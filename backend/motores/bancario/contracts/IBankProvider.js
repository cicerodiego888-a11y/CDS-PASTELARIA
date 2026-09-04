/**
 * Contrato de provider bancário (adapter).
 * Open Finance e instituições concretas NÃO são implementados na MBC-01.
 * @module motores/bancario/contracts/IBankProvider
 */
'use strict';

const { ERROS, erroMbc } = require('./constantes');

class IBankProvider {
  get codigo() {
    return 'abstract';
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
}

module.exports = { IBankProvider };
