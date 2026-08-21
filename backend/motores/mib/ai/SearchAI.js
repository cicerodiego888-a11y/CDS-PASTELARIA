'use strict';

const { tokenizar } = require('../core/tokenizer');
const { levenshtein, similaridade } = require('../core/levenshtein');
const { normalizarNomeBusca } = require('../core/normalizarNomeBusca');

/**
 * SearchAI — correção, abreviações, apelidos e sugestões.
 * Base para integração futura com MIIP.
 */
class SearchAI {
  /**
   * @param {{
   *   sinonimos: import('../core/SinonimosService'),
   *   learning: import('../core/LearningEngine'),
   *   catalog: import('../catalog/CatalogMemory'),
   *   config: import('../config/MibConfig')
   * }} deps
   */
  constructor(deps) {
    this.sinonimos = deps.sinonimos;
    this.learning = deps.learning;
    this.catalog = deps.catalog;
    this.config = deps.config;
  }

  maxDistancia() {
    return Math.max(1, Number(this.config.get('sensibilidadeLevenshtein')) || 2);
  }

  /**
   * Interpreta termo: tokens, sinônimos, preferência do operador.
   */
  interpretar(termo, contexto = {}) {
    const tok = tokenizar(termo);
    const tokensExpandidos = this.config.get('ativarSinonimos')
      ? this.sinonimos.expandir(tok.tokensNorm)
      : tok.tokensNorm;

    const preferido = this.config.get('ativarAprendizado')
      ? this.learning.preferenciaProduto(tok.normalizado, contexto.operador_id)
      : null;

    return {
      ...tok,
      tokensExpandidos,
      preferidoId: preferido,
      abreviacao: tok.tokensNorm.length === 1 && tok.tokensNorm[0].length <= 5
    };
  }

  /**
   * Busca fuzzy no snapshot do catálogo (limitada para performance).
   * @returns {{ itens: object[], sugestoes: string[] }}
   */
  buscarFuzzy(termoNorm, opcoes = {}) {
    if (!this.config.get('ativarFuzzy')) {
      return { itens: [], sugestoes: [] };
    }
    const maxDist = this.maxDistancia();
    const limite = Math.min(Math.max(Number(opcoes.limite) || 20, 1), 40);
    const modoFiscal = opcoes.modoFiscal === true;
    const snapshot = this.catalog.ativo ? this.catalog.ativo() : null;
    const lista = snapshot?.lista || [];
    const out = [];
    const sugestoes = new Set();

    // amostra: prefixo aproximado (1ª letra) + janelas de tamanho do termo
    const candidatos = [];
    const first = termoNorm.slice(0, 1);
    for (const p of lista) {
      if (modoFiscal && Number(p.item_fiscal) !== 1) continue;
      const nb = p.nome_busca || '';
      if (!nb) continue;
      // evita scan total: mesma inicial OU tamanho próximo OU contém 2 primeiras letras
      const pref2 = termoNorm.slice(0, Math.min(2, termoNorm.length));
      const sameStart = first && nb[0] === first;
      const nearLen = Math.abs(nb.length - termoNorm.length) <= maxDist + 6;
      const softPref = pref2.length >= 2 && nb.includes(pref2);
      if (!sameStart && !nearLen && !softPref) continue;
      candidatos.push(p);
      if (candidatos.length >= 4000) break;
    }

    for (const p of candidatos) {
      const nb = p.nome_busca || '';
      let d = Infinity;
      const lens = new Set([
        termoNorm.length,
        termoNorm.length + 1,
        Math.max(1, termoNorm.length - 1),
        termoNorm.length + maxDist
      ]);
      for (const len of lens) {
        d = Math.min(d, levenshtein(termoNorm, nb.slice(0, len)));
      }
      if (nb.length <= termoNorm.length + 4) {
        d = Math.min(d, levenshtein(termoNorm, nb));
      }
      // tokens do nome original (espaços) — cobre "COKA" ↔ "COCA" em "COCA COLA 2L"
      const nomeTok = String(p.nome || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3);
      for (const tok of nomeTok) {
        d = Math.min(d, levenshtein(termoNorm, tok));
      }

      if (d <= maxDist || similaridade(termoNorm, nb.slice(0, termoNorm.length)) >= 0.72) {
        out.push({
          ...p,
          preco_venda: p.preco,
          _matchTipo: { fuzzy: true },
          _fuzzyDist: d,
          match_exato: 0
        });
        if (p.nome) sugestoes.add(p.nome);
      }
      if (out.length >= limite * 3) break;
    }

    out.sort((a, b) => (a._fuzzyDist || 9) - (b._fuzzyDist || 9));
    return {
      itens: out.slice(0, limite),
      sugestoes: [...sugestoes].slice(0, 5)
    };
  }

  /**
   * Filtra catálogo por tokens/sinônimos.
   */
  buscarPorTokens(tokensExpandidos, opcoes = {}) {
    if (!tokensExpandidos?.length) return [];
    const limite = Math.min(Math.max(Number(opcoes.limite) || 20, 1), 50);
    const modoFiscal = opcoes.modoFiscal === true;
    const snapshot = this.catalog.ativo ? this.catalog.ativo() : null;
    const lista = snapshot?.lista || [];
    const out = [];

    for (const p of lista) {
      if (modoFiscal && Number(p.item_fiscal) !== 1) continue;
      const nb = p.nome_busca || '';
      let hits = 0;
      let sinonimo = false;
      for (const t of tokensExpandidos) {
        if (t && nb.includes(t)) {
          hits += 1;
          // se token não está no termo original compactado, veio de sinônimo
          if (opcoes.tokensOriginais && !opcoes.tokensOriginais.includes(t)) {
            sinonimo = true;
          }
        }
      }
      if (hits > 0) {
        out.push({
          ...p,
          preco_venda: p.preco,
          _matchTipo: { sinonimo, tokens: hits },
          match_exato: 0
        });
      }
      if (out.length >= limite * 4) break;
    }
    return out;
  }

  /**
   * "Você quis dizer..." quando não há resultados.
   */
  sugerirCorrecao(termo, fuzzyResult) {
    if (!this.config.get('ativarAutoCorrecao')) {
      return { mensagem: null, sugestoes: [] };
    }
    const sugestoes = fuzzyResult?.sugestoes || [];
    if (!sugestoes.length) {
      // histórico
      const top = this.learning.topSearches(5).map((t) => t.termo);
      if (!top.length) return { mensagem: null, sugestoes: [] };
      return {
        mensagem: 'Você quis dizer...',
        sugestoes: top
      };
    }
    this.learning.correcoes += 1;
    return {
      mensagem: 'Você quis dizer...',
      sugestoes
    };
  }

  /**
   * Expande termo único via sinônimo para busca.
   */
  termoViaSinonimo(termoNorm) {
    const exp = this.sinonimos.expandir([termoNorm]);
    return exp.filter((t) => t !== termoNorm);
  }
}

module.exports = SearchAI;
