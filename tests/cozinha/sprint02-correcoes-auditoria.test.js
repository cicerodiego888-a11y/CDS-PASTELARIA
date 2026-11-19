/**
 * Correções de auditoria — Sprint 02 Cozinha
 * Banco temporário apenas.
 *
 *   node --test --test-concurrency=1 tests/cozinha/sprint02-correcoes-auditoria.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cozinha-s02-fix-'));
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
  await run(db, `CREATE TABLE IF NOT EXISTS mesas (
    id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER NOT NULL, numero INTEGER NOT NULL, ativo INTEGER DEFAULT 1)`);
  await run(db, `CREATE TABLE IF NOT EXISTS mesa_atendimentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER NOT NULL, mesa_id INTEGER NOT NULL,
    estado TEXT NOT NULL, operador_abertura_id INTEGER NOT NULL DEFAULT 1, aberto_em TEXT DEFAULT CURRENT_TIMESTAMP)`);
  await run(db, `CREATE TABLE IF NOT EXISTS produtos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL, tipo_operacional TEXT DEFAULT 'COMERCIAL')`);
  await run(db, `CREATE TABLE IF NOT EXISTS pedidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, codigo VARCHAR(50), data_pedido DATE DEFAULT '2026-01-01',
    total DECIMAL(10,2) DEFAULT 0, status TEXT DEFAULT 'PEDIDO', empresa_id INTEGER, mesa_id INTEGER, mesa_atendimento_id INTEGER)`);
  await run(db, `CREATE TABLE IF NOT EXISTS pedidos_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT, pedido_id INTEGER NOT NULL, produto_id INTEGER NOT NULL,
    quantidade REAL NOT NULL, preco_unitario DECIMAL(10,2) DEFAULT 0, subtotal DECIMAL(10,2) DEFAULT 0,
    classificacao_operacional_snapshot TEXT, produto_nome_snapshot TEXT)`);
  await run(db, `CREATE TABLE IF NOT EXISTS pedido_item_ingredientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, pedido_id INTEGER NOT NULL, pedido_item_id INTEGER NOT NULL,
    empresa_id INTEGER NOT NULL, insumo_id INTEGER NOT NULL, insumo_nome_snapshot TEXT NOT NULL,
    quantidade_snapshot REAL NOT NULL, unidade_snapshot TEXT NOT NULL,
    classificacao_comercial_snapshot TEXT NOT NULL, selecionado INTEGER NOT NULL, preco_adicional_snapshot REAL DEFAULT 0)`);
  const info = await garantirSchemaCozinha(db);
  assert.equal(info.operacional, true);
  assert.equal(isCozinhaOperacional(), true);
}

async function seedBase(db, { mesaAtiva = 1 } = {}) {
  const mesa = await run(db, `INSERT INTO mesas (empresa_id, numero, ativo) VALUES (1, 5, ?)`, [mesaAtiva]);
  const at = await run(db, `INSERT INTO mesa_atendimentos (empresa_id, mesa_id, estado) VALUES (1, ?, 'OCUPADA')`, [mesa.lastID]);
  const un = await run(db, `INSERT INTO cozinha_unidades (empresa_id, codigo, sequencia_atual) VALUES (1, 'U1', 0)`);
  const prod = await run(db, `INSERT INTO produtos (nome, tipo_operacional) VALUES ('Pastel de Carne', 'COMERCIAL')`);
  const ped = await run(db, `
    INSERT INTO pedidos (codigo, status, empresa_id, mesa_id, mesa_atendimento_id)
    VALUES ('P1', 'PEDIDO', 1, ?, ?)
  `, [mesa.lastID, at.lastID]);
  const item = await run(db, `
    INSERT INTO pedidos_itens (
      pedido_id, produto_id, quantidade, classificacao_operacional_snapshot, produto_nome_snapshot
    ) VALUES (?, ?, 2, 'COMERCIAL', 'Pastel de Carne')
  `, [ped.lastID, prod.lastID]);
  const cmd = await run(db, `
    INSERT INTO cozinha_comandas (empresa_id, atendimento_id, numero_comanda, pedido_id)
    VALUES (1, ?, 1, ?)
  `, [at.lastID, ped.lastID]);
  return {
    empresaId: 1,
    operadorId: 7,
    mesaId: mesa.lastID,
    atendimentoId: at.lastID,
    unidadeId: un.lastID,
    pedidoId: ped.lastID,
    pedidoItemId: item.lastID,
    comandaId: cmd.lastID,
    produtoId: prod.lastID
  };
}

function entrada(ctx, itens, key) {
  return {
    empresaId: ctx.empresaId,
    operadorId: ctx.operadorId,
    idempotencyKey: key,
    unidade_id: ctx.unidadeId,
    mesa_id: ctx.mesaId,
    atendimento_id: ctx.atendimentoId,
    itens
  };
}

describe('Correções auditoria Sprint 02', () => {
  beforeEach(() => marcarCozinhaOperacional(false));

  describe('CORREÇÃO 01 — Mesa inativa', () => {
    it('mesa ativa permite despacho', async () => {
      const db = await open();
      await schemaErp(db);
      const ctx = await seedBase(db, { mesaAtiva: 1 });
      const out = await CozinhaDespacho.despacharLote(entrada(ctx, [{
        pedido_id: ctx.pedidoId,
        pedido_item_id: ctx.pedidoItemId,
        comanda_id: ctx.comandaId,
        qty_solicitada: '1.000'
      }], 'mesa-ativa'), { db });
      assert.equal(out.success, true);
      assert.equal(out.rodada.sequencia_global, 1);
      await close(db);
    });

    it('mesa inativa é rejeitada sem rodada/FIFO/parciais', async () => {
      const db = await open();
      await schemaErp(db);
      const ctx = await seedBase(db, { mesaAtiva: 0 });
      await assert.rejects(
        () => CozinhaDespacho.despacharLote(entrada(ctx, [{
          pedido_id: ctx.pedidoId,
          pedido_item_id: ctx.pedidoItemId,
          comanda_id: ctx.comandaId,
          qty_solicitada: '1.000'
        }], 'mesa-inativa'), { db }),
        (err) => {
          assert.equal(err.statusCode, 409);
          assert.equal(err.codigo, 'MESA_INATIVA');
          return true;
        }
      );
      assert.equal((await all(db, `SELECT id FROM cozinha_rodadas`)).length, 0);
      assert.equal((await all(db, `SELECT id FROM cozinha_itens`)).length, 0);
      const un = await get(db, `SELECT sequencia_atual FROM cozinha_unidades WHERE id=?`, [ctx.unidadeId]);
      assert.equal(un.sequencia_atual, 0);
      assert.equal(await get(db, `SELECT * FROM cozinha_idempotencia WHERE idempotency_key='mesa-inativa'`), null);
      await close(db);
    });
  });

  describe('CORREÇÃO 02 — Item removido (cancelamento individual no ERP)', () => {
    it('diagnóstico: ERP remove linha via DELETE; sem coluna de cancelamento em pedidos_itens', async () => {
      const db = await open();
      await schemaErp(db);
      const cols = await all(db, `PRAGMA table_info(pedidos_itens)`);
      const nomes = cols.map((c) => c.name);
      assert.ok(!nomes.includes('cancelado'));
      assert.ok(!nomes.includes('cancelada'));
      assert.ok(!nomes.includes('status'));
      assert.ok(!nomes.includes('situacao'));
      await close(db);
    });

    it('pedido aberto: item deletado não despacha; item válido despacha', async () => {
      const db = await open();
      await schemaErp(db);
      const ctx = await seedBase(db);
      const item2 = await run(db, `
        INSERT INTO pedidos_itens (
          pedido_id, produto_id, quantidade, classificacao_operacional_snapshot, produto_nome_snapshot
        ) VALUES (?, ?, 1, 'COMERCIAL', 'Pastel de Queijo')
      `, [ctx.pedidoId, ctx.produtoId]);

      // Simula cancelamento individual oficial do ERP: DELETE da linha
      await run(db, `DELETE FROM pedidos_itens WHERE id = ?`, [ctx.pedidoItemId]);

      await assert.rejects(
        () => CozinhaDespacho.despacharLote(entrada(ctx, [{
          pedido_id: ctx.pedidoId,
          pedido_item_id: ctx.pedidoItemId,
          comanda_id: ctx.comandaId,
          qty_solicitada: '1.000'
        }], 'item-deletado'), { db }),
        (err) => {
          assert.equal(err.codigo, 'ITEM_PEDIDO_INCOMPATIVEL');
          return true;
        }
      );

      const ok = await CozinhaDespacho.despacharLote(entrada(ctx, [{
        pedido_id: ctx.pedidoId,
        pedido_item_id: item2.lastID,
        comanda_id: ctx.comandaId,
        qty_solicitada: '1.000'
      }], 'item-valido'), { db });
      assert.equal(ok.success, true);
      assert.equal(ok.itens[0].pedido_item_id, item2.lastID);
      await close(db);
    });
  });

  describe('CORREÇÃO 03 — Classificação operacional', () => {
    it('não classifica COMERCIAL como PASTEL; default OUTRO; respeita valor explícito', () => {
      assert.equal(CozinhaDespacho.classificarTipoItem({
        classificacao_operacional_snapshot: 'COMERCIAL',
        produto_nome_snapshot: 'Pastel de Carne'
      }), 'OUTRO');
      assert.equal(CozinhaDespacho.classificarTipoItem({
        classificacao_operacional: 'INSUMO',
        produto_nome_snapshot: 'Refrigerante Coca'
      }), 'OUTRO');
      assert.equal(CozinhaDespacho.classificarTipoItem({
        classificacao_operacional_snapshot: 'PASTEL'
      }), 'PASTEL');
      assert.equal(CozinhaDespacho.classificarTipoItem({
        classificacao_operacional_snapshot: 'BEBIDA'
      }), 'BEBIDA');
      assert.equal(CozinhaDespacho.classificarTipoItem({
        tipo_item: 'OUTRO'
      }), 'OUTRO');
    });

    it('persistência usa OUTRO quando snapshot é COMERCIAL', async () => {
      const db = await open();
      await schemaErp(db);
      const ctx = await seedBase(db);
      const out = await CozinhaDespacho.despacharLote(entrada(ctx, [{
        pedido_id: ctx.pedidoId,
        pedido_item_id: ctx.pedidoItemId,
        comanda_id: ctx.comandaId,
        qty_solicitada: '1.000'
      }], 'tipo-outro'), { db });
      assert.equal(out.itens[0].tipo_item, 'OUTRO');
      const row = await get(db, `SELECT tipo_item FROM cozinha_itens WHERE id=?`, [out.itens[0].id]);
      assert.equal(row.tipo_item, 'OUTRO');
      await close(db);
    });
  });

  describe('CORREÇÃO 06 — PRAGMA foreign_keys', () => {
    it('FK habilitada antes do BEGIN e rejeita referência inválida', async () => {
      const db = await open();
      await schemaErp(db);
      const fk = await get(db, `PRAGMA foreign_keys`);
      assert.equal(Number(fk.foreign_keys), 1);

      const ctx = await seedBase(db);
      // Confirma que a conexão usada pelo serviço mantém FK=ON e bloqueia cruzamento
      await assert.rejects(
        () => run(db, `
          INSERT INTO cozinha_rodadas (
            empresa_id, unidade_id, mesa_id, atendimento_id, numero_rodada, sequencia_global
          ) VALUES (2, ?, 1, 1, 1, 1)
        `, [ctx.unidadeId]),
        (err) => /FOREIGN KEY|constraint/i.test(String(err && err.message))
      );

      // Garante ordem no fonte: PRAGMA antes de BEGIN IMMEDIATE
      const fonte = fs.readFileSync(
        path.join(__dirname, '../../backend/services/cozinha/CozinhaDespachoService.js'),
        'utf8'
      );
      const idxPragma = fonte.indexOf("PRAGMA foreign_keys = ON");
      const idxBegin = fonte.indexOf('await beginImmediate(db)');
      assert.ok(idxPragma > 0 && idxBegin > 0 && idxPragma < idxBegin);

      await close(db);
    });
  });
});
