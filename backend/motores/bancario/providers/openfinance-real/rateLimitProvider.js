/**
 * Rate limit do provider real. Sem valor inventado.
 * @module motores/bancario/providers/openfinance-real/rateLimitProvider
 */
'use strict';

const RATE_LIMIT_PROVIDER = Object.freeze({
  status: 'PENDENTE',
  origem: 'DOCUMENTACAO_PROVIDER',
  limite: null,
  janela: null,
  unidade: null
});

function rateLimitOficialConhecido() {
  return RATE_LIMIT_PROVIDER.status === 'HOMOLOGADO' && RATE_LIMIT_PROVIDER.limite != null;
}

module.exports = { RATE_LIMIT_PROVIDER, rateLimitOficialConhecido };
