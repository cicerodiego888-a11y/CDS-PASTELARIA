/**
 * Correções de auditoria — Sprint 03 Cozinha
 * Idempotência central · Classificação oficial · Rodada CANCELADA
 *
 *   node --test --test-concurrency=1 tests/cozinha/sprint03-correcoes-auditoria.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cozinha-s03-fix-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const {
  garantirSchemaCozinha,
  marcarCozinhaOperacional,
  isCozinhaOperacional,
  COZINHA_SCHEMA_VERSION
} = require('../../backend/utils/cozinhaSchema');
const CozinhaDespacho = require('../../backend/services/cozinha/CozinhaDespachoService');
const CozinhaPreparacao = require('../../backend/services/cozinha/CozinhaPreparacaoService');
const {
  classificarItemCozinha
} = require('../../backend/services/cozinha/cozinhaClassificacaoItem');
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
  await run(db, `CREATE TABLE IF NOT EXISTS configuracoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, chave VARCHAR(100) UNIQUE NOT NULL,
    valor TEXT, tipo VARCHAR(50), descricao TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  await run(db, `CREATE TABLE IF NOT EXISTS categorias (
    id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL)`);
  await run(db, `CREATE TABLE IF NOT EXISTS mesas (
    id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER NOT NULL,
    numero INTEGER NOT NULL, ativo INTEGER DEFAULT 1)`);
  await run(db, `CREATE TABLE IF NOT EXISTS mesa_atendimentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER NOT NULL, mesa_id INTEGER NOT NULL,
    estado TEXT NOT NULL, operador_abertura_id INTEGER DEFAULT 1, aberto_em TEXT DEFAULT CURRENT_TIMESTAMP)`);
  await run(db, `CREATE TABLE IF NOT EXISTS produtos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL,
    tipo_operacional TEXT DEFAULT 'COMERCIAL', comercializavel INTEGER DEFAULT 0,
    categoria_id INTEGER, utiliza_ficha_tecnica INTEGER DEFAULT 0,
    permite_personalizacao_ingredientes INTEGER DEFAULT 0)`);
  await run(db, `CREATE TABLE IF NOT EXISTS ficha_tecnica (
    id INTEGER PRIMARY KEY AUTOINCREMENT, produto_id INTEGER NOT NULL, ativo INTEGER DEFAULT 1)`);
  await run(db, `CREATE TABLE IF NOT EXISTS pedidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, codigo VARCHAR(50), data_pedido DATE DEFAULT '2026-01-01',
    total DECIMAL(10,2) DEFAULT 0, status TEXT DEFAULT 'PEDIDO',
    empresa_id INTEGER, mesa_id INTEGER, mesa_atendimento_id INTEGER)`);
  await run(db, `CREATE TABLE IF NOT EXISTS pedidos_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT, pedido_id INTEGER NOT NULL, produto_id INTEGER NOT NULL,
    quantidade REAL NOT NULL, preco_unitario DECIMAL(10,2) DEFAULT 0, subtotal DECIMAL(10,2) DEFAULT 0,
    classificacao_operacional_snapshot TEXT, produto_nome_snapshot TEXT)`);
  await run(db, `CREATE TABLE IF NOT EXISTS pedido_item_ingredientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, pedido_id INTEGER NOT NULL, pedido_item_id INTEGER NOT NULL,
    empresa_id INTEGER NOT NULL, insumo_id INTEGER NOT NULL, insumo_nome_snapshot TEXT NOT NULL,
    quantidade_snapshot REAL NOT NULL, unidade_snapshot TEXT NOT NULL,
    classificacao_comercial_snapshot TEXT NOT NULL, selecionado INTEGER NOT NULL,
    preco_adicional_snapshot REAL DEFAULT 0)`);
  const info = await garantirSchemaCozinha(db);
  assert.equal(info.operacional, true);
  assert.equal(isCozinhaOperacional(), true);
  assert.equal(COZINHA_SCHEMA_VERSION, 4);
}

async function seed(db, empresaId = 1) {
  const catRef = await run(db, `INSERT INTO categorias (nome) VALUES ('Refrigerantes')`);
  const catOut = await run(db, `INSERT INTO categorias (nome) VALUES ('Embalagens')`);
  const pastel = await run(db, `
    INSERT INTO produtos (nome, tipo_operacional, utiliza_ficha_tecnica, permite_personalizacao_ingredientes, categoria_id)
    VALUES ('Pastel do Cheff', 'COMERCIAL', 1, 1, ?)
  `, [catOut.lastID]);
  const pastelSemPers = await run(db, `
    INSERT INTO produtos (nome, tipo_operacional, utiliza_ficha_tecnica, permite_personalizacao_ingredientes)
    VALUES ('Pastel Simples', 'COMERCIAL', 1, 0)
  `);
  const semFicha = await run(db, `
    INSERT INTO produtos (nome, tipo_operacional, utiliza_ficha_tecnica)
    VALUES ('Produto Sem Ficha', 'COMERCIAL', 0)
  `);
  const carne = await run(db, `
    INSERT INTO produtos (nome, tipo_operacional, comercializavel) VALUES ('Carne de Sol', 'INSUMO', 0)
  `);
  const fanta = await run(db, `
    INSERT INTO produtos (nome, tipo_operacional, comercializavel, categoria_id)
    VALUES ('Fanta Lata 350 ML', 'INSUMO', 1, ?)
  `, [catRef.lastID]);
  const emb = await run(db, `
    INSERT INTO produtos (nome, tipo_operacional, comercializavel, categoria_id)
    VALUES ('Copo Plastico', 'INSUMO', 1, ?)
  `, [catOut.lastID]);
  const mesa = await run(db, `INSERT INTO mesas (empresa_id, numero, ativo) VALUES (?, 7, 1)`, [empresaId]);
  const at = await run(db, `
    INSERT INTO mesa_atendimentos (empresa_id, mesa_id, estado) VALUES (?, ?, 'OCUPADA')
  `, [empresaId, mesa.lastID]);
  const un = await run(db, `
    INSERT INTO cozinha_unidades (empresa_id, codigo, sequencia_atual) VALUES (?, ?, 0)
  `, [empresaId, `U${empresaId}`]);
  return {
    empresaId,
    mesaId: mesa.lastID,
    atendimentoId: at.lastID,
    unidadeId: un.lastID,
    prodPastelId: pastel.lastID,
    prodPastelSemPersId: pastelSemPers.lastID,
    prodSemFichaId: semFicha.lastID,
    prodCarneId: carne.lastID,
    prodFantaId: fanta.lastID,
    prodEmbId: emb.lastID
  };
}

async function criarItem(db, infra, {
  produtoId, nome, classif, qty = 1, personalizacao = null
}) {
  const ped = await run(db, `
    INSERT INTO pedidos (codigo, status, empresa_id, mesa_id, mesa_atendimento_id, total)
    VALUES (?, 'PEDIDO', ?, ?, ?, 10)
  `, [`P-${Date.now()}-${Math.random()}`, infra.empresaId, infra.mesaId, infra.atendimentoId]);
  const item = await run(db, `
    INSERT INTO pedidos_itens (
      pedido_id, produto_id, quantidade, preco_unitario, subtotal,
      classificacao_operacional_snapshot, produto_nome_snapshot
    ) VALUES (?, ?, ?, 10, 10, ?, ?)
  `, [ped.lastID, produtoId, qty, classif, nome]);
  if (personalizacao) {
    await run(db, `
      INSERT INTO pedido_item_ingredientes (
        pedido_id, pedido_item_id, empresa_id, insumo_id,
        insumo_nome_snapshot, quantidade_snapshot, unidade_snapshot,
        classificacao_comercial_snapshot, selecionado, preco_adicional_snapshot
      ) VALUES (?, ?, ?, ?, ?, 1, 'UN', 'ADICIONAL', 1, 0)
    `, [ped.lastID, item.lastID, infra.empresaId, infra.prodCarneId, personalizacao]);
  }
  const cmd = await run(db, `
    INSERT INTO cozinha_comandas (empresa_id, atendimento_id, numero_comanda, pedido_id)
    VALUES (?, ?, ?, ?)
  `, [infra.empresaId, infra.atendimentoId, Math.floor(Math.random() * 8000) + 1, ped.lastID]);
  return { pedidoId: ped.lastID, pedidoItemId: item.lastID, comandaId: cmd.lastID, qty: String(Number(qty).toFixed(3)) };
}

function despachoEntrada(infra, linhas, key) {
  return {
    empresaId: infra.empresaId,
    operadorId: 7,
    idempotencyKey: key,
    unidade_id: infra.unidadeId,
    mesa_id: infra.mesaId,
    atendimento_id: infra.atendimentoId,
    itens: linhas.map((l) => ({
      pedido_id: l.pedidoId,
      pedido_item_id: l.pedidoItemId,
      comanda_id: l.comandaId,
      qty_solicitada: l.qty || '1.000'
    }))
  };
}

describe('Correções auditoria Sprint 03', () => {
  beforeEach(() => marcarCozinhaOperacional(false));

  describe('Idempotência central', () => {
    it('1) mesma chave, mesmo iniciar e mesmo item: replay', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seed(db);
      const pastel = await criarItem(db, infra, {
        produtoId: infra.prodPastelId, nome: 'Pastel', classif: 'COMERCIAL'
      });
      const out = await CozinhaDespacho.despacharLote(
        despachoEntrada(infra, [pastel], 'fix-desp-1'), { db }
      );
      const id = out.itens[0].id;
      const a = await CozinhaPreparacao.iniciarPreparacao({
        empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId: id, idempotencyKey: 'idem-ini-1'
      }, { db });
      const b = await CozinhaPreparacao.iniciarPreparacao({
        empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId: id, idempotencyKey: 'idem-ini-1'
      }, { db });
      assert.equal(a.repetida, false);
      assert.equal(b.repetida, true);
      assert.equal(a.item.id, b.item.id);
      const rows = await all(db, `
        SELECT * FROM cozinha_idempotencia WHERE idempotency_key='idem-ini-1'
      `);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].tipo_operacao, TIPOS_OPERACAO.PREPARACAO_INICIADA);
      assert.equal(rows[0].situacao, 'CONCLUIDA');
      await close(db);
    });

    it('2) mesma chave, iniciar em itens diferentes: 409', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seed(db);
      const p1 = await criarItem(db, infra, {
        produtoId: infra.prodPastelId, nome: 'P1', classif: 'COMERCIAL'
      });
      const p2 = await criarItem(db, infra, {
        produtoId: infra.prodPastelId, nome: 'P2', classif: 'COMERCIAL'
      });
      const out = await CozinhaDespacho.despacharLote(
        despachoEntrada(infra, [p1, p2], 'fix-desp-2'), { db }
      );
      await CozinhaPreparacao.iniciarPreparacao({
        empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId: out.itens[0].id, idempotencyKey: 'idem-cross-item'
      }, { db });
      await assert.rejects(
        () => CozinhaPreparacao.iniciarPreparacao({
          empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId: out.itens[1].id, idempotencyKey: 'idem-cross-item'
        }, { db }),
        (err) => {
          assert.equal(err.codigo, 'IDEMPOTENCY_PAYLOAD_DIVERGENTE');
          assert.equal(err.statusCode, 409);
          return true;
        }
      );
      await close(db);
    });

    it('3) mesma chave entre iniciar e marcar pronto: 409', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seed(db);
      const p = await criarItem(db, infra, {
        produtoId: infra.prodPastelId, nome: 'P', classif: 'COMERCIAL'
      });
      const out = await CozinhaDespacho.despacharLote(
        despachoEntrada(infra, [p], 'fix-desp-3'), { db }
      );
      const id = out.itens[0].id;
      await CozinhaPreparacao.iniciarPreparacao({
        empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId: id, idempotencyKey: 'idem-op-cross'
      }, { db });
      await assert.rejects(
        () => CozinhaPreparacao.marcarItemPronto({
          empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId: id, idempotencyKey: 'idem-op-cross'
        }, { db }),
        (err) => {
          assert.equal(err.codigo, 'IDEMPOTENCY_OPERACAO_DIVERGENTE');
          return true;
        }
      );
      await close(db);
    });

    it('4) mesma chave entre marcar pronto e entregar bebida: 409', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seed(db);
      const pastel = await criarItem(db, infra, {
        produtoId: infra.prodPastelId, nome: 'P', classif: 'COMERCIAL'
      });
      const bebida = await criarItem(db, infra, {
        produtoId: infra.prodFantaId, nome: 'Fanta', classif: 'INSUMO', qty: 1
      });
      const out = await CozinhaDespacho.despacharLote(
        despachoEntrada(infra, [pastel, bebida], 'fix-desp-4'), { db }
      );
      const pastelItem = out.itens.find((i) => i.tipo_item === 'PASTEL');
      const bebItem = out.itens.find((i) => i.tipo_item === 'BEBIDA');
      await CozinhaPreparacao.iniciarPreparacao({
        empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId: pastelItem.id, idempotencyKey: 'ini-4'
      }, { db });
      await CozinhaPreparacao.marcarItemPronto({
        empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId: pastelItem.id, idempotencyKey: 'idem-pronto-beb'
      }, { db });
      await assert.rejects(
        () => CozinhaPreparacao.entregarBebida({
          empresaId: 1, operadorId: 7, itemId: bebItem.id,
        unidade_id: infra.unidadeId,
          qty_entregue: '1.000', idempotencyKey: 'idem-pronto-beb'
        }, { db }),
        (err) => err.codigo === 'IDEMPOTENCY_OPERACAO_DIVERGENTE'
      );
      await close(db);
    });

    it('5) mesma chave com payload diferente (qty): 409', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seed(db);
      const bebida = await criarItem(db, infra, {
        produtoId: infra.prodFantaId, nome: 'Fanta', classif: 'INSUMO', qty: 3
      });
      const out = await CozinhaDespacho.despacharLote(
        despachoEntrada(infra, [{ ...bebida, qty: '3.000' }], 'fix-desp-5'), { db }
      );
      await CozinhaPreparacao.entregarBebida({
        empresaId: 1, operadorId: 7, itemId: out.itens[0].id,
        unidade_id: infra.unidadeId,
        qty_entregue: '1.000', idempotencyKey: 'idem-qty'
      }, { db });
      await assert.rejects(
        () => CozinhaPreparacao.entregarBebida({
          empresaId: 1, operadorId: 7, itemId: out.itens[0].id,
        unidade_id: infra.unidadeId,
          qty_entregue: '2.000', idempotencyKey: 'idem-qty'
        }, { db }),
        (err) => {
          assert.equal(err.codigo, 'IDEMPOTENCY_PAYLOAD_DIVERGENTE');
          return true;
        }
      );
      const entregas = await all(db, `SELECT * FROM cozinha_bebida_entregas`);
      assert.equal(entregas.length, 1);
      assert.equal(entregas[0].qty_entregue_millis, 1000);
      await close(db);
    });

    it('6) repetição de entrega não duplica quantidade', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seed(db);
      const bebida = await criarItem(db, infra, {
        produtoId: infra.prodFantaId, nome: 'Fanta', classif: 'INSUMO', qty: 2
      });
      const out = await CozinhaDespacho.despacharLote(
        despachoEntrada(infra, [{ ...bebida, qty: '2.000' }], 'fix-desp-6'), { db }
      );
      const a = await CozinhaPreparacao.entregarBebida({
        empresaId: 1, operadorId: 7, itemId: out.itens[0].id,
        unidade_id: infra.unidadeId,
        qty_entregue: '1.000', idempotencyKey: 'idem-beb-rep'
      }, { db });
      const b = await CozinhaPreparacao.entregarBebida({
        empresaId: 1, operadorId: 7, itemId: out.itens[0].id,
        unidade_id: infra.unidadeId,
        qty_entregue: '1.000', idempotencyKey: 'idem-beb-rep'
      }, { db });
      assert.equal(b.repetida, true);
      assert.equal(a.entrega.id, b.entrega.id);
      const sum = await get(db, `
        SELECT COALESCE(SUM(qty_entregue_millis),0) AS t FROM cozinha_bebida_entregas
        WHERE cozinha_item_id=?
      `, [out.itens[0].id]);
      assert.equal(Number(sum.t), 1000);
      await close(db);
    });

    it('7) falha transacional não deixa registros parciais', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seed(db);
      const p = await criarItem(db, infra, {
        produtoId: infra.prodPastelId, nome: 'P', classif: 'COMERCIAL'
      });
      const out = await CozinhaDespacho.despacharLote(
        despachoEntrada(infra, [p], 'fix-desp-7'), { db }
      );
      await assert.rejects(
        () => CozinhaPreparacao.marcarItemPronto({
          empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId: out.itens[0].id, idempotencyKey: 'idem-fail-7'
        }, { db }),
        (err) => err.codigo === 'TRANSICAO_INVALIDA'
      );
      assert.equal(await get(db, `
        SELECT * FROM cozinha_idempotencia WHERE idempotency_key='idem-fail-7'
      `), null);
      assert.equal((await all(db, `
        SELECT * FROM cozinha_eventos_outbox WHERE idempotency_key LIKE 'idem-fail-7%'
      `)).length, 0);
      const item = await get(db, `SELECT estado_preparacao FROM cozinha_itens WHERE id=?`, [out.itens[0].id]);
      assert.equal(item.estado_preparacao, 'AGUARDANDO');
      await close(db);
    });
  });

  describe('Classificação oficial', () => {
    it('8) COMERCIAL + utiliza_ficha_tecnica=1 → PASTEL', async () => {
      assert.equal(classificarItemCozinha({
        tipo_operacional: 'COMERCIAL', utiliza_ficha_tecnica: 1
      }).tipo, 'PASTEL');
      const db = await open();
      await schemaErp(db);
      const infra = await seed(db);
      const p = await criarItem(db, infra, {
        produtoId: infra.prodPastelId, nome: 'Pastel', classif: 'COMERCIAL'
      });
      const out = await CozinhaDespacho.despacharLote(
        despachoEntrada(infra, [p], 'cls-8'), { db }
      );
      assert.equal(out.itens[0].tipo_item, 'PASTEL');
      await close(db);
    });

    it('9) COMERCIAL + utiliza_ficha_tecnica=0 → OUTRO', async () => {
      assert.equal(classificarItemCozinha({
        tipo_operacional: 'COMERCIAL', utiliza_ficha_tecnica: 0
      }).tipo, 'OUTRO');
      const db = await open();
      await schemaErp(db);
      const infra = await seed(db);
      const p = await criarItem(db, infra, {
        produtoId: infra.prodSemFichaId, nome: 'Sem Ficha', classif: 'COMERCIAL'
      });
      const out = await CozinhaDespacho.despacharLote(
        despachoEntrada(infra, [p], 'cls-9'), { db }
      );
      assert.equal(out.itens[0].tipo_item, 'OUTRO');
      await close(db);
    });

    it('10) PASTEL sem personalização continua PASTEL', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seed(db);
      const p = await criarItem(db, infra, {
        produtoId: infra.prodPastelSemPersId, nome: 'Pastel Simples', classif: 'COMERCIAL'
      });
      const out = await CozinhaDespacho.despacharLote(
        despachoEntrada(infra, [p], 'cls-10'), { db }
      );
      assert.equal(out.itens[0].tipo_item, 'PASTEL');
      const ings = await all(db, `
        SELECT * FROM cozinha_item_ingredientes WHERE cozinha_item_id=?
      `, [out.itens[0].id]);
      assert.equal(ings.length, 0);
      await close(db);
    });

    it('11) PASTEL com personalização mantém ingredientes vinculados', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seed(db);
      const p = await criarItem(db, infra, {
        produtoId: infra.prodPastelId, nome: 'Pastel Cheff', classif: 'COMERCIAL',
        personalizacao: 'Carne de Sol'
      });
      const out = await CozinhaDespacho.despacharLote(
        despachoEntrada(infra, [p], 'cls-11'), { db }
      );
      assert.equal(out.itens[0].tipo_item, 'PASTEL');
      const ings = await all(db, `
        SELECT * FROM cozinha_item_ingredientes WHERE cozinha_item_id=?
      `, [out.itens[0].id]);
      assert.equal(ings.length, 1);
      assert.equal(ings[0].insumo_nome_snapshot, 'Carne de Sol');
      await close(db);
    });

    it('12) INSUMO comercializável Refrigerantes → BEBIDA', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seed(db);
      const b = await criarItem(db, infra, {
        produtoId: infra.prodFantaId, nome: 'Fanta', classif: 'INSUMO'
      });
      const out = await CozinhaDespacho.despacharLote(
        despachoEntrada(infra, [b], 'cls-12'), { db }
      );
      assert.equal(out.itens[0].tipo_item, 'BEBIDA');
      await close(db);
    });

    it('13) INSUMO comercializável outra categoria → OUTRO', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seed(db);
      const b = await criarItem(db, infra, {
        produtoId: infra.prodEmbId, nome: 'Copo', classif: 'INSUMO'
      });
      const out = await CozinhaDespacho.despacharLote(
        despachoEntrada(infra, [b], 'cls-13'), { db }
      );
      assert.equal(out.itens[0].tipo_item, 'OUTRO');
      await close(db);
    });

    it('14) ingrediente da ficha não vira item independente', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seed(db);
      const p = await criarItem(db, infra, {
        produtoId: infra.prodPastelId, nome: 'Pastel', classif: 'COMERCIAL',
        personalizacao: 'Carne de Sol'
      });
      const b = await criarItem(db, infra, {
        produtoId: infra.prodFantaId, nome: 'Fanta', classif: 'INSUMO'
      });
      const out = await CozinhaDespacho.despacharLote(
        despachoEntrada(infra, [p, b], 'cls-14'), { db }
      );
      assert.equal(out.itens.length, 2);
      assert.ok(!out.itens.some((i) => (i.produto_nome_snapshot || '').includes('Carne de Sol')));
      await close(db);
    });

    it('15) alteração posterior no cadastro não reclassifica item despachado', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seed(db);
      const p = await criarItem(db, infra, {
        produtoId: infra.prodPastelId, nome: 'Pastel', classif: 'COMERCIAL'
      });
      const out = await CozinhaDespacho.despacharLote(
        despachoEntrada(infra, [p], 'cls-15'), { db }
      );
      assert.equal(out.itens[0].tipo_item, 'PASTEL');
      await run(db, `UPDATE produtos SET utiliza_ficha_tecnica=0 WHERE id=?`, [infra.prodPastelId]);
      const row = await get(db, `SELECT tipo_item FROM cozinha_itens WHERE id=?`, [out.itens[0].id]);
      assert.equal(row.tipo_item, 'PASTEL');
      const consulta = await CozinhaPreparacao.consultarPreparacaoRodada({
        empresaId: 1, rodadaId: out.rodada.id
      }, { db });
      assert.equal(consulta.itens[0].tipo_item, 'PASTEL');
      await close(db);
    });
  });

  describe('Rodada CANCELADA', () => {
    async function despacharECancelar(db) {
      const infra = await seed(db);
      const pastel = await criarItem(db, infra, {
        produtoId: infra.prodPastelId, nome: 'P', classif: 'COMERCIAL'
      });
      const bebida = await criarItem(db, infra, {
        produtoId: infra.prodFantaId, nome: 'F', classif: 'INSUMO', qty: 2
      });
      const out = await CozinhaDespacho.despacharLote(
        despachoEntrada(infra, [pastel, { ...bebida, qty: '2.000' }], `canc-desp-${Math.random()}`),
        { db }
      );
      await run(db, `
        UPDATE cozinha_rodadas SET estado_preparacao='CANCELADA' WHERE id=?
      `, [out.rodada.id]);
      return { infra, out };
    }

    it('16) rodada cancelada não pode iniciar preparação', async () => {
      const db = await open();
      await schemaErp(db);
      const { infra, out } = await despacharECancelar(db);
      const pastel = out.itens.find((i) => i.tipo_item === 'PASTEL');
      await assert.rejects(
        () => CozinhaPreparacao.iniciarPreparacao({
          empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId: pastel.id, idempotencyKey: 'canc-16'
        }, { db }),
        (err) => {
          assert.equal(err.codigo, 'RODADA_CANCELADA');
          return true;
        }
      );
      const item = await get(db, `SELECT estado_preparacao FROM cozinha_itens WHERE id=?`, [pastel.id]);
      assert.equal(item.estado_preparacao, 'AGUARDANDO');
      await close(db);
    });

    it('17) rodada cancelada não pode receber item pronto', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seed(db);
      const p = await criarItem(db, infra, {
        produtoId: infra.prodPastelId, nome: 'P', classif: 'COMERCIAL'
      });
      const out = await CozinhaDespacho.despacharLote(
        despachoEntrada(infra, [p], 'canc-17-desp'), { db }
      );
      await CozinhaPreparacao.iniciarPreparacao({
        empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId: out.itens[0].id, idempotencyKey: 'canc-17-ini'
      }, { db });
      await run(db, `UPDATE cozinha_rodadas SET estado_preparacao='CANCELADA' WHERE id=?`, [out.rodada.id]);
      await assert.rejects(
        () => CozinhaPreparacao.marcarItemPronto({
          empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId: out.itens[0].id, idempotencyKey: 'canc-17-pronto'
        }, { db }),
        (err) => err.codigo === 'RODADA_CANCELADA'
      );
      const rod = await get(db, `SELECT estado_preparacao FROM cozinha_rodadas WHERE id=?`, [out.rodada.id]);
      assert.equal(rod.estado_preparacao, 'CANCELADA');
      await close(db);
    });

    it('18) rodada cancelada não pode receber entrega de bebida', async () => {
      const db = await open();
      await schemaErp(db);
      const { infra, out } = await despacharECancelar(db);
      const beb = out.itens.find((i) => i.tipo_item === 'BEBIDA');
      await assert.rejects(
        () => CozinhaPreparacao.entregarBebida({
          empresaId: 1, operadorId: 7, itemId: beb.id,
          unidade_id: infra.unidadeId,
          qty_entregue: '1.000', idempotencyKey: 'canc-18'
        }, { db }),
        (err) => err.codigo === 'RODADA_CANCELADA'
      );
      assert.equal((await all(db, `SELECT id FROM cozinha_bebida_entregas`)).length, 0);
      await close(db);
    });

    it('19) sincronização não altera CANCELADA', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seed(db);
      const p = await criarItem(db, infra, {
        produtoId: infra.prodPastelId, nome: 'P', classif: 'COMERCIAL'
      });
      const out = await CozinhaDespacho.despacharLote(
        despachoEntrada(infra, [p], 'canc-19-desp'), { db }
      );
      await run(db, `UPDATE cozinha_itens SET estado_preparacao='PRONTO' WHERE id=?`, [out.itens[0].id]);
      await run(db, `UPDATE cozinha_rodadas SET estado_preparacao='CANCELADA' WHERE id=?`, [out.rodada.id]);
      const rodada = await get(db, `SELECT * FROM cozinha_rodadas WHERE id=?`, [out.rodada.id]);
      const itens = await all(db, `SELECT * FROM cozinha_itens WHERE rodada_id=?`, [out.rodada.id]);
      await run(db, 'BEGIN IMMEDIATE');
      const sync = await CozinhaPreparacao.sincronizarEstadoRodada(db, rodada, itens, {
        empresaId: 1, operadorId: 7, idempotencyKeyBase: 'canc-19-sync'
      });
      await run(db, 'COMMIT');
      assert.equal(sync.estado_preparacao, 'CANCELADA');
      assert.equal(sync.bloqueada, true);
      const rod = await get(db, `SELECT estado_preparacao FROM cozinha_rodadas WHERE id=?`, [out.rodada.id]);
      assert.equal(rod.estado_preparacao, 'CANCELADA');
      await close(db);
    });

    it('20) falha transacional preserva CANCELADA', async () => {
      const db = await open();
      await schemaErp(db);
      const { infra, out } = await despacharECancelar(db);
      const pastel = out.itens.find((i) => i.tipo_item === 'PASTEL');
      await assert.rejects(
        () => CozinhaPreparacao.iniciarPreparacao({
          empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId, itemId: pastel.id, idempotencyKey: 'canc-20'
        }, { db }),
        (err) => err.codigo === 'RODADA_CANCELADA'
      );
      const rod = await get(db, `SELECT estado_preparacao FROM cozinha_rodadas WHERE id=?`, [out.rodada.id]);
      assert.equal(rod.estado_preparacao, 'CANCELADA');
      assert.equal(await get(db, `
        SELECT * FROM cozinha_idempotencia WHERE idempotency_key='canc-20'
      `), null);
      await close(db);
    });
  });

  describe('Consulta bebidas vs PRONTA', () => {
    it('consulta separa saldos de bebida e nota sobre PRONTA', async () => {
      const db = await open();
      await schemaErp(db);
      const infra = await seed(db);
      const bebida = await criarItem(db, infra, {
        produtoId: infra.prodFantaId, nome: 'Fanta', classif: 'INSUMO', qty: 2
      });
      const out = await CozinhaDespacho.despacharLote(
        despachoEntrada(infra, [{ ...bebida, qty: '2.000' }], 'beb-consulta'), { db }
      );
      await CozinhaPreparacao.entregarBebida({
        empresaId: 1, operadorId: 7, itemId: out.itens[0].id,
        unidade_id: infra.unidadeId,
        qty_entregue: '1.000', idempotencyKey: 'beb-ent-parcial'
      }, { db });
      const c = await CozinhaPreparacao.consultarPreparacaoRodada({
        empresaId: 1, rodadaId: out.rodada.id
      }, { db });
      assert.equal(c.bebidas.qty_solicitada, '2.000');
      assert.equal(c.bebidas.qty_entregue, '1.000');
      assert.equal(c.bebidas.qty_pendente, '1.000');
      assert.ok(/não confirma/i.test(c.bebidas.nota));
      await close(db);
    });
  });
});
