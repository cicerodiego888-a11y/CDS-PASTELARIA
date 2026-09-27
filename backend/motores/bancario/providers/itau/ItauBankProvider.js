/**
 * Provider Itaú — IBankProvider (MBC-ITAU-02).
 * Autenticação + saldo + extrato. Persistência fica no MBC (sync service).
 * @module motores/bancario/providers/itau/ItauBankProvider
 */
'use strict';

const { IBankProvider } = require('../../contracts/IBankProvider');
const { ERROS, erroMbc, CATEGORIA_ERRO_PROVIDER } = require('../../contracts/constantes');
const {
  CODIGO,
  NOME,
  STATUS_ADAPTER,
  endpointsParaAmbiente
} = require('./ItauConstants');
const { ItauOAuthClient } = require('./ItauOAuthClient');
const { ItauApiClient } = require('./ItauApiClient');
const { mapearSaldo, mapearPagina } = require('./ItauMapper');

class ItauBankProvider extends IBankProvider {
  constructor(deps = {}) {
    super();
    this.env = deps.env || process.env;
    this.oauthClient = deps.oauthClient || new ItauOAuthClient(deps);
    this.apiClient = deps.apiClient || new ItauApiClient(deps);
    this._conectado = false;
    this._ultimoAuth = null;
  }

  get codigo() {
    return CODIGO;
  }

  get nome() {
    return NOME;
  }

  get disponivel() {
    return true;
  }

  get statusAdapter() {
    return STATUS_ADAPTER;
  }

  get suportaAutorizacao() {
    return false;
  }

  get suportaSincronizacao() {
    return true;
  }

  async conectar(params = {}) {
    const out = await this.testarConexao(params);
    if (!out.success) {
      const err = erroMbc(
        ERROS.AUTORIZACAO_INVALIDA,
        out.message || 'Falha ao conectar ao Itaú.',
        401
      );
      err.categoria = CATEGORIA_ERRO_PROVIDER.AUTENTICACAO;
      err.errorCode = out.errorCode || null;
      throw err;
    }
    this._conectado = true;
    this._ultimoAuth = out;
    return { ok: true, modo: 'itau', status: STATUS_ADAPTER };
  }

  async desconectar() {
    this._conectado = false;
    this._ultimoAuth = null;
    return { ok: true };
  }

  async testarConexao(params = {}) {
    const ambiente = params.ambiente || 'SANDBOX';
    const endpoints = endpointsParaAmbiente(ambiente, this.env);
    try {
      const tok = await this.oauthClient.obterAccessToken({
        client_id: params.client_id,
        client_secret: params.client_secret,
        certificate: params.certificate,
        private_key: params.private_key,
        ca: params.ca,
        passphrase: params.passphrase,
        ambiente,
        fetchImpl: params.fetchImpl,
        forcarRefresh: params.forcarRefresh === true
      });
      return {
        success: true,
        provider: CODIGO,
        environment: endpoints.ambiente_chave,
        authentication: 'OAUTH2_CLIENT_CREDENTIALS',
        mtls: tok.mtls_usado === true || endpoints.exige_mtls === true,
        authenticated: true,
        token_from_cache: tok.from_cache === true,
        message: tok.from_cache
          ? 'Autenticação Itaú válida (token em cache).'
          : 'Token OAuth obtido com sucesso. Conexão autenticada.',
        mtls_requerido: endpoints.exige_mtls === true
      };
    } catch (err) {
      return {
        success: false,
        provider: CODIGO,
        environment: endpoints.ambiente_chave,
        authentication: 'OAUTH2_CLIENT_CREDENTIALS',
        mtls: endpoints.exige_mtls === true,
        authenticated: false,
        errorCode: err.errorCode || err.code || 'OAUTH_FALHA',
        message: String(err.message || 'Falha na autenticação Itaú.').split('\n')[0].slice(0, 200),
        mtls_requerido: endpoints.exige_mtls === true
      };
    }
  }

  async _obterToken(params = {}) {
    return this.oauthClient.obterAccessToken({
      client_id: params.client_id,
      client_secret: params.client_secret,
      certificate: params.certificate,
      private_key: params.private_key,
      ca: params.ca,
      passphrase: params.passphrase,
      ambiente: params.ambiente,
      fetchImpl: params.fetchImpl,
      forcarRefresh: params.forcarRefresh === true
    });
  }

  _contextoConta(params = {}) {
    return {
      empresaId: params.empresaId != null ? params.empresaId : params.empresa_id,
      contaBancariaId: params.contaBancariaId != null
        ? params.contaBancariaId
        : params.conta_bancaria_id,
      external_account_id: params.account_id || params.external_account_id || null
    };
  }

  /**
   * Consulta saldo no provider. Não persiste. Não altera saldo conceitual.
   */
  async consultarSaldo(params = {}) {
    if (!params.client_id || !params.client_secret) {
      const e = erroMbc(ERROS.CREDENCIAL_SECRET_OBRIGATORIO, 'Credenciais Itaú ausentes para consultar saldo.', 409);
      e.errorCode = 'CREDENCIAIS_AUSENTES';
      throw e;
    }
    const tok = await this._obterToken(params);
    const bruto = await this.apiClient.getJson({
      access_token: tok.access_token,
      ambiente: params.ambiente,
      path_key: 'saldo',
      url: params.saldo_url || null,
      path: params.saldo_path || null,
      account_id: params.account_id || params.external_account_id,
      agencia: params.agencia,
      conta: params.conta || params.numero,
      certificate: params.certificate,
      private_key: params.private_key,
      ca: params.ca,
      passphrase: params.passphrase,
      fetchImpl: params.fetchImpl
    });
    return mapearSaldo(bruto, this._contextoConta(params));
  }

  /**
   * Consulta extrato/movimentações. Não persiste.
   * @returns {{ transacoes, has_more, next_cursor }}
   */
  async listarTransacoes(params = {}) {
    if (!params.client_id || !params.client_secret) {
      const e = erroMbc(ERROS.CREDENCIAL_SECRET_OBRIGATORIO, 'Credenciais Itaú ausentes para consultar extrato.', 409);
      e.errorCode = 'CREDENCIAIS_AUSENTES';
      throw e;
    }
    const tok = await this._obterToken(params);
    const query = {};
    if (params.data_inicio || params.begin_date) {
      query.data_inicio = params.data_inicio || params.begin_date;
    }
    if (params.data_fim || params.end_date) {
      query.data_fim = params.data_fim || params.end_date;
    }
    if (params.cursor) query.cursor = params.cursor;

    const bruto = await this.apiClient.getJson({
      access_token: tok.access_token,
      ambiente: params.ambiente,
      path_key: 'extrato',
      url: params.extrato_url || null,
      path: params.extrato_path || null,
      account_id: params.account_id || params.external_account_id,
      agencia: params.agencia,
      conta: params.conta || params.numero,
      query,
      certificate: params.certificate,
      private_key: params.private_key,
      ca: params.ca,
      passphrase: params.passphrase,
      fetchImpl: params.fetchImpl
    });
    return mapearPagina(bruto, this._contextoConta(params));
  }

  async listarContas() {
    throw erroMbc(ERROS.NAO_IMPLEMENTADO, 'Listagem de contas Itaú fora do escopo MBC-ITAU-02.', 501);
  }
}

module.exports = {
  ItauBankProvider
};
