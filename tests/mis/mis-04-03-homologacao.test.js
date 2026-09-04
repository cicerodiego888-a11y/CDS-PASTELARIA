/**
 * Sprint 04.03 — Homologação funcional do MIS.
 * Executar: node --test tests/mis/mis-04-03-homologacao.test.js
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
const { obterResumoMis, validarPeriodo } = require('../../backend/services/mis/MisResumoService');
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
    estoque_minimo REAL DEFAULT 0
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

  const idsA = [];
  for (let i = 1; i <= 11; i += 1) {
    const p = await run(db, `INSERT INTO produtos (nome, estoque_atual, estoque_minimo) VALUES (?, 999, 0)`, [`P${i}`]);
    idsA.push(p.lastID);
  }
  const pBaixo = await run(db, `INSERT INTO produtos (nome, estoque_atual, estoque_minimo) VALUES ('Baixo', 999, 5)`);
  const pExato = await run(db, `INSERT INTO produtos (nome, estoque_atual, estoque_minimo) VALUES ('Exato', 999, 3)`);
  const pAcima = await run(db, `INSERT INTO produtos (nome, estoque_atual, estoque_minimo) VALUES ('Acima', 999, 5)`);
  const pSemMin = await run(db, `INSERT INTO produtos (nome, estoque_atual, estoque_minimo) VALUES ('SemMin', 999, 0)`);

  await EstoqueEmpresaService.criarRegistro({
    produtoId: pBaixo.lastID, empresaId: empresaA.id, saldo_fiscal: 2, saldo_nao_fiscal: 0, estoque_atual: 2
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: pExato.lastID, empresaId: empresaA.id, saldo_fiscal: 3, saldo_nao_fiscal: 0, estoque_atual: 3
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: pAcima.lastID, empresaId: empresaA.id, saldo_fiscal: 20, saldo_nao_fiscal: 0, estoque_atual: 20
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: pSemMin.lastID, empresaId: empresaA.id, saldo_fiscal: 0, saldo_nao_fiscal: 0, estoque_atual: 0
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: pBaixo.lastID, empresaId: empresaB.id, saldo_fiscal: 50, saldo_nao_fiscal: 0, estoque_atual: 50
  }, { db });

  const vA = await run(db, `INSERT INTO vendas (empresa_id, data_venda, total, status, valor_fiscal, valor_nao_fiscal)
    VALUES (?, '2026-09-01', 175, 'concluida', 50, 125)`, [empresaA.id]);
  await run(db, `INSERT INTO vendas (empresa_id, data_venda, total, status, valor_fiscal, valor_nao_fiscal)
    VALUES (?, '2026-09-04', 999, 'concluida', 999, 0)`, [empresaA.id]);
  const vB = await run(db, `INSERT INTO vendas (empresa_id, data_venda, total, status, valor_fiscal, valor_nao_fiscal)
    VALUES (?, '2026-09-02', 500, 'concluida', 500, 0)`, [empresaB.id]);

  for (let i = 0; i < idsA.length; i += 1) {
    const qtd = 11 - i;
    await run(db, `INSERT INTO vendas_itens (venda_id, produto_id, quantidade, quantidade_fiscal, quantidade_nao_fiscal, subtotal)
      VALUES (?, ?, ?, ?, 0, ?)`, [vA.lastID, idsA[i], qtd, qtd, qtd]);
  }
  await run(db, `INSERT INTO vendas_itens (venda_id, produto_id, quantidade, quantidade_fiscal, quantidade_nao_fiscal, subtotal)
    VALUES (?, ?, 80, 80, 0, 500)`, [vB.lastID, idsA[0]]);

  await run(db, `INSERT INTO compras (empresa_id, data_compra, total) VALUES (?, '2026-09-02', 80)`, [empresaA.id]);
  await run(db, `INSERT INTO compras (empresa_id, data_compra, total) VALUES (?, '2026-09-04', 10)`, [empresaA.id]);
  await run(db, `INSERT INTO compras (empresa_id, data_compra, total) VALUES (?, '2026-09-02', 300)`, [empresaB.id]);

  await run(db, `INSERT INTO contas_receber (empresa_id, valor_restante, status) VALUES (?, 40, 'aberto')`, [empresaA.id]);
  await run(db, `INSERT INTO contas_receber (empresa_id, valor_restante, status) VALUES (?, 10, 'parcial')`, [empresaA.id]);
  await run(db, `INSERT INTO contas_receber (empresa_id, valor_restante, status) VALUES (?, 999, 'quitado')`, [empresaA.id]);
  await run(db, `INSERT INTO contas_receber (empresa_id, valor_restante, status) VALUES (?, 90, 'aberto')`, [empresaB.id]);

  await run(db, `INSERT INTO nfce_notas (venda_id, created_at) VALUES (?, '2026-09-01')`, [vA.lastID]);
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

  return { db, empresaA, empresaB, depsMulti, depsSimples, periodo, idsA };
}

async function httpResumo(ctx, { empresaId, userId, query, headerEmpresaId }) {
  const { res, out } = mockRes();
  const req = {
    user: { id: userId != null ? userId : 1 },
    empresaId,
    headers: headerEmpresaId != null ? { 'x-empresa-id': String(headerEmpresaId) } : {},
    query: query || { inicio: ctx.periodo.inicio, fim: ctx.periodo.fim, modo_fiscal: '0' }
  };
  await handleGetResumo(req, res, { db: ctx.db, ...ctx.depsMulti });
  return out;
}

describe('04.03 UI e contrato', () => {
  it('atalhos reutilizam a mesma consulta; período inválido e troca de empresa', () => {
    const front = src('frontend/erp/js/mis.js');
    const html = src('frontend/erp/pages/mis.html');
    const ctx = src('frontend/shared/js/cds-empresa-contexto.js');
    const rota = src('backend/rotas/mis.js');
    assert.match(front, /carregarResumoMis/);
    assert.match(front, /data-mis-atalho/);
    assert.match(front, /Período inválido/);
    assert.match(front, /cds-empresa-contexto-alterado/);
    assert.match(front, /formatarMoedaDashboard/);
    assert.doesNotMatch(front, /faturamento\s*\+|ticket.*\/.*total_vendas/);
    assert.match(html, /Nenhum dado encontrado/);
    assert.match(html, /em aberto/i);
    assert.match(html, /overflow-x: hidden/);
    assert.match(ctx, /cds-empresa-contexto-alterado/);
    assert.doesNotMatch(rota, /FROM vendas/);
    assert.doesNotMatch(rota, /Todas as empresas/);
    assert.match(src('frontend/erp/index.html'), /data-page="dashboard"/);
    assert.match(src('frontend/erp/index.html'), /data-page="mis"/);
  });
});

describe('04.03 homologação API', () => {
  it('T01 — API retorna 200 com período válido', async () => {
    const ctx = await setup();
    const out = await httpResumo(ctx, { empresaId: ctx.empresaA.id });
    assert.equal(out.statusCode, 200);
    await closeDb(ctx.db);
  });

  it('T02 T03 T04 — A e B isoladas; A não recebe dados de B', async () => {
    const ctx = await setup();
    const a = await obterResumoMis({ db: ctx.db, empresaId: ctx.empresaA.id, ...ctx.periodo, modoFiscal: '0' });
    const b = await obterResumoMis({ db: ctx.db, empresaId: ctx.empresaB.id, ...ctx.periodo, modoFiscal: '0' });
    assert.equal(a.vendas.faturamento, 175);
    assert.equal(b.vendas.faturamento, 500);
    assert.notEqual(a.vendas.faturamento, b.vendas.faturamento);
    assert.equal(a.compras.total, 80);
    assert.equal(b.compras.total, 300);
    assert.ok(!a.ranking.some((p) => p.quantidade_vendida === 80));
    await closeDb(ctx.db);
  });

  it('T05 — empresa_id da querystring não substitui contexto', async () => {
    const ctx = await setup();
    const out = await httpResumo(ctx, {
      empresaId: ctx.empresaA.id,
      query: { inicio: '2026-09-01', fim: '2026-09-03', modo_fiscal: '0', empresa_id: ctx.empresaB.id }
    });
    assert.equal(out.statusCode, 200);
    assert.equal(out.body.empresa_id, ctx.empresaA.id);
    assert.equal(out.body.vendas.faturamento, 175);
    await closeDb(ctx.db);
  });

  it('T06 — usuário não autorizado recebe 403', async () => {
    const ctx = await setup();
    const out = await httpResumo(ctx, { empresaId: ctx.empresaB.id, userId: 2 });
    assert.equal(out.statusCode, 403);
    assert.equal(out.body.code, 'EMPRESA_NAO_AUTORIZADA');
    await closeDb(ctx.db);
  });

  it('T07 — ausência de empresa retorna 400', async () => {
    const ctx = await setup();
    const out = await httpResumo(ctx, { empresaId: undefined });
    assert.equal(out.statusCode, 400);
    assert.ok(out.body.code);
    await closeDb(ctx.db);
  });

  it('T08 — período inválido é rejeitado', async () => {
    const ctx = await setup();
    assert.throws(() => validarPeriodo('2026-09-03', '2026-09-01'), (e) => {
      return e.code === 'PERIODO_INVALIDO' && e.message === 'Período inválido.';
    });
    const out = await httpResumo(ctx, {
      empresaId: ctx.empresaA.id,
      query: { inicio: '2026-09-03', fim: '2026-09-01', modo_fiscal: '0' }
    });
    assert.equal(out.statusCode, 400);
    assert.equal(out.body.code, 'PERIODO_INVALIDO');
    await closeDb(ctx.db);
  });

  it('T09 — compras respeitam empresa e período', async () => {
    const ctx = await setup();
    const a = await obterResumoMis({ db: ctx.db, empresaId: ctx.empresaA.id, ...ctx.periodo, modoFiscal: '0' });
    assert.equal(a.compras.total, 80);
    assert.equal(a.compras.quantidade, 1);
    await closeDb(ctx.db);
  });

  it('T10 — receber considera aberto/parcial e ignora quitado', async () => {
    const ctx = await setup();
    const a = await obterResumoMis({ db: ctx.db, empresaId: ctx.empresaA.id, ...ctx.periodo, modoFiscal: '0' });
    const b = await obterResumoMis({ db: ctx.db, empresaId: ctx.empresaB.id, ...ctx.periodo, modoFiscal: '0' });
    assert.equal(a.receber.total, 50);
    assert.equal(a.receber.quantidade, 2);
    assert.equal(a.receber.natureza, 'em_aberto');
    assert.equal(b.receber.total, 90);
    await closeDb(ctx.db);
  });

  it('T11 — ranking respeita empresa/período e máximo 10', async () => {
    const ctx = await setup();
    const a = await obterResumoMis({ db: ctx.db, empresaId: ctx.empresaA.id, ...ctx.periodo, modoFiscal: '0' });
    assert.equal(a.ranking.length, 10);
    assert.equal(a.ranking[0].nome, 'P1');
    assert.equal(a.ranking[0].quantidade_vendida, 11);
    assert.equal(a.ranking[9].quantidade_vendida, 2);
    assert.ok(!a.ranking.some((p) => p.nome === 'P11'));
    await closeDb(ctx.db);
  });

  it('T12 — estoque crítico usa estoque_empresa', async () => {
    const ctx = await setup();
    const a = await obterResumoMis({ db: ctx.db, empresaId: ctx.empresaA.id, ...ctx.periodo, modoFiscal: '0' });
    const b = await obterResumoMis({ db: ctx.db, empresaId: ctx.empresaB.id, ...ctx.periodo, modoFiscal: '0' });
    const nomes = a.estoque_critico.map((p) => p.nome);
    assert.ok(nomes.includes('Baixo'));
    assert.ok(nomes.includes('Exato'));
    assert.ok(!nomes.includes('Acima'));
    assert.ok(!nomes.includes('SemMin'));
    assert.ok(!b.estoque_critico.some((p) => p.nome === 'Baixo'));
    const svc = src('backend/services/mis/MisIndicadoresService.js');
    const trecho = svc.slice(svc.indexOf('async function estoqueCriticoPorEmpresa'));
    assert.match(trecho.slice(0, 900), /FROM estoque_empresa ee/);
    assert.doesNotMatch(trecho.slice(0, 900), /p\.estoque_atual/);
    await closeDb(ctx.db);
  });

  it('T13 — modo fiscal é propagado corretamente', async () => {
    const ctx = await setup();
    const nf = await obterResumoMis({ db: ctx.db, empresaId: ctx.empresaA.id, ...ctx.periodo, modoFiscal: '0' });
    const fi = await obterResumoMis({ db: ctx.db, empresaId: ctx.empresaA.id, ...ctx.periodo, modoFiscal: '1' });
    assert.equal(nf.vendas.faturamento, 175);
    assert.equal(fi.vendas.faturamento, 50);
    await closeDb(ctx.db);
  });

  it('T14 — ausência de dados não produz NaN/null/undefined indevido', async () => {
    const ctx = await setup();
    const r = await obterResumoMis({
      db: ctx.db, empresaId: ctx.empresaA.id, inicio: '2020-01-01', fim: '2020-01-02', modoFiscal: '0'
    });
    assert.equal(r.vendas.faturamento, 0);
    assert.equal(r.vendas.ticket_medio, 0);
    assert.ok(Number.isFinite(r.vendas.ticket_medio));
    assert.equal(r.ranking.length, 0);
    assert.notEqual(r.vendas.faturamento, null);
    await closeDb(ctx.db);
  });

  it('T15 — resposta possui estrutura completa do MIS', async () => {
    const ctx = await setup();
    const out = await httpResumo(ctx, { empresaId: ctx.empresaA.id });
    const r = out.body;
    assert.ok(r.empresa_id);
    assert.ok(r.periodo.inicio && r.periodo.fim);
    assert.ok('faturamento' in r.vendas && 'total_vendas' in r.vendas && 'ticket_medio' in r.vendas);
    assert.ok('total' in r.compras && 'quantidade' in r.compras);
    assert.ok('total' in r.receber && 'quantidade' in r.receber);
    assert.ok('quantidade' in r.fiscal && 'total' in r.fiscal);
    assert.ok(Array.isArray(r.ranking));
    assert.ok(Array.isArray(r.estoque_critico));
    await closeDb(ctx.db);
  });

  it('EMPRESA_SIMPLES usa empresa operacional mesmo com header de B', async () => {
    const ctx = await setup();
    const resolved = await resolverEmpresaIdParaMis(
      { empresaId: ctx.empresaB.id, user: { id: 1 } },
      ctx.depsSimples
    );
    assert.equal(resolved.empresaId, ctx.empresaA.id);
    await closeDb(ctx.db);
  });

  it('X-Empresa-Id autorizado consulta somente a empresa do header', async () => {
    const ctx = await setup();
    const out = await httpResumo(ctx, {
      empresaId: undefined,
      headerEmpresaId: ctx.empresaB.id
    });
    assert.equal(out.statusCode, 200);
    assert.equal(out.body.empresa_id, ctx.empresaB.id);
    assert.equal(out.body.vendas.faturamento, 500);
    await closeDb(ctx.db);
  });
});
