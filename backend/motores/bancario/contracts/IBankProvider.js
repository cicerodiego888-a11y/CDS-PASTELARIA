/**
 * Contrato único de provider bancário (adapter).
 * Autorização: iniciarAutorizacao, processarCallback, revogarAutorizacao.
 * Dados: listarContas, consultarSaldo, listarTransacoes.
 * Conexão: conectar, desconectar.
 * Sem IOpenFinanceProvider / IRealBankProvider paralelo.
 * Provider real implementa esta classe; não executa SQL do ERP.
 * @module motores/bancario/contracts/IBankProvider
 */
'use strict';

const { ERROS, erroMbc } = require('./constantes');

class IBankProvider {
  get codigo() {
    return 'abstract';
  }

  get nome() {
    return 'Provider abstrato';
  }

  get disponivel() {
    return false;
  }

  async conectar() {
    throw erroMbc(ERROS.NAO_IMPLEMENTADO, 'Provider bancário não implementado na MBC-01.', 501);
  }

  async desconectar() {
    throw erroMbc(ERROS.NAO_IMPLEMENTADO, 'Provider bancário não implementado na MBC-01.', 501);
  }

  async listarContas() {
    throw erroMbc(ERROS.NAO_IMPLEMENTADO, 'Provider bancário não implementado na MBC-01.', 501);
  }

  async listarTransacoes() {
    throw erroMbc(ERROS.NAO_IMPLEMENTADO, 'Provider bancário não implementado na MBC-01.', 501);
  }

  async consultarSaldo() {
    throw erroMbc(ERROS.NAO_IMPLEMENTADO, 'Provider bancário não implementado na MBC-01.', 501);
  }

  get suportaAutorizacao() {
    return false;
  }

  get suportaSincronizacao() {
    return false;
  }

  async iniciarAutorizacao() {
    throw erroMbc(ERROS.NAO_IMPLEMENTADO, 'Autorização do provider não implementada.', 501);
  }

  async processarCallback() {
    throw erroMbc(ERROS.NAO_IMPLEMENTADO, 'Callback do provider não implementado.', 501);
  }

  async revogarAutorizacao() {
    throw erroMbc(ERROS.NAO_IMPLEMENTADO, 'Revogação do provider não implementada.', 501);
  }
}

module.exports = { IBankProvider };
