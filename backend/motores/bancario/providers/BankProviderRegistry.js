/**
 * Registro central de providers bancários.
 * @module motores/bancario/providers/BankProviderRegistry
 */
'use strict';

const { ERROS, erroMbc, CODIGO_PROVIDER } = require('../contracts/constantes');
const { MockBankProvider } = require('./MockBankProvider');
const { MockOpenFinanceProvider } = require('./MockOpenFinanceProvider');
const { OpenFinanceRealBankProvider } = require('./openfinance-real/OpenFinanceRealBankProvider');

class BankProviderRegistry {
  constructor() {
    this._map = new Map();
  }

  registrar(provider) {
    if (!provider || !provider.codigo) {
      throw erroMbc(ERROS.PROVIDER_DESCONHECIDO, 'Provider inválido para registro.', 400);
    }
    this._map.set(String(provider.codigo).toUpperCase(), provider);
    return this;
  }

  existe(codigo) {
    return this._map.has(String(codigo || '').toUpperCase());
  }

  obter(codigo) {
    const key = String(codigo || '').toUpperCase();
    const p = this._map.get(key);
    if (!p) {
      throw erroMbc(ERROS.PROVIDER_DESCONHECIDO, 'Provider bancário desconhecido.', 400);
    }
    return p;
  }

  listar() {
    return Array.from(this._map.values()).map((p) => ({
      codigo: p.codigo,
      nome: p.nome,
      disponivel: p.disponivel !== false,
      homologacao: p.statusAdapter || (p.codigo === 'OPEN_FINANCE_REAL' ? 'NAO_HOMOLOGAVEL' : 'NAO_APLICAVEL')
    }));
  }
}

function criarRegistryPadrao() {
  const registry = new BankProviderRegistry();
  registry.registrar(new MockBankProvider());
  registry.registrar(new MockOpenFinanceProvider());
  registry.registrar(new OpenFinanceRealBankProvider());
  return registry;
}

let padrao = null;
function obterRegistryPadrao() {
  if (!padrao) padrao = criarRegistryPadrao();
  return padrao;
}

module.exports = {
  BankProviderRegistry,
  criarRegistryPadrao,
  obterRegistryPadrao,
  CODIGO_PROVIDER
};
