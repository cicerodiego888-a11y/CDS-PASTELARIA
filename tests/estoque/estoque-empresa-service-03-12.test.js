/**
 * Fase 2 / Implementação 03.12 — camada isolada de acesso a estoque_empresa.
 * Sem backfill. Sem fallback para produtos. Sem redirecionar a porta pública.
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
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const saldosPublico = require('../../backend/services/fiscalNaoFiscal/estoqueSaldosPublico');

const ROOT = path.resolve(__dirname, '../..');
const SRC_SERVICE = path.join(ROOT, 'backend/services/estoque/EstoqueEmpresaService.js');
const SRC_PORTA = path.join(ROOT, 'backend/services/fiscalNaoFiscal/estoqueSaldosPublico.js');

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

async function assertRejects(promise, code) {
  try {
    await promise;
    throw new Error(`Esperava erro ${code}, mas resolveu`);
  } catch (err) {
    if (err.message && err.message.startsWith('Esperava erro')) throw err;
    assert.strictEqual(err.code, code, `código esperado ${code}, veio ${err.code}: ${err.message}`);
  }
}

async function setup(extraProduto = {}) {
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
  const sf = extraProduto.saldo_fiscal != null ? extraProduto.saldo_fiscal : 10;
  const snf = extraProduto.saldo_nao_fiscal != null ? extraProduto.saldo_nao_fiscal : 4;
  const prod = await run(
    db,
    `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual)
     VALUES ('P', ?, ?, ?)`,
    [sf, snf, sf + snf]
  );
  return { db, empresaA: empA.lastID, empresaB: empB.lastID, produtoId: prod.lastID };
}

async function test01SchemaDisponivel() {
  const { db } = await setup();
  const row = await get(
    db,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'estoque_empresa'`
  );
  assert.ok(row && row.name === 'estoque_empresa');
  await closeDb(db);
}

async function test02ConsultaExigeEmpresaId() {
  const { db, produtoId } = await setup();
  await assertRejects(
    EstoqueEmpresaService.consultarSaldo({ produtoId }, { db }),
    'EMPRESA_OBRIGATORIA'
  );
  await assertRejects(
    EstoqueEmpresaService.criarRegistro({ produtoId }, { db }),
    'EMPRESA_OBRIGATORIA'
  );
  await closeDb(db);
}

async function test03ConsultaSemRegistro() {
  const { db, produtoId, empresaA } = await setup();
  const registro = await EstoqueEmpresaService.consultarSaldo(
    { produtoId, empresaId: empresaA },
    { db }
  );
  assert.strictEqual(registro, null);
  const existe = await EstoqueEmpresaService.existeRegistro(
    { produtoId, empresaId: empresaA },
    { db }
  );
  assert.strictEqual(existe, false);
  const prod = await get(db, 'SELECT saldo_fiscal FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.saldo_fiscal, 10);
  await closeDb(db);
}

async function test04CriarRegistroExplicitamente() {
  const { db, produtoId, empresaA } = await setup();
  const criado = await EstoqueEmpresaService.criarRegistro(
    { produtoId, empresaId: empresaA },
    { db }
  );
  assert.ok(criado && criado.id > 0);
  assert.strictEqual(criado.produto_id, produtoId);
  assert.strictEqual(criado.empresa_id, empresaA);
  assert.strictEqual(criado.saldo_fiscal, 0);
  assert.strictEqual(criado.saldo_nao_fiscal, 0);
  assert.strictEqual(criado.estoque_atual, 0);
  const prod = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.saldo_fiscal, 10);
  assert.strictEqual(prod.estoque_atual, 14);
  await closeDb(db);
}

async function test05NaoDuplicarProdutoEmpresa() {
  const { db, produtoId, empresaA } = await setup();
  await EstoqueEmpresaService.criarRegistro({ produtoId, empresaId: empresaA }, { db });
  await assertRejects(
    EstoqueEmpresaService.criarRegistro({ produtoId, empresaId: empresaA }, { db }),
    'ESTOQUE_EMPRESA_DUPLICADO'
  );
  const n = await get(db, 'SELECT COUNT(*) AS c FROM estoque_empresa');
  assert.strictEqual(n.c, 1);
  await closeDb(db);
}

async function test06EmpresasIndependentes() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  const a = await EstoqueEmpresaService.criarRegistro(
    { produtoId, empresaId: empresaA, saldo_fiscal: 3, saldo_nao_fiscal: 1 },
    { db }
  );
  const b = await EstoqueEmpresaService.criarRegistro(
    { produtoId, empresaId: empresaB, saldo_fiscal: 8, saldo_nao_fiscal: 2 },
    { db }
  );
  assert.strictEqual(a.saldo_fiscal, 3);
  assert.strictEqual(a.estoque_atual, 4);
  assert.strictEqual(b.saldo_fiscal, 8);
  assert.strictEqual(b.estoque_atual, 10);
  const novamenteA = await EstoqueEmpresaService.consultarSaldo(
    { produtoId, empresaId: empresaA },
    { db }
  );
  assert.strictEqual(novamenteA.saldo_fiscal, 3);
  const prod = await get(db, 'SELECT saldo_fiscal FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.saldo_fiscal, 10);
  await closeDb(db);
}

async function test07DbInjetavel() {
  const a = await setup();
  const b = await setup();
  await EstoqueEmpresaService.criarRegistro(
    { produtoId: a.produtoId, empresaId: a.empresaA },
    { db: a.db }
  );
  const noA = await EstoqueEmpresaService.consultarSaldo(
    { produtoId: a.produtoId, empresaId: a.empresaA },
    { db: a.db }
  );
  const noB = await EstoqueEmpresaService.consultarSaldo(
    { produtoId: b.produtoId, empresaId: b.empresaA },
    { db: b.db }
  );
  assert.ok(noA && noA.id > 0);
  assert.strictEqual(noB, null);
  await closeDb(a.db);
  await closeDb(b.db);
}

async function test08ConsultaNaoCriaRegistro() {
  const { db, produtoId, empresaA } = await setup();
  await EstoqueEmpresaService.consultarSaldo({ produtoId, empresaId: empresaA }, { db });
  await EstoqueEmpresaService.existeRegistro({ produtoId, empresaId: empresaA }, { db });
  const n = await get(db, 'SELECT COUNT(*) AS c FROM estoque_empresa');
  assert.strictEqual(n.c, 0);

  const porta = fs.readFileSync(SRC_PORTA, 'utf8');
  const service = fs.readFileSync(SRC_SERVICE, 'utf8');
  assert.ok(porta.includes('FROM produtos'));
  assert.ok(!/\b(FROM|JOIN|INTO|UPDATE)\s+estoque_empresa\b/i.test(porta));
  assert.ok(!service.includes('modoLegadoSemEmpresa'));
  assert.ok(!service.includes('COMPAT_CERTIFICADA'));
  assert.ok(!/\bFROM\s+produtos\b[\s\S]{0,80}saldo_fiscal/i.test(service));

  const publico = await saldosPublico.consultarSaldo(produtoId, {
    db,
    empresaId: empresaA
  });
  assert.strictEqual(publico.saldo_fiscal, 0);
  await closeDb(db);
}

async function main() {
  const testes = [
    ['01 schema disponivel', test01SchemaDisponivel],
    ['02 consulta exige empresaId', test02ConsultaExigeEmpresaId],
    ['03 consulta sem registro', test03ConsultaSemRegistro],
    ['04 criar registro explicitamente', test04CriarRegistroExplicitamente],
    ['05 nao duplicar produto + empresa', test05NaoDuplicarProdutoEmpresa],
    ['06 empresas diferentes independentes', test06EmpresasIndependentes],
    ['07 db injetavel', test07DbInjetavel],
    ['08 consulta nao cria registro', test08ConsultaNaoCriaRegistro]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\nestoque-empresa-service-03-12: ${ok}/${testes.length} OK`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
