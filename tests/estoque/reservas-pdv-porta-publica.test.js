/**
 * Fase 1 / Implementação 02.7 — Reservas PDV via porta pública.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const reservas = require('../../backend/services/fiscalNaoFiscal/reservasPublico');
const { TipoSaldo } = require('../../backend/services/fiscalNaoFiscal/constants');

const SRC_PORTA = path.resolve(
  __dirname,
  '../../backend/services/fiscalNaoFiscal/reservasPublico.js'
);
const SRC_RESERVA = path.resolve(
  __dirname,
  '../../backend/services/estoque/EstoqueReservaService.js'
);
const SRC_CONSUMO = path.resolve(
  __dirname,
  '../../backend/services/estoque/EstoqueConsumoReserva.js'
);

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

async function assertRejects(promise, codeOrMsg) {
  try {
    await promise;
    throw new Error(`Esperava falha (${codeOrMsg})`);
  } catch (err) {
    if (err.message && err.message.startsWith('Esperava falha')) throw err;
    if (typeof codeOrMsg === 'string' && codeOrMsg.startsWith('EMPRESA')) {
      assert.strictEqual(err.code, codeOrMsg);
    } else {
      assert.ok(
        err.code === codeOrMsg || String(err.message).includes(codeOrMsg),
        `esperado ${codeOrMsg}, veio ${err.code}/${err.message}`
      );
    }
  }
}

async function setup(sf = 100, snf = 50, rf = 0, rnf = 0) {
  const db = await openDb();
  await run(db, `
    CREATE TABLE produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT,
      saldo_fiscal REAL DEFAULT 0,
      saldo_nao_fiscal REAL DEFAULT 0,
      reservado_fiscal REAL DEFAULT 0,
      reservado_nao_fiscal REAL DEFAULT 0,
      estoque_atual REAL DEFAULT 0,
      controla_estoque INTEGER DEFAULT 1,
      updated_at DATETIME
    )
  `);
  await run(db, `CREATE TABLE empresas (id INTEGER PRIMARY KEY, razao TEXT)`);
  await run(db, `INSERT INTO empresas (id, razao) VALUES (1, 'A')`);
  const p = await run(
    db,
    `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, reservado_fiscal, reservado_nao_fiscal, estoque_atual)
     VALUES ('Global', ?, ?, ?, ?, ?)`,
    [sf, snf, rf, rnf, sf + snf]
  );
  return { db, produtoId: p.lastID, empresaId: 1 };
}

async function test01CriarFiscal() {
  const { db, produtoId, empresaId } = await setup();
  const r = await reservas.reservarQuantidade(produtoId, TipoSaldo.FISCAL, 12, { db, empresaId });
  assert.strictEqual(r.reservado_fiscal, 12);
  assert.strictEqual(r.saldo_fiscal, 100);
  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.reservado_fiscal, 12);
  assert.strictEqual(row.saldo_fiscal, 100);
  assert.strictEqual(row.saldo_nao_fiscal, 50);
  await closeDb(db);
}

async function test02CriarNaoFiscal() {
  const { db, produtoId, empresaId } = await setup();
  const r = await reservas.reservarQuantidade(produtoId, TipoSaldo.NAO_FISCAL, 7, { db, empresaId });
  assert.strictEqual(r.reservado_nao_fiscal, 7);
  assert.strictEqual(r.saldo_nao_fiscal, 50);
  await closeDb(db);
}

async function test03LiberarFiscal() {
  const { db, produtoId, empresaId } = await setup(100, 50, 20, 8);
  const r = await reservas.liberarQuantidadeReservada(produtoId, TipoSaldo.FISCAL, 5, { db, empresaId });
  assert.strictEqual(r.reservado_fiscal, 15);
  assert.strictEqual(r.reservado_nao_fiscal, 8);
  assert.strictEqual(r.saldo_fiscal, 100);
  await closeDb(db);
}

async function test04LiberarNaoFiscal() {
  const { db, produtoId, empresaId } = await setup(100, 50, 20, 8);
  const r = await reservas.liberarQuantidadeReservada(produtoId, TipoSaldo.NAO_FISCAL, 3, { db, empresaId });
  assert.strictEqual(r.reservado_nao_fiscal, 5);
  assert.strictEqual(r.reservado_fiscal, 20);
  await closeDb(db);
}

async function test05FiscalNaoAlteraNF() {
  const { db, produtoId, empresaId } = await setup(100, 50, 1, 9);
  await reservas.reservarQuantidade(produtoId, TipoSaldo.FISCAL, 4, { db, empresaId });
  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.reservado_nao_fiscal, 9);
  await closeDb(db);
}

async function test06NFNaoAlteraFiscal() {
  const { db, produtoId, empresaId } = await setup(100, 50, 1, 9);
  await reservas.reservarQuantidade(produtoId, TipoSaldo.NAO_FISCAL, 2, { db, empresaId });
  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.reservado_fiscal, 1);
  await closeDb(db);
}

async function test07Disponibilidade() {
  const { db, produtoId, empresaId } = await setup(100, 50, 0, 0);
  const r = await reservas.reservarQuantidade(produtoId, TipoSaldo.FISCAL, 12, { db, empresaId });
  assert.strictEqual(r.disponivel_fiscal, 88);
  assert.strictEqual(r.disponivel_nao_fiscal, 50);
  const r2 = await reservas.reservarQuantidade(produtoId, TipoSaldo.NAO_FISCAL, 10, { db, empresaId });
  assert.strictEqual(r2.disponivel_nao_fiscal, 40);
  assert.strictEqual(r2.disponivel_fiscal, 88);
  await closeDb(db);
}

async function test08EmpresaPropagada() {
  const { db, produtoId, empresaId } = await setup();
  const r = await reservas.reservarQuantidade(produtoId, TipoSaldo.FISCAL, 1, { db, empresaId });
  assert.strictEqual(r.empresa_id, empresaId);
  assert.strictEqual(r.legado, false);
  await closeDb(db);
}

async function test09Compat() {
  const { db, produtoId } = await setup();
  await assertRejects(
    reservas.reservarQuantidade(produtoId, TipoSaldo.FISCAL, 1, { db }),
    'EMPRESA_OBRIGATORIA'
  );
  const r = await reservas.reservarQuantidade(produtoId, TipoSaldo.FISCAL, 2, {
    db,
    modoLegadoSemEmpresa: true,
    motivoCompat: 'COMPAT_RESERVA_PDV_PRE_MULTIEMPRESA'
  });
  assert.strictEqual(r.legado, true);
  assert.strictEqual(r.reservado_fiscal, 2);

  const reservaSrc = fs.readFileSync(SRC_RESERVA, 'utf8');
  assert.ok(reservaSrc.includes('COMPAT_RESERVA_PDV_PRE_MULTIEMPRESA'));
  assert.ok(reservaSrc.includes('modoLegadoSemEmpresa'));
  await closeDb(db);
}

async function test10Rollback() {
  const { db, produtoId, empresaId } = await setup(100, 50, 0, 0);
  await run(db, 'BEGIN');
  await reservas.reservarQuantidade(produtoId, TipoSaldo.FISCAL, 25, { db, empresaId });
  await reservas.reservarQuantidade(produtoId, TipoSaldo.NAO_FISCAL, 10, { db, empresaId });
  const mid = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(mid.reservado_fiscal, 25);
  assert.strictEqual(mid.reservado_nao_fiscal, 10);
  await run(db, 'ROLLBACK');
  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.reservado_fiscal, 0);
  assert.strictEqual(row.reservado_nao_fiscal, 0);
  assert.strictEqual(row.saldo_fiscal, 100);
  await closeDb(db);
}

async function test11ScanSqlFluxosMigrados() {
  const porta = fs.readFileSync(SRC_PORTA, 'utf8');
  const reserva = fs.readFileSync(SRC_RESERVA, 'utf8');
  const consumo = fs.readFileSync(SRC_CONSUMO, 'utf8');

  assert.ok(porta.includes('reservarQuantidade'));
  assert.ok(porta.includes('liberarQuantidadeReservada'));
  assert.ok(reserva.includes('reservasPublico'));
  assert.ok(reserva.includes('reservarQuantidade'));
  assert.ok(consumo.includes('liberarQuantidadeReservada'));
  assert.ok(!consumo.includes('debitarSaldo'), 'consumo não deve criar reserva via débito de saldo');

  assert.ok(!/UPDATE\s+produtos/i.test(reserva), 'EstoqueReservaService não UPDATE produtos');
  assert.ok(!/SET\s+reservado_fiscal/i.test(reserva));
  assert.ok(!/SET\s+reservado_nao_fiscal/i.test(reserva));
  assert.ok(!/UPDATE\s+produtos/i.test(consumo), 'EstoqueConsumoReserva não UPDATE produtos');
  assert.ok(!/SET\s+reservado_fiscal/i.test(consumo));
  assert.ok(!/SET\s+reservado_nao_fiscal/i.test(consumo));

  assert.ok(consumo.includes('reduzirEstoqueDistribuido'), 'baixa permanece no consumo');
  assert.ok(!reserva.includes('saldo_fiscal ='));
  assert.ok(!reserva.includes('estoque_atual ='));
}

async function main() {
  const testes = [
    ['01 criar reserva fiscal', test01CriarFiscal],
    ['02 criar reserva nao fiscal', test02CriarNaoFiscal],
    ['03 liberar reserva fiscal', test03LiberarFiscal],
    ['04 liberar reserva nao fiscal', test04LiberarNaoFiscal],
    ['05 F nao altera NF', test05FiscalNaoAlteraNF],
    ['06 NF nao altera F', test06NFNaoAlteraFiscal],
    ['07 disponibilidade', test07Disponibilidade],
    ['08 empresaId', test08EmpresaPropagada],
    ['09 COMPAT', test09Compat],
    ['10 rollback', test10Rollback],
    ['11 scan SQL fluxos migrados', test11ScanSqlFluxosMigrados]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\nreservas-pdv-porta-publica: ${ok}/${testes.length} OK`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
