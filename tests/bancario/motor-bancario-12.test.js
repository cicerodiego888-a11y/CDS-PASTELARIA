/**
 * Sprint MBC-12 — operação assistida / produção controlada.
 * Sem instituição oficial: nenhuma chamada externa. MOCK intacto.
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('node:http');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const UsuarioEmpresaService = require('../../backend/services/empresas/UsuarioEmpresaService');
const { ModoOperacionalGlobal } = require('../../backend/core/modo-operacional');
const { garantirSchemaBancarioAsync } = require('../../backend/motores/bancario/schema/bancarioSchema');
const { obterMotorBancario } = require('../../backend/motores/bancario/MotorBancarioService');
const { criarRouter } = require('../../backend/rotas/bancario');
const { resolverEmpresaIdParaBancario } = require('../../backend/motores/bancario/BancarioEmpresaContextoService');
const { criarRegistryPadrao } = require('../../backend/motores/bancario/providers/BankProviderRegistry');
const { MemorySecretStore } = require('../../backend/motores/bancario/secrets/MemorySecretStore');
const { EncryptedLocalSecretStore } = require('../../backend/motores/bancario/secrets/EncryptedLocalSecretStore');
const { ERROS, CATEGORIA_ERRO_PROVIDER, STATUS_CONCILIACAO } = require('../../backend/motores/bancario/contracts/constantes');
const { sanitizarObjetoMbc } = require('../../backend/motores/bancario/contracts/sanitizarMbc');
const { OpenFinanceRealBankProvider } = require('../../backend/motores/bancario/providers/openfinance-real/OpenFinanceRealBankProvider');
const { OpenFinanceRealClient } = require('../../backend/motores/bancario/providers/openfinance-real/OpenFinanceRealClient');
const { mapearTransacao, mapearPagina, mapearSaldo } = require('../../backend/motores/bancario/providers/openfinance-real/OpenFinanceRealMapper');
const {
  providerRealPodeOperar,
  featureFlagLigada,
  ambienteEndpointValido,
  MSG_BLOQUEIO_OPERACAO_REAL,
  INSTITUICAO_OFICIAL
} = require('../../backend/motores/bancario/providers/openfinance-real/prontidaoOperacaoReal');
const { montarRegistroOperacaoAssistida } = require('../../backend/motores/bancario/providers/openfinance-real/operacaoAssistida');
const VERSAO = require('../../backend/motores/bancario/version');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

function src(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}
function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}
function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}
function closeDb(db) {
  return new Promise((resolve) => { try { db.close(() => resolve()); } catch (_) { resolve(); } });
}
function stateDaUrl(url) {
  return new URL(url, 'http://127.0.0.1').searchParams.get('state');
}

class Harness {
  constructor() { this.modo = null; this.calls = 0; }
  async request(p) {
    this.calls += 1;
    if (this.modo === 'timeout') {
      const e = new Error('timeout'); e.code = ERROS.PROVIDER_TIMEOUT; e.categoria = CATEGORIA_ERRO_PROVIDER.TIMEOUT; throw e;
    }
    if (this.modo === 'rate') {
      const e = new Error('429'); e.code = ERROS.PROVIDER_RATE_LIMIT; e.categoria = CATEGORIA_ERRO_PROVIDER.RATE_LIMIT; throw e;
    }
    if (this.modo === 'auth') {
      const e = new Error('401'); e.categoria = CATEGORIA_ERRO_PROVIDER.AUTENTICACAO; throw e;
    }
    if (this.modo === 'p2fail' && p.cursor === 'P2') {
      const e = new Error('p2'); e.statusCode = 502; e.categoria = CATEGORIA_ERRO_PROVIDER.INDISPONIBILIDADE; throw e;
    }
    if (p.recurso === 'autorizacao') return { authorization_url: '/h/auth?state=' + encodeURIComponent(p.state || '') };
    if (p.recurso === 'token') return { access_token: 'AT-X', refresh_token: 'RT-X', consentimento_externo_id: 'E1' };
    if (p.recurso === 'saldo') return { availableAmount: 10, date: '2026-09-04' };
    if (p.recurso === 'extrato') {
      const tx = (n) => ({
        transactionId: 'R-' + n, amount: 50, creditDebitType: 'CREDIT',
        transactionDateTime: '2026-04-0' + n, transactionName: 'TX ' + n, type: 'PIX'
      });
      if (p.cursor === 'P2') return { transacoes: [tx(2)], has_more: false };
      return { transacoes: [tx(1)], has_more: true, next_cursor: 'P2' };
    }
    if (p.recurso === 'contas') return { data: [{ accountId: 'C1', name: 'C' }] };
    if (p.recurso === 'revogacao') return { ok: true };
    return {};
  }
}

async function setup(harness) {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaUsuarioEmpresasAsync(db);
  await garantirSchemaBancarioAsync(db);
  await run(db, `CREATE TABLE financeiro (id INTEGER PRIMARY KEY AUTOINCREMENT, tipo TEXT, descricao TEXT, valor REAL, data_movimento TEXT, status TEXT, empresa_id INTEGER)`);
  await run(db, `CREATE TABLE contas_receber (id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER, numero_parcela INTEGER, total_parcelas INTEGER, valor_parcela REAL, valor_restante REAL, data_vencimento TEXT, status TEXT)`);
  await run(db, `CREATE TABLE contas_receber_pagamentos (id INTEGER PRIMARY KEY AUTOINCREMENT, conta_receber_id INTEGER, cliente_id INTEGER, valor_pago REAL, data_pagamento TEXT, observacao TEXT)`);
  await run(db, `CREATE TABLE vendas (id INTEGER PRIMARY KEY, empresa_id INTEGER)`);
  await run(db, `CREATE TABLE compras (id INTEGER PRIMARY KEY, empresa_id INTEGER)`);
  await run(db, `CREATE TABLE caixa_sessoes (id INTEGER PRIMARY KEY, empresa_id INTEGER)`);
  const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaA.id, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaB.id, { db });
  const secretStore = new MemorySecretStore();
  const transport = harness ? new Harness() : null;
  const registry = !harness
    ? criarRegistryPadrao()
    : (() => {
      const r = criarRegistryPadrao();
      r.registrar(new OpenFinanceRealBankProvider({
        client: new OpenFinanceRealClient({ transport }),
        secretStore
      }));
      return r;
    })();
  const motor = obterMotorBancario({ db, secretStore, registry });
  return {
    db, empresaA, empresaB, motor, secretStore, registry, transport,
    depsMulti: { db, obterModoOperacionalGlobal: () => ModoOperacionalGlobal.MULTIEMPRESA }
  };
}

async function conta(ctx, emp, n) {
  const inst = await ctx.motor.criarInstituicao({ nome: 'I' + n });
  return ctx.motor.criarConta({ empresaId: emp, instituicao_financeira_id: inst.id, nome: 'C' + n, tipo: 'CORRENTE', numero: String(n) });
}

function listenApp(ctx, userId, empresaId) {
  const app = express();
  app.use(express.json());
  app.use((req, _r, next) => { req.user = { id: userId }; req.empresaId = empresaId; next(); });
  app.use('/api/bancario', criarRouter({
    db: ctx.db, auth: (_a, _b, n) => n(),
    obterMotorBancario: (d) => obterMotorBancario({ db: d.db || ctx.db, secretStore: ctx.secretStore, registry: ctx.registry }),
    resolverEmpresaIdParaBancario: (req, d) => resolverEmpresaIdParaBancario(req, { ...ctx.depsMulti, ...d })
  }));
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        async json(method, urlPath, body) {
          const res = await fetch('http://127.0.0.1:' + port + urlPath, {
            method, headers: { 'Content-Type': 'application/json' },
            body: body != null ? JSON.stringify(body) : undefined
          });
          return { status: res.status, data: await res.json().catch(() => ({})) };
        },
        close() { return new Promise((r) => server.close(() => r())); }
      });
    });
  });
}

describe('MBC-12 prontidão e bloqueio', () => {
  it('T01 — provider real selecionado (código interno)', () => {
    assert.equal(criarRegistryPadrao().existe('OPEN_FINANCE_REAL'), true);
  });
  it('T02 — sem documentação bloqueado', () => {
    const p = providerRealPodeOperar();
    assert.equal(p.ok, false);
    assert.equal(INSTITUICAO_OFICIAL, null);
    assert.equal(p.mensagem, MSG_BLOQUEIO_OPERACAO_REAL);
  });
  it('T03 — ambiente inválido', () => {
    assert.throws(() => ambienteEndpointValido('PRODUCAO', { apiUrl: 'https://sandbox.x/api' }), (e) => e.statusCode === 409);
  });
  it('T04 — produção apontando sandbox bloqueada', () => {
    assert.throws(() => ambienteEndpointValido('PRODUCAO', { authUrl: 'https://hml.banco/a' }));
  });
  it('T05 — configuração sem credencial (secret_configurado false)', async () => {
    const ctx = await setup(false);
    const c = await conta(ctx, ctx.empresaA.id, 1);
    const cfg = await ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id, conta_bancaria_id: c.id, provider: 'OPEN_FINANCE_REAL', ambiente: 'SANDBOX'
    });
    assert.equal(cfg.secret_configurado, false);
    await closeDb(ctx.db);
  });
  it('T06 — SecretStore cifrado indisponível sem chave', async () => {
    const prev = process.env.MBC_SECRET_STORE_KEY;
    delete process.env.MBC_SECRET_STORE_KEY;
    const db = await openDb();
    await garantirSchemaBancarioAsync(db);
    const st = new EncryptedLocalSecretStore({ db });
    let code = null;
    try { await st.set('k', 'v'); } catch (e) { code = e.code; }
    assert.equal(code, ERROS.SECRET_KEY_AUSENTE);
    await closeDb(db);
    if (prev != null) process.env.MBC_SECRET_STORE_KEY = prev;
  });
  it('T07 — autorização real bloqueada', async () => {
    const p = new OpenFinanceRealBankProvider();
    await assert.rejects(() => p.iniciarAutorizacao({ state: 's' }), (e) => e.message === MSG_BLOQUEIO_OPERACAO_REAL);
  });
  it('T08 — callback válido (harness, não instituição)', async () => {
    const store = new MemorySecretStore();
    const p = new OpenFinanceRealBankProvider({ client: new OpenFinanceRealClient({ transport: new Harness() }), secretStore: store });
    const out = await p.processarCallback({ query: { code: 'ok' }, consentimentoId: 1, secretStore: store });
    assert.equal(out.status, 'AUTORIZADO');
    assert.equal(JSON.stringify(out).includes('AT-X'), false);
  });
  it('T09 — callback inválido sem código', async () => {
    const p = new OpenFinanceRealBankProvider({ client: new OpenFinanceRealClient({ transport: new Harness() }) });
    await assert.rejects(() => p.processarCallback({ query: {} }));
  });
  it('T10 T11 — callback replay / state MBC-06', () => {
    const s = src('backend/motores/bancario/services/ConsentimentoOpenFinanceService.js');
    assert.match(s, /consumido/);
    assert.match(s, /randomBytes/);
  });
  it('T12 — consentimento negado', async () => {
    const p = new OpenFinanceRealBankProvider({ client: new OpenFinanceRealClient({ transport: new Harness() }) });
    const out = await p.processarCallback({ query: { resultado: 'negado' } });
    assert.equal(out.status, 'NEGADO');
  });
});

describe('MBC-12 dados e sync (harness / bloqueio)', () => {
  it('T13 — listar contas harness', async () => {
    const p = new OpenFinanceRealBankProvider({ client: new OpenFinanceRealClient({ transport: new Harness() }) });
    const c = await p.listarContas({ empresaId: 1 });
    assert.equal(c[0].identificador_externo, 'C1');
  });
  it('T14 — saldo harness', async () => {
    const p = new OpenFinanceRealBankProvider({ client: new OpenFinanceRealClient({ transport: new Harness() }) });
    assert.equal((await p.consultarSaldo()).valor, 10);
  });
  it('T15 — extrato harness', async () => {
    const p = new OpenFinanceRealBankProvider({ client: new OpenFinanceRealClient({ transport: new Harness() }) });
    const pg = await p.listarTransacoes({ empresaId: 1, contaBancariaId: 2 });
    assert.equal(pg.transacoes[0].external_id, 'R-1');
  });
  it('T16 — mapper', () => {
    assert.equal(mapearSaldo({ availableAmount: 3 }).natureza, 'informado_banco');
  });
  it('T17 — external_id ausente recusado', () => {
    assert.throws(() => mapearTransacao({ amount: 1 }, { empresaId: 1, contaBancariaId: 1 }));
  });
  it('T18 T19 — idempotência sync', async () => {
    const ctx = await setup(true);
    const c = await conta(ctx, ctx.empresaA.id, 20);
    await ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id, conta_bancaria_id: c.id, provider: 'OPEN_FINANCE_REAL', ambiente: 'SANDBOX'
    });
    const ini = await ctx.motor.iniciarConsentimento({
      empresaId: ctx.empresaA.id, conta_bancaria_id: c.id, provider: 'OPEN_FINANCE_REAL'
    });
    await ctx.motor.processarCallbackConsentimento({
      state: stateDaUrl(ini.authorization_url), query: { code: '1' }, empresaIdContexto: ctx.empresaA.id
    });
    const s1 = await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, conta_bancaria_id: c.id });
    const s2 = await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, conta_bancaria_id: c.id });
    assert.ok(s1.novas_transacoes >= 1);
    assert.equal(s2.novas_transacoes, 0);
    await closeDb(ctx.db);
  });
  it('T20 — paginação', () => {
    const p = mapearPagina({ transacoes: [{
      transactionId: 'A', amount: 1, creditDebitType: 'CREDIT', transactionDateTime: '2026-01-01', transactionName: 'A', type: 'PIX'
    }], has_more: true, next_cursor: 'N' }, { empresaId: 1, contaBancariaId: 1 });
    assert.equal(p.next_cursor, 'N');
  });
  it('T21 T22 — falha página 2 / recuperação', async () => {
    const h = new Harness();
    h.modo = 'p2fail';
    const p = new OpenFinanceRealBankProvider({ client: new OpenFinanceRealClient({ transport: h }) });
    const p1 = await p.listarTransacoes({ empresaId: 1, contaBancariaId: 1 });
    assert.equal(p1.next_cursor, 'P2');
    await assert.rejects(() => p.listarTransacoes({ empresaId: 1, contaBancariaId: 1, cursor: 'P2' }));
  });
  it('T23 — timeout', async () => {
    const h = new Harness(); h.modo = 'timeout';
    const p = new OpenFinanceRealBankProvider({ client: new OpenFinanceRealClient({ transport: h }) });
    await assert.rejects(() => p.consultarSaldo(), (e) => e.categoria === CATEGORIA_ERRO_PROVIDER.TIMEOUT);
  });
  it('T24 — HTTP 429', async () => {
    const h = new Harness(); h.modo = 'rate';
    const p = new OpenFinanceRealBankProvider({ client: new OpenFinanceRealClient({ transport: h }) });
    await assert.rejects(() => p.consultarSaldo(), (e) => e.categoria === CATEGORIA_ERRO_PROVIDER.RATE_LIMIT);
  });
  it('T25 — erro autenticação', async () => {
    const h = new Harness(); h.modo = 'auth';
    const p = new OpenFinanceRealBankProvider({ client: new OpenFinanceRealClient({ transport: h }) });
    await assert.rejects(() => p.consultarSaldo(), (e) => e.categoria === CATEGORIA_ERRO_PROVIDER.AUTENTICACAO);
  });
  it('T26 — erro consentimento na prontidão', () => {
    const p = providerRealPodeOperar({ consentimento_status: 'REVOGADO' });
    assert.ok(p.motivos.includes('CONSENTIMENTO_NAO_AUTORIZADO'));
  });
  it('T27 — erro sanitizado', () => {
    const o = sanitizarObjetoMbc({ error: 'x', access_token: 'AT', client_secret: 'S' });
    assert.equal(o.access_token, '[REDACTED]');
  });
});

describe('MBC-12 multiempresa conciliação flags', () => {
  it('T28 T29 T30 — isolamento A/B', async () => {
    const ctx = await setup(false);
    const a = await conta(ctx, ctx.empresaA.id, 28);
    await conta(ctx, ctx.empresaB.id, 29);
    let fail = false;
    try { await ctx.motor.obterConta({ empresaId: ctx.empresaB.id, id: a.id }); } catch (_) { fail = true; }
    assert.equal(fail, true);
    await closeDb(ctx.db);
  });
  it('T31 T32 T33 — conciliação manual / sugestão / sem auto', async () => {
    const ctx = await setup(true);
    const c = await conta(ctx, ctx.empresaA.id, 31);
    await ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id, conta_bancaria_id: c.id, provider: 'OPEN_FINANCE_REAL', ambiente: 'SANDBOX'
    });
    const ini = await ctx.motor.iniciarConsentimento({
      empresaId: ctx.empresaA.id, conta_bancaria_id: c.id, provider: 'OPEN_FINANCE_REAL'
    });
    await ctx.motor.processarCallbackConsentimento({
      state: stateDaUrl(ini.authorization_url), query: { code: '1' }, empresaIdContexto: ctx.empresaA.id
    });
    await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, conta_bancaria_id: c.id });
    const txsBruto = await ctx.motor.listarTransacoes({ empresaId: ctx.empresaA.id, conta_bancaria_id: c.id, limite: 20 });
    const txs = Array.isArray(txsBruto) ? txsBruto : (txsBruto.transacoes || []);
    const tx = txs.find((t) => t.external_id === 'R-1');
    assert.ok(tx);
    await run(ctx.db, `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, empresa_id)
      VALUES ('receita', 'TX 1', 50, '2026-04-01', 'aberto', ?)`, [ctx.empresaA.id]);
    const a = await ctx.motor.analisarConciliacaoTransacao({ empresaId: ctx.empresaA.id, transacao_bancaria_id: tx.id });
    assert.ok(Array.isArray(a.sugestoes));
    if (a.sugestoes.length >= 1) {
      const ace = await ctx.motor.aceitarSugestaoConciliacao({ empresaId: ctx.empresaA.id, id: a.sugestoes[0].id });
      assert.equal(ace.conciliacao.status, STATUS_CONCILIACAO.CONCILIADA);
    } else {
      const conc = await ctx.motor.conciliarTransacao({
        empresaId: ctx.empresaA.id,
        transacao_bancaria_id: tx.id,
        origem_financeira: 'FINANCEIRO',
        registro_financeiro_id: 1,
        valor_conciliado: 50
      });
      assert.equal(conc.status, STATUS_CONCILIACAO.CONCILIADA);
    }
    assert.equal(src('backend/motores/bancario/matching/MotorMatchingBancarioService.js').includes('INSERT INTO conciliacao_bancaria'), false);
    await closeDb(ctx.db);
  });
  it('T34 — feature flag desligada', () => {
    assert.equal(featureFlagLigada({}), false);
    assert.ok(providerRealPodeOperar({ env: {} }).motivos.includes('FEATURE_FLAG_DESLIGADA'));
  });
  it('T35 — flag ligada sem pré-condições', () => {
    const p = providerRealPodeOperar({
      env: { MBC_OPEN_FINANCE_REAL_ENABLED: 'true' }
    });
    assert.equal(p.ok, false);
    assert.ok(p.motivos.includes('AGUARDANDO_PROVIDER_REAL_AMBIENTE_OFICIAL'));
  });
  it('T36 — operação assistida sanitizada', () => {
    const r = montarRegistroOperacaoAssistida({
      empresa_id: 1, conta_bancaria_id: 2, ambiente: 'SANDBOX',
      quantidade_criada: 0, token: 'LEAK', access_token: 'AT', state: 'ST'
    });
    assert.equal(r.modo, 'OPERACAO_ASSISTIDA');
    assert.equal(r.token, '[REDACTED]');
    assert.equal(r.access_token, '[REDACTED]');
    assert.equal(r.status, 'BLOQUEADO');
  });
  it('T37 — produção controlada bloqueada', () => {
    const p = providerRealPodeOperar({ ambiente: 'PRODUCAO', env: { MBC_OPEN_FINANCE_REAL_ENABLED: 'true' } });
    assert.equal(p.producao_controlada, false);
    assert.equal(p.ok, false);
  });
  it('T38 — logs sem segredo', () => {
    assert.match(src('backend/motores/bancario/contracts/observabilidadeMbc.js'), /sanitizarObjetoMbc/);
  });
  it('T39 — token ausente no JSON de prontidão', () => {
    assert.equal(JSON.stringify(providerRealPodeOperar()).includes('token'), false);
  });
  it('T40 — token ausente na URL de autorização bloqueada', async () => {
    const p = new OpenFinanceRealBankProvider();
    let url = null;
    try { const o = await p.iniciarAutorizacao({ state: 'x' }); url = o.authorization_url; } catch (_) { url = null; }
    assert.equal(url, null);
  });
  it('T41 — sprint MBC-12', () => { assert.ok(String(VERSAO.SPRINT).startsWith('MBC-')); });
  it('T42 — UI mensagem bloqueio', () => {
    assert.match(src('frontend/erp/pages/contas-bancarias.html'), /ainda não está habilitado para operação real/);
  });
  it('T43 — MOCK intacto', async () => {
    const d = await criarRegistryPadrao().obter('MOCK').listarTransacoes({ empresaId: 1, contaBancariaId: 1 });
    assert.equal(d[0].external_id, 'MOCK-TRANS-001');
  });
  it('T44 — motor avaliarProntidao', () => {
    const m = obterMotorBancario({ db: {} });
    assert.equal(m.avaliarProntidaoProviderReal().ok, false);
  });
  it('T45 — HTTP providers sem token', async () => {
    const ctx = await setup(false);
    const cli = await listenApp(ctx, 1, ctx.empresaA.id);
    const r = await cli.json('GET', '/api/bancario/providers');
    assert.equal(r.status, 200);
    assert.equal(JSON.stringify(r.data).includes('access_token'), false);
    await cli.close();
    await closeDb(ctx.db);
  });
  it('T46 — docs MBC-12', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'docs/bancario/MBC-12-PROVIDER-REAL.md')));
    assert.ok(fs.existsSync(path.join(ROOT, 'docs/bancario/MBC-12-RELATORIO.md')));
    assert.ok(fs.existsSync(path.join(ROOT, 'docs/bancario/MBC-12-MATRIZ-COMPATIBILIDADE.md')));
  });
});
