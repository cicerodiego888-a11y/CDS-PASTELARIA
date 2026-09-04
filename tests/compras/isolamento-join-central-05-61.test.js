/**
 * Sprint 05.61 — Isolamento do JOIN Central no relatório uso/consumo.
 * READ-ONLY: não atualiza compra nem documento.
 * Executar: node tests/compras/isolamento-join-central-05-61.test.js
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
const PADRAO = 'REVENDA';

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function handlerRelatorio() {
  const rotas = src('backend/rotas/compras.js');
  const i = rotas.indexOf("router.get('/relatorio/uso-consumo'");
  const j = rotas.indexOf("router.get('/politicas-entrada'", i);
  assert.ok(i >= 0 && j > i);
  return rotas.slice(i, j);
}

function sqlRelatorio() {
  return `
    SELECT
      c.*,
      (SELECT COUNT(*) FROM financeiro f
         WHERE f.compra_id = c.id AND f.empresa_id = c.empresa_id) AS total_financeiro,
      (SELECT COUNT(*) FROM financeiro f
         WHERE f.compra_id = c.id AND f.status = 'pendente' AND f.empresa_id = c.empresa_id) AS parcelas_pendentes,
      (SELECT GROUP_CONCAT(f.status || ':' || COALESCE(f.vencimento, ''), '|')
         FROM financeiro f WHERE f.compra_id = c.id AND f.empresa_id = c.empresa_id) AS financeiro_resumo,
      d.id AS central_documento_id,
      d.chave AS central_chave,
      (SELECT usuario_nome FROM auditoria a
         WHERE a.modulo = 'compras' AND a.referencia_tipo = 'compra' AND a.referencia_id = c.id
         AND a.acao IN ('criar_compra', 'criar_uso_consumo', 'criar_nota_fiscal_avulsa')
         AND (
           json_extract(a.detalhes, '$.empresa_id') IS NULL
           OR CAST(json_extract(a.detalhes, '$.empresa_id') AS INTEGER) = c.empresa_id
         )
         ORDER BY a.id DESC LIMIT 1) AS usuario_nome
    FROM compras c
    LEFT JOIN central_entradas_documentos d
           ON d.compra_id = c.id
          AND d.empresa_id = c.empresa_id
    WHERE COALESCE(c.tipo_entrada, '${PADRAO}') = 'USO_CONSUMO' AND c.empresa_id = ?
    ORDER BY COALESCE(c.data_emissao, c.data_entrada, c.data_compra) DESC, c.id DESC
  `;
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

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
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
      data_emissao DATE,
      data_entrada DATE,
      fornecedor TEXT,
      valor_total_nota REAL,
      total REAL,
      status TEXT,
      tipo_entrada TEXT,
      empresa_id INTEGER
    )
  `);
  await run(db, `
    CREATE TABLE financeiro (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      compra_id INTEGER,
      status TEXT,
      vencimento TEXT,
      empresa_id INTEGER
    )
  `);
  await run(db, `
    CREATE TABLE auditoria (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      modulo TEXT,
      acao TEXT,
      referencia_tipo TEXT,
      referencia_id INTEGER,
      usuario_nome TEXT,
      detalhes TEXT
    )
  `);
  await run(db, `
    CREATE TABLE central_entradas_documentos (
      id INTEGER PRIMARY KEY,
      compra_id INTEGER,
      chave TEXT,
      empresa_id INTEGER
    )
  `);
  return db;
}

async function snapshot(db) {
  return {
    compras: await all(db, 'SELECT * FROM compras ORDER BY id'),
    docs: await all(db, 'SELECT * FROM central_entradas_documentos ORDER BY id'),
    empresas: await all(db, 'SELECT id, cnpj FROM empresas ORDER BY id')
  };
}

function igual(a, b) {
  assert.deepStrictEqual(a, b);
}

async function consultar(db, empresaId) {
  return all(db, sqlRelatorio(), [empresaId]);
}

async function t01() {
  const db = await criarDb();
  await run(db, `INSERT INTO compras (id, data_compra, fornecedor, total, status, tipo_entrada, empresa_id)
    VALUES (100, '2026-01-10', 'FORN_A', 50, 'confirmada', 'USO_CONSUMO', 11)`);
  await run(db, `INSERT INTO central_entradas_documentos (id, compra_id, chave, empresa_id)
    VALUES (200, 100, 'CHAVE_A', 11)`);
  await run(db, `INSERT INTO financeiro (compra_id, status, vencimento, empresa_id) VALUES (100, 'pendente', '2026-02-01', 11)`);
  const antes = await snapshot(db);
  const rows = await consultar(db, EMP_A);
  const depois = await snapshot(db);
  igual(antes, depois);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].id, 100);
  assert.strictEqual(rows[0].central_documento_id, 200);
  assert.strictEqual(rows[0].central_chave, 'CHAVE_A');
  assert.strictEqual(Number(rows[0].total_financeiro), 1);
  db.close();
  console.log('  T01 compra A + documento A → documento aparece; financeiro intacto; sem mutação');
}

async function t02() {
  const db = await criarDb();
  await run(db, `INSERT INTO compras (id, data_compra, fornecedor, total, status, tipo_entrada, empresa_id)
    VALUES (100, '2026-01-10', 'FORN_A', 50, 'confirmada', 'USO_CONSUMO', 11)`);
  await run(db, `INSERT INTO central_entradas_documentos (id, compra_id, chave, empresa_id)
    VALUES (200, 100, 'CHAVE_B', 22)`);
  const antes = await snapshot(db);
  const rows = await consultar(db, EMP_A);
  const depois = await snapshot(db);
  igual(antes, depois);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].id, 100);
  assert.strictEqual(rows[0].central_documento_id, null);
  assert.strictEqual(rows[0].central_chave, null);
  db.close();
  console.log('  T02 compra A + documento B → compra aparece, documento B NULL');
}

async function t03() {
  const db = await criarDb();
  await run(db, `INSERT INTO compras (id, data_compra, fornecedor, total, status, tipo_entrada, empresa_id)
    VALUES (101, '2026-01-11', 'FORN_B', 80, 'confirmada', 'USO_CONSUMO', 22)`);
  await run(db, `INSERT INTO central_entradas_documentos (id, compra_id, chave, empresa_id)
    VALUES (201, 101, 'CHAVE_A', 11)`);
  const rows = await consultar(db, EMP_B);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].id, 101);
  assert.strictEqual(rows[0].central_documento_id, null);
  assert.strictEqual(rows[0].central_chave, null);
  db.close();
  console.log('  T03 compra B + documento A → documento A não aparece');
}

async function t04() {
  const db = await criarDb();
  await run(db, `INSERT INTO compras (id, data_compra, fornecedor, total, status, tipo_entrada, empresa_id)
    VALUES (102, '2026-01-12', 'FORN_A', 10, 'confirmada', 'USO_CONSUMO', 11)`);
  const rows = await consultar(db, EMP_A);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].id, 102);
  assert.strictEqual(rows[0].central_documento_id, null);
  db.close();
  console.log('  T04 compra A sem documento → relatório funciona');
}

async function t05() {
  const db = await criarDb();
  await run(db, `INSERT INTO compras (id, data_compra, fornecedor, total, status, tipo_entrada, empresa_id)
    VALUES (100, '2026-01-10', 'FORN_A', 50, 'confirmada', 'USO_CONSUMO', 11)`);
  await run(db, `INSERT INTO central_entradas_documentos (id, compra_id, chave, empresa_id)
    VALUES (200, 100, 'CHAVE_DIVERGENTE', 22)`);
  const rows = await consultar(db, EMP_A);
  assert.strictEqual(rows[0].central_chave, null);
  const doc = await get(db, 'SELECT * FROM central_entradas_documentos WHERE id = 200');
  assert.strictEqual(doc.compra_id, 100);
  assert.strictEqual(doc.empresa_id, EMP_B);
  db.close();
  console.log('  T05 compra_id correto e empresa divergente → JOIN bloqueado; vínculo persistido');
}

async function t06() {
  const db = await criarDb();
  await run(db, `INSERT INTO compras (id, data_compra, fornecedor, total, status, tipo_entrada, empresa_id)
    VALUES (100, '2026-01-10', 'FORN_A', 50, 'confirmada', 'USO_CONSUMO', 11)`);
  await run(db, `INSERT INTO central_entradas_documentos (id, compra_id, chave, empresa_id)
    VALUES (200, 100, 'CHAVE_B', 22)`);
  const rows = await consultar(db, EMP_A);
  assert.ok(!rows.some((r) => r.central_chave === 'CHAVE_B'));
  assert.ok(!rows.some((r) => r.central_documento_id === 200));
  db.close();
  console.log('  T06 contexto A não recebe documento B');
}

async function t07() {
  const db = await criarDb();
  await run(db, `INSERT INTO compras (id, data_compra, fornecedor, total, status, tipo_entrada, empresa_id)
    VALUES (101, '2026-01-11', 'FORN_B', 80, 'confirmada', 'USO_CONSUMO', 22)`);
  await run(db, `INSERT INTO central_entradas_documentos (id, compra_id, chave, empresa_id)
    VALUES (201, 101, 'CHAVE_A', 11)`);
  await run(db, `INSERT INTO central_entradas_documentos (id, compra_id, chave, empresa_id)
    VALUES (202, NULL, 'DOC_ORFAO_A', 11)`);
  const rows = await consultar(db, EMP_B);
  assert.ok(!rows.some((r) => r.central_chave === 'CHAVE_A'));
  assert.ok(!rows.some((r) => r.id == null), 'não vira listagem de documentos');
  assert.strictEqual(rows.length, 1);
  db.close();
  console.log('  T07 contexto B não recebe documento A; órfão compra_id NULL não vira linha');
}

function t08() {
  const h = handlerRelatorio();
  assert.ok(h.includes('AND c.empresa_id = ?'));
  assert.ok(!/COALESCE\s*\(\s*c\.empresa_id\s*,\s*d\.empresa_id/i.test(h));
  assert.ok(!/COALESCE\s*\(\s*d\.empresa_id/i.test(h));
  const join = h.match(/LEFT JOIN central_entradas_documentos[\s\S]*?\$\{where\}/);
  assert.ok(join, 'JOIN localizado no relatório');
  assert.ok(/d\.compra_id\s*=\s*c\.id/.test(join[0]));
  assert.ok(/d\.empresa_id\s*=\s*c\.empresa_id/.test(join[0]));
  assert.ok(/LEFT JOIN/.test(join[0]));
  assert.ok(!/INNER JOIN central_entradas_documentos/.test(h));
  console.log('  T08 SQL: LEFT JOIN com d.compra_id = c.id AND d.empresa_id = c.empresa_id');
}

async function tNullCompra() {
  const db = await criarDb();
  await run(db, `INSERT INTO compras (id, data_compra, fornecedor, total, status, tipo_entrada, empresa_id)
    VALUES (103, '2026-01-13', 'FORN_NULL', 5, 'confirmada', 'USO_CONSUMO', NULL)`);
  await run(db, `INSERT INTO central_entradas_documentos (id, compra_id, chave, empresa_id)
    VALUES (203, 103, 'CHAVE_RESGATE', 11)`);
  const rows = await consultar(db, EMP_A);
  assert.ok(!rows.some((r) => r.id === 103));
  db.close();
  console.log('  extra: compra NULL não é resgatada por documento.empresa_id');
}

async function main() {
  console.log('05.61 isolamento JOIN Central relatório uso/consumo');
  t08();
  await t01();
  await t02();
  await t03();
  await t04();
  await t05();
  await t06();
  await t07();
  await tNullCompra();
  console.log('T01–T08 OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
