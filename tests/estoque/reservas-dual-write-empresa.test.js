/**
 * Fase 2 / Implementação 03.20 — dual-write de reservas na porta pública.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const reservas = require('../../backend/services/fiscalNaoFiscal/reservasPublico');
const { TipoSaldo } = require('../../backend/services/fiscalNaoFiscal/constants');
const { COMPAT_CERTIFICADA_PRE_MULTIEMPRESA } = require('../../backend/services/fiscalNaoFiscal/empresaContexto');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');

const ROOT = path.resolve(__dirname, '../..');
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
    `INSERT INTO produtos
       (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual, reservado_fiscal, reservado_nao_fiscal)
     VALUES ('X', 100, 40, 140, 100, 50)`
  );
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const b = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  return { db, produtoId: p.lastID, empresaA: a, empresaB: b };
}

async function ee(db, produtoId, empresaId) {
  return EstoqueEmpresaService.consultarSaldo({ produtoId, empresaId }, { db });
}

async function test01CompatSemEmpresa() {
  const { db, produtoId } = await setup();
  await reservas.reservarQuantidade(produtoId, TipoSaldo.FISCAL, 5, {
    db,
    ...COMPAT_CERTIFICADA_PRE_MULTIEMPRESA
  });
  const prod = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.reservado_fiscal, 105);
  const n = await get(db, 'SELECT COUNT(*) AS c FROM estoque_empresa');
  assert.strictEqual(n.c, 0);
  await closeDb(db);
}

async function test02ReservaFiscalComEmpresa() {
  const { db, produtoId, empresaA } = await setup();
  await reservas.reservarQuantidade(produtoId, TipoSaldo.FISCAL, 5, {
    db,
    empresaId: empresaA.id
  });
  const prod = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  const iso = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(prod.reservado_fiscal, 105);
  assert.strictEqual(iso.reservado_fiscal, 5);
  await closeDb(db);
}

async function test03ReservaNaoFiscal() {
  const { db, produtoId, empresaA } = await setup();
  await reservas.reservarQuantidade(produtoId, TipoSaldo.NAO_FISCAL, 3, {
    db,
    empresaId: empresaA.id
  });
  const prod = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  const iso = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(prod.reservado_nao_fiscal, 53);
  assert.strictEqual(iso.reservado_nao_fiscal, 3);
  assert.strictEqual(iso.reservado_fiscal, 0);
  await closeDb(db);
}

async function test04LiberacaoFiscal() {
  const { db, produtoId, empresaA } = await setup();
  await reservas.reservarQuantidade(produtoId, TipoSaldo.FISCAL, 8, { db, empresaId: empresaA.id });
  await reservas.liberarQuantidadeReservada(produtoId, TipoSaldo.FISCAL, 3, {
    db,
    empresaId: empresaA.id
  });
  const prod = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  const iso = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(prod.reservado_fiscal, 105);
  assert.strictEqual(iso.reservado_fiscal, 5);
  await closeDb(db);
}

async function test05LiberacaoNaoFiscal() {
  const { db, produtoId, empresaA } = await setup();
  await reservas.reservarQuantidade(produtoId, TipoSaldo.NAO_FISCAL, 6, { db, empresaId: empresaA.id });
  await reservas.liberarQuantidadeReservada(produtoId, TipoSaldo.NAO_FISCAL, 2, {
    db,
    empresaId: empresaA.id
  });
  const iso = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(iso.reservado_nao_fiscal, 4);
  await closeDb(db);
}

async function test06IsolamentoAB() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await reservas.reservarQuantidade(produtoId, TipoSaldo.FISCAL, 10, { db, empresaId: empresaA.id });
  await reservas.reservarQuantidade(produtoId, TipoSaldo.FISCAL, 20, { db, empresaId: empresaB.id });
  assert.strictEqual((await ee(db, produtoId, empresaA.id)).reservado_fiscal, 10);
  assert.strictEqual((await ee(db, produtoId, empresaB.id)).reservado_fiscal, 20);
  await reservas.liberarQuantidadeReservada(produtoId, TipoSaldo.FISCAL, 4, {
    db,
    empresaId: empresaA.id
  });
  assert.strictEqual((await ee(db, produtoId, empresaA.id)).reservado_fiscal, 6);
  assert.strictEqual((await ee(db, produtoId, empresaB.id)).reservado_fiscal, 20);
  await closeDb(db);
}

async function test07NasceZeradoMaisDelta() {
  const { db, produtoId, empresaA } = await setup();
  await reservas.reservarQuantidade(produtoId, TipoSaldo.FISCAL, 5, { db, empresaId: empresaA.id });
  const iso = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(iso.reservado_fiscal, 5);
  assert.strictEqual(iso.saldo_fiscal, 0);
  await closeDb(db);
}

async function test08NaoCopiaLegado() {
  const { db, produtoId, empresaA } = await setup();
  const prod = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.reservado_fiscal, 100);
  await reservas.reservarQuantidade(produtoId, TipoSaldo.FISCAL, 5, { db, empresaId: empresaA.id });
  const iso = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(iso.reservado_fiscal, 5);
  assert.notStrictEqual(iso.reservado_fiscal, 105);
  await closeDb(db);
}

async function test09Rollback() {
  const { db, produtoId, empresaA } = await setup();
  await run(db, 'BEGIN');
  await reservas.reservarQuantidade(produtoId, TipoSaldo.FISCAL, 9, { db, empresaId: empresaA.id });
  const midProd = await get(db, 'SELECT reservado_fiscal FROM produtos WHERE id = ?', [produtoId]);
  const midEe = await get(
    db,
    'SELECT reservado_fiscal FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?',
    [produtoId, empresaA.id]
  );
  assert.strictEqual(midProd.reservado_fiscal, 109);
  assert.strictEqual(midEe.reservado_fiscal, 9);
  await run(db, 'ROLLBACK');
  const prod = await get(db, 'SELECT reservado_fiscal FROM produtos WHERE id = ?', [produtoId]);
  const n = await get(db, 'SELECT COUNT(*) AS c FROM estoque_empresa');
  assert.strictEqual(prod.reservado_fiscal, 100);
  assert.strictEqual(n.c, 0);
  await closeDb(db);
}

async function test10EstoqueAtualIntacto() {
  const { db, produtoId, empresaA } = await setup();
  const antes = await get(db, 'SELECT estoque_atual FROM produtos WHERE id = ?', [produtoId]);
  await reservas.reservarQuantidade(produtoId, TipoSaldo.FISCAL, 5, { db, empresaId: empresaA.id });
  const prod = await get(db, 'SELECT estoque_atual FROM produtos WHERE id = ?', [produtoId]);
  const iso = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(prod.estoque_atual, antes.estoque_atual);
  assert.strictEqual(iso.estoque_atual, 0);
  await closeDb(db);
}

async function test11SaldosFisicosIntacto() {
  const { db, produtoId, empresaA } = await setup();
  await reservas.reservarQuantidade(produtoId, TipoSaldo.FISCAL, 5, { db, empresaId: empresaA.id });
  await reservas.reservarQuantidade(produtoId, TipoSaldo.NAO_FISCAL, 2, { db, empresaId: empresaA.id });
  const prod = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  const iso = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(prod.saldo_fiscal, 100);
  assert.strictEqual(prod.saldo_nao_fiscal, 40);
  assert.strictEqual(iso.saldo_fiscal, 0);
  assert.strictEqual(iso.saldo_nao_fiscal, 0);
  await closeDb(db);
}

async function test12Fluxos036e037PelaPorta() {
  const ponte = fs.readFileSync(
    path.join(ROOT, 'backend/services/estoque/pedidoReservaPonteNucleo.js'),
    'utf8'
  );
  const repair = fs.readFileSync(
    path.join(ROOT, 'backend/motores/comercial/ReservaRepairService.js'),
    'utf8'
  );
  const porta = fs.readFileSync(
    path.join(ROOT, 'backend/services/fiscalNaoFiscal/reservasPublico.js'),
    'utf8'
  );
  const pdv = fs.readFileSync(
    path.join(ROOT, 'backend/services/estoque/EstoqueReservaService.js'),
    'utf8'
  );
  assert.ok(ponte.includes('liberarQuantidadeReservada'));
  assert.ok(repair.includes('reservarQuantidade'));
  assert.ok(repair.includes('liberarQuantidadeReservada'));
  assert.ok(pdv.includes('reservasPublico'));
  assert.ok(porta.includes('aplicarEfeitoReservado'));
  assert.ok(porta.includes('FROM produtos'));
  assert.ok(!/\bFROM\s+estoque_empresa\b/i.test(porta));
  assert.ok(!ponte.includes('EstoqueEmpresaService'));
  assert.ok(!repair.includes('EstoqueEmpresaService'));
  assert.ok(!pdv.includes('EstoqueEmpresaService'));
}

async function main() {
  const testes = [
    ['01 COMPAT sem empresa', test01CompatSemEmpresa],
    ['02 reserva fiscal com empresa', test02ReservaFiscalComEmpresa],
    ['03 reserva nao fiscal', test03ReservaNaoFiscal],
    ['04 liberacao fiscal', test04LiberacaoFiscal],
    ['05 liberacao nao fiscal', test05LiberacaoNaoFiscal],
    ['06 isolamento A/B', test06IsolamentoAB],
    ['07 nasce zerado + delta', test07NasceZeradoMaisDelta],
    ['08 nao copia legado', test08NaoCopiaLegado],
    ['09 rollback externo', test09Rollback],
    ['10 estoque_atual intacto', test10EstoqueAtualIntacto],
    ['11 SF/SNF intactos', test11SaldosFisicosIntacto],
    ['12 fluxos 03.6 e 03.7 pela porta', test12Fluxos036e037PelaPorta]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\nreservas-dual-write-empresa: ${ok}/${testes.length} OK`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
