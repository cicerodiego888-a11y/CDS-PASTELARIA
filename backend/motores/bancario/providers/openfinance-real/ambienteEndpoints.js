/**
 * Separação SANDBOX / HOMOLOGAÇÃO / PRODUÇÃO.
 * Sem URLs de instituição versionadas. Sem inventar endpoint.
 * @module motores/bancario/providers/openfinance-real/ambienteEndpoints
 */
'use strict';

const { ERROS, erroMbc } = require('../../contracts/constantes');

const STATUS_HOMOLOGACAO = 'NAO_HOMOLOGAVEL';

function pickEnv(env, base, ambiente) {
  const sufixo = ambiente ? String(ambiente).toUpperCase() : '';
  if (sufixo && env[base + '_' + sufixo]) return String(env[base + '_' + sufixo]);
  if (env[base]) return String(env[base]);
  return null;
}

function resolverEndpoints(ambiente, env = process.env) {
  const amb = String(ambiente || '').toUpperCase() || null;
  return {
    authUrl: pickEnv(env, 'MBC_OF_REAL_AUTH_URL', amb),
    tokenUrl: pickEnv(env, 'MBC_OF_REAL_TOKEN_URL', amb),
    apiUrl: pickEnv(env, 'MBC_OF_REAL_API_URL', amb)
  };
}

function textoUrls(urls) {
  return [urls.authUrl, urls.tokenUrl, urls.apiUrl].filter(Boolean).join(' ').toLowerCase();
}

function validarSeparacaoAmbiente(ambiente, urls) {
  const amb = String(ambiente || '').toUpperCase();
  const txt = textoUrls(urls || {});
  if (!txt) return true;
  if (amb === 'PRODUCAO' && /sandbox|homolog|\bhml\b/.test(txt)) {
    throw erroMbc(
      ERROS.AMBIENTE_INVALIDO,
      'Configuração de ambiente incompatível com a operação solicitada.',
      409
    );
  }
  if (amb === 'SANDBOX' && /\/prod(\/|$)|production/.test(txt)) {
    throw erroMbc(
      ERROS.AMBIENTE_INVALIDO,
      'Configuração de ambiente incompatível com a operação solicitada.',
      409
    );
  }
  return true;
}

function ambientesComMesmoEndpoint(env = process.env) {
  const sand = resolverEndpoints('SANDBOX', env).apiUrl;
  const prod = resolverEndpoints('PRODUCAO', env).apiUrl;
  return !!(sand && prod && sand === prod);
}

module.exports = {
  STATUS_HOMOLOGACAO,
  resolverEndpoints,
  validarSeparacaoAmbiente,
  ambientesComMesmoEndpoint
};
