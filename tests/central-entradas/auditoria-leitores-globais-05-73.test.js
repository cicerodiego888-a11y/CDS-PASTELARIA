/**
 * Sprint 05.73 — Auditoria dos leitores globais de central_entradas_documentos.
 * NÃO altera produção. Executar: node tests/central-entradas/auditoria-leitores-globais-05-73.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const CentralDocumentosRepository = require('../../backend/motores/central-entradas/repositories/CentralDocumentosRepository');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');

const EMP_A = 11;
const EMP_B = 22;
const CHAVE_X = '23260707196033002141550090012840571375100827';

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
      xml TEXT NOT NULL DEFAULT '',
      fornecedor TEXT,
      status TEXT,
      parse_json TEXT,
      empresa_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(chave, empresa_id)
    )
  `);
  return db;
}

function repo(db) {
  return new CentralDocumentosRepository({ db });
}

function t01Inventario() {
  const repoSrc = src('backend/motores/central-entradas/repositories/CentralDocumentosRepository.js');
  assert.ok(repoSrc.includes('async buscarPorChave(chave, empresaId)'));
  assert.ok(repoSrc.includes('async buscarPorId(id)'));
  assert.ok(repoSrc.includes('listarPendentesProcessamento'));
  assert.ok(repoSrc.includes('listarFornecedoresNovos'));
  assert.ok(repoSrc.includes('obterMetricasOperacionais'));

  const avulsos = [
    'backend/services/IndicadoresFiscaisService.js',
    'backend/monitoring/providers/FiscalProvider.js',
    'backend/monitoring/intelligence/MonitoringAlertService.js',
    'backend/motores/central-entradas/health/HealthRepository.js',
    'backend/motores/central-entradas/services/CentralDiagnosticoService.js',
    'backend/services/fiscal/espelharTributosNfeDevolucaoCompra.js',
    'backend/rotas/compras.js',
    'backend/utils/comprasEmpresaHelpers.js'
  ];
  for (const f of avulsos) {
    assert.ok(src(f).includes('central_entradas_documentos'), `falta tabela em ${f}`);
  }
  console.log('  T01 inventário: repositório + 8 leitores SQL avulsos de produção');
}

function t02ReaderPrincipalChave() {
  const repoFn = src('backend/motores/central-entradas/repositories/CentralDocumentosRepository.js');
  const fn = repoFn.slice(
    repoFn.indexOf('async buscarPorChave(chave, empresaId)'),
    repoFn.indexOf('_montarClausulaWhere')
  );
  assert.ok(fn.includes('WHERE chave = ? AND empresa_id = ?'));
  assert.ok(!/WHERE chave = \?\s*`/.test(fn.replace('AND empresa_id', '')));

  const persist = src('backend/motores/central-entradas/services/CentralDfePersistenciaService.js');
  assert.ok(persist.includes('buscarPorChave(chave, empresaIdOperacao)'));
  assert.ok(!persist.includes('buscarPorChave(chave)'));

  const sync = src('backend/motores/central-entradas/services/CentralSincronizacaoService.js');
  assert.ok(sync.includes('buscarPorChave(chaveLimpa, empresaId)'));

  const rotas = src('backend/rotas/central-entradas.js');
  const bloco = rotas.slice(
    rotas.indexOf("router.get('/buscar-chave'"),
    rotas.indexOf("router.post('/upload'")
  );
  assert.ok(bloco.includes('resolverEmpresaParaCentral'));
  assert.ok(bloco.includes('empresaId: ctx.empresaId'));

  const xml = src('backend/services/fiscal/espelharTributosNfeDevolucaoCompra.js');
  assert.ok(xml.includes('REPLACE(chave, \' \', \'\') = ? AND empresa_id = ?'));

  const riscos = [];
  const health = src('backend/motores/central-entradas/health/HealthRepository.js');
  if (/FROM central_entradas_documentos\s+WHERE status NOT IN/.test(health)
    && !health.slice(health.indexOf('FROM central_entradas_documentos'), health.indexOf('carregarEstado')).includes('empresa_id')) {
    riscos.push('HealthRepository.scan sem empresa_id');
  }
  const fiscal = src('backend/monitoring/providers/FiscalProvider.js');
  const fnFiscal = fiscal.slice(
    fiscal.indexOf('async function ultimaEntradaFiscal'),
    fiscal.indexOf('async function agregarEntradasNaoFiscais')
  );
  assert.ok(fnFiscal.includes('WHERE empresa_id = ?'), '05.76 ultimaEntradaFiscal isolada');
  const repoSrcT02 = src('backend/motores/central-entradas/repositories/CentralDocumentosRepository.js');
  const forn = repoSrcT02.slice(
    repoSrcT02.indexOf('async listarFornecedoresNovos()'),
    repoSrcT02.indexOf('async listarValorAcimaMediaFornecedor')
  );
  if (forn.includes('FROM') && !forn.includes('empresa_id')) {
    riscos.push('listarFornecedoresNovos sem empresa_id');
  }
  assert.ok(riscos.length >= 1, 'auditoria deveria encontrar leitores globais residuais');
  console.log('  T02 lookup principal chave+empresa; globais residuais:', riscos.join(' | '));
}

async function t03exigeEmpresa() {
  const db = await criarDb();
  await run(db, `INSERT INTO central_entradas_documentos (chave, xml, fornecedor, empresa_id)
    VALUES (?, '<a/>', 'FORN_A', ?)`, [CHAVE_X, EMP_A]);
  const r = repo(db);
  assert.strictEqual(await r.buscarPorChave(CHAVE_X), null);
  assert.strictEqual(await r.buscarPorChave(CHAVE_X, null), null);
  assert.strictEqual(await r.buscarPorChave(CHAVE_X, 0), null);
  const ok = await r.buscarPorChave(CHAVE_X, EMP_A);
  assert.ok(ok && ok.empresaId === EMP_A);
  db.close();
  console.log('  T03 buscarPorChave exige empresa (sem fallback)');
}

async function t04aRetornaA() {
  const db = await criarDb();
  await run(db, `INSERT INTO central_entradas_documentos (id, chave, xml, fornecedor, empresa_id)
    VALUES (1, ?, '<a/>', 'FORN_A', ?)`, [CHAVE_X, EMP_A]);
  await run(db, `INSERT INTO central_entradas_documentos (id, chave, xml, fornecedor, empresa_id)
    VALUES (2, ?, '<b/>', 'FORN_B', ?)`, [CHAVE_X, EMP_B]);
  const doc = await repo(db).buscarPorChave(CHAVE_X, EMP_A);
  assert.strictEqual(doc.id, 1);
  assert.strictEqual(doc.fornecedor, 'FORN_A');
  db.close();
  console.log('  T04 A + X retorna A');
}

async function t05bRetornaB() {
  const db = await criarDb();
  await run(db, `INSERT INTO central_entradas_documentos (id, chave, xml, fornecedor, empresa_id)
    VALUES (1, ?, '<a/>', 'FORN_A', ?)`, [CHAVE_X, EMP_A]);
  await run(db, `INSERT INTO central_entradas_documentos (id, chave, xml, fornecedor, empresa_id)
    VALUES (2, ?, '<b/>', 'FORN_B', ?)`, [CHAVE_X, EMP_B]);
  const doc = await repo(db).buscarPorChave(CHAVE_X, EMP_B);
  assert.strictEqual(doc.id, 2);
  assert.strictEqual(doc.fornecedor, 'FORN_B');
  db.close();
  console.log('  T05 B + X retorna B');
}

async function t06bNaoRetornaA() {
  const db = await criarDb();
  await run(db, `INSERT INTO central_entradas_documentos (id, chave, xml, fornecedor, empresa_id)
    VALUES (1, ?, '<a/>', 'FORN_A', ?)`, [CHAVE_X, EMP_A]);
  await run(db, `INSERT INTO central_entradas_documentos (id, chave, xml, fornecedor, empresa_id)
    VALUES (2, ?, '<b/>', 'FORN_B', ?)`, [CHAVE_X, EMP_B]);
  const doc = await repo(db).buscarPorChave(CHAVE_X, EMP_B);
  assert.notStrictEqual(doc.id, 1);
  assert.notStrictEqual(doc.fornecedor, 'FORN_A');
  db.close();
  console.log('  T06 B não retorna A');
}

async function t07aNaoRetornaB() {
  const db = await criarDb();
  await run(db, `INSERT INTO central_entradas_documentos (id, chave, xml, fornecedor, empresa_id)
    VALUES (1, ?, '<a/>', 'FORN_A', ?)`, [CHAVE_X, EMP_A]);
  await run(db, `INSERT INTO central_entradas_documentos (id, chave, xml, fornecedor, empresa_id)
    VALUES (2, ?, '<b/>', 'FORN_B', ?)`, [CHAVE_X, EMP_B]);
  const doc = await repo(db).buscarPorChave(CHAVE_X, EMP_A);
  assert.notStrictEqual(doc.id, 2);
  assert.notStrictEqual(doc.fornecedor, 'FORN_B');
  db.close();
  console.log('  T07 A não retorna B');
}

async function t08null() {
  const db = await criarDb();
  await run(db, `INSERT INTO central_entradas_documentos (chave, xml, fornecedor, empresa_id)
    VALUES (?, '<n/>', 'FORN_NULL', NULL)`, [CHAVE_X]);
  const doc = await repo(db).buscarPorChave(CHAVE_X, EMP_A);
  assert.strictEqual(doc, null);
  db.close();
  console.log('  T08 documento NULL não é atribuído');
}

function t09semFallback() {
  const repoSrc = src('backend/motores/central-entradas/repositories/CentralDocumentosRepository.js');
  const fn = repoSrc.slice(
    repoSrc.indexOf('async buscarPorChave(chave, empresaId)'),
    repoSrc.indexOf('_montarClausulaWhere')
  );
  assert.ok(fn.includes('if (!Number.isInteger(emp) || emp <= 0) return null'));
  assert.ok(!fn.includes('COALESCE'));
  assert.ok(!fn.includes('IFNULL'));
  assert.ok(!fn.includes('empresa_operacional'));
  const docs = src('backend/utils/centralEntradasEmpresaHelpers.js');
  assert.ok(docs.includes('COALESCE(ativo, 1)'), 'COALESCE só em empresas.ativo (não em documento.empresa_id)');
  assert.ok(!/COALESCE\(\s*empresa_id/.test(src('backend/motores/central-entradas/repositories/CentralDocumentosRepository.js')));
  console.log('  T09 reader buscarPorChave sem fallback; sem COALESCE(empresa_id)');
}

async function t10update() {
  const repoSrc = src('backend/motores/central-entradas/repositories/CentralDocumentosRepository.js');
  const upd = repoSrc.slice(
    repoSrc.indexOf('async atualizar(id, dados)'),
    repoSrc.indexOf('async remover')
  );
  assert.ok(upd.includes('WHERE id = ?'));
  assert.ok(!upd.includes('WHERE chave'));

  const persist = src('backend/motores/central-entradas/services/CentralDfePersistenciaService.js');
  assert.ok(persist.includes('buscarPorChave(chave, empresaIdOperacao)'));

  const pend = repoSrc.slice(
    repoSrc.indexOf('async listarPendentesProcessamento'),
    repoSrc.indexOf('COLUNAS_LISTAGEM')
  );
  assert.ok(pend.includes('empresa_id = ?'));
  assert.ok(pend.includes('EMPRESA_CENTRAL_AUSENTE'));

  const db = await criarDb();
  await run(db, `INSERT INTO central_entradas_documentos (id, chave, xml, status, parse_json, empresa_id)
    VALUES (1, ?, '<a/>', 'XML_COMPLETO', NULL, ?)`, [CHAVE_X, EMP_A]);
  await run(db, `INSERT INTO central_entradas_documentos (id, chave, xml, status, parse_json, empresa_id)
    VALUES (2, ?, '<b/>', 'XML_COMPLETO', NULL, ?)`, [CHAVE_X, EMP_B]);
  const listaA = await repo(db).listarPendentesProcessamento(10, EMP_A);
  assert.deepStrictEqual(listaA.map((d) => d.id), [1]);
  const listaB = await repo(db).listarPendentesProcessamento(10, EMP_B);
  assert.deepStrictEqual(listaB.map((d) => d.id), [2]);
  db.close();

  const cert = src('backend/certification/ReleaseCertificationService.js');
  assert.ok(cert.includes('buscarPorChave(CHAVE)'));
  const homo = src('backend/certification/CentralInteligenteHomologacaoService.js');
  assert.ok(homo.includes('buscarPorChave(chave)'));

  console.log('  T10 UPDATE por chave isolado; fila pendentes isolada (05.74); cert 1-arg permanece E');
}

function tEstaticoEndpoints() {
  const rotas = src('backend/rotas/central-entradas.js');
  const ocorrencias = rotas.split("router.get('/buscar-chave'").length - 1;
  assert.strictEqual(ocorrencias, 1);
  assert.ok(rotas.includes('comDocumentoAutorizado'));
  const dfe = src('backend/rotas/dfe.js');
  assert.ok(dfe.includes("router.get('/consultar-chave'"));
  assert.ok(dfe.includes('410'));
  const join = src('backend/rotas/compras.js');
  assert.ok(join.includes('d.empresa_id = c.empresa_id'));
  console.log('  extra: um GET /buscar-chave; dfe 410; JOIN compras com empresa_id');
}

async function main() {
  console.log('05.73 auditoria leitores globais Central');
  t01Inventario();
  t02ReaderPrincipalChave();
  await t03exigeEmpresa();
  await t04aRetornaA();
  await t05bRetornaB();
  await t06bNaoRetornaA();
  await t07aNaoRetornaB();
  await t08null();
  t09semFallback();
  await t10update();
  tEstaticoEndpoints();
  console.log('OK 10/10');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
