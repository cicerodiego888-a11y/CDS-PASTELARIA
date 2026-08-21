'use strict';

const { contarTokensMatch } = require('./tokenizer');

const SCORES = Object.freeze({
  CODIGO_EXATO: 100,
  CODIGO_BARRAS: 95,
  PLU: 90,
  PREFIXO: 80,
  REFERENCIA: 70,
  MARCA: 60,
  HISTORICO: 50,
  OPERADOR: 40,
  FILIAL: 30,
  NOME_CONTEM: 40,
  MAIS_VENDIDO: 20,
  ULTIMA_VENDA: 15,
  FAVORITO: 10,
  FUZZY: 8,
  SINONIMO: 5,
  TOKEN: 6
});

/**
 * Ranking adaptativo RC2.0 —
 * Score base + histórico + operador + filial + frequência + fuzzy/sinônimo.
 */
class RankingEngine {
  /**
   * @param {import('./LearningEngine')|null} learningEngine
   */
  constructor(learningEngine = null) {
    this.learning = learningEngine;
  }

  /**
   * @param {object} produto
   * @param {object} ctx
   */
  pontuar(produto, ctx = {}) {
    if (!produto) return 0;
    let score = 0;

    const termo = String(ctx.termoNorm || '');
    const raw = String(ctx.termoRaw || '').trim();
    const rawLower = raw.toLowerCase();
    const tokensNorm = ctx.tokensNorm || [];
    const tokensExpandidos = ctx.tokensExpandidos || tokensNorm;
    const estrategia = ctx.estrategia;
    const matchTipo = ctx.matchTipo || {};

    const codigo = String(produto.codigo || '').toLowerCase();
    const barras = String(produto.codigo_barras || '').toLowerCase();
    const plu = String(produto.plu || '').toLowerCase();
    const nomeBusca = String(produto.nome_busca || '');

    if (codigo && (codigo === rawLower || codigo === termo)) {
      score = Math.max(score, SCORES.CODIGO_EXATO);
    }
    if (barras && (barras === rawLower || barras === termo)) {
      score = Math.max(score, SCORES.CODIGO_BARRAS);
    }
    if (plu && (plu === rawLower || plu === termo)) {
      score = Math.max(score, SCORES.PLU);
    }
    if (termo && nomeBusca.startsWith(termo)) {
      score = Math.max(score, SCORES.PREFIXO);
    } else if (termo && nomeBusca.includes(termo)) {
      score = Math.max(score, SCORES.NOME_CONTEM);
    }
    if (codigo && rawLower && codigo.startsWith(rawLower) && codigo !== rawLower) {
      score = Math.max(score, SCORES.REFERENCIA);
    }

    const tokensHit = contarTokensMatch(produto, tokensExpandidos);
    if (tokensHit > 0) {
      score += Math.min(30, tokensHit * SCORES.TOKEN);
    }

    if (matchTipo.fuzzy) score += SCORES.FUZZY;
    if (matchTipo.sinonimo) score += SCORES.SINONIMO;
    if (Number(produto.match_exato) === 1) {
      score = Math.max(score, SCORES.CODIGO_EXATO);
    }
    if (estrategia === 'preferencia') score += SCORES.OPERADOR;

    if (this.learning) {
      const id = Number(produto.id);
      const ctxScore = this.learning.scoreContextual(id, termo, {
        operador_id: ctx.operador_id,
        filial_id: ctx.filial_id
      });
      score += ctxScore.historico;
      score += ctxScore.operador;
      score += ctxScore.filial;

      if (this.learning.isFavorito(id)) score += SCORES.FAVORITO;
      if (this.learning.isMaisVendido(id)) score += SCORES.MAIS_VENDIDO;
      if (this.learning.isUltimaVenda(id)) score += SCORES.ULTIMA_VENDA;

      const pref = this.learning.preferenciaProduto(termo, ctx.operador_id);
      if (pref && pref === id) score += SCORES.OPERADOR;
    }

    return score;
  }

  /**
   * @param {object[]} itens
   * @param {object} ctx
   */
  ordenar(itens, ctx = {}) {
    // compat: ordenar(itens, termoNorm, termoRaw, estrategia)
    if (typeof ctx === 'string') {
      ctx = {
        termoNorm: arguments[1],
        termoRaw: arguments[2],
        estrategia: arguments[3]
      };
    }

    const lista = (itens || []).map((p) => ({
      ...p,
      mib_score: this.pontuar(p, {
        ...ctx,
        matchTipo: p._matchTipo || ctx.matchTipo || {}
      })
    }));

    lista.sort((a, b) => {
      if (b.mib_score !== a.mib_score) return b.mib_score - a.mib_score;
      return String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR');
    });
    return lista;
  }
}

RankingEngine.SCORES = SCORES;

module.exports = RankingEngine;
