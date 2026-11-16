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

function tefRegistroHabilitado(registro) {
  return tefConfigRepository.intToBool(registro && registro.habilitado);
}

function erroTefDesabilitado() {
  const err = new Error('TEF está desabilitado na configuração.');
  err.code = 'TEF_DESABILITADO';
  err.statusCode = 409;
  return err;
}

function criarAdapter(registro) {
  if (!registro) {
    throw new Error('TEF não configurado');
  }

  const provedor = String(registro.provedor || '').toLowerCase().trim();
  const usarReal = ambienteUsaMiddlewareReal(registro.ambiente);

  if (!provedor) {
    const err = new Error('Provedor TEF não configurado.');
    err.code = 'TEF_PROVEDOR_AUSENTE';
    throw err;
  }

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

/**
 * Porta única de inicialização do adaptador TEF.
 * Com TEF desabilitado (`tef_configuracao.habilitado`) não valida provedor,
 * não instancia adaptador e não carrega DLL/SDK/middleware.
 */
async function obterAdapter() {
  const registro = await tefConfigRepository.buscarConfiguracaoPrincipal();
  if (!registro) {
    throw new Error('TEF não configurado');
  }
  if (!tefRegistroHabilitado(registro)) {
    throw erroTefDesabilitado();
  }
  return criarAdapter(registro);
}

module.exports = {
  obterAdapter,
  criarAdapter,
  ambienteUsaMiddlewareReal,
  ambienteTesteSmartPos,
  tefRegistroHabilitado,
  erroTefDesabilitado
};
