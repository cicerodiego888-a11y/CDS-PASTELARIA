'use strict';

const assert = require('assert');
const { montarParcelasReceber } = require('../../backend/services/vendas/ParcelasReceber');

const parcelas = montarParcelasReceber(100, 5, 3);
const somaPorComponente = parcelas.flatMap((parcela) => parcela.componentes)
  .reduce((soma, componente) => {
    soma[componente.componente] = (soma[componente.componente] || 0) + componente.valor_parcela;
    return soma;
  }, {});

assert.strictEqual(somaPorComponente.produtos, 95);
assert.strictEqual(somaPorComponente.outros, 5);
assert.strictEqual(
  parcelas.reduce(
    (soma, parcela) => soma + parcela.componentes.reduce((total, c) => total + c.valor_parcela, 0),
    0
  ),
  100
);
assert.deepStrictEqual(
  parcelas.map((parcela) => parcela.componentes.reduce((soma, c) => soma + c.valor_parcela, 0)),
  [33.34, 33.33, 33.33]
);

const semOutros = montarParcelasReceber(10, 0, 2);
assert.ok(semOutros.every((parcela) => parcela.componentes.length === 1));
assert.ok(semOutros.every((parcela) => parcela.componentes[0].componente === 'produtos'));

assert.throws(() => montarParcelasReceber(10, 11, 2), RangeError);

console.log('ParcelasReceber OK — soma reconciliada e componentes separados');
