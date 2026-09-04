/**
 * Fase 2 / Implementação 03.6 — Consumo de reserva de pedido via porta pública.
 *
 * Mutador: consumirReservasPedidoNaVenda
 * Porta: reservasPublico.liberarQuantidadeReservada (somente reservado_fiscal)
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const {
  consumirReservasPedidoNaVenda,
  montarOptsPortaConsumoReservaPedido
} = require('../../backend/services/estoque/pedidoReservaPonteNucleo');

const ROOT = path.resolve(__dirname, '../..');
const SRC_PONTE = path.join(ROOT, 'backend/services/estoque/pedidoReservaPonteNucleo.js');
const SRC_PAGAMENTO = path.join(ROOT, 'backend/services/vendas/VendaPagamentoService.js');
const SRC_DEBITO_VENDA = path.join(ROOT, 'backend/services/vendas/debitoEstoqueVendaViaPorta.js');
const SRC_PDV_RESERVA = path.join(ROOT, 'backend/services/estoque/EstoqueReservaService.js');
const SRC_PDV_CONSUMO = path.join(ROOT, 'backend/services/estoque/EstoqueConsumoReserva.js');
const SRC_MTS = path.join(ROOT, 'backend/motores/mts/MtsService.js');
const SRC_MUC = path.join(ROOT, 'backend/motores/muc/index.js');
const SRC_COMERCIAL = path.join(ROOT, 'backend/motores/comercial/MotorComercialService.js');
const SRC_REPAIR = path.join(ROOT, 'backend/motores/comercial/ReservaRepairService.js');
const SRC_DISTRIBUIDOR = path.join(ROOT, 'backend/services/distribuidorEstoqueVenda.js');
const SRC_FXNF_CONST = path.join(ROOT, 'backend/services/fiscalNaoFiscal/constants.js');
const SRC_PORTA = path.join(ROOT, 'backend/services/fiscalNaoFiscal/reservasPublico.js');

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

async function setup({ sf = 100, snf = 50, rf = 10, rnf = 4 } = {}) {
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
      controla_estoque INTEGER DEFAULT 1,
      updated_at DATETIME
    )
  `);
  await run(db, `CREATE TABLE empresas (id INTEGER PRIMARY KEY, razao TEXT)`);
  await run(db, `INSERT INTO empresas (id, razao) VALUES (1, 'A')`);
  await run(db, `
    CREATE TABLE pedidos (
      id INTEGER PRIMARY KEY,
      empresa_id INTEGER,
      status TEXT DEFAULT 'PEDIDO'
    )
  `);
  await run(db, `
    CREATE TABLE pedido_estoque_reservas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER NOT NULL,
      pedido_item_id INTEGER,
      produto_id INTEGER NOT NULL,
      quantidade_fiscal REAL NOT NULL DEFAULT 0,
      empresa_id INTEGER,
      status TEXT NOT NULL DEFAULT 'ATIVA',
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      atualizado_em DATETIME
    )
  `);
  await run(db, `
    CREATE TABLE venda_estoque_reservas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venda_id INTEGER,
      produto_id INTEGER,
      quantidade_fiscal REAL DEFAULT 0,
      quantidade_nao_fiscal REAL DEFAULT 0,
      status TEXT DEFAULT 'ATIVA'
    )
  `);

  const p = await run(
    db,
    `INSERT INTO produtos
       (nome, saldo_fiscal, saldo_nao_fiscal, reservado_fiscal, reservado_nao_fiscal, estoque_atual)
     VALUES ('Pedido', ?, ?, ?, ?, ?)`,
    [sf, snf, rf, rnf, sf + snf]
  );
  return { db, produtoId: p.lastID, empresaId: 1 };
}

async function seedPedido(db, id, empresaId = 1) {
  await run(
    db,
    `INSERT OR IGNORE INTO pedidos (id, empresa_id, status) VALUES (?, ?, 'PEDIDO')`,
    [id, empresaId]
  );
}

async function seedReserva(db, { pedidoId, produtoId, qtdFiscal, status = 'ATIVA', empresaId = 1, skipPedido = false }) {
  if (!skipPedido) {
    await seedPedido(db, pedidoId, empresaId);
  }
  const r = await run(
    db,
    `INSERT INTO pedido_estoque_reservas
       (pedido_id, produto_id, quantidade_fiscal, status, empresa_id)
     VALUES (?, ?, ?, ?, ?)`,
    [pedidoId, produtoId, qtdFiscal, status, empresaId]
  );
  return r.lastID;
}

function extrairFuncaoConsumo(src) {
  const inicio = src.indexOf('async function consumirReservasPedidoNaVenda');
  const fim = src.indexOf('function obterCreditoReservaPedidoCb');
  assert.ok(inicio >= 0 && fim > inicio, 'consumirReservasPedidoNaVenda não encontrada');
  return src.slice(inicio, fim);
}

async function test01ConsumoReservaFiscal() {
  const { db, produtoId, empresaId } = await setup({ rf: 10, rnf: 4 });
  await seedReserva(db, { pedidoId: 77, produtoId, qtdFiscal: 7 });

  const r = await consumirReservasPedidoNaVenda(77, 9001, { db, empresaId });
  assert.strictEqual(r.consumidas, 1);
  assert.strictEqual(r.pedido_id, 77);
  assert.strictEqual(r.venda_id, 9001);

  const reserva = await get(db, 'SELECT status FROM pedido_estoque_reservas WHERE pedido_id = 77');
  assert.strictEqual(reserva.status, 'CONSUMIDA');
  await closeDb(db);
}

async function test02ReservadoFiscalDiminui() {
  const { db, produtoId, empresaId } = await setup({ rf: 10, rnf: 4 });
  await seedReserva(db, { pedidoId: 78, produtoId, qtdFiscal: 6 });

  await consumirReservasPedidoNaVenda(78, 1, { db, empresaId });
  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.reservado_fiscal, 4);
  assert.strictEqual(row.reservado_nao_fiscal, 4);
  await closeDb(db);
}

async function test03SaldoFisicoNaoMuda() {
  const { db, produtoId, empresaId } = await setup({ sf: 80, snf: 30, rf: 12, rnf: 5 });
  await seedReserva(db, { pedidoId: 79, produtoId, qtdFiscal: 5 });

  await consumirReservasPedidoNaVenda(79, 1, { db, empresaId });
  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.saldo_fiscal, 80);
  assert.strictEqual(row.saldo_nao_fiscal, 30);
  assert.strictEqual(row.estoque_atual, 110);
  assert.strictEqual(row.reservado_fiscal, 7);
  await closeDb(db);
}

async function test04EmpresaIdPropagado() {
  const { db, produtoId, empresaId } = await setup();
  await seedReserva(db, { pedidoId: 80, produtoId, qtdFiscal: 1 });

  const r = await consumirReservasPedidoNaVenda(80, 1, { db, empresaId });
  assert.strictEqual(r.empresa_id, empresaId);
  assert.strictEqual(r.legado, false);

  const viaOpcoes = montarOptsPortaConsumoReservaPedido({ db, empresaId: 1 });
  assert.strictEqual(viaOpcoes.empresaId, 1);
  assert.strictEqual(viaOpcoes.legado, false);
  assert.strictEqual(viaOpcoes.motivoCompat, null);

  await assertRejects(
    Promise.resolve().then(() => montarOptsPortaConsumoReservaPedido({
      db,
      contexto: { empresa_id: 1 }
    })),
    'EMPRESA_CONTEXT_REQUIRED'
  );
  await closeDb(db);
}

async function test05CompatExplicita() {
  const { db, produtoId } = await setup();

  await assertRejects(
    consumirReservasPedidoNaVenda(999, 1, { db }),
    'PEDIDO_NAO_ENCONTRADO'
  );

  await run(
    db,
    `INSERT INTO pedidos (id, empresa_id, status) VALUES (81, NULL, 'PEDIDO')`
  );
  await seedReserva(db, { pedidoId: 81, produtoId, qtdFiscal: 2, skipPedido: true });
  await assertRejects(
    consumirReservasPedidoNaVenda(81, 1, { db }),
    'EMPRESA_OWNERSHIP_REQUIRED'
  );

  await assertRejects(
    Promise.resolve().then(() => montarOptsPortaConsumoReservaPedido({ db })),
    'EMPRESA_CONTEXT_REQUIRED'
  );

  const src = fs.readFileSync(SRC_PONTE, 'utf8');
  assert.ok(!src.includes('COMPAT_CONSUMO_RESERVA_PEDIDO_PRE_MULTIEMPRESA'));
  assert.ok(!src.includes('COMPAT_CERTIFICADA_PRE_MULTIEMPRESA'));
  assert.ok(!/empresaId\s*\|\|/.test(src));
  assert.ok(!/empresaId\s*\?\?/.test(src));
  assert.ok(!/configuracoes\.cnpj/.test(src));
  await closeDb(db);
}

async function test06RollbackRestauraReservado() {
  const { db, produtoId, empresaId } = await setup({ rf: 15, rnf: 4 });
  await seedReserva(db, { pedidoId: 82, produtoId, qtdFiscal: 8 });

  await run(db, 'BEGIN');
  await consumirReservasPedidoNaVenda(82, 1, { db, empresaId });
  const mid = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(mid.reservado_fiscal, 7);
  await run(db, 'ROLLBACK');

  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.reservado_fiscal, 15);
  assert.strictEqual(row.reservado_nao_fiscal, 4);
  assert.strictEqual(row.saldo_fiscal, 100);
  await closeDb(db);
}

async function test07ConsumoNaoDuplica() {
  const { db, produtoId, empresaId } = await setup({ rf: 10 });
  await seedReserva(db, { pedidoId: 83, produtoId, qtdFiscal: 4 });

  const r1 = await consumirReservasPedidoNaVenda(83, 1, { db, empresaId });
  assert.strictEqual(r1.consumidas, 1);
  const depois1 = await get(db, 'SELECT reservado_fiscal FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(depois1.reservado_fiscal, 6);

  const r2 = await consumirReservasPedidoNaVenda(83, 1, { db, empresaId });
  assert.strictEqual(r2.consumidas, 0);
  const depois2 = await get(db, 'SELECT reservado_fiscal FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(depois2.reservado_fiscal, 6);

  const jaConsumida = await seedReserva(db, {
    pedidoId: 84,
    produtoId,
    qtdFiscal: 3,
    status: 'CONSUMIDA'
  });
  assert.ok(jaConsumida > 0);
  const r3 = await consumirReservasPedidoNaVenda(84, 1, { db, empresaId });
  assert.strictEqual(r3.consumidas, 0);
  await closeDb(db);
}

async function test08SqlDiretoRemovido() {
  const src = fs.readFileSync(SRC_PONTE, 'utf8');
  const fn = extrairFuncaoConsumo(src);

  assert.ok(src.includes('reservasPublico'));
  assert.ok(fn.includes('liberarQuantidadeReservada'));
  assert.ok(!/UPDATE\s+produtos/i.test(fn), 'consumo não deve UPDATE produtos');
  assert.ok(!/SET\s+reservado_fiscal/i.test(fn));
  assert.ok(!/SET\s+reservado_nao_fiscal/i.test(fn));
  assert.ok(!/SET\s+saldo_fiscal/i.test(fn));
  assert.ok(!/SET\s+estoque_atual/i.test(fn));
  assert.ok(
    /UPDATE\s+pedido_estoque_reservas\s+SET\s+status\s*=\s*'CONSUMIDA'/i.test(fn),
    'tracking CONSUMIDA permanece'
  );
  assert.ok(!fn.includes('venda_estoque_reservas'));
}

async function test09BaixaFisicaContinua02_6() {
  const ponte = fs.readFileSync(SRC_PONTE, 'utf8');
  const pagamento = fs.readFileSync(SRC_PAGAMENTO, 'utf8');
  const debito = fs.readFileSync(SRC_DEBITO_VENDA, 'utf8');

  assert.ok(!ponte.includes('debitarSaldo'));
  assert.ok(!ponte.includes('creditarSaldo'));
  assert.ok(!ponte.includes('reduzirEstoqueDistribuido'));
  assert.ok(!ponte.includes('debitarEstoqueItemVenda'));
  assert.ok(!ponte.includes('estoqueSaldosPublico'));

  assert.ok(debito.includes('debitarSaldo'));
  assert.ok(pagamento.includes('debitarEstoqueItemVenda'));
  assert.ok(pagamento.includes('consumirReservasPedidoNaVendaCb'));
  assert.ok(
    pagamento.includes('consumirReservaPedidoAposBaixa')
      || /consumirReservasPedidoNaVendaCb\(pedidoIdVenda/.test(pagamento),
    'consumo de reserva permanece após a baixa 02.6'
  );
}

async function test10MotoresEPdvIntacto() {
  const mts = fs.readFileSync(SRC_MTS, 'utf8');
  const muc = fs.readFileSync(SRC_MUC, 'utf8');
  const comercial = fs.readFileSync(SRC_COMERCIAL, 'utf8');
  const repair = fs.readFileSync(SRC_REPAIR, 'utf8');
  const distribuidor = fs.readFileSync(SRC_DISTRIBUIDOR, 'utf8');
  const pdvReserva = fs.readFileSync(SRC_PDV_RESERVA, 'utf8');
  const pdvConsumo = fs.readFileSync(SRC_PDV_CONSUMO, 'utf8');
  const constants = fs.readFileSync(SRC_FXNF_CONST, 'utf8');
  const porta = fs.readFileSync(SRC_PORTA, 'utf8');
  const ponte = fs.readFileSync(SRC_PONTE, 'utf8');

  assert.ok(!mts.includes('COMPAT_CONSUMO_RESERVA_PEDIDO_PRE_MULTIEMPRESA'));
  assert.ok(!muc.includes('COMPAT_CONSUMO_RESERVA_PEDIDO_PRE_MULTIEMPRESA'));
  assert.ok(!comercial.includes('consumirReservasPedidoNaVenda'));
  assert.ok(!distribuidor.includes('consumirReservasPedidoNaVenda'));
  assert.ok(pdvReserva.includes('venda_estoque_reservas') || pdvConsumo.includes('venda_estoque_reservas'));
  assert.ok(pdvConsumo.includes('liberarQuantidadeReservada'));
  assert.ok(!pdvConsumo.includes('pedido_estoque_reservas'));
  assert.ok(constants.includes("FISCAL: 'FISCAL'"));
  assert.ok(constants.includes("NAO_FISCAL: 'NAO_FISCAL'"));
  assert.ok(porta.includes('liberarQuantidadeReservada'));
  assert.ok(!ponte.includes('ReservaRepairService'));
  assert.ok(repair.includes('reservasPublico'), '03.7: Repair usa a porta');
  assert.ok(!/UPDATE\s+produtos/i.test(repair), '03.7: Repair sem UPDATE produtos');
  assert.ok(!fs.existsSync(path.join(ROOT, 'backend/database/estoque_empresa')));
  assert.ok(!fs.existsSync(path.join(ROOT, 'backend/services/reservaPedidoPublico2.js')));
  assert.ok(!fs.existsSync(path.join(ROOT, 'backend/services/pedidoReservaPublico2.js')));
  assert.ok(!fs.existsSync(path.join(ROOT, 'backend/services/ReservaService2.js')));
}

async function main() {
  const testes = [
    ['01 consumo reserva fiscal', test01ConsumoReservaFiscal],
    ['02 reservado_fiscal diminui', test02ReservadoFiscalDiminui],
    ['03 saldo fisico nao muda', test03SaldoFisicoNaoMuda],
    ['04 empresaId propagado', test04EmpresaIdPropagado],
    ['05 ownership do pedido (helper exige empresa)', test05CompatExplicita],
    ['06 rollback restaura reservado', test06RollbackRestauraReservado],
    ['07 consumo nao duplica', test07ConsumoNaoDuplica],
    ['08 SQL direto de reservado removido', test08SqlDiretoRemovido],
    ['09 baixa fisica permanece 02.6', test09BaixaFisicaContinua02_6],
    ['10 motores / PDV intactos', test10MotoresEPdvIntacto]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\nconsumo-reserva-pedido-porta-publica: ${ok}/${testes.length} OK`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
