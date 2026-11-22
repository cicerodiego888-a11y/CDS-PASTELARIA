'use strict';

const Module = require('node:module');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const ledgerPath = require.resolve('../../backend/services/cozinha/CozinhaRetiradaLedgerService');
const turnoMock = {
  async resolverTurnoOperacional() { return { id: 5 }; },
  async vincularEventoAoTurno() {}
};
const loadOriginal = Module._load;
Module._load = function loadWithTurnoMock(request, parent, isMain) {
  if (request === './CozinhaTurnoService' && parent && parent.filename === ledgerPath) {
    return turnoMock;
  }
  return loadOriginal.call(this, request, parent, isMain);
};
const CozinhaRetiradaLedger = require(ledgerPath);
Module._load = loadOriginal;

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
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

function openMemory() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => {
      if (err) reject(err);
      else resolve(db);
    });
  });
}

function close(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

async function seed(db) {
  await run(db, `CREATE TABLE pedidos (
    id INTEGER PRIMARY KEY, empresa_id INTEGER NOT NULL, status TEXT NOT NULL
  )`);
  await run(db, `CREATE TABLE pedidos_itens (
    id INTEGER PRIMARY KEY, pedido_id INTEGER NOT NULL, empresa_id INTEGER NOT NULL,
    quantidade REAL NOT NULL
  )`);
  await run(db, `CREATE TABLE cozinha_rodadas (
    id INTEGER PRIMARY KEY, empresa_id INTEGER NOT NULL, unidade_id INTEGER NOT NULL,
    turno_id INTEGER,
    estado_preparacao TEXT NOT NULL, retirada_estado TEXT NOT NULL,
    retirada_em TEXT, retirada_por INTEGER, updated_at TEXT
  )`);
  await run(db, `CREATE TABLE cozinha_itens (
    id INTEGER PRIMARY KEY, empresa_id INTEGER NOT NULL, unidade_id INTEGER NOT NULL,
    pedido_id INTEGER NOT NULL, pedido_item_id INTEGER NOT NULL, rodada_id INTEGER NOT NULL,
    tipo_item TEXT NOT NULL, estado_preparacao TEXT NOT NULL, qty_solicitada_millis INTEGER NOT NULL
  )`);
  await run(db, `CREATE TABLE cozinha_idempotencia (
    id INTEGER PRIMARY KEY AUTOINCREMENT, idempotency_key TEXT NOT NULL UNIQUE,
    tipo_operacao TEXT NOT NULL, contexto TEXT, payload_hash TEXT NOT NULL,
    situacao TEXT NOT NULL, resultado_json TEXT, resultado_http_status INTEGER,
    recurso_tipo TEXT, recurso_id INTEGER, concluded_at TEXT
  )`);
  await run(db, `CREATE TABLE cozinha_retirada_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER NOT NULL, unidade_id INTEGER NOT NULL,
    pedido_id INTEGER NOT NULL, pedido_item_id INTEGER NOT NULL, cozinha_item_id INTEGER NOT NULL,
    rodada_id INTEGER NOT NULL, tipo_evento TEXT NOT NULL, qty_millis INTEGER NOT NULL, turno_id INTEGER,
    operador_id INTEGER NOT NULL, autorizado_por_operador_id INTEGER, operacao_id TEXT,
    evento_origem_id INTEGER, justificativa TEXT, registrado_em TEXT NOT NULL
  )`);
  await run(db, `CREATE TABLE cozinha_cancelamento_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER NOT NULL, unidade_id INTEGER NOT NULL,
    pedido_id INTEGER NOT NULL, pedido_item_id INTEGER NOT NULL, cozinha_item_id INTEGER NOT NULL,
    turno_id INTEGER,
    rodada_id INTEGER NOT NULL, tipo_evento TEXT NOT NULL, qty_millis INTEGER NOT NULL
  )`);
  await run(db, `CREATE TABLE cozinha_bebida_entregas (
    id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER NOT NULL,
    cozinha_item_id INTEGER NOT NULL, rodada_id INTEGER NOT NULL, qty_entregue_millis INTEGER NOT NULL
  )`);
  await run(db, `CREATE TABLE cozinha_eventos_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER NOT NULL, unidade_id INTEGER NOT NULL,
    tipo TEXT NOT NULL, payload_json TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE
  )`);

  await run(db, `INSERT INTO pedidos (id, empresa_id, status) VALUES (90, 1, 'PEDIDO')`);
  await run(db, `INSERT INTO pedidos_itens (id, pedido_id, empresa_id, quantidade)
    VALUES (901, 90, 1, 1), (902, 90, 1, 1)`);
  await run(db, `INSERT INTO cozinha_rodadas
    (id, empresa_id, unidade_id, estado_preparacao, retirada_estado)
    VALUES (22, 1, 3, 'EM_PREPARACAO', 'PENDENTE')`);
  await run(db, `INSERT INTO cozinha_itens (
    id, empresa_id, unidade_id, pedido_id, pedido_item_id, rodada_id,
    tipo_item, estado_preparacao, qty_solicitada_millis
  ) VALUES
    (801, 1, 3, 90, 901, 22, 'BEBIDA', 'PRONTO', 1000),
    (802, 1, 3, 90, 902, 22, 'PASTEL', 'AGUARDANDO', 1000)`);
  await run(db, `INSERT INTO cozinha_bebida_entregas
    (empresa_id, cozinha_item_id, rodada_id, qty_entregue_millis)
    VALUES (1, 801, 22, 1000)`);
}

describe('Retirada individual no ledger (SQLite :memory:)', () => {
  it('registra a bebida antes do pastel e completa a rodada somente após a segunda retirada', async () => {
    const db = await openMemory();
    try {
      await seed(db);

      const bebida = await CozinhaRetiradaLedger.retirarItem({
        empresaId: 1,
        unidade_id: 3,
        operadorId: 7,
        itemId: 801,
        usar_saldo_pendente: true,
        idempotencyKey: 'memory-drink-pickup'
      }, { db });

      assert.equal(bebida.success, true);
      assert.equal(bebida.rodada_retirada, false);
      const estadoAposBebida = await get(db,
        'SELECT estado_preparacao FROM cozinha_rodadas WHERE id = 22');
      assert.equal(estadoAposBebida.estado_preparacao, 'EM_PREPARACAO');
      const concorrentes = await Promise.allSettled([
        CozinhaRetiradaLedger.retirarItem({
          empresaId: 1,
          unidade_id: 3,
          operadorId: 7,
          itemId: 801,
          usar_saldo_pendente: true,
          idempotencyKey: 'memory-drink-concurrent-a'
        }, { db }),
        CozinhaRetiradaLedger.retirarItem({
          empresaId: 1,
          unidade_id: 3,
          operadorId: 8,
          itemId: 801,
          usar_saldo_pendente: true,
          idempotencyKey: 'memory-drink-concurrent-b'
        }, { db })
      ]);
      assert.ok(concorrentes.every((resultado) => resultado.status === 'rejected'
        && resultado.reason.codigo === 'RETIRADA_SEM_SALDO'));
      assert.equal((await all(db, 'SELECT id FROM cozinha_retirada_itens')).length, 1);
      await assert.rejects(
        CozinhaRetiradaLedger.retirarItem({
          empresaId: 1,
          unidade_id: 3,
          operadorId: 7,
          itemId: 802,
          usar_saldo_pendente: true,
          idempotencyKey: 'memory-pastry-not-ready'
        }, { db }),
        (err) => err.codigo === 'ITEM_NAO_PRONTO'
      );

      await run(db, `UPDATE cozinha_itens SET estado_preparacao = 'PRONTO' WHERE id = 802`);
      await run(db, `UPDATE cozinha_rodadas SET estado_preparacao = 'PRONTA' WHERE id = 22`);
      const pastel = await CozinhaRetiradaLedger.retirarItem({
        empresaId: 1,
        unidade_id: 3,
        operadorId: 7,
        itemId: 802,
        usar_saldo_pendente: true,
        idempotencyKey: 'memory-pastry-pickup'
      }, { db });

      assert.equal(pastel.rodada_retirada, true);
      const eventos = await all(db, `
        SELECT pedido_id, pedido_item_id, cozinha_item_id, tipo_evento, qty_millis
        FROM cozinha_retirada_itens
        ORDER BY cozinha_item_id
      `);
      assert.deepEqual(eventos, [
        {
          pedido_id: 90,
          pedido_item_id: 901,
          cozinha_item_id: 801,
          tipo_evento: 'RETIRADA_CONFIRMADA',
          qty_millis: 1000
        },
        {
          pedido_id: 90,
          pedido_item_id: 902,
          cozinha_item_id: 802,
          tipo_evento: 'RETIRADA_CONFIRMADA',
          qty_millis: 1000
        }
      ]);
      const repetida = await CozinhaRetiradaLedger.retirarItem({
        empresaId: 1,
        unidade_id: 3,
        operadorId: 7,
        itemId: 801,
        usar_saldo_pendente: true,
        idempotencyKey: 'memory-drink-pickup'
      }, { db });
      assert.equal(repetida.repetida, true);
      assert.equal((await all(db, 'SELECT id FROM cozinha_retirada_itens')).length, 2);
    } finally {
      await close(db);
    }
  });
});
