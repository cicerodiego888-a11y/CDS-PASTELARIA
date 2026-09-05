/**
 * Sprint MBC-06 — Open Finance + consentimento (MOCK).
 * Executar: node --test tests/bancario/motor-bancario-06.test.js
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
const { ERROS, STATUS_CONSENTIMENTO } = require('../../backend/motores/bancario/contracts/constantes');
const { chaveSecretConsentimento } = require('../../backend/motores/bancario/services/ConsentimentoOpenFinanceService');

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
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_) { resolve(); }
  });
}

async function setup() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaUsuarioEmpresasAsync(db);
  await garantirSchemaBancarioAsync(db);
  await run(db, `CREATE TABLE financeiro (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tipo TEXT, valor REAL, empresa_id INTEGER
  )`);
  const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaA.id, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaB.id, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(2, empresaA.id, { db });
  const secretStore = new MemorySecretStore();
  const registry = criarRegistryPadrao();
  const motor = obterMotorBancario({ db, secretStore, registry });
  const depsMulti = {
    db,
    obterModoOperacionalGlobal: () => ModoOperacionalGlobal.MULTIEMPRESA
  };
  return { db, empresaA, empresaB, motor, secretStore, registry, depsMulti };
}

async function criarConta(ctx, empresaId, nome, numero) {
  const inst = await ctx.motor.criarInstituicao({ nome: 'Inst ' + nome + ' ' + numero });
  return ctx.motor.criarConta({
    empresaId,
    instituicao_financeira_id: inst.id,
    nome,
    tipo: 'CORRENTE',
    numero
  });
}

async function contaComConfigOf(ctx, empresaId, nome, numero) {
  const conta = await criarConta(ctx, empresaId, nome, numero);
  const cfg = await ctx.motor.criarConfiguracaoIntegracao({
    empresaId,
    conta_bancaria_id: conta.id,
    provider: 'MOCK_OPEN_FINANCE',
    ambiente: 'TESTE'
  });
  return { conta, cfg };
}

function stateDaUrl(url) {
  const u = new URL(url, 'http://127.0.0.1');
  return u.searchParams.get('state');
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
      db: d.db || ctx.db,
      secretStore: ctx.secretStore,
      registry: ctx.registry
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
        close() {
          return new Promise((r) => server.close(() => r()));
        }
      });
    });
  });
}

describe('MBC-06 Open Finance e consentimento', () => {
  it('T01 — registry encontra MOCK_OPEN_FINANCE', () => {
    const r = criarRegistryPadrao();
    assert.equal(r.existe('MOCK_OPEN_FINANCE'), true);
    assert.equal(r.obter('MOCK_OPEN_FINANCE').codigo, 'MOCK_OPEN_FINANCE');
    assert.equal(r.existe('MOCK'), true);
  });

  it('T02 — provider inexistente rejeitado', () => {
    const r = criarRegistryPadrao();
    assert.throws(() => r.obter('BANCO_REAL_X'), (err) => err.code === ERROS.PROVIDER_DESCONHECIDO);
  });

  it('T03 T11 T12 T13 T14 T16 — criar consentimento inicia com URL e state', async () => {
    const ctx = await setup();
    const { conta } = await contaComConfigOf(ctx, ctx.empresaA.id, 'A', '3');
    const out = await ctx.motor.iniciarConsentimento({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: conta.id,
      provider: 'MOCK_OPEN_FINANCE',
      escopos: ['CONTAS', 'SALDOS', 'TRANSACOES']
    });
    assert.ok(out.consentimento_id);
    assert.equal(out.status, STATUS_CONSENTIMENTO.AGUARDANDO_AUTORIZACAO);
    assert.match(out.authorization_url, /^\/api\/bancario\/open-finance\/mock-autorizar\?state=/);
    const state = stateDaUrl(out.authorization_url);
    assert.ok(state && state.length >= 32);
    const st = await get(ctx.db, `SELECT * FROM consentimento_of_state WHERE state = ?`, [state]);
    assert.equal(st.consentimento_id, out.consentimento_id);
    assert.equal(st.empresa_id, ctx.empresaA.id);
    await closeDb(ctx.db);
  });

  it('T04 — conta inexistente rejeitada', async () => {
    const ctx = await setup();
    await assert.rejects(
      () => ctx.motor.iniciarConsentimento({
        empresaId: ctx.empresaA.id,
        conta_bancaria_id: 99999,
        provider: 'MOCK_OPEN_FINANCE'
      }),
      (err) => err.code === ERROS.CONTA_NAO_ENCONTRADA
    );
    await closeDb(ctx.db);
  });

  it('T05 — conta de outra empresa rejeitada', async () => {
    const ctx = await setup();
    const { conta } = await contaComConfigOf(ctx, ctx.empresaB.id, 'B', '5');
    await assert.rejects(
      () => ctx.motor.iniciarConsentimento({
        empresaId: ctx.empresaA.id,
        conta_bancaria_id: conta.id,
        provider: 'MOCK_OPEN_FINANCE'
      }),
      (err) => err.code === ERROS.CONTA_NAO_ENCONTRADA || err.code === ERROS.EMPRESA_CONTA_DIVERGENTE
    );
    await closeDb(ctx.db);
  });

  it('T06 — conta inativa rejeitada', async () => {
    const ctx = await setup();
    const { conta } = await contaComConfigOf(ctx, ctx.empresaA.id, 'A', '6');
    await ctx.motor.desativarConta({ empresaId: ctx.empresaA.id, id: conta.id });
    await assert.rejects(
      () => ctx.motor.iniciarConsentimento({
        empresaId: ctx.empresaA.id,
        conta_bancaria_id: conta.id,
        provider: 'MOCK_OPEN_FINANCE'
      }),
      (err) => err.code === ERROS.CONTA_INATIVA
    );
    await closeDb(ctx.db);
  });

  it('T07 — empresa não autorizada recebe 403', async () => {
    const ctx = await setup();
    const { conta } = await contaComConfigOf(ctx, ctx.empresaB.id, 'B', '7');
    const api = await listenApp(ctx, { userId: 2, empresaId: ctx.empresaB.id });
    const out = await api.json('POST', '/api/bancario/open-finance/consentimentos', {
      conta_bancaria_id: conta.id,
      provider: 'MOCK_OPEN_FINANCE'
    });
    assert.equal(out.status, 403);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T08 — instituição incompatível rejeitada', async () => {
    const ctx = await setup();
    const { conta } = await contaComConfigOf(ctx, ctx.empresaA.id, 'A', '8');
    const outra = await ctx.motor.criarInstituicao({ nome: 'Outra Inst' });
    await assert.rejects(
      () => ctx.motor.iniciarConsentimento({
        empresaId: ctx.empresaA.id,
        conta_bancaria_id: conta.id,
        instituicao_financeira_id: outra.id,
        provider: 'MOCK_OPEN_FINANCE'
      }),
      (err) => err.code === ERROS.INSTITUICAO_INCOMPATIVEL
    );
    await closeDb(ctx.db);
  });

  it('T09 — configuração inexistente rejeitada', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '9');
    await assert.rejects(
      () => ctx.motor.iniciarConsentimento({
        empresaId: ctx.empresaA.id,
        conta_bancaria_id: conta.id,
        provider: 'MOCK_OPEN_FINANCE'
      }),
      (err) => err.code === ERROS.CONFIG_NAO_ENCONTRADA
    );
    await closeDb(ctx.db);
  });

  it('T10 — provider incompatível rejeitado', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '10');
    await ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: conta.id,
      provider: 'MOCK',
      ambiente: 'TESTE'
    });
    await assert.rejects(
      () => ctx.motor.iniciarConsentimento({
        empresaId: ctx.empresaA.id,
        conta_bancaria_id: conta.id,
        provider: 'MOCK_OPEN_FINANCE'
      }),
      (err) => err.code === ERROS.PROVIDER_NAO_EXECUTAVEL
    );
    await assert.rejects(
      () => ctx.motor.iniciarConsentimento({
        empresaId: ctx.empresaA.id,
        conta_bancaria_id: conta.id,
        provider: 'MOCK'
      }),
      (err) => err.code === ERROS.PROVIDER_NAO_EXECUTAVEL
    );
    await closeDb(ctx.db);
  });

  it('T15 — state não previsível', async () => {
    const ctx = await setup();
    const a = await contaComConfigOf(ctx, ctx.empresaA.id, 'A', '15a');
    const b = await contaComConfigOf(ctx, ctx.empresaA.id, 'A', '15b');
    const o1 = await ctx.motor.iniciarConsentimento({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: a.conta.id,
      provider: 'MOCK_OPEN_FINANCE'
    });
    const o2 = await ctx.motor.iniciarConsentimento({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: b.conta.id,
      provider: 'MOCK_OPEN_FINANCE'
    });
    assert.notEqual(stateDaUrl(o1.authorization_url), stateDaUrl(o2.authorization_url));
    await closeDb(ctx.db);
  });

  it('T17 T18 T19 T34 T36 — callback válido autoriza e usa SecretStore', async () => {
    const ctx = await setup();
    const { conta } = await contaComConfigOf(ctx, ctx.empresaA.id, 'A', '17');
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const ini = await api.json('POST', '/api/bancario/open-finance/consentimentos', {
      conta_bancaria_id: conta.id,
      provider: 'MOCK_OPEN_FINANCE',
      escopos: ['CONTAS', 'SALDOS', 'TRANSACOES']
    });
    assert.equal(ini.status, 201);
    const dumped = JSON.stringify(ini.data);
    assert.doesNotMatch(dumped, /access_token|refresh_token|client_secret/i);
    const cb = await api.json('GET', '/api/bancario/open-finance/callback?state=' + encodeURIComponent(stateDaUrl(ini.data.authorization_url)) + '&resultado=aprovado');
    assert.equal(cb.status, 200);
    assert.equal(cb.data.status, STATUS_CONSENTIMENTO.AUTORIZADO);
    assert.doesNotMatch(JSON.stringify(cb.data), /access_token|refresh_token|client_secret|OF_MOCK_REF/i);
    const item = await ctx.motor.obterConsentimento({ empresaId: ctx.empresaA.id, id: ini.data.consentimento_id });
    assert.equal(item.status, STATUS_CONSENTIMENTO.AUTORIZADO);
    assert.equal(item.consentimento_externo_id, 'OF-MOCK-CONSENT-001');
    assert.equal(await ctx.secretStore.has(chaveSecretConsentimento(item.id)), true);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T20 — callback sem state rejeitado', async () => {
    const ctx = await setup();
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json('GET', '/api/bancario/open-finance/callback');
    assert.equal(out.status, 400);
    assert.equal(out.data.error, 'Autorização inválida.');
    assert.doesNotMatch(JSON.stringify(out.data), /conta|empresa|provider|consentimento/i);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T21 — state inválido rejeitado', async () => {
    const ctx = await setup();
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json('GET', '/api/bancario/open-finance/callback?state=naoexiste');
    assert.equal(out.status, 400);
    assert.equal(out.data.error, 'Autorização inválida.');
    await api.close();
    await closeDb(ctx.db);
  });

  it('T22 — state expirado rejeitado', async () => {
    const ctx = await setup();
    const { conta } = await contaComConfigOf(ctx, ctx.empresaA.id, 'A', '22');
    const ini = await ctx.motor.iniciarConsentimento({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: conta.id,
      provider: 'MOCK_OPEN_FINANCE'
    });
    const state = stateDaUrl(ini.authorization_url);
    await run(ctx.db, `UPDATE consentimento_of_state SET expira_em = ? WHERE state = ?`, ['2000-01-01T00:00:00.000Z', state]);
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    try {
      const out = await api.json('GET', '/api/bancario/open-finance/callback?state=' + encodeURIComponent(state));
      assert.equal(out.status, 400);
      const item = await ctx.motor.obterConsentimento({ empresaId: ctx.empresaA.id, id: ini.consentimento_id });
      assert.equal(item.status, STATUS_CONSENTIMENTO.ERRO);
    } finally {
      await api.close();
      await closeDb(ctx.db);
    }
  });

  it('T23 — state reutilizado rejeitado', async () => {
    const ctx = await setup();
    const { conta } = await contaComConfigOf(ctx, ctx.empresaA.id, 'A', '23');
    const ini = await ctx.motor.iniciarConsentimento({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: conta.id,
      provider: 'MOCK_OPEN_FINANCE'
    });
    const state = stateDaUrl(ini.authorization_url);
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const ok = await api.json('GET', '/api/bancario/open-finance/callback?state=' + encodeURIComponent(state));
    assert.equal(ok.status, 200);
    const again = await api.json('GET', '/api/bancario/open-finance/callback?state=' + encodeURIComponent(state));
    assert.equal(again.status, 400);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T24 — callback com erro marca NEGADO', async () => {
    const ctx = await setup();
    const { conta } = await contaComConfigOf(ctx, ctx.empresaA.id, 'A', '24');
    const ini = await ctx.motor.iniciarConsentimento({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: conta.id,
      provider: 'MOCK_OPEN_FINANCE'
    });
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json(
      'GET',
      '/api/bancario/open-finance/callback?state=' + encodeURIComponent(stateDaUrl(ini.authorization_url)) + '&error=access_denied'
    );
    assert.equal(out.status, 200);
    assert.equal(out.data.status, STATUS_CONSENTIMENTO.NEGADO);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T25 T26 — revogar e não pode ser usado', async () => {
    const ctx = await setup();
    const { conta } = await contaComConfigOf(ctx, ctx.empresaA.id, 'A', '25');
    const ini = await ctx.motor.iniciarConsentimento({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: conta.id,
      provider: 'MOCK_OPEN_FINANCE'
    });
    await ctx.motor.processarCallbackConsentimento({
      state: stateDaUrl(ini.authorization_url),
      query: { resultado: 'aprovado' },
      empresaIdContexto: ctx.empresaA.id
    });
    const rev = await ctx.motor.revogarConsentimento({ empresaId: ctx.empresaA.id, id: ini.consentimento_id });
    assert.equal(rev.status, STATUS_CONSENTIMENTO.REVOGADO);
    await assert.rejects(
      () => ctx.motor.exigirConsentimentoAutorizado({
        empresaId: ctx.empresaA.id,
        id: ini.consentimento_id
      }),
      (err) => err.code === ERROS.CONSENTIMENTO_INVALIDO
    );
    await closeDb(ctx.db);
  });

  it('T27 T28 — renovar cria novo e preserva histórico', async () => {
    const ctx = await setup();
    const { conta } = await contaComConfigOf(ctx, ctx.empresaA.id, 'A', '27');
    const ini = await ctx.motor.iniciarConsentimento({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: conta.id,
      provider: 'MOCK_OPEN_FINANCE'
    });
    await ctx.motor.processarCallbackConsentimento({
      state: stateDaUrl(ini.authorization_url),
      query: { resultado: 'aprovado' },
      empresaIdContexto: ctx.empresaA.id
    });
    const novo = await ctx.motor.renovarConsentimento({ empresaId: ctx.empresaA.id, id: ini.consentimento_id });
    assert.notEqual(novo.consentimento_id, ini.consentimento_id);
    assert.equal(novo.status, STATUS_CONSENTIMENTO.AGUARDANDO_AUTORIZACAO);
    const lista = await ctx.motor.listarConsentimentos({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: conta.id
    });
    assert.ok(lista.length >= 2);
    assert.ok(lista.some((c) => c.id === ini.consentimento_id && c.status === STATUS_CONSENTIMENTO.REVOGADO));
    await closeDb(ctx.db);
  });

  it('T29 — consentimento expirado', async () => {
    const ctx = await setup();
    const { conta } = await contaComConfigOf(ctx, ctx.empresaA.id, 'A', '29');
    const ini = await ctx.motor.iniciarConsentimento({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: conta.id,
      provider: 'MOCK_OPEN_FINANCE'
    });
    await ctx.motor.processarCallbackConsentimento({
      state: stateDaUrl(ini.authorization_url),
      query: { resultado: 'aprovado' },
      empresaIdContexto: ctx.empresaA.id
    });
    await run(ctx.db, `UPDATE consentimento_open_finance SET expira_em = ? WHERE id = ?`, ['2000-01-01T00:00:00.000Z', ini.consentimento_id]);
    const item = await ctx.motor.obterConsentimento({ empresaId: ctx.empresaA.id, id: ini.consentimento_id });
    assert.equal(item.status, STATUS_CONSENTIMENTO.EXPIRADO);
    await closeDb(ctx.db);
  });

  it('T30 T31 — listar por empresa e isolamento', async () => {
    const ctx = await setup();
    const a = await contaComConfigOf(ctx, ctx.empresaA.id, 'A', '30');
    const b = await contaComConfigOf(ctx, ctx.empresaB.id, 'B', '30');
    await ctx.motor.iniciarConsentimento({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: a.conta.id,
      provider: 'MOCK_OPEN_FINANCE'
    });
    await ctx.motor.iniciarConsentimento({
      empresaId: ctx.empresaB.id,
      conta_bancaria_id: b.conta.id,
      provider: 'MOCK_OPEN_FINANCE'
    });
    const listaA = await ctx.motor.listarConsentimentos({ empresaId: ctx.empresaA.id });
    const listaB = await ctx.motor.listarConsentimentos({ empresaId: ctx.empresaB.id });
    assert.equal(listaA.every((c) => c.empresa_id === ctx.empresaA.id), true);
    assert.equal(listaB.every((c) => c.empresa_id === ctx.empresaB.id), true);
    assert.equal(listaA.some((c) => c.empresa_id === ctx.empresaB.id), false);
    await closeDb(ctx.db);
  });

  it('T32 — empresa_id body não altera contexto', async () => {
    const ctx = await setup();
    const a = await contaComConfigOf(ctx, ctx.empresaA.id, 'A', '32');
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json('POST', '/api/bancario/open-finance/consentimentos', {
      conta_bancaria_id: a.conta.id,
      provider: 'MOCK_OPEN_FINANCE',
      empresa_id: ctx.empresaB.id
    });
    assert.equal(out.status, 201);
    const item = await ctx.motor.obterConsentimento({ empresaId: ctx.empresaA.id, id: out.data.consentimento_id });
    assert.equal(item.empresa_id, ctx.empresaA.id);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T33 — empresa_id query não altera contexto', async () => {
    const ctx = await setup();
    const a = await contaComConfigOf(ctx, ctx.empresaA.id, 'A', '33');
    await ctx.motor.iniciarConsentimento({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: a.conta.id,
      provider: 'MOCK_OPEN_FINANCE'
    });
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json('GET', '/api/bancario/open-finance/consentimentos?empresa_id=' + ctx.empresaB.id);
    assert.equal(out.status, 200);
    assert.equal(out.data.empresa_id, ctx.empresaA.id);
    assert.equal(out.data.consentimentos.every((c) => c.empresa_id === ctx.empresaA.id), true);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T35 — token nunca aparece no log', async () => {
    const ctx = await setup();
    const { conta } = await contaComConfigOf(ctx, ctx.empresaA.id, 'A', '35');
    const logs = [];
    const orig = console.log;
    console.log = (...args) => { logs.push(args.map(String).join(' ')); };
    try {
      const ini = await ctx.motor.iniciarConsentimento({
        empresaId: ctx.empresaA.id,
        conta_bancaria_id: conta.id,
        provider: 'MOCK_OPEN_FINANCE'
      });
      await ctx.motor.processarCallbackConsentimento({
        state: stateDaUrl(ini.authorization_url),
        query: { resultado: 'aprovado' },
        empresaIdContexto: ctx.empresaA.id
      });
    } finally {
      console.log = orig;
    }
    assert.doesNotMatch(logs.join('\n'), /access_token|refresh_token|client_secret/i);
    await closeDb(ctx.db);
  });

  it('T37 T38 T39 T40 — MOCK não usa HTTP nem sincroniza', async () => {
    const ctx = await setup();
    const { conta } = await contaComConfigOf(ctx, ctx.empresaA.id, 'A', '37');
    const ini = await ctx.motor.iniciarConsentimento({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: conta.id,
      provider: 'MOCK_OPEN_FINANCE'
    });
    await ctx.motor.processarCallbackConsentimento({
      state: stateDaUrl(ini.authorization_url),
      query: { resultado: 'aprovado' },
      empresaIdContexto: ctx.empresaA.id
    });
    const txs = await ctx.motor.listarTransacoes({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id });
    const conc = await ctx.motor.listarConciliacoes({ empresaId: ctx.empresaA.id });
    assert.equal(txs.length, 0);
    assert.equal(conc.length, 0);
    const mockSrc = src('backend/motores/bancario/providers/MockOpenFinanceProvider.js');
    assert.doesNotMatch(mockSrc, /require\(['"]https?['"]\)|fetch\(/i);
    assert.doesNotMatch(mockSrc, /INSERT INTO transacao_bancaria|INSERT INTO conciliacao_bancaria/i);
    const svc = src('backend/motores/bancario/services/ConsentimentoOpenFinanceService.js');
    assert.doesNotMatch(svc, /consultarSaldo|listarTransacoes|getBalance/i);
    await closeDb(ctx.db);
  });

  it('T41 — duas autorizações simultâneas não criam dois ativos', async () => {
    const ctx = await setup();
    const { conta } = await contaComConfigOf(ctx, ctx.empresaA.id, 'A', '41');
    const params = {
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: conta.id,
      provider: 'MOCK_OPEN_FINANCE'
    };
    const [a, b] = await Promise.all([
      ctx.motor.iniciarConsentimento(params),
      ctx.motor.iniciarConsentimento(params)
    ]);
    const ids = new Set([a.consentimento_id, b.consentimento_id]);
    const operacionais = await all(
      ctx.db,
      `SELECT * FROM consentimento_open_finance
       WHERE conta_bancaria_id = ? AND status IN ('INICIADO','AGUARDANDO_AUTORIZACAO','AUTORIZADO')`,
      [conta.id]
    );
    assert.equal(operacionais.length, 1);
    assert.equal(ids.size, 1);
    await closeDb(ctx.db);
  });

  it('T42 — instituição compartilhada continua sem empresa_id', () => {
    const schema = src('backend/motores/bancario/schema/bancarioSchema.js');
    const bloco = schema.split('CREATE TABLE IF NOT EXISTS instituicao_financeira')[1].split(')')[0];
    assert.doesNotMatch(bloco, /empresa_id/);
  });

  it('T43 — consentimento possui empresa igual à conta', async () => {
    const ctx = await setup();
    const { conta } = await contaComConfigOf(ctx, ctx.empresaA.id, 'A', '43');
    const ini = await ctx.motor.iniciarConsentimento({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: conta.id,
      provider: 'MOCK_OPEN_FINANCE'
    });
    const item = await ctx.motor.obterConsentimento({ empresaId: ctx.empresaA.id, id: ini.consentimento_id });
    assert.equal(item.empresa_id, conta.empresa_id);
    assert.equal(item.instituicao_financeira_id, conta.instituicao_financeira_id);
    await closeDb(ctx.db);
  });

  it('T44 — troca de empresa limpa contexto da UI', () => {
    const js = src('frontend/erp/js/contas-bancarias.js');
    assert.match(js, /cds-empresa-contexto-alterado/);
    assert.match(js, /consentimentosCache = \[\]/);
    assert.match(js, /limparPainelTransacoes/);
    assert.match(js, /mbcOfBody/);
    assert.doesNotMatch(js, /access_token|refresh_token|client_secret|localStorage\.setItem\(['"]token_of/i);
    assert.match(src('frontend/erp/pages/contas-bancarias.html'), /Open Finance/);
  });

  it('callback de outra empresa rejeitado', async () => {
    const ctx = await setup();
    const { conta } = await contaComConfigOf(ctx, ctx.empresaA.id, 'A', '45');
    const ini = await ctx.motor.iniciarConsentimento({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: conta.id,
      provider: 'MOCK_OPEN_FINANCE'
    });
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaB.id });
    const out = await api.json(
      'GET',
      '/api/bancario/open-finance/callback?state=' + encodeURIComponent(stateDaUrl(ini.authorization_url))
    );
    assert.equal(out.status, 400);
    const item = await ctx.motor.obterConsentimento({ empresaId: ctx.empresaA.id, id: ini.consentimento_id });
    assert.equal(item.status, STATUS_CONSENTIMENTO.AGUARDANDO_AUTORIZACAO);
    await api.close();
    await closeDb(ctx.db);
  });
});
