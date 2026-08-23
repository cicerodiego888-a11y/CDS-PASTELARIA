/**
 * Contrato base do adaptador de impressão.
 */
'use strict';

class PrintAdapter {
  async imprimir() {
    const err = new Error('NOT_IMPLEMENTED');
    err.code = 'NOT_IMPLEMENTED';
    throw err;
  }
}

module.exports = { PrintAdapter };
