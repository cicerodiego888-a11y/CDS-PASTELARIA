'use strict';

/**
 * Contrato do fechamento de uma composição já aprovada no pedido.
 * Não cria outra regra de dinheiro e não habilita recomposição em produção.
 */

const {
  RECOMPOSICAO_HABILITADA_EM_PRODUCAO
} = require('./RecomposicaoFiscalContratoService');
const {
  calcularReferenciasConfirmadas
} = require('./PagamentoSequencialComposicaoService');

function round2(valor) {
  return Math.round((Number(valor) + Number.EPSILON) * 100) / 100;
}

function subtotalDoItem(item) {
  if (item && item.subtotal != null && item.subtotal !== '') return Number(item.subtotal);
  return Number(item && item.preco_unitario || 0) * Number(item && item.quantidade || 0);
}

/**
 * Só a venda vinculada a pedido, cuja identidade comercial já fecha,
 * preserva o preço dos itens. Desconto técnico permanece no cabeçalho.
 */
function devePreservarItensComposicaoPedido({ pedidoId, itens, desconto, acrescimo, total } = {}) {
  const id = Number(pedidoId);
  if (!Number.isInteger(id) || id <= 0) return false;
  if (!Array.isArray(itens) || itens.length === 0) return false;
  const desc = Number(desconto || 0);
  const acres = Number(acrescimo || 0);
  if (!Number.isFinite(desc) || desc < 0 || !Number.isFinite(acres) || acres < 0) return false;
  const bruto = round2(itens.reduce((soma, item) => soma + subtotalDoItem(item), 0));
  const liquido = round2(bruto - desc + acres);
  const alvo = round2(Number(total || 0));
  return liquido > 0 && Math.abs(liquido - alvo) <= 0.02;
}

/**
 * ATIVACAO-01: permanece amarrada somente a RECOMPOSICAO_HABILITADA_EM_PRODUCAO.
 * O fechamento operacional NÃO autoriza reescrita no emissor.
 */
function reescritaDeComposicaoNoEmissorAutorizada() {
  return RECOMPOSICAO_HABILITADA_EM_PRODUCAO === true;
}

/**
 * Classificação já existente: digital aprovado é fiscal, dinheiro confirmado é não fiscal.
 * Pagamento misto não autoriza NFC-e nesta sprint: a divisão tributária do desconto
 * técnico entre as duas referências não está comprovada.
 */
function decisaoEmissaoComposicaoPreservada(pagamentos) {
  const referencias = calcularReferenciasConfirmadas(pagamentos);
  const fiscal = round2(referencias.valor_fiscal_referencia || 0);
  const naoFiscal = round2(referencias.valor_nao_fiscal_referencia || 0);
  if (fiscal > 0.009 && naoFiscal > 0.009) {
    return {
      referencias,
      emitirNfce: false,
      somenteNaoFiscal: false,
      codigo: 'COMPOSICAO_PEDIDO_MISTA_SEM_NFC',
      motivo: 'A composição aprovada do pedido foi preservada. A NFC-e de pagamento misto não é montada enquanto a divisão tributária entre o valor digital e o dinheiro não estiver autorizada.',
      valorFiscal: fiscal,
      valorNaoFiscal: naoFiscal
    };
  }
  if (fiscal <= 0.009 && naoFiscal > 0.009) {
    return {
      referencias,
      emitirNfce: false,
      somenteNaoFiscal: true,
      codigo: null,
      motivo: null,
      valorFiscal: 0,
      valorNaoFiscal: naoFiscal
    };
  }
  return {
    referencias,
    emitirNfce: fiscal > 0.009,
    somenteNaoFiscal: false,
    codigo: null,
    motivo: null,
    valorFiscal: fiscal,
    valorNaoFiscal: naoFiscal
  };
}

module.exports = {
  devePreservarItensComposicaoPedido,
  reescritaDeComposicaoNoEmissorAutorizada,
  decisaoEmissaoComposicaoPreservada,
  round2
};
