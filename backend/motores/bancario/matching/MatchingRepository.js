/**
 * Persistência de sugestões. Sem SQL nas rotas. Sem INSERT em conciliacao_bancaria.
 * @module motores/bancario/matching/MatchingRepository
 */
'use strict';

const { ERROS, erroMbc } = require('../contracts/constantes');
const { STATUS_SUGESTAO } = require('./contracts/constantesMatching');
const { dbRun, dbGet, dbAll } = require('../services/dbPromessas');
const { exigirEmpresaId } = require('../contracts/TransacaoBancariaNormalizada');
const ContaBancariaService = require('../services/ContaBancariaService');

function mapRow(row) {
  if (!row) return null;
  let motivos = [];
  try {
    motivos = row.motivos ? JSON.parse(row.motivos) : [];
  } catch (_) {
    motivos = [];
  }
  return {
    id: row.id,
    empresa_id: row.empresa_id,
    transacao_bancaria_id: row.transacao_bancaria_id,
    tipo_registro: row.tipo_registro,
    registro_id: row.registro_id,
    score: Number(row.score),
    nivel_confianca: row.nivel_confianca,
    motivos,
    status: row.status,
    valor_candidato: row.valor_candidato == null ? null : Number(row.valor_candidato),
    data_candidato: row.data_candidato,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function obterOperacional(db, empresaId, transacaoId, tipo, registroId) {
  return dbGet(
    db,
    `SELECT * FROM sugestao_conciliacao_bancaria
     WHERE empresa_id = ? AND transacao_bancaria_id = ? AND tipo_registro = ? AND registro_id = ?
       AND status = ?`,
    [empresaId, transacaoId, tipo, registroId, STATUS_SUGESTAO.PENDENTE]
  );
}

async function inserirSeNova(db, dados) {
  const existente = await obterOperacional(
    db,
    dados.empresa_id,
    dados.transacao_bancaria_id,
    dados.tipo_registro,
    dados.registro_id
  );
  if (existente) return { criada: false, row: mapRow(existente) };
  try {
    const r = await dbRun(
      db,
      `INSERT INTO sugestao_conciliacao_bancaria (
        empresa_id, transacao_bancaria_id, tipo_registro, registro_id, score, nivel_confianca,
        motivos, status, valor_candidato, data_candidato, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))`,
      [
        dados.empresa_id,
        dados.transacao_bancaria_id,
        dados.tipo_registro,
        dados.registro_id,
        dados.score,
        dados.nivel_confianca,
        JSON.stringify(dados.motivos || []),
        STATUS_SUGESTAO.PENDENTE,
        dados.valor_candidato,
        dados.data_candidato
      ]
    );
    const row = await dbGet(db, `SELECT * FROM sugestao_conciliacao_bancaria WHERE id = ?`, [r.lastID]);
    return { criada: true, row: mapRow(row) };
  } catch (err) {
    if (/UNIQUE/i.test(String(err.message || ''))) {
      const novamente = await obterOperacional(
        db,
        dados.empresa_id,
        dados.transacao_bancaria_id,
        dados.tipo_registro,
        dados.registro_id
      );
      if (novamente) return { criada: false, row: mapRow(novamente) };
    }
    throw err;
  }
}

async function obterNoContexto(params = {}) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const row = await dbGet(
    params.db,
    `SELECT * FROM sugestao_conciliacao_bancaria WHERE id = ? AND empresa_id = ?`,
    [Number(params.id), empresaId]
  );
  if (!row) {
    throw erroMbc(ERROS.SUGESTAO_NAO_ENCONTRADA, 'Sugestão de conciliação não encontrada.', 404);
  }
  return mapRow(row);
}

async function listar(params = {}) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const where = ['s.empresa_id = ?'];
  const bind = [empresaId];
  if (params.conta_bancaria_id) {
    await ContaBancariaService.obterNoContexto({
      db: params.db,
      empresaId,
      id: params.conta_bancaria_id
    });
    where.push('t.conta_bancaria_id = ?');
    bind.push(Number(params.conta_bancaria_id));
  }
  if (params.status) {
    where.push('s.status = ?');
    bind.push(String(params.status).toUpperCase());
  }
  if (params.nivel_confianca) {
    where.push('s.nivel_confianca = ?');
    bind.push(String(params.nivel_confianca).toUpperCase());
  }
  if (params.transacao_bancaria_id) {
    where.push('s.transacao_bancaria_id = ?');
    bind.push(Number(params.transacao_bancaria_id));
  }
  if (params.data_inicio) {
    where.push('date(t.data_transacao) >= date(?)');
    bind.push(params.data_inicio);
  }
  if (params.data_fim) {
    where.push('date(t.data_transacao) <= date(?)');
    bind.push(params.data_fim);
  }
  const limite = Math.min(Math.max(Number(params.limite) || 100, 1), 200);
  const offset = Math.max(Number(params.offset) || 0, 0);
  bind.push(limite, offset);
  const rows = await dbAll(
    params.db,
    `SELECT s.* FROM sugestao_conciliacao_bancaria s
     INNER JOIN transacao_bancaria t ON t.id = s.transacao_bancaria_id
     WHERE ${where.join(' AND ')}
     ORDER BY s.score DESC, s.id DESC
     LIMIT ? OFFSET ?`,
    bind
  );
  return rows.map(mapRow);
}

async function atualizarStatus(db, id, empresaId, de, para) {
  const r = await dbRun(
    db,
    `UPDATE sugestao_conciliacao_bancaria
     SET status = ?, updated_at = datetime('now','localtime')
     WHERE id = ? AND empresa_id = ? AND status = ?`,
    [para, id, empresaId, de]
  );
  return r.changes;
}

async function expirarPendentesDaTransacao(db, empresaId, transacaoId, excetoId) {
  await dbRun(
    db,
    `UPDATE sugestao_conciliacao_bancaria
     SET status = ?, updated_at = datetime('now','localtime')
     WHERE empresa_id = ? AND transacao_bancaria_id = ? AND status = ? AND id != ?`,
    [STATUS_SUGESTAO.EXPIRADA, empresaId, transacaoId, STATUS_SUGESTAO.PENDENTE, excetoId]
  );
}

module.exports = {
  inserirSeNova,
  obterNoContexto,
  listar,
  atualizarStatus,
  expirarPendentesDaTransacao,
  mapRow
};
