/**
 * Fase 1 / Implementação 02.1 — Ajuste de estoque via porta pública.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const {
  aplicarAjusteEstoqueProduto,
  aplicarSaldosIniciaisViaPorta,
  MOTIVO_COMPAT_AJUSTE
} = require('../../backend/services/ajusteEstoqueService');

const SRC = path.resolve(
  __dirname,
  '../../backend/services/ajusteEstoqueService.js'
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

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_) { resolve(); }
  });
}

function aplicarAsync(db, opcoes) {
  return new Promise((resolve, reject) => {
    aplicarAjusteEstoqueProduto(db, opcoes, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

function saldosIniciaisAsync(db, opcoes) {
  return new Promise((resolve, reject) => {
    aplicarSaldosIniciaisViaPorta(db, opcoes, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

async function assertRejects(promise, codeOrMsg) {
  try {
    await promise;
    throw new Error(`Esperava falha (${codeOrMsg})`);
  } catch (err) {
    if (err.message && err.message.startsWith('Esperava falha')) throw err;
    if (typeof codeOrMsg === 'string' && codeOrMsg.startsWith('EMPRESA')) {
      assert.strictEqual(err.code, codeOrMsg, `${err.code} !== ${codeOrMsg}: ${err.message}`);
    } else if (typeof codeOrMsg === 'string') {
      assert.ok(
        err.code === codeOrMsg || String(err.message).includes(codeOrMsg),
        `esperado ${codeOrMsg}, veio code=${err.code} msg=${err.message}`
      );
    }
  }
}

async function setup() {
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
      controlar_validade INTEGER DEFAULT 0,
      updated_at DATETIME
    )
  `);
  await run(db, `
    CREATE TABLE produtos_ajustes_estoque (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produto_id INTEGER,
      usuario_id INTEGER,
      usuario_nome TEXT,
      motivo TEXT,
      ajuste_fiscal REAL,
      ajuste_nao_fiscal REAL,
      saldo_fiscal_antes REAL,
      saldo_fiscal_depois REAL,
      saldo_nao_fiscal_antes REAL,
      saldo_nao_fiscal_depois REAL,
      estoque_total_antes REAL,
      estoque_total_depois REAL
    )
  `);
  await run(db, `
    CREATE TABLE empresas (
      id INTEGER PRIMARY KEY,
      razao_social TEXT
    )
  `);
  await run(db, `INSERT INTO empresas (id, razao_social) VALUES (1, 'Empresa A')`);

  const p = await run(
    db,
    `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual)
     VALUES ('Cebola', 10, 5, 15)`
  );
  return { db, produtoId: p.lastID, empresaId: 1 };
}

async function test01FiscalPositivo() {
  const { db, produtoId, empresaId } = await setup();
  const r = await aplicarAsync(db, {
    produtoId,
    empresaId,
    ajusteFiscal: 3,
    ajusteNaoFiscal: 0,
    motivo: 'teste +3F',
    usuarioId: 1,
    usuarioNome: 'tester'
  });
  assert.strictEqual(r.saldo_fiscal, 13);
  assert.strictEqual(r.saldo_nao_fiscal, 5);
  assert.strictEqual(r.estoque_atual, 18);
  await closeDb(db);
}

async function test02FiscalNegativo() {
  const { db, produtoId, empresaId } = await setup();
  const r = await aplicarAsync(db, {
    produtoId,
    empresaId,
    ajusteFiscal: -3,
    ajusteNaoFiscal: 0,
    motivo: 'teste -3F'
  });
  assert.strictEqual(r.saldo_fiscal, 7);
  assert.strictEqual(r.saldo_nao_fiscal, 5);
  assert.strictEqual(r.estoque_atual, 12);
  await closeDb(db);
}

async function test03NaoFiscalPositivo() {
  const { db, produtoId, empresaId } = await setup();
  const r = await aplicarAsync(db, {
    produtoId,
    empresaId,
    ajusteFiscal: 0,
    ajusteNaoFiscal: 4,
    motivo: 'teste +4NF'
  });
  assert.strictEqual(r.saldo_fiscal, 10);
  assert.strictEqual(r.saldo_nao_fiscal, 9);
  assert.strictEqual(r.estoque_atual, 19);
  await closeDb(db);
}

async function test04NaoFiscalNegativo() {
  const { db, produtoId, empresaId } = await setup();
  const r = await aplicarAsync(db, {
    produtoId,
    empresaId,
    ajusteFiscal: 0,
    ajusteNaoFiscal: -2,
    motivo: 'teste -2NF'
  });
  assert.strictEqual(r.saldo_fiscal, 10);
  assert.strictEqual(r.saldo_nao_fiscal, 3);
  assert.strictEqual(r.estoque_atual, 13);
  await closeDb(db);
}

async function test05FiscalNaoAlteraNf() {
  const { db, produtoId, empresaId } = await setup();
  const r = await aplicarAsync(db, {
    produtoId, empresaId, ajusteFiscal: 1, ajusteNaoFiscal: 0, motivo: 'iso F'
  });
  assert.strictEqual(r.saldo_nao_fiscal, 5);
  await closeDb(db);
}

async function test06NfNaoAlteraFiscal() {
  const { db, produtoId, empresaId } = await setup();
  const r = await aplicarAsync(db, {
    produtoId, empresaId, ajusteFiscal: 0, ajusteNaoFiscal: 1, motivo: 'iso NF'
  });
  assert.strictEqual(r.saldo_fiscal, 10);
  await closeDb(db);
}

async function test07EstoqueAtual() {
  const { db, produtoId, empresaId } = await setup();
  const r = await aplicarAsync(db, {
    produtoId, empresaId, ajusteFiscal: 2, ajusteNaoFiscal: -1, motivo: 'ea'
  });
  assert.strictEqual(r.estoque_atual, r.saldo_fiscal + r.saldo_nao_fiscal);
  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.estoque_atual, row.saldo_fiscal + row.saldo_nao_fiscal);
  await closeDb(db);
}

async function test08EmpresaPropagada() {
  const { db, produtoId, empresaId } = await setup();
  const r = await aplicarAsync(db, {
    produtoId, empresaId, ajusteFiscal: 1, ajusteNaoFiscal: 0, motivo: 'prop'
  });
  assert.strictEqual(r.empresa_id, empresaId);
  assert.strictEqual(r.legado, false);
  await closeDb(db);
}

async function test09EmpresaAusenteObrigatoria() {
  const { db, produtoId } = await setup();
  await assertRejects(
    aplicarAsync(db, {
      produtoId,
      exigirEmpresa: true,
      ajusteFiscal: 1,
      ajusteNaoFiscal: 0,
      motivo: 'sem empresa'
    }),
    'EMPRESA_OBRIGATORIA'
  );
  await closeDb(db);
}

async function test10ProdutoInexistente() {
  const { db, empresaId } = await setup();
  await assertRejects(
    aplicarAsync(db, {
      produtoId: 99999,
      empresaId,
      ajusteFiscal: 1,
      ajusteNaoFiscal: 0,
      motivo: 'ghost'
    }),
    'não encontrado'
  );
  await closeDb(db);
}

async function test11TransacaoExterna() {
  const { db, produtoId, empresaId } = await setup();
  await run(db, 'BEGIN');
  await aplicarAsync(db, {
    produtoId, empresaId, ajusteFiscal: 5, ajusteNaoFiscal: 0, motivo: 'tx'
  });
  await run(db, 'ROLLBACK');
  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.saldo_fiscal, 10, 'rollback externo deve reverter saldo da porta');
  assert.strictEqual(row.saldo_nao_fiscal, 5);
  await closeDb(db);
}

async function test12Historico() {
  const { db, produtoId, empresaId } = await setup();
  await aplicarAsync(db, {
    produtoId,
    empresaId,
    ajusteFiscal: 2,
    ajusteNaoFiscal: 0,
    motivo: 'hist-ok',
    usuarioId: 7,
    usuarioNome: 'auditor'
  });
  const rows = await all(db, 'SELECT * FROM produtos_ajustes_estoque WHERE produto_id = ?', [produtoId]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].motivo, 'hist-ok');
  assert.strictEqual(rows[0].ajuste_fiscal, 2);
  assert.strictEqual(rows[0].saldo_fiscal_antes, 10);
  assert.strictEqual(rows[0].saldo_fiscal_depois, 12);
  assert.strictEqual(rows[0].usuario_id, 7);
  await closeDb(db);
}

async function test13CompatLegado() {
  const { db, produtoId } = await setup();
  const r = await aplicarAsync(db, {
    produtoId,
    ajusteFiscal: 1,
    ajusteNaoFiscal: 0,
    motivo: 'compat legado'
  });
  assert.strictEqual(r.legado, true);
  assert.strictEqual(r.motivo_compat, MOTIVO_COMPAT_AJUSTE);
  assert.strictEqual(r.saldo_fiscal, 11);
  await closeDb(db);
}

async function testSaldosIniciaisViaPorta() {
  const { db, produtoId, empresaId } = await setup();
  const r = await saldosIniciaisAsync(db, {
    produtoId,
    empresaId,
    saldoFiscal: 20,
    saldoNaoFiscal: 0
  });
  assert.strictEqual(r.saldo_fiscal, 20);
  assert.strictEqual(r.saldo_nao_fiscal, 0);
  assert.strictEqual(r.estoque_atual, 20);
  const hist = await all(db, 'SELECT * FROM produtos_ajustes_estoque');
  assert.strictEqual(hist.length, 0, 'saldos iniciais não gravam histórico de ajuste');
  await closeDb(db);
}

async function testSemSqlDiretoNoSource() {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.ok(!/UPDATE\s+produtos/i.test(src), 'ajusteEstoqueService não deve ter UPDATE produtos');
  assert.ok(src.includes('estoqueSaldosPublico'), 'deve usar porta pública');
  assert.ok(src.includes('creditarSaldo') || src.includes('debitarSaldo'));
}

async function main() {
  const testes = [
    ['01 fiscal +', test01FiscalPositivo],
    ['02 fiscal -', test02FiscalNegativo],
    ['03 nao fiscal +', test03NaoFiscalPositivo],
    ['04 nao fiscal -', test04NaoFiscalNegativo],
    ['05 F nao altera NF', test05FiscalNaoAlteraNf],
    ['06 NF nao altera F', test06NfNaoAlteraFiscal],
    ['07 estoque_atual = SF+SNF', test07EstoqueAtual],
    ['08 empresaId propagado', test08EmpresaPropagada],
    ['09 empresa ausente obrigatória', test09EmpresaAusenteObrigatoria],
    ['10 produto inexistente', test10ProdutoInexistente],
    ['11 TX externa / rollback', test11TransacaoExterna],
    ['12 histórico', test12Historico],
    ['13 COMPAT legado explícito', test13CompatLegado],
    ['saldos iniciais via porta', testSaldosIniciaisViaPorta],
    ['sem SQL direto no source', testSemSqlDiretoNoSource]
  ];

  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\najuste-estoque-porta-publica: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
