/**
 * Autorização do adapter real.
 * Sem documentação oficial: nenhum OAuth/OIDC de instituição.
 * State permanece no MBC-06.
 * @module motores/bancario/providers/openfinance-real/Auth
 */
'use strict';

const { providerRealPodeOperar, exigirOperacaoReal } = require('./prontidaoOperacaoReal');

function autorizacaoRealHabilitada(params) {
  return providerRealPodeOperar(params).ok;
}

module.exports = { autorizacaoRealHabilitada, exigirOperacaoReal };
