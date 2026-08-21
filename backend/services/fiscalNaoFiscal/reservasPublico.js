/**
 * Interface Pública de Reservas — Motor Fiscal × Não Fiscal.
 * RC3.16.1: reservas fiscais de Pedido. MTS NÃO cria reservas.
 *
 * Fase 1 / Implementação 01: contrato preparado para produtoId + empresaId.
 * Storage de reservado_* permanece em `produtos` (sem nova estrutura).
 *
 * @module services/fiscalNaoFiscal/reservasPublico
 */
'use strict';

const { calcularEstoqueProduto } = require('../estoque/EstoqueDisponivelService');
const {
  produtoControlaEstoque,
  SALDO_VIRTUAL_SEM_CONTROLE
} = require('../estoque/produtoControlaEstoque');
const { TipoSaldo, normalizarTipoSaldo } = require('./constants');
const {
  resolverEmpresaId,
  resolverContextoEmpresa,
  logOperacaoSaldo,
  COMPAT_CERTIFICADA_PRE_MULTIEMPRESA
} = require('./empresaContexto');

function round3(n) {
  return Math.round(Number(n || 0) * 1000) / 1000;
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
      resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

/** sqlite3 não expõe inTransaction; nested BEGIN falha com esta mensagem. */
const RE_TX_JA_ATIVA = /cannot start a transaction within a transaction/i;

/**
 * RC5.1.2 — executa work reutilizando TX ativa, ou com BEGIN IMMEDIATE própria.
 * @param {object} db
 * @param {() => Promise<*>} work
 */
async function executarComTxOuReutilizar(db, work) {
  let propria = false;
  try {
    await dbRun(db, 'BEGIN IMMEDIATE');
    propria = true;
  } catch (err) {
    if (!RE_TX_JA_ATIVA.test(String(err && err.message || ''))) {
      throw err;
    }
  }

  try {
    const result = await work();
    if (propria) {
      await dbRun(db, 'COMMIT');
    }
    return result;
  } catch (err) {
    if (propria) {
      try {
        await dbRun(db, 'ROLLBACK');
      } catch (_) { /* ignore */ }
    }
    throw err;
  }
}

const SQL_RESERVAS_PEDIDO = `
CREATE TABLE IF NOT EXISTS pedido_estoque_reservas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id INTEGER NOT NULL,
  pedido_item_id INTEGER,
  produto_id INTEGER NOT NULL,
  quantidade_fiscal REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ATIVA',
  criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
  atualizado_em DATETIME
)
`;

async function garantirSchemaReservas(db) {
  await dbRun(db, SQL_RESERVAS_PEDIDO);
  await dbRun(db, `CREATE INDEX IF NOT EXISTS idx_pedido_reservas_pedido_status
    ON pedido_estoque_reservas(pedido_id, status)`);
  await dbRun(db, `CREATE INDEX IF NOT EXISTS idx_pedido_reservas_produto_status
    ON pedido_estoque_reservas(produto_id, status)`);
}

function mesclarOptsEmpresa(produtoIdOrParams, opts = {}) {
  if (
    produtoIdOrParams
    && typeof produtoIdOrParams === 'object'
    && !Array.isArray(produtoIdOrParams)
  ) {
    const p = produtoIdOrParams;
    return {
      produtoId: p.produtoId != null ? p.produtoId : p.produto_id,
      opts: {
        ...opts,
        ...p,
        empresaId: resolverEmpresaId(p) ?? resolverEmpresaId(opts),
        db: opts.db != null ? opts.db : p.db
      }
    };
  }
  return { produtoId: produtoIdOrParams, opts };
}

/**
 * Consulta disponibilidade líquida (saldo − reservado) no contexto de empresa.
 */
async function consultarDisponibilidade(produtoIdOrParams, opts = {}) {
  const normalized = mesclarOptsEmpresa(produtoIdOrParams, opts);
  const id = Number(normalized.produtoId);
  const callOpts = normalized.opts;

  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('Produto inválido.');
    err.code = 'PRODUTO_INVALIDO';
    throw err;
  }

  const ctx = await resolverContextoEmpresa(callOpts);
  const db = getDb(callOpts.db);
  await garantirSchemaReservas(db);

  const row = await dbGet(
    db,
    `SELECT id,
            COALESCE(saldo_fiscal, 0) AS saldo_fiscal,
            COALESCE(saldo_nao_fiscal, 0) AS saldo_nao_fiscal,
            COALESCE(reservado_fiscal, 0) AS reservado_fiscal,
            COALESCE(reservado_nao_fiscal, 0) AS reservado_nao_fiscal,
            COALESCE(controla_estoque, 1) AS controla_estoque,
            estoque_atual
     FROM produtos WHERE id = ?`,
    [id]
  );

  if (!row) {
    const err = new Error('Produto não encontrado.');
    err.code = 'PRODUTO_NAO_ENCONTRADO';
    throw err;
  }

  if (!produtoControlaEstoque(row)) {
    return Object.freeze({
      produto_id: id,
      empresa_id: ctx.empresaId,
      legado: ctx.legado,
      existe: true,
      controla_estoque: 0,
      estoque_fisico: Number(row.estoque_atual || 0),
      estoque_atual: Number(row.estoque_atual || 0),
      saldo_fiscal: Number(row.saldo_fiscal || 0),
      saldo_nao_fiscal: Number(row.saldo_nao_fiscal || 0),
      reservado_fiscal: 0,
      reservado_nao_fiscal: 0,
      disponivel_fiscal: SALDO_VIRTUAL_SEM_CONTROLE,
      disponivel_nao_fiscal: SALDO_VIRTUAL_SEM_CONTROLE,
      disponivel_total: SALDO_VIRTUAL_SEM_CONTROLE * 2
    });
  }

  const calc = calcularEstoqueProduto(row);
  return Object.freeze({
    produto_id: id,
    empresa_id: ctx.empresaId,
    legado: ctx.legado,
    existe: true,
    controla_estoque: 1,
    estoque_atual: calc.estoque_fisico,
    ...calc
  });
}

/**
 * Disponibilidade líquida, descontando reservas de OUTROS pedidos.
 * Se `pedidoId` for informado, as reservas ATIVAS desse pedido voltam a contar
 * como disponíveis (reativação / edição / reenvio).
 */
async function consultarDisponibilidadeParaPedido(produtoId, pedidoId, opts = {}) {
  const disp = await consultarDisponibilidade(produtoId, opts);
  const pid = Number(pedidoId);
  if (!Number.isInteger(pid) || pid <= 0) return disp;

  const db = getDb(opts.db);
  await garantirSchemaReservas(db);
  const row = await dbGet(
    db,
    `SELECT COALESCE(SUM(quantidade_fiscal), 0) AS q
     FROM pedido_estoque_reservas
     WHERE pedido_id = ? AND produto_id = ? AND status = 'ATIVA'`,
    [pid, Number(disp.produto_id)]
  );
  const propria = round3(row?.q || 0);
  if (propria <= 0) return disp;

  return Object.freeze({
    ...disp,
    reservado_fiscal: Math.max(0, round3(disp.reservado_fiscal - propria)),
    disponivel_fiscal: round3(disp.disponivel_fiscal + propria),
    disponivel_total: round3(disp.disponivel_total + propria)
  });
}

async function _criarReservaTipo(params = {}, opts = {}, tipoSaldo) {
  const tipo = normalizarTipoSaldo(tipoSaldo);
  const pedidoId = Number(params.pedidoId || params.pedido_id);
  const produtoId = Number(params.produtoId || params.produto_id);
  const quantidade = round3(
    params.quantidade
    ?? params.quantidade_fiscal
    ?? params.quantidade_nao_fiscal
  );
  const pedidoItemId = params.pedidoItemId != null || params.pedido_item_id != null
    ? Number(params.pedidoItemId ?? params.pedido_item_id)
    : null;

  const callOpts = {
    ...opts,
    empresaId: resolverEmpresaId(params) ?? resolverEmpresaId(opts),
    modoLegadoSemEmpresa: opts.modoLegadoSemEmpresa === true
      || params.modoLegadoSemEmpresa === true,
    motivoCompat: opts.motivoCompat || params.motivoCompat,
    validarEmpresa: opts.validarEmpresa || params.validarEmpresa,
    usuarioId: opts.usuarioId != null ? opts.usuarioId : params.usuarioId,
    db: opts.db != null ? opts.db : params.db
  };

  if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
    const err = new Error('Pedido inválido para reserva.');
    err.code = 'PEDIDO_INVALIDO';
    throw err;
  }
  if (!(quantidade > 0)) {
    const err = new Error('Quantidade de reserva inválida.');
    err.code = 'QUANTIDADE_INVALIDA';
    throw err;
  }

  const ctx = await resolverContextoEmpresa(callOpts);
  const db = getDb(callOpts.db);
  await garantirSchemaReservas(db);

  const disp = await consultarDisponibilidade(produtoId, { ...callOpts, db });
  if (!produtoControlaEstoque(disp)) {
    return Object.freeze({
      id: null,
      pedido_id: pedidoId,
      produto_id: produtoId,
      empresa_id: ctx.empresaId,
      legado: ctx.legado,
      tipo,
      quantidade_fiscal: tipo === TipoSaldo.FISCAL ? quantidade : 0,
      quantidade_nao_fiscal: tipo === TipoSaldo.NAO_FISCAL ? quantidade : 0,
      status: 'IGNORADA',
      controla_estoque: 0
    });
  }

  const disponivel = tipo === TipoSaldo.FISCAL
    ? disp.disponivel_fiscal
    : disp.disponivel_nao_fiscal;

  if (disponivel + 1e-9 < quantidade) {
    const err = new Error(
      tipo === TipoSaldo.FISCAL
        ? 'Saldo fiscal insuficiente para reserva.'
        : 'Saldo não fiscal insuficiente para reserva.'
    );
    err.code = 'SALDO_INSUFICIENTE';
    err.saldo_disponivel = disponivel;
    throw err;
  }

  const ins = await executarComTxOuReutilizar(db, async () => {
    await _aplicarDeltaReservado(db, produtoId, tipo, quantidade);

    // Tracking de pedido permanece na estrutura fiscal existente (sem migration).
    // Reservas NF atualizam apenas reservado_nao_fiscal em produtos nesta Sprint.
    if (tipo === TipoSaldo.FISCAL) {
      return dbRun(
        db,
        `INSERT INTO pedido_estoque_reservas (
        pedido_id, pedido_item_id, produto_id, quantidade_fiscal, status, criado_em
      ) VALUES (?, ?, ?, ?, 'ATIVA', CURRENT_TIMESTAMP)`,
        [pedidoId, pedidoItemId, produtoId, quantidade]
      );
    }

    return { lastID: null, changes: 1 };
  });

  logOperacaoSaldo({
    operacao: tipo === TipoSaldo.FISCAL ? 'criarReservaFiscal' : 'criarReservaNaoFiscal',
    produtoId,
    empresaId: ctx.empresaId,
    tipo,
    quantidade,
    legado: ctx.legado,
    usuarioId: callOpts.usuarioId
  });

  return Object.freeze({
    id: ins.lastID,
    pedido_id: pedidoId,
    produto_id: produtoId,
    empresa_id: ctx.empresaId,
    legado: ctx.legado,
    tipo,
    quantidade_fiscal: tipo === TipoSaldo.FISCAL ? quantidade : 0,
    quantidade_nao_fiscal: tipo === TipoSaldo.NAO_FISCAL ? quantidade : 0,
    status: 'ATIVA'
  });
}

async function criarReservaFiscal(params = {}, opts = {}) {
  return _criarReservaTipo(params, opts, TipoSaldo.FISCAL);
}

/**
 * Reserva não fiscal no contexto produto + empresa.
 * Storage: produtos.reservado_nao_fiscal (sem nova tabela nesta Sprint).
 */
async function criarReservaNaoFiscal(params = {}, opts = {}) {
  return _criarReservaTipo(params, opts, TipoSaldo.NAO_FISCAL);
}

/**
 * Libera reservas ativas de um pedido (tracking fiscal em pedido_estoque_reservas).
 */
async function liberarReservasPedido(pedidoId, opts = {}) {
  const id = Number(pedidoId);
  await resolverContextoEmpresa(opts);
  const db = getDb(opts.db);
  await garantirSchemaReservas(db);

  const rows = await dbAll(
    db,
    `SELECT * FROM pedido_estoque_reservas WHERE pedido_id = ? AND status = 'ATIVA'`,
    [id]
  );

  for (const row of rows) {
    const q = round3(row.quantidade_fiscal);
    if (q > 0) {
      await _aplicarDeltaReservado(db, row.produto_id, TipoSaldo.FISCAL, -q);
    }
    await dbRun(
      db,
      `UPDATE pedido_estoque_reservas
       SET status = 'CANCELADA', atualizado_em = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [row.id]
    );
  }

  return { liberadas: rows.length, empresa_id: resolverEmpresaId(opts) };
}

/**
 * Aplica delta em reservado_fiscal ou reservado_nao_fiscal.
 * Não altera saldo físico. Não grava tracking de pedido/venda.
 * delta > 0 incrementa; delta < 0 decrementa com piso 0.
 */
async function _aplicarDeltaReservado(db, produtoId, tipo, delta) {
  const tipoN = normalizarTipoSaldo(tipo);
  const d = round3(delta);
  if (d === 0) return { changes: 0 };

  const id = Number(produtoId);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('Produto inválido.');
    err.code = 'PRODUTO_INVALIDO';
    throw err;
  }

  const row = await dbGet(db, `SELECT id FROM produtos WHERE id = ?`, [id]);
  if (!row) {
    const err = new Error('Produto não encontrado.');
    err.code = 'PRODUTO_NAO_ENCONTRADO';
    throw err;
  }

  const coluna = tipoN === TipoSaldo.FISCAL ? 'reservado_fiscal' : 'reservado_nao_fiscal';
  if (d > 0) {
    return dbRun(
      db,
      `UPDATE produtos SET ${coluna} = COALESCE(${coluna}, 0) + ? WHERE id = ?`,
      [d, id]
    );
  }

  const q = Math.abs(d);
  return dbRun(
    db,
    `UPDATE produtos
     SET ${coluna} = CASE
       WHEN COALESCE(${coluna}, 0) - ? < 0 THEN 0
       ELSE COALESCE(${coluna}, 0) - ?
     END
     WHERE id = ?`,
    [q, q, id]
  );
}

/**
 * Incrementa ou decrementa reservado_* no contexto de empresa.
 * Não exige pedidoId (reservas PDV / venda_estoque_reservas).
 * Não altera saldo_fiscal / saldo_nao_fiscal / estoque_atual.
 */
async function ajustarReservado(produtoIdOrParams, tipo, delta, opts = {}) {
  const normalized = mesclarOptsEmpresa(produtoIdOrParams, opts);
  const produtoId = Number(normalized.produtoId);
  const callOpts = normalized.opts;
  const d = round3(delta);

  const ctx = await resolverContextoEmpresa(callOpts);
  const db = getDb(callOpts.db);
  await _aplicarDeltaReservado(db, produtoId, tipo, d);

  logOperacaoSaldo({
    operacao: d >= 0 ? 'reservarQuantidade' : 'liberarQuantidadeReservada',
    produtoId,
    empresaId: ctx.empresaId,
    tipo: normalizarTipoSaldo(tipo),
    quantidade: Math.abs(d),
    legado: ctx.legado,
    usuarioId: callOpts.usuarioId
  });

  return consultarDisponibilidade(produtoId, { ...callOpts, db });
}

async function reservarQuantidade(produtoId, tipo, quantidade, opts = {}) {
  const q = round3(quantidade);
  if (!(q > 0)) {
    const err = new Error('Quantidade de reserva inválida.');
    err.code = 'QUANTIDADE_INVALIDA';
    throw err;
  }
  return ajustarReservado(produtoId, tipo, q, opts);
}

async function liberarQuantidadeReservada(produtoId, tipo, quantidade, opts = {}) {
  const q = round3(quantidade);
  if (!(q > 0)) {
    const err = new Error('Quantidade de reserva inválida.');
    err.code = 'QUANTIDADE_INVALIDA';
    throw err;
  }
  return ajustarReservado(produtoId, tipo, -q, opts);
}

module.exports = {
  SQL_RESERVAS_PEDIDO,
  garantirSchemaReservas,
  consultarDisponibilidade,
  consultarDisponibilidadeParaPedido,
  criarReservaFiscal,
  criarReservaNaoFiscal,
  liberarReservasPedido,
  ajustarReservado,
  reservarQuantidade,
  liberarQuantidadeReservada,
  COMPAT_CERTIFICADA_PRE_MULTIEMPRESA
};
