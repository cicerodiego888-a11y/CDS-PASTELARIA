/**
 * Motor Bancário — contrato de fundação (MBC-01).
 * Não sincroniza banco. Não escreve no financeiro. Não Open Finance.
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
const VERSAO = require('./version');

const CONTRATO = Object.freeze([
  'listarContas',
  'obterConta',
  'criarConta',
  'atualizarConta',
  'listarTransacoes',
  'obterTransacao',
  'importarTransacoes',
  'conciliarTransacao',
  'desconciliarTransacao'
]);

function foraDeEscopo(code, msg) {
  throw erroMbc(code, msg, 501);
}

class MotorBancarioService {
  constructor(deps = {}) {
    this.db = deps.db || null;
    this.resolverEmpresa = deps.resolverEmpresaIdParaBancario || resolverEmpresaIdParaBancario;
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

  /**
   * Contas em memória vazias: persistência é MBC-02.
   * Exige empresa explícita. Não lê financeiro.
   */
  listarContas(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return [];
  }

  obterConta(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    foraDeEscopo(ERROS.NAO_IMPLEMENTADO, 'Cadastro de conta bancária entra na MBC-02.');
  }

  criarConta(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    foraDeEscopo(ERROS.NAO_IMPLEMENTADO, 'Cadastro de conta bancária entra na MBC-02.');
  }

  atualizarConta(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    foraDeEscopo(ERROS.NAO_IMPLEMENTADO, 'Cadastro de conta bancária entra na MBC-02.');
  }

  listarTransacoes(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    return [];
  }

  obterTransacao(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    foraDeEscopo(ERROS.NAO_IMPLEMENTADO, 'Persistência de transação entra na MBC-03.');
  }

  /**
   * Importação/sincronização fora de escopo. Nunca grava financeiro.
   */
  importarTransacoes(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    foraDeEscopo(
      ERROS.SINCRONIZACAO_FORA_ESCOPO,
      'Sincronização bancária não está na MBC-01 e não gera lançamento financeiro.'
    );
  }

  conciliarTransacao(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    foraDeEscopo(
      ERROS.CONCILIACAO_FORA_ESCOPO,
      'Conciliação bancária não está na MBC-01. Não altera contas a receber/pagar.'
    );
  }

  desconciliarTransacao(params = {}) {
    this.exigirEmpresaId(params.empresaId);
    foraDeEscopo(
      ERROS.CONCILIACAO_FORA_ESCOPO,
      'Desconciliação bancária não está na MBC-01.'
    );
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
