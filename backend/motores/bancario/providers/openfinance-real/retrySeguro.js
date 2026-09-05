/**
 * Retry limitado para falhas transitórias do provider.
 * Não retenta autenticação, autorização, consentimento ou dados inválidos.
 * @module motores/bancario/providers/openfinance-real/retrySeguro
 */
'use strict';

const { CATEGORIA_ERRO_PROVIDER, classificarErroProvider } = require('../../contracts/constantes');

const RETENTAVEIS = new Set([
  CATEGORIA_ERRO_PROVIDER.TIMEOUT,
  CATEGORIA_ERRO_PROVIDER.INDISPONIBILIDADE,
  CATEGORIA_ERRO_PROVIDER.RATE_LIMIT
]);

async function retrySeguro(fn, opts = {}) {
  const max = opts.max != null ? Number(opts.max) : 2;
  const esperarMs = opts.esperarMs != null ? Number(opts.esperarMs) : 0;
  let tentativa = 0;
  let ultimo;
  while (tentativa <= max) {
    try {
      return await fn(tentativa);
    } catch (err) {
      ultimo = err;
      const cat = err.categoria || classificarErroProvider(err);
      err.categoria = cat;
      if (!RETENTAVEIS.has(cat) || tentativa >= max) throw err;
      if (esperarMs > 0) {
        await new Promise((r) => setTimeout(r, esperarMs));
      }
      tentativa += 1;
    }
  }
  throw ultimo;
}

module.exports = { retrySeguro, RETENTAVEIS };
