/**
 * Busca read-only de produtos para Contagem Física — CDS-ESTOQUE-CONTAGEM-UX-PERMISSOES-05.1.
 *
 * Campos oficiais do cadastro: nome, codigo (código interno), codigo_barras.
 * Não usa filtro PDV (não exclui INSUMO). Não movimenta estoque.
 *
 * @module services/estoque/EstoqueContagemProdutoBuscaService
 */
'use strict';

const {
  obterMetadadosConversaoProduto
} = require('./EstoqueContagemConversaoService');

const LIMITE_PADRAO = 20;
const LIMITE_MAX = 40;

function erroBusca(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function normalizarTermo(valor) {
  return String(valor == null ? '' : valor).trim();
}

/**
 * @param {object} db
 * @param {string} termoBruto
 * @param {{ limite?: number }} [opts]
 */
async function buscarProdutosParaContagem(db, termoBruto, opts = {}) {
  if (!db) throw erroBusca('DB_OBRIGATORIO', 'db é obrigatório.', 500);
  const termo = normalizarTermo(termoBruto);
  if (!termo) {
    return { ok: true, termo: '', total: 0, itens: [] };
  }
  if (termo.length < 1) {
    return { ok: true, termo, total: 0, itens: [] };
  }

  let limite = Number(opts.limite != null ? opts.limite : LIMITE_PADRAO);
  if (!Number.isInteger(limite) || limite <= 0) limite = LIMITE_PADRAO;
  if (limite > LIMITE_MAX) limite = LIMITE_MAX;

  const like = `%${termo.replace(/%/g, '').replace(/_/g, '')}%`;
  const termoUpper = termo.toUpperCase();

  let rows;
  try {
    rows = await dbAll(
      db,
      `SELECT p.id, p.nome, p.codigo, p.codigo_barras,
              COALESCE(p.unidade_comercial, p.unidade, 'UN') AS unidade,
              COALESCE(p.tipo_operacional, 'COMERCIAL') AS tipo_operacional,
              COALESCE(p.ativo, 1) AS ativo
         FROM produtos p
        WHERE (
              UPPER(COALESCE(p.nome, '')) LIKE UPPER(?)
           OR UPPER(COALESCE(p.nome_busca, '')) LIKE UPPER(?)
           OR UPPER(COALESCE(p.codigo, '')) = ?
           OR UPPER(COALESCE(p.codigo, '')) LIKE UPPER(?)
           OR COALESCE(p.codigo_barras, '') = ?
           OR COALESCE(p.codigo_barras, '') LIKE ?
        )
          AND COALESCE(p.ativo, 1) = 1
        ORDER BY
          CASE
            WHEN COALESCE(p.codigo_barras, '') = ? THEN 0
            WHEN UPPER(COALESCE(p.codigo, '')) = ? THEN 1
            WHEN UPPER(COALESCE(p.nome, '')) LIKE UPPER(?) THEN 2
            ELSE 3
          END,
          p.nome COLLATE NOCASE ASC
        LIMIT ?`,
      [
        like,
        like,
        termoUpper,
        like,
        termo,
        like,
        termo,
        termoUpper,
        `${termo}%`,
        limite
      ]
    );
  } catch (err) {
    if (/no such table/i.test(String(err && err.message || ''))) {
      return { ok: true, termo, total: 0, itens: [] };
    }
    throw erroBusca(
      'BUSCA_PRODUTOS_FALHOU',
      'Não foi possível pesquisar produtos para contagem.',
      503
    );
  }

  const itens = [];
  for (const row of rows) {
    const base = {
      id: Number(row.id),
      produto_id: Number(row.id),
      nome: row.nome || '',
      codigo: row.codigo || null,
      codigo_interno: row.codigo || null,
      codigo_barras: row.codigo_barras || null,
      unidade: row.unidade || 'UN',
      unidade_comercial: row.unidade || 'UN',
      unidade_base: null,
      utiliza_conversao: false,
      fator_conversao: null,
      apresentacao_id: null,
      tipo_operacional: row.tipo_operacional || 'COMERCIAL'
    };
    try {
      const meta = await obterMetadadosConversaoProduto(db, row.id);
      if (meta) {
        base.unidade_comercial = meta.unidade_comercial || base.unidade;
        base.unidade = base.unidade_comercial;
        base.unidade_base = meta.unidade_base || null;
        base.utiliza_conversao = !!meta.utiliza_conversao;
        base.fator_conversao = meta.fator_conversao;
        base.apresentacao_id = meta.apresentacao_id;
      }
    } catch (_) { /* busca não deve falhar por metadado */ }
    itens.push(base);
  }

  return {
    ok: true,
    termo,
    total: itens.length,
    itens
  };
}

module.exports = {
  buscarProdutosParaContagem,
  LIMITE_PADRAO,
  LIMITE_MAX
};
