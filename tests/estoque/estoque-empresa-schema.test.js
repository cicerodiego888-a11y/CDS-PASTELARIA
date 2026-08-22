/**
 * Fase 2 / Implementação 03.11 — fundação de schema estoque_empresa.
 * Sem backfill. Sem redirecionar a porta. Storage operacional permanece em produtos.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const {
  garantirSchemaEstoqueEmpresaAsync
} = require('../../backend/services/estoque/estoqueEmpresaSchema');
const {
  garantirSchemaEmpresasAsync
} = require('../../backend/services/empresas/empresasSchema');

const ROOT = path.resolve(__dirname, '../..');
const SRC_SCHEMA = path.join(ROOT, 'backend/services/estoque/estoqueEmpresaSchema.js');
const SRC_DB = path.join(ROOT, 'backend/database.js');
const SRC_PORTA_SALDO = path.join(ROOT, 'backend/services/fiscalNaoFiscal/estoqueSaldosPublico.js');
const SRC_PORTA_RESERVA = path.join(ROOT, 'backend/services/fiscalNaoFiscal/reservasPublico.js');
const SRC_PRODUTOS = path.join(ROOT, 'backend/rotas/produtos.js');
const SRC_REPAIR = path.join(ROOT, 'backend/motores/comercial/ReservaRepairService.js');
const SRC_PONTE = path.join(ROOT, 'backend/services/estoque/pedidoReservaPonteNucleo.js');
const SRC_NFE = path.join(ROOT, 'backend/services/fiscal/estoqueNfeDevolucaoVenda.js');
const SRC_MTS = path.join(ROOT, 'backend/motores/mts/MtsService.js');
const SRC_MUC = path.join(ROOT, 'backend/motores/muc/index.js');

const CAMPOS = [
  'id',
  'produto_id',
  'empresa_id',
  'saldo_fiscal',
  'saldo_nao_fiscal',
  'estoque_atual',
  'reservado_fiscal',
  'reservado_nao_fiscal',
  'created_at',
  'updated_at'
];

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

async function setup() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
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
  await garantirSchemaEstoqueEmpresaAsync(db);
  const empA = await run(db, `INSERT INTO empresas (cnpj, razao_social) VALUES ('11222333000181', 'A')`);
  const empB = await run(db, `INSERT INTO empresas (cnpj, razao_social) VALUES ('04252011000110', 'B')`);
  const prod = await run(
    db,
    `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual)
     VALUES ('P', 10, 4, 14)`
  );
  return { db, empresaA: empA.lastID, empresaB: empB.lastID, produtoId: prod.lastID };
}

async function test01TabelaCriada() {
  const { db } = await setup();
  const row = await get(
    db,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'estoque_empresa'`
  );
  assert.ok(row && row.name === 'estoque_empresa');
  await closeDb(db);
}

async function test02CamposNecessarios() {
  const { db } = await setup();
  const cols = await all(db, `PRAGMA table_info(estoque_empresa)`);
  const nomes = cols.map((c) => c.name);
  for (const campo of CAMPOS) {
    assert.ok(nomes.includes(campo), `falta coluna ${campo}`);
  }
  await closeDb(db);
}

async function test03UniqueProdutoEmpresa() {
  const { db, produtoId, empresaA } = await setup();
  await run(
    db,
    `INSERT INTO estoque_empresa (produto_id, empresa_id, saldo_fiscal)
     VALUES (?, ?, 1)`,
    [produtoId, empresaA]
  );
  let falhou = false;
  try {
    await run(
      db,
      `INSERT INTO estoque_empresa (produto_id, empresa_id, saldo_fiscal)
       VALUES (?, ?, 2)`,
      [produtoId, empresaA]
    );
  } catch (err) {
    falhou = true;
    assert.ok(/UNIQUE/i.test(String(err.message)));
  }
  assert.ok(falhou, 'UNIQUE(produto_id, empresa_id) deveria recusar duplicata');
  await closeDb(db);
}

async function test04MesmoProdutoEmpresasDiferentes() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await run(
    db,
    `INSERT INTO estoque_empresa (produto_id, empresa_id, saldo_fiscal, saldo_nao_fiscal, estoque_atual)
     VALUES (?, ?, 3, 1, 4)`,
    [produtoId, empresaA]
  );
  await run(
    db,
    `INSERT INTO estoque_empresa (produto_id, empresa_id, saldo_fiscal, saldo_nao_fiscal, estoque_atual)
     VALUES (?, ?, 8, 2, 10)`,
    [produtoId, empresaB]
  );
  const rows = await all(db, `SELECT * FROM estoque_empresa WHERE produto_id = ? ORDER BY empresa_id`, [produtoId]);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].saldo_fiscal, 3);
  assert.strictEqual(rows[1].saldo_fiscal, 8);
  await closeDb(db);
}

async function test05BootstrapIdempotente() {
  const { db, produtoId, empresaA } = await setup();
  await run(
    db,
    `INSERT INTO estoque_empresa (produto_id, empresa_id, saldo_fiscal) VALUES (?, ?, 5)`,
    [produtoId, empresaA]
  );
  await garantirSchemaEstoqueEmpresaAsync(db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  const tabelas = await all(
    db,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'estoque_empresa'`
  );
  assert.strictEqual(tabelas.length, 1);
  const rows = await all(db, `SELECT * FROM estoque_empresa`);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].saldo_fiscal, 5);
  await closeDb(db);
}

async function test06SaldoProdutosNaoMigrado() {
  const { db, produtoId } = await setup();
  const prod = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.saldo_fiscal, 10);
  assert.strictEqual(prod.saldo_nao_fiscal, 4);
  assert.strictEqual(prod.estoque_atual, 14);
  const n = await get(db, 'SELECT COUNT(*) AS c FROM estoque_empresa');
  assert.strictEqual(n.c, 0);
  const schema = fs.readFileSync(SRC_SCHEMA, 'utf8');
  assert.ok(!/\bINSERT\s+INTO\s+estoque_empresa\b/i.test(schema));
  assert.ok(!/\bUPDATE\s+produtos\b/i.test(schema));
  await closeDb(db);
}

function usaTabelaEstoqueEmpresa(fonte) {
  return /\b(FROM|JOIN|INTO|UPDATE)\s+estoque_empresa\b/i.test(fonte)
    || fonte.includes('estoqueEmpresaSchema');
}

async function test07FluxosOperacionaisIntacto() {
  const portaSaldo = fs.readFileSync(SRC_PORTA_SALDO, 'utf8');
  const portaReserva = fs.readFileSync(SRC_PORTA_RESERVA, 'utf8');
  const produtos = fs.readFileSync(SRC_PRODUTOS, 'utf8');
  const repair = fs.readFileSync(SRC_REPAIR, 'utf8');
  const ponte = fs.readFileSync(SRC_PONTE, 'utf8');
  const nfe = fs.readFileSync(SRC_NFE, 'utf8');
  const mts = fs.readFileSync(SRC_MTS, 'utf8');
  const muc = fs.readFileSync(SRC_MUC, 'utf8');
  const dbjs = fs.readFileSync(SRC_DB, 'utf8');

  assert.ok(portaSaldo.includes('FROM produtos'));
  assert.ok(!/\bFROM\s+estoque_empresa\b/i.test(portaSaldo));
  assert.ok(portaReserva.includes('UPDATE produtos'));
  assert.ok(!usaTabelaEstoqueEmpresa(portaReserva));
  assert.ok(produtos.includes('aplicarSaldoInicialCreateProduto'));
  assert.ok(!usaTabelaEstoqueEmpresa(produtos));
  assert.ok(repair.includes('reservasPublico'));
  assert.ok(!usaTabelaEstoqueEmpresa(repair));
  assert.ok(ponte.includes('liberarQuantidadeReservada'));
  assert.ok(!usaTabelaEstoqueEmpresa(ponte));
  assert.ok(nfe.includes('debitarSaldo'));
  assert.ok(!usaTabelaEstoqueEmpresa(nfe));
  assert.ok(!usaTabelaEstoqueEmpresa(mts));
  assert.ok(!usaTabelaEstoqueEmpresa(muc));
  assert.ok(dbjs.includes('garantirSchemaEstoqueEmpresa'));
  assert.ok(!fs.existsSync(path.join(ROOT, 'backend/services/estoque/EstoqueEmpresaRepository.js')));
  assert.ok(!/\bFROM\s+estoque_empresa\b/i.test(portaSaldo));
  assert.ok(!usaTabelaEstoqueEmpresa(portaReserva));
  assert.ok(!produtos.includes('EstoqueEmpresaService'));
}

async function test08SchemaProdutosCompativel() {
  const { db, produtoId } = await setup();
  const cols = await all(db, 'PRAGMA table_info(produtos)');
  const nomes = cols.map((c) => c.name);
  assert.ok(nomes.includes('saldo_fiscal'));
  assert.ok(nomes.includes('saldo_nao_fiscal'));
  assert.ok(nomes.includes('estoque_atual'));
  assert.ok(nomes.includes('reservado_fiscal'));
  assert.ok(nomes.includes('reservado_nao_fiscal'));
  await run(
    db,
    `UPDATE produtos SET saldo_fiscal = 11, estoque_atual = 15 WHERE id = ?`,
    [produtoId]
  );
  const prod = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.saldo_fiscal, 11);
  assert.strictEqual(prod.estoque_atual, 15);
  const n = await get(db, 'SELECT COUNT(*) AS c FROM estoque_empresa');
  assert.strictEqual(n.c, 0);
  await closeDb(db);
}

async function main() {
  const testes = [
    ['01 tabela e criada', test01TabelaCriada],
    ['02 campos necessarios', test02CamposNecessarios],
    ['03 UNIQUE produto + empresa', test03UniqueProdutoEmpresa],
    ['04 mesmo produto em empresas diferentes', test04MesmoProdutoEmpresasDiferentes],
    ['05 bootstrap idempotente', test05BootstrapIdempotente],
    ['06 saldo de produtos nao migrado', test06SaldoProdutosNaoMigrado],
    ['07 fluxos operacionais intactos', test07FluxosOperacionaisIntacto],
    ['08 schema produtos continua compativel', test08SchemaProdutosCompativel]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\nestoque-empresa-schema: ${ok}/${testes.length} OK`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
