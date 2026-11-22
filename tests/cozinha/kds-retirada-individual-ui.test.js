'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const kds = require('../../frontend/erp/js/cozinha-kds.js');

describe('KDS — retirada individual por item', () => {
  it('mantém a bebida retirada em RETIRADOS e o pastel pronto em PRONTOS na mesma rodada', () => {
    const rodada = {
      id: 22,
      empresa_id: 1,
      unidade_id: 3,
      mesa_id: 5,
      mesa_numero: '5',
      atendimento_id: 44,
      numero_rodada: 2,
      sequencia_global: 8,
      estado_preparacao: 'EM_PREPARACAO',
      retirada_confirmada_por_ledger: false,
      retirada_estado: 'PENDENTE',
      enviada_em: '2026-11-17 20:50:00',
      itens: [
        {
          id: 801,
          pedido_id: 90,
          pedido_item_id: 901,
          numero_comanda: 44,
          tipo_item: 'BEBIDA',
          estado_preparacao: 'PRONTO',
          qty_solicitada: '1.000',
          qty_pendente_retirada: '0.000',
          qty_retirada_liquida: '1.000',
          qty_entregue: '1.000',
          qty_disponivel_retirada: '0.000',
          retirada_confirmada_por_ledger: true,
          produto_nome_snapshot: 'Refrigerante'
        },
        {
          id: 802,
          pedido_id: 90,
          pedido_item_id: 902,
          numero_comanda: 44,
          tipo_item: 'PASTEL',
          estado_preparacao: 'PRONTO',
          qty_solicitada: '1.000',
          qty_pendente_retirada: '1.000',
          qty_retirada_liquida: '0.000',
          retirada_confirmada_por_ledger: false,
          produto_nome_snapshot: 'Pastel'
        }
      ]
    };

    const distribuicao = kds.distribuirPorEstado([rodada]);
    assert.deepEqual(distribuicao.RETIRADO[0].itens.map((item) => item.id), [801]);
    assert.deepEqual(distribuicao.PRONTO[0].itens.map((item) => item.id), [802]);
    assert.equal(distribuicao.RETIRADO[0].retirada_por_item, true);
    assert.equal(distribuicao.RETIRADO[0].id, distribuicao.PRONTO[0].id);
    assert.equal(distribuicao.RETIRADO[0].itens[0].pedido_id, 90);
    assert.equal(distribuicao.PRONTO[0].itens[0].pedido_id, 90);

    const html = kds.htmlPainel({
      rodadas: [rodada],
      distribuicao,
      turnoPendencias: []
    }, new Date('2026-11-17T21:10:00-03:00'));
    assert.match(html, /data-acao="confirmar-retirada-item" data-item-id="802"/);
    assert.doesNotMatch(html, /data-acao="confirmar-retirada-item" data-item-id="801"/);
    assert.doesNotMatch(html, /data-acao="cancelar-rodada"/);
    assert.doesNotMatch(html, /data-acao="cancelar-item" data-item-id="801"/);
    assert.match(html, /Retirada destes itens confirmada individualmente no ledger/);
  });

  it('disponibiliza retirada quando o item está pronto mesmo com a rodada em preparação', () => {
    const rodada = {
      id: 23,
      empresa_id: 1,
      unidade_id: 3,
      estado_preparacao: 'EM_PREPARACAO',
      retirada_confirmada_por_ledger: false,
      itens: [{
        id: 803,
        pedido_id: 91,
        pedido_item_id: 903,
        tipo_item: 'BEBIDA',
        estado_preparacao: 'PRONTO',
        qty_pendente_retirada: '1.000',
        qty_disponivel_retirada: '1.000',
        qty_pendente_entrega: '0.000',
        qty_entregue: '1.000',
        qty_retirada_liquida: '0.000',
        produto_nome_snapshot: 'Suco'
      }]
    };

    const html = kds.htmlPainel({
      rodadas: [rodada],
      distribuicao: kds.distribuirPorEstado([rodada]),
      turnoPendencias: []
    }, new Date('2026-11-17T21:10:00-03:00'));
    assert.match(html, /data-acao="confirmar-retirada-item" data-item-id="803"/);
  });

  it('mostra somente o saldo pendente em PRONTOS após retirada parcial', () => {
    const rodada = {
      id: 24,
      empresa_id: 1,
      unidade_id: 3,
      estado_preparacao: 'PRONTA',
      retirada_confirmada_por_ledger: false,
      retirada_estado: 'PENDENTE',
      itens: [{
        id: 804,
        pedido_id: 92,
        pedido_item_id: 904,
        tipo_item: 'PASTEL',
        estado_preparacao: 'PRONTO',
        qty_solicitada: '2.000',
        qty_retirada_liquida: '1.500',
        qty_pendente_retirada: '0.500',
        produto_nome_snapshot: 'Pastel'
      }]
    };
    const distribuicao = kds.distribuirPorEstado([rodada]);
    const html = kds.htmlPainel({
      rodadas: [rodada],
      distribuicao,
      turnoPendencias: []
    }, new Date('2026-11-17T21:10:00-03:00'));

    assert.equal(distribuicao.PRONTO[0].itens[0].id, 804);
    assert.equal(distribuicao.RETIRADO.length, 0);
    assert.match(html, /class="kds-item__qtd">0\.5<small>pendente<\/small>/);
    assert.doesNotMatch(html, /class="kds-item__qtd">2/);
    assert.match(html, /Retirada líquida: 1\.5 · Pendente: 0\.5/);
  });

  it('mantém todos os itens integralmente retirados na coluna RETIRADOS', () => {
    const rodada = {
      id: 25,
      empresa_id: 1,
      unidade_id: 3,
      estado_preparacao: 'PRONTA',
      retirada_confirmada_por_ledger: true,
      retirada_estado: 'RETIRADA',
      itens: [805, 806].map((id) => ({
        id,
        tipo_item: 'PASTEL',
        estado_preparacao: 'PRONTO',
        qty_solicitada: '1.000',
        qty_retirada_liquida: '1.000',
        qty_pendente_retirada: '0.000',
        retirada_confirmada_por_ledger: true,
        produto_nome_snapshot: `Produto ${id}`
      }))
    };
    const distribuicao = kds.distribuirPorEstado([rodada]);
    const html = kds.htmlPainel({
      rodadas: [rodada],
      distribuicao,
      turnoPendencias: []
    }, new Date('2026-11-17T21:10:00-03:00'));

    assert.deepEqual(distribuicao.RETIRADO[0].itens.map((item) => item.id), [805, 806]);
    assert.equal(distribuicao.PRONTO.length, 0);
    assert.match(html, /data-coluna="RETIRADO"/);
    assert.match(html, /data-item-id="805"/);
    assert.match(html, /data-item-id="806"/);
  });
});
