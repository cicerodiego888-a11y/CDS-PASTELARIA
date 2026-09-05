/**
 * Normalização determinística de textos para matching. Não altera o original persistido.
 * @module motores/bancario/matching/MatchingNormalizacaoService
 */
'use strict';

function normalizarTexto(valor) {
  const s = String(valor == null ? '' : valor)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

function tokens(valor) {
  const n = normalizarTexto(valor);
  return n ? n.split(' ') : [];
}

function sobreposicaoTokens(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const setB = new Set(tb);
  let comuns = 0;
  ta.forEach((t) => {
    if (setB.has(t)) comuns += 1;
  });
  return comuns / Math.max(ta.length, tb.length);
}

function extrairDataIso(valor) {
  if (valor == null) return null;
  const s = String(valor).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function diasEntre(a, b) {
  const da = extrairDataIso(a);
  const db = extrairDataIso(b);
  if (!da || !db) return null;
  const ua = Date.UTC(Number(da.slice(0, 4)), Number(da.slice(5, 7)) - 1, Number(da.slice(8, 10)));
  const ub = Date.UTC(Number(db.slice(0, 4)), Number(db.slice(5, 7)) - 1, Number(db.slice(8, 10)));
  return Math.abs(Math.round((ua - ub) / 86400000));
}

function valoresIguais(a, b) {
  const na = Math.round(Number(a) * 100) / 100;
  const nb = Math.round(Number(b) * 100) / 100;
  return Number.isFinite(na) && Number.isFinite(nb) && na === nb;
}

module.exports = {
  normalizarTexto,
  tokens,
  sobreposicaoTokens,
  extrairDataIso,
  diasEntre,
  valoresIguais
};
