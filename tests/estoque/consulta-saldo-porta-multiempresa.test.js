/**
 * Fase 2 / Implementação 03.35 — consultarSaldo da porta com empresaId.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const saldos = require('../../backend/services/fiscalNaoFiscal/estoqueSaldosPublico');
const { TipoSaldo } = require('../../backend/services/fiscalNaoFiscal/constants');
const { COMPAT_CERTIFICADA_PRE_MULTIEMPRESA } = require('../../backend/services/fiscalNaoFiscal/empresaContexto');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');

const ROOT = path.resolve(__dirname, '../..');
const PORTA = path.join(ROOT, 'backend/services/fiscalNaoFiscal/estoqueSaldosPublico.js');
const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

const CHAVES_CONTRATO = [
  'produto_id', 'empresa_id', 'legado', 'existe',
  'saldo_fiscal', 'saldo_nao_fiscal', 'estoque_atual', 'estoque_total',
  'reservado_fiscal', 'reservado_nao_fiscal',
  'disponivel_fiscal', 'disponivel_nao_fiscal', 'disponivel_total'
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
    saldo_fiscal: 10, saldo_nao_fiscal: 2, estoque_atual: 12, reservado_fiscal: 1
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaB.id,
    saldo_fiscal: 3, saldo_nao_fiscal: 1, estoque_atual: 4
  }, { db });
}

async function test01SemEmpresaLegado() {
  const { db, produtoId } = await setup();
  const r = await saldos.consultarSaldo(produtoId, {
    db,
    ...COMPAT_CERTIFICADA_PRE_MULTIEMPRESA
  });
  assert.strictEqual(r.legado, true);
  assert.strictEqual(r.empresa_id, null);
  assert.strictEqual(r.saldo_fiscal, 100);
  assert.strictEqual(r.estoque_atual, 120);
  await closeDb(db);
}

async function test02EmpresaALeA() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  const r = await saldos.consultarSaldo(produtoId, { db, empresaId: empresaA.id });
  assert.strictEqual(r.empresa_id, empresaA.id);
  assert.strictEqual(r.saldo_fiscal, 10);
  assert.strictEqual(r.saldo_nao_fiscal, 2);
  assert.strictEqual(r.estoque_atual, 12);
  assert.strictEqual(r.reservado_fiscal, 1);
  await closeDb(db);
}

async function test03EmpresaBLeB() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  const r = await saldos.consultarSaldo(produtoId, { db, empresaId: empresaB.id });
  assert.strictEqual(r.saldo_fiscal, 3);
  assert.strictEqual(r.saldo_nao_fiscal, 1);
  await closeDb(db);
}

async function test04ANaoVeB() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  const r = await saldos.consultarSaldo(produtoId, { db, empresaId: empresaA.id });
  assert.notStrictEqual(r.saldo_fiscal, 3);
  assert.strictEqual(r.saldo_fiscal, 10);
  await closeDb(db);
}

async function test05BNaoVeA() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  const r = await saldos.consultarSaldo(produtoId, { db, empresaId: empresaB.id });
  assert.notStrictEqual(r.saldo_fiscal, 10);
  assert.strictEqual(r.saldo_fiscal, 3);
  await closeDb(db);
}

async function test06LegadoNaoInterfere() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  const r = await saldos.consultarSaldo(produtoId, { db, empresaId: empresaB.id });
  assert.notStrictEqual(r.saldo_fiscal, 100);
  assert.strictEqual(r.saldo_fiscal, 3);
  await closeDb(db);
}

async function test07SemRegistroZero() {
  const { db, produtoId, empresaA } = await setup();
  const r = await saldos.consultarSaldo(produtoId, { db, empresaId: empresaA.id });
  assert.strictEqual(r.saldo_fiscal, 0);
  assert.strictEqual(r.saldo_nao_fiscal, 0);
  assert.strictEqual(r.estoque_atual, 0);
  assert.strictEqual(r.reservado_fiscal, 0);
  assert.strictEqual(r.reservado_nao_fiscal, 0);
  assert.notStrictEqual(r.saldo_fiscal, 100);
  await closeDb(db);
}

async function test08NaoCriaRegistro() {
  const { db, produtoId, empresaA } = await setup();
  await saldos.consultarSaldo(produtoId, { db, empresaId: empresaA.id });
  const n = await get(db, 'SELECT COUNT(*) AS c FROM estoque_empresa');
  assert.strictEqual(n.c, 0);
  await closeDb(db);
}

async function test09ContratoIgual() {
  const { db, produtoId, empresaA } = await setup();
  const legado = await saldos.consultarSaldo(produtoId, {
    db,
    ...COMPAT_CERTIFICADA_PRE_MULTIEMPRESA
  });
  const isolado = await saldos.consultarSaldo(produtoId, { db, empresaId: empresaA.id });
  assert.deepStrictEqual(Object.keys(legado), CHAVES_CONTRATO);
  assert.deepStrictEqual(Object.keys(isolado), Object.keys(legado));
  await closeDb(db);
}

async function test10EmpresaIdChega() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  const obj = await saldos.consultarSaldo({ produtoId, empresaId: empresaB.id, db });
  assert.strictEqual(obj.empresa_id, empresaB.id);
  assert.strictEqual(obj.saldo_fiscal, 3);
  await closeDb(db);
}

async function test11BodyNaoSubstitui() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  const r = await saldos.consultarSaldo(produtoId, {
    db,
    empresaId: empresaA.id,
    body: { empresaId: empresaB.id },
    query: { empresaId: empresaB.id },
    contexto: { empresaId: empresaB.id },
    ctx: { empresaId: empresaB.id },
    empresa_id: empresaB.id
  });
  assert.strictEqual(r.empresa_id, empresaA.id);
  assert.strictEqual(r.saldo_fiscal, 10);
  const sem = await saldos.consultarSaldo(produtoId, {
    db,
    ...COMPAT_CERTIFICADA_PRE_MULTIEMPRESA,
    body: { empresaId: empresaA.id },
    contexto: { empresaId: empresaA.id },
    empresa_id: empresaA.id
  });
  assert.strictEqual(sem.empresa_id, null);
  assert.strictEqual(sem.saldo_fiscal, 100);
  await closeDb(db);
}

async function test12WritersIntacto() {
  const src = fs.readFileSync(PORTA, 'utf8');
  assert.ok(src.includes('consultarSaldoParaEmpresa'));
  assert.ok(src.includes('consultarSaldoEmProdutos'));
  assert.ok(src.includes('espelharEfeitoEmEstoqueEmpresa'));
  const blocoAjuste = src.slice(src.indexOf('async function _ajustarSaldo'));
  assert.ok(blocoAjuste.includes('consultarSaldoEmProdutos'));
  const { db, produtoId, empresaA } = await setup();
  await saldos.creditarSaldo(produtoId, TipoSaldo.FISCAL, 7, { db, empresaId: empresaA.id });
  const prod = await get(db, 'SELECT saldo_fiscal FROM produtos WHERE id = ?', [produtoId]);
  const ee = await get(
    db,
    'SELECT saldo_fiscal FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?',
    [produtoId, empresaA.id]
  );
  assert.strictEqual(prod.saldo_fiscal, 107);
  assert.strictEqual(ee.saldo_fiscal, 7);
  await closeDb(db);
}

async function main() {
  const testes = [
    ['01 sem empresaId mantem produtos', test01SemEmpresaLegado],
    ['02 empresa A le estoque_empresa A', test02EmpresaALeA],
    ['03 empresa B le estoque_empresa B', test03EmpresaBLeB],
    ['04 A nao ve B', test04ANaoVeB],
    ['05 B nao ve A', test05BNaoVeA],
    ['06 legado produtos nao interfere', test06LegadoNaoInterfere],
    ['07 sem registro retorna zero', test07SemRegistroZero],
    ['08 nao cria registro', test08NaoCriaRegistro],
    ['09 contrato de retorno igual', test09ContratoIgual],
    ['10 empresaId explicito chega', test10EmpresaIdChega],
    ['11 body/query/contexto nao substituem', test11BodyNaoSubstitui],
    ['12 writers / dual-write intactos', test12WritersIntacto]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  ok ${nome}`);
  }
  console.log(`\nconsulta-saldo-porta-multiempresa: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
