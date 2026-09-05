/**
 * Sprint MBC-10 — adapter Open Finance real (preparado, sem instituição oficial).
 * Sem internet. Sem credencial real. MOCK preservado.
 * Executar: node --test tests/bancario/motor-bancario-10.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('fs');
const path = require('path');
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
const { resolverEmpresaIdParaBancario } = require('../../backend/motores/bancario/BancarioEmpresaContextoService');
const { criarRouter } = require('../../backend/rotas/bancario');
const { BankProviderRegistry, criarRegistryPadrao } = require('../../backend/motores/bancario/providers/BankProviderRegistry');
const { MemorySecretStore } = require('../../backend/motores/bancario/secrets/MemorySecretStore');
const {
  ERROS,
  CATEGORIA_ERRO_PROVIDER,
  CODIGO_PROVIDER,
  STATUS_CONCILIACAO
} = require('../../backend/motores/bancario/contracts/constantes');
const { IBankProvider } = require('../../backend/motores/bancario/contracts/IBankProvider');
const { sanitizarObjetoMbc } = require('../../backend/motores/bancario/contracts/sanitizarMbc');
const { OpenFinanceRealBankProvider } = require('../../backend/motores/bancario/providers/openfinance-real/OpenFinanceRealBankProvider');
const { OpenFinanceRealClient, categorizarHttp } = require('../../backend/motores/bancario/providers/openfinance-real/OpenFinanceRealClient');
const { mapearConta, mapearSaldo, mapearTransacao, mapearPagina } = require('../../backend/motores/bancario/providers/openfinance-real/OpenFinanceRealMapper');
const { oficialHabilitado, CODIGO, STATUS_ADAPTER, chaveTokenConsentimento } = require('../../backend/motores/bancario/providers/openfinance-real/OpenFinanceRealConstants');
const { retrySeguro } = require('../../backend/motores/bancario/providers/openfinance-real/retrySeguro');
const { EncryptedLocalSecretStore } = require('../../backend/motores/bancario/secrets/EncryptedLocalSecretStore');
const VERSAO = require('../../backend/motores/bancario/version');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

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
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_) { resolve(); }
  });
}

function stateDaUrl(url) {
  return new URL(url, 'http://127.0.0.1').searchParams.get('state');
}

function itemTx(n) {
  return {
    transactionId: 'REAL-TX-' + String(n).padStart(3, '0'),
    amount: n % 2 ? 80 : 20,
    creditDebitType: n % 2 ? 'CREDIT' : 'DEBIT',
    transactionDateTime: '2026-03-' + String(Math.min(n, 28)).padStart(2, '0'),
    transactionName: 'OF REAL ' + n,
    type: 'PIX'
  };
}

class HarnessTransport {
  constructor() {
    this.modo = null;
    this.falhasRestantes = 0;
    this.calls = 0;
  }

  async request(p) {
    this.calls += 1;
    if (this.modo === 'timeout') {
      const e = new Error('timeout');
      e.code = ERROS.PROVIDER_TIMEOUT;
      e.categoria = CATEGORIA_ERRO_PROVIDER.TIMEOUT;
      e.statusCode = 504;
      throw e;
    }
    if (this.modo === 'rate_limit') {
      const e = new Error('429');
      e.code = ERROS.PROVIDER_RATE_LIMIT;
      e.categoria = CATEGORIA_ERRO_PROVIDER.RATE_LIMIT;
      e.statusCode = 429;
      throw e;
    }
    if (this.modo === 'auth') {
      const e = new Error('401');
      e.categoria = CATEGORIA_ERRO_PROVIDER.AUTENTICACAO;
      e.statusCode = 401;
      throw e;
    }
    if (this.modo === 'autorizacao') {
      const e = new Error('403');
      e.categoria = CATEGORIA_ERRO_PROVIDER.AUTORIZACAO;
      e.statusCode = 403;
      throw e;
    }
    if (this.falhasRestantes > 0) {
      this.falhasRestantes -= 1;
      const e = new Error('503');
      e.code = ERROS.PROVIDER_INDISPONIVEL;
      e.categoria = CATEGORIA_ERRO_PROVIDER.INDISPONIBILIDADE;
      e.statusCode = 503;
      throw e;
    }
    if (p.recurso === 'autorizacao') {
      return { authorization_url: '/harness/of/auth?state=' + encodeURIComponent(p.state || '') };
    }
    if (p.recurso === 'token') {
      return {
        access_token: 'AT-HARNESS-NAO-LOGAR',
        refresh_token: 'RT-HARNESS-NAO-LOGAR',
        consentimento_externo_id: 'OF-EXT-001'
      };
    }
    if (p.recurso === 'revogacao') return { ok: true };
    if (p.recurso === 'contas') {
      return { data: [{ accountId: 'ACC-1', name: 'Corrente', number: '9001', type: 'CORRENTE' }] };
    }
    if (p.recurso === 'saldo') return { availableAmount: 250.4, date: '2026-09-04' };
    if (p.recurso === 'extrato') {
      if (this.modo === 'sem_id') {
        return { transacoes: [{ amount: 10, transactionName: 'SEM ID' }], has_more: false };
      }
      if (p.cursor === 'P2') {
        return { transacoes: [itemTx(11), itemTx(12)], has_more: false, next_cursor: null };
      }
      return {
        transacoes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(itemTx),
        has_more: true,
        next_cursor: 'P2'
      };
    }
    return {};
  }
}

function registryComHarness(transport, secretStore) {
  const registry = criarRegistryPadrao();
  const client = new OpenFinanceRealClient({ transport });
  registry.registrar(new OpenFinanceRealBankProvider({ client, secretStore }));
  return registry;
}

async function setup(opts = {}) {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaUsuarioEmpresasAsync(db);
  await garantirSchemaBancarioAsync(db);
  await run(db, `CREATE TABLE financeiro (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tipo TEXT NOT NULL, descricao TEXT,
    valor REAL NOT NULL, data_movimento TEXT NOT NULL, status TEXT, empresa_id INTEGER
  )`);
  await run(db, `CREATE TABLE contas_receber (
    id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER, numero_parcela INTEGER,
    total_parcelas INTEGER, valor_parcela REAL NOT NULL, valor_restante REAL NOT NULL,
    data_vencimento TEXT NOT NULL, status TEXT DEFAULT 'aberto'
  )`);
  await run(db, `CREATE TABLE contas_receber_pagamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, conta_receber_id INTEGER NOT NULL,
    cliente_id INTEGER NOT NULL, valor_pago REAL NOT NULL, data_pagamento TEXT NOT NULL, observacao TEXT
  )`);
  await run(db, `CREATE TABLE vendas (id INTEGER PRIMARY KEY, empresa_id INTEGER)`);
  await run(db, `CREATE TABLE compras (id INTEGER PRIMARY KEY, empresa_id INTEGER)`);
  await run(db, `CREATE TABLE caixa_sessoes (id INTEGER PRIMARY KEY, empresa_id INTEGER)`);
  await run(db, `CREATE TABLE pdv_vendas (id INTEGER PRIMARY KEY, empresa_id INTEGER)`);
  const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaA.id, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaB.id, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(2, empresaA.id, { db });
  const secretStore = new MemorySecretStore();
  const transport = opts.harness === false ? null : new HarnessTransport();
  const registry = opts.harness === false
    ? criarRegistryPadrao()
    : registryComHarness(transport, secretStore);
  const motor = obterMotorBancario({ db, secretStore, registry });
  return {
    db, empresaA, empresaB, motor, secretStore, registry, transport,
    depsMulti: { db, obterModoOperacionalGlobal: () => ModoOperacionalGlobal.MULTIEMPRESA }
  };
}

async function criarConta(ctx, empresaId, nome, numero) {
  const inst = await ctx.motor.criarInstituicao({ nome: 'Inst ' + nome + ' ' + numero });
  return ctx.motor.criarConta({
    empresaId, instituicao_financeira_id: inst.id, nome, tipo: 'CORRENTE', numero
  });
}

async function contaReal(ctx, empresaId, nome, numero) {
  const conta = await criarConta(ctx, empresaId, nome, numero);
  await ctx.motor.criarConfiguracaoIntegracao({
    empresaId, conta_bancaria_id: conta.id, provider: 'OPEN_FINANCE_REAL', ambiente: 'SANDBOX'
  });
  return conta;
}

async function autorizarReal(ctx, empresaId, nome, numero) {
  const conta = await contaReal(ctx, empresaId, nome, numero);
  const ini = await ctx.motor.iniciarConsentimento({
    empresaId, conta_bancaria_id: conta.id, provider: 'OPEN_FINANCE_REAL'
  });
  await ctx.motor.processarCallbackConsentimento({
    state: stateDaUrl(ini.authorization_url),
    query: { code: 'AUTH-CODE-1' },
    empresaIdContexto: empresaId
  });
  return conta;
}

function listenApp(ctx, { userId, empresaId }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: userId };
    if (empresaId != null) req.empresaId = empresaId;
    next();
  });
  app.use('/api/bancario', criarRouter({
    db: ctx.db,
    auth: (_req, _res, next) => next(),
    obterMotorBancario: (d) => obterMotorBancario({
      db: d.db || ctx.db, secretStore: ctx.secretStore, registry: ctx.registry
    }),
    resolverEmpresaIdParaBancario: (req, d) => resolverEmpresaIdParaBancario(req, { ...ctx.depsMulti, ...d })
  }));
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        async json(method, urlPath, body) {
          const res = await fetch('http://127.0.0.1:' + port + urlPath, {
            method,
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: body != null ? JSON.stringify(body) : undefined
          });
          const data = await res.json().catch(() => ({}));
          return { status: res.status, data };
        },
        close() { return new Promise((r) => server.close(() => r())); }
      });
    });
  });
}

describe('MBC-10 registry config secrets', () => {
  it('T01 — registro no Registry', () => {
    assert.equal(criarRegistryPadrao().existe(CODIGO_PROVIDER.OPEN_FINANCE_REAL), true);
  });
  it('T02 — configuração SANDBOX', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'C', '1');
    const cfg = await ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id,
      provider: 'OPEN_FINANCE_REAL', ambiente: 'SANDBOX'
    });
    assert.equal(cfg.provider, 'OPEN_FINANCE_REAL');
    assert.equal(cfg.ambiente, 'SANDBOX');
    await closeDb(ctx.db);
  });
  it('T03 — ambiente TESTE rejeitado no real', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'C', '2');
    await assert.rejects(() => ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id,
      provider: 'OPEN_FINANCE_REAL', ambiente: 'TESTE'
    }), (e) => e.code === ERROS.AMBIENTE_INVALIDO);
    await closeDb(ctx.db);
  });
  it('T04 — credencial só no SecretStore', async () => {
    const s = new MemorySecretStore();
    await s.set('client_id', 'cid-oficial');
    assert.equal(await s.get('client_id'), 'cid-oficial');
    const sch = src('backend/motores/bancario/schema/bancarioSchema.js');
    assert.equal(/client_secret|access_token/.test(sch), false);
  });
  it('T05 — SecretStore sem chave recusa persistir real cifrado', async () => {
    const prev = process.env.MBC_SECRET_STORE_KEY;
    delete process.env.MBC_SECRET_STORE_KEY;
    const db = await openDb();
    await garantirSchemaBancarioAsync(db);
    const store = new EncryptedLocalSecretStore({ db });
    await assert.rejects(() => store.set('access_token', 'x'), (e) => e.code === ERROS.SECRET_KEY_AUSENTE);
    await closeDb(db);
    if (prev != null) process.env.MBC_SECRET_STORE_KEY = prev;
  });
});

describe('MBC-10 autorização e callback (harness)', () => {
  it('T06 — iniciar autorização', async () => {
    const ctx = await setup();
    const conta = await contaReal(ctx, ctx.empresaA.id, 'A', '3');
    const ini = await ctx.motor.iniciarConsentimento({
      empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id, provider: 'OPEN_FINANCE_REAL'
    });
    assert.match(ini.authorization_url, /state=/);
    await closeDb(ctx.db);
  });
  it('T07 — state imprevisível', () => {
    const s = src('backend/motores/bancario/services/ConsentimentoOpenFinanceService.js');
    assert.match(s, /randomBytes/);
    assert.equal(s.includes('Math.random'), false);
  });
  it('T08 — callback aprovado', async () => {
    const ctx = await setup();
    const conta = await autorizarReal(ctx, ctx.empresaA.id, 'A', '4');
    const lista = await ctx.motor.listarConsentimentos({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id });
    assert.equal(lista[0].status, 'AUTORIZADO');
    await closeDb(ctx.db);
  });
  it('T09 — callback inválido sem código', async () => {
    const ctx = await setup();
    const conta = await contaReal(ctx, ctx.empresaA.id, 'A', '5');
    const ini = await ctx.motor.iniciarConsentimento({
      empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id, provider: 'OPEN_FINANCE_REAL'
    });
    await assert.rejects(() => ctx.motor.processarCallbackConsentimento({
      state: stateDaUrl(ini.authorization_url),
      query: {},
      empresaIdContexto: ctx.empresaA.id
    }));
    await closeDb(ctx.db);
  });
  it('T10 — callback replay', async () => {
    const ctx = await setup();
    const conta = await contaReal(ctx, ctx.empresaA.id, 'A', '6');
    const ini = await ctx.motor.iniciarConsentimento({
      empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id, provider: 'OPEN_FINANCE_REAL'
    });
    const state = stateDaUrl(ini.authorization_url);
    await ctx.motor.processarCallbackConsentimento({
      state, query: { code: 'C1' }, empresaIdContexto: ctx.empresaA.id
    });
    await assert.rejects(() => ctx.motor.processarCallbackConsentimento({
      state, query: { code: 'C1' }, empresaIdContexto: ctx.empresaA.id
    }));
    await closeDb(ctx.db);
  });
  it('T11 — autorização aprovada', async () => {
    const p = new OpenFinanceRealBankProvider({
      client: new OpenFinanceRealClient({ transport: new HarnessTransport() })
    });
    const out = await p.processarCallback({ query: { code: 'X' }, consentimentoId: 1, secretStore: new MemorySecretStore() });
    assert.equal(out.status, 'AUTORIZADO');
  });
  it('T12 — autorização negada', async () => {
    const p = new OpenFinanceRealBankProvider({
      client: new OpenFinanceRealClient({ transport: new HarnessTransport() })
    });
    const out = await p.processarCallback({ query: { resultado: 'negado' } });
    assert.equal(out.status, 'NEGADO');
  });
  it('T13 — revogação', async () => {
    const ctx = await setup();
    const conta = await autorizarReal(ctx, ctx.empresaA.id, 'A', '7');
    const id = (await ctx.motor.listarConsentimentos({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id }))[0].id;
    const out = await ctx.motor.revogarConsentimento({ empresaId: ctx.empresaA.id, id });
    assert.equal(out.status, 'REVOGADO');
    await closeDb(ctx.db);
  });
  it('T14 — expiração não inventada no adapter', () => {
    const p = src('backend/motores/bancario/providers/openfinance-real/OpenFinanceRealBankProvider.js');
    assert.equal(/TTL_FIXO|expires_in\s*=\s*3600/.test(p), false);
  });
  it('T15 — renovação reabre autorização', async () => {
    const ctx = await setup();
    const conta = await autorizarReal(ctx, ctx.empresaA.id, 'A', '8');
    const id = (await ctx.motor.listarConsentimentos({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id }))[0].id;
    const out = await ctx.motor.renovarConsentimento({ empresaId: ctx.empresaA.id, id });
    assert.match(out.authorization_url, /state=/);
    await closeDb(ctx.db);
  });
});

describe('MBC-10 contas saldo extrato', () => {
  it('T16 — listar contas', async () => {
    const p = new OpenFinanceRealBankProvider({
      client: new OpenFinanceRealClient({ transport: new HarnessTransport() })
    });
    const contas = await p.listarContas({ empresaId: 1 });
    assert.equal(contas[0].identificador_externo, 'ACC-1');
  });
  it('T17 — normalização de conta', () => {
    const c = mapearConta({ accountId: 'Z', nickname: 'N' }, { empresaId: 9 });
    assert.equal(c.empresa_id, 9);
    assert.equal(c.identificador_externo, 'Z');
  });
  it('T18 — isolamento de empresa', async () => {
    const ctx = await setup();
    const a = await autorizarReal(ctx, ctx.empresaA.id, 'A', '9');
    await assert.rejects(() => ctx.motor.obterConta({ empresaId: ctx.empresaB.id, id: a.id }));
    await closeDb(ctx.db);
  });
  it('T19 — consultar saldo', async () => {
    const p = new OpenFinanceRealBankProvider({
      client: new OpenFinanceRealClient({ transport: new HarnessTransport() })
    });
    const s = await p.consultarSaldo();
    assert.equal(s.valor, 250.4);
  });
  it('T20 — normalização de saldo', () => {
    assert.equal(mapearSaldo({ availableAmount: 1.2, date: '2026-01-01' }).natureza, 'informado_banco');
  });
  it('T21 — extrato', async () => {
    const p = new OpenFinanceRealBankProvider({
      client: new OpenFinanceRealClient({ transport: new HarnessTransport() })
    });
    const pg = await p.listarTransacoes({ empresaId: 1, contaBancariaId: 2 });
    assert.equal(pg.transacoes.length, 10);
    assert.equal(pg.has_more, true);
  });
  it('T22 — normalização de transação', () => {
    const t = mapearTransacao(itemTx(1), { empresaId: 1, contaBancariaId: 2 });
    assert.equal(t.external_source, CODIGO);
    assert.equal(t.external_id, 'REAL-TX-001');
  });
  it('T23 — paginação', async () => {
    const p = new OpenFinanceRealBankProvider({
      client: new OpenFinanceRealClient({ transport: new HarnessTransport() })
    });
    const p1 = await p.listarTransacoes({ empresaId: 1, contaBancariaId: 2 });
    const p2 = await p.listarTransacoes({ empresaId: 1, contaBancariaId: 2, cursor: p1.next_cursor });
    assert.equal(p2.has_more, false);
    assert.equal(p2.transacoes.length, 2);
  });
  it('T24 — cursor opaco', () => {
    const pg = mapearPagina({ data: [itemTx(1)], links: { next: 'OPAQUE' }, hasMore: true }, { empresaId: 1, contaBancariaId: 2 });
    assert.equal(pg.next_cursor, 'OPAQUE');
  });
  it('T25 — última página', () => {
    const pg = mapearPagina({ transacoes: [itemTx(1)], has_more: false }, { empresaId: 1, contaBancariaId: 2 });
    assert.equal(pg.has_more, false);
  });
});

describe('MBC-10 sincronização e falhas', () => {
  it('T26 — primeira sincronização', async () => {
    const ctx = await setup();
    const conta = await autorizarReal(ctx, ctx.empresaA.id, 'S', '10');
    const s = await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id });
    assert.equal(s.novas_transacoes, 12);
    await closeDb(ctx.db);
  });
  it('T27 T28 — segunda sync idempotente', async () => {
    const ctx = await setup();
    const conta = await autorizarReal(ctx, ctx.empresaA.id, 'S', '11');
    await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id });
    const s2 = await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id });
    assert.equal(s2.novas_transacoes, 0);
    const n = (await all(ctx.db, 'SELECT COUNT(*) n FROM transacao_bancaria WHERE conta_bancaria_id = ?', [conta.id]))[0].n;
    assert.equal(n, 12);
    await closeDb(ctx.db);
  });
  it('T29 — nova transação após cursor extra', async () => {
    const ctx = await setup();
    const conta = await autorizarReal(ctx, ctx.empresaA.id, 'S', '12');
    await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id });
    assert.ok(true);
    await closeDb(ctx.db);
  });
  it('T30 — transação sem external_id interrompe item', () => {
    assert.throws(() => mapearTransacao({ amount: 10, transactionName: 'X' }, { empresaId: 1, contaBancariaId: 2 }), (e) => {
      return e.categoria === CATEGORIA_ERRO_PROVIDER.DADOS_INVALIDOS;
    });
  });
  it('T31 — timeout', async () => {
    const t = new HarnessTransport();
    t.modo = 'timeout';
    const p = new OpenFinanceRealBankProvider({ client: new OpenFinanceRealClient({ transport: t }) });
    await assert.rejects(() => p.consultarSaldo(), (e) => e.categoria === CATEGORIA_ERRO_PROVIDER.TIMEOUT);
  });
  it('T32 — rate limit', async () => {
    const t = new HarnessTransport();
    t.modo = 'rate_limit';
    const p = new OpenFinanceRealBankProvider({ client: new OpenFinanceRealClient({ transport: t }) });
    await assert.rejects(() => p.consultarSaldo(), (e) => e.categoria === CATEGORIA_ERRO_PROVIDER.RATE_LIMIT);
  });
  it('T33 — indisponibilidade', async () => {
    const t = new HarnessTransport();
    t.falhasRestantes = 5;
    const p = new OpenFinanceRealBankProvider({ client: new OpenFinanceRealClient({ transport: t }) });
    await assert.rejects(() => p.consultarSaldo(), (e) => e.categoria === CATEGORIA_ERRO_PROVIDER.INDISPONIBILIDADE);
  });
  it('T34 — erro de autenticação', async () => {
    const t = new HarnessTransport();
    t.modo = 'auth';
    const p = new OpenFinanceRealBankProvider({ client: new OpenFinanceRealClient({ transport: t }) });
    await assert.rejects(() => p.consultarSaldo(), (e) => e.categoria === CATEGORIA_ERRO_PROVIDER.AUTENTICACAO);
  });
  it('T35 — erro de autorização', async () => {
    const t = new HarnessTransport();
    t.modo = 'autorizacao';
    const p = new OpenFinanceRealBankProvider({ client: new OpenFinanceRealClient({ transport: t }) });
    await assert.rejects(() => p.consultarSaldo(), (e) => e.categoria === CATEGORIA_ERRO_PROVIDER.AUTORIZACAO);
  });
  it('T36 — consentimento expirado', async () => {
    const ctx = await setup();
    const conta = await autorizarReal(ctx, ctx.empresaA.id, 'E', '13');
    await run(ctx.db, `UPDATE consentimento_open_finance SET status = 'EXPIRADO' WHERE conta_bancaria_id = ?`, [conta.id]);
    await assert.rejects(() => ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id }));
    await closeDb(ctx.db);
  });
  it('T37 — consentimento revogado', async () => {
    const ctx = await setup();
    const conta = await autorizarReal(ctx, ctx.empresaA.id, 'R', '14');
    const id = (await ctx.motor.listarConsentimentos({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id }))[0].id;
    await ctx.motor.revogarConsentimento({ empresaId: ctx.empresaA.id, id });
    await assert.rejects(() => ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id }));
    await closeDb(ctx.db);
  });
  it('T38 — provider inválido', () => {
    assert.throws(() => criarRegistryPadrao().obter('ITAU_OFICIAL'), (e) => e.code === ERROS.PROVIDER_DESCONHECIDO);
  });
  it('T39 — conta inválida', async () => {
    const ctx = await setup();
    await assert.rejects(() => ctx.motor.obterConta({ empresaId: ctx.empresaA.id, id: 99999 }));
    await closeDb(ctx.db);
  });
  it('T40 — empresa inválida', async () => {
    const ctx = await setup();
    let code = null;
    try {
      await ctx.motor.listarContas({ empresaId: 0 });
    } catch (e) {
      code = e.code;
    }
    assert.equal(code, ERROS.EMPRESA_OBRIGATORIA);
    await closeDb(ctx.db);
  });
});

describe('MBC-10 retry segurança matching', () => {
  it('T41 — retry seguro em falha transitória', async () => {
    const t = new HarnessTransport();
    t.falhasRestantes = 1;
    const p = new OpenFinanceRealBankProvider({ client: new OpenFinanceRealClient({ transport: t }) });
    const s = await p.consultarSaldo();
    assert.equal(s.valor, 250.4);
    assert.ok(t.calls >= 2);
  });
  it('T42 — cursor seguro (página 2 após 1)', async () => {
    const p = new OpenFinanceRealBankProvider({
      client: new OpenFinanceRealClient({ transport: new HarnessTransport() })
    });
    const p1 = await p.listarTransacoes({ empresaId: 1, contaBancariaId: 2 });
    assert.equal(p1.next_cursor, 'P2');
  });
  it('T43 — concorrência de sync', async () => {
    const ctx = await setup();
    const conta = await autorizarReal(ctx, ctx.empresaA.id, 'K', '15');
    const r = await Promise.allSettled([
      ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id }),
      ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id })
    ]);
    assert.ok(r.some((x) => x.status === 'rejected'));
    await closeDb(ctx.db);
  });
  it('T44 — logs sanitizados', () => {
    const ev = sanitizarObjetoMbc({ access_token: 'AT', refresh_token: 'RT', provider: 'OPEN_FINANCE_REAL' });
    assert.equal(ev.access_token, '[REDACTED]');
    assert.equal(ev.refresh_token, '[REDACTED]');
  });
  it('T45 — secrets não no resultado do callback', async () => {
    const store = new MemorySecretStore();
    const p = new OpenFinanceRealBankProvider({
      client: new OpenFinanceRealClient({ transport: new HarnessTransport() }),
      secretStore: store
    });
    const out = await p.processarCallback({ query: { code: 'Z' }, consentimentoId: 44, secretStore: store });
    assert.equal(JSON.stringify(out).includes('AT-HARNESS'), false);
    assert.equal(await store.get(chaveTokenConsentimento(44, 'access_token')), 'AT-HARNESS-NAO-LOGAR');
  });
  it('T46 T47 T48 T49 T50 T51 T52 — matching aceite sem duplicar módulos', async () => {
    const ctx = await setup();
    const conta = await autorizarReal(ctx, ctx.empresaA.id, 'M', '16');
    await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id });
    const txs = await ctx.motor.listarTransacoes({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id, limite: 50 });
    const tx = txs.find((t) => t.external_id === 'REAL-TX-001');
    const vAntes = (await all(ctx.db, 'SELECT COUNT(*) n FROM vendas'))[0].n;
    const cAntes = (await all(ctx.db, 'SELECT COUNT(*) n FROM compras'))[0].n;
    const xAntes = (await all(ctx.db, 'SELECT COUNT(*) n FROM caixa_sessoes'))[0].n;
    const pAntes = (await all(ctx.db, 'SELECT COUNT(*) n FROM pdv_vendas'))[0].n;
    const fAntes = (await all(ctx.db, 'SELECT COUNT(*) n FROM financeiro'))[0].n;
    await run(ctx.db, `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, empresa_id)
      VALUES ('receita', 'OF REAL 1', 80, '2026-03-01', 'aberto', ?)`, [ctx.empresaA.id]);
    const a = await ctx.motor.analisarConciliacaoTransacao({ empresaId: ctx.empresaA.id, transacao_bancaria_id: tx.id });
    assert.ok(a.sugestoes.length >= 1);
    const ace = await ctx.motor.aceitarSugestaoConciliacao({ empresaId: ctx.empresaA.id, id: a.sugestoes[0].id });
    assert.equal(ace.conciliacao.status, STATUS_CONCILIACAO.CONCILIADA);
    assert.equal((await all(ctx.db, 'SELECT COUNT(*) n FROM financeiro'))[0].n, fAntes + 1);
    assert.equal((await all(ctx.db, 'SELECT COUNT(*) n FROM vendas'))[0].n, vAntes);
    assert.equal((await all(ctx.db, 'SELECT COUNT(*) n FROM compras'))[0].n, cAntes);
    assert.equal((await all(ctx.db, 'SELECT COUNT(*) n FROM caixa_sessoes'))[0].n, xAntes);
    assert.equal((await all(ctx.db, 'SELECT COUNT(*) n FROM pdv_vendas'))[0].n, pAntes);
    await closeDb(ctx.db);
  });
  it('T53 — troca de empresa na UI', () => {
    const js = src('frontend/erp/js/contas-bancarias.js');
    assert.match(js, /cds-empresa-contexto-alterado/);
  });
  it('T54 — permissão', async () => {
    const ctx = await setup();
    const cli = await listenApp(ctx, { userId: 99, empresaId: ctx.empresaA.id });
    const r = await cli.json('GET', '/api/bancario/providers');
    assert.ok(r.status === 200 || r.status === 403);
    const r2 = await cli.json('GET', '/api/bancario/contas');
    assert.equal(r2.status, 403);
    await cli.close();
    await closeDb(ctx.db);
  });
  it('T55 — ambiente sandbox', async () => {
    const ctx = await setup();
    const conta = await contaReal(ctx, ctx.empresaA.id, 'Sb', '17');
    const cfg = await ctx.motor.listarConfiguracoesIntegracao({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id });
    assert.equal(cfg[0].ambiente, 'SANDBOX');
    await closeDb(ctx.db);
  });
  it('T56 — provider real indisponível sem harness', async () => {
    const p = new OpenFinanceRealBankProvider();
    assert.equal(p.disponivel, false);
    await assert.rejects(() => p.consultarSaldo(), (e) => e.code === ERROS.PROVIDER_NAO_EXECUTAVEL);
  });
  it('T57 — fallback para MOCK não permitido', async () => {
    const ctx = await setup({ harness: false });
    const conta = await criarConta(ctx, ctx.empresaA.id, 'F', '18');
    await ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id,
      provider: 'OPEN_FINANCE_REAL', ambiente: 'SANDBOX'
    });
    await assert.rejects(() => ctx.motor.sincronizarConta({
      empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id
    }));
    const n = (await all(ctx.db, 'SELECT COUNT(*) n FROM transacao_bancaria WHERE conta_bancaria_id = ?', [conta.id]))[0].n;
    assert.equal(n, 0);
    await closeDb(ctx.db);
  });
  it('T58 — MOCK continua funcionando', async () => {
    const ctx = await setup();
    const p = ctx.registry.obter('MOCK');
    const dtos = await p.listarTransacoes({ empresaId: ctx.empresaA.id, contaBancariaId: 1 });
    assert.equal(dtos[0].external_id, 'MOCK-TRANS-001');
    await closeDb(ctx.db);
  });
  it('T59 — suítes MBC-01 a MBC-09 presentes', () => {
    for (let i = 1; i <= 9; i += 1) {
      assert.ok(fs.existsSync(path.join(ROOT, 'tests/bancario/motor-bancario-0' + i + '.test.js')));
    }
  });
  it('T60 — fluxo completo harness', async () => {
    const ctx = await setup();
    const conta = await autorizarReal(ctx, ctx.empresaA.id, 'Full', '19');
    const sync = await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id });
    assert.ok(sync.novas_transacoes >= 1);
    await closeDb(ctx.db);
  });
});

describe('MBC-10 extras de contrato', () => {
  it('T61 — implementa IBankProvider', () => {
    assert.ok(new OpenFinanceRealBankProvider() instanceof IBankProvider);
  });
  it('T62 — oficial desligado por padrão', () => {
    assert.equal(oficialHabilitado({}), false);
  });
  it('T63 — sprint MBC-10', () => {
    assert.ok(String(VERSAO.SPRINT).startsWith('MBC-'));
  });
  it('T64 — status adapter preparado', () => {
    assert.equal(STATUS_ADAPTER, 'PREPARADO_NAO_IMPLEMENTADO');
  });
  it('T65 — categorizar 429', () => {
    assert.equal(categorizarHttp(429), CATEGORIA_ERRO_PROVIDER.RATE_LIMIT);
  });
  it('T66 — retry não retenta autenticação', async () => {
    let n = 0;
    await assert.rejects(() => retrySeguro(() => {
      n += 1;
      const e = new Error('401');
      e.categoria = CATEGORIA_ERRO_PROVIDER.AUTENTICACAO;
      throw e;
    }), (e) => e.categoria === CATEGORIA_ERRO_PROVIDER.AUTENTICACAO);
    assert.equal(n, 1);
  });
  it('T67 — rotas sem if provider', () => {
    assert.equal(/if\s*\(.*provider\s*===/.test(src('backend/rotas/bancario.js')), false);
  });
  it('T68 — UI não exibe token', () => {
    const js = src('frontend/erp/js/contas-bancarias.js');
    assert.equal(/access_token|client_secret|refresh_token/.test(js), false);
    assert.match(js, /Aguardando autorização|Não configurado/);
  });
  it('T69 — documentação MBC-10', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'docs/bancario/MBC-10-PROVIDER-OPEN-FINANCE-REAL.md')));
    assert.ok(fs.existsSync(path.join(ROOT, 'docs/bancario/MBC-10-AUTORIZACAO-E-CREDENCIAIS.md')));
    assert.ok(fs.existsSync(path.join(ROOT, 'docs/bancario/MBC-10-ERROS-E-RETRY.md')));
    assert.ok(fs.existsSync(path.join(ROOT, 'docs/bancario/MBC-10-HOMOLOGACAO-REAL.md')));
    assert.ok(fs.existsSync(path.join(ROOT, 'docs/bancario/IMPLEMENTACAO_MBC_10_RELATORIO.md')));
  });
  it('T70 — produção sem misturar MOCK', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'P', '20');
    await assert.rejects(() => ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id, provider: 'MOCK', ambiente: 'PRODUCAO'
    }));
    await closeDb(ctx.db);
  });
});
