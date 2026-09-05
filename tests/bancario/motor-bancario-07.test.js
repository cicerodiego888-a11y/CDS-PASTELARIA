/**
 * Sprint MBC-07 — sincronização de saldo e extrato (MOCK).
 * Executar: node --test tests/bancario/motor-bancario-07.test.js
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
const { ERROS, STATUS_SINCRONIZACAO } = require('../../backend/motores/bancario/contracts/constantes');
const { SALDO_PADRAO } = require('../../backend/motores/bancario/providers/MockOpenFinanceProvider');

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
  await run(db, `CREATE TABLE financeiro (id INTEGER PRIMARY KEY, tipo TEXT, valor REAL, empresa_id INTEGER)`);
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
    db,
    empresaA,
    empresaB,
    motor,
    secretStore,
    registry,
    depsMulti: { db, obterModoOperacionalGlobal: () => ModoOperacionalGlobal.MULTIEMPRESA }
  };
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
  await ctx.motor.criarConfiguracaoIntegracao({
    empresaId,
    conta_bancaria_id: conta.id,
    provider: 'MOCK_OPEN_FINANCE',
    ambiente: 'TESTE'
  });
  return conta;
}

async function autorizarConta(ctx, empresaId, nome, numero) {
  const conta = await contaComConfigOf(ctx, empresaId, nome, numero);
  const ini = await ctx.motor.iniciarConsentimento({
    empresaId,
    conta_bancaria_id: conta.id,
    provider: 'MOCK_OPEN_FINANCE'
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

describe('MBC-07 precondições', () => {
  it('T01 — conta válida sincroniza', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'A', '1');
    const out = await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id });
    assert.equal(out.status, STATUS_SINCRONIZACAO.SUCESSO);
    assert.equal(out.conta_bancaria_id, conta.id);
    await closeDb(ctx.db);
  });

  it('T02 — conta inexistente', async () => {
    const ctx = await setup();
    await assert.rejects(
      () => ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: 99999 }),
      (err) => err.code === ERROS.CONTA_NAO_ENCONTRADA
    );
    await closeDb(ctx.db);
  });

  it('T03 — conta de outra empresa', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaB.id, 'B', '3');
    await assert.rejects(
      () => ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id }),
      (err) => err.code === ERROS.CONTA_NAO_ENCONTRADA
    );
    await closeDb(ctx.db);
  });

  it('T04 — conta inativa', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'A', '4');
    await ctx.motor.desativarConta({ empresaId: ctx.empresaA.id, id: conta.id });
    await assert.rejects(
      () => ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id }),
      (err) => err.code === ERROS.CONTA_INATIVA
    );
    await closeDb(ctx.db);
  });

  it('T05 — sem configuração', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '5');
    await assert.rejects(
      () => ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id }),
      (err) => err.code === ERROS.CONFIG_NAO_ENCONTRADA
    );
    await closeDb(ctx.db);
  });

  it('T06 — provider inexistente', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'A', '6');
    await run(ctx.db, `UPDATE config_integracao_bancaria SET provider = 'BANCO_FANTASMA' WHERE conta_bancaria_id = ?`, [conta.id]);
    await assert.rejects(
      () => ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id }),
      (err) => err.code === ERROS.PROVIDER_DESCONHECIDO
    );
    await closeDb(ctx.db);
  });

  it('T07 — consentimento inexistente', async () => {
    const ctx = await setup();
    const conta = await contaComConfigOf(ctx, ctx.empresaA.id, 'A', '7');
    await assert.rejects(
      () => ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id }),
      (err) => err.code === ERROS.CONSENTIMENTO_NAO_ENCONTRADO
    );
    await closeDb(ctx.db);
  });

  it('T08 — consentimento não autorizado', async () => {
    const ctx = await setup();
    const conta = await contaComConfigOf(ctx, ctx.empresaA.id, 'A', '8');
    await ctx.motor.iniciarConsentimento({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: conta.id,
      provider: 'MOCK_OPEN_FINANCE'
    });
    await assert.rejects(
      () => ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id }),
      (err) => err.code === ERROS.CONSENTIMENTO_INVALIDO
    );
    await closeDb(ctx.db);
  });

  it('T09 — consentimento expirado', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'A', '9');
    await run(ctx.db, `UPDATE consentimento_open_finance SET expira_em = ? WHERE conta_bancaria_id = ?`, ['2000-01-01T00:00:00.000Z', conta.id]);
    await assert.rejects(
      () => ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id }),
      (err) => err.code === ERROS.CONSENTIMENTO_INVALIDO
    );
    const sync = await ctx.motor.obterSincronizacao({ empresaId: ctx.empresaA.id, id: conta.id });
    assert.equal(sync.status, STATUS_SINCRONIZACAO.CONSENTIMENTO_EXPIRADO);
    await closeDb(ctx.db);
  });

  it('T10 — consentimento revogado', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'A', '10');
    const lista = await ctx.motor.listarConsentimentos({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id });
    await ctx.motor.revogarConsentimento({ empresaId: ctx.empresaA.id, id: lista[0].id });
    await assert.rejects(
      () => ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id }),
      (err) => err.code === ERROS.CONSENTIMENTO_INVALIDO
    );
    const sync = await ctx.motor.obterSincronizacao({ empresaId: ctx.empresaA.id, id: conta.id });
    assert.equal(sync.status, STATUS_SINCRONIZACAO.CONSENTIMENTO_REVOGADO);
    await closeDb(ctx.db);
  });
});

describe('MBC-07 saldo', () => {
  it('T11 T12 — consulta e persiste saldo', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'A', '11');
    const out = await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id });
    assert.equal(out.saldo_bancario, SALDO_PADRAO);
    const saldo = await ctx.motor.obterSaldoBancario({ empresaId: ctx.empresaA.id, id: conta.id });
    assert.equal(saldo.saldo_bancario, SALDO_PADRAO);
    assert.equal(saldo.natureza_bancario, 'informado_banco');
    assert.equal(saldo.natureza_conceitual, 'conceitual');
    await closeDb(ctx.db);
  });

  it('T13 — saldo atualizado', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'A', '13');
    await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id });
    of(ctx).saldoOverride = 1300;
    const out = await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id });
    assert.equal(out.saldo_bancario, 1300);
    await closeDb(ctx.db);
  });

  it('T14 — saldo anterior preservado em erro', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'A', '14');
    await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id });
    of(ctx).falharSaldo = true;
    await assert.rejects(() => ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id }));
    const saldo = await ctx.motor.obterSaldoBancario({ empresaId: ctx.empresaA.id, id: conta.id });
    assert.equal(saldo.saldo_bancario, SALDO_PADRAO);
    await closeDb(ctx.db);
  });

  it('T15 — diferença calculada', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'A', '15');
    const out = await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id });
    assert.equal(out.saldo_conceitual, 500);
    assert.equal(out.diferenca, Math.round((SALDO_PADRAO - 500) * 100) / 100);
    await closeDb(ctx.db);
  });
});

describe('MBC-07 extrato e idempotência', () => {
  it('T16 — primeira sincronização', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'A', '16');
    const out = await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id });
    assert.equal(out.transacoes_recebidas, 20);
    assert.equal(out.novas_transacoes, 20);
    assert.equal(out.duplicadas, 0);
    await closeDb(ctx.db);
  });

  it('T17 — segunda sincronização incremental', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'A', '17');
    await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id });
    const out = await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id });
    assert.equal(out.transacoes_recebidas, 0);
    assert.equal(out.novas_transacoes, 0);
    const txs = await ctx.motor.listarTransacoes({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id, limite: 200 });
    assert.equal(txs.length, 20);
    await closeDb(ctx.db);
  });

  it('T18 — idempotência no reprocessamento', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'A', '18');
    await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id });
    const out = await ctx.motor.sincronizarConta({
      empresaId: ctx.empresaA.id,
      id: conta.id,
      reprocessarCatalogo: true
    });
    assert.equal(out.transacoes_recebidas, 20);
    assert.equal(out.novas_transacoes, 0);
    assert.equal(out.duplicadas, 20);
    const txs = await ctx.motor.listarTransacoes({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id, limite: 200 });
    assert.equal(txs.length, 20);
    await closeDb(ctx.db);
  });

  it('T19 T20 — novas transações e duplicadas', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'A', '19');
    await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id });
    of(ctx).liberarPaginaExtra = true;
    const out = await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id });
    assert.equal(out.novas_transacoes, 5);
    assert.equal(out.duplicadas, 0);
    const txs = await ctx.motor.listarTransacoes({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id, limite: 200 });
    assert.equal(txs.length, 25);
    await closeDb(ctx.db);
  });
});

describe('MBC-07 paginação e cursor', () => {
  it('T21 T22 — duas páginas', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'A', '21');
    const out = await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id });
    assert.equal(out.transacoes_recebidas, 20);
    assert.equal(out.cursor, 'CURSOR-002');
    await closeDb(ctx.db);
  });

  it('T23 — cursor inicial nulo', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'A', '23');
    const sync = await ctx.motor.obterSincronizacao({ empresaId: ctx.empresaA.id, id: conta.id });
    assert.equal(sync.status, STATUS_SINCRONIZACAO.PENDENTE);
    assert.equal(sync.cursor_atual, null);
    await closeDb(ctx.db);
  });

  it('T24 — cursor atualizado', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'A', '24');
    await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id });
    const sync = await ctx.motor.obterSincronizacao({ empresaId: ctx.empresaA.id, id: conta.id });
    assert.equal(sync.cursor_atual, 'CURSOR-002');
    await closeDb(ctx.db);
  });

  it('T25 T29 — cursor não avança antes da persistência e retomada', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'A', '25');
    of(ctx).falharNaPagina = 2;
    await assert.rejects(() => ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id }));
    const meio = await ctx.motor.obterSincronizacao({ empresaId: ctx.empresaA.id, id: conta.id });
    assert.equal(meio.cursor_atual, 'CURSOR-001');
    assert.equal(meio.status, STATUS_SINCRONIZACAO.ERRO);
    const parcial = await ctx.motor.listarTransacoes({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id, limite: 200 });
    assert.equal(parcial.length, 10);
    of(ctx).falharNaPagina = 0;
    const out = await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id });
    assert.equal(out.novas_transacoes, 10);
    assert.equal(out.cursor, 'CURSOR-002');
    await closeDb(ctx.db);
  });
});

describe('MBC-07 erro e concorrência', () => {
  it('T26 T27 T28 — erro do provider', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'A', '26');
    of(ctx).falharSaldo = true;
    await assert.rejects(() => ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id }));
    const sync = await ctx.motor.obterSincronizacao({ empresaId: ctx.empresaA.id, id: conta.id });
    assert.equal(sync.status, STATUS_SINCRONIZACAO.ERRO);
    assert.ok(sync.ultimo_erro);
    assert.doesNotMatch(String(sync.ultimo_erro), /access_token|refresh_token|client_secret/i);
    await closeDb(ctx.db);
  });

  it('T30 — sincronização concorrente', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'A', '30');
    const results = await Promise.allSettled([
      ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id }),
      ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id })
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const fail = results.filter((r) => r.status === 'rejected');
    assert.equal(ok.length, 1);
    assert.equal(fail.length, 1);
    assert.equal(fail[0].reason.code, ERROS.SINCRONIZACAO_EM_ANDAMENTO);
    await closeDb(ctx.db);
  });
});

describe('MBC-07 multiempresa e API', () => {
  it('T31 T32 T33 — isolamento A/B', async () => {
    const ctx = await setup();
    const a = await autorizarConta(ctx, ctx.empresaA.id, 'A', '31');
    const b = await autorizarConta(ctx, ctx.empresaB.id, 'B', '32');
    await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: a.id });
    await ctx.motor.sincronizarConta({ empresaId: ctx.empresaB.id, id: b.id });
    const txsA = await ctx.motor.listarTransacoes({ empresaId: ctx.empresaA.id, conta_bancaria_id: a.id, limite: 200 });
    const txsB = await ctx.motor.listarTransacoes({ empresaId: ctx.empresaB.id, conta_bancaria_id: b.id, limite: 200 });
    assert.equal(txsA.every((t) => t.empresa_id === ctx.empresaA.id), true);
    assert.equal(txsB.every((t) => t.empresa_id === ctx.empresaB.id), true);
    await assert.rejects(
      () => ctx.motor.obterSincronizacao({ empresaId: ctx.empresaA.id, id: b.id }),
      (err) => err.code === ERROS.CONTA_NAO_ENCONTRADA
    );
    await closeDb(ctx.db);
  });

  it('T34 — empresa_id body ignorado', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'A', '34');
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json('POST', '/api/bancario/contas/' + conta.id + '/sincronizar', {
      empresa_id: ctx.empresaB.id
    });
    assert.equal(out.status, 200);
    assert.equal(out.data.empresa_id, ctx.empresaA.id);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T35 — empresa_id query ignorado', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'A', '35');
    await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id });
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json('GET', '/api/bancario/contas/' + conta.id + '/sincronizacao?empresa_id=' + ctx.empresaB.id);
    assert.equal(out.status, 200);
    assert.equal(out.data.empresa_id, ctx.empresaA.id);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T36 — permissão', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaB.id, 'B', '36');
    const api = await listenApp(ctx, { userId: 2, empresaId: ctx.empresaB.id });
    const out = await api.json('POST', '/api/bancario/contas/' + conta.id + '/sincronizar');
    assert.equal(out.status, 403);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T37 — extrato', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'A', '37');
    await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id });
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json('GET', '/api/bancario/contas/' + conta.id + '/extrato');
    assert.equal(out.status, 200);
    assert.equal(out.data.transacoes.length, 20);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T38 — filtro de período', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'A', '38');
    await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id });
    const txs = await ctx.motor.listarTransacoes({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: conta.id,
      data_inicio: '2026-01-01',
      data_fim: '2026-01-05'
    });
    assert.equal(txs.length, 5);
    await closeDb(ctx.db);
  });

  it('T39 — ordenação', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'A', '39');
    await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id });
    const txs = await ctx.motor.listarTransacoes({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id, limite: 200 });
    assert.ok(txs[0].data_transacao >= txs[1].data_transacao);
    await closeDb(ctx.db);
  });

  it('T40 — limite', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'A', '40');
    await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id });
    const txs = await ctx.motor.listarTransacoes({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: conta.id,
      limite: 3
    });
    assert.equal(txs.length, 3);
    await closeDb(ctx.db);
  });
});

describe('MBC-07 UI e integridade', () => {
  it('T41 — UI empresa A', () => {
    const js = src('frontend/erp/js/contas-bancarias.js');
    assert.match(js, /carregarSincronizacao/);
    assert.match(js, /saldo-bancario/);
  });

  it('T42 — UI troca de empresa', () => {
    const js = src('frontend/erp/js/contas-bancarias.js');
    assert.match(js, /cds-empresa-contexto-alterado/);
    assert.match(js, /mbcSyncSaldoBancario/);
    assert.match(js, /mbcExtratoBody/);
  });

  it('T43 — UI status', () => {
    const js = src('frontend/erp/js/contas-bancarias.js');
    assert.match(js, /Sincronizado/);
    assert.match(js, /Erro na sincronização/);
  });

  it('T44 — UI saldo', () => {
    assert.match(src('frontend/erp/pages/contas-bancarias.html'), /Saldo bancário/);
    assert.match(src('frontend/erp/pages/contas-bancarias.html'), /Saldo conceitual/);
    assert.match(src('frontend/erp/pages/contas-bancarias.html'), /Diferença/);
  });

  it('T45 — UI extrato', () => {
    assert.match(src('frontend/erp/pages/contas-bancarias.html'), /Extrato bancário/);
    assert.match(src('frontend/erp/js/contas-bancarias.js'), /\/extrato/);
    assert.doesNotMatch(src('frontend/erp/js/contas-bancarias.js'), /access_token|refresh_token|client_secret/);
  });

  it('T46 T47 T48 T49 T50 — não altera financeiro vendas compras caixa PDV', async () => {
    const ctx = await setup();
    const before = {
      financeiro: (await get(ctx.db, 'SELECT COUNT(*) AS n FROM financeiro')).n,
      vendas: (await get(ctx.db, 'SELECT COUNT(*) AS n FROM vendas')).n,
      compras: (await get(ctx.db, 'SELECT COUNT(*) AS n FROM compras')).n,
      caixa: (await get(ctx.db, 'SELECT COUNT(*) AS n FROM caixa_sessoes')).n,
      pdv: (await get(ctx.db, 'SELECT COUNT(*) AS n FROM pdv_vendas')).n
    };
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'A', '46');
    await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id });
    assert.equal((await get(ctx.db, 'SELECT COUNT(*) AS n FROM financeiro')).n, before.financeiro);
    assert.equal((await get(ctx.db, 'SELECT COUNT(*) AS n FROM vendas')).n, before.vendas);
    assert.equal((await get(ctx.db, 'SELECT COUNT(*) AS n FROM compras')).n, before.compras);
    assert.equal((await get(ctx.db, 'SELECT COUNT(*) AS n FROM caixa_sessoes')).n, before.caixa);
    assert.equal((await get(ctx.db, 'SELECT COUNT(*) AS n FROM pdv_vendas')).n, before.pdv);
    const txs = await ctx.motor.listarTransacoes({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id, limite: 200 });
    assert.equal(txs.length, 20);
    const svc = src('backend/motores/bancario/services/SincronizacaoBancariaService.js');
    assert.doesNotMatch(svc, /INSERT INTO financeiro|INSERT INTO vendas|INSERT INTO compras|INSERT INTO caixa|INSERT INTO pdv/i);
    assert.match(svc, /TransacaoBancariaService\.registrar/);
    const mock = src('backend/motores/bancario/providers/MockOpenFinanceProvider.js');
    assert.doesNotMatch(mock, /INSERT INTO transacao_bancaria/i);
    assert.doesNotMatch(mock, /require\(['"]https?['"]\)|fetch\(/);
    await closeDb(ctx.db);
  });

  it('provider MOCK genérico não sincroniza', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '51');
    await ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: conta.id,
      provider: 'MOCK',
      ambiente: 'TESTE'
    });
    await assert.rejects(
      () => ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id }),
      (err) => err.code === ERROS.PROVIDER_SEM_SINCRONIZACAO
    );
    await closeDb(ctx.db);
  });

  it('T51 — schema de sincronização sem credenciais', () => {
    const schema = src('backend/motores/bancario/schema/bancarioSchema.js');
    assert.match(schema, /sincronizacao_bancaria/);
    assert.doesNotMatch(schema, /access_token|refresh_token|client_secret/);
  });

  it('T52 — IBankProvider declara suportaSincronizacao', () => {
    const { IBankProvider } = require('../../backend/motores/bancario/contracts/IBankProvider');
    const base = new IBankProvider();
    assert.equal(base.suportaSincronizacao, false);
    assert.equal(of({ registry: criarRegistryPadrao() }).suportaSincronizacao, true);
  });

  it('T53 — sincronização grava consentimento da mesma conta', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'A', '53');
    await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id });
    const row = await get(ctx.db, `SELECT * FROM sincronizacao_bancaria WHERE conta_bancaria_id = ?`, [conta.id]);
    assert.equal(row.empresa_id, conta.empresa_id);
    const cons = await get(ctx.db, `SELECT * FROM consentimento_open_finance WHERE id = ?`, [row.consentimento_open_finance_id]);
    assert.equal(cons.conta_bancaria_id, conta.id);
    assert.equal(cons.empresa_id, conta.empresa_id);
    await closeDb(ctx.db);
  });

  it('T54 — GET saldo-bancario HTTP', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'A', '54');
    await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id });
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json('GET', '/api/bancario/contas/' + conta.id + '/saldo-bancario');
    assert.equal(out.status, 200);
    assert.equal(out.data.saldo_bancario, SALDO_PADRAO);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T55 — GET sincronizacao HTTP após sucesso', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'A', '55');
    await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id });
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json('GET', '/api/bancario/contas/' + conta.id + '/sincronizacao');
    assert.equal(out.status, 200);
    assert.equal(out.data.status, STATUS_SINCRONIZACAO.SUCESSO);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T56 — transações usam source MOCK_OPEN_FINANCE', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'A', '56');
    await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id });
    const txs = await ctx.motor.listarTransacoes({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id, limite: 200 });
    assert.ok(txs.every((t) => t.external_source === 'MOCK_OPEN_FINANCE' && t.external_id));
    await closeDb(ctx.db);
  });

  it('T57 — importarTransacoes da fundação permanece fora de escopo', async () => {
    const ctx = await setup();
    assert.throws(
      () => ctx.motor.importarTransacoes({ empresaId: ctx.empresaA.id }),
      (err) => err.code === ERROS.SINCRONIZACAO_FORA_ESCOPO
    );
    await closeDb(ctx.db);
  });

  it('T58 — UI botão Sincronizar agora', () => {
    assert.match(src('frontend/erp/pages/contas-bancarias.html'), /Sincronizar agora/);
    assert.match(src('frontend/erp/js/contas-bancarias.js'), /mbcSyncAgora/);
  });

  it('T59 — cursor por conta não é compartilhado', async () => {
    const ctx = await setup();
    const a = await autorizarConta(ctx, ctx.empresaA.id, 'A', '59a');
    const b = await autorizarConta(ctx, ctx.empresaA.id, 'A', '59b');
    of(ctx).falharNaPagina = 2;
    await assert.rejects(() => ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: a.id }));
    of(ctx).falharNaPagina = 0;
    await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: b.id });
    const sa = await ctx.motor.obterSincronizacao({ empresaId: ctx.empresaA.id, id: a.id });
    const sb = await ctx.motor.obterSincronizacao({ empresaId: ctx.empresaA.id, id: b.id });
    assert.equal(sa.cursor_atual, 'CURSOR-001');
    assert.equal(sb.cursor_atual, 'CURSOR-002');
    await closeDb(ctx.db);
  });

  it('T60 — sem Math.random no mock de sincronização', () => {
    const mock = src('backend/motores/bancario/providers/MockOpenFinanceProvider.js');
    assert.doesNotMatch(mock, /Math\.random/);
  });

  it('JSON da sincronização não contém token', async () => {
    const ctx = await setup();
    const conta = await autorizarConta(ctx, ctx.empresaA.id, 'A', '52');
    const out = await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, id: conta.id });
    assert.doesNotMatch(JSON.stringify(out), /access_token|refresh_token|client_secret|state=/i);
    await closeDb(ctx.db);
  });
});
