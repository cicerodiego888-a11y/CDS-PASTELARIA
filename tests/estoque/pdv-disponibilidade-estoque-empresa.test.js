/**
 * Fase 2 / Implementação 03.24 — disponibilidade de venda PDV por empresa.
 * Ponto real: overlay dos saldos antes de calcularEstoqueProduto /
 * saldosParaDistribuicaoVenda em VendaPagamentoService.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const {
  aplicarSaldosDisponibilidadeVenda,
  aplicarSaldosIdentificacaoPdv
} = require('../../backend/services/estoque/leituraEstoqueEmpresaProduto');
const { calcularEstoqueProduto } = require('../../backend/services/estoque/EstoqueDisponivelService');
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

async function decidirVenda(row, empresaId, db, quantidade) {
  const [overlay] = await aplicarSaldosDisponibilidadeVenda({
    produtos: [row],
    empresaId,
    db
  });
  const calc = calcularEstoqueProduto(overlay);
  const permitido = quantidade <= calc.disponivel_total + 1e-9;
  return { overlay, calc, permitido };
}

async function setup(saldosLegado = {}) {
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
      controla_estoque INTEGER DEFAULT 1
    )
  `);
  const ins = await run(
    db,
    `INSERT INTO produtos
       (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual, reservado_fiscal, reservado_nao_fiscal)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      'X',
      saldosLegado.sf ?? 100,
      saldosLegado.snf ?? 40,
      saldosLegado.ea ?? 140,
      saldosLegado.rf ?? 0,
      saldosLegado.rnf ?? 0
    ]
  );
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const b = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [ins.lastID]);
  return { db, produtoId: ins.lastID, empresaA: a, empresaB: b, row };
}

async function test01SemEmpresaLegado() {
  const { db, row } = await setup();
  const r = await decidirVenda(row, null, db, 5);
  assert.strictEqual(r.overlay.saldo_fiscal, 100);
  assert.strictEqual(r.permitido, true);
  const bloqueio = await decidirVenda(row, null, db, 200);
  assert.strictEqual(bloqueio.permitido, false);
  await closeDb(db);
}

async function test02EmpresaAPermite() {
  const { db, produtoId, empresaA, row } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaA.id, saldo_fiscal: 10, estoque_atual: 10
  }, { db });
  const r = await decidirVenda(row, empresaA.id, db, 5);
  assert.strictEqual(r.permitido, true);
  assert.strictEqual(r.calc.disponivel_fiscal, 10);
  await closeDb(db);
}

async function test03EmpresaBBloqueia() {
  const { db, produtoId, empresaB, row } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaB.id, saldo_fiscal: 3, estoque_atual: 3
  }, { db });
  const r = await decidirVenda(row, empresaB.id, db, 5);
  assert.strictEqual(r.permitido, false);
  assert.strictEqual(r.calc.disponivel_fiscal, 3);
  await closeDb(db);
}

async function test04Isolamento() {
  const { db, produtoId, empresaA, empresaB, row } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaA.id, saldo_fiscal: 10, estoque_atual: 10
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaB.id, saldo_fiscal: 3, estoque_atual: 3
  }, { db });
  const a = await decidirVenda(row, empresaA.id, db, 5);
  const b = await decidirVenda(row, empresaB.id, db, 5);
  assert.strictEqual(a.permitido, true);
  assert.strictEqual(b.permitido, false);
  assert.strictEqual(a.calc.saldo_fiscal, 10);
  assert.strictEqual(b.calc.saldo_fiscal, 3);
  await closeDb(db);
}

async function test05SemRegistroIndisponivel() {
  const { db, empresaA, row } = await setup();
  const r = await decidirVenda(row, empresaA.id, db, 1);
  assert.strictEqual(r.overlay.saldo_fiscal, 0);
  assert.strictEqual(r.overlay.estoque_atual, 0);
  assert.strictEqual(r.calc.disponivel_total, 0);
  assert.strictEqual(r.permitido, false);
  await closeDb(db);
}

async function test06SemFallback() {
  const { db, empresaA, row } = await setup();
  assert.strictEqual(row.saldo_fiscal, 100);
  const r = await decidirVenda(row, empresaA.id, db, 5);
  assert.strictEqual(r.overlay.saldo_fiscal, 0);
  assert.strictEqual(r.permitido, false);
  await closeDb(db);
}

async function test07Fiscal() {
  const { db, produtoId, empresaA, row } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId,
    empresaId: empresaA.id,
    saldo_fiscal: 10,
    saldo_nao_fiscal: 100,
    estoque_atual: 110
  }, { db });
  const r = await decidirVenda(row, empresaA.id, db, 5);
  assert.strictEqual(r.calc.disponivel_fiscal, 10);
  assert.ok(5 <= r.calc.disponivel_fiscal);
  const acima = await decidirVenda(row, empresaA.id, db, 11);
  assert.ok(11 > acima.calc.disponivel_fiscal);
  await closeDb(db);
}

async function test08NaoFiscal() {
  const { db, produtoId, empresaA, row } = await setup();
  await EstoqueEmpresaService.criarRegistro({
    produtoId,
    empresaId: empresaA.id,
    saldo_fiscal: 1,
    saldo_nao_fiscal: 8,
    estoque_atual: 9
  }, { db });
  const r = await decidirVenda(row, empresaA.id, db, 5);
  assert.strictEqual(r.calc.disponivel_nao_fiscal, 8);
  assert.ok(5 <= r.calc.disponivel_nao_fiscal);
  await closeDb(db);
}

async function test09Reservas() {
  const { db, produtoId, empresaA, row } = await setup({ sf: 100, snf: 0, ea: 100, rf: 0, rnf: 0 });
  await EstoqueEmpresaService.criarRegistro({
    produtoId,
    empresaId: empresaA.id,
    saldo_fiscal: 10,
    estoque_atual: 10,
    reservado_fiscal: 8,
    reservado_nao_fiscal: 0
  }, { db });
  const r = await decidirVenda(row, empresaA.id, db, 5);
  assert.strictEqual(r.calc.disponivel_fiscal, 2);
  assert.strictEqual(r.permitido, false);
  const ok = await decidirVenda(row, empresaA.id, db, 2);
  assert.strictEqual(ok.permitido, true);
  await closeDb(db);
}

async function test10SemEscrita() {
  const { db, produtoId, empresaA, row } = await setup();
  const antes = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  const nAntes = await get(db, 'SELECT COUNT(*) AS c FROM estoque_empresa');
  await decidirVenda(row, empresaA.id, db, 5);
  const depois = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  const nDepois = await get(db, 'SELECT COUNT(*) AS c FROM estoque_empresa');
  assert.strictEqual(depois.saldo_fiscal, antes.saldo_fiscal);
  assert.strictEqual(depois.estoque_atual, 140);
  assert.strictEqual(nDepois.c, nAntes.c);
  await closeDb(db);
}

async function test11Identificacao0323() {
  const src = fs.readFileSync(
    path.join(ROOT, 'backend/rotas/produtos.js'),
    'utf8'
  );
  assert.ok(src.includes('aplicarSaldosIdentificacaoPdv'));
  const helper = fs.readFileSync(
    path.join(ROOT, 'backend/services/estoque/leituraEstoqueEmpresaProduto.js'),
    'utf8'
  );
  assert.ok(helper.includes('async function aplicarSaldosIdentificacaoPdv'));
  const payload = await aplicarSaldosIdentificacaoPdv({
    payload: { encontrado: true, produtoId: 1, produto: { id: 1, nome: 'X' } },
    empresaId: null,
    db: null
  });
  assert.strictEqual(payload.payload.produto.nome, 'X');
}

async function test12FluxoLegadoEWiring() {
  const { db, row } = await setup();
  const r = await decidirVenda(row, null, db, 50);
  assert.strictEqual(r.permitido, true);
  assert.strictEqual(r.calc.saldo_fiscal, 100);

  const pag = fs.readFileSync(
    path.join(ROOT, 'backend/services/vendas/VendaPagamentoService.js'),
    'utf8'
  );
  assert.ok(pag.includes('aplicarSaldosDisponibilidadeVenda'));
  assert.ok(pag.includes('empresaId: req.empresaId'));
  assert.ok(pag.includes('debitarEstoqueItemVenda'));
  assert.ok(!pag.includes('consultarSaldoParaEmpresa'));

  const baixa = fs.readFileSync(
    path.join(ROOT, 'backend/services/vendas/debitoEstoqueVendaViaPorta.js'),
    'utf8'
  );
  assert.ok(!baixa.includes('aplicarSaldosDisponibilidadeVenda'));

  const porta = fs.readFileSync(
    path.join(ROOT, 'backend/services/fiscalNaoFiscal/estoqueSaldosPublico.js'),
    'utf8'
  );
  assert.ok(!porta.includes('aplicarSaldosDisponibilidadeVenda'));

  const pdv = fs.readFileSync(path.join(ROOT, 'frontend/pdv/js/pdv.js'), 'utf8');
  assert.ok(pdv.includes("headers['X-Empresa-Id']"));
  assert.ok(pdv.includes('anexarHeaderXhr'));

  await closeDb(db);
}

async function main() {
  const testes = [
    ['01 sem empresa legado', test01SemEmpresaLegado],
    ['02 empresa A permite', test02EmpresaAPermite],
    ['03 empresa B bloqueia', test03EmpresaBBloqueia],
    ['04 isolamento A/B', test04Isolamento],
    ['05 sem registro indisponivel', test05SemRegistroIndisponivel],
    ['06 sem fallback produtos', test06SemFallback],
    ['07 fiscal respeita SF', test07Fiscal],
    ['08 nao fiscal respeita SNF', test08NaoFiscal],
    ['09 reservas na disponibilidade', test09Reservas],
    ['10 sem escrita', test10SemEscrita],
    ['11 identificacao 03.23', test11Identificacao0323],
    ['12 legado e wiring', test12FluxoLegadoEWiring]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\npdv-disponibilidade-estoque-empresa: ${ok}/${testes.length} OK`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
