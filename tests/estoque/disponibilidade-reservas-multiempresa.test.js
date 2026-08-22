/**
 * Fase 2 / Implementação 03.36 — consultarDisponibilidade com empresaId.
 */
'use strict';

const assert = require('assert');
const sqlite3 = require('sqlite3').verbose();

const reservas = require('../../backend/services/fiscalNaoFiscal/reservasPublico');
const { calcularEstoqueProduto } = require('../../backend/services/estoque/EstoqueDisponivelService');
const { COMPAT_CERTIFICADA_PRE_MULTIEMPRESA } = require('../../backend/services/fiscalNaoFiscal/empresaContexto');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

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

async function setup() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  await run(db, `
    CREATE TABLE produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT,
      saldo_fiscal REAL DEFAULT 0,
      saldo_nao_fiscal REAL DEFAULT 0,
      estoque_atual REAL DEFAULT 0,
      reservado_fiscal REAL DEFAULT 0,
      reservado_nao_fiscal REAL DEFAULT 0,
      controla_estoque INTEGER DEFAULT 1,
      updated_at DATETIME
    )
  `);
  const p = await run(
    db,
    `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual, reservado_fiscal)
     VALUES ('X', 100, 20, 120, 4)`
  );
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const b = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  return { db, produtoId: p.lastID, empresaA: a, empresaB: b };
}

async function seedAB(db, produtoId, empresaA, empresaB) {
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaA.id,
    saldo_fiscal: 10, saldo_nao_fiscal: 2, estoque_atual: 12, reservado_fiscal: 2
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaB.id,
    saldo_fiscal: 3, saldo_nao_fiscal: 1, estoque_atual: 4, reservado_fiscal: 0
  }, { db });
}

async function test01SemEmpresaLegado() {
  const { db, produtoId } = await setup();
  const r = await reservas.consultarDisponibilidade(produtoId, {
    db,
    ...COMPAT_CERTIFICADA_PRE_MULTIEMPRESA
  });
  assert.strictEqual(r.legado, true);
  assert.strictEqual(r.saldo_fiscal, 100);
  assert.strictEqual(r.reservado_fiscal, 4);
  assert.strictEqual(r.disponivel_fiscal, 96);
  await closeDb(db);
}

async function test02EmpresaA() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  const r = await reservas.consultarDisponibilidade(produtoId, { db, empresaId: empresaA.id });
  assert.strictEqual(r.empresa_id, empresaA.id);
  assert.strictEqual(r.saldo_fiscal, 10);
  assert.strictEqual(r.reservado_fiscal, 2);
  assert.strictEqual(r.disponivel_fiscal, 8);
  await closeDb(db);
}

async function test03EmpresaB() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  const r = await reservas.consultarDisponibilidade(produtoId, { db, empresaId: empresaB.id });
  assert.strictEqual(r.saldo_fiscal, 3);
  assert.strictEqual(r.disponivel_fiscal, 3);
  await closeDb(db);
}

async function test04ANaoVeB() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  const r = await reservas.consultarDisponibilidade(produtoId, { db, empresaId: empresaA.id });
  assert.notStrictEqual(r.saldo_fiscal, 3);
  assert.strictEqual(r.disponivel_fiscal, 8);
  await closeDb(db);
}

async function test05BNaoVeA() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  const r = await reservas.consultarDisponibilidade(produtoId, { db, empresaId: empresaB.id });
  assert.notStrictEqual(r.disponivel_fiscal, 8);
  assert.strictEqual(r.disponivel_fiscal, 3);
  await closeDb(db);
}

async function test06LegadoNaoInterfere() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  const r = await reservas.consultarDisponibilidade(produtoId, { db, empresaId: empresaB.id });
  assert.notStrictEqual(r.saldo_fiscal, 100);
  assert.notStrictEqual(r.disponivel_fiscal, 96);
  await closeDb(db);
}

async function test07SemRegistroZero() {
  const { db, produtoId, empresaA } = await setup();
  const r = await reservas.consultarDisponibilidade(produtoId, { db, empresaId: empresaA.id });
  assert.strictEqual(r.saldo_fiscal, 0);
  assert.strictEqual(r.reservado_fiscal, 0);
  assert.strictEqual(r.disponivel_fiscal, 0);
  assert.strictEqual(r.disponivel_nao_fiscal, 0);
  await closeDb(db);
}

async function test08NaoCria() {
  const { db, produtoId, empresaA } = await setup();
  await reservas.consultarDisponibilidade(produtoId, { db, empresaId: empresaA.id });
  const n = await get(db, 'SELECT COUNT(*) AS c FROM estoque_empresa');
  assert.strictEqual(n.c, 0);
  await closeDb(db);
}

async function test09ReservadoANaoAfetaB() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  const b = await reservas.consultarDisponibilidade(produtoId, { db, empresaId: empresaB.id });
  assert.strictEqual(b.reservado_fiscal, 0);
  assert.strictEqual(b.disponivel_fiscal, 3);
  await closeDb(db);
}

async function test10Formula() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  const r = await reservas.consultarDisponibilidade(produtoId, { db, empresaId: empresaA.id });
  const calc = calcularEstoqueProduto({
    saldo_fiscal: 10,
    saldo_nao_fiscal: 2,
    reservado_fiscal: 2,
    reservado_nao_fiscal: 0,
    estoque_atual: 12
  });
  assert.strictEqual(r.disponivel_fiscal, calc.disponivel_fiscal);
  assert.strictEqual(r.disponivel_nao_fiscal, calc.disponivel_nao_fiscal);
  assert.strictEqual(r.disponivel_fiscal, Math.max(0, r.saldo_fiscal - r.reservado_fiscal));
  await closeDb(db);
}

async function test11EmpresaIdChega() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  const r = await reservas.consultarDisponibilidade({
    produtoId, empresaId: empresaB.id, db
  });
  assert.strictEqual(r.empresa_id, empresaB.id);
  assert.strictEqual(r.disponivel_fiscal, 3);
  await closeDb(db);
}

async function test12BodyNaoSubstitui() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  const r = await reservas.consultarDisponibilidade(produtoId, {
    db,
    empresaId: empresaA.id,
    body: { empresaId: empresaB.id },
    query: { empresaId: empresaB.id },
    contexto: { empresaId: empresaB.id },
    ctx: { empresaId: empresaB.id },
    empresa_id: empresaB.id
  });
  assert.strictEqual(r.empresa_id, empresaA.id);
  assert.strictEqual(r.disponivel_fiscal, 8);
  const sem = await reservas.consultarDisponibilidade(produtoId, {
    db,
    ...COMPAT_CERTIFICADA_PRE_MULTIEMPRESA,
    body: { empresaId: empresaA.id },
    contexto: { empresaId: empresaA.id }
  });
  assert.strictEqual(sem.empresa_id, null);
  assert.strictEqual(sem.disponivel_fiscal, 96);
  await closeDb(db);
}

async function main() {
  const testes = [
    ['01 sem empresa mantem legado', test01SemEmpresaLegado],
    ['02 empresa A usa saldo isolado', test02EmpresaA],
    ['03 empresa B usa saldo isolado', test03EmpresaB],
    ['04 A nao enxerga B', test04ANaoVeB],
    ['05 B nao enxerga A', test05BNaoVeA],
    ['06 produtos nao interfere', test06LegadoNaoInterfere],
    ['07 sem registro disponibilidade zero', test07SemRegistroZero],
    ['08 nao cria registro', test08NaoCria],
    ['09 reservado A nao interfere em B', test09ReservadoANaoAfetaB],
    ['10 formula preservada', test10Formula],
    ['11 empresaId chega a porta', test11EmpresaIdChega],
    ['12 body/query/contexto nao substituem', test12BodyNaoSubstitui]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  ok ${nome}`);
  }
  console.log(`\ndisponibilidade-reservas-multiempresa: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
