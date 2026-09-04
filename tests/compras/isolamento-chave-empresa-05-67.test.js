/**
 * Sprint 05.67 — Isolamento da chave de acesso no POST /api/compras.
 * POST /api/compras: chave + empresa (05.67). Central: 05.68.
 * Executar: node tests/compras/isolamento-chave-empresa-05-67.test.js
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
const CHAVE_X = '11111111111111111111111111111111111111111111';
const SQL_DUP = 'SELECT id, status FROM compras WHERE chave_acesso = ? AND empresa_id = ? LIMIT 1';

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function cb(err) {
      if (err) reject(err);
      else resolve(this);
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

function mensagemDuplicidade(existente) {
  return `Esta nota já foi lançada na compra #${existente.id}. Não é permitido lançar a mesma chave de acesso duas vezes.`;
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
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fornecedor TEXT,
      chave_acesso TEXT,
      empresa_id INTEGER,
      status TEXT
    )
  `);
  return db;
}

async function t01() {
  const db = await criarDb();
  const ins = await run(db, `INSERT INTO compras (fornecedor, chave_acesso, empresa_id, status)
    VALUES ('FORN_A', ?, 11, 'concluida')`, [CHAVE_X]);
  const existente = await get(db, SQL_DUP, [CHAVE_X, EMP_A]);
  assert.ok(existente);
  assert.strictEqual(existente.id, ins.lastID);
  db.close();
  console.log('  T01 A + X existente → duplicidade na mesma empresa');
}

async function t02() {
  const db = await criarDb();
  await run(db, `INSERT INTO compras (id, fornecedor, chave_acesso, empresa_id, status)
    VALUES (50, 'FORN_A', ?, 11, 'concluida')`, [CHAVE_X]);
  const existente = await get(db, SQL_DUP, [CHAVE_X, EMP_B]);
  assert.strictEqual(existente, null);
  db.close();
  console.log('  T02 A + X: consulta B não encontra A');
}

async function t03() {
  const db = await criarDb();
  await run(db, `INSERT INTO compras (id, fornecedor, chave_acesso, empresa_id, status)
    VALUES (50, 'FORN_A', ?, 11, 'concluida')`, [CHAVE_X]);
  const dupB = await get(db, SQL_DUP, [CHAVE_X, EMP_B]);
  assert.strictEqual(dupB, null);
  const ins = await run(db, `INSERT INTO compras (fornecedor, chave_acesso, empresa_id, status)
    VALUES ('FORN_B', ?, 22, 'concluida')`, [CHAVE_X]);
  assert.ok(ins.lastID > 0);
  db.close();
  console.log('  T03 INSERT B + X permitido após A + X');
}

async function t04() {
  const db = await criarDb();
  await run(db, `INSERT INTO compras (fornecedor, chave_acesso, empresa_id, status)
    VALUES ('FORN_A', ?, 11, 'concluida'), ('FORN_B', ?, 22, 'concluida')`, [CHAVE_X, CHAVE_X]);
  const rows = await all(db, 'SELECT id, empresa_id FROM compras WHERE chave_acesso = ? ORDER BY empresa_id', [CHAVE_X]);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].empresa_id, EMP_A);
  assert.strictEqual(rows[1].empresa_id, EMP_B);
  db.close();
  console.log('  T04 A+X e B+X coexistem');
}

async function t05() {
  const db = await criarDb();
  await run(db, `INSERT INTO compras (id, fornecedor, chave_acesso, empresa_id, status)
    VALUES (9, 'LEGADO', ?, NULL, 'concluida')`, [CHAVE_X]);
  const existente = await get(db, SQL_DUP, [CHAVE_X, EMP_A]);
  assert.strictEqual(existente, null);
  db.close();
  console.log('  T05 chave X + empresa NULL não é dono de A');
}

async function t06() {
  const db = await criarDb();
  await run(db, `INSERT INTO compras (id, fornecedor, chave_acesso, empresa_id, status)
    VALUES (50, 'FORN_A_SECRETO', ?, 11, 'concluida')`, [CHAVE_X]);
  const existente = await get(db, SQL_DUP, [CHAVE_X, EMP_B]);
  assert.strictEqual(existente, null);
  db.close();
  console.log('  T06 consulta B não devolve linha da compra A');
}

async function t07() {
  const db = await criarDb();
  await run(db, `INSERT INTO compras (id, fornecedor, chave_acesso, empresa_id, status)
    VALUES (50, 'FORN_A_SECRETO', ?, 11, 'concluida')`, [CHAVE_X]);
  const existente = await get(db, SQL_DUP, [CHAVE_X, EMP_B]);
  const msg = existente ? mensagemDuplicidade(existente) : '';
  assert.strictEqual(msg, '');
  assert.ok(!msg.includes('#50'));
  assert.ok(!msg.includes('FORN_A_SECRETO'));
  db.close();
  console.log('  T07 B não recebe mensagem com id/fornecedor da compra A');
}

function t08sqlECentral() {
  const post = src('backend/rotas/compras.js');
  const gravacao = post.slice(post.indexOf('const iniciarGravacaoComEmpresa'), post.indexOf("router.post('/:id/cancelar'"));
  assert.ok(gravacao.includes(SQL_DUP) || gravacao.includes('chave_acesso = ? AND empresa_id = ?'));
  assert.ok(gravacao.includes('empresaIdOperacao') || gravacao.includes('resolvida.empresaId'));
  assert.ok(gravacao.includes('[chaveLimpa, empresaIdOperacao]'));
  assert.ok(!/WHERE chave_acesso = \? LIMIT 1/.test(gravacao));
  const persist = src('backend/motores/central-entradas/services/CentralDfePersistenciaService.js');
  assert.ok(persist.includes('SELECT id FROM compras WHERE chave_acesso = ? AND empresa_id = ? LIMIT 1'));
  assert.ok(persist.includes('async existeCompraComChave(chave, empresaId)'));
  console.log('  T08 POST 05.67 intacto; Central 05.68 filtra empresa_id');
}

async function main() {
  console.log('05.67 isolamento chave empresa POST compras');
  t08sqlECentral();
  await t01();
  await t02();
  await t03();
  await t04();
  await t05();
  await t06();
  await t07();
  console.log('T01–T08 OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
