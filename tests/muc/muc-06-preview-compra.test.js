/**
 * MUC-06 — Preview e pré-fill da compra via MUC.
 * Executar: node --test tests/muc/muc-06-preview-compra.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const { obterMuc } = require('../../backend/motores/muc/public');
const { simularConversaoCompraPreview } = require('../../backend/services/compras/simularConversaoCompraPreview');
const ProdutoConversaoConfigService = require('../../backend/services/produtos/ProdutoConversaoConfigService');
const { garantirSchemaProdutoConversaoAsync } = require('../../backend/services/produtos/produtoConversaoSchema');
const { garantirSchemaMuc } = require('../../backend/motores/muc/schema/mucSchema');

const AP_CAIXA = Object.freeze([
  { tipo: 'CX', quantidade: 12, unidade: 'UN', ativa: 1, compra: 1 }
]);
const AP_FARDO = Object.freeze([
  { tipo: 'FD', quantidade: 12, unidade: 'UN', ativa: 1, compra: 1 }
]);
const REL_UN_ML_2000 = Object.freeze([{ unidade_origem: 'UN', unidade_destino: 'ML', fator: 2000 }]);
const REL_UN_ML_350 = Object.freeze([{ unidade_origem: 'UN', unidade_destino: 'ML', fator: 350 }]);
const REL_UN_G_150 = Object.freeze([{ unidade_origem: 'UN', unidade_destino: 'G', fator: 150 }]);

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_) { resolve(); }
  });
}

function schemaCb(fn) {
  return new Promise((resolve, reject) => {
    fn((err) => (err ? reject(err) : resolve()));
  });
}

async function setupDb() {
  const db = await openDb();
  await run(db, `
    CREATE TABLE produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT,
      tipo_operacional TEXT NOT NULL DEFAULT 'COMERCIAL',
      unidade TEXT DEFAULT 'un',
      utiliza_conversao INTEGER NOT NULL DEFAULT 0,
      unidade_estoque TEXT,
      updated_at DATETIME
    )
  `);
  await run(db, `
    CREATE TABLE produto_embalagens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produto_id INTEGER NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'UN',
      quantidade REAL NOT NULL DEFAULT 1,
      unidade TEXT,
      principal INTEGER DEFAULT 1,
      compra INTEGER DEFAULT 1,
      venda INTEGER DEFAULT 1,
      estoque INTEGER DEFAULT 1,
      ativa INTEGER DEFAULT 1
    )
  `);
  await run(db, 'CREATE TABLE compras_itens (id INTEGER PRIMARY KEY)');
  await schemaCb((cb) => garantirSchemaMuc(db, cb));
  await garantirSchemaProdutoConversaoAsync(db);
  return db;
}

async function inserirProduto(db, { nome, unidade = 'UN' } = {}) {
  const r = await run(db, `INSERT INTO produtos (nome, unidade) VALUES (?, ?)`, [nome, unidade]);
  return r.lastID;
}

async function inserirApresentacao(db, produtoId, { tipo = 'CX', quantidade = 12, unidade = 'UN' } = {}) {
  await run(
    db,
    `INSERT INTO produto_embalagens
      (produto_id, tipo, quantidade, unidade, principal, compra, venda, estoque, ativa)
     VALUES (?, ?, ?, ?, 1, 1, 1, 1, 1)`,
    [produtoId, tipo, quantidade, unidade]
  );
}

function processarCompra(db, item, produto) {
  const muc = obterMuc(db);
  return new Promise((resolve, reject) => {
    muc.processarItemCompra(item, produto, { registrarAprendizado: false }, (err, resultado) => {
      if (err) return reject(err);
      resolve(resultado);
    });
  });
}

describe('MUC-06 preview e pré-fill da compra', () => {
  it('T01 — sem conversão: 10 UN → 10 UN', async () => {
    const r = await simularConversaoCompraPreview(null, {
      quantidade: 10,
      unidadeOrigem: 'UN',
      unidadeDestino: 'UN'
    });
    assert.equal(r.quantidadeConvertida, 10);
    assert.equal(r.unidadeDestino, 'UN');
    assert.equal(r.caminho.length, 0);
  });

  it('T02 — SI: 300 ML → 0,3 L', async () => {
    const r = await simularConversaoCompraPreview(null, {
      quantidade: 300,
      unidadeOrigem: 'ML',
      unidadeDestino: 'L'
    });
    assert.equal(r.quantidadeConvertida, 0.3);
    assert.equal(r.unidadeDestino, 'L');
  });

  it('T03 — SI: 80 G → 0,08 KG', async () => {
    const r = await simularConversaoCompraPreview(null, {
      quantidade: 80,
      unidadeOrigem: 'G',
      unidadeDestino: 'KG'
    });
    assert.equal(r.quantidadeConvertida, 0.08);
  });

  it('T04 — embalagem: 1 CAIXA → 12 UN', async () => {
    const r = await simularConversaoCompraPreview(null, {
      quantidade: 1,
      unidadeOrigem: 'CAIXA',
      unidadeDestino: 'UN',
      quantidadePorApresentacao: 12
    });
    assert.equal(r.quantidadeConvertida, 12);
  });

  it('T05 — encadeamento: 1 CAIXA → 12 UN → 24 L', async () => {
    const r = await simularConversaoCompraPreview(null, {
      quantidade: 1,
      unidadeOrigem: 'CAIXA',
      unidadeDestino: 'L',
      quantidadePorApresentacao: 12,
      relacoes: [{ de: 'UN', para: 'L', fator: 2 }]
    });
    assert.equal(r.quantidadeConvertida, 24);
  });

  it('T06 — 12 CAIXAS → 288.000 ML', async () => {
    const r = await simularConversaoCompraPreview(null, {
      quantidade: 12,
      unidadeOrigem: 'CAIXA',
      unidadeDestino: 'ML',
      quantidadePorApresentacao: 12,
      relacoes: [{ de: 'UN', para: 'ML', fator: 2000 }]
    });
    assert.equal(r.quantidadeConvertida, 288000);
    assert.match(r.caminhoTexto, /CAIXA/);
    assert.match(r.caminhoTexto, /ML/);
  });

  it('T07 — 10 FARDO → 42.000 ML', async () => {
    const r = await simularConversaoCompraPreview(null, {
      quantidade: 10,
      unidadeOrigem: 'FARDO',
      unidadeDestino: 'ML',
      quantidadePorApresentacao: 12,
      relacoes: [{ de: 'UN', para: 'ML', fator: 350 }]
    });
    assert.equal(r.quantidadeConvertida, 42000);
  });

  it('T08 — Laranja: 20 UN → 3 KG', async () => {
    const r = await simularConversaoCompraPreview(null, {
      quantidade: 20,
      unidadeOrigem: 'UN',
      unidadeDestino: 'KG',
      relacoes: [{ de: 'UN', para: 'G', fator: 150 }]
    });
    assert.equal(r.quantidadeConvertida, 3);
  });

  it('T09 — unidade origem ausente', async () => {
    await assert.rejects(
      () => simularConversaoCompraPreview(null, { quantidade: 10, unidadeDestino: 'UN' }),
      (e) => e.code === 'UNIDADES_NAO_INFORMADAS' && /origem/i.test(e.message)
    );
  });

  it('T10 — unidade destino ausente', async () => {
    await assert.rejects(
      () => simularConversaoCompraPreview(null, { quantidade: 10, unidadeOrigem: 'UN' }),
      (e) => e.code === 'UNIDADES_NAO_INFORMADAS' && /destino/i.test(e.message)
    );
  });

  it('T11 — relação inexistente', async () => {
    await assert.rejects(
      () => simularConversaoCompraPreview(null, {
        quantidade: 1,
        unidadeOrigem: 'CAIXA',
        unidadeDestino: 'ML'
      }),
      (e) => e.code === 'CONVERSAO_NAO_DISPONIVEL'
    );
  });

  it('T12 — preview == persistência (simples, SI, encadeamento, embalagem)', async () => {
    const db = await setupDb();

    const idCoca = await inserirProduto(db, { nome: 'Coca-Cola 2L', unidade: 'UN' });
    await inserirApresentacao(db, idCoca, { tipo: 'CX', quantidade: 12, unidade: 'UN' });
    await ProdutoConversaoConfigService.salvarConfiguracao(db, idCoca, {
      utiliza_conversao: 1,
      unidade_estoque: 'ML',
      apresentacoes: AP_CAIXA,
      relacoes: REL_UN_ML_2000
    });
    const prodCoca = { id: idCoca, unidade: 'ML', unidade_estoque: 'ML', utiliza_conversao: 1 };
    const previewCoca = await simularConversaoCompraPreview(db, {
      produtoId: idCoca,
      quantidade: 12,
      unidadeOrigem: 'CAIXA',
      unidadeDestino: 'ML'
    });
    const persistCoca = await processarCompra(db, {
      produto_id: idCoca,
      quantidade_embalagens: 12,
      quantidade_por_embalagem: 12,
      compra_em: 'CX',
      valor_total_embalagem: 0
    }, prodCoca);
    assert.equal(previewCoca.quantidadeConvertida, persistCoca.quantidadeEstoque);
    assert.equal(previewCoca.quantidadeConvertida, 288000);

    const previewSi = await simularConversaoCompraPreview(db, {
      quantidade: 300,
      unidadeOrigem: 'ML',
      unidadeDestino: 'L'
    });
    const persistSi = obterMuc(db).converterQuantidade({
      quantidade: 300,
      unidadeOrigem: 'ML',
      unidadeDestino: 'L'
    });
    assert.equal(previewSi.quantidadeConvertida, persistSi.quantidade);

    const idAgua = await inserirProduto(db, { nome: 'Água 350ml', unidade: 'UN' });
    await inserirApresentacao(db, idAgua, { tipo: 'FD', quantidade: 12, unidade: 'UN' });
    await ProdutoConversaoConfigService.salvarConfiguracao(db, idAgua, {
      utiliza_conversao: 1,
      unidade_estoque: 'ML',
      apresentacoes: AP_FARDO,
      relacoes: REL_UN_ML_350
    });
    const previewAgua = await simularConversaoCompraPreview(db, {
      produtoId: idAgua,
      quantidade: 10,
      unidadeOrigem: 'FARDO',
      unidadeDestino: 'ML'
    });
    const persistAgua = await processarCompra(db, {
      produto_id: idAgua,
      quantidade_embalagens: 10,
      quantidade_por_embalagem: 12,
      compra_em: 'FD',
      valor_total_embalagem: 0
    }, { id: idAgua, unidade: 'ML', unidade_estoque: 'ML', utiliza_conversao: 1 });
    assert.equal(previewAgua.quantidadeConvertida, persistAgua.quantidadeEstoque);
    assert.equal(previewAgua.quantidadeConvertida, 42000);

    const idLaranja = await inserirProduto(db, { nome: 'Laranja', unidade: 'UN' });
    await ProdutoConversaoConfigService.salvarConfiguracao(db, idLaranja, {
      utiliza_conversao: 1,
      unidade_estoque: 'KG',
      apresentacoes: [],
      relacoes: REL_UN_G_150
    });
    const previewLar = await simularConversaoCompraPreview(db, {
      produtoId: idLaranja,
      quantidade: 20,
      unidadeOrigem: 'UN',
      unidadeDestino: 'KG'
    });
    const persistLar = obterMuc(db).converterQuantidade({
      quantidade: 20,
      unidadeOrigem: 'UN',
      unidadeDestino: 'KG',
      relacoes: [{ de: 'UN', para: 'G', fator: 150 }]
    });
    assert.equal(previewLar.quantidadeConvertida, persistLar.quantidade);
    assert.equal(previewLar.quantidadeConvertida, 3);

    const previewEmb = await simularConversaoCompraPreview(null, {
      quantidade: 1,
      unidadeOrigem: 'CAIXA',
      unidadeDestino: 'UN',
      quantidadePorApresentacao: 12
    });
    const persistEmb = obterMuc(null).converterQuantidade({
      quantidade: 1,
      unidadeOrigem: 'CAIXA',
      unidadeDestino: 'UN',
      relacoes: [{ de: 'CAIXA', para: 'UN', fator: 12 }]
    });
    assert.equal(previewEmb.quantidadeConvertida, persistEmb.quantidade);

    await closeDb(db);
  });

  it('rota e pré-fill não usam legado como autoridade', () => {
    const compras = src('backend/rotas/compras.js');
    const preview = src('backend/services/compras/simularConversaoCompraPreview.js');
    const front = src('frontend/shared/js/motor-quantidade-compra.js');
    const ui = src('frontend/erp/js/compras.js');
    assert.match(compras, /simularConversaoCompraPreview/);
    assert.match(preview, /converterQuantidade/);
    assert.doesNotMatch(preview, /obterQuantidadeConvertida/);
    assert.match(compras, /quantidade oficial só após processarItemCompra/);
    assert.doesNotMatch(front, /baseEmb \* qtdPorEmb/);
    assert.match(ui, /unidadeOrigem/);
    assert.match(ui, /unidadeDestino/);
  });

  it('sem unidades não inventa multiplicador', async () => {
    await assert.rejects(
      () => simularConversaoCompraPreview(null, {
        quantidade_embalagens: 10,
        quantidade_por_embalagem: 12,
        valor_total_embalagem: 100
      }),
      (e) => e.code === 'UNIDADES_NAO_INFORMADAS'
    );
  });
});
