/**
 * Constantes do adapter Open Finance real.
 * Instituição e endpoints oficiais NÃO estão definidos neste ambiente.
 * Sem URL de banco versionada.
 * @module motores/bancario/providers/openfinance-real/OpenFinanceRealConstants
 */
'use strict';

const { CODIGO_PROVIDER } = require('../../contracts/constantes');
const { resolverEndpoints } = require('./ambienteEndpoints');

const CODIGO = CODIGO_PROVIDER.OPEN_FINANCE_REAL;
const NOME = 'Open Finance (provider real — instituição não definida)';
const STATUS_ADAPTER = 'PREPARADO_NAO_IMPLEMENTADO';

const TIMEOUT_MS = 15000;
const MAX_RETRY_SEGURO = 2;

const CHAVES_SECRET_CONCEITUAIS = Object.freeze([
  'client_id',
  'client_secret',
  'certificado',
  'private_key',
  'access_token',
  'refresh_token'
]);

const AMBIENTES_REAIS = Object.freeze(['SANDBOX', 'HOMOLOGACAO', 'PRODUCAO']);

function oficialHabilitado(env = process.env, ambiente) {
  if (env.MBC_OF_REAL_HABILITADO !== '1') return false;
  const ep = resolverEndpoints(ambiente, env);
  return !!(ep.authUrl && ep.tokenUrl && ep.apiUrl);
}

function chaveTokenConsentimento(consentimentoId, tipo) {
  return 'mbc.of.real.' + Number(consentimentoId) + '.' + tipo;
}

module.exports = {
  CODIGO,
  NOME,
  STATUS_ADAPTER,
  TIMEOUT_MS,
  MAX_RETRY_SEGURO,
  CHAVES_SECRET_CONCEITUAIS,
  AMBIENTES_REAIS,
  oficialHabilitado,
  chaveTokenConsentimento
};
