/**
 * MUC-02 — Catálogo SI e normalização de unidades.
 * Autoridade de códigos de unidade para conversão (não movimenta estoque).
 * @module motores/muc/core/unidadesSi
 */
'use strict';

const FAMILIA = Object.freeze({
  MASSA: 'MASSA',
  VOLUME: 'VOLUME',
  COMPRIMENTO: 'COMPRIMENTO',
  UN: 'UN',
  EMBALAGEM: 'EMBALAGEM'
});

/** Fator para a unidade-base da família (KG, L, M, UN). */
const FATOR_SI = Object.freeze({
  G: { familia: FAMILIA.MASSA, fatorParaBase: 0.001 },
  KG: { familia: FAMILIA.MASSA, fatorParaBase: 1 },
  ML: { familia: FAMILIA.VOLUME, fatorParaBase: 0.001 },
  L: { familia: FAMILIA.VOLUME, fatorParaBase: 1 },
  MM: { familia: FAMILIA.COMPRIMENTO, fatorParaBase: 0.001 },
  CM: { familia: FAMILIA.COMPRIMENTO, fatorParaBase: 0.01 },
  M: { familia: FAMILIA.COMPRIMENTO, fatorParaBase: 1 },
  UN: { familia: FAMILIA.UN, fatorParaBase: 1 }
});

const EMBALAGEM = Object.freeze([
  'CAIXA', 'FARDO', 'PACOTE', 'SACO', 'LATA', 'BALDE', 'ROLO', 'BARRA',
  'KIT', 'DISPLAY', 'BOBINA', 'GALAO'
]);

const ALIAS = Object.freeze({
  UN: 'UN', UND: 'UN', UNI: 'UN',
  KG: 'KG', G: 'G',
  L: 'L', LTRO: 'L',
  ML: 'ML',
  M: 'M', MT: 'M',
  CM: 'CM',
  MM: 'MM',
  M2: 'M2',
  M3: 'M3',
  CX: 'CAIXA', CXA: 'CAIXA', CAIXA: 'CAIXA',
  FD: 'FARDO', FARDO: 'FARDO',
  PC: 'PACOTE', PCT: 'PACOTE', PACOTE: 'PACOTE',
  SC: 'SACO', SACO: 'SACO',
  LT: 'LATA',
  LATA: 'LATA',
  BD: 'BALDE', BALDE: 'BALDE',
  RL: 'ROLO', ROLO: 'ROLO',
  BR: 'BARRA', BARRA: 'BARRA',
  KIT: 'KIT',
  DISPLAY: 'DISPLAY',
  BOBINA: 'BOBINA',
  GALAO: 'GALAO',
  GALÃO: 'GALAO'
});

const CONHECIDAS = new Set([
  ...Object.keys(FATOR_SI),
  ...EMBALAGEM,
  'M2',
  'M3'
]);

function prepararToken(valor) {
  return String(valor || '')
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace('²', '2')
    .replace('³', '3')
    .replace(/\s+/g, '');
}

function isUnidadeConhecida(valor) {
  return normalizarUnidade(valor) != null;
}

function normalizarUnidade(valor) {
  const raw = prepararToken(valor);
  if (!raw) return null;
  if (ALIAS[raw]) return ALIAS[raw];
  if (CONHECIDAS.has(raw)) return raw;
  return null;
}

function familiaDe(unidade) {
  const u = normalizarUnidade(unidade);
  if (!u) return null;
  if (FATOR_SI[u]) return FATOR_SI[u].familia;
  if (EMBALAGEM.includes(u)) return FAMILIA.EMBALAGEM;
  return null;
}

function siIncompativel(a, b) {
  const fa = FATOR_SI[a];
  const fb = FATOR_SI[b];
  return Boolean(fa && fb && fa.familia !== fb.familia);
}

/** KG↔L sem densidade. UN→ML é relação de conteúdo, não família SI. */
function familiasFisicasIncompativeis(a, b) {
  const fa = FATOR_SI[a];
  const fb = FATOR_SI[b];
  if (!fa || !fb) return false;
  if (fa.familia === FAMILIA.UN || fb.familia === FAMILIA.UN) return false;
  return fa.familia !== fb.familia;
}

module.exports = {
  FAMILIA,
  FATOR_SI,
  EMBALAGEM,
  isUnidadeConhecida,
  normalizarUnidade,
  familiaDe,
  siIncompativel,
  familiasFisicasIncompativeis,
  prepararToken
};
