/**
 * OAuth 2.0 Client Credentials Itaú + cache de token + mTLS (https nativo).
 * Nunca loga access_token / Authorization / private key / certificado.
 * @module motores/bancario/providers/itau/ItauOAuthClient
 */
'use strict';

const https = require('https');
const { URL } = require('url');
const { ERROS, erroMbc, CATEGORIA_ERRO_PROVIDER } = require('../../contracts/constantes');
const { resolverFetchImplMbc } = require('../mercadopago/resolverFetchImplMbc');
const {
  TOKEN_TTL_PADRAO_S,
  TOKEN_MARGEM_S,
  endpointsParaAmbiente
} = require('./ItauConstants');
const { validarMaterialTls } = require('./ItauCertificadoUtil');

/** Cache em memória: chave = ambiente|clientId → { access_token, expires_at_ms } */
const tokenCache = new Map();

function cacheKey(ambiente, clientId) {
  return String(ambiente || '').toUpperCase() + '|' + String(clientId || '').trim();
}

function limparCacheToken() {
  tokenCache.clear();
}

function tokenValido(entrada, agoraMs = Date.now()) {
  if (!entrada || !entrada.access_token || !entrada.expires_at_ms) return false;
  return entrada.expires_at_ms - (TOKEN_MARGEM_S * 1000) > agoraMs;
}

/**
 * Agent mTLS. Sempre com validação TLS (rejectUnauthorized: true).
 * CA opcional via params.ca ou env.
 */
function criarAgentMtls(params = {}) {
  const cert = params.certificate || params.cert;
  const key = params.private_key || params.key;
  if (!cert || !key) return null;
  const opts = {
    cert: String(cert),
    key: String(key),
    rejectUnauthorized: true
  };
  if (params.ca) opts.ca = String(params.ca);
  if (params.passphrase) opts.passphrase = String(params.passphrase);
  return new https.Agent(opts);
}

function classificarErroRede(err) {
  const code = err && err.code ? String(err.code) : '';
  const msg = String((err && err.message) || '');
  if (
    /CERT|TLS|SSL|UNABLE_TO_VERIFY|SELF_SIGNED|EPROTO/i.test(code + ' ' + msg)
    || err && err.name === 'Error' && /certificate|TLS|SSL/i.test(msg)
  ) {
    return {
      errorCode: 'TLS_MTLS_FALHA',
      message: 'Falha de TLS/mTLS na autenticação Itaú.',
      categoria: CATEGORIA_ERRO_PROVIDER.AUTENTICACAO
    };
  }
  return {
    errorCode: 'OAUTH_FALHA',
    message: 'Falha na autenticação com o Itaú.',
    categoria: CATEGORIA_ERRO_PROVIDER.INDISPONIBILIDADE
  };
}

/**
 * POST form-urlencoded via https nativo (suporta agent mTLS).
 * Resposta compatível com fetch: { ok, status, json() }.
 */
function httpsPostForm(urlStr, init = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(String(urlStr));
    } catch (err) {
      reject(err);
      return;
    }
    const body = init.body != null ? String(init.body) : '';
    const headers = Object.assign({}, init.headers || {});
    if (!headers['Content-Length'] && !headers['content-length']) {
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers,
        agent: init.agent || undefined,
        rejectUnauthorized: true
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode || 0,
            async json() {
              if (!raw) return null;
              try { return JSON.parse(raw); } catch (_) { return null; }
            },
            async text() { return raw; }
          });
        });
      }
    );
    const timeoutMs = init.timeoutMs != null ? Number(init.timeoutMs) : 15000;
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      const err = new Error('Timeout na autenticação Itaú');
      err.name = 'AbortError';
      reject(err);
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

class ItauOAuthClient {
  constructor(deps = {}) {
    this.fetchImpl = resolverFetchImplMbc(deps.fetchImpl);
    this.env = deps.env || process.env;
    this.timeoutMs = deps.timeoutMs != null ? Number(deps.timeoutMs) : 15000;
  }

  async obterAccessToken(params = {}) {
    const clientId = String(params.client_id || '').trim();
    const clientSecret = String(params.client_secret || '').trim();
    if (!clientId) {
      const e = erroMbc(ERROS.CREDENCIAL_CLIENT_ID_OBRIGATORIO, 'Client ID Itaú é obrigatório.', 400);
      e.errorCode = 'CLIENT_ID_AUSENTE';
      throw e;
    }
    if (!clientSecret) {
      const e = erroMbc(ERROS.CREDENCIAL_SECRET_OBRIGATORIO, 'Client Secret Itaú é obrigatório.', 400);
      e.errorCode = 'CLIENT_SECRET_AUSENTE';
      throw e;
    }

    const endpoints = endpointsParaAmbiente(params.ambiente, this.env);
    const ck = cacheKey(endpoints.ambiente_chave, clientId);
    const cached = tokenCache.get(ck);
    if (tokenValido(cached) && params.forcarRefresh !== true) {
      return {
        access_token: cached.access_token,
        expires_in: Math.max(0, Math.floor((cached.expires_at_ms - Date.now()) / 1000)),
        token_type: cached.token_type || 'Bearer',
        from_cache: true,
        ambiente: endpoints.ambiente_chave,
        exige_mtls: endpoints.exige_mtls,
        authentication: 'OAUTH2_CLIENT_CREDENTIALS'
      };
    }

    const temCert = !!(params.certificate && String(params.certificate).trim());
    const temKey = !!(params.private_key && String(params.private_key).trim());
    const usarMtls = endpoints.exige_mtls === true || (temCert && temKey);

    if (endpoints.exige_mtls && (!temCert || !temKey)) {
      const e = erroMbc(
        ERROS.CREDENCIAL_SECRET_OBRIGATORIO,
        !temCert
          ? 'Produção Itaú exige certificado cliente (mTLS).'
          : 'Produção Itaú exige private key (mTLS).',
        409
      );
      e.errorCode = !temCert ? 'CERTIFICADO_AUSENTE' : 'PRIVATE_KEY_AUSENTE';
      throw e;
    }

    let agent = null;
    if (usarMtls) {
      const val = validarMaterialTls({
        certificate: params.certificate,
        private_key: params.private_key,
        exigir: true
      });
      if (!val.ok) {
        const e = erroMbc(ERROS.CREDENCIAL_SECRET_OBRIGATORIO, val.message, 409);
        e.errorCode = val.errorCode;
        throw e;
      }
      const ca = params.ca
        || (this.env && (this.env.ITAU_TLS_CA || this.env.ITAU_CA_BUNDLE))
        || null;
      agent = criarAgentMtls({
        certificate: params.certificate,
        private_key: params.private_key,
        ca: ca || undefined,
        passphrase: params.passphrase || undefined
      });
    }

    const body = new URLSearchParams();
    body.set('grant_type', 'client_credentials');
    body.set('client_id', clientId);
    body.set('client_secret', clientSecret);
    if (params.scope) body.set('scope', String(params.scope));

    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    };

    const fetchInjetado = typeof params.fetchImpl === 'function';
    let res;
    try {
      if (agent && !fetchInjetado) {
        // undici/global fetch não aplica agent mTLS de forma confiável — https nativo.
        res = await httpsPostForm(endpoints.token_url, {
          headers,
          body: body.toString(),
          agent,
          timeoutMs: this.timeoutMs
        });
      } else {
        const fetchFn = params.fetchImpl || this.fetchImpl;
        if (typeof fetchFn !== 'function') {
          throw erroMbc(ERROS.PROVIDER_NAO_EXECUTAVEL, 'Cliente HTTP Itaú não configurado.', 503);
        }
        const init = { method: 'POST', headers, body: body.toString() };
        if (agent) init.agent = agent;
        res = await fetchFn(endpoints.token_url, init);
      }
    } catch (err) {
      if (err && err.code && err.errorCode) throw err;
      const cls = classificarErroRede(err);
      const e = erroMbc(ERROS.PROVIDER_INDISPONIVEL, cls.message, 503);
      e.categoria = cls.categoria;
      e.errorCode = cls.errorCode;
      e.cause_code = err && err.code ? String(err.code) : null;
      throw e;
    }

    let parsed = null;
    try {
      parsed = typeof res.json === 'function' ? await res.json() : null;
    } catch (_) {
      parsed = null;
    }

    if (!res.ok) {
      const err = erroMbc(
        res.status === 401 || res.status === 403
          ? ERROS.AUTORIZACAO_INVALIDA
          : ERROS.PROVIDER_INDISPONIVEL,
        'Autenticação OAuth Itaú rejeitada.',
        res.status >= 400 ? res.status : 502
      );
      err.categoria = res.status === 401 || res.status === 403
        ? CATEGORIA_ERRO_PROVIDER.AUTENTICACAO
        : CATEGORIA_ERRO_PROVIDER.INDISPONIBILIDADE;
      err.errorCode = parsed && (parsed.error || parsed.codigo)
        ? String(parsed.error || parsed.codigo).slice(0, 80)
        : 'OAUTH_FALHA';
      throw err;
    }

    const accessToken = parsed && parsed.access_token ? String(parsed.access_token) : '';
    if (!accessToken) {
      const e = erroMbc(ERROS.AUTORIZACAO_INVALIDA, 'Resposta de autenticação Itaú sem access_token.', 502);
      e.errorCode = 'OAUTH_FALHA';
      throw e;
    }
    const expiresIn = parsed.expires_in != null
      ? Number(parsed.expires_in)
      : TOKEN_TTL_PADRAO_S;
    const ttl = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : TOKEN_TTL_PADRAO_S;
    const entrada = {
      access_token: accessToken,
      expires_at_ms: Date.now() + (ttl * 1000),
      token_type: parsed.token_type || 'Bearer'
    };
    tokenCache.set(ck, entrada);

    return {
      access_token: accessToken,
      expires_in: ttl,
      token_type: entrada.token_type,
      from_cache: false,
      ambiente: endpoints.ambiente_chave,
      exige_mtls: endpoints.exige_mtls,
      mtls_usado: !!agent,
      authentication: 'OAUTH2_CLIENT_CREDENTIALS'
    };
  }
}

module.exports = {
  ItauOAuthClient,
  limparCacheToken,
  tokenValido,
  cacheKey,
  criarAgentMtls,
  httpsPostForm,
  classificarErroRede
};
