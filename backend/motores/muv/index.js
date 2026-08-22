/**
 * Motor Universal de Vendas — contratos 04.01, modo 04.02, atendimento 04.03.
 */
'use strict';

const contratos = require('./contratos');
const modoOperacaoVenda = require('./modoOperacaoVenda');
const atendimentoSchema = require('./atendimentoSchema');

module.exports = {
  ...contratos,
  ...modoOperacaoVenda,
  ...atendimentoSchema,
  get AtendimentoMultiempresaService() {
    return require('./AtendimentoMultiempresaService');
  }
};
