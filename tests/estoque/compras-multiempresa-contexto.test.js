/**
 * Fase 2 / Implementação 03.27 — compras: req.empresaId até a porta 03.19.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const {
  creditarEstoqueItemCompra,
  empresaIdDoReqCompra,
  montarOptsPortaCreditoCompra
} = require('../../backend/services/compras/creditoEstoqueCompraViaPorta');
const {
  debitarEstoqueItemCompra,
  montarOptsPortaDebitoCompra
} = require('../../backend/services/compras/debitoEstoqueCompraViaPorta');
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
    creditarEstoqueItemCompra(db, dados, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

function debitoAsync(db, dados) {
  return new Promise((resolve, reject) => {
    debitarEstoqueItemCompra(db, dados, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

function opcoesDaReq(req, db) {
  const empresaId = empresaIdDoReqCompra(req);
  return { empresaId, db, usuarioId: req?.user?.id || null };
}

async function entrarComoCompra(db, req, dados) {
  const opts = opcoesDaReq(req, db);
  return creditoAsync(db, {
    produtoId: dados.produtoId,
    quantidadeFiscal: dados.quantidadeFiscal || 0,
    quantidadeNaoFiscal: dados.quantidadeNaoFiscal || 0,
    empresaId: opts.empresaId,
    usuarioId: opts.usuarioId
  });
}

async function reverterComoCompra(db, req, dados) {
  const opts = opcoesDaReq(req, db);
  return debitoAsync(db, {
    produtoId: dados.produtoId,
    quantidadeFiscal: dados.quantidadeFiscal || 0,
    quantidadeNaoFiscal: dados.quantidadeNaoFiscal || 0,
    empresaId: opts.empresaId,
    usuarioId: opts.usuarioId,
    origem: dados.origem || 'cancelamento_compra'
  });
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
     VALUES ('X', 100, 40, 140)`
  );
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const b = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  return { db, produtoId: p.lastID, empresaA: a, empresaB: b };
}

async function seedAB(db, produtoId, empresaA, empresaB) {
  await EstoqueEmpresaService.criarRegistro({
    produtoId,
    empresaId: empresaA.id,
    saldo_fiscal: 10,
    saldo_nao_fiscal: 4,
    estoque_atual: 14
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId,
    empresaId: empresaB.id,
    saldo_fiscal: 20,
    saldo_nao_fiscal: 8,
    estoque_atual: 28
  }, { db });
}

async function ee(db, produtoId, empresaId) {
  return get(
    db,
    'SELECT * FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?',
    [produtoId, empresaId]
  );
}

async function test01EntradaEmpresaA() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  const r = await entrarComoCompra(db, { empresaId: empresaA.id }, {
    produtoId, quantidadeFiscal: 10
  });
  assert.strictEqual(r.empresa_id, empresaA.id);
  assert.strictEqual(r.legado, false);
  const a = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(a.saldo_fiscal, 20);
  const prod = await get(db, 'SELECT saldo_fiscal FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.saldo_fiscal, 110);
  await closeDb(db);
}

async function test02NaoAlteraEmpresaB() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  await entrarComoCompra(db, { empresaId: empresaA.id }, {
    produtoId, quantidadeFiscal: 10
  });
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(b.saldo_fiscal, 20);
  assert.strictEqual(b.saldo_nao_fiscal, 8);
  await closeDb(db);
}

async function test03EmpresaBIndependente() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  await entrarComoCompra(db, { empresaId: empresaA.id }, {
    produtoId, quantidadeFiscal: 10
  });
  await entrarComoCompra(db, { empresaId: empresaB.id }, {
    produtoId, quantidadeFiscal: 20
  });
  const a = await ee(db, produtoId, empresaA.id);
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(a.saldo_fiscal, 20);
  assert.strictEqual(b.saldo_fiscal, 40);
  await closeDb(db);
}

async function test04ReversaoEmpresaCorreta() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  const req = { empresaId: empresaA.id };
  await entrarComoCompra(db, req, { produtoId, quantidadeFiscal: 10 });
  await reverterComoCompra(db, req, {
    produtoId, quantidadeFiscal: 10, origem: 'cancelamento_compra'
  });
  const a = await ee(db, produtoId, empresaA.id);
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(a.saldo_fiscal, 10);
  assert.strictEqual(b.saldo_fiscal, 20);
  await closeDb(db);
}

async function test05ReqChegaNaPorta() {
  const { db, produtoId, empresaA } = await setup();
  const req = {
    empresaId: empresaA.id,
    body: { empresaId: 99, empresa_id: 99 },
    query: { empresaId: 99 }
  };
  const opts = montarOptsPortaCreditoCompra(db, opcoesDaReq(req, db));
  assert.strictEqual(opts.empresaId, empresaA.id);
  assert.strictEqual(opts.legado, false);
  const r = await entrarComoCompra(db, req, { produtoId, quantidadeFiscal: 3 });
  assert.strictEqual(r.empresa_id, empresaA.id);
  const iso = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(iso.saldo_fiscal, 3);
  await closeDb(db);
}

async function test06ReqPrevaleceSobreBodyQuery() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  const req = {
    empresaId: empresaA.id,
    body: { empresaId: empresaB.id, empresa_id: empresaB.id },
    query: { empresaId: empresaB.id },
    contexto: { empresaId: empresaB.id },
    ctx: { empresaId: empresaB.id }
  };
  assert.strictEqual(empresaIdDoReqCompra(req), empresaA.id);
  const credito = montarOptsPortaCreditoCompra(db, {
    empresaId: empresaIdDoReqCompra(req),
    contexto: req.contexto,
    ctx: req.ctx
  });
  const debito = montarOptsPortaDebitoCompra(db, {
    empresaId: empresaIdDoReqCompra(req),
    contexto: req.contexto,
    ctx: req.ctx
  });
  assert.strictEqual(credito.empresaId, empresaA.id);
  assert.strictEqual(debito.empresaId, empresaA.id);
  await entrarComoCompra(db, req, { produtoId, quantidadeFiscal: 5 });
  const a = await ee(db, produtoId, empresaA.id);
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(a.saldo_fiscal, 15);
  assert.strictEqual(b.saldo_fiscal, 20);
  await closeDb(db);
}

async function test07SemEmpresaMantemCompat() {
  const { db, produtoId } = await setup();
  const req = { empresaId: null, body: { empresaId: 99 }, query: { empresaId: 99 } };
  const r = await entrarComoCompra(db, req, { produtoId, quantidadeFiscal: 7 });
  assert.strictEqual(r.legado, true);
  assert.ok(r.empresa_id == null);
  const prod = await get(db, 'SELECT saldo_fiscal FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.saldo_fiscal, 107);
  await closeDb(db);
}

async function test08SemEmpresaNaoCriaEstoqueEmpresa() {
  const { db, produtoId } = await setup();
  await entrarComoCompra(db, { empresaId: null, body: { empresaId: 1 } }, {
    produtoId, quantidadeFiscal: 7
  });
  const n = await get(db, 'SELECT COUNT(*) AS c FROM estoque_empresa');
  assert.strictEqual(n.c, 0);
  await closeDb(db);
}

async function test09RollbackExterno() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  await run(db, 'BEGIN');
  await entrarComoCompra(db, { empresaId: empresaA.id }, {
    produtoId, quantidadeFiscal: 10
  });
  const midProd = await get(db, 'SELECT saldo_fiscal FROM produtos WHERE id = ?', [produtoId]);
  const midA = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(midProd.saldo_fiscal, 110);
  assert.strictEqual(midA.saldo_fiscal, 20);
  await run(db, 'ROLLBACK');
  const prod = await get(db, 'SELECT saldo_fiscal FROM produtos WHERE id = ?', [produtoId]);
  const a = await ee(db, produtoId, empresaA.id);
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(prod.saldo_fiscal, 100);
  assert.strictEqual(a.saldo_fiscal, 10);
  assert.strictEqual(b.saldo_fiscal, 20);
  await closeDb(db);
}

async function test10RegressaoFuncional() {
  const { db, produtoId, empresaA } = await setup();
  const r = await entrarComoCompra(db, { empresaId: empresaA.id }, {
    produtoId, quantidadeFiscal: 4, quantidadeNaoFiscal: 2
  });
  assert.strictEqual(r.saldo_fiscal, 4);
  assert.strictEqual(r.saldo_nao_fiscal, 2);
  const prod = await get(db, 'SELECT saldo_fiscal, saldo_nao_fiscal FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.saldo_fiscal, 104);
  assert.strictEqual(prod.saldo_nao_fiscal, 42);
  const iso = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(iso.saldo_fiscal, 4);
  assert.strictEqual(iso.saldo_nao_fiscal, 2);

  await reverterComoCompra(db, { empresaId: empresaA.id }, {
    produtoId, quantidadeFiscal: 4, quantidadeNaoFiscal: 2, origem: 'devolucao_compra'
  });
  const depois = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(depois.saldo_fiscal, 0);
  assert.strictEqual(depois.saldo_nao_fiscal, 0);

  const rotas = fs.readFileSync(path.join(ROOT, 'backend/rotas/compras.js'), 'utf8');
  assert.ok(rotas.includes('empresaIdDoReqCompra(req)'));
  assert.ok(!rotas.includes('empresaIdDoReqOperacional'));
  assert.strictEqual((rotas.match(/creditarEstoqueItemCompra\s*\(/g) || []).length, 1);
  assert.strictEqual((rotas.match(/debitarEstoqueItemCompra\s*\(/g) || []).length, 2);
  assert.ok(rotas.includes("status: 410") || rotas.includes('res.status(410)'));

  const credito = fs.readFileSync(
    path.join(ROOT, 'backend/services/compras/creditoEstoqueCompraViaPorta.js'),
    'utf8'
  );
  assert.ok(credito.includes('empresaIdDoReqCompra'));
  assert.ok(credito.includes('resolverEmpresaId(opcoes.empresaId)'));
  assert.ok(!credito.includes('opcoes.contexto'));
  assert.ok(credito.includes('estoqueSaldosPublico'));
  assert.ok(!credito.includes('EstoqueEmpresaService'));

  const debito = fs.readFileSync(
    path.join(ROOT, 'backend/services/compras/debitoEstoqueCompraViaPorta.js'),
    'utf8'
  );
  assert.ok(debito.includes('resolverEmpresaId(opcoes.empresaId)'));
  assert.ok(!debito.includes('opcoes.contexto'));
  assert.ok(debito.includes('estoqueSaldosPublico'));
  assert.ok(!debito.includes('EstoqueEmpresaService'));

  const porta = fs.readFileSync(
    path.join(ROOT, 'backend/services/fiscalNaoFiscal/estoqueSaldosPublico.js'),
    'utf8'
  );
  assert.ok(porta.includes('aplicarEfeitoSaldo'));

  await closeDb(db);
}

async function test11DevolucaoNaoAlteraB() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  await entrarComoCompra(db, { empresaId: empresaA.id }, {
    produtoId, quantidadeNaoFiscal: 3
  });
  await reverterComoCompra(db, { empresaId: empresaA.id }, {
    produtoId, quantidadeNaoFiscal: 3, origem: 'devolucao_compra'
  });
  const a = await ee(db, produtoId, empresaA.id);
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(a.saldo_nao_fiscal, 4);
  assert.strictEqual(b.saldo_nao_fiscal, 8);
  assert.strictEqual(b.saldo_fiscal, 20);
  await closeDb(db);
}

async function test12ParseXmlNaoMuta() {
  const rotas = fs.readFileSync(path.join(ROOT, 'backend/rotas/compras.js'), 'utf8');
  const xmlSection = rotas.slice(
    rotas.indexOf("router.post('/parse-xml'"),
    rotas.indexOf("router.get('/:id/nfe-devolucao/preparar'")
  );
  assert.ok(xmlSection.includes('410'));
  assert.ok(!xmlSection.includes('creditarEstoqueItemCompra'));
  assert.ok(!xmlSection.includes('debitarEstoqueItemCompra'));
}

async function main() {
  const testes = [
    ['01 entrada de compra com empresa A', test01EntradaEmpresaA],
    ['02 entrada nao altera empresa B', test02NaoAlteraEmpresaB],
    ['03 segunda empresa saldo independente', test03EmpresaBIndependente],
    ['04 reversao/cancelamento empresa correta', test04ReversaoEmpresaCorreta],
    ['05 req.empresaId chega ate a porta', test05ReqChegaNaPorta],
    ['06 req.empresaId prevalece sobre body/query', test06ReqPrevaleceSobreBodyQuery],
    ['07 sem empresa mantem COMPAT', test07SemEmpresaMantemCompat],
    ['08 sem empresa nao cria estoque_empresa', test08SemEmpresaNaoCriaEstoqueEmpresa],
    ['09 rollback externo restaura ambos', test09RollbackExterno],
    ['10 fluxo de compra continua funcionando', test10RegressaoFuncional],
    ['11 devolucao NF nao altera B', test11DevolucaoNaoAlteraB],
    ['12 parse-xml nao muta estoque', test12ParseXmlNaoMuta]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\ncompras-multiempresa-contexto: ${ok}/${testes.length} OK`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
