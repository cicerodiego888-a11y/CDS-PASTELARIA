/**
 * Sprint 04.07 — documentos fiscais por empresa + comprovante unificado.
 */
'use strict';

const assert = require('assert');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const {
  STATUS_ATENDIMENTO,
  STATUS_FISCAL_OPERACAO
} = require('../../backend/motores/muv');
const atendimentoService = require('../../backend/motores/muv/AtendimentoMultiempresaService');
const fiscalServiceMod = require('../../backend/motores/muv/FiscalizarAtendimentoService');
const fiscalService = {
  fiscalizarAtendimento(id, deps = {}) {
    return fiscalServiceMod.fiscalizarAtendimento(id, {
      ...deps,
      getFiscalConfig: deps.getFiscalConfig || ((opts) => ({
        fonte: 'EMPRESA',
        empresaId: opts.empresaId
      }))
    });
  },
  obterComprovanteUnificado: fiscalServiceMod.obterComprovanteUnificado
};
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';
const CNPJ_C = '65957340000150';

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
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
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

async function assertRejects(promise, code) {
  try {
    await promise;
    throw new Error(`Esperava ${code}`);
  } catch (err) {
    if (err.message === `Esperava ${code}`) throw err;
    assert.strictEqual(err.code || err.codigo, code, err.message);
  }
}

function item(produtoId, empresaId, quantidade, valorUnitario, tipoFiscal) {
  const base = { produtoId, empresaId, quantidade, valorUnitario };
  if (tipoFiscal) base.tipoFiscal = tipoFiscal;
  return base;
}

async function saldoEmp(db, produtoId, empresaId) {
  return EstoqueEmpresaService.consultarSaldoParaEmpresa({ produtoId, empresaId, db });
}

async function setupBase() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  await run(db, `
    CREATE TABLE produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT,
      saldo_fiscal REAL DEFAULT 0,
      saldo_nao_fiscal REAL DEFAULT 0,
      reservado_fiscal REAL DEFAULT 0,
      reservado_nao_fiscal REAL DEFAULT 0,
      controla_estoque INTEGER DEFAULT 1,
      estoque_atual REAL DEFAULT 0,
      updated_at DATETIME
    )
  `);
  await run(db, `
    CREATE TABLE vendas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT, data_venda TEXT, total REAL, desconto REAL DEFAULT 0,
      forma_pagamento TEXT, status TEXT, status_pagamento TEXT, origem TEXT
    )
  `);
  await run(db, `
    CREATE TABLE vendas_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venda_id INTEGER, produto_id INTEGER, quantidade REAL,
      preco_unitario REAL, subtotal REAL
    )
  `);
  await run(db, `
    CREATE TABLE venda_pagamentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venda_id INTEGER, forma_pagamento TEXT, valor REAL
    )
  `);
  await run(db, `
    CREATE TABLE financeiro (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venda_id INTEGER, tipo TEXT, origem TEXT, valor REAL, status TEXT
    )
  `);
  const p = await run(
    db,
    `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual)
     VALUES ('X', 999, 999, 1998)`
  );
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const b = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  const c = await EmpresaService.criarEmpresa({ cnpj: CNPJ_C, razao_social: 'C' }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: p.lastID, empresaId: a.id, saldo_fiscal: 20, saldo_nao_fiscal: 5, estoque_atual: 25
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: p.lastID, empresaId: b.id, saldo_fiscal: 6, saldo_nao_fiscal: 4, estoque_atual: 10
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: p.lastID, empresaId: c.id, saldo_fiscal: 15, saldo_nao_fiscal: 8, estoque_atual: 23
  }, { db });
  return { db, produtoId: p.lastID, empresaA: a, empresaB: b, empresaC: c };
}

function mockRes() {
  const state = { statusCode: null, body: null };
  return {
    state,
    status(code) { state.statusCode = code; return this; },
    json(payload) { state.body = payload; return payload; }
  };
}

function loadAppWithFakePagamento() {
  const pagamentoPath = require.resolve('../../backend/services/vendas/VendaPagamentoService');
  const appPath = path.resolve(__dirname, '../../backend/services/vendas/VendaApplicationService.js');
  const originalPag = require.cache[pagamentoPath];
  const originalApp = require.cache[appPath];
  let pagamentoChamado = 0;
  require.cache[pagamentoPath] = {
    id: pagamentoPath, filename: pagamentoPath, loaded: true,
    exports: { criarVenda() { pagamentoChamado += 1; return 'DELEGATED_PDV'; } }
  };
  delete require.cache[appPath];
  const app = require('../../backend/services/vendas/VendaApplicationService');
  return {
    app,
    getPagamentoChamado: () => pagamentoChamado,
    restore() {
      if (originalPag) require.cache[pagamentoPath] = originalPag;
      else delete require.cache[pagamentoPath];
      if (originalApp) require.cache[appPath] = originalApp;
      else delete require.cache[appPath];
    }
  };
}

function emitOk(vendaId, empresaTag) {
  return {
    success: true,
    status: 'autorizada',
    notaId: 1000 + Number(vendaId),
    numero: 100 + Number(vendaId),
    chaveAcesso: `CHAVE-${empresaTag}-${vendaId}`,
    qrCodeUrl: `https://qr.local/${empresaTag}/${vendaId}`
  };
}

function emitFail(vendaId) {
  return {
    success: false,
    status: 'rejeitada',
    notaId: null,
    message: `rejeicao ${vendaId}`
  };
}

async function materializadoABC(ctx) {
  const atd = await atendimentoService.criarAtendimento({
    itens: [
      item(ctx.produtoId, ctx.empresaA.id, 1, 12, 'FISCAL'),
      item(ctx.produtoId, ctx.empresaB.id, 1, 18, 'FISCAL'),
      item(ctx.produtoId, ctx.empresaC.id, 1, 21, 'FISCAL')
    ]
  }, { db: ctx.db });
  await atendimentoService.reservarAtendimento(atd.atendimentoId, { db: ctx.db });
  await atendimentoService.confirmarPagamentoAtendimento(atd.atendimentoId, {
    pagamentos: [{ formaPagamento: 'pix', valor: 51 }]
  }, { db: ctx.db });
  return atendimentoService.materializarAtendimento(atd.atendimentoId, {}, { db: ctx.db });
}

function emitPorEmpresa(ctx, mat, overrides = {}) {
  const calls = [];
  const porEmpresa = new Map();
  for (const op of mat.operacoes) {
    porEmpresa.set(op.vendaId, overrides[op.empresaId] || (() => emitOk(op.vendaId, op.empresaId)));
  }
  return {
    calls,
    emitirPorVendaId(vendaId) {
      calls.push({ vendaId, empresaId: mat.operacoes.find((o) => o.vendaId === vendaId).empresaId });
      const fn = porEmpresa.get(vendaId);
      return typeof fn === 'function' ? fn(vendaId) : fn;
    }
  };
}

async function test01UmaEmpresa() {
  const ctx = await setupBase();
  const atd = await atendimentoService.criarAtendimento({
    itens: [item(ctx.produtoId, ctx.empresaA.id, 1, 12, 'FISCAL')]
  }, { db: ctx.db });
  await atendimentoService.reservarAtendimento(atd.atendimentoId, { db: ctx.db });
  await atendimentoService.confirmarPagamentoAtendimento(atd.atendimentoId, {
    pagamentos: [{ formaPagamento: 'pix', valor: 12 }]
  }, { db: ctx.db });
  const mat = await atendimentoService.materializarAtendimento(atd.atendimentoId, {}, { db: ctx.db });
  const emit = emitPorEmpresa(ctx, mat);
  const r = await fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
    db: ctx.db, emitirPorVendaId: emit.emitirPorVendaId
  });
  assert.strictEqual(r.status, STATUS_ATENDIMENTO.FISCALIZADO);
  assert.strictEqual(r.documentos.length, 1);
  assert.strictEqual(r.documentos[0].empresaId, ctx.empresaA.id);
  await closeDb(ctx.db);
}

async function test02ABC() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  const emit = emitPorEmpresa(ctx, mat);
  const r = await fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
    db: ctx.db, emitirPorVendaId: emit.emitirPorVendaId
  });
  assert.strictEqual(r.documentos.length, 3);
  assert.strictEqual(emit.calls.length, 3);
  await closeDb(ctx.db);
}

async function test03ChamaFluxoCorreto() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  const emit = emitPorEmpresa(ctx, mat);
  await fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
    db: ctx.db, emitirPorVendaId: emit.emitirPorVendaId
  });
  const ids = emit.calls.map((c) => c.vendaId).sort();
  const esperados = mat.operacoes.map((o) => o.vendaId).sort();
  assert.deepStrictEqual(ids, esperados);
  await closeDb(ctx.db);
}

async function test04EmpresaCorreta() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  const emit = emitPorEmpresa(ctx, mat);
  await fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
    db: ctx.db, emitirPorVendaId: emit.emitirPorVendaId
  });
  for (const call of emit.calls) {
    const op = mat.operacoes.find((o) => o.vendaId === call.vendaId);
    assert.strictEqual(call.empresaId, op.empresaId);
  }
  await closeDb(ctx.db);
}

async function test05DocumentoANaoEmB() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  const emit = emitPorEmpresa(ctx, mat);
  const r = await fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
    db: ctx.db, emitirPorVendaId: emit.emitirPorVendaId
  });
  const docA = r.documentos.find((d) => d.empresaId === ctx.empresaA.id);
  const docB = r.documentos.find((d) => d.empresaId === ctx.empresaB.id);
  assert.notStrictEqual(docA.chaveAcesso, docB.chaveAcesso);
  assert.notStrictEqual(docA.vendaId, docB.vendaId);
  await closeDb(ctx.db);
}

async function test06XmlIndependentes() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  const emit = emitPorEmpresa(ctx, mat);
  const r = await fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
    db: ctx.db, emitirPorVendaId: emit.emitirPorVendaId
  });
  const chaves = r.documentos.map((d) => d.chaveAcesso);
  assert.strictEqual(new Set(chaves).size, 3);
  await closeDb(ctx.db);
}

async function test07AutorizadaPersistida() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  const emit = emitPorEmpresa(ctx, mat);
  await fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
    db: ctx.db, emitirPorVendaId: emit.emitirPorVendaId
  });
  const rows = await all(ctx.db, 'SELECT * FROM atendimento_operacao_documentos');
  assert.ok(rows.every((r) => r.status === STATUS_FISCAL_OPERACAO.AUTORIZADA));
  await closeDb(ctx.db);
}

async function test08SucessoTotal() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  const emit = emitPorEmpresa(ctx, mat);
  const r = await fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
    db: ctx.db, emitirPorVendaId: emit.emitirPorVendaId
  });
  assert.strictEqual(r.status, 'FISCALIZADO');
  await closeDb(ctx.db);
}

async function test09SucessoParcial() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  const emit = emitPorEmpresa(ctx, mat, {
    [ctx.empresaC.id]: (vendaId) => emitFail(vendaId)
  });
  const r = await fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
    db: ctx.db, emitirPorVendaId: emit.emitirPorVendaId
  });
  assert.strictEqual(r.status, STATUS_ATENDIMENTO.FISCAL_PARCIAL);
  const a = r.documentos.find((d) => d.empresaId === ctx.empresaA.id);
  const c = r.documentos.find((d) => d.empresaId === ctx.empresaC.id);
  assert.strictEqual(a.status, 'AUTORIZADA');
  assert.strictEqual(c.status, 'REJEITADA');
  await closeDb(ctx.db);
}

async function test10FalhaTotal() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  const emit = emitPorEmpresa(ctx, mat, {
    [ctx.empresaA.id]: emitFail,
    [ctx.empresaB.id]: emitFail,
    [ctx.empresaC.id]: emitFail
  });
  const r = await fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
    db: ctx.db, emitirPorVendaId: emit.emitirPorVendaId
  });
  assert.strictEqual(r.status, STATUS_ATENDIMENTO.FISCAL_ERRO);
  await closeDb(ctx.db);
}

async function test11RetryNaoDuplica() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  const emit = emitPorEmpresa(ctx, mat);
  await fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
    db: ctx.db, emitirPorVendaId: emit.emitirPorVendaId
  });
  const n1 = (await all(ctx.db, 'SELECT * FROM atendimento_operacao_documentos')).length;
  const r2 = await fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
    db: ctx.db, emitirPorVendaId: emit.emitirPorVendaId
  });
  const n2 = (await all(ctx.db, 'SELECT * FROM atendimento_operacao_documentos')).length;
  assert.strictEqual(n1, n2);
  assert.ok(r2.documentos.every((d) => d.reused === true));
  await closeDb(ctx.db);
}

async function test12RetryPendente() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  let falhouC = true;
  const emit = emitPorEmpresa(ctx, mat, {
    [ctx.empresaC.id]: (vendaId) => (falhouC ? emitFail(vendaId) : emitOk(vendaId, 'C'))
  });
  await fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
    db: ctx.db, emitirPorVendaId: emit.emitirPorVendaId
  });
  falhouC = false;
  const r2 = await fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
    db: ctx.db, emitirPorVendaId: emit.emitirPorVendaId
  });
  const c = r2.documentos.find((d) => d.empresaId === ctx.empresaC.id);
  assert.strictEqual(c.status, 'AUTORIZADA');
  const a = r2.documentos.find((d) => d.empresaId === ctx.empresaA.id);
  assert.strictEqual(a.reused, true);
  await closeDb(ctx.db);
}

async function test13NaoCriaVenda() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  const nAntes = (await get(ctx.db, 'SELECT COUNT(*) AS q FROM vendas')).q;
  const emit = emitPorEmpresa(ctx, mat);
  await fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
    db: ctx.db, emitirPorVendaId: emit.emitirPorVendaId
  });
  assert.strictEqual((await get(ctx.db, 'SELECT COUNT(*) AS q FROM vendas')).q, nAntes);
  await closeDb(ctx.db);
}

async function test14NaoCobra() {
  const src = require('fs').readFileSync(
    path.join(__dirname, '../../backend/motores/muv/FiscalizarAtendimentoService.js'),
    'utf8'
  );
  assert.ok(!src.includes('confirmarPagamentoAtendimento'));
  assert.ok(!src.includes('OrquestradorPagamento'));
}

async function test15NaoBaixaEstoque() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  const antes = await saldoEmp(ctx.db, ctx.produtoId, ctx.empresaA.id);
  const emit = emitPorEmpresa(ctx, mat);
  await fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
    db: ctx.db, emitirPorVendaId: emit.emitirPorVendaId
  });
  const depois = await saldoEmp(ctx.db, ctx.produtoId, ctx.empresaA.id);
  assert.strictEqual(depois.saldoFiscal, antes.saldoFiscal);
  await closeDb(ctx.db);
}

async function test16NaoConsomeReserva() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  const emit = emitPorEmpresa(ctx, mat);
  await fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
    db: ctx.db, emitirPorVendaId: emit.emitirPorVendaId
  });
  const reservas = await all(ctx.db, 'SELECT status FROM atendimento_operacao_reservas');
  assert.ok(reservas.every((r) => r.status === 'CONSUMIDA'));
  await closeDb(ctx.db);
}

async function test17ListaContinua() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  const emit = emitPorEmpresa(ctx, mat);
  const r = await fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
    db: ctx.db, emitirPorVendaId: emit.emitirPorVendaId
  });
  assert.strictEqual(r.comprovante.itens.length, 3);
  assert.strictEqual(r.comprovante.itensAgrupadosPorEmpresa, false);
  await closeDb(ctx.db);
}

async function test18NaoAgrupaPorEmpresa() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  const emit = emitPorEmpresa(ctx, mat);
  const r = await fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
    db: ctx.db, emitirPorVendaId: emit.emitirPorVendaId
  });
  assert.ok(!Object.prototype.hasOwnProperty.call(r.comprovante.itens[0], 'empresaId'));
  await closeDb(ctx.db);
}

async function test19TotalOficial() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  const emit = emitPorEmpresa(ctx, mat);
  const r = await fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
    db: ctx.db, emitirPorVendaId: emit.emitirPorVendaId
  });
  assert.strictEqual(r.comprovante.total, 51);
  assert.strictEqual(r.comprovante.invariantes.somaOperacoes, 51);
  await closeDb(ctx.db);
}

async function test20PagamentoUnificado() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  const emit = emitPorEmpresa(ctx, mat);
  const r = await fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
    db: ctx.db, emitirPorVendaId: emit.emitirPorVendaId
  });
  assert.strictEqual(r.comprovante.pagamento.unificado, true);
  assert.strictEqual(r.comprovante.pagamento.formas[0].formaPagamento, 'pix');
  assert.strictEqual(r.comprovante.pagamento.total, 51);
  await closeDb(ctx.db);
}

async function test21DocsPorEmpresa() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  const emit = emitPorEmpresa(ctx, mat);
  const r = await fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
    db: ctx.db, emitirPorVendaId: emit.emitirPorVendaId
  });
  const empresas = r.comprovante.documentosFiscais.map((d) => d.empresaId);
  assert.ok(empresas.includes(ctx.empresaA.id));
  assert.ok(empresas.includes(ctx.empresaB.id));
  assert.ok(empresas.includes(ctx.empresaC.id));
  await closeDb(ctx.db);
}

async function test22EmpresaUnica() {
  const { app, getPagamentoChamado, restore } = loadAppWithFakePagamento();
  try {
    const result = app.criarVenda({ body: { total: 10, itens: [] } }, mockRes(), {
      obterModoOperacaoVenda: () => 'EMPRESA_UNICA'
    });
    assert.strictEqual(result, 'DELEGATED_PDV');
    assert.strictEqual(getPagamentoChamado(), 1);
  } finally {
    restore();
  }
}

async function test23Idempotencia() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  const emit = emitPorEmpresa(ctx, mat);
  const r1 = await fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
    db: ctx.db, emitirPorVendaId: emit.emitirPorVendaId
  });
  const r2 = await fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
    db: ctx.db, emitirPorVendaId: emit.emitirPorVendaId
  });
  assert.strictEqual(r1.documentos[0].chaveAcesso, r2.documentos[0].chaveAcesso);
  await closeDb(ctx.db);
}

async function test24VinculoCorrompido() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  await run(ctx.db, 'UPDATE atendimento_operacoes SET venda_id = id + 90000');
  await assertRejects(
    fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
      db: ctx.db,
      emitirPorVendaId() { return emitOk(1, 'X'); }
    }),
    'VINCULO_FISCAL_INVALIDO'
  );
  await closeDb(ctx.db);
}

async function test25EmpresaPersistida() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  const emit = emitPorEmpresa(ctx, mat);
  await assertRejects(
    fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
      db: ctx.db,
      emitirPorVendaId: emit.emitirPorVendaId,
      empresaId: 999
    }),
    'VINCULO_FISCAL_INVALIDO'
  );
  await closeDb(ctx.db);
}

async function test26BodyNaoSubstitui() {
  const src = require('fs').readFileSync(
    path.join(__dirname, '../../backend/motores/muv/FiscalizarAtendimentoService.js'),
    'utf8'
  );
  assert.ok(src.includes('operacao.empresaId'));
  assert.ok(!src.includes('body.empresa'));
}

async function test27NaoAplicavel() {
  const ctx = await setupBase();
  const atd = await atendimentoService.criarAtendimento({
    itens: [item(ctx.produtoId, ctx.empresaA.id, 1, 12, 'NAO_FISCAL')]
  }, { db: ctx.db });
  await atendimentoService.reservarAtendimento(atd.atendimentoId, { db: ctx.db });
  await atendimentoService.confirmarPagamentoAtendimento(atd.atendimentoId, {
    pagamentos: [{ formaPagamento: 'dinheiro', valor: 12 }]
  }, { db: ctx.db });
  const mat = await atendimentoService.materializarAtendimento(atd.atendimentoId, {}, { db: ctx.db });
  let chamado = 0;
  const r = await fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
    db: ctx.db,
    emitirPorVendaId() { chamado += 1; return emitOk(1, 'A'); }
  });
  assert.strictEqual(chamado, 0);
  assert.strictEqual(r.documentos[0].status, STATUS_FISCAL_OPERACAO.NAO_APLICAVEL);
  await closeDb(ctx.db);
}

async function test28ErroLocalNaoCorrompe() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  const emit = emitPorEmpresa(ctx, mat);
  await assertRejects(
    fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
      db: ctx.db,
      emitirPorVendaId: emit.emitirPorVendaId,
      aposFiscalizarOperacao() {
        const err = new Error('falha local');
        err.code = 'ATENDIMENTO_INVALIDO';
        throw err;
      }
    }),
    'ATENDIMENTO_INVALIDO'
  );
  const docs = await all(ctx.db, 'SELECT * FROM atendimento_operacao_documentos');
  assert.ok(docs.length >= 1);
  const cab = await get(ctx.db, 'SELECT status FROM atendimentos WHERE id = ?', [mat.atendimentoId]);
  assert.notStrictEqual(cab.status, 'FISCALIZADO');
  await closeDb(ctx.db);
}

async function test29ConsistenciaParcial() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  const emit = emitPorEmpresa(ctx, mat, {
    [ctx.empresaC.id]: (vendaId) => emitFail(vendaId)
  });
  await fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
    db: ctx.db, emitirPorVendaId: emit.emitirPorVendaId
  });
  const a = await get(ctx.db, `SELECT status FROM atendimento_operacao_documentos WHERE empresa_id = ?`, [ctx.empresaA.id]);
  assert.strictEqual(a.status, 'AUTORIZADA');
  await closeDb(ctx.db);
}

async function test30ContratoComprovante() {
  const ctx = await setupBase();
  const mat = await materializadoABC(ctx);
  const emit = emitPorEmpresa(ctx, mat);
  const r = await fiscalService.fiscalizarAtendimento(mat.atendimentoId, {
    db: ctx.db, emitirPorVendaId: emit.emitirPorVendaId
  });
  assert.strictEqual(r.comprovante.tipo, 'COMPROVANTE_UNIFICADO_ATENDIMENTO');
  assert.ok(r.comprovante.cabecalho.codigo);
  assert.ok(Array.isArray(r.comprovante.itens));
  assert.ok(Array.isArray(r.comprovante.documentosFiscais));
  assert.strictEqual(r.comprovante.pagamento.unificado, true);
  await closeDb(ctx.db);
}

async function main() {
  const testes = [
    ['01 uma empresa fiscal', test01UmaEmpresa],
    ['02 A+B+C', test02ABC],
    ['03 chama fluxo fiscal correto', test03ChamaFluxoCorreto],
    ['04 empresa correta chega ao fiscal', test04EmpresaCorreta],
    ['05 documento A não aparece em B', test05DocumentoANaoEmB],
    ['06 XML/chaves independentes', test06XmlIndependentes],
    ['07 autorizada persistida', test07AutorizadaPersistida],
    ['08 sucesso total', test08SucessoTotal],
    ['09 sucesso parcial', test09SucessoParcial],
    ['10 falha total', test10FalhaTotal],
    ['11 retry não duplica autorizado', test11RetryNaoDuplica],
    ['12 retry processa pendente', test12RetryPendente],
    ['13 não gera nova venda', test13NaoCriaVenda],
    ['14 não cobra pagamento', test14NaoCobra],
    ['15 estoque não baixa novamente', test15NaoBaixaEstoque],
    ['16 reserva não é reconsumida', test16NaoConsomeReserva],
    ['17 comprovante lista contínua', test17ListaContinua],
    ['18 comprovante não agrupa por empresa', test18NaoAgrupaPorEmpresa],
    ['19 total = atendimento', test19TotalOficial],
    ['20 pagamento unificado', test20PagamentoUnificado],
    ['21 documentos por empresa', test21DocsPorEmpresa],
    ['22 EMPRESA_UNICA inalterado', test22EmpresaUnica],
    ['23 idempotência', test23Idempotencia],
    ['24 vínculo corrompido bloqueia', test24VinculoCorrompido],
    ['25 empresa persistida é autoridade', test25EmpresaPersistida],
    ['26 body/query não substituem', test26BodyNaoSubstitui],
    ['27 operação sem documento aplicável', test27NaoAplicavel],
    ['28 erro local não apaga vínculos', test28ErroLocalNaoCorrompe],
    ['29 consistência após parcial', test29ConsistenciaParcial],
    ['30 contrato público do comprovante', test30ContratoComprovante]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  ok ${nome}`);
  }
  console.log(`\nfiscal-atendimento-multiempresa-04-07: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
