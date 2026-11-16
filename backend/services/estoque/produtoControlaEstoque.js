/**
 * RC8.0.Y — Controle opcional de estoque por produto.
 * controla_estoque = 1 (padrão): valida e movimenta saldo.
 * controla_estoque = 0: vende sem validar/baixar estoque.
 *
 * CDS-PDV-ESTOQUE-PRODUTOS-COMERCIAIS-FISCAIS-01:
 * produto comercial (acabado) não usa saldo próprio — só insumos da composição.
 */

'use strict';

function produtoControlaEstoque(produto) {
  if (produto == null) return true;
  if (
    produto.controla_estoque === undefined
    || produto.controla_estoque === null
    || produto.controla_estoque === ''
  ) {
    return true;
  }
  return Number(produto.controla_estoque) !== 0;
}

/**
 * Acabado de venda (COMERCIAL): item de catálogo/NFC-e, sem saldo próprio.
 * INSUMO (incl. comercializável) continua com validação/baixa de estoque próprio.
 */
function ehProdutoComercialSemSaldoProprio(produto) {
  if (!produto) return false;
  const tipo = String(produto.tipo_operacional || 'COMERCIAL').trim().toUpperCase();
  if (tipo === 'INSUMO') return false;
  return true;
}

/** True quando o SKU deve validar/baixar o próprio saldo na venda/capacidade. */
function produtoExigeValidacaoSaldoProprio(produto) {
  if (ehProdutoComercialSemSaldoProprio(produto)) return false;
  return produtoControlaEstoque(produto);
}

/**
 * Saldos virtuais para o motor F×NF quando o produto não controla estoque
 * ou é comercial sem saldo próprio (diretriz CDS-01).
 * Ambos = quantidade permite 100% fiscal ou 100% não fiscal conforme prioridade da venda.
 */
function saldosParaDistribuicaoVenda(produto, quantidade, disponivelFiscal, disponivelNaoFiscal) {
  if (!produtoExigeValidacaoSaldoProprio(produto)) {
    const q = Math.max(Number(quantidade) || 0, 0);
    return { saldoFiscal: q, saldoNaoFiscal: q };
  }
  return {
    saldoFiscal: Number(disponivelFiscal || 0),
    saldoNaoFiscal: Number(disponivelNaoFiscal || 0)
  };
}

function normalizarFlagControlaEstoque(valor) {
  if (valor === undefined || valor === null || valor === '') return 1;
  return Number(valor) === 0 ? 0 : 1;
}

/** Quantidade virtual “infinita” para consultas de disponibilidade sem controle. */
const SALDO_VIRTUAL_SEM_CONTROLE = 1e12;

module.exports = {
  produtoControlaEstoque,
  ehProdutoComercialSemSaldoProprio,
  produtoExigeValidacaoSaldoProprio,
  saldosParaDistribuicaoVenda,
  normalizarFlagControlaEstoque,
  SALDO_VIRTUAL_SEM_CONTROLE
};
