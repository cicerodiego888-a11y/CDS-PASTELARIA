/**
 * Fase 2 / Implementação 03.21 — primeira leitura operacional por empresa.
 * Consumidor: GET /api/produtos/:id via resolverSaldosProdutoParaResposta.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const { resolverSaldosProdutoParaResposta } = require('../../backend/services/estoque/leituraEstoqueEmpresaProduto');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');

const ROOT = path.resolve(__dirname, '../..');
const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

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

function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_) { resolve(); }
  });
}

async function setup() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  await run(db, `
    CREATE TABLE produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT,
      saldo_fiscal REAL DEFAULT 0,
      saldo_nao_fiscal REAL DEFAULT 0,
      estoque_atual REAL DEFAULT 0,
      reservado_fiscal REAL DEFAULT 0,
      reservado_nao_fiscal REAL DEFAULT 0
    )
  `);
  const p = await run(
    db,
    `INSERT INTO produtos
       (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual, reservado_fiscal, reservado_nao_fiscal)
     VALUES ('X', 100, 40, 140, 7, 3)`
  );
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const b = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [p.lastID]);
  return { db, produtoId: p.lastID, empresaA: a, empresaB: b, row };
}

async function test01SemEmpresaLegado() {
  const { db, produtoId, row } = await setup();
  const r = await resolverSaldosProdutoParaResposta({
    row,
    produtoId,
    empresaId: null,
    db
  });
  assert.strictEqual(r.isolado, false);
  assert.strictEqual(r.row.saldo_fiscal, 100);
  assert.strictEqual(r.row.saldo_nao_fiscal, 40);
  assert.strictEqual(r.row.estoque_atual, 140);
  await closeDb(db);
}

async function test02ComEmpresaLeEstoqueEmpresa() {
  const { db, produtoId, empresaA, row } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId,
    empresaId: empresaA.id,
    saldo_fiscal: 12,
    saldo_nao_fiscal: 4,
    estoque_atual: 16,
    reservado_fiscal: 2,
    reservado_nao_fiscal: 1
  }, { db });
  const r = await resolverSaldosProdutoParaResposta({
    row,
    produtoId,
    empresaId: empresaA.id,
    db
  });
  assert.strictEqual(r.isolado, true);
  assert.strictEqual(r.encontrado, true);
  assert.strictEqual(r.row.saldo_fiscal, 12);
  await closeDb(db);
}

async function test03IsolamentoAB() {
  const { db, produtoId, empresaA, empresaB, row } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId,
    empresaId: empresaA.id,
    saldo_fiscal: 12,
    saldo_nao_fiscal: 0,
    estoque_atual: 12
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId,
    empresaId: empresaB.id,
    saldo_fiscal: 99,
    saldo_nao_fiscal: 0,
    estoque_atual: 99
  }, { db });
  const a = await resolverSaldosProdutoParaResposta({
    row, produtoId, empresaId: empresaA.id, db
  });
  const b = await resolverSaldosProdutoParaResposta({
    row, produtoId, empresaId: empresaB.id, db
  });
  assert.strictEqual(a.row.saldo_fiscal, 12);
  assert.strictEqual(b.row.saldo_fiscal, 99);
  await closeDb(db);
}

async function test04InexistenteNaoCaiEmProdutos() {
  const { db, produtoId, empresaA, row } = await setup();
  const r = await resolverSaldosProdutoParaResposta({
    row, produtoId, empresaId: empresaA.id, db
  });
  assert.strictEqual(r.isolado, true);
  assert.strictEqual(r.encontrado, false);
  assert.strictEqual(r.row.saldo_fiscal, 0);
  assert.notStrictEqual(r.row.saldo_fiscal, 100);
  await closeDb(db);
}

async function test05LegadoNaoInterfere() {
  const { db, produtoId, empresaA, row } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId,
    empresaId: empresaA.id,
    saldo_fiscal: 1,
    saldo_nao_fiscal: 2,
    estoque_atual: 3
  }, { db });
  const r = await resolverSaldosProdutoParaResposta({
    row, produtoId, empresaId: empresaA.id, db
  });
  assert.strictEqual(r.row.saldo_fiscal, 1);
  assert.notStrictEqual(r.row.estoque_atual, 140);
  await closeDb(db);
}

async function test06SaldoFiscal() {
  const { db, produtoId, empresaA, row } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaA.id, saldo_fiscal: 12, saldo_nao_fiscal: 4, estoque_atual: 16
  }, { db });
  const r = await resolverSaldosProdutoParaResposta({
    row, produtoId, empresaId: empresaA.id, db
  });
  assert.strictEqual(r.row.saldo_fiscal, 12);
  await closeDb(db);
}

async function test07SaldoNaoFiscal() {
  const { db, produtoId, empresaA, row } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaA.id, saldo_fiscal: 12, saldo_nao_fiscal: 4, estoque_atual: 16
  }, { db });
  const r = await resolverSaldosProdutoParaResposta({
    row, produtoId, empresaId: empresaA.id, db
  });
  assert.strictEqual(r.row.saldo_nao_fiscal, 4);
  await closeDb(db);
}

async function test08Reservas() {
  const { db, produtoId, empresaA, row } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId,
    empresaId: empresaA.id,
    saldo_fiscal: 12,
    saldo_nao_fiscal: 4,
    estoque_atual: 16,
    reservado_fiscal: 2,
    reservado_nao_fiscal: 1
  }, { db });
  const r = await resolverSaldosProdutoParaResposta({
    row, produtoId, empresaId: empresaA.id, db
  });
  assert.strictEqual(r.row.reservado_fiscal, 2);
  assert.strictEqual(r.row.reservado_nao_fiscal, 1);
  await closeDb(db);
}

async function test09EstoqueAtualIsolado() {
  const { db, produtoId, empresaA, row } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaA.id, saldo_fiscal: 12, saldo_nao_fiscal: 4, estoque_atual: 16
  }, { db });
  const r = await resolverSaldosProdutoParaResposta({
    row, produtoId, empresaId: empresaA.id, db
  });
  assert.strictEqual(r.row.estoque_atual, 16);
  await closeDb(db);
}

async function test10SemEscrita() {
  const { db, produtoId, empresaA, row } = await setup();
  const antesProd = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  const nAntes = await get(db, 'SELECT COUNT(*) AS c FROM estoque_empresa');
  await resolverSaldosProdutoParaResposta({
    row, produtoId, empresaId: empresaA.id, db
  });
  const depoisProd = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  const nDepois = await get(db, 'SELECT COUNT(*) AS c FROM estoque_empresa');
  assert.strictEqual(depoisProd.saldo_fiscal, antesProd.saldo_fiscal);
  assert.strictEqual(depoisProd.estoque_atual, 140);
  assert.strictEqual(nDepois.c, nAntes.c);

  const produtos = fs.readFileSync(path.join(ROOT, 'backend/rotas/produtos.js'), 'utf8');
  assert.ok(produtos.includes('resolverSaldosProdutoParaResposta'));
  assert.ok(produtos.includes("router.get('/:id'"));
  assert.ok(!produtos.includes('consultarSaldoParaEmpresa'));
  const porta = fs.readFileSync(
    path.join(ROOT, 'backend/services/fiscalNaoFiscal/estoqueSaldosPublico.js'),
    'utf8'
  );
  assert.ok(porta.includes('consultarSaldoParaEmpresa'));
  const pdv = fs.readFileSync(
    path.join(ROOT, 'backend/services/estoque/EstoqueReservaService.js'),
    'utf8'
  );
  assert.ok(!pdv.includes('consultarSaldoParaEmpresa'));
  await closeDb(db);
}

async function main() {
  const testes = [
    ['01 sem empresa mantem legado', test01SemEmpresaLegado],
    ['02 com empresaId le estoque_empresa', test02ComEmpresaLeEstoqueEmpresa],
    ['03 A nao le B', test03IsolamentoAB],
    ['04 inexistente nao cai em produtos', test04InexistenteNaoCaiEmProdutos],
    ['05 legado nao interfere', test05LegadoNaoInterfere],
    ['06 saldo fiscal', test06SaldoFiscal],
    ['07 saldo nao fiscal', test07SaldoNaoFiscal],
    ['08 reservas', test08Reservas],
    ['09 estoque atual isolado', test09EstoqueAtualIsolado],
    ['10 nenhuma escrita', test10SemEscrita]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\nleitura-operacional-empresa: ${ok}/${testes.length} OK`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
