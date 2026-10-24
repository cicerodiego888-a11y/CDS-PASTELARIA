/**
 * Contrato de domínio: categoria fiscal lógica (REFRIGERANTE | AGUA) por empresa.
 *
 * - Vínculo sempre explícito; nada é inferido por nome, marca, sabor, embalagem ou unidade.
 * - Não altera `produtos` (tipo_operacional, saldos, categoria comercial).
 * - Insumo não pode ser vinculado nem é elegível.
 * - Sem saldo, reserva, débito ou movimento.
 *
 * @module services/vendas/CategoriaFiscalEmpresaService
 */
'use strict';

const {
  CategoriaFiscalLogica,
  garantirSchemaCategoriaFiscalEmpresaAsync
} = require('./categoriaFiscalEmpresaSchema');

const TIPO_INSUMO = 'INSUMO';

function erro(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = 400;
  Object.assign(err, extra);
  return err;
}

function getDb(db) {
  return db || require('../../database');
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

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function idPositivo(valor, code, message) {
  const n = Number(valor);
  if (valor == null || valor === '' || !Number.isInteger(n) || n <= 0) throw erro(code, message);
  return n;
}

function normalizarCategoriaFiscal(valor) {
  const raw = String(valor == null ? '' : valor).trim().toUpperCase();
  if (!raw) throw erro('CATEGORIA_FISCAL_OBRIGATORIA', 'categoria_fiscal é obrigatória.');
  if (!Object.prototype.hasOwnProperty.call(CategoriaFiscalLogica, raw)) {
    throw erro('CATEGORIA_FISCAL_INVALIDA', 'categoria_fiscal inválida. Use REFRIGERANTE ou AGUA.');
  }
  return raw;
}

function elegivelBooleano(valor) {
  if (valor === true || valor === 1 || valor === '1') return 1;
  if (valor === false || valor === 0 || valor === '0' || valor == null) return 0;
  throw erro('ELEGIBILIDADE_INVALIDA', 'elegivel_composicao deve ser booleano.');
}

async function preparar(opts = {}) {
  const db = getDb(opts.db);
  await garantirSchemaCategoriaFiscalEmpresaAsync(db);
  const empresaId = idPositivo(opts.empresaId ?? opts.empresa_id, 'EMPRESA_OBRIGATORIA', 'empresaId é obrigatório.');
  const empresa = await dbGet(db, 'SELECT id FROM empresas WHERE id = ? LIMIT 1', [empresaId]);
  if (!empresa) throw erro('EMPRESA_NAO_ENCONTRADA', `Empresa não encontrada: ${empresaId}.`, { empresa_id: empresaId });
  return { db, empresaId };
}

async function exigirProdutoVinculavel(db, produtoId) {
  const p = await dbGet(db, 'SELECT id, tipo_operacional FROM produtos WHERE id = ? LIMIT 1', [produtoId]);
  if (!p) throw erro('PRODUTO_NAO_ENCONTRADO', 'Produto não encontrado.', { produto_id: produtoId });
  if (String(p.tipo_operacional || '').toUpperCase() === TIPO_INSUMO) {
    throw erro('INSUMO_NAO_ELEGIVEL', 'Insumo não pode ser vinculado a categoria fiscal de composição.', {
      produto_id: produtoId
    });
  }
}

function mapear(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    empresa_id: Number(row.empresa_id),
    produto_id: Number(row.produto_id),
    categoria_fiscal: row.categoria_fiscal,
    elegivel_composicao: Number(row.elegivel_composicao) === 1
  };
}

/** Cria ou atualiza o vínculo explícito. Elegibilidade padrão: false. */
async function definirVinculo(params = {}, opts = {}) {
  const { db, empresaId } = await preparar({ ...params, ...opts });
  const produtoId = idPositivo(params.produtoId ?? params.produto_id, 'PRODUTO_INVALIDO', 'Produto inválido.');
  const categoria = normalizarCategoriaFiscal(params.categoriaFiscal ?? params.categoria_fiscal);
  const elegivel = elegivelBooleano(params.elegivelComposicao ?? params.elegivel_composicao);
  await exigirProdutoVinculavel(db, produtoId);
  await dbRun(
    db,
    `INSERT INTO produto_categoria_fiscal_empresa (empresa_id, produto_id, categoria_fiscal, elegivel_composicao)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(empresa_id, produto_id) DO UPDATE SET
       categoria_fiscal = excluded.categoria_fiscal,
       elegivel_composicao = excluded.elegivel_composicao,
       updated_at = CURRENT_TIMESTAMP`,
    [empresaId, produtoId, categoria, elegivel]
  );
  return obterVinculo({ empresaId, produtoId }, { db });
}

/** Ativa/desativa a elegibilidade de um vínculo já existente. */
async function definirElegibilidade(params = {}, opts = {}) {
  const { db, empresaId } = await preparar({ ...params, ...opts });
  const produtoId = idPositivo(params.produtoId ?? params.produto_id, 'PRODUTO_INVALIDO', 'Produto inválido.');
  const elegivel = elegivelBooleano(params.elegivelComposicao ?? params.elegivel_composicao);
  const atual = await dbGet(
    db,
    'SELECT id FROM produto_categoria_fiscal_empresa WHERE empresa_id = ? AND produto_id = ?',
    [empresaId, produtoId]
  );
  if (!atual) {
    throw erro('VINCULO_NAO_ENCONTRADO', 'Produto sem categoria fiscal explícita nesta empresa.', {
      empresa_id: empresaId,
      produto_id: produtoId
    });
  }
  if (elegivel) await exigirProdutoVinculavel(db, produtoId);
  await dbRun(
    db,
    `UPDATE produto_categoria_fiscal_empresa
        SET elegivel_composicao = ?, updated_at = CURRENT_TIMESTAMP
      WHERE empresa_id = ? AND produto_id = ?`,
    [elegivel, empresaId, produtoId]
  );
  return obterVinculo({ empresaId, produtoId }, { db });
}

async function removerVinculo(params = {}, opts = {}) {
  const { db, empresaId } = await preparar({ ...params, ...opts });
  const produtoId = idPositivo(params.produtoId ?? params.produto_id, 'PRODUTO_INVALIDO', 'Produto inválido.');
  const r = await dbRun(
    db,
    'DELETE FROM produto_categoria_fiscal_empresa WHERE empresa_id = ? AND produto_id = ?',
    [empresaId, produtoId]
  );
  return { removido: r.changes > 0 };
}

async function obterVinculo(params = {}, opts = {}) {
  const { db, empresaId } = await preparar({ ...params, ...opts });
  const produtoId = idPositivo(params.produtoId ?? params.produto_id, 'PRODUTO_INVALIDO', 'Produto inválido.');
  return mapear(
    await dbGet(
      db,
      'SELECT * FROM produto_categoria_fiscal_empresa WHERE empresa_id = ? AND produto_id = ?',
      [empresaId, produtoId]
    )
  );
}

/** Elegível somente com vínculo explícito + elegibilidade ativa + produto não insumo. */
async function produtoEhElegivel(params = {}, opts = {}) {
  const { db, empresaId } = await preparar({ ...params, ...opts });
  const produtoId = idPositivo(params.produtoId ?? params.produto_id, 'PRODUTO_INVALIDO', 'Produto inválido.');
  const row = await dbGet(
    db,
    `SELECT v.id
       FROM produto_categoria_fiscal_empresa v
       JOIN produtos p ON p.id = v.produto_id
      WHERE v.empresa_id = ? AND v.produto_id = ? AND v.elegivel_composicao = 1
        AND COALESCE(p.tipo_operacional, 'COMERCIAL') <> 'INSUMO'`,
    [empresaId, produtoId]
  );
  return !!row;
}

async function listarElegiveis(params = {}, opts = {}) {
  const { db, empresaId } = await preparar({ ...params, ...opts });
  const categoria = normalizarCategoriaFiscal(params.categoriaFiscal ?? params.categoria_fiscal);
  const rows = await dbAll(
    db,
    `SELECT v.*
       FROM produto_categoria_fiscal_empresa v
       JOIN produtos p ON p.id = v.produto_id
      WHERE v.empresa_id = ? AND v.categoria_fiscal = ? AND v.elegivel_composicao = 1
        AND COALESCE(p.tipo_operacional, 'COMERCIAL') <> 'INSUMO'
      ORDER BY v.produto_id`,
    [empresaId, categoria]
  );
  return rows.map(mapear);
}

module.exports = {
  CategoriaFiscalLogica,
  normalizarCategoriaFiscal,
  definirVinculo,
  definirElegibilidade,
  removerVinculo,
  obterVinculo,
  produtoEhElegivel,
  listarElegiveis
};
