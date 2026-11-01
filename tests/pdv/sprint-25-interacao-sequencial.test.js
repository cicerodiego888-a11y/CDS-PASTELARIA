/**
 * Sprint 25 — sequência operacional do pagamento misto na tela do PDV.
 * Sem banco. Autorizador simulado. Sem TEF real, PIX, NFC-e, NF-e ou SEFAZ.
 *
 * Executar: node --test --test-concurrency=1 tests/pdv/sprint-25-interacao-sequencial.test.js
 */
'use strict';

const { beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const PagamentoSequencial = require('../../frontend/pdv/js/pagamentoSequencial');
const InteracaoPagamentoMisto = require('../../frontend/pdv/js/interacaoPagamentoMisto');

function criar(total = 50) {
  PagamentoSequencial.reset();
  return InteracaoPagamentoMisto.criar({
    totalVenda: total,
    sequencial: PagamentoSequencial
  });
}

describe('Sprint 25 — sequência da tela de pagamento misto', () => {
  beforeEach(() => {
    PagamentoSequencial.reset();
  });

  it('a escolha da forma abre o valor e a composição não começa preenchida', async () => {
    const tela = criar();
    const inicio = tela.visao();
    assert.equal(inicio.mostrarEscolhaForma, true);
    assert.equal(inicio.solicitarValor, false);
    assert.equal(inicio.restante, 50);
    assert.equal(inicio.parcelas.length, 0);
    assert.equal(inicio.podeFinalizar, false);

    const semForma = await tela.confirmarValor(20, { formaUsaTef: () => false });
    assert.equal(semForma.ok, false);
    assert.equal(semForma.codigo, 'VALOR_SEM_FORMA');
    assert.equal(PagamentoSequencial.snapshot().length, 0);

    const credito = tela.escolherForma('cartao_credito');
    assert.equal(credito.ok, true);
    assert.equal(credito.solicitarValor, true);
    assert.equal(credito.mostrarEscolhaForma, false);
    assert.equal(credito.formaEscolhida, 'cartao_credito');
    assert.equal(credito.parcelas.length, 0);
  });

  it('crédito e débito passam pelo autorizador e o dinheiro continua manual', async () => {
    const tela = criar();
    const autorizacoes = [];
    const autorizacao = {
      formaUsaTef: () => false,
      autorizarTef: async (forma) => {
        autorizacoes.push(forma);
        return { aprovado: true, status: 'aprovado', transacao_id: autorizacoes.length, nsu: 'NSU', autorizacao: 'AUT' };
      }
    };

    let passo = tela.escolherForma('cartao_credito');
    passo = await tela.confirmarValor(20, autorizacao);
    assert.equal(passo.ok, true);
    assert.equal(passo.solicitarValor, false);
    assert.equal(passo.restante, 30);
    assert.equal(passo.podeFinalizar, false);
    assert.equal(passo.parcelas.length, 1);
    assert.equal(passo.parcelas[0].status_autorizacao, 'aprovada');

    tela.escolherForma('cartao_debito');
    passo = await tela.confirmarValor(20, autorizacao);
    assert.equal(passo.restante, 10);
    assert.equal(passo.parcelas.length, 2);

    tela.escolherForma('dinheiro');
    passo = await tela.confirmarValor(10, autorizacao);
    assert.equal(passo.restante, 0);
    assert.equal(passo.podeFinalizar, true);
    assert.equal(passo.mostrarEscolhaForma, false);
    assert.equal(passo.parcelas[2].status_autorizacao, 'informada');
    assert.deepEqual(passo.parcelas.map((p) => [p.forma_pagamento, p.valor]), [
      ['cartao_credito', 20],
      ['cartao_debito', 20],
      ['dinheiro', 10]
    ]);
    assert.deepEqual(autorizacoes, ['cartao_credito', 'cartao_debito']);
    assert.equal(tela.escolherForma('pix').codigo, 'VENDA_QUITADA');
  });

  it('TEF ligado autoriza cada cartão uma vez e não reautoriza no fim da lista', async () => {
    const tela = criar();
    const autorizacoes = [];
    const tef = {
      formaUsaTef: (forma) => forma !== 'dinheiro',
      autorizarTef: async (forma, valor) => {
        autorizacoes.push(`${forma}:${valor}`);
        return {
          aprovado: true,
          transacao_id: autorizacoes.length,
          nsu: `NSU-${autorizacoes.length}`,
          autorizacao: `AUT-${autorizacoes.length}`
        };
      }
    };

    tela.escolherForma('cartao_credito');
    let passo = await tela.confirmarValor(20, tef);
    assert.equal(passo.parcelas[0].tef_transacao_id, 1);
    assert.equal(passo.parcelas[0].status_autorizacao, 'aprovada');

    tela.escolherForma('cartao_debito');
    passo = await tela.confirmarValor(20, tef);
    tela.escolherForma('dinheiro');
    passo = await tela.confirmarValor(10, tef);

    assert.equal(passo.podeFinalizar, true);
    assert.deepEqual(autorizacoes, ['cartao_credito:20', 'cartao_debito:20']);
    assert.equal(passo.parcelas[2].status_autorizacao, 'informada');
    assert.equal(passo.parcelas[2].tef_transacao_id, undefined);

    const repetidas = [];
    await PagamentoSequencial.autorizarParcelasPendentes(PagamentoSequencial.exportar(), {
      tefHabilitado: true,
      formaUsaTef: (forma) => forma !== 'dinheiro',
      autorizarTef: async (forma) => {
        repetidas.push(forma);
        return { aprovado: true, transacao_id: 99 };
      }
    });
    assert.equal(repetidas.length, 0);
    assert.equal(PagamentoSequencial.snapshot()[0].tef_transacao_id, 1);
    assert.equal(PagamentoSequencial.snapshot()[1].tef_transacao_id, 2);
  });

  it('valor acima do restante, rejeição e timeout preservam as parcelas anteriores', async () => {
    const tela = criar();
    tela.escolherForma('cartao_credito');
    await tela.confirmarValor(20, {
      formaUsaTef: () => true,
      autorizarTef: async () => ({ aprovado: true, status: 'aprovado', transacao_id: 7, nsu: 'NSU-7', autorizacao: 'AUT-7' })
    });

    tela.escolherForma('cartao_debito');
    const acima = await tela.confirmarValor(40, { formaUsaTef: () => false });
    assert.equal(acima.ok, false);
    assert.equal(acima.codigo, 'VALOR_ACIMA_DO_RESTANTE');
    assert.equal(acima.solicitarValor, true);
    assert.equal(PagamentoSequencial.snapshot().length, 1);
    assert.equal(tela.visao().podeFinalizar, false);

    const rejeitada = await tela.confirmarValor(20, {
      formaUsaTef: () => true,
      autorizarTef: async () => ({ aprovado: false, status: 'negado' })
    });
    assert.equal(rejeitada.codigo, 'TEF_REJEITADO');
    assert.notEqual(rejeitada.parcela.status_autorizacao, 'aprovada');
    assert.equal(PagamentoSequencial.snapshot().length, 1);

    const timeout = await tela.confirmarValor(20, {
      formaUsaTef: () => true,
      autorizarTef: async () => { throw new Error('timeout de comunicação'); }
    });
    assert.equal(timeout.codigo, 'TEF_FALHA');
    assert.equal(timeout.parcela.status_autorizacao, 'falha');
    assert.equal(PagamentoSequencial.snapshot().length, 1);
    assert.equal(PagamentoSequencial.snapshot()[0].tef_transacao_id, 7);
  });
});
