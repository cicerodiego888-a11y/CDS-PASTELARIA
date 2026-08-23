/**
 * Adaptador PREVIEW — devolve conteúdo sem impressão física.
 */
'use strict';

const { PrintAdapter } = require('./PrintAdapter');
const { DESTINOS_IMPRESSAO } = require('./printContracts');

class PreviewPrintAdapter extends PrintAdapter {
  async imprimir(payload) {
    return Object.freeze({
      sucesso: true,
      destino: DESTINOS_IMPRESSAO.PREVIEW,
      formato: payload.formato,
      conteudo: payload.conteudo,
      titulo: payload.titulo,
      metadata: payload.metadata,
      impresso: false,
      preview: true,
      impressao_fisica: false
    });
  }
}

module.exports = { PreviewPrintAdapter };
