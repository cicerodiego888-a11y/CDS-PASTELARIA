/**
 * Autorização usuário ↔ empresa (Fase 2 / 03.3).
 * Camada de vínculo sobre empresaContexto. Não altera JWT, login ou estoque.
 *
 * @module services/empresas/UsuarioEmpresaService
 */
'use strict';

const EmpresaService = require('./EmpresaService');

function erroVinculo(code, message, status, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
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

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function resolverUsuarioId(fonte) {
  if (fonte == null || fonte === '') return null;
  if (typeof fonte === 'number' || typeof fonte === 'string') {
    const n = Number(fonte);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  if (typeof fonte === 'object') {
    const raw = fonte.id != null
      ? fonte.id
      : (fonte.usuario_id != null ? fonte.usuario_id : fonte.usuarioId);
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  return null;
}

function exigirUsuarioId(fonte) {
  const id = resolverUsuarioId(fonte);
  if (id == null) {
    throw erroVinculo(
      'USUARIO_OBRIGATORIO',
      'usuarioId é obrigatório para autorização empresarial.',
      400
    );
  }
  return id;
}

async function buscarVinculo(usuarioId, empresaId, opts = {}) {
  const db = getDb(opts.db);
  return dbGet(
    db,
    `SELECT * FROM usuario_empresas WHERE usuario_id = ? AND empresa_id = ? LIMIT 1`,
    [usuarioId, empresaId]
  );
}

async function usuarioPodeAcessarEmpresa(usuarioId, empresaId, opts = {}) {
  const uid = resolverUsuarioId(usuarioId);
  const eid = Number(empresaId);
  if (!uid || !Number.isInteger(eid) || eid <= 0) return false;

  const vinculo = await buscarVinculo(uid, eid, opts);
  if (!vinculo || Number(vinculo.ativo) !== 1) return false;

  try {
    const empresa = await EmpresaService.buscarEmpresaPorId(eid, opts);
    return empresa && empresa.ativo === 1;
  } catch (err) {
    if (err && err.code === 'EMPRESA_NAO_ENCONTRADA') return false;
    throw err;
  }
}

async function exigirEmpresaAutorizada(usuarioFonte, empresaId, opts = {}) {
  const uid = exigirUsuarioId(usuarioFonte);
  const eid = Number(empresaId);
  if (!Number.isInteger(eid) || eid <= 0) {
    throw erroVinculo('EMPRESA_ID_OBRIGATORIO', 'empresaId é obrigatório.', 400);
  }

  const autorizado = await usuarioPodeAcessarEmpresa(uid, eid, opts);
  if (!autorizado) {
    throw erroVinculo(
      'EMPRESA_NAO_AUTORIZADA',
      'Usuário não está autorizado a usar esta empresa.',
      403,
      { usuario_id: uid, empresa_id: eid }
    );
  }
  return { usuarioId: uid, empresaId: eid };
}

/**
 * Empresas ativas + vínculo ativo — para o seletor.
 */
async function listarEmpresasPermitidas(usuarioFonte, opts = {}) {
  const uid = exigirUsuarioId(usuarioFonte);
  const db = getDb(opts.db);

  const rows = await dbAll(
    db,
    `SELECT e.id, e.cnpj, e.razao_social, e.nome_fantasia
     FROM usuario_empresas ue
     INNER JOIN empresas e ON e.id = ue.empresa_id
     WHERE ue.usuario_id = ?
       AND COALESCE(ue.ativo, 0) = 1
       AND COALESCE(e.ativo, 0) = 1
     ORDER BY e.razao_social COLLATE NOCASE, e.id`,
    [uid]
  );
  return rows.map((row) => EmpresaService.dtoContextoEmpresa(row));
}

/**
 * Todos os vínculos do usuário (admin), inclusive inativos.
 */
async function listarVinculosDoUsuario(usuarioFonte, opts = {}) {
  const uid = exigirUsuarioId(usuarioFonte);
  const db = getDb(opts.db);

  const rows = await dbAll(
    db,
    `SELECT
        ue.id AS vinculo_id,
        ue.usuario_id,
        ue.empresa_id,
        ue.ativo AS vinculo_ativo,
        e.cnpj,
        e.razao_social,
        e.nome_fantasia,
        e.ativo AS empresa_ativa
     FROM usuario_empresas ue
     INNER JOIN empresas e ON e.id = ue.empresa_id
     WHERE ue.usuario_id = ?
     ORDER BY e.razao_social COLLATE NOCASE, e.id`,
    [uid]
  );
  return rows.map((row) => ({
    vinculo_id: Number(row.vinculo_id),
    usuario_id: Number(row.usuario_id),
    empresa_id: Number(row.empresa_id),
    ativo: Number(row.vinculo_ativo) === 1 ? 1 : 0,
    empresa: EmpresaService.dtoContextoEmpresa({
      id: row.empresa_id,
      cnpj: row.cnpj,
      razao_social: row.razao_social,
      nome_fantasia: row.nome_fantasia
    }),
    empresa_ativa: Number(row.empresa_ativa) === 1 ? 1 : 0
  }));
}

async function vincularUsuarioEmpresa(usuarioFonte, empresaFonte, opts = {}) {
  const uid = exigirUsuarioId(usuarioFonte);
  const { resolverEmpresaId } = require('../fiscalNaoFiscal/empresaContexto');
  const eid = resolverEmpresaId(empresaFonte);
  if (eid == null) {
    throw erroVinculo('EMPRESA_ID_OBRIGATORIO', 'empresaId é obrigatório.', 400);
  }

  await EmpresaService.buscarEmpresaPorId(eid, opts);

  const db = getDb(opts.db);
  const existente = await buscarVinculo(uid, eid, { db });

  if (existente && Number(existente.ativo) === 1) {
    throw erroVinculo(
      'VINCULO_EMPRESA_DUPLICADO',
      'Este usuário já está vinculado a esta empresa.',
      409,
      { usuario_id: uid, empresa_id: eid }
    );
  }

  if (existente) {
    await dbRun(
      db,
      `UPDATE usuario_empresas SET ativo = 1, updated_at = CURRENT_TIMESTAMP
       WHERE usuario_id = ? AND empresa_id = ?`,
      [uid, eid]
    );
  } else {
    try {
      await dbRun(
        db,
        `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo, created_at, updated_at)
         VALUES (?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [uid, eid]
      );
    } catch (err) {
      const msg = String(err && err.message ? err.message : '');
      if (/UNIQUE/i.test(msg)) {
        throw erroVinculo(
          'VINCULO_EMPRESA_DUPLICADO',
          'Este usuário já está vinculado a esta empresa.',
          409,
          { usuario_id: uid, empresa_id: eid }
        );
      }
      throw err;
    }
  }

  return buscarVinculo(uid, eid, { db });
}

async function inativarVinculo(usuarioFonte, empresaFonte, opts = {}) {
  const uid = exigirUsuarioId(usuarioFonte);
  const { resolverEmpresaId } = require('../fiscalNaoFiscal/empresaContexto');
  const eid = resolverEmpresaId(empresaFonte);
  if (eid == null) {
    throw erroVinculo('EMPRESA_ID_OBRIGATORIO', 'empresaId é obrigatório.', 400);
  }

  const existente = await buscarVinculo(uid, eid, opts);
  if (!existente) {
    throw erroVinculo(
      'VINCULO_NAO_ENCONTRADO',
      'Vínculo usuário-empresa não encontrado.',
      404,
      { usuario_id: uid, empresa_id: eid }
    );
  }
  if (Number(existente.ativo) === 0) {
    throw erroVinculo(
      'VINCULO_JA_INATIVO',
      'Vínculo já está inativo.',
      409,
      { usuario_id: uid, empresa_id: eid }
    );
  }

  const db = getDb(opts.db);
  await dbRun(
    db,
    `UPDATE usuario_empresas SET ativo = 0, updated_at = CURRENT_TIMESTAMP
     WHERE usuario_id = ? AND empresa_id = ?`,
    [uid, eid]
  );
  return buscarVinculo(uid, eid, { db });
}

module.exports = {
  resolverUsuarioId,
  exigirUsuarioId,
  usuarioPodeAcessarEmpresa,
  exigirEmpresaAutorizada,
  listarEmpresasPermitidas,
  listarVinculosDoUsuario,
  vincularUsuarioEmpresa,
  inativarVinculo,
  buscarVinculo
};
