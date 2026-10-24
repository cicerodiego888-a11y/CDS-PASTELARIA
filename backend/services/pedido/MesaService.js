/**
 * MesaService — cadastro mínimo de mesas por empresa.
 * Sem ocupação, transferência, junção, divisão ou fechamento de conta.
 * Toda operação exige empresa explícita; não há fallback global.
 */
'use strict';

const dbPadrao = require('../../database');

function erro(mensagem, statusCode, codigo) {
  const err = new Error(mensagem);
  err.statusCode = statusCode;
  err.codigo = codigo;
  return err;
}

function conn(opts) {
  return (opts && opts.db) || dbPadrao;
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function cb(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function exigirEmpresa(empresaId) {
  const n = Number(empresaId);
  if (empresaId == null || !Number.isInteger(n) || n <= 0) {
    throw erro('Empresa do contexto é obrigatória para operar mesas.', 400, 'EMPRESA_CONTEXT_REQUIRED');
  }
  return n;
}

function normalizarNumero(valor) {
  const texto = String(valor == null ? '' : valor).trim();
  if (!/^\d+$/.test(texto) || !(Number(texto) > 0) || !Number.isSafeInteger(Number(texto))) {
    throw erro('Informe um número de mesa inteiro e maior que zero.', 400, 'MESA_NUMERO_INVALIDO');
  }
  return Number(texto);
}

function mapear(row) {
  if (!row) return null;
  return {
    id: row.id,
    empresa_id: row.empresa_id,
    numero: row.numero,
    nome: `Mesa ${row.numero}`,
    ativo: row.ativo === 1 || row.ativo === true,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function traduzirConflito(err) {
  if (err && /UNIQUE|constraint/i.test(String(err.message || ''))) {
    return erro('Já existe uma mesa com este número nesta empresa.', 409, 'MESA_NUMERO_DUPLICADO');
  }
  return err;
}

async function listar(empresaId, opts = {}) {
  const emp = exigirEmpresa(empresaId);
  const db = conn(opts);
  const where = ['empresa_id = ?'];
  if (opts.somenteAtivas) where.push('ativo = 1');
  const rows = await all(db, `SELECT * FROM mesas WHERE ${where.join(' AND ')} ORDER BY numero ASC`, [emp]);
  return { success: true, itens: rows.map(mapear) };
}

async function obterDaEmpresa(empresaId, mesaId, opts = {}) {
  const emp = exigirEmpresa(empresaId);
  const id = Number(mesaId);
  if (!Number.isInteger(id) || id <= 0) {
    throw erro('Mesa inválida.', 400, 'MESA_INVALIDA');
  }
  const row = await get(conn(opts), 'SELECT * FROM mesas WHERE id = ?', [id]);
  if (!row) throw erro('Mesa não encontrada.', 404, 'MESA_NAO_ENCONTRADA');
  if (Number(row.empresa_id) !== emp) {
    // Mesa de outra empresa é tratada como inexistente para não vazar dados entre empresas.
    throw erro('Mesa não encontrada.', 404, 'MESA_NAO_ENCONTRADA');
  }
  return mapear(row);
}

async function criar(empresaId, body = {}, opts = {}) {
  const emp = exigirEmpresa(empresaId);
  const numero = normalizarNumero(body.numero);
  const db = conn(opts);
  const dup = await get(db, 'SELECT id FROM mesas WHERE empresa_id = ? AND numero = ?', [emp, numero]);
  if (dup) throw erro('Já existe uma mesa com este número nesta empresa.', 409, 'MESA_NUMERO_DUPLICADO');
  try {
    const ins = await run(
      db,
      'INSERT INTO mesas (empresa_id, numero, ativo, updated_at) VALUES (?, ?, 1, CURRENT_TIMESTAMP)',
      [emp, numero]
    );
    return { success: true, mesa: await obterDaEmpresa(emp, ins.lastID, opts) };
  } catch (err) {
    throw traduzirConflito(err);
  }
}

async function atualizar(empresaId, mesaId, body = {}, opts = {}) {
  const emp = exigirEmpresa(empresaId);
  const atual = await obterDaEmpresa(emp, mesaId, opts);
  const db = conn(opts);
  const sets = [];
  const params = [];
  if (body.numero !== undefined) {
    const numero = normalizarNumero(body.numero);
    if (numero !== atual.numero) {
      const dup = await get(
        db,
        'SELECT id FROM mesas WHERE empresa_id = ? AND numero = ? AND id <> ?',
        [emp, numero, atual.id]
      );
      if (dup) throw erro('Já existe uma mesa com este número nesta empresa.', 409, 'MESA_NUMERO_DUPLICADO');
      sets.push('numero = ?');
      params.push(numero);
    }
  }
  if (body.ativo !== undefined) {
    sets.push('ativo = ?');
    params.push(body.ativo === true || body.ativo === 1 || body.ativo === '1' || body.ativo === 'true' ? 1 : 0);
  }
  if (sets.length) {
    sets.push('updated_at = CURRENT_TIMESTAMP');
    try {
      await run(db, `UPDATE mesas SET ${sets.join(', ')} WHERE id = ? AND empresa_id = ?`, [...params, atual.id, emp]);
    } catch (err) {
      throw traduzirConflito(err);
    }
  }
  return { success: true, mesa: await obterDaEmpresa(emp, atual.id, opts) };
}

/**
 * Valida a mesa de um pedido no backend: existe, pertence à empresa e (para novos
 * vínculos) está ativa. Retorna o id normalizado ou null quando não há mesa.
 */
async function validarMesaDoPedido(empresaId, mesaId, opts = {}) {
  if (mesaId == null || mesaId === '') return null;
  const mesa = await obterDaEmpresa(empresaId, mesaId, opts);
  if (!mesa.ativo && !opts.permitirInativa) {
    throw erro(`A Mesa ${mesa.numero} está desativada e não pode receber novos pedidos.`, 409, 'MESA_INATIVA');
  }
  return mesa.id;
}

module.exports = {
  listar,
  criar,
  atualizar,
  obterDaEmpresa,
  validarMesaDoPedido
};
