/**
 * MUC-03 — Configuração de conversão no cadastro de produto.
 * Executar: node tests/muc/muc-03-configuracao-produto.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const { converterQuantidade, CODIGOS } = require('../../backend/motores/muc/core/MotorConversaoQuantidade');
const { obterMuc } = require('../../backend/motores/muc/public');
const ProdutoConversaoConfigService = require('../../backend/services/produtos/ProdutoConversaoConfigService');
const { garantirSchemaProdutoConversaoAsync } = require('../../backend/services/produtos/produtoConversaoSchema');
const { garantirSchemaMuc } = require('../../backend/motores/muc/schema/mucSchema');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

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

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
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
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  return db;
}

async function inserirProduto(db, { nome, tipo = 'COMERCIAL', unidade = 'un' } = {}) {
  const r = await run(
    db,
    `INSERT INTO produtos (nome, tipo_operacional, unidade) VALUES (?, ?, ?)`,
    [nome, tipo, unidade]
  );
  return r.lastID;
}

async function inserirApresentacao(db, produtoId, { tipo = 'CX', quantidade = 12, unidade = 'un' } = {}) {
  await run(
    db,
    `INSERT INTO produto_embalagens
      (produto_id, tipo, quantidade, unidade, principal, compra, venda, estoque, ativa)
     VALUES (?, ?, ?, ?, 1, 1, 1, 1, 1)`,
    [produtoId, tipo, quantidade, unidade]
  );
}

function processarCompra(db, item, produto) {
  const { obterMuc: obterMucDb } = require('../../backend/motores/muc');
  const muc = obterMucDb(db);
  return new Promise((resolve, reject) => {
    muc.processarItemCompra(item, produto, { registrarAprendizado: false }, (err, resultado) => {
      if (err) return reject(err);
      resolve(resultado);
    });
  });
}

describe('MUC-03 configuração de produto', () => {
  it('T01 — produto sem conversão', () => {
    const r = ProdutoConversaoConfigService.validarConfiguracao({
      utilizaConversao: false,
      unidadeEstoque: 'ML',
      apresentacoes: AP_CAIXA,
      relacoes: REL_UN_ML_2000
    });
    assert.equal(r.utiliza_conversao, 0);
    assert.equal(r.relacoes.length, 0);
  });

  it('T02 — habilitar conversão', () => {
    const r = ProdutoConversaoConfigService.validarConfiguracao({
      utilizaConversao: true,
      unidadeEstoque: 'ML',
      apresentacoes: AP_CAIXA,
      relacoes: REL_UN_ML_2000
    });
    assert.equal(r.utiliza_conversao, 1);
    assert.equal(r.unidade_estoque, 'ML');
  });

  it('T03 — unidade de estoque obrigatória', () => {
    assert.throws(
      () => ProdutoConversaoConfigService.validarConfiguracao({
        utilizaConversao: true,
        unidadeEstoque: '',
        apresentacoes: [],
        relacoes: []
      }),
      (e) => e.code === 'UNIDADE_ESTOQUE_OBRIGATORIA'
    );
  });

  it('T04 — apresentação CAIXA → 12 UN', () => {
    const r = ProdutoConversaoConfigService.validarConfiguracao({
      utilizaConversao: true,
      unidadeEstoque: 'UN',
      apresentacoes: AP_CAIXA,
      relacoes: []
    });
    assert.equal(r.utiliza_conversao, 1);
    const conv = converterQuantidade({
      quantidade: 1,
      unidadeOrigem: 'CAIXA',
      unidadeDestino: 'UN',
      relacoes: ProdutoConversaoConfigService.montarRelacoesMuc(AP_CAIXA, [])
    });
    assert.equal(conv.quantidade, 12);
  });

  it('T05 — relação UN → ML', () => {
    ProdutoConversaoConfigService.validarRelacaoSi({ unidade_origem: 'UN', unidade_destino: 'ML', fator: 2000 });
    const conv = converterQuantidade({
      quantidade: 1,
      unidadeOrigem: 'UN',
      unidadeDestino: 'ML',
      relacoes: [{ de: 'UN', para: 'ML', fator: 2000 }]
    });
    assert.equal(conv.quantidade, 2000);
  });

  it('T06 — encadeamento CAIXA → UN → ML', () => {
    const rel = ProdutoConversaoConfigService.montarRelacoesMuc(AP_CAIXA, REL_UN_ML_2000);
    const conv = converterQuantidade({
      quantidade: 1,
      unidadeOrigem: 'CAIXA',
      unidadeDestino: 'ML',
      relacoes: rel
    });
    assert.equal(conv.quantidade, 24000);
    const nos = [conv.caminho[0].de, ...conv.caminho.map((e) => e.para)];
    assert.ok(nos.includes('CAIXA') && nos.includes('UN') && nos.includes('ML'));
  });

  it('T07 — Coca-Cola 12 CX → 288.000 ML', () => {
    const rel = ProdutoConversaoConfigService.montarRelacoesMuc(AP_CAIXA, REL_UN_ML_2000);
    const conv = converterQuantidade({
      quantidade: 12,
      unidadeOrigem: 'CX',
      unidadeDestino: 'ML',
      relacoes: rel
    });
    assert.equal(conv.quantidade, 288000);
  });

  it('T08 — Água 10 FARDO → 42.000 ML', () => {
    const rel = ProdutoConversaoConfigService.montarRelacoesMuc(AP_FARDO, REL_UN_ML_350);
    const conv = converterQuantidade({
      quantidade: 10,
      unidadeOrigem: 'FARDO',
      unidadeDestino: 'ML',
      relacoes: rel
    });
    assert.equal(conv.quantidade, 42000);
  });

  it('T09 — insumo sem conversão', () => {
    const r = ProdutoConversaoConfigService.validarConfiguracao({
      utilizaConversao: false,
      unidadeEstoque: 'KG',
      apresentacoes: [],
      relacoes: []
    });
    assert.equal(r.utiliza_conversao, 0);
    const conv = converterQuantidade({
      quantidade: 5,
      unidadeOrigem: 'KG',
      unidadeDestino: 'KG'
    });
    assert.equal(conv.quantidade, 5);
  });

  it('T10 — insumo com conversão', () => {
    const r = ProdutoConversaoConfigService.validarConfiguracao({
      utilizaConversao: true,
      unidadeEstoque: 'KG',
      apresentacoes: [],
      relacoes: REL_UN_G_150
    });
    assert.equal(r.utiliza_conversao, 1);
    const conv = converterQuantidade({
      quantidade: 20,
      unidadeOrigem: 'UN',
      unidadeDestino: 'KG',
      relacoes: [{ de: 'UN', para: 'G', fator: 150 }]
    });
    assert.equal(conv.quantidade, 3);
  });

  it('T11 — fator zero rejeitado', () => {
    assert.throws(
      () => ProdutoConversaoConfigService.validarRelacaoSi({
        unidade_origem: 'UN', unidade_destino: 'ML', fator: 0
      }),
      (e) => e.code === 'FATOR_INVALIDO'
    );
  });

  it('T12 — fator negativo rejeitado', () => {
    assert.throws(
      () => ProdutoConversaoConfigService.validarRelacaoSi({
        unidade_origem: 'UN', unidade_destino: 'ML', fator: -2
      }),
      (e) => e.code === 'FATOR_INVALIDO'
    );
  });

  it('T13 — unidade inválida rejeitada', () => {
    assert.throws(
      () => ProdutoConversaoConfigService.validarRelacaoSi({
        unidade_origem: 'XYZ', unidade_destino: 'ML', fator: 1
      }),
      (e) => e.code === 'UNIDADE_INVALIDA'
    );
  });

  it('T14 — família incompatível rejeitada', () => {
    assert.throws(
      () => ProdutoConversaoConfigService.validarRelacaoSi({
        unidade_origem: 'KG', unidade_destino: 'ML', fator: 1
      }),
      (e) => e.code === 'CONVERSAO_INVALIDA'
    );
  });

  it('T15 — caminho inexistente rejeitado', () => {
    assert.throws(
      () => ProdutoConversaoConfigService.validarConfiguracao({
        utilizaConversao: true,
        unidadeEstoque: 'ML',
        apresentacoes: AP_CAIXA,
        relacoes: []
      }),
      (e) => e.code === 'CONVERSAO_NAO_DISPONIVEL'
    );
  });

  it('T16 — simulação não altera estoque', async () => {
    const db = await setupDb();
    const id = await inserirProduto(db, { nome: 'Coca-Cola 2L', unidade: 'ML' });
    await ProdutoConversaoConfigService.salvarConfiguracao(db, id, {
      utiliza_conversao: 1,
      unidade_estoque: 'ML',
      apresentacoes: AP_CAIXA,
      relacoes: REL_UN_ML_2000
    });
    const empresa = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
    await EstoqueEmpresaService.criarRegistro({
      produtoId: id, empresaId: empresa.id, saldo_fiscal: 10, estoque_atual: 10
    }, { db });
    const antes = await get(db, 'SELECT estoque_atual FROM estoque_empresa WHERE produto_id = ?', [id]);
    const cfg = await ProdutoConversaoConfigService.obterConfiguracao(db, id);
    const sim = ProdutoConversaoConfigService.simularConversaoProduto(cfg, {
      quantidade: 12,
      unidadeOrigem: 'CAIXA',
      unidadeDestino: 'ML',
      apresentacoes: AP_CAIXA
    });
    assert.equal(sim.quantidade, 288000);
    assert.equal(sim.estoqueAlterado, false);
    const depois = await get(db, 'SELECT estoque_atual FROM estoque_empresa WHERE produto_id = ?', [id]);
    assert.equal(Number(depois.estoque_atual), Number(antes.estoque_atual));
    await closeDb(db);
  });

  it('T17 — produto A e B compartilham configuração (catálogo, sem empresa_id)', async () => {
    const { DDL_RELACOES } = require('../../backend/services/produtos/produtoConversaoSchema');
    assert.doesNotMatch(DDL_RELACOES, /empresa_id/);
    const db = await setupDb();
    const id = await inserirProduto(db, { nome: 'Coca-Cola 2L', unidade: 'ML' });
    await ProdutoConversaoConfigService.salvarConfiguracao(db, id, {
      utiliza_conversao: 1,
      unidade_estoque: 'ML',
      apresentacoes: AP_CAIXA,
      relacoes: REL_UN_ML_2000
    });
    const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
    const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
    const cfg = await ProdutoConversaoConfigService.obterConfiguracao(db, id);
    assert.equal(cfg.relacoes.length, 1);
    assert.equal(cfg.relacoes[0].fator, 2000);
    assert.ok(empresaA.id !== empresaB.id);
    await closeDb(db);
  });

  it('T18 — estoque A e B continuam separados', async () => {
    const db = await setupDb();
    const id = await inserirProduto(db, { nome: 'Coca-Cola 2L', unidade: 'ML' });
    const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
    const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
    await EstoqueEmpresaService.criarRegistro({
      produtoId: id, empresaId: empresaA.id, saldo_fiscal: 0, estoque_atual: 0
    }, { db });
    await EstoqueEmpresaService.criarRegistro({
      produtoId: id, empresaId: empresaB.id, saldo_fiscal: 0, estoque_atual: 0
    }, { db });
    await EstoqueEmpresaService.aplicarEfeitoSaldo({
      produtoId: id, empresaId: empresaA.id, deltaSaldoFiscal: 288000
    }, { db });
    const a = await get(db, 'SELECT estoque_atual FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?', [id, empresaA.id]);
    const b = await get(db, 'SELECT estoque_atual FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?', [id, empresaB.id]);
    assert.equal(Number(a.estoque_atual), 288000);
    assert.equal(Number(b.estoque_atual), 0);
    await closeDb(db);
  });

  it('T19 — edição de relação', async () => {
    const db = await setupDb();
    const id = await inserirProduto(db, { nome: 'Coca-Cola 2L', unidade: 'ML' });
    await ProdutoConversaoConfigService.salvarConfiguracao(db, id, {
      utiliza_conversao: 1,
      unidade_estoque: 'ML',
      apresentacoes: AP_CAIXA,
      relacoes: REL_UN_ML_2000
    });
    await ProdutoConversaoConfigService.salvarConfiguracao(db, id, {
      utiliza_conversao: 1,
      unidade_estoque: 'ML',
      apresentacoes: AP_CAIXA,
      relacoes: [{ unidade_origem: 'UN', unidade_destino: 'ML', fator: 2500 }]
    });
    const cfg = await ProdutoConversaoConfigService.obterConfiguracao(db, id);
    assert.equal(cfg.relacoes[0].fator, 2500);
    await closeDb(db);
  });

  it('T20 — exclusão protegida', async () => {
    const db = await setupDb();
    const id = await inserirProduto(db, { nome: 'Coca-Cola 2L', unidade: 'ML' });
    await ProdutoConversaoConfigService.salvarConfiguracao(db, id, {
      utiliza_conversao: 1,
      unidade_estoque: 'ML',
      apresentacoes: AP_CAIXA,
      relacoes: REL_UN_ML_2000
    });
    const cfg = await ProdutoConversaoConfigService.obterConfiguracao(db, id);
    await assert.rejects(
      () => ProdutoConversaoConfigService.excluirRelacao(db, id, cfg.relacoes[0].id, AP_CAIXA),
      (e) => e.code === 'RELACAO_NECESSARIA'
    );
    await closeDb(db);
  });

  it('T21 — produto antigo sem configuração continua funcionando', async () => {
    const db = await setupDb();
    const id = await inserirProduto(db, { nome: 'Produto legado', unidade: 'un' });
    const row = await get(db, 'SELECT utiliza_conversao FROM produtos WHERE id = ?', [id]);
    assert.equal(Number(row.utiliza_conversao), 0);
    const muc = obterMuc({
      run(sql, params, cb) { if (typeof params === 'function') params(null); else if (cb) cb(null); },
      get(sql, params, cb) { if (typeof params === 'function') params(null, null); else if (cb) cb(null, null); },
      all(sql, params, cb) { if (typeof params === 'function') params(null, []); else if (cb) cb(null, []); }
    });
    const pipe = muc.converter({
      quantidadeCompra: 2,
      quantidadePorApresentacao: 10,
      produto: { id, unidade: 'un', utiliza_conversao: 0 },
      item: { quantidade_embalagens: 2, quantidade_por_embalagem: 10, valor_total_embalagem: 0, compra_em: 'PCT' }
    });
    assert.equal(pipe.quantidadeEstoque, 20);
    await closeDb(db);
  });

  it('T22 — não cria conversão por nome do produto', () => {
    assert.throws(
      () => converterQuantidade({
        quantidade: 12,
        unidadeOrigem: 'CAIXA',
        unidadeDestino: 'ML',
        relacoes: []
      }),
      (e) => e.code === CODIGOS.CONVERSAO_NAO_DISPONIVEL
    );
    assert.doesNotMatch(src('backend/motores/muc/core/MotorConversaoQuantidade.js'), /Coca-Cola|coca cola/i);
  });

  it('T23 — não duplica relação final', () => {
    assert.throws(
      () => ProdutoConversaoConfigService.validarRelacaoSi({
        unidade_origem: 'CAIXA', unidade_destino: 'ML', fator: 24000
      }),
      (e) => e.code === 'RELACAO_INVALIDA'
    );
  });

  it('T24 — auditoria registra alteração', async () => {
    const rotas = src('backend/rotas/produtos.js');
    assert.match(rotas, /configurar_conversao_produto/);
    assert.match(rotas, /gravarAuditoria/);
    const db = await setupDb();
    const id = await inserirProduto(db, { nome: 'Coca-Cola 2L', unidade: 'ML' });
    const cfg = await ProdutoConversaoConfigService.salvarConfiguracao(db, id, {
      utiliza_conversao: 1,
      unidade_estoque: 'ML',
      apresentacoes: AP_CAIXA,
      relacoes: REL_UN_ML_2000
    }, { usuario: { id: 7 } });
    assert.equal(cfg.auditoria.acao, 'configurar_conversao_produto');
    assert.equal(cfg.auditoria.usuario_id, 7);
    await closeDb(db);
  });

  it('T25 — compatibilidade com MUC-02', () => {
    const muc = obterMuc({
      run(sql, params, cb) { if (typeof params === 'function') params(null); else if (cb) cb(null); },
      get(sql, params, cb) { if (typeof params === 'function') params(null, null); else if (cb) cb(null, []); },
      all(sql, params, cb) { if (typeof params === 'function') params(null, []); else if (cb) cb(null, []); }
    });
    const pipe = muc.converter({
      quantidadeCompra: 12,
      unidadeCompra: 'CAIXA',
      quantidadePorApresentacao: 12,
      produto: { unidade: 'ML', utiliza_conversao: 0 },
      relacoes: [{ de: 'UN', para: 'ML', fator: 2000 }],
      item: {
        quantidade_embalagens: 12,
        quantidade_por_embalagem: 12,
        valor_total_embalagem: 0,
        unidade_comercial: 'CAIXA',
        compra_em: 'CX'
      }
    });
    assert.equal(pipe.quantidadeEstoque, 288000);
    assert.match(src('backend/rotas/compras.js'), /quantidadeEstoque/);
  });

  it('integração Coca — cadastro + simulação + compra + estoque empresa A', async () => {
    const db = await setupDb();
    const id = await inserirProduto(db, { nome: 'Coca-Cola 2L', tipo: 'COMERCIAL', unidade: 'un' });
    await inserirApresentacao(db, id, { tipo: 'CX', quantidade: 12, unidade: 'un' });
    const salvo = await ProdutoConversaoConfigService.salvarConfiguracao(db, id, {
      utiliza_conversao: 1,
      unidade_estoque: 'ML',
      apresentacoes: AP_CAIXA,
      relacoes: REL_UN_ML_2000
    });
    assert.equal(salvo.utiliza_conversao, 1);
    const prod = await get(db, 'SELECT * FROM produtos WHERE id = ?', [id]);
    assert.equal(prod.tipo_operacional, 'COMERCIAL');
    assert.equal(Number(prod.utiliza_conversao), 1);

    const cfg = await ProdutoConversaoConfigService.obterConfiguracao(db, id);
    const sim = ProdutoConversaoConfigService.simularConversaoProduto(cfg, {
      quantidade: 12,
      unidade: 'CAIXA',
      apresentacoes: AP_CAIXA
    });
    assert.equal(sim.quantidade, 288000);
    assert.equal(sim.estoqueAlterado, false);

    const resultado = await processarCompra(db, {
      produto_id: id,
      quantidade_embalagens: 12,
      quantidade_por_embalagem: 12,
      compra_em: 'CX',
      valor_total_embalagem: 0
    }, prod);
    assert.equal(resultado.quantidadeEstoque, 288000);

    const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
    const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
    await EstoqueEmpresaService.aplicarEfeitoSaldo({
      produtoId: id,
      empresaId: empresaA.id,
      deltaSaldoFiscal: resultado.quantidadeEstoque
    }, { db });
    const a = await get(db, 'SELECT estoque_atual FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?', [id, empresaA.id]);
    const b = await get(db, 'SELECT estoque_atual FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?', [id, empresaB.id]);
    assert.equal(Number(a.estoque_atual), 288000);
    assert.equal(b, null);
    await closeDb(db);
  });

  it('integração Água 10 FARDO → 42.000 ML', async () => {
    const db = await setupDb();
    const id = await inserirProduto(db, { nome: 'Água Mineral 350 ML', tipo: 'COMERCIAL', unidade: 'ML' });
    await inserirApresentacao(db, id, { tipo: 'FD', quantidade: 12, unidade: 'un' });
    await ProdutoConversaoConfigService.salvarConfiguracao(db, id, {
      utiliza_conversao: 1,
      unidade_estoque: 'ML',
      apresentacoes: AP_FARDO,
      relacoes: REL_UN_ML_350
    });
    const prod = await get(db, 'SELECT * FROM produtos WHERE id = ?', [id]);
    const resultado = await processarCompra(db, {
      produto_id: id,
      quantidade_embalagens: 10,
      quantidade_por_embalagem: 12,
      compra_em: 'FD',
      valor_total_embalagem: 0
    }, prod);
    assert.equal(resultado.quantidadeEstoque, 42000);
    await closeDb(db);
  });

  it('integração insumo Laranja 20 UN → 3 KG', async () => {
    const db = await setupDb();
    const id = await inserirProduto(db, { nome: 'Laranja', tipo: 'INSUMO', unidade: 'KG' });
    await ProdutoConversaoConfigService.salvarConfiguracao(db, id, {
      utiliza_conversao: 1,
      unidade_estoque: 'KG',
      apresentacoes: [],
      relacoes: REL_UN_G_150
    });
    const prod = await get(db, 'SELECT * FROM produtos WHERE id = ?', [id]);
    assert.equal(prod.tipo_operacional, 'INSUMO');
    const resultado = await processarCompra(db, {
      produto_id: id,
      quantidade_embalagens: 20,
      quantidade_por_embalagem: 1,
      compra_em: 'UN',
      valor_total_embalagem: 0
    }, prod);
    assert.equal(resultado.quantidadeEstoque, 3);
    const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
    const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
    await EstoqueEmpresaService.aplicarEfeitoSaldo({
      produtoId: id, empresaId: empresaA.id, deltaSaldoFiscal: 3
    }, { db });
    await EstoqueEmpresaService.aplicarEfeitoSaldo({
      produtoId: id, empresaId: empresaB.id, deltaSaldoFiscal: 1
    }, { db });
    const a = await get(db, 'SELECT estoque_atual FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?', [id, empresaA.id]);
    const b = await get(db, 'SELECT estoque_atual FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?', [id, empresaB.id]);
    assert.equal(Number(a.estoque_atual), 3);
    assert.equal(Number(b.estoque_atual), 1);
    await closeDb(db);
  });

  it('UI permanece no cadastro de produtos (sem tela Cadastro de MUC)', () => {
    const ui = src('frontend/erp/js/produto-embalagens.js');
    const save = src('frontend/erp/js/produtos.js');
    assert.match(ui, /Utiliza conversão/);
    assert.match(ui, /unidade_estoque/);
    assert.match(ui, /Simular conversão/);
    assert.match(ui, /btnSimularConversaoMuc/);
    assert.doesNotMatch(ui, /Cadastro de MUC/);
    assert.match(save, /utiliza_conversao/);
    assert.match(save, /relacoes/);
    assert.match(src('backend/rotas/produtos.js'), /conversao\/simular/);
  });
});
