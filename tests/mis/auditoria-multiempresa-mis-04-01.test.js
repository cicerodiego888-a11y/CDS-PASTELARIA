/**
 * Sprint 04.01 — Fundação multiempresa do MIS.
 * Executar: node tests/mis/auditoria-multiempresa-mis-04-01.test.js
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
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const UsuarioEmpresaService = require('../../backend/services/empresas/UsuarioEmpresaService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const { ModoOperacionalGlobal } = require('../../backend/core/modo-operacional');
const { resolverEmpresaIdParaMis } = require('../../backend/services/mis/MisEmpresaContextoService');
const {
  faturamentoPorEmpresa,
  rankingProdutosPorEmpresa,
  estoqueProdutoPorEmpresa,
  comprasPorEmpresa,
  financeiroReceberPorEmpresa,
  fiscalNfcePorEmpresa
} = require('../../backend/services/mis/MisIndicadoresService');
const { sqlRankingProdutosDaEmpresa } = require('../../backend/services/reportFiscalHelpers');

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

function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_) { resolve(); }
  });
}

async function setup() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  await garantirSchemaUsuarioEmpresasAsync(db);
  await run(db, `CREATE TABLE produtos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT, estoque_atual REAL DEFAULT 0,
    saldo_fiscal REAL DEFAULT 0, saldo_nao_fiscal REAL DEFAULT 0
  )`);
  await run(db, `CREATE TABLE vendas (
    id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER, data_venda TEXT,
    total REAL DEFAULT 0, status TEXT DEFAULT 'concluida',
    valor_fiscal REAL DEFAULT 0, valor_nao_fiscal REAL DEFAULT 0
  )`);
  await run(db, `CREATE TABLE vendas_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT, venda_id INTEGER, produto_id INTEGER,
    quantidade REAL, quantidade_fiscal REAL, quantidade_nao_fiscal REAL, subtotal REAL
  )`);
  await run(db, `CREATE TABLE compras (
    id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER, data_compra TEXT,
    total REAL DEFAULT 0, created_at TEXT
  )`);
  await run(db, `CREATE TABLE contas_receber (
    id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER, valor_restante REAL,
    status TEXT
  )`);
  await run(db, `CREATE TABLE nfce_notas (
    id INTEGER PRIMARY KEY AUTOINCREMENT, venda_id INTEGER, created_at TEXT
  )`);

  const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  const prod = await run(db, `INSERT INTO produtos (nome, estoque_atual) VALUES ('Pastel', 999)`);
  const produtoId = prod.lastID;
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaA.id, saldo_fiscal: 10, saldo_nao_fiscal: 0, estoque_atual: 10
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaB.id, saldo_fiscal: 50, saldo_nao_fiscal: 0, estoque_atual: 50
  }, { db });

  const va = await run(db, `INSERT INTO vendas (empresa_id, data_venda, total, status, valor_fiscal, valor_nao_fiscal)
    VALUES (?, '2026-08-15', 1000, 'concluida', 1000, 0)`, [empresaA.id]);
  const vb = await run(db, `INSERT INTO vendas (empresa_id, data_venda, total, status, valor_fiscal, valor_nao_fiscal)
    VALUES (?, '2026-08-15', 2000, 'concluida', 2000, 0)`, [empresaB.id]);
  await run(db, `INSERT INTO vendas_itens (venda_id, produto_id, quantidade, quantidade_fiscal, quantidade_nao_fiscal, subtotal)
    VALUES (?, ?, 100, 100, 0, 1000)`, [va.lastID, produtoId]);
  await run(db, `INSERT INTO vendas_itens (venda_id, produto_id, quantidade, quantidade_fiscal, quantidade_nao_fiscal, subtotal)
    VALUES (?, ?, 500, 500, 0, 2000)`, [vb.lastID, produtoId]);
  await run(db, `INSERT INTO vendas (empresa_id, data_venda, total, status)
    VALUES (?, '2026-01-01', 99999, 'concluida')`, [empresaA.id]);

  await run(db, `INSERT INTO compras (empresa_id, data_compra, total) VALUES (?, '2026-08-10', 80)`, [empresaA.id]);
  await run(db, `INSERT INTO compras (empresa_id, data_compra, total) VALUES (?, '2026-08-10', 300)`, [empresaB.id]);
  await run(db, `INSERT INTO contas_receber (empresa_id, valor_restante, status) VALUES (?, 40, 'aberto')`, [empresaA.id]);
  await run(db, `INSERT INTO contas_receber (empresa_id, valor_restante, status) VALUES (?, 90, 'aberto')`, [empresaB.id]);
  await run(db, `INSERT INTO nfce_notas (venda_id, created_at) VALUES (?, '2026-08-15')`, [va.lastID]);
  await run(db, `INSERT INTO nfce_notas (venda_id, created_at) VALUES (?, '2026-08-15')`, [vb.lastID]);

  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaA.id, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaB.id, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(2, empresaA.id, { db });

  const depsMulti = {
    db,
    obterModoOperacionalGlobal: () => ModoOperacionalGlobal.MULTIEMPRESA
  };
  const depsSimples = {
    db,
    obterModoOperacionalGlobal: () => ModoOperacionalGlobal.EMPRESA_SIMPLES,
    empresa_operacional_id: empresaA.id
  };
  const periodo = { inicio: '2026-08-01', fim: '2026-08-31', db, produtoId };

  return { db, empresaA, empresaB, produtoId, depsMulti, depsSimples, periodo };
}

describe('04.01 invariantes de código', () => {
  it('T00 — dashboard e ranking MIS filtram vendas.empresa_id; helper legado permanece global', () => {
    const dash = src('backend/rotas/dashboard.js');
    const helpers = src('backend/services/reportFiscalHelpers.js');
    const rankingRota = src('backend/rotas/vendas.js');
    assert.match(dash, /resolverEmpresaIdParaMis/);
    assert.match(dash, /sqlRankingProdutosDaEmpresa/);
    assert.match(dash, /v\.empresa_id = \?/);
    assert.match(dash, /estoque_empresa/);
    assert.match(rankingRota, /relatorio\/produtos-mais-vendidos/);
    const trechoRanking = rankingRota.slice(rankingRota.indexOf('relatorio/produtos-mais-vendidos'));
    assert.match(trechoRanking.slice(0, 1800), /v\.empresa_id = \?/);
    assert.match(helpers, /function sqlRankingProdutosDaEmpresa/);
    assert.doesNotMatch(
      helpers.slice(helpers.indexOf('function sqlRankingProdutos('), helpers.indexOf('function sqlRankingProdutos(') + 220),
      /v\.empresa_id/
    );
    assert.match(sqlRankingProdutosDaEmpresa('0'), /v\.empresa_id = \?/);
    assert.doesNotMatch(src('backend/services/mis/MisIndicadoresService.js'), /empresaId\s*\|\|\s*1/);
    assert.doesNotMatch(src('backend/services/mis/MisEmpresaContextoService.js'), /pdv-universal/i);
  });
});

describe('04.01 isolamento MIS', () => {
  it('T01 — indicador da Empresa A retorna somente A', async () => {
    const { db, empresaA, periodo } = await setup();
    const a = await faturamentoPorEmpresa({ ...periodo, empresaId: empresaA.id });
    assert.equal(a.empresa_id, empresaA.id);
    assert.equal(a.faturamento, 1000);
    await closeDb(db);
  });

  it('T02 — indicador da Empresa B retorna somente B', async () => {
    const { db, empresaB, periodo } = await setup();
    const b = await faturamentoPorEmpresa({ ...periodo, empresaId: empresaB.id });
    assert.equal(b.empresa_id, empresaB.id);
    assert.equal(b.faturamento, 2000);
    await closeDb(db);
  });

  it('T03 — A e B com o mesmo produto não se misturam', async () => {
    const { db, empresaA, empresaB, periodo } = await setup();
    const a = await faturamentoPorEmpresa({ ...periodo, empresaId: empresaA.id });
    const b = await faturamentoPorEmpresa({ ...periodo, empresaId: empresaB.id });
    assert.equal(a.faturamento, 1000);
    assert.equal(b.faturamento, 2000);
    assert.notEqual(a.faturamento, 3000);
    assert.notEqual(b.faturamento, 3000);
    await closeDb(db);
  });

  it('T04 — usuário autorizado A/B pode alternar contexto', async () => {
    const { db, empresaA, empresaB, depsMulti } = await setup();
    const ctxA = await resolverEmpresaIdParaMis(
      { empresaId: empresaA.id, user: { id: 1 } },
      depsMulti
    );
    const ctxB = await resolverEmpresaIdParaMis(
      { empresaId: empresaB.id, user: { id: 1 } },
      depsMulti
    );
    assert.equal(ctxA.empresaId, empresaA.id);
    assert.equal(ctxB.empresaId, empresaB.id);
    await closeDb(db);
  });

  it('T05 — usuário somente A não acessa B', async () => {
    const { db, empresaB, depsMulti } = await setup();
    await assert.rejects(
      () => resolverEmpresaIdParaMis({ empresaId: empresaB.id, user: { id: 2 } }, depsMulti),
      (e) => e.code === 'EMPRESA_NAO_AUTORIZADA'
    );
    await closeDb(db);
  });

  it('T06 — faturamento respeita empresa', async () => {
    const { db, empresaA, empresaB, periodo } = await setup();
    const a = await faturamentoPorEmpresa({ ...periodo, empresaId: empresaA.id });
    const b = await faturamentoPorEmpresa({ ...periodo, empresaId: empresaB.id });
    assert.equal(a.faturamento, 1000);
    assert.equal(b.faturamento, 2000);
    await closeDb(db);
  });

  it('T07 — quantidade de vendas respeita empresa', async () => {
    const { db, empresaA, empresaB, periodo } = await setup();
    const a = await faturamentoPorEmpresa({ ...periodo, empresaId: empresaA.id });
    const b = await faturamentoPorEmpresa({ ...periodo, empresaId: empresaB.id });
    assert.equal(a.total_vendas, 1);
    assert.equal(b.total_vendas, 1);
    await closeDb(db);
  });

  it('T08 — ranking de produtos respeita empresa', async () => {
    const { db, empresaA, empresaB, periodo } = await setup();
    const ra = await rankingProdutosPorEmpresa({ ...periodo, empresaId: empresaA.id, limite: 5 });
    const rb = await rankingProdutosPorEmpresa({ ...periodo, empresaId: empresaB.id, limite: 5 });
    assert.equal(ra.produtos[0].quantidade_vendida, 100);
    assert.equal(rb.produtos[0].quantidade_vendida, 500);
    await closeDb(db);
  });

  it('T09 — estoque respeita empresa (estoque_empresa, não produtos.estoque_atual)', async () => {
    const { db, empresaA, empresaB, produtoId } = await setup();
    const ea = await estoqueProdutoPorEmpresa({ db, empresaId: empresaA.id, produtoId });
    const eb = await estoqueProdutoPorEmpresa({ db, empresaId: empresaB.id, produtoId });
    assert.equal(ea.estoque_atual, 10);
    assert.equal(eb.estoque_atual, 50);
    assert.equal(ea.origem, 'estoque_empresa');
    await closeDb(db);
  });

  it('T10 — compras respeitam empresa', async () => {
    const { db, empresaA, empresaB, periodo } = await setup();
    const ca = await comprasPorEmpresa({ ...periodo, empresaId: empresaA.id });
    const cb = await comprasPorEmpresa({ ...periodo, empresaId: empresaB.id });
    assert.equal(ca.total, 80);
    assert.equal(cb.total, 300);
    await closeDb(db);
  });

  it('T11 — financeiro respeita empresa', async () => {
    const { db, empresaA, empresaB } = await setup();
    const fina = await financeiroReceberPorEmpresa({ db, empresaId: empresaA.id });
    const finb = await financeiroReceberPorEmpresa({ db, empresaId: empresaB.id });
    assert.equal(fina.total, 40);
    assert.equal(finb.total, 90);
    await closeDb(db);
  });

  it('T12 — fiscal respeita empresa', async () => {
    const { db, empresaA, empresaB, periodo } = await setup();
    const fisa = await fiscalNfcePorEmpresa({ ...periodo, empresaId: empresaA.id });
    const fisb = await fiscalNfcePorEmpresa({ ...periodo, empresaId: empresaB.id });
    assert.equal(fisa.quantidade, 1);
    assert.equal(fisb.quantidade, 1);
    await closeDb(db);
  });

  it('T13 — período é aplicado (data_venda fora da janela ignorada)', async () => {
    const { db, empresaA, periodo } = await setup();
    const r = await faturamentoPorEmpresa({ ...periodo, empresaId: empresaA.id });
    assert.equal(r.faturamento, 1000);
    assert.equal(r.periodo.campo, 'data_venda');
    await closeDb(db);
  });

  it('T14 — nenhuma consulta do MIS soma A+B no contexto de uma empresa', async () => {
    const { db, empresaA, empresaB, produtoId, periodo } = await setup();
    const a = await faturamentoPorEmpresa({ ...periodo, empresaId: empresaA.id });
    const b = await faturamentoPorEmpresa({ ...periodo, empresaId: empresaB.id });
    const ea = await estoqueProdutoPorEmpresa({ db, empresaId: empresaA.id, produtoId });
    assert.equal(a.faturamento, 1000);
    assert.equal(b.faturamento, 2000);
    assert.equal(ea.estoque_atual, 10);
    await closeDb(db);
  });

  it('T15 — EMPRESA_SIMPLES usa empresa operacional', async () => {
    const { db, empresaA, empresaB, depsSimples } = await setup();
    const ctx = await resolverEmpresaIdParaMis({ empresaId: empresaB.id, user: { id: 1 } }, depsSimples);
    assert.equal(ctx.empresaId, empresaA.id);
    assert.equal(ctx.origem, 'CONTRATO_EMPRESA_SIMPLES');
    await closeDb(db);
  });

  it('T16 — MULTIEMPRESA usa empresa do contexto', async () => {
    const { db, empresaB, depsMulti } = await setup();
    const ctx = await resolverEmpresaIdParaMis({ empresaId: empresaB.id, user: { id: 1 } }, depsMulti);
    assert.equal(ctx.empresaId, empresaB.id);
    assert.equal(ctx.origem, 'CONTEXTO_REQUISICAO');
    await closeDb(db);
  });
});

