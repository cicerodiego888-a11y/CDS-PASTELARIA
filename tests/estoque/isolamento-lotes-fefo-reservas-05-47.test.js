/**
 * Sprint 05.47 — Isolamento empresarial de lotes, FEFO e reservas.
 * Executar: node tests/estoque/isolamento-lotes-fefo-reservas-05-47.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const { garantirSchemaLotesEmpresaAsync } = require('../../backend/services/estoque/lotesEmpresaSchema');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const lotesService = require('../../backend/services/lotesService');
const reservas = require('../../backend/services/fiscalNaoFiscal/reservasPublico');
const { TipoSaldo } = require('../../backend/services/fiscalNaoFiscal/constants');
const { devolverLotesParcialItem } = require('../../backend/services/vendas/VendaDevolucaoService');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function cb(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_) { resolve(); }
  });
}

function criarLoteAsync(dados) {
  return new Promise((resolve, reject) => {
    lotesService.criarLote(dados, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function consumirFefoAsync(produtoId, quantidade, opcoes) {
  return new Promise((resolve, reject) => {
    lotesService.consumirLotesFEFO(produtoId, quantidade, (err, consumo) => (
      err ? reject(err) : resolve(consumo)
    ), opcoes);
  });
}

function restaurarAsync(vendaItemId, opcoes) {
  return new Promise((resolve, reject) => {
    lotesService.restaurarLotesVenda(vendaItemId, (err) => (err ? reject(err) : resolve()), opcoes);
  });
}

function devolverParcialAsync(vendaItemId, quantidade, opcoes) {
  return new Promise((resolve, reject) => {
    devolverLotesParcialItem(vendaItemId, quantidade, (err) => (err ? reject(err) : resolve()), opcoes);
  });
}

function registrarConsumoAsync(vendaItemId, consumo, opcoes) {
  return new Promise((resolve, reject) => {
    lotesService.registrarConsumoVenda(vendaItemId, consumo, (err) => (err ? reject(err) : resolve()), opcoes);
  });
}

async function assertRejects(promise, codes) {
  const expected = Array.isArray(codes) ? codes : [codes];
  try {
    await promise;
    throw new Error(`Esperava falha (${expected.join('|')})`);
  } catch (err) {
    if (err.message && err.message.startsWith('Esperava falha')) throw err;
    assert.ok(
      expected.includes(err.code) || expected.some((c) => String(err.message).includes(c)),
      `esperado ${expected.join('|')}, veio ${err.code}/${err.message}`
    );
  }
}

async function setup() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  await run(db, `
    CREATE TABLE produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT,
      codigo TEXT,
      preco_venda REAL DEFAULT 0,
      saldo_fiscal REAL DEFAULT 0,
      saldo_nao_fiscal REAL DEFAULT 0,
      estoque_atual REAL DEFAULT 0,
      reservado_fiscal REAL DEFAULT 0,
      reservado_nao_fiscal REAL DEFAULT 0,
      controla_estoque INTEGER DEFAULT 1,
      controlar_validade INTEGER DEFAULT 1,
      updated_at DATETIME
    )
  `);
  await garantirSchemaLotesEmpresaAsync(db);
  await run(db, `
    CREATE TABLE venda_lotes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venda_item_id INTEGER NOT NULL,
      produto_lote_id INTEGER NOT NULL,
      quantidade REAL NOT NULL
    )
  `);
  await run(db, `
    CREATE TABLE vendas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER
    )
  `);
  await run(db, `
    CREATE TABLE vendas_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venda_id INTEGER,
      produto_id INTEGER
    )
  `);
  const p = await run(db, `INSERT INTO produtos (nome, saldo_fiscal, estoque_atual) VALUES ('Pastel', 0, 0)`);
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const b = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  return { db, produtoId: p.lastID, empresaA: a, empresaB: b };
}

async function seedEstoque(db, produtoId, empresaA, empresaB, qA = 10, qB = 10) {
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaA.id,
    saldo_fiscal: qA, saldo_nao_fiscal: 0, estoque_atual: qA, reservado_fiscal: 0
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaB.id,
    saldo_fiscal: qB, saldo_nao_fiscal: 0, estoque_atual: qB, reservado_fiscal: 0
  }, { db });
}

async function seedLotesAB(db, produtoId, empresaA, empresaB) {
  const loteA = await criarLoteAsync({
    db, empresaId: empresaA.id, produto_id: produtoId,
    lote: 'LA-A', quantidade_inicial: 10,
    data_validade: '2030-12-31', data_entrada: '2026-01-01', origem: 'TESTE'
  });
  const loteB = await criarLoteAsync({
    db, empresaId: empresaB.id, produto_id: produtoId,
    lote: 'LB-B', quantidade_inicial: 10,
    data_validade: '2026-01-01', data_entrada: '2026-01-01', origem: 'TESTE'
  });
  return { loteA, loteB };
}

async function t01FefoASoVeLoteA() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedLotesAB(db, produtoId, empresaA, empresaB);
  const lotes = await lotesService.selecionarLoteFefo({
    db, empresaId: empresaA.id, produtoId, quantidade: 1
  });
  assert.strictEqual(lotes.length, 1);
  assert.strictEqual(lotes[0].lote, 'LA-A');
  assert.strictEqual(lotes[0].empresa_id, empresaA.id);
  await closeDb(db);
}

async function t02ValidadeBMenorNaoVazaParaA() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedLotesAB(db, produtoId, empresaA, empresaB);
  const consumo = await consumirFefoAsync(produtoId, 3, { db, empresaId: empresaA.id });
  assert.strictEqual(consumo.length, 1);
  assert.strictEqual(consumo[0].lote, 'LA-A');
  const b = await get(db, 'SELECT quantidade_atual FROM produtos_lotes WHERE lote = ?', ['LB-B']);
  assert.strictEqual(Number(b.quantidade_atual), 10);
  const a = await get(db, 'SELECT quantidade_atual FROM produtos_lotes WHERE lote = ?', ['LA-A']);
  assert.strictEqual(Number(a.quantidade_atual), 7);
  await closeDb(db);
}

async function t03EmpresaASemLoteNaoUsaB() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await criarLoteAsync({
    db, empresaId: empresaB.id, produto_id: produtoId,
    lote: 'SO-B', quantidade_inicial: 8,
    data_validade: '2026-06-01', data_entrada: '2026-01-01', origem: 'TESTE'
  });
  await assertRejects(
    consumirFefoAsync(produtoId, 1, { db, empresaId: empresaA.id }),
    ['Não há lotes disponíveis']
  );
  const b = await get(db, 'SELECT quantidade_atual FROM produtos_lotes WHERE lote = ?', ['SO-B']);
  assert.strictEqual(Number(b.quantidade_atual), 8);
  await closeDb(db);
}

async function t04SaldoEmpresarialIsolado() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedEstoque(db, produtoId, empresaA, empresaB, 10, 4);
  const dispA = await reservas.consultarDisponibilidade(produtoId, { db, empresaId: empresaA.id });
  const dispB = await reservas.consultarDisponibilidade(produtoId, { db, empresaId: empresaB.id });
  assert.strictEqual(dispA.saldo_fiscal, 10);
  assert.strictEqual(dispB.saldo_fiscal, 4);
  assert.notStrictEqual(dispA.disponivel_fiscal, dispB.disponivel_fiscal);
  await closeDb(db);
}

async function t05ReservaAReduzSoA() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedEstoque(db, produtoId, empresaA, empresaB, 10, 10);
  await reservas.criarReservaFiscal({
    pedidoId: 1, produtoId, quantidade: 3, empresaId: empresaA.id, db
  });
  const a = await get(db, 'SELECT reservado_fiscal FROM estoque_empresa WHERE empresa_id = ?', [empresaA.id]);
  const b = await get(db, 'SELECT reservado_fiscal FROM estoque_empresa WHERE empresa_id = ?', [empresaB.id]);
  assert.strictEqual(Number(a.reservado_fiscal), 3);
  assert.strictEqual(Number(b.reservado_fiscal), 0);
  await closeDb(db);
}

async function t06ReservaBNaoInterfereEmA() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedEstoque(db, produtoId, empresaA, empresaB, 10, 10);
  await reservas.criarReservaFiscal({
    pedidoId: 2, produtoId, quantidade: 4, empresaId: empresaB.id, db
  });
  const dispA = await reservas.consultarDisponibilidade(produtoId, { db, empresaId: empresaA.id });
  assert.strictEqual(dispA.disponivel_fiscal, 10);
  assert.strictEqual(dispA.reservado_fiscal, 0);
  await closeDb(db);
}

async function t07OversellBloqueado() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedEstoque(db, produtoId, empresaA, empresaB, 5, 100);
  await assertRejects(
    reservas.criarReservaFiscal({
      pedidoId: 3, produtoId, quantidade: 6, empresaId: empresaA.id, db
    }),
    'SALDO_INSUFICIENTE'
  );
  const a = await get(db, 'SELECT reservado_fiscal FROM estoque_empresa WHERE empresa_id = ?', [empresaA.id]);
  assert.strictEqual(Number(a.reservado_fiscal), 0);
  await closeDb(db);
}

async function t08DuasEmpresasReservamNoProprioSaldo() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedEstoque(db, produtoId, empresaA, empresaB, 5, 5);
  await reservas.criarReservaFiscal({
    pedidoId: 4, produtoId, quantidade: 5, empresaId: empresaA.id, db
  });
  await reservas.criarReservaFiscal({
    pedidoId: 5, produtoId, quantidade: 5, empresaId: empresaB.id, db
  });
  const a = await get(db, 'SELECT reservado_fiscal FROM estoque_empresa WHERE empresa_id = ?', [empresaA.id]);
  const b = await get(db, 'SELECT reservado_fiscal FROM estoque_empresa WHERE empresa_id = ?', [empresaB.id]);
  assert.strictEqual(Number(a.reservado_fiscal), 5);
  assert.strictEqual(Number(b.reservado_fiscal), 5);
  await closeDb(db);
}

async function t09LiberacaoANaoAlteraB() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedEstoque(db, produtoId, empresaA, empresaB, 10, 10);
  await reservas.criarReservaFiscal({
    pedidoId: 6, produtoId, quantidade: 3, empresaId: empresaA.id, db
  });
  await reservas.criarReservaFiscal({
    pedidoId: 7, produtoId, quantidade: 4, empresaId: empresaB.id, db
  });
  await reservas.liberarReservasPedido(6, { db, empresaId: empresaA.id });
  const a = await get(db, 'SELECT reservado_fiscal FROM estoque_empresa WHERE empresa_id = ?', [empresaA.id]);
  const b = await get(db, 'SELECT reservado_fiscal FROM estoque_empresa WHERE empresa_id = ?', [empresaB.id]);
  assert.strictEqual(Number(a.reservado_fiscal), 0);
  assert.strictEqual(Number(b.reservado_fiscal), 4);
  await closeDb(db);
}

async function t10ConsumoUsaEstoqueDaDona() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedEstoque(db, produtoId, empresaA, empresaB, 10, 10);
  await run(db, `
    CREATE TABLE IF NOT EXISTS pedidos (
      id INTEGER PRIMARY KEY,
      empresa_id INTEGER,
      status TEXT DEFAULT 'PEDIDO'
    )
  `);
  await run(db, `INSERT INTO pedidos (id, empresa_id, status) VALUES (8, ?, 'PEDIDO')`, [empresaA.id]);
  await reservas.criarReservaFiscal({
    pedidoId: 8, produtoId, quantidade: 3, empresaId: empresaA.id, db
  });
  const { consumirReservasPedidoNaVenda } = require('../../backend/services/estoque/pedidoReservaPonteNucleo');
  await consumirReservasPedidoNaVenda(8, 99, { db, empresaId: empresaA.id });
  const a = await get(db, 'SELECT reservado_fiscal FROM estoque_empresa WHERE empresa_id = ?', [empresaA.id]);
  const b = await get(db, 'SELECT reservado_fiscal FROM estoque_empresa WHERE empresa_id = ?', [empresaB.id]);
  assert.strictEqual(Number(a.reservado_fiscal), 0);
  assert.strictEqual(Number(b.reservado_fiscal), 0);
  const status = await get(db, `SELECT status FROM pedido_estoque_reservas WHERE pedido_id = 8`);
  assert.strictEqual(status.status, 'CONSUMIDA');
  await closeDb(db);
}

async function t11CancelamentoRestauraLoteOriginal() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  const { loteA } = await seedLotesAB(db, produtoId, empresaA, empresaB);
  const consumo = await consumirFefoAsync(produtoId, 2, { db, empresaId: empresaA.id });
  await run(db, 'INSERT INTO vendas_itens (id, venda_id, produto_id) VALUES (1, 1, ?)', [produtoId]);
  await registrarConsumoAsync(1, consumo, { db });
  await restaurarAsync(1, { db, empresaId: empresaA.id });
  const a = await get(db, 'SELECT quantidade_atual FROM produtos_lotes WHERE id = ?', [loteA.id]);
  const b = await get(db, 'SELECT quantidade_atual FROM produtos_lotes WHERE lote = ?', ['LB-B']);
  assert.strictEqual(Number(a.quantidade_atual), 10);
  assert.strictEqual(Number(b.quantidade_atual), 10);
  await closeDb(db);
}

async function t12DevolucaoRestauraLoteOriginal() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedLotesAB(db, produtoId, empresaA, empresaB);
  const consumo = await consumirFefoAsync(produtoId, 4, { db, empresaId: empresaA.id });
  await run(db, 'INSERT INTO vendas_itens (id, venda_id, produto_id) VALUES (2, 2, ?)', [produtoId]);
  await registrarConsumoAsync(2, consumo, { db });
  await devolverParcialAsync(2, 4, { db, empresaId: empresaA.id });
  const a = await get(db, 'SELECT quantidade_atual FROM produtos_lotes WHERE lote = ?', ['LA-A']);
  const b = await get(db, 'SELECT quantidade_atual FROM produtos_lotes WHERE lote = ?', ['LB-B']);
  assert.strictEqual(Number(a.quantidade_atual), 10);
  assert.strictEqual(Number(b.quantidade_atual), 10);
  await closeDb(db);
}

async function t13ContextoBNaoManipulaReservaA() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedEstoque(db, produtoId, empresaA, empresaB, 10, 10);
  const r = await reservas.criarReservaFiscal({
    pedidoId: 9, produtoId, quantidade: 2, empresaId: empresaA.id, db
  });
  await assertRejects(
    reservas.obterReservaPedidoDaEmpresa(r.id, empresaB.id, { db }),
    'RESERVA_NAO_ENCONTRADA'
  );
  await assertRejects(
    reservas.cancelarReservaPedidoDaEmpresa(r.id, empresaB.id, { db }),
    'RESERVA_NAO_ENCONTRADA'
  );
  const a = await get(db, 'SELECT reservado_fiscal, status FROM estoque_empresa ee, pedido_estoque_reservas pr WHERE pr.id = ? AND ee.empresa_id = ?', [r.id, empresaA.id]);
  const row = await get(db, 'SELECT status FROM pedido_estoque_reservas WHERE id = ?', [r.id]);
  const ee = await get(db, 'SELECT reservado_fiscal FROM estoque_empresa WHERE empresa_id = ?', [empresaA.id]);
  assert.strictEqual(row.status, 'ATIVA');
  assert.strictEqual(Number(ee.reservado_fiscal), 2);
  await closeDb(db);
}

async function t14ContextoBNaoAcessaLoteA() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  const { loteA } = await seedLotesAB(db, produtoId, empresaA, empresaB);
  await assertRejects(
    lotesService.obterLoteDaEmpresa(loteA.id, empresaB.id, null, { db }),
    'LOTE_NAO_ENCONTRADO'
  );
  const ainda = await get(db, 'SELECT quantidade_atual FROM produtos_lotes WHERE id = ?', [loteA.id]);
  assert.strictEqual(Number(ainda.quantidade_atual), 10);
  await closeDb(db);
}

async function t15LegadoNaoRecebeEmpresa() {
  const { db, produtoId, empresaA } = await setup();
  const ins = await run(db, `
    INSERT INTO produtos_lotes (
      produto_id, lote, quantidade_inicial, quantidade_atual,
      data_validade, data_entrada, origem, ativo
    ) VALUES (?, 'LEGADO', 5, 5, '2026-05-01', '2026-01-01', 'LEGADO', 1)
  `, [produtoId]);
  const row = await get(db, 'SELECT empresa_id FROM produtos_lotes WHERE id = ?', [ins.lastID]);
  assert.strictEqual(row.empresa_id, null);
  const fefo = await lotesService.selecionarLoteFefo({
    db, empresaId: empresaA.id, produtoId, quantidade: 1
  });
  assert.strictEqual(fefo.length, 0);
  const depois = await get(db, 'SELECT empresa_id FROM produtos_lotes WHERE id = ?', [ins.lastID]);
  assert.strictEqual(depois.empresa_id, null);
  await closeDb(db);
}

async function t16OperacaoSemEmpresa() {
  const { db, produtoId } = await setup();
  await assertRejects(
    lotesService.selecionarLoteFefo({ db, produtoId, quantidade: 1 }),
    ['EMPRESA_CONTEXT_REQUIRED', 'EMPRESA_OWNERSHIP_REQUIRED', 'EMPRESA_OBRIGATORIA']
  );
  await assertRejects(
    consumirFefoAsync(produtoId, 1, { db }),
    ['EMPRESA_CONTEXT_REQUIRED', 'EMPRESA_OWNERSHIP_REQUIRED', 'EMPRESA_OBRIGATORIA']
  );
  await assertRejects(
    criarLoteAsync({
      db, produto_id: produtoId, lote: 'X', quantidade_inicial: 1,
      data_validade: '2030-01-01', data_entrada: '2026-01-01'
    }),
    ['EMPRESA_CONTEXT_REQUIRED', 'EMPRESA_OWNERSHIP_REQUIRED', 'EMPRESA_OBRIGATORIA']
  );
  await closeDb(db);
}

async function t17ReprocessoNaoDuplica() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedEstoque(db, produtoId, empresaA, empresaB, 10, 10);
  const r1 = await reservas.criarReservaFiscal({
    pedidoId: 10, produtoId, quantidade: 3, empresaId: empresaA.id, db
  });
  const r2 = await reservas.criarReservaFiscal({
    pedidoId: 10, produtoId, quantidade: 3, empresaId: empresaA.id, db
  });
  assert.strictEqual(r1.id, r2.id);
  const a = await get(db, 'SELECT reservado_fiscal FROM estoque_empresa WHERE empresa_id = ?', [empresaA.id]);
  assert.strictEqual(Number(a.reservado_fiscal), 3);
  const n = await get(db, `SELECT COUNT(*) AS c FROM pedido_estoque_reservas WHERE pedido_id = 10 AND status = 'ATIVA'`);
  assert.strictEqual(n.c, 1);
  await closeDb(db);
}

async function t18TransacaoOversell() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedEstoque(db, produtoId, empresaA, empresaB, 5, 5);
  await reservas.criarReservaFiscal({
    pedidoId: 11, produtoId, quantidade: 5, empresaId: empresaA.id, db
  });
  await assertRejects(
    reservas.criarReservaFiscal({
      pedidoId: 12, produtoId, quantidade: 1, empresaId: empresaA.id, db
    }),
    'SALDO_INSUFICIENTE'
  );
  const a = await get(db, 'SELECT reservado_fiscal FROM estoque_empresa WHERE empresa_id = ?', [empresaA.id]);
  assert.strictEqual(Number(a.reservado_fiscal), 5);

  const srcReservas = src('backend/services/fiscalNaoFiscal/reservasPublico.js');
  assert.ok(srcReservas.includes('BEGIN IMMEDIATE'));
  const criar = srcReservas.slice(
    srcReservas.indexOf('async function _criarReservaTipo'),
    srcReservas.indexOf('async function criarReservaFiscal')
  );
  assert.ok(criar.includes('consultarDisponibilidade'));
  assert.ok(criar.includes('executarComTxOuReutilizar'));

  const srcFefo = src('backend/services/lotesService.js');
  assert.ok(srcFefo.includes('WHERE pl.empresa_id = ?'));
  assert.ok(srcFefo.includes('ORDER BY pl.data_validade ASC, pl.id ASC'));
  assert.ok(!/FROM produtos_lotes[\s\S]*WHERE pl\.produto_id = \?[\s\S]*ORDER BY pl\.data_validade ASC\s*$/m.test(
    srcFefo.slice(srcFefo.indexOf('function sqlLotesFefoEmpresa'), srcFefo.indexOf('function withSchema'))
  ));
  await closeDb(db);
}

async function tQueriesGlobaisEliminadas() {
  const lotes = src('backend/services/lotesService.js');
  const fefo = lotes.slice(
    lotes.indexOf('function sqlLotesFefoEmpresa'),
    lotes.indexOf('function withSchema')
  );
  assert.ok(fefo.includes('pl.empresa_id = ?'));
  assert.ok(fefo.includes('pl.produto_id = ?'));
  const consumir = lotes.slice(
    lotes.indexOf('function consumirLotesFEFO'),
    lotes.indexOf('function registrarConsumoVenda')
  );
  assert.ok(consumir.includes('exigirEmpresaContexto'));
  assert.ok(consumir.includes('AND empresa_id = ?'));
}

async function main() {
  const testes = [
    ['T01 FEFO A so encontra lote A', t01FefoASoVeLoteA],
    ['T02 validade B menor nao e consumida por A', t02ValidadeBMenorNaoVazaParaA],
    ['T03 A sem lote nao usa lote B', t03EmpresaASemLoteNaoUsaB],
    ['T04 saldo empresarial isolado', t04SaldoEmpresarialIsolado],
    ['T05 reserva A reduz so A', t05ReservaAReduzSoA],
    ['T06 reserva B nao interfere em A', t06ReservaBNaoInterfereEmA],
    ['T07 oversell da empresa bloqueado', t07OversellBloqueado],
    ['T08 duas empresas reservam no proprio saldo', t08DuasEmpresasReservamNoProprioSaldo],
    ['T09 liberacao A nao altera B', t09LiberacaoANaoAlteraB],
    ['T10 consumo usa estoque da dona', t10ConsumoUsaEstoqueDaDona],
    ['T11 cancelamento restaura lote original', t11CancelamentoRestauraLoteOriginal],
    ['T12 devolucao restaura lote original', t12DevolucaoRestauraLoteOriginal],
    ['T13 contexto B reserva A = 404', t13ContextoBNaoManipulaReservaA],
    ['T14 contexto B lote A = 404', t14ContextoBNaoAcessaLoteA],
    ['T15 legado nao recebe empresa', t15LegadoNaoRecebeEmpresa],
    ['T16 operacao sem empresa', t16OperacaoSemEmpresa],
    ['T17 reprocesso nao duplica', t17ReprocessoNaoDuplica],
    ['T18 transacao impede oversell', t18TransacaoOversell],
    ['queries FEFO empresariais', tQueriesGlobaisEliminadas]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\nisolamento-lotes-fefo-reservas-05-47: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
