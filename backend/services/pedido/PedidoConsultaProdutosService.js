/**
 * Consulta de produtos para o Pedido:
 * - Itens comerciais (exceto refrigerante de copo): mesma fonte MIB/PDV vendável.
 * - Insumos comercializáveis (flag comercializavel=1): catálogo de INSUMOS.
 *
 * Não altera o motor de composição nem a consulta do PDV (`consulta-pdv`).
 */
'use strict';

const {
  ehCategoriaRefrigerante,
  buscarRefrigerantesInsumos
} = require('./PedidoRefrigeranteInsumoConsultaService');

function erro(codigo, mensagem, statusCode = 400) {
  const err = new Error(mensagem);
  err.code = codigo;
  err.statusCode = statusCode;
  return err;
}

function categoriaDoItem(item) {
  return item?.categoria_nome || item?.categoria || '';
}

/**
 * Remove refrigerantes comerciais da lista MIB — a origem operacional passa a ser INSUMO.
 */
function filtrarComerciaisSemRefrigerante(itens) {
  return (itens || []).filter((item) => !ehCategoriaRefrigerante(categoriaDoItem(item)));
}

function deduplicarPorId(...listas) {
  const vistos = new Set();
  const saida = [];
  for (const lista of listas) {
    for (const item of lista || []) {
      const id = Number(item && item.id);
      if (!Number.isInteger(id) || id <= 0 || vistos.has(id)) continue;
      vistos.add(id);
      saida.push(item);
    }
  }
  return saida;
}

/**
 * @param {object} params
 * @param {object} params.db
 * @param {string} params.termo
 * @param {number} [params.limite]
 * @param {function} params.buscarComerciaisPdv — async ({ termo, limite }) => itens[]
 */
async function buscarProdutosParaPedido({
  db,
  termo,
  limite = 15,
  buscarComerciaisPdv
} = {}) {
  if (!db) {
    throw erro('DB_OBRIGATORIO', 'A consulta do Pedido exige conexão de banco.', 500);
  }
  if (typeof buscarComerciaisPdv !== 'function') {
    throw erro('BUSCA_COMERCIAL_OBRIGATORIA', 'A busca comercial do Pedido não foi fornecida.', 500);
  }

  const q = String(termo || '').trim();
  if (!q) return [];

  const lim = Math.min(Math.max(parseInt(limite, 10) || 15, 1), 20);

  const [comerciaisBrutos, refrigerantesInsumo] = await Promise.all([
    buscarComerciaisPdv({ termo: q, limite: lim }),
    buscarRefrigerantesInsumos({ db, termo: q, limite: lim })
  ]);

  const comerciais = filtrarComerciaisSemRefrigerante(comerciaisBrutos);
  // Prioriza refrigerantes operacionais (insumo) e completa com demais comerciais.
  const mesclado = deduplicarPorId(refrigerantesInsumo, comerciais);
  return mesclado.slice(0, lim);
}

module.exports = {
  filtrarComerciaisSemRefrigerante,
  buscarProdutosParaPedido
};
