/**
 * Consulta de insumos comercializáveis para o Pedido.
 *
 * CDS-INSUMOS-PRODUTO-COMERCIALIZAVEL-01:
 * - Somente INSUMO com comercializavel = 1 entra na busca de venda direta.
 * - Preço = preco_venda cadastrado (nunca preco_compra).
 *
 * Não altera o motor de composição nem cria vínculo insumo → copo comercial.
 */
'use strict';

const { TipoOperacionalProduto } = require('../produtos/tipoOperacionalProduto');

const CATEGORIAS_REFRIGERANTE = new Set(['REFRIGERANTES', 'REFRIGERANTE']);

function erro(codigo, mensagem, statusCode = 400) {
  const err = new Error(mensagem);
  err.code = codigo;
  err.statusCode = statusCode;
  return err;
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function normalizarNomeCategoria(nome) {
  return String(nome || '').trim().toUpperCase();
}

function ehCategoriaRefrigerante(nome) {
  return CATEGORIAS_REFRIGERANTE.has(normalizarNomeCategoria(nome));
}

/**
 * Adapta insumo comercializável ao contrato da UI do Pedido.
 */
function adaptarInsumoRefrigeranteParaPedido(row) {
  if (!row || !Number.isInteger(Number(row.id)) || Number(row.id) <= 0) {
    throw erro('INSUMO_COMERCIALIZAVEL_INVALIDO', 'Registro de insumo comercializável inválido.');
  }
  const tipo = String(row.tipo_operacional || '').trim().toUpperCase();
  if (tipo !== TipoOperacionalProduto.INSUMO) {
    throw erro(
      'ORIGEM_NAO_INSUMO',
      'Somente insumos podem ser adaptados como item operacional do Pedido.'
    );
  }
  if (Number(row.comercializavel) !== 1) {
    throw erro(
      'INSUMO_NAO_COMERCIALIZAVEL',
      'O insumo não está marcado como produto comercializável.'
    );
  }

  const volumeConfigurado = Number(row.utiliza_volume) === 1
    && Number(row.volume_valor) > 0
    && Boolean(String(row.volume_unidade || '').trim());

  const precoVenda = Number(row.preco_venda);
  const precoSeguro = Number.isFinite(precoVenda) && precoVenda > 0 ? precoVenda : 0;

  return {
    id: Number(row.id),
    codigo: row.codigo != null ? String(row.codigo) : null,
    nome: row.nome != null ? String(row.nome) : '',
    nome_comercial: null,
    unidade: row.unidade != null ? String(row.unidade) : null,
    tipo_operacional: TipoOperacionalProduto.INSUMO,
    classificacao_operacional: TipoOperacionalProduto.INSUMO,
    origem_cadastro: 'INSUMO',
    comercializavel: 1,
    categoria_id: row.categoria_id != null ? Number(row.categoria_id) : null,
    categoria_nome: row.categoria_nome != null ? String(row.categoria_nome) : null,
    categoria: row.categoria_nome != null ? String(row.categoria_nome) : '',
    marca_id: row.marca_id != null ? Number(row.marca_id) : null,
    marca_nome: row.marca_nome != null ? String(row.marca_nome) : null,
    utiliza_volume: volumeConfigurado ? 1 : Number(row.utiliza_volume || 0) ? 1 : 0,
    volume_valor: volumeConfigurado ? Number(row.volume_valor) : (row.volume_valor != null ? Number(row.volume_valor) : null),
    volume_unidade: volumeConfigurado
      ? String(row.volume_unidade).trim()
      : (row.volume_unidade != null ? String(row.volume_unidade) : null),
    // Nunca usar preco_compra como preço de venda.
    preco_venda: precoSeguro,
    preco_promocional: null,
    preco_pedido: null,
    ativo: Number(row.ativo) === 1 ? 1 : 0
  };
}

/**
 * Busca insumos comercializáveis no catálogo (mesma tabela `produtos`).
 */
async function buscarRefrigerantesInsumos({ db, termo, limite = 15 } = {}) {
  if (!db) {
    throw erro('DB_OBRIGATORIO', 'A consulta de insumos comercializáveis exige conexão de banco.', 500);
  }
  const q = String(termo || '').trim();
  if (!q) return [];

  const lim = Math.min(Math.max(parseInt(limite, 10) || 15, 1), 20);
  const like = `%${q.replace(/%/g, '')}%`;
  const likePrefix = `${q.replace(/%/g, '')}%`;

  const rows = await dbAll(
    db,
    `SELECT p.id, p.codigo, p.nome, p.unidade, p.ativo, p.categoria_id, p.marca_id,
            p.utiliza_volume, p.volume_valor, p.volume_unidade, p.preco_venda,
            COALESCE(p.comercializavel, 0) AS comercializavel,
            COALESCE(p.tipo_operacional, 'COMERCIAL') AS tipo_operacional,
            c.nome AS categoria_nome,
            m.nome AS marca_nome
       FROM produtos p
       LEFT JOIN categorias c ON c.id = p.categoria_id
       LEFT JOIN marcas m ON m.id = p.marca_id
      WHERE COALESCE(p.tipo_operacional, 'COMERCIAL') = ?
        AND COALESCE(p.ativo, 1) = 1
        AND COALESCE(p.comercializavel, 0) = 1
        AND (
          p.codigo = ?
          OR p.codigo LIKE ?
          OR p.nome LIKE ?
          OR IFNULL(m.nome, '') LIKE ?
        )
      ORDER BY
        CASE WHEN p.codigo = ? THEN 0
             WHEN p.codigo LIKE ? THEN 1
             ELSE 2 END,
        p.nome
      LIMIT ?`,
    [
      TipoOperacionalProduto.INSUMO,
      q,
      likePrefix,
      like,
      like,
      q,
      likePrefix,
      lim
    ]
  );

  return rows.map(adaptarInsumoRefrigeranteParaPedido);
}

module.exports = {
  CATEGORIAS_REFRIGERANTE,
  ehCategoriaRefrigerante,
  adaptarInsumoRefrigeranteParaPedido,
  buscarRefrigerantesInsumos,
  // Alias semântico da sprint
  buscarInsumosComercializaveis: buscarRefrigerantesInsumos,
  adaptarInsumoComercializavelParaPedido: adaptarInsumoRefrigeranteParaPedido
};
