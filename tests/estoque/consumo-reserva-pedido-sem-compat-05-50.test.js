/**
 * Sprint 05.50 — Consumo de reserva de pedido sem fallback COMPAT.
 * Executar: node tests/estoque/consumo-reserva-pedido-sem-compat-05-50.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const reservasPublico = require('../../backend/services/fiscalNaoFiscal/reservasPublico');
const {
  consumirReservasPedidoNaVenda,
  montarOptsPortaConsumoReservaPedido
} = require('../../backend/services/estoque/pedidoReservaPonteNucleo');

const ROOT = path.resolve(__dirname, '../..');
const ARQUIVOS_DOMINIO = [
  'backend/services/estoque/pedidoReservaPonteNucleo.js',
  'backend/services/faturamento/FaturamentoService.js',
  'backend/services/vendas/VendaPagamentoService.js'
];

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

async function assertRejects(promise, code) {
  try {
    await promise;
    throw new Error(`Esperava falha (${code})`);
  } catch (err) {
    if (err.message && err.message.startsWith('Esperava falha')) throw err;
    assert.ok(
      err.code === code || err.codigo === code || String(err.message || '').includes(code),
      `esperado ${code}, veio ${err.code}/${err.message}`
    );
  }
}

async function setup() {
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
  await run(db, `CREATE TABLE empresas (id INTEGER PRIMARY KEY, razao TEXT, ativo INTEGER DEFAULT 1)`);
  await run(db, `INSERT INTO empresas (id, razao) VALUES (1, 'A'), (2, 'B')`);
  await run(db, `
    CREATE TABLE pedidos (
      id INTEGER PRIMARY KEY,
      empresa_id INTEGER,
      status TEXT DEFAULT 'PEDIDO'
    )
  `);
  await run(db, `
    CREATE TABLE vendas (
      id INTEGER PRIMARY KEY,
      empresa_id INTEGER,
      status TEXT
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
  const p = await run(
    db,
    `INSERT INTO produtos
       (nome, saldo_fiscal, saldo_nao_fiscal, reservado_fiscal, reservado_nao_fiscal, estoque_atual)
     VALUES ('P', 100, 50, 10, 4, 150)`
  );
  return { db, produtoId: p.lastID, empresaA: 1, empresaB: 2 };
}

async function seedCadeia(db, {
  pedidoId,
  vendaId,
  produtoId,
  empresaPedido,
  empresaReserva,
  empresaVenda,
  qtd = 5,
  status = 'ATIVA'
}) {
  await run(db, `INSERT INTO pedidos (id, empresa_id, status) VALUES (?, ?, 'PEDIDO')`, [
    pedidoId,
    empresaPedido
  ]);
  if (vendaId != null) {
    await run(db, `INSERT INTO vendas (id, empresa_id, status) VALUES (?, ?, 'finalizada')`, [
      vendaId,
      empresaVenda != null ? empresaVenda : empresaPedido
    ]);
  }
  await run(
    db,
    `INSERT INTO pedido_estoque_reservas
       (pedido_id, produto_id, quantidade_fiscal, status, empresa_id)
     VALUES (?, ?, ?, ?, ?)`,
    [pedidoId, produtoId, qtd, status, empresaReserva]
  );
}

async function t01ConsumoMesmaEmpresa() {
  const { db, produtoId, empresaA } = await setup();
  await seedCadeia(db, {
    pedidoId: 10,
    vendaId: 100,
    produtoId,
    empresaPedido: empresaA,
    empresaReserva: empresaA,
    empresaVenda: empresaA
  });
  const r = await consumirReservasPedidoNaVenda(10, 100, { db, empresaId: empresaA });
  assert.strictEqual(r.consumidas, 1);
  assert.strictEqual(r.empresa_id, empresaA);
  const reserva = await get(db, 'SELECT status FROM pedido_estoque_reservas WHERE pedido_id = 10');
  assert.strictEqual(reserva.status, 'CONSUMIDA');
  await closeDb(db);
}

async function t02HelperSemEmpresa() {
  await assertRejects(
    Promise.resolve().then(() => montarOptsPortaConsumoReservaPedido({ db: {} })),
    'EMPRESA_CONTEXT_REQUIRED'
  );
}

async function t03PedidoAVendaB() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedCadeia(db, {
    pedidoId: 11,
    vendaId: 111,
    produtoId,
    empresaPedido: empresaA,
    empresaReserva: empresaA,
    empresaVenda: empresaB
  });
  const antes = await get(db, 'SELECT reservado_fiscal FROM produtos WHERE id = ?', [produtoId]);
  await assertRejects(
    consumirReservasPedidoNaVenda(11, 111, { db, empresaId: empresaA }),
    'OPERACAO_EMPRESA_DIVERGENTE'
  );
  const depois = await get(db, 'SELECT reservado_fiscal FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(depois.reservado_fiscal, antes.reservado_fiscal);
  const reserva = await get(db, 'SELECT status FROM pedido_estoque_reservas WHERE pedido_id = 11');
  assert.strictEqual(reserva.status, 'ATIVA');
  await closeDb(db);
}

async function t04PedidoAReservaB() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedCadeia(db, {
    pedidoId: 12,
    vendaId: 112,
    produtoId,
    empresaPedido: empresaA,
    empresaReserva: empresaB,
    empresaVenda: empresaA
  });
  await assertRejects(
    consumirReservasPedidoNaVenda(12, 112, { db, empresaId: empresaA }),
    'RESERVA_EMPRESA_DIVERGENTE'
  );
  const reserva = await get(db, 'SELECT status FROM pedido_estoque_reservas WHERE pedido_id = 12');
  assert.strictEqual(reserva.status, 'ATIVA');
  await closeDb(db);
}

async function t05PedidoNull() {
  const { db, produtoId, empresaA } = await setup();
  await seedCadeia(db, {
    pedidoId: 13,
    vendaId: 113,
    produtoId,
    empresaPedido: null,
    empresaReserva: empresaA,
    empresaVenda: empresaA
  });
  const antes = await get(db, 'SELECT reservado_fiscal FROM produtos WHERE id = ?', [produtoId]);
  await assertRejects(
    consumirReservasPedidoNaVenda(13, 113, { db }),
    'EMPRESA_OWNERSHIP_REQUIRED'
  );
  const depois = await get(db, 'SELECT reservado_fiscal FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(depois.reservado_fiscal, antes.reservado_fiscal);
  const reserva = await get(db, 'SELECT status FROM pedido_estoque_reservas WHERE pedido_id = 13');
  assert.strictEqual(reserva.status, 'ATIVA');
  await closeDb(db);
}

async function t06ReservaNull() {
  const { db, produtoId, empresaA } = await setup();
  await seedCadeia(db, {
    pedidoId: 14,
    vendaId: 114,
    produtoId,
    empresaPedido: empresaA,
    empresaReserva: null,
    empresaVenda: empresaA
  });
  const antes = await get(db, 'SELECT reservado_fiscal FROM produtos WHERE id = ?', [produtoId]);
  await assertRejects(
    consumirReservasPedidoNaVenda(14, 114, { db, empresaId: empresaA }),
    'EMPRESA_OWNERSHIP_REQUIRED'
  );
  const depois = await get(db, 'SELECT reservado_fiscal FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(depois.reservado_fiscal, antes.reservado_fiscal);
  const reserva = await get(db, 'SELECT status FROM pedido_estoque_reservas WHERE pedido_id = 14');
  assert.strictEqual(reserva.status, 'ATIVA');
  await closeDb(db);
}

async function t07Cruzado() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedCadeia(db, {
    pedidoId: 15,
    vendaId: 115,
    produtoId,
    empresaPedido: empresaA,
    empresaReserva: empresaA,
    empresaVenda: empresaA
  });
  await assertRejects(
    consumirReservasPedidoNaVenda(15, 115, { db, empresaId: empresaB }),
    'PEDIDO_NAO_ENCONTRADO'
  );
  const reserva = await get(db, 'SELECT status FROM pedido_estoque_reservas WHERE pedido_id = 15');
  assert.strictEqual(reserva.status, 'ATIVA');
  const prod = await get(db, 'SELECT reservado_fiscal FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.reservado_fiscal, 10);
  await closeDb(db);
}

async function t08EmpresaDaPorta() {
  const { db, produtoId, empresaA } = await setup();
  await seedCadeia(db, {
    pedidoId: 16,
    vendaId: 116,
    produtoId,
    empresaPedido: empresaA,
    empresaReserva: empresaA,
    empresaVenda: empresaA
  });
  const original = reservasPublico.liberarQuantidadeReservada;
  const visto = [];
  reservasPublico.liberarQuantidadeReservada = async function spy(...args) {
    visto.push(args[3] && args[3].empresaId);
    return original.apply(this, args);
  };
  try {
    await consumirReservasPedidoNaVenda(16, 116, { db, empresaId: empresaA });
    assert.deepStrictEqual(visto, [empresaA]);
  } finally {
    reservasPublico.liberarQuantidadeReservada = original;
  }
  await closeDb(db);
}

async function t09ScanCompat() {
  const ponte = fs.readFileSync(path.join(ROOT, 'backend/services/estoque/pedidoReservaPonteNucleo.js'), 'utf8');
  assert.ok(!ponte.includes('COMPAT_CERTIFICADA_PRE_MULTIEMPRESA'));
  assert.ok(!ponte.includes('COMPAT_CONSUMO_RESERVA_PEDIDO'));
  assert.ok(!ponte.includes('modoLegadoSemEmpresa: true'));
  assert.ok(!/empresaId\s*\|\|\s*COMPAT/.test(ponte));
  assert.ok(!/empresaId\s*\?\?\s*COMPAT/.test(ponte));
  assert.ok(!ponte.includes('resolverEmpresaIdDaRequisicao'));

  for (const rel of ARQUIVOS_DOMINIO) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (rel.endsWith('pedidoReservaPonteNucleo.js')) continue;
    const trechoConsumo = src.includes('consumirReservasPedidoNaVenda')
      ? src.slice(
        src.indexOf('consumirReservasPedidoNaVenda'),
        src.indexOf('consumirReservasPedidoNaVenda') + 800
      )
      : '';
    const trechoCb = src.includes('consumirReservasPedidoNaVendaCb')
      ? src.slice(
        src.indexOf('consumirReservasPedidoNaVendaCb'),
        src.indexOf('consumirReservasPedidoNaVendaCb') + 600
      )
      : '';
    const trecho = trechoConsumo + trechoCb;
    assert.ok(!trecho.includes('COMPAT_CERTIFICADA_PRE_MULTIEMPRESA'), rel);
    assert.ok(!/empresaId\s*\|\|\s*COMPAT/.test(trecho), rel);
  }
}

async function t10Idempotencia() {
  const { db, produtoId, empresaA } = await setup();
  await seedCadeia(db, {
    pedidoId: 17,
    vendaId: 117,
    produtoId,
    empresaPedido: empresaA,
    empresaReserva: empresaA,
    empresaVenda: empresaA,
    qtd: 4
  });
  const r1 = await consumirReservasPedidoNaVenda(17, 117, { db, empresaId: empresaA });
  assert.strictEqual(r1.consumidas, 1);
  const depois1 = await get(db, 'SELECT reservado_fiscal FROM produtos WHERE id = ?', [produtoId]);
  const r2 = await consumirReservasPedidoNaVenda(17, 117, { db, empresaId: empresaA });
  assert.strictEqual(r2.consumidas, 0);
  const depois2 = await get(db, 'SELECT reservado_fiscal FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(depois2.reservado_fiscal, depois1.reservado_fiscal);
  await closeDb(db);
}

async function main() {
  const testes = [
    ['T01 pedido+reserva+venda A', t01ConsumoMesmaEmpresa],
    ['T02 helper sem empresaId', t02HelperSemEmpresa],
    ['T03 pedido A venda B', t03PedidoAVendaB],
    ['T04 pedido A reserva B', t04PedidoAReservaB],
    ['T05 pedido empresa NULL', t05PedidoNull],
    ['T06 reserva empresa NULL', t06ReservaNull],
    ['T07 cruzado B sobre A', t07Cruzado],
    ['T08 porta recebe empresa do pedido', t08EmpresaDaPorta],
    ['T09 scan COMPAT domínio', t09ScanCompat],
    ['T10 idempotência existente', t10Idempotencia]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\nconsumo-reserva-pedido-sem-compat-05-50: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
