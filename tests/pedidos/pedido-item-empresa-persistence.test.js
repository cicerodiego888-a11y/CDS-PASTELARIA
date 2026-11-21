'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const databasePath = require.resolve('../../backend/database');
require.cache[databasePath] = {
  id: databasePath,
  filename: databasePath,
  loaded: true,
  exports: {}
};

const { _montarInsertPedidoItem } = require('../../backend/services/pedido/PedidoRepository');

describe('persistência da empresa no item comercial do pedido', () => {
  it('grava empresa_id do pedido ao inserir item com schema Sprint 1', () => {
    const insert = _montarInsertPedidoItem({
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
      () => _montarInsertPedidoItem({
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
});
