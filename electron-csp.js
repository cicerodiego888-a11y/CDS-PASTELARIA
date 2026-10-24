/**
 * Aplica CSP restritiva nas sessions Electron do CDS (renderer principal).
 * Não altera contextIsolation / sandbox / nodeIntegration.
 * Sessions particionadas (ex.: Portal NFe) ficam de fora do defaultSession.
 *
 * Usa CSP_HTTP (com frame-ancestors). Substitui qualquer CSP prévia da resposta
 * por um único header — evita duplicata/contradição com o Express.
 */
'use strict';

const { session } = require('electron');
const { CSP_HTTP, validarCspSegura } = require('./cds-csp-policy');

const FLAG = '__cdsCspHeadersApplied';

/**
 * Injeta Content-Security-Policy nas respostas HTTP da session.
 * @param {Electron.Session} ses
 * @param {{ csp?: string }} [opts]
 */
function aplicarCspNaSessao(ses, opts = {}) {
  if (!ses) return { ok: false, motivo: 'session ausente' };
  const csp = opts.csp || CSP_HTTP;
  const validacao = validarCspSegura(csp, { exigirFrameAncestors: true });
  if (!validacao.ok) {
    console.error('[ELECTRON][CSP] Política rejeitada:', validacao.motivos.join('; '));
    return { ok: false, motivos: validacao.motivos };
  }
  if (ses[FLAG]) {
    return { ok: true, jaAplicada: true };
  }

  ses.webRequest.onHeadersReceived((details, callback) => {
    try {
      const responseHeaders = { ...(details.responseHeaders || {}) };
      // Remove todas as variantes do header para ficar com um único valor canônico.
      for (const key of Object.keys(responseHeaders)) {
        if (key.toLowerCase() === 'content-security-policy'
          || key.toLowerCase() === 'content-security-policy-report-only') {
          delete responseHeaders[key];
        }
      }
      responseHeaders['Content-Security-Policy'] = [csp];
      callback({ responseHeaders });
    } catch (err) {
      console.error('[ELECTRON][CSP] Falha ao injetar header:', err?.message || err);
      callback({});
    }
  });

  ses[FLAG] = true;
  console.log('[ELECTRON][CSP] Content-Security-Policy HTTP aplicada (frame-ancestors; sem unsafe-eval).');
  return { ok: true, jaAplicada: false };
}

/**
 * Aplica CSP na defaultSession (janela principal ERP/PDV / login).
 * Deve ser chamado em app.whenReady(), antes do primeiro loadURL.
 */
function aplicarCspElectron() {
  return aplicarCspNaSessao(session.defaultSession);
}

module.exports = {
  CSP_HTTP,
  /** @deprecated alias — preferir CSP_HTTP */
  CSP_RENDERER: CSP_HTTP,
  aplicarCspElectron,
  aplicarCspNaSessao
};
