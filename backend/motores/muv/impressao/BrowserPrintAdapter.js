/**
 * Adaptador BROWSER — prepara conteúdo para o frontend/Electron.
 * Não chama window.print().
 */
'use strict';

const { PrintAdapter } = require('./PrintAdapter');
const { DESTINOS_IMPRESSAO } = require('./printContracts');

class BrowserPrintAdapter extends PrintAdapter {
  async imprimir(payload) {
    return Object.freeze({
      sucesso: true,
      destino: DESTINOS_IMPRESSAO.BROWSER,
      formato: payload.formato,
      conteudo: payload.conteudo,
      titulo: payload.titulo,
      metadata: payload.metadata,
      pronto_para_impressao: true,
      impresso: false,
      impressao_fisica: false
    });
  }
}

module.exports = { BrowserPrintAdapter };
