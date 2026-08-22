/**
 * Fase 2 / Implementação 03.33 — validação de cancelamento/devolução de compra
 * lê estoque_empresa quando há req.empresaId.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const {
  estoqueAtualParaValidacaoCompra
} = require('../../backend/services/compras/estoqueAtualValidacaoCompra');
const { empresaIdDoReqCompra } = require('../../backend/services/compras/creditoEstoqueCompraViaPorta');
const { debitarEstoqueItemCompra } = require('../../backend/services/compras/debitoEstoqueCompraViaPorta');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');

const ROOT = path.resolve(__dirname, '../..');
const BACKEND = path.join(ROOT, 'backend');
const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';
const QTD = 8;

const SRC = {
  rotas: path.join(BACKEND, 'rotas/compras.js'),
  helper: path.join(BACKEND, 'services/compras/estoqueAtualValidacaoCompra.js'),
  debito: path.join(BACKEND, 'services/compras/debitoEstoqueCompraViaPorta.js'),
  porta: path.join(BACKEND, 'services/fiscalNaoFiscal/estoqueSaldosPublico.js'),
  reservas: path.join(BACKEND, 'services/fiscalNaoFiscal/reservasPublico.js')
};

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

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
    debitarEstoqueItemCompra(db, dados, (err, r) => (err ? reject(err) : resolve(r)));
  });
}

function permitido(estoqueAtual, quantidade) {
  return Number(estoqueAtual || 0) >= Number(quantidade || 0);
}

async function setup() {
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
     VALUES ('X', 400, 599, 999)`
  );
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const b = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: p.lastID, empresaId: a.id,
    saldo_fiscal: 10, saldo_nao_fiscal: 5, estoque_atual: 15
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: p.lastID, empresaId: b.id,
    saldo_fiscal: 3, saldo_nao_fiscal: 2, estoque_atual: 5
  }, { db });
  const produto = { id: p.lastID, nome: 'X', estoque_atual: 999 };
  return { db, produtoId: p.lastID, empresaA: a, empresaB: b, produto };
}

async function validar(db, produto, req) {
  return estoqueAtualParaValidacaoCompra({
    produto,
    produtoId: produto.id,
    req,
    db
  });
}

function test01AuditoriaPontosReais() {
  const rotas = read(SRC.rotas);
  const helper = read(SRC.helper);
  assert.ok(rotas.includes("router.post('/:id/cancelar'"));
  assert.ok(rotas.includes("router.post('/:id/devolver'"));
  assert.ok(rotas.includes('criarMiddlewareContextoEmpresa'));
  assert.ok(rotas.includes('estoqueAtualParaValidacaoCompra'));
  assert.ok(rotas.includes('SELECT nome, estoque_atual FROM produtos'));
  assert.ok(rotas.includes('COALESCE(p.estoque_atual, 0) AS estoque_atual'));
  assert.ok(helper.includes('consultarSaldoParaEmpresa'));
  assert.ok(helper.includes('empresaIdDoReqCompra'));
}

async function test02CancelamentoEmpresaA() {
  const { db, produto, empresaA } = await setup();
  const estoque = await validar(db, produto, { empresaId: empresaA.id, body: {} });
  assert.strictEqual(estoque, 15);
  assert.strictEqual(permitido(estoque, QTD), true);
  await closeDb(db);
}

async function test03CancelamentoEmpresaBIsolada() {
  const { db, produto, empresaA, empresaB } = await setup();
  const a = await validar(db, produto, { empresaId: empresaA.id });
  const b = await validar(db, produto, { empresaId: empresaB.id });
  assert.strictEqual(a, 15);
  assert.strictEqual(b, 5);
  assert.strictEqual(permitido(b, QTD), false);
  assert.notStrictEqual(a, b);
  await closeDb(db);
}

async function test04DevolucaoEmpresaA() {
  const { db, produto, empresaA } = await setup();
  const estoque = await validar(db, produto, { empresaId: empresaA.id });
  assert.strictEqual(estoque, 15);
  assert.strictEqual(permitido(estoque, QTD), true);
  await closeDb(db);
}

async function test05DevolucaoEmpresaBIsolada() {
  const { db, produto, empresaB } = await setup();
  const estoque = await validar(db, produto, { empresaId: empresaB.id });
  assert.strictEqual(estoque, 5);
  assert.strictEqual(permitido(estoque, QTD), false);
  await closeDb(db);
}

async function test06LegadoNaoInterfere() {
  const { db, produto, empresaB } = await setup();
  const estoque = await validar(db, produto, {
    empresaId: empresaB.id,
    body: { empresaId: 1 }
  });
  assert.strictEqual(estoque, 5);
  assert.notStrictEqual(estoque, 999);
  assert.strictEqual(permitido(estoque, QTD), false);
  await closeDb(db);
}

async function test07RegistroInexistenteZero() {
  const { db, produto, empresaA } = await setup();
  const c = await EmpresaService.criarEmpresa(
    { cnpj: '65957340000150', razao_social: 'C' },
    { db }
  );
  const estoque = await validar(db, produto, { empresaId: c.id });
  assert.strictEqual(estoque, 0);
  assert.ok(c.id !== empresaA.id);
  assert.strictEqual(permitido(estoque, QTD), false);
  await closeDb(db);
}

async function test08SemEmpresaLegado() {
  const { db, produto } = await setup();
  const estoque = await validar(db, produto, {
    empresaId: null,
    body: { empresaId: 1 },
    query: { empresaId: 1 }
  });
  assert.strictEqual(estoque, 999);
  assert.strictEqual(permitido(estoque, QTD), true);
  assert.strictEqual(empresaIdDoReqCompra({ empresaId: null, body: { empresaId: 1 } }), null);
  await closeDb(db);
}

function test09ReqEmpresaIdPrevalece() {
  const helper = read(SRC.helper);
  const rotas = read(SRC.rotas);
  assert.ok(helper.includes('empresaIdDoReqCompra(req)'));
  assert.ok(!helper.includes('empresaIdDoReqOperacional'));
  assert.ok(!/empresaId:\s*req\.body/.test(rotas));
  assert.ok(rotas.includes('estoqueAtualParaValidacaoCompra'));
  assert.strictEqual(empresaIdDoReqCompra({
    empresaId: 7,
    body: { empresaId: 1 },
    query: { empresaId: 1 }
  }), 7);
}

function test10BaixaContinuaPorta() {
  const rotas = read(SRC.rotas);
  const debito = read(SRC.debito);
  assert.ok(rotas.includes('debitarEstoqueItemCompra'));
  assert.ok(rotas.includes("origem: 'cancelamento_compra'"));
  assert.ok(rotas.includes("origem: 'devolucao_compra'") || rotas.includes('devolucao_compra'));
  assert.ok(debito.includes('estoqueSaldosPublico'));
  assert.ok(debito.includes('debitarSaldo'));
  assert.ok(!read(SRC.helper).includes('debitarSaldo'));
}

async function test11RollbackEscritas() {
  const { db, produtoId, empresaA } = await setup();
  await run(db, 'BEGIN');
  await debitoAsync(db, {
    produtoId,
    quantidadeFiscal: 2,
    quantidadeNaoFiscal: 1,
    empresaId: empresaA.id
  });
  const midProd = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  const midEe = await get(
    db,
    'SELECT * FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?',
    [produtoId, empresaA.id]
  );
  assert.strictEqual(midProd.saldo_fiscal, 398);
  assert.strictEqual(midEe.saldo_fiscal, 8);
  await run(db, 'ROLLBACK');
  const prod = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  const ee = await get(
    db,
    'SELECT * FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?',
    [produtoId, empresaA.id]
  );
  assert.strictEqual(prod.saldo_fiscal, 400);
  assert.strictEqual(ee.saldo_fiscal, 10);
  await closeDb(db);
}

function test12WritersPortaIntocados() {
  const porta = read(SRC.porta);
  const reservas = read(SRC.reservas);
  const debito = read(SRC.debito);
  const helper = read(SRC.helper);
  assert.ok(porta.includes('aplicarEfeitoSaldo'));
  assert.ok(porta.includes('FROM produtos WHERE id = ?'));
  assert.ok(reservas.includes('aplicarEfeitoReservado'));
  assert.ok(debito.includes('debitarEstoqueItemCompra'));
  assert.ok(!helper.includes('estoqueSaldosPublico'));
  assert.ok(!helper.includes('UPDATE produtos'));
}

async function main() {
  const testes = [
    ['01 auditoria confirma pontos reais de leitura', test01AuditoriaPontosReais],
    ['02 cancelamento empresa A usa estoque_empresa A', test02CancelamentoEmpresaA],
    ['03 cancelamento empresa B nao usa saldo da A', test03CancelamentoEmpresaBIsolada],
    ['04 devolucao empresa A usa estoque_empresa A', test04DevolucaoEmpresaA],
    ['05 devolucao empresa B permanece isolada', test05DevolucaoEmpresaBIsolada],
    ['06 saldo legado alto nao interfere', test06LegadoNaoInterfere],
    ['07 registro inexistente recebe zero', test07RegistroInexistenteZero],
    ['08 sem empresa mantem legado', test08SemEmpresaLegado],
    ['09 req.empresaId prevalece sobre body/query', test09ReqEmpresaIdPrevalece],
    ['10 baixa continua pela porta publica', test10BaixaContinuaPorta],
    ['11 rollback externo restaura escritas', test11RollbackEscritas],
    ['12 nenhum writer/porta alterado fora da validacao', test12WritersPortaIntocados]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  ok ${nome}`);
  }
  console.log(`\ncancelamento-devolucao-compra-multiempresa: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
