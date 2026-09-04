/**
 * Sprint MIS-05 — evolução gerencial (série diária + comparação opcional).
 * Executar: node --test tests/mis/mis-05.test.js
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
  obterResumoMis,
  calcularPeriodoAnterior,
  calcularVariacaoPercentual
} = require('../../backend/services/mis/MisResumoService');
const { faturamentoDiarioPorEmpresa } = require('../../backend/services/mis/MisIndicadoresService');
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
  const pBaixo = await run(db, `INSERT INTO produtos (nome, estoque_atual, estoque_minimo) VALUES ('Baixo', 999, 10)`);
  const pExato = await run(db, `INSERT INTO produtos (nome, estoque_atual, estoque_minimo) VALUES ('Exato', 999, 3)`);

  await EstoqueEmpresaService.criarRegistro({
    produtoId: pBaixo.lastID, empresaId: empresaA.id, saldo_fiscal: 3, saldo_nao_fiscal: 0, estoque_atual: 3
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: pExato.lastID, empresaId: empresaA.id, saldo_fiscal: 3, saldo_nao_fiscal: 0, estoque_atual: 3
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: pBaixo.lastID, empresaId: empresaB.id, saldo_fiscal: 50, saldo_nao_fiscal: 0, estoque_atual: 50
  }, { db });

  await run(db, `INSERT INTO vendas (empresa_id, data_venda, total, status, valor_fiscal, valor_nao_fiscal)
    VALUES (?, '2026-08-29', 200, 'concluida', 200, 0)`, [empresaA.id]);
  await run(db, `INSERT INTO vendas (empresa_id, data_venda, total, status, valor_fiscal, valor_nao_fiscal)
    VALUES (?, '2026-08-30', 0, 'concluida', 0, 0)`, [empresaA.id]);
  await run(db, `INSERT INTO vendas (empresa_id, data_venda, total, status, valor_fiscal, valor_nao_fiscal)
    VALUES (?, '2026-08-31', 1000, 'concluida', 1000, 0)`, [empresaA.id]);

  const vA1 = await run(db, `INSERT INTO vendas (empresa_id, data_venda, total, status, valor_fiscal, valor_nao_fiscal)
    VALUES (?, '2026-09-01', 100, 'concluida', 40, 60)`, [empresaA.id]);
  await run(db, `INSERT INTO vendas (empresa_id, data_venda, total, status, valor_fiscal, valor_nao_fiscal)
    VALUES (?, '2026-09-03', 200, 'concluida', 80, 120)`, [empresaA.id]);
  const vB = await run(db, `INSERT INTO vendas (empresa_id, data_venda, total, status, valor_fiscal, valor_nao_fiscal)
    VALUES (?, '2026-09-02', 500, 'concluida', 500, 0)`, [empresaB.id]);
  await run(db, `INSERT INTO vendas (empresa_id, data_venda, total, status, valor_fiscal, valor_nao_fiscal)
    VALUES (?, '2026-08-31', 9999, 'concluida', 9999, 0)`, [empresaB.id]);

  for (let i = 0; i < 11; i += 1) {
    await run(db, `INSERT INTO vendas_itens (venda_id, produto_id, quantidade, quantidade_fiscal, quantidade_nao_fiscal, subtotal)
      VALUES (?, ?, ?, ?, 0, 1)`, [vA1.lastID, idsA[i], 11 - i, 11 - i]);
  }
  await run(db, `INSERT INTO vendas_itens (venda_id, produto_id, quantidade, quantidade_fiscal, quantidade_nao_fiscal, subtotal)
    VALUES (?, ?, 80, 80, 0, 500)`, [vB.lastID, idsA[0]]);

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

  return { db, empresaA, empresaB, depsMulti, depsSimples, periodo, pBaixoId: pBaixo.lastID };
}

async function httpResumo(ctx, { empresaId, userId, query, headers } = {}) {
  const { res, out } = mockRes();
  const req = {
    user: { id: userId != null ? userId : 1 },
    empresaId: empresaId,
    headers: headers || {},
    query: query || { inicio: ctx.periodo.inicio, fim: ctx.periodo.fim, modo_fiscal: '0' }
  };
  await handleGetResumo(req, res, {
    db: ctx.db,
    ...ctx.depsMulti
  });
  return out;
}

describe('MIS-05 invariantes', () => {
  it('rota continua sem SQL; ranking oficial; sem MUC', () => {
    const rota = src('backend/rotas/mis.js');
    const ind = src('backend/services/mis/MisIndicadoresService.js');
    assert.match(rota, /obterResumoMis/);
    assert.doesNotMatch(rota, /FROM vendas/);
    assert.doesNotMatch(rota, /obterMuc|MotorConversao/);
    assert.match(ind, /rankingProdutosPorEmpresa/);
    assert.match(ind, /faturamentoDiarioPorEmpresa/);
    assert.match(ind, /FILTRO_VENDA_VALIDA/);
    assert.match(ind, /getExprValorVenda/);
    assert.doesNotMatch(src('frontend/erp/js/mis.js'), /Todas as empresas/i);
  });
});

describe('MIS-05 API', () => {
  it('T01 T20 — resumo atual continua funcionando sem comparação obrigatória', async () => {
    const ctx = await setup();
    const out = await httpResumo(ctx, { empresaId: ctx.empresaA.id });
    assert.equal(out.statusCode, 200);
    assert.equal(out.body.vendas.faturamento, 300);
    assert.equal(out.body.comparacao.habilitada, false);
    assert.ok(Array.isArray(out.body.evolucao));
    assert.equal(out.body.evolucao.length, 3);
    assert.ok('ticket_medio' in out.body.vendas);
    assert.ok('natureza' in out.body.receber);
    await closeDb(ctx.db);
  });

  it('T02 T03 T04 T05 — faturamento diário respeita empresa, período e dias zerados', async () => {
    const ctx = await setup();
    const a = await faturamentoDiarioPorEmpresa({
      db: ctx.db, empresaId: ctx.empresaA.id, ...ctx.periodo, modoFiscal: '0'
    });
    const b = await faturamentoDiarioPorEmpresa({
      db: ctx.db, empresaId: ctx.empresaB.id, ...ctx.periodo, modoFiscal: '0'
    });
    assert.deepEqual(a.serie.map((d) => d.data), ['2026-09-01', '2026-09-02', '2026-09-03']);
    assert.equal(a.serie[0].faturamento, 100);
    assert.equal(a.serie[1].faturamento, 0);
    assert.equal(a.serie[1].total_vendas, 0);
    assert.equal(a.serie[2].faturamento, 200);
    assert.equal(b.serie[1].faturamento, 500);
    assert.equal(a.serie.reduce((s, d) => s + d.faturamento, 0), 300);
    assert.ok(!a.serie.some((d) => d.faturamento === 500));
    assert.ok(!b.serie.some((d) => d.faturamento === 100));
    await closeDb(ctx.db);
  });

  it('T06 — comparação calcula período anterior corretamente', async () => {
    const ant = calcularPeriodoAnterior('2026-09-01', '2026-09-03');
    assert.deepEqual(ant, { inicio: '2026-08-29', fim: '2026-08-31' });
    const sem = calcularPeriodoAnterior('2026-09-01', '2026-09-07');
    assert.deepEqual(sem, { inicio: '2026-08-25', fim: '2026-08-31' });
  });

  it('T07 T08 T15 — comparação respeita empresa e variação correta', async () => {
    const ctx = await setup();
    const a = await obterResumoMis({
      db: ctx.db, empresaId: ctx.empresaA.id, ...ctx.periodo, modoFiscal: '0', comparar: true
    });
    const b = await obterResumoMis({
      db: ctx.db, empresaId: ctx.empresaB.id, ...ctx.periodo, modoFiscal: '0', comparar: true
    });
    assert.equal(a.comparacao.habilitada, true);
    assert.deepEqual(a.comparacao.periodo_anterior, { inicio: '2026-08-29', fim: '2026-08-31' });
    assert.equal(a.comparacao.atual.faturamento, 300);
    assert.equal(a.comparacao.anterior.faturamento, 1200);
    assert.equal(a.comparacao.variacao.faturamento, -75);
    assert.equal(a.comparacao.variacao.faturamento_estado, 'ok');
    assert.equal(b.comparacao.atual.faturamento, 500);
    assert.equal(b.comparacao.anterior.faturamento, 9999);
    assert.notEqual(a.comparacao.atual.faturamento, b.comparacao.atual.faturamento);
    assert.ok(!Number.isNaN(a.comparacao.variacao.faturamento));
    await closeDb(ctx.db);
  });

  it('T09 T10 — comparação com anterior zero não gera NaN nem Infinity', async () => {
    const z1 = calcularVariacaoPercentual(100, 0);
    const z0 = calcularVariacaoPercentual(0, 0);
    assert.equal(z1.estado, 'sem_base');
    assert.equal(z1.percentual, null);
    assert.equal(z0.estado, 'sem_variacao');
    assert.ok(z1.percentual !== Infinity && z0.percentual !== Infinity);
    assert.ok(z1.percentual == null || Number.isFinite(z1.percentual));

    const ctx = await setup();
    const r = await obterResumoMis({
      db: ctx.db, empresaId: ctx.empresaA.id, inicio: '2026-07-01', fim: '2026-07-03',
      modoFiscal: '0', comparar: true
    });
    assert.equal(r.comparacao.anterior.faturamento, 0);
    assert.equal(r.comparacao.atual.faturamento, 0);
    assert.equal(r.comparacao.variacao.faturamento, null);
    assert.equal(r.comparacao.variacao.faturamento_estado, 'sem_variacao');
    assert.notEqual(r.comparacao.variacao.faturamento, Infinity);
    assert.ok(r.comparacao.variacao.faturamento !== Number.NaN);
    await closeDb(ctx.db);
  });

  it('T11 T12 — ranking limitado a 10 e isolado', async () => {
    const ctx = await setup();
    const a = await obterResumoMis({
      db: ctx.db, empresaId: ctx.empresaA.id, ...ctx.periodo, modoFiscal: '0'
    });
    const b = await obterResumoMis({
      db: ctx.db, empresaId: ctx.empresaB.id, ...ctx.periodo, modoFiscal: '0'
    });
    assert.equal(a.ranking.length, 10);
    assert.equal(a.ranking[0].quantidade_vendida, 11);
    assert.ok(!a.ranking.some((p) => p.quantidade_vendida === 80));
    assert.equal(b.ranking[0].quantidade_vendida, 80);
    await closeDb(ctx.db);
  });

  it('T13 T14 — estoque crítico usa estoque_empresa e mínimo', async () => {
    const ctx = await setup();
    const a = await obterResumoMis({
      db: ctx.db, empresaId: ctx.empresaA.id, ...ctx.periodo, modoFiscal: '0'
    });
    const b = await obterResumoMis({
      db: ctx.db, empresaId: ctx.empresaB.id, ...ctx.periodo, modoFiscal: '0'
    });
    const baixo = a.estoque_critico.find((p) => p.nome === 'Baixo');
    assert.ok(baixo);
    assert.equal(baixo.estoque, 3);
    assert.equal(baixo.estoque_minimo, 10);
    assert.equal(baixo.diferenca, -7);
    assert.ok(a.estoque_critico.some((p) => p.nome === 'Exato'));
    assert.ok(!b.estoque_critico.some((p) => p.nome === 'Baixo'));
    const trecho = src('backend/services/mis/MisIndicadoresService.js');
    assert.match(trecho, /FROM estoque_empresa ee/);
    await closeDb(ctx.db);
  });

  it('T16 — modo fiscal é respeitado pela evolução de vendas', async () => {
    const ctx = await setup();
    const nf = await faturamentoDiarioPorEmpresa({
      db: ctx.db, empresaId: ctx.empresaA.id, ...ctx.periodo, modoFiscal: '0'
    });
    const fi = await faturamentoDiarioPorEmpresa({
      db: ctx.db, empresaId: ctx.empresaA.id, ...ctx.periodo, modoFiscal: '1'
    });
    assert.equal(nf.serie[0].faturamento, 100);
    assert.equal(fi.serie[0].faturamento, 40);
    assert.equal(fi.serie[2].faturamento, 80);
    await closeDb(ctx.db);
  });

  it('T17 — empresa_id da querystring não substitui o contexto', async () => {
    const ctx = await setup();
    const out = await httpResumo(ctx, {
      empresaId: ctx.empresaA.id,
      query: {
        inicio: '2026-09-01',
        fim: '2026-09-03',
        modo_fiscal: '0',
        empresa_id: ctx.empresaB.id,
        comparar: '1'
      }
    });
    assert.equal(out.statusCode, 200);
    assert.equal(out.body.empresa_id, ctx.empresaA.id);
    assert.equal(out.body.vendas.faturamento, 300);
    assert.ok(!out.body.evolucao.some((d) => d.faturamento === 500));
    await closeDb(ctx.db);
  });

  it('T18 — usuário não autorizado recebe 403', async () => {
    const ctx = await setup();
    const out = await httpResumo(ctx, { empresaId: ctx.empresaB.id, userId: 2 });
    assert.equal(out.statusCode, 403);
    assert.equal(out.body.code, 'EMPRESA_NAO_AUTORIZADA');
    await closeDb(ctx.db);
  });

  it('T19 — ausência de empresa retorna 400 quando aplicável', async () => {
    const ctx = await setup();
    const { res, out } = mockRes();
    await handleGetResumo(
      { user: { id: 1 }, query: { inicio: '2026-09-01', fim: '2026-09-03' } },
      res,
      { db: ctx.db, ...ctx.depsMulti }
    );
    assert.ok(out.statusCode === 400 || out.statusCode === 403);
    await closeDb(ctx.db);
  });

  it('HTTP comparar=1 habilita seção no resumo', async () => {
    const ctx = await setup();
    const out = await httpResumo(ctx, {
      empresaId: ctx.empresaA.id,
      query: { inicio: '2026-09-01', fim: '2026-09-03', modo_fiscal: '0', comparar: '1' }
    });
    assert.equal(out.statusCode, 200);
    assert.equal(out.body.comparacao.habilitada, true);
    assert.equal(out.body.comparacao.anterior.faturamento, 1200);
    await closeDb(ctx.db);
  });

  it('EMPRESA_SIMPLES usa operacional na série', async () => {
    const ctx = await setup();
    const resolved = await resolverEmpresaIdParaMis(
      { empresaId: ctx.empresaB.id, user: { id: 1 } },
      ctx.depsSimples
    );
    assert.equal(resolved.empresaId, ctx.empresaA.id);
    const serie = await faturamentoDiarioPorEmpresa({
      db: ctx.db, empresaId: resolved.empresaId, ...ctx.periodo, modoFiscal: '0'
    });
    assert.equal(serie.serie[0].faturamento, 100);
    await closeDb(ctx.db);
  });
});
