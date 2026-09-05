/**
 * Prontidão para operação real. Sem instituição oficial = recusa determinística.
 * Nenhuma chamada HTTP é feita aqui.
 * @module motores/bancario/providers/openfinance-real/prontidaoOperacaoReal
 */
'use strict';

const { ERROS, erroMbc } = require('../../contracts/constantes');
const { derivarChave } = require('../../secrets/EncryptedLocalSecretStore');
const { oficialHabilitado } = require('./OpenFinanceRealConstants');
const { resolverEndpoints, validarSeparacaoAmbiente } = require('./ambienteEndpoints');

const MSG_BLOQUEIO_OPERACAO_REAL = 'Este provider ainda não está habilitado para operação real.';
const MSG_AMBIENTE_INCOMPATIVEL = 'Configuração de ambiente incompatível com a operação solicitada.';

const INSTITUICAO_OFICIAL = null;
const DOCUMENTACAO_OFICIAL_URL = null;
const PRODUTO_OPEN_FINANCE_OFICIAL = null;
const OAUTH_OFICIAL = null;
const CERTIFICADO_OFICIAL_EXIGIDO = null;

function secretStoreProducaoDisponivel() {
  return false;
}

function featureFlagLigada(env = process.env) {
  return String(env.MBC_OPEN_FINANCE_REAL_ENABLED || '').toLowerCase() === 'true';
}

function ambienteEndpointValido(ambiente, urls) {
  try {
    validarSeparacaoAmbiente(ambiente, urls);
    return true;
  } catch (err) {
    throw erroMbc(ERROS.AMBIENTE_INVALIDO, MSG_AMBIENTE_INCOMPATIVEL, 409);
  }
}

function providerRealPodeOperar(params = {}) {
  const env = params.env || process.env;
  const ambiente = params.ambiente || null;
  const motivos = [];

  if (!INSTITUICAO_OFICIAL || !DOCUMENTACAO_OFICIAL_URL || !PRODUTO_OPEN_FINANCE_OFICIAL) {
    motivos.push('AGUARDANDO_PROVIDER_REAL_AMBIENTE_OFICIAL');
  }
  if (!featureFlagLigada(env)) {
    motivos.push('FEATURE_FLAG_DESLIGADA');
  }
  if (!oficialHabilitado(env, ambiente)) {
    motivos.push('ENDPOINTS_OFICIAIS_AUSENTES');
  }
  if (!OAUTH_OFICIAL) {
    motivos.push('OAUTH_OFICIAL_AUSENTE');
  }
  if (params.certificado_exigido === true && params.certificado_configurado !== true) {
    motivos.push('CERTIFICADO_AUSENTE');
  }
  if (params.secret_configurado === false) {
    motivos.push('CREDENCIAL_AUSENTE');
  }
  const urls = resolverEndpoints(ambiente, env);
  try {
    if (urls.authUrl || urls.tokenUrl || urls.apiUrl) {
      ambienteEndpointValido(ambiente, urls);
    }
  } catch (_) {
    motivos.push('AMBIENTE_ENDPOINT_INCOMPATIVEL');
  }
  if (ambiente === 'PRODUCAO' && !secretStoreProducaoDisponivel()) {
    motivos.push('SECRET_STORE_PRODUCAO_AUSENTE');
  } else if (ambiente === 'PRODUCAO' && !derivarChave()) {
    motivos.push('SECRET_STORE_PRODUCAO_AUSENTE');
  }
  if (params.consentimento_status && params.consentimento_status !== 'AUTORIZADO') {
    motivos.push('CONSENTIMENTO_NAO_AUTORIZADO');
  }

  const ok = motivos.length === 0;
  return {
    ok,
    pode_operar: ok,
    operacao_assistida: false,
    producao_controlada: false,
    mensagem: ok ? null : MSG_BLOQUEIO_OPERACAO_REAL,
    instituicao: INSTITUICAO_OFICIAL,
    documentacao_oficial: DOCUMENTACAO_OFICIAL_URL,
    produto: PRODUTO_OPEN_FINANCE_OFICIAL,
    oauth_oficial: OAUTH_OFICIAL,
    certificado_oficial_exigido: CERTIFICADO_OFICIAL_EXIGIDO,
    secret_store_producao: secretStoreProducaoDisponivel(),
    feature_flag: featureFlagLigada(env),
    ambiente: ambiente,
    motivos
  };
}

function exigirOperacaoReal(params = {}) {
  const out = providerRealPodeOperar(params);
  if (!out.ok) {
    const err = erroMbc(ERROS.PROVIDER_NAO_EXECUTAVEL, MSG_BLOQUEIO_OPERACAO_REAL, 409);
    err.motivos = out.motivos;
    throw err;
  }
  return out;
}

module.exports = {
  MSG_BLOQUEIO_OPERACAO_REAL,
  MSG_AMBIENTE_INCOMPATIVEL,
  INSTITUICAO_OFICIAL,
  DOCUMENTACAO_OFICIAL_URL,
  PRODUTO_OPEN_FINANCE_OFICIAL,
  OAUTH_OFICIAL,
  CERTIFICADO_OFICIAL_EXIGIDO,
  secretStoreProducaoDisponivel,
  featureFlagLigada,
  ambienteEndpointValido,
  providerRealPodeOperar,
  exigirOperacaoReal
};
