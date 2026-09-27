/**
 * Sprint MBC-16.3 — sincronização real Mercado Pago (checkpoint interno + continuidade).
 * Executar: node --test tests/bancario/motor-bancario-16-3.test.js
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
const { MemorySecretStore } = require('../../backend/motores/bancario/secrets/MemorySecretStore');
const { chaveOauthMercadoPago, gravarPayloadOauth } = require('../../backend/motores/bancario/services/MercadoPagoOAuthService');
const {
  CHECKPOINT_KIND,
  MAX_DIAS_PERIODO_OFICIAL,
  validarPeriodoSettlement,
  parseCheckpointInterno,
  comRetryLimitado,
  categoriaPermiteRetry
} = require('../../backend/motores/bancario/services/MercadoPagoSincronizacaoService');
const { EXTERNAL_SOURCE } = require('../../backend/motores/bancario/providers/mercadopago/MercadoPagoAccountMoneyMapper');
const { CATEGORIA_ERRO_PROVIDER, ERROS, STATUS_SINCRONIZACAO, erroMbc } = require('../../backend/motores/bancario/contracts/constantes');
const VERSAO = require('../../backend/motores/bancario/version');
const { dbGet, dbAll, dbRun } = require('../../backend/motores/bancario/services/dbPromessas');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

function src(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}
function closeDb(db) {
  return new Promise((resolve) => { try { db.close(() => resolve()); } catch (_) { resolve(); } });
}

function csvHeader() {
  return 'SOURCE_ID;EXTERNAL_REFERENCE;TRANSACTION_TYPE;TRANSACTION_DATE;SETTLEMENT_DATE;SETTLEMENT_NET_AMOUNT;SETTLEMENT_CURRENCY;TRANSACTION_AMOUNT';
}

function csvMovimentos(prefix, n, start = 1) {
  const rows = [csvHeader()];
  for (let i = 0; i < n; i += 1) {
    const id = start + i;
    const valor = ((i % 2 === 0) ? 1 : -1) * (10 + i);
    rows.push(
      `${prefix}${id};R${id};SETTLEMENT;2026-09-01T10:00:00Z;2026-09-01T12:00:00Z;${valor}.00;BRL;${valor}.00`
    );
  }
  return rows.join('\n');
}

function mockApiDoisArquivos(opts = {}) {
  const calls = { criar: 0, listar: 0, baixar: [], getConfig: 0 };
  const csv1 = opts.csv1 != null ? opts.csv1 : csvMovimentos('P1-', 10, 1);
  const csv2 = opts.csv2 != null ? opts.csv2 : csvMovimentos('P2-', 10, 1);
  return {
    calls,
    async getConfig() { calls.getConfig += 1; return { status: 200, body: {} }; },
    async postConfig() { return { status: 200, body: {} }; },
    async putConfig() { return { status: 200, body: {} }; },
    async criarRelatorio() {
      calls.criar += 1;
      if (opts.failCreate) {
        const e = erroMbc(ERROS.PROVIDER_INDISPONIVEL, 'fail create', opts.failCreateStatus || 500);
        e.categoria = opts.failCreateCat || CATEGORIA_ERRO_PROVIDER.INDISPONIBILIDADE;
        e.statusCode = opts.failCreateStatus || 500;
        throw e;
      }
      return { status: 202, body: { id: 1 } };
    },
    async listarRelatorios() {
      calls.listar += 1;
      if (opts.lista) return { status: 200, body: opts.lista };
      return {
        status: 200,
        body: [
          {
            id: 1,
            report_id: 101,
            status: 'processed',
            file_name: 'page1.csv',
            begin_date: '2026-09-01T00:00:00Z',
            end_date: '2026-09-03T00:00:00Z',
            generation_date: '2026-09-01T12:00:00Z'
          },
          {
            id: 2,
            report_id: 102,
            status: 'processed',
            file_name: 'page2.csv',
            begin_date: '2026-09-03T00:00:00Z',
            end_date: '2026-09-05T00:00:00Z',
            generation_date: '2026-09-03T12:00:00Z'
          }
        ]
      };
    },
    async baixarRelatorio(_t, fileName) {
      calls.baixar.push(fileName);
      if (opts.failDownload === fileName) {
        const e = erroMbc(ERROS.PROVIDER_INDISPONIVEL, 'fail download', 500);
        e.categoria = CATEGORIA_ERRO_PROVIDER.INDISPONIBILIDADE;
        e.statusCode = 500;
        throw e;
      }
      if (fileName === 'page1.csv') return { status: 200, body: csv1 };
      if (fileName === 'page2.csv') return { status: 200, body: csv2 };
      return { status: 200, body: csv1 };
    }
  };
}

async function setup() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaUsuarioEmpresasAsync(db);
  await garantirSchemaBancarioAsync(db);
  await dbRun(db, `CREATE TABLE IF NOT EXISTS financeiro (id INTEGER PRIMARY KEY, tipo TEXT, valor REAL, empresa_id INTEGER)`);
  await dbRun(db, `CREATE TABLE IF NOT EXISTS contas_receber (id INTEGER PRIMARY KEY, empresa_id INTEGER)`);
  await dbRun(db, `CREATE TABLE IF NOT EXISTS contas_pagar (id INTEGER PRIMARY KEY, empresa_id INTEGER)`);
  await dbRun(db, `CREATE TABLE IF NOT EXISTS vendas (id INTEGER PRIMARY KEY, empresa_id INTEGER)`);
  await dbRun(db, `CREATE TABLE IF NOT EXISTS compras (id INTEGER PRIMARY KEY, empresa_id INTEGER)`);
  const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaA.id, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaB.id, { db });
  const secretStore = new MemorySecretStore();
  const motor = obterMotorBancario({ db, secretStore });
  return {
    db, empresaA, empresaB, motor, secretStore,
    depsMulti: { db, obterModoOperacionalGlobal: () => ModoOperacionalGlobal.MULTIEMPRESA }
  };
}

async function contaMpAutorizada(ctx, empresaId, numero) {
  const inst = await ctx.motor.criarInstituicao({ nome: 'I' + numero });
  const conta = await ctx.motor.criarConta({
    empresaId, instituicao_financeira_id: inst.id, nome: 'C' + numero, tipo: 'CORRENTE', numero: String(numero)
  });
  const cfg = await ctx.motor.criarConfiguracaoIntegracao({
    empresaId, conta_bancaria_id: conta.id, provider: 'OPEN_FINANCE_REAL', ambiente: 'SANDBOX'
  });
  await ctx.motor.configurarCredenciaisMercadoPago({
    empresaId, id: cfg.id, client_id: 'APP-' + numero, client_secret: 'SEC-' + numero
  });
  await gravarPayloadOauth(ctx.secretStore, cfg.id, {
    access_token: 'AT-' + numero,
    refresh_token: 'RT-' + numero,
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    scope: 'read',
    live_mode: false
  });
  return { conta, cfg };
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
      secretStore: ctx.secretStore
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

describe('MBC-16.3 sincronização Mercado Pago', () => {
  it('T01 T08 T10–T14 T18 T19 T33–T39 T44 T45 — sync OAuth, persistência, checkpoint', async () => {
    const ctx = await setup();
    const { conta, cfg } = await contaMpAutorizada(ctx, ctx.empresaA.id, 16301);
    const api = mockApiDoisArquivos();
    const finAntes = Number((await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM financeiro')).n);
    const concAntes = Number((await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM conciliacao_bancaria')).n);

    const out = await ctx.motor.sincronizarConta({
      empresaId: ctx.empresaA.id,
      id: conta.id,
      apiClient: api,
      forcarMercadoPago: true
    });

    assert.equal(out.status, STATUS_SINCRONIZACAO.SUCESSO);
    assert.equal(out.origem, 'MERCADO_PAGO');
    assert.equal(out.arquivos_processados, 2);
    assert.equal(out.novas_transacoes, 20);
    assert.equal(out.duplicadas, 0);
    assert.equal(out.saldo_bancario, null);
    assert.ok(api.calls.criar >= 1);
    assert.ok(api.calls.baixar.includes('page1.csv'));
    assert.ok(api.calls.baixar.includes('page2.csv'));
    assert.equal(String(JSON.stringify(out)).includes('AT-16301'), false);
    assert.equal(String(JSON.stringify(out)).includes('access_token'), false);

    const cp = parseCheckpointInterno(out.cursor);
    assert.equal(cp.kind, CHECKPOINT_KIND);
    assert.equal(cp.last_safe_report_key, '102');
    assert.ok(cp.processed_report_keys.includes('101'));
    assert.ok(cp.processed_report_keys.includes('102'));

    const rows = await dbAll(ctx.db, 'SELECT * FROM transacao_bancaria WHERE conta_bancaria_id = ?', [conta.id]);
    assert.equal(rows.length, 20);
    assert.ok(rows.every((r) => r.external_source === EXTERNAL_SOURCE));
    assert.ok(rows.every((r) => Number(r.empresa_id) === Number(ctx.empresaA.id)));
    assert.ok(rows.every((r) => r.saldo_apos_transacao == null));
    assert.ok(rows.every((r) => !String(r.raw_reference || '').includes('AT-')));

    const out2 = await ctx.motor.sincronizarConta({
      empresaId: ctx.empresaA.id, id: conta.id, apiClient: api, forcarMercadoPago: true
    });
    assert.equal(out2.novas_transacoes, 0);
    assert.equal(out2.duplicadas, 20);
    assert.equal(Number((await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM transacao_bancaria WHERE conta_bancaria_id = ?', [conta.id])).n), 20);

    assert.equal(Number((await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM financeiro')).n), finAntes);
    assert.equal(Number((await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM contas_receber')).n), 0);
    assert.equal(Number((await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM contas_pagar')).n), 0);
    assert.equal(Number((await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM vendas')).n), 0);
    assert.equal(Number((await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM compras')).n), 0);
    assert.equal(Number((await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM conciliacao_bancaria')).n), concAntes);

    assert.doesNotMatch(src('backend/motores/bancario/providers/mercadopago/MercadoPagoApiClient.js'), /INSERT INTO transacao_bancaria/i);
    assert.match(src('backend/motores/bancario/services/MercadoPagoPersistenciaService.js'), /TransacaoBancariaService\.registrar/);
    assert.equal(cfg.provider, 'OPEN_FINANCE_REAL');
    await closeDb(ctx.db);
  });

  it('T02–T07 — bloqueios OAuth/conta/config/provider', async () => {
    const ctx = await setup();
    const a = await contaMpAutorizada(ctx, ctx.empresaA.id, 16310);
    const b = await contaMpAutorizada(ctx, ctx.empresaB.id, 16311);
    const api = mockApiDoisArquivos();

    await ctx.secretStore.delete(chaveOauthMercadoPago(a.cfg.id));
    await assert.rejects(() => ctx.motor.sincronizarConta({
      empresaId: ctx.empresaA.id, id: a.conta.id, apiClient: api, forcarMercadoPago: true
    }), (e) => /não autorizad/i.test(e.message));

    await gravarPayloadOauth(ctx.secretStore, a.cfg.id, {
      access_token: 'AT-X', expires_at: new Date(Date.now() + 999999).toISOString()
    });

    await assert.rejects(() => ctx.motor.sincronizarConta({
      empresaId: ctx.empresaA.id, id: 999999, apiClient: api, forcarMercadoPago: true
    }));

    await assert.rejects(() => ctx.motor.sincronizarConta({
      empresaId: ctx.empresaA.id, id: b.conta.id, apiClient: api, forcarMercadoPago: true
    }));

    await ctx.motor.desativarConta({ empresaId: ctx.empresaA.id, id: a.conta.id });
    await assert.rejects(() => ctx.motor.sincronizarConta({
      empresaId: ctx.empresaA.id, id: a.conta.id, apiClient: api, forcarMercadoPago: true
    }), (e) => e.code === 'MBC_CONTA_INATIVA' || /inativa/i.test(e.message));

    const conta2 = await contaMpAutorizada(ctx, ctx.empresaA.id, 16312);
    await ctx.motor.desativarConfiguracaoIntegracao({ empresaId: ctx.empresaA.id, id: conta2.cfg.id });
    await assert.rejects(() => ctx.motor.sincronizarConta({
      empresaId: ctx.empresaA.id, id: conta2.conta.id, apiClient: api, forcarMercadoPago: true
    }));

    const conta3 = await ctx.motor.criarConta({
      empresaId: ctx.empresaA.id,
      instituicao_financeira_id: (await ctx.motor.criarInstituicao({ nome: 'IM' })).id,
      nome: 'Mock', tipo: 'CORRENTE', numero: '16313'
    });
    await ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id, conta_bancaria_id: conta3.id, provider: 'MOCK', ambiente: 'TESTE'
    });
    await assert.rejects(() => ctx.motor.sincronizarConta({
      empresaId: ctx.empresaA.id, id: conta3.id, apiClient: api, forcarMercadoPago: true
    }));

    await closeDb(ctx.db);
  });

  it('T09 — PROCESSANDO não avança checkpoint', async () => {
    const ctx = await setup();
    const { conta } = await contaMpAutorizada(ctx, ctx.empresaA.id, 16320);
    const api = mockApiDoisArquivos({
      lista: [{ id: 1, status: 'processing', file_name: null }]
    });
    await assert.rejects(() => ctx.motor.sincronizarConta({
      empresaId: ctx.empresaA.id, id: conta.id, apiClient: api, forcarMercadoPago: true, pollAttempts: 1
    }), (e) => /PROCESSANDO/i.test(e.message));
    const sync = await ctx.motor.obterSincronizacao({ empresaId: ctx.empresaA.id, id: conta.id });
    assert.equal(sync.status, STATUS_SINCRONIZACAO.ERRO);
    assert.equal(sync.cursor_atual, null);
    assert.equal(Number((await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM transacao_bancaria WHERE conta_bancaria_id = ?', [conta.id])).n), 0);
    await closeDb(ctx.db);
  });

  it('T15 T16 T17 — continuidade: falha página 2 + retomada sem duplicidade', async () => {
    const ctx = await setup();
    const { conta } = await contaMpAutorizada(ctx, ctx.empresaA.id, 16330);
    const api = mockApiDoisArquivos();

    await assert.rejects(() => ctx.motor.sincronizarConta({
      empresaId: ctx.empresaA.id,
      id: conta.id,
      apiClient: api,
      forcarMercadoPago: true,
      falharNoArquivo: 'page2.csv'
    }));

    const n1 = Number((await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM transacao_bancaria WHERE conta_bancaria_id = ?', [conta.id])).n);
    assert.equal(n1, 10);
    const sync = await ctx.motor.obterSincronizacao({ empresaId: ctx.empresaA.id, id: conta.id });
    assert.equal(sync.status, STATUS_SINCRONIZACAO.ERRO);
    const cp = parseCheckpointInterno(sync.cursor_atual);
    assert.equal(cp.last_safe_report_key, '101');
    assert.ok(!cp.processed_report_keys.includes('102'));

    const out2 = await ctx.motor.sincronizarConta({
      empresaId: ctx.empresaA.id, id: conta.id, apiClient: api, forcarMercadoPago: true
    });
    assert.equal(out2.novas_transacoes, 10);
    assert.equal(out2.duplicadas, 10);
    const n2 = Number((await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM transacao_bancaria WHERE conta_bancaria_id = ?', [conta.id])).n);
    assert.equal(n2, 20);
    await closeDb(ctx.db);
  });

  it('T20 — três sincronizações sem duplicidade (20 finais)', async () => {
    const ctx = await setup();
    const { conta } = await contaMpAutorizada(ctx, ctx.empresaA.id, 16340);
    const api = mockApiDoisArquivos();
    const s1 = await ctx.motor.sincronizarConta({
      empresaId: ctx.empresaA.id, id: conta.id, apiClient: api, forcarMercadoPago: true
    });
    assert.equal(s1.novas_transacoes, 20);
    const s2 = await ctx.motor.sincronizarConta({
      empresaId: ctx.empresaA.id, id: conta.id, apiClient: api, forcarMercadoPago: true
    });
    assert.equal(s2.novas_transacoes, 0);
    assert.equal(s2.duplicadas, 20);
    const s3 = await ctx.motor.sincronizarConta({
      empresaId: ctx.empresaA.id, id: conta.id, apiClient: api, forcarMercadoPago: true
    });
    assert.equal(s3.novas_transacoes, 0);
    assert.equal(s3.duplicadas, 20);
    assert.equal(Number((await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM transacao_bancaria WHERE conta_bancaria_id = ?', [conta.id])).n), 20);
    await closeDb(ctx.db);
  });

  it('T21 T23 T32 — multiempresa isolada; contas independentes', async () => {
    const ctx = await setup();
    const a = await contaMpAutorizada(ctx, ctx.empresaA.id, 16350);
    const b = await contaMpAutorizada(ctx, ctx.empresaB.id, 16351);
    const csvA = csvMovimentos('A-', 10, 1);
    const csvB = csvMovimentos('B-', 10, 1);
    const apiA = mockApiDoisArquivos({
      lista: [{ id: 1, report_id: 201, status: 'processed', file_name: 'a.csv', generation_date: '2026-09-01' }],
      csv1: csvA
    });
    apiA.baixarRelatorio = async (_t, fn) => ({ status: 200, body: csvA });

    const apiB = mockApiDoisArquivos({
      lista: [{ id: 1, report_id: 301, status: 'processed', file_name: 'b.csv', generation_date: '2026-09-01' }]
    });
    apiB.baixarRelatorio = async () => ({ status: 200, body: csvB });

    await ctx.motor.sincronizarConta({
      empresaId: ctx.empresaA.id, id: a.conta.id, apiClient: apiA, forcarMercadoPago: true
    });
    assert.equal(Number((await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM transacao_bancaria WHERE empresa_id = ?', [ctx.empresaA.id])).n), 10);
    assert.equal(Number((await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM transacao_bancaria WHERE empresa_id = ?', [ctx.empresaB.id])).n), 0);

    await ctx.motor.sincronizarConta({
      empresaId: ctx.empresaB.id, id: b.conta.id, apiClient: apiB, forcarMercadoPago: true
    });
    assert.equal(Number((await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM transacao_bancaria WHERE empresa_id = ?', [ctx.empresaA.id])).n), 10);
    assert.equal(Number((await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM transacao_bancaria WHERE empresa_id = ?', [ctx.empresaB.id])).n), 10);

    await assert.rejects(() => ctx.motor.sincronizarConta({
      empresaId: ctx.empresaB.id, id: a.conta.id, apiClient: apiA, forcarMercadoPago: true
    }));
    await closeDb(ctx.db);
  });

  it('T22 — concorrência mesma conta → 409', async () => {
    const ctx = await setup();
    const { conta } = await contaMpAutorizada(ctx, ctx.empresaA.id, 16360);
    let release;
    const gate = new Promise((r) => { release = r; });
    const api = mockApiDoisArquivos({
      lista: [{ id: 1, report_id: 401, status: 'processed', file_name: 'slow.csv', generation_date: '2026-09-01' }]
    });
    const csv = csvMovimentos('S-', 5, 1);
    api.baixarRelatorio = async () => {
      await gate;
      return { status: 200, body: csv };
    };

    const p1 = ctx.motor.sincronizarConta({
      empresaId: ctx.empresaA.id, id: conta.id, apiClient: api, forcarMercadoPago: true
    });
    await new Promise((r) => setTimeout(r, 30));
    await assert.rejects(() => ctx.motor.sincronizarConta({
      empresaId: ctx.empresaA.id, id: conta.id, apiClient: api, forcarMercadoPago: true
    }), (e) => e.code === ERROS.SINCRONIZACAO_EM_ANDAMENTO || e.statusCode === 409);
    release();
    await p1;
    await closeDb(ctx.db);
  });

  it('T24–T28 — retry limitado; 401/403 sem loop', async () => {
    let n429 = 0;
    const out429 = await comRetryLimitado(async () => {
      n429 += 1;
      if (n429 < 3) {
        const e = erroMbc(ERROS.PROVIDER_RATE_LIMIT, '429', 429);
        e.categoria = CATEGORIA_ERRO_PROVIDER.RATE_LIMIT;
        e.retry_after = '0';
        throw e;
      }
      return 'ok';
    }, { maxExtra: 2, sleepMs: 1 });
    assert.equal(out429, 'ok');
    assert.equal(n429, 3);

    let n401 = 0;
    await assert.rejects(() => comRetryLimitado(async () => {
      n401 += 1;
      const e = erroMbc(ERROS.AUTORIZACAO_INVALIDA, '401', 401);
      e.categoria = CATEGORIA_ERRO_PROVIDER.AUTENTICACAO;
      throw e;
    }, { maxExtra: 2, sleepMs: 1 }), () => true);
    assert.equal(n401, 1);

    let n403 = 0;
    await assert.rejects(() => comRetryLimitado(async () => {
      n403 += 1;
      const e = erroMbc(ERROS.AUTORIZACAO_INVALIDA, '403', 403);
      e.categoria = CATEGORIA_ERRO_PROVIDER.AUTORIZACAO;
      throw e;
    }, { maxExtra: 2, sleepMs: 1 }), () => true);
    assert.equal(n403, 1);

    assert.equal(categoriaPermiteRetry({ categoria: CATEGORIA_ERRO_PROVIDER.TIMEOUT }), true);
    assert.equal(categoriaPermiteRetry({ categoria: CATEGORIA_ERRO_PROVIDER.AUTENTICACAO }), false);

    const ctx = await setup();
    const { conta } = await contaMpAutorizada(ctx, ctx.empresaA.id, 16370);
    let tries = 0;
    const api = mockApiDoisArquivos();
    api.criarRelatorio = async () => {
      tries += 1;
      const e = erroMbc(ERROS.PROVIDER_TIMEOUT, 'timeout', 504);
      e.categoria = CATEGORIA_ERRO_PROVIDER.TIMEOUT;
      e.statusCode = 504;
      throw e;
    };
    await assert.rejects(() => ctx.motor.sincronizarConta({
      empresaId: ctx.empresaA.id, id: conta.id, apiClient: api, forcarMercadoPago: true, retrySleepMs: 1
    }));
    assert.ok(tries >= 3 && tries <= 4);
    const sync = await ctx.motor.obterSincronizacao({ empresaId: ctx.empresaA.id, id: conta.id });
    assert.equal(sync.status, STATUS_SINCRONIZACAO.ERRO);
    assert.equal(sync.cursor_atual, null);
    await closeDb(ctx.db);
  });

  it('T40 T41 — período inválido / acima de 60 dias', () => {
    assert.throws(() => validarPeriodoSettlement('2026-09-10T00:00:00Z', '2026-09-01T00:00:00Z'));
    assert.throws(() => validarPeriodoSettlement('invalid', '2026-09-01T00:00:00Z'));
    assert.throws(() => validarPeriodoSettlement('2026-01-01T00:00:00Z', '2026-04-15T00:00:00Z'));
    assert.equal(MAX_DIAS_PERIODO_OFICIAL, 60);
    const ok = validarPeriodoSettlement('2026-09-01T00:00:00Z', '2026-09-30T00:00:00Z');
    assert.ok(ok.begin_date);
  });

  it('T42 T43 — empresa_id body/query não altera propriedade', async () => {
    const ctx = await setup();
    const a = await contaMpAutorizada(ctx, ctx.empresaA.id, 16380);
    const api = mockApiDoisArquivos({
      lista: [{ id: 1, report_id: 501, status: 'processed', file_name: 'only.csv', generation_date: '2026-09-01' }]
    });
    api.baixarRelatorio = async () => ({ status: 200, body: csvMovimentos('X-', 2, 1) });

    const srv = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    try {
      const r = await srv.json('POST', '/api/bancario/contas/' + a.conta.id + '/sincronizar?empresa_id=' + ctx.empresaB.id, {
        empresa_id: ctx.empresaB.id,
        begin_date: '2026-09-01T00:00:00Z',
        end_date: '2026-09-07T00:00:00Z'
      });
      // Sem apiClient no HTTP — pode falhar por OF real; o importante é não gravar como B
      const nB = Number((await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM transacao_bancaria WHERE empresa_id = ?', [ctx.empresaB.id])).n);
      assert.equal(nB, 0);
      if (r.status === 200) {
        assert.equal(r.data.empresa_id, ctx.empresaA.id);
      }
    } finally {
      await srv.close();
    }

    // via motor: body empresa ignorada — contexto A + conta A
    const out = await ctx.motor.sincronizarConta({
      empresaId: ctx.empresaA.id,
      id: a.conta.id,
      empresa_id: ctx.empresaB.id,
      apiClient: api,
      forcarMercadoPago: true
    });
    assert.equal(out.empresa_id, ctx.empresaA.id);
    assert.equal(Number((await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM transacao_bancaria WHERE empresa_id = ?', [ctx.empresaB.id])).n), 0);
    await closeDb(ctx.db);
  });

  it('contrato, sprint e documentação', () => {
    assert.ok(String(VERSAO.SPRINT).startsWith('MBC-'));
    assert.equal(VERSAO.CODIGO, 'MBC-01');
    assert.equal(CHECKPOINT_KIND, 'mp_settlement_checkpoint_v1');
    assert.match(src('backend/motores/bancario/services/MercadoPagoSincronizacaoService.js'), /checkpoint/i);
    assert.match(src('backend/motores/bancario/services/MercadoPagoSincronizacaoService.js'), /settlement_report/);
    assert.doesNotMatch(src('backend/motores/bancario/services/MercadoPagoSincronizacaoService.js'), /INSERT INTO transacao_bancaria/i);
    assert.ok(fs.existsSync(path.join(ROOT, 'docs/bancario/MBC-16.3-RELATORIO.md')));
  });
});
