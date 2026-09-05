/**
 * Sanitização de objetos/logs do MBC. Nunca registrar secrets.
 * @module motores/bancario/contracts/sanitizarMbc
 */
'use strict';

const SENSIVEIS = /secret|token|senha|password|authorization|refresh|client_secret|private.?key|certificado|bearer|authorization_code|\bstate\b|oauth/i;

function sanitizarValorMbc(valor, chave) {
  if (chave && SENSIVEIS.test(String(chave))) return '[REDACTED]';
  if (typeof valor === 'string' && SENSIVEIS.test(valor) && valor.length > 8) return '[REDACTED]';
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

module.exports = { sanitizarObjetoMbc, sanitizarValorMbc };
