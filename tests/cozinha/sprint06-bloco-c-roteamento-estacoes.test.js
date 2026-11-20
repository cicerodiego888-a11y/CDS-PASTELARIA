/**
 * Sprint 06 — Bloco C: roteamento e comportamento das estações.
 * Sem worker / print físico / Electron / reenvio / Bloco D.
 *
 *   node --test --test-concurrency=1 tests/cozinha/sprint06-bloco-c-roteamento-estacoes.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cozinha-s06c-'));
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
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const CozinhaDespacho = require('../../backend/services/cozinha/CozinhaDespachoService');
const EstacaoService = require('../../backend/services/cozinha/CozinhaImpressaoEstacaoService');
const FilaService = require('../../backend/services/cozinha/CozinhaImpressaoFilaService');
const {
  snapshotContemCamposProibidos,
  ESTADOS_FILA
} = require('../../backend/services/cozinha/cozinhaImpressaoContratos');

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

async function schemaErpMinimo(db) {
  await garantirSchemaEmpresasAsync(db);
  await run(db, `
    CREATE TABLE IF NOT EXISTS configuracoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chave VARCHAR(100) UNIQUE NOT NULL,
      valor TEXT, tipo VARCHAR(50), descricao TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
      aberto_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      tipo_operacional TEXT DEFAULT 'COMERCIAL',
      utiliza_ficha_tecnica INTEGER DEFAULT 0
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
      mesa_atendimento_id INTEGER
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
  assert.ok(COZINHA_SCHEMA_VERSION >= 4);
  assert.equal(isCozinhaOperacional(), true);
}

async function criarEmpresa(db, cnpj, nome) {
  const r = await run(db, `
    INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
    VALUES (?, ?, ?, 1)
  `, [cnpj, nome, nome]);
  return r.lastID;
}

async function prepararBase(db, opts = {}) {
  const empresaId = opts.empresaId || await criarEmpresa(db, opts.cnpj || `${Date.now()}000111`, 'Emp C');
  const mesa = await run(db, `
    INSERT INTO mesas (empresa_id, numero, ativo) VALUES (?, ?, 1)
  `, [empresaId, opts.mesaNumero || 7]);
  const mesaId = mesa.lastID;
  const at = await run(db, `
    INSERT INTO mesa_atendimentos (empresa_id, mesa_id, estado, operador_abertura_id)
    VALUES (?, ?, 'OCUPADA', 1)
  `, [empresaId, mesaId]);
  const atendimentoId = at.lastID;
  const un = await run(db, `
    INSERT INTO cozinha_unidades (empresa_id, codigo, ativo, sequencia_atual)
    VALUES (?, ?, 1, 0)
  `, [empresaId, opts.codigoUnidade || `UC-${empresaId}`]);
  const unidadeId = un.lastID;

  const prodPastel = await run(db, `
    INSERT INTO produtos (nome, tipo_operacional, utiliza_ficha_tecnica)
    VALUES ('Pastel', 'COMERCIAL', 1)
  `);
  const prodBebida = await run(db, `
    INSERT INTO produtos (nome, tipo_operacional) VALUES ('Refri', 'COMERCIAL')
  `);
  const prodOutro = await run(db, `
    INSERT INTO produtos (nome, tipo_operacional) VALUES ('Talher', 'COMERCIAL')
  `);

  async function criarItem(numeroComanda, tipo, nome, qty = 1) {
    const prodId = tipo === 'PASTEL' ? prodPastel.lastID
      : (tipo === 'BEBIDA' ? prodBebida.lastID : prodOutro.lastID);
    const ped = await run(db, `
      INSERT INTO pedidos (
        codigo, data_pedido, total, status, empresa_id, mesa_id, mesa_atendimento_id
      ) VALUES (?, '2026-01-01', 10, 'PEDIDO', ?, ?, ?)
    `, [`PC-${empresaId}-${numeroComanda}-${Math.random()}`, empresaId, mesaId, atendimentoId]);
    const item = await run(db, `
      INSERT INTO pedidos_itens (
        pedido_id, produto_id, quantidade, preco_unitario, subtotal,
        classificacao_operacional_snapshot, produto_nome_snapshot, observacao
      ) VALUES (?, ?, ?, 9.90, 9.90, ?, ?, 'obs')
    `, [ped.lastID, prodId, qty, tipo, nome]);
    const cmd = await run(db, `
      INSERT INTO cozinha_comandas (
        empresa_id, atendimento_id, numero_comanda, rotulo, pedido_id, operador_lancamento_id
      ) VALUES (?, ?, ?, ?, ?, 1)
    `, [empresaId, atendimentoId, numeroComanda, `C${numeroComanda}`, ped.lastID]);
    return {
      pedidoId: ped.lastID,
      pedidoItemId: item.lastID,
      comandaId: cmd.lastID,
      tipo,
      qty
    };
  }

  return { empresaId, mesaId, atendimentoId, unidadeId, criarItem };
}

function entrada(ctx, itens, chave) {
  return {
    empresaId: ctx.empresaId,
    operadorId: 7,
    idempotencyKey: chave,
    unidade_id: ctx.unidadeId,
    mesa_id: ctx.mesaId,
    atendimento_id: ctx.atendimentoId,
    itens: itens.map((c) => ({
      pedido_id: c.pedidoId,
      pedido_item_id: c.pedidoItemId,
      comanda_id: c.comandaId,
      qty_solicitada: Number(c.qty || 1).toFixed(3)
    }))
  };
}

async function criarEstacao(db, ctx, codigo, flags = {}) {
  return EstacaoService.criarEstacao({
    db,
    empresaId: ctx.empresaId,
    unidadeId: ctx.unidadeId,
    codigo_estacao: codigo,
    largura_mm: 80,
    vias: flags.vias != null ? flags.vias : 1,
    modelo_individual: flags.modelo_individual != null ? flags.modelo_individual : 0,
    modelo_agrupado: flags.modelo_agrupado != null ? flags.modelo_agrupado : 1,
    ativo: flags.ativo != null ? flags.ativo : 1
  });
}

describe('Sprint 06 Bloco C — roteamento e estações', () => {
  beforeEach(() => marcarCozinhaOperacional(false));

  it('1) roteamento PASTEL → estação PASTEL', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    const est = await criarEstacao(db, ctx, 'PASTEL', { modelo_agrupado: 1, modelo_individual: 0 });
    const item = await ctx.criarItem(1, 'PASTEL', 'Pastel Carne');
    const out = await CozinhaDespacho.despacharLote(entrada(ctx, [item], 'c-1'), { db });
    const job = await get(db, `SELECT * FROM cozinha_impressao_fila WHERE rodada_id=?`, [out.rodada.id]);
    assert.equal(job.estacao_impressao_id, est.estacao.id);
    await close(db);
  });

  it('2) roteamento BEBIDA → estação BEBIDA', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    const est = await criarEstacao(db, ctx, 'BEBIDA', { modelo_agrupado: 1, modelo_individual: 0 });
    const item = await ctx.criarItem(1, 'BEBIDA', 'Refri');
    const out = await CozinhaDespacho.despacharLote(entrada(ctx, [item], 'c-2'), { db });
    const job = await get(db, `SELECT * FROM cozinha_impressao_fila WHERE rodada_id=?`, [out.rodada.id]);
    assert.equal(job.estacao_impressao_id, est.estacao.id);
    await close(db);
  });

  it('3) roteamento OUTRO → estação OUTRO', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    const est = await criarEstacao(db, ctx, 'OUTRO', { modelo_agrupado: 1, modelo_individual: 0 });
    const item = await ctx.criarItem(1, 'OUTRO', 'Talher');
    const out = await CozinhaDespacho.despacharLote(entrada(ctx, [item], 'c-3'), { db });
    const job = await get(db, `SELECT * FROM cozinha_impressao_fila WHERE rodada_id=?`, [out.rodada.id]);
    assert.equal(job.estacao_impressao_id, est.estacao.id);
    await close(db);
  });

  it('4) INDIVIDUAL gera um job por comanda', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await criarEstacao(db, ctx, 'PASTEL', { modelo_individual: 1, modelo_agrupado: 0 });
    const a = await ctx.criarItem(1, 'PASTEL', 'P1');
    const b = await ctx.criarItem(2, 'PASTEL', 'P2');
    const c = await ctx.criarItem(3, 'PASTEL', 'P3');
    const out = await CozinhaDespacho.despacharLote(entrada(ctx, [a, b, c], 'c-4'), { db });
    const jobs = await all(db, `
      SELECT * FROM cozinha_impressao_fila WHERE rodada_id=? AND modelo='INDIVIDUAL' ORDER BY id
    `, [out.rodada.id]);
    assert.equal(jobs.length, 3);
    await close(db);
  });

  it('5) INDIVIDUAL não mistura itens de comandas diferentes', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await criarEstacao(db, ctx, 'PASTEL', { modelo_individual: 1, modelo_agrupado: 0 });
    const a = await ctx.criarItem(1, 'PASTEL', 'P1');
    const b = await ctx.criarItem(2, 'PASTEL', 'P2');
    const out = await CozinhaDespacho.despacharLote(entrada(ctx, [a, b], 'c-5'), { db });
    const jobs = await all(db, `
      SELECT payload_snapshot, idempotency_key FROM cozinha_impressao_fila
      WHERE rodada_id=? AND modelo='INDIVIDUAL'
    `, [out.rodada.id]);
    assert.equal(jobs.length, 2);
    for (const j of jobs) {
      const snap = JSON.parse(j.payload_snapshot);
      const comandas = new Set(snap.itens.map((i) => i.comanda_id));
      assert.equal(comandas.size, 1);
      assert.match(j.idempotency_key, /:INDIVIDUAL:comanda:\d+$/);
    }
    await close(db);
  });

  it('6) AGRUPADO gera um job por estação e rodada', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await criarEstacao(db, ctx, 'PASTEL', { modelo_agrupado: 1, modelo_individual: 0 });
    const a = await ctx.criarItem(1, 'PASTEL', 'P1');
    const b = await ctx.criarItem(2, 'PASTEL', 'P2');
    const out = await CozinhaDespacho.despacharLote(entrada(ctx, [a, b], 'c-6'), { db });
    const jobs = await all(db, `
      SELECT * FROM cozinha_impressao_fila WHERE rodada_id=? AND modelo='AGRUPADO'
    `, [out.rodada.id]);
    assert.equal(jobs.length, 1);
    assert.match(jobs[0].idempotency_key, /:AGRUPADO:all$/);
    await close(db);
  });

  it('7) AGRUPADO reúne itens de comandas diferentes', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await criarEstacao(db, ctx, 'PASTEL', { modelo_agrupado: 1, modelo_individual: 0 });
    const a = await ctx.criarItem(1, 'PASTEL', 'P1');
    const b = await ctx.criarItem(2, 'PASTEL', 'P2');
    const out = await CozinhaDespacho.despacharLote(entrada(ctx, [a, b], 'c-7'), { db });
    const job = await get(db, `SELECT payload_snapshot FROM cozinha_impressao_fila WHERE rodada_id=?`, [out.rodada.id]);
    const snap = JSON.parse(job.payload_snapshot);
    assert.equal(snap.itens.length, 2);
    assert.deepEqual(
      [...new Set(snap.itens.map((i) => i.comanda_id))].sort(),
      [a.comandaId, b.comandaId].sort()
    );
    await close(db);
  });

  it('8) INDIVIDUAL desabilitado impede job nesse modelo', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await criarEstacao(db, ctx, 'PASTEL', { modelo_individual: 0, modelo_agrupado: 1 });
    const a = await ctx.criarItem(1, 'PASTEL', 'P1');
    const b = await ctx.criarItem(2, 'PASTEL', 'P2');
    const out = await CozinhaDespacho.despacharLote(entrada(ctx, [a, b], 'c-8'), { db });
    const ind = await get(db, `
      SELECT COUNT(*) AS n FROM cozinha_impressao_fila WHERE rodada_id=? AND modelo='INDIVIDUAL'
    `, [out.rodada.id]);
    assert.equal(ind.n, 0);
    const agr = await get(db, `
      SELECT COUNT(*) AS n FROM cozinha_impressao_fila WHERE rodada_id=? AND modelo='AGRUPADO'
    `, [out.rodada.id]);
    assert.equal(agr.n, 1);
    await close(db);
  });

  it('9) AGRUPADO desabilitado impede job nesse modelo', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await criarEstacao(db, ctx, 'PASTEL', { modelo_individual: 1, modelo_agrupado: 0 });
    const a = await ctx.criarItem(1, 'PASTEL', 'P1');
    const out = await CozinhaDespacho.despacharLote(entrada(ctx, [a], 'c-9'), { db });
    assert.equal((await get(db, `
      SELECT COUNT(*) AS n FROM cozinha_impressao_fila WHERE rodada_id=? AND modelo='AGRUPADO'
    `, [out.rodada.id])).n, 0);
    assert.equal((await get(db, `
      SELECT COUNT(*) AS n FROM cozinha_impressao_fila WHERE rodada_id=? AND modelo='INDIVIDUAL'
    `, [out.rodada.id])).n, 1);
    await close(db);
  });

  it('10) estação com duas vias persiste vias=2', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await criarEstacao(db, ctx, 'PASTEL', { vias: 2, modelo_agrupado: 1, modelo_individual: 0 });
    const a = await ctx.criarItem(1, 'PASTEL', 'P1');
    await CozinhaDespacho.despacharLote(entrada(ctx, [a], 'c-10'), { db });
    assert.equal((await get(db, `SELECT vias FROM cozinha_impressao_fila`)).vias, 2);
    assert.equal((await get(db, `SELECT COUNT(*) AS n FROM cozinha_impressao_fila`)).n, 1);
    await close(db);
  });

  it('11) estação com três vias persiste vias=3', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await criarEstacao(db, ctx, 'PASTEL', { vias: 3, modelo_agrupado: 1, modelo_individual: 0 });
    const a = await ctx.criarItem(1, 'PASTEL', 'P1');
    await CozinhaDespacho.despacharLote(entrada(ctx, [a], 'c-11'), { db });
    assert.equal((await get(db, `SELECT vias FROM cozinha_impressao_fila`)).vias, 3);
    assert.equal((await get(db, `SELECT COUNT(*) AS n FROM cozinha_impressao_fila`)).n, 1);
    await close(db);
  });

  it('12) estação de outra unidade nunca é utilizada', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    const un2 = await run(db, `
      INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'U-X', 1)
    `, [ctx.empresaId]);
    await EstacaoService.criarEstacao({
      db, empresaId: ctx.empresaId, unidadeId: un2.lastID,
      codigo_estacao: 'PASTEL', largura_mm: 80,
      modelo_agrupado: 1, modelo_individual: 0
    });
    const a = await ctx.criarItem(1, 'PASTEL', 'P1');
    const out = await CozinhaDespacho.despacharLote(entrada(ctx, [a], 'c-12'), { db });
    assert.equal(out.success, true);
    assert.equal((await get(db, `SELECT COUNT(*) AS n FROM cozinha_impressao_fila`)).n, 0);
    await close(db);
  });

  it('13) estação de outra empresa nunca é utilizada', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    const emp2 = await criarEmpresa(db, '99999999000199', 'Outra');
    const un2 = await run(db, `
      INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'UE2', 1)
    `, [emp2]);
    await EstacaoService.criarEstacao({
      db, empresaId: emp2, unidadeId: un2.lastID,
      codigo_estacao: 'PASTEL', largura_mm: 80,
      modelo_agrupado: 1, modelo_individual: 0
    });
    const a = await ctx.criarItem(1, 'PASTEL', 'P1');
    const out = await CozinhaDespacho.despacharLote(entrada(ctx, [a], 'c-13'), { db });
    assert.equal(out.success, true);
    assert.equal((await get(db, `SELECT COUNT(*) AS n FROM cozinha_impressao_fila`)).n, 0);
    await close(db);
  });

  it('14) ausência de estação não bloqueia expedição', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    const a = await ctx.criarItem(1, 'PASTEL', 'P1');
    const out = await CozinhaDespacho.despacharLote(entrada(ctx, [a], 'c-14'), { db });
    assert.equal(out.success, true);
    assert.ok(out.rodada.id > 0);
    assert.equal((await get(db, `SELECT COUNT(*) AS n FROM cozinha_impressao_fila`)).n, 0);
    assert.ok(await get(db, `SELECT id FROM cozinha_eventos_outbox WHERE tipo='IMPRESSAO_SEM_ESTACAO'`));
    await close(db);
  });

  it('15) ausência de modelo elegível não bloqueia expedição', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await criarEstacao(db, ctx, 'PASTEL', { modelo_individual: 0, modelo_agrupado: 0 });
    const a = await ctx.criarItem(1, 'PASTEL', 'P1');
    const out = await CozinhaDespacho.despacharLote(entrada(ctx, [a], 'c-15'), { db });
    assert.equal(out.success, true);
    assert.equal((await get(db, `SELECT COUNT(*) AS n FROM cozinha_impressao_fila`)).n, 0);
    assert.ok(await get(db, `
      SELECT id FROM cozinha_eventos_outbox WHERE tipo='IMPRESSAO_SEM_MODELO_ELEGIVEL'
    `));
    await close(db);
  });

  it('16) replay idêntico não duplica jobs INDIVIDUAIS', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await criarEstacao(db, ctx, 'PASTEL', { modelo_individual: 1, modelo_agrupado: 0 });
    const a = await ctx.criarItem(1, 'PASTEL', 'P1');
    const b = await ctx.criarItem(2, 'PASTEL', 'P2');
    const itens = [a, b];
    const out = await CozinhaDespacho.despacharLote(entrada(ctx, itens, 'c-16'), { db });
    const before = await get(db, `SELECT COUNT(*) AS n FROM cozinha_impressao_fila`);
    const replay = await FilaService.enfileirarDaRodada({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, rodadaId: out.rodada.id
    }, { db });
    assert.equal(replay.repetida, true);
    assert.equal((await get(db, `SELECT COUNT(*) AS n FROM cozinha_impressao_fila`)).n, before.n);
    await close(db);
  });

  it('17) replay idêntico não duplica jobs AGRUPADOS', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await criarEstacao(db, ctx, 'PASTEL', { modelo_agrupado: 1, modelo_individual: 0 });
    const a = await ctx.criarItem(1, 'PASTEL', 'P1');
    const out = await CozinhaDespacho.despacharLote(entrada(ctx, [a], 'c-17'), { db });
    await FilaService.enfileirarDaRodada({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, rodadaId: out.rodada.id
    }, { db });
    assert.equal((await get(db, `SELECT COUNT(*) AS n FROM cozinha_impressao_fila`)).n, 1);
    await close(db);
  });

  it('18) snapshot INDIVIDUAL contém somente itens da comanda', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await criarEstacao(db, ctx, 'PASTEL', { modelo_individual: 1, modelo_agrupado: 0 });
    const a = await ctx.criarItem(1, 'PASTEL', 'SoA');
    const b = await ctx.criarItem(2, 'PASTEL', 'SoB');
    const out = await CozinhaDespacho.despacharLote(entrada(ctx, [a, b], 'c-18'), { db });
    const jobs = await all(db, `
      SELECT payload_snapshot FROM cozinha_impressao_fila WHERE rodada_id=? AND modelo='INDIVIDUAL'
    `, [out.rodada.id]);
    for (const j of jobs) {
      const snap = JSON.parse(j.payload_snapshot);
      assert.equal(snap.itens.length, 1);
      assert.equal(new Set(snap.itens.map((i) => i.comanda_id)).size, 1);
    }
    await close(db);
  });

  it('19) snapshot AGRUPADO contém todos os itens da estação', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await criarEstacao(db, ctx, 'PASTEL', { modelo_agrupado: 1, modelo_individual: 0 });
    const a = await ctx.criarItem(1, 'PASTEL', 'A');
    const b = await ctx.criarItem(2, 'PASTEL', 'B');
    const out = await CozinhaDespacho.despacharLote(entrada(ctx, [a, b], 'c-19'), { db });
    const snap = JSON.parse((await get(db, `
      SELECT payload_snapshot FROM cozinha_impressao_fila WHERE rodada_id=?
    `, [out.rodada.id])).payload_snapshot);
    assert.equal(snap.itens.length, 2);
    await close(db);
  });

  it('20) snapshot sem preço/pagamento/fiscal', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await criarEstacao(db, ctx, 'PASTEL', { modelo_agrupado: 1, modelo_individual: 0 });
    const a = await ctx.criarItem(1, 'PASTEL', 'P');
    await CozinhaDespacho.despacharLote(entrada(ctx, [a], 'c-20'), { db });
    const raw = (await get(db, `SELECT payload_snapshot FROM cozinha_impressao_fila`)).payload_snapshot;
    assert.ok(!/"preco"/i.test(raw));
    assert.ok(!/"pagamento"/i.test(raw));
    assert.ok(!/"ncm"/i.test(raw));
    assert.deepEqual(snapshotContemCamposProibidos(JSON.parse(raw)), []);
    await close(db);
  });

  it('21) número visível da mesa continua correto', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const empresaId = await criarEmpresa(db, '55555555000155', 'MesaVis');
    await run(db, `INSERT INTO mesas (empresa_id, numero, ativo) VALUES (?, 90, 1)`, [empresaId]);
    await run(db, `INSERT INTO mesas (empresa_id, numero, ativo) VALUES (?, 91, 1)`, [empresaId]);
    const ctx = await prepararBase(db, { empresaId, mesaNumero: 12 });
    assert.notEqual(ctx.mesaId, 12);
    await criarEstacao(db, ctx, 'PASTEL', { modelo_agrupado: 1, modelo_individual: 0 });
    const a = await ctx.criarItem(1, 'PASTEL', 'P');
    await CozinhaDespacho.despacharLote(entrada(ctx, [a], 'c-21'), { db });
    const snap = JSON.parse((await get(db, `SELECT payload_snapshot FROM cozinha_impressao_fila`)).payload_snapshot);
    assert.equal(String(snap.mesa_numero), '12');
    assert.notEqual(String(snap.mesa_numero), String(ctx.mesaId));
    await close(db);
  });

  it('22) nenhuma impressão física é executada', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await criarEstacao(db, ctx, 'PASTEL', { modelo_agrupado: 1, modelo_individual: 0 });
    const a = await ctx.criarItem(1, 'PASTEL', 'P');
    await CozinhaDespacho.despacharLote(entrada(ctx, [a], 'c-22'), { db });
    const job = await get(db, `SELECT estado, worker_id, spooler_job_token FROM cozinha_impressao_fila`);
    assert.equal(job.estado, ESTADOS_FILA.PENDENTE);
    assert.equal(job.worker_id, null);
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'backend', 'services', 'cozinha', 'CozinhaImpressaoFilaService.js'),
      'utf8'
    );
    assert.ok(!/webContents\.print/.test(src));
    assert.ok(!/impressora_cupom/.test(src));
    await close(db);
  });

  it('23) roteamento não altera estado de preparação', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await criarEstacao(db, ctx, 'PASTEL', { modelo_agrupado: 1, modelo_individual: 0 });
    const a = await ctx.criarItem(1, 'PASTEL', 'P');
    const out = await CozinhaDespacho.despacharLote(entrada(ctx, [a], 'c-23'), { db });
    assert.equal(out.rodada.estado_preparacao, 'AGUARDANDO');
    const item = await get(db, `SELECT estado_preparacao FROM cozinha_itens WHERE rodada_id=?`, [out.rodada.id]);
    assert.equal(item.estado_preparacao, 'AGUARDANDO');
    await close(db);
  });

  it('24) rollback da expedição remove os jobs criados', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await criarEstacao(db, ctx, 'PASTEL', { modelo_agrupado: 1, modelo_individual: 0 });
    const a = await ctx.criarItem(1, 'PASTEL', 'P');
    await assert.rejects(
      () => CozinhaDespacho.despacharLote(
        entrada(ctx, [a], 'c-24'),
        { db, simularFalhaAposEnfileirarImpressao: true }
      )
    );
    assert.equal((await get(db, `SELECT COUNT(*) AS n FROM cozinha_impressao_fila`)).n, 0);
    assert.equal((await get(db, `SELECT COUNT(*) AS n FROM cozinha_rodadas`)).n, 0);
    await close(db);
  });
});

describe('Sprint 06 Bloco C — correção anti-duplicidade / modelo ambíguo', () => {
  beforeEach(() => marcarCozinhaOperacional(false));

  it('25) somente INDIVIDUAL habilitado gera jobs individuais', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await criarEstacao(db, ctx, 'PASTEL', { modelo_individual: 1, modelo_agrupado: 0 });
    const a = await ctx.criarItem(1, 'PASTEL', 'A');
    const b = await ctx.criarItem(2, 'PASTEL', 'B');
    const out = await CozinhaDespacho.despacharLote(entrada(ctx, [a, b], 'c-25'), { db });
    const jobs = await all(db, `SELECT modelo FROM cozinha_impressao_fila WHERE rodada_id=?`, [out.rodada.id]);
    assert.equal(jobs.length, 2);
    assert.ok(jobs.every((j) => j.modelo === 'INDIVIDUAL'));
    await close(db);
  });

  it('26) somente AGRUPADO habilitado gera job agrupado', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await criarEstacao(db, ctx, 'PASTEL', { modelo_individual: 0, modelo_agrupado: 1 });
    const a = await ctx.criarItem(1, 'PASTEL', 'A');
    const b = await ctx.criarItem(2, 'PASTEL', 'B');
    const out = await CozinhaDespacho.despacharLote(entrada(ctx, [a, b], 'c-26'), { db });
    const jobs = await all(db, `SELECT modelo FROM cozinha_impressao_fila WHERE rodada_id=?`, [out.rodada.id]);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].modelo, 'AGRUPADO');
    await close(db);
  });

  it('27) ambos habilitados: nenhum job + IMPRESSAO_CONFIG_MODELO_AMBIGUO', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await criarEstacao(db, ctx, 'PASTEL', { modelo_individual: 1, modelo_agrupado: 1 });
    const a = await ctx.criarItem(1, 'PASTEL', 'A');
    const b = await ctx.criarItem(2, 'PASTEL', 'B');
    const out = await CozinhaDespacho.despacharLote(entrada(ctx, [a, b], 'c-27'), { db });
    assert.equal(out.success, true);
    assert.ok(out.rodada.id > 0);
    assert.equal((await get(db, `SELECT COUNT(*) AS n FROM cozinha_impressao_fila`)).n, 0);
    const ev = await get(db, `
      SELECT tipo, payload_json FROM cozinha_eventos_outbox
      WHERE tipo = 'IMPRESSAO_CONFIG_MODELO_AMBIGUO'
    `);
    assert.ok(ev);
    assert.match(ev.payload_json, /AMBIGUO|ambiguo|simultaneamente/i);
    await close(db);
  });

  it('28) nenhum modelo habilitado: SEM_MODELO_ELEGIVEL e despacho segue', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await criarEstacao(db, ctx, 'PASTEL', { modelo_individual: 0, modelo_agrupado: 0 });
    const a = await ctx.criarItem(1, 'PASTEL', 'A');
    const out = await CozinhaDespacho.despacharLote(entrada(ctx, [a], 'c-28'), { db });
    assert.equal(out.success, true);
    assert.equal((await get(db, `SELECT COUNT(*) AS n FROM cozinha_impressao_fila`)).n, 0);
    assert.ok(await get(db, `
      SELECT id FROM cozinha_eventos_outbox WHERE tipo='IMPRESSAO_SEM_MODELO_ELEGIVEL'
    `));
    await close(db);
  });

  it('29) repetição de despacho não duplica jobs', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await criarEstacao(db, ctx, 'PASTEL', { modelo_individual: 0, modelo_agrupado: 1 });
    const a = await ctx.criarItem(1, 'PASTEL', 'A');
    const itens = [a];
    const r1 = await CozinhaDespacho.despacharLote(entrada(ctx, itens, 'c-29-rep'), { db });
    const r2 = await CozinhaDespacho.despacharLote(entrada(ctx, itens, 'c-29-rep'), { db });
    assert.equal(r2.repetida, true);
    assert.equal(r2.rodada.id, r1.rodada.id);
    assert.equal((await get(db, `SELECT COUNT(*) AS n FROM cozinha_impressao_fila`)).n, 1);
    await close(db);
  });

  it('30) repetição de comanda (enfileirarDaRodada) não duplica job individual', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await criarEstacao(db, ctx, 'PASTEL', { modelo_individual: 1, modelo_agrupado: 0 });
    const a = await ctx.criarItem(1, 'PASTEL', 'A');
    const out = await CozinhaDespacho.despacharLote(entrada(ctx, [a], 'c-30'), { db });
    const before = await all(db, `SELECT id, idempotency_key FROM cozinha_impressao_fila`);
    assert.equal(before.length, 1);
    const replay = await FilaService.enfileirarDaRodada({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, rodadaId: out.rodada.id
    }, { db });
    assert.equal(replay.repetida, true);
    assert.equal(replay.jobs[0].id, before[0].id);
    assert.equal((await get(db, `SELECT COUNT(*) AS n FROM cozinha_impressao_fila`)).n, 1);
    await close(db);
  });

  it('31) reprocessamento preserva jobs existentes (sem sobrescrever)', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await criarEstacao(db, ctx, 'PASTEL', { modelo_individual: 0, modelo_agrupado: 1 });
    const a = await ctx.criarItem(1, 'PASTEL', 'A');
    const out = await CozinhaDespacho.despacharLote(entrada(ctx, [a], 'c-31'), { db });
    const original = await get(db, `SELECT id, payload_snapshot, idempotency_key FROM cozinha_impressao_fila`);
    await FilaService.enfileirarDaRodada({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, rodadaId: out.rodada.id
    }, { db });
    const after = await get(db, `SELECT id, payload_snapshot, idempotency_key FROM cozinha_impressao_fila`);
    assert.equal(after.id, original.id);
    assert.equal(after.payload_snapshot, original.payload_snapshot);
    assert.equal(after.idempotency_key, original.idempotency_key);
    assert.equal((await get(db, `SELECT COUNT(*) AS n FROM cozinha_impressao_fila`)).n, 1);
    await close(db);
  });

  it('32) recuperação/reprocessamento: mesma chave + conteúdo igual não cria segundo registro', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await criarEstacao(db, ctx, 'PASTEL', { modelo_individual: 1, modelo_agrupado: 0 });
    const a = await ctx.criarItem(1, 'PASTEL', 'A');
    const b = await ctx.criarItem(2, 'PASTEL', 'B');
    const out = await CozinhaDespacho.despacharLote(entrada(ctx, [a, b], 'c-32'), { db });
    const n1 = (await get(db, `SELECT COUNT(*) AS n FROM cozinha_impressao_fila`)).n;
    assert.equal(n1, 2);
    await FilaService.enfileirarDaRodada({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, rodadaId: out.rodada.id
    }, { db });
    assert.equal((await get(db, `SELECT COUNT(*) AS n FROM cozinha_impressao_fila`)).n, 2);
    await close(db);
  });

  it('33) despacho continua com configuração ambígua', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    await criarEstacao(db, ctx, 'PASTEL', { modelo_individual: 1, modelo_agrupado: 1 });
    const a = await ctx.criarItem(1, 'PASTEL', 'A');
    const out = await CozinhaDespacho.despacharLote(entrada(ctx, [a], 'c-33'), { db });
    assert.equal(out.success, true);
    assert.equal(out.rodada.estado_preparacao, 'AGUARDANDO');
    assert.equal((await get(db, `SELECT estado_preparacao FROM cozinha_itens`)).estado_preparacao, 'AGUARDANDO');
    assert.equal((await get(db, `SELECT COUNT(*) AS n FROM cozinha_impressao_fila`)).n, 0);
    await close(db);
  });

  it('34) isolamento: ambiguidade/estação de outra unidade não vaza jobs', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararBase(db);
    const un2 = await run(db, `
      INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'U-AMB', 1)
    `, [ctx.empresaId]);
    await EstacaoService.criarEstacao({
      db, empresaId: ctx.empresaId, unidadeId: un2.lastID,
      codigo_estacao: 'PASTEL', largura_mm: 80,
      modelo_individual: 1, modelo_agrupado: 1
    });
    await criarEstacao(db, ctx, 'PASTEL', { modelo_individual: 0, modelo_agrupado: 1 });
    const a = await ctx.criarItem(1, 'PASTEL', 'A');
    const out = await CozinhaDespacho.despacharLote(entrada(ctx, [a], 'c-34'), { db });
    const jobs = await all(db, `SELECT unidade_id FROM cozinha_impressao_fila WHERE rodada_id=?`, [out.rodada.id]);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].unidade_id, ctx.unidadeId);
    assert.ok(!jobs.some((j) => j.unidade_id === un2.lastID));
    await close(db);
  });
});
