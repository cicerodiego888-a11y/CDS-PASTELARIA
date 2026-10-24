/**
 * Classificação operacional do produto no catálogo compartilhado (Sprint 03.03).
 * Não cria produto_empresa. Default COMERCIAL preserva o legado vendável.
 *
 * @module services/produtos/tipoOperacionalProduto
 */
'use strict';

const TipoOperacionalProduto = Object.freeze({
  COMERCIAL: 'COMERCIAL',
  INSUMO: 'INSUMO'
});

const DDL_TIPO_OPERACIONAL = `ALTER TABLE produtos ADD COLUMN tipo_operacional TEXT NOT NULL DEFAULT 'COMERCIAL'`;

function normalizarTipoOperacional(valor) {
  const raw = String(valor == null ? '' : valor).trim().toUpperCase();
  if (!raw) return TipoOperacionalProduto.COMERCIAL;
  if (raw === TipoOperacionalProduto.COMERCIAL || raw === 'PRODUTO_COMERCIAL' || raw === 'PRODUTO') {
    return TipoOperacionalProduto.COMERCIAL;
  }
  if (raw === TipoOperacionalProduto.INSUMO) return TipoOperacionalProduto.INSUMO;
  const err = new Error('tipo_operacional inválido. Use COMERCIAL ou INSUMO.');
  err.code = 'TIPO_OPERACIONAL_INVALIDO';
  err.statusCode = 400;
  throw err;
}

function produtoEhVendavelPdv(produto) {
  if (!produto) return false;
  return normalizarTipoOperacional(produto.tipo_operacional) === TipoOperacionalProduto.COMERCIAL;
}

function sqlFiltroProdutoVendavelPdv(alias = 'p') {
  return ` AND COALESCE(${alias}.tipo_operacional, 'COMERCIAL') <> 'INSUMO'`;
}

function origemPdvExigeVendavel(origem) {
  const o = String(origem || '').toLowerCase();
  return o === 'pdv' || o === 'pdv_apos_motor_equipamentos';
}

function consultaSomenteVendaveis(req) {
  const q = (req && req.query) || {};
  if (q.somente_vendaveis === '1' || q.somente_vendaveis === 'true') return true;
  return origemPdvExigeVendavel(q.origem);
}

function filtrarItensVendaveisPdv(itens) {
  return (itens || []).filter((p) => produtoEhVendavelPdv(p));
}

function exigirProdutosVendaveisNaVenda(produtos) {
  const insumo = (produtos || []).find((p) => !produtoEhVendavelPdv(p));
  if (!insumo) return;
  const err = new Error(
    `Insumo não pode ser vendido no PDV (produto ${insumo.id}${insumo.nome ? ` — ${insumo.nome}` : ''}).`
  );
  err.code = 'INSUMO_NAO_VENDAVEL';
  err.statusCode = 400;
  throw err;
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

async function produtoIdEhVendavelPdv(db, produtoId) {
  const id = Number(produtoId);
  if (!db || !Number.isInteger(id) || id <= 0) return true;
  const row = await dbGet(
    db,
    `SELECT COALESCE(tipo_operacional, 'COMERCIAL') AS tipo_operacional FROM produtos WHERE id = ?`,
    [id]
  );
  if (!row) return true;
  return produtoEhVendavelPdv(row);
}

async function garantirConversaoInsumoSemReferencias(db, produtoId) {
  const id = Number(produtoId);
  if (!db || !Number.isInteger(id) || id <= 0) {
    throw new Error('db e produtoId válidos são obrigatórios para validar a conversão.');
  }

  const referencias = [
    ['ficha_tecnica', 'produto_id'],
    ['ficha_tecnica_itens', 'insumo_id'],
    ['estoque_empresa', 'produto_id'],
    ['compras_itens', 'produto_id'],
    ['vendas_itens', 'produto_id'],
    ['produtos_ajustes_estoque', 'produto_id'],
    ['movimentos_transferencia_saldos', 'produto_id'],
    ['pedido_estoque_reservas', 'produto_id'],
    ['venda_estoque_reservas', 'produto_id'],
    ['produtos_lotes', 'produto_id'],
    ['produto_identificadores', 'produto_id'],
    ['produto_atacado', 'produto_id'],
    ['produto_embalagens', 'produto_id'],
    ['muc_produto_relacoes', 'produto_id'],
    ['muc_auditoria_conversao', 'produto_id'],
    ['muc_aprendizado', 'produto_id'],
    ['produto_balanca_sync_log', 'produto_id']
  ];

  for (const [tabela, coluna] of referencias) {
    const existe = await dbGet(
      db,
      `SELECT 1 AS existe FROM sqlite_master WHERE type = 'table' AND name = ?`,
      [tabela]
    );
    if (!existe) continue;

    const referencia = await dbGet(
      db,
      `SELECT 1 AS existe FROM ${tabela} WHERE ${coluna} = ? LIMIT 1`,
      [id]
    );
    if (referencia) {
      const err = new Error(
        'Conversão de insumo bloqueada: o registro possui referências em fichas técnicas ou operações. Mantenha-o como insumo.'
      );
      err.code = 'INSUMO_REFERENCIADO_NAO_CONVERSIVEL';
      err.statusCode = 409;
      throw err;
    }
  }
}

function garantirColunaTipoOperacional(db, callback) {
  const done = typeof callback === 'function' ? callback : () => {};
  if (!db) return done(new Error('db obrigatório'));
  db.run(DDL_TIPO_OPERACIONAL, (err) => {
    if (err && !/duplicate column/i.test(String(err.message || ''))) {
      return done(err);
    }
    done(null);
  });
}

function garantirColunaTipoOperacionalAsync(db) {
  return new Promise((resolve, reject) => {
    garantirColunaTipoOperacional(db, (err) => (err ? reject(err) : resolve()));
  });
}

module.exports = {
  TipoOperacionalProduto,
  DDL_TIPO_OPERACIONAL,
  normalizarTipoOperacional,
  produtoEhVendavelPdv,
  sqlFiltroProdutoVendavelPdv,
  origemPdvExigeVendavel,
  consultaSomenteVendaveis,
  filtrarItensVendaveisPdv,
  exigirProdutosVendaveisNaVenda,
  produtoIdEhVendavelPdv,
  garantirConversaoInsumoSemReferencias,
  garantirColunaTipoOperacional,
  garantirColunaTipoOperacionalAsync
};
