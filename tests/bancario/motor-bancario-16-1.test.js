/**
 * Sprint MBC-16.1 — leitura real Mercado Pago (sem persistência).
 * Contrato oficial: /v1/account/settlement_report (Dinheiro em conta).
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const UsuarioEmpresaService = require('../../backend/services/empresas/UsuarioEmpresaService');
const { garantirSchemaBancarioAsync } = require('../../backend/motores/bancario/schema/bancarioSchema');
const { obterMotorBancario } = require('../../backend/motores/bancario/MotorBancarioService');
const { MemorySecretStore } = require('../../backend/motores/bancario/secrets/MemorySecretStore');
const { chaveOauthMercadoPago, gravarPayloadOauth } = require('../../backend/motores/bancario/services/MercadoPagoOAuthService');
const {
  SALDO_NAO_DISPONIVEL
} = require('../../backend/motores/bancario/services/MercadoPagoLeituraService');
const { MercadoPagoApiClient, API_BASE, categorizarHttp } = require('../../backend/motores/bancario/providers/mercadopago/MercadoPagoApiClient');
const {
  mapearLinhaRelatorio,
  mapearCsvParaDtos,
  parseCsv,
  EXTERNAL_SOURCE
} = require('../../backend/motores/bancario/providers/mercadopago/MercadoPagoAccountMoneyMapper');
const VERSAO = require('../../backend/motores/bancario/version');
const { dbGet } = require('../../backend/motores/bancario/services/dbPromessas');

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

const CSV_OK = [
  'SOURCE_ID;EXTERNAL_REFERENCE;TRANSACTION_TYPE;TRANSACTION_DATE;SETTLEMENT_DATE;SETTLEMENT_NET_AMOUNT;SETTLEMENT_CURRENCY;TRANSACTION_AMOUNT',
  'SRC-100;REF-A;SETTLEMENT;2026-09-01T10:00:00Z;2026-09-01T12:00:00Z;150.55;BRL;160.00',
  'SRC-200;REF-B;WITHDRAWAL;2026-09-02T10:00:00Z;2026-09-02T12:00:00Z;-40.00;BRL;-40.00'
].join('\n');

function mockApiClient(opts = {}) {
  const calls = [];
  return {
    calls,
    async getConfig() {
      calls.push('getConfig');
      if (opts.config404) {
        const e = new Error('not found');
        e.statusCode = 404;
        e.code = 'MBC_PROVIDER_INDISPONIVEL';
        throw e;
      }
      return { status: 200, body: { columns: [] } };
    },
    async postConfig() { calls.push('postConfig'); return { status: 200, body: {} }; },
    async putConfig() { calls.push('putConfig'); return { status: 200, body: {} }; },
    async criarRelatorio(_t, begin, end) {
      calls.push({ op: 'criar', begin, end });
      if (opts.createStatus) return { status: opts.createStatus, body: { id: 1 } };
      return { status: 202, body: { id: 1 } };
    },
    async listarRelatorios() {
      calls.push('listar');
      if (opts.lista) return { status: 200, body: opts.lista };
      return {
        status: 200,
        body: [{
          id: 99,
          status: 'processed',
          file_name: 'cds-settlement-2026.csv',
          begin_date: '2026-09-01T00:00:00Z',
          end_date: '2026-09-08T00:00:00Z',
          currency_id: 'BRL',
          generation_date: '2026-09-06T12:00:00Z'
        }]
      };
    },
    async baixarRelatorio(_t, fileName) {
      calls.push({ op: 'baixar', fileName });
      return { status: 200, body: opts.csv != null ? opts.csv : CSV_OK };
    }
  };
}

async function setup() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaUsuarioEmpresasAsync(db);
  await garantirSchemaBancarioAsync(db);
  const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaA.id, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaB.id, { db });
  const secretStore = new MemorySecretStore();
  const motor = obterMotorBancario({ db, secretStore });
  return { db, empresaA, empresaB, motor, secretStore };
}

async function contaAutorizada(ctx, empresaId, numero) {
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

describe('MBC-16.1 leitura Mercado Pago', () => {
  it('T01 T02 T03 T05 T06 T12 T13 T14 T15 T16 T17 T18 T19 T21 T22 — leitura normalizada sem persistir', async () => {
    const ctx = await setup();
    const { cfg, conta } = await contaAutorizada(ctx, ctx.empresaA.id, 1601);
    const api = mockApiClient();
    const out = await ctx.motor.testarLeituraProviderMercadoPago({
      empresaId: ctx.empresaA.id,
      id: cfg.id,
      apiClient: api
    });
    assert.equal(out.ok, true);
    assert.equal(out.persistiu, false);
    assert.equal(out.status_leitura, 'PRONTO');
    assert.equal(out.saldo.codigo, SALDO_NAO_DISPONIVEL);
    assert.equal(out.movimentacoes.length, 2);
    assert.equal(out.movimentacoes[0].external_id, 'SRC-100');
    assert.equal(out.movimentacoes[0].direcao, 'entrada');
    assert.equal(out.movimentacoes[0].valor, 150.55);
    assert.equal(out.movimentacoes[1].external_id, 'SRC-200');
    assert.equal(out.movimentacoes[1].direcao, 'saida');
    assert.equal(out.movimentacoes[1].valor, 40);
    assert.ok(out.movimentacoes[0].data_transacao);
    assert.ok(out.movimentacoes[0].descricao);
    assert.equal(String(JSON.stringify(out)).includes('AT-1601'), false);
    assert.equal(String(JSON.stringify(out)).includes('access_token'), false);
    assert.ok(out.movimentacoes[0].raw_reference.includes('SRC-100'));
    assert.equal(out.movimentacoes[0].raw_reference.includes('AT-'), false);

    const qtd = await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM transacao_bancaria WHERE conta_bancaria_id = ?', [conta.id]);
    assert.equal(Number(qtd.n), 0);
    assert.ok(api.calls.some((c) => c && c.op === 'criar'));
    assert.ok(api.calls.includes('listar'));
    await closeDb(ctx.db);
  });

  it('T04 T07 T08 T09 T10 T11 — HTTP erros e Authorization Bearer', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (url.includes('/fail-401')) return { ok: false, status: 401, headers: { get() { return null; } }, async json() { return {}; } };
      if (url.includes('/fail-403')) return { ok: false, status: 403, headers: { get() { return null; } }, async json() { return {}; } };
      if (url.includes('/fail-429')) {
        return { ok: false, status: 429, headers: { get(n) { return n === 'retry-after' ? '12' : null; } }, async json() { return {}; } };
      }
      if (url.includes('/timeout')) {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      }
      return { ok: true, status: 200, headers: { get() { return null; } }, async json() { return { ok: true }; } };
    };
    const client = new MercadoPagoApiClient({ fetchImpl, timeoutMs: 50 });
    await client.request({ path: '/v1/ok', accessToken: 'TOK', operacao: 't' });
    assert.equal(calls[0].url, API_BASE + '/v1/ok');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer TOK');
    assert.match(calls[0].url, /^https:\/\//);

    await assert.rejects(() => client.request({ path: '/fail-401', accessToken: 'TOK' }), (e) => e.statusCode === 401);
    await assert.rejects(() => client.request({ path: '/fail-403', accessToken: 'TOK' }), (e) => e.statusCode === 403);
    await assert.rejects(() => client.request({ path: '/fail-429', accessToken: 'TOK' }), (e) => {
      assert.equal(e.code, 'MBC_PROVIDER_RATE_LIMIT');
      assert.equal(e.retry_after, '12');
      return true;
    });
    await assert.rejects(() => client.request({ path: '/timeout', accessToken: 'TOK' }), (e) => e.code === 'MBC_PROVIDER_TIMEOUT');
    assert.equal(categorizarHttp(401), 'AUTENTICACAO');
    assert.equal(JSON.stringify(calls).includes('TOK') === true, true); // header local da chamada mock
    // retorno sanitizado do erro não deve embutir token
  });

  it('T20 T29 T30 — saldo após nulo; CSV vazio; normalização inválida', () => {
    const ctx = { empresaId: 1, contaBancariaId: 2 };
    const entrada = mapearLinhaRelatorio({
      SOURCE_ID: '1',
      SETTLEMENT_NET_AMOUNT: '10',
      TRANSACTION_TYPE: 'SETTLEMENT',
      TRANSACTION_DATE: '2026-01-01'
    }, ctx);
    assert.equal(entrada.saldo_apos_transacao, null);

    const vazio = mapearCsvParaDtos('', ctx);
    assert.equal(vazio.transacoes.length, 0);

    assert.throws(() => mapearLinhaRelatorio({ SETTLEMENT_NET_AMOUNT: '1' }, ctx));
    assert.throws(() => mapearLinhaRelatorio({ SOURCE_ID: 'X' }, ctx));
    assert.equal(EXTERNAL_SOURCE, 'MERCADO_PAGO_SETTLEMENT_REPORT');
    assert.equal(parseCsv('A;B\n1;2').length, 1);
  });

  it('T23 T24 — isolamento multiempresa de token', async () => {
    const ctx = await setup();
    const a = await contaAutorizada(ctx, ctx.empresaA.id, 1610);
    const b = await contaAutorizada(ctx, ctx.empresaB.id, 1611);
    let tokenUsado = null;
    const api = {
      async getConfig(t) { tokenUsado = t; return { status: 200, body: {} }; },
      async criarRelatorio() { return { status: 202, body: {} }; },
      async listarRelatorios() {
        return {
          status: 200,
          body: [{ id: 1, status: 'processed', file_name: 'f.csv', generation_date: '2026-01-01' }]
        };
      },
      async baixarRelatorio() { return { status: 200, body: CSV_OK }; }
    };
    await ctx.motor.testarLeituraProviderMercadoPago({
      empresaId: ctx.empresaA.id, id: a.cfg.id, apiClient: api
    });
    assert.equal(tokenUsado, 'AT-1610');
    await ctx.motor.testarLeituraProviderMercadoPago({
      empresaId: ctx.empresaB.id, id: b.cfg.id, apiClient: api
    });
    assert.equal(tokenUsado, 'AT-1611');
    await assert.rejects(() => ctx.motor.testarLeituraProviderMercadoPago({
      empresaId: ctx.empresaA.id, id: b.cfg.id, apiClient: api
    }));
    await closeDb(ctx.db);
  });

  it('T25 T26 T27 T28 — bloqueios', async () => {
    const ctx = await setup();
    const { cfg, conta } = await contaAutorizada(ctx, ctx.empresaA.id, 1620);
    const api = mockApiClient();

    await ctx.secretStore.delete(chaveOauthMercadoPago(cfg.id));
    await assert.rejects(() => ctx.motor.testarLeituraProviderMercadoPago({
      empresaId: ctx.empresaA.id, id: cfg.id, apiClient: api
    }), (e) => /não autorizada/i.test(e.message));

    await gravarPayloadOauth(ctx.secretStore, cfg.id, {
      access_token: 'AT-X', expires_at: new Date(Date.now() + 999999).toISOString()
    });
    await ctx.motor.desativarConfiguracaoIntegracao({ empresaId: ctx.empresaA.id, id: cfg.id });
    await assert.rejects(() => ctx.motor.testarLeituraProviderMercadoPago({
      empresaId: ctx.empresaA.id, id: cfg.id, apiClient: api
    }), (e) => e.code === 'MBC_CONFIG_INATIVA');

    const cfgMock = await ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id, provider: 'MOCK', ambiente: 'TESTE'
    });
    await assert.rejects(() => ctx.motor.testarLeituraProviderMercadoPago({
      empresaId: ctx.empresaA.id, id: cfgMock.id, apiClient: api
    }), (e) => e.code === 'MBC_PROVIDER_CREDENCIAL_INCOMPATIVEL');
    await closeDb(ctx.db);
  });

  it('T11 resposta inválida / processamento assíncrono', async () => {
    const ctx = await setup();
    const { cfg } = await contaAutorizada(ctx, ctx.empresaA.id, 1630);
    const api = mockApiClient({
      lista: [{ id: 1, status: 'processing', file_name: null }]
    });
    const out = await ctx.motor.testarLeituraProviderMercadoPago({
      empresaId: ctx.empresaA.id, id: cfg.id, apiClient: api, pollAttempts: 1
    });
    assert.equal(out.status_leitura, 'PROCESSANDO');
    assert.equal(out.movimentacoes.length, 0);
    assert.equal(out.persistiu, false);
    await closeDb(ctx.db);
  });

  it('contrato oficial, sprint e ausência de INSERT direto no serviço de leitura', () => {
    assert.equal(API_BASE, 'https://api.mercadopago.com');
    assert.ok(String(VERSAO.SPRINT).startsWith('MBC-'));
    assert.match(src('backend/rotas/bancario.js'), /provider\/testar-leitura/);
    assert.match(src('backend/motores/bancario/services/MercadoPagoLeituraService.js'), /settlement_report/);
    assert.doesNotMatch(src('backend/motores/bancario/services/MercadoPagoLeituraService.js'), /INSERT INTO transacao_bancaria/i);
    assert.doesNotMatch(src('backend/motores/bancario/providers/mercadopago/MercadoPagoApiClient.js'), /access_token=/);
    assert.ok(fs.existsSync(path.join(ROOT, 'docs/bancario/MBC-16.1-RELATORIO.md')));
  });
});
