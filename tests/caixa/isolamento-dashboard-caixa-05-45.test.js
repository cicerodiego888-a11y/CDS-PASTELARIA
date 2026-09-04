/**
 * Sprint 05.45 — Isolamento do dashboard e leituras operacionais de caixa.
 * Executar: node tests/caixa/isolamento-dashboard-caixa-05-45.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const CaixaProvider = require('../../backend/monitoring/providers/CaixaProvider');
const {
  montarSqlSessaoAberta,
  montarSqlHistoricoTurnosDaEmpresa,
  montarSqlMovimentacoesDaSessaoDaEmpresa,
  obterSessaoDaEmpresaPorId,
  obterMovimentacaoDaEmpresaPorId
} = require('../../backend/utils/caixaSessaoHelpers');
const { exigirCaixaCompativelComVenda } = require('../../backend/services/vendas/VendaEmpresaContextoService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');

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
    const conn = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(conn)));
  });
  await garantirSchemaEmpresasAsync(db);
  await run(db, `CREATE TABLE usuarios (id INTEGER PRIMARY KEY, nome TEXT)`);
  await run(db, `
    CREATE TABLE caixa (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data TEXT,
      valor_inicial REAL DEFAULT 0,
      status TEXT,
      terminal_id INTEGER,
      aberto_por INTEGER,
      fechado_por INTEGER
    )
  `);
  await run(db, `
    CREATE TABLE caixa_sessoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caixa_id INTEGER,
      caixa_turno_id INTEGER,
      terminal_id INTEGER,
      operador_id INTEGER,
      empresa_id INTEGER,
      valor_abertura REAL DEFAULT 0,
      status TEXT DEFAULT 'aberto',
      aberto_em TEXT,
      fechado_em TEXT
    )
  `);
  await run(db, `
    CREATE TABLE caixa_movimentacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caixa_id INTEGER,
      sessao_id INTEGER,
      tipo TEXT,
      valor REAL,
      usuario_id INTEGER
    )
  `);
  await run(db, `
    CREATE TABLE vendas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caixa_sessao_id INTEGER,
      empresa_id INTEGER,
      status TEXT,
      valor_fiscal REAL DEFAULT 0,
      valor_nao_fiscal REAL DEFAULT 0
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

async function abrirSessao(db, { empresaId, terminalId = 1, valor = 100 }) {
  const caixaIns = await run(db,
    `INSERT INTO caixa (data, valor_inicial, status, terminal_id) VALUES ('2026-08-25', ?, 'aberto', ?)`,
    [valor, terminalId]
  );
  const caixaId = caixaIns.lastID;
  const sessIns = await run(db, `
    INSERT INTO caixa_sessoes (caixa_turno_id, caixa_id, terminal_id, operador_id, empresa_id, status, valor_abertura)
    VALUES (?, ?, ?, 1, ?, 'aberto', ?)
  `, [caixaId, caixaId, terminalId, empresaId, valor]);
  return { caixaId, sessaoId: sessIns.lastID };
}

async function dashboard(db, empresaId) {
  return CaixaProvider.collect({ db, empresaId });
}

async function t01DashboardASoSessaoA() {
  const db = await criarDb();
  const { a, b } = await seedEmpresas(db);
  const sa = await abrirSessao(db, { empresaId: a.id });
  await abrirSessao(db, { empresaId: b.id });
  const r = await dashboard(db, a.id);
  assert.strictEqual(r.success, true);
  assert.strictEqual(Number(r.data.caixa.empresaId), Number(a.id));
  assert.strictEqual(Number(r.data.caixa.fiscal.sessaoId), Number(sa.sessaoId));
  db.close();
}

async function t02DashboardBSoSessaoB() {
  const db = await criarDb();
  const { a, b } = await seedEmpresas(db);
  await abrirSessao(db, { empresaId: a.id });
  const sb = await abrirSessao(db, { empresaId: b.id });
  const r = await dashboard(db, b.id);
  assert.strictEqual(Number(r.data.caixa.fiscal.sessaoId), Number(sb.sessaoId));
  db.close();
}

async function t03SessaoBMaisNovaNaoVazaParaA() {
  const db = await criarDb();
  const { a, b } = await seedEmpresas(db);
  const sa = await abrirSessao(db, { empresaId: a.id });
  const sb = await abrirSessao(db, { empresaId: b.id });
  assert.ok(Number(sb.sessaoId) > Number(sa.sessaoId));
  const r = await dashboard(db, a.id);
  assert.strictEqual(Number(r.data.caixa.fiscal.sessaoId), Number(sa.sessaoId));
  db.close();
}

async function t04SemSessaoNaoPegaGlobal() {
  const db = await criarDb();
  const { a, b } = await seedEmpresas(db);
  await abrirSessao(db, { empresaId: b.id });
  const r = await dashboard(db, a.id);
  assert.strictEqual(r.data.caixa.fiscal.sessaoId, null);
  assert.strictEqual(r.data.caixa.fiscal.status, 'fechado');
  assert.ok(r.warnings.includes('CAIXA_SESSAO_NAO_ENCONTRADA'));
  db.close();
}

async function t05MovimentacoesANaoAparecemParaB() {
  const db = await criarDb();
  const { a, b } = await seedEmpresas(db);
  const sa = await abrirSessao(db, { empresaId: a.id });
  const sb = await abrirSessao(db, { empresaId: b.id });
  await run(db, `INSERT INTO caixa_movimentacoes (caixa_id, sessao_id, tipo, valor) VALUES (?, ?, 'sangria', 15)`, [sa.caixaId, sa.sessaoId]);
  const q = montarSqlMovimentacoesDaSessaoDaEmpresa({ sessaoId: sa.sessaoId, empresaId: b.id });
  const rows = await all(db, q.sql, q.params);
  assert.strictEqual(rows.length, 0);
  const dashB = await dashboard(db, b.id);
  assert.strictEqual(Number(dashB.data.caixa.fiscal.sangrias), 0);
  assert.strictEqual(Number(dashB.data.caixa.fiscal.sessaoId), Number(sb.sessaoId));
  db.close();
}

async function t06MovimentacoesBNaoAparecemParaA() {
  const db = await criarDb();
  const { a, b } = await seedEmpresas(db);
  const sa = await abrirSessao(db, { empresaId: a.id });
  const sb = await abrirSessao(db, { empresaId: b.id });
  await run(db, `INSERT INTO caixa_movimentacoes (caixa_id, sessao_id, tipo, valor) VALUES (?, ?, 'sangria', 40)`, [sb.caixaId, sb.sessaoId]);
  const q = montarSqlMovimentacoesDaSessaoDaEmpresa({ sessaoId: sb.sessaoId, empresaId: a.id });
  const rows = await all(db, q.sql, q.params);
  assert.strictEqual(rows.length, 0);
  const dashA = await dashboard(db, a.id);
  assert.strictEqual(Number(dashA.data.caixa.fiscal.sangrias), 0);
  assert.strictEqual(Number(dashA.data.caixa.fiscal.sessaoId), Number(sa.sessaoId));
  db.close();
}

async function t07SessaoIdCruzado404() {
  const db = await criarDb();
  const { a, b } = await seedEmpresas(db);
  const sa = await abrirSessao(db, { empresaId: a.id });
  await assert.rejects(
    () => obterSessaoDaEmpresaPorId(db, { sessaoId: sa.sessaoId, empresaId: b.id }),
    (err) => err.code === 'CAIXA_SESSAO_NAO_ENCONTRADA' && err.statusCode === 404
  );
  db.close();
}

async function t08MovimentacaoIdCruzado404() {
  const db = await criarDb();
  const { a, b } = await seedEmpresas(db);
  const sa = await abrirSessao(db, { empresaId: a.id });
  const mov = await run(db, `INSERT INTO caixa_movimentacoes (caixa_id, sessao_id, tipo, valor) VALUES (?, ?, 'sangria', 9)`, [sa.caixaId, sa.sessaoId]);
  await assert.rejects(
    () => obterMovimentacaoDaEmpresaPorId(db, { movimentacaoId: mov.lastID, empresaId: b.id }),
    (err) => err.code === 'CAIXA_MOVIMENTACAO_NAO_ENCONTRADA' && err.statusCode === 404
  );
  const propria = await obterMovimentacaoDaEmpresaPorId(db, { movimentacaoId: mov.lastID, empresaId: a.id });
  assert.strictEqual(Number(propria.id), Number(mov.lastID));
  db.close();
}

async function t09NullNaoApareceParaA() {
  const db = await criarDb();
  const { a } = await seedEmpresas(db);
  await abrirSessao(db, { empresaId: null });
  const r = await dashboard(db, a.id);
  assert.strictEqual(r.data.caixa.fiscal.sessaoId, null);
  db.close();
}

async function t10NullNaoApareceParaB() {
  const db = await criarDb();
  const { b } = await seedEmpresas(db);
  await abrirSessao(db, { empresaId: null });
  const r = await dashboard(db, b.id);
  assert.strictEqual(r.data.caixa.fiscal.sessaoId, null);
  db.close();
}

function t11Regressao0544() {
  const helper = src('backend/utils/caixaSessaoHelpers.js');
  const provider = src('backend/monitoring/providers/CaixaProvider.js');
  assert.ok(!/FROM caixa_sessoes WHERE status = 'aberto' ORDER BY id DESC LIMIT 1/.test(helper));
  assert.ok(!/FROM caixa_sessoes WHERE status = 'aberto' ORDER BY id DESC LIMIT 1/.test(provider));
  assert.ok(!/FROM caixa WHERE status = 'aberto' ORDER BY id DESC LIMIT 1/.test(provider));
  assert.throws(() => montarSqlSessaoAberta({}), (err) => err.code === 'CAIXA_EMPRESA_OBRIGATORIA');
}

function t12VendaMesmaEmpresa() {
  assert.doesNotThrow(() => exigirCaixaCompativelComVenda(
    { caixaSessao: { id: 1, empresa_id: 2 } },
    2
  ));
}

function t13VendaOutraEmpresa() {
  assert.throws(
    () => exigirCaixaCompativelComVenda(
      { caixaSessao: { id: 1, empresa_id: 3 } },
      2
    ),
    (err) => err.code === 'CAIXA_SESSAO_EMPRESA_DIVERGENTE'
  );
}

async function t14HistoricoIsolado() {
  const db = await criarDb();
  const { a, b } = await seedEmpresas(db);
  const sa = await abrirSessao(db, { empresaId: a.id });
  const sb = await abrirSessao(db, { empresaId: b.id });
  const histA = montarSqlHistoricoTurnosDaEmpresa(a.id, { limite: 100 });
  const turnos = await all(db, histA.sql, histA.params);
  assert.ok(turnos.every((t) => Number(t.id) === Number(sa.caixaId)));
  assert.ok(!turnos.some((t) => Number(t.id) === Number(sb.caixaId)));
  db.close();
}

async function main() {
  const testes = [
    ['T01 dashboard A retorna só sessão A', t01DashboardASoSessaoA],
    ['T02 dashboard B retorna só sessão B', t02DashboardBSoSessaoB],
    ['T03 sessão B mais nova não vaza para A', t03SessaoBMaisNovaNaoVazaParaA],
    ['T04 sem sessão não pega última global', t04SemSessaoNaoPegaGlobal],
    ['T05 movimentações A não aparecem para B', t05MovimentacoesANaoAparecemParaB],
    ['T06 movimentações B não aparecem para A', t06MovimentacoesBNaoAparecemParaA],
    ['T07 sessaoId cruzado 404', t07SessaoIdCruzado404],
    ['T08 movimentacaoId cruzado 404', t08MovimentacaoIdCruzado404],
    ['T09 legado NULL não aparece para A', t09NullNaoApareceParaA],
    ['T10 legado NULL não aparece para B', t10NullNaoApareceParaB],
    ['T11 regressão 05.44 / sem LIMIT 1 global', t11Regressao0544],
    ['T12 venda + sessão da mesma empresa', t12VendaMesmaEmpresa],
    ['T13 venda + sessão de outra empresa bloqueada', t13VendaOutraEmpresa],
    ['T14 histórico empresarial isolado', t14HistoricoIsolado]
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
  console.log(`\n${ok}/${testes.length} cenários 05.45 OK`);
}

main();
