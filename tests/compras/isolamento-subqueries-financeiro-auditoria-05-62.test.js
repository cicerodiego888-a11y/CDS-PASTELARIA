/**
 * Sprint 05.62 — Isolamento das subqueries financeiro/auditoria no relatório uso/consumo.
 * READ-ONLY: não atualiza compra, financeiro nem auditoria.
 * Executar: node tests/compras/isolamento-subqueries-financeiro-auditoria-05-62.test.js
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
    financeiro: await all(db, 'SELECT * FROM financeiro ORDER BY id'),
    auditoria: await all(db, 'SELECT * FROM auditoria ORDER BY id'),
    empresas: await all(db, 'SELECT id FROM empresas ORDER BY id')
  };
}

async function seedCompraA(db) {
  await run(db, `INSERT INTO compras (id, data_compra, fornecedor, total, status, tipo_entrada, empresa_id)
    VALUES (100, '2026-01-10', 'FORN_A', 50, 'confirmada', 'USO_CONSUMO', 11)`);
}

async function t01() {
  const db = await criarDb();
  await seedCompraA(db);
  await run(db, `INSERT INTO financeiro (compra_id, status, vencimento, empresa_id)
    VALUES (100, 'pendente', '2026-02-01', 11)`);
  const rows = await all(db, sqlRelatorio(), [EMP_A]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(Number(rows[0].total_financeiro), 1);
  assert.strictEqual(Number(rows[0].parcelas_pendentes), 1);
  assert.ok(String(rows[0].financeiro_resumo).includes('pendente'));
  db.close();
  console.log('  T01 compra A + financeiro A → totais e resumo aparecem');
}

async function t02() {
  const db = await criarDb();
  await seedCompraA(db);
  await run(db, `INSERT INTO financeiro (compra_id, status, vencimento, empresa_id)
    VALUES (100, 'pendente', '2026-02-01', 22)`);
  const antes = await snapshot(db);
  const rows = await all(db, sqlRelatorio(), [EMP_A]);
  const depois = await snapshot(db);
  assert.deepStrictEqual(antes, depois);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(Number(rows[0].total_financeiro), 0);
  assert.strictEqual(Number(rows[0].parcelas_pendentes), 0);
  assert.strictEqual(rows[0].financeiro_resumo, null);
  const fin = await get(db, 'SELECT * FROM financeiro WHERE compra_id = 100');
  assert.strictEqual(fin.empresa_id, EMP_B);
  db.close();
  console.log('  T02 financeiro B no compra_id A → não entra; linha persistida');
}

async function t03() {
  const db = await criarDb();
  await seedCompraA(db);
  await run(db, `INSERT INTO financeiro (compra_id, status, vencimento, empresa_id)
    VALUES (100, 'pendente', '2026-02-01', NULL)`);
  const rows = await all(db, sqlRelatorio(), [EMP_A]);
  assert.strictEqual(Number(rows[0].total_financeiro), 0);
  db.close();
  console.log('  T03 financeiro empresa_id NULL → não resgata ownership');
}

async function t04() {
  const db = await criarDb();
  await seedCompraA(db);
  await run(db, `INSERT INTO auditoria (modulo, acao, referencia_tipo, referencia_id, usuario_nome, detalhes)
    VALUES ('compras', 'criar_uso_consumo', 'compra', 100, 'operador_a', '{}')`);
  const rows = await all(db, sqlRelatorio(), [EMP_A]);
  assert.strictEqual(rows[0].usuario_nome, 'operador_a');
  db.close();
  console.log('  T04 auditoria criar_uso_consumo sem empresa em detalhes → usuário aparece');
}

async function t05() {
  const db = await criarDb();
  await seedCompraA(db);
  await run(db, `INSERT INTO auditoria (modulo, acao, referencia_tipo, referencia_id, usuario_nome, detalhes)
    VALUES ('compras', 'criar_uso_consumo', 'compra', 100, 'operador_a', '{}')`);
  await run(db, `INSERT INTO auditoria (modulo, acao, referencia_tipo, referencia_id, usuario_nome, detalhes)
    VALUES ('compras', 'criar_uso_consumo', 'compra', 100, 'operador_b', '{"empresa_id":22}')`);
  const rows = await all(db, sqlRelatorio(), [EMP_A]);
  assert.strictEqual(rows[0].usuario_nome, 'operador_a');
  assert.notStrictEqual(rows[0].usuario_nome, 'operador_b');
  db.close();
  console.log('  T05 auditoria com detalhes.empresa_id B → ignorada no LIMIT 1');
}

async function t06() {
  const db = await criarDb();
  await seedCompraA(db);
  await run(db, `INSERT INTO financeiro (compra_id, status, vencimento, empresa_id) VALUES (100, 'pago', '2026-01-15', 11)`);
  await run(db, `INSERT INTO financeiro (compra_id, status, vencimento, empresa_id) VALUES (100, 'pendente', '2026-03-01', 22)`);
  const rows = await all(db, sqlRelatorio(), [EMP_A]);
  assert.strictEqual(Number(rows[0].total_financeiro), 1);
  assert.strictEqual(Number(rows[0].parcelas_pendentes), 0);
  db.close();
  console.log('  T06 totais não somam lançamento da empresa B');
}

function t07() {
  const h = handlerRelatorio();
  const matches = h.match(/f\.empresa_id\s*=\s*c\.empresa_id/g) || [];
  assert.strictEqual(matches.length, 3, 'três subqueries financeiro com igualdade empresarial');
  assert.ok(h.includes("json_extract(a.detalhes, '$.empresa_id')"));
  assert.ok(/CAST\(json_extract\(a\.detalhes, '\$\.empresa_id'\) AS INTEGER\) = c\.empresa_id/.test(h));
  assert.ok(/d\.empresa_id\s*=\s*c\.empresa_id/.test(h));
  assert.ok(h.includes('AND c.empresa_id = ?'));
  assert.ok(!/COALESCE\s*\(\s*f\.empresa_id/.test(h));
  assert.ok(!/COALESCE\s*\(\s*c\.empresa_id\s*,\s*f\.empresa_id/.test(h));
  console.log('  T07 SQL: 3× f.empresa_id = c.empresa_id no relatório; auditoria rejeita detalhes divergente; JOIN 05.61 intacto');
}

async function t08() {
  const db = await criarDb();
  await seedCompraA(db);
  await run(db, `INSERT INTO compras (id, data_compra, fornecedor, total, status, tipo_entrada, empresa_id)
    VALUES (101, '2026-01-11', 'FORN_B', 80, 'confirmada', 'USO_CONSUMO', 22)`);
  await run(db, `INSERT INTO financeiro (compra_id, status, vencimento, empresa_id) VALUES (101, 'pendente', '2026-02-01', 22)`);
  await run(db, `INSERT INTO auditoria (modulo, acao, referencia_tipo, referencia_id, usuario_nome, detalhes)
    VALUES ('compras', 'criar_uso_consumo', 'compra', 101, 'operador_b', '{"empresa_id":22}')`);
  const rowsA = await all(db, sqlRelatorio(), [EMP_A]);
  assert.strictEqual(rowsA.length, 1);
  assert.strictEqual(rowsA[0].id, 100);
  assert.strictEqual(Number(rowsA[0].total_financeiro), 0);
  assert.notStrictEqual(rowsA[0].usuario_nome, 'operador_b');
  db.close();
  console.log('  T08 contexto A não recebe financeiro/usuário da compra B');
}

async function main() {
  console.log('05.62 isolamento subqueries financeiro/auditoria');
  t07();
  await t01();
  await t02();
  await t03();
  await t04();
  await t05();
  await t06();
  await t08();
  console.log('T01–T08 OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
