/**
 * 03.21 — leitura isolada de estoque na resposta de GET /api/produtos/:id.
 * Não é a porta pública. Sem fallback silencioso para produtos.
 */
'use strict';

const EstoqueEmpresaService = require('./EstoqueEmpresaService');

function zerarSaldosResposta(row) {
  return {
    ...row,
    saldo_fiscal: 0,
    saldo_nao_fiscal: 0,
    estoque_atual: 0,
    reservado_fiscal: 0,
    reservado_nao_fiscal: 0
  };
}

function aplicarSaldosIsolados(row, saldo) {
  return {
    ...row,
    saldo_fiscal: saldo.saldoFiscal,
    saldo_nao_fiscal: saldo.saldoNaoFiscal,
    estoque_atual: saldo.estoqueAtual,
    reservado_fiscal: saldo.reservadoFiscal,
    reservado_nao_fiscal: saldo.reservadoNaoFiscal
  };
}

/**
 * Sem empresaId: devolve a linha legada (produtos) sem alterar.
 * Com empresaId: consulta estoque_empresa. null → zeros explícitos, sem copiar legado.
 */
async function resolverSaldosProdutoParaResposta(params = {}) {
  const { row, produtoId, empresaId, db } = params;
  if (empresaId == null || empresaId === '') {
    return { row, isolado: false, encontrado: null };
  }

  const saldo = await EstoqueEmpresaService.consultarSaldoParaEmpresa({
    produtoId,
    empresaId,
    db
  });

  if (!saldo) {
    return { row: zerarSaldosResposta(row), isolado: true, encontrado: false };
  }

  return { row: aplicarSaldosIsolados(row, saldo), isolado: true, encontrado: true };
}

/**
 * 03.22 — LEFT JOIN estoque_empresa para listagem.
 * Sem empresaId: strings vazias (consulta legada).
 * Com empresaId: COALESCE 0 quando não há registro. Sem copiar produtos.
 */
function fragmentoEstoqueEmpresaListagem(empresaId, opts = {}) {
  const aliasP = opts.aliasProduto || 'p';
  const aliasEe = opts.aliasEe || 'ee';
  const id = Number(empresaId);
  if (empresaId == null || empresaId === '' || !Number.isInteger(id) || id <= 0) {
    return { isolado: false, joinSql: '', extraSelect: '', params: [] };
  }

  return {
    isolado: true,
    joinSql: `LEFT JOIN estoque_empresa ${aliasEe}
      ON ${aliasEe}.produto_id = ${aliasP}.id AND ${aliasEe}.empresa_id = ?`,
    extraSelect: `,
      COALESCE(${aliasEe}.saldo_fiscal, 0) AS saldo_fiscal,
      COALESCE(${aliasEe}.saldo_nao_fiscal, 0) AS saldo_nao_fiscal,
      COALESCE(${aliasEe}.estoque_atual, 0) AS estoque_atual,
      COALESCE(${aliasEe}.reservado_fiscal, 0) AS reservado_fiscal,
      COALESCE(${aliasEe}.reservado_nao_fiscal, 0) AS reservado_nao_fiscal`,
    params: [id]
  };
}

/**
 * 03.23 — overlay dos 5 saldos no payload de /produtos/identificar.
 * empresaId somente do contexto validado (req.empresaId). Sem fallback.
 */
async function aplicarSaldosIdentificacaoPdv(params = {}) {
  const { payload, empresaId, db } = params;
  if (!payload || payload.encontrado !== true) {
    return { payload, isolado: false, encontrado: null };
  }

  const produto = payload.produto && typeof payload.produto === 'object'
    ? payload.produto
    : {};
  const produtoId = payload.produtoId != null
    ? Number(payload.produtoId)
    : (produto.id != null ? Number(produto.id) : null);

  if (!Number.isInteger(produtoId) || produtoId <= 0) {
    return { payload, isolado: false, encontrado: null };
  }

  const r = await resolverSaldosProdutoParaResposta({
    row: produto,
    produtoId,
    empresaId,
    db
  });

  return {
    payload: { ...payload, produto: r.row },
    isolado: r.isolado,
    encontrado: r.encontrado
  };
}

/**
 * 03.24 — origem dos saldos para disponibilidade de venda (PDV).
 * Sem empresaId: linhas legadas. Com empresaId: estoque_empresa, zeros se ausente.
 * Não escreve. Não altera o cálculo F×NF / reservas.
 */
async function aplicarSaldosDisponibilidadeVenda(params = {}) {
  const { produtos = [], empresaId, db } = params;
  if (!Array.isArray(produtos) || produtos.length === 0) {
    return produtos;
  }
  if (empresaId == null || empresaId === '') {
    return produtos;
  }

  const out = [];
  for (const row of produtos) {
    const produtoId = row && (row.id != null ? row.id : row.produto_id);
    const r = await resolverSaldosProdutoParaResposta({
      row,
      produtoId,
      empresaId,
      db
    });
    out.push(r.row);
  }
  return out;
}

module.exports = {
  resolverSaldosProdutoParaResposta,
  fragmentoEstoqueEmpresaListagem,
  aplicarSaldosIdentificacaoPdv,
  aplicarSaldosDisponibilidadeVenda
};
