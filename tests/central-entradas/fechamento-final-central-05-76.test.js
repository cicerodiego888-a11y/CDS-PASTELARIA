/**
 * Sprint 05.76 — Fechamento final Central (saúde + ultimaEntradaFiscal).
 * Executar: node tests/central-entradas/fechamento-final-central-05-76.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const HealthRepository = require('../../backend/motores/central-entradas/health/HealthRepository');
const HealthMonitor = require('../../backend/motores/central-entradas/health/HealthMonitor');
const { ultimaEntradaFiscal } = require('../../backend/monitoring/providers/FiscalProvider');
const CentralDocumentosRepository = require('../../backend/motores/central-entradas/repositories/CentralDocumentosRepository');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');

const EMP_A = 11;
const EMP_B = 22;
const EMP_C = 33;
const CHAVE_X = '23260707196033002141550090012840571375100827';
const STATUS = 'XML_COMPLETO';
const CNPJ_A = '11111111000191';
const CNPJ_B = '22222222000182';
const CNPJ_C = '33333333000173';

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
    (22, '22222222000182', 'Empresa B', 1),
    (33, '33333333000173', 'Empresa C', 1)
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
      data_entrada TEXT,
      xml TEXT NOT NULL DEFAULT '',
      parse_json TEXT,
      created_at TEXT,
      updated_at TEXT,
      empresa_id INTEGER
    )
  `);
  return db;
}

function dbGet(db) {
  return (sql, params) => get(db, sql, params);
}

function monitor(db, extras = {}) {
  return new HealthMonitor({
    db,
    obterMirx: () => ({
      obterEstadoDocumento: () => null,
      obterTelemetria: () => ({})
    }),
    obterOrchestrator: extras.obterOrchestrator || (() => ({
      processarDocumento: async () => {
        throw new Error('saúde não deve processar');
      }
    }))
  });
}

function saude(db, empresaId, extras = {}) {
  return monitor(db, extras).obterPainel({
    exigirEmpresa: true,
    empresaId,
    forcar: true,
    persistirEstado: false,
    atualizarCacheGlobal: false,
    autoRecuperar: false
  });
}

async function inserir(db, {
  id, empresaId, chave, fornecedor, cnpj, createdAt, numero
}) {
  await run(
    db,
    `INSERT INTO central_entradas_documentos
      (id, chave, numero, fornecedor, cnpj_fornecedor, xml, status, empresa_id,
       created_at, updated_at, data_emissao, data_entrada)
     VALUES (?, ?, ?, ?, ?, '<xml/>', ?, ?, ?, ?, ?, ?)`,
    [
      id,
      chave,
      numero || String(id),
      fornecedor,
      cnpj,
      STATUS,
      empresaId,
      createdAt || '2026-01-01 00:00:00',
      createdAt || '2026-01-01 00:00:00',
      createdAt || '2026-01-01 00:00:00',
      createdAt || '2026-01-01 00:00:00'
    ]
  );
}

async function seedABC(db) {
  await inserir(db, {
    id: 1, empresaId: EMP_A, chave: CHAVE_X, fornecedor: 'FORN_A', cnpj: CNPJ_A,
    createdAt: '2026-06-01 00:00:00'
  });
  await inserir(db, {
    id: 2, empresaId: EMP_B, chave: CHAVE_X, fornecedor: 'FORN_B', cnpj: CNPJ_B,
    createdAt: '2026-07-01 00:00:00'
  });
  await inserir(db, {
    id: 3, empresaId: EMP_C, chave: 'C'.padEnd(44, '3'), fornecedor: 'FORN_C', cnpj: CNPJ_C,
    createdAt: '2026-08-01 00:00:00'
  });
}

function ids(painel) {
  return (painel.documentos || []).map((d) => Number(d.documentoId)).sort((a, b) => a - b);
}

function texto(painel) {
  return JSON.stringify(painel);
}

async function t01() {
  const db = await criarDb();
  await seedABC(db);
  const p = await saude(db, EMP_A);
  assert.deepStrictEqual(ids(p), [1]);
  assert.ok(!texto(p).includes('FORN_B'));
  assert.ok(!texto(p).includes('FORN_C'));
  db.close();
  console.log('  T01 saúde A somente A');
}

async function t02() {
  const db = await criarDb();
  await seedABC(db);
  const p = await saude(db, EMP_B);
  assert.deepStrictEqual(ids(p), [2]);
  db.close();
  console.log('  T02 saúde B somente B');
}

async function t03() {
  const db = await criarDb();
  await seedABC(db);
  const p = await saude(db, EMP_C);
  assert.deepStrictEqual(ids(p), [3]);
  db.close();
  console.log('  T03 saúde C somente C');
}

async function t04() {
  const db = await criarDb();
  await seedABC(db);
  const p = await saude(db, EMP_A);
  assert.ok(!texto(p).includes(CNPJ_B));
  assert.ok(!texto(p).includes(CNPJ_C));
  assert.ok(!ids(p).includes(2));
  db.close();
  console.log('  T04 saúde não expõe documento cruzado');
}

async function t05() {
  const db = await criarDb();
  await seedABC(db);
  const r = await ultimaEntradaFiscal(EMP_A, { dbGet: dbGet(db) });
  assert.strictEqual(r.ultimaNf.chave, CHAVE_X);
  assert.strictEqual(r.fornecedor, 'FORN_A');
  assert.strictEqual(r.ultimaNf.empresaId, EMP_A);
  db.close();
  console.log('  T05 ultimaEntradaFiscal A somente A');
}

async function t06() {
  const db = await criarDb();
  await seedABC(db);
  const r = await ultimaEntradaFiscal(EMP_B, { dbGet: dbGet(db) });
  assert.strictEqual(r.fornecedor, 'FORN_B');
  assert.notStrictEqual(r.fornecedor, 'FORN_A');
  db.close();
  console.log('  T06 ultimaEntradaFiscal B somente B');
}

async function t07() {
  const db = await criarDb();
  await seedABC(db);
  const r = await ultimaEntradaFiscal(EMP_C, { dbGet: dbGet(db) });
  assert.strictEqual(r.fornecedor, 'FORN_C');
  db.close();
  console.log('  T07 ultimaEntradaFiscal C somente C');
}

async function t08() {
  const db = await criarDb();
  await inserir(db, {
    id: 99, empresaId: null, chave: CHAVE_X, fornecedor: 'FORN_NULL', cnpj: '00000000000000',
    createdAt: '2026-12-01 00:00:00'
  });
  await inserir(db, {
    id: 1, empresaId: EMP_A, chave: 'A'.padEnd(44, '1'), fornecedor: 'FORN_A', cnpj: CNPJ_A,
    createdAt: '2026-01-01 00:00:00'
  });
  const p = await saude(db, EMP_A);
  const u = await ultimaEntradaFiscal(EMP_A, { dbGet: dbGet(db) });
  assert.ok(!ids(p).includes(99));
  assert.ok(!texto(p).includes('FORN_NULL'));
  assert.strictEqual(u.fornecedor, 'FORN_A');
  db.close();
  console.log('  T08 documento NULL não atribuído');
}

async function t09() {
  let n = 0;
  const spy = async () => {
    n += 1;
    return { chave: 'X', fornecedor: 'LEAK' };
  };
  const r = await ultimaEntradaFiscal(null, { dbGet: spy });
  assert.strictEqual(n, 0);
  assert.strictEqual(r.ultimaNf, null);
  await assert.rejects(
    () => monitor({}).obterPainel({ exigirEmpresa: true }),
    (err) => err.code === 'EMPRESA_CENTRAL_AUSENTE'
  );
  console.log('  T09 empresa ausente não executa SELECT global');
}

function t10() {
  const fiscal = src('backend/monitoring/providers/FiscalProvider.js');
  const fn = fiscal.slice(
    fiscal.indexOf('async function ultimaEntradaFiscal'),
    fiscal.indexOf('async function agregarEntradasNaoFiscais')
  );
  assert.ok(fnFiscalHasEmpresa(fn));
  const health = src('backend/motores/central-entradas/health/HealthRepository.js');
  const ult = health.slice(
    health.indexOf('async obterUltimaEntrada'),
    health.indexOf('async carregarEstado')
  );
  assert.ok(ult.includes('WHERE empresa_id = ?'));
  assert.ok(ult.includes('LIMIT 1'));
  const idxWhere = ult.indexOf('WHERE empresa_id = ?');
  const idxLimit = ult.indexOf('LIMIT 1');
  assert.ok(idxWhere < idxLimit);
  console.log('  T10 LIMIT 1 empresarial isolado (saúde + FiscalProvider)');
}

function fnFiscalHasEmpresa(fn) {
  assert.ok(fn.includes('WHERE empresa_id = ?'));
  assert.ok(fn.indexOf('WHERE empresa_id = ?') < fn.indexOf('LIMIT 1'));
  return true;
}

function t11() {
  const rotas = src('backend/rotas/central-entradas.js');
  const saude = rotas.slice(
    rotas.indexOf("router.get('/saude'"),
    rotas.indexOf("router.get('/saude/alertas'")
  );
  assert.ok(saude.includes('autoRecuperar: false'));
  assert.ok(!saude.includes('listarPendentesProcessamento'));
  const reproc = rotas.slice(
    rotas.indexOf("router.post('/diagnostico/acoes/reprocessar-pendencias'"),
    rotas.indexOf("router.post('/diagnostico/acoes/testar-certificado'")
  );
  assert.ok(reproc.includes('resolverEmpresaParaCentral'));
  assert.ok(reproc.includes('empresaId: ctx.empresaId'));
  console.log('  T11 diagnóstico/saúde não alimenta fila global');
}

async function t12() {
  const db = await criarDb();
  await seedABC(db);
  let proc = 0;
  await saude(db, EMP_A, {
    obterOrchestrator: () => ({
      processarDocumento: async () => {
        proc += 1;
      }
    })
  });
  assert.strictEqual(proc, 0);
  db.close();
  console.log('  T12 saúde não processa (cruzado ou próprio)');
}

async function t13() {
  const db = await criarDb();
  await seedABC(db);
  const repo = new CentralDocumentosRepository({ db });
  const a = await repo.buscarPorChave(CHAVE_X, EMP_A);
  const b = await repo.buscarPorChave(CHAVE_X, EMP_B);
  assert.strictEqual(a.id, 1);
  assert.strictEqual(b.id, 2);
  assert.strictEqual(a.fornecedor, 'FORN_A');
  db.close();
  console.log('  T13 cross-company lookup bloqueado (chave+empresa)');
}

function t14() {
  const repoSrc = src('backend/motores/central-entradas/repositories/CentralDocumentosRepository.js');
  assert.ok(repoSrc.includes('async buscarPorChave(chave, empresaId)'));
  assert.ok(src('backend/utils/centralEntradasEmpresaHelpers.js').includes('UNIQUE(chave, empresa_id)')
    || src('backend/utils/centralEntradasEmpresaHelpers.js').includes('chave, empresa_id'));
  console.log('  T14 identidade chave + empresa preservada');
}

async function t15() {
  const db = await criarDb();
  await seedABC(db);
  const before = await get(db, 'SELECT chave, fornecedor, status FROM central_entradas_documentos WHERE id = 2');
  await saude(db, EMP_A);
  const after = await get(db, 'SELECT chave, fornecedor, status FROM central_entradas_documentos WHERE id = 2');
  assert.deepStrictEqual(after, before);
  const rotas = src('backend/rotas/central-entradas.js');
  const bloco = rotas.slice(
    rotas.indexOf("router.get('/saude'"),
    rotas.indexOf("router.get('/saude/alertas'")
  );
  assert.ok(bloco.includes('persistirEstado: false'));
  db.close();
  console.log('  T15 consulta de saúde sem mutação');
}

async function t16() {
  const db = await criarDb();
  await seedABC(db);
  const before = await get(db, 'SELECT * FROM central_entradas_documentos WHERE id = 3');
  await saude(db, EMP_A);
  await ultimaEntradaFiscal(EMP_A, { dbGet: dbGet(db) });
  const after = await get(db, 'SELECT * FROM central_entradas_documentos WHERE id = 3');
  assert.deepStrictEqual(after, before);
  db.close();
  console.log('  T16 documento de outra empresa inalterado');
}

function t17() {
  const acesso = src('frontend/shared/js/pdv-acesso-oficial.js');
  assert.ok(acesso.includes('CONGELADO'));
  assert.ok(src('docs/arquitetura/PDV_UNIVERSAL_CONGELADO.md').includes('CONGELADO'));
  console.log('  T17 PDV Universal permanece congelado');
}

function t18() {
  const arquivos = [
    'tests/central-entradas/modo-multiempresa-05-54.test.js',
    'tests/central-entradas/identidade-documento-empresa-05-70.test.js',
    'tests/central-entradas/isolamento-xml-devolucao-empresa-05-71.test.js',
    'tests/central-entradas/isolamento-buscar-chave-empresa-05-72.test.js',
    'tests/central-entradas/auditoria-leitores-globais-05-73.test.js',
    'tests/central-entradas/isolamento-fila-processamento-05-74.test.js',
    'tests/auditoria/isolamento-pdv-universal-05-75.test.js'
  ];
  for (const rel of arquivos) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), rel);
  }
  console.log('  T18 suítes de regressão principais presentes');
}

async function main() {
  console.log('05.76 fechamento final Central');
  await t01();
  await t02();
  await t03();
  await t04();
  await t05();
  await t06();
  await t07();
  await t08();
  await t09();
  t10();
  t11();
  await t12();
  await t13();
  t14();
  await t15();
  await t16();
  t17();
  t18();
  console.log('OK 18/18');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
