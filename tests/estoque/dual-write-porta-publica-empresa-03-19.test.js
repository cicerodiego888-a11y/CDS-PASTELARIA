/**
 * Fase 2 / Implementação 03.19 — contexto operacional opcional + dual-write na porta.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const saldos = require('../../backend/services/fiscalNaoFiscal/estoqueSaldosPublico');
const { TipoSaldo } = require('../../backend/services/fiscalNaoFiscal/constants');
const {
  criarMiddlewareContextoEmpresa,
  empresaIdDoReqOperacional,
  COMPAT_CERTIFICADA_PRE_MULTIEMPRESA
} = require('../../backend/services/fiscalNaoFiscal/empresaContexto');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const UsuarioEmpresaService = require('../../backend/services/empresas/UsuarioEmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const { extrairEmpresaIdDeReq } = require('../../backend/services/vendas/creditoEstoqueVendaViaPorta');

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
      reservado_nao_fiscal REAL DEFAULT 0,
      updated_at DATETIME
    )
  `);
  const u = await run(db, `INSERT INTO usuarios (username) VALUES ('ana')`);
  const outro = await run(db, `INSERT INTO usuarios (username) VALUES ('bruno')`);
  const p = await run(
    db,
    `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual)
     VALUES ('X', 100, 40, 140)`
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

async function ee(db, produtoId, empresaId) {
  return EstoqueEmpresaService.consultarSaldo({ produtoId, empresaId }, { db });
}

function despacharMw(db, req) {
  return new Promise((resolve) => {
    let nextChamado = false;
    const mw = criarMiddlewareContextoEmpresa(db);
    const res = {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        resolve({
          status: this.statusCode,
          body: payload,
          next: nextChamado,
          empresaId: req.empresaId
        });
        return this;
      }
    };
    mw(req, res, () => {
      nextChamado = true;
      resolve({
        status: 200,
        body: null,
        next: true,
        empresaId: req.empresaId
      });
    });
  });
}

async function test01CreditoFiscal() {
  const { db, produtoId, empresaA } = await setup();
  await saldos.creditarSaldo(produtoId, TipoSaldo.FISCAL, 5, { db, empresaId: empresaA.id });
  const prod = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  const iso = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(prod.saldo_fiscal, 105);
  assert.strictEqual(iso.saldo_fiscal, 5);
  await closeDb(db);
}

async function test02CreditoNaoFiscal() {
  const { db, produtoId, empresaA } = await setup();
  await saldos.creditarSaldo(produtoId, TipoSaldo.NAO_FISCAL, 3, { db, empresaId: empresaA.id });
  const prod = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  const iso = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(prod.saldo_nao_fiscal, 43);
  assert.strictEqual(iso.saldo_nao_fiscal, 3);
  await closeDb(db);
}

async function test03DebitoFiscal() {
  const { db, produtoId, empresaA } = await setup();
  await saldos.creditarSaldo(produtoId, TipoSaldo.FISCAL, 10, { db, empresaId: empresaA.id });
  await saldos.debitarSaldo(produtoId, TipoSaldo.FISCAL, 4, { db, empresaId: empresaA.id });
  const prod = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  const iso = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(prod.saldo_fiscal, 106);
  assert.strictEqual(iso.saldo_fiscal, 6);
  await closeDb(db);
}

async function test04DebitoNaoFiscal() {
  const { db, produtoId, empresaA } = await setup();
  await saldos.creditarSaldo(produtoId, TipoSaldo.NAO_FISCAL, 8, { db, empresaId: empresaA.id });
  await saldos.debitarSaldo(produtoId, TipoSaldo.NAO_FISCAL, 2, { db, empresaId: empresaA.id });
  const prod = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  const iso = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(prod.saldo_nao_fiscal, 46);
  assert.strictEqual(iso.saldo_nao_fiscal, 6);
  await closeDb(db);
}

async function test05EstoqueAtual() {
  const { db, produtoId, empresaA } = await setup();
  await saldos.creditarSaldo(produtoId, TipoSaldo.FISCAL, 10, { db, empresaId: empresaA.id });
  await saldos.creditarSaldo(produtoId, TipoSaldo.NAO_FISCAL, 4, { db, empresaId: empresaA.id });
  const iso = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(iso.estoque_atual, 14);
  assert.strictEqual(iso.estoque_atual, iso.saldo_fiscal + iso.saldo_nao_fiscal);
  const prod = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.estoque_atual, 154);
  await closeDb(db);
}

async function test06IsolamentoAB() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await saldos.creditarSaldo(produtoId, TipoSaldo.FISCAL, 10, { db, empresaId: empresaA.id });
  await saldos.creditarSaldo(produtoId, TipoSaldo.FISCAL, 20, { db, empresaId: empresaB.id });
  const a = await ee(db, produtoId, empresaA.id);
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(a.saldo_fiscal, 10);
  assert.strictEqual(b.saldo_fiscal, 20);
  await saldos.debitarSaldo(produtoId, TipoSaldo.FISCAL, 3, { db, empresaId: empresaA.id });
  assert.strictEqual((await ee(db, produtoId, empresaA.id)).saldo_fiscal, 7);
  assert.strictEqual((await ee(db, produtoId, empresaB.id)).saldo_fiscal, 20);
  await closeDb(db);
}

async function test07NasceZeradoMaisDelta() {
  const { db, produtoId, empresaA } = await setup();
  await saldos.creditarSaldo(produtoId, TipoSaldo.FISCAL, 10, { db, empresaId: empresaA.id });
  const iso = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(iso.saldo_fiscal, 10);
  assert.strictEqual(iso.reservado_fiscal, 0);
  await closeDb(db);
}

async function test08NaoCopiaLegado() {
  const { db, produtoId, empresaA } = await setup();
  const prod = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.saldo_fiscal, 100);
  await saldos.creditarSaldo(produtoId, TipoSaldo.FISCAL, 10, { db, empresaId: empresaA.id });
  const iso = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(iso.saldo_fiscal, 10);
  assert.notStrictEqual(iso.saldo_fiscal, 110);
  await closeDb(db);
}

async function test09CompatSemEmpresa() {
  const { db, produtoId } = await setup();
  await saldos.creditarSaldo(produtoId, TipoSaldo.FISCAL, 2, {
    db,
    ...COMPAT_CERTIFICADA_PRE_MULTIEMPRESA
  });
  const prod = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.saldo_fiscal, 102);
  const n = await get(db, 'SELECT COUNT(*) AS c FROM estoque_empresa');
  assert.strictEqual(n.c, 0);
  await closeDb(db);
}

async function test10Rollback() {
  const { db, produtoId, empresaA } = await setup();
  await run(db, 'BEGIN');
  await saldos.creditarSaldo(produtoId, TipoSaldo.FISCAL, 9, { db, empresaId: empresaA.id });
  const midProd = await get(db, 'SELECT saldo_fiscal FROM produtos WHERE id = ?', [produtoId]);
  const midEe = await get(
    db,
    'SELECT saldo_fiscal FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?',
    [produtoId, empresaA.id]
  );
  assert.strictEqual(midProd.saldo_fiscal, 109);
  assert.strictEqual(midEe.saldo_fiscal, 9);
  await run(db, 'ROLLBACK');
  const prod = await get(db, 'SELECT saldo_fiscal FROM produtos WHERE id = ?', [produtoId]);
  const n = await get(db, 'SELECT COUNT(*) AS c FROM estoque_empresa');
  assert.strictEqual(prod.saldo_fiscal, 100);
  assert.strictEqual(n.c, 0);
  await closeDb(db);
}

async function test11EmpresaInexistenteHttp() {
  const { db, usuarioId } = await setup();
  let operacao = false;
  const r = await despacharMw(db, {
    user: { id: usuarioId },
    headers: { 'x-empresa-id': '99999' },
    body: {},
    query: {}
  });
  if (r.next) operacao = true;
  assert.strictEqual(r.next, false);
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.code, 'EMPRESA_NAO_ENCONTRADA');
  assert.strictEqual(operacao, false);
  await closeDb(db);
}

async function test12EmpresaInativa() {
  const { db, usuarioId, empresaA } = await setup();
  await UsuarioEmpresaService.vincularUsuarioEmpresa(usuarioId, { empresaId: empresaA.id }, { db });
  await EmpresaService.inativarEmpresa(empresaA.id, { db });
  const r = await despacharMw(db, {
    user: { id: usuarioId },
    headers: { 'x-empresa-id': String(empresaA.id) },
    body: {},
    query: {}
  });
  assert.strictEqual(r.next, false);
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.code, 'EMPRESA_INATIVA');
  await closeDb(db);
}

async function test13SemVinculo() {
  const { db, outroUsuarioId, empresaA } = await setup();
  const r = await despacharMw(db, {
    user: { id: outroUsuarioId },
    headers: { 'x-empresa-id': String(empresaA.id) },
    body: {},
    query: {}
  });
  assert.strictEqual(r.next, false);
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.body.code, 'EMPRESA_NAO_AUTORIZADA');
  await closeDb(db);
}

async function test14BodyNaoSobrescreve() {
  const { db, usuarioId, empresaA, empresaB } = await setup();
  await UsuarioEmpresaService.vincularUsuarioEmpresa(usuarioId, { empresaId: empresaA.id }, { db });
  const req = {
    user: { id: usuarioId },
    headers: { 'x-empresa-id': String(empresaA.id) },
    body: { empresaId: empresaB.id },
    query: {}
  };
  const r = await despacharMw(db, req);
  assert.strictEqual(r.next, true);
  assert.strictEqual(req.empresaId, empresaA.id);
  assert.strictEqual(empresaIdDoReqOperacional(req), empresaA.id);
  assert.strictEqual(extrairEmpresaIdDeReq(req), empresaA.id);
  assert.notStrictEqual(extrairEmpresaIdDeReq(req), empresaB.id);
  await closeDb(db);
}

async function test15LeituraContinuaProdutos() {
  const { db, produtoId, empresaA } = await setup();
  await run(db, `UPDATE produtos SET reservado_fiscal = 99 WHERE id = ?`, [produtoId]);
  await saldos.creditarSaldo(produtoId, TipoSaldo.FISCAL, 10, { db, empresaId: empresaA.id });
  const publico = await saldos.consultarSaldo(produtoId, { db, empresaId: empresaA.id });
  assert.strictEqual(publico.saldo_fiscal, 10);
  assert.strictEqual(publico.reservado_fiscal, 0);
  const iso = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(iso.saldo_fiscal, 10);
  assert.strictEqual(iso.reservado_fiscal, 0);
  const prod = await get(db, 'SELECT saldo_fiscal, reservado_fiscal FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.saldo_fiscal, 110);
  assert.strictEqual(prod.reservado_fiscal, 99);

  const porta = fs.readFileSync(
    path.join(ROOT, 'backend/services/fiscalNaoFiscal/estoqueSaldosPublico.js'),
    'utf8'
  );
  assert.ok(porta.includes('FROM produtos'));
  assert.ok(porta.includes('consultarSaldoParaEmpresa'));
  assert.ok(porta.includes('consultarSaldoEmProdutos'));
  assert.ok(!/\bFROM\s+estoque_empresa\b/i.test(porta));
  const produtos = fs.readFileSync(path.join(ROOT, 'backend/rotas/produtos.js'), 'utf8');
  const compras = fs.readFileSync(path.join(ROOT, 'backend/rotas/compras.js'), 'utf8');
  const vendas = fs.readFileSync(path.join(ROOT, 'backend/rotas/vendas.js'), 'utf8');
  assert.ok(produtos.includes('criarMiddlewareContextoEmpresa(db)'));
  assert.ok(compras.includes('criarMiddlewareContextoEmpresa(db)'));
  assert.ok(vendas.includes('criarMiddlewareContextoEmpresa(db)'));
  assert.ok(!/criarMiddlewareContextoEmpresa\(db,\s*\{\s*obrigatorio:\s*true/.test(produtos));
  await closeDb(db);
}

async function main() {
  const testes = [
    ['01 credito fiscal espelha', test01CreditoFiscal],
    ['02 credito nao fiscal espelha', test02CreditoNaoFiscal],
    ['03 debito fiscal espelha', test03DebitoFiscal],
    ['04 debito nao fiscal espelha', test04DebitoNaoFiscal],
    ['05 estoque_atual = SF+SNF', test05EstoqueAtual],
    ['06 isolamento A/B', test06IsolamentoAB],
    ['07 nasce zerado + delta', test07NasceZeradoMaisDelta],
    ['08 nao copia saldo legado', test08NaoCopiaLegado],
    ['09 COMPAT sem empresa', test09CompatSemEmpresa],
    ['10 rollback externo', test10Rollback],
    ['11 empresa inexistente HTTP', test11EmpresaInexistenteHttp],
    ['12 empresa inativa', test12EmpresaInativa],
    ['13 usuario sem vinculo', test13SemVinculo],
    ['14 body nao sobrescreve contexto', test14BodyNaoSobrescreve],
    ['15 consultarSaldo com empresa le estoque_empresa (03.35)', test15LeituraContinuaProdutos]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\ndual-write-porta-publica-empresa-03-19: ${ok}/${testes.length} OK`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
