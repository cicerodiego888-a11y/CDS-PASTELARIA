/**
 * Montagem do contrato operacional único da instalação.
 *
 * @module core/modo-operacional/ContratoOperacionalService
 */
'use strict';

const { resolverModoOperacionalGlobalAtivo } = require('./modoOperacionalGlobal');
const { modoGlobalParaModoVenda } = require('./compatibilidadeModoVenda');
const { capacidadesParaModoGlobal, ModoOperacionalGlobal } = require('./contratos');
const PoliticaEmpresaSimples = require('./PoliticaEmpresaSimples');
const PoliticaMultiempresa = require('./PoliticaMultiempresa');

async function montarContratoOperacional(deps = {}) {
  const modo = resolverModoOperacionalGlobalAtivo(deps);
  const capacidades = capacidadesParaModoGlobal(modo);
  const modo_operacao_venda = modoGlobalParaModoVenda(modo);

  let empresa_operacional = null;
  if (modo === ModoOperacionalGlobal.EMPRESA_SIMPLES) {
    const resolvida = await PoliticaEmpresaSimples.resolverEmpresaOperacional(deps);
    empresa_operacional = resolvida.empresa;
  } else {
    empresa_operacional = PoliticaMultiempresa.resolverEmpresaOperacionalContrato();
  }

  return Object.freeze({
    modo_operacional: modo,
    modo_operacao_venda,
    empresa_operacional,
    capacidades
  });
}

function montarContratoOperacionalParcial(deps = {}) {
  const modo = resolverModoOperacionalGlobalAtivo(deps);
  return Object.freeze({
    modo_operacional: modo,
    modo_operacao_venda: modoGlobalParaModoVenda(modo),
    capacidades: capacidadesParaModoGlobal(modo)
  });
}

module.exports = {
  montarContratoOperacional,
  montarContratoOperacionalParcial
};
