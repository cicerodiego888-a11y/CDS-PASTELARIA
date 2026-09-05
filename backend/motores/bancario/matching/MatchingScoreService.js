/**
 * Score determinístico. Pesos não são alteráveis pelo frontend.
 * @module motores/bancario/matching/MatchingScoreService
 */
'use strict';

const {
  PESOS_MATCHING,
  PONTOS_DATA,
  JANELA_DIAS_MATCHING,
  LIMIARES_CONFIANCA,
  NIVEL_CONFIANCA
} = require('./contracts/constantesMatching');
const {
  normalizarTexto,
  sobreposicaoTokens,
  diasEntre,
  valoresIguais
} = require('./MatchingNormalizacaoService');

function pontuarValor(tx, candidato) {
  if (valoresIguais(tx.valor, candidato.valor)) {
    return { pontos: PESOS_MATCHING.VALOR_EXATO, motivo: 'VALOR_EXATO' };
  }
  return { pontos: 0, motivo: null };
}

function pontuarData(tx, candidato) {
  const dias = diasEntre(tx.data_transacao, candidato.data);
  if (dias == null || dias > JANELA_DIAS_MATCHING) {
    return { pontos: 0, motivo: null };
  }
  if (dias === 0) return { pontos: PONTOS_DATA.MESMO_DIA, motivo: 'DATA_MESMO_DIA' };
  if (dias === 1) return { pontos: PONTOS_DATA.UM_DIA, motivo: 'DATA_1_DIA' };
  return { pontos: PONTOS_DATA.DOIS_DIAS, motivo: 'DATA_2_DIAS' };
}

function compactarId(valor) {
  return normalizarTexto(valor).replace(/\s+/g, '');
}

function pontuarIdentificador(tx, candidato) {
  const ids = [tx.external_id, tx.referencia_externa].map(compactarId).filter(Boolean);
  if (!ids.length) return { pontos: 0, motivo: null };
  const alvo = compactarId((candidato.identificador || '') + ' ' + (candidato.descricao || ''));
  const hit = ids.some((id) => alvo === id || alvo.indexOf(id) !== -1);
  if (hit) return { pontos: PESOS_MATCHING.IDENTIFICADOR, motivo: 'IDENTIFICADOR_EXATO' };
  return { pontos: 0, motivo: null };
}

function pontuarDescricao(tx, candidato) {
  const a = normalizarTexto(tx.descricao);
  const b = normalizarTexto(candidato.descricao);
  if (!a || !b) return { pontos: 0, motivo: null };
  if (a === b) return { pontos: PESOS_MATCHING.DESCRICAO, motivo: 'DESCRICAO_IDENTICA' };
  const ov = sobreposicaoTokens(a, b);
  if (ov >= 0.7) return { pontos: 7, motivo: 'DESCRICAO_COMPATIVEL' };
  if (ov >= 0.4) return { pontos: 4, motivo: 'DESCRICAO_PARCIAL' };
  return { pontos: 0, motivo: null };
}

function classificar(score) {
  if (score >= LIMIARES_CONFIANCA.ALTA_MIN) return NIVEL_CONFIANCA.ALTA;
  if (score >= LIMIARES_CONFIANCA.MEDIA_MIN) return NIVEL_CONFIANCA.MEDIA;
  if (score >= LIMIARES_CONFIANCA.BAIXA_MIN) return NIVEL_CONFIANCA.BAIXA;
  return null;
}

function calcularScore(tx, candidato) {
  const partes = [
    pontuarValor(tx, candidato),
    pontuarData(tx, candidato),
    pontuarIdentificador(tx, candidato),
    pontuarDescricao(tx, candidato)
  ];
  const score = partes.reduce((acc, p) => acc + p.pontos, 0);
  const motivos = partes.map((p) => p.motivo).filter(Boolean);
  const nivel_confianca = classificar(score);
  return { score, nivel_confianca, motivos, sugerir: nivel_confianca != null };
}

module.exports = {
  calcularScore,
  classificar,
  pontuarValor,
  pontuarData,
  pontuarIdentificador,
  pontuarDescricao
};
