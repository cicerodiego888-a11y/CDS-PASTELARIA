/**
 * Sprint 05.42 — Ownership empresarial de cancelamento e devolução.
 * Executar: node tests/vendas/ownership-cancelamento-devolucao-05-42.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const {
  creditarEstoqueItemVenda,
  montarOpcoesRetornoEstoqueDaVenda
} = require('../../backend/services/vendas/creditoEstoqueVendaViaPorta');
const {
  resolverEmpresaDaVenda,
  exigirOperacaoReversaoDaVenda,
  CODIGO_EMPRESA_OWNERSHIP_REQUIRED
} = require('../../backend/services/vendas/VendaEmpresaContextoService');
const {
  resolverEmpresaDaOrigemFinanceira
} = require('../../backend/services/financeiro/FinanceiroEmpresaContextoService');

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

function creditoAsync(db, dados) {
  return new Promise((resolve, reject) => {
    creditarEstoqueItemVenda(db, dados, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

async function criarDb() {
  const db = await new Promise((resolve, reject) => {
    const c = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(c)));
  });
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  await run(db, `
    CREATE TABLE produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT,
      saldo_fiscal REAL DEFAULT 0,
      saldo_nao_fiscal REAL DEFAULT 0,
      reservado_fiscal REAL DEFAULT 0,
      reservado_nao_fiscal REAL DEFAULT 0,
      estoque_atual REAL DEFAULT 0,
      updated_at DATETIME
    )
  `);
  await run(db, `
    CREATE TABLE vendas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT,
      total REAL DEFAULT 0,
      status TEXT DEFAULT 'concluida',
      empresa_id INTEGER
    )
  `);
  await run(db, `
    CREATE TABLE financeiro (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo TEXT,
      valor REAL,
      venda_id INTEGER,
      origem TEXT,
      empresa_id INTEGER
    )
  `);
  const p = await run(
    db,
    `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual) VALUES ('X', 100, 50, 150)`
  );
  const a = await EmpresaService.criarEmpresa(
    { cnpj: '11222333000181', razao_social: 'Empresa A', nome_fantasia: 'A' },
    { db }
  );
  const b = await EmpresaService.criarEmpresa(
    { cnpj: '04252011000110', razao_social: 'Empresa B', nome_fantasia: 'B' },
    { db }
  );
  await EstoqueEmpresaService.criarRegistro({
    produtoId: p.lastID, empresaId: a.id, saldo_fiscal: 20, saldo_nao_fiscal: 10, estoque_atual: 30
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: p.lastID, empresaId: b.id, saldo_fiscal: 80, saldo_nao_fiscal: 40, estoque_atual: 120
  }, { db });
  return { db, produtoId: p.lastID, a, b };
}

async function ee(db, produtoId, empresaId) {
  return get(
    db,
    'SELECT * FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?',
    [produtoId, empresaId]
  );
}

async function test01CancelamentoMesmaEmpresa() {
  const { db, produtoId, a, b } = await criarDb();
  const vendaIns = await run(
    db,
    `INSERT INTO vendas (codigo, total, status, empresa_id) VALUES ('VA', 10, 'concluida', ?)`,
    [a.id]
  );
  const venda = await get(db, 'SELECT * FROM vendas WHERE id = ?', [vendaIns.lastID]);
  const empresaId = exigirOperacaoReversaoDaVenda(venda, a.id);
  assert.strictEqual(empresaId, Number(a.id));

  const opts = montarOpcoesRetornoEstoqueDaVenda(venda, { empresaId: a.id }, 'cancelamento_venda', db);
  assert.strictEqual(opts.empresaId, Number(a.id));
  assert.strictEqual(opts.exigirEmpresa, true);

  await creditoAsync(db, {
    produtoId,
    quantidadeFiscal: 2,
    quantidadeNaoFiscal: 1,
    empresaId: opts.empresaId,
    exigirEmpresa: true,
    origem: 'cancelamento_venda'
  });

  const estoqueA = await ee(db, produtoId, a.id);
  const estoqueB = await ee(db, produtoId, b.id);
  assert.strictEqual(Number(estoqueA.saldo_fiscal), 22);
  assert.strictEqual(Number(estoqueA.saldo_nao_fiscal), 11);
  assert.strictEqual(Number(estoqueB.saldo_fiscal), 80);
  assert.strictEqual(Number(estoqueB.saldo_nao_fiscal), 40);

  const empresaFin = resolverEmpresaDaOrigemFinanceira({ venda });
  assert.strictEqual(empresaFin, Number(a.id));
  const fin = await run(
    db,
    `INSERT INTO financeiro (tipo, valor, venda_id, origem, empresa_id)
     VALUES ('despesa', 10, ?, 'cancelamento_venda', ?)`,
    [venda.id, empresaFin]
  );
  const row = await get(db, 'SELECT empresa_id FROM financeiro WHERE id = ?', [fin.lastID]);
  assert.strictEqual(Number(row.empresa_id), Number(a.id));
  db.close();
}

async function test02CancelamentoCruzado() {
  const { db, produtoId, a, b } = await criarDb();
  const vendaIns = await run(
    db,
    `INSERT INTO vendas (codigo, total, status, empresa_id) VALUES ('VA', 10, 'concluida', ?)`,
    [a.id]
  );
  const venda = await get(db, 'SELECT * FROM vendas WHERE id = ?', [vendaIns.lastID]);
  const aAntes = await ee(db, produtoId, a.id);
  const bAntes = await ee(db, produtoId, b.id);

  assert.throws(
    () => exigirOperacaoReversaoDaVenda(venda, b.id),
    (e) => e.code === 'VENDA_NAO_ENCONTRADA' && e.statusCode === 404
  );

  const aDepois = await ee(db, produtoId, a.id);
  const bDepois = await ee(db, produtoId, b.id);
  assert.strictEqual(Number(aDepois.saldo_fiscal), Number(aAntes.saldo_fiscal));
  assert.strictEqual(Number(bDepois.saldo_fiscal), Number(bAntes.saldo_fiscal));
  const fins = await get(db, 'SELECT COUNT(*) AS n FROM financeiro');
  assert.strictEqual(Number(fins.n), 0);
  db.close();
}

async function test03DevolucaoMesmaEmpresa() {
  const { db, produtoId, a, b } = await criarDb();
  const vendaIns = await run(
    db,
    `INSERT INTO vendas (codigo, total, status, empresa_id) VALUES ('VA', 10, 'concluida', ?)`,
    [a.id]
  );
  const venda = await get(db, 'SELECT * FROM vendas WHERE id = ?', [vendaIns.lastID]);
  exigirOperacaoReversaoDaVenda(venda, a.id);
  const opts = montarOpcoesRetornoEstoqueDaVenda(venda, { empresaId: a.id }, 'devolucao_venda', db);
  await creditoAsync(db, {
    produtoId,
    quantidadeFiscal: 1,
    empresaId: opts.empresaId,
    exigirEmpresa: true,
    origem: 'devolucao_venda'
  });
  const estoqueA = await ee(db, produtoId, a.id);
  const estoqueB = await ee(db, produtoId, b.id);
  assert.strictEqual(Number(estoqueA.saldo_fiscal), 21);
  assert.strictEqual(Number(estoqueB.saldo_fiscal), 80);
  const empresaFin = resolverEmpresaDaOrigemFinanceira({ venda });
  assert.strictEqual(empresaFin, Number(a.id));
  db.close();
}

async function test04DevolucaoCruzada() {
  const { db, produtoId, a, b } = await criarDb();
  const vendaIns = await run(
    db,
    `INSERT INTO vendas (codigo, total, status, empresa_id) VALUES ('VA', 10, 'concluida', ?)`,
    [a.id]
  );
  const venda = await get(db, 'SELECT * FROM vendas WHERE id = ?', [vendaIns.lastID]);
  const bAntes = await ee(db, produtoId, b.id);
  assert.throws(
    () => exigirOperacaoReversaoDaVenda(venda, b.id),
    (e) => e.code === 'VENDA_NAO_ENCONTRADA'
  );
  const bDepois = await ee(db, produtoId, b.id);
  assert.strictEqual(Number(bDepois.saldo_fiscal), Number(bAntes.saldo_fiscal));
  const finsB = await get(db, 'SELECT COUNT(*) AS n FROM financeiro WHERE empresa_id = ?', [b.id]);
  assert.strictEqual(Number(finsB.n), 0);
  db.close();
}

async function test05VendaLegadaCancelar() {
  const { db, produtoId, a, b } = await criarDb();
  const vendaIns = await run(
    db,
    `INSERT INTO vendas (codigo, total, status, empresa_id) VALUES ('LEGADO', 10, 'concluida', NULL)`
  );
  const venda = await get(db, 'SELECT * FROM vendas WHERE id = ?', [vendaIns.lastID]);
  const aAntes = await ee(db, produtoId, a.id);
  const bAntes = await ee(db, produtoId, b.id);
  assert.throws(
    () => resolverEmpresaDaVenda(venda),
    (e) => e.code === CODIGO_EMPRESA_OWNERSHIP_REQUIRED
  );
  assert.throws(
    () => exigirOperacaoReversaoDaVenda(venda, a.id),
    (e) => e.code === CODIGO_EMPRESA_OWNERSHIP_REQUIRED
  );
  const aDepois = await ee(db, produtoId, a.id);
  const fins = await get(db, 'SELECT COUNT(*) AS n FROM financeiro');
  assert.strictEqual(Number(aDepois.saldo_fiscal), Number(aAntes.saldo_fiscal));
  assert.strictEqual(Number((await ee(db, produtoId, b.id)).saldo_fiscal), Number(bAntes.saldo_fiscal));
  assert.strictEqual(Number(fins.n), 0);
  db.close();
}

async function test06VendaLegadaDevolver() {
  const { db, produtoId, a } = await criarDb();
  const vendaIns = await run(
    db,
    `INSERT INTO vendas (codigo, total, status) VALUES ('LEGADO', 10, 'concluida')`
  );
  const venda = await get(db, 'SELECT * FROM vendas WHERE id = ?', [vendaIns.lastID]);
  const aAntes = await ee(db, produtoId, a.id);
  assert.throws(
    () => exigirOperacaoReversaoDaVenda(venda, a.id),
    (e) => e.code === CODIGO_EMPRESA_OWNERSHIP_REQUIRED
  );
  assert.throws(
    () => resolverEmpresaDaOrigemFinanceira({ venda }),
    (e) => e.code === 'EMPRESA_OWNERSHIP_REQUIRED'
  );
  const aDepois = await ee(db, produtoId, a.id);
  assert.strictEqual(Number(aDepois.saldo_fiscal), Number(aAntes.saldo_fiscal));
  const fins = await get(db, 'SELECT COUNT(*) AS n FROM financeiro');
  assert.strictEqual(Number(fins.n), 0);
  db.close();
}

async function test07VendaEhFonteDeVerdade() {
  const { db, produtoId, a, b } = await criarDb();
  const vendaIns = await run(
    db,
    `INSERT INTO vendas (codigo, total, status, empresa_id) VALUES ('VA', 10, 'concluida', ?)`,
    [a.id]
  );
  const venda = await get(db, 'SELECT * FROM vendas WHERE id = ?', [vendaIns.lastID]);
  const reqEspurio = {
    empresaId: b.id,
    caixaSessao: { empresa_id: b.id },
    body: { empresa_id: b.id }
  };
  const opts = montarOpcoesRetornoEstoqueDaVenda(venda, reqEspurio, 'cancelamento_venda', db);
  assert.strictEqual(opts.empresaId, Number(a.id));
  await creditoAsync(db, {
    produtoId,
    quantidadeFiscal: 3,
    empresaId: opts.empresaId,
    exigirEmpresa: true
  });
  const estoqueA = await ee(db, produtoId, a.id);
  const estoqueB = await ee(db, produtoId, b.id);
  assert.strictEqual(Number(estoqueA.saldo_fiscal), 23);
  assert.strictEqual(Number(estoqueB.saldo_fiscal), 80);
  assert.strictEqual(resolverEmpresaDaOrigemFinanceira({ venda }), Number(a.id));
  db.close();
}

function test08WritersNaoUsamReqComoOwnership() {
  const cancel = src('backend/services/vendas/VendaCancelamentoService.js');
  const devolucao = src('backend/services/vendas/VendaDevolucaoService.js');
  const financeiro = src('backend/services/vendas/VendaFinanceiroService.js');
  const rotas = src('backend/rotas/vendas.js');

  assert.ok(cancel.includes('exigirOperacaoReversaoDaVenda'));
  assert.ok(cancel.includes('montarOpcoesRetornoEstoqueDaVenda'));
  assert.ok(!cancel.includes('montarOpcoesRetornoEstoqueVenda(req'));
  assert.ok(/INSERT INTO financeiro[\s\S]{0,500}empresa_id/i.test(cancel));
  assert.ok(cancel.includes('resolverEmpresaDaOrigemFinanceira({ venda })'));

  assert.ok(devolucao.includes('exigirOperacaoReversaoDaVenda'));
  assert.ok(devolucao.includes('montarOpcoesRetornoEstoqueDaVenda'));
  assert.ok(!devolucao.includes('montarOpcoesRetornoEstoqueVenda(req'));

  assert.ok(financeiro.includes('resolverEmpresaDaOrigemFinanceira({ venda })'));
  assert.ok(!financeiro.includes('opcoes.empresaId || opcoes.empresa_id || null'));

  assert.ok(rotas.includes("router.put('/:id/cancelar', anexarEmpresaVenda"));
  assert.ok(rotas.includes("router.post('/cancelar/:id', anexarEmpresaVenda"));
  assert.ok(rotas.includes("router.post('/:id/devolver', anexarEmpresaVenda"));
}

function test09NaoInventaFallback() {
  const ctx = src('backend/services/vendas/VendaEmpresaContextoService.js');
  assert.ok(ctx.includes('function resolverEmpresaDaVenda'));
  assert.ok(ctx.includes('CODIGO_EMPRESA_OWNERSHIP_REQUIRED'));
  assert.ok(!ctx.includes('empresa_id = 1'));
  const credito = src('backend/services/vendas/creditoEstoqueVendaViaPorta.js');
  assert.ok(credito.includes('function montarOpcoesRetornoEstoqueDaVenda'));
}

const TESTS = [
  ['01 cancelamento mesma empresa', test01CancelamentoMesmaEmpresa],
  ['02 cancelamento cruzado', test02CancelamentoCruzado],
  ['03 devolução mesma empresa', test03DevolucaoMesmaEmpresa],
  ['04 devolução cruzada', test04DevolucaoCruzada],
  ['05 venda legada cancelar', test05VendaLegadaCancelar],
  ['06 venda legada devolver', test06VendaLegadaDevolver],
  ['07 venda é fonte de verdade', test07VendaEhFonteDeVerdade],
  ['08 writers não usam req como ownership', test08WritersNaoUsamReqComoOwnership],
  ['09 sem fallback inventado', test09NaoInventaFallback]
];

(async () => {
  let ok = 0;
  let fail = 0;
  for (const [nome, fn] of TESTS) {
    try {
      await fn();
      ok += 1;
      console.log(`  OK  ${nome}`);
    } catch (err) {
      fail += 1;
      console.error(`  FAIL ${nome}:`, err.message);
      if (err.stack) console.error(err.stack.split('\n').slice(0, 8).join('\n'));
    }
  }
  console.log(`\nResultado: ${ok}/${TESTS.length} OK, ${fail} falha(s).`);
  if (fail > 0) process.exit(1);
})();
