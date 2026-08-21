/**
 * Fase 2 / Implementação 03.4 — Contexto empresarial obrigatório (operações novas).
 */
'use strict';

const assert = require('assert');
const sqlite3 = require('sqlite3').verbose();

const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const UsuarioEmpresaService = require('../../backend/services/empresas/UsuarioEmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const {
  criarMiddlewareContextoEmpresa,
  exigirEmpresaAlvoDoContexto,
  resolverEmpresaIdDaRequisicao,
  COMPAT_CERTIFICADA_PRE_MULTIEMPRESA
} = require('../../backend/services/fiscalNaoFiscal/empresaContexto');
const saldos = require('../../backend/services/fiscalNaoFiscal/estoqueSaldosPublico');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';
const CNPJ_C = '12345678000195';

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

function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_) { resolve(); }
  });
}

async function setup() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaUsuarioEmpresasAsync(db);
  await run(db, `
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT
    )
  `);
  const u1 = await run(db, `INSERT INTO usuarios (username) VALUES ('ana')`);
  const u2 = await run(db, `INSERT INTO usuarios (username) VALUES ('bruno')`);
  await run(db, `
    CREATE TABLE produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT,
      saldo_fiscal REAL DEFAULT 0,
      saldo_nao_fiscal REAL DEFAULT 0,
      reservado_fiscal REAL DEFAULT 0,
      reservado_nao_fiscal REAL DEFAULT 0,
      controla_estoque INTEGER DEFAULT 1,
      estoque_atual REAL DEFAULT 0,
      updated_at DATETIME
    )
  `);
  const p = await run(db, `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual)
    VALUES ('Cebola', 10, 5, 15)`);
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'Empresa A', nome_fantasia: 'A' }, { db });
  const b = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'Empresa B', nome_fantasia: 'B' }, { db });
  const c = await EmpresaService.criarEmpresa({ cnpj: CNPJ_C, razao_social: 'Empresa C', nome_fantasia: 'C' }, { db });
  return {
    db,
    produtoId: p.lastID,
    usuarioId: u1.lastID,
    outroUsuarioId: u2.lastID,
    empresaA: a,
    empresaB: b,
    empresaC: c
  };
}

function reqContexto(usuarioId, empresaId, extra = {}) {
  const headers = extra.headers || {};
  if (empresaId != null && headers['x-empresa-id'] == null) {
    headers['x-empresa-id'] = String(empresaId);
  }
  return {
    user: usuarioId != null ? { id: usuarioId } : extra.user,
    headers,
    body: extra.body || {},
    params: extra.params || {}
  };
}

function executarObrigatorio(db, req, operacao) {
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
        resolve({ ok: false, status: this.statusCode, body: payload, empresaId: req.empresaId });
        return this;
      }
    };
    mw(req, res, async () => {
      try {
        const result = operacao ? await operacao(req) : null;
        resolve({ ok: true, empresaId: req.empresaId, result });
      } catch (err) {
        resolve({
          ok: false,
          err,
          status: err.status || null,
          body: { code: err.code, error: err.message },
          empresaId: req.empresaId
        });
      }
    }).catch((err) => resolve({ ok: false, err }));
  });
}

async function alterarEmpresaNoContexto(db, req, alvoId, dados) {
  return executarObrigatorio(db, req, async (r) => {
    const empresaId = exigirEmpresaAlvoDoContexto(r.empresaId, alvoId);
    return EmpresaService.atualizarEmpresa(empresaId, dados, { db });
  });
}

async function vincularNoContexto(db, req, usuarioAlvoId, empresaFonte) {
  return executarObrigatorio(db, req, async (r) => {
    const empresaId = exigirEmpresaAlvoDoContexto(r.empresaId, empresaFonte);
    return UsuarioEmpresaService.vincularUsuarioEmpresa(usuarioAlvoId, { empresaId }, { db });
  });
}

async function test01OperacaoValida() {
  const { db, usuarioId, empresaA } = await setup();
  await UsuarioEmpresaService.vincularUsuarioEmpresa(usuarioId, { empresaId: empresaA.id }, { db });
  const r = await alterarEmpresaNoContexto(
    db,
    reqContexto(usuarioId, empresaA.id),
    empresaA.id,
    { nome_fantasia: 'A1' }
  );
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.empresaId, empresaA.id);
  assert.strictEqual(r.result.nome_fantasia, 'A1');
  assert.strictEqual(r.result.id, empresaA.id);
  await closeDb(db);
}

async function test02SemEmpresa() {
  const { db, usuarioId, empresaA } = await setup();
  await UsuarioEmpresaService.vincularUsuarioEmpresa(usuarioId, { empresaId: empresaA.id }, { db });
  const r = await alterarEmpresaNoContexto(
    db,
    reqContexto(usuarioId, null, { headers: {} }),
    empresaA.id,
    { nome_fantasia: 'X' }
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.body && r.body.code, 'EMPRESA_OBRIGATORIA');
  assert.strictEqual(r.status, 400);
  await closeDb(db);
}

async function test03Inexistente() {
  const { db, usuarioId } = await setup();
  const r = await alterarEmpresaNoContexto(
    db,
    reqContexto(usuarioId, 999),
    999,
    { nome_fantasia: 'X' }
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.body && r.body.code, 'EMPRESA_NAO_ENCONTRADA');
  await closeDb(db);
}

async function test04Inativa() {
  const { db, usuarioId, empresaA } = await setup();
  await UsuarioEmpresaService.vincularUsuarioEmpresa(usuarioId, { empresaId: empresaA.id }, { db });
  await EmpresaService.inativarEmpresa(empresaA.id, { db });
  const r = await alterarEmpresaNoContexto(
    db,
    reqContexto(usuarioId, empresaA.id),
    empresaA.id,
    { nome_fantasia: 'X' }
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.body && r.body.code, 'EMPRESA_INATIVA');
  await closeDb(db);
}

async function test05SemVinculo() {
  const { db, usuarioId, empresaA } = await setup();
  const r = await alterarEmpresaNoContexto(
    db,
    reqContexto(usuarioId, empresaA.id),
    empresaA.id,
    { nome_fantasia: 'X' }
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.body && r.body.code, 'EMPRESA_NAO_AUTORIZADA');
  assert.strictEqual(r.status, 403);
  await closeDb(db);
}

async function test06AutorizadaVinculo() {
  const { db, usuarioId, outroUsuarioId, empresaA } = await setup();
  await UsuarioEmpresaService.vincularUsuarioEmpresa(usuarioId, { empresaId: empresaA.id }, { db });
  const r = await vincularNoContexto(
    db,
    reqContexto(usuarioId, empresaA.id, { body: { empresaId: empresaA.id } }),
    outroUsuarioId,
    { empresaId: empresaA.id }
  );
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.empresaId, empresaA.id);
  assert.strictEqual(Number(r.result.empresa_id), empresaA.id);
  assert.strictEqual(Number(r.result.usuario_id), outroUsuarioId);
  await closeDb(db);
}

async function test07TrocarEmpresaAlteraContexto() {
  const { db, usuarioId, empresaA, empresaB } = await setup();
  await UsuarioEmpresaService.vincularUsuarioEmpresa(usuarioId, { empresaId: empresaA.id }, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(usuarioId, { empresaId: empresaB.id }, { db });

  const rA = await alterarEmpresaNoContexto(
    db,
    reqContexto(usuarioId, empresaA.id),
    empresaA.id,
    { nome_fantasia: 'Ctx A' }
  );
  assert.strictEqual(rA.ok, true);
  assert.strictEqual(rA.empresaId, empresaA.id);

  const rB = await alterarEmpresaNoContexto(
    db,
    reqContexto(usuarioId, empresaB.id),
    empresaB.id,
    { nome_fantasia: 'Ctx B' }
  );
  assert.strictEqual(rB.ok, true);
  assert.strictEqual(rB.empresaId, empresaB.id);
  assert.strictEqual(rB.result.nome_fantasia, 'Ctx B');

  const cruzado = await alterarEmpresaNoContexto(
    db,
    reqContexto(usuarioId, empresaA.id),
    empresaB.id,
    { nome_fantasia: 'Nao' }
  );
  assert.strictEqual(cruzado.ok, false);
  assert.strictEqual(cruzado.body && cruzado.body.code, 'EMPRESA_NAO_AUTORIZADA');
  await closeDb(db);
}

async function test08HeaderNaoBypassa() {
  const { db, usuarioId, empresaA } = await setup();
  const r = await executarObrigatorio(db, reqContexto(usuarioId, empresaA.id));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.body && r.body.code, 'EMPRESA_NAO_AUTORIZADA');

  const semUser = await executarObrigatorio(db, {
    headers: { 'x-empresa-id': String(empresaA.id) },
    body: {},
    user: null
  });
  assert.strictEqual(semUser.ok, false);
  assert.strictEqual(semUser.body && semUser.body.code, 'EMPRESA_NAO_AUTORIZADA');
  await closeDb(db);
}

async function test09CompatLegado() {
  const { db, produtoId } = await setup();
  const r = await saldos.consultarSaldo(produtoId, {
    db,
    ...COMPAT_CERTIFICADA_PRE_MULTIEMPRESA
  });
  assert.strictEqual(r.legado, true);
  assert.strictEqual(r.empresa_id, null);

  const opcional = criarMiddlewareContextoEmpresa(db);
  const req = { headers: {}, body: {}, user: { id: 1 } };
  await new Promise((resolve, reject) => {
    opcional(req, { status() { return this; }, json() {} }, () => {
      try {
        assert.strictEqual(req.empresaId, null);
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });

  const row = await new Promise((resolve, reject) => {
    db.get(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'estoque_empresa'`,
      (err, x) => (err ? reject(err) : resolve(x || null))
    );
  });
  assert.strictEqual(row, null);
  await closeDb(db);
}

async function test10EndToEnd() {
  const { db, usuarioId, empresaA, empresaB, empresaC } = await setup();
  await UsuarioEmpresaService.vincularUsuarioEmpresa(usuarioId, { empresaId: empresaA.id }, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(usuarioId, { empresaId: empresaB.id }, { db });

  const reqA = reqContexto(usuarioId, empresaA.id);
  assert.strictEqual(resolverEmpresaIdDaRequisicao(reqA), empresaA.id);
  const opA = await alterarEmpresaNoContexto(db, reqA, empresaA.id, { nome_fantasia: 'Op A' });
  assert.strictEqual(opA.ok, true);
  assert.strictEqual(opA.empresaId, empresaA.id);

  const reqB = reqContexto(usuarioId, empresaB.id);
  assert.strictEqual(resolverEmpresaIdDaRequisicao(reqB), empresaB.id);
  const opB = await alterarEmpresaNoContexto(db, reqB, empresaB.id, { nome_fantasia: 'Op B' });
  assert.strictEqual(opB.ok, true);
  assert.strictEqual(opB.empresaId, empresaB.id);

  const opC = await alterarEmpresaNoContexto(
    db,
    reqContexto(usuarioId, empresaC.id),
    empresaC.id,
    { nome_fantasia: 'Op C' }
  );
  assert.strictEqual(opC.ok, false);
  assert.strictEqual(opC.body && opC.body.code, 'EMPRESA_NAO_AUTORIZADA');
  assert.strictEqual(opC.status, 403);
  await closeDb(db);
}

async function main() {
  const testes = [
    ['01 operação com empresa válida', test01OperacaoValida],
    ['02 sem empresa EMPRESA_OBRIGATORIA', test02SemEmpresa],
    ['03 inexistente EMPRESA_NAO_ENCONTRADA', test03Inexistente],
    ['04 inativa EMPRESA_INATIVA', test04Inativa],
    ['05 sem vínculo EMPRESA_NAO_AUTORIZADA', test05SemVinculo],
    ['06 autorizada (vínculo) funciona', test06AutorizadaVinculo],
    ['07 trocar empresa altera o contexto', test07TrocarEmpresaAlteraContexto],
    ['08 header não bypassa autorização', test08HeaderNaoBypassa],
    ['09 COMPAT legado', test09CompatLegado],
    ['10 end-to-end A → B → C recusada', test10EndToEnd]
  ];

  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\ncontexto-obrigatorio-03-4: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
