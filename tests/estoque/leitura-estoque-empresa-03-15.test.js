/**
 * Fase 2 / Implementação 03.15 — leitura técnica isolada de estoque_empresa.
 * Sem fallback para produtos. Sem criar. Sem COMPAT. Porta pública intacta.
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
const saldosPublico = require('../../backend/services/fiscalNaoFiscal/estoqueSaldosPublico');

const ROOT = path.resolve(__dirname, '../..');
const SRC_SERVICE = path.join(ROOT, 'backend/services/estoque/EstoqueEmpresaService.js');
const SRC_PORTA = path.join(ROOT, 'backend/services/fiscalNaoFiscal/estoqueSaldosPublico.js');
const SRC_AJUSTE = path.join(ROOT, 'backend/services/ajusteEstoqueService.js');
const SRC_BACKFILL = path.join(ROOT, 'backend/services/estoque/EstoqueEmpresaBackfillService.js');
const SRC_PRODUTOS = path.join(ROOT, 'backend/rotas/produtos.js');
const SRC_PDV = path.join(ROOT, 'backend/services/estoque/EstoqueReservaService.js');
const SRC_VENDAS = path.join(ROOT, 'backend/services/vendas/debitoEstoqueVendaViaPorta.js');

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
  const prod = await run(
    db,
    `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual, reservado_fiscal, reservado_nao_fiscal)
     VALUES ('X', 99, 50, 149, 7, 3)`
  );
  return { db, empresaA: empA.lastID, empresaB: empB.lastID, produtoId: prod.lastID };
}

async function test01EmpresaIdObrigatorio() {
  const { db, produtoId } = await setup();
  await assertRejects(
    EstoqueEmpresaService.consultarSaldoTecnico({ produtoId }, { db }),
    'EMPRESA_OBRIGATORIA'
  );
  await closeDb(db);
}

async function test02RegistroExistente() {
  const { db, produtoId, empresaA } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId,
    empresaId: empresaA,
    saldo_fiscal: 10,
    saldo_nao_fiscal: 4,
    estoque_atual: 14,
    reservado_fiscal: 2,
    reservado_nao_fiscal: 1
  }, { db });
  const r = await EstoqueEmpresaService.consultarSaldoTecnico(
    { produtoId, empresaId: empresaA },
    { db }
  );
  assert.ok(r);
  assert.strictEqual(r.produto_id, produtoId);
  assert.strictEqual(r.empresa_id, empresaA);
  await closeDb(db);
}

async function test03RegistroInexistente() {
  const { db, produtoId, empresaA } = await setup();
  const r = await EstoqueEmpresaService.consultarSaldoTecnico(
    { produtoId, empresaId: empresaA },
    { db }
  );
  assert.strictEqual(r, null);
  await closeDb(db);
}

async function test04ConsultaNaoCria() {
  const { db, produtoId, empresaA } = await setup();
  await EstoqueEmpresaService.consultarSaldoTecnico(
    { produtoId, empresaId: empresaA },
    { db }
  );
  const n = await get(db, 'SELECT COUNT(*) AS c FROM estoque_empresa');
  assert.strictEqual(n.c, 0);
  await closeDb(db);
}

async function test05RetornaSf() {
  const { db, produtoId, empresaA } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaA, saldo_fiscal: 10, saldo_nao_fiscal: 4
  }, { db });
  const r = await EstoqueEmpresaService.consultarSaldoTecnico(
    { produtoId, empresaId: empresaA },
    { db }
  );
  assert.strictEqual(r.saldo_fiscal, 10);
  await closeDb(db);
}

async function test06RetornaSnf() {
  const { db, produtoId, empresaA } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaA, saldo_fiscal: 10, saldo_nao_fiscal: 4
  }, { db });
  const r = await EstoqueEmpresaService.consultarSaldoTecnico(
    { produtoId, empresaId: empresaA },
    { db }
  );
  assert.strictEqual(r.saldo_nao_fiscal, 4);
  await closeDb(db);
}

async function test07RetornaReservas() {
  const { db, produtoId, empresaA } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId,
    empresaId: empresaA,
    saldo_fiscal: 10,
    saldo_nao_fiscal: 4,
    reservado_fiscal: 2,
    reservado_nao_fiscal: 1
  }, { db });
  const r = await EstoqueEmpresaService.consultarSaldoTecnico(
    { produtoId, empresaId: empresaA },
    { db }
  );
  assert.strictEqual(r.reservado_fiscal, 2);
  assert.strictEqual(r.reservado_nao_fiscal, 1);
  await closeDb(db);
}

async function test08EaPersistido() {
  const { db, produtoId, empresaA } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId,
    empresaId: empresaA,
    saldo_fiscal: 1,
    saldo_nao_fiscal: 1,
    estoque_atual: 99
  }, { db });
  const r = await EstoqueEmpresaService.consultarSaldoTecnico(
    { produtoId, empresaId: empresaA },
    { db }
  );
  assert.strictEqual(r.estoque_atual, 99);
  assert.notStrictEqual(r.estoque_atual, r.saldo_fiscal + r.saldo_nao_fiscal);
  await closeDb(db);
}

async function test09EmpresasIndependentes() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaA, saldo_fiscal: 10, saldo_nao_fiscal: 0
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaB, saldo_fiscal: 3, saldo_nao_fiscal: 2
  }, { db });
  const a = await EstoqueEmpresaService.consultarSaldoTecnico(
    { produtoId, empresaId: empresaA },
    { db }
  );
  const b = await EstoqueEmpresaService.consultarSaldoTecnico(
    { produtoId, empresaId: empresaB },
    { db }
  );
  assert.strictEqual(a.saldo_fiscal, 10);
  assert.strictEqual(a.saldo_nao_fiscal, 0);
  assert.strictEqual(b.saldo_fiscal, 3);
  assert.strictEqual(b.saldo_nao_fiscal, 2);
  await closeDb(db);
}

async function test10SemFallbackProdutos() {
  const { db, produtoId, empresaA } = await setup();
  const semRegistro = await EstoqueEmpresaService.consultarSaldoTecnico(
    { produtoId, empresaId: empresaA },
    { db }
  );
  assert.strictEqual(semRegistro, null);

  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaA, saldo_fiscal: 5, saldo_nao_fiscal: 1, estoque_atual: 6
  }, { db });
  const tecnico = await EstoqueEmpresaService.consultarSaldoTecnico(
    { produtoId, empresaId: empresaA },
    { db }
  );
  const publico = await saldosPublico.consultarSaldo(produtoId, { db, empresaId: empresaA });
  assert.strictEqual(tecnico.saldo_fiscal, 5);
  assert.strictEqual(publico.saldo_fiscal, 5);

  const src = fs.readFileSync(SRC_SERVICE, 'utf8');
  const porta = fs.readFileSync(SRC_PORTA, 'utf8');
  const ajuste = fs.readFileSync(SRC_AJUSTE, 'utf8');
  const backfill = fs.readFileSync(SRC_BACKFILL, 'utf8');
  const produtos = fs.readFileSync(SRC_PRODUTOS, 'utf8');
  const pdv = fs.readFileSync(SRC_PDV, 'utf8');
  const vendas = fs.readFileSync(SRC_VENDAS, 'utf8');

  assert.ok(src.includes('async function consultarSaldoTecnico'));
  assert.ok(src.includes('const registro = await consultarSaldo(params, opts)'));
  assert.ok(!src.includes('modoLegadoSemEmpresa'));
  assert.ok(porta.includes('FROM produtos'));
  assert.ok(!porta.includes('consultarSaldoTecnico'));
  assert.ok(!ajuste.includes('consultarSaldoTecnico'));
  assert.ok(!backfill.includes('consultarSaldoTecnico'));
  assert.ok(!produtos.includes('consultarSaldoTecnico'));
  assert.ok(!pdv.includes('consultarSaldoTecnico'));
  assert.ok(!vendas.includes('consultarSaldoTecnico'));
  await closeDb(db);
}

async function main() {
  const testes = [
    ['01 empresaId obrigatorio', test01EmpresaIdObrigatorio],
    ['02 consulta registro existente', test02RegistroExistente],
    ['03 consulta registro inexistente', test03RegistroInexistente],
    ['04 consulta nao cria registro', test04ConsultaNaoCria],
    ['05 retorna SF', test05RetornaSf],
    ['06 retorna SNF', test06RetornaSnf],
    ['07 retorna reservas', test07RetornaReservas],
    ['08 EA persistido sem recalcular', test08EaPersistido],
    ['09 empresa A independente de B', test09EmpresasIndependentes],
    ['10 sem fallback para produtos', test10SemFallbackProdutos]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\nleitura-estoque-empresa-03-15: ${ok}/${testes.length} OK`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
