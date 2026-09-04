/**
 * MUC-04 — Ficha técnica e consumo via MUC oficial.
 * Executar: node tests/muc/muc-04-ficha-consumo.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const { obterMuc } = require('../../backend/motores/muc/public');
const { CODIGOS } = require('../../backend/motores/muc/core/MotorConversaoQuantidade');
const ProdutoConversaoConfigService = require('../../backend/services/produtos/ProdutoConversaoConfigService');
const { garantirSchemaProdutoConversaoAsync } = require('../../backend/services/produtos/produtoConversaoSchema');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const { garantirSchemaFichaTecnicaAsync } = require('../../backend/services/produtos/fichaTecnicaSchema');
const { garantirColunaTipoOperacionalAsync } = require('../../backend/services/produtos/tipoOperacionalProduto');
const { garantirSchemaVendaFichaConsumoAsync } = require('../../backend/services/produtos/vendaFichaConsumoSchema');
const FichaTecnicaService = require('../../backend/services/produtos/FichaTecnicaService');
const {
  consumirFichaTecnicaDaVenda,
  estornarConsumoFichaTecnicaDaVenda,
  estornarConsumoFichaTecnicaDaDevolucao,
  montarLinhasConsumo,
  converterQuantidadeFichaParaEstoque
} = require('../../backend/services/produtos/FichaTecnicaConsumoService');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

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

async function setupBase() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  await run(db, `
    CREATE TABLE produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT,
      ativo INTEGER DEFAULT 1,
      unidade TEXT DEFAULT 'UN',
      tipo_operacional TEXT NOT NULL DEFAULT 'COMERCIAL',
      saldo_fiscal REAL DEFAULT 0,
      saldo_nao_fiscal REAL DEFAULT 0,
      estoque_atual REAL DEFAULT 0,
      reservado_fiscal REAL DEFAULT 0,
      reservado_nao_fiscal REAL DEFAULT 0,
      controla_estoque INTEGER DEFAULT 1,
      updated_at DATETIME
    )
  `);
  await run(db, 'CREATE TABLE vendas (id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER)');
  await garantirColunaTipoOperacionalAsync(db);
  await garantirSchemaFichaTecnicaAsync(db);
  await garantirSchemaVendaFichaConsumoAsync(db);
  await garantirSchemaProdutoConversaoAsync(db);
  const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  return { db, empresaA, empresaB };
}

async function criarProduto(db, nome, tipo, unidade, saldo = 0) {
  const ins = await run(
    db,
    `INSERT INTO produtos (nome, tipo_operacional, unidade, saldo_fiscal, estoque_atual)
     VALUES (?, ?, ?, ?, ?)`,
    [nome, tipo, unidade, saldo, saldo]
  );
  return ins.lastID;
}

async function estoque(db, produtoId, empresaId, saldoFiscal) {
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId, saldo_fiscal: saldoFiscal, saldo_nao_fiscal: 0, estoque_atual: saldoFiscal
  }, { db });
}

function ee(db, produtoId, empresaId) {
  return get(db, 'SELECT * FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?', [produtoId, empresaId]);
}

async function salvarFicha(db, comercialId, itens, ativo = 1) {
  return FichaTecnicaService.salvar(comercialId, { ativo, itens }, { db });
}

describe('MUC-04 ficha e consumo', () => {
  it('T01 — ficha sem conversão (mesma unidade)', async () => {
    const { db, empresaA } = await setupBase();
    const pastel = await criarProduto(db, 'Pastel', 'COMERCIAL', 'UN');
    const massa = await criarProduto(db, 'Massa', 'INSUMO', 'UN', 10);
    await estoque(db, massa, empresaA.id, 10);
    await salvarFicha(db, pastel, [{ insumo_id: massa, quantidade: 2, unidade: 'UN' }]);
    const venda = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
    await consumirFichaTecnicaDaVenda({
      vendaId: venda.lastID, empresaId: empresaA.id,
      itens: [{ produto_id: pastel, quantidade: 1 }], db
    });
    assert.equal(Number((await ee(db, massa, empresaA.id)).saldo_fiscal), 8);
    await closeDb(db);
  });

  it('T02 — ficha ML → estoque L', async () => {
    const { db, empresaA } = await setupBase();
    const prod = await criarProduto(db, 'Açaí', 'COMERCIAL', 'UN');
    const base = await criarProduto(db, 'Polpa', 'INSUMO', 'L', 10);
    await estoque(db, base, empresaA.id, 10);
    await salvarFicha(db, prod, [{ insumo_id: base, quantidade: 300, unidade: 'ML' }]);
    const venda = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
    await consumirFichaTecnicaDaVenda({
      vendaId: venda.lastID, empresaId: empresaA.id,
      itens: [{ produto_id: prod, quantidade: 1 }], db
    });
    assert.equal(Number((await ee(db, base, empresaA.id)).saldo_fiscal), 9.7);
    const snap = await get(db, 'SELECT * FROM venda_ficha_consumo_itens WHERE venda_id = ?', [venda.lastID]);
    assert.equal(Number(snap.quantidade), 0.3);
    assert.equal(String(snap.unidade).toUpperCase(), 'L');
    assert.equal(Number(snap.quantidade_ficha), 300);
    assert.equal(String(snap.unidade_ficha).toUpperCase(), 'ML');
    await closeDb(db);
  });

  it('T03 — ficha G → estoque KG', async () => {
    const { db, empresaA } = await setupBase();
    const prod = await criarProduto(db, 'Pastel', 'COMERCIAL', 'UN');
    const queijo = await criarProduto(db, 'Queijo', 'INSUMO', 'KG', 10);
    await estoque(db, queijo, empresaA.id, 10);
    await salvarFicha(db, prod, [{ insumo_id: queijo, quantidade: 80, unidade: 'G' }]);
    const venda = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
    await consumirFichaTecnicaDaVenda({
      vendaId: venda.lastID, empresaId: empresaA.id,
      itens: [{ produto_id: prod, quantidade: 1 }], db
    });
    assert.equal(Number((await ee(db, queijo, empresaA.id)).saldo_fiscal), 9.92);
    await closeDb(db);
  });

  it('T04 — ficha UN → estoque UN', async () => {
    const conv = converterQuantidadeFichaParaEstoque(null, {
      quantidade: 2, unidadeOrigem: 'UN', unidadeDestino: 'UN', relacoes: []
    });
    assert.equal(conv.quantidade, 2);
    assert.equal(conv.caminho.length, 0);
  });

  it('T05 — ficha UN → G → KG', async () => {
    const { db, empresaA } = await setupBase();
    const prod = await criarProduto(db, 'Suco', 'COMERCIAL', 'UN');
    const laranja = await criarProduto(db, 'Laranja', 'INSUMO', 'KG', 20);
    await estoque(db, laranja, empresaA.id, 20);
    await ProdutoConversaoConfigService.salvarConfiguracao(db, laranja, {
      utiliza_conversao: 1,
      unidade_estoque: 'KG',
      apresentacoes: [],
      relacoes: [{ unidade_origem: 'UN', unidade_destino: 'G', fator: 150 }]
    });
    await salvarFicha(db, prod, [{ insumo_id: laranja, quantidade: 20, unidade: 'UN' }]);
    const venda = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
    await consumirFichaTecnicaDaVenda({
      vendaId: venda.lastID, empresaId: empresaA.id,
      itens: [{ produto_id: prod, quantidade: 1 }], db
    });
    assert.equal(Number((await ee(db, laranja, empresaA.id)).saldo_fiscal), 17);
    await closeDb(db);
  });

  it('T06 — caminho inexistente', async () => {
    const { db, empresaA } = await setupBase();
    const prod = await criarProduto(db, 'X', 'COMERCIAL', 'UN');
    const ins = await criarProduto(db, 'Y', 'INSUMO', 'ML', 10);
    await estoque(db, ins, empresaA.id, 10);
    await salvarFicha(db, prod, [{ insumo_id: ins, quantidade: 1, unidade: 'CAIXA' }]);
    const venda = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
    await assert.rejects(
      () => consumirFichaTecnicaDaVenda({
        vendaId: venda.lastID, empresaId: empresaA.id,
        itens: [{ produto_id: prod, quantidade: 1 }], db
      }),
      (e) => e.code === 'CONVERSAO_NAO_DISPONIVEL' || e.code === CODIGOS.CONVERSAO_NAO_DISPONIVEL
    );
    await closeDb(db);
  });

  it('T07 — família incompatível', async () => {
    const { db, empresaA } = await setupBase();
    const prod = await criarProduto(db, 'X', 'COMERCIAL', 'UN');
    const farinha = await criarProduto(db, 'Farinha', 'INSUMO', 'L', 10);
    await estoque(db, farinha, empresaA.id, 10);
    await salvarFicha(db, prod, [{ insumo_id: farinha, quantidade: 500, unidade: 'G' }]);
    const venda = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
    await assert.rejects(
      () => consumirFichaTecnicaDaVenda({
        vendaId: venda.lastID, empresaId: empresaA.id,
        itens: [{ produto_id: prod, quantidade: 1 }], db
      }),
      (e) => e.code === 'CONVERSAO_INVALIDA' || e.code === 'CONVERSAO_NAO_DISPONIVEL'
    );
    await closeDb(db);
  });

  it('T08 — produto sem ficha', async () => {
    const { db, empresaA } = await setupBase();
    const prod = await criarProduto(db, 'Simples', 'COMERCIAL', 'UN');
    const venda = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
    const r = await consumirFichaTecnicaDaVenda({
      vendaId: venda.lastID, empresaId: empresaA.id,
      itens: [{ produto_id: prod, quantidade: 1 }], db
    });
    assert.equal(r.consumido, false);
    await closeDb(db);
  });

  it('T09 — ficha inativa', async () => {
    const { db, empresaA } = await setupBase();
    const prod = await criarProduto(db, 'X', 'COMERCIAL', 'UN');
    const ins = await criarProduto(db, 'Y', 'INSUMO', 'UN', 10);
    await estoque(db, ins, empresaA.id, 10);
    await salvarFicha(db, prod, [{ insumo_id: ins, quantidade: 1, unidade: 'UN' }], 0);
    const venda = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
    const r = await consumirFichaTecnicaDaVenda({
      vendaId: venda.lastID, empresaId: empresaA.id,
      itens: [{ produto_id: prod, quantidade: 1 }], db
    });
    assert.equal(r.consumido, false);
    assert.equal(Number((await ee(db, ins, empresaA.id)).saldo_fiscal), 10);
    await closeDb(db);
  });

  it('T10 — insumo inativo', async () => {
    const { db, empresaA } = await setupBase();
    const prod = await criarProduto(db, 'X', 'COMERCIAL', 'UN');
    const ins = await criarProduto(db, 'Y', 'INSUMO', 'UN', 10);
    await estoque(db, ins, empresaA.id, 10);
    await salvarFicha(db, prod, [{ insumo_id: ins, quantidade: 1, unidade: 'UN' }]);
    await run(db, 'UPDATE produtos SET ativo = 0 WHERE id = ?', [ins]);
    const venda = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
    await assert.rejects(
      () => consumirFichaTecnicaDaVenda({
        vendaId: venda.lastID, empresaId: empresaA.id,
        itens: [{ produto_id: prod, quantidade: 1 }], db
      }),
      (e) => e.code === 'FICHA_INSUMO_INATIVO'
    );
    await closeDb(db);
  });

  it('T11 — saldo insuficiente', async () => {
    const { db, empresaA } = await setupBase();
    const prod = await criarProduto(db, 'X', 'COMERCIAL', 'UN');
    const ins = await criarProduto(db, 'Y', 'INSUMO', 'UN', 1);
    await estoque(db, ins, empresaA.id, 0.5);
    await salvarFicha(db, prod, [{ insumo_id: ins, quantidade: 1, unidade: 'UN' }]);
    const venda = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
    await assert.rejects(
      () => consumirFichaTecnicaDaVenda({
        vendaId: venda.lastID, empresaId: empresaA.id,
        itens: [{ produto_id: prod, quantidade: 1 }], db
      }),
      (e) => e.code === 'SALDO_INSUFICIENTE'
    );
    await closeDb(db);
  });

  it('T12 — rollback sem baixa parcial', async () => {
    const { db, empresaA } = await setupBase();
    const prod = await criarProduto(db, 'Combo', 'COMERCIAL', 'UN');
    const ok = await criarProduto(db, 'Queijo', 'INSUMO', 'UN', 50);
    const falta = await criarProduto(db, 'Carne', 'INSUMO', 'UN', 0);
    await estoque(db, ok, empresaA.id, 50);
    await estoque(db, falta, empresaA.id, 0);
    await salvarFicha(db, prod, [
      { insumo_id: ok, quantidade: 1, unidade: 'UN' },
      { insumo_id: falta, quantidade: 1, unidade: 'UN' }
    ]);
    const venda = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
    await assert.rejects(
      () => consumirFichaTecnicaDaVenda({
        vendaId: venda.lastID, empresaId: empresaA.id,
        itens: [{ produto_id: prod, quantidade: 1 }], db
      }),
      (e) => e.code === 'SALDO_INSUFICIENTE'
    );
    assert.equal(Number((await ee(db, ok, empresaA.id)).saldo_fiscal), 50);
    assert.equal(Number((await ee(db, falta, empresaA.id)).saldo_fiscal), 0);
    await closeDb(db);
  });

  it('T13 — multiempresa mesma ficha', async () => {
    const { db, empresaA, empresaB } = await setupBase();
    const prod = await criarProduto(db, 'Pastel', 'COMERCIAL', 'UN');
    const queijo = await criarProduto(db, 'Queijo', 'INSUMO', 'KG', 10);
    await estoque(db, queijo, empresaA.id, 10);
    await estoque(db, queijo, empresaB.id, 10);
    await salvarFicha(db, prod, [{ insumo_id: queijo, quantidade: 80, unidade: 'G' }]);
    const vA = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
    const vB = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaB.id]);
    await consumirFichaTecnicaDaVenda({
      vendaId: vA.lastID, empresaId: empresaA.id,
      itens: [{ produto_id: prod, quantidade: 1 }], db
    });
    await consumirFichaTecnicaDaVenda({
      vendaId: vB.lastID, empresaId: empresaB.id,
      itens: [{ produto_id: prod, quantidade: 1 }], db
    });
    assert.equal(Number((await ee(db, queijo, empresaA.id)).saldo_fiscal), 9.92);
    assert.equal(Number((await ee(db, queijo, empresaB.id)).saldo_fiscal), 9.92);
    await closeDb(db);
  });

  it('T14 — snapshot quantidade estoque + unidade ficha', async () => {
    const { db, empresaA } = await setupBase();
    const prod = await criarProduto(db, 'Pastel', 'COMERCIAL', 'UN');
    const queijo = await criarProduto(db, 'Queijo', 'INSUMO', 'KG', 10);
    await estoque(db, queijo, empresaA.id, 10);
    await salvarFicha(db, prod, [{ insumo_id: queijo, quantidade: 80, unidade: 'G' }]);
    const venda = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
    await consumirFichaTecnicaDaVenda({
      vendaId: venda.lastID, empresaId: empresaA.id,
      itens: [{ produto_id: prod, quantidade: 1 }], db
    });
    const snap = await get(db, 'SELECT * FROM venda_ficha_consumo_itens WHERE venda_id = ?', [venda.lastID]);
    assert.equal(Number(snap.quantidade), 0.08);
    assert.equal(String(snap.unidade).toUpperCase(), 'KG');
    assert.equal(Number(snap.quantidade_ficha), 80);
    assert.equal(String(snap.unidade_ficha).toUpperCase(), 'G');
    await closeDb(db);
  });

  it('T15 T28 — alteração posterior da ficha não altera snapshot', async () => {
    const { db, empresaA } = await setupBase();
    const prod = await criarProduto(db, 'Pastel', 'COMERCIAL', 'UN');
    const queijo = await criarProduto(db, 'Queijo', 'INSUMO', 'KG', 10);
    await estoque(db, queijo, empresaA.id, 10);
    await salvarFicha(db, prod, [{ insumo_id: queijo, quantidade: 80, unidade: 'G' }]);
    const v1 = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
    await consumirFichaTecnicaDaVenda({
      vendaId: v1.lastID, empresaId: empresaA.id,
      itens: [{ produto_id: prod, quantidade: 1 }], db
    });
    await salvarFicha(db, prod, [{ insumo_id: queijo, quantidade: 120, unidade: 'G' }]);
    const v2 = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
    await consumirFichaTecnicaDaVenda({
      vendaId: v2.lastID, empresaId: empresaA.id,
      itens: [{ produto_id: prod, quantidade: 1 }], db
    });
    const s1 = await get(db, 'SELECT quantidade_ficha, quantidade FROM venda_ficha_consumo_itens WHERE venda_id = ?', [v1.lastID]);
    const s2 = await get(db, 'SELECT quantidade_ficha, quantidade FROM venda_ficha_consumo_itens WHERE venda_id = ?', [v2.lastID]);
    assert.equal(Number(s1.quantidade_ficha), 80);
    assert.equal(Number(s1.quantidade), 0.08);
    assert.equal(Number(s2.quantidade_ficha), 120);
    assert.equal(Number(s2.quantidade), 0.12);
    await estornarConsumoFichaTecnicaDaVenda({
      vendaId: v1.lastID, empresaId: empresaA.id, db
    });
    const apos = await ee(db, queijo, empresaA.id);
    assert.equal(Number(apos.saldo_fiscal), 9.88);
    await closeDb(db);
  });

  it('T16 — cancelamento estorna snapshot', async () => {
    const { db, empresaA } = await setupBase();
    const prod = await criarProduto(db, 'Pastel', 'COMERCIAL', 'UN');
    const queijo = await criarProduto(db, 'Queijo', 'INSUMO', 'KG', 10);
    await estoque(db, queijo, empresaA.id, 10);
    await salvarFicha(db, prod, [{ insumo_id: queijo, quantidade: 80, unidade: 'G' }]);
    const venda = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
    await consumirFichaTecnicaDaVenda({
      vendaId: venda.lastID, empresaId: empresaA.id,
      itens: [{ produto_id: prod, quantidade: 1 }], db
    });
    const r = await estornarConsumoFichaTecnicaDaVenda({
      vendaId: venda.lastID, empresaId: empresaA.id, db
    });
    assert.equal(r.estornado, true);
    assert.equal(Number((await ee(db, queijo, empresaA.id)).saldo_fiscal), 10);
    await closeDb(db);
  });

  it('T17 — devolução proporcional', async () => {
    const { db, empresaA } = await setupBase();
    const prod = await criarProduto(db, 'Pastel', 'COMERCIAL', 'UN');
    const queijo = await criarProduto(db, 'Queijo', 'INSUMO', 'KG', 10);
    await estoque(db, queijo, empresaA.id, 10);
    await salvarFicha(db, prod, [{ insumo_id: queijo, quantidade: 80, unidade: 'G' }]);
    const venda = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
    await consumirFichaTecnicaDaVenda({
      vendaId: venda.lastID, empresaId: empresaA.id,
      itens: [{ produto_id: prod, quantidade: 5 }], db
    });
    assert.equal(Number((await ee(db, queijo, empresaA.id)).saldo_fiscal), 9.6);
    await estornarConsumoFichaTecnicaDaDevolucao({
      vendaId: venda.lastID,
      empresaId: empresaA.id,
      produtoId: prod,
      quantidadeDevolvida: 2,
      quantidadeVendida: 5,
      vendaDevolucaoId: 1,
      db
    });
    assert.equal(Number((await ee(db, queijo, empresaA.id)).saldo_fiscal), 9.76);
    await estornarConsumoFichaTecnicaDaDevolucao({
      vendaId: venda.lastID,
      empresaId: empresaA.id,
      produtoId: prod,
      quantidadeDevolvida: 2,
      quantidadeVendida: 5,
      vendaDevolucaoId: 2,
      db
    });
    assert.equal(Number((await ee(db, queijo, empresaA.id)).saldo_fiscal), 9.92);
    await closeDb(db);
  });

  it('T18 — idempotência', async () => {
    const { db, empresaA } = await setupBase();
    const prod = await criarProduto(db, 'X', 'COMERCIAL', 'UN');
    const ins = await criarProduto(db, 'Y', 'INSUMO', 'UN', 10);
    await estoque(db, ins, empresaA.id, 10);
    await salvarFicha(db, prod, [{ insumo_id: ins, quantidade: 1, unidade: 'UN' }]);
    const venda = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
    const a = await consumirFichaTecnicaDaVenda({
      vendaId: venda.lastID, empresaId: empresaA.id,
      itens: [{ produto_id: prod, quantidade: 1 }], db
    });
    const b = await consumirFichaTecnicaDaVenda({
      vendaId: venda.lastID, empresaId: empresaA.id,
      itens: [{ produto_id: prod, quantidade: 1 }], db
    });
    assert.equal(a.consumido, true);
    assert.equal(b.ja_consumido, true);
    assert.equal(Number((await ee(db, ins, empresaA.id)).saldo_fiscal), 9);
    const est1 = await estornarConsumoFichaTecnicaDaVenda({
      vendaId: venda.lastID, empresaId: empresaA.id, db
    });
    const est2 = await estornarConsumoFichaTecnicaDaVenda({
      vendaId: venda.lastID, empresaId: empresaA.id, db
    });
    assert.equal(est1.estornado, true);
    assert.equal(est2.ja_estornado, true);
    await closeDb(db);
  });

  it('T19 — MUC não altera estoque diretamente', async () => {
    const { db, empresaA } = await setupBase();
    const prod = await criarProduto(db, 'Pastel', 'COMERCIAL', 'UN');
    const queijo = await criarProduto(db, 'Queijo', 'INSUMO', 'KG', 10);
    await estoque(db, queijo, empresaA.id, 10);
    await salvarFicha(db, prod, [{ insumo_id: queijo, quantidade: 80, unidade: 'G' }]);
    const antes = await ee(db, queijo, empresaA.id);
    const linhas = await montarLinhasConsumo([{ produto_id: prod, quantidade: 1 }], db);
    assert.equal(linhas[0].quantidade, 0.08);
    const depois = await ee(db, queijo, empresaA.id);
    assert.equal(Number(depois.saldo_fiscal), Number(antes.saldo_fiscal));
    await closeDb(db);
  });

  it('T20 — serviço de estoque recebe unidade final', async () => {
    const consumo = src('backend/services/produtos/FichaTecnicaConsumoService.js');
    assert.match(consumo, /debitarEstoqueItemVenda/);
    assert.match(consumo, /exigirEmpresa: true/);
    assert.match(consumo, /quantidade: round3\(conv\.quantidade\)/);
    await Promise.resolve();
  });

  it('T21 — nenhuma conversão dupla', async () => {
    const conv = converterQuantidadeFichaParaEstoque(null, {
      quantidade: 300, unidadeOrigem: 'ML', unidadeDestino: 'L', relacoes: []
    });
    assert.equal(conv.quantidade, 0.3);
    assert.notEqual(conv.quantidade, 0.0003);
  });

  it('T22 — nenhuma conversão artificial UN → UN', () => {
    const conv = converterQuantidadeFichaParaEstoque(null, {
      quantidade: 20, unidadeOrigem: 'UN', unidadeDestino: 'UN', relacoes: []
    });
    assert.equal(conv.quantidade, 20);
    assert.equal(conv.caminho.length, 0);
    const calc = src('backend/motores/muc/core/MotorConversaoCalculo.js');
    assert.match(calc, /tipoAp !== 'UN'/);
  });

  it('T23 — Laranja 20 UN → 3 KG', async () => {
    const { db, empresaA } = await setupBase();
    const prod = await criarProduto(db, 'Suco', 'COMERCIAL', 'UN');
    const laranja = await criarProduto(db, 'Laranja', 'INSUMO', 'KG', 20);
    await estoque(db, laranja, empresaA.id, 20);
    await ProdutoConversaoConfigService.salvarConfiguracao(db, laranja, {
      utiliza_conversao: 1,
      unidade_estoque: 'KG',
      relacoes: [{ unidade_origem: 'UN', unidade_destino: 'G', fator: 150 }]
    });
    await salvarFicha(db, prod, [{ insumo_id: laranja, quantidade: 20, unidade: 'UN' }]);
    const venda = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
    await consumirFichaTecnicaDaVenda({
      vendaId: venda.lastID, empresaId: empresaA.id,
      itens: [{ produto_id: prod, quantidade: 1 }], db
    });
    assert.equal(Number((await ee(db, laranja, empresaA.id)).saldo_fiscal), 17);
    const snap = await get(db, 'SELECT quantidade, unidade FROM venda_ficha_consumo_itens WHERE venda_id = ?', [venda.lastID]);
    assert.equal(Number(snap.quantidade), 3);
    assert.equal(String(snap.unidade).toUpperCase(), 'KG');
    await closeDb(db);
  });

  it('T24 — Queijo 80 G → 0,08 KG', async () => {
    const conv = converterQuantidadeFichaParaEstoque(null, {
      quantidade: 80, unidadeOrigem: 'G', unidadeDestino: 'KG', relacoes: []
    });
    assert.equal(conv.quantidade, 0.08);
  });

  it('T25 — venda A não baixa B', async () => {
    const { db, empresaA, empresaB } = await setupBase();
    const prod = await criarProduto(db, 'Pastel', 'COMERCIAL', 'UN');
    const queijo = await criarProduto(db, 'Queijo', 'INSUMO', 'KG', 10);
    await estoque(db, queijo, empresaA.id, 10);
    await estoque(db, queijo, empresaB.id, 10);
    await salvarFicha(db, prod, [{ insumo_id: queijo, quantidade: 80, unidade: 'G' }]);
    const vA = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
    await consumirFichaTecnicaDaVenda({
      vendaId: vA.lastID, empresaId: empresaA.id,
      itens: [{ produto_id: prod, quantidade: 1 }], db
    });
    assert.equal(Number((await ee(db, queijo, empresaA.id)).saldo_fiscal), 9.92);
    assert.equal(Number((await ee(db, queijo, empresaB.id)).saldo_fiscal), 10);
    await closeDb(db);
  });

  it('T26 — venda B não baixa A', async () => {
    const { db, empresaA, empresaB } = await setupBase();
    const prod = await criarProduto(db, 'Pastel', 'COMERCIAL', 'UN');
    const queijo = await criarProduto(db, 'Queijo', 'INSUMO', 'KG', 10);
    await estoque(db, queijo, empresaA.id, 10);
    await estoque(db, queijo, empresaB.id, 10);
    await salvarFicha(db, prod, [{ insumo_id: queijo, quantidade: 80, unidade: 'G' }]);
    const vB = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaB.id]);
    await consumirFichaTecnicaDaVenda({
      vendaId: vB.lastID, empresaId: empresaB.id,
      itens: [{ produto_id: prod, quantidade: 1 }], db
    });
    assert.equal(Number((await ee(db, queijo, empresaB.id)).saldo_fiscal), 9.92);
    assert.equal(Number((await ee(db, queijo, empresaA.id)).saldo_fiscal), 10);
    await closeDb(db);
  });

  it('T27 — dois insumos com rollback', async () => {
    const { db, empresaA } = await setupBase();
    const prod = await criarProduto(db, 'Combo', 'COMERCIAL', 'UN');
    const queijo = await criarProduto(db, 'Queijo', 'INSUMO', 'KG', 10);
    const carne = await criarProduto(db, 'Carne', 'INSUMO', 'KG', 10);
    await estoque(db, queijo, empresaA.id, 10);
    await estoque(db, carne, empresaA.id, 0.01);
    await salvarFicha(db, prod, [
      { insumo_id: queijo, quantidade: 80, unidade: 'G' },
      { insumo_id: carne, quantidade: 80, unidade: 'G' }
    ]);
    const venda = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
    await assert.rejects(
      () => consumirFichaTecnicaDaVenda({
        vendaId: venda.lastID, empresaId: empresaA.id,
        itens: [{ produto_id: prod, quantidade: 1 }], db
      }),
      (e) => e.code === 'SALDO_INSUFICIENTE'
    );
    assert.equal(Number((await ee(db, queijo, empresaA.id)).saldo_fiscal), 10);
    assert.equal(Number((await ee(db, carne, empresaA.id)).saldo_fiscal), 0.01);
    await closeDb(db);
  });

  it('T29 — contrato MUC-02', () => {
    const muc = obterMuc({
      run(s, p, cb) { if (typeof p === 'function') p(null); else if (cb) cb(null); },
      get(s, p, cb) { if (typeof p === 'function') p(null, null); else if (cb) cb(null, null); },
      all(s, p, cb) { if (typeof p === 'function') p(null, []); else if (cb) cb(null, []); }
    });
    assert.equal(typeof muc.converterQuantidade, 'function');
    assert.equal(muc.converterQuantidade({
      quantidade: 300, unidadeOrigem: 'ML', unidadeDestino: 'L'
    }).quantidade, 0.3);
    assert.match(src('backend/services/produtos/FichaTecnicaConsumoService.js'), /obterMuc\(db\)\.converterQuantidade/);
  });

  it('T30 — configuração MUC-03', () => {
    const consumo = src('backend/services/produtos/FichaTecnicaConsumoService.js');
    assert.match(consumo, /ProdutoConversaoConfigService/);
    assert.match(consumo, /montarRelacoesMuc/);
    assert.match(consumo, /unidade_estoque/);
    assert.doesNotMatch(consumo, /require\('\.\.\/unidades\/MotorUnidadesMedida'\)/);
  });
});
