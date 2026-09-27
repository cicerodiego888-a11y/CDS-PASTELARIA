/**
 * Sanitização de objetos/logs do MBC. Nunca registrar secrets.
 * Mensagens funcionais ao usuário NÃO devem virar "[REDACTED]"
 * só porque citam "oauth" / "authorization".
 * @module motores/bancario/contracts/sanitizarMbc
 */
'use strict';

const SENSIVEIS = /secret|token|senha|password|authorization|refresh|client_secret|private.?key|certificado|certificate|bearer|authorization_code|\bstate\b|oauth/i;

/** Heurística para valor textual que parece credencial/token, não frase operacional. */
function pareceSegredoEmTexto(valor) {
  const s = String(valor);
  if (/bearer\s+[A-Za-z0-9._\-+=\/]{8,}/i.test(s)) return true;
  if (/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/.test(s)) return true;
  if (/(access_token|refresh_token|client_secret|code_verifier|authorization_code)\s*[:=]\s*\S+/i.test(s)) {
    return true;
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(s)) return true;
  // Blob opaco longo (hex/base64) — típico de segredo acidental em log
  if (s.length >= 80 && /^[A-Za-z0-9+\/_=-]{80,}$/.test(s.replace(/\s+/g, ''))) return true;
  return false;
}

function sanitizarValorMbc(valor, chave) {
  if (chave && SENSIVEIS.test(String(chave))) return '[REDACTED]';
  if (typeof valor === 'string' && pareceSegredoEmTexto(valor)) return '[REDACTED]';
  return valor;
}

function sanitizarObjetoMbc(obj) {
  if (obj == null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map((v) => sanitizarObjetoMbc(v));
  const out = {};
  Object.keys(obj).forEach((k) => {
    const v = obj[k];
    if (SENSIVEIS.test(k)) {
      out[k] = '[REDACTED]';
    } else if (v && typeof v === 'object') {
      out[k] = sanitizarObjetoMbc(v);
    } else {
      out[k] = sanitizarValorMbc(v, k);
    }
  });
  return out;
}

module.exports = { sanitizarObjetoMbc, sanitizarValorMbc, pareceSegredoEmTexto };
