/**
 * Cliente HTTP do adapter. Sem endpoint de instituição versionado.
 * Sem oficialHabilitado: recusa rede. Timeout obrigatório.
 * @module motores/bancario/providers/openfinance-real/OpenFinanceRealClient
 */
'use strict';

const {
  ERROS,
  erroMbc,
  CATEGORIA_ERRO_PROVIDER,
  classificarErroProvider
} = require('../../contracts/constantes');
const { registrarOperacaoMbc } = require('../../contracts/observabilidadeMbc');
const { oficialHabilitado, TIMEOUT_MS, MAX_RETRY_SEGURO } = require('./OpenFinanceRealConstants');
const { resolverEndpoints, validarSeparacaoAmbiente } = require('./ambienteEndpoints');
const { retrySeguro } = require('./retrySeguro');

function categorizarHttp(status, message) {
  if (status === 401) return CATEGORIA_ERRO_PROVIDER.AUTENTICACAO;
  if (status === 403) return CATEGORIA_ERRO_PROVIDER.AUTORIZACAO;
  if (status === 429) return CATEGORIA_ERRO_PROVIDER.RATE_LIMIT;
  if (status === 408 || status === 504) return CATEGORIA_ERRO_PROVIDER.TIMEOUT;
  if (status === 502 || status === 503) return CATEGORIA_ERRO_PROVIDER.INDISPONIBILIDADE;
  if (status >= 400 && status < 500) return CATEGORIA_ERRO_PROVIDER.DADOS_INVALIDOS;
  return classificarErroProvider({ message, statusCode: status });
}

class OpenFinanceRealClient {
  constructor(deps = {}) {
    this.fetchImpl = deps.fetchImpl || null;
    this.timeoutMs = deps.timeoutMs != null ? Number(deps.timeoutMs) : TIMEOUT_MS;
    this.transport = deps.transport || null;
    this.env = deps.env || process.env;
    this.ambiente = deps.ambiente || null;
  }

  endpoints() {
    return resolverEndpoints(this.ambiente, this.env);
  }

  exigirOficial() {
    if (this.transport) return true;
    if (!oficialHabilitado(this.env, this.ambiente)) {
      const err = erroMbc(
        ERROS.PROVIDER_NAO_EXECUTAVEL,
        'Provider Open Finance real preparado, mas instituição, documentação oficial e credenciais não estão disponíveis neste ambiente.',
        503
      );
      err.categoria = CATEGORIA_ERRO_PROVIDER.INDISPONIBILIDADE;
      throw err;
    }
    return true;
  }

  async request(params = {}) {
    this.exigirOficial();
    if (!this.transport) {
      validarSeparacaoAmbiente(this.ambiente, this.endpoints());
    }
    if (this.transport) {
      return this.transport.request(params);
    }
    const fetchFn = this.fetchImpl;
    if (typeof fetchFn !== 'function') {
      const err = erroMbc(
        ERROS.PROVIDER_NAO_EXECUTAVEL,
        'Cliente HTTP do provider real não configurado.',
        503
      );
      err.categoria = CATEGORIA_ERRO_PROVIDER.INDISPONIBILIDADE;
      throw err;
    }
    const inicio = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetchFn(params.url, {
        method: params.method || 'GET',
        headers: params.headers || {},
        body: params.body,
        signal: ctrl.signal
      });
      registrarOperacaoMbc({
        operacao: params.operacao || 'http',
        provider: 'OPEN_FINANCE_REAL',
        status: res.status,
        duracao_ms: Date.now() - inicio
      });
      if (!res.ok) {
        const err = erroMbc(ERROS.PROVIDER_INDISPONIVEL, 'Falha na comunicação com o provider.', res.status);
        err.categoria = categorizarHttp(res.status);
        if (err.categoria === CATEGORIA_ERRO_PROVIDER.RATE_LIMIT) err.code = ERROS.PROVIDER_RATE_LIMIT;
        if (err.categoria === CATEGORIA_ERRO_PROVIDER.TIMEOUT) err.code = ERROS.PROVIDER_TIMEOUT;
        throw err;
      }
      return res.json ? res.json() : res;
    } catch (err) {
      if (err.name === 'AbortError' || /aborted|timeout/i.test(String(err.message || ''))) {
        const t = erroMbc(ERROS.PROVIDER_TIMEOUT, 'Timeout na comunicação com o provider.', 504);
        t.categoria = CATEGORIA_ERRO_PROVIDER.TIMEOUT;
        throw t;
      }
      err.categoria = err.categoria || classificarErroProvider(err);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async getComRetry(params) {
    return retrySeguro(() => this.request({ ...params, method: 'GET' }), {
      max: MAX_RETRY_SEGURO,
      esperarMs: 0
    });
  }
}

module.exports = { OpenFinanceRealClient, categorizarHttp };
