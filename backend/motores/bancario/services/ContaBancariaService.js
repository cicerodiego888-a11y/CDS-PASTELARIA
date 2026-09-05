/**
 * Contas bancárias por empresa. Sem credenciais. Sem extrato.
 * @module motores/bancario/services/ContaBancariaService
 */
'use strict';

const { ERROS, TIPOS_CONTA, erroMbc } = require('../contracts/constantes');
const { exigirEmpresaId } = require('../contracts/TransacaoBancariaNormalizada');
const { dbRun, dbGet, dbAll, dbExec } = require('./dbPromessas');
const InstituicaoFinanceiraService = require('./InstituicaoFinanceiraService');

function texto(v) {
  if (v == null) return '';
  return String(v).trim();
}

function bool01(v, def = 0) {
  if (v === undefined || v === null) return def;
  if (v === true || v === 1 || v === '1') return 1;
  if (v === false || v === 0 || v === '0') return 0;
  return def;
}

function normalizarTipo(tipo) {
  const t = texto(tipo).toUpperCase().replace('Ç', 'C').replace('Ã', 'A');
  const mapa = {
    CORRENTE: 'CORRENTE',
    POUPANCA: 'POUPANCA',
    POUPANÇA: 'POUPANCA',
    PAGAMENTO: 'PAGAMENTO',
    OUTRA: 'OUTRA'
  };
  return mapa[t] || t;
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    empresa_id: row.empresa_id,
    instituicao_financeira_id: row.instituicao_financeira_id,
    instituicao_nome: row.instituicao_nome || null,
    instituicao_codigo: row.instituicao_codigo != null ? row.instituicao_codigo : null,
    nome: row.nome,
    tipo: row.tipo,
    agencia: row.agencia,
    numero: row.numero,
    digito: row.digito,
    titular: row.titular,
    documento_titular: row.documento_titular,
    ativa: Number(row.ativa) === 1,
    principal: Number(row.principal) === 1,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

const SELECT_JOIN = `
  SELECT c.*, i.nome AS instituicao_nome, i.codigo AS instituicao_codigo
  FROM conta_bancaria c
  INNER JOIN instituicao_financeira i ON i.id = c.instituicao_financeira_id
`;

async function obterNoContexto(params = {}) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw erroMbc(ERROS.CONTA_NAO_ENCONTRADA, 'Conta bancária não encontrada.', 404);
  }
  const row = await dbGet(
    params.db,
    `${SELECT_JOIN} WHERE c.id = ? AND c.empresa_id = ?`,
    [id, empresaId]
  );
  if (!row) {
    throw erroMbc(ERROS.CONTA_NAO_ENCONTRADA, 'Conta bancária não encontrada.', 404);
  }
  return mapRow(row);
}

async function listarPorEmpresa(params = {}) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const rows = await dbAll(
    params.db,
    `${SELECT_JOIN} WHERE c.empresa_id = ? ORDER BY c.principal DESC, c.nome COLLATE NOCASE ASC, c.id ASC`,
    [empresaId]
  );
  return rows.map(mapRow);
}

async function limparPrincipalEmpresa(db, empresaId, excetoId) {
  if (excetoId) {
    await dbRun(
      db,
      `UPDATE conta_bancaria SET principal = 0, updated_at = datetime('now','localtime')
       WHERE empresa_id = ? AND id != ? AND principal = 1`,
      [empresaId, excetoId]
    );
  } else {
    await dbRun(
      db,
      `UPDATE conta_bancaria SET principal = 0, updated_at = datetime('now','localtime')
       WHERE empresa_id = ? AND principal = 1`,
      [empresaId]
    );
  }
}

async function criar(params = {}) {
  const db = params.db;
  const empresaId = exigirEmpresaId(params.empresaId);
  const instId = Number(params.instituicao_financeira_id);
  if (!Number.isInteger(instId) || instId <= 0) {
    throw erroMbc(ERROS.INSTITUICAO_NAO_ENCONTRADA, 'Instituição financeira não encontrada.', 404);
  }
  await InstituicaoFinanceiraService.exigirAtivaParaVinculo({ db, id: instId });
  const nome = texto(params.nome);
  if (!nome) {
    throw erroMbc(ERROS.NOME_OBRIGATORIO, 'Nome da conta bancária é obrigatório.', 400);
  }
  const tipo = normalizarTipo(params.tipo || 'CORRENTE');
  if (!TIPOS_CONTA.includes(tipo)) {
    throw erroMbc(ERROS.TIPO_INVALIDO, 'Tipo de conta bancária inválido.', 400);
  }
  const numero = texto(params.numero);
  if (!numero) {
    throw erroMbc(ERROS.NUMERO_OBRIGATORIO, 'Número da conta bancária é obrigatório.', 400);
  }
  const principal = bool01(params.principal, 0);
  const ativa = bool01(params.ativa, 1);
  const principalFinal = ativa === 1 ? principal : 0;

  await dbExec(db, 'BEGIN IMMEDIATE');
  try {
    if (principalFinal === 1) {
      await limparPrincipalEmpresa(db, empresaId, null);
    }
    const r = await dbRun(
      db,
      `INSERT INTO conta_bancaria (
        empresa_id, instituicao_financeira_id, nome, tipo, agencia, numero, digito,
        titular, documento_titular, ativa, principal, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))`,
      [
        empresaId,
        instId,
        nome,
        tipo,
        texto(params.agencia) || null,
        numero,
        texto(params.digito) || null,
        texto(params.titular) || null,
        texto(params.documento_titular) || null,
        ativa,
        principalFinal
      ]
    );
    await dbExec(db, 'COMMIT');
    return obterNoContexto({ db, empresaId, id: r.lastID });
  } catch (err) {
    try { await dbExec(db, 'ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  }
}

async function atualizar(params = {}) {
  const db = params.db;
  const atual = await obterNoContexto(params);
  const empresaId = atual.empresa_id;
  let instId = atual.instituicao_financeira_id;
  if (params.instituicao_financeira_id != null) {
    instId = Number(params.instituicao_financeira_id);
    if (!Number.isInteger(instId) || instId <= 0) {
      throw erroMbc(ERROS.INSTITUICAO_NAO_ENCONTRADA, 'Instituição financeira não encontrada.', 404);
    }
    if (instId !== atual.instituicao_financeira_id) {
      await InstituicaoFinanceiraService.exigirAtivaParaVinculo({ db, id: instId });
    }
  }
  const nome = params.nome != null ? texto(params.nome) : atual.nome;
  if (!nome) {
    throw erroMbc(ERROS.NOME_OBRIGATORIO, 'Nome da conta bancária é obrigatório.', 400);
  }
  let tipo = atual.tipo;
  if (params.tipo != null) {
    tipo = normalizarTipo(params.tipo);
    if (!TIPOS_CONTA.includes(tipo)) {
      throw erroMbc(ERROS.TIPO_INVALIDO, 'Tipo de conta bancária inválido.', 400);
    }
  }
  const numero = params.numero != null ? texto(params.numero) : atual.numero;
  if (!numero) {
    throw erroMbc(ERROS.NUMERO_OBRIGATORIO, 'Número da conta bancária é obrigatório.', 400);
  }
  let ativa = atual.ativa ? 1 : 0;
  if (params.ativa != null) ativa = bool01(params.ativa, ativa);
  let principal = atual.principal ? 1 : 0;
  if (params.principal != null) principal = bool01(params.principal, principal);
  if (ativa === 0) principal = 0;

  await dbExec(db, 'BEGIN IMMEDIATE');
  try {
    if (principal === 1) {
      await limparPrincipalEmpresa(db, empresaId, atual.id);
    }
    await dbRun(
      db,
      `UPDATE conta_bancaria SET
        instituicao_financeira_id = ?, nome = ?, tipo = ?, agencia = ?, numero = ?, digito = ?,
        titular = ?, documento_titular = ?, ativa = ?, principal = ?,
        updated_at = datetime('now','localtime')
       WHERE id = ? AND empresa_id = ?`,
      [
        instId,
        nome,
        tipo,
        Object.prototype.hasOwnProperty.call(params, 'agencia') ? (texto(params.agencia) || null) : atual.agencia,
        numero,
        Object.prototype.hasOwnProperty.call(params, 'digito') ? (texto(params.digito) || null) : atual.digito,
        Object.prototype.hasOwnProperty.call(params, 'titular') ? (texto(params.titular) || null) : atual.titular,
        Object.prototype.hasOwnProperty.call(params, 'documento_titular')
          ? (texto(params.documento_titular) || null)
          : atual.documento_titular,
        ativa,
        principal,
        atual.id,
        empresaId
      ]
    );
    await dbExec(db, 'COMMIT');
    return obterNoContexto({ db, empresaId, id: atual.id });
  } catch (err) {
    try { await dbExec(db, 'ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  }
}

async function ativar(params = {}) {
  return atualizar({ ...params, ativa: 1 });
}

async function desativar(params = {}) {
  return atualizar({ ...params, ativa: 0, principal: 0 });
}

async function definirPrincipal(params = {}) {
  const atual = await obterNoContexto(params);
  if (!atual.ativa) {
    throw erroMbc(ERROS.CONTA_INATIVA_PRINCIPAL, 'Conta inativa não pode ser principal.', 400);
  }
  return atualizar({ ...params, principal: 1, ativa: 1 });
}

async function tabelaTransacaoExiste(db) {
  const row = await dbGet(
    db,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'transacao_bancaria'`
  );
  return !!row;
}

async function excluir(params = {}) {
  const db = params.db;
  const atual = await obterNoContexto(params);
  if (await tabelaTransacaoExiste(db)) {
    const dep = await dbGet(
      db,
      `SELECT id FROM transacao_bancaria WHERE conta_bancaria_id = ? LIMIT 1`,
      [atual.id]
    );
    if (dep) {
      throw erroMbc(
        ERROS.CONFLITO_EXCLUSAO,
        'Conta bancária possui transações e não pode ser excluída.',
        409
      );
    }
  }
  await dbRun(db, `DELETE FROM conta_bancaria WHERE id = ? AND empresa_id = ?`, [atual.id, atual.empresa_id]);
  return { ok: true, id: atual.id };
}

module.exports = {
  listarPorEmpresa,
  obterNoContexto,
  criar,
  atualizar,
  ativar,
  desativar,
  definirPrincipal,
  excluir,
  TIPOS_CONTA
};
