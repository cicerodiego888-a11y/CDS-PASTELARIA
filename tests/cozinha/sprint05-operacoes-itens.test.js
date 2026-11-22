/**
 * Sprint 05 — Operações e transições dos itens da Cozinha.
 * SQLite exclusivamente em memória. Sem banco oficial ou arquivos SQLite.
 *
 * Executar:
 *   node --test --test-concurrency=1 tests/cozinha/sprint05-operacoes-itens.test.js
 */
'use strict';

const Module = require('node:module');
const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;
delete process.env.DB_DIR;

const databasePath = require.resolve('../../backend/database');
const databaseMemory = new sqlite3.Database(':memory:');
const databaseMock = new Module(databasePath);
databaseMock.filename = databasePath;
databaseMock.loaded = true;
databaseMock.exports = databaseMemory;
require.cache[databasePath] = databaseMock;

const {
  garantirSchemaCozinha,
  marcarCozinhaOperacional,
  isCozinhaOperacional
} = require('../../backend/utils/cozinhaSchema');
const CozinhaDespacho = require('../../backend/services/cozinha/CozinhaDespachoService');
const CozinhaPreparacao = require('../../backend/services/cozinha/CozinhaPreparacaoService');
const CozinhaRetiradaLedger = require('../../backend/services/cozinha/CozinhaRetiradaLedgerService');
const { executarMigracaoSprint2 } = require('../../backend/migrations/sprint2-cozinha-ledgers');
const { TIPOS_OPERACAO } = require('../../backend/services/cozinha/cozinhaIdempotenciaHash');
const {
  resolverUnidadeOperacionalReq
} = require('../../backend/services/cozinha/cozinhaUnidadeOperacional');

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function cb(err) {
      if (err) reject(err);
      else resolve(this);
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
function open() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => {
      if (err) return reject(err);
      db.serialize(() => {
        db.run('PRAGMA foreign_keys = ON');
        db.run('PRAGMA busy_timeout = 10000', (e) => (e ? reject(e) : resolve(db)));
      });
    });
  });
}
function close(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

async function schemaErp(db) {
  await run(db, `
    CREATE TABLE IF NOT EXISTS empresas (
      id INTEGER PRIMARY KEY,
      nome TEXT
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY,
      username TEXT,
      password_hash TEXT,
      role TEXT,
      perfil TEXT,
      ativo INTEGER NOT NULL DEFAULT 1,
      nome TEXT
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS configuracoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chave VARCHAR(100) UNIQUE NOT NULL,
      valor TEXT, tipo VARCHAR(50), descricao TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS categorias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS mesas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL,
      numero INTEGER NOT NULL,
      ativo INTEGER NOT NULL DEFAULT 1
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS mesa_atendimentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL,
      mesa_id INTEGER NOT NULL,
      estado TEXT NOT NULL,
      operador_abertura_id INTEGER NOT NULL DEFAULT 1,
      aberto_em TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      tipo_operacional TEXT DEFAULT 'COMERCIAL',
      comercializavel INTEGER DEFAULT 0,
      categoria_id INTEGER,
      utiliza_ficha_tecnica INTEGER DEFAULT 0,
      permite_personalizacao_ingredientes INTEGER DEFAULT 0
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS ficha_tecnica (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produto_id INTEGER NOT NULL,
      ativo INTEGER DEFAULT 1
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS pedidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo VARCHAR(50),
      data_pedido DATE DEFAULT '2026-01-01',
      total DECIMAL(10,2) DEFAULT 0,
      status TEXT DEFAULT 'PEDIDO',
      empresa_id INTEGER,
      mesa_id INTEGER,
      mesa_atendimento_id INTEGER
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS pedidos_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER NOT NULL,
      empresa_id INTEGER NOT NULL,
      produto_id INTEGER NOT NULL,
      quantidade REAL NOT NULL,
      preco_unitario DECIMAL(10,2) DEFAULT 0,
      subtotal DECIMAL(10,2) DEFAULT 0,
      classificacao_operacional_snapshot TEXT,
      produto_nome_snapshot TEXT,
      observacao TEXT
    )
  `);
  await run(db, `
    CREATE UNIQUE INDEX IF NOT EXISTS ux_pedidos_id_empresa
    ON pedidos(id, empresa_id)
  `);
  await run(db, `
    CREATE UNIQUE INDEX IF NOT EXISTS ux_pedidos_itens_id_pedido_empresa
    ON pedidos_itens(id, pedido_id, empresa_id)
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS pedido_item_ingredientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER NOT NULL,
      pedido_item_id INTEGER NOT NULL,
      empresa_id INTEGER NOT NULL,
      insumo_id INTEGER NOT NULL,
      insumo_nome_snapshot TEXT NOT NULL,
      quantidade_snapshot REAL NOT NULL,
      unidade_snapshot TEXT NOT NULL,
      classificacao_comercial_snapshot TEXT NOT NULL,
      selecionado INTEGER NOT NULL,
      preco_adicional_snapshot REAL DEFAULT 0
    )
  `);
  const info = await garantirSchemaCozinha(db);
  assert.equal(info.operacional, true);
  await executarMigracaoSprint2(db, { isolamentoExplicito: true });
  assert.equal(isCozinhaOperacional(), true);
}

async function seedInfra(db, empresaId = 1) {
  await run(db, `
    INSERT OR IGNORE INTO empresas (id, nome) VALUES (?, ?)
  `, [empresaId, `Empresa ${empresaId}`]);
  await run(db, `
    INSERT OR IGNORE INTO usuarios (id, username, role, perfil, ativo)
    VALUES (7, 'kds_operator', 'operador', 'USUARIO', 1)
  `);
  const catRef = await run(db, `INSERT INTO categorias (nome) VALUES ('Refrigerantes')`);
  const catOut = await run(db, `INSERT INTO categorias (nome) VALUES ('Diversos')`);

  const pastel = await run(db, `
    INSERT INTO produtos (
      nome, tipo_operacional, comercializavel, categoria_id,
      utiliza_ficha_tecnica, permite_personalizacao_ingredientes
    ) VALUES ('Pastel do Cheff', 'COMERCIAL', 0, ?, 1, 1)
  `, [catOut.lastID]);
  await run(db, `INSERT INTO ficha_tecnica (produto_id, ativo) VALUES (?, 1)`, [pastel.lastID]);

  const carneSol = await run(db, `
    INSERT INTO produtos (nome, tipo_operacional, comercializavel)
    VALUES ('Carne de Sol', 'INSUMO', 0)
  `);

  const fanta = await run(db, `
    INSERT INTO produtos (
      nome, tipo_operacional, comercializavel, categoria_id
    ) VALUES ('Fanta Lata 350 ML', 'INSUMO', 1, ?)
  `, [catRef.lastID]);

  const outro = await run(db, `
    INSERT INTO produtos (nome, tipo_operacional, comercializavel, categoria_id)
    VALUES ('Produto Generico', 'COMERCIAL', 0, ?)
  `, [catOut.lastID]);

  const mesa = await run(db, `
    INSERT INTO mesas (empresa_id, numero, ativo) VALUES (?, 10, 1)
  `, [empresaId]);
  const at = await run(db, `
    INSERT INTO mesa_atendimentos (empresa_id, mesa_id, estado)
    VALUES (?, ?, 'OCUPADA')
  `, [empresaId, mesa.lastID]);
  const un = await run(db, `
    INSERT INTO cozinha_unidades (empresa_id, codigo, sequencia_atual)
    VALUES (?, ?, 0)
  `, [empresaId, `U-${empresaId}-${Date.now()}-${Math.random()}`]);
  await run(db, `
    INSERT INTO cozinha_turnos (
      empresa_id, unidade_id, estado, abertura_operador_id, abertura_em
    ) VALUES (?, ?, 'ABERTA', 7, datetime('now'))
  `, [empresaId, un.lastID]);

  return {
    empresaId,
    mesaId: mesa.lastID,
    atendimentoId: at.lastID,
    unidadeId: un.lastID,
    prodPastelId: pastel.lastID,
    prodCarneSolId: carneSol.lastID,
    prodFantaId: fanta.lastID,
    prodOutroId: outro.lastID
  };
}

async function criarPedidoItem(db, infra, {
  produtoId,
  nome,
  classifSnapshot,
  qty = 1,
  comPersonalizacao = false
}) {
  const ped = await run(db, `
    INSERT INTO pedidos (
      codigo, status, empresa_id, mesa_id, mesa_atendimento_id, total
    ) VALUES (?, 'PEDIDO', ?, ?, ?, 10)
  `, [
    `P-${infra.empresaId}-${Date.now()}-${Math.random()}`,
    infra.empresaId,
    infra.mesaId,
    infra.atendimentoId
  ]);
  const item = await run(db, `
    INSERT INTO pedidos_itens (
      pedido_id, empresa_id, produto_id, quantidade, preco_unitario, subtotal,
      classificacao_operacional_snapshot, produto_nome_snapshot
    ) VALUES (?, ?, ?, ?, 10, 10, ?, ?)
  `, [ped.lastID, infra.empresaId, produtoId, qty, classifSnapshot, nome]);

  if (comPersonalizacao) {
    await run(db, `
      INSERT INTO pedido_item_ingredientes (
        pedido_id, pedido_item_id, empresa_id, insumo_id,
        insumo_nome_snapshot, quantidade_snapshot, unidade_snapshot,
        classificacao_comercial_snapshot, selecionado, preco_adicional_snapshot
      ) VALUES (?, ?, ?, ?, 'Carne de Sol', 1.000, 'UN', 'ADICIONAL', 1, 0)
    `, [ped.lastID, item.lastID, infra.empresaId, infra.prodCarneSolId]);
  }

  const cmd = await run(db, `
    INSERT INTO cozinha_comandas (
      empresa_id, atendimento_id, numero_comanda, pedido_id, operador_lancamento_id
    ) VALUES (?, ?, ?, ?, 1)
  `, [
    infra.empresaId,
    infra.atendimentoId,
    Math.floor(Math.random() * 9000) + 1,
    ped.lastID
  ]);

  return {
    pedidoId: ped.lastID,
    pedidoItemId: item.lastID,
    comandaId: cmd.lastID
  };
}

function entradaDespacho(infra, itens, chave) {
  return {
    empresaId: infra.empresaId,
    operadorId: 7,
    idempotencyKey: chave,
    unidade_id: infra.unidadeId,
    mesa_id: infra.mesaId,
    atendimento_id: infra.atendimentoId,
    itens
  };
}

async function despacharItens(db, infra, linhas, chave) {
  const itens = linhas.map((l) => ({
    pedido_id: l.pedidoId,
    pedido_item_id: l.pedidoItemId,
    comanda_id: l.comandaId,
    qty_solicitada: l.qty || '1.000'
  }));
  return CozinhaDespacho.despacharLote(entradaDespacho(infra, itens, chave), { db });
}

async function despacharPastel(db, infra, chave) {
  const pastel = await criarPedidoItem(db, infra, {
    produtoId: infra.prodPastelId,
    nome: 'Pastel do Cheff',
    classifSnapshot: 'COMERCIAL',
    comPersonalizacao: true
  });
  const out = await despacharItens(db, infra, [pastel], chave);
  return { pastel, out, itemId: out.itens[0].id, rodadaId: out.rodada.id };
}

async function despacharBebida(db, infra, chave, qty = '3.000') {
  const bebida = await criarPedidoItem(db, infra, {
    produtoId: infra.prodFantaId,
    nome: 'Fanta Lata 350 ML',
    classifSnapshot: 'INSUMO',
    qty: Number(qty)
  });
  const out = await despacharItens(db, infra, [{ ...bebida, qty }], chave);
  return { bebida, out, itemId: out.itens[0].id, rodadaId: out.rodada.id };
}

async function deixarItemPronto(db, infra, itemId, chave) {
  const contexto = {
    empresaId: infra.empresaId,
    operadorId: 7,
    unidade_id: infra.unidadeId,
    itemId
  };
  await CozinhaPreparacao.iniciarPreparacao({
    ...contexto,
    idempotencyKey: `${chave}-inicio`
  }, { db });
  return CozinhaPreparacao.marcarItemPronto({
    ...contexto,
    idempotencyKey: `${chave}-pronto`
  }, { db });
}

describe('Sprint 05 — Operações dos itens', () => {
  beforeEach(() => marcarCozinhaOperacional(false));
  after(async () => close(databaseMemory));

  describe('Preparação — iniciar', () => {
    it('início válido AGUARDANDO→EM_PREPARACAO + outbox + idempotência PREPARACAO_INICIADA', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const { itemId } = await despacharPastel(db, infra, 's05-ini-ok-desp');

      const prep = await CozinhaPreparacao.iniciarPreparacao({
        empresaId: infra.empresaId,
        operadorId: 7,
        unidade_id: infra.unidadeId,
        itemId,
        idempotencyKey: 's05-ini-ok'
      }, { db });

      assert.equal(prep.success, true);
      assert.equal(prep.item.estado_preparacao, 'EM_PREPARACAO');
      assert.equal(prep.evento, 'PREPARACAO_INICIADA');
      assert.equal(prep.operador_id, 7);
      assert.ok(prep.iniciado_em);

      const row = await get(db, `SELECT estado_preparacao FROM cozinha_itens WHERE id=?`, [itemId]);
      assert.equal(row.estado_preparacao, 'EM_PREPARACAO');

      const idemp = await get(db, `
        SELECT tipo_operacao, situacao FROM cozinha_idempotencia
        WHERE idempotency_key='s05-ini-ok'
      `);
      assert.equal(idemp.tipo_operacao, TIPOS_OPERACAO.PREPARACAO_INICIADA);
      assert.equal(idemp.situacao, 'CONCLUIDA');

      const ev = await all(db, `
        SELECT tipo, payload_json FROM cozinha_eventos_outbox WHERE idempotency_key='s05-ini-ok:EVENTO'
      `);
      assert.equal(ev.length, 1);
      assert.equal(ev[0].tipo, 'PREPARACAO_INICIADA');
      const payload = JSON.parse(ev[0].payload_json);
      assert.equal(payload.operador_id, 7);
      assert.equal(payload.iniciado_em, prep.iniciado_em);
      await close(db);
    });

    it('início duplicado (mesma chave) não duplica evento nem estado', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const { itemId } = await despacharPastel(db, infra, 's05-ini-dup-desp');

      const a = await CozinhaPreparacao.iniciarPreparacao({
        empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId, idempotencyKey: 's05-ini-dup'
      }, { db });
      const b = await CozinhaPreparacao.iniciarPreparacao({
        empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId, idempotencyKey: 's05-ini-dup'
      }, { db });

      assert.equal(a.repetida, false);
      assert.equal(b.repetida, true);
      assert.equal(b.item.estado_preparacao, 'EM_PREPARACAO');

      const ev = await all(db, `
        SELECT id FROM cozinha_eventos_outbox WHERE idempotency_key='s05-ini-dup:EVENTO'
      `);
      assert.equal(ev.length, 1);
      const idemp = await all(db, `
        SELECT id FROM cozinha_idempotencia WHERE idempotency_key='s05-ini-dup'
      `);
      assert.equal(idemp.length, 1);
      await close(db);
    });

    it('inícios simultâneos com chaves distintas geram só um evento operacional', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const { itemId } = await despacharPastel(db, infra, 's05-ini-race-desp');

      const resultados = await Promise.all(['s05-ini-race-a', 's05-ini-race-b'].map((idempotencyKey) => (
        CozinhaPreparacao.iniciarPreparacao({
          empresaId: 1,
          operadorId: 7,
          unidade_id: infra.unidadeId,
          itemId,
          idempotencyKey
        }, { db })
      )));

      assert.deepEqual(resultados.map((r) => r.repetida).sort(), [false, true]);
      assert.equal(resultados.find((r) => !r.repetida).operador_id, 7);
      const eventos = await all(db, `
        SELECT id FROM cozinha_eventos_outbox WHERE tipo='PREPARACAO_INICIADA'
          AND CAST(json_extract(payload_json, '$.item.id') AS INTEGER)=?
      `, [itemId]);
      assert.equal(eventos.length, 1);
      await close(db);
    });

    it('item inexistente', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      await assert.rejects(
        () => CozinhaPreparacao.iniciarPreparacao({
          empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId: 999999, idempotencyKey: 's05-ini-404'
        }, { db }),
        (err) => err.codigo === 'ITEM_INEXISTENTE' || err.statusCode === 404
      );
      await close(db);
    });

    it('estado incompatível: item já PRONTO', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const { itemId } = await despacharPastel(db, infra, 's05-ini-pronto-desp');
      await CozinhaPreparacao.iniciarPreparacao({
        empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId, idempotencyKey: 's05-ini-p1'
      }, { db });
      await CozinhaPreparacao.marcarItemPronto({
        empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId, idempotencyKey: 's05-ini-p2'
      }, { db });

      await assert.rejects(
        () => CozinhaPreparacao.iniciarPreparacao({
          empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId, idempotencyKey: 's05-ini-p3'
        }, { db }),
        (err) => err.codigo === 'TRANSICAO_INVALIDA'
      );
      await close(db);
    });

    it('rejeita comanda pertencente a outro pedido', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const original = await despacharPastel(db, infra, 's05-link-a-desp');
      const outro = await despacharPastel(db, infra, 's05-link-b-desp');
      const outraComanda = await get(db, `
        SELECT comanda_id FROM cozinha_itens WHERE id = ?
      `, [outro.itemId]);
      await run(db, `
        UPDATE cozinha_itens SET comanda_id = ? WHERE id = ?
      `, [outraComanda.comanda_id, original.itemId]);

      await assert.rejects(
        () => CozinhaPreparacao.iniciarPreparacao({
          empresaId: 1,
          operadorId: 7,
          unidade_id: infra.unidadeId,
          itemId: original.itemId,
          idempotencyKey: 's05-item-pedido-incompativel'
        }, { db }),
        (err) => err.codigo === 'ITEM_PEDIDO_INCOMPATIVEL'
      );
      await close(db);
    });

    it('falha durante a transação — rollback integral (estado + idempotência + outbox)', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const { itemId } = await despacharPastel(db, infra, 's05-ini-fail-desp');

      await assert.rejects(
        () => CozinhaPreparacao.iniciarPreparacao({
          empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId, idempotencyKey: 's05-ini-fail'
        }, { db, simularFalha: 'antes_commit' }),
        (err) => err.codigo === 'FALHA_SIMULADA'
      );

      const item = await get(db, `SELECT estado_preparacao FROM cozinha_itens WHERE id=?`, [itemId]);
      assert.equal(item.estado_preparacao, 'AGUARDANDO');
      const idemp = await all(db, `
        SELECT * FROM cozinha_idempotencia WHERE idempotency_key='s05-ini-fail'
      `);
      assert.equal(idemp.length, 0);
      const ev = await all(db, `
        SELECT * FROM cozinha_eventos_outbox WHERE idempotency_key LIKE 's05-ini-fail%'
      `);
      assert.equal(ev.length, 0);
      await close(db);
    });
  });

  describe('Item pronto', () => {
    it('conclusão válida EM_PREPARACAO→PRONTO + ITEM_PRONTO', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const { itemId } = await despacharPastel(db, infra, 's05-pronto-ok-desp');
      await CozinhaPreparacao.iniciarPreparacao({
        empresaId: 1, operadorId: 7, itemId, unidade_id: infra.unidadeId,
        idempotencyKey: 's05-pronto-ok-ini'
      }, { db });

      const pronto = await CozinhaPreparacao.marcarItemPronto({
        empresaId: 1, operadorId: 7, itemId, unidade_id: infra.unidadeId,
        idempotencyKey: 's05-pronto-ok'
      }, { db });

      assert.equal(pronto.item.estado_preparacao, 'PRONTO');
      assert.equal(pronto.evento, 'ITEM_PRONTO');
      assert.equal(pronto.rodada.estado_preparacao, 'PRONTA');
      assert.equal(pronto.operador_id, 7);
      assert.ok(pronto.pronto_em);
      assert.equal(pronto.item.pronto_em, pronto.pronto_em);

      const evento = await get(db, `
        SELECT payload_json FROM cozinha_eventos_outbox WHERE idempotency_key='s05-pronto-ok:EVENTO'
      `);
      const payload = JSON.parse(evento.payload_json);
      assert.equal(payload.operador_id, 7);
      assert.equal(payload.pronto_em, pronto.pronto_em);

      const idemp = await get(db, `
        SELECT tipo_operacao FROM cozinha_idempotencia WHERE idempotency_key='s05-pronto-ok'
      `);
      assert.equal(idemp.tipo_operacao, TIPOS_OPERACAO.ITEM_PRONTO);
      await close(db);
    });

    it('conclusão duplicada não reexecuta', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const { itemId } = await despacharPastel(db, infra, 's05-pronto-dup-desp');
      await CozinhaPreparacao.iniciarPreparacao({
        empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId, idempotencyKey: 's05-pronto-dup-ini'
      }, { db });
      const a = await CozinhaPreparacao.marcarItemPronto({
        empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId, idempotencyKey: 's05-pronto-dup'
      }, { db });
      const b = await CozinhaPreparacao.marcarItemPronto({
        empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId, idempotencyKey: 's05-pronto-dup'
      }, { db });
      assert.equal(b.repetida, true);
      assert.equal(a.item.id, b.item.id);
      const outroClique = await CozinhaPreparacao.marcarItemPronto({
        empresaId: 1, operadorId: 8, unidade_id: infra.unidadeId, itemId, idempotencyKey: 's05-pronto-dup-outra-chave'
      }, { db });
      assert.equal(outroClique.repetida, true);
      const ev = await all(db, `
        SELECT id FROM cozinha_eventos_outbox WHERE idempotency_key='s05-pronto-dup:EVENTO'
      `);
      assert.equal(ev.length, 1);
      const eventosItem = await all(db, `
        SELECT id FROM cozinha_eventos_outbox
        WHERE tipo='ITEM_PRONTO' AND CAST(json_extract(payload_json, '$.item.id') AS INTEGER)=?
      `, [itemId]);
      assert.equal(eventosItem.length, 1);
      await close(db);
    });

    it('conclusões simultâneas registram um único evento e uma transição', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const { itemId } = await despacharPastel(db, infra, 's05-pronto-race-desp');
      await CozinhaPreparacao.iniciarPreparacao({
        empresaId: 1,
        operadorId: 7,
        unidade_id: infra.unidadeId,
        itemId,
        idempotencyKey: 's05-pronto-race-ini'
      }, { db });

      const resultados = await Promise.all([
        CozinhaPreparacao.marcarItemPronto({
          empresaId: 1,
          operadorId: 7,
          unidade_id: infra.unidadeId,
          itemId,
          idempotencyKey: 's05-pronto-race-a'
        }, { db }),
        CozinhaPreparacao.marcarItemPronto({
          empresaId: 1,
          operadorId: 8,
          unidade_id: infra.unidadeId,
          itemId,
          idempotencyKey: 's05-pronto-race-b'
        }, { db })
      ]);

      assert.deepEqual(resultados.map((r) => r.repetida).sort(), [false, true]);
      assert.equal(resultados.find((r) => !r.repetida).operador_id, 7);
      const item = await get(db, `
        SELECT estado_preparacao FROM cozinha_itens WHERE id=?
      `, [itemId]);
      assert.equal(item.estado_preparacao, 'PRONTO');
      const eventos = await all(db, `
        SELECT id FROM cozinha_eventos_outbox
        WHERE tipo='ITEM_PRONTO' AND CAST(json_extract(payload_json, '$.item.id') AS INTEGER)=?
      `, [itemId]);
      assert.equal(eventos.length, 1);
      await close(db);
    });

    it('item inexistente', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      await assert.rejects(
        () => CozinhaPreparacao.marcarItemPronto({
          empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId: 888888, idempotencyKey: 's05-pronto-404'
        }, { db }),
        (err) => err.codigo === 'ITEM_INEXISTENTE' || err.statusCode === 404
      );
      await close(db);
    });

    it('estado incompatível AGUARDANDO→PRONTO', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const { itemId } = await despacharPastel(db, infra, 's05-pronto-bad-desp');
      await assert.rejects(
        () => CozinhaPreparacao.marcarItemPronto({
          empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId, idempotencyKey: 's05-pronto-bad'
        }, { db }),
        (err) => err.codigo === 'TRANSICAO_INVALIDA'
      );
      const row = await get(db, `SELECT estado_preparacao FROM cozinha_itens WHERE id=?`, [itemId]);
      assert.equal(row.estado_preparacao, 'AGUARDANDO');
      await close(db);
    });

    it('falha durante a transação — rollback integral', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const { itemId } = await despacharPastel(db, infra, 's05-pronto-fail-desp');
      await CozinhaPreparacao.iniciarPreparacao({
        empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId, idempotencyKey: 's05-pronto-fail-ini'
      }, { db });

      await assert.rejects(
        () => CozinhaPreparacao.marcarItemPronto({
          empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId, idempotencyKey: 's05-pronto-fail'
        }, { db, simularFalha: 'antes_commit' }),
        (err) => err.codigo === 'FALHA_SIMULADA'
      );

      const item = await get(db, `SELECT estado_preparacao FROM cozinha_itens WHERE id=?`, [itemId]);
      assert.equal(item.estado_preparacao, 'EM_PREPARACAO');
      const idemp = await all(db, `
        SELECT * FROM cozinha_idempotencia WHERE idempotency_key='s05-pronto-fail'
      `);
      assert.equal(idemp.length, 0);
      await close(db);
    });
  });

  describe('Bebidas', () => {
    it('entrega total', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const { itemId } = await despacharBebida(db, infra, 's05-beb-tot-desp', '2.000');
      await deixarItemPronto(db, infra, itemId, 's05-beb-tot');
      const out = await CozinhaPreparacao.entregarBebida({
        empresaId: 1, operadorId: 7, itemId,
        unidade_id: infra.unidadeId,
        qty_entregue: '2.000',
        idempotencyKey: 's05-beb-tot'
      }, { db });
      assert.equal(out.entrega.qty_restante, '0.000');
      assert.equal(out.evento, 'BEBIDA_ENTREGUE');
      const idemp = await get(db, `
        SELECT tipo_operacao FROM cozinha_idempotencia WHERE idempotency_key='s05-beb-tot'
      `);
      assert.equal(idemp.tipo_operacao, TIPOS_OPERACAO.BEBIDA_ENTREGUE);
      await close(db);
    });

    it('entrega parcial', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const { itemId } = await despacharBebida(db, infra, 's05-beb-par-desp', '3.000');
      await deixarItemPronto(db, infra, itemId, 's05-beb-par');
      const out = await CozinhaPreparacao.entregarBebida({
        empresaId: 1, operadorId: 7, itemId,
        unidade_id: infra.unidadeId,
        qty_entregue: '1.000', idempotencyKey: 's05-beb-par'
      }, { db });
      assert.equal(out.entrega.qty_entregue, '1.000');
      assert.equal(out.entrega.qty_restante, '2.000');
      await close(db);
    });

    it('calcula a entrega do saldo restante em milésimos e mantém idempotência', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const { itemId } = await despacharBebida(db, infra, 's05-beb-saldo-desp', '2.500');
      await deixarItemPronto(db, infra, itemId, 's05-beb-saldo-pronto');
      await CozinhaPreparacao.entregarBebida({
        empresaId: 1, operadorId: 7, itemId,
        unidade_id: infra.unidadeId,
        qty_entregue: '1.750',
        idempotencyKey: 's05-beb-saldo-parcial'
      }, { db });

      const entrada = {
        empresaId: 1, operadorId: 7, itemId,
        unidade_id: infra.unidadeId,
        usar_saldo_pendente: true,
        idempotencyKey: 's05-beb-saldo-auto'
      };
      const entrega = await CozinhaPreparacao.entregarBebida(entrada, { db });
      const replay = await CozinhaPreparacao.entregarBebida({
        ...entrada,
        qty_millis: 1
      }, { db });

      assert.equal(entrega.entrega.qty_entregue, '0.750');
      assert.equal(entrega.entrega.qty_restante, '0.000');
      assert.equal(replay.repetida, true);
      assert.equal(replay.entrega.qty_entregue, '0.750');
      assert.equal(Number((await get(db, `
        SELECT COUNT(*) AS n FROM cozinha_bebida_entregas WHERE cozinha_item_id=?
      `, [itemId])).n), 2);
      await assert.rejects(
        () => CozinhaPreparacao.entregarBebida({
          ...entrada,
          idempotencyKey: 's05-beb-saldo-vazio'
        }, { db }),
        (err) => err.codigo === 'QTY_ENTREGA_SEM_PENDENCIA'
      );
      await close(db);
    });

    it('entregas parciais sucessivas até zerar', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const { itemId } = await despacharBebida(db, infra, 's05-beb-suc-desp', '3.000');
      await deixarItemPronto(db, infra, itemId, 's05-beb-suc');

      await CozinhaPreparacao.entregarBebida({
        empresaId: 1, operadorId: 7, itemId,
        unidade_id: infra.unidadeId,
        qty_entregue: '1.000', idempotencyKey: 's05-beb-suc-1'
      }, { db });
      await CozinhaPreparacao.entregarBebida({
        empresaId: 1, operadorId: 7, itemId,
        unidade_id: infra.unidadeId,
        qty_entregue: '1.000', idempotencyKey: 's05-beb-suc-2'
      }, { db });
      const fim = await CozinhaPreparacao.entregarBebida({
        empresaId: 1, operadorId: 7, itemId,
        unidade_id: infra.unidadeId,
        qty_entregue: '1.000', idempotencyKey: 's05-beb-suc-3'
      }, { db });

      assert.equal(fim.entrega.qty_restante, '0.000');
      const entregas = await all(db, `
        SELECT id FROM cozinha_bebida_entregas WHERE cozinha_item_id=?
      `, [itemId]);
      assert.equal(entregas.length, 3);
      await close(db);
    });

    it('quantidade acumulada igual à solicitada — histórico preservado', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const { itemId } = await despacharBebida(db, infra, 's05-beb-eq-desp', '2.500');
      await deixarItemPronto(db, infra, itemId, 's05-beb-eq');
      await CozinhaPreparacao.entregarBebida({
        empresaId: 1, operadorId: 7, itemId,
        unidade_id: infra.unidadeId,
        qty_entregue: '1.500', idempotencyKey: 's05-beb-eq-1'
      }, { db });
      await CozinhaPreparacao.entregarBebida({
        empresaId: 1, operadorId: 7, itemId,
        unidade_id: infra.unidadeId,
        qty_entregue: '1.000', idempotencyKey: 's05-beb-eq-2'
      }, { db });
      const sum = await get(db, `
        SELECT SUM(qty_entregue_millis) AS t FROM cozinha_bebida_entregas
        WHERE cozinha_item_id=?
      `, [itemId]);
      assert.equal(Number(sum.t), 2500);
      await close(db);
    });

    it('tentativa de ultrapassar quantidade solicitada', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const { itemId } = await despacharBebida(db, infra, 's05-beb-exc-desp', '2.000');
      await deixarItemPronto(db, infra, itemId, 's05-beb-exc');
      await CozinhaPreparacao.entregarBebida({
        empresaId: 1, operadorId: 7, itemId,
        unidade_id: infra.unidadeId,
        qty_entregue: '1.500', idempotencyKey: 's05-beb-exc-1'
      }, { db });
      await assert.rejects(
        () => CozinhaPreparacao.entregarBebida({
          empresaId: 1, operadorId: 7, itemId,
        unidade_id: infra.unidadeId,
          qty_entregue: '1.000', idempotencyKey: 's05-beb-exc-2'
        }, { db }),
        (err) => err.codigo === 'QTY_ENTREGA_EXCEDE'
      );
      const entregas = await all(db, `
        SELECT id FROM cozinha_bebida_entregas WHERE cozinha_item_id=?
      `, [itemId]);
      assert.equal(entregas.length, 1);
      await close(db);
    });

    it('quantidade negativa ou inválida', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const { itemId } = await despacharBebida(db, infra, 's05-beb-neg-desp', '1.000');

      await assert.rejects(
        () => CozinhaPreparacao.entregarBebida({
          empresaId: 1, operadorId: 7, itemId,
        unidade_id: infra.unidadeId,
          qty_entregue: '-1.000', idempotencyKey: 's05-beb-neg'
        }, { db }),
        (err) => err.codigo === 'QTY_INVALIDA' || err.codigo === 'QTY_PRECISAO_INVALIDA'
      );
      await assert.rejects(
        () => CozinhaPreparacao.entregarBebida({
          empresaId: 1, operadorId: 7, itemId,
        unidade_id: infra.unidadeId,
          qty_entregue: '0', idempotencyKey: 's05-beb-zero'
        }, { db }),
        (err) => err.codigo === 'QTY_INVALIDA'
      );
      await assert.rejects(
        () => CozinhaPreparacao.entregarBebida({
          empresaId: 1, operadorId: 7, itemId,
        unidade_id: infra.unidadeId,
          qty_entregue: 'abc', idempotencyKey: 's05-beb-abc'
        }, { db }),
        (err) => err.codigo === 'QTY_INVALIDA' || err.codigo === 'QTY_PRECISAO_INVALIDA'
      );
      await close(db);
    });

    it('repetição idempotente BEBIDA_ENTREGUE', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const { itemId } = await despacharBebida(db, infra, 's05-beb-idem-desp', '2.000');
      await deixarItemPronto(db, infra, itemId, 's05-beb-idem');
      const a = await CozinhaPreparacao.entregarBebida({
        empresaId: 1, operadorId: 7, itemId,
        unidade_id: infra.unidadeId,
        qty_entregue: '1.000', idempotencyKey: 's05-beb-idem'
      }, { db });
      const b = await CozinhaPreparacao.entregarBebida({
        empresaId: 1, operadorId: 7, itemId,
        unidade_id: infra.unidadeId,
        qty_entregue: '1.000', idempotencyKey: 's05-beb-idem'
      }, { db });
      assert.equal(b.repetida, true);
      assert.equal(a.entrega.id, b.entrega.id);
      const entregas = await all(db, `
        SELECT id FROM cozinha_bebida_entregas WHERE cozinha_item_id=?
      `, [itemId]);
      assert.equal(entregas.length, 1);
      await close(db);
    });

    it('bebida entrega sem exigir pastéis prontos', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const pastel = await criarPedidoItem(db, infra, {
        produtoId: infra.prodPastelId, nome: 'Pastel',
        classifSnapshot: 'COMERCIAL', comPersonalizacao: true
      });
      const bebida = await criarPedidoItem(db, infra, {
        produtoId: infra.prodFantaId, nome: 'Fanta',
        classifSnapshot: 'INSUMO', qty: 1
      });
      const out = await despacharItens(db, infra, [
        pastel,
        { ...bebida, qty: '1.000' }
      ], 's05-beb-indep-desp');
      const itemBebida = out.itens.find((i) => i.tipo_item === 'BEBIDA');
      await deixarItemPronto(db, infra, itemBebida.id, 's05-beb-indep');
      const ent = await CozinhaPreparacao.entregarBebida({
        empresaId: 1, operadorId: 7, itemId: itemBebida.id,
        unidade_id: infra.unidadeId,
        qty_entregue: '1.000', idempotencyKey: 's05-beb-indep'
      }, { db });
      assert.equal(ent.success, true);
      assert.notEqual(ent.rodada.estado_preparacao, 'PRONTA');
      await close(db);
    });
  });

  describe('Retirada da rodada', () => {
    it('só confirma rodada pronta, é idempotente e preserva pedido, atendimento e impressão', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const despacho = await despacharPastel(db, infra, 's05-retirada-despacho');
      const entrada = {
        empresaId: infra.empresaId,
        operadorId: 7,
        unidade_id: infra.unidadeId,
        rodadaId: despacho.rodadaId,
        idempotencyKey: 's05-retirada-antes-pronto'
      };

      await assert.rejects(
        () => CozinhaPreparacao.confirmarRetirada(entrada, { db }),
        (err) => err.codigo === 'RODADA_NAO_PRONTA'
      );
      await CozinhaPreparacao.iniciarPreparacao({
        empresaId: infra.empresaId,
        operadorId: 7,
        unidade_id: infra.unidadeId,
        itemId: despacho.itemId,
        idempotencyKey: 's05-retirada-iniciar'
      }, { db });
      await CozinhaPreparacao.marcarItemPronto({
        empresaId: infra.empresaId,
        operadorId: 7,
        unidade_id: infra.unidadeId,
        itemId: despacho.itemId,
        idempotencyKey: 's05-retirada-pronto'
      }, { db });

      const itemRetirada = await get(db, `
        SELECT qty_solicitada_millis FROM cozinha_itens WHERE id=?
      `, [despacho.itemId]);
      await CozinhaRetiradaLedger.retirarItem({
        empresaId: infra.empresaId,
        operadorId: 7,
        unidade_id: infra.unidadeId,
        itemId: despacho.itemId,
        qty_millis: Number(itemRetirada.qty_solicitada_millis),
        idempotencyKey: 's05-retirada-ledger'
      }, { db });

      const filaAntes = await get(db, 'SELECT COUNT(*) AS n FROM cozinha_impressao_fila');
      const retirada = await CozinhaPreparacao.confirmarRetirada({
        ...entrada,
        idempotencyKey: 's05-retirada-confirmar'
      }, { db });
      const repetida = await CozinhaPreparacao.confirmarRetirada({
        ...entrada,
        idempotencyKey: 's05-retirada-confirmar'
      }, { db });
      const novaChave = await CozinhaPreparacao.confirmarRetirada({
        ...entrada,
        idempotencyKey: 's05-retirada-replay-nova-chave'
      }, { db });
      assert.equal(retirada.success, true);
      assert.equal(retirada.repetida, true);
      assert.equal(repetida.repetida, true);
      assert.equal(novaChave.repetida, true);
      assert.equal(retirada.rodada.retirada_estado, 'RETIRADA');
      assert.ok(retirada.rodada.retirada_em);
      assert.equal(retirada.rodada.retirada_por, 7);

      const eventos = await all(db, `
        SELECT id FROM cozinha_eventos_outbox
        WHERE tipo='RETIRADA_CONFIRMADA'
          AND CAST(json_extract(payload_json, '$.rodada.id') AS INTEGER)=?
      `, [despacho.rodadaId]);
      assert.equal(eventos.length, 1);
      const comercial = await get(db, `
        SELECT p.status, ma.estado AS atendimento_estado
        FROM pedidos p
        JOIN mesa_atendimentos ma ON ma.id=p.mesa_atendimento_id
        WHERE p.id=?
      `, [despacho.pastel.pedidoId]);
      assert.equal(comercial.status, 'PEDIDO');
      assert.equal(comercial.atendimento_estado, 'OCUPADA');
      const filaDepois = await get(db, 'SELECT COUNT(*) AS n FROM cozinha_impressao_fila');
      assert.equal(filaDepois.n, filaAntes.n);
      await close(db);
    });

    it('isola empresa/unidade e serializa confirmações concorrentes sem evento duplicado', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db, 1);
      const outraEmpresa = await seedInfra(db, 2);
      const despacho = await despacharPastel(db, infra, 's05-retirada-concorrente-desp');
      await CozinhaPreparacao.iniciarPreparacao({
        empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId,
        itemId: despacho.itemId, idempotencyKey: 's05-retirada-concorrente-ini'
      }, { db });
      await CozinhaPreparacao.marcarItemPronto({
        empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId,
        itemId: despacho.itemId, idempotencyKey: 's05-retirada-concorrente-pronto'
      }, { db });
      const itemRetirada = await get(db, `
        SELECT qty_solicitada_millis FROM cozinha_itens WHERE id=?
      `, [despacho.itemId]);
      await CozinhaRetiradaLedger.retirarItem({
        empresaId: 1,
        operadorId: 7,
        unidade_id: infra.unidadeId,
        itemId: despacho.itemId,
        qty_millis: Number(itemRetirada.qty_solicitada_millis),
        idempotencyKey: 's05-retirada-concorrente-ledger'
      }, { db });

      await assert.rejects(
        () => CozinhaPreparacao.confirmarRetirada({
          empresaId: 1, operadorId: 8, unidade_id: outraEmpresa.unidadeId,
          rodadaId: despacho.rodadaId, idempotencyKey: 's05-retirada-unidade-divergente'
        }, { db }),
        (err) => err.codigo === 'UNIDADE_ISOLAMENTO'
      );
      await assert.rejects(
        () => CozinhaPreparacao.confirmarRetirada({
          empresaId: 2, operadorId: 8, unidade_id: outraEmpresa.unidadeId,
          rodadaId: despacho.rodadaId, idempotencyKey: 's05-retirada-empresa-divergente'
        }, { db }),
        (err) => err.statusCode === 404 || err.codigo === 'RODADA_INEXISTENTE'
      );

      const [a, b] = await Promise.all([
        CozinhaPreparacao.confirmarRetirada({
          empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId,
          rodadaId: despacho.rodadaId, idempotencyKey: 's05-retirada-concorrente-a'
        }, { db }),
        CozinhaPreparacao.confirmarRetirada({
          empresaId: 1, operadorId: 9, unidade_id: infra.unidadeId,
          rodadaId: despacho.rodadaId, idempotencyKey: 's05-retirada-concorrente-b'
        }, { db })
      ]);
      assert.equal(a.success, true);
      assert.equal(b.success, true);
      assert.equal([a, b].filter((r) => !r.repetida).length, 0);
      const eventos = await get(db, `
        SELECT COUNT(*) AS n FROM cozinha_eventos_outbox
        WHERE tipo='RETIRADA_CONFIRMADA'
          AND CAST(json_extract(payload_json, '$.rodada.id') AS INTEGER)=?
      `, [despacho.rodadaId]);
      assert.equal(eventos.n, 1);
      await close(db);
    });

    it('não redefine o significado de ASSUMIDA_RETIRADA', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const despacho = await despacharPastel(db, infra, 's05-retirada-assumida-desp');
      await CozinhaPreparacao.iniciarPreparacao({
        empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId,
        itemId: despacho.itemId, idempotencyKey: 's05-retirada-assumida-ini'
      }, { db });
      await CozinhaPreparacao.marcarItemPronto({
        empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId,
        itemId: despacho.itemId, idempotencyKey: 's05-retirada-assumida-pronto'
      }, { db });
      await run(db, `
        UPDATE cozinha_rodadas SET retirada_estado='ASSUMIDA_RETIRADA' WHERE id=?
      `, [despacho.rodadaId]);
      await assert.rejects(
        () => CozinhaPreparacao.confirmarRetirada({
          empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId,
          rodadaId: despacho.rodadaId, idempotencyKey: 's05-retirada-assumida'
        }, { db }),
        (err) => err.codigo === 'RETIRADA_ESTADO_NAO_SUPORTADO'
      );
      const rodada = await get(db, `
        SELECT retirada_estado, retirada_em, retirada_por
        FROM cozinha_rodadas WHERE id=?
      `, [despacho.rodadaId]);
      assert.deepEqual(rodada, {
        retirada_estado: 'ASSUMIDA_RETIRADA',
        retirada_em: null,
        retirada_por: null
      });
      await close(db);
    });
  });

  describe('Segurança e integridade', () => {
    it('isolamento entre empresas', async () => {
      const db = await open();
      await schemaErp(db);
      const infra1 = await seedInfra(db, 1);
      const infra2 = await seedInfra(db, 2);
      const { itemId } = await despacharPastel(db, infra1, 's05-emp-1-desp');

      await assert.rejects(
        () => CozinhaPreparacao.iniciarPreparacao({
          empresaId: 2, operadorId: 7, unidade_id: infra2.unidadeId, itemId, idempotencyKey: 's05-emp-cross'
        }, { db }),
        (err) => err.codigo === 'ITEM_INEXISTENTE' || err.statusCode === 404 || err.codigo === 'EMPRESA_ISOLAMENTO'
      );

      const ok = await CozinhaPreparacao.iniciarPreparacao({
        empresaId: infra2.empresaId, operadorId: 9,
        unidade_id: infra2.unidadeId,
        itemId: (await despacharPastel(db, infra2, 's05-emp-2-desp')).itemId,
        idempotencyKey: 's05-emp-ok'
      }, { db });
      assert.equal(ok.item.empresa_id, 2);
      await close(db);
    });

    it('homologação unidade — autorizada / outra / ausente / vazia / divergente / rollback / idempotência (3 ops)', async () => {
      const db = await open();
      await schemaErp(db);
      const infraA = await seedInfra(db, 1);
      const unidadeA = infraA.unidadeId;
      const unidadeBRow = await run(db, `
        INSERT INTO cozinha_unidades (empresa_id, codigo, sequencia_atual)
        VALUES (1, 'U-B-HOM', 0)
      `);
      const unidadeB = unidadeBRow.lastID;
      await run(db, `
        INSERT INTO cozinha_turnos (
          empresa_id, unidade_id, estado, abertura_operador_id, abertura_em
        ) VALUES (1, ?, 'ABERTA', 7, datetime('now'))
      `, [unidadeB]);
      const infraB = { ...infraA, unidadeId: unidadeB };

      const pastelA = await despacharPastel(db, infraA, 's05-hom-a-pastel');
      const bebidaA = await despacharBebida(db, infraA, 's05-hom-a-beb', '2.000');
      const pastelB = await despacharPastel(db, infraB, 's05-hom-b-pastel');
      const bebidaB = await despacharBebida(db, infraB, 's05-hom-b-beb', '1.000');

      const iniOk = await CozinhaPreparacao.iniciarPreparacao({
        empresaId: 1, operadorId: 7, unidade_id: unidadeA,
        itemId: pastelA.itemId, idempotencyKey: 's05-hom-ok-ini'
      }, { db });
      assert.equal(iniOk.item.estado_preparacao, 'EM_PREPARACAO');

      const prontoOk = await CozinhaPreparacao.marcarItemPronto({
        empresaId: 1, operadorId: 7, unidade_id: unidadeA,
        itemId: pastelA.itemId, idempotencyKey: 's05-hom-ok-pronto'
      }, { db });
      assert.equal(prontoOk.item.estado_preparacao, 'PRONTO');

      await deixarItemPronto(db, infraA, bebidaA.itemId, 's05-hom-ok-bebida');
      const bebOk = await CozinhaPreparacao.entregarBebida({
        empresaId: 1, operadorId: 7, unidade_id: unidadeA,
        itemId: bebidaA.itemId, qty_entregue: '1.000',
        idempotencyKey: 's05-hom-ok-beb'
      }, { db });
      assert.equal(bebOk.success, true);

      await assert.rejects(
        () => CozinhaPreparacao.iniciarPreparacao({
          empresaId: 1, operadorId: 7, unidade_id: unidadeA,
          itemId: pastelB.itemId, idempotencyKey: 's05-hom-cross-ini'
        }, { db }),
        (err) => err.codigo === 'UNIDADE_ISOLAMENTO'
      );
      await assert.rejects(
        () => CozinhaPreparacao.marcarItemPronto({
          empresaId: 1, operadorId: 7, unidade_id: unidadeA,
          itemId: pastelB.itemId, idempotencyKey: 's05-hom-cross-pronto'
        }, { db }),
        (err) => err.codigo === 'UNIDADE_ISOLAMENTO'
      );
      await assert.rejects(
        () => CozinhaPreparacao.entregarBebida({
          empresaId: 1, operadorId: 7, unidade_id: unidadeA,
          itemId: bebidaB.itemId, qty_entregue: '1.000',
          idempotencyKey: 's05-hom-cross-beb'
        }, { db }),
        (err) => err.codigo === 'UNIDADE_ISOLAMENTO'
      );

      await assert.rejects(
        () => CozinhaPreparacao.iniciarPreparacao({
          empresaId: 1, operadorId: 7,
          itemId: pastelB.itemId, idempotencyKey: 's05-hom-sem-ini'
        }, { db }),
        (err) => err.codigo === 'UNIDADE_OBRIGATORIA'
      );
      await assert.rejects(
        () => CozinhaPreparacao.marcarItemPronto({
          empresaId: 1, operadorId: 7,
          itemId: pastelB.itemId, idempotencyKey: 's05-hom-sem-pronto'
        }, { db }),
        (err) => err.codigo === 'UNIDADE_OBRIGATORIA'
      );
      await assert.rejects(
        () => CozinhaPreparacao.entregarBebida({
          empresaId: 1, operadorId: 7,
          itemId: bebidaB.itemId, qty_entregue: '1.000',
          idempotencyKey: 's05-hom-sem-beb'
        }, { db }),
        (err) => err.codigo === 'UNIDADE_OBRIGATORIA'
      );

      await assert.rejects(
        () => CozinhaPreparacao.iniciarPreparacao({
          empresaId: 1, operadorId: 7, unidade_id: '',
          itemId: pastelB.itemId, idempotencyKey: 's05-hom-vazia-ini'
        }, { db }),
        (err) => err.codigo === 'UNIDADE_OBRIGATORIA'
      );
      await assert.rejects(
        () => CozinhaPreparacao.marcarItemPronto({
          empresaId: 1, operadorId: 7, unidade_id: '   ',
          itemId: pastelB.itemId, idempotencyKey: 's05-hom-vazia-pronto'
        }, { db }),
        (err) => err.codigo === 'UNIDADE_OBRIGATORIA'
      );
      await assert.rejects(
        () => CozinhaPreparacao.entregarBebida({
          empresaId: 1, operadorId: 7, unidade_id: '',
          itemId: bebidaB.itemId, qty_entregue: '1.000',
          idempotencyKey: 's05-hom-vazia-beb'
        }, { db }),
        (err) => err.codigo === 'UNIDADE_OBRIGATORIA'
      );

      assert.throws(
        () => resolverUnidadeOperacionalReq({ user: { id: 7 }, body: {}, query: {} }),
        (err) => err.codigo === 'UNIDADE_OBRIGATORIA'
      );
      assert.throws(
        () => resolverUnidadeOperacionalReq({
          user: { id: 7, unidade_cozinha_id: '' }, body: {}, query: {}
        }),
        (err) => err.codigo === 'UNIDADE_OBRIGATORIA'
      );
      assert.throws(
        () => resolverUnidadeOperacionalReq({
          user: { id: 7, unidade_cozinha_id: unidadeA },
          body: { unidade_id: '' }, query: {}
        }),
        (err) => err.codigo === 'UNIDADE_OBRIGATORIA'
      );
      assert.throws(
        () => resolverUnidadeOperacionalReq({
          user: { id: 7, unidade_cozinha_id: unidadeA },
          body: { unidade_id: unidadeB }, query: {}
        }),
        (err) => err.codigo === 'UNIDADE_ISOLAMENTO'
      );
      assert.equal(
        resolverUnidadeOperacionalReq({
          user: { id: 7, unidade_cozinha_id: unidadeA },
          body: { unidade_id: unidadeA }, query: {}
        }),
        unidadeA
      );
      assert.equal(
        resolverUnidadeOperacionalReq({
          user: { id: 7, unidade_cozinha_id: unidadeA }, body: {}, query: {}
        }),
        unidadeA
      );

      const itemBAntes = await get(db, `SELECT estado_preparacao FROM cozinha_itens WHERE id=?`, [pastelB.itemId]);
      assert.equal(itemBAntes.estado_preparacao, 'AGUARDANDO');
      assert.equal((await all(db, `SELECT * FROM cozinha_idempotencia WHERE idempotency_key='s05-hom-cross-ini'`)).length, 0);
      assert.equal((await all(db, `SELECT * FROM cozinha_eventos_outbox WHERE idempotency_key LIKE 's05-hom-cross%'`)).length, 0);
      assert.equal((await all(db, `SELECT * FROM cozinha_bebida_entregas WHERE cozinha_item_id=?`, [bebidaB.itemId])).length, 0);

      const iniReplay = await CozinhaPreparacao.iniciarPreparacao({
        empresaId: 1, operadorId: 7, unidade_id: unidadeA,
        itemId: pastelA.itemId, idempotencyKey: 's05-hom-ok-ini'
      }, { db });
      assert.equal(iniReplay.repetida, true);
      const bebReplay = await CozinhaPreparacao.entregarBebida({
        empresaId: 1, operadorId: 7, unidade_id: unidadeA,
        itemId: bebidaA.itemId, qty_entregue: '1.000',
        idempotencyKey: 's05-hom-ok-beb'
      }, { db });
      assert.equal(bebReplay.repetida, true);
      assert.equal((await all(db, `SELECT id FROM cozinha_bebida_entregas WHERE cozinha_item_id=?`, [bebidaA.itemId])).length, 1);

      await close(db);
    });

    it('reutilização de chave com hash diferente', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const a = await despacharPastel(db, infra, 's05-hash-a-desp');
      const b = await despacharPastel(db, infra, 's05-hash-b-desp');

      await CozinhaPreparacao.iniciarPreparacao({
        empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId: a.itemId, idempotencyKey: 's05-hash-reuse'
      }, { db });

      await assert.rejects(
        () => CozinhaPreparacao.iniciarPreparacao({
          empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId: b.itemId, idempotencyKey: 's05-hash-reuse'
        }, { db }),
        (err) => err.codigo === 'IDEMPOTENCY_PAYLOAD_DIVERGENTE'
      );
      await close(db);
    });

    it('integridade item↔rodada↔comanda', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const { itemId, out } = await despacharPastel(db, infra, 's05-int-desp');
      const pedidoId = out.itens[0].pedido_id;

      // Comanda órfã (FK off só para montar cenário corrompido)
      await run(db, 'PRAGMA foreign_keys = OFF');
      await run(db, `
        UPDATE cozinha_itens SET comanda_id = 999999 WHERE id = ?
      `, [itemId]);
      await run(db, 'PRAGMA foreign_keys = ON');

      await assert.rejects(
        () => CozinhaPreparacao.iniciarPreparacao({
          empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId, idempotencyKey: 's05-int-cmd'
        }, { db }),
        (err) => err.codigo === 'COMANDA_ITEM_INEXISTENTE'
      );

      // Comanda válida com atendimento divergente da rodada
      const at2 = await run(db, `
        INSERT INTO mesa_atendimentos (empresa_id, mesa_id, estado)
        VALUES (1, ?, 'OCUPADA')
      `, [infra.mesaId]);
      const cmdDiv = await run(db, `
        INSERT INTO cozinha_comandas (
          empresa_id, atendimento_id, numero_comanda, pedido_id
        ) VALUES (1, ?, 8888, ?)
      `, [at2.lastID, pedidoId]);
      await run(db, `
        UPDATE cozinha_itens SET comanda_id = ? WHERE id = ?
      `, [cmdDiv.lastID, itemId]);

      await assert.rejects(
        () => CozinhaPreparacao.iniciarPreparacao({
          empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId, idempotencyKey: 's05-int-at'
        }, { db }),
        (err) => err.codigo === 'COMANDA_RODADA_INCOMPATIVEL'
      );

      // Item e rodada com unidade divergente (comanda realinhada ao atendimento da rodada)
      const un2 = await run(db, `
        INSERT INTO cozinha_unidades (empresa_id, codigo, sequencia_atual)
        VALUES (1, 'U-DIV', 0)
      `);
      const cmdOk = await get(db, `
        SELECT id FROM cozinha_comandas
        WHERE empresa_id=1 AND atendimento_id=? ORDER BY id LIMIT 1
      `, [infra.atendimentoId]);
      await run(db, `
        UPDATE cozinha_itens SET comanda_id = ?, unidade_id = ? WHERE id = ?
      `, [cmdOk.id, un2.lastID, itemId]);

      await assert.rejects(
        () => CozinhaPreparacao.iniciarPreparacao({
          empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId, idempotencyKey: 's05-int-un'
        }, { db }),
        (err) => err.codigo === 'ITEM_UNIDADE_INCOMPATIVEL'
      );
      await close(db);
    });

    it('rollback integral em falha de bebida (simularFalha)', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seedInfra(db);
      const { itemId } = await despacharBebida(db, infra, 's05-beb-fail-desp', '2.000');
      await deixarItemPronto(db, infra, itemId, 's05-beb-fail');

      await assert.rejects(
        () => CozinhaPreparacao.entregarBebida({
          empresaId: 1, operadorId: 7, itemId,
        unidade_id: infra.unidadeId,
          qty_entregue: '1.000', idempotencyKey: 's05-beb-fail'
        }, { db, simularFalha: 'antes_commit' }),
        (err) => err.codigo === 'FALHA_SIMULADA'
      );

      const entregas = await all(db, `
        SELECT * FROM cozinha_bebida_entregas WHERE cozinha_item_id=?
      `, [itemId]);
      assert.equal(entregas.length, 0);
      const idemp = await all(db, `
        SELECT * FROM cozinha_idempotencia WHERE idempotency_key='s05-beb-fail'
      `);
      assert.equal(idemp.length, 0);
      await close(db);
    });
  });
});
