/**
 * Indicadores operacionais do MIS — sempre com empresa_id na entidade dona.
 * Não consolida empresas. Não usa saldo global de produtos para estoque empresarial.
 *
 * @module services/mis/MisIndicadoresService
 */
'use strict';

const {
  FILTRO_VENDA_VALIDA,
  getExprValorVenda,
  isModoFiscalRelatorio,
  sqlRankingProdutosDaEmpresa
} = require('../reportFiscalHelpers');
const EstoqueEmpresaService = require('../estoque/EstoqueEmpresaService');
const { listarDiasIso } = require('./misPeriodo');

function exigirEmpresaId(empresaId) {
  const id = Number(empresaId);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('empresa_id é obrigatório para indicador do MIS.');
    err.code = 'EMPRESA_OBRIGATORIA';
    err.statusCode = 400;
    throw err;
  }
  return id;
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || {})));
  });
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Data oficial: vendas.data_venda. */
async function faturamentoPorEmpresa(params = {}) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const db = params.db;
  const expr = getExprValorVenda(params.modoFiscal || '0');
  const row = await dbGet(
    db,
    `SELECT
        COALESCE(SUM(${expr}), 0) AS faturamento,
        COUNT(v.id) AS total_vendas,
        COALESCE(AVG(${expr}), 0) AS ticket_medio
      FROM vendas v
      WHERE ${FILTRO_VENDA_VALIDA}
        AND v.empresa_id = ?
        AND date(v.data_venda) BETWEEN date(?) AND date(?)`,
    [empresaId, params.inicio, params.fim]
  );
  return {
    empresa_id: empresaId,
    periodo: { inicio: params.inicio, fim: params.fim, campo: 'data_venda' },
    faturamento: num(row.faturamento),
    total_vendas: num(row.total_vendas),
    ticket_medio: num(row.ticket_medio)
  };
}

/** Série diária com os mesmos filtros oficiais de faturamentoPorEmpresa. Dias sem venda = 0. */
async function faturamentoDiarioPorEmpresa(params = {}) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const db = params.db;
  const inicio = params.inicio;
  const fim = params.fim;
  const expr = getExprValorVenda(params.modoFiscal || '0');
  const rows = await dbAll(
    db,
    `SELECT
        date(v.data_venda) AS data,
        COALESCE(SUM(${expr}), 0) AS faturamento,
        COUNT(v.id) AS total_vendas
      FROM vendas v
      WHERE ${FILTRO_VENDA_VALIDA}
        AND v.empresa_id = ?
        AND date(v.data_venda) BETWEEN date(?) AND date(?)
      GROUP BY date(v.data_venda)`,
    [empresaId, inicio, fim]
  );
  const mapa = Object.create(null);
  for (const r of rows) {
    mapa[String(r.data)] = {
      faturamento: num(r.faturamento),
      total_vendas: num(r.total_vendas)
    };
  }
  const serie = listarDiasIso(inicio, fim).map((data) => {
    const dia = mapa[data] || { faturamento: 0, total_vendas: 0 };
    return {
      data,
      faturamento: dia.faturamento,
      total_vendas: dia.total_vendas
    };
  });
  return {
    empresa_id: empresaId,
    periodo: { inicio, fim, campo: 'data_venda' },
    serie
  };
}

async function rankingProdutosPorEmpresa(params = {}) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const db = params.db;
  const limite = Math.min(Math.max(Number(params.limite) || 10, 1), 100);
  const sql = sqlRankingProdutosDaEmpresa(params.modoFiscal || '0');
  const rows = await dbAll(
    db,
    `${sql}
     HAVING quantidade_vendida > 0
     ORDER BY quantidade_vendida DESC
     LIMIT ?`,
    [params.inicio, params.fim, empresaId, limite]
  );
  return {
    empresa_id: empresaId,
    periodo: { inicio: params.inicio, fim: params.fim, campo: 'data_venda' },
    produtos: rows.map((r) => ({
      id: r.id,
      nome: r.nome,
      quantidade_vendida: num(r.quantidade_vendida)
    }))
  };
}

async function estoqueProdutoPorEmpresa(params = {}) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const iso = await EstoqueEmpresaService.consultarSaldoParaEmpresa({
    produtoId: params.produtoId,
    empresaId,
    db: params.db
  }, { db: params.db });
  return {
    empresa_id: empresaId,
    produto_id: Number(params.produtoId),
    estoque_atual: iso ? num(iso.estoqueAtual) : 0,
    origem: 'estoque_empresa'
  };
}

/** Data oficial: COALESCE(data_compra, data_entrada, data_emissao). */
async function comprasPorEmpresa(params = {}) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const db = params.db;
  const row = await dbGet(
    db,
    `SELECT COALESCE(SUM(COALESCE(c.total, 0)), 0) AS total,
            COUNT(c.id) AS quantidade
     FROM compras c
     WHERE c.empresa_id = ?
       AND date(c.data_compra) BETWEEN date(?) AND date(?)`,
    [empresaId, params.inicio, params.fim]
  );
  return {
    empresa_id: empresaId,
    periodo: {
      inicio: params.inicio,
      fim: params.fim,
      campo: 'data_compra'
    },
    total: num(row.total),
    quantidade: num(row.quantidade)
  };
}

async function financeiroReceberPorEmpresa(params = {}) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const db = params.db;
  const row = await dbGet(
    db,
    `SELECT COALESCE(SUM(valor_restante), 0) AS total, COUNT(*) AS quantidade
     FROM contas_receber
     WHERE empresa_id = ?
       AND status IN ('aberto', 'parcial')`,
    [empresaId]
  );
  return {
    empresa_id: empresaId,
    periodo: { campo: 'saldo em aberto (sem data de competência neste indicador)' },
    total: num(row.total),
    quantidade: num(row.quantidade)
  };
}

/** Data oficial: nfce_notas.data_emissao ou created_at. */
async function fiscalNfcePorEmpresa(params = {}) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const db = params.db;
  const row = await dbGet(
    db,
    `SELECT COUNT(n.id) AS quantidade, COALESCE(SUM(COALESCE(v.total, 0)), 0) AS total
     FROM nfce_notas n
     INNER JOIN vendas v ON v.id = n.venda_id
     WHERE v.empresa_id = ?
       AND date(COALESCE(n.created_at, v.data_venda)) BETWEEN date(?) AND date(?)`,
    [empresaId, params.inicio, params.fim]
  );
  return {
    empresa_id: empresaId,
    periodo: { inicio: params.inicio, fim: params.fim, campo: 'COALESCE(nfce.created_at, venda.data_venda)' },
    quantidade: num(row.quantidade),
    total: num(row.total)
  };
}

/**
 * Estoque crítico da empresa (estoque_empresa).
 * Não lê produtos.estoque_atual. Sem N+1.
 */
async function estoqueCriticoPorEmpresa(params = {}) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const db = params.db;
  const limite = Math.min(Math.max(Number(params.limite) || 10, 1), 50);
  const expr = isModoFiscalRelatorio(params.modoFiscal || '0')
    ? 'COALESCE(ee.saldo_fiscal, 0)'
    : 'COALESCE(ee.estoque_atual, 0)';
  const rows = await dbAll(
    db,
    `SELECT
        p.id,
        p.nome,
        ${expr} AS estoque,
        COALESCE(p.estoque_minimo, 0) AS estoque_minimo
     FROM estoque_empresa ee
     INNER JOIN produtos p ON p.id = ee.produto_id
     WHERE ee.empresa_id = ?
       AND COALESCE(p.estoque_minimo, 0) > 0
       AND ${expr} <= p.estoque_minimo
     ORDER BY (${expr} * 1.0 / p.estoque_minimo) ASC, ${expr} ASC, p.nome ASC
     LIMIT ?`,
    [empresaId, limite]
  );
  return {
    empresa_id: empresaId,
    origem: 'estoque_empresa',
    produtos: rows.map((r) => {
      const estoque = num(r.estoque);
      const estoque_minimo = num(r.estoque_minimo);
      return {
        id: r.id,
        nome: r.nome,
        estoque,
        estoque_minimo,
        diferenca: estoque - estoque_minimo
      };
    })
  };
}

module.exports = {
  exigirEmpresaId,
  faturamentoPorEmpresa,
  faturamentoDiarioPorEmpresa,
  rankingProdutosPorEmpresa,
  estoqueProdutoPorEmpresa,
  estoqueCriticoPorEmpresa,
  comprasPorEmpresa,
  financeiroReceberPorEmpresa,
  fiscalNfcePorEmpresa
};
