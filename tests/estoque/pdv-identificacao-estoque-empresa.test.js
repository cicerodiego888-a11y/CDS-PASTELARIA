/**
 * Fase 2 / Implementação 03.23 — identificação PDV com estoque_empresa.
 * Fluxo real: POST/GET /api/produtos/identificar → PdvProdutoIdentificacaoService
 * + aplicarSaldosIdentificacaoPdv(req.empresaId).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const {
  aplicarSaldosIdentificacaoPdv
} = require('../../backend/services/estoque/leituraEstoqueEmpresaProduto');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const {
  garantirSchemaProdutoIdentificadores,
  ProdutoIdentificadoresService,
  PdvProdutoIdentificacaoService
} = require('../../backend/motores/produto-identidade');

const ROOT = path.resolve(__dirname, '../..');
const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';
const CODIGO = 'INT-PDV-01';

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

function schemaIdentificadores(db) {
  return new Promise((resolve, reject) => {
    garantirSchemaProdutoIdentificadores(db, (err) => (err ? reject(err) : resolve()));
  });
}

async function identificarPdv(db, codigo, empresaId) {
  const service = new PdvProdutoIdentificacaoService({ db });
  const payload = await service.identificar(codigo, { origem: 'pdv' });
  const r = await aplicarSaldosIdentificacaoPdv({ payload, empresaId, db });
  return r.payload;
}

async function setup() {
  const db = await openDb();
  await run(db, 'PRAGMA foreign_keys = ON');
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  await run(db, `
    CREATE TABLE produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo VARCHAR(50) UNIQUE,
      nome VARCHAR(200) NOT NULL,
      codigo_barras TEXT,
      unidade TEXT,
      preco_venda DECIMAL(10,2) DEFAULT 0,
      ativo INTEGER DEFAULT 1,
      saldo_fiscal REAL DEFAULT 0,
      saldo_nao_fiscal REAL DEFAULT 0,
      estoque_atual REAL DEFAULT 0,
      reservado_fiscal REAL DEFAULT 0,
      reservado_nao_fiscal REAL DEFAULT 0
    )
  `);
  await schemaIdentificadores(db);
  const ins = await run(
    db,
    `INSERT INTO produtos
       (codigo, nome, codigo_barras, unidade, preco_venda, ativo,
        saldo_fiscal, saldo_nao_fiscal, estoque_atual, reservado_fiscal, reservado_nao_fiscal)
     VALUES (?, ?, ?, ?, ?, 1, 100, 40, 140, 7, 3)`,
    [CODIGO, 'Pastel de Carne', '7891234567890', 'UN', 12.5]
  );
  const sync = new ProdutoIdentificadoresService({ db });
  await sync.espelharCodigoEBarras(ins.lastID, { codigo: CODIGO, codigo_barras: '7891234567890' });
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const b = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  return { db, produtoId: ins.lastID, empresaA: a, empresaB: b };
}

async function test01SemEmpresaLegado() {
  const { db } = await setup();
  const payload = await identificarPdv(db, CODIGO, null);
  assert.strictEqual(payload.encontrado, true);
  assert.strictEqual(payload.produto.nome, 'Pastel de Carne');
  assert.strictEqual(payload.produto.saldo_fiscal, undefined);
  await closeDb(db);
}

async function test02EmpresaA() {
  const { db, produtoId, empresaA } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId,
    empresaId: empresaA.id,
    saldo_fiscal: 10,
    saldo_nao_fiscal: 2,
    estoque_atual: 12,
    reservado_fiscal: 1,
    reservado_nao_fiscal: 0
  }, { db });
  const payload = await identificarPdv(db, CODIGO, empresaA.id);
  assert.strictEqual(payload.produto.saldo_fiscal, 10);
  assert.strictEqual(payload.produto.estoque_atual, 12);
  await closeDb(db);
}

async function test03EmpresaB() {
  const { db, produtoId, empresaB } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId,
    empresaId: empresaB.id,
    saldo_fiscal: 25,
    saldo_nao_fiscal: 5,
    estoque_atual: 30
  }, { db });
  const payload = await identificarPdv(db, CODIGO, empresaB.id);
  assert.strictEqual(payload.produto.saldo_fiscal, 25);
  assert.strictEqual(payload.produto.estoque_atual, 30);
  await closeDb(db);
}

async function test04Isolamento() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaA.id, saldo_fiscal: 10, estoque_atual: 10
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaB.id, saldo_fiscal: 25, estoque_atual: 25
  }, { db });
  const a = await identificarPdv(db, CODIGO, empresaA.id);
  const b = await identificarPdv(db, CODIGO, empresaB.id);
  assert.strictEqual(a.produto.saldo_fiscal, 10);
  assert.strictEqual(b.produto.saldo_fiscal, 25);
  assert.notStrictEqual(a.produto.saldo_fiscal, b.produto.saldo_fiscal);
  await closeDb(db);
}

async function test05SemRegistroZeros() {
  const { db, empresaA } = await setup();
  const payload = await identificarPdv(db, CODIGO, empresaA.id);
  assert.strictEqual(payload.produto.saldo_fiscal, 0);
  assert.strictEqual(payload.produto.saldo_nao_fiscal, 0);
  assert.strictEqual(payload.produto.estoque_atual, 0);
  assert.strictEqual(payload.produto.reservado_fiscal, 0);
  assert.strictEqual(payload.produto.reservado_nao_fiscal, 0);
  await closeDb(db);
}

async function test06SemFallback() {
  const { db, produtoId, empresaA } = await setup();
  const legado = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(legado.saldo_fiscal, 100);
  const payload = await identificarPdv(db, CODIGO, empresaA.id);
  assert.strictEqual(payload.produto.saldo_fiscal, 0);
  assert.notStrictEqual(payload.produto.estoque_atual, 140);
  await closeDb(db);
}

async function test07ComerciaisGlobais() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaA.id, saldo_fiscal: 10, estoque_atual: 10
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaB.id, saldo_fiscal: 25, estoque_atual: 25
  }, { db });
  const a = await identificarPdv(db, CODIGO, empresaA.id);
  const b = await identificarPdv(db, CODIGO, empresaB.id);
  const sem = await identificarPdv(db, CODIGO, null);
  assert.strictEqual(a.produto.nome, 'Pastel de Carne');
  assert.strictEqual(b.produto.nome, 'Pastel de Carne');
  assert.strictEqual(sem.produto.nome, 'Pastel de Carne');
  assert.strictEqual(Number(a.produto.preco_venda), 12.5);
  assert.strictEqual(Number(b.produto.preco_venda), 12.5);
  assert.strictEqual(a.produto.codigo, CODIGO);
  assert.strictEqual(b.produto.codigo, CODIGO);
  await closeDb(db);
}

async function test08SaldosFiscais() {
  const { db, produtoId, empresaA } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId,
    empresaId: empresaA.id,
    saldo_fiscal: 10,
    saldo_nao_fiscal: 2,
    estoque_atual: 12
  }, { db });
  const p = (await identificarPdv(db, CODIGO, empresaA.id)).produto;
  assert.strictEqual(p.saldo_fiscal, 10);
  assert.strictEqual(p.saldo_nao_fiscal, 2);
  await closeDb(db);
}

async function test09Reservas() {
  const { db, produtoId, empresaA } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId,
    empresaId: empresaA.id,
    saldo_fiscal: 10,
    estoque_atual: 10,
    reservado_fiscal: 4,
    reservado_nao_fiscal: 1
  }, { db });
  const p = (await identificarPdv(db, CODIGO, empresaA.id)).produto;
  assert.strictEqual(p.reservado_fiscal, 4);
  assert.strictEqual(p.reservado_nao_fiscal, 1);
  await closeDb(db);
}

async function test10FluxoLegadoIdentificacao() {
  const { db } = await setup();
  const payload = await identificarPdv(db, CODIGO, null);
  assert.strictEqual(payload.encontrado, true);
  assert.strictEqual(payload.produtoId != null, true);
  assert.strictEqual(payload.produto.nome, 'Pastel de Carne');
  assert.strictEqual(Number(payload.produto.preco_venda), 12.5);
  assert.ok(payload.habilitado === true);

  const miss = await identificarPdv(db, 'CODIGO-INEXISTENTE', null);
  assert.strictEqual(miss.encontrado, false);

  const produtos = fs.readFileSync(path.join(ROOT, 'backend/rotas/produtos.js'), 'utf8');
  const idx = produtos.indexOf("router.post('/identificar'");
  const trecho = produtos.slice(idx, produtos.indexOf("router.get('/identificar'") + 900);
  assert.ok(trecho.includes('aplicarSaldosIdentificacaoPdv'));
  assert.ok(trecho.includes('empresaId: req.empresaId'));
  assert.ok(!/empresaId:\s*req\.body/.test(trecho));
  assert.ok(!produtos.includes('consultarSaldoParaEmpresa'));

  const pdv = fs.readFileSync(path.join(ROOT, 'frontend/pdv/js/pdv.js'), 'utf8');
  assert.ok(pdv.includes("headers['X-Empresa-Id']"));
  assert.ok(pdv.includes('aplicarSaldosIdentificacaoNoProdutoPdv'));

  const porta = fs.readFileSync(
    path.join(ROOT, 'backend/services/fiscalNaoFiscal/estoqueSaldosPublico.js'),
    'utf8'
  );
  assert.ok(!porta.includes('aplicarSaldosIdentificacaoPdv'));

  const reservas = fs.readFileSync(
    path.join(ROOT, 'backend/services/estoque/EstoqueReservaService.js'),
    'utf8'
  );
  assert.ok(!reservas.includes('aplicarSaldosIdentificacaoPdv'));

  await closeDb(db);
}

async function main() {
  const testes = [
    ['01 sem empresa mantem saldo legado', test01SemEmpresaLegado],
    ['02 empresa A le estoque_empresa A', test02EmpresaA],
    ['03 empresa B le estoque_empresa B', test03EmpresaB],
    ['04 isolamento A/B', test04Isolamento],
    ['05 sem registro zeros', test05SemRegistroZeros],
    ['06 sem fallback para produtos', test06SemFallback],
    ['07 dados comerciais globais', test07ComerciaisGlobais],
    ['08 SF e SNF corretos', test08SaldosFiscais],
    ['09 RF e RNF corretos', test09Reservas],
    ['10 identificacao PDV continua', test10FluxoLegadoIdentificacao]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\npdv-identificacao-estoque-empresa: ${ok}/${testes.length} OK`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
