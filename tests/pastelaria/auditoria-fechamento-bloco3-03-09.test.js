/**
 * Sprint 03.09 — Auditoria de fechamento do Bloco 3 (Operação Pastelaria).
 * Sem implementação funcional. Executar:
 *   node tests/pastelaria/auditoria-fechamento-bloco3-03-09.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
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
  consumirFichaTecnicaDaVenda,
  estornarConsumoFichaTecnicaDaDevolucao,
  estornarConsumoFichaTecnicaDaVenda
} = require('../../backend/services/produtos/FichaTecnicaConsumoService');
const { creditarEstoqueItemVenda } = require('../../backend/services/vendas/creditoEstoqueVendaViaPorta');
const { exigirOperacaoReversaoDaVenda } = require('../../backend/services/vendas/VendaEmpresaContextoService');
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
  await run(db, `CREATE TABLE produtos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT, ativo INTEGER DEFAULT 1,
    unidade TEXT DEFAULT 'UN', tipo_operacional TEXT NOT NULL DEFAULT 'COMERCIAL',
    saldo_fiscal REAL DEFAULT 0, saldo_nao_fiscal REAL DEFAULT 0, estoque_atual REAL DEFAULT 0,
    reservado_fiscal REAL DEFAULT 0, reservado_nao_fiscal REAL DEFAULT 0,
    controla_estoque INTEGER DEFAULT 1, updated_at DATETIME
  )`);
  await run(db, `CREATE TABLE vendas (
    id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER,
    status TEXT DEFAULT 'concluida', cancelada INTEGER DEFAULT 0
  )`);
  await run(db, `CREATE TABLE vendas_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT, venda_id INTEGER, produto_id INTEGER, quantidade REAL
  )`);
  await garantirColunaTipoOperacionalAsync(db);
  await garantirSchemaFichaTecnicaAsync(db);
  await garantirSchemaVendaFichaConsumoAsync(db);
  const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  return { db, empresaA, empresaB };
}

async function criarProduto(db, nome, tipo, unidade, saldo) {
  const ins = await run(
    db,
    `INSERT INTO produtos (nome, tipo_operacional, unidade, saldo_fiscal, saldo_nao_fiscal, estoque_atual)
     VALUES (?, ?, ?, ?, 0, ?)`,
    [nome, tipo, unidade, saldo, saldo]
  );
  return ins.lastID;
}

async function estoque(db, produtoId, empresaId, saldoFiscal) {
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId, saldo_fiscal: saldoFiscal, saldo_nao_fiscal: 0, estoque_atual: saldoFiscal
  }, { db });
}

async function ee(db, produtoId, empresaId) {
  return get(db, 'SELECT * FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?', [produtoId, empresaId]);
}

async function setupPastel() {
  const ctx = await setupBase();
  const { db, empresaA, empresaB } = ctx;
  const comercialId = await criarProduto(db, 'Pastel', 'COMERCIAL', 'UN', 40);
  const queijoId = await criarProduto(db, 'Queijo', 'INSUMO', 'KG', 20);
  await estoque(db, comercialId, empresaA.id, 40);
  await estoque(db, comercialId, empresaB.id, 40);
  await estoque(db, queijoId, empresaA.id, 10);
  await estoque(db, queijoId, empresaB.id, 20);
  await FichaTecnicaService.salvar(comercialId, {
    ativo: 1,
    itens: [{ insumo_id: queijoId, quantidade: 100, unidade: 'G' }]
  }, { db });
  const vendaA = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
  const vendaB = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaB.id]);
  await run(db, 'INSERT INTO vendas_itens (venda_id, produto_id, quantidade) VALUES (?, ?, ?)', [
    vendaA.lastID, comercialId, 10
  ]);
  await run(db, 'INSERT INTO vendas_itens (venda_id, produto_id, quantidade) VALUES (?, ?, ?)', [
    vendaB.lastID, comercialId, 10
  ]);
  return { ...ctx, comercialId, queijoId, vendaA: vendaA.lastID, vendaB: vendaB.lastID };
}

const pagSrc = src('backend/services/vendas/VendaPagamentoService.js');
const appSrc = src('backend/services/vendas/VendaApplicationService.js');
const consSrc = src('backend/services/produtos/FichaTecnicaConsumoService.js');
const cancelSrc = src('backend/services/vendas/VendaCancelamentoService.js');
const devolSrc = src('backend/services/vendas/VendaDevolucaoService.js');
const fichaSchema = src('backend/services/produtos/fichaTecnicaSchema.js');
const tipoSrc = src('backend/services/produtos/tipoOperacionalProduto.js');
const polSimples = src('backend/core/modo-operacional/PoliticaEmpresaSimples.js');
const polMulti = src('backend/core/modo-operacional/PoliticaMultiempresa.js');
const pdvUni = src('backend/rotas/pdv-universal.js');
const pdvSrc = src('frontend/pdv/js/pdv.js');
const rotasVendas = src('backend/rotas/vendas.js');
const rotasProd = src('backend/rotas/produtos.js');
const ranking = src('backend/services/reportFiscalHelpers.js');
const saldoPub = src('backend/services/fiscalNaoFiscal/estoqueSaldosPublico.js');
const fiscalRotas = src('backend/rotas/fiscal.js');
const centro = src('frontend/erp/js/cds-centro-configuracoes.js');

describe('03.09 invariantes de código', () => {
  it('T01 — PDV Normal oficial; Universal congelado', () => {
    assert.match(pdvSrc, /url:\s*`\$\{API_URL\}\/vendas`/);
    assert.match(pdvUni, /CONGELADO/);
    assert.doesNotMatch(consSrc, /pdv-universal|PDVUniversal/);
    assert.doesNotMatch(pagSrc, /require\('\.\.\/\.\.\/motores\/pdv-universal/);
  });

  it('T02 — modos EMPRESA_SIMPLES e MULTIEMPRESA', () => {
    assert.equal(ModoOperacionalGlobal.EMPRESA_SIMPLES, 'EMPRESA_SIMPLES');
    assert.equal(ModoOperacionalGlobal.MULTIEMPRESA, 'MULTIEMPRESA');
    assert.match(polSimples, /múltiplas empresas ativas exige empresa_operacional_id/);
    assert.match(polMulti, /function resolverEmpresaOperacionalContrato\(\) \{\s*return null;/);
  });

  it('T03 — COMERCIAL / INSUMO; insumo não vendável; ficha sem empresa_id', () => {
    assert.match(tipoSrc, /COMERCIAL/);
    assert.match(tipoSrc, /INSUMO/);
    assert.match(tipoSrc, /INSUMO_NAO_VENDAVEL/);
    assert.match(fichaSchema, /CREATE TABLE IF NOT EXISTS ficha_tecnica/);
    assert.doesNotMatch(fichaSchema, /ficha_tecnica\s*\([^)]*empresa_id/);
    assert.match(rotasProd, /ficha-tecnica/);
  });

  it('T04 — venda oficial POST → PagamentoService; empresa da venda', () => {
    assert.match(appSrc, /VendaPagamentoService\.criarVenda/);
    assert.match(pagSrc, /INSERT INTO vendas/);
    assert.match(pagSrc, /empresaIdVenda/);
    assert.match(rotasVendas, /router\.post\('\/', validarCaixaSeOrigemPdv, criarVenda\)/);
    assert.doesNotMatch(pagSrc, /empresaId\s*\|\|\s*1/);
  });

  it('T05 — consumo na transação; cancelamento e devolução estornam snapshot', () => {
    assert.match(pagSrc, /consumirFichaTecnicaDaVendaCb/);
    assert.match(pagSrc, /fichaErr[\s\S]{0,80}ROLLBACK/);
    assert.match(consSrc, /exigirEmpresa: true/);
    assert.match(cancelSrc, /estornarConsumoFichaTecnicaDaVendaCb/);
    assert.match(devolSrc, /estornarConsumoFichaTecnicaDaDevolucaoCb/);
    assert.match(consSrc, /quantidadeDevolvida[\s\S]{0,80}quantidadeVendida|qtdDev \/ qtdVendida/);
  });

  it('T06 — APIs oficiais de operação; ranking MIS sem empresa (não P0)', () => {
    assert.match(rotasVendas, /\/:id\/devolver/);
    assert.match(rotasVendas, /\/:id\/cancelar/);
    assert.match(fiscalRotas, /\/api\/fiscal|router\.(get|post)/);
    assert.match(ranking, /function sqlRankingProdutos/);
    assert.doesNotMatch(ranking.slice(ranking.indexOf('function sqlRankingProdutos'), ranking.indexOf('function sqlRankingProdutos') + 900), /v\.empresa_id/);
    assert.match(rotasProd, /ultimas-compras/);
    assert.doesNotMatch(rotasProd.slice(rotasProd.indexOf('ultimas-compras'), rotasProd.indexOf('ultimas-compras') + 900), /c\.empresa_id/);
  });

  it('T07 — dual-write documentado; consulta empresarial em estoque_empresa', () => {
    assert.match(saldoPub, /dual-write em `estoque_empresa`/);
    assert.match(saldoPub, /Com empresaId: `estoque_empresa`/);
    assert.match(saldoPub, /UPDATE produtos/);
  });

  it('T08 — fiscal empresarial; Plataforma Fiscal não é categoria do Centro', () => {
    assert.match(centro, /cfgEmpresaOperacionalId/);
    assert.doesNotMatch(centro, /data-cfg-cat="plataformaFiscal"/);
    assert.match(fiscalRotas, /config|nfce|NFC/i);
  });

  it('T09 — sem cubas/açaí no consumo da ficha', () => {
    assert.doesNotMatch(consSrc, /cuba|açaí|acai|topping/i);
  });
});

describe('03.09 ciclo e isolamento', () => {
  it('T10 — ciclo: venda → consumo → 2 devoluções → cancelamento do restante', async () => {
    const { db, comercialId, queijoId, empresaA, vendaA } = await setupPastel();
    await consumirFichaTecnicaDaVenda({
      vendaId: vendaA, empresaId: empresaA.id,
      itens: [{ produto_id: comercialId, quantidade: 10 }], db
    });
    assert.equal(Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal), 9);
    await estornarConsumoFichaTecnicaDaDevolucao({
      vendaId: vendaA, empresaId: empresaA.id, produtoId: comercialId,
      quantidadeDevolvida: 3, quantidadeVendida: 10, vendaDevolucaoId: 1, db
    });
    assert.equal(Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal), 9.3);
    await estornarConsumoFichaTecnicaDaDevolucao({
      vendaId: vendaA, empresaId: empresaA.id, produtoId: comercialId,
      quantidadeDevolvida: 2, quantidadeVendida: 10, vendaDevolucaoId: 2, db
    });
    assert.equal(Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal), 9.5);
    await estornarConsumoFichaTecnicaDaVenda({ vendaId: vendaA, empresaId: empresaA.id, db });
    assert.equal(Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal), 10);
    await closeDb(db);
  });

  it('T11 — A não altera B (venda/consumo/devolução/cancelamento)', async () => {
    const { db, comercialId, queijoId, empresaA, empresaB, vendaA, vendaB } = await setupPastel();
    await consumirFichaTecnicaDaVenda({
      vendaId: vendaA, empresaId: empresaA.id,
      itens: [{ produto_id: comercialId, quantidade: 10 }], db
    });
    await consumirFichaTecnicaDaVenda({
      vendaId: vendaB, empresaId: empresaB.id,
      itens: [{ produto_id: comercialId, quantidade: 10 }], db
    });
    await estornarConsumoFichaTecnicaDaDevolucao({
      vendaId: vendaA, empresaId: empresaA.id, produtoId: comercialId,
      quantidadeDevolvida: 4, quantidadeVendida: 10, vendaDevolucaoId: 11, db
    });
    await estornarConsumoFichaTecnicaDaVenda({ vendaId: vendaA, empresaId: empresaA.id, db });
    assert.equal(Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal), 10);
    assert.equal(Number((await ee(db, queijoId, empresaB.id)).saldo_fiscal), 19);
    await closeDb(db);
  });

  it('T12 — snapshot 80 g resiste a ficha 120 g na devolução e no cancelamento', async () => {
    const ctx = await setupBase();
    const { db, empresaA } = ctx;
    const comercialId = await criarProduto(db, 'Pastel', 'COMERCIAL', 'UN', 20);
    const queijoId = await criarProduto(db, 'Queijo', 'INSUMO', 'KG', 10);
    await estoque(db, comercialId, empresaA.id, 20);
    await estoque(db, queijoId, empresaA.id, 10);
    await FichaTecnicaService.salvar(comercialId, {
      ativo: 1,
      itens: [{ insumo_id: queijoId, quantidade: 80, unidade: 'G' }]
    }, { db });
    const venda = await run(db, 'INSERT INTO vendas (empresa_id) VALUES (?)', [empresaA.id]);
    await run(db, 'INSERT INTO vendas_itens (venda_id, produto_id, quantidade) VALUES (?, ?, ?)', [
      venda.lastID, comercialId, 5
    ]);
    await consumirFichaTecnicaDaVenda({
      vendaId: venda.lastID, empresaId: empresaA.id,
      itens: [{ produto_id: comercialId, quantidade: 5 }], db
    });
    const snap = await get(db, 'SELECT quantidade FROM venda_ficha_consumo_itens WHERE venda_id = ?', [venda.lastID]);
    await FichaTecnicaService.salvar(comercialId, {
      ativo: 1,
      itens: [{ insumo_id: queijoId, quantidade: 120, unidade: 'G' }]
    }, { db });
    const r = await estornarConsumoFichaTecnicaDaDevolucao({
      vendaId: venda.lastID, empresaId: empresaA.id, produtoId: comercialId,
      quantidadeDevolvida: 2, quantidadeVendida: 5, vendaDevolucaoId: 21, db
    });
    assert.equal(Number(snap.quantidade), 0.4);
    assert.equal(Number(r.itens[0].quantidade), 0.16);
    await estornarConsumoFichaTecnicaDaVenda({
      vendaId: venda.lastID, empresaId: empresaA.id, db
    });
    assert.equal(Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal), 10);
    await closeDb(db);
  });

  it('T13 — idempotência: segundo cancelamento e mesma devolução', async () => {
    const { db, comercialId, queijoId, empresaA, vendaA } = await setupPastel();
    await consumirFichaTecnicaDaVenda({
      vendaId: vendaA, empresaId: empresaA.id,
      itens: [{ produto_id: comercialId, quantidade: 10 }], db
    });
    await estornarConsumoFichaTecnicaDaDevolucao({
      vendaId: vendaA, empresaId: empresaA.id, produtoId: comercialId,
      quantidadeDevolvida: 2, quantidadeVendida: 10, vendaDevolucaoId: 31, db
    });
    const r2 = await estornarConsumoFichaTecnicaDaDevolucao({
      vendaId: vendaA, empresaId: empresaA.id, produtoId: comercialId,
      quantidadeDevolvida: 2, quantidadeVendida: 10, vendaDevolucaoId: 31, db
    });
    assert.equal(r2.ja_estornado, true);
    await estornarConsumoFichaTecnicaDaVenda({ vendaId: vendaA, empresaId: empresaA.id, db });
    const r3 = await estornarConsumoFichaTecnicaDaVenda({ vendaId: vendaA, empresaId: empresaA.id, db });
    assert.equal(r3.ja_estornado, true);
    assert.equal(Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal), 10);
    await closeDb(db);
  });

  it('T14 — rollback de devolução e cross-company', async () => {
    const { db, comercialId, queijoId, empresaA, empresaB, vendaA } = await setupPastel();
    await consumirFichaTecnicaDaVenda({
      vendaId: vendaA, empresaId: empresaA.id,
      itens: [{ produto_id: comercialId, quantidade: 10 }], db
    });
    const apos = Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal);
    const venda = await get(db, 'SELECT * FROM vendas WHERE id = ?', [vendaA]);
    assert.throws(
      () => exigirOperacaoReversaoDaVenda(venda, empresaB.id),
      (e) => e.code === 'VENDA_NAO_ENCONTRADA'
    );
    await run(db, 'BEGIN IMMEDIATE');
    try {
      await estornarConsumoFichaTecnicaDaDevolucao({
        vendaId: vendaA, empresaId: empresaA.id, produtoId: comercialId,
        quantidadeDevolvida: 1, quantidadeVendida: 10, vendaDevolucaoId: 41, db
      }, { creditarEstoqueItemVenda: (_c, _d, cb) => cb(new Error('falha auditoria')) });
    } catch (_e) { /* esperado */ }
    await run(db, 'ROLLBACK');
    assert.equal(Number((await ee(db, queijoId, empresaA.id)).saldo_fiscal), apos);
    assert.equal(Number((await ee(db, queijoId, empresaB.id)).saldo_fiscal), 20);
    await closeDb(db);
  });
});
