/**
 * Motor Bancário — MBC-01 a MBC-10 (adapter Open Finance real preparado; MOCK intacto).
 * Provider não grava transação. Não escreve no financeiro.

 * @module motores/bancario/MotorBancarioService
 */
'use strict';

const { ERROS, erroMbc, DIRECAO, STATUS_CONCILIACAO } = require('./contracts/constantes');
const {
  exigirEmpresaId,
  normalizarTransacao,
  chaveIdempotencia,
  chaveIdempotenciaFallback
} = require('./contracts/TransacaoBancariaNormalizada');
const { IBankProvider } = require('./contracts/IBankProvider');
const { resolverEmpresaIdParaBancario } = require('./BancarioEmpresaContextoService');
const InstituicaoFinanceiraService = require('./services/InstituicaoFinanceiraService');
const ContaBancariaService = require('./services/ContaBancariaService');
const TransacaoBancariaService = require('./services/TransacaoBancariaService');
const ConciliacaoBancariaService = require('./services/ConciliacaoBancariaService');
const ConfiguracaoIntegracaoBancariaService = require('./services/ConfiguracaoIntegracaoBancariaService');
const ConsentimentoOpenFinanceService = require('./services/ConsentimentoOpenFinanceService');
const MercadoPagoOAuthService = require('./services/MercadoPagoOAuthService');
const MercadoPagoLeituraService = require('./services/MercadoPagoLeituraService');
const ItauCredenciaisService = require('./services/ItauCredenciaisService');
const ItauOperacaoService = require('./services/ItauOperacaoService');
const SincronizacaoBancariaService = require('./services/SincronizacaoBancariaService');
const MotorMatchingBancarioService = require('./matching/MotorMatchingBancarioService');
const { obterRegistryPadrao } = require('./providers/BankProviderRegistry');
const { obterSecretStore } = require('./secrets/EncryptedLocalSecretStore');
const VERSAO = require('./version');

const CONTRATO = Object.freeze([
  'listarContas',
  'obterConta',
  'criarConta',
  'atualizarConta',
  'ativarConta',
  'desativarConta',
  'definirContaPrincipal',
  'excluirConta',
  'listarInstituicoes',
  'obterInstituicao',
  'criarInstituicao',
  'atualizarInstituicao',
  'excluirInstituicao',
  'listarTransacoes',
  'obterTransacao',
  'registrarTransacaoBancaria',
  'calcularSaldoConceitual',
  'listarConciliacoes',
  'obterConciliacao',
  'obterConciliacoesPorTransacao',
  'listarPendentesConciliacao',
  'obterStatusConciliacaoTransacao',
  'conciliarTransacao',
  'desconciliarTransacao',
  'calcularValorConciliadoTransacao',
  'calcularValorDisponivelConciliacao',
  'marcarTransacaoIgnorada',
  'marcarTransacaoDivergente',
  'listarRegistrosElegiveisConciliacao',
  'listarProviders',
  'listarConfiguracoesIntegracao',
  'obterConfiguracaoIntegracao',
  'criarConfiguracaoIntegracao',
  'atualizarConfiguracaoIntegracao',
  'ativarConfiguracaoIntegracao',
  'desativarConfiguracaoIntegracao',
  'testarProvider',
  'executarProvider',
  'importarTransacoes',
  'iniciarConsentimento',
  'listarConsentimentos',
  'obterConsentimento',
  'revogarConsentimento',
  'renovarConsentimento',
  'processarCallbackConsentimento',
  'exigirConsentimentoAutorizado',
  'sincronizarConta',
  'obterSincronizacao',
  'obterSaldoBancario',
  'analisarConciliacoesConta',
  'analisarConciliacaoTransacao',
  'obterMatchingTransacao',
  'listarSugestoesConciliacao',
  'obterSugestaoConciliacao',
  'aceitarSugestaoConciliacao',
  'recusarSugestaoConciliacao',
  'avaliarProntidaoProviderReal',
  'avaliarGoNogoProviderReal',
  'obterStatusCredenciaisIntegracao',
  'configurarCredenciaisMercadoPago',
  'removerCredenciaisMercadoPago',
  'configurarCredenciaisItau',
  'removerCredenciaisItau',
  'configurarCredenciaisProvider',
  'removerCredenciaisProvider',
  'testarConexaoItau',
  'consultarSaldoRealItau',
  'consultarExtratoProviderItau',
  'consultarSaldoReal',
  'consultarExtratoConta',
  'iniciarOAuthMercadoPago',
  'obterStatusOAuthMercadoPago',
  'desconectarOAuthMercadoPago',
  'testarLeituraProviderMercadoPago'
]);

function foraDeEscopo(code, msg) {
  throw erroMbc(code, msg, 501);
}

class MotorBancarioService {
  constructor(deps = {}) {
    this.db = deps.db || null;
    this.resolverEmpresa = deps.resolverEmpresaIdParaBancario || resolverEmpresaIdParaBancario;
    this.registry = deps.registry || obterRegistryPadrao();
    /** Injetado (testes) ou resolvido sob demanda — evita MemorySecretStore por request. */
    this._secretStoreInjetado = deps.secretStore || null;
    this._secretStoreCache = null;
    this.env = deps.env || null;
    const { resolverFetchImplMbc } = require('./providers/mercadopago/resolverFetchImplMbc');
    this.fetchImpl = resolverFetchImplMbc(deps.fetchImpl || null);
  }

  /**
   * SecretStore operacional (EncryptedLocal) ou injetado.
   * Sem MBC_SECRET_STORE_KEY: erro controlado SECRET_KEY_AUSENTE (503).
   */
  get secretStore() {
    if (this._secretStoreInjetado) return this._secretStoreInjetado;
    if (!this._secretStoreCache) {
      this._secretStoreCache = obterSecretStore({ db: this.db });
    }
    return this._secretStoreCache;
  }

  _cfg(params = {}) {
    return {
      db: this._db(params),
      registry: params.registry || this.registry,
      secretStore: params.secretStore || this.secretStore,
      env: params.env || this.env || process.env,
      fetchImpl: params.fetchImpl || this.fetchImpl
    };
  }

  _db(params = {}) {
    return params.db || this.db;
  }

  get versao() {
    return VERSAO;
  }

  get contrato() {
    return CONTRATO;
  }

  exigirEmpresaId(empresaId) {
    return exigirEmpresaId(empresaId);
  }

  normalizarTransacao(input) {
    return normalizarTransacao(input);
  }

  chaveIdempotencia(params) {
    return chaveIdempotencia(params);
  }

  chaveIdempotenciaFallback(dto) {
    return chaveIdempotenciaFallback(dto);
  }

  listarInstituicoes(params = {}) {
    return InstituicaoFinanceiraService.listar({ db: this._db(params) });
  }

  obterInstituicao(params = {}) {
    return InstituicaoFinanceiraService.obterPorId({ db: this._db(params), id: params.id });
  }

  criarInstituicao(params = {}) {
    return InstituicaoFinanceiraService.criar({ db: this._db(params), ...params });
  }

  atualizarInstituicao(params = {}) {
    return InstituicaoFinanceiraService.atualizar({ db: this._db(params), ...params });
  }

  excluirInstituicao(params = {}) {
    return InstituicaoFinanceiraService.excluir({ db: this._db(params), id: params.id });
  }

  listarContas(params = {}) {
    if (Array.isArray(params.empresaIds)) {
      return ContaBancariaService.listarPorEmpresas({
        db: this._db(params),
        empresaIds: params.empresaIds
      });
    }
    this.exigirEmpresaId(params.empresaId);
    return ContaBancariaService.listarPorEmpresa({
      db: this._db(params),
      empresaId: params.empresaId
    });
  }

  obterConta(params = {}) {
    if (Array.isArray(params.empresaIds)) {
      return ContaBancariaService.obterNoConjunto({
        db: this._db(params),
        empresaIds: params.empresaIds,
        id: params.id
      });
    }
    this.exigirEmpresaId(params.empresaId);
    return ContaBancariaService.obterNoContexto({
      db: this._db(params),
      empresaId: params.empresaId,
      id: params.id
    });
  }

  criarConta(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return ContaBancariaService.criar({ db: this._db(params), ...params, empresaId: params.empresaId });
  }

  atualizarConta(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return ContaBancariaService.atualizar({ db: this._db(params), ...params, empresaId: params.empresaId });
  }

  ativarConta(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return ContaBancariaService.ativar({ db: this._db(params), empresaId: params.empresaId, id: params.id });
  }

  desativarConta(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return ContaBancariaService.desativar({ db: this._db(params), empresaId: params.empresaId, id: params.id });
  }

  definirContaPrincipal(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return ContaBancariaService.definirPrincipal({
      db: this._db(params),
      empresaId: params.empresaId,
      id: params.id
    });
  }

  excluirConta(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return ContaBancariaService.excluir({ db: this._db(params), empresaId: params.empresaId, id: params.id });
  }

  listarTransacoes(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return TransacaoBancariaService.listar({ db: this._db(params), ...params, empresaId: params.empresaId });
  }

  obterTransacao(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return TransacaoBancariaService.obterNoContexto({
      db: this._db(params),
      empresaId: params.empresaId,
      id: params.id
    });
  }

  registrarTransacaoBancaria(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return TransacaoBancariaService.registrar({ db: this._db(params), ...params, empresaId: params.empresaId });
  }

  calcularSaldoConceitual(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return TransacaoBancariaService.calcularSaldoConceitual({
      db: this._db(params),
      ...params,
      empresaId: params.empresaId
    });
  }

  listarConciliacoes(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return ConciliacaoBancariaService.listar({ db: this._db(params), ...params, empresaId: params.empresaId });
  }

  listarPendentesConciliacao(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return ConciliacaoBancariaService.listarPendentes({
      db: this._db(params),
      ...params,
      empresaId: params.empresaId
    });
  }

  obterConciliacao(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return ConciliacaoBancariaService.obterNoContexto({
      db: this._db(params),
      empresaId: params.empresaId,
      id: params.id
    });
  }

  obterConciliacoesPorTransacao(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return ConciliacaoBancariaService.obterPorTransacao({
      db: this._db(params),
      ...params,
      empresaId: params.empresaId
    });
  }

  conciliarTransacao(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return ConciliacaoBancariaService.conciliar({ db: this._db(params), ...params, empresaId: params.empresaId });
  }

  desconciliarTransacao(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return ConciliacaoBancariaService.desconciliar({ db: this._db(params), ...params, empresaId: params.empresaId });
  }

  calcularValorConciliadoTransacao(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return ConciliacaoBancariaService.calcularValorConciliado({
      db: this._db(params),
      ...params,
      empresaId: params.empresaId
    });
  }

  calcularValorDisponivelConciliacao(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return ConciliacaoBancariaService.calcularValorDisponivel({
      db: this._db(params),
      ...params,
      empresaId: params.empresaId
    });
  }

  marcarTransacaoIgnorada(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return ConciliacaoBancariaService.marcarIgnorada({ db: this._db(params), ...params, empresaId: params.empresaId });
  }

  marcarTransacaoDivergente(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return ConciliacaoBancariaService.marcarDivergente({ db: this._db(params), ...params, empresaId: params.empresaId });
  }

  listarRegistrosElegiveisConciliacao(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return ConciliacaoBancariaService.listarRegistrosElegiveis({
      db: this._db(params),
      ...params,
      empresaId: params.empresaId
    });
  }

  obterStatusConciliacaoTransacao(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return ConciliacaoBancariaService.obterStatusConciliacao({
      db: this._db(params),
      empresaId: params.empresaId,
      id: params.id,
      transacao_bancaria_id: params.transacao_bancaria_id != null ? params.transacao_bancaria_id : params.id
    });
  }

  listarProviders() {
    return this.registry.listar();
  }

  listarConfiguracoesIntegracao(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return ConfiguracaoIntegracaoBancariaService.listar({
      ...this._cfg(params),
      ...params,
      empresaId: params.empresaId
    });
  }

  obterConfiguracaoIntegracao(params = {}) {
    if (!Array.isArray(params.empresaIds)) this.exigirEmpresaId(params.empresaId);
    return ConfiguracaoIntegracaoBancariaService.obterNoContexto({
      ...this._cfg(params),
      empresaId: params.empresaId,
      empresaIds: params.empresaIds,
      id: params.id
    });
  }

  criarConfiguracaoIntegracao(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return ConfiguracaoIntegracaoBancariaService.criar({
      ...this._cfg(params),
      ...params,
      empresaId: params.empresaId
    });
  }

  atualizarConfiguracaoIntegracao(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return ConfiguracaoIntegracaoBancariaService.atualizar({
      ...this._cfg(params),
      ...params,
      empresaId: params.empresaId
    });
  }

  ativarConfiguracaoIntegracao(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return ConfiguracaoIntegracaoBancariaService.ativar({
      ...this._cfg(params),
      empresaId: params.empresaId,
      id: params.id
    });
  }

  desativarConfiguracaoIntegracao(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return ConfiguracaoIntegracaoBancariaService.desativar({
      ...this._cfg(params),
      empresaId: params.empresaId,
      id: params.id
    });
  }

  obterStatusCredenciaisIntegracao(params = {}) {
    if (!Array.isArray(params.empresaIds)) this.exigirEmpresaId(params.empresaId);
    return ConfiguracaoIntegracaoBancariaService.obterStatusCredenciais({
      ...this._cfg(params),
      empresaId: params.empresaId,
      empresaIds: params.empresaIds,
      id: params.id
    });
  }

  configurarCredenciaisMercadoPago(params = {}) {
    if (!Array.isArray(params.empresaIds)) this.exigirEmpresaId(params.empresaId);
    return ConfiguracaoIntegracaoBancariaService.configurarCredenciaisMercadoPago({
      ...this._cfg(params),
      empresaId: params.empresaId,
      empresaIds: params.empresaIds,
      id: params.id,
      client_id: params.client_id,
      client_secret: params.client_secret,
      ambiente: params.ambiente
    });
  }

  configurarCredenciaisItau(params = {}) {
    if (!Array.isArray(params.empresaIds)) this.exigirEmpresaId(params.empresaId);
    return ItauCredenciaisService.configurar({
      ...this._cfg(params),
      empresaId: params.empresaId,
      id: params.id,
      client_id: params.client_id,
      client_secret: params.client_secret,
      certificate: params.certificate || params.certificado,
      private_key: params.private_key || params.privateKey,
      ca: params.ca || params.certificate_authority,
      ambiente: params.ambiente
    });
  }

  removerCredenciaisMercadoPago(params = {}) {
    if (!Array.isArray(params.empresaIds)) this.exigirEmpresaId(params.empresaId);
    return ConfiguracaoIntegracaoBancariaService.removerCredenciaisMercadoPago({
      ...this._cfg(params),
      empresaId: params.empresaId,
      empresaIds: params.empresaIds,
      id: params.id
    });
  }

  removerCredenciaisItau(params = {}) {
    if (!Array.isArray(params.empresaIds)) this.exigirEmpresaId(params.empresaId);
    return ItauCredenciaisService.remover({
      ...this._cfg(params),
      empresaId: params.empresaId,
      id: params.id
    });
  }

  testarConexaoItau(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return ItauCredenciaisService.testarConexao({
      ...this._cfg(params),
      empresaId: params.empresaId,
      id: params.id,
      forcarRefresh: params.forcarRefresh === true,
      fetchImpl: params.fetchImpl || this.fetchImpl,
      oauthClient: params.oauthClient || null
    });
  }

  consultarSaldoRealItau(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return ItauOperacaoService.consultarSaldoReal({
      ...this._cfg(params),
      empresaId: params.empresaId,
      id: params.id,
      conta_bancaria_id: params.conta_bancaria_id || params.id,
      saldo_url: params.saldo_url,
      saldo_path: params.saldo_path,
      account_id: params.account_id,
      fetchImpl: params.fetchImpl || this.fetchImpl,
      forcarRefresh: params.forcarRefresh === true
    });
  }

  consultarExtratoProviderItau(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return ItauOperacaoService.consultarExtratoProvider({
      ...this._cfg(params),
      empresaId: params.empresaId,
      id: params.id,
      conta_bancaria_id: params.conta_bancaria_id || params.id,
      data_inicio: params.data_inicio || params.begin_date,
      data_fim: params.data_fim || params.end_date,
      extrato_url: params.extrato_url,
      extrato_path: params.extrato_path,
      account_id: params.account_id,
      cursor: params.cursor,
      fetchImpl: params.fetchImpl || this.fetchImpl,
      forcarRefresh: params.forcarRefresh === true
    });
  }

  /**
   * Despacho de saldo real por provider da conta (rotas sem if provider).
   */
  async consultarSaldoReal(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    const lista = await this.listarConfiguracoesIntegracao({
      empresaId: params.empresaId,
      conta_bancaria_id: params.conta_bancaria_id || params.id
    });
    const ativa = (lista || []).find((c) => c.ativo) || (lista || [])[0];
    const provider = String((ativa && ativa.provider) || '').toUpperCase();
    if (provider === 'ITAU') {
      return this.consultarSaldoRealItau(params);
    }
    if (provider === 'OPEN_FINANCE_REAL') {
      const err = erroMbc(
        ERROS.NAO_IMPLEMENTADO,
        'Saldo real indisponível neste fluxo do Mercado Pago.',
        409
      );
      err.codigo = 'SALDO_REAL_NAO_DISPONIVEL_NESTA_OPERACAO';
      err.payload = {
        ok: false,
        disponivel: false,
        provider,
        rotulo: 'Saldo real do banco',
        codigo: 'SALDO_REAL_NAO_DISPONIVEL_NESTA_OPERACAO',
        message: 'Saldo real indisponível neste fluxo do Mercado Pago.'
      };
      throw err;
    }
    const err = erroMbc(
      ERROS.PROVIDER_CREDENCIAL_INCOMPATIVEL,
      'Consulta de saldo real exige provider ITAU configurado.',
      409
    );
    err.payload = {
      ok: false,
      disponivel: false,
      provider: provider || null,
      rotulo: 'Saldo real do banco',
      message: 'Consulta de saldo real exige provider ITAU configurado.'
    };
    throw err;
  }

  /**
   * Extrato MBC (persistido) ou live do provider quando fonte=PROVIDER.
   */
  async consultarExtratoConta(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    const fonte = String(params.fonte || params.origem || '').toUpperCase();
    if (fonte === 'PROVIDER') {
      const lista = await this.listarConfiguracoesIntegracao({
        empresaId: params.empresaId,
        conta_bancaria_id: params.conta_bancaria_id || params.id
      });
      const ativa = (lista || []).find((c) => c.ativo) || (lista || [])[0];
      const provider = String((ativa && ativa.provider) || '').toUpperCase();
      if (provider !== 'ITAU') {
        throw erroMbc(
          ERROS.PROVIDER_CREDENCIAL_INCOMPATIVEL,
          'Extrato live do provider disponível apenas para ITAU neste sprint.',
          409
        );
      }
      return this.consultarExtratoProviderItau(params);
    }
    const transacoes = await this.listarTransacoes({
      empresaId: params.empresaId,
      conta_bancaria_id: params.conta_bancaria_id || params.id,
      data_inicio: params.data_inicio,
      data_fim: params.data_fim,
      direcao: params.direcao,
      tipo: params.tipo,
      limite: params.limite,
      offset: params.offset
    });
    return {
      empresa_id: params.empresaId,
      conta_bancaria_id: Number(params.conta_bancaria_id || params.id),
      origem: 'MBC',
      transacoes
    };
  }

  /**
   * Despacha salvamento de credenciais conforme provider da config.
   */
  async configurarCredenciaisProvider(params = {}) {
    const cfg = await this.obterConfiguracaoIntegracao({
      empresaId: params.empresaId,
      empresaIds: params.empresaIds,
      id: params.id
    });
    const provider = String(cfg.provider || '').toUpperCase();
    if (provider === 'ITAU') {
      return this.configurarCredenciaisItau(params);
    }
    return this.configurarCredenciaisMercadoPago(params);
  }

  async removerCredenciaisProvider(params = {}) {
    const cfg = await this.obterConfiguracaoIntegracao({
      empresaId: params.empresaId,
      empresaIds: params.empresaIds,
      id: params.id
    });
    const provider = String(cfg.provider || '').toUpperCase();
    if (provider === 'ITAU') {
      return this.removerCredenciaisItau(params);
    }
    return this.removerCredenciaisMercadoPago(params);
  }

  iniciarOAuthMercadoPago(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return MercadoPagoOAuthService.iniciar({
      ...this._cfg(params),
      empresaId: params.empresaId,
      id: params.id,
      usuarioId: params.usuarioId,
      env: params.env || this.env || process.env,
      fetchImpl: params.fetchImpl || this.fetchImpl
    });
  }

  obterStatusOAuthMercadoPago(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return MercadoPagoOAuthService.obterStatus({
      ...this._cfg(params),
      empresaId: params.empresaId,
      id: params.id
    });
  }

  desconectarOAuthMercadoPago(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return MercadoPagoOAuthService.desconectar({
      ...this._cfg(params),
      empresaId: params.empresaId,
      id: params.id
    });
  }

  /**
   * Leitura real Mercado Pago (MBC-16.1).
   * Com persistir=true (MBC-16.2), persiste via TransacaoBancariaService (MBC-03).
   */
  testarLeituraProviderMercadoPago(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return MercadoPagoLeituraService.consultarLeituraReal({
      ...this._cfg(params),
      empresaId: params.empresaId,
      id: params.id,
      begin_date: params.begin_date,
      end_date: params.end_date,
      pollAttempts: params.pollAttempts,
      pollWaitMs: params.pollWaitMs,
      apiClient: params.apiClient,
      fetchImpl: params.fetchImpl || this.fetchImpl,
      persistir: params.persistir === true
    });
  }

  testarProvider(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return ConfiguracaoIntegracaoBancariaService.executar({
      ...this._cfg(params),
      empresaId: params.empresaId,
      id: params.id,
      persistir: false
    });
  }

  executarProvider(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return ConfiguracaoIntegracaoBancariaService.executar({
      ...this._cfg(params),
      empresaId: params.empresaId,
      id: params.id,
      persistir: params.persistir === true
    });
  }

  importarTransacoes(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    foraDeEscopo(
      ERROS.SINCRONIZACAO_FORA_ESCOPO,
      'Sincronização bancária não está na MBC-01 e não gera lançamento financeiro.'
    );
  }

  iniciarConsentimento(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return ConsentimentoOpenFinanceService.iniciar({
      ...this._cfg(params),
      ...params,
      empresaId: params.empresaId
    });
  }

  listarConsentimentos(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return ConsentimentoOpenFinanceService.listar({
      ...this._cfg(params),
      ...params,
      empresaId: params.empresaId
    });
  }

  obterConsentimento(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return ConsentimentoOpenFinanceService.obterNoContexto({
      ...this._cfg(params),
      empresaId: params.empresaId,
      id: params.id
    });
  }

  revogarConsentimento(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return ConsentimentoOpenFinanceService.revogar({
      ...this._cfg(params),
      empresaId: params.empresaId,
      id: params.id
    });
  }

  renovarConsentimento(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return ConsentimentoOpenFinanceService.renovar({
      ...this._cfg(params),
      ...params,
      empresaId: params.empresaId,
      id: params.id
    });
  }

  processarCallbackConsentimento(params = {}) {
    return ConsentimentoOpenFinanceService.processarCallback({
      ...this._cfg(params),
      ...params
    });
  }

  exigirConsentimentoAutorizado(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return ConsentimentoOpenFinanceService.exigirConsentimentoAutorizado({
      ...this._cfg(params),
      ...params,
      empresaId: params.empresaId
    });
  }

  sincronizarConta(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return SincronizacaoBancariaService.sincronizarConta({
      ...this._cfg(params),
      ...params,
      empresaId: params.empresaId,
      conta_bancaria_id: params.conta_bancaria_id || params.id,
      begin_date: params.begin_date,
      end_date: params.end_date,
      reprocessarCatalogo: params.reprocessarCatalogo === true,
      apiClient: params.apiClient,
      fetchImpl: params.fetchImpl || this.fetchImpl,
      falharNoArquivo: params.falharNoArquivo,
      pollAttempts: params.pollAttempts,
      pollWaitMs: params.pollWaitMs,
      retrySleepMs: params.retrySleepMs,
      forcarMercadoPago: params.forcarMercadoPago === true,
      lockTtlMs: params.lockTtlMs,
      maxPaginas: params.maxPaginas,
      agoraMs: params.agoraMs,
      env: params.env || this.env || process.env
    });
  }

  obterSincronizacao(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return SincronizacaoBancariaService.obterSincronizacao({
      ...this._cfg(params),
      empresaId: params.empresaId,
      id: params.id,
      conta_bancaria_id: params.conta_bancaria_id || params.id
    });
  }

  obterSaldoBancario(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return SincronizacaoBancariaService.obterSaldoBancario({
      ...this._cfg(params),
      empresaId: params.empresaId,
      id: params.id,
      conta_bancaria_id: params.conta_bancaria_id || params.id
    });
  }

  analisarConciliacoesConta(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return MotorMatchingBancarioService.analisarConta({
      db: this._db(params),
      empresaId: params.empresaId,
      id: params.id,
      conta_bancaria_id: params.conta_bancaria_id || params.id
    });
  }

  analisarConciliacaoTransacao(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return MotorMatchingBancarioService.analisarTransacao({
      db: this._db(params),
      empresaId: params.empresaId,
      id: params.id,
      transacao_bancaria_id: params.transacao_bancaria_id || params.id
    });
  }

  obterMatchingTransacao(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return MotorMatchingBancarioService.obterMatchingTransacao({
      db: this._db(params),
      empresaId: params.empresaId,
      id: params.id,
      transacao_bancaria_id: params.transacao_bancaria_id || params.id
    });
  }

  listarSugestoesConciliacao(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return MotorMatchingBancarioService.listarSugestoes({
      db: this._db(params),
      ...params,
      empresaId: params.empresaId
    });
  }

  obterSugestaoConciliacao(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return MotorMatchingBancarioService.obterSugestao({
      db: this._db(params),
      empresaId: params.empresaId,
      id: params.id
    });
  }

  aceitarSugestaoConciliacao(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return MotorMatchingBancarioService.aceitarSugestao({
      db: this._db(params),
      empresaId: params.empresaId,
      id: params.id
    });
  }

  recusarSugestaoConciliacao(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return MotorMatchingBancarioService.recusarSugestao({
      db: this._db(params),
      empresaId: params.empresaId,
      id: params.id
    });
  }

  avaliarProntidaoProviderReal(params = {}) {
    const { providerRealPodeOperar } = require('./providers/openfinance-real/prontidaoOperacaoReal');
    return providerRealPodeOperar({
      ambiente: params.ambiente,
      consentimento_status: params.consentimento_status,
      env: params.env,
      certificado_exigido: params.certificado_exigido,
      certificado_configurado: params.certificado_configurado,
      secret_configurado: params.secret_configurado
    });
  }

  avaliarGoNogoProviderReal(params = {}) {
    const { decisaoGoNogo } = require('./providers/openfinance-real/auditoriaProntidao');
    return decisaoGoNogo(params);
  }
}

function obterMotorBancario(deps = {}) {
  return new MotorBancarioService(deps);
}

module.exports = {
  MotorBancarioService,
  obterMotorBancario,
  CONTRATO,
  DIRECAO,
  STATUS_CONCILIACAO,
  IBankProvider,
  exigirEmpresaId,
  normalizarTransacao,
  chaveIdempotencia,
  chaveIdempotenciaFallback,
  resolverEmpresaIdParaBancario
};
