/**
 * Fachada pública do Motor Fiscal × Não Fiscal (saldos / distribuição).
 *
 * Princípio CDS: outros motores só consomem este módulo (ou fiscalNaoFiscalService
 * legado de agregação), nunca tabelas de estoque diretamente.
 *
 * Fase 1 / Implementação 01: exporta também helpers de contexto de empresa.
 *
 * @module services/fiscalNaoFiscal
 */
'use strict';

const estoqueSaldosPublico = require('./estoqueSaldosPublico');
const reservasPublico = require('./reservasPublico');
const constants = require('./constants');
const empresaContexto = require('./empresaContexto');
const legado = require('../fiscalNaoFiscalService');

module.exports = {
  // Interface pública de saldos (MTS e futuros motores)
  ...estoqueSaldosPublico,
  // Interface pública de reservas (Motor Comercial / Pedido)
  consultarDisponibilidade: reservasPublico.consultarDisponibilidade,
  consultarDisponibilidadeParaPedido: reservasPublico.consultarDisponibilidadeParaPedido,
  criarReservaFiscal: reservasPublico.criarReservaFiscal,
  criarReservaNaoFiscal: reservasPublico.criarReservaNaoFiscal,
  liberarReservasPedido: reservasPublico.liberarReservasPedido,
  ajustarReservado: reservasPublico.ajustarReservado,
  reservarQuantidade: reservasPublico.reservarQuantidade,
  liberarQuantidadeReservada: reservasPublico.liberarQuantidadeReservada,
  garantirSchemaReservas: reservasPublico.garantirSchemaReservas,
  TipoSaldo: constants.TipoSaldo,
  normalizarTipoSaldo: constants.normalizarTipoSaldo,
  // Contexto multiempresa (contrato)
  resolverEmpresaId: empresaContexto.resolverEmpresaId,
  resolverEmpresaIdDaRequisicao: empresaContexto.resolverEmpresaIdDaRequisicao,
  exigirEmpresaId: empresaContexto.exigirEmpresaId,
  validarEmpresaId: empresaContexto.validarEmpresaId,
  resolverContextoEmpresa: empresaContexto.resolverContextoEmpresa,
  criarMiddlewareContextoEmpresa: empresaContexto.criarMiddlewareContextoEmpresa,
  exigirEmpresaAlvoDoContexto: empresaContexto.exigirEmpresaAlvoDoContexto,
  COMPAT_CERTIFICADA_PRE_MULTIEMPRESA: empresaContexto.COMPAT_CERTIFICADA_PRE_MULTIEMPRESA,
  // Legado (agregação de totais pós-distribuição) — mantido
  separarItensFiscalNaoFiscal: legado.separarItensFiscalNaoFiscal,
  separarItensDistribuidos: legado.separarItensDistribuidos,
  normalizarItemFiscal: legado.normalizarItemFiscal
};
