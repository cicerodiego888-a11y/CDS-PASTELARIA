/**
 * Fase 1 / Implementação 02.5 — Cancelamento/Devolução de venda via porta pública.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const {
  creditarEstoqueItemVenda,
  MOTIVO_COMPAT_CREDITO_VENDA,
  extrairEmpresaIdDeReq,
  montarOpcoesRetornoEstoqueVenda
} = require('../../backend/services/vendas/creditoEstoqueVendaViaPorta');

const SRC_PORTA = path.resolve(
  __dirname,
  '../../backend/services/vendas/creditoEstoqueVendaViaPorta.js'
);
const SRC_DEVOLUCAO = path.resolve(
  __dirname,
  '../../backend/services/vendas/VendaDevolucaoService.js'
);
const SRC_CANCELAMENTO = path.resolve(
  __dirname,
  '../../backend/services/vendas/VendaCancelamentoService.js'
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

function creditoAsync(db, dados) {
  return new Promise((resolve, reject) => {
    creditarEstoqueItemVenda(db, dados, (err, result) => (
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
  const { db, produtoId, empresaId } = await setup(70, 40);
  const r = await creditoAsync(db, {
    produtoId,
    quantidadeFiscal: 10,
    quantidadeNaoFiscal: 0,
    empresaId,
    origem: 'cancelamento_venda'
  });
  assert.strictEqual(r.saldo_fiscal, 80);
  assert.strictEqual(r.saldo_nao_fiscal, 40);
  assert.strictEqual(r.origem, 'cancelamento_venda');
  await closeDb(db);
}

async function test02CancelNaoFiscal() {
  const { db, produtoId, empresaId } = await setup(70, 40);
  const r = await creditoAsync(db, {
    produtoId,
    quantidadeFiscal: 0,
    quantidadeNaoFiscal: 8,
    empresaId,
    origem: 'cancelamento_venda'
  });
  assert.strictEqual(r.saldo_fiscal, 70);
  assert.strictEqual(r.saldo_nao_fiscal, 48);
  await closeDb(db);
}

async function test03DevFiscal() {
  const { db, produtoId, empresaId } = await setup(70, 40);
  const r = await creditoAsync(db, {
    produtoId,
    quantidadeFiscal: 12,
    quantidadeNaoFiscal: 0,
    empresaId,
    origem: 'devolucao_venda'
  });
  assert.strictEqual(r.saldo_fiscal, 82);
  assert.strictEqual(r.saldo_nao_fiscal, 40);
  assert.strictEqual(r.origem, 'devolucao_venda');
  await closeDb(db);
}

async function test04DevNaoFiscal() {
  const { db, produtoId, empresaId } = await setup(70, 40);
  const r = await creditoAsync(db, {
    produtoId,
    quantidadeFiscal: 0,
    quantidadeNaoFiscal: 6,
    empresaId,
    origem: 'devolucao_venda'
  });
  assert.strictEqual(r.saldo_fiscal, 70);
  assert.strictEqual(r.saldo_nao_fiscal, 46);
  await closeDb(db);
}

async function test05FiscalNaoAlteraNF() {
  const { db, produtoId, empresaId } = await setup(100, 50);
  await creditoAsync(db, {
    produtoId,
    quantidadeFiscal: 15,
    quantidadeNaoFiscal: 0,
    empresaId
  });
  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.saldo_nao_fiscal, 50);
  await closeDb(db);
}

async function test06NFNaoAlteraFiscal() {
  const { db, produtoId, empresaId } = await setup(100, 50);
  await creditoAsync(db, {
    produtoId,
    quantidadeFiscal: 0,
    quantidadeNaoFiscal: 9,
    empresaId
  });
  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.saldo_fiscal, 100);
  await closeDb(db);
}

async function test07EmpresaPropagada() {
  const { db, produtoId, empresaId } = await setup();
  const r = await creditoAsync(db, {
    produtoId,
    quantidadeFiscal: 1,
    empresaId
  });
  assert.strictEqual(r.empresa_id, empresaId);
  assert.strictEqual(r.legado, false);

  const viaBody = extrairEmpresaIdDeReq({ body: { empresa_id: 7 } });
  assert.strictEqual(viaBody, 7);
  const viaUser = extrairEmpresaIdDeReq({ user: { empresaId: 3 } });
  assert.strictEqual(viaUser, 3);
  const opts = montarOpcoesRetornoEstoqueVenda(
    { body: { empresaId: 9 }, user: { id: 4 } },
    'cancelamento_venda',
    db
  );
  assert.strictEqual(opts.empresaId, 9);
  assert.strictEqual(opts.usuarioId, 4);
  assert.strictEqual(opts.origem, 'cancelamento_venda');
  await closeDb(db);
}

async function test08Compat() {
  const { db, produtoId } = await setup();
  const r = await creditoAsync(db, {
    produtoId,
    quantidadeFiscal: 2
  });
  assert.strictEqual(r.legado, true);
  assert.strictEqual(r.motivo_compat, MOTIVO_COMPAT_CREDITO_VENDA);

  await assertRejects(
    creditoAsync(db, { produtoId, quantidadeFiscal: 1, exigirEmpresa: true }),
    'EMPRESA_OBRIGATORIA'
  );

  const semEmpresa = montarOpcoesRetornoEstoqueVenda({ body: {}, user: {} }, 'devolucao_venda', db);
  assert.strictEqual(semEmpresa.empresaId, null);
  await closeDb(db);
}

async function test09Rollback() {
  const { db, produtoId, empresaId } = await setup(100, 50);
  await run(db, 'BEGIN');
  await creditoAsync(db, {
    produtoId,
    quantidadeFiscal: 25,
    quantidadeNaoFiscal: 10,
    empresaId
  });
  const mid = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(mid.saldo_fiscal, 125);
  assert.strictEqual(mid.saldo_nao_fiscal, 60);
  await run(db, 'ROLLBACK');
  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.saldo_fiscal, 100);
  assert.strictEqual(row.saldo_nao_fiscal, 50);
  assert.strictEqual(row.estoque_atual, 150);
  await closeDb(db);
}

async function test10SemRetornoDuplicado() {
  const porta = fs.readFileSync(SRC_PORTA, 'utf8');
  const devolucao = fs.readFileSync(SRC_DEVOLUCAO, 'utf8');
  const cancelamento = fs.readFileSync(SRC_CANCELAMENTO, 'utf8');

  assert.ok(porta.includes('estoqueSaldosPublico'));
  assert.ok(porta.includes('creditarSaldo'));
  assert.ok(devolucao.includes('creditarEstoqueItemVenda'));
  assert.ok(cancelamento.includes('devolverEstoqueItensVenda'));
  assert.ok(cancelamento.includes('montarOpcoesRetornoEstoqueVenda'));

  const callsPorta = (devolucao.match(/creditarEstoqueItemVenda\s*\(/g) || []).length;
  assert.strictEqual(callsPorta, 1, 'único caminho de crédito: devolverSaldosDistribuidos');

  const callsCancel = (cancelamento.match(/devolverEstoqueItensVenda\s*\(/g) || []).length;
  assert.strictEqual(callsCancel, 2, 'PUT e POST de cancelamento usam o mesmo retorno');

  assert.ok(
    !/saldo_fiscal\s*=\s*saldo_fiscal\s*\+/i.test(devolucao),
    'devolução não deve UPDATE saldo_fiscal'
  );
  assert.ok(
    !/saldo_nao_fiscal\s*=\s*saldo_nao_fiscal\s*\+/i.test(devolucao),
    'devolução não deve UPDATE saldo_nao_fiscal'
  );
  assert.ok(
    !/estoque_atual\s*=\s*\(saldo_fiscal\s*\+/i.test(devolucao),
    'devolução não deve calcular estoque_atual manualmente'
  );
  assert.ok(
    !/UPDATE\s+produtos[\s\S]{0,400}saldo_fiscal/i.test(cancelamento),
    'cancelamento não deve UPDATE produtos.saldo_*'
  );
}

async function test11EstoqueAtual() {
  const { db, produtoId, empresaId } = await setup(100, 50);
  const r = await creditoAsync(db, {
    produtoId,
    quantidadeFiscal: 20,
    quantidadeNaoFiscal: 10,
    empresaId
  });
  assert.strictEqual(r.estoque_atual, r.saldo_fiscal + r.saldo_nao_fiscal);
  assert.strictEqual(r.estoque_atual, 180);
  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.estoque_atual, row.saldo_fiscal + row.saldo_nao_fiscal);
  await closeDb(db);
}

async function test12ScanSqlFluxosMigrados() {
  const devolucao = fs.readFileSync(SRC_DEVOLUCAO, 'utf8');
  const cancelamento = fs.readFileSync(SRC_CANCELAMENTO, 'utf8');
  const porta = fs.readFileSync(SRC_PORTA, 'utf8');

  assert.ok(!/SET\s+saldo_fiscal/i.test(devolucao));
  assert.ok(!/SET\s+saldo_nao_fiscal/i.test(devolucao));
  assert.ok(!/SET\s+estoque_atual/i.test(devolucao));
  assert.ok(!/SET\s+saldo_fiscal/i.test(cancelamento));
  assert.ok(!/SET\s+saldo_nao_fiscal/i.test(cancelamento));
  assert.ok(!/SET\s+estoque_atual/i.test(cancelamento));
  assert.ok(!/UPDATE\s+produtos/i.test(porta), 'adaptador não escreve produtos diretamente');

  assert.ok(devolucao.includes('resolverQuantidadesVendaItem'));
  assert.ok(devolucao.includes('calcularDevolucaoVendaFiscalPrimeiro'));
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
    ['10 sem retorno duplicado', test10SemRetornoDuplicado],
    ['11 EA = SF+SNF', test11EstoqueAtual],
    ['12 scan SQL fluxos migrados', test12ScanSqlFluxosMigrados]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\ncredito-cancel-dev-venda-porta-publica: ${ok}/${testes.length} OK`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
