/**
 * Sprint 03.03 — Fundação de produtos e ficha técnica da Pastelaria.
 * Executar: node tests/pastelaria/fundacao-produtos-ficha-tecnica-03-03.test.js
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
const FichaTecnicaService = require('../../backend/services/produtos/FichaTecnicaService');
const {
  produtoEhVendavelPdv,
  filtrarItensVendaveisPdv,
  exigirProdutosVendaveisNaVenda,
  consultaSomenteVendaveis,
  sqlFiltroProdutoVendavelPdv
} = require('../../backend/services/produtos/tipoOperacionalProduto');
const MotorUM = require('../../backend/services/unidades/MotorUnidadesMedida');
const {
  exigirEmpresaDaOperacao,
  CODIGO_EMPRESA_CONTEXT_REQUIRED
} = require('../../backend/services/vendas/VendaEmpresaContextoService');
const { debitarEstoqueItemVenda } = require('../../backend/services/vendas/debitoEstoqueVendaViaPorta');
const { ModoOperacionalGlobal } = require('../../backend/core/modo-operacional');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function listarJs(dirRel) {
  const dir = path.join(ROOT, dirRel);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((n) => n.endsWith('.js'))
    .map((n) => path.join(dirRel, n).replace(/\\/g, '/'));
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

function debitoAsync(db, dados) {
  return new Promise((resolve, reject) => {
    debitarEstoqueItemVenda(db, dados, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

async function setupCatalogo() {
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
  await garantirColunaTipoOperacionalAsync(db);
  await garantirSchemaFichaTecnicaAsync(db);
  const comercial = await run(
    db,
    `INSERT INTO produtos (nome, tipo_operacional, unidade, saldo_fiscal, saldo_nao_fiscal, estoque_atual)
     VALUES ('Pastel de carne', 'COMERCIAL', 'UN', 100, 0, 100)`
  );
  const insumo = await run(
    db,
    `INSERT INTO produtos (nome, tipo_operacional, unidade) VALUES ('Massa de pastel', 'INSUMO', 'KG')`
  );
  const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: comercial.lastID, empresaId: empresaA.id,
    saldo_fiscal: 10, saldo_nao_fiscal: 0, estoque_atual: 10
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: comercial.lastID, empresaId: empresaB.id,
    saldo_fiscal: 20, saldo_nao_fiscal: 0, estoque_atual: 20
  }, { db });
  return {
    db,
    comercialId: comercial.lastID,
    insumoId: insumo.lastID,
    empresaA,
    empresaB
  };
}

async function ee(db, produtoId, empresaId) {
  return get(
    db,
    'SELECT * FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?',
    [produtoId, empresaId]
  );
}

function t01ComercialVendavelPdv() {
  assert.strictEqual(produtoEhVendavelPdv({ tipo_operacional: 'COMERCIAL' }), true);
  assert.strictEqual(produtoEhVendavelPdv({}), true);
  assert.ok(consultaSomenteVendaveis({ query: { somente_vendaveis: '1' } }));
  assert.ok(src('backend/rotas/produtos.js').includes('consultaSomenteVendaveis'));
  assert.ok(src('frontend/pdv/js/pdv.js').includes('somente_vendaveis=1'));
}

function t02InsumoForaDaConsulta() {
  const itens = filtrarItensVendaveisPdv([
    { id: 1, tipo_operacional: 'COMERCIAL' },
    { id: 2, tipo_operacional: 'INSUMO' }
  ]);
  assert.strictEqual(itens.length, 1);
  assert.strictEqual(itens[0].id, 1);
  assert.ok(sqlFiltroProdutoVendavelPdv('p').includes("<> 'INSUMO'"));
}

function t03InsumoNaoVende() {
  assert.throws(
    () => exigirProdutosVendaveisNaVenda([{ id: 9, nome: 'Farinha', tipo_operacional: 'INSUMO' }]),
    (e) => e.code === 'INSUMO_NAO_VENDAVEL'
  );
  assert.ok(src('backend/services/vendas/VendaPagamentoService.js').includes('exigirProdutosVendaveisNaVenda'));
  assert.ok(src('backend/motores/produto-identidade/services/PdvProdutoIdentificacaoService.js').includes('produtoIdEhVendavelPdv'));
}

async function t04ProdutoCompartilhadoEmpresaA() {
  const { db, comercialId, empresaA } = await setupCatalogo();
  const prod = await get(db, 'SELECT id, nome FROM produtos WHERE id = ?', [comercialId]);
  const saldo = await ee(db, comercialId, empresaA.id);
  assert.ok(prod);
  assert.strictEqual(Number(saldo.saldo_fiscal), 10);
  await closeDb(db);
}

async function t05ProdutoCompartilhadoEmpresaB() {
  const { db, comercialId, empresaB } = await setupCatalogo();
  const prod = await get(db, 'SELECT id FROM produtos WHERE id = ?', [comercialId]);
  const saldo = await ee(db, comercialId, empresaB.id);
  assert.ok(prod);
  assert.strictEqual(Number(saldo.saldo_fiscal), 20);
  await closeDb(db);
}

async function t06EstoqueSeparado() {
  const { db, comercialId, empresaA, empresaB } = await setupCatalogo();
  const a = await ee(db, comercialId, empresaA.id);
  const b = await ee(db, comercialId, empresaB.id);
  assert.notStrictEqual(Number(a.saldo_fiscal), Number(b.saldo_fiscal));
  await closeDb(db);
}

async function t07FichaAssociada() {
  const { db, comercialId, insumoId } = await setupCatalogo();
  const ficha = await FichaTecnicaService.salvar(comercialId, {
    ativo: 1,
    itens: [{ insumo_id: insumoId, quantidade: 0.12, unidade: 'KG' }]
  }, { db });
  assert.strictEqual(Number(ficha.produto_id), Number(comercialId));
  assert.strictEqual(ficha.itens.length, 1);
  assert.strictEqual(Number(ficha.itens[0].insumo_id), Number(insumoId));
  await closeDb(db);
}

async function t08SomenteComponentesValidos() {
  const { db, comercialId, insumoId } = await setupCatalogo();
  const ficha = await FichaTecnicaService.salvar(comercialId, {
    itens: [{ insumo_id: insumoId, quantidade: 200, unidade: 'G' }]
  }, { db });
  assert.strictEqual(ficha.itens.length, 1);
  await closeDb(db);
}

async function t09InsumoInvalido() {
  const { db, comercialId } = await setupCatalogo();
  await assert.rejects(
    () => FichaTecnicaService.salvar(comercialId, {
      itens: [{ insumo_id: 999999, quantidade: 1, unidade: 'UN' }]
    }, { db }),
    (e) => e.code === 'INSUMO_INEXISTENTE' || e.code === 'PRODUTO_INEXISTENTE'
  );
  await closeDb(db);
}

async function t10ComercialNaoEInsumo() {
  const { db, comercialId } = await setupCatalogo();
  const outro = await run(
    db,
    `INSERT INTO produtos (nome, tipo_operacional) VALUES ('Refrigerante 2L', 'COMERCIAL')`
  );
  await assert.rejects(
    () => FichaTecnicaService.salvar(comercialId, {
      itens: [{ insumo_id: outro.lastID, quantidade: 1, unidade: 'UN' }]
    }, { db }),
    (e) => e.code === 'COMPONENTE_NAO_INSUMO'
  );
  await closeDb(db);
}

async function t11QuantidadePositiva() {
  const { db, comercialId, insumoId } = await setupCatalogo();
  await assert.rejects(
    () => FichaTecnicaService.salvar(comercialId, {
      itens: [{ insumo_id: insumoId, quantidade: 0, unidade: 'KG' }]
    }, { db }),
    (e) => e.code === 'QUANTIDADE_INVALIDA'
  );
  await closeDb(db);
}

async function t12UnidadeInvalida() {
  const { db, comercialId, insumoId } = await setupCatalogo();
  await assert.rejects(
    () => FichaTecnicaService.salvar(comercialId, {
      itens: [{ insumo_id: insumoId, quantidade: 1, unidade: 'XYZ' }]
    }, { db }),
    (e) => e.code === 'UNIDADE_INVALIDA'
  );
  await closeDb(db);
}

function t13ConversaoReutilizada() {
  assert.ok(src('backend/services/produtos/FichaTecnicaService.js').includes('obterMuc'));
  assert.ok(src('backend/services/produtos/FichaTecnicaService.js').includes('MotorUnidadesMedida'));
  assert.strictEqual(MotorUM.isUnidadeComercialConhecida('ML'), true);
  assert.strictEqual(MotorUM.isUnidadeComercialConhecida('XYZ'), false);
  assert.strictEqual(MotorUM.normalizarUnidadeComercial('LTRO'), 'L');
  assert.strictEqual(typeof FichaTecnicaService.converterQuantidadeFicha, 'function');
}

async function t14ANaoAlteraEstoqueB() {
  const { db, comercialId, empresaA, empresaB } = await setupCatalogo();
  const bAntes = await ee(db, comercialId, empresaB.id);
  await debitoAsync(db, {
    produtoId: comercialId,
    quantidadeFiscal: 1,
    empresaId: empresaA.id,
    exigirEmpresa: true,
    origem: 'baixa_venda'
  });
  const a = await ee(db, comercialId, empresaA.id);
  const b = await ee(db, comercialId, empresaB.id);
  assert.strictEqual(Number(a.saldo_fiscal), 9);
  assert.strictEqual(Number(b.saldo_fiscal), Number(bAntes.saldo_fiscal));
  assert.ok(!src('backend/services/produtos/fichaTecnicaSchema.js').includes('empresa_id'));
  await closeDb(db);
}

function t15MultiempresaSemContexto() {
  assert.throws(
    () => exigirEmpresaDaOperacao({}),
    (e) => e.code === CODIGO_EMPRESA_CONTEXT_REQUIRED
  );
  assert.throws(
    () => exigirEmpresaDaOperacao({ empresaId: null }),
    (e) => e.code === CODIGO_EMPRESA_CONTEXT_REQUIRED
  );
}

function t16ProdutoUnicoCatalogo() {
  const ddl = src('backend/database.js');
  assert.ok(/CREATE TABLE IF NOT EXISTS produtos/.test(ddl));
  assert.ok(!/CREATE TABLE IF NOT EXISTS produto_empresa\b/i.test(ddl));
  const bloco = ddl.match(/CREATE TABLE IF NOT EXISTS produtos \(([\s\S]*?)FOREIGN KEY \(subcategoria_id\)/);
  assert.ok(bloco, 'DDL produtos');
  assert.ok(!/\bempresa_id\b/.test(bloco[1]));
}

function t17NaoDuplicaPorCnpj() {
  t16ProdutoUnicoCatalogo();
  assert.ok(src('docs/arquitetura/FUNDACAO_PRODUTOS_FICHA_TECNICA_PASTELARIA_03_03.md').includes('compartilhado'));
}

function t18PdvNormalNaoUniversal() {
  const pdv = src('frontend/pdv/js/pdv.js');
  assert.ok(!/pdv-universal/i.test(pdv));
  assert.ok(!src('backend/rotas/vendas.js').includes('pdv-universal'));
}

async function t19VendaAUsaEstoqueA() {
  const { db, comercialId, empresaA, empresaB } = await setupCatalogo();
  const bAntes = await ee(db, comercialId, empresaB.id);
  await debitoAsync(db, {
    produtoId: comercialId,
    quantidadeFiscal: 2,
    empresaId: empresaA.id,
    exigirEmpresa: true
  });
  const a = await ee(db, comercialId, empresaA.id);
  const b = await ee(db, comercialId, empresaB.id);
  assert.strictEqual(Number(a.saldo_fiscal), 8);
  assert.strictEqual(Number(b.saldo_fiscal), Number(bAntes.saldo_fiscal));
  await closeDb(db);
}

async function t20VendaBUsaEstoqueB() {
  const { db, comercialId, empresaA, empresaB } = await setupCatalogo();
  const aAntes = await ee(db, comercialId, empresaA.id);
  await debitoAsync(db, {
    produtoId: comercialId,
    quantidadeFiscal: 3,
    empresaId: empresaB.id,
    exigirEmpresa: true
  });
  const a = await ee(db, comercialId, empresaA.id);
  const b = await ee(db, comercialId, empresaB.id);
  assert.strictEqual(Number(b.saldo_fiscal), 17);
  assert.strictEqual(Number(a.saldo_fiscal), Number(aAntes.saldo_fiscal));
  await closeDb(db);
}

function t21FichaNaoCriaSegundaVenda() {
  const ficha = src('backend/services/produtos/FichaTecnicaService.js');
  assert.ok(!/INSERT INTO vendas/i.test(ficha));
  assert.ok(!src('backend/services/produtos/FichaTecnicaService.js').includes('VendaPagamentoService'));
}

function t22NucleoNaoReescritoPorFicha() {
  const nucleo = src('backend/services/vendas/VendaPagamentoService.js');
  assert.ok(!/ficha_tecnica/i.test(nucleo));
  assert.ok(!nucleo.includes('FichaTecnicaService'));
  assert.ok(nucleo.includes('exigirProdutosVendaveisNaVenda'));
}

function arquivosNovos03() {
  return [
    'backend/services/produtos/tipoOperacionalProduto.js',
    'backend/services/produtos/fichaTecnicaSchema.js',
    'backend/services/produtos/FichaTecnicaService.js'
  ];
}

function t23SemFallbackEmpresa1() {
  for (const rel of arquivosNovos03()) {
    const t = src(rel);
    assert.ok(!/empresaId\s*=\s*1\b/.test(t), rel);
    assert.ok(!/empresa_id\s*=\s*1\b/.test(t), rel);
  }
}

function t24SemPrimeiraEmpresa() {
  for (const rel of arquivosNovos03()) {
    assert.ok(!/primeira empresa/i.test(src(rel)), rel);
  }
}

function t25SemCompatFallback() {
  for (const rel of arquivosNovos03()) {
    const t = src(rel);
    assert.ok(!/\bCOMPAT\b/.test(t), rel);
  }
  assert.ok(src('backend/core/modo-operacional/contratos.js').includes('MULTIEMPRESA'));
  void ModoOperacionalGlobal;
}

async function main() {
  const casos = [
    ['T01 Produto comercial no PDV', t01ComercialVendavelPdv],
    ['T02 Insumo fora da consulta vendável', t02InsumoForaDaConsulta],
    ['T03 Insumo não vende no PDV', t03InsumoNaoVende],
    ['T04 Catálogo compartilhado empresa A', t04ProdutoCompartilhadoEmpresaA],
    ['T05 Catálogo compartilhado empresa B', t05ProdutoCompartilhadoEmpresaB],
    ['T06 Estoque A separado do B', t06EstoqueSeparado],
    ['T07 Ficha no produto correto', t07FichaAssociada],
    ['T08 Componentes válidos', t08SomenteComponentesValidos],
    ['T09 Insumo inválido rejeitado', t09InsumoInvalido],
    ['T10 Comercial não é insumo', t10ComercialNaoEInsumo],
    ['T11 Quantidade positiva', t11QuantidadePositiva],
    ['T12 Unidade inválida', t12UnidadeInvalida],
    ['T13 Conversão reutilizada', t13ConversaoReutilizada],
    ['T14 A não altera estoque B', t14ANaoAlteraEstoqueB],
    ['T15 MULTI sem contexto bloqueia', t15MultiempresaSemContexto],
    ['T16 Produto único no catálogo', t16ProdutoUnicoCatalogo],
    ['T17 Sem duplicar por CNPJ', t17NaoDuplicaPorCnpj],
    ['T18 PDV Normal não depende do Universal', t18PdvNormalNaoUniversal],
    ['T19 Venda A usa estoque A', t19VendaAUsaEstoqueA],
    ['T20 Venda B usa estoque B', t20VendaBUsaEstoqueB],
    ['T21 Ficha não cria segunda venda', t21FichaNaoCriaSegundaVenda],
    ['T22 Núcleo VendaPagamento sem ficha', t22NucleoNaoReescritoPorFicha],
    ['T23 Sem fallback empresa 1', t23SemFallbackEmpresa1],
    ['T24 Sem primeira empresa', t24SemPrimeiraEmpresa],
    ['T25 Sem COMPAT', t25SemCompatFallback]
  ];

  let falhas = 0;
  for (const [nome, fn] of casos) {
    try {
      await fn();
      console.log('OK', nome);
    } catch (err) {
      falhas += 1;
      console.error('FAIL', nome, err && err.message ? err.message : err);
    }
  }
  console.log(`${casos.length - falhas}/${casos.length}`);
  if (falhas) process.exit(1);
}

main();
