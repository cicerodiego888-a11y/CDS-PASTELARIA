/**
 * Adaptador THERMAL — contrato/preparação. Sem ESC/POS real.
 */
'use strict';

const { PrintAdapter } = require('./PrintAdapter');
const { DESTINOS_IMPRESSAO } = require('./printContracts');

class ThermalPrintAdapter extends PrintAdapter {
  async imprimir(payload) {
    return Object.freeze({
      sucesso: true,
      destino: DESTINOS_IMPRESSAO.THERMAL,
      formato: payload.formato,
      conteudo: payload.conteudo,
      titulo: payload.titulo,
      metadata: payload.metadata,
      preparado: true,
      impressao_fisica: false,
      impresso: false
    });
  }
}

module.exports = { ThermalPrintAdapter };
