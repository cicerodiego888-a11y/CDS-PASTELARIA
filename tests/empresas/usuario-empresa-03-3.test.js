/**
 * Fase 2 / Implementação 03.3 — Vínculo usuário ↔ empresa.
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
  COMPAT_CERTIFICADA_PRE_MULTIEMPRESA
} = require('../../backend/services/fiscalNaoFiscal/empresaContexto');
const saldos = require('../../backend/services/fiscalNaoFiscal/estoqueSaldosPublico');

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

function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_) { resolve(); }
  });
}

async function assertRejects(promise, code) {
  try {
    await promise;
    throw new Error(`Esperava erro ${code}, mas resolveu`);
  } catch (err) {
    if (err.message && err.message.startsWith('Esperava erro')) throw err;
    assert.strictEqual(err.code, code, `código esperado ${code}, veio ${err.code}: ${err.message}`);
  }
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
  return {
    db,
    produtoId: p.lastID,
    usuarioId: u1.lastID,
    outroUsuarioId: u2.lastID,
    empresaA: a,
    empresaB: b
  };
}

function middlewareResultado(db, req) {
  return new Promise((resolve) => {
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
        resolve({ ok: false, status: this.statusCode, body: payload });
        return this;
      }
    };
    mw(req, res, () => resolve({ ok: true, empresaId: req.empresaId })).catch((err) => {
      resolve({ ok: false, err });
    });
  });
}

async function test01CriarVinculo() {
  const { db, usuarioId, empresaA } = await setup();
  const v = await UsuarioEmpresaService.vincularUsuarioEmpresa(usuarioId, { empresaId: empresaA.id }, { db });
  assert.strictEqual(Number(v.usuario_id), usuarioId);
  assert.strictEqual(Number(v.empresa_id), empresaA.id);
  assert.strictEqual(Number(v.ativo), 1);
  await closeDb(db);
}

async function test02VinculoDuplicado() {
  const { db, usuarioId, empresaA } = await setup();
  await UsuarioEmpresaService.vincularUsuarioEmpresa(usuarioId, empresaA.id, { db });
  await assertRejects(
    UsuarioEmpresaService.vincularUsuarioEmpresa(usuarioId, empresaA.id, { db }),
    'VINCULO_EMPRESA_DUPLICADO'
  );
  await closeDb(db);
}

async function test03ListarEmpresasDoUsuario() {
  const { db, usuarioId, empresaA, empresaB } = await setup();
  await UsuarioEmpresaService.vincularUsuarioEmpresa(usuarioId, empresaA.id, { db });
  const lista = await UsuarioEmpresaService.listarVinculosDoUsuario(usuarioId, { db });
  assert.strictEqual(lista.length, 1);
  assert.strictEqual(lista[0].empresa_id, empresaA.id);
  assert.ok(!lista.some((x) => x.empresa_id === empresaB.id));
  await closeDb(db);
}

async function test04VinculadaAtivaAparece() {
  const { db, usuarioId, empresaA } = await setup();
  await UsuarioEmpresaService.vincularUsuarioEmpresa(usuarioId, empresaA.id, { db });
  const disp = await EmpresaService.listarEmpresasDisponiveis({ db, usuarioId });
  assert.strictEqual(disp.length, 1);
  assert.strictEqual(disp[0].id, empresaA.id);
  await closeDb(db);
}

async function test05NaoVinculadaNaoAparece() {
  const { db, usuarioId, empresaA, empresaB } = await setup();
  await UsuarioEmpresaService.vincularUsuarioEmpresa(usuarioId, empresaA.id, { db });
  const disp = await EmpresaService.listarEmpresasDisponiveis({ db, usuarioId });
  assert.ok(!disp.some((e) => e.id === empresaB.id));
  await closeDb(db);
}

async function test06InativaNaoAparece() {
  const { db, usuarioId, empresaA } = await setup();
  await UsuarioEmpresaService.vincularUsuarioEmpresa(usuarioId, empresaA.id, { db });
  await EmpresaService.inativarEmpresa(empresaA.id, { db });
  const disp = await EmpresaService.listarEmpresasDisponiveis({ db, usuarioId });
  assert.deepStrictEqual(disp, []);
  await closeDb(db);
}

async function test07SelecaoVinculada() {
  const { db, usuarioId, empresaA } = await setup();
  await UsuarioEmpresaService.vincularUsuarioEmpresa(usuarioId, empresaA.id, { db });
  const sel = await EmpresaService.selecionarEmpresaContexto(empresaA.id, { db, usuarioId });
  assert.strictEqual(sel.id, empresaA.id);
  await closeDb(db);
}

async function test08SelecaoNaoVinculadaFalha() {
  const { db, usuarioId, empresaA } = await setup();
  await assertRejects(
    EmpresaService.selecionarEmpresaContexto(empresaA.id, { db, usuarioId }),
    'EMPRESA_NAO_AUTORIZADA'
  );
  await closeDb(db);
}

async function test09InexistenteFalha() {
  const { db, usuarioId } = await setup();
  await assertRejects(
    EmpresaService.selecionarEmpresaContexto(999, { db, usuarioId }),
    'EMPRESA_NAO_ENCONTRADA'
  );
  await closeDb(db);
}

async function test10InativaFalha() {
  const { db, usuarioId, empresaA } = await setup();
  await UsuarioEmpresaService.vincularUsuarioEmpresa(usuarioId, empresaA.id, { db });
  await EmpresaService.inativarEmpresa(empresaA.id, { db });
  await assertRejects(
    EmpresaService.selecionarEmpresaContexto(empresaA.id, { db, usuarioId }),
    'EMPRESA_INATIVA'
  );
  await closeDb(db);
}

async function test11HeaderNaoBypassa() {
  const { db, usuarioId, empresaA } = await setup();
  const req = {
    user: { id: usuarioId },
    headers: { 'x-empresa-id': String(empresaA.id) },
    body: {}
  };
  const r = await middlewareResultado(db, req);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.body && r.body.code, 'EMPRESA_NAO_AUTORIZADA');
  assert.strictEqual(r.status, 403);

  const reqSemUser = {
    headers: { 'x-empresa-id': String(empresaA.id) },
    body: {}
  };
  const r2 = await middlewareResultado(db, reqSemUser);
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.body && r2.body.code, 'EMPRESA_NAO_AUTORIZADA');
  await closeDb(db);
}

async function test12TrocaAutorizada() {
  const { db, usuarioId, empresaA, empresaB } = await setup();
  await UsuarioEmpresaService.vincularUsuarioEmpresa(usuarioId, empresaA.id, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(usuarioId, empresaB.id, { db });
  const c1 = await EmpresaService.obterContextoEmpresa(empresaA.id, { db, usuarioId });
  assert.strictEqual(c1.empresaId, empresaA.id);
  const c2 = await EmpresaService.obterContextoEmpresa(empresaB.id, { db, usuarioId });
  assert.strictEqual(c2.empresaId, empresaB.id);
  await closeDb(db);
}

async function test13TrocaNaoAutorizada() {
  const { db, usuarioId, outroUsuarioId, empresaA, empresaB } = await setup();
  await UsuarioEmpresaService.vincularUsuarioEmpresa(usuarioId, empresaA.id, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(outroUsuarioId, empresaB.id, { db });
  await assertRejects(
    EmpresaService.obterContextoEmpresa(empresaB.id, { db, usuarioId }),
    'EMPRESA_NAO_AUTORIZADA'
  );
  await closeDb(db);
}

async function test14UsuarioSemEmpresas() {
  const { db, usuarioId } = await setup();
  const disp = await EmpresaService.listarEmpresasDisponiveis({ db, usuarioId });
  assert.deepStrictEqual(disp, []);
  const ctx = await EmpresaService.obterContextoEmpresa(null, { db, usuarioId });
  assert.strictEqual(ctx.selecionada, false);
  await closeDb(db);
}

async function test15LogoutLimpaContextoLocal() {
  const store = {};
  const localStorage = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; }
  };
  global.localStorage = localStorage;
  global.window = global;
  delete require.cache[require.resolve('../../frontend/shared/js/cds-empresa-contexto.js')];
  require('../../frontend/shared/js/cds-empresa-contexto.js');
  global.CdsEmpresaContexto.persistir({ id: 7, cnpj: CNPJ_A, razao_social: 'X', nome_fantasia: 'X' });
  assert.strictEqual(store.cds_empresa_id, '7');
  global.CdsEmpresaContexto.limpar();
  assert.strictEqual(store.cds_empresa_id, undefined);
  assert.strictEqual(store.cds_empresa, undefined);
}

async function testCompat() {
  const { db, produtoId } = await setup();
  const r = await saldos.consultarSaldo(produtoId, {
    db,
    ...COMPAT_CERTIFICADA_PRE_MULTIEMPRESA
  });
  assert.strictEqual(r.legado, true);
  await closeDb(db);
}

async function main() {
  const testes = [
    ['01 criar vínculo', test01CriarVinculo],
    ['02 impedir duplicado', test02VinculoDuplicado],
    ['03 listar empresas do usuário', test03ListarEmpresasDoUsuario],
    ['04 vinculada ativa aparece', test04VinculadaAtivaAparece],
    ['05 não vinculada não aparece', test05NaoVinculadaNaoAparece],
    ['06 inativa não aparece', test06InativaNaoAparece],
    ['07 seleção vinculada', test07SelecaoVinculada],
    ['08 seleção não vinculada falha', test08SelecaoNaoVinculadaFalha],
    ['09 inexistente falha', test09InexistenteFalha],
    ['10 inativa falha', test10InativaFalha],
    ['11 header não bypassa', test11HeaderNaoBypassa],
    ['12 troca autorizada', test12TrocaAutorizada],
    ['13 troca não autorizada falha', test13TrocaNaoAutorizada],
    ['14 usuário sem empresas', test14UsuarioSemEmpresas],
    ['15 logout limpa contexto local', test15LogoutLimpaContextoLocal],
    ['COMPAT legado', testCompat]
  ];

  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\nusuario-empresa-03-3: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
