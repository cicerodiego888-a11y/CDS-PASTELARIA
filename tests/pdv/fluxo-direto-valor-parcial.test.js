/**
 * Fluxo direto de valor parcial na tela de pagamento do PDV.
 * Sem banco, sem TEF real, sem PIX real e sem emissão fiscal.
 *
 * Executar: node --test --test-concurrency=1 tests/pdv/fluxo-direto-valor-parcial.test.js
 */
'use strict';

const { beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

process.env.CDS_RECOMPOSICAO_REFERENCIA_TESTE = '1';
delete process.env.CDS_RECOMPOSICAO_HOMOLOGACAO_DISTRIBUIR;
delete process.env.CDS_RECOMPOSICAO_APLICAR_DISTRIBUICAO;

const PagamentoSequencial = require('../../frontend/pdv/js/pagamentoSequencial');
const InteracaoPagamentoMisto = require('../../frontend/pdv/js/interacaoPagamentoMisto');
const fluxo = require('../../backend/services/tef/tefFluxoPagamento');
const {
  RECOMPOSICAO_HABILITADA_EM_PRODUCAO
} = require('../../backend/services/vendas/RecomposicaoFiscalContratoService');
const {
  avaliarReferenciaRecomposicao
} = require('../../backend/services/vendas/PagamentoSequencialComposicaoService');

function criar(total = 50) {
  PagamentoSequencial.reset();
  return InteracaoPagamentoMisto.criar({
    totalVenda: total,
    sequencial: PagamentoSequencial
  });
}

describe('fluxo direto de valor parcial', () => {
  beforeEach(() => {
    PagamentoSequencial.reset();
  });

  it('débito pede o valor e só registra depois da aprovação', async () => {
    const tela = criar(50);
    assert.equal(tela.visao().solicitarValor, false);
    const escolha = tela.escolherForma('cartao_debito');
    assert.equal(escolha.solicitarValor, true);
    assert.equal(escolha.parcelas.length, 0);
    assert.equal(InteracaoPagamentoMisto.modoConfirmacaoDireta('cartao_debito', {
      tefHabilitado: true,
      formaUsaTef: () => true
    }), 'tef');

    let liberar;
    const pendente = new Promise((resolve) => { liberar = resolve; });
    const envio = tela.confirmarValor(20, {
      formaUsaTef: () => true,
      autorizarTef: () => pendente
    });
    await Promise.resolve();
    assert.equal(PagamentoSequencial.snapshot().length, 0);
    liberar({ aprovado: true, status: 'aprovado', transacao_id: 3, nsu: 'NSU-3', autorizacao: 'AUT-3' });
    const passo = await envio;
    assert.equal(passo.ok, true);
    assert.equal(passo.solicitarValor, false);
    assert.equal(passo.restante, 30);
    assert.equal(passo.podeFinalizar, false);
    assert.equal(passo.parcelas[0].status_autorizacao, 'aprovada');
    assert.equal(passo.parcelas[0].tef_transacao_id, 3);
  });

  it('crédito recusado não entra na lista e não reautoriza o débito aprovado', async () => {
    const tela = criar(50);
    tela.escolherForma('cartao_debito');
    await tela.confirmarValor(20, {
      formaUsaTef: () => true,
      autorizarTef: async () => ({ aprovado: true, status: 'aprovado', transacao_id: 4, nsu: 'NSU-4', autorizacao: 'AUT-4' })
    });
    tela.escolherForma('cartao_credito');
    const recusa = await tela.confirmarValor(20, {
      formaUsaTef: () => true,
      autorizarTef: async () => ({ aprovado: false, status: 'negado' })
    });
    assert.equal(recusa.codigo, 'TEF_REJEITADO');
    assert.notEqual(recusa.parcela.status_autorizacao, 'aprovada');
    assert.equal(PagamentoSequencial.snapshot().length, 1);
    const repetidas = [];
    await PagamentoSequencial.autorizarParcelasPendentes(PagamentoSequencial.exportar(), {
      tefHabilitado: true,
      formaUsaTef: () => true,
      autorizarTef: async () => {
        repetidas.push(1);
        return { aprovado: true, transacao_id: 99 };
      }
    });
    assert.equal(repetidas.length, 0);
  });

  it('PIX eletrônico não é registrado sem o autorizador', async () => {
    assert.equal(InteracaoPagamentoMisto.modoConfirmacaoDireta('pix'), 'tef');
    assert.equal(InteracaoPagamentoMisto.modoConfirmacaoDireta('cartao_debito'), 'tef');
    assert.equal(InteracaoPagamentoMisto.modoConfirmacaoDireta('cartao_credito'), 'tef');

    const tela = criar(50);
    tela.escolherForma('pix');
    const semAutorizador = await tela.confirmarValor(15, { formaUsaTef: () => false });
    assert.equal(semAutorizador.codigo, 'AUTORIZADOR_AUSENTE');
    assert.equal(PagamentoSequencial.snapshot().length, 0);
    assert.equal(semAutorizador.restante, 50);
  });

  it('dinheiro parcial atualiza o saldo e a referência sem passar do restante', async () => {
    const tela = criar(50);
    assert.equal(InteracaoPagamentoMisto.modoConfirmacaoDireta('dinheiro', { tefHabilitado: true }), 'manual');
    tela.escolherForma('cartao_debito');
    await tela.confirmarValor(20, {
      formaUsaTef: () => true,
      autorizarTef: async () => ({ aprovado: true, status: 'aprovado', transacao_id: 8, nsu: 'NSU-8', autorizacao: 'AUT-8' })
    });
    tela.escolherForma('dinheiro');
    const acima = await tela.confirmarValor(40, { formaUsaTef: () => false });
    assert.equal(acima.codigo, 'VALOR_ACIMA_DO_RESTANTE');
    assert.equal(PagamentoSequencial.snapshot().length, 1);
    const dinheiro = await tela.confirmarValor(10, { formaUsaTef: () => false });
    assert.equal(dinheiro.restante, 20);
    assert.equal(dinheiro.podeFinalizar, false);
    const referencia = avaliarReferenciaRecomposicao({
      total: 30,
      pagamentos: [
        { forma_pagamento: 'cartao_debito', valor: 20, status_autorizacao: 'aprovada' },
        { forma_pagamento: 'dinheiro', valor: 10 }
      ]
    });
    assert.equal(referencia.valor_fiscal_referencia, 20);
    assert.equal(referencia.valor_nao_fiscal_referencia, 10);
    assert.equal(referencia.valor_fiscal_referencia + referencia.valor_nao_fiscal_referencia, 30);
    assert.equal(RECOMPOSICAO_HABILITADA_EM_PRODUCAO, false);
    assert.equal(referencia.aplica_ao_fluxo_oficial, false);
  });

  it('uma parcela direta não volta ao pagamento único e o misto usa a mesma lista', () => {
    const tela = criar(50);
    tela.escolherForma('cartao_debito');
    const resolvido = fluxo.resolverFluxoPagamentoFiscal({
      modoConfirmacaoFiscal: 'TEF',
      tefHabilitado: true,
      formaPagamento: 'misto',
      ehPagamentoMisto: true,
      pagamentosMistos: [{ forma_pagamento: 'cartao_debito', valor: 50, tef_transacao_id: 1 }],
      totalFiscal: 50
    });
    assert.equal(fluxo.ramoFechamentoPagamento({
      ...resolvido,
      totalFiscal: 50,
      ehPagamentoMisto: true
    }), 'lista_sequencial');
    assert.equal(tela.visao().mostrarEscolhaForma, false);
    assert.equal(typeof PagamentoSequencial.adicionar, 'function');
  });
});
