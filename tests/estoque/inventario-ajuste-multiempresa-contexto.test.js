/**
 * Fase 2 / Implementação 03.28 — inventário/ajuste: req.empresaId até a porta 03.19.
 * Não existe módulo de inventário/contagem. Escritores reais: ajuste, saldos iniciais, recálculo.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const {
  aplicarAjusteEstoqueProduto,
  aplicarSaldosIniciaisViaPorta,
  empresaIdDoReqAjuste,
  montarOptsPortaAjuste
} = require('../../backend/services/ajusteEstoqueService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');

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

function ajusteAsync(db, opcoes) {
  return new Promise((resolve, reject) => {
    aplicarAjusteEstoqueProduto(db, opcoes, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

function ajustarComoHttp(db, req, dados) {
  return ajusteAsync(db, {
    produtoId: dados.produtoId,
    ajusteFiscal: dados.ajusteFiscal || 0,
    ajusteNaoFiscal: dados.ajusteNaoFiscal || 0,
    motivo: dados.motivo || 'ajuste-teste',
    empresaId: empresaIdDoReqAjuste(req),
    usuarioId: req?.user?.id || null
  });
}

async function setup() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  await run(db, `
    CREATE TABLE produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT,
      saldo_fiscal REAL DEFAULT 0,
      saldo_nao_fiscal REAL DEFAULT 0,
      estoque_atual REAL DEFAULT 0,
      reservado_fiscal REAL DEFAULT 0,
      reservado_nao_fiscal REAL DEFAULT 0,
      controlar_validade INTEGER DEFAULT 0,
      updated_at DATETIME
    )
  `);
  await run(db, `
    CREATE TABLE produtos_ajustes_estoque (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produto_id INTEGER,
      usuario_id INTEGER,
      usuario_nome TEXT,
      motivo TEXT,
      ajuste_fiscal REAL,
      ajuste_nao_fiscal REAL,
      saldo_fiscal_antes REAL,
      saldo_fiscal_depois REAL,
      saldo_nao_fiscal_antes REAL,
      saldo_nao_fiscal_depois REAL,
      estoque_total_antes REAL,
      estoque_total_depois REAL,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const p = await run(
    db,
    `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual, controlar_validade)
     VALUES ('X', 100, 40, 140, 0)`
  );
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const b = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  return { db, produtoId: p.lastID, empresaA: a, empresaB: b };
}

async function seedAB(db, produtoId, empresaA, empresaB) {
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaA.id, saldo_fiscal: 10, saldo_nao_fiscal: 4, estoque_atual: 14
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaB.id, saldo_fiscal: 20, saldo_nao_fiscal: 8, estoque_atual: 28
  }, { db });
}

async function ee(db, produtoId, empresaId) {
  return get(
    db,
    'SELECT * FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?',
    [produtoId, empresaId]
  );
}

async function test01EmpresaIdChega() {
  const { db, produtoId, empresaA } = await setup();
  const req = { empresaId: empresaA.id, body: { empresaId: 99 } };
  assert.strictEqual(empresaIdDoReqAjuste(req), empresaA.id);
  const opts = montarOptsPortaAjuste(db, { empresaId: empresaIdDoReqAjuste(req) });
  assert.strictEqual(opts.empresaId, empresaA.id);
  assert.strictEqual(opts.legado, false);
  const r = await ajustarComoHttp(db, req, { produtoId, ajusteFiscal: 10 });
  assert.strictEqual(r.empresa_id, empresaA.id);
  await closeDb(db);
}

async function test02BodyNaoSubstitui() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  const req = {
    empresaId: empresaA.id,
    body: { empresaId: empresaB.id, empresa_id: empresaB.id },
    contexto: { empresaId: empresaB.id }
  };
  await ajustarComoHttp(db, req, { produtoId, ajusteFiscal: 10 });
  const a = await ee(db, produtoId, empresaA.id);
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(a.saldo_fiscal, 20);
  assert.strictEqual(b.saldo_fiscal, 20);
  await closeDb(db);
}

async function test03QueryNaoSubstitui() {
  const { db, empresaA, empresaB } = await setup();
  const req = {
    empresaId: empresaA.id,
    query: { empresaId: empresaB.id, empresa_id: empresaB.id }
  };
  assert.strictEqual(empresaIdDoReqAjuste(req), empresaA.id);
  const opts = montarOptsPortaAjuste(db, {
    empresaId: empresaIdDoReqAjuste(req),
    query: req.query
  });
  assert.strictEqual(opts.empresaId, empresaA.id);
  await closeDb(db);
}

async function test04AlteraEmpresaCorreta() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  await ajustarComoHttp(db, { empresaId: empresaA.id }, { produtoId, ajusteFiscal: 10 });
  const a = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(a.saldo_fiscal, 20);
  const prod = await get(db, 'SELECT saldo_fiscal FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.saldo_fiscal, 110);
  await closeDb(db);
}

async function test05ANaoAlteraB() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  await ajustarComoHttp(db, { empresaId: empresaA.id }, { produtoId, ajusteFiscal: 10 });
  await ajustarComoHttp(db, { empresaId: empresaB.id }, { produtoId, ajusteFiscal: 20 });
  const a = await ee(db, produtoId, empresaA.id);
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(a.saldo_fiscal, 20);
  assert.strictEqual(b.saldo_fiscal, 40);
  await closeDb(db);
}

async function test06DualWriteReutilizado() {
  const ajuste = fs.readFileSync(
    path.join(ROOT, 'backend/services/ajusteEstoqueService.js'),
    'utf8'
  );
  const recalc = fs.readFileSync(
    path.join(ROOT, 'backend/services/estoqueFiscalService.js'),
    'utf8'
  );
  const porta = fs.readFileSync(
    path.join(ROOT, 'backend/services/fiscalNaoFiscal/estoqueSaldosPublico.js'),
    'utf8'
  );
  assert.ok(ajuste.includes('estoqueSaldosPublico'));
  assert.ok(!ajuste.includes('EstoqueEmpresaService'));
  assert.ok(recalc.includes('estoqueSaldosPublico'));
  assert.ok(!recalc.includes('EstoqueEmpresaService'));
  assert.ok(porta.includes('aplicarEfeitoSaldo'));
}

async function test07CompatSemEmpresa() {
  const { db, produtoId } = await setup();
  const r = await ajustarComoHttp(db, {
    empresaId: null,
    body: { empresaId: 99 }
  }, { produtoId, ajusteFiscal: 5 });
  assert.strictEqual(r.legado, true);
  assert.ok(r.empresa_id == null);
  const prod = await get(db, 'SELECT saldo_fiscal FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.saldo_fiscal, 105);
  const n = await get(db, 'SELECT COUNT(*) AS c FROM estoque_empresa');
  assert.strictEqual(n.c, 0);
  await closeDb(db);
}

async function test08SemFallbackEmpresa1() {
  const { db } = await setup();
  assert.ok(empresaIdDoReqAjuste({ empresaId: null, body: { empresaId: 1 } }) == null);
  const opts = montarOptsPortaAjuste(db, { body: { empresaId: 1 }, contexto: { empresaId: 1 } });
  assert.strictEqual(opts.legado, true);
  assert.ok(opts.empresaId == null);
  const produtos = fs.readFileSync(path.join(ROOT, 'backend/rotas/produtos.js'), 'utf8');
  assert.ok(!/empresaId\s*=\s*1/.test(produtos));
  assert.ok(produtos.includes('empresaIdDoReqAjuste(req)'));
  assert.ok(!produtos.includes('empresaIdDoReqOperacional'));
  await closeDb(db);
}

async function test09Rollback() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  await run(db, 'BEGIN');
  await ajustarComoHttp(db, { empresaId: empresaA.id }, { produtoId, ajusteFiscal: 10 });
  const midA = await ee(db, produtoId, empresaA.id);
  const midProd = await get(db, 'SELECT saldo_fiscal FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(midA.saldo_fiscal, 20);
  assert.strictEqual(midProd.saldo_fiscal, 110);
  await run(db, 'ROLLBACK');
  const a = await ee(db, produtoId, empresaA.id);
  const b = await ee(db, produtoId, empresaB.id);
  const prod = await get(db, 'SELECT saldo_fiscal FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(a.saldo_fiscal, 10);
  assert.strictEqual(b.saldo_fiscal, 20);
  assert.strictEqual(prod.saldo_fiscal, 100);
  await closeDb(db);
}

async function test10ClassificacaoFxNF() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  await ajustarComoHttp(db, { empresaId: empresaA.id }, {
    produtoId, ajusteFiscal: 3, ajusteNaoFiscal: 2
  });
  const a = await ee(db, produtoId, empresaA.id);
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(a.saldo_fiscal, 13);
  assert.strictEqual(a.saldo_nao_fiscal, 6);
  assert.strictEqual(b.saldo_fiscal, 20);
  assert.strictEqual(b.saldo_nao_fiscal, 8);
  const prod = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.saldo_fiscal, 103);
  assert.strictEqual(prod.saldo_nao_fiscal, 42);
  await closeDb(db);
}

async function test11SemSqlDireto() {
  const ajuste = fs.readFileSync(
    path.join(ROOT, 'backend/services/ajusteEstoqueService.js'),
    'utf8'
  );
  const recalc = fs.readFileSync(
    path.join(ROOT, 'backend/services/estoqueFiscalService.js'),
    'utf8'
  );
  assert.ok(!/UPDATE\s+produtos/i.test(ajuste));
  assert.ok(!/UPDATE\s+produtos/i.test(recalc));
  assert.ok(ajuste.includes('creditarSaldo'));
  assert.ok(ajuste.includes('debitarSaldo'));
}

async function test12AuditoriaInventarioEImportacao() {
  const glob = require('fs');
  const backend = path.join(ROOT, 'backend');
  function walk(dir, acc = []) {
    for (const ent of glob.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules') continue;
        walk(full, acc);
      } else if (/\.js$/i.test(ent.name)) acc.push(full);
    }
    return acc;
  }
  const arquivos = walk(backend);
  const inventario = arquivos.filter((f) => /inventario/i.test(path.basename(f)));
  assert.strictEqual(inventario.length, 0, 'não deve existir módulo de inventário');

  const importRota = fs.readFileSync(
    path.join(ROOT, 'backend/rotas/importacao-inicial-produtos.js'),
    'utf8'
  );
  assert.ok(importRota.includes('empresaIdDoReqAjuste(req)'));
  assert.ok(importRota.includes('criarMiddlewareContextoEmpresa'));

  const importer = fs.readFileSync(
    path.join(ROOT, 'backend/services/importacao-inicial-produtos/importer.js'),
    'utf8'
  );
  assert.ok(importer.includes('empresaId'));
}

async function test13SaldosIniciaisERecalc() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  await new Promise((resolve, reject) => {
    aplicarSaldosIniciaisViaPorta(db, {
      produtoId,
      saldoFiscal: 110,
      saldoNaoFiscal: 40,
      empresaId: empresaIdDoReqAjuste({ empresaId: empresaA.id })
    }, (err, r) => (err ? reject(err) : resolve(r)));
  });
  const a = await ee(db, produtoId, empresaA.id);
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(a.saldo_fiscal, 20);
  assert.strictEqual(b.saldo_fiscal, 20);

  const rotas = fs.readFileSync(path.join(ROOT, 'backend/rotas/produtos.js'), 'utf8');
  assert.ok(rotas.includes("router.post('/recalcular-saldos'"));
  assert.ok(rotas.includes('empresaIdDoReqAjuste(req)'));
  await closeDb(db);
}

async function main() {
  const testes = [
    ['01 empresaId valido chega ao escritor', test01EmpresaIdChega],
    ['02 body nao substitui req.empresaId', test02BodyNaoSubstitui],
    ['03 query nao substitui req.empresaId', test03QueryNaoSubstitui],
    ['04 operacao altera a empresa correta', test04AlteraEmpresaCorreta],
    ['05 empresa A nao altera empresa B', test05ANaoAlteraB],
    ['06 dual-write 03.19 reutilizado', test06DualWriteReutilizado],
    ['07 sem empresa preserva COMPAT', test07CompatSemEmpresa],
    ['08 nao existe fallback empresa 1', test08SemFallbackEmpresa1],
    ['09 rollback externo restaura ambos', test09Rollback],
    ['10 classificacao F/NF permanece', test10ClassificacaoFxNF],
    ['11 SQL direto de saldo nao permanece', test11SemSqlDireto],
    ['12 auditoria: sem inventario; importacao propaga', test12AuditoriaInventarioEImportacao],
    ['13 saldos iniciais e recálculo na empresa', test13SaldosIniciaisERecalc]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\ninventario-ajuste-multiempresa-contexto: ${ok}/${testes.length} OK`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
