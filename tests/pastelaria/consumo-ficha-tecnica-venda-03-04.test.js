/**
 * Sprint 03.04 — Consumo de ficha técnica na venda.
 * Executar: node tests/pastelaria/consumo-ficha-tecnica-venda-03-04.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const { garantirSchemaFichaTecnicaAsync } = require('../../backend/services/produtos/fichaTecnicaSchema');
const { garantirColunaTipoOperacionalAsync } = require('../../backend/services/produtos/tipoOperacionalProduto');
const { garantirSchemaVendaFichaConsumoAsync } = require('../../backend/services/produtos/vendaFichaConsumoSchema');
const FichaTecnicaService = require('../../backend/services/produtos/FichaTecnicaService');
const {
  consumirFichaTecnicaDaVenda
} = require('../../backend/services/produtos/FichaTecnicaConsumoService');
const { exigirProdutosVendaveisNaVenda } = require('../../backend/services/produtos/tipoOperacionalProduto');
const MotorUM = require('../../backend/services/unidades/MotorUnidadesMedida');
const {
  exigirEmpresaDaOperacao,
  CODIGO_EMPRESA_CONTEXT_REQUIRED
} = require('../../backend/services/vendas/VendaEmpresaContextoService');
const { ModoOperacionalGlobal } = require('../../backend/core/modo-operacional');

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
  await run(db, `CREATE TABLE vendas (id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER)`);
  await garantirColunaTipoOperacionalAsync(db);
  await garantirSchemaFichaTecnicaAsync(db);
  await garantirSchemaVendaFichaConsumoAsync(db);
  const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  return { db, empresaA, empresaB };
}

async function criarProduto(db, nome, tipo, unidade, saldoProdutos) {
  const ins = await run(
    db,
    `INSERT INTO produtos (nome, tipo_operacional, unidade, saldo_fiscal, saldo_nao_fiscal, estoque_atual)
     VALUES (?, ?, ?, ?, 0, ?)`,
    [nome, tipo, unidade, saldoProdutos, saldoProdutos]
  );
  return ins.lastID;
}

async function estoque(db, produtoId, empresaId, saldoFiscal) {
  await EstoqueEmpresaService.criarRegistro({
    produtoId,
    empresaId,
    saldo_fiscal: saldoFiscal,
    saldo_nao_fiscal: 0,
    estoque_atual: saldoFiscal
  }, { db });
}

async function ee(db, produtoId, empresaId) {
  return get(
    db,
    'SELECT * FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?',
    [produtoId, empresaId]
  );
}

async function setupAcai() {
  const ctx = await setupBase();
  const { db, empresaA, empresaB } = ctx;
  const comercialId = await criarProduto(db, 'Açaí 300 ml', 'COMERCIAL', 'UN', 50);
  const insumoId = await criarProduto(db, 'Açaí base', 'INSUMO', 'L', 100);
  await estoque(db, comercialId, empresaA.id, 50);
  await estoque(db, comercialId, empresaB.id, 50);
  await estoque(db, insumoId, empresaA.id, 100);
  await estoque(db, insumoId, empresaB.id, 200);
  await FichaTecnicaService.salvar(comercialId, {
    ativo: 1,
    itens: [{ insumo_id: insumoId, quantidade: 300, unidade: 'ML' }]
  }, { db });
  const vendaA = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
  const vendaB = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaB.id]);
  return { ...ctx, comercialId, insumoId, vendaA: vendaA.lastID, vendaB: vendaB.lastID };
}

async function setupPastel() {
  const ctx = await setupBase();
  const { db, empresaA } = ctx;
  const comercialId = await criarProduto(db, 'Pastel', 'COMERCIAL', 'UN', 40);
  const massaId = await criarProduto(db, 'Massa', 'INSUMO', 'UN', 100);
  const carneId = await criarProduto(db, 'Carne', 'INSUMO', 'G', 1000);
  const oleoId = await criarProduto(db, 'Óleo', 'INSUMO', 'ML', 500);
  await estoque(db, comercialId, empresaA.id, 40);
  await estoque(db, massaId, empresaA.id, 100);
  await estoque(db, carneId, empresaA.id, 1000);
  await estoque(db, oleoId, empresaA.id, 500);
  await FichaTecnicaService.salvar(comercialId, {
    ativo: 1,
    itens: [
      { insumo_id: massaId, quantidade: 1, unidade: 'UN' },
      { insumo_id: carneId, quantidade: 80, unidade: 'G' },
      { insumo_id: oleoId, quantidade: 10, unidade: 'ML' }
    ]
  }, { db });
  const venda = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
  return { ...ctx, comercialId, massaId, carneId, oleoId, vendaId: venda.lastID };
}

async function t01ProdutoComFichaConsome() {
  const { db, comercialId, insumoId, empresaA, vendaA } = await setupAcai();
  const r = await consumirFichaTecnicaDaVenda({
    vendaId: vendaA,
    empresaId: empresaA.id,
    itens: [{ produto_id: comercialId, quantidade: 1 }],
    db
  });
  assert.strictEqual(r.consumido, true);
  const a = await ee(db, insumoId, empresaA.id);
  assert.strictEqual(Number(a.saldo_fiscal), 99.7);
  await closeDb(db);
}

async function t02QuantidadeMultiplica() {
  const { db, comercialId, insumoId, empresaA, vendaA } = await setupAcai();
  await consumirFichaTecnicaDaVenda({
    vendaId: vendaA,
    empresaId: empresaA.id,
    itens: [{ produto_id: comercialId, quantidade: 2 }],
    db
  });
  const a = await ee(db, insumoId, empresaA.id);
  assert.strictEqual(Number(a.saldo_fiscal), 99.4);
  await closeDb(db);
}

async function t03SemFichaVende() {
  const ctx = await setupBase();
  const { db, empresaA } = ctx;
  const id = await criarProduto(db, 'Água', 'COMERCIAL', 'UN', 10);
  await estoque(db, id, empresaA.id, 10);
  const venda = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
  const r = await consumirFichaTecnicaDaVenda({
    vendaId: venda.lastID,
    empresaId: empresaA.id,
    itens: [{ produto_id: id, quantidade: 1 }],
    db
  });
  assert.strictEqual(r.consumido, false);
  await closeDb(db);
}

function t04InsumoNaoVendavel() {
  assert.throws(
    () => exigirProdutosVendaveisNaVenda([{ id: 1, tipo_operacional: 'INSUMO' }]),
    (e) => e.code === 'INSUMO_NAO_VENDAVEL'
  );
}

async function t05VendaAConsomeA() {
  const { db, comercialId, insumoId, empresaA, vendaA } = await setupAcai();
  await consumirFichaTecnicaDaVenda({
    vendaId: vendaA, empresaId: empresaA.id,
    itens: [{ produto_id: comercialId, quantidade: 1 }], db
  });
  const a = await ee(db, insumoId, empresaA.id);
  assert.ok(Number(a.saldo_fiscal) < 100);
  await closeDb(db);
}

async function t06VendaBConsomeB() {
  const { db, comercialId, insumoId, empresaB, vendaB } = await setupAcai();
  await consumirFichaTecnicaDaVenda({
    vendaId: vendaB, empresaId: empresaB.id,
    itens: [{ produto_id: comercialId, quantidade: 1 }], db
  });
  const b = await ee(db, insumoId, empresaB.id);
  assert.ok(Number(b.saldo_fiscal) < 200);
  await closeDb(db);
}

async function t07ANaoConsomeB() {
  const { db, comercialId, insumoId, empresaA, empresaB, vendaA } = await setupAcai();
  const bAntes = await ee(db, insumoId, empresaB.id);
  await consumirFichaTecnicaDaVenda({
    vendaId: vendaA, empresaId: empresaA.id,
    itens: [{ produto_id: comercialId, quantidade: 2 }], db
  });
  const b = await ee(db, insumoId, empresaB.id);
  assert.strictEqual(Number(b.saldo_fiscal), Number(bAntes.saldo_fiscal));
  await closeDb(db);
}

async function t08BNaoConsomeA() {
  const { db, comercialId, insumoId, empresaA, empresaB, vendaB } = await setupAcai();
  const aAntes = await ee(db, insumoId, empresaA.id);
  await consumirFichaTecnicaDaVenda({
    vendaId: vendaB, empresaId: empresaB.id,
    itens: [{ produto_id: comercialId, quantidade: 2 }], db
  });
  const a = await ee(db, insumoId, empresaA.id);
  assert.strictEqual(Number(a.saldo_fiscal), Number(aAntes.saldo_fiscal));
  await closeDb(db);
}

async function t09DoisComponentes() {
  const ctx = await setupBase();
  const { db, empresaA } = ctx;
  const comercialId = await criarProduto(db, 'Combo', 'COMERCIAL', 'UN', 10);
  const a = await criarProduto(db, 'Insumo A', 'INSUMO', 'UN', 50);
  const b = await criarProduto(db, 'Insumo B', 'INSUMO', 'UN', 50);
  await estoque(db, comercialId, empresaA.id, 10);
  await estoque(db, a, empresaA.id, 50);
  await estoque(db, b, empresaA.id, 50);
  await FichaTecnicaService.salvar(comercialId, {
    ativo: 1,
    itens: [
      { insumo_id: a, quantidade: 1, unidade: 'UN' },
      { insumo_id: b, quantidade: 2, unidade: 'UN' }
    ]
  }, { db });
  const venda = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
  await consumirFichaTecnicaDaVenda({
    vendaId: venda.lastID, empresaId: empresaA.id,
    itens: [{ produto_id: comercialId, quantidade: 3 }], db
  });
  assert.strictEqual(Number((await ee(db, a, empresaA.id)).saldo_fiscal), 47);
  assert.strictEqual(Number((await ee(db, b, empresaA.id)).saldo_fiscal), 44);
  await closeDb(db);
}

async function t10TresComponentes() {
  const { db, comercialId, massaId, carneId, oleoId, empresaA, vendaId } = await setupPastel();
  await consumirFichaTecnicaDaVenda({
    vendaId, empresaId: empresaA.id,
    itens: [{ produto_id: comercialId, quantidade: 3 }], db
  });
  assert.strictEqual(Number((await ee(db, massaId, empresaA.id)).saldo_fiscal), 97);
  assert.strictEqual(Number((await ee(db, carneId, empresaA.id)).saldo_fiscal), 760);
  assert.strictEqual(Number((await ee(db, oleoId, empresaA.id)).saldo_fiscal), 470);
  await closeDb(db);
}

async function t11FichaInativa() {
  const { db, comercialId, insumoId, empresaA, vendaA } = await setupAcai();
  await FichaTecnicaService.salvar(comercialId, {
    ativo: 0,
    itens: [{ insumo_id: insumoId, quantidade: 300, unidade: 'ML' }]
  }, { db });
  const aAntes = await ee(db, insumoId, empresaA.id);
  const r = await consumirFichaTecnicaDaVenda({
    vendaId: vendaA, empresaId: empresaA.id,
    itens: [{ produto_id: comercialId, quantidade: 1 }], db
  });
  assert.strictEqual(r.consumido, false);
  const a = await ee(db, insumoId, empresaA.id);
  assert.strictEqual(Number(a.saldo_fiscal), Number(aAntes.saldo_fiscal));
  await closeDb(db);
}

async function t12InsumoInativoBloqueia() {
  const { db, comercialId, insumoId, empresaA, vendaA } = await setupAcai();
  await run(db, 'UPDATE produtos SET ativo = 0 WHERE id = ?', [insumoId]);
  const aAntes = await ee(db, insumoId, empresaA.id);
  await assert.rejects(
    () => consumirFichaTecnicaDaVenda({
      vendaId: vendaA, empresaId: empresaA.id,
      itens: [{ produto_id: comercialId, quantidade: 1 }], db
    }),
    (e) => e.code === 'FICHA_INSUMO_INATIVO'
  );
  const a = await ee(db, insumoId, empresaA.id);
  assert.strictEqual(Number(a.saldo_fiscal), Number(aAntes.saldo_fiscal));
  await closeDb(db);
}

async function t13QuantidadeInvalida() {
  const ctx = await setupBase();
  const { db, empresaA } = ctx;
  const comercialId = await criarProduto(db, 'X', 'COMERCIAL', 'UN', 10);
  const insumoId = await criarProduto(db, 'Y', 'INSUMO', 'UN', 10);
  await estoque(db, comercialId, empresaA.id, 10);
  await estoque(db, insumoId, empresaA.id, 10);
  await FichaTecnicaService.salvar(comercialId, {
    ativo: 1,
    itens: [{ insumo_id: insumoId, quantidade: 1, unidade: 'UN' }]
  }, { db });
  await run(db, 'UPDATE ficha_tecnica_itens SET quantidade = 0');
  const venda = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
  await assert.rejects(
    () => consumirFichaTecnicaDaVenda({
      vendaId: venda.lastID, empresaId: empresaA.id,
      itens: [{ produto_id: comercialId, quantidade: 1 }], db
    }),
    (e) => e.code === 'FICHA_QUANTIDADE_INVALIDA'
  );
  await closeDb(db);
}

function t14ConversaoMlLitro() {
  const { obterMuc } = require('../../backend/motores/muc/public');
  const muc = obterMuc(null);
  assert.strictEqual(muc.converterQuantidade({ quantidade: 200, unidadeOrigem: 'ML', unidadeDestino: 'L' }).quantidade, 0.2);
  assert.strictEqual(muc.converterQuantidade({ quantidade: 600, unidadeOrigem: 'ML', unidadeDestino: 'L' }).quantidade, 0.6);
  assert.ok(src('backend/services/produtos/FichaTecnicaConsumoService.js').includes('converterQuantidade'));
}

async function t15ConversaoInvalidaBloqueia() {
  const ctx = await setupBase();
  const { db, empresaA } = ctx;
  const comercialId = await criarProduto(db, 'X', 'COMERCIAL', 'UN', 10);
  const insumoId = await criarProduto(db, 'Farinha', 'INSUMO', 'KG', 10);
  await estoque(db, comercialId, empresaA.id, 10);
  await estoque(db, insumoId, empresaA.id, 10);
  await FichaTecnicaService.salvar(comercialId, {
    ativo: 1,
    itens: [{ insumo_id: insumoId, quantidade: 200, unidade: 'ML' }]
  }, { db });
  const venda = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
  const aAntes = await ee(db, insumoId, empresaA.id);
  await assert.rejects(
    () => consumirFichaTecnicaDaVenda({
      vendaId: venda.lastID, empresaId: empresaA.id,
      itens: [{ produto_id: comercialId, quantidade: 1 }], db
    }),
    (e) => e.code === 'CONVERSAO_INVALIDA'
  );
  const a = await ee(db, insumoId, empresaA.id);
  assert.strictEqual(Number(a.saldo_fiscal), Number(aAntes.saldo_fiscal));
  await closeDb(db);
}

async function t16EstoqueInsuficiente() {
  const { db, comercialId, insumoId, empresaA, vendaA } = await setupAcai();
  await run(
    db,
    `UPDATE estoque_empresa SET saldo_fiscal = 0.1, estoque_atual = 0.1
     WHERE produto_id = ? AND empresa_id = ?`,
    [insumoId, empresaA.id]
  );
  const aAntes = await ee(db, insumoId, empresaA.id);
  await assert.rejects(
    () => consumirFichaTecnicaDaVenda({
      vendaId: vendaA, empresaId: empresaA.id,
      itens: [{ produto_id: comercialId, quantidade: 2 }], db
    }),
    (e) => e.code === 'SALDO_INSUFICIENTE'
  );
  const a = await ee(db, insumoId, empresaA.id);
  assert.strictEqual(Number(a.saldo_fiscal), Number(aAntes.saldo_fiscal));
  await closeDb(db);
}

async function t17FalhaSemParcial() {
  const ctx = await setupBase();
  const { db, empresaA } = ctx;
  const comercialId = await criarProduto(db, 'Combo', 'COMERCIAL', 'UN', 10);
  const okId = await criarProduto(db, 'Ok', 'INSUMO', 'UN', 50);
  const falhaId = await criarProduto(db, 'Falta', 'INSUMO', 'UN', 50);
  await estoque(db, comercialId, empresaA.id, 10);
  await estoque(db, okId, empresaA.id, 50);
  await estoque(db, falhaId, empresaA.id, 0);
  await FichaTecnicaService.salvar(comercialId, {
    ativo: 1,
    itens: [
      { insumo_id: okId, quantidade: 1, unidade: 'UN' },
      { insumo_id: falhaId, quantidade: 1, unidade: 'UN' }
    ]
  }, { db });
  const venda = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
  await assert.rejects(
    () => consumirFichaTecnicaDaVenda({
      vendaId: venda.lastID, empresaId: empresaA.id,
      itens: [{ produto_id: comercialId, quantidade: 1 }], db
    }),
    (e) => e.code === 'SALDO_INSUFICIENTE'
  );
  assert.strictEqual(Number((await ee(db, okId, empresaA.id)).saldo_fiscal), 50);
  assert.strictEqual(Number((await ee(db, falhaId, empresaA.id)).saldo_fiscal), 0);
  await closeDb(db);
}

function t18UmaUnicaVenda() {
  const consumo = src('backend/services/produtos/FichaTecnicaConsumoService.js');
  assert.ok(!/INSERT INTO vendas\b/i.test(consumo));
  assert.ok(!consumo.includes('financeiro'));
}

function t19SemFinanceiro() {
  const consumo = src('backend/services/produtos/FichaTecnicaConsumoService.js');
  assert.ok(!/INSERT INTO financeiro/i.test(consumo));
  assert.ok(!/contas_receber/i.test(consumo));
}

function t20SemCaixa() {
  const consumo = src('backend/services/produtos/FichaTecnicaConsumoService.js');
  assert.ok(!/caixa/i.test(consumo));
}

function t21SemMuv() {
  const consumo = src('backend/services/produtos/FichaTecnicaConsumoService.js');
  const nucleo = src('backend/services/vendas/VendaPagamentoService.js');
  assert.ok(!/criarAtendimento/.test(consumo));
  assert.ok(nucleo.includes('aposBaixaItensDaVenda'));
}

function t22NucleoOficial() {
  const nucleo = src('backend/services/vendas/VendaPagamentoService.js');
  assert.ok(nucleo.includes('FichaTecnicaConsumoService'));
  assert.ok(nucleo.includes('consumirFichaTecnicaDaVendaCb'));
  assert.ok(nucleo.includes('empresaIdVenda'));
}

async function t23EmpresaIdDaVenda() {
  const { db, comercialId, empresaA, vendaA } = await setupAcai();
  const r = await consumirFichaTecnicaDaVenda({
    vendaId: vendaA, empresaId: empresaA.id,
    itens: [{ produto_id: comercialId, quantidade: 1 }], db
  });
  assert.strictEqual(Number(r.empresa_id), Number(empresaA.id));
  const cab = await get(db, 'SELECT empresa_id FROM venda_ficha_consumo WHERE venda_id = ?', [vendaA]);
  assert.strictEqual(Number(cab.empresa_id), Number(empresaA.id));
  await closeDb(db);
}

function t24SemContexto() {
  assert.throws(
    () => exigirEmpresaDaOperacao({}),
    (e) => e.code === CODIGO_EMPRESA_CONTEXT_REQUIRED
  );
}

async function t25ANaoAlteraB() {
  await t07ANaoConsomeB();
}

async function t26BNaoAlteraA() {
  await t08BNaoConsomeA();
}

function t27PdvNormalOficial() {
  assert.ok(src('frontend/pdv/js/pdv.js').includes('/vendas') || src('frontend/pdv/js/pdv.js').includes('API_URL'));
  assert.ok(!/pdv-universal/i.test(src('frontend/pdv/js/pdv.js')));
}

function t28UniversalNaoAcionado() {
  const nucleo = src('backend/services/vendas/VendaPagamentoService.js');
  assert.ok(!/pdv-universal/i.test(nucleo));
  assert.ok(!src('backend/services/produtos/FichaTecnicaConsumoService.js').includes('pdv-universal'));
}

function t29NaTransacao() {
  const nucleo = src('backend/services/vendas/VendaPagamentoService.js');
  assert.ok(nucleo.includes("db.run('BEGIN IMMEDIATE')"));
  const iBegin = nucleo.indexOf("db.run('BEGIN IMMEDIATE')");
  const iCall = nucleo.lastIndexOf('aposBaixaItensDaVenda(vendaId');
  assert.ok(iBegin > 0 && iCall > iBegin);
}

async function t30SemDuplicar() {
  const { db, comercialId, insumoId, empresaA, vendaA } = await setupAcai();
  await consumirFichaTecnicaDaVenda({
    vendaId: vendaA, empresaId: empresaA.id,
    itens: [{ produto_id: comercialId, quantidade: 1 }], db
  });
  const aMeio = await ee(db, insumoId, empresaA.id);
  const r2 = await consumirFichaTecnicaDaVenda({
    vendaId: vendaA, empresaId: empresaA.id,
    itens: [{ produto_id: comercialId, quantidade: 1 }], db
  });
  assert.strictEqual(r2.ja_consumido, true);
  const a = await ee(db, insumoId, empresaA.id);
  assert.strictEqual(Number(a.saldo_fiscal), Number(aMeio.saldo_fiscal));
  await closeDb(db);
}

async function t31CompartilhadoA() {
  await t05VendaAConsomeA();
}

async function t32CompartilhadoB() {
  await t06VendaBConsomeB();
}

function arquivosConsumo() {
  return [
    'backend/services/produtos/FichaTecnicaConsumoService.js',
    'backend/services/produtos/vendaFichaConsumoSchema.js'
  ];
}

function t33SemEmpresa1() {
  for (const rel of arquivosConsumo()) {
    const t = src(rel);
    assert.ok(!/empresaId\s*=\s*1\b/.test(t), rel);
    assert.ok(!/empresa_id\s*=\s*1\b/.test(t), rel);
  }
}

function t34SemPrimeiraEmpresa() {
  for (const rel of arquivosConsumo()) {
    assert.ok(!/primeira empresa/i.test(src(rel)), rel);
  }
}

function t35SemCompat() {
  for (const rel of arquivosConsumo()) {
    assert.ok(!/\bCOMPAT\b/.test(src(rel)), rel);
  }
  assert.ok(!src('backend/services/produtos/FichaTecnicaConsumoService.js').includes('empresa_operacional_id'));
  void ModoOperacionalGlobal;
}

async function main() {
  const casos = [
    ['T01 Produto com ficha gera consumo', t01ProdutoComFichaConsome],
    ['T02 Quantidade multiplica a ficha', t02QuantidadeMultiplica],
    ['T03 Sem ficha continua vendendo', t03SemFichaVende],
    ['T04 Insumo não vendável', t04InsumoNaoVendavel],
    ['T05 Venda A consome estoque A', t05VendaAConsomeA],
    ['T06 Venda B consome estoque B', t06VendaBConsomeB],
    ['T07 Venda A não consome B', t07ANaoConsomeB],
    ['T08 Venda B não consome A', t08BNaoConsomeA],
    ['T09 Dois componentes', t09DoisComponentes],
    ['T10 Três componentes', t10TresComponentes],
    ['T11 Ficha inativa não consome', t11FichaInativa],
    ['T12 Insumo inativo sem parcial', t12InsumoInativoBloqueia],
    ['T13 Quantidade inválida bloqueia', t13QuantidadeInvalida],
    ['T14 Conversão ml/litro', t14ConversaoMlLitro],
    ['T15 Conversão inválida bloqueia', t15ConversaoInvalidaBloqueia],
    ['T16 Estoque insuficiente bloqueia', t16EstoqueInsuficiente],
    ['T17 Falha sem baixa parcial', t17FalhaSemParcial],
    ['T18 Uma única venda', t18UmaUnicaVenda],
    ['T19 Sem lançamento financeiro', t19SemFinanceiro],
    ['T20 Sem recebimento de caixa', t20SemCaixa],
    ['T21 Sem MUV', t21SemMuv],
    ['T22 VendaPagamentoService', t22NucleoOficial],
    ['T23 empresa_id da venda', t23EmpresaIdDaVenda],
    ['T24 MULTI sem contexto', t24SemContexto],
    ['T25 A não altera B', t25ANaoAlteraB],
    ['T26 B não altera A', t26BNaoAlteraA],
    ['T27 PDV Normal oficial', t27PdvNormalOficial],
    ['T28 Universal não acionado', t28UniversalNaoAcionado],
    ['T29 Consumo na transação', t29NaTransacao],
    ['T30 Sem consumo duplicado', t30SemDuplicar],
    ['T31 Produto compartilhado em A', t31CompartilhadoA],
    ['T32 Mesmo produto em B', t32CompartilhadoB],
    ['T33 Sem fallback empresa 1', t33SemEmpresa1],
    ['T34 Sem primeira empresa', t34SemPrimeiraEmpresa],
    ['T35 Sem COMPAT', t35SemCompat]
  ];

  let falhas = 0;
  for (const [nome, fn] of casos) {
    try {
      await fn();
      console.log('OK', nome);
    } catch (err) {
      falhas += 1;
      console.error('FAIL', nome, err && err.stack ? err.message : err);
      if (err && err.message) console.error(err.stack.split('\n').slice(0, 4).join('\n'));
    }
  }
  console.log(`${casos.length - falhas}/${casos.length}`);
  if (falhas) process.exit(1);
}

main();
