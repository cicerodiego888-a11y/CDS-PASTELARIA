/**
 * Fase 1 / Implementação 02.2 — Recálculo de saldos via porta pública.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const {
  recalcularSaldosProduto,
  calcularSaldosAlvoRecalculo,
  MOTIVO_COMPAT_RECALCULO
} = require('../../backend/services/estoqueFiscalService');

const SRC = path.resolve(__dirname, '../../backend/services/estoqueFiscalService.js');

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

function recalcAsync(db, produtoId, opcoes = {}) {
  return new Promise((resolve, reject) => {
    recalcularSaldosProduto(db, produtoId, opcoes, (err, result) => (
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

async function setupSchema(db) {
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
  await run(db, `
    CREATE TABLE compras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT DEFAULT 'concluida'
    )
  `);
  await run(db, `
    CREATE TABLE compras_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      compra_id INTEGER,
      produto_id INTEGER,
      quantidade REAL,
      quantidade_fiscal REAL,
      quantidade_nao_fiscal REAL,
      item_fiscal INTEGER DEFAULT 1
    )
  `);
  await run(db, `
    CREATE TABLE vendas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT DEFAULT 'concluida'
    )
  `);
  await run(db, `
    CREATE TABLE vendas_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venda_id INTEGER,
      produto_id INTEGER,
      quantidade REAL,
      quantidade_fiscal REAL,
      quantidade_nao_fiscal REAL,
      item_fiscal INTEGER DEFAULT 1
    )
  `);
  await run(db, `
    CREATE TABLE compras_devolucoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      compra_item_id INTEGER,
      produto_id INTEGER,
      quantidade REAL
    )
  `);
  await run(db, `CREATE TABLE empresas (id INTEGER PRIMARY KEY, razao TEXT)`);
  await run(db, `INSERT INTO empresas (id, razao) VALUES (1, 'A')`);
}

/**
 * Histórico: compra 100F+50NF, venda 20F+10NF → alvo 80F / 40NF
 * Produto inicia com saldo divergente (999) para forçar correção.
 */
async function setupComHistorico(opts = {}) {
  const db = await openDb();
  await setupSchema(db);
  const p = await run(
    db,
    `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual)
     VALUES ('X', ?, ?, ?)`,
    [
      opts.sfInicial != null ? opts.sfInicial : 999,
      opts.snfInicial != null ? opts.snfInicial : 999,
      opts.eaInicial != null ? opts.eaInicial : 1998
    ]
  );
  const produtoId = p.lastID;
  const c = await run(db, `INSERT INTO compras (status) VALUES ('concluida')`);
  await run(
    db,
    `INSERT INTO compras_itens
     (compra_id, produto_id, quantidade, quantidade_fiscal, quantidade_nao_fiscal, item_fiscal)
     VALUES (?, ?, 150, 100, 50, 1)`,
    [c.lastID, produtoId]
  );
  const v = await run(db, `INSERT INTO vendas (status) VALUES ('concluida')`);
  await run(
    db,
    `INSERT INTO vendas_itens
     (venda_id, produto_id, quantidade, quantidade_fiscal, quantidade_nao_fiscal, item_fiscal)
     VALUES (?, ?, 30, 20, 10, 1)`,
    [v.lastID, produtoId]
  );
  return { db, produtoId, empresaId: 1, alvoSF: 80, alvoSNF: 40 };
}

async function test01Simples() {
  const { db, produtoId, empresaId, alvoSF, alvoSNF } = await setupComHistorico();
  const r = await recalcAsync(db, produtoId, { empresaId });
  assert.strictEqual(r.saldo_fiscal, alvoSF);
  assert.strictEqual(r.saldo_nao_fiscal, alvoSNF);
  assert.strictEqual(r.estoque_atual, alvoSF + alvoSNF);
  await closeDb(db);
}

async function test02Fiscal() {
  const db = await openDb();
  await setupSchema(db);
  const p = await run(db, `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual) VALUES ('F', 0, 0, 0)`);
  const c = await run(db, `INSERT INTO compras (status) VALUES ('concluida')`);
  await run(db, `INSERT INTO compras_itens (compra_id, produto_id, quantidade, quantidade_fiscal, quantidade_nao_fiscal, item_fiscal) VALUES (?, ?, 100, 100, 0, 1)`, [c.lastID, p.lastID]);
  const r = await recalcAsync(db, p.lastID, { empresaId: 1 });
  assert.strictEqual(r.saldo_fiscal, 100);
  assert.strictEqual(r.saldo_nao_fiscal, 0);
  await closeDb(db);
}

async function test03NaoFiscal() {
  const db = await openDb();
  await setupSchema(db);
  const p = await run(db, `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual) VALUES ('NF', 0, 0, 0)`);
  const c = await run(db, `INSERT INTO compras (status) VALUES ('concluida')`);
  await run(db, `INSERT INTO compras_itens (compra_id, produto_id, quantidade, quantidade_fiscal, quantidade_nao_fiscal, item_fiscal) VALUES (?, ?, 40, 0, 40, 0)`, [c.lastID, p.lastID]);
  const r = await recalcAsync(db, p.lastID, { empresaId: 1 });
  assert.strictEqual(r.saldo_fiscal, 0);
  assert.strictEqual(r.saldo_nao_fiscal, 40);
  await closeDb(db);
}

async function test04Ambos() {
  const { db, produtoId, empresaId } = await setupComHistorico();
  const r = await recalcAsync(db, produtoId, { empresaId });
  assert.ok(r.saldo_fiscal > 0 && r.saldo_nao_fiscal > 0);
  await closeDb(db);
}

async function test05EstoqueAtual() {
  const { db, produtoId, empresaId } = await setupComHistorico();
  const r = await recalcAsync(db, produtoId, { empresaId });
  assert.strictEqual(r.estoque_atual, r.saldo_fiscal + r.saldo_nao_fiscal);
  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.estoque_atual, row.saldo_fiscal + row.saldo_nao_fiscal);
  await closeDb(db);
}

async function test06ReservasNaoAlteradas() {
  const { db, produtoId, empresaId } = await setupComHistorico();
  await run(db, `UPDATE produtos SET reservado_fiscal = 7, reservado_nao_fiscal = 3 WHERE id = ?`, [produtoId]);
  await recalcAsync(db, produtoId, { empresaId });
  const row = await get(db, 'SELECT reservado_fiscal, reservado_nao_fiscal FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.reservado_fiscal, 7);
  assert.strictEqual(row.reservado_nao_fiscal, 3);
  await closeDb(db);
}

async function test07Transacao() {
  const { db, produtoId, empresaId } = await setupComHistorico();
  await run(db, 'BEGIN');
  await recalcAsync(db, produtoId, { empresaId });
  const mid = await get(db, 'SELECT saldo_fiscal FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(mid.saldo_fiscal, 80);
  await run(db, 'COMMIT');
  await closeDb(db);
}

async function test08Rollback() {
  const { db, produtoId, empresaId } = await setupComHistorico({ sfInicial: 999, snfInicial: 999, eaInicial: 1998 });
  await run(db, 'BEGIN');
  await recalcAsync(db, produtoId, { empresaId });
  await run(db, 'ROLLBACK');
  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.saldo_fiscal, 999, 'rollback deve restaurar saldo pré-recalc');
  await closeDb(db);
}

async function test09Idempotencia() {
  const { db, produtoId, empresaId } = await setupComHistorico();
  const r1 = await recalcAsync(db, produtoId, { empresaId });
  const r2 = await recalcAsync(db, produtoId, { empresaId });
  assert.strictEqual(r1.saldo_fiscal, r2.saldo_fiscal);
  assert.strictEqual(r1.saldo_nao_fiscal, r2.saldo_nao_fiscal);
  assert.strictEqual(r1.estoque_atual, r2.estoque_atual);
  await closeDb(db);
}

async function test10EmpresaPropagada() {
  const { db, produtoId, empresaId } = await setupComHistorico();
  const r = await recalcAsync(db, produtoId, { empresaId });
  assert.strictEqual(r.empresa_id, empresaId);
  assert.strictEqual(r.legado, false);
  await closeDb(db);
}

async function test11EmpresaAusente() {
  const { db, produtoId } = await setupComHistorico();
  await assertRejects(
    recalcAsync(db, produtoId, { exigirEmpresa: true }),
    'EMPRESA_OBRIGATORIA'
  );
  await closeDb(db);
}

async function test12ProdutoInexistente() {
  const { db } = await setupComHistorico();
  await assertRejects(
    recalcAsync(db, 99999, { empresaId: 1 }),
    'não encontrado'
  );
  await closeDb(db);
}

async function test13SemUpdateDireto() {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.ok(!/UPDATE\s+produtos/i.test(src), 'estoqueFiscalService não deve UPDATE produtos');
  assert.ok(src.includes('estoqueSaldosPublico'));
  assert.ok(src.includes('creditarSaldo') || src.includes('debitarSaldo'));
}

async function testCompatLegado() {
  const { db, produtoId } = await setupComHistorico();
  const r = await recalcAsync(db, produtoId, {});
  assert.strictEqual(r.legado, true);
  assert.strictEqual(r.motivo_compat, MOTIVO_COMPAT_RECALCULO);
  assert.strictEqual(r.saldo_fiscal, 80);
  await closeDb(db);
}

async function testFormulaAlvo() {
  const alvo = calcularSaldosAlvoRecalculo(
    [{ quantidade: 150, quantidade_fiscal: 100, quantidade_nao_fiscal: 50, item_fiscal: 1 }],
    [{ quantidade: 30, quantidade_fiscal: 20, quantidade_nao_fiscal: 10, item_fiscal: 1 }],
    []
  );
  assert.strictEqual(alvo.saldo_fiscal, 80);
  assert.strictEqual(alvo.saldo_nao_fiscal, 40);
  assert.strictEqual(alvo.estoque_atual, 120);
}

async function main() {
  const testes = [
    ['01 recalc simples', test01Simples],
    ['02 fiscal', test02Fiscal],
    ['03 nao fiscal', test03NaoFiscal],
    ['04 ambos', test04Ambos],
    ['05 EA = SF+SNF', test05EstoqueAtual],
    ['06 reservas intocadas', test06ReservasNaoAlteradas],
    ['07 transação', test07Transacao],
    ['08 rollback', test08Rollback],
    ['09 idempotência', test09Idempotencia],
    ['10 empresaId', test10EmpresaPropagada],
    ['11 empresa ausente', test11EmpresaAusente],
    ['12 produto inexistente', test12ProdutoInexistente],
    ['13 sem UPDATE direto', test13SemUpdateDireto],
    ['COMPAT legado', testCompatLegado],
    ['fórmula alvo', testFormulaAlvo]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\nrecalculo-saldos-porta-publica: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
