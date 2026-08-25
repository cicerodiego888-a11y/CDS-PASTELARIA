/**
 * Sprint 05.41 — Ownership empresarial dos writers financeiros.
 * Executar: node tests/financeiro/ownership-financeiro-05-41.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const {
  migrarOwnershipFinanceiro0541,
  formatarLogMigracaoFinanceiro0541,
  sqlFiltroEmpresa
} = require('../../backend/utils/financeiroEmpresaHelpers');
const {
  resolverEmpresaDaOrigemFinanceira,
  exigirEmpresaIdFinanceiro,
  exigirLancamentoDaEmpresa,
  CODIGO_EMPRESA_OWNERSHIP_REQUIRED,
  CODIGO_FINANCEIRO_EMPRESA_DIVERGENTE,
  CODIGO_FINANCEIRO_NAO_ENCONTRADO
} = require('../../backend/services/financeiro/FinanceiroEmpresaContextoService');

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

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

async function criarDb() {
  const db = await new Promise((resolve, reject) => {
    const c = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(c)));
  });
  await garantirSchemaEmpresasAsync(db);
  await run(db, `
    CREATE TABLE caixa_sessoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER,
      status TEXT
    )
  `);
  await run(db, `
    CREATE TABLE vendas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT,
      data_venda TEXT,
      total REAL DEFAULT 0,
      caixa_sessao_id INTEGER,
      origem TEXT,
      empresa_id INTEGER
    )
  `);
  await run(db, `
    CREATE TABLE atendimento_operacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER,
      venda_id INTEGER UNIQUE,
      status TEXT
    )
  `);
  await run(db, `
    CREATE TABLE compras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fornecedor TEXT,
      empresa_id INTEGER
    )
  `);
  await run(db, `
    CREATE TABLE financeiro (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo TEXT,
      descricao TEXT,
      valor REAL,
      data_movimento TEXT,
      status TEXT,
      origem TEXT,
      referencia_id INTEGER,
      referencia_tipo TEXT,
      venda_id INTEGER,
      compra_id INTEGER,
      empresa_id INTEGER
    )
  `);
  return db;
}

async function seedEmpresas(db) {
  const a = await EmpresaService.criarEmpresa(
    { cnpj: '11222333000181', razao_social: 'Empresa A', nome_fantasia: 'A' },
    { db }
  );
  const b = await EmpresaService.criarEmpresa(
    { cnpj: '04252011000110', razao_social: 'Empresa B', nome_fantasia: 'B' },
    { db }
  );
  return { a, b };
}

const WRITERS_EMPRESARIAIS = [
  'backend/services/vendas/VendaPagamentoService.js',
  'backend/motores/muv/MaterializarOperacoesAtendimento.js',
  'backend/services/entrega/MotorFinalizacaoVenda.js',
  'backend/rotas/financeiro.js',
  'backend/rotas/contas_receber.js',
  'backend/rotas/compras.js'
];

const WRITERS_FORA_DE_ESCOPO = [
  'backend/services/vendas/VendaCancelamentoService.js',
  'backend/services/vendas/VendaFinanceiroService.js'
];

function extrairInsertsFinanceiro(texto) {
  return texto.match(/INSERT\s+INTO\s+financeiro\s*\(([^)]+)\)/gi) || [];
}

async function test01FinanceiroEmpresaA() {
  const db = await criarDb();
  const { a } = await seedEmpresas(db);
  const venda = await run(
    db,
    `INSERT INTO vendas (codigo, total, empresa_id) VALUES ('VA', 10, ?)`,
    [a.id]
  );
  const empresaId = resolverEmpresaDaOrigemFinanceira({
    venda: { empresa_id: a.id }
  });
  const fin = await run(
    db,
    `INSERT INTO financeiro (tipo, valor, data_movimento, venda_id, empresa_id)
     VALUES ('receita', 10, '2026-08-24', ?, ?)`,
    [venda.lastID, empresaId]
  );
  const row = await get(db, `SELECT empresa_id FROM financeiro WHERE id = ?`, [fin.lastID]);
  assert.strictEqual(Number(row.empresa_id), Number(a.id));
  db.close();
}

async function test02FinanceiroEmpresaB() {
  const db = await criarDb();
  const { b } = await seedEmpresas(db);
  const venda = await run(
    db,
    `INSERT INTO vendas (codigo, total, empresa_id) VALUES ('VB', 20, ?)`,
    [b.id]
  );
  const empresaId = resolverEmpresaDaOrigemFinanceira({
    venda: { empresa_id: b.id }
  });
  const fin = await run(
    db,
    `INSERT INTO financeiro (tipo, valor, data_movimento, venda_id, empresa_id)
     VALUES ('receita', 20, '2026-08-24', ?, ?)`,
    [venda.lastID, empresaId]
  );
  const row = await get(db, `SELECT empresa_id FROM financeiro WHERE id = ?`, [fin.lastID]);
  assert.strictEqual(Number(row.empresa_id), Number(b.id));
  db.close();
}

async function test03ListaSoA() {
  const db = await criarDb();
  const { a, b } = await seedEmpresas(db);
  await run(db, `INSERT INTO financeiro (tipo, valor, data_movimento, empresa_id) VALUES ('receita', 1, '2026-08-24', ?)`, [a.id]);
  await run(db, `INSERT INTO financeiro (tipo, valor, data_movimento, empresa_id) VALUES ('receita', 2, '2026-08-24', ?)`, [b.id]);
  await run(db, `INSERT INTO financeiro (tipo, valor, data_movimento) VALUES ('receita', 9, '2026-08-24')`);
  const f = sqlFiltroEmpresa('', a.id);
  const rows = await all(db, `SELECT valor FROM financeiro WHERE 1=1 ${f.sql}`, f.params);
  assert.deepStrictEqual(rows.map((r) => r.valor), [1]);
  assert.ok(src('backend/rotas/financeiro.js').includes('filtroEmpresaSql(req.empresaId)'));
  db.close();
}

async function test04ListaSoB() {
  const db = await criarDb();
  const { a, b } = await seedEmpresas(db);
  await run(db, `INSERT INTO financeiro (tipo, valor, data_movimento, empresa_id) VALUES ('receita', 1, '2026-08-24', ?)`, [a.id]);
  await run(db, `INSERT INTO financeiro (tipo, valor, data_movimento, empresa_id) VALUES ('receita', 2, '2026-08-24', ?)`, [b.id]);
  const f = sqlFiltroEmpresa('', b.id);
  const rows = await all(db, `SELECT valor FROM financeiro WHERE 1=1 ${f.sql}`, f.params);
  assert.deepStrictEqual(rows.map((r) => r.valor), [2]);
  db.close();
}

function test05AcessoCruzadoNotFound() {
  assert.throws(
    () => exigirLancamentoDaEmpresa({ id: 7, empresa_id: 2, valor: 99, descricao: 'secreto' }, 1),
    (e) => e.code === CODIGO_FINANCEIRO_NAO_ENCONTRADO && e.statusCode === 404 && !String(e.message).includes('secreto')
  );
  assert.throws(
    () => exigirLancamentoDaEmpresa(null, 1),
    (e) => e.code === CODIGO_FINANCEIRO_NAO_ENCONTRADO
  );
  const get = src('backend/rotas/financeiro.js');
  assert.ok(get.includes('exigirLancamentoDaEmpresa'));
}

function test06MaterializarSemOwnership() {
  assert.throws(
    () => resolverEmpresaDaOrigemFinanceira({}),
    (e) => e.code === CODIGO_EMPRESA_OWNERSHIP_REQUIRED
  );
  assert.throws(
    () => exigirEmpresaIdFinanceiro(null),
    (e) => e.code === CODIGO_EMPRESA_OWNERSHIP_REQUIRED
  );
  const muv = src('backend/motores/muv/MaterializarOperacoesAtendimento.js');
  assert.ok(muv.includes('resolverEmpresaDaOrigemFinanceira'));
  assert.ok(muv.includes('empresa_id'));
}

function test07CoerenciaVendaFinanceiro() {
  const id = resolverEmpresaDaOrigemFinanceira({
    venda: { empresa_id: 8 }
  });
  assert.strictEqual(id, 8);
}

function test08CoerenciaCaixaDivergente() {
  assert.throws(
    () => resolverEmpresaDaOrigemFinanceira({
      venda: { empresa_id: 1 },
      caixa: { empresa_id: 2 }
    }),
    (e) => e.code === CODIGO_FINANCEIRO_EMPRESA_DIVERGENTE
  );
}

async function test09LegadoNullForaDaLista() {
  const db = await criarDb();
  const { a } = await seedEmpresas(db);
  await run(db, `INSERT INTO financeiro (tipo, valor, data_movimento, empresa_id) VALUES ('receita', 1, '2026-08-24', ?)`, [a.id]);
  await run(db, `INSERT INTO financeiro (tipo, valor, data_movimento) VALUES ('receita', 99, '2026-08-24')`);
  const f = sqlFiltroEmpresa('', a.id);
  const rows = await all(db, `SELECT valor FROM financeiro WHERE 1=1 ${f.sql}`, f.params);
  assert.deepStrictEqual(rows.map((r) => r.valor), [1]);
  assert.throws(
    () => exigirLancamentoDaEmpresa({ id: 2, empresa_id: null }, a.id),
    (e) => e.code === CODIGO_FINANCEIRO_NAO_ENCONTRADO
  );
  db.close();
}

function test10WritersNovosNaoGravamNull() {
  for (const rel of WRITERS_EMPRESARIAIS) {
    const blob = src(rel);
    const matches = extrairInsertsFinanceiro(blob);
    assert.ok(matches.length > 0, `Nenhum INSERT INTO financeiro em ${rel}`);
    matches.forEach((sql) => {
      assert.ok(
        /empresa_id/i.test(sql),
        `INSERT em ${rel} sem empresa_id: ${sql.slice(0, 160)}`
      );
    });
  }
  const pagamento = src('backend/services/vendas/VendaPagamentoService.js');
  assert.ok(!/INSERT INTO financeiro[\s\S]{0,900}req\.empresaId \|\| null/.test(pagamento));
  assert.ok(pagamento.includes('empresaIdVenda'));
  const muv = src('backend/motores/muv/MaterializarOperacoesAtendimento.js');
  assert.ok(muv.includes('resolverEmpresaDaOrigemFinanceira'));
  const entrega = src('backend/services/entrega/MotorFinalizacaoVenda.js');
  assert.ok(entrega.includes('empresa_id'));
  assert.ok(entrega.includes('resolverEmpresaDaOrigemFinanceira'));
}

function test11RegressaoFluxosExistentes() {
  const venda = src('backend/services/vendas/VendaPagamentoService.js');
  assert.ok((venda.match(/INSERT INTO financeiro/g) || []).length >= 2);

  const muv = src('backend/motores/muv/MaterializarOperacoesAtendimento.js');
  assert.ok(muv.includes("origem, valor, status, data_movimento, empresa_id"));

  const atendimentoEntrega = src('backend/services/entrega/MotorFinalizacaoVenda.js');
  assert.ok(atendimentoEntrega.includes('INSERT INTO financeiro'));

  const receber = src('backend/rotas/contas_receber.js');
  assert.ok(receber.includes('INSERT INTO financeiro'));
  assert.ok(receber.includes('empresa_id'));

  const pagarParcial = src('backend/rotas/financeiro.js');
  assert.ok(pagarParcial.includes('pagamento-parcial'));
  assert.ok(pagarParcial.includes('empresa_id'));

  const cancel = src('backend/services/vendas/VendaCancelamentoService.js');
  assert.ok(cancel.includes('INSERT INTO financeiro'));
  const devolucao = src('backend/services/vendas/VendaFinanceiroService.js');
  assert.ok(devolucao.includes('INSERT INTO financeiro'));
}

async function testMigracaoBackfillConfiavel() {
  const db = await criarDb();
  const { a, b } = await seedEmpresas(db);
  const c = await EmpresaService.criarEmpresa(
    { cnpj: '65957340000150', razao_social: 'Empresa C', nome_fantasia: 'C' },
    { db }
  );
  const d = await EmpresaService.criarEmpresa(
    { cnpj: '18754123000183', razao_social: 'Empresa D', nome_fantasia: 'D' },
    { db }
  );

  const vendaA = await run(db, `INSERT INTO vendas (codigo, total, empresa_id) VALUES ('VA', 1, ?)`, [a.id]);
  await run(db, `INSERT INTO financeiro (tipo, valor, data_movimento, venda_id) VALUES ('receita', 1, '2026-08-24', ?)`, [vendaA.lastID]);

  const vendaMuv = await run(db, `INSERT INTO vendas (codigo, origem, total) VALUES ('MUV', 'ATENDIMENTO', 1)`);
  await run(db, `INSERT INTO atendimento_operacoes (empresa_id, venda_id, status) VALUES (?, ?, 'CONCLUIDA')`, [
    b.id,
    vendaMuv.lastID
  ]);
  await run(db, `INSERT INTO financeiro (tipo, valor, data_movimento, venda_id) VALUES ('receita', 2, '2026-08-24', ?)`, [vendaMuv.lastID]);

  const sessC = await run(db, `INSERT INTO caixa_sessoes (empresa_id, status) VALUES (?, 'aberto')`, [c.id]);
  const vendaCaixa = await run(db, `INSERT INTO vendas (codigo, caixa_sessao_id, total) VALUES ('CX', ?, 1)`, [sessC.lastID]);
  await run(db, `INSERT INTO financeiro (tipo, valor, data_movimento, venda_id) VALUES ('receita', 3, '2026-08-24', ?)`, [vendaCaixa.lastID]);

  const compra = await run(db, `INSERT INTO compras (fornecedor, empresa_id) VALUES ('Forn', ?)`, [d.id]);
  await run(db, `INSERT INTO financeiro (tipo, valor, data_movimento, compra_id) VALUES ('despesa', 4, '2026-08-24', ?)`, [compra.lastID]);

  await run(db, `INSERT INTO financeiro (tipo, valor, data_movimento) VALUES ('receita', 99, '2026-08-24')`);

  const info = await migrarOwnershipFinanceiro0541(db);
  assert.strictEqual(info.skipped, false);
  assert.strictEqual(info.total, 5);
  assert.strictEqual(info.fromVenda, 1);
  assert.strictEqual(info.fromMuv, 1);
  assert.strictEqual(info.fromCaixa, 1);
  assert.strictEqual(info.fromOutra, 1);
  assert.strictEqual(info.naoClassificadas, 1);

  const viaVenda = await get(db, `SELECT empresa_id FROM financeiro WHERE valor = 1`);
  const viaMuv = await get(db, `SELECT empresa_id FROM financeiro WHERE valor = 2`);
  const viaCaixa = await get(db, `SELECT empresa_id FROM financeiro WHERE valor = 3`);
  const viaCompra = await get(db, `SELECT empresa_id FROM financeiro WHERE valor = 4`);
  const legado = await get(db, `SELECT empresa_id FROM financeiro WHERE valor = 99`);
  assert.strictEqual(Number(viaVenda.empresa_id), Number(a.id));
  assert.strictEqual(Number(viaMuv.empresa_id), Number(b.id));
  assert.strictEqual(Number(viaCaixa.empresa_id), Number(c.id));
  assert.strictEqual(Number(viaCompra.empresa_id), Number(d.id));
  assert.strictEqual(legado.empresa_id, null);

  const log = formatarLogMigracaoFinanceiro0541(info);
  assert.ok(log.includes('MIGRATION_FINANCEIRO_EMPRESA_05_41'));
  assert.ok(log.includes('LEGADO_SEM_OWNERSHIP: 1'));

  const idx = await all(db, `PRAGMA index_list(financeiro)`);
  assert.ok(idx.some((i) => i.name === 'idx_financeiro_empresa_id'));

  const info2 = await migrarOwnershipFinanceiro0541(db);
  assert.strictEqual(info2.added, false);
  assert.strictEqual(info2.naoClassificadas, 1);
  db.close();
}

function testNaoUsaQueryNemFallback() {
  const helper = src('backend/services/financeiro/FinanceiroEmpresaContextoService.js');
  assert.ok(!helper.includes('empresa_id = 1'));
  assert.ok(helper.includes('resolverEmpresaDaOrigemFinanceira'));
  const rotas = src('backend/rotas/financeiro.js');
  assert.ok(!/req\.query\.empresa_id/.test(rotas));
  const dbjs = src('backend/database.js');
  assert.ok(dbjs.includes('migrarOwnershipFinanceiro0541'));
  assert.ok(src('backend/utils/financeiroEmpresaHelpers.js').includes('idx_financeiro_empresa_id'));
}

function testWritersForaDeEscopoDocumentados() {
  for (const rel of WRITERS_FORA_DE_ESCOPO) {
    const blob = src(rel);
    assert.ok(
      /INSERT\s+INTO\s+financeiro/i.test(blob),
      `${rel} deveria continuar com INSERT financeiro (fora de escopo 05.41)`
    );
  }
}

const TESTS = [
  ['01 financeiro empresa A', test01FinanceiroEmpresaA],
  ['02 financeiro empresa B', test02FinanceiroEmpresaB],
  ['03 listar só A', test03ListaSoA],
  ['04 listar só B', test04ListaSoB],
  ['05 acesso cruzado NOT_FOUND', test05AcessoCruzadoNotFound],
  ['06 materializar sem ownership', test06MaterializarSemOwnership],
  ['07 coerência venda → financeiro', test07CoerenciaVendaFinanceiro],
  ['08 divergência caixa bloqueia', test08CoerenciaCaixaDivergente],
  ['09 legado NULL fora da lista', test09LegadoNullForaDaLista],
  ['10 writers novos exigem empresa_id', test10WritersNovosNaoGravamNull],
  ['11 regressão venda/MUV/recebimento/pagamento', test11RegressaoFluxosExistentes],
  ['migration backfill confiável', testMigracaoBackfillConfiavel],
  ['não usa query/fallback inventado', testNaoUsaQueryNemFallback],
  ['writers cancel/devolução fora de escopo', testWritersForaDeEscopoDocumentados]
];

(async () => {
  let ok = 0;
  let fail = 0;
  for (const [nome, fn] of TESTS) {
    try {
      await fn();
      ok += 1;
      console.log(`  OK  ${nome}`);
    } catch (err) {
      fail += 1;
      console.error(`  FAIL ${nome}:`, err.message);
      if (err.stack) console.error(err.stack.split('\n').slice(0, 8).join('\n'));
    }
  }
  console.log(`\nResultado: ${ok}/${TESTS.length} OK, ${fail} falha(s).`);
  if (fail > 0) process.exit(1);
})();
