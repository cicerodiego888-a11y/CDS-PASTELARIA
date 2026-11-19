/**
 * S07-3A — Registro de segmentos de atendimento para roteamento.
 *
 * Segmentos base (obrigatórios / preservados): LOJA, IFOOD, PEDIDO_ONLINE.
 *
 * Extensão futura sem alterar a lógica central de roteamento:
 * - Registrar via `registrarSegmentoExtra(codigo)` (somente em bootstrap/config),
 *   ou
 * - Definir `CDS_COZINHA_SEGMENTOS_EXTRA=UBER,RAPPI` (lista CSV, uppercase).
 *
 * A validação e o mapa segmento→unidade usam apenas `listarSegmentosPermitidos()`.
 * Não há integração com plataformas externas neste módulo.
 */
'use strict';

/** Segmentos oficiais S07-3A — não remover. */
const SEGMENTOS_BASE = Object.freeze(['LOJA', 'IFOOD', 'PEDIDO_ONLINE']);

/** Extensões em memória (processo) — limpas só via limparSegmentosExtra (testes). */
const _extras = new Set();

function normalizarCodigoSegmento(raw) {
  return String(raw == null ? '' : raw).trim().toUpperCase();
}

function extrasDoAmbiente() {
  const raw = process.env.CDS_COZINHA_SEGMENTOS_EXTRA;
  if (raw == null || String(raw).trim() === '') return [];
  return String(raw)
    .split(/[,;]+/)
    .map(normalizarCodigoSegmento)
    .filter((s) => s.length > 0 && /^[A-Z][A-Z0-9_]{0,31}$/.test(s));
}

/**
 * Lista completa (base + extras env + extras registrados), estável e sem duplicatas.
 */
function listarSegmentosPermitidos() {
  const out = [];
  const seen = new Set();
  for (const s of SEGMENTOS_BASE) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  for (const s of extrasDoAmbiente()) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  for (const s of _extras) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

function isSegmentoPermitido(raw) {
  const seg = normalizarCodigoSegmento(raw);
  return seg.length > 0 && listarSegmentosPermitidos().includes(seg);
}

/**
 * Amplia o allowlist em runtime (configuração / testes).
 * Não altera a lógica de roteamento — só o conjunto validado.
 */
function registrarSegmentoExtra(codigo) {
  const seg = normalizarCodigoSegmento(codigo);
  if (!seg || !/^[A-Z][A-Z0-9_]{0,31}$/.test(seg)) {
    throw new Error(`Código de segmento inválido para extensão: ${codigo}`);
  }
  if (SEGMENTOS_BASE.includes(seg)) return seg;
  _extras.add(seg);
  return seg;
}

/** Uso exclusivo em testes. */
function limparSegmentosExtra() {
  _extras.clear();
}

module.exports = {
  SEGMENTOS_BASE,
  listarSegmentosPermitidos,
  isSegmentoPermitido,
  normalizarCodigoSegmento,
  registrarSegmentoExtra,
  limparSegmentosExtra
};
