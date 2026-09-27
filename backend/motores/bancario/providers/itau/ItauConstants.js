/**
 * Constantes e endpoints Itaú (MBC-ITAU-01 / 02).
 * URLs centralizadas — não hardcodar espalhado.
 * Paths de saldo/extrato: configuráveis (portal ainda não confirmado neste repo).
 * @module motores/bancario/providers/itau/ItauConstants
 */
'use strict';

const { CODIGO_PROVIDER, AMBIENTE_INTEGRACAO, ERROS, erroMbc } = require('../../contracts/constantes');

const CODIGO = CODIGO_PROVIDER.ITAU;
const NOME = 'Itaú';
const STATUS_ADAPTER = 'OPERACIONAL_PREPARADO';
const EXTERNAL_SOURCE = 'ITAU';

/**
 * Endpoints oficiais / configuráveis por ambiente.
 * Produção: OAuth + mTLS. Sandbox: comportamento distinto.
 * Override via env: ITAU_TOKEN_URL_*, ITAU_API_BASE_*,
 * ITAU_PATH_SALDO, ITAU_PATH_EXTRATO, ITAU_SALDO_URL, ITAU_EXTRATO_URL.
 *
 * Paths de produto (saldo/extrato) NÃO têm default inventado —
 * devem ser definidos via env ou parâmetro explícito após confirmação no portal.
 */
const ITAU_ENDPOINTS = Object.freeze({
  SANDBOX: Object.freeze({
    token_url: 'https://sandbox.devportal.itau.com.br/api/oauth/jwt',
    api_base: 'https://sandbox.devportal.itau.com.br'
  }),
  HOMOLOGACAO: Object.freeze({
    token_url: 'https://sandbox.devportal.itau.com.br/api/oauth/jwt',
    api_base: 'https://sandbox.devportal.itau.com.br'
  }),
  PRODUCAO: Object.freeze({
    token_url: 'https://sts.itau.com.br/api/oauth/token',
    api_base: 'https://api.itau.com.br'
  })
});

const TOKEN_TTL_PADRAO_S = 300;
const TOKEN_MARGEM_S = 30;

function resolverAmbienteItau(ambiente) {
  const a = String(ambiente || '').toUpperCase();
  if (a === AMBIENTE_INTEGRACAO.PRODUCAO) return 'PRODUCAO';
  if (a === AMBIENTE_INTEGRACAO.HOMOLOGACAO) return 'HOMOLOGACAO';
  return 'SANDBOX';
}

function endpointsParaAmbiente(ambiente, env = process.env) {
  const chave = resolverAmbienteItau(ambiente);
  const base = ITAU_ENDPOINTS[chave] || ITAU_ENDPOINTS.SANDBOX;
  if (chave === 'PRODUCAO') {
    return {
      token_url: String(env.ITAU_TOKEN_URL_PRODUCAO || base.token_url).trim(),
      api_base: String(env.ITAU_API_BASE_PRODUCAO || base.api_base).trim(),
      exige_mtls: true,
      ambiente_chave: chave,
      path_saldo: String(env.ITAU_PATH_SALDO || '').trim(),
      path_extrato: String(env.ITAU_PATH_EXTRATO || '').trim(),
      saldo_url: String(env.ITAU_SALDO_URL || '').trim() || null,
      extrato_url: String(env.ITAU_EXTRATO_URL || '').trim() || null
    };
  }
  return {
    token_url: String(env.ITAU_TOKEN_URL_SANDBOX || base.token_url).trim(),
    api_base: String(env.ITAU_API_BASE_SANDBOX || base.api_base).trim(),
    exige_mtls: false,
    ambiente_chave: chave,
    path_saldo: String(env.ITAU_PATH_SALDO || '').trim(),
    path_extrato: String(env.ITAU_PATH_EXTRATO || '').trim(),
    saldo_url: String(env.ITAU_SALDO_URL || '').trim() || null,
    extrato_url: String(env.ITAU_EXTRATO_URL || '').trim() || null
  };
}

function substituirPlaceholders(tpl, vars = {}) {
  return String(tpl).replace(/\{([a-zA-Z0-9_]+)\}/g, (_, k) => {
    const v = vars[k];
    return v != null && String(v).trim() !== '' ? encodeURIComponent(String(v).trim()) : '';
  });
}

/**
 * Monta URL de recurso. Não inventa path de produto.
 * path_key: 'saldo' | 'extrato'
 */
function montarUrlRecurso(endpoints, pathKey, vars = {}) {
  const key = String(pathKey || '').toLowerCase();
  const env = vars.env || process.env;
  let fullOverride = null;
  let pathTpl = '';
  if (key === 'saldo') {
    fullOverride = vars.url || endpoints.saldo_url || (env && env.ITAU_SALDO_URL) || null;
    pathTpl = vars.path || endpoints.path_saldo || (env && env.ITAU_PATH_SALDO) || '';
  } else if (key === 'extrato') {
    fullOverride = vars.url || endpoints.extrato_url || (env && env.ITAU_EXTRATO_URL) || null;
    pathTpl = vars.path || endpoints.path_extrato || (env && env.ITAU_PATH_EXTRATO) || '';
  } else {
    pathTpl = vars.path || '';
  }

  if (fullOverride && String(fullOverride).trim()) {
    let u = String(fullOverride).trim();
    u = substituirPlaceholders(u, vars);
    if (vars.query && typeof vars.query === 'object') {
      const q = new URLSearchParams();
      Object.keys(vars.query).forEach((k) => {
        if (vars.query[k] != null && String(vars.query[k]) !== '') q.set(k, String(vars.query[k]));
      });
      const qs = q.toString();
      if (qs) u += (u.includes('?') ? '&' : '?') + qs;
    }
    return u;
  }

  const path = String(pathTpl || '').trim();
  if (!path) {
    const operacao = key === 'saldo' ? 'SALDO' : (key === 'extrato' ? 'EXTRATO' : String(key || 'RECURSO').toUpperCase());
    const e = erroMbc(
      ERROS.PROVIDER_NAO_EXECUTAVEL,
      'Endpoint Itaú não configurado para operação ' + operacao
        + '. Defina ITAU_PATH_' + operacao + ' ou ITAU_' + operacao
        + '_URL conforme o portal oficial (sem inventar path). E2E real permanece bloqueado até o portal liberar credenciais, certificado e paths.',
      503
    );
    e.errorCode = 'ENDPOINT_NAO_CONFIGURADO';
    e.operacao = operacao;
    throw e;
  }

  const base = String(endpoints.api_base || '').replace(/\/$/, '');
  let rel = substituirPlaceholders(path, vars);
  if (!rel.startsWith('/')) rel = '/' + rel;
  let u = /^https?:\/\//i.test(rel) ? rel : (base + rel);
  if (vars.query && typeof vars.query === 'object') {
    const q = new URLSearchParams();
    Object.keys(vars.query).forEach((k) => {
      if (vars.query[k] != null && String(vars.query[k]) !== '') q.set(k, String(vars.query[k]));
    });
    const qs = q.toString();
    if (qs) u += (u.includes('?') ? '&' : '?') + qs;
  }
  return u;
}

function chaveSecretClient(configId) {
  return 'mbc.config.' + Number(configId);
}

function chaveCertificado(configId) {
  return 'mbc.itau.cert.' + Number(configId);
}

function chavePrivateKey(configId) {
  return 'mbc.itau.key.' + Number(configId);
}

function chaveCa(configId) {
  return 'mbc.itau.ca.' + Number(configId);
}

module.exports = {
  CODIGO,
  NOME,
  STATUS_ADAPTER,
  EXTERNAL_SOURCE,
  ITAU_ENDPOINTS,
  TOKEN_TTL_PADRAO_S,
  TOKEN_MARGEM_S,
  resolverAmbienteItau,
  endpointsParaAmbiente,
  montarUrlRecurso,
  substituirPlaceholders,
  chaveSecretClient,
  chaveCertificado,
  chavePrivateKey,
  chaveCa
};
