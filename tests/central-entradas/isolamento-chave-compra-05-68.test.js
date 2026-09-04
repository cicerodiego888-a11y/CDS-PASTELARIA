/**
 * Sprint 05.68 — Isolamento da chave de compra na Central (existeCompraComChave).
 * Executar: node tests/central-entradas/isolamento-chave-compra-05-68.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const CentralDfePersistenciaService = require('../../backend/motores/central-entradas/services/CentralDfePersistenciaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');

const EMP_A = 11;
const EMP_B = 22;
const EMP_C = 33;
const CHAVE_X = '11111111111111111111111111111111111111111111';

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

async function criarDb() {
  const db = await new Promise((resolve, reject) => {
    const c = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(c)));
  });
  await garantirSchemaEmpresasAsync(db);
  await run(db, `
    INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES
    (11, '11111111000191', 'Empresa A', 1),
    (22, '22222222000182', 'Empresa B', 1),
    (33, '33333333000173', 'Empresa C', 1)
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

function svc(db, empresaId) {
  return new CentralDfePersistenciaService({ db, empresaId });
}

async function t01() {
  const db = await criarDb();
  await run(db, `INSERT INTO compras (id, fornecedor, chave_acesso, empresa_id, status)
    VALUES (50, 'FORN_A', ?, 11, 'concluida')`, [CHAVE_X]);
  const ok = await svc(db, EMP_A).existeCompraComChave(CHAVE_X, EMP_A);
  assert.strictEqual(ok, true);
  db.close();
  console.log('  T01 Central A + X encontra compra A');
}

async function t02() {
  const db = await criarDb();
  await run(db, `INSERT INTO compras (id, fornecedor, chave_acesso, empresa_id, status)
    VALUES (50, 'FORN_A', ?, 11, 'concluida')`, [CHAVE_X]);
  const ok = await svc(db, EMP_B).existeCompraComChave(CHAVE_X, EMP_B);
  assert.strictEqual(ok, false);
  db.close();
  console.log('  T02 Central B + X não encontra compra A');
}

async function t03() {
  const db = await criarDb();
  await run(db, `INSERT INTO compras (fornecedor, chave_acesso, empresa_id, status) VALUES
    ('FORN_A', ?, 11, 'concluida'), ('FORN_B', ?, 22, 'concluida')`, [CHAVE_X, CHAVE_X]);
  assert.strictEqual(await svc(db).existeCompraComChave(CHAVE_X, EMP_A), true);
  db.close();
  console.log('  T03 A+X e B+X: Central A encontra (boolean true)');
}

async function t04() {
  const db = await criarDb();
  await run(db, `INSERT INTO compras (fornecedor, chave_acesso, empresa_id, status) VALUES
    ('FORN_A', ?, 11, 'concluida'), ('FORN_B', ?, 22, 'concluida')`, [CHAVE_X, CHAVE_X]);
  assert.strictEqual(await svc(db).existeCompraComChave(CHAVE_X, EMP_B), true);
  db.close();
  console.log('  T04 A+X e B+X: Central B encontra (boolean true)');
}

async function t05() {
  const db = await criarDb();
  await run(db, `INSERT INTO compras (fornecedor, chave_acesso, empresa_id, status) VALUES
    ('A', ?, 11, 'concluida'), ('B', ?, 22, 'concluida'), ('C', ?, 33, 'concluida')`,
  [CHAVE_X, CHAVE_X, CHAVE_X]);
  assert.strictEqual(await svc(db, EMP_A).existeCompraComChave(CHAVE_X), true);
  assert.strictEqual(await svc(db, EMP_B).existeCompraComChave(CHAVE_X), true);
  assert.strictEqual(await svc(db, EMP_C).existeCompraComChave(CHAVE_X), true);
  db.close();
  console.log('  T05 alvos A/B/C: cada um encontra só via próprio empresaId (ctor)');
}

async function t06() {
  const db = await criarDb();
  await run(db, `INSERT INTO compras (id, fornecedor, chave_acesso, empresa_id, status)
    VALUES (9, 'LEGADO', ?, NULL, 'concluida')`, [CHAVE_X]);
  assert.strictEqual(await svc(db).existeCompraComChave(CHAVE_X, EMP_A), false);
  db.close();
  console.log('  T06 NULL + X não é compra da A');
}

async function t07() {
  const db = await criarDb();
  await run(db, `INSERT INTO compras (id, fornecedor, chave_acesso, empresa_id, status)
    VALUES (50, 'FORN_A_SECRETO', ?, 11, 'concluida')`, [CHAVE_X]);
  const r = await svc(db).existeCompraComChave(CHAVE_X, EMP_B);
  assert.strictEqual(r, false);
  assert.strictEqual(typeof r, 'boolean');
  db.close();
  console.log('  T07 cruzado retorna false, sem id/fornecedor');
}

function t08sql() {
  const f = src('backend/motores/central-entradas/services/CentralDfePersistenciaService.js');
  const fn = f.slice(f.indexOf('async existeCompraComChave'), f.indexOf('async aplicarEventoDfe'));
  assert.ok(fn.includes('AND empresa_id = ?'));
  assert.ok(!/WHERE chave_acesso = \? LIMIT 1/.test(fn));
  assert.ok(fn.includes('chave_acesso = ? AND empresa_id = ?'));
  assert.ok(f.includes('existeCompraComChave(chave, empresaIdOperacao)'));
  const post = src('backend/rotas/compras.js');
  assert.ok(post.includes('chave_acesso = ? AND empresa_id = ?'));
  console.log('  T08 SQL Central não é mais global; POST 05.67 intacto');
}

async function tSemEmpresa() {
  const db = await criarDb();
  await run(db, `INSERT INTO compras (chave_acesso, empresa_id) VALUES (?, 11)`, [CHAVE_X]);
  assert.strictEqual(await svc(db).existeCompraComChave(CHAVE_X), false);
  db.close();
  console.log('  extra: sem empresaId não consulta global');
}

async function main() {
  console.log('05.68 isolamento chave compra Central');
  t08sql();
  await t01();
  await t02();
  await t03();
  await t04();
  await t05();
  await t06();
  await t07();
  await tSemEmpresa();
  console.log('T01–T08 OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
