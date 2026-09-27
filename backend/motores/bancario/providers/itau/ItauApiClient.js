/**
 * Cliente HTTP Itaú (GET autenticado + mTLS).
 * Nunca loga Authorization, token, certificado ou private key.
 * Sempre rejectUnauthorized: true.
 * @module motores/bancario/providers/itau/ItauApiClient
 */
'use strict';

const https = require('https');
const { URL } = require('url');
const { ERROS, erroMbc, CATEGORIA_ERRO_PROVIDER } = require('../../contracts/constantes');
const { criarAgentMtls, classificarErroRede } = require('./ItauOAuthClient');
const { resolverFetchImplMbc } = require('../mercadopago/resolverFetchImplMbc');
const { endpointsParaAmbiente, montarUrlRecurso } = require('./ItauConstants');

function httpsGetJson(urlStr, init = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(String(urlStr));
    } catch (err) {
      reject(err);
      return;
    }
    const headers = Object.assign({}, init.headers || {});
    const req = https.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: 'GET',
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
    const timeoutMs = init.timeoutMs != null ? Number(init.timeoutMs) : 20000;
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      const err = new Error('Timeout na chamada Itaú');
      err.name = 'AbortError';
      err.errorCode = 'TIMEOUT';
      reject(err);
    });
    req.on('error', reject);
    req.end();
  });
}

class ItauApiClient {
  constructor(deps = {}) {
    this.env = deps.env || process.env;
    this.fetchImpl = resolverFetchImplMbc(deps.fetchImpl);
    this.timeoutMs = deps.timeoutMs != null ? Number(deps.timeoutMs) : 20000;
  }

  _montarAgent(params = {}) {
    const temCert = !!(params.certificate && String(params.certificate).trim());
    const temKey = !!(params.private_key && String(params.private_key).trim());
    if (!temCert || !temKey) return null;
    const ca = params.ca
      || (this.env && (this.env.ITAU_TLS_CA || this.env.ITAU_CA_BUNDLE))
      || null;
    return criarAgentMtls({
      certificate: params.certificate,
      private_key: params.private_key,
      ca: ca || undefined,
      passphrase: params.passphrase || undefined
    });
  }

  async getJson(params = {}) {
    const accessToken = String(params.access_token || '').trim();
    if (!accessToken) {
      const e = erroMbc(ERROS.AUTORIZACAO_INVALIDA, 'Access token Itaú ausente.', 401);
      e.errorCode = 'TOKEN_AUSENTE';
      throw e;
    }

    const endpoints = endpointsParaAmbiente(params.ambiente, this.env);
    const url = params.url
      || montarUrlRecurso(endpoints, params.path_key, {
        account_id: params.account_id,
        agencia: params.agencia,
        conta: params.conta,
        env: this.env,
        query: params.query
      });

    const headers = {
      Accept: 'application/json',
      Authorization: 'Bearer ' + accessToken
    };
    if (params.extraHeaders && typeof params.extraHeaders === 'object') {
      Object.keys(params.extraHeaders).forEach((k) => {
        if (/authorization|cookie|client.secret|private/i.test(k)) return;
        headers[k] = String(params.extraHeaders[k]);
      });
    }

    const agent = this._montarAgent(params);
    const fetchInjetado = typeof params.fetchImpl === 'function';

    let res;
    try {
      if (agent && !fetchInjetado) {
        res = await httpsGetJson(url, { headers, agent, timeoutMs: this.timeoutMs });
      } else {
        const fetchFn = params.fetchImpl || this.fetchImpl;
        if (typeof fetchFn !== 'function') {
          throw erroMbc(ERROS.PROVIDER_NAO_EXECUTAVEL, 'Cliente HTTP Itaú não configurado.', 503);
        }
        const init = { method: 'GET', headers };
        if (agent) init.agent = agent;
        res = await fetchFn(url, init);
      }
    } catch (err) {
      if (err && err.code && err.errorCode) throw err;
      if (err && err.name === 'AbortError') {
        const e = erroMbc(ERROS.PROVIDER_INDISPONIVEL, 'Timeout na chamada Itaú.', 504);
        e.errorCode = 'TIMEOUT';
        e.categoria = CATEGORIA_ERRO_PROVIDER.INDISPONIBILIDADE;
        throw e;
      }
      const cls = classificarErroRede(err);
      const e = erroMbc(ERROS.PROVIDER_INDISPONIVEL, cls.message, 503);
      e.categoria = cls.categoria;
      e.errorCode = cls.errorCode;
      throw e;
    }

    let parsed = null;
    try {
      parsed = typeof res.json === 'function' ? await res.json() : null;
    } catch (_) {
      parsed = null;
    }

    if (!res.ok) {
      const e = erroMbc(
        res.status === 401 || res.status === 403
          ? ERROS.AUTORIZACAO_INVALIDA
          : ERROS.PROVIDER_INDISPONIVEL,
        'Chamada Itaú rejeitada.',
        res.status >= 400 ? res.status : 502
      );
      e.errorCode = parsed && (parsed.error || parsed.codigo)
        ? String(parsed.error || parsed.codigo).slice(0, 80)
        : (res.status === 401 || res.status === 403 ? 'AUTH_FALHA' : 'PROVIDER_HTTP_ERRO');
      e.categoria = res.status === 401 || res.status === 403
        ? CATEGORIA_ERRO_PROVIDER.AUTENTICACAO
        : CATEGORIA_ERRO_PROVIDER.INDISPONIBILIDADE;
      throw e;
    }

    if (parsed == null) {
      const e = erroMbc(ERROS.DTO_INVALIDO, 'Resposta Itaú inválida ou vazia.', 502);
      e.errorCode = 'RESPOSTA_INVALIDA';
      e.categoria = CATEGORIA_ERRO_PROVIDER.DADOS_INVALIDOS;
      throw e;
    }
    return parsed;
  }
}

module.exports = {
  ItauApiClient,
  httpsGetJson
};
