/**
 * Fase 2 / Implementação 03.34 — auditoria de fechamento da Fundação Multiempresa.
 * Comportamento real: isolamento, dual-write, COMPAT, autoridade de req.empresaId.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const saldos = require('../../backend/services/fiscalNaoFiscal/estoqueSaldosPublico');
const reservas = require('../../backend/services/fiscalNaoFiscal/reservasPublico');
const { TipoSaldo } = require('../../backend/services/fiscalNaoFiscal/constants');
const {
  aplicarSaldosDisponibilidadeVenda
} = require('../../backend/services/estoque/leituraEstoqueEmpresaProduto');
const { empresaIdDoReqCompra } = require('../../backend/services/compras/creditoEstoqueCompraViaPorta');
const { montarOpcoesBaixaEstoqueVenda } = require('../../backend/services/vendas/debitoEstoqueVendaViaPorta');
const { montarOpcoesRetornoEstoqueVenda } = require('../../backend/services/vendas/creditoEstoqueVendaViaPorta');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync, DDL_ESTOQUE_EMPRESA } = require('../../backend/services/estoque/estoqueEmpresaSchema');

const ROOT = path.resolve(__dirname, '../..');
const BACKEND = path.join(ROOT, 'backend');
const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

function read(rel) {
  return fs.readFileSync(path.join(BACKEND, rel), 'utf8');
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
      controla_estoque INTEGER DEFAULT 1,
      updated_at DATETIME
    )
  `);
  const p = await run(
    db,
    `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual)
     VALUES ('X', 80, 20, 100)`
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

function test01SchemaExiste() {
  assert.ok(DDL_ESTOQUE_EMPRESA.includes('CREATE TABLE IF NOT EXISTS estoque_empresa'));
  assert.ok(DDL_ESTOQUE_EMPRESA.includes('saldo_fiscal'));
  assert.ok(DDL_ESTOQUE_EMPRESA.includes('reservado_nao_fiscal'));
  assert.ok(DDL_ESTOQUE_EMPRESA.includes('UNIQUE(produto_id, empresa_id)'));
}

async function test02EstoquesIsolados() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaA.id, saldo_fiscal: 10, saldo_nao_fiscal: 5
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaB.id, saldo_fiscal: 30, saldo_nao_fiscal: 20
  }, { db });
  const a = await EstoqueEmpresaService.consultarSaldoParaEmpresa({
    produtoId, empresaId: empresaA.id, db
  });
  const b = await EstoqueEmpresaService.consultarSaldoParaEmpresa({
    produtoId, empresaId: empresaB.id, db
  });
  assert.strictEqual(a.saldoFiscal, 10);
  assert.strictEqual(b.saldoFiscal, 30);
  await closeDb(db);
}

async function test03CreditoIsola() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await saldos.creditarSaldo(produtoId, TipoSaldo.FISCAL, 7, { db, empresaId: empresaA.id });
  const a = await ee(db, produtoId, empresaA.id);
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(a.saldo_fiscal, 7);
  assert.strictEqual(b, null);
  await closeDb(db);
}

async function test04DebitoIsola() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await saldos.creditarSaldo(produtoId, TipoSaldo.FISCAL, 10, { db, empresaId: empresaA.id });
  await saldos.creditarSaldo(produtoId, TipoSaldo.FISCAL, 10, { db, empresaId: empresaB.id });
  await saldos.debitarSaldo(produtoId, TipoSaldo.FISCAL, 3, { db, empresaId: empresaA.id });
  const a = await ee(db, produtoId, empresaA.id);
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(a.saldo_fiscal, 7);
  assert.strictEqual(b.saldo_fiscal, 10);
  await closeDb(db);
}

async function test05ReservaIsola() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await reservas.reservarQuantidade(produtoId, TipoSaldo.FISCAL, 4, { db, empresaId: empresaA.id });
  const a = await ee(db, produtoId, empresaA.id);
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(a.reservado_fiscal, 4);
  assert.strictEqual(b, null);
  await closeDb(db);
}

async function test06LeituraComEmpresaUsaEe() {
  const { db, produtoId, empresaA } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaA.id, saldo_fiscal: 11, saldo_nao_fiscal: 2, estoque_atual: 13
  }, { db });
  const [row] = await aplicarSaldosDisponibilidadeVenda({
    produtos: [{ id: produtoId, saldo_fiscal: 80, saldo_nao_fiscal: 20, estoque_atual: 100 }],
    empresaId: empresaA.id,
    db
  });
  assert.strictEqual(row.saldo_fiscal, 11);
  assert.strictEqual(row.estoque_atual, 13);
  await closeDb(db);
}

async function test07AusenciaNaoCopiaLegado() {
  const { db, produtoId, empresaA } = await setup();
  const [row] = await aplicarSaldosDisponibilidadeVenda({
    produtos: [{ id: produtoId, saldo_fiscal: 80, saldo_nao_fiscal: 20, estoque_atual: 100 }],
    empresaId: empresaA.id,
    db
  });
  assert.strictEqual(row.saldo_fiscal, 0);
  assert.strictEqual(row.estoque_atual, 0);
  assert.notStrictEqual(row.saldo_fiscal, 80);
  await closeDb(db);
}

async function test08SemEmpresaCompat() {
  const { db, produtoId } = await setup();
  await saldos.creditarSaldo(produtoId, TipoSaldo.FISCAL, 5, {
    db,
    modoLegadoSemEmpresa: true
  });
  const prod = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.saldo_fiscal, 85);
  const n = await get(db, 'SELECT COUNT(*) AS c FROM estoque_empresa');
  assert.strictEqual(n.c, 0);
  const [row] = await aplicarSaldosDisponibilidadeVenda({
    produtos: [{ id: produtoId, saldo_fiscal: prod.saldo_fiscal, estoque_atual: prod.estoque_atual }],
    empresaId: null,
    db
  });
  assert.strictEqual(row.saldo_fiscal, 85);
  await closeDb(db);
}

function test09ReqNaoSubstituidoPorBody() {
  const req = {
    empresaId: 12,
    body: { empresaId: 1, empresa_id: 1 },
    query: { empresaId: 1 },
    user: { empresaId: 1 }
  };
  assert.strictEqual(empresaIdDoReqCompra(req), 12);
  assert.strictEqual(montarOpcoesBaixaEstoqueVenda(req).empresaId, 12);
  assert.strictEqual(montarOpcoesRetornoEstoqueVenda(req).empresaId, 12);
  const reserva = read('services/estoque/EstoqueReservaService.js');
  assert.ok(reserva.includes('resolverEmpresaId(req && req.empresaId)'));
  const ajuste = read('services/ajusteEstoqueService.js');
  assert.ok(ajuste.includes('resolverEmpresaId(req && req.empresaId)'));
  const sem = { empresaId: null, body: { empresaId: 1 }, query: { empresaId: 1 } };
  assert.strictEqual(empresaIdDoReqCompra(sem), null);
  assert.strictEqual(montarOpcoesBaixaEstoqueVenda(sem).empresaId, null);
}

async function test10ANaoAlteraB() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await saldos.creditarSaldo(produtoId, TipoSaldo.FISCAL, 9, { db, empresaId: empresaA.id });
  await saldos.creditarSaldo(produtoId, TipoSaldo.NAO_FISCAL, 4, { db, empresaId: empresaB.id });
  const a = await ee(db, produtoId, empresaA.id);
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(a.saldo_fiscal, 9);
  assert.strictEqual(a.saldo_nao_fiscal, 0);
  assert.strictEqual(b.saldo_fiscal, 0);
  assert.strictEqual(b.saldo_nao_fiscal, 4);
  await closeDb(db);
}

function test11SemEmpresaIdUmArtificial() {
  const arquivos = [
    'services/compras/creditoEstoqueCompraViaPorta.js',
    'services/compras/debitoEstoqueCompraViaPorta.js',
    'services/vendas/debitoEstoqueVendaViaPorta.js',
    'services/vendas/creditoEstoqueVendaViaPorta.js',
    'services/ajusteEstoqueService.js',
    'services/estoque/EstoqueReservaService.js',
    'services/estoque/leituraEstoqueEmpresaProduto.js',
    'services/compras/estoqueAtualValidacaoCompra.js'
  ];
  for (const rel of arquivos) {
    const src = read(rel);
    assert.ok(!/empresaId\s*=\s*1\b/.test(src), rel);
    assert.ok(!/empresa_id\s*=\s*1\b/.test(src), rel);
  }
}

function test12WritersUsamPorta() {
  assert.ok(read('services/compras/creditoEstoqueCompraViaPorta.js').includes('creditarSaldo'));
  assert.ok(read('services/compras/debitoEstoqueCompraViaPorta.js').includes('debitarSaldo'));
  assert.ok(read('services/vendas/debitoEstoqueVendaViaPorta.js').includes('debitarSaldo'));
  assert.ok(read('services/vendas/creditoEstoqueVendaViaPorta.js').includes('creditarSaldo'));
  assert.ok(read('services/ajusteEstoqueService.js').includes('estoqueSaldosPublico'));
  assert.ok(read('services/estoque/EstoqueReservaService.js').includes('reservasPublico'));
  assert.ok(read('services/fiscalNaoFiscal/estoqueSaldosPublico.js').includes('aplicarEfeitoSaldo'));
  assert.ok(read('services/fiscalNaoFiscal/reservasPublico.js').includes('aplicarEfeitoReservado'));
  assert.ok(read('rotas/produtos.js').includes('criarMiddlewareContextoEmpresa'));
  assert.ok(read('rotas/vendas.js').includes('criarMiddlewareContextoEmpresa'));
  assert.ok(read('rotas/compras.js').includes('criarMiddlewareContextoEmpresa'));
  assert.ok(read('rotas/pedidos.js').includes('criarMiddlewareContextoEmpresa'));
}

async function main() {
  const testes = [
    ['01 schema estoque_empresa existe', test01SchemaExiste],
    ['02 produto pode ter estoques isolados', test02EstoquesIsolados],
    ['03 credito isola empresas', test03CreditoIsola],
    ['04 debito isola empresas', test04DebitoIsola],
    ['05 reserva isola empresas', test05ReservaIsola],
    ['06 leitura com empresa usa estoque_empresa', test06LeituraComEmpresaUsaEe],
    ['07 ausencia de registro nao copia legado', test07AusenciaNaoCopiaLegado],
    ['08 sem empresa mantem COMPAT/legado', test08SemEmpresaCompat],
    ['09 req.empresaId nao e substituido por body/query', test09ReqNaoSubstituidoPorBody],
    ['10 Empresa A nao altera Empresa B', test10ANaoAlteraB],
    ['11 nao existe empresaId = 1 artificial', test11SemEmpresaIdUmArtificial],
    ['12 writers usam a porta publica', test12WritersUsamPorta]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  ok ${nome}`);
  }
  console.log(`\nauditoria-fechamento-fundacao-multiempresa: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
