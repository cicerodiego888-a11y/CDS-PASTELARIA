/**
 * Fase 2 / Implementação 03.18 — consulta administrativa HTTP de estoque_empresa.
 * GET /api/estoque/empresa/produtos/:produtoId
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const UsuarioEmpresaService = require('../../backend/services/empresas/UsuarioEmpresaService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const { criarMiddlewareContextoEmpresa } = require('../../backend/services/fiscalNaoFiscal/empresaContexto');
const estoqueRotas = require('../../backend/rotas/estoque');

const ROOT = path.resolve(__dirname, '../..');
const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_) { resolve(); }
  });
}

async function setup() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaUsuarioEmpresasAsync(db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  await run(db, `CREATE TABLE IF NOT EXISTS usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT)`);
  await run(db, `
    CREATE TABLE produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT,
      saldo_fiscal REAL DEFAULT 0,
      saldo_nao_fiscal REAL DEFAULT 0,
      estoque_atual REAL DEFAULT 0,
      reservado_fiscal REAL DEFAULT 0,
      reservado_nao_fiscal REAL DEFAULT 0
    )
  `);
  const u = await run(db, `INSERT INTO usuarios (username) VALUES ('ana')`);
  const outro = await run(db, `INSERT INTO usuarios (username) VALUES ('bruno')`);
  const p = await run(
    db,
    `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual, reservado_fiscal)
     VALUES ('X', 99, 50, 149, 7)`
  );
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const b = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  return {
    db,
    usuarioId: u.lastID,
    outroUsuarioId: outro.lastID,
    produtoId: p.lastID,
    empresaA: a,
    empresaB: b
  };
}

function reqConsulta(usuarioId, empresaId, produtoId) {
  const headers = {};
  if (empresaId != null) headers['x-empresa-id'] = String(empresaId);
  return {
    user: usuarioId != null ? { id: usuarioId } : null,
    headers,
    body: {},
    query: {},
    params: { produtoId: String(produtoId) }
  };
}

function despachar(db, req) {
  return new Promise((resolve) => {
    const mw = criarMiddlewareContextoEmpresa(db, { obrigatorio: true });
    const res = {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        resolve({ status: this.statusCode, body: payload, empresaId: req.empresaId });
        return this;
      }
    };
    mw(req, res, () => {
      Promise.resolve(estoqueRotas.handleGetProdutoEstoqueEmpresa(req, res, db)).catch((err) => {
        resolve({ status: 500, body: { error: err.message, code: err.code }, empresaId: req.empresaId });
      });
    });
  });
}

async function test01SemContexto() {
  const { db, usuarioId, produtoId } = await setup();
  const r = await despachar(db, reqConsulta(usuarioId, null, produtoId));
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.code, 'EMPRESA_OBRIGATORIA');
  await closeDb(db);
}

async function test02EmpresaInexistente() {
  const { db, usuarioId, produtoId } = await setup();
  const r = await despachar(db, reqConsulta(usuarioId, 99999, produtoId));
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.code, 'EMPRESA_NAO_ENCONTRADA');
  await closeDb(db);
}

async function test03EmpresaInativa() {
  const { db, usuarioId, empresaA, produtoId } = await setup();
  await UsuarioEmpresaService.vincularUsuarioEmpresa(usuarioId, { empresaId: empresaA.id }, { db });
  await EmpresaService.inativarEmpresa(empresaA.id, { db });
  const r = await despachar(db, reqConsulta(usuarioId, empresaA.id, produtoId));
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.code, 'EMPRESA_INATIVA');
  await closeDb(db);
}

async function test04SemVinculo() {
  const { db, outroUsuarioId, empresaA, produtoId } = await setup();
  const r = await despachar(db, reqConsulta(outroUsuarioId, empresaA.id, produtoId));
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.body.code, 'EMPRESA_NAO_AUTORIZADA');
  await closeDb(db);
}

async function test05ConsultaExistente() {
  const { db, usuarioId, empresaA, produtoId } = await setup();
  await UsuarioEmpresaService.vincularUsuarioEmpresa(usuarioId, { empresaId: empresaA.id }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId,
    empresaId: empresaA.id,
    saldo_fiscal: 10,
    saldo_nao_fiscal: 4,
    estoque_atual: 14,
    reservado_fiscal: 2,
    reservado_nao_fiscal: 1
  }, { db });
  const r = await despachar(db, reqConsulta(usuarioId, empresaA.id, produtoId));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.produtoId, produtoId);
  assert.strictEqual(r.body.empresaId, empresaA.id);
  await closeDb(db);
}

async function test06ValoresCorretos() {
  const { db, usuarioId, empresaA, produtoId } = await setup();
  await UsuarioEmpresaService.vincularUsuarioEmpresa(usuarioId, { empresaId: empresaA.id }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId,
    empresaId: empresaA.id,
    saldo_fiscal: 10,
    saldo_nao_fiscal: 4,
    estoque_atual: 14,
    reservado_fiscal: 2,
    reservado_nao_fiscal: 1
  }, { db });
  const r = await despachar(db, reqConsulta(usuarioId, empresaA.id, produtoId));
  assert.strictEqual(r.body.saldoFiscal, 10);
  assert.strictEqual(r.body.saldoNaoFiscal, 4);
  assert.strictEqual(r.body.estoqueAtual, 14);
  assert.strictEqual(r.body.reservadoFiscal, 2);
  assert.strictEqual(r.body.reservadoNaoFiscal, 1);
  await closeDb(db);
}

async function test07Inexistente404() {
  const { db, usuarioId, empresaA, produtoId } = await setup();
  await UsuarioEmpresaService.vincularUsuarioEmpresa(usuarioId, { empresaId: empresaA.id }, { db });
  const r = await despachar(db, reqConsulta(usuarioId, empresaA.id, produtoId));
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.code, 'ESTOQUE_EMPRESA_NAO_ENCONTRADO');
  assert.strictEqual(r.body.empresaId, empresaA.id);
  await closeDb(db);
}

async function test08NaoConsultaNemAlteraProdutos() {
  const { db, usuarioId, empresaA, produtoId } = await setup();
  await UsuarioEmpresaService.vincularUsuarioEmpresa(usuarioId, { empresaId: empresaA.id }, { db });
  const antes = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  const r = await despachar(db, reqConsulta(usuarioId, empresaA.id, produtoId));
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.code, 'ESTOQUE_EMPRESA_NAO_ENCONTRADO');
  const depois = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(depois.saldo_fiscal, antes.saldo_fiscal);
  assert.strictEqual(depois.estoque_atual, 149);
  const n = await get(db, 'SELECT COUNT(*) AS c FROM estoque_empresa');
  assert.strictEqual(n.c, 0);

  const src = fs.readFileSync(path.join(ROOT, 'backend/rotas/estoque.js'), 'utf8');
  assert.ok(src.includes('consultarSaldoParaEmpresa'));
  assert.ok(!/\bFROM\s+produtos\b/i.test(src));
  const porta = fs.readFileSync(path.join(ROOT, 'backend/services/fiscalNaoFiscal/estoqueSaldosPublico.js'), 'utf8');
  assert.ok(porta.includes('FROM produtos'));
  assert.ok(porta.includes('consultarSaldoParaEmpresa'));
  await closeDb(db);
}

async function main() {
  const testes = [
    ['01 sem contexto EMPRESA_OBRIGATORIA', test01SemContexto],
    ['02 empresa inexistente', test02EmpresaInexistente],
    ['03 empresa inativa', test03EmpresaInativa],
    ['04 usuario sem vinculo 403', test04SemVinculo],
    ['05 consulta registro existente', test05ConsultaExistente],
    ['06 SF SNF EA RF RNF', test06ValoresCorretos],
    ['07 inexistente ESTOQUE_EMPRESA_NAO_ENCONTRADO', test07Inexistente404],
    ['08 nao consulta nem altera produtos', test08NaoConsultaNemAlteraProdutos]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\nconsulta-administrativa-estoque-empresa: ${ok}/${testes.length} OK`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
