/**
 * Adapter IBankProvider para Open Finance real + OAuth Mercado Pago (MBC-15).
 * Saldo/extrato/sync continuam bloqueados sem instituição oficial.
 * OAuth MP usa endpoints oficiais documentados, independente do OF bancário.
 * @module motores/bancario/providers/openfinance-real/OpenFinanceRealBankProvider
 */
'use strict';

const { IBankProvider } = require('../../contracts/IBankProvider');
const {
  ERROS,
  erroMbc,
  STATUS_CONSENTIMENTO,
  CATEGORIA_ERRO_PROVIDER,
  AMBIENTE_INTEGRACAO
} = require('../../contracts/constantes');
const { derivarChave } = require('../../secrets/EncryptedLocalSecretStore');
const {
  CODIGO,
  NOME,
  STATUS_ADAPTER,
  oficialHabilitado,
  chaveTokenConsentimento
} = require('./OpenFinanceRealConstants');
const { OpenFinanceRealClient } = require('./OpenFinanceRealClient');
const { mapearConta, mapearSaldo, mapearPagina } = require('./OpenFinanceRealMapper');
const { providerRealPodeOperar, MSG_BLOQUEIO_OPERACAO_REAL } = require('./prontidaoOperacaoReal');
const { statusRedirectUriOficial } = require('../../../../mercado-pago/redirectUri');
const { gerarPkceS256, persistirVerifier, chaveVerifierConsentimento } = require('../../../../mercado-pago/pkce');
const {
  montarAuthorizationUrl,
  MercadoPagoOAuthClient
} = require('../mercadopago/MercadoPagoOAuthClient');

function chaveOauthMercadoPago(configId) {
  return 'mbc.oauth.mercadopago.' + Number(configId);
}

function chaveSecretConfig(configId) {
  return 'mbc.config.' + Number(configId);
}

async function gravarPayloadOauthLocal(store, configId, payload) {
  await store.set(chaveOauthMercadoPago(configId), JSON.stringify({
    access_token: payload.access_token,
    refresh_token: payload.refresh_token || null,
    expires_at: payload.expires_at || null,
    expires_in: payload.expires_in != null ? payload.expires_in : null,
    token_type: payload.token_type || null,
    scope: payload.scope || null,
    user_id: payload.user_id != null ? payload.user_id : null,
    live_mode: typeof payload.live_mode === 'boolean' ? payload.live_mode : null
  }));
}

class OpenFinanceRealBankProvider extends IBankProvider {
  constructor(deps = {}) {
    super();
    this.client = deps.client || new OpenFinanceRealClient(deps);
    this.secretStore = deps.secretStore || null;
    this.ambiente = deps.ambiente || null;
    this.env = deps.env || process.env;
    this.oauthClient = deps.oauthClient || new MercadoPagoOAuthClient(deps);
    this.fetchImpl = deps.fetchImpl || null;
  }

  get codigo() {
    return CODIGO;
  }

  get nome() {
    return NOME;
  }

  get disponivel() {
    return !!(this.client && this.client.transport) || oficialHabilitado(this.env);
  }

  get suportaAutorizacao() {
    return true;
  }

  get suportaSincronizacao() {
    return true;
  }

  get statusAdapter() {
    return STATUS_ADAPTER;
  }

  _exigirDisponivel() {
    if (this.client && this.client.transport) return;
    const prontidao = providerRealPodeOperar({ env: this.env, ambiente: this.ambiente });
    if (!prontidao.ok || !this.disponivel) {
      const err = erroMbc(ERROS.PROVIDER_NAO_EXECUTAVEL, MSG_BLOQUEIO_OPERACAO_REAL, 409);
      err.categoria = CATEGORIA_ERRO_PROVIDER.INDISPONIBILIDADE;
      err.motivos = prontidao.motivos;
      throw err;
    }
  }

  _exigirCofreSeProducao() {
    if (this.ambiente === 'PRODUCAO' && !derivarChave()) {
      throw erroMbc(
        ERROS.SECRET_KEY_AUSENTE,
        'Ambiente PRODUCAO do provider real exige MBC_SECRET_STORE_KEY. Credenciais reais não serão persistidas sem cofre.',
        503
      );
    }
  }

  _temTransport() {
    return !!(this.client && this.client.transport);
  }

  _podeOAuthMercadoPago(params = {}) {
    const clientId = String(params.clientId || params.client_id || '').trim();
    const redirect = statusRedirectUriOficial(params.env || this.env);
    return !!(clientId && params.configId != null && redirect.status === 'CONFIGURADO' && redirect.uri);
  }

  async conectar() {
    this._exigirDisponivel();
    return { ok: true, modo: 'open-finance-real', status: STATUS_ADAPTER };
  }

  async desconectar() {
    return { ok: true };
  }

  async iniciarAutorizacao(params = {}) {
    const state = String(params.state || '').trim();
    if (!state) {
      throw erroMbc(ERROS.AUTORIZACAO_INVALIDA, 'Autorização inválida.', 400);
    }

    if (this._temTransport()) {
      this._exigirDisponivel();
      const bruto = await this.client.request({
        operacao: 'iniciarAutorizacao',
        method: 'POST',
        recurso: 'autorizacao',
        state
      });
      const url = bruto && bruto.authorization_url ? String(bruto.authorization_url) : '';
      if (!url) {
        throw erroMbc(ERROS.PROVIDER_NAO_EXECUTAVEL, 'Provider não devolveu URL de autorização.', 502);
      }
      return { authorization_url: url };
    }

    if (this._podeOAuthMercadoPago(params)) {
      const redirect = statusRedirectUriOficial(params.env || this.env);
      const store = params.secretStore || this.secretStore;
      const pkce = gerarPkceS256();
      await persistirVerifier(store, params.consentimentoId, pkce.code_verifier);
      const url = montarAuthorizationUrl({
        client_id: String(params.clientId || params.client_id).trim(),
        redirect_uri: redirect.uri,
        state,
        code_challenge: pkce.code_challenge,
        code_challenge_method: pkce.code_challenge_method
      });
      return { authorization_url: url };
    }

    this._exigirDisponivel();
    throw erroMbc(ERROS.PROVIDER_NAO_EXECUTAVEL, MSG_BLOQUEIO_OPERACAO_REAL, 409);
  }

  async processarCallback(params = {}) {
    const query = params.query || {};
    const erro = String(query.error || query.erro || '').toLowerCase();
    const resultado = String(query.resultado || '').toLowerCase();
    if (erro === 'access_denied' || resultado === 'negado' || resultado === 'cancelado') {
      return { status: STATUS_CONSENTIMENTO.NEGADO };
    }

    if (this._temTransport()) {
      this._exigirDisponivel();
      const code = query.code || query.authorization_code;
      if (!code) {
        throw erroMbc(ERROS.AUTORIZACAO_INVALIDA, 'Callback sem código de autorização.', 400);
      }
      this._exigirCofreSeProducao();
      const trocado = await this.client.request({
        operacao: 'trocarCodigo',
        method: 'POST',
        recurso: 'token',
        code: String(code),
        consentimentoId: params.consentimentoId
      });
      const store = params.secretStore || this.secretStore;
      if (store && params.consentimentoId) {
        if (trocado && trocado.access_token) {
          await store.set(chaveTokenConsentimento(params.consentimentoId, 'access_token'), trocado.access_token);
        }
        if (trocado && trocado.refresh_token) {
          await store.set(chaveTokenConsentimento(params.consentimentoId, 'refresh_token'), trocado.refresh_token);
        }
      }
      return {
        status: STATUS_CONSENTIMENTO.AUTORIZADO,
        consentimento_externo_id: (trocado && trocado.consentimento_externo_id) || null
      };
    }

    if (params.configId != null) {
      return this._processarCallbackMercadoPago(params);
    }

    this._exigirDisponivel();
    throw erroMbc(ERROS.PROVIDER_NAO_EXECUTAVEL, MSG_BLOQUEIO_OPERACAO_REAL, 409);
  }

  async _processarCallbackMercadoPago(params = {}) {
    const query = params.query || {};
    const code = query.code || query.authorization_code;
    if (!code) {
      throw erroMbc(ERROS.AUTORIZACAO_INVALIDA, 'Callback sem código de autorização.', 400);
    }
    const store = params.secretStore || this.secretStore;
    if (!store) {
      throw erroMbc(ERROS.AUTORIZACAO_INVALIDA, 'Não foi possível concluir a autorização.', 400);
    }

    const clientId = String(params.clientId || params.client_id || '').trim();
    let clientSecret = params.clientSecret || params.client_secret || null;
    if (!clientSecret) {
      clientSecret = await store.get(chaveSecretConfig(params.configId));
    }
    if (!clientId || !clientSecret) {
      throw erroMbc(ERROS.CREDENCIAL_SECRET_OBRIGATORIO, 'Credenciais do provider indisponíveis.', 409);
    }

    const verifier = await store.get(chaveVerifierConsentimento(params.consentimentoId));
    if (!verifier) {
      throw erroMbc(ERROS.AUTORIZACAO_INVALIDA, 'Não foi possível validar a autorização (PKCE).', 400);
    }

    const redirect = statusRedirectUriOficial(params.env || this.env);
    if (redirect.status !== 'CONFIGURADO' || !redirect.uri) {
      throw erroMbc(ERROS.AUTORIZACAO_INVALIDA, 'Redirect URI oficial não configurado.', 409);
    }

    const ambiente = String(params.ambiente || this.ambiente || '').toUpperCase();
    const testToken = ambiente === AMBIENTE_INTEGRACAO.SANDBOX
      || ambiente === AMBIENTE_INTEGRACAO.HOMOLOGACAO;

    const tokens = await this.oauthClient.trocarAuthorizationCode({
      client_id: clientId,
      client_secret: clientSecret,
      code: String(code),
      redirect_uri: redirect.uri,
      code_verifier: verifier,
      test_token: testToken,
      fetchImpl: params.fetchImpl || this.fetchImpl
    });

    await gravarPayloadOauthLocal(store, params.configId, tokens);
    await store.delete(chaveVerifierConsentimento(params.consentimentoId));

    return {
      status: STATUS_CONSENTIMENTO.AUTORIZADO,
      consentimento_externo_id: tokens.user_id != null ? String(tokens.user_id) : null
    };
  }

  async revogarAutorizacao(params = {}) {
    const store = params.secretStore || this.secretStore;
    if (params.configId != null && store) {
      await store.delete(chaveOauthMercadoPago(params.configId));
      if (params.consentimentoId != null) {
        await store.delete(chaveVerifierConsentimento(params.consentimentoId));
        await store.delete(chaveTokenConsentimento(params.consentimentoId, 'access_token'));
        await store.delete(chaveTokenConsentimento(params.consentimentoId, 'refresh_token'));
      }
      return { ok: true, remoto: false };
    }

    if (this._temTransport()) {
      this._exigirDisponivel();
      await this.client.request({
        operacao: 'revogarAutorizacao',
        method: 'POST',
        recurso: 'revogacao',
        consentimentoId: params.consentimentoId
      });
      if (store && params.consentimentoId) {
        await store.delete(chaveTokenConsentimento(params.consentimentoId, 'access_token'));
        await store.delete(chaveTokenConsentimento(params.consentimentoId, 'refresh_token'));
      }
      return { ok: true };
    }

    if (store && params.consentimentoId) {
      await store.delete(chaveTokenConsentimento(params.consentimentoId, 'access_token'));
      await store.delete(chaveTokenConsentimento(params.consentimentoId, 'refresh_token'));
      await store.delete(chaveVerifierConsentimento(params.consentimentoId));
      return { ok: true, remoto: false };
    }

    this._exigirDisponivel();
    return { ok: true };
  }

  async listarContas(params = {}) {
    this._exigirDisponivel();
    const bruto = await this.client.getComRetry({
      operacao: 'listarContas',
      recurso: 'contas'
    });
    const lista = Array.isArray(bruto) ? bruto : ((bruto && bruto.data) || []);
    return lista.map((c) => mapearConta(c, params));
  }

  async consultarSaldo() {
    this._exigirDisponivel();
    const bruto = await this.client.getComRetry({
      operacao: 'consultarSaldo',
      recurso: 'saldo'
    });
    return mapearSaldo(bruto);
  }

  async listarTransacoes(params = {}) {
    this._exigirDisponivel();
    const bruto = await this.client.getComRetry({
      operacao: 'listarTransacoes',
      recurso: 'extrato',
      cursor: params.cursor || null,
      empresaId: params.empresaId,
      contaBancariaId: params.contaBancariaId || params.conta_bancaria_id
    });
    return mapearPagina(bruto, {
      empresaId: params.empresaId,
      contaBancariaId: params.contaBancariaId || params.conta_bancaria_id
    });
  }

  async obterCredenciaisOperacao(params = {}) {
    if (typeof params.obterCredenciaisProvider !== 'function') return null;
    return params.obterCredenciaisProvider({
      empresaId: params.empresaId,
      id: params.configuracaoId != null ? params.configuracaoId : params.configId
    });
  }
}

module.exports = { OpenFinanceRealBankProvider, chaveOauthMercadoPago };
