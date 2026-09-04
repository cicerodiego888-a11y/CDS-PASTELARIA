/**
 * Sprint 05.64 — Isolamento financeiro em GET /compras e GET /compras/:id.
 * READ-ONLY: não atualiza compra nem financeiro.
 * Executar: node tests/compras/isolamento-financeiro-leituras-compras-05-64.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');

const EMP_A = 11;
const EMP_B = 22;

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function handlerLista() {
  const t = src('backend/rotas/compras.js');
  const i = t.indexOf("router.get('/',");
  const j = t.indexOf("router.get('/:id'", i);
  return t.slice(i, j);
}

function handlerDetalhe() {
  const t = src('backend/rotas/compras.js');
  const i = t.indexOf("router.get('/:id'");
  const j = t.indexOf("router.post('/',", i);
  return t.slice(i, j);
}

function handlerRelatorio() {
  const t = src('backend/rotas/compras.js');
  const i = t.indexOf("router.get('/relatorio/uso-consumo'");
  const j = t.indexOf("router.get('/politicas-entrada'", i);
  return t.slice(i, j);
}

function sqlLista() {
  return `
    SELECT c.*,
      (SELECT COUNT(*) FROM financeiro f
        WHERE f.compra_id = c.id AND f.status = 'pendente' AND f.empresa_id = c.empresa_id) as parcelas_pendentes
    FROM compras c
    WHERE c.empresa_id = ?
    ORDER BY c.data_compra DESC, c.id DESC
  `;
}

function sqlDetalhe(compraId, empresaId) {
  return {
    sql: 'SELECT * FROM financeiro WHERE compra_id = ? AND empresa_id = ? ORDER BY numero_parcela, vencimento',
    params: [compraId, empresaId]
  };
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function cb(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

async function criarDb() {
  const db = await new Promise((resolve, reject) => {
    const c = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(c)));
  });
  await garantirSchemaEmpresasAsync(db);
  await run(db, `
    INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES
    (11, '11111111000191', 'Empresa A', 1),
    (22, '22222222000182', 'Empresa B', 1)
  `);
  await run(db, `
    CREATE TABLE compras (
      id INTEGER PRIMARY KEY,
      data_compra DATE,
      fornecedor TEXT,
      total REAL,
      empresa_id INTEGER
    )
  `);
  await run(db, `
    CREATE TABLE financeiro (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      compra_id INTEGER,
      status TEXT,
      vencimento TEXT,
      numero_parcela INTEGER,
      valor REAL,
      pessoa_nome TEXT,
      empresa_id INTEGER
    )
  `);
  return db;
}

async function snapshot(db) {
  return {
    compras: await all(db, 'SELECT * FROM compras ORDER BY id'),
    financeiro: await all(db, 'SELECT * FROM financeiro ORDER BY id')
  };
}

async function seedMisto(db) {
  await run(db, `INSERT INTO compras (id, data_compra, fornecedor, total, empresa_id)
    VALUES (100, '2026-01-10', 'FORN_A', 50, 11)`);
  await run(db, `INSERT INTO financeiro (compra_id, status, vencimento, numero_parcela, valor, pessoa_nome, empresa_id)
    VALUES
    (100, 'pendente', '2026-02-01', 1, 50, 'FORN_A', 11),
    (100, 'pendente', '2026-03-01', 2, 999, 'FORN_B_VAZADO', 22),
    (100, 'pendente', '2026-04-01', 3, 1, 'LEGADO_NULL', NULL)`);
}

async function t01() {
  const db = await criarDb();
  await seedMisto(db);
  const rows = await all(db, sqlLista(), [EMP_A]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(Number(rows[0].parcelas_pendentes), 1);
  db.close();
  console.log('  T01 GET / compra A: parcelas_pendentes só do financeiro A');
}

async function t02() {
  const db = await criarDb();
  await seedMisto(db);
  const antes = await snapshot(db);
  const q = sqlDetalhe(100, EMP_A);
  const fins = await all(db, q.sql, q.params);
  const depois = await snapshot(db);
  assert.deepStrictEqual(antes, depois);
  assert.strictEqual(fins.length, 1);
  assert.strictEqual(fins[0].pessoa_nome, 'FORN_A');
  assert.ok(!fins.some((f) => f.pessoa_nome === 'FORN_B_VAZADO'));
  db.close();
  console.log('  T02 GET /:id: só linha A; B não aparece; sem mutação');
}

async function t03() {
  const db = await criarDb();
  await seedMisto(db);
  const q = sqlDetalhe(100, EMP_A);
  const fins = await all(db, q.sql, q.params);
  assert.ok(!fins.some((f) => f.empresa_id === EMP_B));
  assert.ok(!fins.some((f) => Number(f.valor) === 999));
  db.close();
  console.log('  T03 detalhe não vaza valor/nome da empresa B');
}

async function t04() {
  const db = await criarDb();
  await seedMisto(db);
  const q = sqlDetalhe(100, EMP_A);
  const fins = await all(db, q.sql, q.params);
  assert.ok(!fins.some((f) => f.empresa_id == null));
  const rows = await all(db, sqlLista(), [EMP_A]);
  assert.strictEqual(Number(rows[0].parcelas_pendentes), 1);
  db.close();
  console.log('  T04 financeiro NULL não resgata e não entra');
}

async function t05() {
  const db = await criarDb();
  await run(db, `INSERT INTO compras (id, data_compra, fornecedor, total, empresa_id)
    VALUES (100, '2026-01-10', 'FORN_A', 50, 11)`);
  await run(db, `INSERT INTO financeiro (compra_id, status, vencimento, numero_parcela, valor, pessoa_nome, empresa_id)
    VALUES (100, 'pendente', '2026-02-01', 1, 50, 'FORN_A', 11)`);
  const rows = await all(db, sqlLista(), [EMP_A]);
  const q = sqlDetalhe(100, EMP_A);
  const fins = await all(db, q.sql, q.params);
  assert.strictEqual(Number(rows[0].parcelas_pendentes), 1);
  assert.strictEqual(fins.length, 1);
  db.close();
  console.log('  T05 fluxo legítimo A+A continua funcionando');
}

async function t06() {
  const db = await criarDb();
  await seedMisto(db);
  const listaB = await all(db, sqlLista(), [EMP_B]);
  assert.strictEqual(listaB.length, 0);
  db.close();
  console.log('  T06 contexto B não lista compra A');
}

function t07() {
  const lista = handlerLista();
  const det = handlerDetalhe();
  assert.ok(/f\.compra_id = c\.id AND f\.status = 'pendente' AND f\.empresa_id = c\.empresa_id/.test(lista));
  assert.ok(lista.includes('WHERE c.empresa_id = ?'));
  assert.ok(!/COALESCE\s*\(\s*f\.empresa_id/.test(lista));
  assert.ok(!/COALESCE\s*\(\s*c\.empresa_id\s*,\s*ctx/.test(det));
  assert.ok(det.includes('SELECT * FROM financeiro WHERE compra_id = ? AND empresa_id = ?'));
  assert.ok(det.includes('[id, compra.empresa_id]'));
  assert.ok(!det.includes('[id, ctxEmp.empresaId]'));
  console.log('  T07 SQL: lista usa c.empresa_id; detalhe usa compra.empresa_id persistido');
}

function t08() {
  const n = (handlerRelatorio().match(/f\.empresa_id\s*=\s*c\.empresa_id/g) || []).length;
  assert.strictEqual(n, 3, 'relatório 05.62 intacto');
  assert.ok(!handlerRelatorio().includes('router.get(\'/\''));
  console.log('  T08 relatório uso/consumo 05.62 inalterado (3 subqueries)');
}

async function main() {
  console.log('05.64 isolamento financeiro leituras compras');
  t07();
  t08();
  await t01();
  await t02();
  await t03();
  await t04();
  await t05();
  await t06();
  console.log('T01–T08 OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
