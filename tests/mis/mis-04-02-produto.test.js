/**
 * Sprint 04.02 — MIS mínimo de produto.
 * Executar: node --test tests/mis/mis-04-02-produto.test.js
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
const { obterResumoMis } = require('../../backend/services/mis/MisResumoService');
const { handleGetResumo } = require('../../backend/rotas/mis');

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

function mockRes() {
  const out = { statusCode: 200, body: null };
  const res = {
    status(c) { out.statusCode = c; return res; },
    json(b) { out.body = b; return res; }
  };
  return { res, out };
}

async function setup() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  await garantirSchemaUsuarioEmpresasAsync(db);
  await run(db, `CREATE TABLE produtos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT, estoque_atual REAL DEFAULT 0,
    estoque_minimo REAL DEFAULT 0, saldo_fiscal REAL DEFAULT 0, saldo_nao_fiscal REAL DEFAULT 0
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
    id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER, data_compra TEXT, total REAL DEFAULT 0
  )`);
  await run(db, `CREATE TABLE contas_receber (
    id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER, valor_restante REAL, status TEXT
  )`);
  await run(db, `CREATE TABLE nfce_notas (
    id INTEGER PRIMARY KEY AUTOINCREMENT, venda_id INTEGER, created_at TEXT
  )`);

  const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  const pastel = await run(db, `INSERT INTO produtos (nome, estoque_atual, estoque_minimo) VALUES ('Pastel', 999, 5)`);
  const suco = await run(db, `INSERT INTO produtos (nome, estoque_atual, estoque_minimo) VALUES ('Suco', 999, 10)`);
  await EstoqueEmpresaService.criarRegistro({
    produtoId: pastel.lastID, empresaId: empresaA.id, saldo_fiscal: 2, saldo_nao_fiscal: 0, estoque_atual: 2
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: pastel.lastID, empresaId: empresaB.id, saldo_fiscal: 50, saldo_nao_fiscal: 0, estoque_atual: 50
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: suco.lastID, empresaId: empresaA.id, saldo_fiscal: 1, saldo_nao_fiscal: 0, estoque_atual: 1
  }, { db });

  const vA100 = await run(db, `INSERT INTO vendas (empresa_id, data_venda, total, status, valor_fiscal, valor_nao_fiscal)
    VALUES (?, '2026-09-01', 100, 'concluida', 30, 70)`, [empresaA.id]);
  await run(db, `INSERT INTO vendas (empresa_id, data_venda, total, status, valor_fiscal, valor_nao_fiscal)
    VALUES (?, '2026-09-02', 50, 'concluida', 50, 0)`, [empresaA.id]);
  await run(db, `INSERT INTO vendas (empresa_id, data_venda, total, status, valor_fiscal, valor_nao_fiscal)
    VALUES (?, '2026-09-03', 25, 'concluida', 25, 0)`, [empresaA.id]);
  await run(db, `INSERT INTO vendas (empresa_id, data_venda, total, status, valor_fiscal, valor_nao_fiscal)
    VALUES (?, '2026-09-04', 999, 'concluida', 999, 0)`, [empresaA.id]);
  const vB = await run(db, `INSERT INTO vendas (empresa_id, data_venda, total, status, valor_fiscal, valor_nao_fiscal)
    VALUES (?, '2026-09-02', 500, 'concluida', 500, 0)`, [empresaB.id]);

  await run(db, `INSERT INTO vendas_itens (venda_id, produto_id, quantidade, quantidade_fiscal, quantidade_nao_fiscal, subtotal)
    VALUES (?, ?, 10, 10, 0, 100)`, [vA100.lastID, pastel.lastID]);
  await run(db, `INSERT INTO vendas_itens (venda_id, produto_id, quantidade, quantidade_fiscal, quantidade_nao_fiscal, subtotal)
    VALUES (?, ?, 80, 80, 0, 500)`, [vB.lastID, pastel.lastID]);

  await run(db, `INSERT INTO compras (empresa_id, data_compra, total) VALUES (?, '2026-09-02', 80)`, [empresaA.id]);
  await run(db, `INSERT INTO compras (empresa_id, data_compra, total) VALUES (?, '2026-09-02', 300)`, [empresaB.id]);
  await run(db, `INSERT INTO contas_receber (empresa_id, valor_restante, status) VALUES (?, 40, 'aberto')`, [empresaA.id]);
  await run(db, `INSERT INTO contas_receber (empresa_id, valor_restante, status) VALUES (?, 90, 'aberto')`, [empresaB.id]);
  await run(db, `INSERT INTO nfce_notas (venda_id, created_at) VALUES (?, '2026-09-01')`, [vA100.lastID]);
  await run(db, `INSERT INTO nfce_notas (venda_id, created_at) VALUES (?, '2026-09-02')`, [vB.lastID]);

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
  const periodo = { inicio: '2026-09-01', fim: '2026-09-03' };

  return {
    db, empresaA, empresaB, produtoId: pastel.lastID, sucoId: suco.lastID,
    depsMulti, depsSimples, periodo
  };
}

async function getResumoHttp(ctx, query, depsExtra) {
  const { res, out } = mockRes();
  const req = {
    user: { id: 1 },
    empresaId: ctx.empresaA.id,
    query: query || { inicio: ctx.periodo.inicio, fim: ctx.periodo.fim, modo_fiscal: '0' }
  };
  await handleGetResumo(req, res, {
    db: ctx.db,
    ...ctx.depsMulti,
    resolverEmpresaIdParaMis: async (r, d) => resolverEmpresaIdParaMis(r, d),
    ...depsExtra
  });
  return out;
}

describe('04.02 invariantes de produto', () => {
  it('rota orquestra MIS sem SQL e sem MUC; dashboard preservado', () => {
    const rota = src('backend/rotas/mis.js');
    const dash = src('backend/rotas/dashboard.js');
    const server = src('backend/server.js');
    const menu = src('frontend/erp/index.html');
    const app = src('frontend/erp/js/app.js');
    const front = src('frontend/erp/js/mis.js');
    assert.match(server, /\/api\/mis/);
    assert.match(rota, /obterResumoMis/);
    assert.match(rota, /resolverEmpresaIdParaMis/);
    assert.doesNotMatch(rota, /FROM vendas/);
    assert.doesNotMatch(rota, /obterMuc|MotorConversao/);
    assert.match(dash, /router\.get\('\/resumo'/);
    assert.match(menu, /data-page="mis"/);
    assert.match(menu, /data-page="dashboard"/);
    assert.match(app, /case 'mis'/);
    assert.doesNotMatch(front, /Chart\.|Todas as empresas|consolidado/i);
    assert.match(front, /Sem vendas no período/);
    assert.match(src('backend/services/mis/MisIndicadoresService.js'), /estoqueCriticoPorEmpresa/);
    assert.doesNotMatch(src('backend/services/mis/MisIndicadoresService.js'), /FROM produtos p\s+WHERE.*estoque_atual/);
  });
});

describe('04.02 API e indicadores', () => {
  it('T01 — GET /api/mis/resumo com empresa autorizada', async () => {
    const ctx = await setup();
    const out = await getResumoHttp(ctx);
    assert.equal(out.statusCode, 200);
    assert.equal(out.body.empresa_id, ctx.empresaA.id);
    assert.ok(out.body.vendas);
    await closeDb(ctx.db);
  });

  it('T02 T03 T04 — faturamento, nº vendas e ticket da empresa A', async () => {
    const ctx = await setup();
    const r = await obterResumoMis({
      db: ctx.db, empresaId: ctx.empresaA.id, ...ctx.periodo, modoFiscal: '0'
    });
    assert.equal(r.vendas.faturamento, 175);
    assert.equal(r.vendas.total_vendas, 3);
    assert.equal(r.vendas.ticket_medio, 175 / 3);
    await closeDb(ctx.db);
  });

  it('T05 T06 T07 T08 T09 — compras, receber, NFC-e, ranking só da empresa', async () => {
    const ctx = await setup();
    const a = await obterResumoMis({
      db: ctx.db, empresaId: ctx.empresaA.id, ...ctx.periodo, modoFiscal: '0'
    });
    const b = await obterResumoMis({
      db: ctx.db, empresaId: ctx.empresaB.id, ...ctx.periodo, modoFiscal: '0'
    });
    assert.equal(a.compras.total, 80);
    assert.equal(a.compras.quantidade, 1);
    assert.equal(b.compras.total, 300);
    assert.equal(a.receber.total, 40);
    assert.equal(a.receber.natureza, 'em_aberto');
    assert.equal(b.receber.total, 90);
    assert.equal(a.fiscal.quantidade, 1);
    assert.equal(a.fiscal.total, 100);
    assert.equal(b.fiscal.quantidade, 1);
    assert.equal(b.fiscal.total, 500);
    assert.equal(a.ranking.length, 1);
    assert.equal(a.ranking[0].quantidade_vendida, 10);
    assert.equal(b.ranking[0].quantidade_vendida, 80);
    assert.notEqual(a.vendas.faturamento + b.vendas.faturamento, a.vendas.faturamento);
    assert.equal(a.vendas.faturamento, 175);
    assert.equal(b.vendas.faturamento, 500);
    await closeDb(ctx.db);
  });

  it('T10 — empresa não autorizada retorna erro', async () => {
    const ctx = await setup();
    const { res, out } = mockRes();
    await handleGetResumo(
      { user: { id: 2 }, empresaId: ctx.empresaB.id, query: { inicio: '2026-09-01', fim: '2026-09-03' } },
      res,
      { db: ctx.db, ...ctx.depsMulti }
    );
    assert.equal(out.statusCode, 403);
    assert.equal(out.body.code, 'EMPRESA_NAO_AUTORIZADA');
    await closeDb(ctx.db);
  });

  it('T11 — EMPRESA_SIMPLES usa empresa_operacional_id', async () => {
    const ctx = await setup();
    const resolved = await resolverEmpresaIdParaMis(
      { empresaId: ctx.empresaB.id, user: { id: 1 } },
      ctx.depsSimples
    );
    assert.equal(resolved.empresaId, ctx.empresaA.id);
    const r = await obterResumoMis({
      db: ctx.db, empresaId: resolved.empresaId, ...ctx.periodo, modoFiscal: '0'
    });
    assert.equal(r.vendas.faturamento, 175);
    await closeDb(ctx.db);
  });

  it('T12 — período 01–03 não inclui 04/09', async () => {
    const ctx = await setup();
    const r = await obterResumoMis({
      db: ctx.db, empresaId: ctx.empresaA.id, inicio: '2026-09-01', fim: '2026-09-03', modoFiscal: '0'
    });
    assert.equal(r.vendas.faturamento, 175);
    const soDia4 = await obterResumoMis({
      db: ctx.db, empresaId: ctx.empresaA.id, inicio: '2026-09-04', fim: '2026-09-04', modoFiscal: '0'
    });
    assert.equal(soDia4.vendas.faturamento, 999);
    await closeDb(ctx.db);
  });

  it('T13 — modo fiscal respeitado', async () => {
    const ctx = await setup();
    const nf = await obterResumoMis({
      db: ctx.db, empresaId: ctx.empresaA.id, ...ctx.periodo, modoFiscal: '0'
    });
    const fi = await obterResumoMis({
      db: ctx.db, empresaId: ctx.empresaA.id, ...ctx.periodo, modoFiscal: '1'
    });
    assert.equal(nf.vendas.faturamento, 175);
    assert.equal(fi.vendas.faturamento, 105);
    await closeDb(ctx.db);
  });

  it('T14 — payload completo', async () => {
    const ctx = await setup();
    const r = await obterResumoMis({
      db: ctx.db, empresaId: ctx.empresaA.id, ...ctx.periodo, modoFiscal: '0'
    });
    assert.equal(r.empresa_id, ctx.empresaA.id);
    assert.deepEqual(r.periodo, ctx.periodo);
    ['faturamento', 'total_vendas', 'ticket_medio'].forEach((k) => assert.ok(k in r.vendas));
    ['total', 'quantidade'].forEach((k) => assert.ok(k in r.compras));
    ['total', 'quantidade'].forEach((k) => assert.ok(k in r.receber));
    ['quantidade', 'total'].forEach((k) => assert.ok(k in r.fiscal));
    assert.ok(Array.isArray(r.ranking));
    assert.ok(Array.isArray(r.estoque_critico));
    assert.ok(r.estoque_critico.some((p) => p.nome === 'Pastel' && p.estoque === 2));
    assert.ok(r.estoque_critico.every((p) => p.id !== undefined));
    await closeDb(ctx.db);
  });

  it('T15 — sem empresa válida → erro explícito', async () => {
    const ctx = await setup();
    const { res, out } = mockRes();
    await handleGetResumo(
      { user: { id: 1 }, query: { inicio: '2026-09-01', fim: '2026-09-03' } },
      res,
      { db: ctx.db, ...ctx.depsMulti }
    );
    assert.ok(out.statusCode === 400 || out.statusCode === 403);
    assert.ok(out.body.code);
    await closeDb(ctx.db);
  });

  it('query empresa_id do frontend não substitui o contexto', async () => {
    const ctx = await setup();
    const out = await getResumoHttp(ctx, {
      inicio: '2026-09-01',
      fim: '2026-09-03',
      modo_fiscal: '0',
      empresa_id: ctx.empresaB.id
    });
    assert.equal(out.statusCode, 200);
    assert.equal(out.body.empresa_id, ctx.empresaA.id);
    assert.equal(out.body.vendas.faturamento, 175);
    await closeDb(ctx.db);
  });

  it('empty state numérico é zero, não NaN', async () => {
    const ctx = await setup();
    const r = await obterResumoMis({
      db: ctx.db, empresaId: ctx.empresaA.id, inicio: '2020-01-01', fim: '2020-01-02', modoFiscal: '0'
    });
    assert.equal(r.vendas.faturamento, 0);
    assert.equal(r.vendas.total_vendas, 0);
    assert.equal(r.vendas.ticket_medio, 0);
    assert.equal(r.compras.total, 0);
    assert.equal(r.ranking.length, 0);
    assert.ok(Number.isFinite(r.receber.total));
    await closeDb(ctx.db);
  });

  it('estoque crítico não usa produtos.estoque_atual global', async () => {
    const ctx = await setup();
    const a = await obterResumoMis({
      db: ctx.db, empresaId: ctx.empresaA.id, ...ctx.periodo, modoFiscal: '0'
    });
    const b = await obterResumoMis({
      db: ctx.db, empresaId: ctx.empresaB.id, ...ctx.periodo, modoFiscal: '0'
    });
    assert.ok(a.estoque_critico.some((p) => p.estoque === 2));
    assert.ok(!b.estoque_critico.some((p) => p.nome === 'Pastel'));
    await closeDb(ctx.db);
  });
});
