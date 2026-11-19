/**
 * S07-3C — Cadastro dinâmico de canais de pedidos e vínculo a unidades.
 * Canal SISTEMA LOJA garantido por empresa. Sem despacho / sem integrações externas.
 * APIs não executam DDL — exigem schema S07-3C já aplicado.
 */
'use strict';

const { isAdminOperacional, parsePositiveInteger } = require('./cozinhaAuthUnidade');
const {
  exigirSchemaCozinhaCanais,
  garantirSchemaCozinhaCanais,
  verificarSchemaCozinhaCanais
} = require('./cozinhaCanaisSchema');

const ORIGEM_SISTEMA = 'SISTEMA';
const ORIGEM_MANUAL = 'MANUAL';
const ORIGEM_INTEGRACAO = 'INTEGRACAO';
const CODIGO_LOJA = 'LOJA';
const NOME_LOJA = 'Loja';

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
      'Somente administrador operacional pode gerenciar canais de pedidos.',
      403,
      'ADMIN_OPERACIONAL_OBRIGATORIO'
    );
  }
}

function normalizarNome(raw) {
  const nome = String(raw == null ? '' : raw).trim();
  if (!nome) {
    throw erro('Nome do canal é obrigatório.', 400, 'NOME_CANAL_OBRIGATORIO');
  }
  if (nome.length > 80) {
    throw erro('Nome do canal excede o limite de 80 caracteres.', 400, 'NOME_CANAL_INVALIDO');
  }
  return nome;
}

function normalizarAtivo(raw, padrao = 1) {
  if (raw === undefined || raw === null || raw === '') return padrao;
  if (raw === true || raw === 1 || raw === '1' || String(raw).toLowerCase() === 'true') return 1;
  if (raw === false || raw === 0 || raw === '0' || String(raw).toLowerCase() === 'false') return 0;
  throw erro('Situação ativa inválida.', 400, 'ATIVO_INVALIDO');
}

/** Gera base de código técnico estável a partir do nome (sem alterar canais existentes). */
function slugifyCodigoBase(nome) {
  const base = String(nome || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  return base || 'CANAL';
}

async function codigoExiste(db, empresaId, codigo) {
  const row = await dbGet(db, `
    SELECT id FROM cozinha_canais WHERE empresa_id = ? AND codigo = ?
  `, [empresaId, codigo]);
  return !!row;
}

async function gerarCodigoUnico(db, empresaId, nome) {
  let base = slugifyCodigoBase(nome);
  if (base === CODIGO_LOJA) base = 'CANAL_LOJA';
  let codigo = base;
  let n = 2;
  while (await codigoExiste(db, empresaId, codigo)) {
    const sufixo = `_${n}`;
    codigo = `${base.slice(0, Math.max(1, 40 - sufixo.length))}${sufixo}`;
    n += 1;
    if (n > 9999) {
      throw erro('Não foi possível gerar código técnico único para o canal.', 409, 'CODIGO_CANAL_ESGOTADO');
    }
  }
  return codigo;
}

function mapCanal(row) {
  const destId = row.unidade_cozinha_id != null ? Number(row.unidade_cozinha_id) : null;
  return {
    id: Number(row.id),
    empresa_id: Number(row.empresa_id),
    codigo: String(row.codigo),
    nome: String(row.nome),
    origem_tipo: String(row.origem_tipo),
    sistema: String(row.origem_tipo) === ORIGEM_SISTEMA,
    ativo: Number(row.ativo) === 1,
    destino: destId != null
      ? {
        unidade_id: destId,
        unidade_codigo: row.unidade_codigo != null ? String(row.unidade_codigo) : null,
        unidade_ativa: row.unidade_ativo == null ? null : Number(row.unidade_ativo) === 1
      }
      : null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    created_by: row.created_by != null ? Number(row.created_by) : null,
    updated_by: row.updated_by != null ? Number(row.updated_by) : null
  };
}

/**
 * Garante canal SISTEMA LOJA para a empresa (idempotente).
 */
async function garantirCanalLojaEmpresa(db, empresaId, usuarioId) {
  const existente = await dbGet(db, `
    SELECT id, codigo, origem_tipo FROM cozinha_canais
    WHERE empresa_id = ? AND codigo = ?
  `, [empresaId, CODIGO_LOJA]);
  if (existente) return Number(existente.id);

  const r = await dbRun(db, `
    INSERT INTO cozinha_canais (
      empresa_id, codigo, nome, origem_tipo, ativo, created_at, updated_at, created_by, updated_by
    ) VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?)
  `, [empresaId, CODIGO_LOJA, NOME_LOJA, ORIGEM_SISTEMA, usuarioId || null, usuarioId || null]);
  return Number(r.lastID);
}

async function carregarCanalCompleto(db, empresaId, canalId) {
  const row = await dbGet(db, `
    SELECT c.*,
           d.unidade_cozinha_id,
           u.codigo AS unidade_codigo,
           u.ativo AS unidade_ativo
    FROM cozinha_canais c
    LEFT JOIN cozinha_canal_destinos d
      ON d.canal_id = c.id AND d.empresa_id = c.empresa_id
    LEFT JOIN cozinha_unidades u
      ON u.id = d.unidade_cozinha_id AND u.empresa_id = d.empresa_id
    WHERE c.empresa_id = ? AND c.id = ?
  `, [empresaId, canalId]);
  return row ? mapCanal(row) : null;
}

async function exigirUnidadeAtivaDaEmpresa(db, empresaId, unidadeIdRaw) {
  const unidadeId = parsePositiveInteger(unidadeIdRaw);
  if (unidadeId == null) {
    throw erro('Identificador da unidade de cozinha inválido.', 400, 'UNIDADE_ID_INVALIDO');
  }
  const row = await dbGet(db, `
    SELECT id, empresa_id, codigo, ativo FROM cozinha_unidades WHERE id = ?
  `, [unidadeId]);
  if (!row) {
    throw erro('Unidade de cozinha inexistente.', 404, 'UNIDADE_INEXISTENTE');
  }
  if (Number(row.empresa_id) !== Number(empresaId)) {
    throw erro('Unidade não pertence à empresa do contexto.', 403, 'UNIDADE_EMPRESA_ISOLAMENTO');
  }
  if (Number(row.ativo) !== 1) {
    throw erro('Unidade de cozinha inativa.', 409, 'UNIDADE_INATIVA');
  }
  return {
    id: Number(row.id),
    codigo: row.codigo != null ? String(row.codigo) : null
  };
}

async function listarCanais({ user, empresaId }, opts = {}) {
  const db = conn(opts);
  const usuario = exigirUsuario(user);
  exigirAdminOperacional(usuario);
  const empId = exigirEmpresa(empresaId);
  await exigirSchemaCozinhaCanais(db);
  await garantirCanalLojaEmpresa(db, empId, usuario.id);

  const rows = await dbAll(db, `
    SELECT c.*,
           d.unidade_cozinha_id,
           u.codigo AS unidade_codigo,
           u.ativo AS unidade_ativo
    FROM cozinha_canais c
    LEFT JOIN cozinha_canal_destinos d
      ON d.canal_id = c.id AND d.empresa_id = c.empresa_id
    LEFT JOIN cozinha_unidades u
      ON u.id = d.unidade_cozinha_id AND u.empresa_id = d.empresa_id
    WHERE c.empresa_id = ?
    ORDER BY
      CASE WHEN c.codigo = 'LOJA' THEN 0 ELSE 1 END,
      c.nome COLLATE NOCASE ASC,
      c.id ASC
  `, [empId]);

  return {
    success: true,
    empresa_id: empId,
    canais: (rows || []).map(mapCanal)
  };
}

async function criarCanal({ user, empresaId, nomeRaw, bodyEmpresaIdIgnored }, opts = {}) {
  const db = conn(opts);
  const usuario = exigirUsuario(user);
  exigirAdminOperacional(usuario);
  const empId = exigirEmpresa(empresaId);
  void bodyEmpresaIdIgnored;
  await exigirSchemaCozinhaCanais(db);
  await garantirCanalLojaEmpresa(db, empId, usuario.id);

  const nome = normalizarNome(nomeRaw);
  const duplicadoNome = await dbGet(db, `
    SELECT id FROM cozinha_canais
    WHERE empresa_id = ? AND lower(trim(nome)) = lower(?)
  `, [empId, nome]);
  if (duplicadoNome) {
    throw erro('Já existe um canal com este nome nesta empresa.', 409, 'NOME_CANAL_DUPLICADO');
  }

  const codigo = await gerarCodigoUnico(db, empId, nome);
  const r = await dbRun(db, `
    INSERT INTO cozinha_canais (
      empresa_id, codigo, nome, origem_tipo, ativo, created_at, updated_at, created_by, updated_by
    ) VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?)
  `, [empId, codigo, nome, ORIGEM_MANUAL, usuario.id, usuario.id]);

  const canal = await carregarCanalCompleto(db, empId, r.lastID);
  return { success: true, canal };
}

async function atualizarCanal({
  user,
  empresaId,
  canalIdRaw,
  nomeRaw,
  ativoRaw,
  bodyEmpresaIdIgnored,
  bodyCodigoIgnored,
  bodyOrigemIgnored
}, opts = {}) {
  const db = conn(opts);
  const usuario = exigirUsuario(user);
  exigirAdminOperacional(usuario);
  const empId = exigirEmpresa(empresaId);
  void bodyEmpresaIdIgnored;
  void bodyCodigoIgnored;
  void bodyOrigemIgnored;

  const canalId = parsePositiveInteger(canalIdRaw);
  if (canalId == null) {
    throw erro('Identificador do canal inválido.', 400, 'CANAL_ID_INVALIDO');
  }

  await exigirSchemaCozinhaCanais(db);

  const atual = await dbGet(db, `
    SELECT id, empresa_id, codigo, nome, origem_tipo, ativo
    FROM cozinha_canais WHERE id = ?
  `, [canalId]);
  if (!atual) {
    throw erro('Canal inexistente.', 404, 'CANAL_INEXISTENTE');
  }
  if (Number(atual.empresa_id) !== empId) {
    throw erro('Canal não pertence à empresa do contexto.', 403, 'CANAL_EMPRESA_ISOLAMENTO');
  }

  let nome = atual.nome;
  if (nomeRaw !== undefined) {
    nome = normalizarNome(nomeRaw);
    const duplicadoNome = await dbGet(db, `
      SELECT id FROM cozinha_canais
      WHERE empresa_id = ? AND lower(trim(nome)) = lower(?) AND id <> ?
    `, [empId, nome, canalId]);
    if (duplicadoNome) {
      throw erro('Já existe um canal com este nome nesta empresa.', 409, 'NOME_CANAL_DUPLICADO');
    }
  }

  let ativo = Number(atual.ativo) === 1 ? 1 : 0;
  if (ativoRaw !== undefined) {
    ativo = normalizarAtivo(ativoRaw, ativo);
    if (String(atual.codigo) === CODIGO_LOJA && String(atual.origem_tipo) === ORIGEM_SISTEMA && ativo === 0) {
      throw erro('O canal de sistema LOJA não pode ser desativado.', 409, 'CANAL_LOJA_PROTEGIDO');
    }
  }

  await dbRun(db, `
    UPDATE cozinha_canais
    SET nome = ?,
        ativo = ?,
        updated_at = CURRENT_TIMESTAMP,
        updated_by = ?
    WHERE id = ? AND empresa_id = ?
  `, [nome, ativo, usuario.id, canalId, empId]);

  const canal = await carregarCanalCompleto(db, empId, canalId);
  return { success: true, canal };
}

async function definirDestinoCanal({
  user,
  empresaId,
  canalIdRaw,
  unidadeIdRaw,
  bodyEmpresaIdIgnored
}, opts = {}) {
  const db = conn(opts);
  const usuario = exigirUsuario(user);
  exigirAdminOperacional(usuario);
  const empId = exigirEmpresa(empresaId);
  void bodyEmpresaIdIgnored;

  const canalId = parsePositiveInteger(canalIdRaw);
  if (canalId == null) {
    throw erro('Identificador do canal inválido.', 400, 'CANAL_ID_INVALIDO');
  }

  await exigirSchemaCozinhaCanais(db);

  const canal = await dbGet(db, `
    SELECT id, empresa_id, codigo, ativo FROM cozinha_canais WHERE id = ?
  `, [canalId]);
  if (!canal) {
    throw erro('Canal inexistente.', 404, 'CANAL_INEXISTENTE');
  }
  if (Number(canal.empresa_id) !== empId) {
    throw erro('Canal não pertence à empresa do contexto.', 403, 'CANAL_EMPRESA_ISOLAMENTO');
  }

  const unidade = await exigirUnidadeAtivaDaEmpresa(db, empId, unidadeIdRaw);

  await dbRun(db, `
    INSERT INTO cozinha_canal_destinos (
      empresa_id, canal_id, unidade_cozinha_id, created_at, updated_at, updated_by
    ) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
    ON CONFLICT(empresa_id, canal_id) DO UPDATE SET
      unidade_cozinha_id = excluded.unidade_cozinha_id,
      updated_at = CURRENT_TIMESTAMP,
      updated_by = excluded.updated_by
  `, [empId, canalId, unidade.id, usuario.id]);

  const out = await carregarCanalCompleto(db, empId, canalId);
  return { success: true, canal: out };
}

module.exports = {
  ORIGEM_SISTEMA,
  ORIGEM_MANUAL,
  ORIGEM_INTEGRACAO,
  CODIGO_LOJA,
  NOME_LOJA,
  slugifyCodigoBase,
  gerarCodigoUnico,
  garantirCanalLojaEmpresa,
  listarCanais,
  criarCanal,
  atualizarCanal,
  definirDestinoCanal,
  garantirSchemaCozinhaCanais,
  verificarSchemaCozinhaCanais,
  exigirSchemaCozinhaCanais
};
