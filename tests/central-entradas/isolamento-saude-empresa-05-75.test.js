/**
 * Sprint 05.75 — Isolamento empresarial do GET /saude (Health Repository/Monitor).
 * Executar: node tests/central-entradas/isolamento-saude-empresa-05-75.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const HealthRepository = require('../../backend/motores/central-entradas/health/HealthRepository');
const HealthMonitor = require('../../backend/motores/central-entradas/health/HealthMonitor');
const { resolverEmpresaParaCentral } = require('../../backend/services/central-entradas/CentralEntradasEmpresaContextoService');
const { ModoOperacionalGlobal } = require('../../backend/core/modo-operacional');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');

const EMP_A = 11;
const EMP_B = 22;
const CHAVE_X = '23260707196033002141550090012840571375100827';
const STATUS = 'XML_COMPLETO';
const CNPJ_A = '11111111000191';
const CNPJ_B = '22222222000182';

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

async function openMem() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

async function criarDb() {
  const db = await openMem();
  await garantirSchemaEmpresasAsync(db);
  await run(db, `
    INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES
    (11, '11111111000191', 'Empresa A', 1),
    (22, '22222222000182', 'Empresa B', 1)
  `);
  await run(db, `
    CREATE TABLE central_entradas_documentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chave TEXT NOT NULL,
      numero TEXT,
      serie TEXT,
      fornecedor TEXT,
      cnpj_fornecedor TEXT,
      valor_total REAL,
      nsu TEXT,
      origem TEXT,
      status TEXT,
      status_detalhe TEXT,
      tipo_documento TEXT,
      miip_sessao_id TEXT,
      miip_resumo_json TEXT,
      compra_id INTEGER,
      processado_em TEXT,
      data_emissao TEXT,
      xml TEXT NOT NULL DEFAULT '',
      parse_json TEXT,
      created_at TEXT,
      updated_at TEXT,
      empresa_id INTEGER
    )
  `);
  return db;
}

function contratoMulti() {
  return { modo_operacional: ModoOperacionalGlobal.MULTIEMPRESA, empresa_operacional: null };
}

function contratoSimples(empresaId) {
  return {
    modo_operacional: ModoOperacionalGlobal.EMPRESA_SIMPLES,
    empresa_operacional: {
      empresa_id: empresaId,
      cnpj: empresaId === EMP_A ? CNPJ_A : CNPJ_B
    }
  };
}

function empresaServiceStub() {
  return {
    buscarEmpresaPorId: async (id) => {
      const n = Number(id);
      if (n === EMP_A) return { id: EMP_A, cnpj: CNPJ_A, ativo: 1 };
      if (n === EMP_B) return { id: EMP_B, cnpj: CNPJ_B, ativo: 1 };
      return null;
    }
  };
}

function monitor(db) {
  return new HealthMonitor({
    db,
    obterMirx: () => ({
      obterEstadoDocumento: () => null,
      obterTelemetria: () => ({ documentosRecuperados: 9, numeroTentativas: 9 })
    }),
    obterOrchestrator: () => ({
      processarDocumento: async () => {}
    })
  });
}

function painelEmpresa(db, empresaId) {
  return monitor(db).obterPainel({
    exigirEmpresa: true,
    empresaId,
    forcar: true,
    persistirEstado: false,
    atualizarCacheGlobal: false,
    autoRecuperar: false
  });
}

async function inserir(db, {
  id, empresaId, chave, fornecedor, cnpj, createdAt, updatedAt, status
}) {
  await run(
    db,
    `INSERT INTO central_entradas_documentos
      (id, chave, fornecedor, cnpj_fornecedor, xml, status, empresa_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, '<xml/>', ?, ?, ?, ?)`,
    [
      id,
      chave,
      fornecedor,
      cnpj,
      status || STATUS,
      empresaId,
      createdAt || '2026-01-01 00:00:00',
      updatedAt || createdAt || '2026-01-01 00:00:00'
    ]
  );
}

async function seedAB(db) {
  await inserir(db, {
    id: 1, empresaId: EMP_A, chave: CHAVE_X, fornecedor: 'FORN_A', cnpj: CNPJ_A
  });
  await inserir(db, {
    id: 2, empresaId: EMP_B, chave: CHAVE_X, fornecedor: 'FORN_B', cnpj: CNPJ_B
  });
}

function idsScan(painel) {
  return (painel.documentos || []).map((d) => Number(d.documentoId)).sort((a, b) => a - b);
}

function textoPainel(painel) {
  return JSON.stringify(painel);
}

async function t01() {
  const db = await criarDb();
  const spy = new HealthRepository({ db });
  const calls = [];
  const origListar = spy.listarDocumentosParaAnalise.bind(spy);
  spy.listarDocumentosParaAnalise = async function listar(limite, empresaId) {
    calls.push({ limite, empresaId });
    return origListar(limite, empresaId);
  };
  const mon = new HealthMonitor({
    repository: spy,
    obterMirx: () => ({ obterEstadoDocumento: () => null, obterTelemetria: () => ({}) }),
    obterOrchestrator: () => ({})
  });
  await assert.rejects(
    () => mon.obterPainel({ exigirEmpresa: true }),
    (err) => err.code === 'EMPRESA_CENTRAL_AUSENTE'
  );
  assert.strictEqual(calls.length, 0);

  await assert.rejects(
    () => resolverEmpresaParaCentral(
      { req: { headers: {}, query: {} } },
      { db, contrato: contratoMulti(), EmpresaService: empresaServiceStub() }
    ),
    (err) => err.code === 'EMPRESA_CENTRAL_AUSENTE'
  );

  const ctxSimples = await resolverEmpresaParaCentral(
    { req: { headers: {}, query: {} } },
    { db, contrato: contratoSimples(EMP_A), EmpresaService: empresaServiceStub() }
  );
  assert.strictEqual(ctxSimples.empresaId, EMP_A);
  db.close();
  console.log('  T01 saúde exige contexto empresarial (MULTI); SIMPLES resolve operacional');
}

async function t02() {
  const db = await criarDb();
  await seedAB(db);
  const painel = await painelEmpresa(db, EMP_A);
  assert.deepStrictEqual(idsScan(painel), [1]);
  assert.strictEqual(painel.empresaId, EMP_A);
  assert.strictEqual(painel.estatisticas.ultimaEntrada.id, 1);
  db.close();
  console.log('  T02 empresa A recebe somente dados de A');
}

async function t03() {
  const db = await criarDb();
  await seedAB(db);
  const painel = await painelEmpresa(db, EMP_B);
  assert.deepStrictEqual(idsScan(painel), [2]);
  assert.strictEqual(painel.estatisticas.ultimaEntrada.id, 2);
  db.close();
  console.log('  T03 empresa B recebe somente dados de B');
}

async function t04() {
  const db = await criarDb();
  await seedAB(db);
  const a = await painelEmpresa(db, EMP_A);
  const b = await painelEmpresa(db, EMP_B);
  assert.strictEqual(a.estatisticas.ultimaEntrada.chave, CHAVE_X);
  assert.strictEqual(b.estatisticas.ultimaEntrada.chave, CHAVE_X);
  assert.strictEqual(a.estatisticas.ultimaEntrada.id, 1);
  assert.strictEqual(b.estatisticas.ultimaEntrada.id, 2);
  db.close();
  console.log('  T04 mesma chave em A/B não cruza');
}

async function t05() {
  const db = await criarDb();
  await seedAB(db);
  const b = await painelEmpresa(db, EMP_B);
  assert.ok(!textoPainel(b).includes('FORN_A'));
  db.close();
  console.log('  T05 fornecedor de A não aparece na saúde B');
}

async function t06() {
  const db = await criarDb();
  await seedAB(db);
  const b = await painelEmpresa(db, EMP_B);
  assert.ok(!textoPainel(b).includes(CNPJ_A));
  assert.ok(textoPainel(b).includes(CNPJ_B));
  db.close();
  console.log('  T06 CNPJ de A não aparece na saúde B');
}

async function t07() {
  const db = await criarDb();
  await inserir(db, {
    id: 1, empresaId: EMP_A, chave: 'A'.padEnd(44, '1'), fornecedor: 'FORN_A_OLD',
    cnpj: CNPJ_A, createdAt: '2024-01-01 00:00:00', updatedAt: '2024-01-01 00:00:00'
  });
  await inserir(db, {
    id: 2, empresaId: EMP_A, chave: 'A'.padEnd(44, '2'), fornecedor: 'FORN_A_NEW',
    cnpj: CNPJ_A, createdAt: '2026-06-01 00:00:00', updatedAt: '2026-06-01 00:00:00'
  });
  await inserir(db, {
    id: 3, empresaId: EMP_B, chave: 'B'.padEnd(44, '9'), fornecedor: 'FORN_B_NEWER',
    cnpj: CNPJ_B, createdAt: '2026-08-01 00:00:00', updatedAt: '2026-08-01 00:00:00'
  });
  const a = await painelEmpresa(db, EMP_A);
  assert.strictEqual(a.estatisticas.ultimaEntrada.id, 2);
  assert.strictEqual(a.estatisticas.ultimaEntrada.fornecedor, 'FORN_A_NEW');
  assert.notStrictEqual(a.estatisticas.ultimaEntrada.id, 3);
  db.close();
  console.log('  T07 LIMIT 1: última entrada A = recente A, nunca B');
}

async function t08() {
  const db = await criarDb();
  await inserir(db, {
    id: 99, empresaId: null, chave: CHAVE_X, fornecedor: 'FORN_NULL', cnpj: '00000000000000'
  });
  await inserir(db, {
    id: 1, empresaId: EMP_A, chave: 'A'.padEnd(44, '3'), fornecedor: 'FORN_A', cnpj: CNPJ_A
  });
  const a = await painelEmpresa(db, EMP_A);
  const b = await painelEmpresa(db, EMP_B);
  assert.ok(!idsScan(a).includes(99));
  assert.ok(!idsScan(b).includes(99));
  assert.ok(!textoPainel(a).includes('FORN_NULL'));
  assert.ok(!textoPainel(b).includes('FORN_NULL'));
  assert.strictEqual(a.estatisticas.totalDocumentos, 1);
  assert.strictEqual(b.estatisticas.totalDocumentos, 0);
  db.close();
  console.log('  T08 documento NULL não é atribuído à empresa');
}

async function t09() {
  const db = await criarDb();
  await seedAB(db);
  const sqls = [];
  const repo = new HealthRepository({ db });
  const origSql = repo._obterSql.bind(repo);
  repo._obterSql = function obterSql() {
    const h = origSql();
    return {
      whenReady: () => h.whenReady(),
      get: async (sql, params) => {
        sqls.push(sql);
        return h.get(sql, params);
      },
      all: async (sql, params) => {
        sqls.push(sql);
        return h.all(sql, params);
      },
      run: h.run.bind(h)
    };
  };
  const mon = new HealthMonitor({
    repository: repo,
    obterMirx: () => ({ obterEstadoDocumento: () => null, obterTelemetria: () => ({}) }),
    obterOrchestrator: () => ({})
  });
  await assert.rejects(
    () => mon.obterPainel({ exigirEmpresa: true }),
    (err) => err.code === 'EMPRESA_CENTRAL_AUSENTE'
  );
  assert.strictEqual(sqls.length, 0, 'MULTIEMPRESA sem empresa não executa SELECT');

  const rotas = src('backend/rotas/central-entradas.js');
  const bloco = rotas.slice(
    rotas.indexOf("router.get('/saude'"),
    rotas.indexOf("router.get('/saude/alertas'")
  );
  assert.ok(bloco.includes('resolverEmpresaParaCentral'));
  assert.ok(bloco.indexOf('resolverEmpresaParaCentral') < bloco.indexOf('obterSaudeCentral'));
  db.close();
  console.log('  T09 MULTIEMPRESA sem empresa não executa SELECT global');
}

async function t10() {
  const db = await criarDb();
  await seedAB(db);
  const sqls = [];
  const repo = new HealthRepository({ db });
  const origSql = repo._obterSql.bind(repo);
  repo._obterSql = function obterSql() {
    const h = origSql();
    return {
      whenReady: () => h.whenReady(),
      get: async (sql, params) => {
        sqls.push({ sql, params });
        return h.get(sql, params);
      },
      all: async (sql, params) => {
        sqls.push({ sql, params });
        return h.all(sql, params);
      },
      run: h.run.bind(h)
    };
  };
  const mon = new HealthMonitor({
    repository: repo,
    obterMirx: () => ({ obterEstadoDocumento: () => null, obterTelemetria: () => ({}) }),
    obterOrchestrator: () => ({})
  });
  await mon.obterPainel({
    exigirEmpresa: true,
    empresaId: EMP_A,
    persistirEstado: false,
    atualizarCacheGlobal: false,
    autoRecuperar: false
  });
  const docsSql = sqls.filter((s) => /central_entradas_documentos/.test(s.sql));
  assert.ok(docsSql.length >= 3, 'listar + COUNT + LIMIT 1');
  for (const q of docsSql) {
    assert.ok(/empresa_id\s*=\s*\?/.test(q.sql), q.sql);
    assert.ok(q.params.includes(EMP_A));
  }
  const health = src('backend/motores/central-entradas/health/HealthRepository.js');
  assert.ok(health.includes('AND empresa_id = ?'));
  assert.ok(health.includes('WHERE empresa_id = ?'));
  db.close();
  console.log('  T10 nenhuma métrica documental do painel HTTP ignora empresa_id');
}

async function t11() {
  const db = await criarDb();
  await seedAB(db);
  const b = await painelEmpresa(db, EMP_B);
  const t = textoPainel(b);
  assert.ok(!t.includes('"documentoId":1'));
  assert.ok(!t.includes('"id":1'));
  assert.ok(!t.includes('FORN_A'));
  assert.ok(!t.includes(CNPJ_A));
  db.close();
  console.log('  T11 empresa B não recebe campos do documento A');
}

async function t12() {
  const db = await criarDb();
  for (let i = 1; i <= 3; i += 1) {
    await inserir(db, {
      id: i,
      empresaId: EMP_A,
      chave: String(i).padEnd(44, 'A'),
      fornecedor: 'FORN_A',
      cnpj: CNPJ_A
    });
  }
  for (let i = 1; i <= 7; i += 1) {
    await inserir(db, {
      id: 10 + i,
      empresaId: EMP_B,
      chave: String(i).padEnd(44, 'B'),
      fornecedor: 'FORN_B',
      cnpj: CNPJ_B
    });
  }
  const a = await painelEmpresa(db, EMP_A);
  const b = await painelEmpresa(db, EMP_B);
  assert.strictEqual(a.estatisticas.totalDocumentos, 3);
  assert.strictEqual(b.estatisticas.totalDocumentos, 7);
  assert.strictEqual(a.analisados, 3);
  assert.strictEqual(b.analisados, 7);
  db.close();
  console.log('  T12 contadores A/B independentes (3 vs 7)');
}

async function t13() {
  const dash = src('backend/motores/central-entradas/services/CentralDashboardService.js');
  const rotas = src('backend/rotas/central-entradas.js');
  assert.ok(dash.includes('exigirEmpresa: true'));
  assert.ok(!/obterPainel\(\{\s*forcar:\s*false\s*\}\)/.test(dash));
  const trecho = rotas.slice(rotas.indexOf("router.get('/dashboard'"));
  const corpo = trecho.slice(0, trecho.indexOf("router.get('/alertas'"));
  assert.ok(corpo.includes('resolverEmpresaParaCentral'));
  assert.ok(!corpo.includes('consolidada_sem_identificacao_por_empresa'));
  console.log('  T13 dashboard/saúde usa a mesma empresa da lista');
}

async function main() {
  console.log('05.75 isolamento saúde empresa');
  await t01();
  await t02();
  await t03();
  await t04();
  await t05();
  await t06();
  await t07();
  await t08();
  await t09();
  await t10();
  await t11();
  await t12();
  t13();
  console.log('OK 13/13');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
