/**
 * Fase 1 / Implementação 02.6 — Baixa normal de venda via porta pública.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const {
  debitarEstoqueItemVenda,
  MOTIVO_COMPAT_DEBITO_VENDA,
  montarOpcoesBaixaEstoqueVenda
} = require('../../backend/services/vendas/debitoEstoqueVendaViaPorta');

const SRC_PORTA = path.resolve(
  __dirname,
  '../../backend/services/vendas/debitoEstoqueVendaViaPorta.js'
);
const SRC_PAGAMENTO = path.resolve(
  __dirname,
  '../../backend/services/vendas/VendaPagamentoService.js'
);
const SRC_DISTRIBUIDOR = path.resolve(
  __dirname,
  '../../backend/services/distribuidorEstoqueVenda.js'
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

function debitoAsync(db, dados) {
  return new Promise((resolve, reject) => {
    debitarEstoqueItemVenda(db, dados, (err, result) => (
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

function secaoBaixa(pagamento) {
  const inicio = pagamento.indexOf('function atualizarSaldoProdutoAposBaixa');
  const fim = pagamento.indexOf('function atualizarStatusPagamentoVenda');
  assert.ok(inicio >= 0 && fim > inicio, 'seção de baixa não encontrada');
  return pagamento.slice(inicio, fim);
}

async function test01VendaFiscal() {
  const { db, produtoId, empresaId } = await setup(100, 50);
  const r = await debitoAsync(db, {
    produtoId,
    quantidadeFiscal: 20,
    quantidadeNaoFiscal: 0,
    empresaId,
    origem: 'baixa_venda'
  });
  assert.strictEqual(r.saldo_fiscal, 80);
  assert.strictEqual(r.saldo_nao_fiscal, 50);
  assert.strictEqual(r.origem, 'baixa_venda');
  await closeDb(db);
}

async function test02VendaNaoFiscal() {
  const { db, produtoId, empresaId } = await setup(100, 50);
  const r = await debitoAsync(db, {
    produtoId,
    quantidadeFiscal: 0,
    quantidadeNaoFiscal: 15,
    empresaId,
    origem: 'baixa_venda'
  });
  assert.strictEqual(r.saldo_fiscal, 100);
  assert.strictEqual(r.saldo_nao_fiscal, 35);
  await closeDb(db);
}

async function test03VendaMista() {
  const { db, produtoId, empresaId } = await setup(100, 50);
  const r = await debitoAsync(db, {
    produtoId,
    quantidadeFiscal: 30,
    quantidadeNaoFiscal: 10,
    empresaId,
    origem: 'baixa_venda'
  });
  assert.strictEqual(r.saldo_fiscal, 70);
  assert.strictEqual(r.saldo_nao_fiscal, 40);
  assert.strictEqual(r.quantidade_fiscal, 30);
  assert.strictEqual(r.quantidade_nao_fiscal, 10);
  await closeDb(db);
}

async function test04FiscalNaoAlteraNF() {
  const { db, produtoId, empresaId } = await setup(100, 50);
  await debitoAsync(db, {
    produtoId,
    quantidadeFiscal: 12,
    quantidadeNaoFiscal: 0,
    empresaId
  });
  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.saldo_nao_fiscal, 50);
  await closeDb(db);
}

async function test05NFNaoAlteraFiscal() {
  const { db, produtoId, empresaId } = await setup(100, 50);
  await debitoAsync(db, {
    produtoId,
    quantidadeFiscal: 0,
    quantidadeNaoFiscal: 8,
    empresaId
  });
  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.saldo_fiscal, 100);
  await closeDb(db);
}

async function test06QuantidadesJaDistribuidas() {
  const pagamento = fs.readFileSync(SRC_PAGAMENTO, 'utf8');
  const distribuidor = fs.readFileSync(SRC_DISTRIBUIDOR, 'utf8');

  assert.ok(pagamento.includes("require('../distribuidorEstoqueVenda')"));
  assert.ok(distribuidor.includes('function distribuirItemVenda') || distribuidor.includes('distribuirItensVenda'));

  const baixa = secaoBaixa(pagamento);
  assert.ok(
    !/distribuirItensVenda|distribuirItemVenda/.test(baixa),
    'baixa não deve recalcular distribuição'
  );

  const calls = pagamento.match(
    /reduzirEstoqueDistribuido\([^)]*item\.quantidade_fiscal,\s*item\.quantidade_nao_fiscal/g
  ) || [];
  assert.strictEqual(calls.length, 2, 'prazo e à vista usam quantidades já distribuídas');
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

  const opts = montarOpcoesBaixaEstoqueVenda(
    { empresaId: 4, body: { empresa_id: 9 }, user: { id: 9 } },
    'baixa_venda',
    db
  );
  assert.strictEqual(opts.empresaId, 4);
  assert.strictEqual(opts.usuarioId, 9);

  const soBody = montarOpcoesBaixaEstoqueVenda(
    { body: { empresa_id: 4 }, user: { id: 9 } },
    'baixa_venda',
    db
  );
  assert.strictEqual(soBody.empresaId, null);
  await closeDb(db);
}

async function test08Compat() {
  const { db, produtoId } = await setup();
  const r = await debitoAsync(db, {
    produtoId,
    quantidadeFiscal: 2
  });
  assert.strictEqual(r.legado, true);
  assert.strictEqual(r.motivo_compat, MOTIVO_COMPAT_DEBITO_VENDA);

  await assertRejects(
    debitoAsync(db, { produtoId, quantidadeFiscal: 1, exigirEmpresa: true }),
    'EMPRESA_OBRIGATORIA'
  );

  const semEmpresa = montarOpcoesBaixaEstoqueVenda({ body: {}, user: {} }, 'baixa_venda', db);
  assert.strictEqual(semEmpresa.empresaId, null);
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
  const mid = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(mid.saldo_fiscal, 75);
  assert.strictEqual(mid.saldo_nao_fiscal, 40);
  await run(db, 'ROLLBACK');
  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.saldo_fiscal, 100);
  assert.strictEqual(row.saldo_nao_fiscal, 50);
  assert.strictEqual(row.estoque_atual, 150);
  await closeDb(db);
}

async function test10SemDebitoDuplicado() {
  const porta = fs.readFileSync(SRC_PORTA, 'utf8');
  const pagamento = fs.readFileSync(SRC_PAGAMENTO, 'utf8');
  const baixa = secaoBaixa(pagamento);

  assert.ok(porta.includes('estoqueSaldosPublico'));
  assert.ok(porta.includes('debitarSaldo'));
  assert.ok(pagamento.includes('debitarEstoqueItemVenda'));
  assert.ok(pagamento.includes('montarOpcoesBaixaEstoqueVenda'));

  const calls = (pagamento.match(/debitarEstoqueItemVenda\s*\(/g) || []).length;
  assert.strictEqual(calls, 1, 'único caminho de débito: atualizarSaldoProdutoAposBaixa');

  assert.ok(!/saldo_fiscal\s*=\s*saldo_fiscal\s*-/i.test(baixa));
  assert.ok(!/saldo_nao_fiscal\s*=\s*saldo_nao_fiscal\s*-/i.test(baixa));
  assert.ok(!/estoque_atual\s*=\s*\(saldo_fiscal\s*-/i.test(baixa));
  assert.ok(!/UPDATE\s+produtos/i.test(baixa));
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
  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.estoque_atual, row.saldo_fiscal + row.saldo_nao_fiscal);
  await closeDb(db);
}

async function test12ScanSqlFluxoMigrado() {
  const pagamento = fs.readFileSync(SRC_PAGAMENTO, 'utf8');
  const porta = fs.readFileSync(SRC_PORTA, 'utf8');
  const baixa = secaoBaixa(pagamento);

  assert.ok(!/SET\s+saldo_fiscal/i.test(baixa));
  assert.ok(!/SET\s+saldo_nao_fiscal/i.test(baixa));
  assert.ok(!/SET\s+estoque_atual/i.test(baixa));
  assert.ok(!/UPDATE\s+produtos/i.test(porta));

  // SELECT de saldo para distribuição permanece (não é escrita)
  assert.ok(/SELECT[\s\S]*saldo_fiscal[\s\S]*saldo_nao_fiscal/i.test(pagamento));
}

async function main() {
  const testes = [
    ['01 venda fiscal', test01VendaFiscal],
    ['02 venda nao fiscal', test02VendaNaoFiscal],
    ['03 venda mista', test03VendaMista],
    ['04 F nao altera NF', test04FiscalNaoAlteraNF],
    ['05 NF nao altera F', test05NFNaoAlteraFiscal],
    ['06 quantidades já distribuídas', test06QuantidadesJaDistribuidas],
    ['07 empresaId', test07EmpresaPropagada],
    ['08 COMPAT', test08Compat],
    ['09 rollback', test09Rollback],
    ['10 sem débito duplicado', test10SemDebitoDuplicado],
    ['11 EA = SF+SNF', test11EstoqueAtual],
    ['12 scan SQL fluxo migrado', test12ScanSqlFluxoMigrado]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\ndebito-baixa-venda-porta-publica: ${ok}/${testes.length} OK`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
