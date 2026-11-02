const SitefAdapter = require('./adapters/sitefAdapter');
const SitefRealAdapter = require('./adapters/sitefRealAdapter');
const PaygoAdapter = require('./adapters/paygoAdapter');
const PaygoRealAdapter = require('./adapters/paygoRealAdapter');
const StoneAdapter = require('./adapters/stoneAdapter');
const CieloAdapter = require('./adapters/cieloAdapter');
const RedeAdapter = require('./adapters/redeAdapter');
const GetnetAdapter = require('./adapters/getnetAdapter');
const SmartPosSimuladorAdapter = require('./adapters/SmartPosSimuladorAdapter');
const tefConfigRepository = require('../../repositories/tefConfigRepository');

function ambienteUsaMiddlewareReal(ambiente) {
  const a = String(ambiente || 'simulacao').toLowerCase();
  return a === 'homologacao' || a === 'producao' || a === 'produção';
}

function ambienteTesteSmartPos() {
  return process.env.CDS_TEST_ISOLATION === '1'
    && process.env.CDS_BLOQUEAR_BANCO_OFICIAL === '1';
}

function criarAdapter(registro) {
  if (!registro) {
    throw new Error('TEF não configurado');
  }

  const provedor = String(registro.provedor || '').toLowerCase();
  const usarReal = ambienteUsaMiddlewareReal(registro.ambiente);

  if (provedor === 'smart_pos_simulador') {
    if (!ambienteTesteSmartPos()) {
      throw new Error('Provedor TEF não suportado: smart_pos_simulador');
    }
    return new SmartPosSimuladorAdapter(registro);
  }

  if (provedor === 'sitef') {
    if (usarReal && SitefRealAdapter.podeUsarModoReal()) {
      return new SitefRealAdapter(registro);
    }
    return new SitefAdapter(registro);
  }

  if (provedor === 'paygo') {
    if (usarReal && PaygoRealAdapter.podeUsarModoReal()) {
      return new PaygoRealAdapter(registro);
    }
    return new PaygoAdapter(registro);
  }

  const gateways = {
    stone: StoneAdapter,
    cielo: CieloAdapter,
    rede: RedeAdapter,
    getnet: GetnetAdapter
  };

  const Gateway = gateways[provedor];
  if (!Gateway) {
    throw new Error(`Provedor TEF não suportado: ${provedor}`);
  }

  return new Gateway(registro);
}

async function obterAdapter() {
  const registro = await tefConfigRepository.buscarConfiguracaoPrincipal();
  return criarAdapter(registro);
}

module.exports = {
  obterAdapter,
  criarAdapter,
  ambienteUsaMiddlewareReal,
  ambienteTesteSmartPos
};
