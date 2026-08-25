/**
 * Política central MULTIEMPRESA — delega contexto empresarial à fundação existente.
 *
 * @module core/modo-operacional/PoliticaMultiempresa
 */
'use strict';

const { capacidadesParaModoGlobal, ModoOperacionalGlobal } = require('./contratos');

function obterCapacidadesMultiempresa() {
  return capacidadesParaModoGlobal(ModoOperacionalGlobal.MULTIEMPRESA);
}

/**
 * Em MULTIEMPRESA a empresa operacional do contrato global é null;
 * o contexto vem de seleção / X-Empresa-Id por operação.
 */
function resolverEmpresaOperacionalContrato() {
  return null;
}

module.exports = {
  obterCapacidadesMultiempresa,
  resolverEmpresaOperacionalContrato
};
