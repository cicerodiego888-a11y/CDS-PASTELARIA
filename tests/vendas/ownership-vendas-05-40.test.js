/**
 * Sprint 05.40 — Ownership empresarial da venda.
 * Executar: node tests/vendas/ownership-vendas-05-40.test.js
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
  migrarEmpresaIdVendas,
  formatarLogMigracaoVendas,
  sqlFiltroEmpresaVenda
} = require('../../backend/utils/vendasEmpresaHelpers');
const {
  resolverEmpresaIdParaVenda,
  exigirEmpresaDaOperacao,
  exigirCaixaCompativelComVenda,
  exigirVendaDaEmpresa,
  CODIGO_EMPRESA_CONTEXT_REQUIRED
} = require('../../backend/services/vendas/VendaEmpresaContextoService');

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
      status TEXT DEFAULT 'concluida',
      valor_fiscal REAL DEFAULT 0,
      valor_nao_fiscal REAL DEFAULT 0,
      caixa_sessao_id INTEGER,
      origem TEXT,
      empresa_id INTEGER
    )
  `);
  await run(db, `
    CREATE TABLE atendimento_operacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL,
      venda_id INTEGER UNIQUE,
      status TEXT
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

function writersBackendInsertVendas() {
  return [
    'backend/services/vendas/VendaPagamentoService.js',
    'backend/motores/muv/MaterializarOperacoesAtendimento.js',
    'backend/services/entrega/CriarVendaEntregaService.js'
  ];
}

async function test01VendaEmpresaA() {
  const db = await criarDb();
  const { a } = await seedEmpresas(db);
  const empresaId = exigirEmpresaDaOperacao({ empresaId: a.id });
  const ins = await run(
    db,
    `INSERT INTO vendas (codigo, data_venda, total, empresa_id) VALUES ('VA', date('now'), 10, ?)`,
    [empresaId]
  );
  const row = await get(db, `SELECT empresa_id FROM vendas WHERE id = ?`, [ins.lastID]);
  assert.strictEqual(Number(row.empresa_id), Number(a.id));
  db.close();
}

async function test02VendaEmpresaB() {
  const db = await criarDb();
  const { b } = await seedEmpresas(db);
  const empresaId = exigirEmpresaDaOperacao({ empresaId: b.id });
  const ins = await run(
    db,
    `INSERT INTO vendas (codigo, data_venda, total, empresa_id) VALUES ('VB', date('now'), 20, ?)`,
    [empresaId]
  );
  const row = await get(db, `SELECT empresa_id FROM vendas WHERE id = ?`, [ins.lastID]);
  assert.strictEqual(Number(row.empresa_id), Number(b.id));
  db.close();
}

async function test03ListaSoA() {
  const db = await criarDb();
  const { a, b } = await seedEmpresas(db);
  await run(db, `INSERT INTO vendas (codigo, total, empresa_id) VALUES ('A1', 1, ?)`, [a.id]);
  await run(db, `INSERT INTO vendas (codigo, total, empresa_id) VALUES ('B1', 1, ?)`, [b.id]);
  await run(db, `INSERT INTO vendas (codigo, total, empresa_id) VALUES (NULL, 1, NULL)`);
  const params = [];
  const filtro = sqlFiltroEmpresaVenda('v', a.id, params);
  const rows = await all(db, `SELECT codigo FROM vendas v WHERE ${filtro} ORDER BY id`, params);
  assert.deepStrictEqual(rows.map((r) => r.codigo), ['A1']);
  assert.ok(src('backend/rotas/vendas.js').includes("sqlFiltroEmpresaVenda('v', empresaId, params)"));
  db.close();
}

async function test04ListaSoB() {
  const db = await criarDb();
  const { a, b } = await seedEmpresas(db);
  await run(db, `INSERT INTO vendas (codigo, total, empresa_id) VALUES ('A1', 1, ?)`, [a.id]);
  await run(db, `INSERT INTO vendas (codigo, total, empresa_id) VALUES ('B1', 1, ?)`, [b.id]);
  const params = [];
  const filtro = sqlFiltroEmpresaVenda('v', b.id, params);
  const rows = await all(db, `SELECT codigo FROM vendas v WHERE ${filtro}`, params);
  assert.deepStrictEqual(rows.map((r) => r.codigo), ['B1']);
  db.close();
}

async function test05AcessoCruzadoNotFound() {
  const db = await criarDb();
  const { a, b } = await seedEmpresas(db);
  const ins = await run(db, `INSERT INTO vendas (codigo, total, empresa_id) VALUES ('A1', 1, ?)`, [a.id]);
  const vendaA = await get(db, `SELECT * FROM vendas WHERE id = ?`, [ins.lastID]);
  assert.throws(
    () => exigirVendaDaEmpresa(vendaA, b.id),
    (e) => e.code === 'VENDA_NAO_ENCONTRADA' && e.statusCode === 404
  );
  const viaSql = await get(
    db,
    `SELECT * FROM vendas WHERE id = ? AND empresa_id = ?`,
    [ins.lastID, b.id]
  );
  assert.strictEqual(viaSql, null);
  assert.ok(src('backend/rotas/vendas.js').includes('AND v.empresa_id = ?'));
  db.close();
}

async function test06CriarSemEmpresa() {
  assert.throws(
    () => exigirEmpresaDaOperacao({}),
    (e) => e.code === CODIGO_EMPRESA_CONTEXT_REQUIRED
  );
  assert.throws(
    () => exigirEmpresaDaOperacao(null),
    (e) => e.code === CODIGO_EMPRESA_CONTEXT_REQUIRED
  );
  await assert.rejects(
    () => resolverEmpresaIdParaVenda(
      { headers: {} },
      { obterModoOperacionalGlobal: () => 'MULTIEMPRESA', exigirAutorizacaoUsuario: false }
    ),
    (e) => e.code === CODIGO_EMPRESA_CONTEXT_REQUIRED
  );
}

async function test07CaixaIncompativel() {
  const db = await criarDb();
  const { a, b } = await seedEmpresas(db);
  assert.throws(
    () => exigirCaixaCompativelComVenda(
      { caixaSessao: { id: 1, empresa_id: a.id } },
      b.id
    ),
    (e) => e.code === 'CAIXA_SESSAO_EMPRESA_DIVERGENTE'
  );
  assert.ok(src('backend/services/vendas/VendaPagamentoService.js').includes('exigirCaixaCompativelComVenda'));
  db.close();
}

async function test08FiscalNaoFiscalMista() {
  const db = await criarDb();
  const { a } = await seedEmpresas(db);
  const empresaId = exigirEmpresaDaOperacao(a.id);
  await run(db, `INSERT INTO vendas (codigo, valor_fiscal, valor_nao_fiscal, empresa_id) VALUES ('FISC', 10, 0, ?)`, [empresaId]);
  await run(db, `INSERT INTO vendas (codigo, valor_fiscal, valor_nao_fiscal, empresa_id) VALUES ('NF', 0, 10, ?)`, [empresaId]);
  await run(db, `INSERT INTO vendas (codigo, valor_fiscal, valor_nao_fiscal, empresa_id) VALUES ('MISTA', 5, 5, ?)`, [empresaId]);
  const rows = await all(db, `SELECT codigo, empresa_id FROM vendas WHERE empresa_id = ?`, [a.id]);
  assert.strictEqual(rows.length, 3);
  rows.forEach((r) => assert.strictEqual(Number(r.empresa_id), Number(a.id)));
  db.close();
}

async function test09LegadoNullForaDaLista() {
  const db = await criarDb();
  const { a } = await seedEmpresas(db);
  await run(db, `INSERT INTO vendas (codigo, total, empresa_id) VALUES ('OK', 1, ?)`, [a.id]);
  await run(db, `INSERT INTO vendas (codigo, total) VALUES ('LEGADO', 1)`);
  const params = [];
  const filtro = sqlFiltroEmpresaVenda('v', a.id, params);
  const rows = await all(db, `SELECT codigo FROM vendas v WHERE ${filtro}`, params);
  assert.deepStrictEqual(rows.map((r) => r.codigo), ['OK']);
  assert.throws(
    () => exigirVendaDaEmpresa({ id: 99, empresa_id: null }, a.id),
    (e) => e.code === 'VENDA_NAO_ENCONTRADA'
  );
  db.close();
}

function test10WritersNovosComEmpresaId() {
  for (const rel of writersBackendInsertVendas()) {
    const blob = src(rel);
    const matches = blob.match(/INSERT INTO vendas\s*\(([^)]+)\)/g) || [];
    assert.ok(matches.length > 0, `Nenhum INSERT INTO vendas em ${rel}`);
    matches.forEach((sql) => {
      assert.ok(
        /empresa_id/i.test(sql),
        `INSERT em ${rel} sem empresa_id: ${sql.slice(0, 120)}`
      );
    });
  }
  const pagamento = src('backend/services/vendas/VendaPagamentoService.js');
  assert.ok(pagamento.includes('exigirEmpresaDaOperacao'));
  assert.ok(pagamento.includes('empresaIdVenda'));
  const rotas = src('backend/rotas/vendas.js');
  assert.ok(!/req\.query\.empresa_id/.test(rotas.split('router.get(\'/\'').pop().slice(0, 800)));
}

async function testMigracaoBackfillELegado() {
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
      total REAL DEFAULT 0,
      caixa_sessao_id INTEGER,
      origem TEXT
    )
  `);
  await run(db, `
    CREATE TABLE atendimento_operacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL,
      venda_id INTEGER UNIQUE,
      status TEXT
    )
  `);
  const { a, b } = await seedEmpresas(db);
  const sessA = await run(db, `INSERT INTO caixa_sessoes (empresa_id, status) VALUES (?, 'aberto')`, [a.id]);
  await run(db, `INSERT INTO vendas (codigo, caixa_sessao_id, total) VALUES ('CAIXA', ?, 1)`, [sessA.lastID]);
  const vendaMuv = await run(db, `INSERT INTO vendas (codigo, origem, total) VALUES ('MUV', 'ATENDIMENTO', 1)`);
  await run(db, `INSERT INTO atendimento_operacoes (empresa_id, venda_id, status) VALUES (?, ?, 'CONCLUIDA')`, [
    b.id,
    vendaMuv.lastID
  ]);
  await run(db, `INSERT INTO vendas (codigo, total) VALUES ('ORFA', 1)`);

  const info = await migrarEmpresaIdVendas(db);
  assert.strictEqual(info.skipped, false);
  assert.strictEqual(info.total, 3);
  assert.strictEqual(info.fromCaixa, 1);
  assert.strictEqual(info.fromMuv, 1);
  assert.strictEqual(info.naoClassificadas, 1);

  const viaCaixa = await get(db, `SELECT empresa_id FROM vendas WHERE codigo = 'CAIXA'`);
  const viaMuv = await get(db, `SELECT empresa_id FROM vendas WHERE codigo = 'MUV'`);
  const orfa = await get(db, `SELECT empresa_id FROM vendas WHERE codigo = 'ORFA'`);
  assert.strictEqual(Number(viaCaixa.empresa_id), Number(a.id));
  assert.strictEqual(Number(viaMuv.empresa_id), Number(b.id));
  assert.strictEqual(orfa.empresa_id, null);

  const log = formatarLogMigracaoVendas(info);
  assert.ok(log.includes('MIGRATION_VENDAS_EMPRESA_05_40'));
  assert.ok(log.includes('NÃO_CLASSIFICADAS: 1'));

  const idx = await all(db, `PRAGMA index_list(vendas)`);
  assert.ok(idx.some((i) => i.name === 'idx_vendas_empresa_id'));

  const info2 = await migrarEmpresaIdVendas(db);
  assert.strictEqual(info2.added, false);
  assert.strictEqual(info2.naoClassificadas, 1);
  db.close();
}

async function testNaoUsaQueryComoOwnership() {
  const db = await criarDb();
  const { a } = await seedEmpresas(db);
  await assert.rejects(
    () => resolverEmpresaIdParaVenda(
      { query: { empresa_id: String(a.id) }, headers: {}, body: { empresa_id: a.id } },
      { obterModoOperacionalGlobal: () => 'MULTIEMPRESA', db, exigirAutorizacaoUsuario: false }
    ),
    (e) => e.code === CODIGO_EMPRESA_CONTEXT_REQUIRED
  );
  const ok = await resolverEmpresaIdParaVenda(
    { headers: { 'x-empresa-id': String(a.id) } },
    { obterModoOperacionalGlobal: () => 'MULTIEMPRESA', db, exigirAutorizacaoUsuario: false }
  );
  assert.strictEqual(ok.empresaId, Number(a.id));
  db.close();
}

async function testSchemaERotaListagem() {
  assert.ok(src('backend/database.js').includes('idx_vendas_empresa_id'));
  assert.ok(src('backend/database.js').includes('migrarEmpresaIdVendas'));
  assert.ok(src('backend/rotas/vendas.js').includes('anexarEmpresaVenda'));
  assert.ok(src('backend/rotas/vendas.js').includes('exigirVendaDaEmpresa'));
}

const TESTS = [
  ['01 venda empresa A', test01VendaEmpresaA],
  ['02 venda empresa B', test02VendaEmpresaB],
  ['03 listar só A', test03ListaSoA],
  ['04 listar só B', test04ListaSoB],
  ['05 acesso cruzado NOT_FOUND', test05AcessoCruzadoNotFound],
  ['06 criar sem empresaId', test06CriarSemEmpresa],
  ['07 caixa incompatível bloqueia', test07CaixaIncompativel],
  ['08 fiscal / não fiscal / mista', test08FiscalNaoFiscalMista],
  ['09 legado NULL fora da lista', test09LegadoNullForaDaLista],
  ['10 writers novos com empresa_id', test10WritersNovosComEmpresaId],
  ['migration backfill caixa/MUV/NULL', testMigracaoBackfillELegado],
  ['não usa query como ownership', testNaoUsaQueryComoOwnership],
  ['schema + rota listagem', testSchemaERotaListagem]
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
      if (err.stack) console.error(err.stack.split('\n').slice(0, 6).join('\n'));
    }
  }
  console.log(`\nResultado: ${ok}/${TESTS.length} OK, ${fail} falha(s).`);
  if (fail > 0) process.exit(1);
})();
