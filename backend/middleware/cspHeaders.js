/**
 * Header Content-Security-Policy para respostas HTTP do backend CDS.
 * Usa CSP_HTTP (inclui frame-ancestors 'none'). Meta HTML usa CSP_META.
 */
'use strict';

const { CSP_HTTP, validarCspSegura } = require('../../cds-csp-policy');

const validacao = validarCspSegura(CSP_HTTP, { exigirFrameAncestors: true });
if (!validacao.ok) {
  // Falha de boot explícita — nunca servir com CSP insegura/inválida.
  throw new Error(`[CSP] Política inválida: ${validacao.motivos.join('; ')}`);
}

function cspHeadersMiddleware(req, res, next) {
  // Um único header; Electron (session) normaliza para a mesma CSP_HTTP.
  res.setHeader('Content-Security-Policy', CSP_HTTP);
  next();
}

module.exports = {
  cspHeadersMiddleware,
  CSP_HTTP,
  /** @deprecated alias — preferir CSP_HTTP */
  CSP_RENDERER: CSP_HTTP
};
