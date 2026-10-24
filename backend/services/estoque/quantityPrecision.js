'use strict';

const PRECISAO_QUANTIDADE_ESTOQUE = 6;
const FATOR_ARREDONDAMENTO = 10 ** PRECISAO_QUANTIDADE_ESTOQUE;

function roundStockQuantity(value) {
  return Math.round(Number(value || 0) * FATOR_ARREDONDAMENTO) / FATOR_ARREDONDAMENTO;
}

function roundStockQuantityOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? roundStockQuantity(number) : 0;
}

module.exports = {
  PRECISAO_QUANTIDADE_ESTOQUE,
  roundStockQuantity,
  roundStockQuantityOrZero
};
