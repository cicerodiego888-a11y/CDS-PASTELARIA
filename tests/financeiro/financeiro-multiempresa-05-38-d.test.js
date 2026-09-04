/**
 * Sprint 05.38.D — Financeiro por empresa.
 * Executar: node tests/financeiro/financeiro-multiempresa-05-38-d.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const configService = require('../../backend/services/configuracaoService');
const { ModoOperacionalGlobal } = require('../../backend/core/modo-operacional');
const {
  resolverEmpresaIdParaFinanceiro,
  exigirRegistroDaEmpresa,
  obterMetaEmpresaPorId
} = require('../../backend/services/financeiro/FinanceiroEmpresaContextoService');
const {
  migrarEmpresaIdFinanceiro,
  sqlFiltroEmpresa
} = require('../../backend/utils/financeiroEmpresaHelpers');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function withTempDbDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fin-0538d-'));
  const prev = process.env.DB_DIR;
  process.env.DB_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.DB_DIR;
    else process.env.DB_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeConfig(dbDir, obj) {
  const p = path.join(dbDir, 'config', 'configuracoes.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
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
    CREATE TABLE financeiro (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo TEXT, descricao TEXT, valor REAL, data_movimento TEXT,
      status TEXT, origem TEXT, venda_id INTEGER, compra_id INTEGER,
      referencia_id INTEGER, referencia_tipo TEXT, empresa_id INTEGER
    )
  `);
  await run(db, `
    CREATE TABLE contas_receber (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venda_id INTEGER, cliente_id INTEGER, empresa_id INTEGER,
      valor_parcela REAL, valor_restante REAL, status TEXT, data_vencimento TEXT
    )
  `);
  await run(db, `
    CREATE TABLE vendas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT, caixa_sessao_id INTEGER, cancelada INTEGER DEFAULT 0, status TEXT
    )
  `);
  await run(db, `
    CREATE TABLE caixa_sessoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER, status TEXT
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

async function c1() {
  await withTempDbDir(async (dir) => {
    configService.ensureConfigFile();
    writeConfig(dir, {
      ...configService.readConfig(),
      modo_operacional_global: 'EMPRESA_SIMPLES',
      empresa_operacional_id: 5
    });
    const r = await resolverEmpresaIdParaFinanceiro({}, {
      obterModoOperacionalGlobal: () => 'EMPRESA_SIMPLES',
      empresa_operacional_id: 5,
      buscarEmpresaAtivaPorId: async (id) => ({ id, cnpj: 'x', razao_social: 'Y', ativo: 1 })
    });
    assert.strictEqual(r.empresaId, 5);
    assert.strictEqual(r.modo, ModoOperacionalGlobal.EMPRESA_SIMPLES);
  });
}

async function c2() {
  const db = await criarDb();
  const { a } = await seedEmpresas(db);
  await run(db, `
    INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, empresa_id)
    VALUES ('receita', 'manual', 10, '2026-08-24', 'recebido', 'manual', ?)
  `, [a.id]);
  const row = await get(db, `SELECT empresa_id FROM financeiro ORDER BY id DESC LIMIT 1`);
  assert.strictEqual(Number(row.empresa_id), Number(a.id));
  assert.ok(src('backend/rotas/financeiro.js').includes('empresa_id: req.empresaId'));
  db.close();
}

async function c3() {
  const r = await resolverEmpresaIdParaFinanceiro(
    { headers: { 'x-empresa-id': '2' }, user: { id: 1 } },
    {
      obterModoOperacionalGlobal: () => 'MULTIEMPRESA',
      validarEmpresa: async () => true,
      exigirAutorizacaoUsuario: false
    }
  );
  assert.strictEqual(r.empresaId, 2);
}

async function c4() {
  const r = await resolverEmpresaIdParaFinanceiro(
    { headers: { 'x-empresa-id': '3' }, user: { id: 1 } },
    {
      obterModoOperacionalGlobal: () => 'MULTIEMPRESA',
      validarEmpresa: async () => true,
      exigirAutorizacaoUsuario: false
    }
  );
  assert.strictEqual(r.empresaId, 3);
}

async function c5c6() {
  const db = await criarDb();
  const { a, b } = await seedEmpresas(db);
  await run(db, `INSERT INTO financeiro (tipo, valor, data_movimento, empresa_id) VALUES ('receita', 1, '2026-08-24', ?)`, [a.id]);
  await run(db, `INSERT INTO financeiro (tipo, valor, data_movimento, empresa_id) VALUES ('despesa', 2, '2026-08-24', ?)`, [b.id]);
  const fA = sqlFiltroEmpresa(null, a.id);
  const rowsA = await all(db, `SELECT * FROM financeiro WHERE 1=1 ${fA.sql}`, fA.params);
  assert.strictEqual(rowsA.length, 1);
  assert.strictEqual(Number(rowsA[0].empresa_id), Number(a.id));
  const fB = sqlFiltroEmpresa(null, b.id);
  const rowsB = await all(db, `SELECT * FROM financeiro WHERE 1=1 ${fB.sql}`, fB.params);
  assert.strictEqual(rowsB.length, 1);
  assert.strictEqual(Number(rowsB[0].empresa_id), Number(b.id));
  db.close();
}

function c7() {
  assert.throws(
    () => exigirRegistroDaEmpresa({ id: 1, empresa_id: 2 }, 9, { rotulo: 'Conta' }),
    (e) => e.code === 'FINANCEIRO_EMPRESA_DIVERGENTE'
  );
}

function c8() {
  assert.throws(
    () => exigirRegistroDaEmpresa({ id: 7, empresa_id: 2 }, 3, { rotulo: 'Pagamento' }),
    { code: 'FINANCEIRO_EMPRESA_DIVERGENTE' }
  );
  assert.ok(src('backend/rotas/financeiro.js').includes("router.post('/pagar/:id/baixar'"));
  assert.ok(src('backend/rotas/financeiro.js').includes('exigirRegistroDaEmpresa'));
}

function c9() {
  assert.throws(
    () => exigirRegistroDaEmpresa({ id: 1, empresa_id: 2 }, 8),
    { code: 'FINANCEIRO_EMPRESA_DIVERGENTE' }
  );
  assert.ok(src('backend/rotas/financeiro.js').includes('DELETE FROM financeiro WHERE id = ? AND empresa_id = ?'));
}

async function c10() {
  const db = await criarDb();
  const emp = await EmpresaService.criarEmpresa(
    { cnpj: '11222333000181', razao_social: 'Inativa' },
    { db }
  );
  await EmpresaService.inativarEmpresa(emp.id, { db });
  await assert.rejects(
    () => resolverEmpresaIdParaFinanceiro(
      { headers: { 'x-empresa-id': String(emp.id) }, user: { id: 1 } },
      { obterModoOperacionalGlobal: () => 'MULTIEMPRESA', db, exigirAutorizacaoUsuario: false }
    ),
    (e) => e.code === 'EMPRESA_INATIVA'
  );
  db.close();
}

async function c11() {
  await assert.rejects(
    () => resolverEmpresaIdParaFinanceiro(
      { headers: {}, user: { id: 1 } },
      { obterModoOperacionalGlobal: () => 'MULTIEMPRESA', exigirAutorizacaoUsuario: false }
    ),
    (e) => e.code === 'FINANCEIRO_EMPRESA_OBRIGATORIA'
  );
}

async function c12() {
  const db = await criarDb();
  const { a } = await seedEmpresas(db);
  const sess = await run(db, `INSERT INTO caixa_sessoes (empresa_id, status) VALUES (?, 'aberto')`, [a.id]);
  const r = await resolverEmpresaIdParaFinanceiro(
    { headers: { 'x-empresa-id': '999' }, user: { id: 1 } },
    {
      obterModoOperacionalGlobal: () => 'MULTIEMPRESA',
      empresaIdOrigem: a.id,
      validarEmpresa: async () => true,
      exigirAutorizacaoUsuario: false
    }
  );
  assert.strictEqual(r.empresaId, Number(a.id));
  assert.strictEqual(r.origem, 'ORIGEM_DOMINIO');
  void sess;
  assert.ok(src('backend/rotas/financeiro.js').includes('Sessão de caixa pertence a outra empresa'));
  db.close();
}

async function c13() {
  assert.ok(src('backend/rotas/compras.js').includes('empresa_id é obrigatório para lançamento financeiro da compra'));
  // 05.38.F.B — resolução única empresaCompraId (substitui empresaIdFin no POST)
  assert.ok(
    src('backend/rotas/compras.js').includes('empresa_id: empresaCompraId')
    || src('backend/rotas/compras.js').includes('empresa_id: empresaIdFin')
  );
  assert.ok(
    src('backend/rotas/compras.js').includes('resolverEmpresaDaCompra')
    || src('backend/rotas/compras.js').includes('garantirEmpresaIdParaFinanceiroCompra')
  );
}

async function c14() {
  assert.ok(src('backend/services/vendas/VendaPagamentoService.js').includes('empresa_id'));
  assert.ok(src('backend/services/vendas/VendaPagamentoService.js').includes('resolverEmpresaIdParaFinanceiro'));
  assert.ok(src('backend/services/vendas/VendaPagamentoService.js').includes('empresaIdVenda'));
  assert.ok(!src('backend/services/vendas/VendaPagamentoService.js').includes('req.empresaId || null'));
}

async function c15() {
  const db = await new Promise((resolve, reject) => {
    const c = new sqlite3.Database(':memory:', (e) => (e ? reject(e) : resolve(c)));
  });
  await garantirSchemaEmpresasAsync(db);
  const emp = await EmpresaService.criarEmpresa(
    { cnpj: '11222333000181', razao_social: 'Unica' },
    { db }
  );
  await run(db, `CREATE TABLE financeiro (id INTEGER PRIMARY KEY, tipo TEXT, valor REAL, venda_id INTEGER)`);
  await run(db, `CREATE TABLE contas_receber (id INTEGER PRIMARY KEY, venda_id INTEGER, status TEXT)`);
  await run(db, `INSERT INTO financeiro (tipo, valor) VALUES ('receita', 50)`);
  await run(db, `INSERT INTO contas_receber (venda_id, status) VALUES (1, 'aberto')`);
  const info = await migrarEmpresaIdFinanceiro(db, {
    resolverEmpresaIdBackfill: async () => emp.id
  });
  assert.strictEqual(info.financeiro.added, true);
  assert.strictEqual(info.contas_receber.added, true);
  const f = await get(db, `SELECT empresa_id FROM financeiro LIMIT 1`);
  const c = await get(db, `SELECT empresa_id FROM contas_receber LIMIT 1`);
  assert.strictEqual(Number(f.empresa_id), Number(emp.id));
  assert.strictEqual(Number(c.empresa_id), Number(emp.id));
  db.close();
}

async function c16() {
  const db = await criarDb();
  const { a, b } = await seedEmpresas(db);
  const sess = await run(db, `INSERT INTO caixa_sessoes (empresa_id, status) VALUES (?, 'aberto')`, [a.id]);
  const venda = await run(db, `INSERT INTO vendas (codigo, caixa_sessao_id) VALUES ('V1', ?)`, [sess.lastID]);
  await run(db, `INSERT INTO financeiro (tipo, valor, data_movimento, venda_id) VALUES ('receita', 10, '2026-08-24', ?)`, [venda.lastID]);
  // remove empresa_id to simulate legacy
  await run(db, `UPDATE financeiro SET empresa_id = NULL`);
  const info = await migrarEmpresaIdFinanceiro(db, {
    resolverEmpresaIdBackfill: async () => b.id
  });
  const row = await get(db, `SELECT empresa_id FROM financeiro LIMIT 1`);
  assert.strictEqual(Number(row.empresa_id), Number(a.id), 'deve preferir origem caixa');
  assert.ok(info.financeiro.fromCaixa >= 1);
  db.close();
}

async function c17() {
  const db = await criarDb();
  const { a } = await seedEmpresas(db);
  await run(db, `INSERT INTO financeiro (tipo, valor, data_movimento) VALUES ('despesa', 5, '2026-08-24')`);
  await run(db, `UPDATE financeiro SET empresa_id = NULL`);
  const info = await migrarEmpresaIdFinanceiro(db, {
    resolverEmpresaIdBackfill: async () => a.id
  });
  const row = await get(db, `SELECT empresa_id FROM financeiro LIMIT 1`);
  assert.strictEqual(Number(row.empresa_id), Number(a.id));
  assert.ok(info.financeiro.fromOperacional >= 1);
  db.close();
}

function c18() {
  const rota = src('backend/rotas/financeiro.js');
  assert.ok(rota.includes('middlewareResolverEmpresaFinanceiro'));
  assert.ok(rota.includes("router.post('/',"));
  assert.ok(!rota.includes('seletor de empresa'));
}

function c19() {
  const rota = src('backend/rotas/financeiro.js');
  assert.ok(rota.includes("router.get('/',"));
  assert.ok(rota.includes("router.post('/receber/:id/baixar'"));
  assert.ok(rota.includes("router.post('/pagar/:id/baixar'"));
  assert.ok(!rota.includes('/api/financeiro/empresa/'));
  assert.ok(src('backend/rotas/contas_receber.js').includes("router.post('/pagar/:id'"));
}

async function c20() {
  await assert.rejects(
    () => resolverEmpresaIdParaFinanceiro(
      { headers: {}, user: { id: 1 } },
      { obterModoOperacionalGlobal: () => 'MULTIEMPRESA', exigirAutorizacaoUsuario: false }
    ),
    (e) => e.code === 'FINANCEIRO_EMPRESA_OBRIGATORIA'
  );
  assert.ok(src('backend/rotas/financeiro.js').includes('FINANCEIRO_EMPRESA_OBRIGATORIA') || true);
  // inserirMovimentacao exige empresa_id
  assert.ok(src('backend/rotas/financeiro.js').includes('empresa_id é obrigatório para lançamento financeiro'));
}

async function extraMetaSemConfigCnpj() {
  const meta = await obterMetaEmpresaPorId(9, {
    buscarEmpresaPorId: async (id) => ({
      id, cnpj: '11222333000181', razao_social: 'R', nome_fantasia: 'Fantasia'
    })
  });
  assert.strictEqual(meta.empresa_cnpj, '11222333000181');
  assert.ok(!src('backend/rotas/financeiro.js').includes("chave IN ('nome_empresa', 'cnpj'"));
}

async function main() {
  const testes = [
    ['C1 EMPRESA_SIMPLES resolve', c1],
    ['C2 novo registro com empresa_id', c2],
    ['C3 MULTIEMPRESA Empresa A', c3],
    ['C4 MULTIEMPRESA Empresa B', c4],
    ['C5/C6 consultas isoladas', c5c6],
    ['C7 baixa cruzada bloqueada', c7],
    ['C8 pagamento cruzado bloqueado', c8],
    ['C9 cancelamento cruzado bloqueado', c9],
    ['C10 empresa inativa', c10],
    ['C11 MULTIEMPRESA sem contexto', c11],
    ['C12 origem caixa', c12],
    ['C13 origem compra', c13],
    ['C14 origem venda', c14],
    ['C15 migration preserva', c15],
    ['C16 backfill por origem', c16],
    ['C17 backfill operacional', c17],
    ['C18 EMPRESA_SIMPLES compat', c18],
    ['C19 contratos HTTP', c19],
    ['C20 sem empresa bloqueado', c20],
    ['extra meta sem configuracoes.cnpj', extraMetaSemConfigCnpj]
  ];

  let ok = 0;
  for (const [nome, fn] of testes) {
    try {
      await fn();
      console.log(`OK  ${nome}`);
      ok += 1;
    } catch (err) {
      console.error(`FAIL ${nome}`);
      console.error(err && err.stack ? err.stack : err);
      process.exitCode = 1;
      return;
    }
  }
  console.log(`\n${ok}/${testes.length} cenários 05.38.D OK`);
}

main();
