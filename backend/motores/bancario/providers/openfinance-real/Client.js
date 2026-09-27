'use strict';
/**
 * Client HTTP do adapter real.
 * OpenFinanceRealClient — transporte genérico / harness.
 * MercadoPagoApiClient — API oficial api.mercadopago.com (MBC-16.1).
 */
const of = require('./OpenFinanceRealClient');
const { MercadoPagoApiClient, API_BASE, TIMEOUT_MS } = require('../mercadopago/MercadoPagoApiClient');

module.exports = {
  OpenFinanceRealClient: of.OpenFinanceRealClient,
  categorizarHttp: of.categorizarHttp,
  MercadoPagoApiClient,
  API_BASE,
  TIMEOUT_MS
};
