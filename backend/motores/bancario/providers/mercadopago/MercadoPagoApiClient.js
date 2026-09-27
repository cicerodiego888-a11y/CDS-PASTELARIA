/**
 * Cliente HTTP Mercado Pago (API oficial api.mercadopago.com).
 * Somente leitura/rede. Sem SQLite, sem persistência, sem frontend.
 * Autenticação: Authorization Bearer <access_token>
 * @module motores/bancario/providers/mercadopago/MercadoPagoApiClient
 */
'use strict';

const {
  ERROS,
  erroMbc,
  CATEGORIA_ERRO_PROVIDER,
  classificarErroProvider
} = require('../../contracts/constantes');
const { registrarOperacaoMbc } = require('../../contracts/observabilidadeMbc');
const { resolverFetchImplMbc } = require('./resolverFetchImplMbc');

const API_BASE = 'https://api.mercadopago.com';
const TIMEOUT_MS = 15000;

function categorizarHttp(status) {
  if (status === 401) return CATEGORIA_ERRO_PROVIDER.AUTENTICACAO;
  if (status === 403) return CATEGORIA_ERRO_PROVIDER.AUTORIZACAO;
  if (status === 404) return CATEGORIA_ERRO_PROVIDER.DADOS_INVALIDOS;
  if (status === 409) return CATEGORIA_ERRO_PROVIDER.DADOS_INVALIDOS;
  if (status === 429) return CATEGORIA_ERRO_PROVIDER.RATE_LIMIT;
  if (status === 408 || status === 504) return CATEGORIA_ERRO_PROVIDER.TIMEOUT;
  if (status >= 500) return CATEGORIA_ERRO_PROVIDER.INDISPONIBILIDADE;
  if (status >= 400) return CATEGORIA_ERRO_PROVIDER.DADOS_INVALIDOS;
  return CATEGORIA_ERRO_PROVIDER.ERRO_INTERNO;
}

function extrairMensagemProvider(body) {
  if (!body || typeof body !== 'object') return null;
  const msg = body.message || body.error || body.error_description;
  if (msg == null || !String(msg).trim()) return null;
  return String(msg).trim().split('\n')[0].slice(0, 200);
}

function mensagemHttp(status, body) {
  if (status === 401) return 'Autenticação rejeitada pelo provider.';
  if (status === 403) return 'Acesso não autorizado ao recurso do provider.';
  if (status === 404) return 'Recurso não encontrado no provider.';
  if (status === 429) return 'O serviço está temporariamente limitando novas tentativas.';
  if (status >= 500) return 'Provider temporariamente indisponível.';
  if (status === 400 || status === 409 || status === 422) {
    return extrairMensagemProvider(body) || 'Requisição rejeitada pelo provider.';
  }
  return extrairMensagemProvider(body) || 'Falha na comunicação com o provider.';
}

class MercadoPagoApiClient {
  constructor(deps = {}) {
    this.fetchImpl = resolverFetchImplMbc(deps.fetchImpl);
    this.timeoutMs = deps.timeoutMs != null ? Number(deps.timeoutMs) : TIMEOUT_MS;
    this.apiBase = deps.apiBase || API_BASE;
  }

  async request(params = {}) {
    const fetchFn = params.fetchImpl || this.fetchImpl;
    if (typeof fetchFn !== 'function') {
      throw erroMbc(ERROS.PROVIDER_NAO_EXECUTAVEL, 'Cliente HTTP Mercado Pago não configurado.', 503);
    }
    const token = params.accessToken || params.access_token;
    if (!token) {
      throw erroMbc(ERROS.AUTORIZACAO_INVALIDA, 'Conta não autorizada para integração bancária.', 409);
    }

    const method = String(params.method || 'GET').toUpperCase();
    const path = String(params.path || '');
    const url = path.startsWith('http') ? path : (this.apiBase + path);
    const headers = Object.assign({
      Accept: 'application/json',
      Authorization: 'Bearer ' + String(token)
    }, params.headers || {});
    if (params.body != null && !headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json';
    }

    const inicio = Date.now();
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => { if (ctrl) ctrl.abort(); }, this.timeoutMs);
    try {
      const res = await fetchFn(url, {
        method,
        headers,
        body: params.body == null
          ? undefined
          : (typeof params.body === 'string' ? params.body : JSON.stringify(params.body)),
        signal: ctrl ? ctrl.signal : undefined
      });
      registrarOperacaoMbc({
        operacao: params.operacao || 'mercado-pago-http',
        provider: 'MERCADO_PAGO',
        status: res.status,
        duracao_ms: Date.now() - inicio
      });

      const retryAfter = res.headers && typeof res.headers.get === 'function'
        ? res.headers.get('retry-after')
        : null;

      let parsed = null;
      const asText = params.responseType === 'text' || params.responseType === 'csv';
      if (asText) {
        parsed = typeof res.text === 'function' ? await res.text() : '';
      } else if (typeof res.json === 'function') {
        try { parsed = await res.json(); } catch (_) { parsed = null; }
      }

      if (!res.ok) {
        const err = erroMbc(
          res.status === 429 ? ERROS.PROVIDER_RATE_LIMIT : ERROS.PROVIDER_INDISPONIVEL,
          mensagemHttp(res.status, parsed),
          res.status
        );
        err.categoria = categorizarHttp(res.status);
        if (retryAfter) err.retry_after = String(retryAfter);
        throw err;
      }

      return {
        status: res.status,
        body: parsed,
        retry_after: retryAfter
      };
    } catch (err) {
      if (err.name === 'AbortError' || /aborted|timeout/i.test(String(err.message || ''))) {
        const t = erroMbc(ERROS.PROVIDER_TIMEOUT, 'Timeout na comunicação com o provider.', 504);
        t.categoria = CATEGORIA_ERRO_PROVIDER.TIMEOUT;
        throw t;
      }
      if (err.code && err.categoria) throw err;
      err.categoria = err.categoria || classificarErroProvider(err);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  getConfig(accessToken) {
    return this.request({
      operacao: 'settlement-report-config-get',
      method: 'GET',
      path: '/v1/account/settlement_report/config',
      accessToken
    });
  }

  putConfig(accessToken, body) {
    return this.request({
      operacao: 'settlement-report-config-put',
      method: 'PUT',
      path: '/v1/account/settlement_report/config',
      accessToken,
      body
    });
  }

  postConfig(accessToken, body) {
    return this.request({
      operacao: 'settlement-report-config-post',
      method: 'POST',
      path: '/v1/account/settlement_report/config',
      accessToken,
      body
    });
  }

  criarRelatorio(accessToken, beginDate, endDate) {
    return this.request({
      operacao: 'settlement-report-create',
      method: 'POST',
      path: '/v1/account/settlement_report',
      accessToken,
      body: {
        begin_date: beginDate,
        end_date: endDate
      }
    });
  }

  listarRelatorios(accessToken) {
    return this.request({
      operacao: 'settlement-report-list',
      method: 'GET',
      path: '/v1/account/settlement_report/list',
      accessToken
    });
  }

  baixarRelatorio(accessToken, fileName) {
    const nome = encodeURIComponent(String(fileName || '').replace(/^\/+/, ''));
    return this.request({
      operacao: 'settlement-report-download',
      method: 'GET',
      path: '/v1/account/settlement_report/' + nome,
      accessToken,
      responseType: 'csv',
      headers: { Accept: 'text/csv, application/json, */*' }
    });
  }
}

module.exports = {
  API_BASE,
  TIMEOUT_MS,
  MercadoPagoApiClient,
  categorizarHttp
};
