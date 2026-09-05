/**
 * Sprint MBC-09 — homologação final MOCK + preparação para provider real.
 * Sem banco real. Sem credencial real. Sem OAuth de instituição.
 * Executar: node --test tests/bancario/motor-bancario-09.test.js
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
const { criarRegistryPadrao } = require('../../backend/motores/bancario/providers/BankProviderRegistry');
const { MemorySecretStore } = require('../../backend/motores/bancario/secrets/MemorySecretStore');
const { EncryptedLocalSecretStore, obterSecretStore } = require('../../backend/motores/bancario/secrets/EncryptedLocalSecretStore');
const {
  ERROS,
  CATEGORIA_ERRO_PROVIDER,
  classificarErroProvider,
  CODIGO_PROVIDER,
  STATUS_CONCILIACAO,
  STATUS_SINCRONIZACAO
} = require('../../backend/motores/bancario/contracts/constantes');
const { IBankProvider } = require('../../backend/motores/bancario/contracts/IBankProvider');
const { sanitizarObjetoMbc } = require('../../backend/motores/bancario/contracts/sanitizarMbc');
const { montarEventoOperacaoMbc } = require('../../backend/motores/bancario/contracts/observabilidadeMbc');
const { adaptarTransacaoDoProvider, adaptarPaginaDoProvider } = require('../../backend/motores/bancario/providers/adaptarTransacaoProvider');
const { chaveIdempotencia } = require('../../backend/motores/bancario/contracts/TransacaoBancariaNormalizada');
const VERSAO = require('../../backend/motores/bancario/version');
const MatchingRepository = require('../../backend/motores/bancario/matching/MatchingRepository');
const ConciliacaoBancariaService = require('../../backend/motores/bancario/services/ConciliacaoBancariaService');
const SincronizacaoBancariaService = require('../../backend/motores/bancario/services/SincronizacaoBancariaService');
const { STATUS_SUGESTAO } = require('../../backend/motores/bancario/matching/contracts/constantesMatching');

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

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
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

async function setup() {
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
  const registry = criarRegistryPadrao();
  const motor = obterMotorBancario({ db, secretStore, registry });
  return {
    db, empresaA, empresaB, motor, secretStore, registry,
    depsMulti: { db, obterModoOperacionalGlobal: () => ModoOperacionalGlobal.MULTIEMPRESA }
  };
}

async function criarConta(ctx, empresaId, nome, numero) {
  const inst = await ctx.motor.criarInstituicao({ nome: 'Inst ' + nome + ' ' + numero });
  return ctx.motor.criarConta({
    empresaId, instituicao_financeira_id: inst.id, nome, tipo: 'CORRENTE', numero
  });
}

async function contaComConfigOf(ctx, empresaId, nome, numero) {
  const conta = await criarConta(ctx, empresaId, nome, numero);
  await ctx.motor.criarConfiguracaoIntegracao({
    empresaId, conta_bancaria_id: conta.id, provider: 'MOCK_OPEN_FINANCE', ambiente: 'TESTE'
  });
  return conta;
}

async function autorizarConta(ctx, empresaId, nome, numero) {
  const conta = await contaComConfigOf(ctx, empresaId, nome, numero);
  const ini = await ctx.motor.iniciarConsentimento({
    empresaId, conta_bancaria_id: conta.id, provider: 'MOCK_OPEN_FINANCE'
  });
  await ctx.motor.processarCallbackConsentimento({
    state: stateDaUrl(ini.authorization_url),
    query: { resultado: 'aprovado' },
    empresaIdContexto: empresaId
  });
  return conta;
}

function of(ctx) {
  return ctx.registry.obter('MOCK_OPEN_FINANCE');
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

describe('MBC-09 arquitetura', () => {
  it('T01 — sprint homologação', () => {
    assert.equal(VERSAO.CODIGO, 'MBC-01');
    assert.ok(String(VERSAO.SPRINT).startsWith('MBC-'));
  });
  it('T02 — contrato único IBankProvider', () => {
    assert.ok(new IBankProvider() instanceof IBankProvider);
    const txt = src('backend/motores/bancario/contracts/IBankProvider.js');
    assert.match(txt, /iniciarAutorizacao/);
    assert.match(txt, /processarCallback/);
    assert.match(txt, /revogarAutorizacao/);
    assert.match(txt, /listarContas/);
    assert.match(txt, /consultarSaldo/);
    assert.match(txt, /listarTransacoes/);
    const idx = src('backend/motores/bancario/index.js');
    assert.equal(idx.includes('IOpenFinanceProvider'), false);
    assert.equal(idx.includes('IRealBankProvider'), false);
  });
  it('T03 — registry é autoridade', () => {
    const r = criarRegistryPadrao();
    assert.equal(r.existe(CODIGO_PROVIDER.MOCK), true);
    assert.equal(r.existe(CODIGO_PROVIDER.MOCK_OPEN_FINANCE), true);
    assert.equal(r.existe('BANCO_REAL'), false);
  });
  it('T04 — rotas não ramificam por provider', () => {
    const rotas = src('backend/rotas/bancario.js');
    assert.equal(/if\s*\(\s*.*provider\s*===/.test(rotas), false);
  });
  it('T05 — adapter não executa SQL', () => {
    const ad = src('backend/motores/bancario/providers/adaptarTransacaoProvider.js');
    assert.equal(/INSERT|UPDATE|SELECT|db\./i.test(ad), false);
  });
  it('T06 — matching não escreve conciliacao_bancaria', () => {
    const repo = src('backend/motores/bancario/matching/MatchingRepository.js');
    assert.equal(repo.includes('INSERT INTO conciliacao_bancaria'), false);
  });
  it('T07 — sync não escreve financeiro', () => {
    const s = src('backend/motores/bancario/services/SincronizacaoBancariaService.js');
    assert.equal(s.includes('INSERT INTO financeiro'), false);
    assert.equal(s.includes('INSERT INTO vendas'), false);
  });
  it('T08 — categorias dedicated', () => {
    assert.equal(CATEGORIA_ERRO_PROVIDER.TIMEOUT, 'TIMEOUT');
    assert.equal(CATEGORIA_ERRO_PROVIDER.RATE_LIMIT, 'RATE_LIMIT');
    assert.equal(Object.keys(CATEGORIA_ERRO_PROVIDER).length, 10);
  });
  it('T09 — sem retry agressivo na sync', () => {
    const s = src('backend/motores/bancario/services/SincronizacaoBancariaService.js');
    assert.match(s, /Sem retry/);
    assert.equal(/for\s*\(\s*;\s*;\s*\)/.test(s), false);
  });
  it('T10 — chave idempotência oficial', () => {
    const k = chaveIdempotencia({
      empresaId: 1, contaBancariaId: 2, external_source: 'MOCK_OPEN_FINANCE', external_id: 'OF-TX-001'
    });
    assert.equal(k, '1|2|MOCK_OPEN_FINANCE|OF-TX-001');
  });
});

describe('MBC-09 providers e secrets', () => {
  it('T11 — MOCK não sincroniza', () => {
    const p = criarRegistryPadrao().obter('MOCK');
    assert.equal(p.suportaSincronizacao, false);
    assert.equal(p.suportaAutorizacao, false);
  });
  it('T12 — MOCK_OPEN_FINANCE sincroniza e autoriza', () => {
    const p = criarRegistryPadrao().obter('MOCK_OPEN_FINANCE');
    assert.equal(p.suportaSincronizacao, true);
    assert.equal(p.suportaAutorizacao, true);
  });
  it('T13 — provider desconhecido', () => {
    assert.throws(() => criarRegistryPadrao().obter('ITAU_REAL'), (e) => e.code === ERROS.PROVIDER_DESCONHECIDO);
  });
  it('T14 — adapter normaliza DTO bruto', () => {
    const dto = adaptarTransacaoDoProvider({
      amount: 10, direction: 'entrada', date: '2026-09-04', description: 'PIX',
      external_id: 'X1', external_source: 'MOCK_OPEN_FINANCE'
    }, { empresaId: 7, contaBancariaId: 3 });
    assert.equal(dto.empresa_id, 7);
    assert.equal(dto.conta_bancaria_id, 3);
    assert.equal(dto.valor, 10);
  });
  it('T15 — adapter de página', () => {
    const p = adaptarPaginaDoProvider({
      transacoes: [{
        amount: 5, direction: 'saida', date: '2026-09-04',
        external_id: 'Y', external_source: 'MOCK'
      }],
      has_more: true,
      next_cursor: 'C1'
    }, { empresaId: 1, contaBancariaId: 2 });
    assert.equal(p.transacoes.length, 1);
    assert.equal(p.has_more, true);
    assert.equal(p.next_cursor, 'C1');
  });
  it('T16 — SecretStore sem chave recusa persistir', async () => {
    const prev = process.env.MBC_SECRET_STORE_KEY;
    delete process.env.MBC_SECRET_STORE_KEY;
    const db = await openDb();
    await garantirSchemaBancarioAsync(db);
    const store = new EncryptedLocalSecretStore({ db });
    await assert.rejects(() => store.set('k', 'segredo'), (e) => e.code === ERROS.SECRET_KEY_AUSENTE);
    await closeDb(db);
    if (prev != null) process.env.MBC_SECRET_STORE_KEY = prev;
  });
  it('T17 — sem chave o factory cai em memória', () => {
    const prev = process.env.MBC_SECRET_STORE_KEY;
    delete process.env.MBC_SECRET_STORE_KEY;
    const s = obterSecretStore({});
    assert.ok(s instanceof MemorySecretStore);
    if (prev != null) process.env.MBC_SECRET_STORE_KEY = prev;
  });
  it('T18 — toJSON do store não vaza valor', async () => {
    const s = new MemorySecretStore();
    await s.set('tok', 'super-secret-token-value');
    assert.equal(JSON.stringify(s).includes('super-secret'), false);
  });
  it('T19 — sanitiza token e state', () => {
    const out = sanitizarObjetoMbc({ token: 'abc', state: 'xyz', authorization_code: 'cd', conta: 1 });
    assert.equal(out.token, '[REDACTED]');
    assert.equal(out.state, '[REDACTED]');
    assert.equal(out.authorization_code, '[REDACTED]');
    assert.equal(out.conta, 1);
  });
  it('T20 — log operacional sem secret', () => {
    const ev = montarEventoOperacaoMbc({
      operacao: 'sincronizarConta', empresa_id: 1, conta_bancaria_id: 2,
      provider: 'MOCK_OPEN_FINANCE', status: 'SUCESSO', token: 'leak', duracao_ms: 12, transacoes: 20
    });
    assert.equal(ev.token, '[REDACTED]');
    assert.equal(ev.empresa_id, 1);
    assert.equal(ev.transacoes, 20);
  });
});

describe('MBC-09 classificação de erros', () => {
  it('T21 — timeout', () => {
    assert.equal(classificarErroProvider({ code: ERROS.PROVIDER_TIMEOUT }), CATEGORIA_ERRO_PROVIDER.TIMEOUT);
  });
  it('T22 — rate limit', () => {
    assert.equal(classificarErroProvider({ code: ERROS.PROVIDER_RATE_LIMIT }), CATEGORIA_ERRO_PROVIDER.RATE_LIMIT);
  });
  it('T23 — indisponibilidade', () => {
    assert.equal(classificarErroProvider({ code: ERROS.PROVIDER_INDISPONIVEL, statusCode: 503 }), CATEGORIA_ERRO_PROVIDER.INDISPONIBILIDADE);
  });
  it('T24 — consentimento', () => {
    assert.equal(classificarErroProvider({ code: ERROS.CONSENTIMENTO_INVALIDO }), CATEGORIA_ERRO_PROVIDER.CONSENTIMENTO);
  });
  it('T25 — cursor inválido', () => {
    assert.equal(classificarErroProvider({ code: ERROS.CURSOR_INVALIDO }), CATEGORIA_ERRO_PROVIDER.CURSOR_INVALIDO);
  });
  it('T26 — autenticação / chave', () => {
    assert.equal(classificarErroProvider({ code: ERROS.SECRET_KEY_AUSENTE }), CATEGORIA_ERRO_PROVIDER.AUTENTICACAO);
  });
  it('T27 — autorização', () => {
    assert.equal(classificarErroProvider({ code: ERROS.AUTORIZACAO_INVALIDA }), CATEGORIA_ERRO_PROVIDER.AUTORIZACAO);
  });
  it('T28 — dados inválidos', () => {
    assert.equal(classificarErroProvider({ code: ERROS.DTO_INVALIDO }), CATEGORIA_ERRO_PROVIDER.DADOS_INVALIDOS);
  });
  it('T29 — interno padrão', () => {
    assert.equal(classificarErroProvider({ message: 'oops' }), CATEGORIA_ERRO_PROVIDER.ERRO_INTERNO);
  });
  it('T30 — 502 vira indisponibilidade', () => {
    assert.equal(classificarErroProvider({ statusCode: 502, message: 'bad gateway' }), CATEGORIA_ERRO_PROVIDER.INDISPONIBILIDADE);
  });
});

describe('MBC-09 pipeline e replay', () => {
  it('T31 — fluxo conta → sync → matching → aceite MBC-04', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'Pipe', '9001');
    const finAntes = (await all(ctx.db, 'SELECT COUNT(*) n FROM financeiro'))[0].n;
    const vendasAntes = (await all(ctx.db, 'SELECT COUNT(*) n FROM vendas'))[0].n;
    const comprasAntes = (await all(ctx.db, 'SELECT COUNT(*) n FROM compras'))[0].n;
    const caixaAntes = (await all(ctx.db, 'SELECT COUNT(*) n FROM caixa_sessoes'))[0].n;
    const sync = await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id });
    assert.equal(sync.novas_transacoes, 20);
    const txs = await ctx.motor.listarTransacoes({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id, limite: 50 });
    const tx = txs.find((t) => t.external_id === 'OF-TX-001');
    await run(
      ctx.db,
      `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, empresa_id)
       VALUES ('receita', 'Mock Open Finance 001', 100, '2026-01-01', 'aberto', ?)`,
      [ctx.empresaA.id]
    );
    const analise = await ctx.motor.analisarConciliacaoTransacao({
      empresaId: ctx.empresaA.id, transacao_bancaria_id: tx.id
    });
    assert.ok(analise.sugestoes.length >= 1);
    const sug = analise.sugestoes[0];
    const ace = await ctx.motor.aceitarSugestaoConciliacao({ empresaId: ctx.empresaA.id, id: sug.id });
    assert.equal(ace.conciliacao.status, STATUS_CONCILIACAO.CONCILIADA);
    const sug2 = await ctx.motor.obterSugestaoConciliacao({ empresaId: ctx.empresaA.id, id: sug.id });
    assert.equal(sug2.status, STATUS_SUGESTAO.ACEITA);
    const concs = await all(ctx.db, `SELECT * FROM conciliacao_bancaria WHERE transacao_bancaria_id = ? AND ativo = 1`, [tx.id]);
    assert.equal(concs.length, 1);
    assert.equal((await all(ctx.db, 'SELECT COUNT(*) n FROM financeiro'))[0].n, finAntes + 1);
    assert.equal((await all(ctx.db, 'SELECT COUNT(*) n FROM vendas'))[0].n, vendasAntes);
    assert.equal((await all(ctx.db, 'SELECT COUNT(*) n FROM compras'))[0].n, comprasAntes);
    assert.equal((await all(ctx.db, 'SELECT COUNT(*) n FROM caixa_sessoes'))[0].n, caixaAntes);
    const txDepois = await ctx.motor.obterTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    assert.equal(Number(txDepois.valor), 100);
    await closeDb(ctx.db);
  });
  it('T32 — sync 1/2/3 sem duplicar', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'Idem', '9002');
    await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id });
    await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id });
    const s3 = await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id });
    assert.equal(s3.novas_transacoes, 0);
    const n = (await all(ctx.db, `SELECT COUNT(*) n FROM transacao_bancaria WHERE conta_bancaria_id = ?`, [conta.id]))[0].n;
    assert.equal(n, 20);
    await closeDb(ctx.db);
  });
  it('T33 — matching duas vezes não duplica sugestão', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'M', '11');
    const tx = (await ctx.motor.registrarTransacaoBancaria({
      empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id, valor: 80, direcao: 'entrada',
      data_transacao: '2026-09-04', descricao: 'PIX A', tipo: 'PIX'
    })).transacao;
    await run(ctx.db, `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, empresa_id)
      VALUES ('receita', 'PIX A', 80, '2026-09-04', 'aberto', ?)`, [ctx.empresaA.id]);
    await ctx.motor.analisarConciliacoesConta({ empresaId: ctx.empresaA.id, id: conta.id });
    const a2 = await ctx.motor.analisarConciliacoesConta({ empresaId: ctx.empresaA.id, id: conta.id });
    assert.equal(a2.sugestoes_criadas, 0);
    const n = (await all(ctx.db, `SELECT COUNT(*) n FROM sugestao_conciliacao_bancaria WHERE transacao_bancaria_id = ?`, [tx.id]))[0].n;
    assert.equal(n, 1);
    await closeDb(ctx.db);
  });
  it('T34 — callback já consumido não duplica consentimento autorizado', async () => {
    const ctx = await setup();
    const conta = await contaComConfigOf(ctx, ctx.empresaA.id, 'Cb', '12');
    const ini = await ctx.motor.iniciarConsentimento({
      empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id, provider: 'MOCK_OPEN_FINANCE'
    });
    const state = stateDaUrl(ini.authorization_url);
    await ctx.motor.processarCallbackConsentimento({
      state, query: { resultado: 'aprovado' }, empresaIdContexto: ctx.empresaA.id
    });
    await assert.rejects(
      () => ctx.motor.processarCallbackConsentimento({
        state, query: { resultado: 'aprovado' }, empresaIdContexto: ctx.empresaA.id
      }),
      (e) => e.statusCode === 409 || e.code === ERROS.AUTORIZACAO_INVALIDA || e.code === ERROS.CONSENTIMENTO_INVALIDO
    );
    const lista = await ctx.motor.listarConsentimentos({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id });
    assert.equal(lista.filter((c) => c.status === 'AUTORIZADO').length, 1);
    await closeDb(ctx.db);
  });
  it('T35 — aceite repetido da mesma sugestão falha', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'Acc', '13');
    const tx = (await ctx.motor.registrarTransacaoBancaria({
      empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id, valor: 40, direcao: 'entrada',
      data_transacao: '2026-09-04', descricao: 'PIX B', tipo: 'PIX'
    })).transacao;
    await run(ctx.db, `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, empresa_id)
      VALUES ('receita', 'PIX B', 40, '2026-09-04', 'aberto', ?)`, [ctx.empresaA.id]);
    const a = await ctx.motor.analisarConciliacaoTransacao({ empresaId: ctx.empresaA.id, transacao_bancaria_id: tx.id });
    await ctx.motor.aceitarSugestaoConciliacao({ empresaId: ctx.empresaA.id, id: a.sugestoes[0].id });
    await assert.rejects(
      () => ctx.motor.aceitarSugestaoConciliacao({ empresaId: ctx.empresaA.id, id: a.sugestoes[0].id }),
      (e) => e.statusCode === 409
    );
    await closeDb(ctx.db);
  });
});

describe('MBC-09 cursor paginação falhas', () => {
  it('T36 — primeira sync persiste 20 e cursor seguro', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'Cur', '14');
    const s = await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id });
    assert.equal(s.novas_transacoes, 20);
    assert.ok(s.cursor);
    await closeDb(ctx.db);
  });
  it('T37 — página 2 falha preserva página 1 e cursor', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'Fail2', '15');
    of(ctx).falharNaPagina = 2;
    await assert.rejects(() => ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id }));
    const n = (await all(ctx.db, `SELECT COUNT(*) n FROM transacao_bancaria WHERE conta_bancaria_id = ?`, [conta.id]))[0].n;
    assert.equal(n, 10);
    const st = await ctx.motor.obterSincronizacao({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id });
    assert.equal(st.cursor_atual, 'CURSOR-001');
    assert.equal(st.status, STATUS_SINCRONIZACAO.ERRO);
    of(ctx).falharNaPagina = 0;
    const s2 = await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id });
    assert.equal(s2.novas_transacoes, 10);
    const n2 = (await all(ctx.db, `SELECT COUNT(*) n FROM transacao_bancaria WHERE conta_bancaria_id = ?`, [conta.id]))[0].n;
    assert.equal(n2, 20);
    await closeDb(ctx.db);
  });
  it('T38 — timeout não duplica nem avança cursor indevido', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'To', '16');
    of(ctx).falhaModo = 'timeout';
    await assert.rejects(() => ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id }), (e) => {
      assert.equal(e.categoria, CATEGORIA_ERRO_PROVIDER.TIMEOUT);
      return true;
    });
    const n = (await all(ctx.db, `SELECT COUNT(*) n FROM transacao_bancaria WHERE conta_bancaria_id = ?`, [conta.id]))[0].n;
    assert.equal(n, 0);
    const st = await ctx.motor.obterSincronizacao({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id });
    assert.equal(st.cursor_atual == null || st.cursor_atual === '', true);
    of(ctx).falhaModo = null;
    await closeDb(ctx.db);
  });
  it('T39 — rate limit', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'Rl', '17');
    of(ctx).falhaModo = 'rate_limit';
    await assert.rejects(() => ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id }), (e) => {
      assert.equal(e.categoria, CATEGORIA_ERRO_PROVIDER.RATE_LIMIT);
      return true;
    });
    of(ctx).falhaModo = null;
    await closeDb(ctx.db);
  });
  it('T40 — provider indisponível', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'Down', '18');
    of(ctx).falhaModo = 'indisponivel';
    await assert.rejects(() => ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id }), (e) => {
      assert.equal(e.categoria, CATEGORIA_ERRO_PROVIDER.INDISPONIBILIDADE);
      return true;
    });
    of(ctx).falhaModo = null;
    await closeDb(ctx.db);
  });
  it('T41 — saldo indisponível', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'Sal', '19');
    of(ctx).falharSaldo = true;
    await assert.rejects(() => ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id }));
    const n = (await all(ctx.db, `SELECT COUNT(*) n FROM transacao_bancaria WHERE conta_bancaria_id = ?`, [conta.id]))[0].n;
    assert.equal(n, 0);
    of(ctx).falharSaldo = false;
    await closeDb(ctx.db);
  });
  it('T42 — consentimento expirado', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'Exp', '20');
    await run(ctx.db, `UPDATE consentimento_open_finance SET status = 'EXPIRADO' WHERE conta_bancaria_id = ?`, [conta.id]);
    await assert.rejects(() => ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id }));
    const st = await ctx.motor.obterSincronizacao({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id });
    assert.equal(st.status, STATUS_SINCRONIZACAO.CONSENTIMENTO_EXPIRADO);
    await closeDb(ctx.db);
  });
  it('T43 — consentimento revogado', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'Rev', '21');
    await ctx.motor.revogarConsentimento({
      empresaId: ctx.empresaA.id,
      id: (await ctx.motor.listarConsentimentos({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id }))[0].id
    });
    await assert.rejects(() => ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id }));
    const st = await ctx.motor.obterSincronizacao({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id });
    assert.equal(st.status, STATUS_SINCRONIZACAO.CONSENTIMENTO_REVOGADO);
    await closeDb(ctx.db);
  });
  it('T44 — MOCK genérico não sincroniza', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'Mk', '22');
    await ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id, provider: 'MOCK', ambiente: 'TESTE'
    });
    await assert.rejects(
      () => ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id }),
      (e) => e.code === ERROS.PROVIDER_SEM_SINCRONIZACAO
    );
    await closeDb(ctx.db);
  });
});

describe('MBC-09 multiempresa permissões API', () => {
  it('T45 — isolamento A/B de transações e sugestões', async () => {
    const ctx = await setup();
    const a = await criarConta(ctx, ctx.empresaA.id, 'A', '31');
    const b = await criarConta(ctx, ctx.empresaB.id, 'B', '32');
    const txA = (await ctx.motor.registrarTransacaoBancaria({
      empresaId: ctx.empresaA.id, conta_bancaria_id: a.id, valor: 15, direcao: 'entrada',
      data_transacao: '2026-09-04', descricao: 'PIX A', tipo: 'PIX'
    })).transacao;
    await ctx.motor.registrarTransacaoBancaria({
      empresaId: ctx.empresaB.id, conta_bancaria_id: b.id, valor: 15, direcao: 'entrada',
      data_transacao: '2026-09-04', descricao: 'PIX B', tipo: 'PIX'
    });
    await run(ctx.db, `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, empresa_id)
      VALUES ('receita', 'PIX A', 15, '2026-09-04', 'aberto', ?)`, [ctx.empresaA.id]);
    await run(ctx.db, `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, empresa_id)
      VALUES ('receita', 'PIX B', 15, '2026-09-04', 'aberto', ?)`, [ctx.empresaB.id]);
    await ctx.motor.analisarConciliacoesConta({ empresaId: ctx.empresaA.id, id: a.id });
    const sugsA = await ctx.motor.listarSugestoesConciliacao({ empresaId: ctx.empresaA.id, conta_bancaria_id: a.id });
    const sugsB = await ctx.motor.listarSugestoesConciliacao({ empresaId: ctx.empresaB.id, conta_bancaria_id: b.id });
    const listaA = Array.isArray(sugsA) ? sugsA : (sugsA.sugestoes || []);
    const listaB = Array.isArray(sugsB) ? sugsB : (sugsB.sugestoes || []);
    assert.ok(listaA.every((s) => s.empresa_id === ctx.empresaA.id));
    assert.ok(listaB.length === 0 || listaB.every((s) => s.empresa_id === ctx.empresaB.id));
    await assert.rejects(() => ctx.motor.obterTransacao({ empresaId: ctx.empresaB.id, id: txA.id }));
    await closeDb(ctx.db);
  });
  it('T46 — body empresa_id ignorado', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'Http', '33');
    const cli = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const r = await cli.json('POST', '/api/bancario/transacoes', {
      empresa_id: ctx.empresaB.id, conta_bancaria_id: conta.id, valor: 9, direcao: 'entrada',
      data_transacao: '2026-09-04', descricao: 'X', tipo: 'PIX'
    });
    assert.equal(r.status, 201);
    assert.equal(r.data.transacao.empresa_id, ctx.empresaA.id);
    await cli.close();
    await closeDb(ctx.db);
  });
  it('T47 — query empresa_id ignorado', async () => {
    const ctx = await setup();
    await criarConta(ctx, ctx.empresaA.id, 'Q', '34');
    const cli = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const r = await cli.json('GET', '/api/bancario/contas?empresa_id=' + ctx.empresaB.id);
    assert.equal(r.status, 200);
    assert.ok((r.data.contas || r.data).length >= 1);
    await cli.close();
    await closeDb(ctx.db);
  });
  it('T48 — usuário sem vínculo 403', async () => {
    const ctx = await setup();
    const cli = await listenApp(ctx, { userId: 99, empresaId: ctx.empresaA.id });
    const r = await cli.json('GET', '/api/bancario/contas');
    assert.equal(r.status, 403);
    await cli.close();
    await closeDb(ctx.db);
  });
  it('T49 — contexto ausente', async () => {
    const ctx = await setup();
    await assert.rejects(() => resolverEmpresaIdParaBancario({ user: { id: 1 } }, ctx.depsMulti));
    await closeDb(ctx.db);
  });
  it('T50 — conta de outra empresa 404', async () => {
    const ctx = await setup();
    const b = await criarConta(ctx, ctx.empresaB.id, 'XB', '35');
    await assert.rejects(() => ctx.motor.obterConta({ empresaId: ctx.empresaA.id, id: b.id }));
    await closeDb(ctx.db);
  });
  it('T51 — HTTP sync empresa B não vê conta A', async () => {
    const ctx = await setup();
    const a = await autorizarConta(ctx, ctx.empresaA.id, 'HA', '36');
    const cli = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaB.id });
    const r = await cli.json('POST', '/api/bancario/contas/' + a.id + '/sincronizar', { empresa_id: ctx.empresaA.id });
    assert.ok(r.status === 404 || r.status === 403);
    await cli.close();
    await closeDb(ctx.db);
  });
  it('T52 — categoria no JSON de erro HTTP', async () => {
    const ctx = await setup();
    const cli = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const r = await cli.json('GET', '/api/bancario/transacoes/999999');
    assert.equal(r.status, 404);
    assert.ok(r.data.categoria);
    assert.equal(JSON.stringify(r.data).includes('token'), false);
    await cli.close();
    await closeDb(ctx.db);
  });
});

describe('MBC-09 conciliação matching concorrência', () => {
  it('T53 — ConciliacaoBancariaService é o único INSERT oficial', () => {
    const conc = src('backend/motores/bancario/services/ConciliacaoBancariaService.js');
    assert.match(conc, /INSERT INTO conciliacao_bancaria/);
    const match = src('backend/motores/bancario/matching/MatchingRepository.js')
      + src('backend/motores/bancario/matching/MotorMatchingBancarioService.js');
    assert.equal(match.includes('INSERT INTO conciliacao_bancaria'), false);
  });
  it('T54 — aceite usa conciliar', () => {
    const m = src('backend/motores/bancario/matching/MotorMatchingBancarioService.js');
    assert.match(m, /ConciliacaoBancariaService\.conciliar/);
  });
  it('T55 — matching não altera origem', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'Orig', '41');
    await ctx.motor.registrarTransacaoBancaria({
      empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id, valor: 22, direcao: 'entrada',
      data_transacao: '2026-09-04', descricao: 'PIX C', tipo: 'PIX'
    });
    const fid = (await run(ctx.db, `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, empresa_id)
      VALUES ('receita', 'PIX C', 22, '2026-09-04', 'aberto', ?)`, [ctx.empresaA.id])).lastID;
    await ctx.motor.analisarConciliacoesConta({ empresaId: ctx.empresaA.id, id: conta.id });
    const fin = await get(ctx.db, 'SELECT * FROM financeiro WHERE id = ?', [fid]);
    assert.equal(Number(fin.valor), 22);
    assert.equal(fin.status, 'aberto');
    await closeDb(ctx.db);
  });
  it('T56 — múltiplos candidatos sem escolha automática', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'Mul', '42');
    const tx = (await ctx.motor.registrarTransacaoBancaria({
      empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id, valor: 33, direcao: 'entrada',
      data_transacao: '2026-09-04', descricao: 'PIX D', tipo: 'PIX'
    })).transacao;
    await run(ctx.db, `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, empresa_id)
      VALUES ('receita', 'PIX D', 33, '2026-09-04', 'aberto', ?)`, [ctx.empresaA.id]);
    await run(ctx.db, `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, empresa_id)
      VALUES ('receita', 'PIX D', 33, '2026-09-04', 'aberto', ?)`, [ctx.empresaA.id]);
    const a = await ctx.motor.analisarConciliacaoTransacao({ empresaId: ctx.empresaA.id, transacao_bancaria_id: tx.id });
    assert.ok(a.sugestoes.length >= 2);
    assert.equal(a.resultado, 'MULTIPLOS');
    await closeDb(ctx.db);
  });
  it('T57 — concorrência no aceite', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'Cc', '43');
    const tx = (await ctx.motor.registrarTransacaoBancaria({
      empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id, valor: 44, direcao: 'entrada',
      data_transacao: '2026-09-04', descricao: 'PIX E', tipo: 'PIX'
    })).transacao;
    await run(ctx.db, `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, empresa_id)
      VALUES ('receita', 'PIX E', 44, '2026-09-04', 'aberto', ?)`, [ctx.empresaA.id]);
    const a = await ctx.motor.analisarConciliacaoTransacao({ empresaId: ctx.empresaA.id, transacao_bancaria_id: tx.id });
    const id = a.sugestoes[0].id;
    const r = await Promise.allSettled([
      ctx.motor.aceitarSugestaoConciliacao({ empresaId: ctx.empresaA.id, id }),
      ctx.motor.aceitarSugestaoConciliacao({ empresaId: ctx.empresaA.id, id })
    ]);
    const ok = r.filter((x) => x.status === 'fulfilled').length;
    const fail = r.filter((x) => x.status === 'rejected').length;
    assert.equal(ok, 1);
    assert.equal(fail, 1);
    const concs = await all(ctx.db, `SELECT * FROM conciliacao_bancaria WHERE transacao_bancaria_id = ? AND ativo = 1`, [tx.id]);
    assert.equal(concs.length, 1);
    await closeDb(ctx.db);
  });
  it('T58 — MatchingRepository.atualizarStatus existe', () => {
    assert.equal(typeof MatchingRepository.atualizarStatus, 'function');
  });
  it('T59 — listarRegistrosElegiveis não inclui venda/compra', () => {
    const s = src('backend/motores/bancario/services/ConciliacaoBancariaService.js');
    assert.equal(s.includes('FROM vendas'), false);
    assert.equal(s.includes('FROM compras'), false);
  });
  it('T60 — importarTransacoes permanece 501', async () => {
    const ctx = await setup();
    let status = null;
    try {
      await ctx.motor.importarTransacoes({ empresaId: ctx.empresaA.id });
    } catch (e) {
      status = e.statusCode;
    }
    assert.equal(status, 501);
    await closeDb(ctx.db);
  });
});

describe('MBC-09 UI segurança frontend', () => {
  it('T61 — UI conciliações sugeridas', () => {
    const js = src('frontend/erp/js/contas-bancarias.js') + src('frontend/erp/pages/contas-bancarias.html');
    assert.match(js, /Conciliações sugeridas|sug-aceitar/);
    assert.match(js, /aceitar/);
    assert.match(js, /recusar/);
    assert.match(js, /cds-empresa-contexto-alterado/);
  });
  it('T62 — UI limpa cache na troca de empresa', () => {
    const js = src('frontend/erp/js/contas-bancarias.js');
    assert.match(js, /sugestoesCache\s*=\s*\[\]/);
  });
  it('T63 — UI não edita valor da transação', () => {
    const js = src('frontend/erp/js/contas-bancarias.js');
    assert.equal(/PUT.*\/transacoes\//.test(js), false);
    assert.equal(/DELETE.*\/transacoes\//.test(js), false);
  });
  it('T64 — UI não envia score', () => {
    const js = src('frontend/erp/js/contas-bancarias.js');
    assert.equal(/score\s*:/.test(js), false);
  });
  it('T65 — UI Open Finance / sincronizar', () => {
    const js = src('frontend/erp/js/contas-bancarias.js');
    assert.match(js, /sincronizar/);
    assert.match(js, /open-finance/);
  });
  it('T66 — textos pt-BR na página', () => {
    const html = src('frontend/erp/pages/contas-bancarias.html') + src('frontend/erp/index.html');
    assert.match(html, /Contas Bancárias|Configuração de Integração/);
  });
  it('T67 — frontend não é autoridade de empresa_id', () => {
    const js = src('frontend/erp/js/contas-bancarias.js');
    assert.equal(/body\.empresa_id\s*=/.test(js), false);
  });
  it('T68 — rotas de instituições exigem permissão', () => {
    const rotas = src('backend/rotas/bancario.js');
    assert.match(rotas, /verificarPermissaoEspecifica\('financeiro'\)|perm/);
  });
});

describe('MBC-09 carga controlada e saldo', () => {
  it('T69 — 500 transações sem duplicidade', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'Load', '50');
    const t0 = Date.now();
    for (let i = 1; i <= 500; i += 1) {
      await ctx.motor.registrarTransacaoBancaria({
        empresaId: ctx.empresaA.id,
        conta_bancaria_id: conta.id,
        valor: 1 + (i % 7),
        direcao: i % 2 ? 'entrada' : 'saida',
        data_transacao: '2026-08-01',
        descricao: 'CARGA ' + i,
        tipo: 'PIX',
        external_source: 'CARGA',
        external_id: 'LOAD-' + String(i).padStart(4, '0')
      });
    }
    const msSync = Date.now() - t0;
    const n = (await all(ctx.db, `SELECT COUNT(*) n FROM transacao_bancaria WHERE conta_bancaria_id = ?`, [conta.id]))[0].n;
    assert.equal(n, 500);
    for (let i = 1; i <= 3; i += 1) {
      await ctx.motor.registrarTransacaoBancaria({
        empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id, valor: 2,
        direcao: 'entrada', data_transacao: '2026-08-01', descricao: 'CARGA 1',
        tipo: 'PIX', external_source: 'CARGA', external_id: 'LOAD-0001'
      });
    }
    const n2 = (await all(ctx.db, `SELECT COUNT(*) n FROM transacao_bancaria WHERE conta_bancaria_id = ?`, [conta.id]))[0].n;
    assert.equal(n2, 500);
    for (let i = 1; i <= 1000; i += 1) {
      await run(ctx.db, `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, empresa_id)
        VALUES ('receita', ?, 2, '2026-08-01', 'aberto', ?)`, ['ELEGIVEL ' + i, ctx.empresaA.id]);
    }
    const t1 = Date.now();
    const analise = await ctx.motor.analisarConciliacoesConta({ empresaId: ctx.empresaA.id, id: conta.id });
    const msMatch = Date.now() - t1;
    assert.ok(analise.transacoes_analisadas >= 1);
    assert.ok(msSync < 60000);
    assert.ok(msMatch < 60000);
    global.__mbc09Carga = { msSync, msMatch, transacoes: 500, elegiveis: 1000, sugestoes: analise.sugestoes_criadas };
    await closeDb(ctx.db);
  });
  it('T70 — saldo conceitual após carga não quebra', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'Saldo', '51');
    await ctx.motor.registrarTransacaoBancaria({
      empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id, valor: 10, direcao: 'entrada',
      data_transacao: '2026-09-01', descricao: 'E', tipo: 'PIX'
    });
    const s = await ctx.motor.calcularSaldoConceitual({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id });
    assert.equal(s.saldo_conceitual, 10);
    await closeDb(ctx.db);
  });
});

describe('MBC-09 cobertura extra', () => {
  it('T71 — schema tem sugestao e sincronizacao', () => {
    const sch = src('backend/motores/bancario/schema/bancarioSchema.js');
    assert.match(sch, /sugestao_conciliacao_bancaria/);
    assert.match(sch, /sincronizacao_bancaria/);
    assert.match(sch, /consentimento_open_finance/);
  });
  it('T72 — schema sem coluna token de provider', () => {
    const sch = src('backend/motores/bancario/schema/bancarioSchema.js');
    assert.equal(/access_token|refresh_token|client_secret/.test(sch), false);
  });
  it('T73 — Motor exporta matching e sync', () => {
    const idx = require('../../backend/motores/bancario/index.js');
    assert.ok(idx.MotorMatchingBancarioService);
    assert.ok(idx.SincronizacaoBancariaService);
    assert.ok(idx.adaptarTransacaoDoProvider);
  });
  it('T74 — listar providers HTTP', async () => {
    const ctx = await setup();
    const cli = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const r = await cli.json('GET', '/api/bancario/providers');
    assert.equal(r.status, 200);
    const codigos = (r.data.providers || r.data).map((p) => p.codigo);
    assert.ok(codigos.includes('MOCK'));
    await cli.close();
    await closeDb(ctx.db);
  });
  it('T75 — análise HTTP da conta', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'AH', '61');
    const cli = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const r = await cli.json('POST', '/api/bancario/contas/' + conta.id + '/analisar-conciliacoes', {});
    assert.equal(r.status, 200);
    assert.ok('transacoes_analisadas' in r.data);
    await cli.close();
    await closeDb(ctx.db);
  });
  it('T76 — GET sugestões HTTP', async () => {
    const ctx = await setup();
    const cli = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const r = await cli.json('GET', '/api/bancario/conciliacoes/sugestoes');
    assert.equal(r.status, 200);
    await cli.close();
    await closeDb(ctx.db);
  });
  it('T77 — sync HTTP após autorização', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'SH', '62');
    const cli = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const r = await cli.json('POST', '/api/bancario/contas/' + conta.id + '/sincronizar', {});
    assert.equal(r.status, 200);
    assert.equal(r.data.novas_transacoes, 20);
    const ext = await cli.json('GET', '/api/bancario/contas/' + conta.id + '/extrato');
    assert.equal(ext.status, 200);
    await cli.close();
    await closeDb(ctx.db);
  });
  it('T78 — paginação extrato', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'Pg', '63');
    await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id });
    const p1 = await ctx.motor.listarTransacoes({
      empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id, limite: 5, offset: 0
    });
    const p2 = await ctx.motor.listarTransacoes({
      empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id, limite: 5, offset: 5
    });
    assert.equal(p1.length, 5);
    assert.equal(p2.length, 5);
    assert.notEqual(p1[0].id, p2[0].id);
    await closeDb(ctx.db);
  });
  it('T79 — cursor inválido no mock opcional', async () => {
    const ctx = await setup();
    of(ctx).falhaModo = 'cursor_invalido';
    await assert.rejects(
      () => of(ctx).listarTransacoes({ empresaId: 1, contaBancariaId: 1, cursor: 'LIXO' }),
      (e) => e.code === ERROS.CURSOR_INVALIDO
    );
    of(ctx).falhaModo = null;
    await closeDb(ctx.db);
  });
  it('T80 — SincronizacaoBancariaService não importa matching', () => {
    const s = src('backend/motores/bancario/services/SincronizacaoBancariaService.js');
    assert.equal(s.includes('sugestao_conciliacao'), false);
    assert.equal(s.includes('MotorMatching'), false);
  });
  it('T81 — ConciliacaoBancariaService não chama matching', () => {
    const s = src('backend/motores/bancario/services/ConciliacaoBancariaService.js');
    assert.equal(s.includes('MotorMatching'), false);
  });
  it('T82 — documentação MBC-09 existe', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'docs/bancario/MBC-09-HOMOLOGACAO-FINAL.md')));
    assert.ok(fs.existsSync(path.join(ROOT, 'docs/bancario/MBC-09-PROVIDER-REAL-CONTRATO.md')));
    assert.ok(fs.existsSync(path.join(ROOT, 'docs/bancario/MBC-09-SEGURANCA-E-PRODUCAO.md')));
    assert.ok(fs.existsSync(path.join(ROOT, 'docs/bancario/IMPLEMENTACAO_MBC_09_RELATORIO.md')));
  });
  it('T83 — checklist produção não marca MOCK como pronto', () => {
    const d = src('docs/bancario/MBC-09-SEGURANCA-E-PRODUCAO.md');
    assert.match(d, /\[ \].*Provider real/);
    assert.doesNotMatch(d, /\[x\].*Provider real/i);
  });
  it('T84 — ISecretStore contrato', () => {
    const { ISecretStore } = require('../../backend/motores/bancario/secrets/ISecretStore');
    assert.ok(typeof ISecretStore.prototype.set === 'function');
  });
  it('T85 — registrarOperacao não loga por padrão', () => {
    const { registrarOperacaoMbc } = require('../../backend/motores/bancario/contracts/observabilidadeMbc');
    const ev = registrarOperacaoMbc({ operacao: 'x', token: 'zzz' });
    assert.equal(ev.token, '[REDACTED]');
  });
});
