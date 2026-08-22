/**
 * Fase 2 / Implementação 03.22 — listagem GET /api/produtos com estoque_empresa.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const { fragmentoEstoqueEmpresaListagem } = require('../../backend/services/estoque/leituraEstoqueEmpresaProduto');
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

function sqlListagem(empresaId, { modoFiscal = false } = {}) {
  const ee = fragmentoEstoqueEmpresaListagem(empresaId);
  const filtroFiscal = modoFiscal ? ' AND COALESCE(p.item_fiscal, 1) = 1' : '';
  const sql = `
    SELECT
      p.id,
      p.nome,
      p.item_fiscal,
      p.saldo_fiscal AS legado_sf
      ${ee.extraSelect}
    FROM produtos p
    ${ee.joinSql}
    WHERE 1=1
      ${filtroFiscal}
    ORDER BY p.id DESC
  `;
  return { sql, params: ee.params, isolado: ee.isolado };
}

async function listar(db, empresaId, opts) {
  const q = sqlListagem(empresaId, opts);
  return all(db, q.sql, q.params);
}

async function setup() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  await run(db, `
    CREATE TABLE produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT,
      item_fiscal INTEGER DEFAULT 1,
      saldo_fiscal REAL DEFAULT 0,
      saldo_nao_fiscal REAL DEFAULT 0,
      estoque_atual REAL DEFAULT 0,
      reservado_fiscal REAL DEFAULT 0,
      reservado_nao_fiscal REAL DEFAULT 0
    )
  `);
  const x = await run(
    db,
    `INSERT INTO produtos (nome, item_fiscal, saldo_fiscal, saldo_nao_fiscal, estoque_atual, reservado_fiscal, reservado_nao_fiscal)
     VALUES ('X', 1, 100, 40, 140, 7, 3)`
  );
  const y = await run(
    db,
    `INSERT INTO produtos (nome, item_fiscal, saldo_fiscal, saldo_nao_fiscal, estoque_atual)
     VALUES ('Y', 0, 50, 10, 60)`
  );
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const b = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  return { db, produtoX: x.lastID, produtoY: y.lastID, empresaA: a, empresaB: b };
}

async function test01SemEmpresaLegado() {
  const { db, produtoX } = await setup();
  const rows = await listar(db, null);
  const x = rows.find((r) => r.id === produtoX);
  assert.strictEqual(x.legado_sf, 100);
  assert.strictEqual(x.saldo_fiscal, undefined);
  await closeDb(db);
}

async function test02ComEmpresaUsaEe() {
  const { db, produtoX, empresaA } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId: produtoX,
    empresaId: empresaA.id,
    saldo_fiscal: 10,
    saldo_nao_fiscal: 2,
    estoque_atual: 12,
    reservado_fiscal: 1,
    reservado_nao_fiscal: 0
  }, { db });
  const rows = await listar(db, empresaA.id);
  const x = rows.find((r) => r.id === produtoX);
  assert.strictEqual(x.saldo_fiscal, 10);
  assert.notStrictEqual(x.saldo_fiscal, 100);
  await closeDb(db);
}

async function test03SemRegistroZeros() {
  const { db, produtoX, empresaA } = await setup();
  const rows = await listar(db, empresaA.id);
  const x = rows.find((r) => r.id === produtoX);
  assert.strictEqual(x.saldo_fiscal, 0);
  assert.strictEqual(x.saldo_nao_fiscal, 0);
  assert.strictEqual(x.estoque_atual, 0);
  assert.strictEqual(x.reservado_fiscal, 0);
  assert.strictEqual(x.reservado_nao_fiscal, 0);
  await closeDb(db);
}

async function test04NaoCopiaLegado() {
  const { db, produtoX, empresaA } = await setup();
  const rows = await listar(db, empresaA.id);
  const x = rows.find((r) => r.id === produtoX);
  assert.strictEqual(x.legado_sf, 100);
  assert.strictEqual(x.estoque_atual, 0);
  await closeDb(db);
}

async function test05EmpresaAProprio() {
  const { db, produtoX, empresaA, empresaB } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId: produtoX, empresaId: empresaA.id, saldo_fiscal: 10, estoque_atual: 10
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: produtoX, empresaId: empresaB.id, saldo_fiscal: 25, estoque_atual: 25
  }, { db });
  const rows = await listar(db, empresaA.id);
  assert.strictEqual(rows.find((r) => r.id === produtoX).estoque_atual, 10);
  await closeDb(db);
}

async function test06EmpresaBProprio() {
  const { db, produtoX, empresaA, empresaB } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId: produtoX, empresaId: empresaA.id, saldo_fiscal: 10, estoque_atual: 10
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: produtoX, empresaId: empresaB.id, saldo_fiscal: 25, estoque_atual: 25
  }, { db });
  const rows = await listar(db, empresaB.id);
  assert.strictEqual(rows.find((r) => r.id === produtoX).estoque_atual, 25);
  await closeDb(db);
}

async function test07ANaoVeB() {
  const { db, produtoX, empresaA, empresaB } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId: produtoX, empresaId: empresaA.id, saldo_fiscal: 10, estoque_atual: 10
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: produtoX, empresaId: empresaB.id, saldo_fiscal: 25, estoque_atual: 25
  }, { db });
  const a = (await listar(db, empresaA.id)).find((r) => r.id === produtoX);
  assert.notStrictEqual(a.estoque_atual, 25);
  assert.strictEqual(a.saldo_fiscal, 10);
  await closeDb(db);
}

async function test08Sf() {
  const { db, produtoX, empresaA } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId: produtoX, empresaId: empresaA.id, saldo_fiscal: 10, saldo_nao_fiscal: 2, estoque_atual: 12
  }, { db });
  const x = (await listar(db, empresaA.id)).find((r) => r.id === produtoX);
  assert.strictEqual(x.saldo_fiscal, 10);
  await closeDb(db);
}

async function test09Snf() {
  const { db, produtoX, empresaA } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId: produtoX, empresaId: empresaA.id, saldo_fiscal: 10, saldo_nao_fiscal: 2, estoque_atual: 12
  }, { db });
  const x = (await listar(db, empresaA.id)).find((r) => r.id === produtoX);
  assert.strictEqual(x.saldo_nao_fiscal, 2);
  await closeDb(db);
}

async function test10Ea() {
  const { db, produtoX, empresaA } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId: produtoX, empresaId: empresaA.id, saldo_fiscal: 10, saldo_nao_fiscal: 2, estoque_atual: 12
  }, { db });
  const x = (await listar(db, empresaA.id)).find((r) => r.id === produtoX);
  assert.strictEqual(x.estoque_atual, 12);
  await closeDb(db);
}

async function test11Rf() {
  const { db, produtoX, empresaA } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId: produtoX,
    empresaId: empresaA.id,
    saldo_fiscal: 10,
    estoque_atual: 10,
    reservado_fiscal: 4,
    reservado_nao_fiscal: 1
  }, { db });
  const x = (await listar(db, empresaA.id)).find((r) => r.id === produtoX);
  assert.strictEqual(x.reservado_fiscal, 4);
  await closeDb(db);
}

async function test12Rnf() {
  const { db, produtoX, empresaA } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId: produtoX,
    empresaId: empresaA.id,
    saldo_fiscal: 10,
    estoque_atual: 10,
    reservado_fiscal: 4,
    reservado_nao_fiscal: 1
  }, { db });
  const x = (await listar(db, empresaA.id)).find((r) => r.id === produtoX);
  assert.strictEqual(x.reservado_nao_fiscal, 1);
  await closeDb(db);
}

async function test13FiltroFiscal() {
  const { db, produtoX, produtoY, empresaA } = await setup();
  const todos = await listar(db, empresaA.id);
  assert.ok(todos.some((r) => r.id === produtoX));
  assert.ok(todos.some((r) => r.id === produtoY));
  const fiscais = await listar(db, empresaA.id, { modoFiscal: true });
  assert.ok(fiscais.some((r) => r.id === produtoX));
  assert.ok(!fiscais.some((r) => r.id === produtoY));
  await closeDb(db);
}

async function test14OrdemListagem() {
  const { db, produtoX, produtoY } = await setup();
  const rows = await listar(db, null);
  assert.ok(rows.length >= 2);
  assert.strictEqual(rows[0].id, produtoY);
  assert.strictEqual(rows[1].id, produtoX);
  const src = fs.readFileSync(path.join(ROOT, 'backend/rotas/produtos.js'), 'utf8');
  const idx = src.indexOf("router.get('/',");
  const trecho = src.slice(idx, idx + 1800);
  assert.ok(trecho.includes('ORDER BY p.id DESC'));
  assert.ok(trecho.includes('fragmentoEstoqueEmpresaListagem(req.empresaId)'));
  assert.ok(trecho.includes('filtroFiscal'));
  await closeDb(db);
}

async function test15SemEscrita() {
  const { db, produtoX, empresaA } = await setup();
  const antes = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoX]);
  const nAntes = await get(db, 'SELECT COUNT(*) AS c FROM estoque_empresa');
  await listar(db, empresaA.id);
  const depois = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoX]);
  const nDepois = await get(db, 'SELECT COUNT(*) AS c FROM estoque_empresa');
  assert.strictEqual(depois.saldo_fiscal, antes.saldo_fiscal);
  assert.strictEqual(depois.estoque_atual, 140);
  assert.strictEqual(nDepois.c, nAntes.c);

  const helper = fs.readFileSync(
    path.join(ROOT, 'backend/services/estoque/leituraEstoqueEmpresaProduto.js'),
    'utf8'
  );
  assert.ok(helper.includes('LEFT JOIN estoque_empresa'));
  assert.ok(!/INSERT\s+INTO\s+estoque_empresa/i.test(helper.split('function fragmentoEstoqueEmpresaListagem')[1] || ''));
  const getId = fs.readFileSync(path.join(ROOT, 'backend/rotas/produtos.js'), 'utf8');
  assert.ok(getId.includes('resolverSaldosProdutoParaResposta'));
  const pdv = fs.readFileSync(path.join(ROOT, 'backend/services/estoque/EstoqueReservaService.js'), 'utf8');
  assert.ok(!pdv.includes('fragmentoEstoqueEmpresaListagem'));
  await closeDb(db);
}

async function main() {
  const testes = [
    ['01 sem empresa legado', test01SemEmpresaLegado],
    ['02 com empresa usa estoque_empresa', test02ComEmpresaUsaEe],
    ['03 sem registro zeros', test03SemRegistroZeros],
    ['04 nao copia legado', test04NaoCopiaLegado],
    ['05 empresa A proprio saldo', test05EmpresaAProprio],
    ['06 empresa B proprio saldo', test06EmpresaBProprio],
    ['07 A nao ve B', test07ANaoVeB],
    ['08 SF isolado', test08Sf],
    ['09 SNF isolado', test09Snf],
    ['10 EA isolado', test10Ea],
    ['11 RF isolado', test11Rf],
    ['12 RNF isolado', test12Rnf],
    ['13 filtro modo_fiscal', test13FiltroFiscal],
    ['14 ordem listagem', test14OrdemListagem],
    ['15 sem escrita', test15SemEscrita]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\nlistagem-produtos-empresa: ${ok}/${testes.length} OK`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
