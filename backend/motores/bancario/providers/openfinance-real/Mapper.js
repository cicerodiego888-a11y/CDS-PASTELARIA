'use strict';
/**
 * Mappers do adapter real.
 * OpenFinanceRealMapper — DTO genérico OF.
 * MercadoPagoAccountMoneyMapper — Dinheiro em conta (settlement_report).
 */
const of = require('./OpenFinanceRealMapper');
const mp = require('../mercadopago/MercadoPagoAccountMoneyMapper');

module.exports = Object.assign({}, of, {
  mapearLinhaRelatorioMercadoPago: mp.mapearLinhaRelatorio,
  mapearCsvMercadoPago: mp.mapearCsvParaDtos,
  parseCsvMercadoPago: mp.parseCsv,
  COLUNAS_CONFIG_MERCADO_PAGO: mp.COLUNAS_CONFIG,
  EXTERNAL_SOURCE_MERCADO_PAGO: mp.EXTERNAL_SOURCE
});
