/**
 * Backfill explícito de `estoque_empresa` (Fase 2 / Implementação 03.14).
 *
 * Copia o snapshot legado de `produtos` para UMA empresa informada.
 * Não roda no bootstrap. Não altera produtos. Não sobrescreve registro existente.
 * Não distribui estoque entre empresas.
 *
 * @module services/estoque/EstoqueEmpresaBackfillService
 */
'use strict';

const { garantirSchemaEstoqueEmpresaAsync } = require('./estoqueEmpresaSchema');
const EstoqueEmpresaService = require('./EstoqueEmpresaService');

function round3(n) {
  return Math.round(Number(n || 0) * 1000) / 1000;
}

function erroBackfill(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

function getDb(dbInjected) {
  if (dbInjected) return dbInjected;
  return require('../../database');
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function resolverEmpresaId(fonte) {
  if (fonte == null || fonte === '') return null;
  if (typeof fonte === 'number' || typeof fonte === 'string') {
    const n = Number(fonte);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  if (typeof fonte === 'object') {
    const raw = fonte.empresaId != null ? fonte.empresaId : fonte.empresa_id;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  return null;
}

function exigirEmpresaId(fonte) {
  const id = resolverEmpresaId(fonte);
  if (id == null) {
    throw erroBackfill(
      'EMPRESA_OBRIGATORIA',
      'empresaId é obrigatório para backfill de estoque_empresa.'
    );
  }
  return id;
}

function snapshotProduto(row) {
  const saldoFiscal = round3(row.saldo_fiscal);
  const saldoNaoFiscal = round3(row.saldo_nao_fiscal);
  const estoqueAtual = row.estoque_atual != null && row.estoque_atual !== ''
    ? round3(row.estoque_atual)
    : round3(saldoFiscal + saldoNaoFiscal);
  return {
    saldo_fiscal: saldoFiscal,
    saldo_nao_fiscal: saldoNaoFiscal,
    estoque_atual: estoqueAtual,
    reservado_fiscal: round3(row.reservado_fiscal),
    reservado_nao_fiscal: round3(row.reservado_nao_fiscal)
  };
}

async function exigirEmpresaExistente(db, empresaId) {
  const row = await dbGet(db, `SELECT id FROM empresas WHERE id = ? LIMIT 1`, [empresaId]);
  if (!row) {
    throw erroBackfill(
      'EMPRESA_NAO_ENCONTRADA',
      `Empresa não encontrada: ${empresaId}.`,
      { empresa_id: empresaId }
    );
  }
}

async function preparar(params = {}, opts = {}) {
  const db = getDb(opts.db != null ? opts.db : params.db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  const empresaId = exigirEmpresaId({ ...params, ...opts });
  await exigirEmpresaExistente(db, empresaId);
  return { db, empresaId };
}

/**
 * Backfill de um produto para uma empresa.
 * Se o registro já existe, não sobrescreve.
 */
async function executarBackfillProduto(params = {}, opts = {}) {
  const { db, empresaId } = await preparar(params, opts);
  const produtoId = Number(params.produtoId != null ? params.produtoId : params.produto_id);
  if (!Number.isInteger(produtoId) || produtoId <= 0) {
    throw erroBackfill('PRODUTO_INVALIDO', 'Produto inválido.');
  }

  const existe = await EstoqueEmpresaService.existeRegistro(
    { produtoId, empresaId },
    { db }
  );
  if (existe) {
    return { empresaId, produtoId, criado: false, ignorado: true };
  }

  const prod = await dbGet(
    db,
    `SELECT id,
            COALESCE(saldo_fiscal, 0) AS saldo_fiscal,
            COALESCE(saldo_nao_fiscal, 0) AS saldo_nao_fiscal,
            estoque_atual,
            COALESCE(reservado_fiscal, 0) AS reservado_fiscal,
            COALESCE(reservado_nao_fiscal, 0) AS reservado_nao_fiscal
       FROM produtos
      WHERE id = ?
      LIMIT 1`,
    [produtoId]
  );
  if (!prod) {
    throw erroBackfill('PRODUTO_NAO_ENCONTRADO', 'Produto não encontrado.', { produto_id: produtoId });
  }

  const snap = snapshotProduto(prod);
  try {
    await EstoqueEmpresaService.criarRegistro({
      produtoId,
      empresaId,
      ...snap
    }, { db });
  } catch (err) {
    if (err && err.code === 'ESTOQUE_EMPRESA_DUPLICADO') {
      return { empresaId, produtoId, criado: false, ignorado: true };
    }
    throw err;
  }

  return { empresaId, produtoId, criado: true, ignorado: false, ...snap };
}

/**
 * Backfill de todos os produtos para UMA empresa.
 * Não copia para outras empresas. Sem BEGIN próprio.
 */
async function executarBackfillEmpresa(params = {}, opts = {}) {
  const { db, empresaId } = await preparar(params, opts);
  const produtos = await dbAll(
    db,
    `SELECT id,
            COALESCE(saldo_fiscal, 0) AS saldo_fiscal,
            COALESCE(saldo_nao_fiscal, 0) AS saldo_nao_fiscal,
            estoque_atual,
            COALESCE(reservado_fiscal, 0) AS reservado_fiscal,
            COALESCE(reservado_nao_fiscal, 0) AS reservado_nao_fiscal
       FROM produtos
      ORDER BY id`
  );

  let criados = 0;
  let ignorados = 0;
  for (const prod of produtos) {
    const r = await executarBackfillProduto(
      { produtoId: prod.id, empresaId },
      { db }
    );
    if (r.criado) criados += 1;
    else ignorados += 1;
  }

  return {
    empresaId,
    criados,
    ignorados,
    totalProdutos: produtos.length
  };
}

module.exports = {
  executarBackfillEmpresa,
  executarBackfillProduto
};
