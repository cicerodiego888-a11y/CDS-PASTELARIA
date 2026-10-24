'use strict';

function arredondarCentavos(valor) {
  return Math.round((Number(valor) + Number.EPSILON) * 100) / 100;
}

function numeroFinito(valor, campo) {
  const numero = Number(valor == null || valor === '' ? 0 : valor);
  if (!Number.isFinite(numero)) {
    throw new TypeError(`Valor inválido para ${campo}.`);
  }
  return numero;
}

function subtotalLiquidoItem(item) {
  if (item.subtotal != null && item.subtotal !== '') {
    return arredondarCentavos(numeroFinito(item.subtotal, 'subtotal do item'));
  }

  const quantidade = numeroFinito(item.quantidade, 'quantidade do item');
  const preco = numeroFinito(item.preco_unitario, 'preço unitário do item');
  const descontoPercentual = numeroFinito(item.desconto_percentual, 'desconto percentual');
  return arredondarCentavos(
    quantidade * preco * (1 - descontoPercentual / 100)
  );
}

function calcularFinanceiroPedido(itens = [], ajustes = {}) {
  const subtotalProdutos = arredondarCentavos(
    (Array.isArray(itens) ? itens : [])
      .reduce((soma, item) => soma + subtotalLiquidoItem(item), 0)
  );
  const desconto = arredondarCentavos(numeroFinito(ajustes.desconto, 'desconto'));
  const frete = arredondarCentavos(numeroFinito(ajustes.frete, 'frete'));
  const acrescimo = arredondarCentavos(numeroFinito(ajustes.acrescimo, 'acréscimo'));
  const valorOutros = arredondarCentavos(frete + acrescimo);

  return {
    subtotalProdutos,
    desconto,
    frete,
    acrescimo,
    valor_outros: valorOutros,
    total: arredondarCentavos(subtotalProdutos - desconto + valorOutros)
  };
}

module.exports = {
  calcularFinanceiroPedido,
  subtotalLiquidoItem
};
