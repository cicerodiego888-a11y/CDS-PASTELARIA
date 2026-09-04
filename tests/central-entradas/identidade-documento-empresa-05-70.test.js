/**
 * Sprint 05.70 — Identidade empresarial do documento Central (chave + empresa_id).
 * Executar: node tests/central-entradas/identidade-documento-empresa-05-70.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const CentralDocumentosRepository = require('../../backend/motores/central-entradas/repositories/CentralDocumentosRepository');
const CentralDfePersistenciaService = require('../../backend/motores/central-entradas/services/CentralDfePersistenciaService');
const {
  migrarIdentidadeUnicaChaveEmpresaDocumentos,
  inspecionarIndicesUnicosDocumentos
} = require('../../backend/utils/centralEntradasEmpresaHelpers');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');

const EMP_A = 11;
const EMP_B = 22;
const EMP_C = 33;
const CHAVE_X = '23260707196033002141550090012840571375100827';

const XML_RES = `<?xml version="1.0"?>
<resNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">
  <chNFe>${CHAVE_X}</chNFe>
  <CNPJ>07196033002141</CNPJ>
  <xNome>FORN</xNome>
  <dhEmi>2026-07-01T10:00:00-03:00</dhEmi>
  <tpNF>1</tpNF>
  <vNF>10.00</vNF>
  <digVal>abc</digVal>
  <dhRecbto>2026-07-01T10:01:00-03:00</dhRecbto>
  <nProt>123</nProt>
  <cSitNFe>1</cSitNFe>
</resNFe>`;

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
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

async function openMem() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

async function criarDbAntigo() {
  const db = await openMem();
  await garantirSchemaEmpresasAsync(db);
  await run(db, `
    INSERT INTO empresas (id, cnpj, razao_social, ativo) VALUES
    (11, '11111111000191', 'Empresa A', 1),
    (22, '22222222000182', 'Empresa B', 1),
    (33, '33333333000173', 'Empresa C', 1)
  `);
  await run(db, `
    CREATE TABLE compras (
      id INTEGER PRIMARY KEY,
      tipo_entrada TEXT,
      tipo_entrada_sugerido TEXT,
      tipo_entrada_confianca REAL,
      tipo_entrada_motivo TEXT,
      tipo_entrada_alterado INTEGER
    )
  `);
  await run(db, `
    CREATE TABLE central_entradas_documentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chave TEXT NOT NULL UNIQUE,
      numero TEXT,
      serie TEXT,
      modelo TEXT DEFAULT '55',
      fornecedor TEXT,
      cnpj_fornecedor TEXT,
      data_emissao TEXT,
      data_entrada TEXT,
      valor_total REAL,
      xml TEXT NOT NULL DEFAULT '',
      nsu TEXT,
      origem TEXT DEFAULT 'dfe',
      status TEXT,
      status_detalhe TEXT,
      tipo_documento TEXT,
      parse_json TEXT,
      miip_sessao_id TEXT,
      miip_resumo_json TEXT,
      compra_id INTEGER,
      usuario_id INTEGER,
      processado_em DATETIME,
      empresa_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(db, `
    CREATE TABLE central_entradas_historico (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      documento_id INTEGER,
      status_anterior TEXT,
      status_novo TEXT,
      usuario_id INTEGER,
      detalhe TEXT
    )
  `);
  return db;
}

async function schemaNovo(db) {
  return migrarIdentidadeUnicaChaveEmpresaDocumentos(db);
}

function repo(db) {
  return new CentralDocumentosRepository({ db });
}

async function uniqueComposto(db) {
  const unicos = await inspecionarIndicesUnicosDocumentos(db);
  return unicos.find((u) => (
    u.colunas.length === 2 && u.colunas[0] === 'chave' && u.colunas[1] === 'empresa_id'
  ));
}

async function t01semUniqueGlobal() {
  const db = await criarDbAntigo();
  await schemaNovo(db);
  const unicos = await inspecionarIndicesUnicosDocumentos(db);
  const soChave = unicos.filter((u) => u.colunas.length === 1 && u.colunas[0] === 'chave');
  assert.strictEqual(soChave.length, 0);
  const ddl = src('backend/database.js');
  const bloco = ddl.slice(
    ddl.indexOf('CREATE TABLE IF NOT EXISTS central_entradas_documentos'),
    ddl.indexOf('CREATE TABLE IF NOT EXISTS central_entradas_historico')
  );
  assert.ok(!/chave TEXT NOT NULL UNIQUE/.test(bloco));
  db.close();
  console.log('  T01 chave deixou de ser UNIQUE global');
}

async function t02uniqueComposto() {
  const db = await criarDbAntigo();
  await schemaNovo(db);
  const idx = await uniqueComposto(db);
  assert.ok(idx, 'UNIQUE(chave, empresa_id) ausente');
  const info = await all(db, `PRAGMA index_info("${idx.name}")`);
  assert.deepStrictEqual(info.sort((a, b) => a.seqno - b.seqno).map((c) => c.name), ['chave', 'empresa_id']);
  db.close();
  console.log('  T02 UNIQUE(chave, empresa_id) existe');
}

async function t03insertA() {
  const db = await criarDbAntigo();
  await schemaNovo(db);
  await repo(db).inserir({ chave: CHAVE_X, xml: '<a/>', empresaId: EMP_A, status: 'RESUMO_RECEBIDO' });
  const row = await get(db, 'SELECT empresa_id FROM central_entradas_documentos WHERE chave = ? AND empresa_id = ?', [CHAVE_X, EMP_A]);
  assert.strictEqual(row.empresa_id, EMP_A);
  db.close();
  console.log('  T03 INSERT A + X');
}

async function t04rejeitaDuplicataA() {
  const db = await criarDbAntigo();
  await schemaNovo(db);
  await repo(db).inserir({ chave: CHAVE_X, xml: '<a/>', empresaId: EMP_A });
  let ok = false;
  try {
    await repo(db).inserir({ chave: CHAVE_X, xml: '<a2/>', empresaId: EMP_A });
  } catch (err) {
    ok = /UNIQUE/i.test(String(err.message));
  }
  assert.ok(ok);
  db.close();
  console.log('  T04 segundo A + X rejeitado');
}

async function t05insertB() {
  const db = await criarDbAntigo();
  await schemaNovo(db);
  await repo(db).inserir({ chave: CHAVE_X, xml: '<a/>', empresaId: EMP_A });
  await repo(db).inserir({ chave: CHAVE_X, xml: '<b/>', empresaId: EMP_B });
  const n = await get(db, 'SELECT COUNT(*) AS n FROM central_entradas_documentos WHERE chave = ?', [CHAVE_X]);
  assert.strictEqual(n.n, 2);
  db.close();
  console.log('  T05 INSERT B + X permitido (teste principal coexistência)');
}

async function t06buscaA() {
  const db = await criarDbAntigo();
  await schemaNovo(db);
  const a = await repo(db).inserir({ chave: CHAVE_X, xml: '<a/>', empresaId: EMP_A });
  await repo(db).inserir({ chave: CHAVE_X, xml: '<b/>', empresaId: EMP_B });
  const found = await repo(db).buscarPorChave(CHAVE_X, EMP_A);
  assert.strictEqual(found.id, a.id);
  assert.strictEqual(found.empresaId, EMP_A);
  db.close();
  console.log('  T06 buscarPorChave(X, A) retorna A');
}

async function t07buscaB() {
  const db = await criarDbAntigo();
  await schemaNovo(db);
  await repo(db).inserir({ chave: CHAVE_X, xml: '<a/>', empresaId: EMP_A });
  const b = await repo(db).inserir({ chave: CHAVE_X, xml: '<b/>', empresaId: EMP_B });
  const found = await repo(db).buscarPorChave(CHAVE_X, EMP_B);
  assert.strictEqual(found.id, b.id);
  assert.strictEqual(found.empresaId, EMP_B);
  db.close();
  console.log('  T07 buscarPorChave(X, B) retorna B');
}

async function t08cruzado() {
  const db = await criarDbAntigo();
  await schemaNovo(db);
  const a = await repo(db).inserir({ chave: CHAVE_X, xml: '<a/>', empresaId: EMP_A });
  const found = await repo(db).buscarPorChave(CHAVE_X, EMP_B);
  assert.strictEqual(found, null);
  const row = await get(db, 'SELECT id, xml FROM central_entradas_documentos WHERE id = ?', [a.id]);
  assert.strictEqual(row.xml, '<a/>');
  db.close();
  console.log('  T08 consulta B não retorna A');
}

async function t09null() {
  const db = await criarDbAntigo();
  await schemaNovo(db);
  await run(db, `INSERT INTO central_entradas_documentos (chave, xml, empresa_id) VALUES (?, '<n/>', NULL)`, [CHAVE_X]);
  const row = await get(db, 'SELECT empresa_id FROM central_entradas_documentos WHERE chave = ?', [CHAVE_X]);
  assert.strictEqual(row.empresa_id, null);
  const found = await repo(db).buscarPorChave(CHAVE_X, EMP_A);
  assert.strictEqual(found, null);
  db.close();
  console.log('  T09 NULL não ganha empresa');
}

async function t10semUpdateCruzado() {
  const db = await criarDbAntigo();
  await schemaNovo(db);
  const a = await repo(db).inserir({
    chave: CHAVE_X, xml: '<a-original/>', empresaId: EMP_A, status: 'RESUMO_RECEBIDO'
  });
  const persist = new CentralDfePersistenciaService({ db, empresaId: EMP_B });
  persist.existeCompraComChave = async () => false;
  const r = await persist.persistirDocumentoDfe({ xml: XML_RES, origem: 'dfe', empresaId: EMP_B });
  assert.ok(r.novo || r.documento);
  assert.notStrictEqual(r.documento && r.documento.id, a.id);
  const rowA = await get(db, 'SELECT xml, empresa_id FROM central_entradas_documentos WHERE id = ?', [a.id]);
  assert.strictEqual(rowA.xml, '<a-original/>');
  assert.strictEqual(rowA.empresa_id, EMP_A);
  db.close();
  console.log('  T10 persistência B não atualiza documento A');
}

async function t11tresEmpresas() {
  const db = await criarDbAntigo();
  await schemaNovo(db);
  const r = repo(db);
  const a = await r.inserir({ chave: CHAVE_X, xml: '<a/>', empresaId: EMP_A });
  const b = await r.inserir({ chave: CHAVE_X, xml: '<b/>', empresaId: EMP_B });
  const c = await r.inserir({ chave: CHAVE_X, xml: '<c/>', empresaId: EMP_C });
  assert.strictEqual((await r.buscarPorChave(CHAVE_X, EMP_A)).id, a.id);
  assert.strictEqual((await r.buscarPorChave(CHAVE_X, EMP_B)).id, b.id);
  assert.strictEqual((await r.buscarPorChave(CHAVE_X, EMP_C)).id, c.id);
  const n = await get(db, 'SELECT COUNT(*) AS n FROM central_entradas_documentos WHERE chave = ?', [CHAVE_X]);
  assert.strictEqual(n.n, 3);
  db.close();
  console.log('  T11 MULTIEMPRESA A/B/C + X coexistentes');
}

async function t12persistenciaSync() {
  const p = src('backend/motores/central-entradas/services/CentralDfePersistenciaService.js');
  assert.ok(p.includes('buscarPorChave(chave, empresaIdOperacao)'));
  assert.ok(p.includes('_empresaIdOperacao'));
  const sync = src('backend/motores/central-entradas/services/CentralSincronizacaoService.js');
  assert.ok(sync.includes('listarAlvosSincronizacaoCentral'));
  assert.ok(sync.includes('new CentralDfePersistenciaService({'));
  assert.ok(sync.includes('empresaId'));
  assert.ok(sync.includes('buscarPorChave(chaveLimpa, empresaId)'));
  assert.ok(!/\.buscarPorChave\(chaveLimpa\)\s*;/.test(sync));
  const repoSrc = src('backend/motores/central-entradas/repositories/CentralDocumentosRepository.js');
  assert.ok(repoSrc.includes('WHERE chave = ? AND empresa_id = ?'));
  assert.ok(repoSrc.includes('async buscarPorChave(chave, empresaId)'));

  const db = await criarDbAntigo();
  await schemaNovo(db);
  const persistA = new CentralDfePersistenciaService({ db, empresaId: EMP_A });
  persistA.existeCompraComChave = async () => false;
  const persistB = new CentralDfePersistenciaService({ db, empresaId: EMP_B });
  persistB.existeCompraComChave = async () => false;
  const ra = await persistA.persistirDocumentoDfe({ xml: XML_RES, origem: 'dfe', empresaId: EMP_A });
  const rb = await persistB.persistirDocumentoDfe({ xml: XML_RES, origem: 'dfe', empresaId: EMP_B });
  assert.ok(ra.novo);
  assert.ok(rb.novo);
  assert.notStrictEqual(ra.documento.id, rb.documento.id);
  db.close();
  console.log('  T12 persistência DistDFe/sync: A e B inserem documentos distintos');
}

async function main() {
  console.log('05.70 identidade documento empresa Central');
  await t01semUniqueGlobal();
  await t02uniqueComposto();
  await t03insertA();
  await t04rejeitaDuplicataA();
  await t05insertB();
  await t06buscaA();
  await t07buscaB();
  await t08cruzado();
  await t09null();
  await t10semUpdateCruzado();
  await t11tresEmpresas();
  await t12persistenciaSync();
  console.log('T01–T12 OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
