/**
 * Cadastro de instituições financeiras (catálogo compartilhado).
 * Sem empresa_id. Sem credenciais.
 * @module motores/bancario/services/InstituicaoFinanceiraService
 */
'use strict';

const { ERROS, erroMbc } = require('../contracts/constantes');
const { dbRun, dbGet, dbAll } = require('./dbPromessas');

function texto(v) {
  if (v == null) return '';
  return String(v).trim();
}

function codigoNormalizado(v) {
  const c = texto(v);
  return c === '' ? null : c;
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    codigo: row.codigo == null ? null : String(row.codigo),
    nome: row.nome,
    nome_reduzido: row.nome_reduzido == null ? null : row.nome_reduzido,
    ativo: Number(row.ativo) === 1,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function criar(params = {}) {
  const db = params.db;
  const nome = texto(params.nome);
  if (!nome) {
    throw erroMbc(ERROS.NOME_OBRIGATORIO, 'Nome da instituição financeira é obrigatório.', 400);
  }
  const codigo = codigoNormalizado(params.codigo);
  if (codigo) {
    const dup = await dbGet(db, `SELECT id FROM instituicao_financeira WHERE codigo = ?`, [codigo]);
    if (dup) {
      throw erroMbc(ERROS.CODIGO_DUPLICADO, 'Já existe uma instituição financeira com este código.', 409);
    }
  }
  const r = await dbRun(
    db,
    `INSERT INTO instituicao_financeira (codigo, nome, nome_reduzido, ativo, created_at, updated_at)
     VALUES (?, ?, ?, 1, datetime('now','localtime'), datetime('now','localtime'))`,
    [codigo, nome, texto(params.nome_reduzido) || null]
  );
  return obterPorId({ db, id: r.lastID });
}

async function listar(params = {}) {
  const rows = await dbAll(
    params.db,
    `SELECT * FROM instituicao_financeira ORDER BY nome COLLATE NOCASE ASC, id ASC`
  );
  return rows.map(mapRow);
}

async function obterPorId(params = {}) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw erroMbc(ERROS.INSTITUICAO_NAO_ENCONTRADA, 'Instituição financeira não encontrada.', 404);
  }
  const row = await dbGet(params.db, `SELECT * FROM instituicao_financeira WHERE id = ?`, [id]);
  if (!row) {
    throw erroMbc(ERROS.INSTITUICAO_NAO_ENCONTRADA, 'Instituição financeira não encontrada.', 404);
  }
  return mapRow(row);
}

async function atualizar(params = {}) {
  const atual = await obterPorId(params);
  const nome = params.nome != null ? texto(params.nome) : atual.nome;
  if (!nome) {
    throw erroMbc(ERROS.NOME_OBRIGATORIO, 'Nome da instituição financeira é obrigatório.', 400);
  }
  let codigo = atual.codigo;
  if (Object.prototype.hasOwnProperty.call(params, 'codigo')) {
    codigo = codigoNormalizado(params.codigo);
  }
  if (codigo) {
    const dup = await dbGet(
      params.db,
      `SELECT id FROM instituicao_financeira WHERE codigo = ? AND id != ?`,
      [codigo, atual.id]
    );
    if (dup) {
      throw erroMbc(ERROS.CODIGO_DUPLICADO, 'Já existe uma instituição financeira com este código.', 409);
    }
  }
  const nomeReduzido = Object.prototype.hasOwnProperty.call(params, 'nome_reduzido')
    ? (texto(params.nome_reduzido) || null)
    : atual.nome_reduzido;
  let ativo = atual.ativo ? 1 : 0;
  if (params.ativo != null) ativo = params.ativo === true || params.ativo === 1 || params.ativo === '1' ? 1 : 0;
  await dbRun(
    params.db,
    `UPDATE instituicao_financeira
     SET codigo = ?, nome = ?, nome_reduzido = ?, ativo = ?, updated_at = datetime('now','localtime')
     WHERE id = ?`,
    [codigo, nome, nomeReduzido, ativo, atual.id]
  );
  return obterPorId({ db: params.db, id: atual.id });
}

async function excluir(params = {}) {
  const atual = await obterPorId(params);
  const vinculo = await dbGet(
    params.db,
    `SELECT id FROM conta_bancaria WHERE instituicao_financeira_id = ? LIMIT 1`,
    [atual.id]
  );
  if (vinculo) {
    throw erroMbc(
      ERROS.CONFLITO_EXCLUSAO,
      'Não é possível excluir instituição financeira vinculada a uma conta bancária.',
      409
    );
  }
  await dbRun(params.db, `DELETE FROM instituicao_financeira WHERE id = ?`, [atual.id]);
  return { ok: true, id: atual.id };
}

async function exigirAtivaParaVinculo(params = {}) {
  const inst = await obterPorId(params);
  if (!inst.ativo) {
    throw erroMbc(ERROS.INSTITUICAO_INATIVA, 'Instituição financeira inativa.', 400);
  }
  return inst;
}

module.exports = {
  criar,
  listar,
  obterPorId,
  atualizar,
  excluir,
  exigirAtivaParaVinculo,
  mapRow
};
