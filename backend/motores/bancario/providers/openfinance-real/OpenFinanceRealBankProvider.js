/**
 * Adapter IBankProvider para Open Finance real.
 * Sem instituição escolhida: não executa OAuth/API de banco.
 * Núcleo MBC não conhece URLs nem payloads proprietários.
 * @module motores/bancario/providers/openfinance-real/OpenFinanceRealBankProvider
 */
'use strict';

const { IBankProvider } = require('../../contracts/IBankProvider');
const {
  ERROS,
  erroMbc,
  STATUS_CONSENTIMENTO,
  CATEGORIA_ERRO_PROVIDER
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

class OpenFinanceRealBankProvider extends IBankProvider {
  constructor(deps = {}) {
    super();
    this.client = deps.client || new OpenFinanceRealClient(deps);
    this.secretStore = deps.secretStore || null;
    this.ambiente = deps.ambiente || null;
    this.env = deps.env || process.env;
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

  async conectar() {
    this._exigirDisponivel();
    return { ok: true, modo: 'open-finance-real', status: STATUS_ADAPTER };
  }

  async desconectar() {
    return { ok: true };
  }

  async iniciarAutorizacao(params = {}) {
    this._exigirDisponivel();
    const state = String(params.state || '').trim();
    if (!state) {
      throw erroMbc(ERROS.AUTORIZACAO_INVALIDA, 'Autorização inválida.', 400);
    }
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

  async processarCallback(params = {}) {
    this._exigirDisponivel();
    const query = params.query || {};
    const erro = String(query.error || query.erro || '').toLowerCase();
    const resultado = String(query.resultado || '').toLowerCase();
    if (erro === 'access_denied' || resultado === 'negado' || resultado === 'cancelado') {
      return { status: STATUS_CONSENTIMENTO.NEGADO };
    }
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

  async revogarAutorizacao(params = {}) {
    this._exigirDisponivel();
    await this.client.request({
      operacao: 'revogarAutorizacao',
      method: 'POST',
      recurso: 'revogacao',
      consentimentoId: params.consentimentoId
    });
    const store = params.secretStore || this.secretStore;
    if (store && params.consentimentoId) {
      await store.delete(chaveTokenConsentimento(params.consentimentoId, 'access_token'));
      await store.delete(chaveTokenConsentimento(params.consentimentoId, 'refresh_token'));
    }
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
}

module.exports = { OpenFinanceRealBankProvider };
