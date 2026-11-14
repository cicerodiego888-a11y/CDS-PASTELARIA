/**
 * Separa o dinheiro entregue, o valor aplicado à venda e o troco.
 * O valor aplicado é o que entra na soma dos pagamentos.
 */
function centavos(valor) {
  const numero = Number(valor);
  if (!Number.isFinite(numero)) return null;
  return Math.round((numero + Number.EPSILON) * 100);
}

function registroFinanceiroParcela(pagamento) {
  const origem = pagamento || {};
  const aplicadoC = centavos(origem.valor || 0);
  const entregueC = origem.valor_entregue != null
    ? centavos(origem.valor_entregue)
    : aplicadoC;
  const trocoC = origem.troco != null
    ? centavos(origem.troco)
    : (entregueC == null || aplicadoC == null ? null : entregueC - aplicadoC);

  if (
    aplicadoC == null
    || entregueC == null
    || trocoC == null
    || aplicadoC < 0
    || entregueC < 0
    || trocoC < 0
    || aplicadoC > entregueC
    || trocoC !== entregueC - aplicadoC
  ) {
    const erro = new Error('O troco não corresponde ao valor entregue e ao valor aplicado.');
    erro.code = 'TROCO_DIVERGENTE';
    throw erro;
  }

  return {
    valor: aplicadoC / 100,
    valor_entregue: entregueC / 100,
    troco: trocoC / 100
  };
}

module.exports = { registroFinanceiroParcela };
