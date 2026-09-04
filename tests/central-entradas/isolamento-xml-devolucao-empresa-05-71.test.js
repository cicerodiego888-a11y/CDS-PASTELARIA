/**
 * Sprint 05.71 — Isolamento do XML de devolução da Central (chave + empresa_id).
 * Executar: node tests/central-entradas/isolamento-xml-devolucao-empresa-05-71.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const {
  carregarXmlNfeCompraOrigem,
  espelharTributosNfeDevolucaoCompra
} = require('../../backend/services/fiscal/espelharTributosNfeDevolucaoCompra');

const EMP_A = 11;
const EMP_B = 22;
const CHAVE_X = '23260707196033002141550090012840571375100827';
const XML_PAD = (marca) => `<nfe>${marca}${'x'.repeat(120)}</nfe>`;

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

async function openMem() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

async function criarDb() {
  const db = await openMem();
  await run(db, `CREATE TABLE central_entradas_documentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chave TEXT NOT NULL,
    xml TEXT,
    compra_id INTEGER,
    empresa_id INTEGER,
    UNIQUE(chave, empresa_id)
  )`);
  await run(db, `CREATE TABLE notas_recebidas_dfe (chave TEXT, xml TEXT)`);
  await run(db, `CREATE TABLE notas_recebidas (chave TEXT, xml TEXT)`);
  return db;
}

function deps(db) {
  return { dbGet: (sql, params) => get(db, sql, params) };
}

async function seedAB(db) {
  await run(db, `INSERT INTO central_entradas_documentos (id, chave, xml, compra_id, empresa_id)
    VALUES (1, ?, ?, 100, ?)`, [CHAVE_X, XML_PAD('DOC_A'), EMP_A]);
  await run(db, `INSERT INTO central_entradas_documentos (id, chave, xml, compra_id, empresa_id)
    VALUES (2, ?, ?, 200, ?)`, [CHAVE_X, XML_PAD('DOC_B'), EMP_B]);
}

async function t01() {
  const db = await criarDb();
  await seedAB(db);
  const r = await carregarXmlNfeCompraOrigem({ chave: CHAVE_X, empresaId: EMP_A }, deps(db));
  assert.ok(r.xml.includes('DOC_A'));
  assert.strictEqual(r.fonte, 'central_chave');
  db.close();
  console.log('  T01 A + X encontra documento A');
}

async function t02() {
  const db = await criarDb();
  await seedAB(db);
  const r = await carregarXmlNfeCompraOrigem({ chave: CHAVE_X, empresaId: EMP_B }, deps(db));
  assert.ok(r.xml.includes('DOC_B'));
  db.close();
  console.log('  T02 B + X encontra documento B');
}

async function t03() {
  const db = await criarDb();
  await seedAB(db);
  const n = await get(db, 'SELECT COUNT(*) AS n FROM central_entradas_documentos WHERE chave = ?', [CHAVE_X]);
  assert.strictEqual(n.n, 2);
  db.close();
  console.log('  T03 A+X e B+X coexistem');
}

async function t04() {
  const db = await criarDb();
  await seedAB(db);
  const r = await carregarXmlNfeCompraOrigem({ chave: CHAVE_X, empresaId: EMP_B }, deps(db));
  assert.ok(!r.xml.includes('DOC_A'));
  assert.ok(r.xml.includes('DOC_B'));
  db.close();
  console.log('  T04 B nunca retorna documento A');
}

async function t05() {
  const db = await criarDb();
  await seedAB(db);
  const r = await carregarXmlNfeCompraOrigem({ chave: CHAVE_X, empresaId: EMP_A }, deps(db));
  assert.ok(!r.xml.includes('DOC_B'));
  db.close();
  console.log('  T05 A nunca retorna documento B');
}

async function t06() {
  const db = await criarDb();
  await run(db, `INSERT INTO central_entradas_documentos (chave, xml, empresa_id)
    VALUES (?, ?, NULL)`, [CHAVE_X, XML_PAD('NULL_DOC')]);
  const r = await carregarXmlNfeCompraOrigem({ chave: CHAVE_X, empresaId: EMP_A }, deps(db));
  assert.strictEqual(r.xml, null);
  db.close();
  console.log('  T06 NULL não é documento de A');
}

async function t07() {
  const db = await criarDb();
  await seedAB(db);
  const sqls = [];
  const spy = {
    dbGet: async (sql, params) => {
      sqls.push(sql);
      return get(db, sql, params);
    }
  };
  try {
    await carregarXmlNfeCompraOrigem({ chave: CHAVE_X }, spy);
    assert.fail('deveria exigir empresa');
  } catch (err) {
    assert.strictEqual(err.code, 'EMPRESA_OWNERSHIP_REQUIRED');
  }
  assert.strictEqual(sqls.length, 0);
  db.close();
  console.log('  T07 empresa ausente não executa lookup global');
}

async function t08() {
  const db = await criarDb();
  await seedAB(db);
  await carregarXmlNfeCompraOrigem({ chave: CHAVE_X, empresaId: EMP_A }, deps(db));
  const a = await get(db, 'SELECT xml FROM central_entradas_documentos WHERE id = 1');
  const b = await get(db, 'SELECT xml FROM central_entradas_documentos WHERE id = 2');
  assert.ok(a.xml.includes('DOC_A'));
  assert.ok(b.xml.includes('DOC_B'));
  db.close();
  console.log('  T08 leitura A não altera documentos');
}

async function t09() {
  const db = await criarDb();
  await seedAB(db);
  const xmlAAntes = (await get(db, 'SELECT xml FROM central_entradas_documentos WHERE id = 1')).xml;
  await carregarXmlNfeCompraOrigem({ chave: CHAVE_X, empresaId: EMP_B }, deps(db));
  const xmlADepois = (await get(db, 'SELECT xml FROM central_entradas_documentos WHERE id = 1')).xml;
  assert.strictEqual(xmlAAntes, xmlADepois);
  db.close();
  console.log('  T09 fluxo B não faz UPDATE no documento A');
}

async function t10() {
  const db = await criarDb();
  await seedAB(db);
  const r = await carregarXmlNfeCompraOrigem({
    chave: '99999999999999999999999999999999999999999999',
    empresaId: EMP_A
  }, deps(db));
  assert.strictEqual(r.xml, null);
  assert.strictEqual(r.fonte, null);
  db.close();
  console.log('  T10 chave inexistente → não encontrado');
}

function tEstatico() {
  const esp = src('backend/services/fiscal/espelharTributosNfeDevolucaoCompra.js');
  const nfe = src('backend/services/fiscal/nfeDevolucaoCompra.js');
  assert.ok(esp.includes('REPLACE(chave, \' \', \'\') = ? AND empresa_id = ?'));
  assert.ok(esp.includes('EMPRESA_OWNERSHIP_REQUIRED'));
  assert.ok(nfe.includes('empresaId: compra.empresa_id'));
  assert.ok(!/WHERE REPLACE\(chave, ' ', ''\) = \? AND xml IS NOT NULL/.test(esp)
    || esp.includes('AND empresa_id = ?'));
  console.log('  extra: SQL Central com empresa_id; callers passam compra.empresa_id');
}

async function extraEspelharSemEmpresa() {
  const r = await espelharTributosNfeDevolucaoCompra({
    chave: CHAVE_X,
    itens: [],
    exigirXml: false
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.erro.code, 'EMPRESA_OWNERSHIP_REQUIRED');
  console.log('  extra: espelhar sem empresa não consulta (exigirXml false)');
}

async function main() {
  console.log('05.71 isolamento XML devolução empresa');
  await t01();
  await t02();
  await t03();
  await t04();
  await t05();
  await t06();
  await t07();
  await t08();
  await t09();
  await t10();
  tEstatico();
  await extraEspelharSemEmpresa();
  console.log('T01–T10 OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
