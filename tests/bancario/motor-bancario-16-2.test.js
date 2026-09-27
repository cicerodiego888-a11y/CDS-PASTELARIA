/**
 * Sprint MBC-16.2 — persistência do extrato real Mercado Pago no MBC-03.
 * Executar: node --test tests/bancario/motor-bancario-16-2.test.js
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
  EXTERNAL_SOURCE,
  mapearLinhaRelatorio,
  mapearCsvParaDtos
} = require('../../backend/motores/bancario/providers/mercadopago/MercadoPagoAccountMoneyMapper');
const MercadoPagoPersistenciaService = require('../../backend/motores/bancario/services/MercadoPagoPersistenciaService');
const TransacaoBancariaService = require('../../backend/motores/bancario/services/TransacaoBancariaService');
const VERSAO = require('../../backend/motores/bancario/version');
const { STATUS_REGISTRO } = require('../../backend/motores/bancario/contracts/constantes');
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

function csvLinhas(linhas) {
  const header = 'SOURCE_ID;EXTERNAL_REFERENCE;TRANSACTION_TYPE;TRANSACTION_DATE;SETTLEMENT_DATE;SETTLEMENT_NET_AMOUNT;SETTLEMENT_CURRENCY;TRANSACTION_AMOUNT';
  return [header].concat(linhas).join('\n');
}

const CSV_BASE = csvLinhas([
  'SRC-100;REF-A;SETTLEMENT;2026-09-01T10:00:00Z;2026-09-01T12:00:00Z;150.55;BRL;160.00',
  'SRC-200;REF-B;WITHDRAWAL;2026-09-02T10:00:00Z;2026-09-02T12:00:00Z;-40.00;BRL;-40.00'
]);

function csvLote10() {
  const rows = [];
  for (let i = 1; i <= 10; i += 1) {
    const sinal = i % 2 === 0 ? '-' : '';
    rows.push(
      `SRC-L${i};REF-L${i};SETTLEMENT;2026-09-0${(i % 9) + 1}T10:00:00Z;2026-09-0${(i % 9) + 1}T12:00:00Z;${sinal}${i * 10}.00;BRL;${sinal}${i * 10}.00`
    );
  }
  return csvLinhas(rows);
}

function mockApiClient(opts = {}) {
  const calls = [];
  return {
    calls,
    async getConfig() {
      calls.push('getConfig');
      return { status: 200, body: { columns: [] } };
    },
    async postConfig() { calls.push('postConfig'); return { status: 200, body: {} }; },
    async putConfig() { calls.push('putConfig'); return { status: 200, body: {} }; },
    async criarRelatorio() {
      calls.push('criar');
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
      return { status: 200, body: opts.csv != null ? opts.csv : CSV_BASE };
    }
  };
}

async function setup() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaUsuarioEmpresasAsync(db);
  await garantirSchemaBancarioAsync(db);
  await dbRun(db, `CREATE TABLE IF NOT EXISTS financeiro (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tipo TEXT, valor REAL, empresa_id INTEGER
  )`);
  await dbRun(db, `CREATE TABLE IF NOT EXISTS contas_receber (
    id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER, valor REAL
  )`);
  await dbRun(db, `CREATE TABLE IF NOT EXISTS contas_pagar (
    id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER, valor REAL
  )`);
  await dbRun(db, `CREATE TABLE IF NOT EXISTS vendas (
    id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER, valor REAL
  )`);
  await dbRun(db, `CREATE TABLE IF NOT EXISTS compras (
    id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER, valor REAL
  )`);
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

describe('MBC-16.2 persistência Mercado Pago → MBC-03', () => {
  it('T01–T17 T25 T27 T28–T32 T36 — DTO válido persiste; idempotência; sem financeiro', async () => {
    const ctx = await setup();
    const { cfg, conta } = await contaAutorizada(ctx, ctx.empresaA.id, 16201);
    const api = mockApiClient();

    const finAntes = Number((await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM financeiro')).n);
    const crAntes = Number((await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM contas_receber')).n);
    const cpAntes = Number((await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM contas_pagar')).n);
    const vAntes = Number((await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM vendas')).n);
    const cAntes = Number((await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM compras')).n);
    const concAntes = Number((await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM conciliacao_bancaria')).n);

    const out1 = await ctx.motor.testarLeituraProviderMercadoPago({
      empresaId: ctx.empresaA.id,
      id: cfg.id,
      apiClient: api,
      persistir: true
    });

    assert.equal(out1.ok, true);
    assert.equal(out1.persistiu, true);
    assert.equal(out1.status_leitura, 'PRONTO');
    assert.equal(out1.persistencia.criadas, 2);
    assert.equal(out1.persistencia.ja_existentes, 0);
    assert.equal(out1.persistencia.recebidas, 2);
    assert.equal(out1.persistencia.ids_criados.length, 2);
    assert.equal(String(JSON.stringify(out1)).includes('AT-16201'), false);
    assert.equal(String(JSON.stringify(out1)).includes('access_token'), false);
    assert.equal(String(JSON.stringify(out1)).includes('RT-16201'), false);

    const rows = await dbAll(
      ctx.db,
      `SELECT * FROM transacao_bancaria WHERE conta_bancaria_id = ? ORDER BY external_id`,
      [conta.id]
    );
    assert.equal(rows.length, 2);

    const entrada = rows.find((r) => r.external_id === 'SRC-100');
    const saida = rows.find((r) => r.external_id === 'SRC-200');
    assert.ok(entrada);
    assert.ok(saida);
    assert.equal(Number(entrada.empresa_id), Number(ctx.empresaA.id));
    assert.equal(Number(entrada.conta_bancaria_id), Number(conta.id));
    assert.equal(entrada.external_source, EXTERNAL_SOURCE);
    assert.equal(entrada.external_id, 'SRC-100');
    assert.equal(entrada.direcao, 'entrada');
    assert.equal(Number(entrada.valor), 150.55);
    assert.ok(String(entrada.descricao || '').length > 0);
    assert.equal(entrada.referencia_externa, 'REF-A');
    assert.ok(entrada.data_transacao);
    assert.ok(entrada.data_processamento);
    assert.equal(entrada.saldo_apos_transacao, null);
    assert.equal(saida.direcao, 'saida');
    assert.equal(Number(saida.valor), 40);
    assert.equal(saida.referencia_externa, 'REF-B');
    assert.equal(String(entrada.raw_reference || '').includes('AT-'), false);
    assert.equal(String(entrada.raw_reference || '').includes('access_token'), false);

    const out2 = await ctx.motor.testarLeituraProviderMercadoPago({
      empresaId: ctx.empresaA.id,
      id: cfg.id,
      apiClient: api,
      persistir: true
    });
    assert.equal(out2.persistencia.criadas, 0);
    assert.equal(out2.persistencia.ja_existentes, 2);
    const qtd = await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM transacao_bancaria WHERE conta_bancaria_id = ?', [conta.id]);
    assert.equal(Number(qtd.n), 2);

    assert.equal(Number((await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM financeiro')).n), finAntes);
    assert.equal(Number((await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM contas_receber')).n), crAntes);
    assert.equal(Number((await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM contas_pagar')).n), cpAntes);
    assert.equal(Number((await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM vendas')).n), vAntes);
    assert.equal(Number((await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM compras')).n), cAntes);
    assert.equal(Number((await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM conciliacao_bancaria')).n), concAntes);

    const listA = await TransacaoBancariaService.listar({
      db: ctx.db, empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id
    });
    assert.equal(listA.length, 2);

    await closeDb(ctx.db);
  });

  it('T18 T34 — SOURCE_ID ausente e inválidos não geram registro', async () => {
    const ctx = await setup();
    const { cfg, conta } = await contaAutorizada(ctx, ctx.empresaA.id, 16210);
    const csv = csvLinhas([
      ';REF-X;SETTLEMENT;2026-09-01T10:00:00Z;2026-09-01T12:00:00Z;10.00;BRL;10.00',
      'SRC-OK;REF-Y;SETTLEMENT;2026-09-01T10:00:00Z;2026-09-01T12:00:00Z;20.00;BRL;20.00'
    ]);
    const api = mockApiClient({ csv });
    const out = await ctx.motor.testarLeituraProviderMercadoPago({
      empresaId: ctx.empresaA.id, id: cfg.id, apiClient: api, persistir: true
    });
    assert.equal(out.persistencia.criadas, 1);
    assert.ok(out.rejeitadas.length >= 1);
    const qtd = await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM transacao_bancaria WHERE conta_bancaria_id = ?', [conta.id]);
    assert.equal(Number(qtd.n), 1);
    await closeDb(ctx.db);
  });

  it('T19 T20 T22 T23 T24 — bloqueios de conta/config/provider/oauth', async () => {
    const ctx = await setup();
    const a = await contaAutorizada(ctx, ctx.empresaA.id, 16220);
    const b = await contaAutorizada(ctx, ctx.empresaB.id, 16221);
    const api = mockApiClient();

    await assert.rejects(() => ctx.motor.testarLeituraProviderMercadoPago({
      empresaId: ctx.empresaA.id, id: 999999, apiClient: api, persistir: true
    }));

    await assert.rejects(() => ctx.motor.testarLeituraProviderMercadoPago({
      empresaId: ctx.empresaA.id, id: b.cfg.id, apiClient: api, persistir: true
    }));

    await ctx.secretStore.delete(chaveOauthMercadoPago(a.cfg.id));
    await assert.rejects(() => ctx.motor.testarLeituraProviderMercadoPago({
      empresaId: ctx.empresaA.id, id: a.cfg.id, apiClient: api, persistir: true
    }), (e) => /não autorizada/i.test(e.message));

    await gravarPayloadOauth(ctx.secretStore, a.cfg.id, {
      access_token: 'AT-X', expires_at: new Date(Date.now() + 999999).toISOString()
    });
    const cfgMock = await ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id, conta_bancaria_id: a.conta.id, provider: 'MOCK', ambiente: 'TESTE'
    });
    await assert.rejects(() => ctx.motor.testarLeituraProviderMercadoPago({
      empresaId: ctx.empresaA.id, id: cfgMock.id, apiClient: api, persistir: true
    }), (e) => e.code === 'MBC_PROVIDER_CREDENCIAL_INCOMPATIVEL');

    await closeDb(ctx.db);
  });

  it('T21 — conta inativa não recebe nova movimentação', async () => {
    const ctx = await setup();
    const { cfg, conta } = await contaAutorizada(ctx, ctx.empresaA.id, 16230);
    await ctx.motor.desativarConta({ empresaId: ctx.empresaA.id, id: conta.id });
    const api = mockApiClient();
    await assert.rejects(() => ctx.motor.testarLeituraProviderMercadoPago({
      empresaId: ctx.empresaA.id, id: cfg.id, apiClient: api, persistir: true
    }), (e) => e.code === 'MBC_CONTA_INATIVA' || /inativa/i.test(e.message));
    const qtd = await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM transacao_bancaria WHERE conta_bancaria_id = ?', [conta.id]);
    assert.equal(Number(qtd.n), 0);
    await closeDb(ctx.db);
  });

  it('T26 T33 T35 — lote 10+10 idempotente; provider sem INSERT; serviço oficial', async () => {
    const ctx = await setup();
    const { cfg, conta } = await contaAutorizada(ctx, ctx.empresaA.id, 16240);
    const api = mockApiClient({ csv: csvLote10() });

    const r1 = await ctx.motor.testarLeituraProviderMercadoPago({
      empresaId: ctx.empresaA.id, id: cfg.id, apiClient: api, persistir: true
    });
    assert.equal(r1.persistencia.criadas, 10);
    assert.equal(r1.persistencia.ja_existentes, 0);

    const r2 = await ctx.motor.testarLeituraProviderMercadoPago({
      empresaId: ctx.empresaA.id, id: cfg.id, apiClient: api, persistir: true
    });
    assert.equal(r2.persistencia.criadas, 0);
    assert.equal(r2.persistencia.ja_existentes, 10);

    const qtd = await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM transacao_bancaria WHERE conta_bancaria_id = ?', [conta.id]);
    assert.equal(Number(qtd.n), 10);

    assert.doesNotMatch(src('backend/motores/bancario/providers/mercadopago/MercadoPagoApiClient.js'), /INSERT INTO transacao_bancaria/i);
    assert.doesNotMatch(src('backend/motores/bancario/providers/mercadopago/MercadoPagoAccountMoneyMapper.js'), /INSERT INTO transacao_bancaria/i);
    assert.doesNotMatch(src('backend/motores/bancario/services/MercadoPagoPersistenciaService.js'), /INSERT INTO transacao_bancaria/i);
    assert.match(src('backend/motores/bancario/services/MercadoPagoPersistenciaService.js'), /TransacaoBancariaService\.registrar/);
    assert.match(src('backend/motores/bancario/services/TransacaoBancariaService.js'), /INSERT INTO transacao_bancaria/);

    await closeDb(ctx.db);
  });

  it('multiempresa real — isolamento A/B e body não transfere propriedade', async () => {
    const ctx = await setup();
    const a = await contaAutorizada(ctx, ctx.empresaA.id, 16250);
    const b = await contaAutorizada(ctx, ctx.empresaB.id, 16251);
    const csvA = csvLinhas([
      'SRC-A1;RA1;SETTLEMENT;2026-09-01T10:00:00Z;2026-09-01T12:00:00Z;11.00;BRL;11.00',
      'SRC-A2;RA2;SETTLEMENT;2026-09-02T10:00:00Z;2026-09-02T12:00:00Z;22.00;BRL;22.00'
    ]);
    const csvB = csvLinhas([
      'SRC-B1;RB1;SETTLEMENT;2026-09-01T10:00:00Z;2026-09-01T12:00:00Z;33.00;BRL;33.00',
      'SRC-B2;RB2;SETTLEMENT;2026-09-02T10:00:00Z;2026-09-02T12:00:00Z;44.00;BRL;44.00'
    ]);

    await ctx.motor.testarLeituraProviderMercadoPago({
      empresaId: ctx.empresaA.id, id: a.cfg.id, apiClient: mockApiClient({ csv: csvA }), persistir: true
    });
    await ctx.motor.testarLeituraProviderMercadoPago({
      empresaId: ctx.empresaB.id, id: b.cfg.id, apiClient: mockApiClient({ csv: csvB }), persistir: true
    });

    const nA = await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM transacao_bancaria WHERE empresa_id = ?', [ctx.empresaA.id]);
    const nB = await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM transacao_bancaria WHERE empresa_id = ?', [ctx.empresaB.id]);
    assert.equal(Number(nA.n), 2);
    assert.equal(Number(nB.n), 2);

    const listA = await ctx.motor.listarTransacoes({ empresaId: ctx.empresaA.id, conta_bancaria_id: a.conta.id });
    const listB = await ctx.motor.listarTransacoes({ empresaId: ctx.empresaB.id, conta_bancaria_id: b.conta.id });
    assert.equal(listA.length, 2);
    assert.equal(listB.length, 2);
    assert.ok(listA.every((t) => Number(t.empresa_id) === Number(ctx.empresaA.id)));
    assert.ok(listB.every((t) => Number(t.empresa_id) === Number(ctx.empresaB.id)));

    // tentativa cruzada: config A no contexto B
    await assert.rejects(() => ctx.motor.testarLeituraProviderMercadoPago({
      empresaId: ctx.empresaB.id, id: a.cfg.id, apiClient: mockApiClient({ csv: csvA }), persistir: true
    }));

    // body/empresa_id não transfere propriedade: DTO da conta A com contexto B
    const dtoA = mapearLinhaRelatorio({
      SOURCE_ID: 'SRC-CROSS',
      SETTLEMENT_NET_AMOUNT: '9',
      TRANSACTION_TYPE: 'SETTLEMENT',
      TRANSACTION_DATE: '2026-09-01',
      SETTLEMENT_CURRENCY: 'BRL'
    }, { empresaId: ctx.empresaA.id, contaBancariaId: a.conta.id });
    const cruzado = await MercadoPagoPersistenciaService.persistirLote({
      db: ctx.db,
      empresaId: ctx.empresaB.id,
      conta_bancaria_id: a.conta.id,
      movimentacoes: [dtoA]
    });
    assert.equal(cruzado.criadas, 0);
    assert.equal(cruzado.rejeitadas.length, 1);
    const crossRow = await dbGet(
      ctx.db,
      `SELECT COUNT(*) AS n FROM transacao_bancaria WHERE external_id = ?`,
      ['SRC-CROSS']
    );
    assert.equal(Number(crossRow.n), 0);

    await closeDb(ctx.db);
  });

  it('valor zero rejeitado pelo contrato MBC-03; moeda não-BRL rejeitada', async () => {
    const ctx = await setup();
    const { conta } = await contaAutorizada(ctx, ctx.empresaA.id, 16260);
    const dtoZero = {
      empresa_id: ctx.empresaA.id,
      conta_bancaria_id: conta.id,
      external_id: 'SRC-ZERO',
      external_source: EXTERNAL_SOURCE,
      data_transacao: '2026-09-01T10:00:00Z',
      valor: 0,
      direcao: 'entrada',
      descricao: 'zero',
      saldo_apos_transacao: null
    };
    const r = await MercadoPagoPersistenciaService.persistirLote({
      db: ctx.db,
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: conta.id,
      movimentacoes: [dtoZero]
    });
    assert.equal(r.criadas, 0);
    assert.equal(r.rejeitadas.length, 1);
    assert.match(r.rejeitadas[0].motivo, /positivo|valor/i);

    assert.throws(() => mapearLinhaRelatorio({
      SOURCE_ID: 'SRC-USD',
      SETTLEMENT_NET_AMOUNT: '10',
      SETTLEMENT_CURRENCY: 'USD',
      TRANSACTION_TYPE: 'SETTLEMENT',
      TRANSACTION_DATE: '2026-09-01'
    }, { empresaId: 1, contaBancariaId: 1 }));

    const mapeado = mapearCsvParaDtos(csvLinhas([
      'SRC-USD;R;SETTLEMENT;2026-09-01T10:00:00Z;2026-09-01T12:00:00Z;10.00;USD;10.00'
    ]), { empresaId: ctx.empresaA.id, contaBancariaId: conta.id });
    assert.equal(mapeado.transacoes.length, 0);
    assert.equal(mapeado.rejeitadas.length, 1);

    await closeDb(ctx.db);
  });

  it('leitura sem persistir permanece sem gravar; sprint e documentação', async () => {
    const ctx = await setup();
    const { cfg, conta } = await contaAutorizada(ctx, ctx.empresaA.id, 16270);
    const out = await ctx.motor.testarLeituraProviderMercadoPago({
      empresaId: ctx.empresaA.id, id: cfg.id, apiClient: mockApiClient(), persistir: false
    });
    assert.equal(out.persistiu, false);
    assert.equal(out.persistencia, null);
    const qtd = await dbGet(ctx.db, 'SELECT COUNT(*) AS n FROM transacao_bancaria WHERE conta_bancaria_id = ?', [conta.id]);
    assert.equal(Number(qtd.n), 0);

    assert.ok(String(VERSAO.SPRINT).startsWith('MBC-'));
    assert.equal(VERSAO.CODIGO, 'MBC-01');
    assert.equal(EXTERNAL_SOURCE, 'MERCADO_PAGO_SETTLEMENT_REPORT');
    assert.ok(fs.existsSync(path.join(ROOT, 'docs/bancario/MBC-16.2-RELATORIO.md')));
    assert.match(src('backend/rotas/bancario.js'), /persistir:\s*body\.persistir\s*===\s*true/);
    assert.equal(STATUS_REGISTRO.CRIADA, 'CRIADA');
    assert.equal(STATUS_REGISTRO.JA_EXISTENTE, 'JA_EXISTENTE');

    await closeDb(ctx.db);
  });
});
