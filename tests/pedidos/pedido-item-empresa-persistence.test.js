'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const databasePath = require.resolve('../../backend/database');
require.cache[databasePath] = {
  id: databasePath,
  filename: databasePath,
  loaded: true,
  exports: {}
};

const PedidoRepository = require('../../backend/services/pedido/PedidoRepository');

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function cb(err) {
    if (err) reject(err);
    else resolve({ lastID: this.lastID, changes: this.changes });
  }));
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row || null)));
}

function openMemoryDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', err => err ? reject(err) : resolve(db));
  });
}

function close(db) {
  return new Promise(resolve => db.close(() => resolve()));
}

describe('persistência da empresa no item comercial do pedido', () => {
  it('grava empresa_id do pedido ao inserir item com schema Sprint 1', () => {
    const insert = PedidoRepository._montarInsertPedidoItem({
      pedidoId: 156,
      empresaId: 1,
      item: {
        produto_id: 747,
        quantidade: 1,
        preco_unitario: 12,
        desconto_percentual: 0,
        subtotal: 12
      },
      snapshot: {},
      colunasPedidoItens: new Set(['empresa_id'])
    });

    const empresaIndex = insert.colunas.indexOf('empresa_id');
    assert.ok(empresaIndex >= 0);
    assert.equal(insert.valores[empresaIndex], 1);
    assert.equal((insert.sql.match(/\?/g) || []).length, insert.valores.length);
  });

  it('recusa inserir item com empresa ausente quando a coluna existe', () => {
    assert.throws(
      () => PedidoRepository._montarInsertPedidoItem({
        pedidoId: 156,
        empresaId: null,
        item: {
          produto_id: 747,
          quantidade: 1,
          preco_unitario: 12,
          subtotal: 12
        },
        snapshot: {},
        colunasPedidoItens: new Set(['empresa_id'])
      }),
      (err) => err.codigo === 'EMPRESA_CONTEXT_REQUIRED'
    );
  });

  it('mantém a empresa do pedido ao editar item existente e vincular uma mesa', async () => {
    const db = await openMemoryDb();
    try {
      await run(db, `CREATE TABLE produtos (
        id INTEGER PRIMARY KEY, codigo TEXT, nome TEXT, nome_comercial TEXT,
        unidade TEXT, tipo_operacional TEXT, preco_venda REAL, preco_pedido REAL
      )`);
      await run(db, `CREATE TABLE pedidos (
        id INTEGER PRIMARY KEY, empresa_id INTEGER NOT NULL, codigo TEXT,
        data_pedido TEXT, operador_id INTEGER, status TEXT, venda_id INTEGER,
        cliente_id INTEGER, cliente_nome TEXT, total REAL,
        desconto REAL, frete REAL, representante_id INTEGER, representante_nome TEXT,
        observacao TEXT, mesa_id INTEGER, mesa_atendimento_id INTEGER,
        unidade_cozinha_destino_id INTEGER, updated_at TEXT
      )`);
      await run(db, `CREATE TABLE pedidos_itens (
        id INTEGER PRIMARY KEY, pedido_id INTEGER NOT NULL, produto_id INTEGER NOT NULL,
        quantidade REAL NOT NULL, preco_unitario REAL NOT NULL, desconto_percentual REAL,
        subtotal REAL NOT NULL, tipo_venda TEXT, empresa_id INTEGER NOT NULL,
        classificacao_operacional_snapshot TEXT, produto_codigo_snapshot TEXT,
        produto_nome_snapshot TEXT, produto_nome_pedido_snapshot TEXT,
        produto_unidade_snapshot TEXT, personalizacao_ingredientes_snapshot INTEGER,
        preco_venda_snapshot REAL, preco_pedido_snapshot REAL, preco_sugerido_snapshot REAL,
        origem_preco_sugerido TEXT, preco_base_unitario_snapshot REAL,
        preco_adicionais_unitario_snapshot REAL
      )`);
      await run(db, 'INSERT INTO produtos(id,nome,tipo_operacional) VALUES (747,\'Pastel\',\'COMERCIAL\')');
      await run(db, `INSERT INTO pedidos(
        id,empresa_id,status,cliente_id,total,desconto,frete,observacao,
        mesa_id,mesa_atendimento_id,unidade_cozinha_destino_id
      ) VALUES (159,1,'PEDIDO',5,12,0,0,'original',NULL,NULL,9)`);
      await run(db, `INSERT INTO pedidos_itens(
        id,pedido_id,produto_id,quantidade,preco_unitario,desconto_percentual,
        subtotal,tipo_venda,empresa_id,classificacao_operacional_snapshot
      ) VALUES (238,159,747,1,12,0,12,'PESO',1,'COMERCIAL')`);

      const pedidoCriadoId = await PedidoRepository.criarPedido({
        codigo: 'NOVO-TESTE',
        dataPedido: '2026-01-01',
        clienteId: 5,
        total: 12,
        desconto: 0,
        frete: 0,
        status: 'PEDIDO',
        observacao: 'criado em memória',
        empresaId: 1,
        itens: [{
          produto_id: 747,
          quantidade: 1,
          preco_unitario: 12,
          desconto_percentual: 0,
          subtotal: 12,
          tipo_venda: 'PESO'
        }],
        db
      });
      const itemCriado = await get(db, 'SELECT empresa_id FROM pedidos_itens WHERE pedido_id=?', [pedidoCriadoId]);
      assert.equal(itemCriado.empresa_id, 1);

      await PedidoRepository.substituirPedido({
        pedidoId: 159,
        clienteId: 5,
        total: 14,
        desconto: 0,
        frete: 0,
        observacao: 'editado',
        itens: [{
          id: 238,
          produto_id: 747,
          quantidade: 1,
          preco_unitario: 14,
          desconto_percentual: 0,
          subtotal: 14,
          tipo_venda: 'PESO'
        }],
        mesaId: 3,
        empresaId: 1,
        db
      });
      await PedidoRepository.vincularAtendimentoDaMesa(159, 1, 44, { db });

      const pedido = await get(db, 'SELECT * FROM pedidos WHERE id=159');
      const item = await get(db, 'SELECT * FROM pedidos_itens WHERE id=238');
      assert.equal(pedido.id, 159);
      assert.equal(pedido.empresa_id, 1);
      assert.equal(pedido.unidade_cozinha_destino_id, 9);
      assert.equal(pedido.mesa_id, 3);
      assert.equal(pedido.mesa_atendimento_id, 44);
      assert.equal(item.id, 238);
      assert.equal(item.empresa_id, 1);
      assert.equal(item.preco_unitario, 14);
      await assert.rejects(
        () => PedidoRepository.substituirPedido({
          pedidoId: 159,
          itens: [],
          empresaId: 2,
          db
        }),
        (err) => err.codigo === 'PEDIDO_NAO_ENCONTRADO'
      );
      assert.equal((await get(db, 'SELECT empresa_id FROM pedidos WHERE id=159')).empresa_id, 1);
    } finally {
      await close(db);
    }
  });

  it('inclui empresa_id validada na atualização SQL do item', () => {
    const update = PedidoRepository._montarUpdatePedidoItem({
      pedidoId: 159,
      empresaId: 1,
      item: { id: 238, produto_id: 747, quantidade: 1, preco_unitario: 12, subtotal: 12 },
      snapshot: {},
      colunasPedidoItens: new Set(['empresa_id'])
    });
    assert.match(update.sql, /empresa_id = \?/);
    const setAssignments = update.sql.split('SET ')[1].split('WHERE')[0].split(',');
    const empresaIndex = setAssignments.findIndex((assignment) => assignment.includes('empresa_id = ?'));
    assert.ok(empresaIndex >= 0);
    assert.equal(update.valores[empresaIndex], 1);
  });
});
