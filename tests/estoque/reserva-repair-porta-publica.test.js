/**
 * Fase 2 / Implementação 03.7 — ReservaRepairService via porta pública.
 *
 * Escritores: LIBERAR / REMOVER / CRIAR / AJUSTAR
 * Porta: reservasPublico.reservarQuantidade / liberarQuantidadeReservada
 * Somente reservado_fiscal (comportamento encontrado).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const {
  executarPlano,
  montarOptsPortaReservaRepair,
  MOTIVO_COMPAT_RESERVA_REPAIR
} = require('../../backend/motores/comercial/ReservaRepairService');
const {
  montarPlanoCorrecao,
  TipoInconsistencia
} = require('../../backend/motores/comercial/ReservaReconciliationService');
const { PedidoStatus } = require('../../backend/services/pedido/enums');

const ROOT = path.resolve(__dirname, '../..');
const SRC_REPAIR = path.join(ROOT, 'backend/motores/comercial/ReservaRepairService.js');
const SRC_PONTE = path.join(ROOT, 'backend/services/estoque/pedidoReservaPonteNucleo.js');
const SRC_PDV_RESERVA = path.join(ROOT, 'backend/services/estoque/EstoqueReservaService.js');
const SRC_PDV_CONSUMO = path.join(ROOT, 'backend/services/estoque/EstoqueConsumoReserva.js');
const SRC_MTS = path.join(ROOT, 'backend/motores/mts/MtsService.js');
const SRC_MUC = path.join(ROOT, 'backend/motores/muc/index.js');
const SRC_COMERCIAL = path.join(ROOT, 'backend/motores/comercial/MotorComercialService.js');
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

async function setup({
  sf = 100,
  snf = 50,
  rf = 0,
  rnf = 4,
  estoque = null
} = {}) {
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
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT,
      data_pedido DATE,
      total REAL DEFAULT 0,
      status TEXT NOT NULL,
      operador_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(db, `
    CREATE TABLE pedidos_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER NOT NULL,
      produto_id INTEGER NOT NULL,
      quantidade REAL NOT NULL,
      preco_unitario REAL DEFAULT 0,
      subtotal REAL DEFAULT 0
    )
  `);
  await run(db, `
    CREATE TABLE pedido_estoque_reservas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER NOT NULL,
      pedido_item_id INTEGER,
      produto_id INTEGER NOT NULL,
      quantidade_fiscal REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ATIVA',
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      atualizado_em DATETIME
    )
  `);
  await run(db, `
    CREATE TABLE auditoria_pedido_estoque_fiscal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER,
      produto_id INTEGER,
      evento TEXT NOT NULL,
      quantidade REAL,
      saldo_fiscal REAL,
      saldo_nao_fiscal REAL,
      disponivel_fiscal REAL,
      disponivel_nao_fiscal REAL,
      detalhes TEXT,
      usuario_id INTEGER,
      supervisor_id INTEGER,
      data_hora DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const p = await run(
    db,
    `INSERT INTO produtos
       (nome, saldo_fiscal, saldo_nao_fiscal, reservado_fiscal, reservado_nao_fiscal, estoque_atual)
     VALUES ('Repair', ?, ?, ?, ?, ?)`,
    [sf, snf, rf, rnf, estoque != null ? estoque : sf + snf]
  );
  return { db, produtoId: p.lastID, empresaId: 1 };
}

async function seedPedido(db, {
  produtoId,
  quantidade,
  status = PedidoStatus.AGUARDANDO_FATURAMENTO
}) {
  const ped = await run(
    db,
    `INSERT INTO pedidos (codigo, data_pedido, total, status) VALUES ('R', date('now'), 0, ?)`,
    [status]
  );
  await run(
    db,
    `INSERT INTO pedidos_itens (pedido_id, produto_id, quantidade, preco_unitario, subtotal)
     VALUES (?, ?, ?, 1, ?)`,
    [ped.lastID, produtoId, quantidade, quantidade]
  );
  return ped.lastID;
}

async function seedReserva(db, { pedidoId, produtoId, qtdFiscal, status = 'ATIVA' }) {
  const r = await run(
    db,
    `INSERT INTO pedido_estoque_reservas
       (pedido_id, produto_id, quantidade_fiscal, status)
     VALUES (?, ?, ?, ?)`,
    [pedidoId, produtoId, qtdFiscal, status]
  );
  return r.lastID;
}

async function test01RepairAumentaReserva() {
  const { db, produtoId, empresaId } = await setup({ rf: 0, rnf: 4 });
  const pedidoId = await seedPedido(db, { produtoId, quantidade: 8 });

  const r = await executarPlano(
    montarPlanoCorrecao(TipoInconsistencia.PEDIDO_SEM_RESERVA),
    {
      dryRun: false,
      db,
      empresaId,
      contexto: { pedido_id: pedidoId, produto_id: produtoId, pedido_quantidade: 8 }
    }
  );

  assert.strictEqual(r.sucesso, true);
  assert.strictEqual(r.acao, 'CRIAR_RESERVA');
  assert.strictEqual(r.detalhes.quantidade_criada, 8);
  assert.strictEqual(r.detalhes.reservado_depois, 8);

  const prod = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.reservado_fiscal, 8);

  const pedidoId2 = await seedPedido(db, { produtoId, quantidade: 12 });
  const reservaId = await seedReserva(db, { pedidoId: pedidoId2, produtoId, qtdFiscal: 8 });

  const aj = await executarPlano(
    montarPlanoCorrecao(TipoInconsistencia.RESERVA_MAIOR_QUE_PEDIDO),
    {
      dryRun: false,
      db,
      empresaId,
      contexto: {
        pedido_id: pedidoId2,
        produto_id: produtoId,
        reserva_id: reservaId,
        pedido_quantidade: 12
      }
    }
  );
  assert.strictEqual(aj.sucesso, true);
  assert.strictEqual(aj.detalhes.diferenca, 4);
  const prod2 = await get(db, 'SELECT reservado_fiscal FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod2.reservado_fiscal, 12);
  await closeDb(db);
}

async function test02RepairLiberaReserva() {
  const { db, produtoId, empresaId } = await setup({ rf: 10, rnf: 4 });
  const pedidoId = await seedPedido(db, {
    produtoId,
    quantidade: 6,
    status: PedidoStatus.CANCELADO
  });
  const reservaId = await seedReserva(db, { pedidoId, produtoId, qtdFiscal: 6 });

  const r = await executarPlano(
    montarPlanoCorrecao(TipoInconsistencia.PEDIDO_CANCELADO_COM_RESERVA_ATIVA),
    {
      dryRun: false,
      db,
      empresaId,
      contexto: { pedido_id: pedidoId, reserva_id: reservaId }
    }
  );
  assert.strictEqual(r.sucesso, true);
  assert.strictEqual(r.acao, 'LIBERAR_RESERVA');
  assert.strictEqual(r.detalhes.quantidade_liberada, 6);
  const prod = await get(db, 'SELECT reservado_fiscal FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.reservado_fiscal, 4);

  const pedidoId2 = await seedPedido(db, { produtoId, quantidade: 2 });
  const reservaId2 = await seedReserva(db, { pedidoId: pedidoId2, produtoId, qtdFiscal: 4 });
  const aj = await executarPlano(
    montarPlanoCorrecao(TipoInconsistencia.RESERVA_MAIOR_QUE_PEDIDO),
    {
      dryRun: false,
      db,
      empresaId,
      contexto: {
        pedido_id: pedidoId2,
        reserva_id: reservaId2,
        pedido_quantidade: 2
      }
    }
  );
  assert.strictEqual(aj.sucesso, true);
  assert.ok(aj.detalhes.diferenca < 0);
  const prod2 = await get(db, 'SELECT reservado_fiscal FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod2.reservado_fiscal, 2);
  await closeDb(db);
}

async function test03FiscalPreservado() {
  const src = fs.readFileSync(SRC_REPAIR, 'utf8');
  assert.ok(src.includes('TipoSaldo.FISCAL'));
  assert.ok(!src.includes('TipoSaldo.NAO_FISCAL'));
  assert.ok(src.includes('reservarQuantidade'));
  assert.ok(src.includes('liberarQuantidadeReservada'));
  assert.ok(!src.includes('criarReservaNaoFiscal'));
}

async function test04NaoFiscalNaoInventado() {
  const { db, produtoId, empresaId } = await setup({ rf: 5, rnf: 9 });
  const pedidoCancelado = await seedPedido(db, {
    produtoId,
    quantidade: 5,
    status: PedidoStatus.CANCELADO
  });
  const reservaId = await seedReserva(db, {
    pedidoId: pedidoCancelado,
    produtoId,
    qtdFiscal: 5
  });

  await executarPlano(
    montarPlanoCorrecao(TipoInconsistencia.PEDIDO_CANCELADO_COM_RESERVA_ATIVA),
    {
      dryRun: false,
      db,
      empresaId,
      contexto: { pedido_id: pedidoCancelado, reserva_id: reservaId }
    }
  );

  const pedidoNovo = await seedPedido(db, { produtoId, quantidade: 3 });
  await executarPlano(
    montarPlanoCorrecao(TipoInconsistencia.PEDIDO_SEM_RESERVA),
    {
      dryRun: false,
      db,
      empresaId,
      contexto: { pedido_id: pedidoNovo, produto_id: produtoId, pedido_quantidade: 3 }
    }
  );

  const prod = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.reservado_nao_fiscal, 9);
  assert.strictEqual(prod.reservado_fiscal, 3);
  await closeDb(db);
}

async function test05EmpresaIdPropagado() {
  const { db, produtoId, empresaId } = await setup({ rf: 0 });
  const pedidoId = await seedPedido(db, { produtoId, quantidade: 2 });

  const r = await executarPlano(
    montarPlanoCorrecao(TipoInconsistencia.PEDIDO_SEM_RESERVA),
    {
      dryRun: false,
      db,
      empresaId,
      contexto: { pedido_id: pedidoId, produto_id: produtoId, pedido_quantidade: 2 }
    }
  );
  assert.strictEqual(r.detalhes.empresa_id, empresaId);
  assert.strictEqual(r.detalhes.legado, false);

  const viaOpcoes = montarOptsPortaReservaRepair({ db, empresaId: 1 });
  assert.strictEqual(viaOpcoes.empresaId, 1);
  assert.strictEqual(viaOpcoes.legado, false);

  const viaContexto = montarOptsPortaReservaRepair({
    db,
    contexto: { empresa_id: 1 }
  });
  assert.strictEqual(viaContexto.empresaId, 1);

  const viaReq = montarOptsPortaReservaRepair({
    db,
    contexto: { headers: { 'x-empresa-id': '1' } }
  });
  assert.strictEqual(viaReq.empresaId, 1);
  assert.strictEqual(viaReq.legado, false);
  await closeDb(db);
}

async function test06CompatExplicita() {
  const { db, produtoId } = await setup({ rf: 0 });
  const pedidoId = await seedPedido(db, { produtoId, quantidade: 1 });

  const r = await executarPlano(
    montarPlanoCorrecao(TipoInconsistencia.PEDIDO_SEM_RESERVA),
    {
      dryRun: false,
      db,
      contexto: { pedido_id: pedidoId, produto_id: produtoId, pedido_quantidade: 1 }
    }
  );
  assert.strictEqual(r.sucesso, true);
  assert.strictEqual(r.detalhes.legado, true);
  assert.strictEqual(r.detalhes.motivo_compat, MOTIVO_COMPAT_RESERVA_REPAIR);
  assert.strictEqual(r.detalhes.empresa_id, null);

  const pedidoExigir = await seedPedido(db, { produtoId, quantidade: 1 });
  await assertRejects(
    executarPlano(
      montarPlanoCorrecao(TipoInconsistencia.PEDIDO_SEM_RESERVA),
      {
        dryRun: false,
        db,
        exigirEmpresa: true,
        contexto: { pedido_id: pedidoExigir, produto_id: produtoId, pedido_quantidade: 1 }
      }
    ),
    'EMPRESA_OBRIGATORIA'
  );

  const semEmpresa = montarOptsPortaReservaRepair({ db });
  assert.strictEqual(semEmpresa.legado, true);
  assert.strictEqual(semEmpresa.motivoCompat, MOTIVO_COMPAT_RESERVA_REPAIR);

  const src = fs.readFileSync(SRC_REPAIR, 'utf8');
  assert.ok(src.includes('COMPAT_RESERVA_REPAIR_PRE_MULTIEMPRESA'));
  assert.ok(!/empresaId\s*=\s*1/.test(src));
  assert.ok(!/configuracoes\.cnpj/.test(src));
  await closeDb(db);
}

async function test07RollbackRestauraReservado() {
  const { db, produtoId, empresaId } = await setup({ rf: 15, rnf: 4, sf: 80, snf: 30 });
  const pedidoId = await seedPedido(db, {
    produtoId,
    quantidade: 8,
    status: PedidoStatus.CANCELADO
  });
  const reservaId = await seedReserva(db, { pedidoId, produtoId, qtdFiscal: 8 });

  await run(db, 'BEGIN');
  await executarPlano(
    montarPlanoCorrecao(TipoInconsistencia.PEDIDO_CANCELADO_COM_RESERVA_ATIVA),
    {
      dryRun: false,
      db,
      empresaId,
      contexto: { pedido_id: pedidoId, reserva_id: reservaId }
    }
  );
  const mid = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(mid.reservado_fiscal, 7);
  await run(db, 'ROLLBACK');

  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.reservado_fiscal, 15);
  assert.strictEqual(row.reservado_nao_fiscal, 4);
  assert.strictEqual(row.saldo_fiscal, 80);
  const reserva = await get(db, 'SELECT status FROM pedido_estoque_reservas WHERE id = ?', [reservaId]);
  assert.strictEqual(reserva.status, 'ATIVA');
  await closeDb(db);
}

async function test08NaoDuplica() {
  const { db, produtoId, empresaId } = await setup({ rf: 6, rnf: 4 });
  const pedidoId = await seedPedido(db, {
    produtoId,
    quantidade: 6,
    status: PedidoStatus.CANCELADO
  });
  const reservaId = await seedReserva(db, { pedidoId, produtoId, qtdFiscal: 6 });

  const r1 = await executarPlano(
    montarPlanoCorrecao(TipoInconsistencia.PEDIDO_CANCELADO_COM_RESERVA_ATIVA),
    {
      dryRun: false,
      db,
      empresaId,
      contexto: { pedido_id: pedidoId, reserva_id: reservaId }
    }
  );
  assert.strictEqual(r1.sucesso, true);
  const depois1 = await get(db, 'SELECT reservado_fiscal FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(depois1.reservado_fiscal, 0);

  const r2 = await executarPlano(
    montarPlanoCorrecao(TipoInconsistencia.PEDIDO_CANCELADO_COM_RESERVA_ATIVA),
    {
      dryRun: false,
      db,
      empresaId,
      contexto: { pedido_id: pedidoId, reserva_id: reservaId }
    }
  );
  assert.strictEqual(r2.sucesso, false);
  assert.strictEqual(r2.codigo, 'RESERVA_INEXISTENTE');
  const depois2 = await get(db, 'SELECT reservado_fiscal FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(depois2.reservado_fiscal, 0);

  const pedidoNovo = await seedPedido(db, { produtoId, quantidade: 3 });
  const c1 = await executarPlano(
    montarPlanoCorrecao(TipoInconsistencia.PEDIDO_SEM_RESERVA),
    {
      dryRun: false,
      db,
      empresaId,
      contexto: { pedido_id: pedidoNovo, produto_id: produtoId, pedido_quantidade: 3 }
    }
  );
  assert.strictEqual(c1.sucesso, true);
  const c2 = await executarPlano(
    montarPlanoCorrecao(TipoInconsistencia.PEDIDO_SEM_RESERVA),
    {
      dryRun: false,
      db,
      empresaId,
      contexto: { pedido_id: pedidoNovo, produto_id: produtoId, pedido_quantidade: 3 }
    }
  );
  assert.strictEqual(c2.sucesso, false);
  assert.strictEqual(c2.codigo, 'RESERVA_JA_EXISTENTE');
  const depois3 = await get(db, 'SELECT reservado_fiscal FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(depois3.reservado_fiscal, 3);
  await closeDb(db);
}

async function test09SqlDiretoRemovido() {
  const src = fs.readFileSync(SRC_REPAIR, 'utf8');
  assert.ok(src.includes('reservasPublico'));
  assert.ok(src.includes('reservarQuantidade'));
  assert.ok(src.includes('liberarQuantidadeReservada'));
  assert.ok(!/UPDATE\s+produtos/i.test(src), 'Repair não deve UPDATE produtos');
  assert.ok(!/SET\s+reservado_fiscal\s*=/i.test(src));
  assert.ok(!/SET\s+reservado_nao_fiscal/i.test(src));
  assert.ok(!/SET\s+saldo_fiscal/i.test(src));
  assert.ok(!/SET\s+estoque_atual/i.test(src));
  assert.ok(/UPDATE\s+pedido_estoque_reservas/i.test(src), 'tracking permanece');
  assert.ok(!src.includes('venda_estoque_reservas'));
  assert.ok(!src.includes('BEGIN'));
  assert.ok(!src.includes('COMMIT'));
  assert.ok(!src.includes('ROLLBACK'));
  assert.ok(!fs.existsSync(path.join(ROOT, 'backend/motores/comercial/ReservaRepairServiceV2.js')));
  assert.ok(!fs.existsSync(path.join(ROOT, 'backend/services/reservasRepairPublico.js')));
  assert.ok(!fs.existsSync(path.join(ROOT, 'backend/services/repairReservaPorta.js')));
}

async function test10SaldoFisicoIntacto() {
  const { db, produtoId, empresaId } = await setup({
    sf: 80,
    snf: 30,
    rf: 12,
    rnf: 5,
    estoque: 110
  });
  const pedidoId = await seedPedido(db, {
    produtoId,
    quantidade: 5,
    status: PedidoStatus.CANCELADO
  });
  const reservaId = await seedReserva(db, { pedidoId, produtoId, qtdFiscal: 5 });

  await executarPlano(
    montarPlanoCorrecao(TipoInconsistencia.PEDIDO_CANCELADO_COM_RESERVA_ATIVA),
    {
      dryRun: false,
      db,
      empresaId,
      contexto: { pedido_id: pedidoId, reserva_id: reservaId }
    }
  );

  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.saldo_fiscal, 80);
  assert.strictEqual(row.saldo_nao_fiscal, 30);
  assert.strictEqual(row.estoque_atual, 110);
  assert.strictEqual(row.reservado_fiscal, 7);
  assert.strictEqual(row.reservado_nao_fiscal, 5);

  const repair = fs.readFileSync(SRC_REPAIR, 'utf8');
  const ponte = fs.readFileSync(SRC_PONTE, 'utf8');
  const pdvReserva = fs.readFileSync(SRC_PDV_RESERVA, 'utf8');
  const pdvConsumo = fs.readFileSync(SRC_PDV_CONSUMO, 'utf8');
  const mts = fs.readFileSync(SRC_MTS, 'utf8');
  const muc = fs.readFileSync(SRC_MUC, 'utf8');
  const comercial = fs.readFileSync(SRC_COMERCIAL, 'utf8');
  const porta = fs.readFileSync(SRC_PORTA, 'utf8');

  assert.ok(!repair.includes('debitarSaldo'));
  assert.ok(!repair.includes('creditarSaldo'));
  assert.ok(!repair.includes('estoqueSaldosPublico'));
  assert.ok(!repair.includes('BEGIN IMMEDIATE'));
  assert.ok(ponte.includes('liberarQuantidadeReservada'));
  assert.ok(pdvReserva.includes('venda_estoque_reservas') || pdvConsumo.includes('venda_estoque_reservas'));
  assert.ok(!mts.includes('COMPAT_RESERVA_REPAIR_PRE_MULTIEMPRESA'));
  assert.ok(!muc.includes('COMPAT_RESERVA_REPAIR_PRE_MULTIEMPRESA'));
  assert.ok(!comercial.includes('COMPAT_RESERVA_REPAIR_PRE_MULTIEMPRESA'));
  assert.ok(porta.includes('reservarQuantidade'));
  assert.ok(!fs.existsSync(path.join(ROOT, 'backend/database/estoque_empresa')));
  await closeDb(db);
}

async function main() {
  const testes = [
    ['01 repair aumenta reserva', test01RepairAumentaReserva],
    ['02 repair libera reserva', test02RepairLiberaReserva],
    ['03 fiscal preservado', test03FiscalPreservado],
    ['04 nao fiscal nao inventado', test04NaoFiscalNaoInventado],
    ['05 empresaId propagado', test05EmpresaIdPropagado],
    ['06 COMPAT explicita', test06CompatExplicita],
    ['07 rollback restaura reservado', test07RollbackRestauraReservado],
    ['08 nao duplica', test08NaoDuplica],
    ['09 SQL direto de reservado removido', test09SqlDiretoRemovido],
    ['10 saldo fisico intacto', test10SaldoFisicoIntacto]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\nreserva-repair-porta-publica: ${ok}/${testes.length} OK`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
