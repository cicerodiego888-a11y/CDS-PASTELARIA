/**
 * Erros do adapter. Reusa categorias MBC. Sem response bruto ao frontend.
 * @module motores/bancario/providers/openfinance-real/Errors
 */
'use strict';

const { categorizarHttp } = require('./OpenFinanceRealClient');
const { classificarErroProvider, CATEGORIA_ERRO_PROVIDER } = require('../../contracts/constantes');
const { MSG_BLOQUEIO_OPERACAO_REAL } = require('./prontidaoOperacaoReal');

module.exports = {
  categorizarHttp,
  classificarErroProvider,
  CATEGORIA_ERRO_PROVIDER,
  MSG_BLOQUEIO_OPERACAO_REAL
};
