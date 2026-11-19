/**
 * Autorização operador ↔ unidade de cozinha no login.
 * Não confia em unidade_cozinha_id do cliente sem validar cadastro.
 *
 * Estruturas reutilizadas:
 * - cozinha_unidades (existência, ativo, empresa_id)
 * - usuario_empresas (operador autorizado na empresa da unidade)
 * - cozinha_operador_unidades (vínculo fino operador↔unidade; CREATE IF NOT EXISTS)
 */
'use strict';

const UsuarioEmpresaService = require('../empresas/UsuarioEmpresaService');

function erroAuth(mensagem, statusCode, codigo, extras = {}) {
  const err = new Error(mensagem);
  err.statusCode = statusCode;
  err.codigo = codigo;
  Object.assign(err, extras);
  return err;
}

function parsePositiveInteger(value) {
  const num = Number(value);
  return Number.isInteger(num) && num > 0 ? num : null;
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function cb(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

/**
 * Garante tabela de vínculo sem migration/version bump (CREATE IF NOT EXISTS).
 * Não altera schema version da Cozinha (permanece v3).
 */
async function garantirTabelaOperadorUnidades(db) {
  if (!db) throw erroAuth('Banco indisponível.', 500, 'DB_INDISPONIVEL');
  await dbRun(db, `
    CREATE TABLE IF NOT EXISTS cozinha_operador_unidades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL,
      operador_id INTEGER NOT NULL,
      unidade_id INTEGER NOT NULL,
      ativo INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT,
      UNIQUE (empresa_id, operador_id, unidade_id),
      FOREIGN KEY (unidade_id, empresa_id)
        REFERENCES cozinha_unidades(id, empresa_id)
    )
  `);
  await dbRun(db, `
    CREATE INDEX IF NOT EXISTS idx_cozinha_operador_unidades_op
    ON cozinha_operador_unidades(operador_id, ativo)
  `);
  await dbRun(db, `
    CREATE INDEX IF NOT EXISTS idx_cozinha_operador_unidades_un
    ON cozinha_operador_unidades(unidade_id, ativo)
  `);
}

function isAdminOperacional(usuario) {
  if (!usuario || typeof usuario !== 'object') return false;
  const perfil = String(usuario.perfil || '').trim().toUpperCase();
  const role = String(usuario.role || '').trim().toLowerCase();
  // Admin operacional aprovado S07-2: role admin OU perfil ADMIN/SUPER_ADMIN.
  // role comparado em minúsculas (evita classificar admin como operador comum).
  return role === 'admin'
    || ['SUPER_ADMIN', 'ADMIN'].includes(perfil);
}

/**
 * Valida unidade solicitada no login contra cadastro.
 * @returns {Promise<number|null>} unidade autorizada ou null se não solicitada
 */
async function validarUnidadeCozinhaNoLogin({
  db,
  usuario,
  unidadeCozinhaIdRaw,
  empresaIdRaw
}) {
  const unidadeSolicitada = parsePositiveInteger(unidadeCozinhaIdRaw);
  if (unidadeSolicitada == null) {
    // Login sem unidade (PDV / outros fluxos) — não bloqueia.
    return null;
  }

  await garantirTabelaOperadorUnidades(db);

  const unidade = await dbGet(db, `
    SELECT id, empresa_id, codigo, ativo
    FROM cozinha_unidades
    WHERE id = ?
  `, [unidadeSolicitada]);

  if (!unidade) {
    throw erroAuth(
      'Unidade de cozinha inexistente.',
      403,
      'UNIDADE_INEXISTENTE'
    );
  }
  if (Number(unidade.ativo) !== 1) {
    throw erroAuth(
      'Unidade de cozinha inativa.',
      403,
      'UNIDADE_INATIVA'
    );
  }

  const empresaSessao = parsePositiveInteger(empresaIdRaw);
  if (empresaSessao != null && empresaSessao !== Number(unidade.empresa_id)) {
    throw erroAuth(
      'Unidade não pertence à empresa da sessão.',
      403,
      'UNIDADE_EMPRESA_ISOLAMENTO'
    );
  }

  const empresaId = Number(unidade.empresa_id);
  const operadorId = Number(usuario && (usuario.id || usuario.usuario_id));
  if (!Number.isInteger(operadorId) || operadorId <= 0) {
    throw erroAuth('Operador inválido.', 401, 'SESSAO_INVALIDA');
  }

  const podeEmpresa = await UsuarioEmpresaService.usuarioPodeAcessarEmpresa(
    operadorId,
    empresaId,
    { db, user: usuario }
  );
  if (!podeEmpresa) {
    throw erroAuth(
      'Operador sem autorização para a empresa da unidade.',
      403,
      'UNIDADE_NAO_AUTORIZADA'
    );
  }

  // Admin operacional: qualquer unidade ativa da empresa autorizada.
  // Demais: vínculo explícito em cozinha_operador_unidades.
  if (!isAdminOperacional(usuario)) {
    const vinculo = await dbGet(db, `
      SELECT id, ativo
      FROM cozinha_operador_unidades
      WHERE empresa_id = ? AND operador_id = ? AND unidade_id = ?
      LIMIT 1
    `, [empresaId, operadorId, unidadeSolicitada]);

    if (!vinculo || Number(vinculo.ativo) !== 1) {
      throw erroAuth(
        'Operador sem autorização para esta unidade de cozinha.',
        403,
        'UNIDADE_NAO_AUTORIZADA'
      );
    }
  }

  return unidadeSolicitada;
}

module.exports = {
  garantirTabelaOperadorUnidades,
  validarUnidadeCozinhaNoLogin,
  parsePositiveInteger,
  isAdminOperacional
};
