/**
 * Sprint 07 · S07-0 — GET /api/cozinha/preparacao/painel
 * Banco temporário / :memory:. Sem banco oficial. Sem impressão física.
 *
 *   CDS_BLOQUEAR_BANCO_OFICIAL=1 CDS_TEST_ISOLATION=1 \
 *   node --test --test-concurrency=1 --test-force-exit tests/cozinha/sprint07-s07-0-painel-kds.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cozinha-s07-0-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'cds-test-jwt-s07-0-painel';
delete process.env.CDS_ALLOW_OFFICIAL_DB;
delete process.env.CDS_COZINHA_IMPRESSAO_FISICA_AUTORIZADA;

const {
  garantirSchemaCozinha,
  marcarCozinhaOperacional,
  isCozinhaOperacional
} = require('../../backend/utils/cozinhaSchema');
const CozinhaDespacho = require('../../backend/services/cozinha/CozinhaDespachoService');
const CozinhaPreparacao = require('../../backend/services/cozinha/CozinhaPreparacaoService');
const CozinhaKdsPainel = require('../../backend/services/cozinha/CozinhaKdsPainelService');
const cozinhaRoutes = require('../../backend/rotas/cozinha');
const { verificarToken } = require('../../backend/middleware/auth');
const { exigirRecurso } = require('../../backend/middleware/validarRecursoImplantacao');
const configService = require('../../backend/services/configuracaoService');

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
  marcarCozinhaOperacional(true);
  assert.equal(isCozinhaOperacional(), true);
}

async function seedUnidade(db, empresaId, codigo, mesaNumero) {
  const mesa = await run(db, `
    INSERT INTO mesas (empresa_id, numero, ativo) VALUES (?, ?, 1)
  `, [empresaId, mesaNumero]);
  const at = await run(db, `
    INSERT INTO mesa_atendimentos (empresa_id, mesa_id, estado)
    VALUES (?, ?, 'OCUPADA')
  `, [empresaId, mesa.lastID]);
  const un = await run(db, `
    INSERT INTO cozinha_unidades (empresa_id, codigo, sequencia_atual, ativo)
    VALUES (?, ?, 0, 1)
  `, [empresaId, codigo]);
  const cat = await run(db, `INSERT INTO categorias (nome) VALUES ('Pastelaria')`);
  const pastel = await run(db, `
    INSERT INTO produtos (
      nome, tipo_operacional, comercializavel, categoria_id,
      utiliza_ficha_tecnica, permite_personalizacao_ingredientes
    ) VALUES ('Pastel Carne', 'COMERCIAL', 0, ?, 1, 0)
  `, [cat.lastID]);
  await run(db, `INSERT INTO ficha_tecnica (produto_id, ativo) VALUES (?, 1)`, [pastel.lastID]);
  return {
    empresaId,
    mesaId: mesa.lastID,
    atendimentoId: at.lastID,
    unidadeId: un.lastID,
    prodPastelId: pastel.lastID
  };
}

async function despacharPastel(db, infra, { observacao = null, chave, numeroComanda } = {}) {
  const ped = await run(db, `
    INSERT INTO pedidos (codigo, status, empresa_id, mesa_id, mesa_atendimento_id, total)
    VALUES (?, 'PEDIDO', ?, ?, ?, 99.90)
  `, [`P-${chave}`, infra.empresaId, infra.mesaId, infra.atendimentoId]);
  const item = await run(db, `
    INSERT INTO pedidos_itens (
      pedido_id, produto_id, quantidade, preco_unitario, subtotal,
      classificacao_operacional_snapshot, produto_nome_snapshot, observacao
    ) VALUES (?, ?, 2, 15.50, 31.00, 'PASTEL', 'Pastel Carne', ?)
  `, [ped.lastID, infra.prodPastelId, observacao]);
  const nCmd = numeroComanda != null
    ? Number(numeroComanda)
    : (Math.abs(String(chave).split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % 9000) + 1;
  const cmd = await run(db, `
    INSERT INTO cozinha_comandas (
      empresa_id, atendimento_id, numero_comanda, pedido_id, operador_lancamento_id
    ) VALUES (?, ?, ?, ?, 1)
  `, [infra.empresaId, infra.atendimentoId, nCmd, ped.lastID]);

  const out = await CozinhaDespacho.despacharLote({
    empresaId: infra.empresaId,
    operadorId: 1,
    idempotencyKey: `despacho-${chave}`,
    unidade_id: infra.unidadeId,
    mesa_id: infra.mesaId,
    atendimento_id: infra.atendimentoId,
    itens: [{
      pedido_id: ped.lastID,
      pedido_item_id: item.lastID,
      comanda_id: cmd.lastID,
      qty_solicitada: 2
    }]
  }, { db });

  return {
    despacho: out,
    pedidoId: ped.lastID,
    pedidoItemId: item.lastID,
    comandaId: cmd.lastID,
    numeroComanda: nCmd
  };
}

function assertSemFinanceiroFiscal(obj) {
  const json = JSON.stringify(obj).toLowerCase();
  for (const proibido of [
    'preco_unitario',
    'subtotal',
    'pagamento',
    'nfce',
    'cfop',
    'csosn',
    'imposto',
    '99.90',
    '15.50',
    '9.99'
  ]) {
    assert.equal(json.includes(proibido), false, `vazou campo: ${proibido}`);
  }
  // "total" de paginação é contagem de rodadas — não valor financeiro.
  assert.equal(typeof obj.total, 'number');
  assert.equal(obj.financeiro, false);
  assert.equal(obj.fiscal, false);
  assert.equal(obj.impressao_fisica, false);
}

describe('Sprint 07 S07-0 — painel KDS (serviço)', () => {
  it('1) lista rodadas da unidade autenticada (FIFO + mesa/comanda/obs)', async () => {
    const db = await open();
    await schemaErp(db);
    const infra = await seedUnidade(db, 1, 'U-A', 12);
    const d1 = await despacharPastel(db, infra, { observacao: 'Sem cebola', chave: 'a1' });
    await despacharPastel(db, infra, { observacao: 'Bem passado', chave: 'a2' });

    const painel = await CozinhaKdsPainel.listarPainelPreparacao({
      empresaId: infra.empresaId,
      unidadeId: infra.unidadeId
    }, { db });

    assert.equal(painel.success, true);
    assert.equal(painel.empresa_id, infra.empresaId);
    assert.equal(painel.unidade_id, infra.unidadeId);
    assert.ok(painel.total >= 2);
    assert.equal(painel.rodadas.length, 2);
    assert.ok(painel.rodadas[0].sequencia_global < painel.rodadas[1].sequencia_global);
    assert.equal(painel.rodadas[0].mesa_numero, '12');
    assert.equal(painel.rodadas[0].atendimento_id, infra.atendimentoId);
    assert.equal(painel.rodadas[0].itens[0].numero_comanda, d1.numeroComanda);
    assert.equal(painel.rodadas[0].itens[0].observacoes_snapshot, 'Sem cebola');
    assert.equal(painel.rodadas[0].itens[0].produto_nome_snapshot, 'Pastel Carne');
    assert.equal(painel.rodadas[0].itens[0].tipo_item, 'PASTEL');
    assert.equal(painel.rodadas[0].itens[0].estado_preparacao, 'AGUARDANDO');
    assert.equal(painel.ordenacao, 'FIFO_SEQUENCIA_GLOBAL');
    assertSemFinanceiroFiscal(painel);
    await close(db);
  });

  it('2+3) isolamento empresa e unidade', async () => {
    const db = await open();
    await schemaErp(db);
    const a = await seedUnidade(db, 1, 'U-1A', 1);
    const bEmp = await seedUnidade(db, 2, 'U-2A', 2);
    const a2 = await seedUnidade(db, 1, 'U-1B', 3);
    await despacharPastel(db, a, { chave: 'iso-a', observacao: 'A' });
    await despacharPastel(db, bEmp, { chave: 'iso-b', observacao: 'B' });
    await despacharPastel(db, a2, { chave: 'iso-a2', observacao: 'A2' });

    const painelA = await CozinhaKdsPainel.listarPainelPreparacao({
      empresaId: a.empresaId,
      unidadeId: a.unidadeId
    }, { db });
    assert.equal(painelA.rodadas.length, 1);
    assert.equal(painelA.rodadas[0].itens[0].observacoes_snapshot, 'A');
    assert.equal(painelA.rodadas[0].unidade_id, a.unidadeId);

    const painelA2 = await CozinhaKdsPainel.listarPainelPreparacao({
      empresaId: a2.empresaId,
      unidadeId: a2.unidadeId
    }, { db });
    assert.equal(painelA2.rodadas.length, 1);
    assert.equal(painelA2.rodadas[0].itens[0].observacoes_snapshot, 'A2');

    const painelB = await CozinhaKdsPainel.listarPainelPreparacao({
      empresaId: bEmp.empresaId,
      unidadeId: bEmp.unidadeId
    }, { db });
    assert.equal(painelB.rodadas.length, 1);
    assert.equal(painelB.rodadas[0].empresa_id, 2);

    await assert.rejects(
      () => CozinhaKdsPainel.listarPainelPreparacao({
        empresaId: a.empresaId,
        unidadeId: bEmp.unidadeId
      }, { db }),
      (err) => err.codigo === 'UNIDADE_NAO_AUTORIZADA'
    );
    await close(db);
  });

  it('4+5+6) filtros AGUARDANDO / EM_PREPARACAO / PRONTO', async () => {
    const db = await open();
    await schemaErp(db);
    const infra = await seedUnidade(db, 1, 'U-F', 5);
    const d1 = await despacharPastel(db, infra, { chave: 'f1', observacao: 'aguardando' });
    const d2 = await despacharPastel(db, infra, { chave: 'f2', observacao: 'prep' });
    const d3 = await despacharPastel(db, infra, { chave: 'f3', observacao: 'pronto' });
    const pedidoId = d3.despacho.itens[0].pedido_id;
    const pedidoAntes = await get(db, `SELECT status, total FROM pedidos WHERE id=?`, [pedidoId]);
    const atendimentoAntes = await get(db, `
      SELECT estado FROM mesa_atendimentos WHERE id=?
    `, [infra.atendimentoId]);
    const filaExiste = await get(db, `
      SELECT name FROM sqlite_master WHERE type='table' AND name='equipamentos_fila'
    `);
    const filaAntes = filaExiste
      ? await get(db, `SELECT COUNT(*) AS n FROM equipamentos_fila`)
      : null;

    const item2 = d2.despacho.itens[0].id;
    const item3 = d3.despacho.itens[0].id;

    await CozinhaPreparacao.iniciarPreparacao({
      empresaId: infra.empresaId,
      operadorId: 1,
      idempotencyKey: 'ini-f2',
      itemId: item2,
      unidade_id: infra.unidadeId
    }, { db });

    await CozinhaPreparacao.iniciarPreparacao({
      empresaId: infra.empresaId,
      operadorId: 1,
      idempotencyKey: 'ini-f3',
      itemId: item3,
      unidade_id: infra.unidadeId
    }, { db });
    await CozinhaPreparacao.marcarItemPronto({
      empresaId: infra.empresaId,
      operadorId: 1,
      idempotencyKey: 'pronto-f3',
      itemId: item3,
      unidade_id: infra.unidadeId
    }, { db });

    const aguardando = await CozinhaKdsPainel.listarPainelPreparacao({
      empresaId: infra.empresaId,
      unidadeId: infra.unidadeId,
      estado_item: 'AGUARDANDO'
    }, { db });
    assert.equal(aguardando.rodadas.length, 1);
    assert.equal(aguardando.rodadas[0].itens[0].estado_preparacao, 'AGUARDANDO');
    assert.equal(aguardando.rodadas[0].itens[0].observacoes_snapshot, 'aguardando');

    const prep = await CozinhaKdsPainel.listarPainelPreparacao({
      empresaId: infra.empresaId,
      unidadeId: infra.unidadeId,
      estado_item: 'EM_PREPARACAO'
    }, { db });
    assert.equal(prep.rodadas.length, 1);
    assert.equal(prep.rodadas[0].itens[0].estado_preparacao, 'EM_PREPARACAO');
    assert.equal(prep.rodadas[0].itens[0].operador_inicio_id, 1);
    assert.ok(prep.rodadas[0].itens[0].iniciado_em);

    const pronto = await CozinhaKdsPainel.listarPainelPreparacao({
      empresaId: infra.empresaId,
      unidadeId: infra.unidadeId,
      estado_item: 'PRONTO'
    }, { db });
    assert.equal(pronto.rodadas.length, 1);
    assert.equal(pronto.rodadas[0].itens[0].estado_preparacao, 'PRONTO');
    assert.equal(pronto.rodadas[0].itens[0].operador_pronto_id, 1);
    assert.ok(pronto.rodadas[0].itens[0].pronto_em);
    assert.ok(d1.despacho.rodada && d1.despacho.rodada.id);

    assert.deepEqual(await get(db, `SELECT status, total FROM pedidos WHERE id=?`, [pedidoId]), pedidoAntes);
    assert.deepEqual(await get(db, `
      SELECT estado FROM mesa_atendimentos WHERE id=?
    `, [infra.atendimentoId]), atendimentoAntes);
    if (filaAntes) {
      const filaDepois = await get(db, `SELECT COUNT(*) AS n FROM equipamentos_fila`);
      assert.equal(filaDepois.n, filaAntes.n);
    }
    await close(db);
  });

  it('9+14) ordenação FIFO + limite/offset', async () => {
    const db = await open();
    await schemaErp(db);
    const infra = await seedUnidade(db, 1, 'U-P', 8);
    for (let i = 0; i < 5; i += 1) {
      await despacharPastel(db, infra, { chave: `p-${i}`, observacao: `ord-${i}` });
    }
    const page1 = await CozinhaKdsPainel.listarPainelPreparacao({
      empresaId: infra.empresaId,
      unidadeId: infra.unidadeId,
      limite: 2,
      offset: 0
    }, { db });
    assert.equal(page1.limite, 2);
    assert.equal(page1.offset, 0);
    assert.equal(page1.total, 5);
    assert.equal(page1.rodadas.length, 2);
    assert.equal(page1.rodadas[0].itens[0].observacoes_snapshot, 'ord-0');
    assert.equal(page1.rodadas[1].itens[0].observacoes_snapshot, 'ord-1');

    const page2 = await CozinhaKdsPainel.listarPainelPreparacao({
      empresaId: infra.empresaId,
      unidadeId: infra.unidadeId,
      limite: 2,
      offset: 2
    }, { db });
    assert.equal(page2.rodadas.length, 2);
    assert.equal(page2.rodadas[0].itens[0].observacoes_snapshot, 'ord-2');
    assert.ok(page1.rodadas[0].sequencia_global < page2.rodadas[0].sequencia_global);

    const capped = await CozinhaKdsPainel.listarPainelPreparacao({
      empresaId: infra.empresaId,
      unidadeId: infra.unidadeId,
      limite: 999
    }, { db });
    assert.equal(capped.limite, 100);
    await close(db);
  });

  it('10) unidade ausente/inválida', async () => {
    const db = await open();
    await schemaErp(db);
    await assert.rejects(
      () => CozinhaKdsPainel.listarPainelPreparacao({ empresaId: 1 }, { db }),
      (err) => err.codigo === 'UNIDADE_OBRIGATORIA'
    );
    await assert.rejects(
      () => CozinhaKdsPainel.listarPainelPreparacao({ empresaId: 1, unidadeId: -1 }, { db }),
      (err) => err.codigo === 'UNIDADE_OBRIGATORIA'
    );
    await close(db);
  });

  it('11) empresa ausente/inválida', async () => {
    const db = await open();
    await schemaErp(db);
    await assert.rejects(
      () => CozinhaKdsPainel.listarPainelPreparacao({ unidadeId: 1 }, { db }),
      (err) => err.codigo === 'EMPRESA_CONTEXT_REQUIRED'
    );
    await close(db);
  });
});

describe('Sprint 07 S07-0 — painel KDS (HTTP)', () => {
  let server;
  let baseUrl;
  let recursoOriginal;
  let dbHttp;
  let empresaId;
  let unidadeId;
  let unidadeOutra;
  let tokenOk;
  let tokenSemUnidade;
  let tokenOutraUnidade;
  let tokenSemEmpresa;
  let itemCozinhaHttpId;
  let rodadaHttpId;
  let pedidoHttpId;

  function requestJson(method, urlPath, { token, headers = {}, empresaHeader, body } = {}) {
    const u = new URL(urlPath, baseUrl);
    const emp = empresaHeader != null ? empresaHeader : empresaId;
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          ...headers,
          ...(body != null ? { 'Content-Type': 'application/json' } : {}),
          ...(emp != null ? { 'X-Empresa-Id': String(emp) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        }
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = raw ? JSON.parse(raw) : null; } catch (_e) { json = { raw }; }
          resolve({ status: res.statusCode, body: json });
        });
      });
      req.on('error', reject);
      req.end(body != null ? JSON.stringify(body) : undefined);
    });
  }

  before(async () => {
    dbHttp = require('../../backend/database');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('DB timeout')), 60000);
      dbHttp.whenReady((err) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      });
    });
    // Aguarda estabilização do init assíncrono do database.js (recriação v0→v3).
    for (let i = 0; i < 80; i += 1) {
      const row = await get(dbHttp, `
        SELECT name FROM sqlite_master WHERE type='table' AND name='cozinha_comandas'
      `);
      if (row && row.name === 'cozinha_comandas') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await garantirSchemaCozinha(dbHttp);
    marcarCozinhaOperacional(true);
    const confirm = await get(dbHttp, `
      SELECT name FROM sqlite_master WHERE type='table' AND name='cozinha_comandas'
    `);
    assert.ok(confirm, 'schema cozinha deve estar pronto antes do seed HTTP');

    recursoOriginal = configService.recursoHabilitado;
    configService.recursoHabilitado = (nome) => {
      if (nome === 'pedidos') return true;
      return recursoOriginal.call(configService, nome);
    };

    await run(dbHttp, `
      INSERT OR IGNORE INTO usuarios (id, username, password_hash, role, perfil, ativo)
      VALUES (70, 'kds_op', 'hash', 'operador', 'USUARIO', 1)
    `);
    await run(dbHttp, `
      INSERT OR IGNORE INTO usuarios (id, username, password_hash, role, perfil, ativo)
      VALUES (71, 'kds_noemp', 'hash', 'operador', 'USUARIO', 1)
    `);

    const emp = await run(dbHttp, `
      INSERT INTO empresas (cnpj, razao_social, nome_fantasia, ativo)
      VALUES ('99887766000155', 'Empresa KDS S07', 'KDS S07', 1)
    `);
    empresaId = emp.lastID;
    await run(dbHttp, `
      INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo)
      VALUES (70, ?, 1)
    `, [empresaId]);

    const mesa = await run(dbHttp, `
      INSERT INTO mesas (empresa_id, numero, ativo) VALUES (?, 21, 1)
    `, [empresaId]);
    const at = await run(dbHttp, `
      INSERT INTO mesa_atendimentos (empresa_id, mesa_id, estado, operador_abertura_id)
      VALUES (?, ?, 'OCUPADA', 70)
    `, [empresaId, mesa.lastID]);
    const un = await run(dbHttp, `
      INSERT INTO cozinha_unidades (empresa_id, codigo, sequencia_atual, ativo)
      VALUES (?, 'KDS-HTTP', 0, 1)
    `, [empresaId]);
    unidadeId = un.lastID;
    const un2 = await run(dbHttp, `
      INSERT INTO cozinha_unidades (empresa_id, codigo, sequencia_atual, ativo)
      VALUES (?, 'KDS-HTTP-B', 0, 1)
    `, [empresaId]);
    unidadeOutra = un2.lastID;

    const cat = await run(dbHttp, `INSERT INTO categorias (nome) VALUES ('KDS-HTTP')`);
    const prod = await run(dbHttp, `
      INSERT INTO produtos (
        nome, tipo_operacional, comercializavel, categoria_id, utiliza_ficha_tecnica, preco_venda
      ) VALUES ('Pastel HTTP', 'COMERCIAL', 0, ?, 1, 0)
    `, [cat.lastID]);
    await run(dbHttp, `INSERT INTO ficha_tecnica (produto_id, ativo) VALUES (?, 1)`, [prod.lastID]);

    const ped = await run(dbHttp, `
      INSERT INTO pedidos (
        codigo, status, empresa_id, mesa_id, mesa_atendimento_id, total, data_pedido
      ) VALUES ('PHTTP', 'PEDIDO', ?, ?, ?, 10, date('now'))
    `, [empresaId, mesa.lastID, at.lastID]);
    pedidoHttpId = ped.lastID;
    const pit = await run(dbHttp, `
      INSERT INTO pedidos_itens (
        pedido_id, produto_id, quantidade, preco_unitario, subtotal,
        classificacao_operacional_snapshot, produto_nome_snapshot
      ) VALUES (?, ?, 1, 9.99, 9.99, 'PASTEL', 'Pastel HTTP')
    `, [ped.lastID, prod.lastID]);
    const cmd = await run(dbHttp, `
      INSERT INTO cozinha_comandas (
        empresa_id, atendimento_id, numero_comanda, pedido_id, operador_lancamento_id
      ) VALUES (?, ?, 3, ?, 70)
    `, [empresaId, at.lastID, ped.lastID]);

    const despachoHttp = await CozinhaDespacho.despacharLote({
      empresaId,
      operadorId: 70,
      idempotencyKey: 'http-s07-0-despacho',
      unidade_id: unidadeId,
      mesa_id: mesa.lastID,
      atendimento_id: at.lastID,
      itens: [{
        pedido_id: ped.lastID,
        pedido_item_id: pit.lastID,
        comanda_id: cmd.lastID,
        qty_solicitada: 1
      }]
    }, { db: dbHttp });
    itemCozinhaHttpId = despachoHttp.itens[0].id;
    rodadaHttpId = despachoHttp.rodada.id;
    await run(dbHttp, `
      UPDATE cozinha_itens
      SET observacoes_snapshot = 'Obs HTTP'
      WHERE id = ? AND empresa_id = ?
    `, [itemCozinhaHttpId, empresaId]);

    tokenOk = jwt.sign(
      { id: 70, role: 'operador', perfil: 'USUARIO', unidade_cozinha_id: unidadeId },
      process.env.JWT_SECRET
    );
    tokenSemUnidade = jwt.sign(
      { id: 70, role: 'operador', perfil: 'USUARIO' },
      process.env.JWT_SECRET
    );
    tokenOutraUnidade = jwt.sign(
      { id: 70, role: 'operador', perfil: 'USUARIO', unidade_cozinha_id: unidadeOutra },
      process.env.JWT_SECRET
    );
    tokenSemEmpresa = jwt.sign(
      { id: 71, role: 'operador', perfil: 'USUARIO', unidade_cozinha_id: unidadeId },
      process.env.JWT_SECRET
    );

    const app = express();
    app.use(express.json());
    app.use('/api/cozinha', verificarToken, exigirRecurso('pedidos'), cozinhaRoutes);
    server = await new Promise((resolve, reject) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
      instance.once('error', reject);
    });
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    if (recursoOriginal) configService.recursoHabilitado = recursoOriginal;
    if (server) await new Promise((r) => server.close(() => r()));
  });

  it('HTTP: lista painel da unidade autenticada', async () => {
    const r = await requestJson('GET', '/api/cozinha/preparacao/painel', { token: tokenOk });
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.equal(r.body.unidade_id, unidadeId);
    assert.equal(r.body.empresa_id, empresaId);
    assert.ok(r.body.rodadas.length >= 1);
    assert.equal(r.body.rodadas[0].itens[0].observacoes_snapshot, 'Obs HTTP');
    assert.equal(r.body.rodadas[0].itens[0].numero_comanda, 3);
    assertSemFinanceiroFiscal(r.body);
  });

  it('HTTP: confirma retirada autenticada, isolada e sem duplicar evento ou impressão', async () => {
    const rota = `/api/cozinha/rodadas/${rodadaHttpId}/retirada`;
    const antesDePronta = await requestJson('POST', rota, {
      token: tokenOk,
      body: { idempotency_key: 'http-retirada-antes-pronta' }
    });
    assert.equal(antesDePronta.status, 409);
    assert.equal(antesDePronta.body.codigo, 'RODADA_NAO_PRONTA');

    const unidadeDivergente = await requestJson('POST', rota, {
      token: tokenOutraUnidade,
      body: { idempotency_key: 'http-retirada-unidade-divergente' }
    });
    assert.equal(unidadeDivergente.status, 409);
    assert.equal(unidadeDivergente.body.codigo, 'UNIDADE_ISOLAMENTO');

    const inicio = await requestJson('POST', `/api/cozinha/itens/${itemCozinhaHttpId}/iniciar`, {
      token: tokenOk,
      body: { idempotency_key: 'http-retirada-inicio' }
    });
    assert.equal(inicio.status, 200);
    const pronto = await requestJson('POST', `/api/cozinha/itens/${itemCozinhaHttpId}/pronto`, {
      token: tokenOk,
      body: { idempotency_key: 'http-retirada-pronto' }
    });
    assert.equal(pronto.status, 200);

    const filaAntes = await get(dbHttp, 'SELECT COUNT(*) AS n FROM cozinha_impressao_fila');
    const [a, b] = await Promise.all([
      requestJson('POST', rota, {
        token: tokenOk,
        body: { idempotency_key: 'http-retirada-concorrente-a' }
      }),
      requestJson('POST', rota, {
        token: tokenOk,
        body: { idempotency_key: 'http-retirada-concorrente-b' }
      })
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.body.success, true);
    assert.equal(b.body.success, true);
    assert.equal([a.body, b.body].filter((r) => !r.repetida).length, 1);
    const repetida = await requestJson('POST', rota, {
      token: tokenOk,
      body: { idempotency_key: 'http-retirada-concorrente-a' }
    });
    assert.equal(repetida.status, 200);
    assert.equal(repetida.body.repetida, true);

    const eventos = await get(dbHttp, `
      SELECT COUNT(*) AS n FROM cozinha_eventos_outbox
      WHERE tipo='RETIRADA_CONFIRMADA'
        AND CAST(json_extract(payload_json, '$.rodada.id') AS INTEGER)=?
    `, [rodadaHttpId]);
    assert.equal(eventos.n, 1);
    const comercial = await get(dbHttp, `
      SELECT p.status, ma.estado AS atendimento_estado
      FROM pedidos p
      JOIN mesa_atendimentos ma ON ma.id=p.mesa_atendimento_id
      WHERE p.id=?
    `, [pedidoHttpId]);
    assert.equal(comercial.status, 'PEDIDO');
    assert.equal(comercial.atendimento_estado, 'OCUPADA');
    const filaDepois = await get(dbHttp, 'SELECT COUNT(*) AS n FROM cozinha_impressao_fila');
    assert.equal(filaDepois.n, filaAntes.n);
  });

  it('HTTP: unidade ausente na sessão', async () => {
    const r = await requestJson('GET', '/api/cozinha/preparacao/painel', { token: tokenSemUnidade });
    assert.equal(r.status, 400);
    assert.equal(r.body.codigo, 'UNIDADE_OBRIGATORIA');
  });

  it('12) HTTP: unidade divergente / não enxerga dados da outra unidade', async () => {
    const rDiv = await requestJson(
      'GET',
      `/api/cozinha/preparacao/painel?unidade_id=${unidadeId}`,
      { token: tokenOutraUnidade }
    );
    assert.equal(rDiv.status, 409);
    assert.equal(rDiv.body.codigo, 'UNIDADE_ISOLAMENTO');

    const rOkOutra = await requestJson('GET', '/api/cozinha/preparacao/painel', {
      token: tokenOutraUnidade
    });
    assert.equal(rOkOutra.status, 200);
    assert.equal(rOkOutra.body.unidade_id, unidadeOutra);
    assert.equal(rOkOutra.body.rodadas.length, 0);
  });

  it('HTTP: empresa_id do cliente divergente recusada', async () => {
    const r = await requestJson(
      'GET',
      '/api/cozinha/preparacao/painel?empresa_id=999999',
      { token: tokenOk }
    );
    assert.equal(r.status, 409);
    assert.equal(r.body.codigo, 'EMPRESA_ISOLAMENTO');
  });

  it('HTTP: operador sem vínculo de empresa', async () => {
    const r = await requestJson('GET', '/api/cozinha/preparacao/painel', {
      token: tokenSemEmpresa,
      empresaHeader: empresaId
    });
    assert.ok(r.status === 400 || r.status === 403 || r.status === 401);
  });

  it('HTTP: filtro estado_item=AGUARDANDO', async () => {
    const r = await requestJson(
      'GET',
      '/api/cozinha/preparacao/painel?estado_item=AGUARDANDO&limite=10',
      { token: tokenOk }
    );
    assert.equal(r.status, 200);
    assert.ok(r.body.rodadas.every((rod) =>
      rod.itens.every((it) => it.estado_preparacao === 'AGUARDANDO')));
  });
});
