/**
 * Sprint 05.49 — Ownership empresarial do pedido comercial e ReservaRepair.
 * Executar: node tests/pedidos/ownership-pedido-reserva-05-49.test.js
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
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const repo = require('../../backend/services/pedido/PedidoRepository');
const MotorComercial = require('../../backend/motores/comercial');
const {
  executarPlano,
  montarOptsPortaReservaRepair,
  handlerCriarReserva
} = require('../../backend/motores/comercial/ReservaRepairService');
const { montarPlanoCorrecao, TipoInconsistencia } = require('../../backend/motores/comercial/ReservaReconciliationService');
const { PedidoStatus } = require('../../backend/services/pedido/enums');
const reservas = require('../../backend/services/fiscalNaoFiscal/reservasPublico');
const {
  exigirEmpresaDaCriacao,
  exigirPedidoDaEmpresa,
  exigirEmpresaDoPedido,
  exigirOperacaoDoPedido,
  CODIGO_EMPRESA_OWNERSHIP_REQUIRED,
  CODIGO_EMPRESA_CONTEXT_REQUIRED,
  CODIGO_PEDIDO_NAO_ENCONTRADO
} = require('../../backend/services/pedidos/PedidoEmpresaContextoService');
const { migrarEmpresaIdPedidos } = require('../../backend/utils/pedidosEmpresaHelpers');

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

function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_) { resolve(); }
  });
}

async function assertRejects(fnOrPromise, codes) {
  const expected = Array.isArray(codes) ? codes : [codes];
  try {
    await (typeof fnOrPromise === 'function' ? fnOrPromise() : fnOrPromise);
    throw new Error(`Esperava falha (${expected.join('|')})`);
  } catch (err) {
    if (err.message && err.message.startsWith('Esperava falha')) throw err;
    assert.ok(
      expected.includes(err.code) || expected.includes(err.codigo)
        || expected.some((c) => String(err.message || '').includes(c)),
      `esperado ${expected.join('|')}, veio ${err.code || err.codigo}/${err.message}`
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
      saldo_fiscal REAL DEFAULT 0,
      saldo_nao_fiscal REAL DEFAULT 0,
      estoque_atual REAL DEFAULT 0,
      reservado_fiscal REAL DEFAULT 0,
      reservado_nao_fiscal REAL DEFAULT 0,
      controla_estoque INTEGER DEFAULT 1
    )
  `);
  await run(db, `
    CREATE TABLE pedidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT,
      data_pedido DATE,
      cliente_id INTEGER,
      total REAL DEFAULT 0,
      desconto REAL DEFAULT 0,
      frete REAL DEFAULT 0,
      status TEXT,
      representante_id INTEGER,
      representante_nome TEXT,
      observacao TEXT,
      operador_id INTEGER,
      venda_id INTEGER,
      empresa_id INTEGER
    )
  `);
  await run(db, `
    CREATE TABLE pedidos_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER,
      produto_id INTEGER,
      quantidade REAL,
      preco_unitario REAL DEFAULT 1,
      desconto_percentual REAL DEFAULT 0,
      subtotal REAL DEFAULT 0,
      tipo_venda TEXT DEFAULT 'PESO'
    )
  `);
  await run(db, `
    CREATE TABLE pedido_estoque_reservas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER,
      pedido_item_id INTEGER,
      produto_id INTEGER,
      quantidade_fiscal REAL DEFAULT 0,
      status TEXT DEFAULT 'ATIVA',
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      atualizado_em DATETIME,
      empresa_id INTEGER
    )
  `);
  await run(db, `
    CREATE TABLE auditoria_pedido_estoque_fiscal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER,
      produto_id INTEGER,
      evento TEXT,
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
  await run(db, `
    CREATE TABLE movimentos_transferencia_saldos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produto_id INTEGER,
      origem TEXT, destino TEXT, quantidade REAL,
      saldo_origem_antes REAL, saldo_origem_depois REAL,
      saldo_destino_antes REAL, saldo_destino_depois REAL,
      motivo TEXT, usuario_id INTEGER, resultado TEXT DEFAULT 'ok'
    )
  `);
  const p = await run(db, `INSERT INTO produtos (nome, saldo_fiscal, estoque_atual) VALUES ('Pastel', 50, 50)`);
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const b = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: p.lastID, empresaId: a.id,
    saldo_fiscal: 50, saldo_nao_fiscal: 0, estoque_atual: 50, reservado_fiscal: 0
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: p.lastID, empresaId: b.id,
    saldo_fiscal: 80, saldo_nao_fiscal: 0, estoque_atual: 80, reservado_fiscal: 0
  }, { db });
  return { db, produtoId: p.lastID, empresaA: a, empresaB: b };
}

async function criarPedidoRepo(db, empresaId, produtoId, opts = {}) {
  return repo.criarPedido({
    db,
    codigo: opts.codigo || `PED-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    dataPedido: '2026-08-25',
    total: 10,
    desconto: 0,
    frete: 0,
    status: opts.status || PedidoStatus.PEDIDO,
    operadorId: 1,
    empresaId,
    itens: [{
      produto_id: produtoId,
      quantidade: opts.quantidade || 3,
      preco_unitario: 10,
      desconto_percentual: 0,
      subtotal: 30,
      tipo_venda: 'PESO'
    }]
  });
}

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  OK  ${name}`);
}

async function t01a04CriarAB() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  const idA = await criarPedidoRepo(db, empresaA.id, produtoId, { codigo: 'PED-A' });
  const idB = await criarPedidoRepo(db, empresaB.id, produtoId, { codigo: 'PED-B' });
  const a = await get(db, 'SELECT empresa_id, codigo FROM pedidos WHERE id = ?', [idA]);
  const b = await get(db, 'SELECT empresa_id, codigo FROM pedidos WHERE id = ?', [idB]);
  assert.strictEqual(Number(a.empresa_id), empresaA.id);
  assert.strictEqual(Number(b.empresa_id), empresaB.id);
  assert.notStrictEqual(a.empresa_id, b.empresa_id);
  await closeDb(db);
  ok('T01–T04 criar pedido A/B persiste empresa_id');
}

async function t05BNaoLeA() {
  const pedidoA = { id: 1, empresa_id: 7 };
  exigirPedidoDaEmpresa(pedidoA, 7);
  await assertRejects(() => exigirPedidoDaEmpresa(pedidoA, 8), CODIGO_PEDIDO_NAO_ENCONTRADO);
  ok('T05 contexto B não lê pedido A (404)');
}

async function t06a09ConfirmacaoIsolada() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  const idA = await criarPedidoRepo(db, empresaA.id, produtoId, { quantidade: 4 });
  await assertRejects(
    MotorComercial.confirmarPedidoFiscal({
      pedidoId: idA,
      itens: [{ produto_id: produtoId, quantidade: 4 }],
      empresaId: empresaB.id
    }, { db }),
    ['PEDIDO_EMPRESA_DIVERGENTE']
  );
  const r = await MotorComercial.confirmarPedidoFiscal({
    pedidoId: idA,
    itens: [{ produto_id: produtoId, quantidade: 4 }],
    empresaId: empresaA.id
  }, { db });
  assert.strictEqual(r.sucesso, true);
  assert.ok(r.reservas.length >= 1);
  assert.strictEqual(Number(r.reservas[0].empresa_id), empresaA.id);
  const eeA = await get(db, 'SELECT reservado_fiscal FROM estoque_empresa WHERE empresa_id = ?', [empresaA.id]);
  const eeB = await get(db, 'SELECT reservado_fiscal FROM estoque_empresa WHERE empresa_id = ?', [empresaB.id]);
  assert.strictEqual(Number(eeA.reservado_fiscal), 4);
  assert.strictEqual(Number(eeB.reservado_fiscal), 0);
  await closeDb(db);
  ok('T06–T09 confirmação A cria reserva A e não afeta B; divergente bloqueia');
}

async function t10t11LegadoNull() {
  const { db, produtoId, empresaA } = await setup();
  const ins = await run(db, `INSERT INTO pedidos (codigo, data_pedido, total, status, empresa_id) VALUES ('LEG', date('now'), 0, 'PEDIDO', NULL)`);
  await run(db, `INSERT INTO pedidos_itens (pedido_id, produto_id, quantidade, preco_unitario, subtotal) VALUES (?, ?, 1, 1, 1)`, [ins.lastID, produtoId]);
  await assertRejects(
    () => exigirEmpresaDoPedido({ id: ins.lastID, empresa_id: null }),
    CODIGO_EMPRESA_OWNERSHIP_REQUIRED
  );
  await assertRejects(
    MotorComercial.confirmarPedidoFiscal({
      pedidoId: ins.lastID,
      itens: [{ produto_id: produtoId, quantidade: 1 }],
      empresaId: empresaA.id
    }, { db }),
    [CODIGO_EMPRESA_OWNERSHIP_REQUIRED]
  );
  const rf = await get(db, 'SELECT reservado_fiscal FROM estoque_empresa WHERE empresa_id = ?', [empresaA.id]);
  assert.strictEqual(Number(rf.reservado_fiscal), 0);
  await closeDb(db);
  ok('T10–T11 legado NULL bloqueia confirmação/reserva sem mutar estoque');
}

async function t12t13MotorSemCompat() {
  await assertRejects(
    () => exigirEmpresaDaCriacao({ empresaId: null }),
    CODIGO_EMPRESA_CONTEXT_REQUIRED
  );
  const { db, produtoId, empresaA, empresaB } = await setup();
  const idA = await criarPedidoRepo(db, empresaA.id, produtoId, { quantidade: 2 });
  await assertRejects(
    MotorComercial.analisarDisponibilidadeFiscal(
      [{ produto_id: produtoId, quantidade: 1 }],
      { db }
    ),
    [CODIGO_EMPRESA_CONTEXT_REQUIRED]
  );
  await assertRejects(
    MotorComercial.confirmarPedidoFiscal({
      pedidoId: idA,
      itens: [{ produto_id: produtoId, quantidade: 2 }],
      empresaId: empresaB.id
    }, { db }),
    ['PEDIDO_EMPRESA_DIVERGENTE']
  );
  const motorSrc = src('backend/motores/comercial/MotorComercialService.js');
  assert.ok(!motorSrc.includes('COMPAT_CERTIFICADA_PRE_MULTIEMPRESA'));
  assert.ok(motorSrc.includes('pedidos.empresa_id') || motorSrc.includes('exigirEmpresaDoPedido'));
  await closeDb(db);
  ok('T12–T13 Motor sem COMPAT; divergente bloqueia');
}

async function t14t16Repair() {
  const { db, produtoId, empresaA } = await setup();
  const legado = await run(db, `INSERT INTO pedidos (codigo, data_pedido, total, status) VALUES ('N', date('now'), 0, ?)`, [PedidoStatus.PEDIDO]);
  await run(db, `INSERT INTO pedidos_itens (pedido_id, produto_id, quantidade, preco_unitario, subtotal) VALUES (?, ?, 2, 1, 2)`, [legado.lastID, produtoId]);
  const dry = await executarPlano(
    montarPlanoCorrecao(TipoInconsistencia.PEDIDO_SEM_RESERVA),
    { dryRun: true, db, contexto: { pedido_id: legado.lastID, produto_id: produtoId } }
  );
  assert.strictEqual(dry.sucesso, false);
  assert.strictEqual(dry.codigo, CODIGO_EMPRESA_OWNERSHIP_REQUIRED);
  assert.strictEqual(dry.dry_run, true);

  const idA = await criarPedidoRepo(db, empresaA.id, produtoId, { quantidade: 5, codigo: 'REP-A' });
  const exec = await executarPlano(
    montarPlanoCorrecao(TipoInconsistencia.PEDIDO_SEM_RESERVA),
    {
      dryRun: false,
      db,
      empresaId: empresaA.id,
      contexto: { pedido_id: idA, produto_id: produtoId, quantidade: 5 }
    }
  );
  assert.strictEqual(exec.sucesso, true);
  const row = await get(db, 'SELECT empresa_id FROM pedido_estoque_reservas WHERE pedido_id = ?', [idA]);
  assert.strictEqual(Number(row.empresa_id), empresaA.id);

  await assertRejects(
    () => montarOptsPortaReservaRepair({ db }),
    CODIGO_EMPRESA_OWNERSHIP_REQUIRED
  );
  const repairSrc = src('backend/motores/comercial/ReservaRepairService.js');
  assert.ok(repairSrc.includes('INSERT INTO pedido_estoque_reservas'));
  assert.ok(repairSrc.includes('empresa_id'));
  assert.ok(!repairSrc.includes('motivoCompat: fonte.motivoCompat || MOTIVO_COMPAT_RESERVA_REPAIR'));
  await closeDb(db);
  ok('T14–T16 Repair dryRun detecta NULL; dryRun false grava empresa_id; sem COMPAT');
}

async function t17CancelLiberaMesmaEmpresa() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  const idA = await criarPedidoRepo(db, empresaA.id, produtoId, { quantidade: 3 });
  await MotorComercial.confirmarPedidoFiscal({
    pedidoId: idA,
    itens: [{ produto_id: produtoId, quantidade: 3 }],
    empresaId: empresaA.id
  }, { db });
  await MotorComercial.liberarReservasDoPedido(idA, { db, empresaId: empresaA.id });
  const eeA = await get(db, 'SELECT reservado_fiscal FROM estoque_empresa WHERE empresa_id = ?', [empresaA.id]);
  const eeB = await get(db, 'SELECT reservado_fiscal FROM estoque_empresa WHERE empresa_id = ?', [empresaB.id]);
  assert.strictEqual(Number(eeA.reservado_fiscal), 0);
  assert.strictEqual(Number(eeB.reservado_fiscal), 0);
  const st = await get(db, `SELECT status FROM pedido_estoque_reservas WHERE pedido_id = ?`, [idA]);
  assert.ok(st == null || String(st.status).toUpperCase() !== 'ATIVA' || st.status === 'CANCELADA');
  await closeDb(db);
  ok('T17 cancelamento libera reserva da mesma empresa');
}

async function t18t19Reprocesso() {
  const { db, produtoId, empresaA } = await setup();
  const idA = await criarPedidoRepo(db, empresaA.id, produtoId, { quantidade: 2 });
  await MotorComercial.confirmarPedidoFiscal({
    pedidoId: idA,
    itens: [{ produto_id: produtoId, quantidade: 2 }],
    empresaId: empresaA.id
  }, { db });
  await MotorComercial.confirmarPedidoFiscal({
    pedidoId: idA,
    itens: [{ produto_id: produtoId, quantidade: 2 }],
    empresaId: empresaA.id
  }, { db });
  const n = await get(db, `SELECT COUNT(*) AS c FROM pedido_estoque_reservas WHERE pedido_id = ? AND status = 'ATIVA'`, [idA]);
  assert.strictEqual(Number(n.c), 1);
  const row = await get(db, `SELECT empresa_id FROM pedido_estoque_reservas WHERE pedido_id = ? AND status = 'ATIVA'`, [idA]);
  assert.strictEqual(Number(row.empresa_id), empresaA.id);
  await closeDb(db);
  ok('T18–T19 reprocesso não duplica e mantém empresa');
}

async function t20CruzadoSemEfeito() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  const idA = await criarPedidoRepo(db, empresaA.id, produtoId, { quantidade: 2 });
  await MotorComercial.confirmarPedidoFiscal({
    pedidoId: idA,
    itens: [{ produto_id: produtoId, quantidade: 2 }],
    empresaId: empresaA.id
  }, { db });
  await assertRejects(
    MotorComercial.liberarReservasDoPedido(idA, { db, empresaId: empresaB.id }),
    ['PEDIDO_EMPRESA_DIVERGENTE', CODIGO_PEDIDO_NAO_ENCONTRADO]
  );
  const eeA = await get(db, 'SELECT reservado_fiscal FROM estoque_empresa WHERE empresa_id = ?', [empresaA.id]);
  assert.strictEqual(Number(eeA.reservado_fiscal), 2);
  await closeDb(db);
  ok('T20 acesso cruzado não produz efeito colateral');
}

async function tBackfillEWriters() {
  const db = await openDb();
  await run(db, `CREATE TABLE pedidos (id INTEGER PRIMARY KEY, venda_id INTEGER, empresa_id INTEGER)`);
  await run(db, `CREATE TABLE vendas (id INTEGER PRIMARY KEY, empresa_id INTEGER)`);
  await run(db, `CREATE TABLE pedido_estoque_reservas (id INTEGER PRIMARY KEY, pedido_id INTEGER, empresa_id INTEGER)`);
  await run(db, `INSERT INTO pedidos (id, venda_id, empresa_id) VALUES (1, NULL, NULL)`);
  await run(db, `INSERT INTO pedido_estoque_reservas (pedido_id, empresa_id) VALUES (1, 9)`);
  await run(db, `INSERT INTO pedidos (id, venda_id, empresa_id) VALUES (2, 20, NULL)`);
  await run(db, `INSERT INTO vendas (id, empresa_id) VALUES (20, 4)`);
  await run(db, `INSERT INTO pedidos (id, venda_id, empresa_id) VALUES (3, NULL, NULL)`);
  await run(db, `INSERT INTO pedido_estoque_reservas (pedido_id, empresa_id) VALUES (3, 1)`);
  await run(db, `INSERT INTO pedido_estoque_reservas (pedido_id, empresa_id) VALUES (3, 2)`);
  await run(db, `INSERT INTO pedidos (id, venda_id, empresa_id) VALUES (4, NULL, NULL)`);
  const info = await migrarEmpresaIdPedidos(db);
  assert.strictEqual(info.total, 4);
  assert.ok(info.ambiguos >= 1);
  const p1 = await get(db, 'SELECT empresa_id FROM pedidos WHERE id = 1');
  const p2 = await get(db, 'SELECT empresa_id FROM pedidos WHERE id = 2');
  const p3 = await get(db, 'SELECT empresa_id FROM pedidos WHERE id = 3');
  const p4 = await get(db, 'SELECT empresa_id FROM pedidos WHERE id = 4');
  assert.strictEqual(Number(p1.empresa_id), 9);
  assert.strictEqual(Number(p2.empresa_id), 4);
  assert.strictEqual(p3.empresa_id, null);
  assert.strictEqual(p4.empresa_id, null);
  await closeDb(db);

  const repoSrc = src('backend/services/pedido/PedidoRepository.js');
  assert.ok(repoSrc.includes('empresa_id'));
  assert.ok(src('backend/services/pedido/PedidoOperacionalService.js').includes('exigirEmpresaDaCriacao')
    || src('backend/services/pedido/PedidoOperacionalService.js').includes('empresaDoContexto'));
  assert.ok(src('backend/rotas/pedidos.js').includes('empresaIdDoReqPedido'));
  ok('backfill confiável + writers com empresa_id');
}

async function main() {
  console.log('Sprint 05.49 — ownership pedido / reserva / Motor / Repair\n');
  await t01a04CriarAB();
  await t05BNaoLeA();
  await t06a09ConfirmacaoIsolada();
  await t10t11LegadoNull();
  await t12t13MotorSemCompat();
  await t14t16Repair();
  await t17CancelLiberaMesmaEmpresa();
  await t18t19Reprocesso();
  await t20CruzadoSemEfeito();
  await tBackfillEWriters();
  console.log(`\n${passed} testes OK`);
}

main().catch((err) => {
  console.error('FALHA', err);
  process.exit(1);
});
