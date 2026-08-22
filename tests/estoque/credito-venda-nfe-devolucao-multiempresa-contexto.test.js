/**
 * Fase 2 / Implementação 03.31 — domínio corrigido:
 * crédito de estoque de venda (cancelamento / devolução / NF-e).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const {
  creditarEstoqueItemVenda,
  montarOpcoesRetornoEstoqueVenda,
  montarOptsPortaCreditoVenda,
  MOTIVO_COMPAT_CREDITO_VENDA
} = require('../../backend/services/vendas/creditoEstoqueVendaViaPorta');
const {
  reverterEstoqueNfeDevolucaoVenda,
  montarOptsPortaRevertDevolucaoVenda
} = require('../../backend/services/fiscal/estoqueNfeDevolucaoVenda');
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

function creditoAsync(db, dados) {
  return new Promise((resolve, reject) => {
    creditarEstoqueItemVenda(db, dados, (err, r) => (err ? reject(err) : resolve(r)));
  });
}

async function setup(sf = 100, snf = 40) {
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
    `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual)
     VALUES ('X', ?, ?, ?)`,
    [sf, snf, sf + snf]
  );
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const b = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  return { db, produtoId: p.lastID, empresaA: a, empresaB: b };
}

async function ee(db, produtoId, empresaId) {
  return get(
    db,
    'SELECT * FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?',
    [produtoId, empresaId]
  );
}

async function seedNotaRevert(db, produtoId) {
  await run(db, `
    CREATE TABLE IF NOT EXISTS vendas_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venda_id INTEGER,
      produto_id INTEGER,
      quantidade REAL,
      quantidade_fiscal REAL,
      quantidade_nao_fiscal REAL
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS nfe_devolucoes_venda (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venda_id INTEGER,
      status TEXT,
      estoque_retornado INTEGER DEFAULT 0
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS nfe_devolucao_venda_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nfe_devolucao_id INTEGER,
      venda_id INTEGER,
      venda_item_id INTEGER,
      produto_id INTEGER,
      quantidade REAL,
      quantidade_vendida REAL,
      estoque_retornado INTEGER DEFAULT 0
    )
  `);
  const vi = await run(
    db,
    `INSERT INTO vendas_itens (venda_id, produto_id, quantidade, quantidade_fiscal, quantidade_nao_fiscal)
     VALUES (1, ?, 5, 5, 0)`,
    [produtoId]
  );
  const nota = await run(
    db,
    `INSERT INTO nfe_devolucoes_venda (venda_id, status, estoque_retornado) VALUES (1, 'autorizada', 1)`
  );
  await run(
    db,
    `INSERT INTO nfe_devolucao_venda_itens
      (nfe_devolucao_id, venda_id, venda_item_id, produto_id, quantidade, quantidade_vendida, estoque_retornado)
     VALUES (?, 1, ?, ?, 5, 5, 1)`,
    [nota.lastID, vi.lastID, produtoId]
  );
  return nota.lastID;
}

async function test01CompatBodyNaoInventaEmpresa() {
  const { db, produtoId } = await setup();
  const req = { empresaId: null, body: { empresaId: 99 }, query: { empresaId: 99 } };
  const opts = montarOpcoesRetornoEstoqueVenda(req, 'cancelamento_venda', db);
  assert.strictEqual(opts.empresaId, null);
  const r = await creditoAsync(db, {
    produtoId,
    quantidadeFiscal: 3,
    empresaId: opts.empresaId
  });
  assert.strictEqual(r.legado, true);
  assert.strictEqual(r.motivo_compat, MOTIVO_COMPAT_CREDITO_VENDA);
  const n = await get(db, 'SELECT COUNT(*) AS c FROM estoque_empresa');
  assert.strictEqual(n.c, 0);
  await closeDb(db);
}

async function test02ReqEmpresaIdChega() {
  const { db, produtoId, empresaA } = await setup();
  const opts = montarOpcoesRetornoEstoqueVenda(
    { empresaId: empresaA.id, body: { empresaId: 9 } },
    'devolucao_venda',
    db
  );
  assert.strictEqual(opts.empresaId, empresaA.id);
  const r = await creditoAsync(db, {
    produtoId,
    quantidadeFiscal: 2,
    empresaId: opts.empresaId
  });
  assert.strictEqual(r.empresa_id, empresaA.id);
  assert.strictEqual(r.legado, false);
  await closeDb(db);
}

async function test03BodyNaoSubstitui() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  const opts = montarOpcoesRetornoEstoqueVenda(
    { empresaId: empresaA.id, body: { empresaId: empresaB.id, empresa_id: empresaB.id } },
    'cancelamento_venda',
    db
  );
  assert.strictEqual(opts.empresaId, empresaA.id);
  const porta = montarOptsPortaCreditoVenda(db, {
    empresaId: opts.empresaId,
    body: { empresaId: empresaB.id },
    contexto: { empresaId: empresaB.id }
  });
  assert.strictEqual(porta.empresaId, empresaA.id);
  await creditoAsync(db, { produtoId, quantidadeFiscal: 1, empresaId: opts.empresaId });
  const a = await ee(db, produtoId, empresaA.id);
  const b = await ee(db, produtoId, empresaB.id);
  assert.ok(a);
  assert.strictEqual(b, null);
  await closeDb(db);
}

async function test04QueryNaoSubstitui() {
  const { db, empresaA, empresaB } = await setup();
  const opts = montarOpcoesRetornoEstoqueVenda(
    { empresaId: empresaA.id, query: { empresaId: empresaB.id } },
    'devolucao_venda',
    db
  );
  assert.strictEqual(opts.empresaId, empresaA.id);
  await closeDb(db);
}

async function test05IsolamentoAB() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaA.id, saldo_fiscal: 10, estoque_atual: 10
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaB.id, saldo_fiscal: 20, estoque_atual: 20
  }, { db });
  await creditoAsync(db, {
    produtoId,
    quantidadeFiscal: 3,
    empresaId: empresaA.id
  });
  const a = await ee(db, produtoId, empresaA.id);
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(a.saldo_fiscal, 13);
  assert.strictEqual(b.saldo_fiscal, 20);
  await closeDb(db);
}

async function test06NfeRevertSoEmpresaId() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  const notaId = await seedNotaRevert(db, produtoId);
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaA.id, saldo_fiscal: 50, estoque_atual: 50
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaB.id, saldo_fiscal: 80, estoque_atual: 80
  }, { db });
  const leak = montarOptsPortaRevertDevolucaoVenda(db, {
    contexto: { empresaId: empresaB.id },
    ctx: { empresaId: empresaB.id },
    body: { empresaId: empresaB.id }
  });
  assert.strictEqual(leak.empresaId, undefined);
  assert.strictEqual(leak.legado, true);
  await reverterEstoqueNfeDevolucaoVenda(notaId, { db, empresaId: empresaA.id });
  const a = await ee(db, produtoId, empresaA.id);
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(a.saldo_fiscal, 45);
  assert.strictEqual(b.saldo_fiscal, 80);
  await closeDb(db);
}

async function test07WiringHttpNfe() {
  const vendas = fs.readFileSync(path.join(ROOT, 'backend/rotas/vendas.js'), 'utf8');
  const nfe = fs.readFileSync(path.join(ROOT, 'backend/services/fiscal/nfeDevolucaoVenda.js'), 'utf8');
  const life = fs.readFileSync(
    path.join(ROOT, 'backend/services/fiscal/nfeDevolucaoLifecycleVenda.js'),
    'utf8'
  );
  const credito = fs.readFileSync(
    path.join(ROOT, 'backend/services/vendas/creditoEstoqueVendaViaPorta.js'),
    'utf8'
  );
  const devolucao = fs.readFileSync(
    path.join(ROOT, 'backend/services/vendas/VendaDevolucaoService.js'),
    'utf8'
  );
  const estoqueNfe = fs.readFileSync(
    path.join(ROOT, 'backend/services/fiscal/estoqueNfeDevolucaoVenda.js'),
    'utf8'
  );

  assert.ok(vendas.includes('empresaId: resolverEmpresaId(req.empresaId)'));
  assert.ok(nfe.includes('empresaId: opcoes.empresaId'));
  assert.ok(nfe.includes('retornarEstoqueNfeDevolucaoVenda(notaId, {'));
  assert.ok(life.includes('empresaId'));
  assert.ok(credito.includes('resolverEmpresaId(req && req.empresaId)'));
  assert.ok(credito.includes('resolverEmpresaId(opcoes.empresaId)'));
  assert.ok(!credito.includes('empresaIdDoReqOperacional'));
  assert.ok(!devolucao.includes('contexto: opcoes.contexto'));
  assert.ok(estoqueNfe.includes('devolverSaldosDistribuidos(produtoId, qtdFiscal, qtdNaoFiscal,'));
  assert.ok(estoqueNfe.includes('optsCredito'));
  await Promise.resolve();
}

async function test08Rollback() {
  const { db, produtoId, empresaA } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaA.id, saldo_fiscal: 10, estoque_atual: 10
  }, { db });
  await run(db, 'BEGIN');
  await creditoAsync(db, { produtoId, quantidadeFiscal: 5, empresaId: empresaA.id });
  const midProd = await get(db, 'SELECT saldo_fiscal FROM produtos WHERE id = ?', [produtoId]);
  const midEe = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(midProd.saldo_fiscal, 105);
  assert.strictEqual(midEe.saldo_fiscal, 15);
  await run(db, 'ROLLBACK');
  const prod = await get(db, 'SELECT saldo_fiscal FROM produtos WHERE id = ?', [produtoId]);
  const iso = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(prod.saldo_fiscal, 100);
  assert.strictEqual(iso.saldo_fiscal, 10);
  await closeDb(db);
}

async function main() {
  const testes = [
    ['01 COMPAT body nao inventa empresa', test01CompatBodyNaoInventaEmpresa],
    ['02 req.empresaId chega ao credito', test02ReqEmpresaIdChega],
    ['03 body nao substitui', test03BodyNaoSubstitui],
    ['04 query nao substitui', test04QueryNaoSubstitui],
    ['05 isolamento A/B', test05IsolamentoAB],
    ['06 NF-e revert so empresaId', test06NfeRevertSoEmpresaId],
    ['07 wiring HTTP / NF-e', test07WiringHttpNfe],
    ['08 rollback da transacao do caller', test08Rollback]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  ok ${nome}`);
  }
  console.log(`\ncredito-venda-nfe-devolucao-multiempresa-contexto: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
