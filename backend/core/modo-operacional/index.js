/**
 * Módulo central — Modo Operacional Global CDS.
 *
 * @module core/modo-operacional
 */
'use strict';

const contratos = require('./contratos');
const modoOperacionalGlobal = require('./modoOperacionalGlobal');
const compatibilidade = require('./compatibilidadeModoVenda');
const PoliticaEmpresaSimples = require('./PoliticaEmpresaSimples');
const PoliticaMultiempresa = require('./PoliticaMultiempresa');
const ContratoOperacionalService = require('./ContratoOperacionalService');

module.exports = {
  ...contratos,
  ...modoOperacionalGlobal,
  ...compatibilidade,
  PoliticaEmpresaSimples,
  PoliticaMultiempresa,
  ContratoOperacionalService
};
