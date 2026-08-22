/**
 * Fase 2 / Implementação 03.8 — CREATE produto / saldos iniciais via porta pública.
 *
 * Mutador: POST / em rotas/produtos.js
 * Helper: aplicarSaldoInicialCreateProduto → estoqueSaldosPublico
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const {
  aplicarSaldoInicialCreateProduto,
  definirSaldosIniciaisProduto,
  montarOptsPortaAjuste,
  MOTIVO_COMPAT_CREATE_PRODUTO_SALDO_INICIAL
} = require('../../backend/services/ajusteEstoqueService');

const ROOT = path.resolve(__dirname, '../..');
const SRC_PRODUTOS = path.join(ROOT, 'backend/rotas/produtos.js');
const SRC_AJUSTE = path.join(ROOT, 'backend/services/ajusteEstoqueService.js');
const SRC_COMPRAS = path.join(ROOT, 'backend/rotas/compras.js');
const SRC_IMPORT = path.join(ROOT, 'backend/services/importacao-inicial-produtos/importer.js');
const SRC_REPAIR = path.join(ROOT, 'backend/motores/comercial/ReservaRepairService.js');
const SRC_PONTE = path.join(ROOT, 'backend/services/estoque/pedidoReservaPonteNucleo.js');
const SRC_PDV = path.join(ROOT, 'backend/services/estoque/EstoqueReservaService.js');
const SRC_BAIXA = path.join(ROOT, 'backend/services/vendas/debitoEstoqueVendaViaPorta.js');
const SRC_MTS = path.join(ROOT, 'backend/motores/mts/MtsService.js');
const SRC_MUC = path.join(ROOT, 'backend/motores/muc/index.js');
const SRC_COMERCIAL = path.join(ROOT, 'backend/motores/comercial/MotorComercialService.js');
const SRC_PORTA = path.join(ROOT, 'backend/services/fiscalNaoFiscal/estoqueSaldosPublico.js');

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

function aplicarAsync(db, opcoes) {
  return new Promise((resolve, reject) => {
    aplicarSaldoInicialCreateProduto(db, opcoes, (err, result) => (
      err ? reject(err) : resolve(result)
    ));
  });
}

async function assertRejects(promise, codeOrMsg) {
  try {
    await promise;
    throw new Error(`Esperava falha (${codeOrMsg})`);
  } catch (err) {
    if (err.message && err.message.startsWith('Esperava falha')) throw err;
    if (typeof codeOrMsg === 'string' && codeOrMsg.startsWith('EMPRESA')) {
      assert.strictEqual(err.code, codeOrMsg);
    } else {
      assert.ok(
        err.code === codeOrMsg || String(err.message).includes(codeOrMsg),
        `esperado ${codeOrMsg}, veio ${err.code}/${err.message}`
      );
    }
  }
}

function extrairPostCreate(src) {
  const inicio = src.indexOf("router.post('/', (req, res) => {");
  const fim = src.indexOf("router.get('/vencimentos/estatisticas'");
  assert.ok(inicio >= 0 && fim > inicio, 'POST create produto não encontrado');
  return src.slice(inicio, fim);
}

async function setup() {
  const db = await openDb();
  await run(db, `
    CREATE TABLE produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT,
      saldo_fiscal REAL DEFAULT 0,
      saldo_nao_fiscal REAL DEFAULT 0,
      reservado_fiscal REAL DEFAULT 0,
      reservado_nao_fiscal REAL DEFAULT 0,
      estoque_atual REAL DEFAULT 0,
      controla_estoque INTEGER DEFAULT 1,
      updated_at DATETIME
    )
  `);
  await run(db, `CREATE TABLE empresas (id INTEGER PRIMARY KEY, razao TEXT)`);
  await run(db, `INSERT INTO empresas (id, razao) VALUES (1, 'A')`);
  return { db, empresaId: 1 };
}

async function criarProdutoZerado(db, nome = 'Novo') {
  const r = await run(
    db,
    `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual)
     VALUES (?, 0, 0, 0)`,
    [nome]
  );
  return r.lastID;
}

async function test01SemSaldoInicial() {
  const { db } = await setup();
  const produtoId = await criarProdutoZerado(db);
  const r = await aplicarAsync(db, { produtoId, saldoFiscal: 0, saldoNaoFiscal: 0 });
  assert.strictEqual(r.aplicado, false);
  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.saldo_fiscal, 0);
  assert.strictEqual(row.saldo_nao_fiscal, 0);
  assert.strictEqual(row.estoque_atual, 0);
  await closeDb(db);
}

async function test02SaldoFiscalInicial() {
  const { db, empresaId } = await setup();
  const produtoId = await criarProdutoZerado(db);
  const r = await aplicarAsync(db, {
    produtoId,
    saldoFiscal: 12,
    saldoNaoFiscal: 0,
    empresaId
  });
  assert.strictEqual(r.aplicado, true);
  assert.strictEqual(r.saldo_fiscal, 12);
  assert.strictEqual(r.saldo_nao_fiscal, 0);
  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.saldo_fiscal, 12);
  assert.strictEqual(row.saldo_nao_fiscal, 0);
  await closeDb(db);
}

async function test03SaldoNaoFiscalInicial() {
  const { db, empresaId } = await setup();
  const produtoId = await criarProdutoZerado(db);
  const r = await aplicarAsync(db, {
    produtoId,
    saldoFiscal: 0,
    saldoNaoFiscal: 7,
    empresaId
  });
  assert.strictEqual(r.aplicado, true);
  assert.strictEqual(r.saldo_fiscal, 0);
  assert.strictEqual(r.saldo_nao_fiscal, 7);
  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.saldo_nao_fiscal, 7);
  assert.strictEqual(row.saldo_fiscal, 0);
  await closeDb(db);
}

async function test04EstoqueAtualSfSnf() {
  const { db, empresaId } = await setup();
  const produtoId = await criarProdutoZerado(db);
  await aplicarAsync(db, {
    produtoId,
    saldoFiscal: 10,
    saldoNaoFiscal: 4,
    empresaId
  });
  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.saldo_fiscal, 10);
  assert.strictEqual(row.saldo_nao_fiscal, 4);
  assert.strictEqual(row.estoque_atual, 14);
  const calc = definirSaldosIniciaisProduto(10, 4);
  assert.strictEqual(calc.estoque_atual, 14);
  await closeDb(db);
}

async function test05EmpresaIdPropagado() {
  const { db, empresaId } = await setup();
  const produtoId = await criarProdutoZerado(db);
  const r = await aplicarAsync(db, {
    produtoId,
    saldoFiscal: 3,
    saldoNaoFiscal: 0,
    empresaId
  });
  assert.strictEqual(r.empresa_id, empresaId);
  assert.strictEqual(r.legado, false);

  const viaOpcoes = montarOptsPortaAjuste(db, { empresaId: 1 });
  assert.strictEqual(viaOpcoes.empresaId, 1);
  assert.strictEqual(viaOpcoes.legado, false);

  const viaReq = montarOptsPortaAjuste(db, {
    empresaId: 1,
    contexto: { headers: { 'x-empresa-id': '99' } },
    ctx: { empresaId: 99 }
  });
  assert.strictEqual(viaReq.empresaId, 1);

  const semAnexo = montarOptsPortaAjuste(db, {
    contexto: { headers: { 'x-empresa-id': '1' } },
    body: { empresaId: 1 }
  });
  assert.strictEqual(semAnexo.legado, true);
  assert.ok(semAnexo.empresaId == null);
  await closeDb(db);
}

async function test06CompatExplicita() {
  const { db } = await setup();
  const produtoId = await criarProdutoZerado(db);
  const r = await aplicarAsync(db, {
    produtoId,
    saldoFiscal: 2,
    saldoNaoFiscal: 1
  });
  assert.strictEqual(r.aplicado, true);
  assert.strictEqual(r.legado, true);
  assert.strictEqual(r.motivo_compat, MOTIVO_COMPAT_CREATE_PRODUTO_SALDO_INICIAL);
  assert.strictEqual(r.empresa_id, null);

  await assertRejects(
    aplicarAsync(db, {
      produtoId: await criarProdutoZerado(db, 'Exigir'),
      saldoFiscal: 1,
      saldoNaoFiscal: 0,
      exigirEmpresa: true
    }),
    'EMPRESA_OBRIGATORIA'
  );

  const srcAjuste = fs.readFileSync(SRC_AJUSTE, 'utf8');
  const srcPost = extrairPostCreate(fs.readFileSync(SRC_PRODUTOS, 'utf8'));
  assert.ok(srcAjuste.includes('COMPAT_CREATE_PRODUTO_SALDO_INICIAL_PRE_MULTIEMPRESA'));
  assert.ok(srcPost.includes('aplicarSaldoInicialCreateProduto'));
  assert.ok(!/empresaId\s*=\s*1/.test(srcPost));
  assert.ok(!/configuracoes\.cnpj/.test(srcPost));
  await closeDb(db);
}

async function test07RollbackMesmoDb() {
  const { db, empresaId } = await setup();
  await run(db, 'BEGIN');
  const produtoId = await criarProdutoZerado(db, 'Tx');
  await aplicarAsync(db, {
    produtoId,
    saldoFiscal: 9,
    saldoNaoFiscal: 3,
    empresaId
  });
  const mid = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(mid.saldo_fiscal, 9);
  assert.strictEqual(mid.estoque_atual, 12);
  await run(db, 'ROLLBACK');

  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row, null);
  await closeDb(db);
}

async function test08SemEscritaOperacionalDireta() {
  const post = extrairPostCreate(fs.readFileSync(SRC_PRODUTOS, 'utf8'));
  assert.ok(post.includes('aplicarSaldoInicialCreateProduto'));
  assert.ok(post.includes('0, estoque_minimo || 0, fornecedor'));
  assert.ok(!/estoqueInicial, estoque_minimo/.test(post));
  assert.ok(!/saldoFiscalInicial,\s*\n\s*saldoNaoFiscalInicial/.test(post));
  assert.ok(!/UPDATE\s+produtos[\s\S]{0,80}saldo_fiscal/i.test(post));
  assert.ok(!post.includes('creditarSaldo'));
  assert.ok(post.includes('estoqueSaldosPublico') === false);
}

async function test09FluxoLegadoCompativel() {
  const post = extrairPostCreate(fs.readFileSync(SRC_PRODUTOS, 'utf8'));
  assert.ok(post.includes('const estoqueLegado = Number(estoque_atual || 0);'));
  assert.ok(post.includes('saldoFiscalInicial = estoqueLegado;'));
  assert.ok(post.includes('saldoNaoFiscalInicial = 0;'));
  assert.ok(post.includes('definirSaldosIniciaisProduto'));

  const { db, empresaId } = await setup();
  const produtoId = await criarProdutoZerado(db);
  const legado = definirSaldosIniciaisProduto(Number(8 || 0), 0);
  assert.strictEqual(legado.saldo_fiscal, 8);
  assert.strictEqual(legado.saldo_nao_fiscal, 0);
  await aplicarAsync(db, {
    produtoId,
    saldoFiscal: legado.saldo_fiscal,
    saldoNaoFiscal: legado.saldo_nao_fiscal,
    empresaId
  });
  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.saldo_fiscal, 8);
  assert.strictEqual(row.saldo_nao_fiscal, 0);
  assert.strictEqual(row.estoque_atual, 8);
  await closeDb(db);
}

async function test10MotoresEFluxosAnterioresIntacto() {
  const mts = fs.readFileSync(SRC_MTS, 'utf8');
  const muc = fs.readFileSync(SRC_MUC, 'utf8');
  const comercial = fs.readFileSync(SRC_COMERCIAL, 'utf8');
  const repair = fs.readFileSync(SRC_REPAIR, 'utf8');
  const ponte = fs.readFileSync(SRC_PONTE, 'utf8');
  const pdv = fs.readFileSync(SRC_PDV, 'utf8');
  const baixa = fs.readFileSync(SRC_BAIXA, 'utf8');
  const compras = fs.readFileSync(SRC_COMPRAS, 'utf8');
  const importer = fs.readFileSync(SRC_IMPORT, 'utf8');
  const porta = fs.readFileSync(SRC_PORTA, 'utf8');

  assert.ok(!mts.includes('COMPAT_CREATE_PRODUTO_SALDO_INICIAL_PRE_MULTIEMPRESA'));
  assert.ok(!muc.includes('COMPAT_CREATE_PRODUTO_SALDO_INICIAL_PRE_MULTIEMPRESA'));
  assert.ok(!comercial.includes('aplicarSaldoInicialCreateProduto'));
  assert.ok(!repair.includes('aplicarSaldoInicialCreateProduto'));
  assert.ok(ponte.includes('liberarQuantidadeReservada'));
  assert.ok(pdv.includes('venda_estoque_reservas') || pdv.includes('reservarQuantidade'));
  assert.ok(baixa.includes('debitarSaldo'));
  assert.ok(porta.includes('creditarSaldo'));
  assert.ok(compras.includes('estoque_atual, estoque_minimo, fornecedor, ncm,'));
  assert.ok(/VALUES \(\?, \?, \?, \?, \?, \?, \?, 0, 0, \?, \?, 0, 0, \?/.test(compras));
  assert.ok(importer.includes('estoque_atual, estoque_minimo, fornecedor,'));
  assert.ok(!fs.existsSync(path.join(ROOT, 'backend/database/estoque_empresa')));
  assert.ok(!fs.existsSync(path.join(ROOT, 'backend/services/produto_empresa.js')));
}

async function main() {
  const testes = [
    ['01 produto criado sem saldo inicial', test01SemSaldoInicial],
    ['02 saldo fiscal inicial', test02SaldoFiscalInicial],
    ['03 saldo nao fiscal inicial', test03SaldoNaoFiscalInicial],
    ['04 estoque_atual = SF + SNF', test04EstoqueAtualSfSnf],
    ['05 empresaId propagado', test05EmpresaIdPropagado],
    ['06 COMPAT explicita', test06CompatExplicita],
    ['07 rollback com mesmo db', test07RollbackMesmoDb],
    ['08 sem escrita operacional direta de saldo', test08SemEscritaOperacionalDireta],
    ['09 fluxo legado de criacao compativel', test09FluxoLegadoCompativel],
    ['10 motores e fluxos anteriores intactos', test10MotoresEFluxosAnterioresIntacto]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\ncreate-produto-saldo-inicial-porta-publica: ${ok}/${testes.length} OK`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
