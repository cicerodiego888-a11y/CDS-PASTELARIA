/**
 * Sprint 06 — Bloco B2: idempotência avançada + integração TX com despacho.
 * Sem worker / print físico / Electron / reenvio / Bloco C.
 *
 *   node --test --test-concurrency=1 tests/cozinha/sprint06-bloco-b2-idempotencia-despacho.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cozinha-s06b2-'));
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
  montarIdempotencyKeyFila,
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
  assert.equal(COZINHA_SCHEMA_VERSION, 4);
  assert.equal(isCozinhaOperacional(), true);
}

async function criarEmpresa(db, cnpj, nome) {
  const r = await run(db, `
    INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
    VALUES (?, ?, ?, 1)
  `, [cnpj, nome, nome]);
  return r.lastID;
}

async function prepararDespacho(db, opts = {}) {
  const empresaId = opts.empresaId || await criarEmpresa(db, opts.cnpj || '11111111000111', 'Emp B2');
  const mesa = await run(db, `
    INSERT INTO mesas (empresa_id, numero, ativo) VALUES (?, ?, 1)
  `, [empresaId, opts.mesaNumero || 5]);
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
    INSERT INTO produtos (nome, tipo_operacional, utiliza_ficha_tecnica)
    VALUES ('Pastel de Carne', 'COMERCIAL', 1)
  `);
  const produtoId = prod.lastID;
  const prodIng = await run(db, `
    INSERT INTO produtos (nome, tipo_operacional) VALUES ('Queijo', 'INSUMO')
  `);

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
        classificacao_operacional_snapshot, produto_nome_snapshot, observacao
      ) VALUES (?, ?, ?, 10, 10, 'COMERCIAL', 'Pastel de Carne', 'sem cebola')
    `, [pedidoId, produtoId, qty]);
    const pedidoItemId = item.lastID;
    if (comIngrediente) {
      await run(db, `
        INSERT INTO pedido_item_ingredientes (
          pedido_id, pedido_item_id, empresa_id, insumo_id,
          insumo_nome_snapshot, quantidade_snapshot, unidade_snapshot,
          classificacao_comercial_snapshot, selecionado, preco_adicional_snapshot
        ) VALUES (?, ?, ?, ?, 'Queijo Extra', 1.000, 'UN', 'ADICIONAL', 1, 2.50)
      `, [pedidoId, pedidoItemId, empresaId, prodIng.lastID]);
    }
    const cmd = await run(db, `
      INSERT INTO cozinha_comandas (
        empresa_id, atendimento_id, numero_comanda, rotulo, pedido_id, operador_lancamento_id
      ) VALUES (?, ?, ?, ?, ?, 1)
    `, [empresaId, atendimentoId, numeroComanda, `C${numeroComanda}`, pedidoId]);
    return { pedidoId, pedidoItemId, comandaId: cmd.lastID };
  }

  const comanda1 = await criarPedidoComItem(1, 2, true);

  return {
    empresaId, mesaId, atendimentoId, unidadeId, produtoId, comanda1, criarPedidoComItem
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

function itemDespacho(c) {
  return {
    pedido_id: c.pedidoId,
    pedido_item_id: c.pedidoItemId,
    comanda_id: c.comandaId,
    qty_solicitada: '2.000'
  };
}

describe('Sprint 06 Bloco B2 — idempotência e despacho', () => {
  beforeEach(() => {
    marcarCozinhaOperacional(false);
  });

  it('1) expedição gera trabalho na fila', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararDespacho(db);
    await EstacaoService.criarEstacao({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId,
      codigo_estacao: 'PASTEL', largura_mm: 80, vias: 1,
      modelo_individual: 0, modelo_agrupado: 1
    });

    const out = await CozinhaDespacho.despacharLote(
      entradaDespacho(ctx, [itemDespacho(ctx.comanda1)], 'b2-1'),
      { db }
    );
    assert.equal(out.success, true);

    const jobs = await all(db, `SELECT * FROM cozinha_impressao_fila`);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].estado, ESTADOS_FILA.PENDENTE);
    assert.equal(jobs[0].rodada_id, out.rodada.id);
    await close(db);
  });

  it('2) trabalho pertence à empresa e unidade corretas', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararDespacho(db);
    await EstacaoService.criarEstacao({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId,
      codigo_estacao: 'PASTEL', largura_mm: 80,
      modelo_individual: 0, modelo_agrupado: 1
    });
    const out = await CozinhaDespacho.despacharLote(
      entradaDespacho(ctx, [itemDespacho(ctx.comanda1)], 'b2-2'),
      { db }
    );
    const job = await get(db, `SELECT * FROM cozinha_impressao_fila WHERE rodada_id = ?`, [out.rodada.id]);
    assert.equal(job.empresa_id, ctx.empresaId);
    assert.equal(job.unidade_id, ctx.unidadeId);
    await close(db);
  });

  it('3) chave determinística em chamadas repetidas', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararDespacho(db);
    const est = await EstacaoService.criarEstacao({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId,
      codigo_estacao: 'PASTEL', largura_mm: 80,
      modelo_individual: 0, modelo_agrupado: 1
    });
    const out = await CozinhaDespacho.despacharLote(
      entradaDespacho(ctx, [itemDespacho(ctx.comanda1)], 'b2-3'),
      { db }
    );
    const esperado = montarIdempotencyKeyFila({
      empresaId: ctx.empresaId,
      unidadeId: ctx.unidadeId,
      rodadaId: out.rodada.id,
      estacaoId: est.estacao.id,
      modelo: 'AGRUPADO',
      escopo: 'all'
    });
    const job = await get(db, `SELECT idempotency_key FROM cozinha_impressao_fila`);
    assert.equal(job.idempotency_key, esperado);
    assert.ok(!/uuid|random|Math\.random/i.test(job.idempotency_key));
    assert.match(job.idempotency_key, /^imp:\d+:\d+:\d+:\d+:AGRUPADO:all$/);

    const again = await FilaService.enfileirarDaRodada({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, rodadaId: out.rodada.id
    }, { db });
    assert.equal(again.jobs[0].idempotency_key, esperado);
    await close(db);
  });

  it('4) replay idêntico não duplica registro', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararDespacho(db);
    await EstacaoService.criarEstacao({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId,
      codigo_estacao: 'PASTEL', largura_mm: 80,
      modelo_individual: 0, modelo_agrupado: 1
    });
    const out = await CozinhaDespacho.despacharLote(
      entradaDespacho(ctx, [itemDespacho(ctx.comanda1)], 'b2-4'),
      { db }
    );
    const before = await get(db, `SELECT COUNT(*) AS n, id FROM cozinha_impressao_fila`);
    const replay = await FilaService.enfileirarDaRodada({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId, rodadaId: out.rodada.id
    }, { db });
    assert.equal(replay.repetida, true);
    assert.equal(replay.jobs[0].id, before.id);
    const after = await get(db, `SELECT COUNT(*) AS n FROM cozinha_impressao_fila`);
    assert.equal(after.n, 1);
    await close(db);
  });

  it('5) mesma chave com snapshot diferente gera conflito', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararDespacho(db);
    const est = await EstacaoService.criarEstacao({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId,
      codigo_estacao: 'PASTEL', largura_mm: 80,
      modelo_individual: 0, modelo_agrupado: 1
    });
    const out = await CozinhaDespacho.despacharLote(
      entradaDespacho(ctx, [itemDespacho(ctx.comanda1)], 'b2-5'),
      { db }
    );
    const key = montarIdempotencyKeyFila({
      empresaId: ctx.empresaId,
      unidadeId: ctx.unidadeId,
      rodadaId: out.rodada.id,
      estacaoId: est.estacao.id,
      modelo: 'AGRUPADO',
      escopo: 'all'
    });
    const snapAntes = await get(db, `SELECT payload_snapshot FROM cozinha_impressao_fila`);
    await assert.rejects(
      () => FilaService.enfileirarJob({
        db,
        empresaId: ctx.empresaId,
        unidadeId: ctx.unidadeId,
        rodadaId: out.rodada.id,
        estacaoImpressaoId: est.estacao.id,
        idempotency_key: key,
        snapshot: {
          itens: [{ tipo_item: 'PASTEL', descricao: 'CONTEUDO-DIVERGENTE', qty: '9.000' }]
        }
      }),
      (err) => err.codigo === 'IMPRESSAO_IDEMPOTENCY_DIVERGENTE'
    );
    const snapDepois = await get(db, `SELECT payload_snapshot, COUNT(*) AS n FROM cozinha_impressao_fila`);
    assert.equal(snapDepois.payload_snapshot, snapAntes.payload_snapshot);
    const n = await get(db, `SELECT COUNT(*) AS n FROM cozinha_impressao_fila`);
    assert.equal(n.n, 1);
    await close(db);
  });

  it('6) expedição repetida não duplica trabalhos', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararDespacho(db);
    await EstacaoService.criarEstacao({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId,
      codigo_estacao: 'PASTEL', largura_mm: 80,
      modelo_individual: 0, modelo_agrupado: 1
    });
    const itens = [itemDespacho(ctx.comanda1)];
    const a = await CozinhaDespacho.despacharLote(entradaDespacho(ctx, itens, 'b2-6-replay'), { db });
    const b = await CozinhaDespacho.despacharLote(entradaDespacho(ctx, itens, 'b2-6-replay'), { db });
    assert.equal(b.repetida, true);
    assert.equal(b.rodada.id, a.rodada.id);
    const n = await get(db, `SELECT COUNT(*) AS n FROM cozinha_impressao_fila`);
    assert.equal(n.n, 1);
    const rods = await get(db, `SELECT COUNT(*) AS n FROM cozinha_rodadas`);
    assert.equal(rods.n, 1);
    await close(db);
  });

  it('7) rollback da expedição remove os trabalhos incluídos', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararDespacho(db);
    await EstacaoService.criarEstacao({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId,
      codigo_estacao: 'PASTEL', largura_mm: 80,
      modelo_individual: 0, modelo_agrupado: 1
    });
    await assert.rejects(
      () => CozinhaDespacho.despacharLote(
        entradaDespacho(ctx, [itemDespacho(ctx.comanda1)], 'b2-7-rb'),
        { db, simularFalhaAposEnfileirarImpressao: true }
      ),
      (err) => err.codigo === 'SIMULAR_FALHA_IMPRESSAO'
    );
    assert.equal((await get(db, `SELECT COUNT(*) AS n FROM cozinha_impressao_fila`)).n, 0);
    assert.equal((await get(db, `SELECT COUNT(*) AS n FROM cozinha_rodadas`)).n, 0);
    assert.equal((await get(db, `SELECT COUNT(*) AS n FROM cozinha_itens`)).n, 0);
    await close(db);
  });

  it('8) falha de persistência respeita a atomicidade', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararDespacho(db);
    await EstacaoService.criarEstacao({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId,
      codigo_estacao: 'PASTEL', largura_mm: 80,
      modelo_individual: 0, modelo_agrupado: 1
    });
    await assert.rejects(
      () => CozinhaDespacho.despacharLote(
        entradaDespacho(ctx, [itemDespacho(ctx.comanda1)], 'b2-8-atom'),
        { db, simularFalhaAposEnfileirarImpressao: true }
      )
    );
    assert.equal((await get(db, `SELECT COUNT(*) AS n FROM cozinha_impressao_fila`)).n, 0);
    assert.equal((await get(db, `SELECT COUNT(*) AS n FROM cozinha_rodadas`)).n, 0);
    await close(db);
  });

  it('9) ausência de estação não bloqueia expedição', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararDespacho(db);
    // Sem estação PASTEL
    const out = await CozinhaDespacho.despacharLote(
      entradaDespacho(ctx, [itemDespacho(ctx.comanda1)], 'b2-9-sem'),
      { db }
    );
    assert.equal(out.success, true);
    assert.ok(out.rodada.id > 0);
    assert.equal((await get(db, `SELECT COUNT(*) AS n FROM cozinha_impressao_fila`)).n, 0);
    const ev = await get(db, `
      SELECT * FROM cozinha_eventos_outbox WHERE tipo = 'IMPRESSAO_SEM_ESTACAO'
    `);
    assert.ok(ev);
    assert.match(ev.payload_json, /PASTEL/);
    await close(db);
  });

  it('10) estação de outra unidade não é utilizada', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararDespacho(db);
    const un2 = await run(db, `
      INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'U-OUTRA', 1)
    `, [ctx.empresaId]);
    await EstacaoService.criarEstacao({
      db, empresaId: ctx.empresaId, unidadeId: un2.lastID,
      codigo_estacao: 'PASTEL', largura_mm: 80,
      modelo_individual: 0, modelo_agrupado: 1
    });
    const out = await CozinhaDespacho.despacharLote(
      entradaDespacho(ctx, [itemDespacho(ctx.comanda1)], 'b2-10-u'),
      { db }
    );
    assert.equal(out.success, true);
    assert.equal((await get(db, `SELECT COUNT(*) AS n FROM cozinha_impressao_fila`)).n, 0);
    await close(db);
  });

  it('11) estação de outra empresa não é utilizada', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararDespacho(db);
    const emp2 = await criarEmpresa(db, '22222222000122', 'Emp2');
    const un2 = await run(db, `
      INSERT INTO cozinha_unidades (empresa_id, codigo, ativo) VALUES (?, 'U-E2', 1)
    `, [emp2]);
    await EstacaoService.criarEstacao({
      db, empresaId: emp2, unidadeId: un2.lastID,
      codigo_estacao: 'PASTEL', largura_mm: 80,
      modelo_individual: 0, modelo_agrupado: 1
    });
    const out = await CozinhaDespacho.despacharLote(
      entradaDespacho(ctx, [itemDespacho(ctx.comanda1)], 'b2-11-e'),
      { db }
    );
    assert.equal(out.success, true);
    assert.equal((await get(db, `SELECT COUNT(*) AS n FROM cozinha_impressao_fila`)).n, 0);
    await close(db);
  });

  it('12) snapshot não contém preço, pagamento ou dados fiscais', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararDespacho(db);
    await EstacaoService.criarEstacao({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId,
      codigo_estacao: 'PASTEL', largura_mm: 80,
      modelo_individual: 0, modelo_agrupado: 1
    });
    await CozinhaDespacho.despacharLote(
      entradaDespacho(ctx, [itemDespacho(ctx.comanda1)], 'b2-12-snap'),
      { db }
    );
    const job = await get(db, `SELECT payload_snapshot FROM cozinha_impressao_fila`);
    assert.ok(job.payload_snapshot);
    assert.ok(!/"preco"/i.test(job.payload_snapshot));
    assert.ok(!/"pagamento"/i.test(job.payload_snapshot));
    assert.ok(!/"ncm"/i.test(job.payload_snapshot));
    assert.ok(!/"valor"/i.test(job.payload_snapshot));
    assert.ok(!/"2\.50"/i.test(job.payload_snapshot), 'preço adicional do ingrediente não deve ir ao snapshot');
    const parsed = JSON.parse(job.payload_snapshot);
    assert.deepEqual(snapshotContemCamposProibidos(parsed), []);
    assert.equal(parsed.itens[0].descricao, 'Pastel de Carne');
    await close(db);
  });

  it('14) mesa_numero no snapshot é mesas.numero, nunca o id interno', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const empresaId = await criarEmpresa(db, '14141414000141', 'Emp MesaNum');
    // Força id interno ≠ número visível (ids 1 e 2 ocupados; mesa alvo = id 3, numero 5).
    await run(db, `INSERT INTO mesas (empresa_id, numero, ativo) VALUES (?, 90, 1)`, [empresaId]);
    await run(db, `INSERT INTO mesas (empresa_id, numero, ativo) VALUES (?, 91, 1)`, [empresaId]);
    const ctx = await prepararDespacho(db, { empresaId, mesaNumero: 5 });
    assert.notEqual(ctx.mesaId, 5, 'pré-condição: id interno deve diferir do número visível');
    assert.equal(
      (await get(db, `SELECT numero FROM mesas WHERE id = ? AND empresa_id = ?`, [ctx.mesaId, empresaId])).numero,
      5
    );

    await EstacaoService.criarEstacao({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId,
      codigo_estacao: 'PASTEL', largura_mm: 80,
      modelo_individual: 0, modelo_agrupado: 1
    });
    await CozinhaDespacho.despacharLote(
      entradaDespacho(ctx, [itemDespacho(ctx.comanda1)], 'b2-14-mesa-numero'),
      { db }
    );

    const job = await get(db, `SELECT payload_snapshot FROM cozinha_impressao_fila`);
    assert.ok(job && job.payload_snapshot);
    const snap = JSON.parse(job.payload_snapshot);
    assert.equal(String(snap.mesa_numero), '5');
    assert.notEqual(String(snap.mesa_numero), String(ctx.mesaId));
    assert.ok(!new RegExp(`"mesa_numero"\\s*:\\s*"${ctx.mesaId}"`).test(job.payload_snapshot));
    await close(db);
  });

  it('13) nenhuma impressão física é executada', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    const ctx = await prepararDespacho(db);
    await EstacaoService.criarEstacao({
      db, empresaId: ctx.empresaId, unidadeId: ctx.unidadeId,
      codigo_estacao: 'PASTEL', largura_mm: 80,
      modelo_individual: 0, modelo_agrupado: 1
    });
    const out = await CozinhaDespacho.despacharLote(
      entradaDespacho(ctx, [itemDespacho(ctx.comanda1)], 'b2-13-nofis'),
      { db }
    );
    assert.equal(out.success, true);
    const job = await get(db, `SELECT estado, worker_id, spooler_job_token FROM cozinha_impressao_fila`);
    assert.equal(job.estado, 'PENDENTE');
    assert.equal(job.worker_id, null);
    assert.equal(job.spooler_job_token, null);

    const filaSrc = fs.readFileSync(
      path.join(__dirname, '..', '..', 'backend', 'services', 'cozinha', 'CozinhaImpressaoFilaService.js'),
      'utf8'
    );
    const despSrc = fs.readFileSync(
      path.join(__dirname, '..', '..', 'backend', 'services', 'cozinha', 'CozinhaDespachoService.js'),
      'utf8'
    );
    for (const src of [filaSrc, despSrc]) {
      assert.ok(!/webContents\.print/.test(src));
      assert.ok(!/impressora_cupom/.test(src));
      assert.ok(!/\/api\/impressao/.test(src));
    }
    await close(db);
  });
});
