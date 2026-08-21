/**
 * Fase 2 / Implementação 03.2 — Contexto empresarial + seletor.
 */
'use strict';

const assert = require('assert');
const sqlite3 = require('sqlite3').verbose();

const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const UsuarioEmpresaService = require('../../backend/services/empresas/UsuarioEmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const {
  resolverEmpresaIdDaRequisicao,
  resolverContextoEmpresa,
  validarEmpresaId,
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
  const u = await run(db, `INSERT INTO usuarios (username) VALUES ('operador')`);
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
  const p = await run(
    db,
    `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual)
     VALUES ('Cebola', 10, 5, 15)`
  );
  return { db, produtoId: p.lastID, usuarioId: u.lastID };
}

async function vincular(db, usuarioId, empresaId) {
  await UsuarioEmpresaService.vincularUsuarioEmpresa(usuarioId, { empresaId }, { db });
}

async function test01ListarAtivas() {
  const { db, usuarioId } = await setup();
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A', nome_fantasia: 'Fantasia A' }, { db });
  const b = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  await vincular(db, usuarioId, a.id);
  await vincular(db, usuarioId, b.id);
  const lista = await EmpresaService.listarEmpresasDisponiveis({ db, usuarioId });
  assert.strictEqual(lista.length, 2);
  assert.ok(lista.every((e) => e.id && e.cnpj && e.razao_social));
  assert.ok(!Object.prototype.hasOwnProperty.call(lista[0], 'inscricao_estadual'));
  assert.ok(lista.some((e) => e.id === a.id && e.nome_fantasia === 'Fantasia A'));
  await closeDb(db);
}

async function test02NaoListarInativa() {
  const { db, usuarioId } = await setup();
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const b = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  await vincular(db, usuarioId, a.id);
  await vincular(db, usuarioId, b.id);
  await EmpresaService.inativarEmpresa(a.id, { db });
  const lista = await EmpresaService.listarEmpresasDisponiveis({ db, usuarioId });
  assert.strictEqual(lista.length, 1);
  assert.strictEqual(lista[0].cnpj, CNPJ_B);
  await closeDb(db);
}

async function test03SelecionarExistente() {
  const { db, usuarioId } = await setup();
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  await vincular(db, usuarioId, a.id);
  const sel = await EmpresaService.selecionarEmpresaContexto({ empresaId: a.id }, { db, usuarioId });
  assert.strictEqual(sel.id, a.id);
  assert.strictEqual(sel.cnpj, CNPJ_A);
  await closeDb(db);
}

async function test04RejeitarInexistente() {
  const { db } = await setup();
  await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  await assertRejects(
    EmpresaService.selecionarEmpresaContexto(999, { db }),
    'EMPRESA_NAO_ENCONTRADA'
  );
  await closeDb(db);
}

async function test05RejeitarInativa() {
  const { db } = await setup();
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  await EmpresaService.inativarEmpresa(a.id, { db });
  await assertRejects(
    EmpresaService.selecionarEmpresaContexto(a.id, { db }),
    'EMPRESA_INATIVA'
  );
  await assertRejects(
    validarEmpresaId(a.id, { db }),
    'EMPRESA_INATIVA'
  );
  await closeDb(db);
}

async function test06ContextoRetornaEmpresaId() {
  const { db, usuarioId } = await setup();
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  await vincular(db, usuarioId, a.id);
  const ctx = await EmpresaService.obterContextoEmpresa({ empresaId: a.id }, { db, usuarioId });
  assert.strictEqual(ctx.selecionada, true);
  assert.strictEqual(ctx.empresaId, a.id);
  assert.strictEqual(ctx.empresa.id, a.id);

  const req = { headers: { 'x-empresa-id': String(a.id) } };
  const viaReq = resolverEmpresaIdDaRequisicao(req);
  assert.strictEqual(viaReq, a.id);
  const ctxReq = await EmpresaService.obterContextoEmpresa(null, { db, req, usuarioId });
  assert.strictEqual(ctxReq.empresaId, a.id);
  await closeDb(db);
}

async function test07TrocarEmpresa() {
  const { db, usuarioId } = await setup();
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const b = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  await vincular(db, usuarioId, a.id);
  await vincular(db, usuarioId, b.id);
  const c1 = await EmpresaService.obterContextoEmpresa(a.id, { db, usuarioId });
  assert.strictEqual(c1.empresaId, a.id);
  const c2 = await EmpresaService.obterContextoEmpresa(b.id, { db, usuarioId });
  assert.strictEqual(c2.empresaId, b.id);
  assert.strictEqual(c2.empresa.cnpj, CNPJ_B);
  await closeDb(db);
}

async function test08NenhumaAtiva() {
  const { db, usuarioId } = await setup();
  const vazia = await EmpresaService.listarEmpresasDisponiveis({ db, usuarioId });
  assert.deepStrictEqual(vazia, []);
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  await vincular(db, usuarioId, a.id);
  await EmpresaService.inativarEmpresa(a.id, { db });
  const depois = await EmpresaService.listarEmpresasDisponiveis({ db, usuarioId });
  assert.deepStrictEqual(depois, []);
  const ctx = await EmpresaService.obterContextoEmpresa(null, { db, usuarioId });
  assert.strictEqual(ctx.selecionada, false);
  assert.strictEqual(ctx.empresaId, null);
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
  const ctx = await resolverContextoEmpresa({
    db,
    ...COMPAT_CERTIFICADA_PRE_MULTIEMPRESA
  });
  assert.strictEqual(ctx.legado, true);
  await closeDb(db);
}

async function testIdObrigatorioESemFallback() {
  const { db } = await setup();
  await assertRejects(
    EmpresaService.selecionarEmpresaContexto({}, { db }),
    'EMPRESA_ID_OBRIGATORIO'
  );
  assert.strictEqual(resolverEmpresaIdDaRequisicao({ headers: {}, body: {} }), null);
  await closeDb(db);
}

async function testSemEstoqueEmpresa() {
  const { db } = await setup();
  await EmpresaService.criarEmpresa({ cnpj: CNPJ_C, razao_social: 'C' }, { db });
  const row = await new Promise((resolve, reject) => {
    db.get(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'estoque_empresa'`,
      (err, r) => (err ? reject(err) : resolve(r || null))
    );
  });
  assert.strictEqual(row, null);
  await closeDb(db);
}

async function main() {
  const testes = [
    ['01 listar empresas ativas', test01ListarAtivas],
    ['02 não listar inativa', test02NaoListarInativa],
    ['03 selecionar existente', test03SelecionarExistente],
    ['04 rejeitar inexistente', test04RejeitarInexistente],
    ['05 rejeitar inativa', test05RejeitarInativa],
    ['06 contexto retorna empresaId', test06ContextoRetornaEmpresaId],
    ['07 trocar empresa', test07TrocarEmpresa],
    ['08 nenhuma empresa ativa', test08NenhumaAtiva],
    ['09 COMPAT legado', test09CompatLegado],
    ['empresaId obrigatório / sem fallback', testIdObrigatorioESemFallback],
    ['sem estoque_empresa', testSemEstoqueEmpresa]
  ];

  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\ncontexto-empresarial-03-2: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
