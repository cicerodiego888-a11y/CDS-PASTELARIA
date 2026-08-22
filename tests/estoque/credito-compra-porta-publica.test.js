/**
 * Fase 1 / Implementação 02.3 — Crédito de estoque de compra via porta pública.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const {
  creditarEstoqueItemCompra,
  MOTIVO_COMPAT_CREDITO_COMPRA
} = require('../../backend/services/compras/creditoEstoqueCompraViaPorta');

const SRC_PORTA = path.resolve(
  __dirname,
  '../../backend/services/compras/creditoEstoqueCompraViaPorta.js'
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

function creditoAsync(db, dados) {
  return new Promise((resolve, reject) => {
    creditarEstoqueItemCompra(db, dados, (err, result) => (
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

async function setup(sf = 0, snf = 0) {
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

async function test01Fiscal() {
  const { db, produtoId, empresaId } = await setup(10, 5);
  const r = await creditoAsync(db, {
    produtoId,
    quantidadeFiscal: 20,
    quantidadeNaoFiscal: 0,
    empresaId
  });
  assert.strictEqual(r.saldo_fiscal, 20);
  assert.strictEqual(r.saldo_nao_fiscal, 0);
  assert.strictEqual(r.creditado, true);
  await closeDb(db);
}

async function test02NaoFiscal() {
  const { db, produtoId, empresaId } = await setup(10, 5);
  const r = await creditoAsync(db, {
    produtoId,
    quantidadeFiscal: 0,
    quantidadeNaoFiscal: 15,
    empresaId
  });
  assert.strictEqual(r.saldo_fiscal, 0);
  assert.strictEqual(r.saldo_nao_fiscal, 15);
  await closeDb(db);
}

async function test03ProdutoGlobal() {
  const { db, produtoId, empresaId } = await setup(0, 0);
  await creditoAsync(db, {
    produtoId,
    quantidadeFiscal: 7,
    quantidadeNaoFiscal: 3,
    empresaId
  });
  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.saldo_fiscal, 7);
  assert.strictEqual(row.saldo_nao_fiscal, 3);
  assert.strictEqual(row.estoque_atual, 10);
  await closeDb(db);
}

async function test04EmpresaPropagada() {
  const { db, produtoId, empresaId } = await setup();
  const r = await creditoAsync(db, {
    produtoId,
    quantidadeFiscal: 1,
    empresaId
  });
  assert.strictEqual(r.empresa_id, empresaId);
  assert.strictEqual(r.legado, false);
  await closeDb(db);
}

async function test05CompatEmpresaAusente() {
  const { db, produtoId } = await setup();
  const r = await creditoAsync(db, {
    produtoId,
    quantidadeFiscal: 4,
    quantidadeNaoFiscal: 0
  });
  assert.strictEqual(r.legado, true);
  assert.strictEqual(r.motivo_compat, MOTIVO_COMPAT_CREDITO_COMPRA);
  assert.strictEqual(r.saldo_fiscal, 4);

  await assertRejects(
    creditoAsync(db, {
      produtoId,
      quantidadeFiscal: 1,
      exigirEmpresa: true
    }),
    'EMPRESA_OBRIGATORIA'
  );
  await closeDb(db);
}

async function test06EstoqueAtual() {
  const { db, produtoId, empresaId } = await setup(100, 50);
  const r = await creditoAsync(db, {
    produtoId,
    quantidadeFiscal: 10,
    quantidadeNaoFiscal: 5,
    empresaId
  });
  assert.strictEqual(r.estoque_atual, r.saldo_fiscal + r.saldo_nao_fiscal);
  assert.strictEqual(r.estoque_atual, 15);
  await closeDb(db);
}

async function test07Transacao() {
  const { db, produtoId, empresaId } = await setup(0, 0);
  await run(db, 'BEGIN');
  await creditoAsync(db, {
    produtoId,
    quantidadeFiscal: 8,
    empresaId
  });
  const mid = await get(db, 'SELECT saldo_fiscal FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(mid.saldo_fiscal, 8);
  await run(db, 'COMMIT');
  await closeDb(db);
}

async function test08Rollback() {
  const { db, produtoId, empresaId } = await setup(12, 0);
  await run(db, 'BEGIN');
  await creditoAsync(db, {
    produtoId,
    quantidadeFiscal: 5,
    empresaId
  });
  await run(db, 'ROLLBACK');
  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.saldo_fiscal, 12, 'rollback deve desfazer crédito da porta');
  await closeDb(db);
}

async function test09SemCreditoDuplicadoNoSource() {
  const rotas = fs.readFileSync(SRC_ROTAS, 'utf8');
  const porta = fs.readFileSync(SRC_PORTA, 'utf8');

  assert.ok(rotas.includes('creditarEstoqueItemCompra'));
  assert.ok(porta.includes('estoqueSaldosPublico'));
  assert.ok(porta.includes('creditarSaldo'));

  // No fluxo de crédito (processarItensCompra), não deve haver UPDATE de saldo.
  // Cancelamento/devolução ainda usam UPDATE (fora do escopo 02.3).
  const creditoSection = rotas.slice(
    rotas.indexOf('function processarItensCompra'),
    rotas.indexOf('function garantirTabelaDevolucoesCompra')
  );
  assert.ok(creditoSection.length > 100, 'seção processarItensCompra não encontrada');
  assert.ok(
    !/saldo_fiscal\s*=\s*COALESCE\(saldo_fiscal/i.test(creditoSection),
    'processarItensCompra não deve UPDATE saldo_fiscal'
  );
  assert.ok(
    !/saldo_nao_fiscal\s*=\s*COALESCE\(saldo_nao_fiscal/i.test(creditoSection),
    'processarItensCompra não deve UPDATE saldo_nao_fiscal'
  );
  assert.ok(
    !/estoque_atual\s*=\s*\(COALESCE\(saldo_fiscal/i.test(creditoSection),
    'processarItensCompra não deve UPDATE estoque_atual via saldo'
  );

  // Uma única chamada ao adaptador no arquivo de rotas
  const calls = (rotas.match(/creditarEstoqueItemCompra\s*\(/g) || []).length;
  assert.strictEqual(calls, 1, 'deve haver exatamente um caminho de crédito na rota');
}

async function test10QuantidadesSeparadas() {
  const { db, produtoId, empresaId } = await setup(0, 0);
  const r = await creditoAsync(db, {
    produtoId,
    quantidadeFiscal: 11.5,
    quantidadeNaoFiscal: 2.25,
    empresaId
  });
  assert.strictEqual(r.quantidade_fiscal, 11.5);
  assert.strictEqual(r.quantidade_nao_fiscal, 2.25);
  assert.strictEqual(r.saldo_fiscal, 11.5);
  assert.strictEqual(r.saldo_nao_fiscal, 2.25);
  // F não vira NF
  assert.notStrictEqual(r.saldo_fiscal, r.saldo_nao_fiscal);
  await closeDb(db);
}

async function testZeroNaoCredita() {
  const { db, produtoId, empresaId } = await setup(9, 1);
  const r = await creditoAsync(db, {
    produtoId,
    quantidadeFiscal: 0,
    quantidadeNaoFiscal: 0,
    empresaId
  });
  assert.strictEqual(r.creditado, false);
  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.saldo_fiscal, 9);
  assert.strictEqual(row.saldo_nao_fiscal, 1);
  await closeDb(db);
}

async function main() {
  const testes = [
    ['01 compra fiscal', test01Fiscal],
    ['02 compra nao fiscal', test02NaoFiscal],
    ['03 produto global', test03ProdutoGlobal],
    ['04 empresaId', test04EmpresaPropagada],
    ['05 COMPAT / empresa ausente', test05CompatEmpresaAusente],
    ['06 EA = SF+SNF', test06EstoqueAtual],
    ['07 transação', test07Transacao],
    ['08 rollback', test08Rollback],
    ['09 sem crédito duplicado / sem UPDATE saldo no crédito', test09SemCreditoDuplicadoNoSource],
    ['10 quantidades F/NF', test10QuantidadesSeparadas],
    ['zero não credita', testZeroNaoCredita]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\ncredito-compra-porta-publica: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
