/**
 * Sprint 05.74 — Isolamento da fila de processamento (empresa_id).
 * Executar: node tests/central-entradas/isolamento-fila-processamento-05-74.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const CentralDocumentosRepository = require('../../backend/motores/central-entradas/repositories/CentralDocumentosRepository');
const CentralProcessamentoService = require('../../backend/motores/central-entradas/services/CentralProcessamentoService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');

const EMP_A = 11;
const EMP_B = 22;
const CHAVE_X = '23260707196033002141550090012840571375100827';
const STATUS_PEND = 'XML_COMPLETO';

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
    (22, '22222222000182', 'Empresa B', 1)
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
      chave TEXT NOT NULL,
      xml TEXT NOT NULL DEFAULT '',
      fornecedor TEXT,
      status TEXT,
      parse_json TEXT,
      compra_id INTEGER,
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

function proc(db) {
  return new CentralProcessamentoService({
    documentosRepository: repo(db),
    historicoService: { registrar: async () => {} },
    transitionService: {
      transicionar: async () => {
        throw new Error('não deveria transicionar neste teste');
      }
    }
  });
}

async function seedAB(db) {
  await run(db, `INSERT INTO central_entradas_documentos
    (id, chave, xml, fornecedor, status, parse_json, empresa_id)
    VALUES (1, ?, '<xml-A/>', 'FORN_A', ?, NULL, ?)`, [CHAVE_X, STATUS_PEND, EMP_A]);
  await run(db, `INSERT INTO central_entradas_documentos
    (id, chave, xml, fornecedor, status, parse_json, empresa_id)
    VALUES (2, ?, '<xml-B/>', 'FORN_B', ?, NULL, ?)`, [CHAVE_X, STATUS_PEND, EMP_B]);
}

async function t01() {
  const db = await criarDb();
  await seedAB(db);
  await assert.rejects(
    () => repo(db).listarPendentesProcessamento(10),
    (err) => err.code === 'EMPRESA_CENTRAL_AUSENTE'
  );
  db.close();
  console.log('  T01 listarPendentesProcessamento exige empresaId');
}

async function t02() {
  const db = await criarDb();
  await seedAB(db);
  const lista = await repo(db).listarPendentesProcessamento(10, EMP_A);
  assert.strictEqual(lista.length, 1);
  assert.strictEqual(lista[0].id, 1);
  assert.strictEqual(lista[0].empresaId, EMP_A);
  db.close();
  console.log('  T02 empresa A recebe somente documentos A');
}

async function t03() {
  const db = await criarDb();
  await seedAB(db);
  const lista = await repo(db).listarPendentesProcessamento(10, EMP_B);
  assert.strictEqual(lista.length, 1);
  assert.strictEqual(lista[0].id, 2);
  db.close();
  console.log('  T03 empresa B recebe somente documentos B');
}

async function t04() {
  const db = await criarDb();
  await seedAB(db);
  const lista = await repo(db).listarPendentesProcessamento(10, EMP_B);
  assert.ok(!lista.some((d) => d.id === 1));
  db.close();
  console.log('  T04 A + X não aparece na fila B');
}

async function t05() {
  const db = await criarDb();
  await seedAB(db);
  const lista = await repo(db).listarPendentesProcessamento(10, EMP_A);
  assert.ok(!lista.some((d) => d.id === 2));
  db.close();
  console.log('  T05 B + X não aparece na fila A');
}

async function t06() {
  const db = await criarDb();
  await run(db, `INSERT INTO central_entradas_documentos
    (id, chave, xml, status, parse_json, empresa_id)
    VALUES (99, ?, '<n/>', ?, NULL, NULL)`, [CHAVE_X, STATUS_PEND]);
  const a = await repo(db).listarPendentesProcessamento(10, EMP_A);
  const b = await repo(db).listarPendentesProcessamento(10, EMP_B);
  assert.strictEqual(a.length, 0);
  assert.strictEqual(b.length, 0);
  db.close();
  console.log('  T06 documento NULL não entra na fila');
}

async function t07() {
  const db = await criarDb();
  await seedAB(db);
  await assert.rejects(
    () => proc(db).processar(1, { empresaId: EMP_B }),
    (err) => err.code === 'DOCUMENTO_NAO_ENCONTRADO' || err.code === 'OPERACAO_EMPRESA_DIVERGENTE'
  );
  db.close();
  console.log('  T07 processar documento A com empresa B bloqueia');
}

async function t08() {
  const db = await criarDb();
  await seedAB(db);
  await run(db, `UPDATE central_entradas_documentos SET parse_json = '{"ok":1}' WHERE id = 1`);
  const r = await proc(db).processar(1, { empresaId: EMP_A });
  assert.strictEqual(r.sucesso, true);
  assert.strictEqual(r.reutilizado, true);
  const b = await get(db, 'SELECT xml, status, fornecedor FROM central_entradas_documentos WHERE id = 2');
  assert.strictEqual(b.xml, '<xml-B/>');
  assert.strictEqual(b.status, STATUS_PEND);
  assert.strictEqual(b.fornecedor, 'FORN_B');
  db.close();
  console.log('  T08 processamento correto não altera documento B');
}

async function t09() {
  const db = await criarDb();
  await seedAB(db);
  const antes = await get(db, 'SELECT xml, status, fornecedor, parse_json, compra_id FROM central_entradas_documentos WHERE id = 1');
  await assert.rejects(() => proc(db).processar(1, { empresaId: EMP_B }));
  const depois = await get(db, 'SELECT xml, status, fornecedor, parse_json, compra_id FROM central_entradas_documentos WHERE id = 1');
  assert.deepStrictEqual(depois, antes);
  db.close();
  console.log('  T09 bloqueio cruzado ZERO MUTATION em A');
}

function t10() {
  const orch = src('backend/motores/central-entradas/CentralEntradasOrchestrator.js');
  assert.ok(orch.includes('empresaId: opcoes.empresaId'));
  assert.ok(orch.includes('empresaId: alvo.empresaId'));
  const health = src('backend/motores/central-entradas/health/HealthMonitor.js');
  assert.ok(health.includes('empresaIdContexto: emp'));
  assert.ok(!health.includes('origemHealth: true'));
  const upload = src('backend/motores/central-entradas/services/CentralUploadService.js');
  assert.ok(upload.includes('empresaId: empresaResolvida.empresaId'));
  console.log('  T10 retry/auto-processamento passa empresaId do alvo/documento');
}

async function t11() {
  const db = await criarDb();
  await seedAB(db);
  await assert.rejects(
    () => repo(db).listarPendentesProcessamento(10, null),
    (err) => err.code === 'EMPRESA_CENTRAL_AUSENTE'
  );
  await assert.rejects(
    () => proc(db).processar(1, {}),
    (err) => err.code === 'EMPRESA_CENTRAL_AUSENTE'
  );
  await assert.rejects(
    () => proc(db).processar(99, { empresaId: EMP_B }),
    (err) => err.code === 'DOCUMENTO_NAO_ENCONTRADO'
  );
  await run(db, `INSERT INTO central_entradas_documentos
    (id, chave, xml, status, empresa_id) VALUES (99, ?, '<n/>', ?, NULL)`, [CHAVE_X, STATUS_PEND]);
  await assert.rejects(
    () => proc(db).processar(99, { empresaId: EMP_B }),
    (err) => err.code === 'EMPRESA_DOCUMENTO_NAO_RESOLVIDA'
  );
  const repoSrc = src('backend/motores/central-entradas/repositories/CentralDocumentosRepository.js');
  const fn = repoSrc.slice(
    repoSrc.indexOf('async listarPendentesProcessamento'),
    repoSrc.indexOf('COLUNAS_LISTAGEM')
  );
  assert.ok(!fn.includes('COALESCE'));
  assert.ok(!fn.includes('empresa_operacional'));
  db.close();
  console.log('  T11 chamador sem empresa não usa fallback; NULL bloqueia processar');
}

function t12() {
  const repoSrc = src('backend/motores/central-entradas/repositories/CentralDocumentosRepository.js');
  const fn = repoSrc.slice(
    repoSrc.indexOf('async listarPendentesProcessamento'),
    repoSrc.indexOf('COLUNAS_LISTAGEM')
  );
  assert.ok(fn.includes('AND empresa_id = ?'));
  assert.ok(fn.includes('status = ?'));
  const orch = src('backend/motores/central-entradas/CentralEntradasOrchestrator.js');
  assert.ok(orch.includes('listarPendentesProcessamento(\n      limite,\n      empresaId'));
  assert.ok(!orch.includes('listarPendentesProcessamento(limite);'));
  const rotas = src('backend/rotas/central-entradas.js');
  assert.ok(rotas.includes('empresaId: ctx.empresaId'));
  console.log('  T12 nenhum SELECT global de pendências no caminho de mutação');
}

async function main() {
  console.log('05.74 isolamento fila processamento');
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
  await t11();
  t12();
  console.log('OK 12/12');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
