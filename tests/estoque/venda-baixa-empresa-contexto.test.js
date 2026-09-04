/**
 * Fase 2 / Implementação 03.25 — empresaId da venda até a baixa 02.6.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const {
  debitarEstoqueItemVenda,
  montarOpcoesBaixaEstoqueVenda
} = require('../../backend/services/vendas/debitoEstoqueVendaViaPorta');
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

function debitoAsync(db, dados) {
  return new Promise((resolve, reject) => {
    debitarEstoqueItemVenda(db, dados, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

async function baixarComoVenda(db, req, dadosItem) {
  const opts = montarOpcoesBaixaEstoqueVenda(req, 'baixa_venda', db);
  return debitoAsync(db, {
    produtoId: dadosItem.produtoId,
    quantidadeFiscal: dadosItem.quantidadeFiscal || 0,
    quantidadeNaoFiscal: dadosItem.quantidadeNaoFiscal || 0,
    empresaId: opts.empresaId,
    usuarioId: opts.usuarioId,
    origem: opts.origem,
    db: opts.db
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

async function test01CompatSemEmpresa() {
  const { db, produtoId } = await setup();
  const req = { empresaId: null, body: { empresaId: 99 }, query: { empresaId: 99 } };
  const r = await baixarComoVenda(db, req, { produtoId, quantidadeFiscal: 3 });
  assert.strictEqual(r.legado, true);
  const prod = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.saldo_fiscal, 97);
  const n = await get(db, 'SELECT COUNT(*) AS c FROM estoque_empresa');
  assert.strictEqual(n.c, 0);
  await closeDb(db);
}

async function test02EmpresaAPropaga() {
  const { db, produtoId, empresaA } = await setup();
  const opts = montarOpcoesBaixaEstoqueVenda(
    { empresaId: empresaA.id, body: {}, query: {} },
    'baixa_venda',
    db
  );
  assert.strictEqual(opts.empresaId, empresaA.id);
  const r = await baixarComoVenda(db, { empresaId: empresaA.id }, {
    produtoId, quantidadeFiscal: 3
  });
  assert.strictEqual(r.empresa_id, empresaA.id);
  assert.strictEqual(r.legado, false);
  await closeDb(db);
}

async function test03EmpresaBPropaga() {
  const { db, produtoId, empresaB } = await setup();
  const r = await baixarComoVenda(db, { empresaId: empresaB.id }, {
    produtoId, quantidadeFiscal: 1
  });
  assert.strictEqual(r.empresa_id, empresaB.id);
  await closeDb(db);
}

async function test04AlteraSomenteA() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaA.id, saldo_fiscal: 10, estoque_atual: 10
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaB.id, saldo_fiscal: 20, estoque_atual: 20
  }, { db });
  await baixarComoVenda(db, { empresaId: empresaA.id }, {
    produtoId, quantidadeFiscal: 3
  });
  const a = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(a.saldo_fiscal, 7);
  await closeDb(db);
}

async function test05BIntacto() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaA.id, saldo_fiscal: 10, estoque_atual: 10
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaB.id, saldo_fiscal: 20, estoque_atual: 20
  }, { db });
  await baixarComoVenda(db, { empresaId: empresaA.id }, {
    produtoId, quantidadeFiscal: 3
  });
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(b.saldo_fiscal, 20);
  await closeDb(db);
}

async function test06BodyNaoSubstitui() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  const opts = montarOpcoesBaixaEstoqueVenda({
    empresaId: empresaA.id,
    body: { empresaId: empresaB.id, empresa_id: empresaB.id },
    query: {}
  }, 'baixa_venda', db);
  assert.strictEqual(opts.empresaId, empresaA.id);
  assert.notStrictEqual(opts.empresaId, empresaB.id);
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaA.id, saldo_fiscal: 10, estoque_atual: 10
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaB.id, saldo_fiscal: 20, estoque_atual: 20
  }, { db });
  await baixarComoVenda(db, {
    empresaId: empresaA.id,
    body: { empresaId: empresaB.id }
  }, { produtoId, quantidadeFiscal: 3 });
  const a = await ee(db, produtoId, empresaA.id);
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(a.saldo_fiscal, 7);
  assert.strictEqual(b.saldo_fiscal, 20);
  await closeDb(db);
}

async function test07QueryNaoSubstitui() {
  const { db, empresaA, empresaB } = await setup();
  const opts = montarOpcoesBaixaEstoqueVenda({
    empresaId: empresaA.id,
    body: {},
    query: { empresaId: empresaB.id }
  }, 'baixa_venda', db);
  assert.strictEqual(opts.empresaId, empresaA.id);
  await closeDb(db);
}

async function test08BaixaFiscalEmpresa() {
  const { db, produtoId, empresaA } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaA.id, saldo_fiscal: 10, saldo_nao_fiscal: 8, estoque_atual: 18
  }, { db });
  await baixarComoVenda(db, { empresaId: empresaA.id }, {
    produtoId, quantidadeFiscal: 4
  });
  const a = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(a.saldo_fiscal, 6);
  assert.strictEqual(a.saldo_nao_fiscal, 8);
  await closeDb(db);
}

async function test09BaixaNaoFiscalEmpresa() {
  const { db, produtoId, empresaA } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaA.id, saldo_fiscal: 10, saldo_nao_fiscal: 8, estoque_atual: 18
  }, { db });
  await baixarComoVenda(db, { empresaId: empresaA.id }, {
    produtoId, quantidadeNaoFiscal: 2
  });
  const a = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(a.saldo_fiscal, 10);
  assert.strictEqual(a.saldo_nao_fiscal, 6);
  await closeDb(db);
}

async function test10ProdutosDualWrite() {
  const { db, produtoId, empresaA } = await setup(100, 40);
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaA.id, saldo_fiscal: 10, estoque_atual: 10
  }, { db });
  await baixarComoVenda(db, { empresaId: empresaA.id }, {
    produtoId, quantidadeFiscal: 3
  });
  const prod = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.saldo_fiscal, 97);
  const iso = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(iso.saldo_fiscal, 7);
  assert.notStrictEqual(iso.saldo_fiscal, prod.saldo_fiscal);
  await closeDb(db);
}

async function test11Rollback() {
  const { db, produtoId, empresaA } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaA.id, saldo_fiscal: 10, estoque_atual: 10
  }, { db });
  await run(db, 'BEGIN');
  await baixarComoVenda(db, { empresaId: empresaA.id }, {
    produtoId, quantidadeFiscal: 5
  });
  const midProd = await get(db, 'SELECT saldo_fiscal FROM produtos WHERE id = ?', [produtoId]);
  const midEe = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(midProd.saldo_fiscal, 95);
  assert.strictEqual(midEe.saldo_fiscal, 5);
  await run(db, 'ROLLBACK');
  const prod = await get(db, 'SELECT saldo_fiscal FROM produtos WHERE id = ?', [produtoId]);
  const iso = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(prod.saldo_fiscal, 100);
  assert.strictEqual(iso.saldo_fiscal, 10);
  await closeDb(db);
}

async function test12LegadoEWiring() {
  const { db, produtoId } = await setup();
  const r = await baixarComoVenda(db, { empresaId: null, body: {} }, {
    produtoId, quantidadeFiscal: 2
  });
  assert.strictEqual(r.legado, true);
  const prod = await get(db, 'SELECT saldo_fiscal FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.saldo_fiscal, 98);

  const pag = fs.readFileSync(
    path.join(ROOT, 'backend/services/vendas/VendaPagamentoService.js'),
    'utf8'
  );
  const calls = pag.split('reduzirEstoqueDistribuido(').slice(1);
  assert.ok(calls.length >= 2);
  for (const trecho of calls) {
    if (trecho.trim().startsWith('vendaItemId,')) continue;
    assert.ok(
      trecho.includes('opcoesBaixaEstoque'),
      'cada caller de baixa deve receber opcoesBaixaEstoque'
    );
  }
  assert.ok(pag.includes('montarOpcoesBaixaEstoqueVenda(req'));
  assert.ok(!pag.includes('contexto: opcoes.contexto'));

  const baixa = fs.readFileSync(
    path.join(ROOT, 'backend/services/vendas/debitoEstoqueVendaViaPorta.js'),
    'utf8'
  );
  assert.ok(baixa.includes('resolverEmpresaId(req && req.empresaIdVenda)'));
  assert.ok(baixa.includes('resolverEmpresaId(req && req.empresaId)'));
  assert.ok(baixa.includes('estoqueSaldosPublico.debitarSaldo'));
  assert.ok(!baixa.includes('extrairEmpresaIdDeReq'));

  const porta = fs.readFileSync(
    path.join(ROOT, 'backend/services/fiscalNaoFiscal/estoqueSaldosPublico.js'),
    'utf8'
  );
  assert.ok(porta.includes('debitarSaldo'));

  await closeDb(db);
}

async function main() {
  const testes = [
    ['01 COMPAT sem empresa', test01CompatSemEmpresa],
    ['02 empresa A propaga', test02EmpresaAPropaga],
    ['03 empresa B propaga', test03EmpresaBPropaga],
    ['04 altera somente A', test04AlteraSomenteA],
    ['05 B intacto', test05BIntacto],
    ['06 body nao substitui', test06BodyNaoSubstitui],
    ['07 query nao substitui', test07QueryNaoSubstitui],
    ['08 baixa fiscal empresa', test08BaixaFiscalEmpresa],
    ['09 baixa nao fiscal empresa', test09BaixaNaoFiscalEmpresa],
    ['10 produtos dual-write 03.19', test10ProdutosDualWrite],
    ['11 rollback', test11Rollback],
    ['12 legado e wiring', test12LegadoEWiring]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\nvenda-baixa-empresa-contexto: ${ok}/${testes.length} OK`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
