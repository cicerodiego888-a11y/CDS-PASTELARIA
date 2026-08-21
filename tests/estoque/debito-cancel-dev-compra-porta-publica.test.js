/**
 * Fase 1 / Implementação 02.4 — Cancelamento/Devolução de compra via porta pública.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const {
  debitarEstoqueItemCompra,
  MOTIVO_COMPAT_DEBITO_COMPRA
} = require('../../backend/services/compras/debitoEstoqueCompraViaPorta');

const SRC_PORTA = path.resolve(
  __dirname,
  '../../backend/services/compras/debitoEstoqueCompraViaPorta.js'
);
const SRC_ROTAS = path.resolve(__dirname, '../../backend/rotas/compras.js');

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

function debitoAsync(db, dados) {
  return new Promise((resolve, reject) => {
    debitarEstoqueItemCompra(db, dados, (err, result) => (
      err ? reject(err) : resolve(result)
    ));
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

async function setup(sf = 100, snf = 50) {
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
      updated_at DATETIME
    )
  `);
  await run(db, `CREATE TABLE empresas (id INTEGER PRIMARY KEY, razao TEXT)`);
  await run(db, `INSERT INTO empresas (id, razao) VALUES (1, 'A')`);
  const p = await run(
    db,
    `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual)
     VALUES ('Global', ?, ?, ?)`,
    [sf, snf, sf + snf]
  );
  return { db, produtoId: p.lastID, empresaId: 1 };
}

async function test01CancelFiscal() {
  const { db, produtoId, empresaId } = await setup(100, 50);
  const r = await debitoAsync(db, {
    produtoId,
    quantidadeFiscal: 30,
    quantidadeNaoFiscal: 0,
    empresaId,
    origem: 'cancelamento_compra'
  });
  assert.strictEqual(r.saldo_fiscal, 70);
  assert.strictEqual(r.saldo_nao_fiscal, 50);
  assert.strictEqual(r.origem, 'cancelamento_compra');
  await closeDb(db);
}

async function test02CancelNaoFiscal() {
  const { db, produtoId, empresaId } = await setup(100, 50);
  const r = await debitoAsync(db, {
    produtoId,
    quantidadeFiscal: 0,
    quantidadeNaoFiscal: 20,
    empresaId,
    origem: 'cancelamento_compra'
  });
  assert.strictEqual(r.saldo_fiscal, 100);
  assert.strictEqual(r.saldo_nao_fiscal, 30);
  await closeDb(db);
}

async function test03DevFiscal() {
  const { db, produtoId, empresaId } = await setup(80, 40);
  const r = await debitoAsync(db, {
    produtoId,
    quantidadeFiscal: 15,
    quantidadeNaoFiscal: 0,
    empresaId,
    origem: 'devolucao_compra'
  });
  assert.strictEqual(r.saldo_fiscal, 65);
  assert.strictEqual(r.saldo_nao_fiscal, 40);
  assert.strictEqual(r.origem, 'devolucao_compra');
  await closeDb(db);
}

async function test04DevNaoFiscal() {
  const { db, produtoId, empresaId } = await setup(80, 40);
  const r = await debitoAsync(db, {
    produtoId,
    quantidadeFiscal: 0,
    quantidadeNaoFiscal: 12,
    empresaId,
    origem: 'devolucao_compra'
  });
  assert.strictEqual(r.saldo_fiscal, 80);
  assert.strictEqual(r.saldo_nao_fiscal, 28);
  await closeDb(db);
}

async function test05FiscalNaoAlteraNF() {
  const { db, produtoId, empresaId } = await setup(100, 50);
  await debitoAsync(db, {
    produtoId,
    quantidadeFiscal: 10,
    quantidadeNaoFiscal: 0,
    empresaId
  });
  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.saldo_nao_fiscal, 50);
  await closeDb(db);
}

async function test06NFNaoAlteraFiscal() {
  const { db, produtoId, empresaId } = await setup(100, 50);
  await debitoAsync(db, {
    produtoId,
    quantidadeFiscal: 0,
    quantidadeNaoFiscal: 10,
    empresaId
  });
  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.saldo_fiscal, 100);
  await closeDb(db);
}

async function test07EmpresaPropagada() {
  const { db, produtoId, empresaId } = await setup();
  const r = await debitoAsync(db, {
    produtoId,
    quantidadeFiscal: 1,
    empresaId
  });
  assert.strictEqual(r.empresa_id, empresaId);
  assert.strictEqual(r.legado, false);
  await closeDb(db);
}

async function test08Compat() {
  const { db, produtoId } = await setup();
  const r = await debitoAsync(db, {
    produtoId,
    quantidadeFiscal: 2
  });
  assert.strictEqual(r.legado, true);
  assert.strictEqual(r.motivo_compat, MOTIVO_COMPAT_DEBITO_COMPRA);

  await assertRejects(
    debitoAsync(db, { produtoId, quantidadeFiscal: 1, exigirEmpresa: true }),
    'EMPRESA_OBRIGATORIA'
  );
  await closeDb(db);
}

async function test09Rollback() {
  const { db, produtoId, empresaId } = await setup(100, 50);
  await run(db, 'BEGIN');
  await debitoAsync(db, {
    produtoId,
    quantidadeFiscal: 25,
    quantidadeNaoFiscal: 10,
    empresaId
  });
  await run(db, 'ROLLBACK');
  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.saldo_fiscal, 100);
  assert.strictEqual(row.saldo_nao_fiscal, 50);
  await closeDb(db);
}

async function test10SemDebitoDuplicado() {
  const rotas = fs.readFileSync(SRC_ROTAS, 'utf8');
  const porta = fs.readFileSync(SRC_PORTA, 'utf8');

  assert.ok(porta.includes('debitarSaldo'));
  assert.ok(rotas.includes('debitarEstoqueItemCompra'));

  const cancelSection = rotas.slice(
    rotas.indexOf("router.post('/:id/cancelar'"),
    rotas.indexOf("router.post('/parse-xml'")
  );
  const devolucaoSection = rotas.slice(
    rotas.indexOf("router.post('/:id/devolver'"),
    rotas.indexOf("router.post('/:id/cancelar'")
  );

  assert.ok(cancelSection.includes('debitarEstoqueItemCompra'));
  assert.ok(devolucaoSection.includes('debitarEstoqueItemCompra'));
  assert.ok(
    !/saldo_fiscal\s*=\s*saldo_fiscal\s*-/i.test(cancelSection),
    'cancelamento não deve UPDATE saldo_fiscal'
  );
  assert.ok(
    !/saldo_fiscal\s*=\s*saldo_fiscal\s*-/i.test(devolucaoSection),
    'devolução não deve UPDATE saldo_fiscal'
  );
  assert.ok(
    !/estoque_atual\s*=\s*\(saldo_fiscal\s*-/i.test(cancelSection),
    'cancelamento não deve calcular estoque_atual manualmente'
  );
  assert.ok(
    !/estoque_atual\s*=\s*\(saldo_fiscal\s*-/i.test(devolucaoSection),
    'devolução não deve calcular estoque_atual manualmente'
  );

  const calls = (rotas.match(/debitarEstoqueItemCompra\s*\(/g) || []).length;
  assert.strictEqual(calls, 2, 'exatamente 2 caminhos: cancel + devolução');
}

async function test11EstoqueAtual() {
  const { db, produtoId, empresaId } = await setup(100, 50);
  const r = await debitoAsync(db, {
    produtoId,
    quantidadeFiscal: 20,
    quantidadeNaoFiscal: 10,
    empresaId
  });
  assert.strictEqual(r.estoque_atual, r.saldo_fiscal + r.saldo_nao_fiscal);
  assert.strictEqual(r.estoque_atual, 120);
  await closeDb(db);
}

async function test12ScanSqlFluxosMigrados() {
  const rotas = fs.readFileSync(SRC_ROTAS, 'utf8');
  const cancelSection = rotas.slice(
    rotas.indexOf("router.post('/:id/cancelar'"),
    rotas.indexOf("router.post('/parse-xml'")
  );
  const devolucaoSection = rotas.slice(
    rotas.indexOf("router.post('/:id/devolver'"),
    rotas.indexOf("router.post('/:id/cancelar'")
  );

  assert.ok(!/SET\s+saldo_fiscal/i.test(cancelSection));
  assert.ok(!/SET\s+saldo_nao_fiscal/i.test(cancelSection));
  assert.ok(!/SET\s+estoque_atual/i.test(cancelSection));
  assert.ok(!/SET\s+saldo_fiscal/i.test(devolucaoSection));
  assert.ok(!/SET\s+saldo_nao_fiscal/i.test(devolucaoSection));
  assert.ok(!/SET\s+estoque_atual/i.test(devolucaoSection));

  // crédito (02.3) ainda pode ter UPDATE metadados — ok
  assert.ok(rotas.includes('creditarEstoqueItemCompra'));
}

async function main() {
  const testes = [
    ['01 cancel fiscal', test01CancelFiscal],
    ['02 cancel nao fiscal', test02CancelNaoFiscal],
    ['03 devolucao fiscal', test03DevFiscal],
    ['04 devolucao nao fiscal', test04DevNaoFiscal],
    ['05 F nao altera NF', test05FiscalNaoAlteraNF],
    ['06 NF nao altera F', test06NFNaoAlteraFiscal],
    ['07 empresaId', test07EmpresaPropagada],
    ['08 COMPAT', test08Compat],
    ['09 rollback', test09Rollback],
    ['10 sem débito duplicado', test10SemDebitoDuplicado],
    ['11 EA = SF+SNF', test11EstoqueAtual],
    ['12 scan SQL fluxos migrados', test12ScanSqlFluxosMigrados]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\ndebito-cancel-dev-compra-porta-publica: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
