/**
 * Fase 2 / Implementação 03.14 — backfill explícito de estoque_empresa.
 * Uma empresa por vez. Não sobrescreve. Não altera produtos. Não roda no bootstrap.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const {
  executarBackfillEmpresa,
  executarBackfillProduto
} = require('../../backend/services/estoque/EstoqueEmpresaBackfillService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const {
  garantirSchemaEstoqueEmpresaAsync
} = require('../../backend/services/estoque/estoqueEmpresaSchema');
const {
  garantirSchemaEmpresasAsync
} = require('../../backend/services/empresas/empresasSchema');
const saldosPublico = require('../../backend/services/fiscalNaoFiscal/estoqueSaldosPublico');

const ROOT = path.resolve(__dirname, '../..');
const SRC_BACKFILL = path.join(ROOT, 'backend/services/estoque/EstoqueEmpresaBackfillService.js');
const SRC_DB = path.join(ROOT, 'backend/database.js');
const SRC_PORTA = path.join(ROOT, 'backend/services/fiscalNaoFiscal/estoqueSaldosPublico.js');
const SRC_AJUSTE = path.join(ROOT, 'backend/services/ajusteEstoqueService.js');

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
  const p1 = await run(
    db,
    `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual, reservado_fiscal, reservado_nao_fiscal)
     VALUES ('P1', 10, 4, 14, 2, 1)`
  );
  const p2 = await run(
    db,
    `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual, reservado_fiscal, reservado_nao_fiscal)
     VALUES ('P2', 5, 0, 5, 0, 0)`
  );
  return {
    db,
    empresaA: empA.lastID,
    empresaB: empB.lastID,
    produto1: p1.lastID,
    produto2: p2.lastID
  };
}

async function test01EmpresaIdObrigatorio() {
  const { db, produto1 } = await setup();
  await assertRejects(executarBackfillEmpresa({ db }), 'EMPRESA_OBRIGATORIA');
  await assertRejects(executarBackfillProduto({ produtoId: produto1, db }), 'EMPRESA_OBRIGATORIA');
  await closeDb(db);
}

async function test02CriaSnapshotAusente() {
  const { db, empresaA, produto1 } = await setup();
  const antes = await EstoqueEmpresaService.existeRegistro(
    { produtoId: produto1, empresaId: empresaA },
    { db }
  );
  assert.strictEqual(antes, false);
  const r = await executarBackfillProduto({ produtoId: produto1, empresaId: empresaA }, { db });
  assert.strictEqual(r.criado, true);
  const ee = await EstoqueEmpresaService.consultarSaldo(
    { produtoId: produto1, empresaId: empresaA },
    { db }
  );
  assert.ok(ee);
  assert.strictEqual(ee.produto_id, produto1);
  assert.strictEqual(ee.empresa_id, empresaA);
  await closeDb(db);
}

async function test03SaldoFiscalCopiado() {
  const { db, empresaA, produto1 } = await setup();
  await executarBackfillProduto({ produtoId: produto1, empresaId: empresaA }, { db });
  const ee = await EstoqueEmpresaService.consultarSaldo(
    { produtoId: produto1, empresaId: empresaA },
    { db }
  );
  assert.strictEqual(ee.saldo_fiscal, 10);
  await closeDb(db);
}

async function test04SaldoNaoFiscalCopiado() {
  const { db, empresaA, produto1 } = await setup();
  await executarBackfillProduto({ produtoId: produto1, empresaId: empresaA }, { db });
  const ee = await EstoqueEmpresaService.consultarSaldo(
    { produtoId: produto1, empresaId: empresaA },
    { db }
  );
  assert.strictEqual(ee.saldo_nao_fiscal, 4);
  await closeDb(db);
}

async function test05ReservasCopiadas() {
  const { db, empresaA, produto1 } = await setup();
  await executarBackfillProduto({ produtoId: produto1, empresaId: empresaA }, { db });
  const ee = await EstoqueEmpresaService.consultarSaldo(
    { produtoId: produto1, empresaId: empresaA },
    { db }
  );
  assert.strictEqual(ee.reservado_fiscal, 2);
  assert.strictEqual(ee.reservado_nao_fiscal, 1);
  await closeDb(db);
}

async function test06EstoqueAtualDoModelo() {
  const { db, empresaA, produto1 } = await setup();
  await executarBackfillProduto({ produtoId: produto1, empresaId: empresaA }, { db });
  const ee = await EstoqueEmpresaService.consultarSaldo(
    { produtoId: produto1, empresaId: empresaA },
    { db }
  );
  assert.strictEqual(ee.estoque_atual, 14);
  assert.strictEqual(ee.estoque_atual, ee.saldo_fiscal + ee.saldo_nao_fiscal);
  await closeDb(db);
}

async function test07SegundaExecucaoNaoDuplica() {
  const { db, empresaA } = await setup();
  const a = await executarBackfillEmpresa({ empresaId: empresaA }, { db });
  assert.strictEqual(a.criados, 2);
  assert.strictEqual(a.ignorados, 0);
  const b = await executarBackfillEmpresa({ empresaId: empresaA }, { db });
  assert.strictEqual(b.criados, 0);
  assert.strictEqual(b.ignorados, 2);
  const n = await get(db, 'SELECT COUNT(*) AS c FROM estoque_empresa WHERE empresa_id = ?', [empresaA]);
  assert.strictEqual(n.c, 2);
  await closeDb(db);
}

async function test08RegistroExistenteNaoSobrescrito() {
  const { db, empresaA, produto1 } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId: produto1,
    empresaId: empresaA,
    saldo_fiscal: 3,
    saldo_nao_fiscal: 1,
    estoque_atual: 4,
    reservado_fiscal: 0,
    reservado_nao_fiscal: 0
  }, { db });
  await executarBackfillEmpresa({ empresaId: empresaA }, { db });
  const ee = await EstoqueEmpresaService.consultarSaldo(
    { produtoId: produto1, empresaId: empresaA },
    { db }
  );
  assert.strictEqual(ee.saldo_fiscal, 3);
  assert.strictEqual(ee.saldo_nao_fiscal, 1);
  assert.strictEqual(ee.estoque_atual, 4);
  assert.strictEqual(ee.reservado_fiscal, 0);
  await closeDb(db);
}

async function test09EmpresasIndependentes() {
  const { db, empresaA, empresaB, produto1 } = await setup();
  await executarBackfillEmpresa({ empresaId: empresaA }, { db });
  const nB = await get(db, 'SELECT COUNT(*) AS c FROM estoque_empresa WHERE empresa_id = ?', [empresaB]);
  assert.strictEqual(nB.c, 0);
  const eeB = await EstoqueEmpresaService.consultarSaldo(
    { produtoId: produto1, empresaId: empresaB },
    { db }
  );
  assert.strictEqual(eeB, null);

  await executarBackfillEmpresa({ empresaId: empresaB }, { db });
  const a = await EstoqueEmpresaService.consultarSaldo(
    { produtoId: produto1, empresaId: empresaA },
    { db }
  );
  const b = await EstoqueEmpresaService.consultarSaldo(
    { produtoId: produto1, empresaId: empresaB },
    { db }
  );
  assert.strictEqual(a.saldo_fiscal, 10);
  assert.strictEqual(b.saldo_fiscal, 10);
  assert.notStrictEqual(a.id, b.id);
  await closeDb(db);
}

async function test10RollbackExterno() {
  const { db, empresaA } = await setup();
  await run(db, 'BEGIN');
  const r = await executarBackfillEmpresa({ empresaId: empresaA }, { db });
  assert.strictEqual(r.criados, 2);
  const mid = await get(db, 'SELECT COUNT(*) AS c FROM estoque_empresa');
  assert.strictEqual(mid.c, 2);
  await run(db, 'ROLLBACK');
  const depois = await get(db, 'SELECT COUNT(*) AS c FROM estoque_empresa');
  assert.strictEqual(depois.c, 0);
  await closeDb(db);
}

async function test11ProdutosNaoAlterados() {
  const { db, empresaA, produto1 } = await setup();
  const antes = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produto1]);
  await executarBackfillEmpresa({ empresaId: empresaA }, { db });
  const depois = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produto1]);
  assert.strictEqual(depois.saldo_fiscal, antes.saldo_fiscal);
  assert.strictEqual(depois.saldo_nao_fiscal, antes.saldo_nao_fiscal);
  assert.strictEqual(depois.estoque_atual, antes.estoque_atual);
  assert.strictEqual(depois.reservado_fiscal, antes.reservado_fiscal);
  assert.strictEqual(depois.reservado_nao_fiscal, antes.reservado_nao_fiscal);

  const src = fs.readFileSync(SRC_BACKFILL, 'utf8');
  assert.ok(!/\bUPDATE\s+produtos\b/i.test(src));
  assert.ok(!src.includes('modoLegadoSemEmpresa'));
  const dbjs = fs.readFileSync(SRC_DB, 'utf8');
  assert.ok(!dbjs.includes('EstoqueEmpresaBackfillService'));
  assert.ok(!dbjs.includes('executarBackfillEmpresa'));
  await closeDb(db);
}

async function test12PortaContinuaEmProdutos() {
  const { db, empresaA, produto1 } = await setup();
  await executarBackfillEmpresa({ empresaId: empresaA }, { db });
  const publico = await saldosPublico.consultarSaldo(produto1, { db, empresaId: empresaA });
  assert.strictEqual(publico.saldo_fiscal, 10);
  assert.strictEqual(publico.reservado_fiscal, 2);

  const porta = fs.readFileSync(SRC_PORTA, 'utf8');
  const ajuste = fs.readFileSync(SRC_AJUSTE, 'utf8');
  assert.ok(porta.includes('FROM produtos'));
  assert.ok(!/\bFROM\s+estoque_empresa\b/i.test(porta));
  assert.ok(!porta.includes('EstoqueEmpresaBackfillService'));
  assert.ok(porta.includes('consultarSaldoParaEmpresa'));
  assert.ok(ajuste.includes('espelharSaldoInicialEmEstoqueEmpresa'));
  assert.ok(!ajuste.includes('executarBackfillEmpresa'));
  await closeDb(db);
}

async function main() {
  const testes = [
    ['01 empresaId obrigatorio', test01EmpresaIdObrigatorio],
    ['02 produto sem registro cria snapshot', test02CriaSnapshotAusente],
    ['03 saldo fiscal copiado', test03SaldoFiscalCopiado],
    ['04 saldo nao fiscal copiado', test04SaldoNaoFiscalCopiado],
    ['05 reservas copiadas', test05ReservasCopiadas],
    ['06 estoque_atual do modelo real', test06EstoqueAtualDoModelo],
    ['07 segunda execucao nao duplica', test07SegundaExecucaoNaoDuplica],
    ['08 registro existente nao sobrescrito', test08RegistroExistenteNaoSobrescrito],
    ['09 empresas independentes', test09EmpresasIndependentes],
    ['10 rollback externo nao deixa parcial', test10RollbackExterno],
    ['11 produtos nao sao alterados', test11ProdutosNaoAlterados],
    ['12 porta publica continua em produtos', test12PortaContinuaEmProdutos]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\nbackfill-estoque-empresa-03-14: ${ok}/${testes.length} OK`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
