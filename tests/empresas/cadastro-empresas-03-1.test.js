/**
 * Fase 2 / Implementação 03.1 — Cadastro oficial de empresas.
 */
'use strict';

const assert = require('assert');
const sqlite3 = require('sqlite3').verbose();

const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const {
  isCnpjEmpresaValido,
  exigirCnpjEmpresaValido,
  normalizarCnpjEmpresa
} = require('../../backend/services/empresas/empresaCnpj');
const {
  validarEmpresaId,
  resolverContextoEmpresa,
  COMPAT_CERTIFICADA_PRE_MULTIEMPRESA
} = require('../../backend/services/fiscalNaoFiscal/empresaContexto');
const saldos = require('../../backend/services/fiscalNaoFiscal/estoqueSaldosPublico');
const { TipoSaldo } = require('../../backend/services/fiscalNaoFiscal/constants');

const CNPJ_A = '11222333000181';
const CNPJ_A_FMT = '11.222.333/0001-81';
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

async function assertRejects(promise, code) {
  try {
    await promise;
    throw new Error(`Esperava erro ${code}, mas resolveu`);
  } catch (err) {
    if (err.message && err.message.startsWith('Esperava erro')) throw err;
    assert.strictEqual(err.code, code, `código esperado ${code}, veio ${err.code}: ${err.message}`);
  }
}

async function setupCadastro() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  return db;
}

async function setupComProduto() {
  const db = await setupCadastro();
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
  return { db, produtoId: p.lastID };
}

async function test01CriarEmpresa() {
  const db = await setupCadastro();
  const e = await EmpresaService.criarEmpresa({
    cnpj: CNPJ_A_FMT,
    razao_social: 'Pastelaria Centro Ltda',
    nome_fantasia: 'Pastelaria Centro'
  }, { db });
  assert.ok(e.id > 0);
  assert.strictEqual(e.cnpj, CNPJ_A);
  assert.strictEqual(e.razao_social, 'Pastelaria Centro Ltda');
  assert.strictEqual(e.nome_fantasia, 'Pastelaria Centro');
  assert.strictEqual(e.ativo, 1);
  await closeDb(db);
}

async function test02CnpjValido() {
  assert.strictEqual(isCnpjEmpresaValido(CNPJ_A), true);
  assert.strictEqual(isCnpjEmpresaValido(CNPJ_A_FMT), true);
  assert.strictEqual(exigirCnpjEmpresaValido(CNPJ_A_FMT), CNPJ_A);
}

async function test03CnpjInvalido() {
  assert.strictEqual(isCnpjEmpresaValido('123'), false);
  assert.strictEqual(isCnpjEmpresaValido('00000000000000'), false);
  assert.strictEqual(isCnpjEmpresaValido('11222333000180'), false);
  await assertRejects(
    Promise.resolve().then(() => exigirCnpjEmpresaValido('11.222.333/0001-80')),
    'CNPJ_EMPRESA_INVALIDO'
  );
  const db = await setupCadastro();
  await assertRejects(
    EmpresaService.criarEmpresa({ cnpj: '123', razao_social: 'X' }, { db }),
    'CNPJ_EMPRESA_INVALIDO'
  );
  await assertRejects(
    EmpresaService.criarEmpresa({ razao_social: 'X' }, { db }),
    'CNPJ_EMPRESA_OBRIGATORIO'
  );
  await assertRejects(
    EmpresaService.criarEmpresa({ cnpj: CNPJ_A }, { db }),
    'RAZAO_SOCIAL_OBRIGATORIA'
  );
  await closeDb(db);
}

async function test04CnpjDuplicado() {
  const db = await setupCadastro();
  await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  await assertRejects(
    EmpresaService.criarEmpresa({ cnpj: CNPJ_A_FMT, razao_social: 'B' }, { db }),
    'CNPJ_EMPRESA_DUPLICADO'
  );
  await closeDb(db);
}

async function test05BuscarPorId() {
  const db = await setupCadastro();
  const criada = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const e = await EmpresaService.buscarEmpresaPorId(criada.id, { db });
  assert.strictEqual(e.id, criada.id);
  assert.strictEqual(e.cnpj, CNPJ_A);
  await closeDb(db);
}

async function test06BuscarPorCnpjNormalizado() {
  const db = await setupCadastro();
  await EmpresaService.criarEmpresa({ cnpj: CNPJ_A_FMT, razao_social: 'A' }, { db });
  const e = await EmpresaService.buscarEmpresaPorCnpj('11.222.333/0001-81', { db });
  assert.strictEqual(e.cnpj, CNPJ_A);
  assert.strictEqual(normalizarCnpjEmpresa(CNPJ_A_FMT), CNPJ_A);
  await closeDb(db);
}

async function test07ListarEmpresas() {
  const db = await setupCadastro();
  await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'Beta' }, { db });
  await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'Alfa' }, { db });
  const lista = await EmpresaService.listarEmpresas({}, { db });
  assert.strictEqual(lista.length, 2);
  assert.strictEqual(lista[0].razao_social, 'Alfa');
  await closeDb(db);
}

async function test08AlterarDados() {
  const db = await setupCadastro();
  const criada = await EmpresaService.criarEmpresa({
    cnpj: CNPJ_A,
    razao_social: 'Antes',
    nome_fantasia: 'N1'
  }, { db });
  const e = await EmpresaService.atualizarEmpresa(criada.id, {
    razao_social: 'Depois',
    nome_fantasia: 'N2',
    inscricao_estadual: '123'
  }, { db });
  assert.strictEqual(e.razao_social, 'Depois');
  assert.strictEqual(e.nome_fantasia, 'N2');
  assert.strictEqual(e.inscricao_estadual, '123');
  assert.strictEqual(e.cnpj, CNPJ_A);
  await closeDb(db);
}

async function test09AtivarEmpresa() {
  const db = await setupCadastro();
  const criada = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  await EmpresaService.inativarEmpresa(criada.id, { db });
  const e = await EmpresaService.ativarEmpresa(criada.id, { db });
  assert.strictEqual(e.ativo, 1);
  await assertRejects(
    EmpresaService.ativarEmpresa(criada.id, { db }),
    'EMPRESA_JA_ATIVA'
  );
  await closeDb(db);
}

async function test10InativarEmpresa() {
  const db = await setupCadastro();
  const criada = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const e = await EmpresaService.inativarEmpresa(criada.id, { db });
  assert.strictEqual(e.ativo, 0);
  const row = await get(db, 'SELECT ativo FROM empresas WHERE id = ?', [criada.id]);
  assert.strictEqual(Number(row.ativo), 0);
  await assertRejects(
    EmpresaService.inativarEmpresa(criada.id, { db }),
    'EMPRESA_JA_INATIVA'
  );
  await closeDb(db);
}

async function test11EmpresaInexistente() {
  const db = await setupCadastro();
  await assertRejects(
    EmpresaService.buscarEmpresaPorId(99, { db }),
    'EMPRESA_NAO_ENCONTRADA'
  );
  await assertRejects(
    EmpresaService.atualizarEmpresa(99, { razao_social: 'X' }, { db }),
    'EMPRESA_NAO_ENCONTRADA'
  );
  await assertRejects(
    EmpresaService.buscarEmpresaPorCnpj(CNPJ_C, { db }),
    'EMPRESA_NAO_ENCONTRADA'
  );
  await closeDb(db);
}

async function test12ContextoEmpresaInativa() {
  const { db, produtoId } = await setupComProduto();
  const criada = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  await EmpresaService.inativarEmpresa(criada.id, { db });
  await assertRejects(
    validarEmpresaId(criada.id, { db }),
    'EMPRESA_INATIVA'
  );
  await assertRejects(
    resolverContextoEmpresa({ empresaId: criada.id, db }),
    'EMPRESA_INATIVA'
  );
  await assertRejects(
    saldos.consultarSaldo(produtoId, { db, empresaId: criada.id }),
    'EMPRESA_INATIVA'
  );
  await assertRejects(
    saldos.creditarSaldo(produtoId, TipoSaldo.FISCAL, 1, { db, empresaId: criada.id }),
    'EMPRESA_INATIVA'
  );
  await closeDb(db);
}

async function test13ContextoEmpresaExistente() {
  const { db, produtoId } = await setupComProduto();
  const criada = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const id = await validarEmpresaId(criada.id, { db });
  assert.strictEqual(id, criada.id);
  const ctx = await resolverContextoEmpresa({ empresaId: criada.id, db });
  assert.strictEqual(ctx.empresaId, criada.id);
  assert.strictEqual(ctx.legado, false);
  const r = await saldos.consultarSaldo(produtoId, { db, empresaId: criada.id });
  assert.strictEqual(r.empresa_id, criada.id);
  assert.strictEqual(r.saldo_fiscal, 10);
  await closeDb(db);
}

async function test14ContextoEmpresaInexistente() {
  const { db, produtoId } = await setupComProduto();
  await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  await assertRejects(
    validarEmpresaId(999, { db }),
    'EMPRESA_NAO_ENCONTRADA'
  );
  await assertRejects(
    saldos.consultarSaldo(produtoId, { db, empresaId: 999 }),
    'EMPRESA_NAO_ENCONTRADA'
  );
  await closeDb(db);
}

async function test15CompatLegado() {
  const { db, produtoId } = await setupComProduto();
  const r = await saldos.consultarSaldo(produtoId, {
    db,
    ...COMPAT_CERTIFICADA_PRE_MULTIEMPRESA
  });
  assert.strictEqual(r.legado, true);
  assert.strictEqual(r.empresa_id, null);
  assert.strictEqual(r.saldo_fiscal, 10);
  const ctx = await resolverContextoEmpresa({
    db,
    ...COMPAT_CERTIFICADA_PRE_MULTIEMPRESA
  });
  assert.strictEqual(ctx.legado, true);
  assert.strictEqual(ctx.empresaId, null);
  await closeDb(db);
}

async function testProdutoGlobalIntocado() {
  const { db, produtoId } = await setupComProduto();
  await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const prod = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.saldo_fiscal, 10);
  assert.strictEqual(prod.saldo_nao_fiscal, 5);
  const temEstoqueEmpresa = await get(
    db,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'estoque_empresa'`
  );
  assert.strictEqual(temEstoqueEmpresa, null);
  await closeDb(db);
}

async function testSemEmpresaPadrao() {
  const db = await setupCadastro();
  const lista = await EmpresaService.listarEmpresas({}, { db });
  assert.strictEqual(lista.length, 0);
  await closeDb(db);
}

async function main() {
  const testes = [
    ['01 criar empresa', test01CriarEmpresa],
    ['02 CNPJ válido', test02CnpjValido],
    ['03 CNPJ inválido / obrigatório', test03CnpjInvalido],
    ['04 CNPJ duplicado', test04CnpjDuplicado],
    ['05 buscar por ID', test05BuscarPorId],
    ['06 buscar por CNPJ normalizado', test06BuscarPorCnpjNormalizado],
    ['07 listar empresas', test07ListarEmpresas],
    ['08 alterar dados', test08AlterarDados],
    ['09 ativar empresa', test09AtivarEmpresa],
    ['10 inativar empresa', test10InativarEmpresa],
    ['11 empresa inexistente', test11EmpresaInexistente],
    ['12 contexto recusa inativa', test12ContextoEmpresaInativa],
    ['13 empresaContexto reconhece existente', test13ContextoEmpresaExistente],
    ['14 empresaContexto recusa inexistente', test14ContextoEmpresaInexistente],
    ['15 COMPAT legado continua', test15CompatLegado],
    ['produto global / sem estoque_empresa', testProdutoGlobalIntocado],
    ['sem empresa padrão automática', testSemEmpresaPadrao]
  ];

  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\ncadastro-empresas-03-1: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
