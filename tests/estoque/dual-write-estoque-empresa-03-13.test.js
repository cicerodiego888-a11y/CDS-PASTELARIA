/**
 * Fase 2 / Implementação 03.13 — primeiro dual-write controlado.
 *
 * Fluxo: CREATE produto / saldo inicial (03.8)
 *   porta pública → produtos  +  EstoqueEmpresaService → estoque_empresa
 * Sem backfill. Sem redirecionar leitura. Sem migrar compra/venda/PDV.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const {
  aplicarSaldoInicialCreateProduto,
  MOTIVO_COMPAT_CREATE_PRODUTO_SALDO_INICIAL
} = require('../../backend/services/ajusteEstoqueService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const {
  garantirSchemaEstoqueEmpresaAsync
} = require('../../backend/services/estoque/estoqueEmpresaSchema');
const {
  garantirSchemaEmpresasAsync
} = require('../../backend/services/empresas/empresasSchema');
const saldosPublico = require('../../backend/services/fiscalNaoFiscal/estoqueSaldosPublico');

const ROOT = path.resolve(__dirname, '../..');
const SRC_AJUSTE = path.join(ROOT, 'backend/services/ajusteEstoqueService.js');
const SRC_PORTA = path.join(ROOT, 'backend/services/fiscalNaoFiscal/estoqueSaldosPublico.js');
const SRC_RESERVA = path.join(ROOT, 'backend/services/fiscalNaoFiscal/reservasPublico.js');
const SRC_PRODUTOS = path.join(ROOT, 'backend/rotas/produtos.js');
const SRC_COMPRAS = path.join(ROOT, 'backend/rotas/compras.js');
const SRC_VENDAS = path.join(ROOT, 'backend/services/vendas/debitoEstoqueVendaViaPorta.js');
const SRC_PDV = path.join(ROOT, 'backend/services/estoque/EstoqueReservaService.js');
const SRC_REPAIR = path.join(ROOT, 'backend/motores/comercial/ReservaRepairService.js');
const SRC_SERVICE = path.join(ROOT, 'backend/services/estoque/EstoqueEmpresaService.js');

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

function aplicarAsync(db, opcoes) {
  return new Promise((resolve, reject) => {
    aplicarSaldoInicialCreateProduto(db, opcoes, (err, result) => (
      err ? reject(err) : resolve(result)
    ));
  });
}

async function setup() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
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
  await garantirSchemaEstoqueEmpresaAsync(db);
  const empA = await run(db, `INSERT INTO empresas (cnpj, razao_social) VALUES ('11222333000181', 'A')`);
  const empB = await run(db, `INSERT INTO empresas (cnpj, razao_social) VALUES ('04252011000110', 'B')`);
  return { db, empresaA: empA.lastID, empresaB: empB.lastID };
}

async function criarProdutoZerado(db, nome = 'Novo') {
  const r = await run(
    db,
    `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual)
     VALUES (?, 0, 0, 0)`,
    [nome]
  );
  return r.lastID;
}

async function test01ProdutosContinuaOficial() {
  const { db, empresaA } = await setup();
  const produtoId = await criarProdutoZerado(db);
  const r = await aplicarAsync(db, {
    produtoId,
    saldoFiscal: 12,
    saldoNaoFiscal: 0,
    empresaId: empresaA
  });
  assert.strictEqual(r.aplicado, true);
  const prod = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.saldo_fiscal, 12);
  assert.strictEqual(prod.saldo_nao_fiscal, 0);
  assert.strictEqual(prod.estoque_atual, 12);
  await closeDb(db);
}

async function test02EspelhaEstoqueEmpresa() {
  const { db, empresaA } = await setup();
  const produtoId = await criarProdutoZerado(db);
  await aplicarAsync(db, {
    produtoId,
    saldoFiscal: 12,
    saldoNaoFiscal: 0,
    empresaId: empresaA
  });
  const ee = await EstoqueEmpresaService.consultarSaldo(
    { produtoId, empresaId: empresaA },
    { db }
  );
  assert.ok(ee);
  assert.strictEqual(ee.produto_id, produtoId);
  assert.strictEqual(ee.empresa_id, empresaA);
  assert.strictEqual(ee.saldo_fiscal, 12);
  assert.strictEqual(ee.saldo_nao_fiscal, 0);
  assert.strictEqual(ee.estoque_atual, 12);
  await closeDb(db);
}

async function test03RegistroComecaEmZero() {
  const { db, empresaA } = await setup();
  const produtoId = await criarProdutoZerado(db);
  const antes = await EstoqueEmpresaService.existeRegistro(
    { produtoId, empresaId: empresaA },
    { db }
  );
  assert.strictEqual(antes, false);

  const efeito = await EstoqueEmpresaService.aplicarEfeitoSaldo({
    produtoId,
    empresaId: empresaA,
    deltaSaldoFiscal: 5,
    deltaSaldoNaoFiscal: 2
  }, { db });
  assert.strictEqual(efeito.criado, true);
  assert.strictEqual(efeito.saldo_fiscal, 5);
  assert.strictEqual(efeito.saldo_nao_fiscal, 2);

  const src = fs.readFileSync(SRC_SERVICE, 'utf8');
  assert.ok(src.includes('await criarRegistro({ produtoId, empresaId }, { db })'));
  assert.ok(!/\bFROM\s+produtos\b[\s\S]{0,80}saldo_fiscal/i.test(src));
  await closeDb(db);
}

async function test04SomenteEfeitoDaOperacao() {
  const { db, empresaA } = await setup();
  const produtoId = await criarProdutoZerado(db);
  await run(db, `UPDATE produtos SET reservado_fiscal = 99 WHERE id = ?`, [produtoId]);
  await aplicarAsync(db, {
    produtoId,
    saldoFiscal: 10,
    saldoNaoFiscal: 4,
    empresaId: empresaA
  });
  const prod = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.saldo_fiscal, 10);
  assert.strictEqual(prod.saldo_nao_fiscal, 4);
  assert.strictEqual(prod.estoque_atual, 14);
  assert.strictEqual(prod.reservado_fiscal, 99);

  const ee = await EstoqueEmpresaService.consultarSaldo(
    { produtoId, empresaId: empresaA },
    { db }
  );
  assert.strictEqual(ee.saldo_fiscal, 10);
  assert.strictEqual(ee.saldo_nao_fiscal, 4);
  assert.strictEqual(ee.estoque_atual, 14);
  assert.strictEqual(ee.reservado_fiscal, 0);
  assert.strictEqual(ee.reservado_nao_fiscal, 0);
  await closeDb(db);
}

async function test05EmpresaIdCorreto() {
  const { db, empresaA, empresaB } = await setup();
  const produtoId = await criarProdutoZerado(db);
  const r = await aplicarAsync(db, {
    produtoId,
    saldoFiscal: 3,
    saldoNaoFiscal: 0,
    empresaId: empresaA
  });
  assert.strictEqual(r.empresa_id, empresaA);
  const ee = await EstoqueEmpresaService.consultarSaldo(
    { produtoId, empresaId: empresaA },
    { db }
  );
  assert.strictEqual(ee.empresa_id, empresaA);
  const outro = await EstoqueEmpresaService.consultarSaldo(
    { produtoId, empresaId: empresaB },
    { db }
  );
  assert.strictEqual(outro, null);
  await closeDb(db);
}

async function test06EmpresasIndependentes() {
  const { db, empresaA, empresaB } = await setup();
  const p1 = await criarProdutoZerado(db, 'P1');
  const p2 = await criarProdutoZerado(db, 'P2');
  await aplicarAsync(db, { produtoId: p1, saldoFiscal: 10, saldoNaoFiscal: 0, empresaId: empresaA });
  await aplicarAsync(db, { produtoId: p2, saldoFiscal: 0, saldoNaoFiscal: 4, empresaId: empresaB });

  const a = await EstoqueEmpresaService.consultarSaldo({ produtoId: p1, empresaId: empresaA }, { db });
  const b = await EstoqueEmpresaService.consultarSaldo({ produtoId: p2, empresaId: empresaB }, { db });
  assert.strictEqual(a.saldo_fiscal, 10);
  assert.strictEqual(b.saldo_nao_fiscal, 4);
  assert.strictEqual(
    await EstoqueEmpresaService.consultarSaldo({ produtoId: p1, empresaId: empresaB }, { db }),
    null
  );
  assert.strictEqual(
    await EstoqueEmpresaService.consultarSaldo({ produtoId: p2, empresaId: empresaA }, { db }),
    null
  );
  await closeDb(db);
}

async function test07CompatSemEmpresa() {
  const { db } = await setup();
  const produtoId = await criarProdutoZerado(db);
  const r = await aplicarAsync(db, {
    produtoId,
    saldoFiscal: 2,
    saldoNaoFiscal: 1
  });
  assert.strictEqual(r.aplicado, true);
  assert.strictEqual(r.legado, true);
  assert.strictEqual(r.motivo_compat, MOTIVO_COMPAT_CREATE_PRODUTO_SALDO_INICIAL);
  assert.strictEqual(r.empresa_id, null);

  const prod = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.saldo_fiscal, 2);
  assert.strictEqual(prod.saldo_nao_fiscal, 1);

  const n = await get(db, 'SELECT COUNT(*) AS c FROM estoque_empresa');
  assert.strictEqual(n.c, 0);

  const src = fs.readFileSync(SRC_AJUSTE, 'utf8');
  assert.ok(src.includes('COMPAT_CREATE_PRODUTO_SALDO_INICIAL_PRE_MULTIEMPRESA'));
  assert.ok(!/empresaId\s*=\s*1/.test(src));
  await closeDb(db);
}

async function test08RollbackExterno() {
  const { db, empresaA } = await setup();
  await run(db, 'BEGIN');
  const produtoId = await criarProdutoZerado(db, 'Tx');
  await aplicarAsync(db, {
    produtoId,
    saldoFiscal: 9,
    saldoNaoFiscal: 3,
    empresaId: empresaA
  });
  const midProd = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  const midEe = await get(
    db,
    'SELECT * FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?',
    [produtoId, empresaA]
  );
  assert.strictEqual(midProd.saldo_fiscal, 9);
  assert.strictEqual(midEe.saldo_fiscal, 9);
  await run(db, 'ROLLBACK');

  const prod = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  const ee = await get(db, 'SELECT COUNT(*) AS c FROM estoque_empresa');
  assert.strictEqual(prod, null);
  assert.strictEqual(ee.c, 0);
  await closeDb(db);
}

function usaEstoqueEmpresa(fonte) {
  return /\b(FROM|JOIN|INTO|UPDATE)\s+estoque_empresa\b/i.test(fonte)
    || fonte.includes('EstoqueEmpresaService');
}

async function test09LeituraOperacionalNaoRedirecionada() {
  const porta = fs.readFileSync(SRC_PORTA, 'utf8');
  const reserva = fs.readFileSync(SRC_RESERVA, 'utf8');
  const produtos = fs.readFileSync(SRC_PRODUTOS, 'utf8');
  const compras = fs.readFileSync(SRC_COMPRAS, 'utf8');
  const vendas = fs.readFileSync(SRC_VENDAS, 'utf8');
  const pdv = fs.readFileSync(SRC_PDV, 'utf8');
  const repair = fs.readFileSync(SRC_REPAIR, 'utf8');
  const ajuste = fs.readFileSync(SRC_AJUSTE, 'utf8');

  assert.ok(porta.includes('FROM produtos'));
  assert.ok(!/\bFROM\s+estoque_empresa\b/i.test(porta));
  assert.ok(porta.includes('EstoqueEmpresaService') || porta.includes('aplicarEfeitoSaldo'));
  assert.ok(!/\bFROM\s+estoque_empresa\b/i.test(reserva));
  assert.ok(!usaEstoqueEmpresa(produtos));
  assert.ok(!usaEstoqueEmpresa(compras));
  assert.ok(!usaEstoqueEmpresa(vendas));
  assert.ok(!usaEstoqueEmpresa(pdv));
  assert.ok(!usaEstoqueEmpresa(repair));
  assert.ok(ajuste.includes('espelharSaldoInicialEmEstoqueEmpresa'));
  assert.ok(ajuste.includes('aplicarSaldoInicialCreateProduto'));
  assert.ok(!ajuste.includes('aplicarAjusteEstoqueProduto') || !/aplicarAjusteEstoqueProduto[\s\S]{0,200}EstoqueEmpresaService/.test(ajuste));
}

async function test10PortaContinuaEmProdutos() {
  const { db, empresaA } = await setup();
  const produtoId = await criarProdutoZerado(db);
  await run(db, `UPDATE produtos SET reservado_fiscal = 99 WHERE id = ?`, [produtoId]);
  await aplicarAsync(db, {
    produtoId,
    saldoFiscal: 8,
    saldoNaoFiscal: 0,
    empresaId: empresaA
  });

  const publico = await saldosPublico.consultarSaldo(produtoId, { db, empresaId: empresaA });
  assert.strictEqual(publico.saldo_fiscal, 8);
  assert.strictEqual(publico.reservado_fiscal, 0);

  const ee = await EstoqueEmpresaService.consultarSaldo(
    { produtoId, empresaId: empresaA },
    { db }
  );
  assert.strictEqual(ee.saldo_fiscal, 8);
  assert.strictEqual(ee.reservado_fiscal, 0);

  const porta = fs.readFileSync(SRC_PORTA, 'utf8');
  assert.ok(porta.includes('FROM produtos'));
  assert.ok(!/\bFROM\s+estoque_empresa\b/i.test(porta));
  await closeDb(db);
}

async function main() {
  const testes = [
    ['01 operacao atualiza produtos', test01ProdutosContinuaOficial],
    ['02 mesma operacao espelha estoque_empresa', test02EspelhaEstoqueEmpresa],
    ['03 registro comeca em zero', test03RegistroComecaEmZero],
    ['04 somente efeito da operacao', test04SomenteEfeitoDaOperacao],
    ['05 empresaId correto', test05EmpresaIdCorreto],
    ['06 empresas independentes', test06EmpresasIndependentes],
    ['07 COMPAT sem empresa nao inventa id', test07CompatSemEmpresa],
    ['08 rollback externo restaura ambos', test08RollbackExterno],
    ['09 leitura operacional nao redirecionada', test09LeituraOperacionalNaoRedirecionada],
    ['10 porta publica continua em produtos', test10PortaContinuaEmProdutos]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\ndual-write-estoque-empresa-03-13: ${ok}/${testes.length} OK`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
