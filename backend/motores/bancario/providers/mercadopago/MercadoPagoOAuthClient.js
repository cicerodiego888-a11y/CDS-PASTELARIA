/**
 * Cliente OAuth Mercado Pago — contrato oficial.
 * Auth: https://auth.mercadopago.com/authorization
 * Token: POST https://api.mercadopago.com/oauth/token
 * Fonte: docs Mercado Pago Developers (Authorization Code + PKCE).
 * @module motores/bancario/providers/mercadopago/MercadoPagoOAuthClient
 */
'use strict';

const {
  ERROS,
  erroMbc,
  CATEGORIA_ERRO_PROVIDER
} = require('../../contracts/constantes');
const { registrarOperacaoMbc } = require('../../contracts/observabilidadeMbc');
const { resolverFetchImplMbc } = require('./resolverFetchImplMbc');

const AUTH_BASE = 'https://auth.mercadopago.com/authorization';
const TOKEN_URL = 'https://api.mercadopago.com/oauth/token';
const TIMEOUT_MS = 15000;
/** Margem de segurança antes de expires_at (segundos). */
const MARGEM_EXPIRACAO_S = 60;

const MSG_USUARIO = Object.freeze({
  invalid_client: 'Não foi possível autenticar a aplicação. Verifique as credenciais do provider.',
  invalid_grant: 'A autorização expirou ou já foi utilizada. Inicie novamente.',
  invalid_scope: 'Escopo de autorização inválido para esta aplicação.',
  invalid_request: 'Não foi possível concluir a autorização. Tente novamente.',
  unauthorized_client: 'A aplicação não tem permissão para esta autorização.',
  forbidden: 'Acesso não autorizado pelo provider.',
  local_rate_limited: 'O serviço está temporariamente limitando novas tentativas. Tente novamente em instantes.',
  '429': 'O serviço está temporariamente limitando novas tentativas. Tente novamente em instantes.',
  padrao: 'Não foi possível concluir a autorização.'
});

function montarAuthorizationUrl(params = {}) {
  const q = new URLSearchParams();
  q.set('response_type', 'code');
  q.set('client_id', String(params.client_id || ''));
  q.set('redirect_uri', String(params.redirect_uri || ''));
  q.set('state', String(params.state || ''));
  q.set('platform_id', 'mp');
  if (params.code_challenge) {
    q.set('code_challenge', String(params.code_challenge));
    q.set('code_challenge_method', String(params.code_challenge_method || 'S256'));
  }
  return AUTH_BASE + '?' + q.toString();
}

function mapearErroOauth(body, statusHttp) {
  const code = String((body && (body.error || body.message)) || '').trim();
  const key = statusHttp === 429 ? '429' : code;
  const mensagem = MSG_USUARIO[key] || MSG_USUARIO.padrao;
  const err = erroMbc(ERROS.AUTORIZACAO_INVALIDA, mensagem, statusHttp >= 400 ? statusHttp : 400);
  err.categoria = statusHttp === 429
    ? CATEGORIA_ERRO_PROVIDER.RATE_LIMIT
    : CATEGORIA_ERRO_PROVIDER.AUTENTICACAO;
  err.oauth_error = code || null;
  if (statusHttp === 429) err.code = ERROS.PROVIDER_RATE_LIMIT;
  return err;
}

function calcularExpiresAt(expiresIn, agoraMs = Date.now()) {
  const seg = Number(expiresIn);
  if (!Number.isFinite(seg) || seg <= 0) return null;
  const efetivo = Math.max(0, seg - MARGEM_EXPIRACAO_S);
  return new Date(agoraMs + efetivo * 1000).toISOString();
}

function normalizarRespostaToken(bruto, agoraMs = Date.now()) {
  if (!bruto || !bruto.access_token) {
    throw erroMbc(ERROS.AUTORIZACAO_INVALIDA, MSG_USUARIO.padrao, 502);
  }
  return {
    access_token: String(bruto.access_token),
    refresh_token: bruto.refresh_token != null ? String(bruto.refresh_token) : null,
    token_type: bruto.token_type != null ? String(bruto.token_type) : null,
    scope: bruto.scope != null ? String(bruto.scope) : null,
    user_id: bruto.user_id != null ? bruto.user_id : null,
    live_mode: typeof bruto.live_mode === 'boolean' ? bruto.live_mode : null,
    expires_in: bruto.expires_in != null ? Number(bruto.expires_in) : null,
    expires_at: calcularExpiresAt(bruto.expires_in, agoraMs),
    public_key: undefined
  };
}

class MercadoPagoOAuthClient {
  constructor(deps = {}) {
    this.fetchImpl = resolverFetchImplMbc(deps.fetchImpl);
    this.timeoutMs = deps.timeoutMs != null ? Number(deps.timeoutMs) : TIMEOUT_MS;
    this.tokenUrl = deps.tokenUrl || TOKEN_URL;
  }

  async trocarAuthorizationCode(params = {}) {
    const fetchFn = params.fetchImpl || this.fetchImpl;
    if (typeof fetchFn !== 'function') {
      throw erroMbc(ERROS.PROVIDER_NAO_EXECUTAVEL, 'Cliente HTTP OAuth não configurado.', 503);
    }
    const body = {
      client_id: String(params.client_id || ''),
      client_secret: String(params.client_secret || ''),
      grant_type: 'authorization_code',
      code: String(params.code || ''),
      redirect_uri: String(params.redirect_uri || '')
    };
    if (params.code_verifier) {
      body.code_verifier = String(params.code_verifier);
    }
    if (params.test_token === true || params.test_token === 'true') {
      body.test_token = 'true';
    }

    const inicio = Date.now();
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => {
      if (ctrl) ctrl.abort();
    }, this.timeoutMs);
    try {
      const res = await fetchFn(this.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl ? ctrl.signal : undefined
      });
      registrarOperacaoMbc({
        operacao: 'mercado-pago-oauth-token',
        provider: 'MERCADO_PAGO',
        status: res.status,
        duracao_ms: Date.now() - inicio
      });
      let json = null;
      try {
        json = typeof res.json === 'function' ? await res.json() : null;
      } catch (_) {
        json = null;
      }
      if (!res.ok) {
        throw mapearErroOauth(json || {}, res.status);
      }
      return normalizarRespostaToken(json, Date.now());
    } catch (err) {
      if (err.name === 'AbortError' || /aborted|timeout/i.test(String(err.message || ''))) {
        const t = erroMbc(ERROS.PROVIDER_TIMEOUT, 'Timeout na comunicação com o provider.', 504);
        t.categoria = CATEGORIA_ERRO_PROVIDER.TIMEOUT;
        throw t;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = {
  AUTH_BASE,
  TOKEN_URL,
  TIMEOUT_MS,
  MARGEM_EXPIRACAO_S,
  MSG_USUARIO,
  montarAuthorizationUrl,
  calcularExpiresAt,
  normalizarRespostaToken,
  mapearErroOauth,
  MercadoPagoOAuthClient
};
