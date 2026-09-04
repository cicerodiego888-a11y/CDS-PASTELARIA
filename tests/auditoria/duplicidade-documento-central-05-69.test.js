/**
 * Sprint 05.69 — Auditoria: duplicidade de documentos da Central por chave.
 * Comprova o estado ATUAL. Não altera produção.
 * Executar: node tests/auditoria/duplicidade-documento-central-05-69.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function walkJs(dir, acc = []) {
  for (const nome of fs.readdirSync(dir, { withFileTypes: true })) {
    if (nome.name === 'node_modules' || nome.name === '.git') continue;
    const full = path.join(dir, nome.name);
    if (nome.isDirectory()) {
      walkJs(full, acc);
      continue;
    }
    if (!/\.js$/i.test(nome.name)) continue;
    acc.push(full);
  }
  return acc;
}

function rel(full) {
  return path.relative(ROOT, full).replace(/\\/g, '/');
}

function repo() {
  return src('backend/motores/central-entradas/repositories/CentralDocumentosRepository.js');
}

function persist() {
  return src('backend/motores/central-entradas/services/CentralDfePersistenciaService.js');
}

function ddl() {
  return src('backend/database.js');
}

function t01writers() {
  const literais = [];
  for (const f of walkJs(path.join(ROOT, 'backend'))) {
    const t = fs.readFileSync(f, 'utf8');
    if (/INSERT\s+INTO\s+central_entradas_documentos/i.test(t)) {
      literais.push(rel(f));
    }
  }
  assert.deepStrictEqual(literais, [], 'produção usa INSERT via TABELA, não literal');

  const r = repo();
  assert.ok(r.includes('async inserir(dados)'));
  assert.ok(r.includes('INSERT INTO ${CentralDocumentosRepository.TABELA}'));
  assert.ok(r.includes('empresa_id'));

  const callersInserir = [];
  for (const f of walkJs(path.join(ROOT, 'backend'))) {
    const t = fs.readFileSync(f, 'utf8');
    if (/_documentosRepository\.inserir\(/.test(t)) callersInserir.push(rel(f));
  }
  assert.deepStrictEqual(callersInserir.sort(), [
    'backend/motores/central-entradas/services/CentralDfePersistenciaService.js',
    'backend/motores/central-entradas/services/CentralDocumentoService.js'
  ]);

  const orch = src('backend/motores/central-entradas/CentralEntradasOrchestrator.js');
  assert.ok(!orch.includes('_documentoService.criar'));
  assert.ok(persist().includes('this._documentosRepository.inserir({'));

  console.log('  T01 writers: 1 INSERT (repository.inserir); callers persistirDocumentoDfe + DocumentoService.criar (orquestrador não chama criar)');
}

function t02funcoesDuplicidade() {
  const r = repo();
  const fn = r.slice(r.indexOf('async buscarPorChave'), r.indexOf('_montarClausulaWhere', r.indexOf('async buscarPorChave')));
  assert.ok(fn.includes('WHERE chave = ? AND empresa_id = ?'));
  assert.ok(fn.includes('async buscarPorChave(chave, empresaId)'));

  const p = persist();
  assert.ok((p.match(/buscarPorChave\(chave, empresaIdOperacao\)/g) || []).length >= 2);
  assert.ok(p.includes('if (existente)'));
  assert.ok(p.includes('duplicado: true'));

  const sync = src('backend/motores/central-entradas/services/CentralSincronizacaoService.js');
  assert.ok(sync.includes('buscarPorChave(chaveLimpa, empresaId)'));

  const rotas = src('backend/rotas/central-entradas.js');
  assert.ok(rotas.includes("router.get('/buscar-chave'"));
  assert.ok(rotas.includes('centralEntradasService.buscarPorChave(chave, {'));

  const legado = src('backend/motores/central-entradas/services/CentralImportacaoXmlLegadoService.js');
  assert.ok(legado.includes('buscarPorChave(validacao.chave, empresaIdLookup)'));

  console.log('  T02 duplicidade: buscarPorChave(chave, empresaId) na persistência/sync/legado');
}

function t03consultaGlobal() {
  const r = repo();
  const fn = r.slice(r.indexOf('async buscarPorChave'), r.indexOf('_montarClausulaWhere', r.indexOf('async buscarPorChave')));
  assert.ok(fn.includes('empresa_id = ?'));

  const esp = src('backend/services/fiscal/espelharTributosNfeDevolucaoCompra.js');
  const trecho = esp.slice(esp.indexOf('const porChave'), esp.indexOf("fonte: 'central_chave'"));
  assert.ok(trecho.includes('AND empresa_id = ?'));
  assert.ok(trecho.includes('WHERE REPLACE(chave'));

  const compras = persist();
  const compraFn = compras.slice(
    compras.indexOf('async existeCompraComChave'),
    compras.indexOf('async aplicarEventoDfe')
  );
  assert.ok(compraFn.includes('chave_acesso = ? AND empresa_id = ?'));

  console.log('  T03 lookup Central empresarial (05.70); XML devolução chave+empresa (05.71)');
}

function t04empresaIdSchema() {
  const bloco = ddl().slice(
    ddl().indexOf('CREATE TABLE IF NOT EXISTS central_entradas_documentos'),
    ddl().indexOf('CREATE TABLE IF NOT EXISTS central_entradas_historico')
  );
  assert.ok(bloco.includes('id INTEGER PRIMARY KEY AUTOINCREMENT'));
  assert.ok(bloco.includes('chave TEXT NOT NULL'));
  assert.ok(!/chave TEXT NOT NULL UNIQUE/.test(bloco));
  assert.ok(/UNIQUE\s*\(\s*chave\s*,\s*empresa_id\s*\)/.test(bloco));
  assert.ok(bloco.includes('empresa_id INTEGER'));
  assert.ok(ddl().includes('idx_central_entradas_documentos_empresa ON central_entradas_documentos(empresa_id)'));

  console.log('  T04 UNIQUE(chave, empresa_id); empresa_id nullable');
}

function t05fonteSync() {
  const sync = src('backend/motores/central-entradas/services/CentralSincronizacaoService.js');
  assert.ok(sync.includes('listarAlvosSincronizacaoCentral'));
  assert.ok(sync.includes('new CentralDfePersistenciaService({'));
  assert.ok(sync.includes('empresaId'));

  const p = persist();
  assert.ok(p.includes('_empresaIdOperacao'));
  assert.ok(p.includes('buscarPorChave(chave, empresaIdOperacao)'));
  const iEmp = p.indexOf('const empresaIdOperacao = this._empresaIdOperacao(dados);');
  const iBusca = p.indexOf('buscarPorChave(chave, empresaIdOperacao)');
  assert.ok(iEmp >= 0 && iBusca > iEmp);

  const dfe = src('backend/services/fiscal/distribuicaoDFe.js');
  assert.ok(dfe.includes('empresaId: empresaIdPersistencia'));

  console.log('  T05 alvo chega ao lookup e ao INSERT');
}

function openMem() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
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

async function t06axBx() {
  const db = await openMem();
  await run(db, `CREATE TABLE central_entradas_documentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chave TEXT NOT NULL,
    xml TEXT NOT NULL DEFAULT '',
    empresa_id INTEGER,
    UNIQUE(chave, empresa_id)
  )`);
  await run(db, `INSERT INTO central_entradas_documentos (chave, xml, empresa_id) VALUES ('X', '<a/>', 11)`);
  await run(db, `INSERT INTO central_entradas_documentos (chave, xml, empresa_id) VALUES ('X', '<b/>', 22)`);

  const sqlEmp = 'SELECT * FROM central_entradas_documentos WHERE chave = ? AND empresa_id = ?';
  const paraA = await get(db, sqlEmp, ['X', 11]);
  const paraB = await get(db, sqlEmp, ['X', 22]);
  assert.strictEqual(paraA.empresa_id, 11);
  assert.strictEqual(paraB.empresa_id, 22);
  assert.notStrictEqual(paraA.id, paraB.id);

  db.close();
  console.log('  T06 A+X e B+X coexistem (05.70 UNIQUE composto)');
}

async function t07null() {
  const db = await openMem();
  await run(db, `CREATE TABLE central_entradas_documentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chave TEXT NOT NULL,
    xml TEXT NOT NULL DEFAULT '',
    empresa_id INTEGER,
    UNIQUE(chave, empresa_id)
  )`);
  await run(db, `INSERT INTO central_entradas_documentos (chave, xml, empresa_id) VALUES ('X', '<n/>', NULL)`);

  const row = await get(db, 'SELECT * FROM central_entradas_documentos WHERE chave = ?', ['X']);
  assert.strictEqual(row.empresa_id, null);
  const daA = await get(db, 'SELECT * FROM central_entradas_documentos WHERE chave = ? AND empresa_id = ?', ['X', 11]);
  assert.strictEqual(daA, undefined);

  const ins = repo().slice(repo().indexOf('async inserir'), repo().indexOf('async atualizar'));
  assert.ok(!/COALESCE/.test(ins));
  const r = repo();
  const fn = r.slice(r.indexOf('async buscarPorChave'), r.indexOf('_montarClausulaWhere', r.indexOf('async buscarPorChave')));
  assert.ok(!/COALESCE/.test(fn));

  db.close();
  console.log('  T07 NULL não é documento da A; INSERT permite empresa_id null; sem COALESCE');
}

function t08producaoIntocada() {
  assert.ok(persist().includes("SELECT id FROM compras WHERE chave_acesso = ? AND empresa_id = ? LIMIT 1"));
  assert.ok(repo().includes('WHERE chave = ? AND empresa_id = ?'));
  assert.ok(persist().includes('buscarPorChave(chave, empresaIdOperacao)'));
  assert.ok(ddl().includes('UNIQUE(chave, empresa_id)'));

  console.log('  T08 05.68 compras intacta; lookup documental 05.70 empresarial');
}

async function main() {
  console.log('05.69 auditoria duplicidade documento Central');
  t01writers();
  t02funcoesDuplicidade();
  t03consultaGlobal();
  t04empresaIdSchema();
  t05fonteSync();
  await t06axBx();
  await t07null();
  t08producaoIntocada();
  console.log('T01–T08 OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
