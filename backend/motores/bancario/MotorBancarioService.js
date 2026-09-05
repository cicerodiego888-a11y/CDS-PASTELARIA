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
  'conciliarTransacao',
  'desconciliarTransacao',
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
  'listarSugestoesConciliacao',
  'obterSugestaoConciliacao',
  'aceitarSugestaoConciliacao',
  'recusarSugestaoConciliacao',
  'avaliarProntidaoProviderReal',
  'avaliarGoNogoProviderReal'
]);

function foraDeEscopo(code, msg) {
  throw erroMbc(code, msg, 501);
}

class MotorBancarioService {
  constructor(deps = {}) {
    this.db = deps.db || null;
    this.resolverEmpresa = deps.resolverEmpresaIdParaBancario || resolverEmpresaIdParaBancario;
    this.registry = deps.registry || obterRegistryPadrao();
    this.secretStore = deps.secretStore || obterSecretStore({ db: this.db });
  }

  _cfg(params = {}) {
    return {
      db: this._db(params),
      registry: params.registry || this.registry,
      secretStore: params.secretStore || this.secretStore
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
    this.exigirEmpresaId(params.empresaId);
    return ContaBancariaService.listarPorEmpresa({
      db: this._db(params),
      empresaId: params.empresaId
    });
  }

  obterConta(params = {}) {
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

  obterConciliacao(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return ConciliacaoBancariaService.obterNoContexto({
      db: this._db(params),
      empresaId: params.empresaId,
      id: params.id
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
    return ConciliacaoBancariaService.obterStatusDaTransacao(this._db(params), params.id);
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
    this.exigirEmpresaId(params.empresaId);
    return ConfiguracaoIntegracaoBancariaService.obterNoContexto({
      ...this._cfg(params),
      empresaId: params.empresaId,
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
      conta_bancaria_id: params.conta_bancaria_id || params.id
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
