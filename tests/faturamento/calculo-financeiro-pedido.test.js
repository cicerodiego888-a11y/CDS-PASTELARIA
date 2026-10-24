'use strict';

const assert = require('assert');
const { calcularFinanceiroPedido } = require('../../backend/services/faturamento/CalculoFinanceiroPedido');

const comDescontoEFrete = calcularFinanceiroPedido([
  {
    quantidade: 2,
    preco_unitario: 10,
    desconto_percentual: 10,
    subtotal: 18
  }
], {
  desconto: 2,
  frete: 5,
  acrescimo: 0
});

assert.deepStrictEqual(comDescontoEFrete, {
  subtotalProdutos: 18,
  desconto: 2,
  frete: 5,
  acrescimo: 0,
  valor_outros: 5,
  total: 21
});

const comOverrides = calcularFinanceiroPedido([
  {
    quantidade: 2,
    preco_unitario: 10,
    desconto_percentual: 10,
    subtotal: 18
  }
], {
  desconto: 1,
  frete: 8,
  acrescimo: 3
});

assert.strictEqual(comOverrides.total, 28);
assert.strictEqual(comOverrides.valor_outros, 11);

const legadoSemSubtotal = calcularFinanceiroPedido([
  { quantidade: 2, preco_unitario: 10, desconto_percentual: 10, subtotal: null }
], {});
assert.strictEqual(legadoSemSubtotal.subtotalProdutos, 18);
assert.strictEqual(legadoSemSubtotal.total, 18);

const zeroConfigurado = calcularFinanceiroPedido([
  { quantidade: 1, preco_unitario: 10, subtotal: 0 }
], {});
assert.strictEqual(zeroConfigurado.total, 0);

console.log('CalculoFinanceiroPedido OK — 4 cenários');
