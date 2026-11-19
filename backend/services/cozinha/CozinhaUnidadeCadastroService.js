/**
 * S07-2 — Cadastro administrativo mínimo de unidades de cozinha.
 * Empresa somente do contexto autenticado. Sem coluna nome.
 * Não altera rotas/regras de seleção KDS (unidades-disponiveis / sessao/unidade).
 */
'use strict';

const { isAdminOperacional, parsePositiveInteger } = require('./cozinhaAuthUnidade');

function erro(mensagem, statusCode, codigo, extras = {}) {
  const err = new Error(mensagem);
  err.statusCode = statusCode;
  err.codigo = codigo;
  Object.assign(err, extras);
  return err;
}

function conn(opts) {
  return (opts && opts.db) || require('../../database');
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function cb(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function exigirEmpresa(empresaId) {
  const n = Number(empresaId);
  if (!Number.isInteger(n) || n <= 0) {
    throw erro('Empresa do contexto é obrigatória.', 400, 'EMPRESA_CONTEXT_REQUIRED');
  }
  return n;
}

function exigirUsuario(user) {
  if (!user || typeof user !== 'object') {
    throw erro('Sessão inválida.', 401, 'SESSAO_INVALIDA');
  }
  const id = Number(user.id != null ? user.id : user.usuario_id);
  if (!Number.isInteger(id) || id <= 0) {
    throw erro('Sessão sem operador.', 401, 'SESSAO_INVALIDA');
  }
  return { ...user, id, usuario_id: id };
}

function exigirAdminOperacional(user) {
  if (!isAdminOperacional(user)) {
    throw erro(
      'Somente administrador operacional pode gerenciar unidades de cozinha.',
      403,
      'ADMIN_OPERACIONAL_OBRIGATORIO'
    );
  }
}

function normalizarCodigo(raw) {
  if (raw == null) return '';
  return String(raw).trim();
}

function normalizarAtivo(raw, padrao = 1) {
  if (raw === undefined || raw === null || raw === '') return padrao;
  if (raw === true || raw === 1 || raw === '1' || String(raw).toLowerCase() === 'true') return 1;
  if (raw === false || raw === 0 || raw === '0' || String(raw).toLowerCase() === 'false') return 0;
  throw erro('Situação ativa inválida.', 400, 'ATIVO_INVALIDO');
}

function mapUnidade(row) {
  return {
    id: Number(row.id),
    empresa_id: Number(row.empresa_id),
    codigo: row.codigo != null ? String(row.codigo) : null,
    ativo: Number(row.ativo) === 1,
    sequencia_atual: Number(row.sequencia_atual) || 0,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null
  };
}

/**
 * Lista unidades da empresa do contexto (ativas e inativas).
 * Somente admin operacional.
 */
async function listarUnidadesGestao({ user, empresaId }, opts = {}) {
  const db = conn(opts);
  const usuario = exigirUsuario(user);
  exigirAdminOperacional(usuario);
  const empId = exigirEmpresa(empresaId);

  const rows = await dbAll(db, `
    SELECT id, empresa_id, codigo, ativo, sequencia_atual, created_at, updated_at
    FROM cozinha_unidades
    WHERE empresa_id = ?
    ORDER BY codigo ASC, id ASC
  `, [empId]);

  return {
    success: true,
    empresa_id: empId,
    unidades: (rows || []).map(mapUnidade)
  };
}

/**
 * Cadastra unidade na empresa do contexto.
 * Body: { codigo, ativo? }. Ignora empresa_id do corpo.
 */
async function criarUnidade({ user, empresaId, codigoRaw, ativoRaw, bodyEmpresaIdIgnored }, opts = {}) {
  const db = conn(opts);
  const usuario = exigirUsuario(user);
  exigirAdminOperacional(usuario);
  const empId = exigirEmpresa(empresaId);

  // empresa_id do corpo nunca autoriza nem redefine a empresa.
  void bodyEmpresaIdIgnored;

  const codigo = normalizarCodigo(codigoRaw);
  if (!codigo) {
    throw erro('Código da unidade é obrigatório.', 400, 'CODIGO_OBRIGATORIO');
  }
  if (codigo.length > 64) {
    throw erro('Código da unidade excede o tamanho máximo (64).', 400, 'CODIGO_INVALIDO');
  }

  const ativo = normalizarAtivo(ativoRaw, 1);

  const existente = await dbGet(db, `
    SELECT id FROM cozinha_unidades
    WHERE empresa_id = ? AND codigo = ?
    LIMIT 1
  `, [empId, codigo]);
  if (existente) {
    throw erro(
      'Já existe unidade com este código nesta empresa.',
      409,
      'CODIGO_DUPLICADO'
    );
  }

  let result;
  try {
    result = await dbRun(db, `
      INSERT INTO cozinha_unidades (empresa_id, codigo, ativo, sequencia_atual, updated_at)
      VALUES (?, ?, ?, 0, CURRENT_TIMESTAMP)
    `, [empId, codigo, ativo]);
  } catch (err) {
    if (/UNIQUE/i.test(String(err && err.message))) {
      throw erro(
        'Já existe unidade com este código nesta empresa.',
        409,
        'CODIGO_DUPLICADO'
      );
    }
    throw err;
  }

  const row = await dbGet(db, `
    SELECT id, empresa_id, codigo, ativo, sequencia_atual, created_at, updated_at
    FROM cozinha_unidades
    WHERE id = ? AND empresa_id = ?
  `, [result.lastID, empId]);

  return {
    success: true,
    empresa_id: empId,
    unidade: mapUnidade(row)
  };
}

/**
 * Altera situação ativa/inativa. Impede alterar unidade de outra empresa.
 */
async function alterarSituacaoUnidade({ user, empresaId, unidadeIdRaw, ativoRaw }, opts = {}) {
  const db = conn(opts);
  const usuario = exigirUsuario(user);
  exigirAdminOperacional(usuario);
  const empId = exigirEmpresa(empresaId);

  const unidadeId = parsePositiveInteger(unidadeIdRaw);
  if (unidadeId == null) {
    throw erro('Identificador da unidade inválido.', 400, 'UNIDADE_ID_INVALIDO');
  }

  if (ativoRaw === undefined || ativoRaw === null || ativoRaw === '') {
    throw erro('Situação ativa é obrigatória.', 400, 'ATIVO_OBRIGATORIO');
  }
  const ativo = normalizarAtivo(ativoRaw);

  const row = await dbGet(db, `
    SELECT id, empresa_id, codigo, ativo, sequencia_atual, created_at, updated_at
    FROM cozinha_unidades
    WHERE id = ?
  `, [unidadeId]);

  if (!row) {
    throw erro('Unidade de cozinha não encontrada.', 404, 'UNIDADE_NAO_ENCONTRADA');
  }
  if (Number(row.empresa_id) !== empId) {
    throw erro(
      'Unidade não pertence à empresa do contexto.',
      403,
      'UNIDADE_EMPRESA_ISOLAMENTO'
    );
  }

  await dbRun(db, `
    UPDATE cozinha_unidades
    SET ativo = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND empresa_id = ?
  `, [ativo, unidadeId, empId]);

  const atualizada = await dbGet(db, `
    SELECT id, empresa_id, codigo, ativo, sequencia_atual, created_at, updated_at
    FROM cozinha_unidades
    WHERE id = ? AND empresa_id = ?
  `, [unidadeId, empId]);

  return {
    success: true,
    empresa_id: empId,
    unidade: mapUnidade(atualizada)
  };
}

module.exports = {
  listarUnidadesGestao,
  criarUnidade,
  alterarSituacaoUnidade
};
