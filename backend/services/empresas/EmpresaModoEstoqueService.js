/**
 * Modo global de estoque por empresa — CDS-ESTOQUE-MANUAL-01.
 * AUTOMATICO (padrão/legado): baixa e ficha como hoje.
 * MANUAL: não executar baixas automáticas de venda/ficha/pedido.
 *
 * @module services/empresas/EmpresaModoEstoqueService
 */
'use strict';

const {
  garantirSchemaEmpresasConfiguracaoEstoqueAsync
} = require('./empresasConfiguracaoEstoqueSchema');

const MODO_AUTOMATICO = 'AUTOMATICO';
const MODO_MANUAL = 'MANUAL';
const MODOS = Object.freeze([MODO_AUTOMATICO, MODO_MANUAL]);

function erroModo(code, message, status = 400, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  Object.assign(err, extra);
  return err;
}

function resolverEmpresaId(valor) {
  const id = Number(valor);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

function normalizarModo(valor) {
  const modo = String(valor == null ? '' : valor).trim().toUpperCase();
  if (!MODOS.includes(modo)) {
    throw erroModo(
      'MODO_ESTOQUE_INVALIDO',
      'Modo de estoque inválido. Use AUTOMATICO ou MANUAL.'
    );
  }
  return modo;
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
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

/**
 * Lê o modo da empresa. Sem linha / empresaId inválido → AUTOMATICO (legado).
 * Valida existência da empresa quando empresaId é informado e válido.
 */
async function obterModoEstoqueEmpresa(db, empresaIdBruto, opts = {}) {
  const empresaId = resolverEmpresaId(empresaIdBruto);
  if (empresaId == null) {
    return {
      empresa_id: null,
      modo: MODO_AUTOMATICO,
      origem: 'PADRAO_LEGADO_SEM_EMPRESA',
      permite_baixa_automatica: true
    };
  }
  if (!db) throw erroModo('DB_OBRIGATORIO', 'db é obrigatório.', 500);

  if (opts.garantirSchema !== false) {
    await garantirSchemaEmpresasConfiguracaoEstoqueAsync(db);
  }

  const empresa = await dbGet(db, 'SELECT id FROM empresas WHERE id = ?', [empresaId]);
  if (!empresa) {
    throw erroModo(
      'EMPRESA_NAO_ENCONTRADA',
      'Empresa não encontrada para configuração de estoque.',
      404,
      { empresa_id: empresaId }
    );
  }

  const row = await dbGet(
    db,
    'SELECT empresa_id, modo, updated_at, updated_by FROM empresas_configuracao_estoque WHERE empresa_id = ?',
    [empresaId]
  );
  if (!row) {
    return {
      empresa_id: empresaId,
      modo: MODO_AUTOMATICO,
      origem: 'PADRAO_LEGADO',
      permite_baixa_automatica: true,
      updated_at: null,
      updated_by: null
    };
  }
  const modo = normalizarModo(row.modo);
  return {
    empresa_id: empresaId,
    modo,
    origem: 'CONFIGURACAO',
    permite_baixa_automatica: modo === MODO_AUTOMATICO,
    updated_at: row.updated_at || null,
    updated_by: row.updated_by != null ? Number(row.updated_by) : null
  };
}

async function empresaPermiteBaixaAutomaticaEstoque(db, empresaId) {
  const cfg = await obterModoEstoqueEmpresa(db, empresaId);
  return cfg.permite_baixa_automatica === true;
}

async function salvarModoEstoqueEmpresa(db, empresaIdBruto, modoBruto, opts = {}) {
  const empresaId = resolverEmpresaId(empresaIdBruto);
  if (empresaId == null) {
    throw erroModo('EMPRESA_ID_OBRIGATORIO', 'empresaId é obrigatório para salvar o modo de estoque.');
  }
  if (!db) throw erroModo('DB_OBRIGATORIO', 'db é obrigatório.', 500);
  const modo = normalizarModo(modoBruto);
  await garantirSchemaEmpresasConfiguracaoEstoqueAsync(db);

  const empresa = await dbGet(db, 'SELECT id FROM empresas WHERE id = ?', [empresaId]);
  if (!empresa) {
    throw erroModo(
      'EMPRESA_NAO_ENCONTRADA',
      'Empresa não encontrada para configuração de estoque.',
      404,
      { empresa_id: empresaId }
    );
  }

  const updatedBy = opts.usuarioId != null && Number.isInteger(Number(opts.usuarioId))
    ? Number(opts.usuarioId)
    : null;

  await dbRun(
    db,
    `INSERT INTO empresas_configuracao_estoque (empresa_id, modo, updated_at, updated_by)
     VALUES (?, ?, CURRENT_TIMESTAMP, ?)
     ON CONFLICT(empresa_id) DO UPDATE SET
       modo = excluded.modo,
       updated_at = CURRENT_TIMESTAMP,
       updated_by = excluded.updated_by`,
    [empresaId, modo, updatedBy]
  );

  return obterModoEstoqueEmpresa(db, empresaId, { garantirSchema: false });
}

module.exports = {
  MODO_AUTOMATICO,
  MODO_MANUAL,
  MODOS,
  obterModoEstoqueEmpresa,
  empresaPermiteBaixaAutomaticaEstoque,
  salvarModoEstoqueEmpresa,
  normalizarModo,
  resolverEmpresaId
};
