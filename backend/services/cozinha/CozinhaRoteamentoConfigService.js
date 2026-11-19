/**
 * S07-3A — Configuração administrativa de roteamento de cozinhas.
 * MODO 1: COZINHA_PADRAO — uma unidade ativa da empresa.
 * MODO 2: COZINHA_POR_SEGMENTO — mapa segmento → unidade ativa.
 * Empresa somente do contexto. Sem despacho / sem alterar pedidos / sem KDS.
 * APIs não executam DDL — exigem schema já aplicado (migration controlada).
 */
'use strict';

const { isAdminOperacional, parsePositiveInteger } = require('./cozinhaAuthUnidade');
const {
  exigirSchemaCozinhaRoteamento,
  garantirSchemaCozinhaRoteamento,
  verificarSchemaCozinhaRoteamento
} = require('./cozinhaRoteamentoSchema');
const {
  SEGMENTOS_BASE,
  listarSegmentosPermitidos,
  isSegmentoPermitido,
  normalizarCodigoSegmento
} = require('./cozinhaRoteamentoSegmentos');

const MODO_PADRAO = 'COZINHA_PADRAO';
const MODO_SEGMENTO = 'COZINHA_POR_SEGMENTO';
const MODOS = Object.freeze([MODO_PADRAO, MODO_SEGMENTO]);

/** Alias estável: base S07-3A (LOJA, IFOOD, PEDIDO_ONLINE). Preferir listarSegmentosPermitidos(). */
const SEGMENTOS = SEGMENTOS_BASE;

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
      'Somente administrador operacional pode gerenciar o roteamento de cozinhas.',
      403,
      'ADMIN_OPERACIONAL_OBRIGATORIO'
    );
  }
}

function normalizarModo(raw) {
  const modo = String(raw == null ? '' : raw).trim().toUpperCase();
  if (!MODOS.includes(modo)) {
    throw erro(
      'Modo de distribuição inválido. Use COZINHA_PADRAO ou COZINHA_POR_SEGMENTO.',
      400,
      'MODO_ROTEAMENTO_INVALIDO'
    );
  }
  return modo;
}

function normalizarSegmento(raw) {
  const seg = normalizarCodigoSegmento(raw);
  const permitidos = listarSegmentosPermitidos();
  if (!isSegmentoPermitido(seg)) {
    throw erro(
      `Segmento inválido. Use: ${permitidos.join(', ')}.`,
      400,
      'SEGMENTO_INVALIDO',
      { segmentos_permitidos: permitidos.slice() }
    );
  }
  return seg;
}

/**
 * APIs: apenas verificação — nunca CREATE TABLE.
 */
async function exigirSchemaDisponivel(db) {
  await exigirSchemaCozinhaRoteamento(db);
}

/**
 * Valida unidade ativa pertencente à empresa do contexto.
 */
async function exigirUnidadeAtivaDaEmpresa(db, empresaId, unidadeIdRaw, codigoErro = 'UNIDADE_DESTINO_INVALIDA') {
  void codigoErro;
  const unidadeId = parsePositiveInteger(unidadeIdRaw);
  if (unidadeId == null) {
    throw erro('Identificador da unidade de cozinha inválido.', 400, 'UNIDADE_ID_INVALIDO');
  }
  const row = await dbGet(db, `
    SELECT id, empresa_id, codigo, ativo
    FROM cozinha_unidades
    WHERE id = ?
  `, [unidadeId]);
  if (!row) {
    throw erro('Unidade de cozinha inexistente.', 404, 'UNIDADE_INEXISTENTE');
  }
  if (Number(row.empresa_id) !== Number(empresaId)) {
    throw erro(
      'Unidade não pertence à empresa do contexto.',
      403,
      'UNIDADE_EMPRESA_ISOLAMENTO'
    );
  }
  if (Number(row.ativo) !== 1) {
    throw erro('Unidade de cozinha inativa.', 409, 'UNIDADE_INATIVA');
  }
  return {
    id: Number(row.id),
    empresa_id: Number(row.empresa_id),
    codigo: row.codigo != null ? String(row.codigo) : null,
    ativo: true
  };
}

async function lerSegmentos(db, empresaId) {
  const rows = await dbAll(db, `
    SELECT s.segmento, s.unidade_id, s.updated_at, u.codigo AS unidade_codigo, u.ativo AS unidade_ativo
    FROM cozinha_roteamento_segmentos s
    LEFT JOIN cozinha_unidades u
      ON u.id = s.unidade_id AND u.empresa_id = s.empresa_id
    WHERE s.empresa_id = ?
    ORDER BY s.segmento ASC
  `, [empresaId]);
  return (rows || []).map((r) => ({
    segmento: String(r.segmento),
    unidade_id: Number(r.unidade_id),
    unidade_codigo: r.unidade_codigo != null ? String(r.unidade_codigo) : null,
    unidade_ativa: Number(r.unidade_ativo) === 1,
    updated_at: r.updated_at || null
  }));
}

async function montarResposta(db, empresaId) {
  const cfg = await dbGet(db, `
    SELECT c.empresa_id, c.modo, c.unidade_padrao_id, c.updated_at, c.updated_by,
           u.codigo AS unidade_padrao_codigo, u.ativo AS unidade_padrao_ativo
    FROM cozinha_roteamento_config c
    LEFT JOIN cozinha_unidades u
      ON u.id = c.unidade_padrao_id AND u.empresa_id = c.empresa_id
    WHERE c.empresa_id = ?
  `, [empresaId]);
  const segmentos = await lerSegmentos(db, empresaId);
  const segmentosPermitidos = listarSegmentosPermitidos();

  if (!cfg) {
    return {
      success: true,
      configurado: false,
      empresa_id: empresaId,
      modo: null,
      unidade_padrao_id: null,
      unidade_padrao: null,
      segmentos,
      segmentos_permitidos: segmentosPermitidos,
      segmentos_base: SEGMENTOS_BASE.slice(),
      updated_at: null,
      updated_by: null
    };
  }

  const unidadePadrao = cfg.unidade_padrao_id != null
    ? {
      id: Number(cfg.unidade_padrao_id),
      codigo: cfg.unidade_padrao_codigo != null ? String(cfg.unidade_padrao_codigo) : null,
      ativo: Number(cfg.unidade_padrao_ativo) === 1
    }
    : null;

  return {
    success: true,
    configurado: true,
    empresa_id: empresaId,
    modo: String(cfg.modo),
    unidade_padrao_id: cfg.unidade_padrao_id != null ? Number(cfg.unidade_padrao_id) : null,
    unidade_padrao: unidadePadrao,
    segmentos,
    segmentos_permitidos: segmentosPermitidos,
    segmentos_base: SEGMENTOS_BASE.slice(),
    updated_at: cfg.updated_at || null,
    updated_by: cfg.updated_by != null ? Number(cfg.updated_by) : null
  };
}

async function upsertConfigBase(db, empresaId, { modo, unidadePadraoId, updatedBy }) {
  const existente = await dbGet(db, `
    SELECT empresa_id, modo, unidade_padrao_id FROM cozinha_roteamento_config WHERE empresa_id = ?
  `, [empresaId]);

  if (!existente) {
    await dbRun(db, `
      INSERT INTO cozinha_roteamento_config (empresa_id, modo, unidade_padrao_id, updated_at, updated_by)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)
    `, [empresaId, modo, unidadePadraoId, updatedBy]);
    return;
  }

  await dbRun(db, `
    UPDATE cozinha_roteamento_config
    SET modo = ?,
        unidade_padrao_id = ?,
        updated_at = CURRENT_TIMESTAMP,
        updated_by = ?
    WHERE empresa_id = ?
  `, [modo, unidadePadraoId, updatedBy, empresaId]);
}

/**
 * Consulta configuração da empresa do contexto.
 */
async function obterConfiguracao({ user, empresaId }, opts = {}) {
  const db = conn(opts);
  const usuario = exigirUsuario(user);
  exigirAdminOperacional(usuario);
  const empId = exigirEmpresa(empresaId);
  await exigirSchemaDisponivel(db);
  return montarResposta(db, empId);
}

/**
 * Define o modo de distribuição.
 * Body lógico: { modo }. empresa_id do corpo é ignorado.
 */
async function definirModo({ user, empresaId, modoRaw, bodyEmpresaIdIgnored }, opts = {}) {
  const db = conn(opts);
  const usuario = exigirUsuario(user);
  exigirAdminOperacional(usuario);
  const empId = exigirEmpresa(empresaId);
  void bodyEmpresaIdIgnored;
  const modo = normalizarModo(modoRaw);
  await exigirSchemaDisponivel(db);

  const atual = await dbGet(db, `
    SELECT modo, unidade_padrao_id FROM cozinha_roteamento_config WHERE empresa_id = ?
  `, [empId]);

  let unidadePadraoId = atual && atual.unidade_padrao_id != null
    ? Number(atual.unidade_padrao_id)
    : null;

  if (modo === MODO_PADRAO) {
    if (unidadePadraoId == null) {
      throw erro(
        'Defina a cozinha padrão antes de ativar o modo COZINHA_PADRAO.',
        409,
        'COZINHA_PADRAO_OBRIGATORIA'
      );
    }
    await exigirUnidadeAtivaDaEmpresa(db, empId, unidadePadraoId);
  }

  await upsertConfigBase(db, empId, {
    modo,
    unidadePadraoId: unidadePadraoId,
    updatedBy: usuario.id
  });

  return montarResposta(db, empId);
}

/**
 * Define a cozinha padrão (unidade ativa da empresa).
 * Body: { unidade_id }. Ignora empresa_id do corpo.
 */
async function definirCozinhaPadrao({ user, empresaId, unidadeIdRaw, bodyEmpresaIdIgnored }, opts = {}) {
  const db = conn(opts);
  const usuario = exigirUsuario(user);
  exigirAdminOperacional(usuario);
  const empId = exigirEmpresa(empresaId);
  void bodyEmpresaIdIgnored;
  await exigirSchemaDisponivel(db);

  const unidade = await exigirUnidadeAtivaDaEmpresa(db, empId, unidadeIdRaw);

  const atual = await dbGet(db, `
    SELECT modo, unidade_padrao_id FROM cozinha_roteamento_config WHERE empresa_id = ?
  `, [empId]);
  const modo = atual && atual.modo ? String(atual.modo) : MODO_PADRAO;

  await upsertConfigBase(db, empId, {
    modo,
    unidadePadraoId: unidade.id,
    updatedBy: usuario.id
  });

  return montarResposta(db, empId);
}

/**
 * Associa um segmento a uma unidade ativa da empresa.
 * Body: { segmento, unidade_id }. Sem destino → erro.
 */
async function associarSegmento({
  user,
  empresaId,
  segmentoRaw,
  unidadeIdRaw,
  bodyEmpresaIdIgnored
}, opts = {}) {
  const db = conn(opts);
  const usuario = exigirUsuario(user);
  exigirAdminOperacional(usuario);
  const empId = exigirEmpresa(empresaId);
  void bodyEmpresaIdIgnored;

  const segmento = normalizarSegmento(segmentoRaw);
  if (unidadeIdRaw === undefined || unidadeIdRaw === null || unidadeIdRaw === '') {
    throw erro(
      'Destino (unidade_id) é obrigatório para o segmento.',
      400,
      'SEGMENTO_SEM_DESTINO'
    );
  }
  await exigirSchemaDisponivel(db);
  const unidade = await exigirUnidadeAtivaDaEmpresa(db, empId, unidadeIdRaw);

  const atual = await dbGet(db, `
    SELECT modo, unidade_padrao_id FROM cozinha_roteamento_config WHERE empresa_id = ?
  `, [empId]);
  if (!atual) {
    await upsertConfigBase(db, empId, {
      modo: MODO_SEGMENTO,
      unidadePadraoId: null,
      updatedBy: usuario.id
    });
  } else {
    await dbRun(db, `
      UPDATE cozinha_roteamento_config
      SET updated_at = CURRENT_TIMESTAMP, updated_by = ?
      WHERE empresa_id = ?
    `, [usuario.id, empId]);
  }

  await dbRun(db, `
    INSERT INTO cozinha_roteamento_segmentos (empresa_id, segmento, unidade_id, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(empresa_id, segmento) DO UPDATE SET
      unidade_id = excluded.unidade_id,
      updated_at = CURRENT_TIMESTAMP
  `, [empId, segmento, unidade.id]);

  return montarResposta(db, empId);
}

module.exports = {
  MODO_PADRAO,
  MODO_SEGMENTO,
  MODOS,
  SEGMENTOS,
  SEGMENTOS_BASE,
  listarSegmentosPermitidos,
  obterConfiguracao,
  definirModo,
  definirCozinhaPadrao,
  associarSegmento,
  /** Somente testes / aplicação controlada — APIs não usam. */
  garantirSchemaCozinhaRoteamento,
  verificarSchemaCozinhaRoteamento,
  exigirSchemaCozinhaRoteamento
};
