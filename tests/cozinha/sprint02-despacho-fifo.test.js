/**
 * Sprint 02 — Despacho em lote, formação de rodada e FIFO.
 * Banco temporário apenas (:memory: / tmp). Sem banco oficial.
 *
 * Executar:
 *   node --test --test-concurrency=1 tests/cozinha/sprint02-despacho-fifo.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cozinha-s02-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const {
  garantirSchemaCozinha,
  marcarCozinhaOperacional,
  isCozinhaOperacional
} = require('../../backend/utils/cozinhaSchema');
const CozinhaDespacho = require('../../backend/services/cozinha/CozinhaDespachoService');
const { TIPOS_OPERACAO } = require('../../backend/services/cozinha/cozinhaIdempotenciaHash');

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

function open(arquivo) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(arquivo || ':memory:', (err) => {
      if (err) return reject(err);
      db.serialize(() => {
        db.run('PRAGMA foreign_keys = ON');
        db.run('PRAGMA busy_timeout = 10000', (fkErr) => (fkErr ? reject(fkErr) : resolve(db)));
      });
    });
  });
}

function close(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

async function schemaErpMinimo(db) {
  await run(db, `
    CREATE TABLE IF NOT EXISTS configuracoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chave VARCHAR(100) UNIQUE NOT NULL,
      valor TEXT,
      tipo VARCHAR(50),
      descricao TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS mesas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL,
      numero INTEGER NOT NULL,
      ativo INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS mesa_atendimentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL,
      mesa_id INTEGER NOT NULL,
      estado TEXT NOT NULL,
      cliente_id INTEGER,
      operador_abertura_id INTEGER NOT NULL DEFAULT 1,
      aberto_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      operador_encerramento_id INTEGER,
      encerrado_em TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      tipo_operacional TEXT DEFAULT 'COMERCIAL'
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS pedidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo VARCHAR(50),
      data_pedido DATE NOT NULL DEFAULT '2026-01-01',
      total DECIMAL(10,2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'PEDIDO',
      empresa_id INTEGER,
      mesa_id INTEGER,
      mesa_atendimento_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS pedidos_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER NOT NULL,
      produto_id INTEGER NOT NULL,
      quantidade REAL NOT NULL,
      preco_unitario DECIMAL(10,2) NOT NULL DEFAULT 0,
      subtotal DECIMAL(10,2) NOT NULL DEFAULT 0,
      classificacao_operacional_snapshot TEXT,
      produto_nome_snapshot TEXT,
      observacao TEXT
    )
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
      preco_adicional_snapshot REAL NOT NULL DEFAULT 0
    )
  `);
  const info = await garantirSchemaCozinha(db);
  assert.equal(info.operacional, true);
  assert.equal(isCozinhaOperacional(), true);
}

/**
 * Cenário padrão empresa 1: mesa, atendimento, unidade, 2 pedidos/comandas.
 */
async function semearCenarioBase(db, opts = {}) {
  const empresaId = opts.empresaId || 1;
  const mesaNumero = opts.mesaNumero || 5;

  const mesa = await run(db, `
    INSERT INTO mesas (empresa_id, numero, ativo) VALUES (?, ?, 1)
  `, [empresaId, mesaNumero]);
  const mesaId = mesa.lastID;

  const at = await run(db, `
    INSERT INTO mesa_atendimentos (empresa_id, mesa_id, estado, operador_abertura_id)
    VALUES (?, ?, 'OCUPADA', 1)
  `, [empresaId, mesaId]);
  const atendimentoId = at.lastID;

  const un = await run(db, `
    INSERT INTO cozinha_unidades (empresa_id, codigo, ativo, sequencia_atual)
    VALUES (?, ?, 1, 0)
  `, [empresaId, opts.codigoUnidade || `U-${empresaId}`]);
  const unidadeId = un.lastID;

  const prod = await run(db, `
    INSERT INTO produtos (nome, tipo_operacional) VALUES ('Pastel de Carne', 'COMERCIAL')
  `);
  const produtoId = prod.lastID;
  const prodIng = await run(db, `
    INSERT INTO produtos (nome, tipo_operacional) VALUES ('Queijo', 'INSUMO')
  `);
  const insumoId = prodIng.lastID;

  async function criarPedidoComItem(numeroComanda, qty, comIngrediente) {
    const ped = await run(db, `
      INSERT INTO pedidos (
        codigo, data_pedido, total, status, empresa_id, mesa_id, mesa_atendimento_id
      ) VALUES (?, '2026-01-01', 10, 'PEDIDO', ?, ?, ?)
    `, [`P-${empresaId}-${numeroComanda}-${Date.now()}-${Math.random()}`, empresaId, mesaId, atendimentoId]);
    const pedidoId = ped.lastID;

    const item = await run(db, `
      INSERT INTO pedidos_itens (
        pedido_id, produto_id, quantidade, preco_unitario, subtotal,
        classificacao_operacional_snapshot, produto_nome_snapshot
      ) VALUES (?, ?, ?, 10, 10, 'COMERCIAL', 'Pastel de Carne')
    `, [pedidoId, produtoId, qty]);
    const pedidoItemId = item.lastID;

    if (comIngrediente) {
      await run(db, `
        INSERT INTO pedido_item_ingredientes (
          pedido_id, pedido_item_id, empresa_id, insumo_id,
          insumo_nome_snapshot, quantidade_snapshot, unidade_snapshot,
          classificacao_comercial_snapshot, selecionado, preco_adicional_snapshot
        ) VALUES (?, ?, ?, ?, 'Queijo Extra', 1.000, 'UN', 'ADICIONAL', 1, 2.50)
      `, [pedidoId, pedidoItemId, empresaId, insumoId]);
    }

    const cmd = await run(db, `
      INSERT INTO cozinha_comandas (
        empresa_id, atendimento_id, numero_comanda, rotulo, pedido_id, operador_lancamento_id
      ) VALUES (?, ?, ?, ?, ?, 1)
    `, [empresaId, atendimentoId, numeroComanda, `C${numeroComanda}`, pedidoId]);
    const comandaId = cmd.lastID;

    return { pedidoId, pedidoItemId, comandaId };
  }

  const a = await criarPedidoComItem(1, 2, true);
  const b = await criarPedidoComItem(2, 1, false);

  return {
    empresaId,
    mesaId,
    atendimentoId,
    unidadeId,
    produtoId,
    comanda1: a,
    comanda2: b,
    criarPedidoComItem
  };
}

function entradaDespacho(ctx, itens, chave) {
  return {
    empresaId: ctx.empresaId,
    operadorId: 7,
    idempotencyKey: chave,
    unidade_id: ctx.unidadeId,
    mesa_id: ctx.mesaId,
    atendimento_id: ctx.atendimentoId,
    itens
  };
}

describe('Sprint 02 — Despacho / rodada / FIFO (banco temporário)', () => {
  beforeEach(() => {
    marcarCozinhaOperacional(false);
  });

  describe('Despacho básico', () => {
    it('1) uma comanda gera uma rodada', async () => {
      const db = await open();
      await schemaErpMinimo(db);
      const ctx = await semearCenarioBase(db);

      const out = await CozinhaDespacho.despacharLote(entradaDespacho(ctx, [{
        pedido_id: ctx.comanda1.pedidoId,
        pedido_item_id: ctx.comanda1.pedidoItemId,
        comanda_id: ctx.comanda1.comandaId,
        qty_solicitada: '2.000'
      }], 'desp-1-uma-comanda'), { db });

      assert.equal(out.success, true);
      assert.equal(out.repetida, false);
      assert.ok(out.rodada.id > 0);
      assert.equal(out.rodada.numero_rodada, 1);
      assert.equal(out.rodada.sequencia_global, 1);
      assert.equal(out.quantidade_itens, 1);
      assert.deepEqual(out.comandas_ids, [ctx.comanda1.comandaId]);

      const rods = await all(db, `SELECT * FROM cozinha_rodadas`);
      assert.equal(rods.length, 1);
      await close(db);
    });

    it('2) duas comandas do mesmo atendimento geram uma única rodada', async () => {
      const db = await open();
      await schemaErpMinimo(db);
      const ctx = await semearCenarioBase(db);

      const out = await CozinhaDespacho.despacharLote(entradaDespacho(ctx, [
        {
          pedido_id: ctx.comanda1.pedidoId,
          pedido_item_id: ctx.comanda1.pedidoItemId,
          comanda_id: ctx.comanda1.comandaId,
          qty_solicitada: '1.000'
        },
        {
          pedido_id: ctx.comanda2.pedidoId,
          pedido_item_id: ctx.comanda2.pedidoItemId,
          comanda_id: ctx.comanda2.comandaId,
          qty_solicitada: '1.000'
        }
      ], 'desp-2-duas-comandas'), { db });

      assert.equal(out.quantidade_itens, 2);
      assert.equal(out.rodada.numero_rodada, 1);
      const rods = await all(db, `SELECT id FROM cozinha_rodadas`);
      assert.equal(rods.length, 1);
      const itens = await all(db, `SELECT rodada_id FROM cozinha_itens`);
      assert.equal(itens.length, 2);
      assert.equal(itens[0].rodada_id, out.rodada.id);
      assert.equal(itens[1].rodada_id, out.rodada.id);
      await close(db);
    });

    it('3) cada item permanece vinculado à sua comanda', async () => {
      const db = await open();
      await schemaErpMinimo(db);
      const ctx = await semearCenarioBase(db);

      const out = await CozinhaDespacho.despacharLote(entradaDespacho(ctx, [
        {
          pedido_id: ctx.comanda1.pedidoId,
          pedido_item_id: ctx.comanda1.pedidoItemId,
          comanda_id: ctx.comanda1.comandaId,
          qty_solicitada: '1.000'
        },
        {
          pedido_id: ctx.comanda2.pedidoId,
          pedido_item_id: ctx.comanda2.pedidoItemId,
          comanda_id: ctx.comanda2.comandaId,
          qty_solicitada: '1.000'
        }
      ], 'desp-3-vinculo-comanda'), { db });

      const porComanda = new Map(out.itens.map((i) => [i.comanda_id, i]));
      assert.equal(porComanda.get(ctx.comanda1.comandaId).pedido_item_id, ctx.comanda1.pedidoItemId);
      assert.equal(porComanda.get(ctx.comanda2.comandaId).pedido_item_id, ctx.comanda2.pedidoItemId);

      const rows = await all(db, `SELECT comanda_id, pedido_item_id FROM cozinha_itens ORDER BY id`);
      assert.equal(rows.length, 2);
      assert.ok(rows.some((r) => r.comanda_id === ctx.comanda1.comandaId
        && r.pedido_item_id === ctx.comanda1.pedidoItemId));
      assert.ok(rows.some((r) => r.comanda_id === ctx.comanda2.comandaId
        && r.pedido_item_id === ctx.comanda2.pedidoItemId));
      await close(db);
    });

    it('4) personalizações são preservadas em cozinha_item_ingredientes', async () => {
      const db = await open();
      await schemaErpMinimo(db);
      const ctx = await semearCenarioBase(db);

      const out = await CozinhaDespacho.despacharLote(entradaDespacho(ctx, [{
        pedido_id: ctx.comanda1.pedidoId,
        pedido_item_id: ctx.comanda1.pedidoItemId,
        comanda_id: ctx.comanda1.comandaId,
        qty_solicitada: '2.000'
      }], 'desp-4-personalizacao'), { db });

      const ings = await all(db, `
        SELECT * FROM cozinha_item_ingredientes WHERE cozinha_item_id = ?
      `, [out.itens[0].id]);
      assert.equal(ings.length, 1);
      assert.equal(ings[0].insumo_nome_snapshot, 'Queijo Extra');
      assert.equal(ings[0].selecionado, 1);
      assert.equal(ings[0].quantidade_snapshot_millis, 1000);
      assert.equal(ings[0].unidade_snapshot, 'UN');

      const origem = await get(db, `
        SELECT * FROM pedido_item_ingredientes WHERE pedido_item_id = ?
      `, [ctx.comanda1.pedidoItemId]);
      assert.equal(origem.insumo_nome_snapshot, 'Queijo Extra');
      await close(db);
    });

    it('5) estados iniciais da rodada e dos itens estão corretos', async () => {
      const db = await open();
      await schemaErpMinimo(db);
      const ctx = await semearCenarioBase(db);

      const out = await CozinhaDespacho.despacharLote(entradaDespacho(ctx, [{
        pedido_id: ctx.comanda1.pedidoId,
        pedido_item_id: ctx.comanda1.pedidoItemId,
        comanda_id: ctx.comanda1.comandaId,
        qty_solicitada: '1.000'
      }], 'desp-5-estados'), { db });

      assert.equal(out.rodada.estado_preparacao, 'AGUARDANDO');
      assert.equal(out.rodada.retirada_estado, 'PENDENTE');
      assert.equal(out.rodada.entrega_estado, 'PENDENTE');

      const item = await get(db, `SELECT * FROM cozinha_itens WHERE id = ?`, [out.itens[0].id]);
      assert.equal(item.estado_preparacao, 'AGUARDANDO');
      assert.equal(item.qty_preparada_millis, 0);
      assert.equal(item.qty_cancelada_millis, 0);
      assert.equal(item.qty_solicitada_millis, 1000);
      await close(db);
    });
  });

  describe('FIFO', () => {
    it('6) sequências crescem na unidade a cada despacho', async () => {
      const db = await open();
      await schemaErpMinimo(db);
      const ctx = await semearCenarioBase(db);

      const r1 = await CozinhaDespacho.despacharLote(entradaDespacho(ctx, [{
        pedido_id: ctx.comanda1.pedidoId,
        pedido_item_id: ctx.comanda1.pedidoItemId,
        comanda_id: ctx.comanda1.comandaId,
        qty_solicitada: '1.000'
      }], 'fifo-6-a'), { db });

      const r2 = await CozinhaDespacho.despacharLote(entradaDespacho(ctx, [{
        pedido_id: ctx.comanda2.pedidoId,
        pedido_item_id: ctx.comanda2.pedidoItemId,
        comanda_id: ctx.comanda2.comandaId,
        qty_solicitada: '1.000'
      }], 'fifo-6-b'), { db });

      assert.equal(r1.rodada.sequencia_global, 1);
      assert.equal(r2.rodada.sequencia_global, 2);
      assert.equal(r1.rodada.numero_rodada, 1);
      assert.equal(r2.rodada.numero_rodada, 2);
      assert.notEqual(r1.rodada.id, r2.rodada.id);

      const un = await get(db, `SELECT sequencia_atual FROM cozinha_unidades WHERE id = ?`, [ctx.unidadeId]);
      assert.equal(un.sequencia_atual, 2);
      await close(db);
    });

    it('7) despachos concorrentes não compartilham a mesma sequência', async () => {
      const arquivo = path.join(dbDir, `fifo-concorrente-${Date.now()}.sqlite`);
      const db = await open(arquivo);
      await schemaErpMinimo(db);
      const ctx = await semearCenarioBase(db);
      await close(db);

      const abrir = () => open(arquivo);

      const [a, b] = await Promise.all([
        (async () => {
          const d = await abrir();
          try {
            return await CozinhaDespacho.despacharLote(entradaDespacho(ctx, [{
              pedido_id: ctx.comanda1.pedidoId,
              pedido_item_id: ctx.comanda1.pedidoItemId,
              comanda_id: ctx.comanda1.comandaId,
              qty_solicitada: '1.000'
            }], 'fifo-7-a'), { db: d });
          } finally {
            await close(d);
          }
        })(),
        (async () => {
          const d = await abrir();
          try {
            return await CozinhaDespacho.despacharLote(entradaDespacho(ctx, [{
              pedido_id: ctx.comanda2.pedidoId,
              pedido_item_id: ctx.comanda2.pedidoItemId,
              comanda_id: ctx.comanda2.comandaId,
              qty_solicitada: '1.000'
            }], 'fifo-7-b'), { db: d });
          } finally {
            await close(d);
          }
        })()
      ]);

      const seqs = [a.rodada.sequencia_global, b.rodada.sequencia_global].sort((x, y) => x - y);
      assert.deepEqual(seqs, [1, 2]);

      const dbCheck = await open(arquivo);
      const un = await get(dbCheck, `SELECT sequencia_atual FROM cozinha_unidades WHERE id = ?`, [ctx.unidadeId]);
      assert.equal(un.sequencia_atual, 2);
      const rods = await all(dbCheck, `SELECT sequencia_global FROM cozinha_rodadas ORDER BY sequencia_global`);
      assert.deepEqual(rods.map((r) => r.sequencia_global), [1, 2]);
      await close(dbCheck);
    });

    it('8) sequência não reinicia por atendimento; pertence à unidade', async () => {
      const db = await open();
      await schemaErpMinimo(db);
      const ctx = await semearCenarioBase(db);

      await CozinhaDespacho.despacharLote(entradaDespacho(ctx, [{
        pedido_id: ctx.comanda1.pedidoId,
        pedido_item_id: ctx.comanda1.pedidoItemId,
        comanda_id: ctx.comanda1.comandaId,
        qty_solicitada: '1.000'
      }], 'fifo-8-a1'), { db });

      // Encerra atendimento e abre outro na mesma mesa/unidade
      await run(db, `
        UPDATE mesa_atendimentos SET estado = 'ENCERRADO' WHERE id = ?
      `, [ctx.atendimentoId]);
      const at2 = await run(db, `
        INSERT INTO mesa_atendimentos (empresa_id, mesa_id, estado, operador_abertura_id)
        VALUES (?, ?, 'OCUPADA', 1)
      `, [ctx.empresaId, ctx.mesaId]);
      const atendimento2 = at2.lastID;

      const ped = await run(db, `
        INSERT INTO pedidos (
          codigo, data_pedido, total, status, empresa_id, mesa_id, mesa_atendimento_id
        ) VALUES ('P-AT2', '2026-01-01', 5, 'PEDIDO', ?, ?, ?)
      `, [ctx.empresaId, ctx.mesaId, atendimento2]);
      const item = await run(db, `
        INSERT INTO pedidos_itens (
          pedido_id, produto_id, quantidade, preco_unitario, subtotal,
          classificacao_operacional_snapshot, produto_nome_snapshot
        ) VALUES (?, ?, 1, 5, 5, 'COMERCIAL', 'Pastel de Carne')
      `, [ped.lastID, ctx.produtoId]);
      const cmd = await run(db, `
        INSERT INTO cozinha_comandas (
          empresa_id, atendimento_id, numero_comanda, rotulo, pedido_id
        ) VALUES (?, ?, 1, 'Novo', ?)
      `, [ctx.empresaId, atendimento2, ped.lastID]);

      const out = await CozinhaDespacho.despacharLote({
        empresaId: ctx.empresaId,
        operadorId: 7,
        idempotencyKey: 'fifo-8-a2',
        unidade_id: ctx.unidadeId,
        mesa_id: ctx.mesaId,
        atendimento_id: atendimento2,
        itens: [{
          pedido_id: ped.lastID,
          pedido_item_id: item.lastID,
          comanda_id: cmd.lastID,
          qty_solicitada: '1.000'
        }]
      }, { db });

      assert.equal(out.rodada.numero_rodada, 1);
      assert.equal(out.rodada.sequencia_global, 2);
      await close(db);
    });
  });

  describe('Idempotência', () => {
    it('9) replay com mesma chave e payload devolve resposta original', async () => {
      const db = await open();
      await schemaErpMinimo(db);
      const ctx = await semearCenarioBase(db);
      const payload = entradaDespacho(ctx, [{
        pedido_id: ctx.comanda1.pedidoId,
        pedido_item_id: ctx.comanda1.pedidoItemId,
        comanda_id: ctx.comanda1.comandaId,
        qty_solicitada: '1.000'
      }], 'idem-9');

      const first = await CozinhaDespacho.despacharLote(payload, { db });
      // Altera estado do pedido após sucesso — replay não deve revalidar negócio
      await run(db, `UPDATE pedidos SET status = 'CANCELADO' WHERE id = ?`, [ctx.comanda1.pedidoId]);

      const second = await CozinhaDespacho.despacharLote(payload, { db });
      assert.equal(second.repetida, true);
      assert.equal(second.rodada.id, first.rodada.id);
      assert.equal(second.rodada.sequencia_global, first.rodada.sequencia_global);

      const rods = await all(db, `SELECT id FROM cozinha_rodadas`);
      assert.equal(rods.length, 1);
      const un = await get(db, `SELECT sequencia_atual FROM cozinha_unidades WHERE id = ?`, [ctx.unidadeId]);
      assert.equal(un.sequencia_atual, 1);
      await close(db);
    });

    it('10) mesma chave com payload diferente → 409', async () => {
      const db = await open();
      await schemaErpMinimo(db);
      const ctx = await semearCenarioBase(db);

      await CozinhaDespacho.despacharLote(entradaDespacho(ctx, [{
        pedido_id: ctx.comanda1.pedidoId,
        pedido_item_id: ctx.comanda1.pedidoItemId,
        comanda_id: ctx.comanda1.comandaId,
        qty_solicitada: '1.000'
      }], 'idem-10'), { db });

      await assert.rejects(
        () => CozinhaDespacho.despacharLote(entradaDespacho(ctx, [{
          pedido_id: ctx.comanda1.pedidoId,
          pedido_item_id: ctx.comanda1.pedidoItemId,
          comanda_id: ctx.comanda1.comandaId,
          qty_solicitada: '2.000'
        }], 'idem-10'), { db }),
        (err) => {
          assert.equal(err.statusCode, 409);
          assert.equal(err.codigo, 'IDEMPOTENCY_PAYLOAD_DIVERGENTE');
          return true;
        }
      );
      await close(db);
    });

    it('11) mesma chave associada a outro tipo de operação → 409', async () => {
      const db = await open();
      await schemaErpMinimo(db);
      const ctx = await semearCenarioBase(db);

      await run(db, `
        INSERT INTO cozinha_idempotencia (
          idempotency_key, tipo_operacao, contexto, payload_hash, situacao,
          resultado_http_status, resultado_json
        ) VALUES ('idem-11', 'AUTORIZAR_QTY', '{}', 'abc', 'CONCLUIDA', 201, '{}')
      `);

      await assert.rejects(
        () => CozinhaDespacho.despacharLote(entradaDespacho(ctx, [{
          pedido_id: ctx.comanda1.pedidoId,
          pedido_item_id: ctx.comanda1.pedidoItemId,
          comanda_id: ctx.comanda1.comandaId,
          qty_solicitada: '1.000'
        }], 'idem-11'), { db }),
        (err) => {
          assert.equal(err.statusCode, 409);
          assert.equal(err.codigo, 'IDEMPOTENCY_OPERACAO_DIVERGENTE');
          return true;
        }
      );
      await close(db);
    });
  });

  describe('Isolamento e validações', () => {
    it('12) rejeita pedido de outra empresa', async () => {
      const db = await open();
      await schemaErpMinimo(db);
      const ctx = await semearCenarioBase(db);
      await run(db, `UPDATE pedidos SET empresa_id = 99 WHERE id = ?`, [ctx.comanda1.pedidoId]);

      await assert.rejects(
        () => CozinhaDespacho.despacharLote(entradaDespacho(ctx, [{
          pedido_id: ctx.comanda1.pedidoId,
          pedido_item_id: ctx.comanda1.pedidoItemId,
          comanda_id: ctx.comanda1.comandaId,
          qty_solicitada: '1.000'
        }], 'iso-12'), { db }),
        (err) => {
          assert.equal(err.statusCode, 404);
          assert.equal(err.codigo, 'PEDIDO_NAO_ENCONTRADO');
          return true;
        }
      );

      const rods = await all(db, `SELECT id FROM cozinha_rodadas`);
      assert.equal(rods.length, 0);
      const un = await get(db, `SELECT sequencia_atual FROM cozinha_unidades WHERE id = ?`, [ctx.unidadeId]);
      assert.equal(un.sequencia_atual, 0);
      await close(db);
    });

    it('13) rejeita atendimento incompatível com a mesa', async () => {
      const db = await open();
      await schemaErpMinimo(db);
      const ctx = await semearCenarioBase(db);
      const mesa2 = await run(db, `
        INSERT INTO mesas (empresa_id, numero, ativo) VALUES (1, 99, 1)
      `);

      await assert.rejects(
        () => CozinhaDespacho.despacharLote({
          ...entradaDespacho(ctx, [{
            pedido_id: ctx.comanda1.pedidoId,
            pedido_item_id: ctx.comanda1.pedidoItemId,
            comanda_id: ctx.comanda1.comandaId,
            qty_solicitada: '1.000'
          }], 'iso-13'),
          mesa_id: mesa2.lastID
        }, { db }),
        (err) => {
          assert.equal(err.statusCode, 409);
          assert.equal(err.codigo, 'ATENDIMENTO_MESA_INCOMPATIVEL');
          return true;
        }
      );
      await close(db);
    });

    it('14) rejeita unidade inativa', async () => {
      const db = await open();
      await schemaErpMinimo(db);
      const ctx = await semearCenarioBase(db);
      await run(db, `UPDATE cozinha_unidades SET ativo = 0 WHERE id = ?`, [ctx.unidadeId]);

      await assert.rejects(
        () => CozinhaDespacho.despacharLote(entradaDespacho(ctx, [{
          pedido_id: ctx.comanda1.pedidoId,
          pedido_item_id: ctx.comanda1.pedidoItemId,
          comanda_id: ctx.comanda1.comandaId,
          qty_solicitada: '1.000'
        }], 'iso-14'), { db }),
        (err) => {
          assert.equal(err.statusCode, 409);
          assert.equal(err.codigo, 'UNIDADE_INATIVA');
          return true;
        }
      );
      await close(db);
    });
  });

  describe('Quantidades', () => {
    it('15) rejeita quantidade acima do saldo e não consome FIFO', async () => {
      const db = await open();
      await schemaErpMinimo(db);
      const ctx = await semearCenarioBase(db);

      await assert.rejects(
        () => CozinhaDespacho.despacharLote(entradaDespacho(ctx, [{
          pedido_id: ctx.comanda1.pedidoId,
          pedido_item_id: ctx.comanda1.pedidoItemId,
          comanda_id: ctx.comanda1.comandaId,
          qty_solicitada: '3.000'
        }], 'qty-15'), { db }),
        (err) => {
          assert.equal(err.statusCode, 409);
          assert.equal(err.codigo, 'QTY_EXCEDE_RESTANTE');
          return true;
        }
      );
      const un = await get(db, `SELECT sequencia_atual FROM cozinha_unidades WHERE id = ?`, [ctx.unidadeId]);
      assert.equal(un.sequencia_atual, 0);
      const rods = await all(db, `SELECT id FROM cozinha_rodadas`);
      assert.equal(rods.length, 0);
      await close(db);
    });

    it('16) despacho parcial reduz o saldo; segundo despacho consome o restante', async () => {
      const db = await open();
      await schemaErpMinimo(db);
      const ctx = await semearCenarioBase(db);

      const r1 = await CozinhaDespacho.despacharLote(entradaDespacho(ctx, [{
        pedido_id: ctx.comanda1.pedidoId,
        pedido_item_id: ctx.comanda1.pedidoItemId,
        comanda_id: ctx.comanda1.comandaId,
        qty_solicitada: '1.000'
      }], 'qty-16-a'), { db });
      assert.equal(r1.itens[0].qty_solicitada, '1.000');

      const r2 = await CozinhaDespacho.despacharLote(entradaDespacho(ctx, [{
        pedido_id: ctx.comanda1.pedidoId,
        pedido_item_id: ctx.comanda1.pedidoItemId,
        comanda_id: ctx.comanda1.comandaId,
        qty_solicitada: '1.000'
      }], 'qty-16-b'), { db });
      assert.equal(r2.rodada.sequencia_global, 2);

      await assert.rejects(
        () => CozinhaDespacho.despacharLote(entradaDespacho(ctx, [{
          pedido_id: ctx.comanda1.pedidoId,
          pedido_item_id: ctx.comanda1.pedidoItemId,
          comanda_id: ctx.comanda1.comandaId,
          qty_solicitada: '0.001'
        }], 'qty-16-c'), { db }),
        (err) => err.codigo === 'QTY_EXCEDE_RESTANTE'
      );
      await close(db);
    });

    it('17) alteração silenciosa da qty do pedido não eleva o teto', async () => {
      const db = await open();
      await schemaErpMinimo(db);
      const ctx = await semearCenarioBase(db);

      await CozinhaDespacho.despacharLote(entradaDespacho(ctx, [{
        pedido_id: ctx.comanda1.pedidoId,
        pedido_item_id: ctx.comanda1.pedidoItemId,
        comanda_id: ctx.comanda1.comandaId,
        qty_solicitada: '2.000'
      }], 'qty-17-a'), { db });

      await run(db, `
        UPDATE pedidos_itens SET quantidade = 10 WHERE id = ?
      `, [ctx.comanda1.pedidoItemId]);

      await assert.rejects(
        () => CozinhaDespacho.despacharLote(entradaDespacho(ctx, [{
          pedido_id: ctx.comanda1.pedidoId,
          pedido_item_id: ctx.comanda1.pedidoItemId,
          comanda_id: ctx.comanda1.comandaId,
          qty_solicitada: '1.000'
        }], 'qty-17-b'), { db }),
        (err) => {
          assert.equal(err.codigo, 'QTY_EXCEDE_RESTANTE');
          return true;
        }
      );

      const ctrl = await get(db, `
        SELECT qty_referencia_despacho_millis FROM cozinha_pedido_item_controle
        WHERE pedido_item_id = ?
      `, [ctx.comanda1.pedidoItemId]);
      assert.equal(ctrl.qty_referencia_despacho_millis, 2000);
      await close(db);
    });

    it('18) rejeita mais de três casas decimais', async () => {
      const db = await open();
      await schemaErpMinimo(db);
      const ctx = await semearCenarioBase(db);

      await assert.rejects(
        () => CozinhaDespacho.despacharLote(entradaDespacho(ctx, [{
          pedido_id: ctx.comanda1.pedidoId,
          pedido_item_id: ctx.comanda1.pedidoItemId,
          comanda_id: ctx.comanda1.comandaId,
          qty_solicitada: '1.0001'
        }], 'qty-18'), { db }),
        (err) => {
          assert.equal(err.codigo, 'QTY_PRECISAO_INVALIDA');
          assert.equal(err.statusCode, 400);
          return true;
        }
      );
      await close(db);
    });

    it('19) armazena quantidades em milésimos inteiros', async () => {
      const db = await open();
      await schemaErpMinimo(db);
      const ctx = await semearCenarioBase(db);

      await CozinhaDespacho.despacharLote(entradaDespacho(ctx, [{
        pedido_id: ctx.comanda1.pedidoId,
        pedido_item_id: ctx.comanda1.pedidoItemId,
        comanda_id: ctx.comanda1.comandaId,
        qty_solicitada: '1.500'
      }], 'qty-19'), { db });

      const item = await get(db, `
        SELECT qty_solicitada_millis FROM cozinha_itens WHERE pedido_item_id = ?
      `, [ctx.comanda1.pedidoItemId]);
      assert.equal(item.qty_solicitada_millis, 1500);
      assert.equal(Number.isInteger(item.qty_solicitada_millis), true);
      await close(db);
    });
  });

  describe('Transação', () => {
    it('20) falha após claim de idempotência faz ROLLBACK sem rodada/FIFO', async () => {
      const db = await open();
      await schemaErpMinimo(db);
      const ctx = await semearCenarioBase(db);

      // Item inexistente: passa claim, falha na validação → rollback
      await assert.rejects(
        () => CozinhaDespacho.despacharLote(entradaDespacho(ctx, [{
          pedido_id: ctx.comanda1.pedidoId,
          pedido_item_id: 999999,
          comanda_id: ctx.comanda1.comandaId,
          qty_solicitada: '1.000'
        }], 'tx-20'), { db }),
        (err) => err.codigo === 'ITEM_PEDIDO_INCOMPATIVEL'
      );

      const rods = await all(db, `SELECT id FROM cozinha_rodadas`);
      assert.equal(rods.length, 0);
      const un = await get(db, `SELECT sequencia_atual FROM cozinha_unidades WHERE id = ?`, [ctx.unidadeId]);
      assert.equal(un.sequencia_atual, 0);
      const idemp = await get(db, `
        SELECT * FROM cozinha_idempotencia WHERE idempotency_key = 'tx-20'
      `);
      assert.equal(idemp, null);

      // Mesma chave pode ser reutilizada após rollback
      const ok = await CozinhaDespacho.despacharLote(entradaDespacho(ctx, [{
        pedido_id: ctx.comanda1.pedidoId,
        pedido_item_id: ctx.comanda1.pedidoItemId,
        comanda_id: ctx.comanda1.comandaId,
        qty_solicitada: '1.000'
      }], 'tx-20'), { db });
      assert.equal(ok.success, true);
      await close(db);
    });

    it('21) registra operação CONCLUIDA na tabela central cozinha_idempotencia', async () => {
      const db = await open();
      await schemaErpMinimo(db);
      const ctx = await semearCenarioBase(db);

      const out = await CozinhaDespacho.despacharLote(entradaDespacho(ctx, [{
        pedido_id: ctx.comanda1.pedidoId,
        pedido_item_id: ctx.comanda1.pedidoItemId,
        comanda_id: ctx.comanda1.comandaId,
        qty_solicitada: '1.000'
      }], 'tx-21'), { db });

      const row = await get(db, `
        SELECT * FROM cozinha_idempotencia WHERE idempotency_key = 'tx-21'
      `);
      assert.equal(row.tipo_operacao, TIPOS_OPERACAO.DESPACHO_LOTE);
      assert.equal(row.situacao, 'CONCLUIDA');
      assert.equal(row.resultado_http_status, 201);
      assert.equal(row.recurso_tipo, 'rodada');
      assert.equal(Number(row.recurso_id), out.rodada.id);
      const corpo = JSON.parse(row.resultado_json);
      assert.equal(corpo.rodada.id, out.rodada.id);
      await close(db);
    });
  });
});
