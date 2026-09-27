/**
 * Pesos, janela e limiares do matching. Sem números mágicos no restante do código.
 * @module motores/bancario/matching/contracts/constantesMatching
 */
'use strict';

const PESOS_MATCHING = Object.freeze({
  VALOR_EXATO: 40,
  VALOR_COMPATIVEL: 30,
  VALOR_PARCIAL: 25,
  DATA_COMPATIVEL: 25,
  IDENTIFICADOR: 25,
  DESCRICAO: 10,
  TIPO_MOVIMENTO: 15
});

const PONTOS_DATA = Object.freeze({
  MESMO_DIA: 25,
  UM_DIA: 15,
  DOIS_DIAS: 8
});

/** Janela determinística em dias (±) entre data da TX e data do candidato. */
const JANELA_DIAS_MATCHING = 2;

const LIMIARES_CONFIANCA = Object.freeze({
  ALTA_MIN: 90,
  MEDIA_MIN: 75,
  BAIXA_MIN: 60
});

const NIVEL_CONFIANCA = Object.freeze({
  ALTA: 'ALTA',
  MEDIA: 'MEDIA',
  BAIXA: 'BAIXA'
});

const STATUS_SUGESTAO = Object.freeze({
  PENDENTE: 'PENDENTE',
  ACEITA: 'ACEITA',
  RECUSADA: 'RECUSADA',
  EXPIRADA: 'EXPIRADA'
});

const RESULTADO_MATCHING = Object.freeze({
  UNICO: 'UNICO',
  MULTIPLOS: 'MULTIPLOS',
  NENHUM: 'NENHUM',
  JA_CONCILIADA: 'JA_CONCILIADA'
});

/** Classificação objetiva MBC-05.2 (sem score probabilístico / IA). */
const COMPATIBILIDADE_MATCHING = Object.freeze({
  EXATA: 'EXATA',
  COMPATIVEL: 'COMPATIVEL',
  PARCIAL: 'PARCIAL',
  INCOMPATIVEL: 'INCOMPATIVEL'
});

module.exports = {
  PESOS_MATCHING,
  PONTOS_DATA,
  JANELA_DIAS_MATCHING,
  LIMIARES_CONFIANCA,
  NIVEL_CONFIANCA,
  STATUS_SUGESTAO,
  RESULTADO_MATCHING,
  COMPATIBILIDADE_MATCHING
};
