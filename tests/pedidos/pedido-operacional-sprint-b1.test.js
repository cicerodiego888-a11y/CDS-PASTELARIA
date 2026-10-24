'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const PedidoRepository = require('../../backend/services/pedido/PedidoRepository');
const PedidoOperacionalService = require('../../backend/services/pedido/PedidoOperacionalService');
const configService = require('../../backend/services/configuracaoService');

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_) { resolve(); }
  });
}

async function criarSchemaMinimo(db) {
  await run(db, `
    CREATE TABLE produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT,
      nome TEXT,
      unidade TEXT,
      tipo_operacional TEXT DEFAULT 'COMERCIAL'
    )
  `);
  await run(db, `
    CREATE TABLE pedidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT,
      data_pedido TEXT,
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
      empresa_id INTEGER,
      updated_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(db, `
    CREATE TABLE pedidos_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER NOT NULL,
      produto_id INTEGER NOT NULL,
      quantidade REAL NOT NULL,
      preco_unitario REAL NOT NULL,
      desconto_percentual REAL DEFAULT 0,
      subtotal REAL NOT NULL,
      tipo_venda TEXT DEFAULT 'PESO',
      classificacao_operacional_snapshot TEXT,
      produto_codigo_snapshot TEXT,
      produto_nome_snapshot TEXT,
      produto_unidade_snapshot TEXT
    )
  `);
  await run(db, `CREATE TABLE clientes (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT)`);
  await run(db, `CREATE TABLE usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, nome TEXT)`);
}

describe('Pedido operacional sprint B1', () => {
  it('preserva valores praticados e snapshot operacional nos itens', async () => {
    const db = await openDb();
    try {
      await criarSchemaMinimo(db);
      const produtoComercial = await run(
        db,
        `INSERT INTO produtos (codigo, nome, unidade, tipo_operacional) VALUES ('P001','Pastel Chef','UN','COMERCIAL')`
      );
      const produtoInsumo = await run(
        db,
        `INSERT INTO produtos (codigo, nome, unidade, tipo_operacional) VALUES ('I777','Molho Especial','KG','INSUMO')`
      );

      const pedidoId = await PedidoRepository.criarPedido({
        db,
        codigo: 'PED-B1-001',
        dataPedido: '2026-10-21',
        clienteId: null,
        total: 61.98,
        desconto: 0,
        frete: 0,
        status: 'PEDIDO',
        empresaId: 1,
        itens: [
          { produto_id: produtoComercial.lastID, quantidade: 2, preco_unitario: 21.99, desconto_percentual: 0, subtotal: 43.98 },
          { produto_id: produtoInsumo.lastID, quantidade: 1, preco_unitario: 18.00, desconto_percentual: 0, subtotal: 18.00 }
        ]
      });

      const pedido = await PedidoRepository.obterPorId(pedidoId, { db });
      assert.equal(pedido.total, 61.98);
      assert.equal(pedido.itens.length, 2);
      assert.equal(Number(pedido.itens[0].subtotal), 43.98);
      assert.equal(Number(pedido.itens[1].subtotal), 18.00);
      assert.equal(pedido.itens[0].classificacao_operacional_snapshot, 'COMERCIAL');
      assert.equal(pedido.itens[1].classificacao_operacional_snapshot, 'INSUMO');
      assert.equal(pedido.itens[0].classificacao_operacional_origem, 'SNAPSHOT_PEDIDO');
      assert.equal(pedido.itens[1].produto_codigo_snapshot, 'I777');
      assert.equal(pedido.itens[1].produto_unidade_snapshot, 'KG');
    } finally {
      await closeDb(db);
    }
  });

  it('resolve classificação de legado sem snapshot pelo catálogo atual', async () => {
    const db = await openDb();
    try {
      await criarSchemaMinimo(db);
      const produto = await run(
        db,
        `INSERT INTO produtos (codigo, nome, unidade, tipo_operacional) VALUES ('PLEG','Produto Legado','UN','INSUMO')`
      );
      const pedido = await run(
        db,
        `INSERT INTO pedidos (codigo, data_pedido, total, status, empresa_id) VALUES ('LEG-1','2026-10-21',10,'PEDIDO',1)`
      );
      await run(
        db,
        `INSERT INTO pedidos_itens (pedido_id, produto_id, quantidade, preco_unitario, subtotal, tipo_venda)
         VALUES (?, ?, 1, 10, 10, 'PESO')`,
        [pedido.lastID, produto.lastID]
      );

      const carregado = await PedidoRepository.obterPorId(pedido.lastID, { db });
      assert.equal(carregado.itens[0].classificacao_operacional_snapshot, null);
      assert.equal(carregado.itens[0].classificacao_operacional, 'INSUMO');
      assert.equal(carregado.itens[0].classificacao_operacional_origem, 'CATALOGO_ATUAL_LEGADO');
    } finally {
      await closeDb(db);
    }
  });

  it('rejeita total inconsistente na criação operacional', async () => {
    const original = configService.recursoHabilitado;
    configService.recursoHabilitado = () => true;
    try {
      await assert.rejects(
        PedidoOperacionalService.criar({
          itens: [{ produto_id: 1, quantidade: 2, preco_unitario: 21.99, subtotal: 43.98 }],
          desconto: 0,
          frete: 0,
          total: 99.99
        }, null, { empresaId: 1 }),
        (err) => err && err.codigo === 'PEDIDO_TOTAL_INCONSISTENTE'
      );
    } finally {
      configService.recursoHabilitado = original;
    }
  });
});
