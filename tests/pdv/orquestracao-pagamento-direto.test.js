/**
 * Orquestração do pagamento direto.
 * O simulador existente recebe a solicitação. A parcela eletrônica
 * só entra na lista depois do retorno aprovado.
 * Sem banco, sem TEF real e sem emissão fiscal.
 *
 * Executar: node --test --test-concurrency=1 tests/pdv/orquestracao-pagamento-direto.test.js
 */
'use strict';

const { beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const PagamentoSequencial = require('../../frontend/pdv/js/pagamentoSequencial');
const InteracaoPagamentoMisto = require('../../frontend/pdv/js/interacaoPagamentoMisto');
const SimulatedGatewayAdapter = require('../../backend/services/tef/adapters/SimulatedGatewayAdapter');
const tefContrato = require('../../backend/services/tef/tefContrato');
const {
  RECOMPOSICAO_HABILITADA_EM_PRODUCAO
} = require('../../backend/services/vendas/RecomposicaoFiscalContratoService');

function criar(total = 50) {
  PagamentoSequencial.reset();
  return InteracaoPagamentoMisto.criar({
    totalVenda: total,
    sequencial: PagamentoSequencial
  });
}

function autorizarPeloSimulador(sequencia, resultado) {
  const adapter = new SimulatedGatewayAdapter({}, { nome: 'Stone', adquirente: 'STONE' });
  return async (forma, valor) => {
    sequencia.push({
      etapa: 'solicitacao_autorizador',
      forma,
      valor,
      parcelas_antes: PagamentoSequencial.snapshot().filter((parcela) => parcela.forma_pagamento === forma).length
    });
    try {
      const bruto = await adapter.autorizarPagamento({
        tipo: forma,
        valor,
        resultado_simulado: resultado
      });
      const resposta = tefContrato.paraRespostaApi(bruto, bruto.transacaoId);
      sequencia.push({
        etapa: 'retorno_adaptador',
        status: resposta.status,
        aprovado: resposta.aprovado,
        transacaoId: resposta.transacaoId
      });
      return resposta;
    } catch (error) {
      const timeout = String(error && error.message || '').toLowerCase().includes('timeout');
      const falha = {
        sucesso: false,
        aprovado: false,
        status: timeout ? 'timeout' : 'erro',
        codigo: timeout ? 'TIMEOUT' : 'ERRO',
        tipo_erro: timeout ? 'timeout' : 'erro',
        mensagem: error.message
      };
      sequencia.push({ etapa: 'retorno_adaptador', status: falha.status, codigo: falha.codigo });
      return falha;
    }
  };
}

async function confirmar(tela, forma, valor, sequencia, resultado) {
  assert.equal(InteracaoPagamentoMisto.modoConfirmacaoDireta(forma), 'tef');
  tela.escolherForma(forma);
  assert.equal(tela.visao().solicitarValor, true);
  return tela.confirmarValor(valor, {
    autorizarTef: autorizarPeloSimulador(sequencia, resultado)
  });
}

describe('orquestração do pagamento direto', () => {
  beforeEach(() => {
    PagamentoSequencial.reset();
  });

  it('1. débito aprovado pelo simulador registra identificador e saldo', async () => {
    const sequencia = [];
    const tela = criar(50);
    const passo = await confirmar(tela, 'cartao_debito', 20, sequencia, 'aprovado');
    assert.deepEqual(sequencia.map((item) => item.etapa), ['solicitacao_autorizador', 'retorno_adaptador']);
    assert.equal(sequencia[0].parcelas_antes, 0);
    assert.equal(sequencia[1].aprovado, true);
    assert.equal(passo.ok, true);
    assert.equal(passo.solicitarValor, false);
    assert.equal(passo.restante, 30);
    assert.equal(passo.parcelas[0].status_autorizacao, 'aprovada');
    assert.equal(passo.parcelas[0].tef_transacao_id, sequencia[1].transacaoId);
    assert.ok(passo.parcelas[0].nsu);
    assert.ok(passo.parcelas[0].autorizacao);
  });

  it('2. crédito aprovado pelo simulador segue a mesma sequência', async () => {
    const sequencia = [];
    const tela = criar(50);
    const passo = await confirmar(tela, 'cartao_credito', 15, sequencia, 'aprovado');
    assert.equal(sequencia[0].forma, 'cartao_credito');
    assert.equal(passo.parcelas[0].tef_transacao_id, sequencia[1].transacaoId);
    assert.equal(passo.restante, 35);
    assert.equal(passo.podeFinalizar, false);
  });

  it('3. PIX aprovado pelo simulador registra a parcela eletrônica', async () => {
    const sequencia = [];
    const tela = criar(50);
    const passo = await confirmar(tela, 'pix', 10, sequencia, 'aprovado');
    assert.equal(sequencia[1].status, 'aprovado');
    assert.equal(passo.parcelas[0].forma_pagamento, 'pix');
    assert.equal(passo.parcelas[0].status_autorizacao, 'aprovada');
    assert.equal(passo.parcelas[0].tef_transacao_id, sequencia[1].transacaoId);
    assert.equal(passo.restante, 40);
  });

  it('4. débito recusado não entra como parcela aprovada', async () => {
    const sequencia = [];
    const tela = criar(50);
    const passo = await confirmar(tela, 'cartao_debito', 20, sequencia, 'recusado');
    assert.equal(sequencia[1].status, 'negado');
    assert.equal(passo.ok, false);
    assert.equal(passo.codigo, 'TEF_REJEITADO');
    assert.equal(PagamentoSequencial.snapshot().length, 0);
    assert.equal(passo.restante, 50);
    assert.equal(passo.solicitarValor, true);
  });

  it('5. crédito em timeout preserva a parcela anterior', async () => {
    const tela = criar(50);
    const aprovado = [];
    await confirmar(tela, 'cartao_debito', 20, aprovado, 'aprovado');
    const anterior = PagamentoSequencial.snapshot()[0].tef_transacao_id;
    const sequencia = [];
    tela.escolherForma('cartao_credito');
    const passo = await tela.confirmarValor(20, {
      autorizarTef: autorizarPeloSimulador(sequencia, 'timeout')
    });
    assert.equal(sequencia[1].codigo, 'TIMEOUT');
    assert.equal(passo.codigo, 'TIMEOUT');
    assert.equal(PagamentoSequencial.snapshot().length, 1);
    assert.equal(PagamentoSequencial.snapshot()[0].tef_transacao_id, anterior);
    assert.equal(tela.visao().restante, 30);
  });

  it('6. PIX com erro não registra parcela aprovada', async () => {
    const sequencia = [];
    const tela = criar(50);
    const passo = await confirmar(tela, 'pix', 12, sequencia, 'erro');
    assert.equal(sequencia[1].status, 'erro');
    assert.equal(passo.codigo, 'ERRO');
    assert.equal(PagamentoSequencial.snapshot().length, 0);
    assert.equal(passo.restante, 50);
  });

  it('7. parcela aprovada não é reautorizada no mesmo núcleo do misto', async () => {
    const tela = criar(50);
    const primeira = [];
    await confirmar(tela, 'cartao_debito', 20, primeira, 'aprovado');
    const repetidas = [];
    await PagamentoSequencial.autorizarParcelasPendentes(PagamentoSequencial.exportar(), {
      tefHabilitado: true,
      formaUsaTef: () => true,
      autorizarTef: async () => {
        repetidas.push('reautorizacao');
        return { aprovado: true, status: 'aprovado', transacao_id: 'NAO-DEVE' };
      }
    });
    assert.equal(repetidas.length, 0);
    assert.equal(PagamentoSequencial.snapshot()[0].tef_transacao_id, primeira[1].transacaoId);
    assert.equal(typeof PagamentoSequencial.adicionar, 'function');
  });

  it('8. nenhuma parcela eletrônica existe antes do retorno positivo', async () => {
    const tela = criar(50);
    tela.escolherForma('cartao_debito');
    let liberar;
    const espera = new Promise((resolve) => { liberar = resolve; });
    const sequencia = [];
    const envio = tela.confirmarValor(20, {
      autorizarTef: async (forma, valor) => {
        sequencia.push('solicitacao');
        await espera;
        sequencia.push('adaptador');
        return autorizarPeloSimulador(sequencia, 'aprovado')(forma, valor);
      }
    });
    await Promise.resolve();
    assert.deepEqual(sequencia, ['solicitacao']);
    assert.equal(PagamentoSequencial.snapshot().length, 0);
    liberar();
    const passo = await envio;
    assert.equal(passo.ok, true);
    assert.equal(PagamentoSequencial.snapshot().length, 1);
    assert.equal(passo.parcelas[0].status_autorizacao, 'aprovada');

    PagamentoSequencial.reset();
    const pendente = criar(50);
    const seqPendente = [];
    pendente.escolherForma('cartao_credito');
    const aguardando = await pendente.confirmarValor(10, {
      autorizarTef: autorizarPeloSimulador(seqPendente, 'pendente')
    });
    assert.equal(aguardando.codigo, 'PENDENTE');
    assert.equal(aguardando.restante, 50);
    assert.equal(PagamentoSequencial.exportar().length, 0);
    assert.equal(PagamentoSequencial.snapshot()[0].status_autorizacao, 'pendente');
    assert.equal(RECOMPOSICAO_HABILITADA_EM_PRODUCAO, false);
  });
});
