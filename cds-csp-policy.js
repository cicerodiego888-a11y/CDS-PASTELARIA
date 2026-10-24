/**
 * Política CSP canônica do CDS (renderer HTTP + Electron + meta HTML).
 *
 * Regras:
 * - Nunca incluir 'unsafe-eval' (Electron Security Warning + risco real).
 * - 'unsafe-inline' em script/style é residual e documentado (templates ERP/PDV
 *   com style="" e handlers/scripts inline legados) — não usar para silenciar aviso.
 * - object-src / base-uri restritivos.
 * - frame-ancestors 'none' só no cabeçalho HTTP / session Electron.
 *   Navegadores ignoram frame-ancestors em <meta>; não declarar na meta.
 */
'use strict';

/** Diretivas comuns a header HTTP e meta (sem frame-ancestors). */
const CSP_DIRETIVAS_BASE = Object.freeze([
  "default-src 'self'",
  // Scripts locais + inline legado (onclick / <script> boot). SEM unsafe-eval.
  "script-src 'self' 'unsafe-inline'",
  // Estilos Bootstrap/CSS locais + atributos style="" gerados pelo ERP.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // API sempre same-origin (location.origin/api). Sem WebSocket no frontend atual.
  "connect-src 'self'",
  // Preview de comprovante (iframe blob/data) e frames locais.
  "frame-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'"
]);

/** Somente cabeçalho HTTP / Electron — inválido/ignorado em <meta>. */
const CSP_DIRETIVA_FRAME_ANCESTORS = "frame-ancestors 'none'";

/** CSP para <meta http-equiv> (sem frame-ancestors). */
const CSP_META = CSP_DIRETIVAS_BASE.join('; ');

/** CSP para Content-Security-Policy HTTP e session Electron. */
const CSP_HTTP = [...CSP_DIRETIVAS_BASE, CSP_DIRETIVA_FRAME_ANCESTORS].join('; ');

/** Alias histórico: política efetiva do renderer via HTTP/Electron. */
const CSP_RENDERER = CSP_HTTP;

/** @deprecated use CSP_DIRETIVAS_BASE + frame-ancestors no HTTP */
const CSP_DIRETIVAS = Object.freeze([...CSP_DIRETIVAS_BASE, CSP_DIRETIVA_FRAME_ANCESTORS]);

/**
 * Meta tag CSP (defesa em profundidade) — sem frame-ancestors.
 * @returns {string}
 */
function metaTagCsp() {
  return `<meta http-equiv="Content-Security-Policy" content="${CSP_META.replace(/"/g, '&quot;')}">`;
}

/**
 * Valida que a política não reintroduz permissões inseguras críticas.
 * @param {string} [csp]
 * @param {{ exigirFrameAncestors?: boolean, proibirFrameAncestors?: boolean }} [opts]
 * @returns {{ ok: boolean, motivos: string[] }}
 */
function validarCspSegura(csp = CSP_HTTP, opts = {}) {
  const texto = String(csp || '');
  const motivos = [];
  if (!texto.trim()) {
    motivos.push('CSP vazia');
  }
  if (/unsafe-eval/i.test(texto)) {
    motivos.push("contém 'unsafe-eval'");
  }
  if (!/object-src\s+'none'/i.test(texto)) {
    motivos.push("object-src deve ser 'none'");
  }
  if (!/base-uri\s+'self'/i.test(texto)) {
    motivos.push("base-uri deve ser 'self'");
  }
  if (!/script-src\s/i.test(texto)) {
    motivos.push('script-src ausente');
  }
  if (/script-src[^;]*\*/i.test(texto)) {
    motivos.push('script-src com curinga *');
  }
  if (opts.exigirFrameAncestors === true && !/frame-ancestors\s+'none'/i.test(texto)) {
    motivos.push("HTTP/Electron exige frame-ancestors 'none'");
  }
  if (opts.proibirFrameAncestors === true && /frame-ancestors/i.test(texto)) {
    motivos.push('meta CSP não deve declarar frame-ancestors');
  }
  return { ok: motivos.length === 0, motivos };
}

/**
 * Indica se a CSP bloquearia eval()/new Function no renderer (ausência de unsafe-eval).
 * @param {string} [csp]
 * @returns {boolean}
 */
function cspBloqueiaUnsafeEval(csp = CSP_HTTP) {
  return !/unsafe-eval/i.test(String(csp || ''));
}

/**
 * Documenta a única divergência permitida entre mecanismos de entrega.
 * @returns {{ http: string, meta: string, diferenca: string }}
 */
function documentarDiferencaEntregaCsp() {
  return {
    http: CSP_HTTP,
    meta: CSP_META,
    diferenca:
      "frame-ancestors 'none' existe apenas no cabeçalho HTTP / session Electron; "
      + 'omitido na meta porque navegadores ignoram essa diretiva em <meta>.'
  };
}

module.exports = {
  CSP_DIRETIVAS_BASE,
  CSP_DIRETIVA_FRAME_ANCESTORS,
  CSP_DIRETIVAS,
  CSP_META,
  CSP_HTTP,
  CSP_RENDERER,
  metaTagCsp,
  validarCspSegura,
  cspBloqueiaUnsafeEval,
  documentarDiferencaEntregaCsp
};
