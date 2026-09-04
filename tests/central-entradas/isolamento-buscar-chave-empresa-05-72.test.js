/**
 * Sprint 05.72 — Isolamento do GET /buscar-chave (chave + empresa_id).
 * Executar: node tests/central-entradas/isolamento-buscar-chave-empresa-05-72.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const CentralDocumentosRepository = require('../../backend/motores/central-entradas/repositories/CentralDocumentosRepository');
const CentralSincronizacaoService = require('../../backend/motores/central-entradas/services/CentralSincronizacaoService');
const { resolverEmpresaParaCentral } = require('../../backend/services/central-entradas/CentralEntradasEmpresaContextoService');
const { ModoOperacionalGlobal } = require('../../backend/core/modo-operacional');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');

const EMP_A = 11;
const EMP_B = 22;
const CHAVE_X = '23260707196033002141550090012840571375100827';
const CHAVE_Y = '35260707196033002141550090012840571375100828';

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
      modelo TEXT DEFAULT '55',
      fornecedor TEXT,
      cnpj_fornecedor TEXT,
      data_emissao TEXT,
      valor_total REAL,
      xml TEXT NOT NULL DEFAULT '',
      origem TEXT DEFAULT 'dfe',
      status TEXT,
      tipo_documento TEXT,
      compra_id INTEGER,
      empresa_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(chave, empresa_id)
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
      cnpj: empresaId === EMP_A ? '11111111000191' : '22222222000182'
    }
  };
}

function empresaServiceStub() {
  return {
    buscarEmpresaPorId: async (id) => {
      const n = Number(id);
      if (n === EMP_A) return { id: EMP_A, cnpj: '11111111000191', ativo: 1 };
      if (n === EMP_B) return { id: EMP_B, cnpj: '22222222000182', ativo: 1 };
      return null;
    }
  };
}

async function seedDoc(db, { id, empresaId, chave, fornecedor, xml, cnpj }) {
  await run(
    db,
    `INSERT INTO central_entradas_documentos
      (id, chave, fornecedor, cnpj_fornecedor, xml, empresa_id, status)
     VALUES (?, ?, ?, ?, ?, ?, 'RESUMO_RECEBIDO')`,
    [id, chave, fornecedor, cnpj, xml, empresaId]
  );
}

function montarSync(db, extras = {}) {
  const lookups = [];
  const base = new CentralDocumentosRepository({ db });
  const documentosRepository = {
    buscarPorChave: async (chave, empresaId) => {
      lookups.push({ chave, empresaId });
      return base.buscarPorChave(chave, empresaId);
    }
  };
  const sefazCalls = [];
  const sync = new CentralSincronizacaoService({
    documentosRepository,
    pularGateConsultaChave: true,
    consultarNotaPorChave: async (chave) => {
      sefazCalls.push(chave);
      return { cStat: '217', notasNovas: 0, origem: 'mock-sefaz' };
    },
    configuracaoService: {
      obterContextoOperacional: async (opcoes) => ({
        ok: true,
        contexto: { empresaId: Number(opcoes.empresaId) }
      })
    },
    ...extras
  });
  return { sync, lookups, sefazCalls };
}

async function httpBuscarChave(db, { headers = {}, query = {}, contrato, empresaId }) {
  const chave = String(query.chave || '').replace(/\D/g, '');
  const req = { headers, query, empresaId, db };
  const ctx = await resolverEmpresaParaCentral(
    { req, empresaId: req.empresaId },
    { db, contrato, EmpresaService: empresaServiceStub() }
  );
  const { sync, lookups, sefazCalls } = montarSync(db);
  const resultado = await sync.buscarPorChave(chave, {
    empresaId: ctx.empresaId,
    modo: ctx.modo
  });
  return { resultado, ctx, lookups, sefazCalls };
}

async function t01() {
  const db = await criarDb();
  await seedDoc(db, {
    id: 1, empresaId: EMP_A, chave: CHAVE_X,
    fornecedor: 'FORN_A', xml: '<xml-A/>', cnpj: '11111111000191'
  });
  const { resultado } = await httpBuscarChave(db, {
    headers: { 'x-empresa-id': String(EMP_A) },
    query: { chave: CHAVE_X },
    contrato: contratoMulti()
  });
  assert.strictEqual(resultado.documento.id, 1);
  assert.strictEqual(resultado.documento.empresaId, EMP_A);
  assert.strictEqual(resultado.documento.fornecedor, 'FORN_A');
  db.close();
  console.log('  T01 Empresa A + chave X retorna documento A');
}

async function t02() {
  const db = await criarDb();
  await seedDoc(db, {
    id: 2, empresaId: EMP_B, chave: CHAVE_X,
    fornecedor: 'FORN_B', xml: '<xml-B/>', cnpj: '22222222000182'
  });
  const { resultado } = await httpBuscarChave(db, {
    headers: { 'x-empresa-id': String(EMP_B) },
    query: { chave: CHAVE_X },
    contrato: contratoMulti()
  });
  assert.strictEqual(resultado.documento.id, 2);
  assert.strictEqual(resultado.documento.empresaId, EMP_B);
  assert.strictEqual(resultado.documento.fornecedor, 'FORN_B');
  db.close();
  console.log('  T02 Empresa B + chave X retorna documento B');
}

async function t03() {
  const db = await criarDb();
  await seedDoc(db, {
    id: 1, empresaId: EMP_A, chave: CHAVE_X,
    fornecedor: 'FORN_A', xml: '<xml-A/>', cnpj: '11111111000191'
  });
  await seedDoc(db, {
    id: 2, empresaId: EMP_B, chave: CHAVE_X,
    fornecedor: 'FORN_B', xml: '<xml-B/>', cnpj: '22222222000182'
  });
  const a = await httpBuscarChave(db, {
    headers: { 'x-empresa-id': String(EMP_A) },
    query: { chave: CHAVE_X },
    contrato: contratoMulti()
  });
  const b = await httpBuscarChave(db, {
    headers: { 'x-empresa-id': String(EMP_B) },
    query: { chave: CHAVE_X },
    contrato: contratoMulti()
  });
  assert.strictEqual(a.resultado.documento.id, 1);
  assert.strictEqual(b.resultado.documento.id, 2);
  assert.notStrictEqual(a.resultado.documento.id, b.resultado.documento.id);
  db.close();
  console.log('  T03 A+X e B+X coexistem e são consultáveis separadamente');
}

async function t04() {
  const db = await criarDb();
  await seedDoc(db, {
    id: 1, empresaId: EMP_A, chave: CHAVE_X,
    fornecedor: 'FORN_A', xml: '<xml-A/>', cnpj: '11111111000191'
  });
  await seedDoc(db, {
    id: 2, empresaId: EMP_B, chave: CHAVE_X,
    fornecedor: 'FORN_B', xml: '<xml-B/>', cnpj: '22222222000182'
  });
  const { resultado } = await httpBuscarChave(db, {
    headers: { 'x-empresa-id': String(EMP_B) },
    query: { chave: CHAVE_X },
    contrato: contratoMulti()
  });
  assert.strictEqual(resultado.documento.id, 2);
  assert.notStrictEqual(resultado.documento.id, 1);
  assert.notStrictEqual(resultado.documento.fornecedor, 'FORN_A');
  db.close();
  console.log('  T04 Caller B não recebe documento A');
}

async function t05() {
  const db = await criarDb();
  await seedDoc(db, {
    id: 1, empresaId: EMP_A, chave: CHAVE_X,
    fornecedor: 'FORN_A', xml: '<xml-A/>', cnpj: '11111111000191'
  });
  await seedDoc(db, {
    id: 2, empresaId: EMP_B, chave: CHAVE_X,
    fornecedor: 'FORN_B', xml: '<xml-B/>', cnpj: '22222222000182'
  });
  const { resultado } = await httpBuscarChave(db, {
    headers: { 'x-empresa-id': String(EMP_A) },
    query: { chave: CHAVE_X },
    contrato: contratoMulti()
  });
  assert.strictEqual(resultado.documento.id, 1);
  assert.notStrictEqual(resultado.documento.id, 2);
  assert.notStrictEqual(resultado.documento.fornecedor, 'FORN_B');
  db.close();
  console.log('  T05 Caller A não recebe documento B');
}

async function t06() {
  const db = await criarDb();
  await seedDoc(db, {
    id: 1, empresaId: EMP_A, chave: CHAVE_X,
    fornecedor: 'FORN_A', xml: '<xml-A/>', cnpj: '11111111000191'
  });
  const { sync, lookups, sefazCalls } = montarSync(db);
  await assert.rejects(
    () => resolverEmpresaParaCentral(
      { req: { headers: {}, query: { chave: CHAVE_X }, db }, empresaId: null },
      { db, contrato: contratoMulti(), EmpresaService: empresaServiceStub() }
    ),
    (err) => err.code === 'EMPRESA_CENTRAL_AUSENTE'
  );
  await assert.rejects(
    () => sync.buscarPorChave(CHAVE_X),
    (err) => err.code === 'EMPRESA_CENTRAL_AUSENTE'
  );
  assert.strictEqual(lookups.length, 0);
  assert.strictEqual(sefazCalls.length, 0);
  const rotas = src('backend/rotas/central-entradas.js');
  const bloco = rotas.slice(
    rotas.indexOf("router.get('/buscar-chave'"),
    rotas.indexOf("router.post('/upload'")
  );
  assert.ok(bloco.includes('resolverEmpresaParaCentral'));
  assert.ok(bloco.includes('empresaId: ctx.empresaId'));
  assert.ok(!bloco.includes('centralEntradasService.buscarPorChave(chave);'));
  db.close();
  console.log('  T06 MULTIEMPRESA sem X-Empresa-Id não executa lookup global');
}

async function t07() {
  const db = await criarDb();
  await seedDoc(db, {
    id: 2, empresaId: EMP_B, chave: CHAVE_X,
    fornecedor: 'FORN_B', xml: '<xml-B/>', cnpj: '22222222000182'
  });
  const { resultado, ctx } = await httpBuscarChave(db, {
    headers: {},
    query: { chave: CHAVE_X },
    contrato: contratoSimples(EMP_B)
  });
  assert.strictEqual(ctx.origem, 'CONTRATO_EMPRESA_SIMPLES');
  assert.strictEqual(ctx.empresaId, EMP_B);
  assert.strictEqual(resultado.documento.id, 2);
  assert.strictEqual(resultado.documento.empresaId, EMP_B);
  db.close();
  console.log('  T07 EMPRESA_SIMPLES utiliza a empresa operacional do contrato');
}

async function t08() {
  const db = await criarDb();
  await seedDoc(db, {
    id: 9, empresaId: null, chave: CHAVE_X,
    fornecedor: 'FORN_NULL', xml: '<xml-NULL/>', cnpj: '00000000000000'
  });
  const { resultado } = await httpBuscarChave(db, {
    headers: { 'x-empresa-id': String(EMP_A) },
    query: { chave: CHAVE_X },
    contrato: contratoMulti()
  });
  assert.strictEqual(resultado.documento, null);
  db.close();
  console.log('  T08 Documento com empresa_id NULL não é atribuído automaticamente');
}

async function t09() {
  const db = await criarDb();
  await seedDoc(db, {
    id: 1, empresaId: EMP_A, chave: CHAVE_X,
    fornecedor: 'FORN_A', xml: '<xml-A-secreto/>', cnpj: '11111111000191'
  });
  const { resultado } = await httpBuscarChave(db, {
    headers: { 'x-empresa-id': String(EMP_B) },
    query: { chave: CHAVE_X },
    contrato: contratoMulti()
  });
  assert.strictEqual(resultado.documento, null);
  const dump = JSON.stringify(resultado);
  assert.ok(!dump.includes('FORN_A'));
  assert.ok(!dump.includes('xml-A-secreto'));
  assert.ok(!dump.includes('"id":1'));
  assert.ok(!dump.includes('"empresaId":11'));
  db.close();
  console.log('  T09 Resposta cruzada não revela dados da outra empresa');
}

async function t10() {
  const db = await criarDb();
  const { resultado } = await httpBuscarChave(db, {
    headers: { 'x-empresa-id': String(EMP_A) },
    query: { chave: CHAVE_Y },
    contrato: contratoMulti()
  });
  assert.strictEqual(resultado.documento, null);
  db.close();
  console.log('  T10 Chave inexistente mantém comportamento de não encontrado');
}

function tEstatico() {
  const rotas = src('backend/rotas/central-entradas.js');
  const bloco = rotas.slice(
    rotas.indexOf("router.get('/buscar-chave'"),
    rotas.indexOf("router.post('/upload'")
  );
  assert.ok(bloco.includes("String(req.query.chave || '').replace(/\\D/g, '')"));
  assert.ok(bloco.includes('resolverEmpresaParaCentral'));
  assert.ok(bloco.includes('buscarPorChave(chave, {'));

  const sync = src('backend/motores/central-entradas/services/CentralSincronizacaoService.js');
  const fn = sync.slice(
    sync.indexOf('Lookup documental: chave + empresa'),
    sync.lastIndexOf('module.exports')
  );
  assert.ok(fn.includes('buscarPorChave(chaveLimpa, empresaId)'));
  assert.ok(!/WHERE chave = \?['`]?\s*$/m.test(fn));
  assert.ok(fn.includes('EMPRESA_CENTRAL_AUSENTE'));

  const repo = src('backend/motores/central-entradas/repositories/CentralDocumentosRepository.js');
  const repoFn = repo.slice(
    repo.indexOf('async buscarPorChave(chave, empresaId)'),
    repo.indexOf('_montarClausulaWhere')
  );
  assert.ok(repoFn.includes('WHERE chave = ? AND empresa_id = ?'));
  console.log('  extra: rota resolve empresa; lookup chave+empresaId; normalização da chave intacta');
}

async function main() {
  console.log('05.72 isolamento GET /buscar-chave empresa');
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
  tEstatico();
  console.log('OK 10/10');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
