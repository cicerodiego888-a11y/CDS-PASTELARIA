/**
 * Fase 2 / Implementação 03.16 — leitura controlada de estoque_empresa.
 * Camada técnica. Sem fallback. Sem fluxo operacional.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const {
  garantirSchemaEstoqueEmpresaAsync
} = require('../../backend/services/estoque/estoqueEmpresaSchema');
const {
  garantirSchemaEmpresasAsync
} = require('../../backend/services/empresas/empresasSchema');

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
  const emp = await run(db, `INSERT INTO empresas (cnpj, razao_social) VALUES ('11222333000181', 'A')`);
  const prod = await run(
    db,
    `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual, reservado_fiscal)
     VALUES ('X', 99, 50, 149, 7)`
  );
  return { db, empresaId: emp.lastID, produtoId: prod.lastID };
}

async function criarEe(db, produtoId, empresaId) {
  return EstoqueEmpresaService.criarRegistro({
    produtoId,
    empresaId,
    saldo_fiscal: 10,
    saldo_nao_fiscal: 4,
    estoque_atual: 14,
    reservado_fiscal: 2,
    reservado_nao_fiscal: 1
  }, { db });
}

async function test01EmpresaIdObrigatorio() {
  const { db, produtoId } = await setup();
  await assertRejects(
    EstoqueEmpresaService.consultarSaldoParaEmpresa({ produtoId, db }),
    'EMPRESA_OBRIGATORIA'
  );
  await assertRejects(
    EstoqueEmpresaService.consultarSaldoParaEmpresa({ produtoId, empresa_id: 1, db }),
    'EMPRESA_OBRIGATORIA'
  );
  await closeDb(db);
}

async function test02Sf() {
  const { db, produtoId, empresaId } = await setup();
  await criarEe(db, produtoId, empresaId);
  const r = await EstoqueEmpresaService.consultarSaldoParaEmpresa({ produtoId, empresaId, db });
  assert.strictEqual(r.saldoFiscal, 10);
  await closeDb(db);
}

async function test03Snf() {
  const { db, produtoId, empresaId } = await setup();
  await criarEe(db, produtoId, empresaId);
  const r = await EstoqueEmpresaService.consultarSaldoParaEmpresa({ produtoId, empresaId, db });
  assert.strictEqual(r.saldoNaoFiscal, 4);
  await closeDb(db);
}

async function test04Ea() {
  const { db, produtoId, empresaId } = await setup();
  await criarEe(db, produtoId, empresaId);
  const r = await EstoqueEmpresaService.consultarSaldoParaEmpresa({ produtoId, empresaId, db });
  assert.strictEqual(r.estoqueAtual, 14);
  await closeDb(db);
}

async function test05Reservas() {
  const { db, produtoId, empresaId } = await setup();
  await criarEe(db, produtoId, empresaId);
  const r = await EstoqueEmpresaService.consultarSaldoParaEmpresa({ produtoId, empresaId, db });
  assert.strictEqual(r.reservadoFiscal, 2);
  assert.strictEqual(r.reservadoNaoFiscal, 1);
  await closeDb(db);
}

async function test06InexistenteNull() {
  const { db, produtoId, empresaId } = await setup();
  const r = await EstoqueEmpresaService.consultarSaldoParaEmpresa({ produtoId, empresaId, db });
  assert.strictEqual(r, null);
  await closeDb(db);
}

async function test07NaoCria() {
  const { db, produtoId, empresaId } = await setup();
  await EstoqueEmpresaService.consultarSaldoParaEmpresa({ produtoId, empresaId, db });
  const n = await get(db, 'SELECT COUNT(*) AS c FROM estoque_empresa');
  assert.strictEqual(n.c, 0);
  await closeDb(db);
}

async function test08SemFallbackProdutos() {
  const { db, produtoId, empresaId } = await setup();
  const ausente = await EstoqueEmpresaService.consultarSaldoParaEmpresa({ produtoId, empresaId, db });
  assert.strictEqual(ausente, null);

  await criarEe(db, produtoId, empresaId);
  const r = await EstoqueEmpresaService.consultarSaldoParaEmpresa({ produtoId, empresaId, db });
  assert.strictEqual(r.saldoFiscal, 10);
  assert.notStrictEqual(r.saldoFiscal, 99);

  const src = fs.readFileSync(SRC_SERVICE, 'utf8');
  const porta = fs.readFileSync(SRC_PORTA, 'utf8');
  const fn = src.slice(src.indexOf('async function consultarSaldoParaEmpresa'));
  assert.ok(!/\bFROM\s+produtos\b/i.test(fn));
  assert.ok(porta.includes('FROM produtos'));
  assert.ok(porta.includes('consultarSaldoParaEmpresa'));
  await closeDb(db);
}

async function main() {
  const testes = [
    ['01 empresaId obrigatorio', test01EmpresaIdObrigatorio],
    ['02 SF existente', test02Sf],
    ['03 SNF existente', test03Snf],
    ['04 estoque_atual', test04Ea],
    ['05 reservas', test05Reservas],
    ['06 inexistente retorna null', test06InexistenteNull],
    ['07 nao cria registro', test07NaoCria],
    ['08 nao consulta produtos como fallback', test08SemFallbackProdutos]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\nleitura-controlada-estoque-empresa: ${ok}/${testes.length} OK`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
