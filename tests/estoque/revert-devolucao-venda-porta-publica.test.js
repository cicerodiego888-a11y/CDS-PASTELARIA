/**
 * Fase 2 / Implementação 03.5 — Revert de estoque da NF-e de devolução de venda
 * via porta pública.
 *
 * O mutador `reverterEstoqueNfeDevolucaoVenda` desfaz o crédito da autorização
 * (02.5). A porta usada é `estoqueSaldosPublico.debitarSaldo`.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const {
  reverterEstoqueNfeDevolucaoVenda,
  montarOptsPortaRevertDevolucaoVenda,
  resolverQuantidadesItemDevolucaoNfe,
  MOTIVO_COMPAT_REVERT_DEVOLUCAO_VENDA
} = require('../../backend/services/fiscal/estoqueNfeDevolucaoVenda');

const estoqueSaldosPublico = require('../../backend/services/fiscalNaoFiscal/estoqueSaldosPublico');
const { TipoSaldo } = require('../../backend/services/fiscalNaoFiscal/constants');

const ROOT = path.resolve(__dirname, '../..');
const SRC_REVERT = path.join(ROOT, 'backend/services/fiscal/estoqueNfeDevolucaoVenda.js');
const SRC_CALLER = path.join(ROOT, 'backend/services/fiscal/controleSaldoDevolucaoVenda.js');
const SRC_PORTA = path.join(ROOT, 'backend/services/fiscalNaoFiscal/estoqueSaldosPublico.js');
const SRC_MTS = path.join(ROOT, 'backend/motores/mts/MtsService.js');
const SRC_MUC = path.join(ROOT, 'backend/motores/muc/index.js');
const SRC_COMERCIAL = path.join(ROOT, 'backend/motores/comercial/MotorComercialService.js');
const SRC_DISTRIBUIDOR = path.join(ROOT, 'backend/services/distribuidorEstoqueVenda.js');
const SRC_FXNF_CONST = path.join(ROOT, 'backend/services/fiscalNaoFiscal/constants.js');

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

async function setup(sf = 100, snf = 50) {
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
      updated_at DATETIME
    )
  `);
  await run(db, `CREATE TABLE empresas (id INTEGER PRIMARY KEY, razao TEXT)`);
  await run(db, `INSERT INTO empresas (id, razao) VALUES (1, 'A')`);
  await run(db, `
    CREATE TABLE vendas_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venda_id INTEGER,
      produto_id INTEGER,
      quantidade REAL,
      quantidade_fiscal REAL,
      quantidade_nao_fiscal REAL
    )
  `);
  await run(db, `
    CREATE TABLE nfe_devolucoes_venda (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venda_id INTEGER,
      status TEXT,
      estoque_retornado INTEGER DEFAULT 0
    )
  `);
  await run(db, `
    CREATE TABLE nfe_devolucao_venda_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nfe_devolucao_id INTEGER,
      venda_id INTEGER,
      venda_item_id INTEGER,
      produto_id INTEGER,
      quantidade REAL,
      quantidade_vendida REAL,
      estoque_retornado INTEGER DEFAULT 0
    )
  `);

  const p = await run(
    db,
    `INSERT INTO produtos
       (nome, saldo_fiscal, saldo_nao_fiscal, reservado_fiscal, reservado_nao_fiscal, estoque_atual)
     VALUES ('Global', ?, ?, 3, 2, ?)`,
    [sf, snf, sf + snf]
  );

  return { db, produtoId: p.lastID, empresaId: 1 };
}

async function seedNota(db, {
  produtoId,
  qtdNfe,
  qtdVendida,
  qtdFiscal,
  qtdNaoFiscal,
  estoqueRetornado = 1
}) {
  const vendaItem = await run(
    db,
    `INSERT INTO vendas_itens
       (venda_id, produto_id, quantidade, quantidade_fiscal, quantidade_nao_fiscal)
     VALUES (1, ?, ?, ?, ?)`,
    [produtoId, qtdVendida, qtdFiscal, qtdNaoFiscal]
  );
  const nota = await run(
    db,
    `INSERT INTO nfe_devolucoes_venda (venda_id, status, estoque_retornado)
     VALUES (1, 'autorizada', ?)`,
    [estoqueRetornado]
  );
  await run(
    db,
    `INSERT INTO nfe_devolucao_venda_itens
       (nfe_devolucao_id, venda_id, venda_item_id, produto_id, quantidade,
        quantidade_vendida, estoque_retornado)
     VALUES (?, 1, ?, ?, ?, ?, ?)`,
    [nota.lastID, vendaItem.lastID, produtoId, qtdNfe, qtdVendida, estoqueRetornado]
  );
  return { notaId: nota.lastID, vendaItemId: vendaItem.lastID };
}

function extrairFuncaoRevert(src) {
  const inicio = src.indexOf('async function reverterEstoqueNfeDevolucaoVenda');
  const fim = src.indexOf('module.exports');
  assert.ok(inicio >= 0 && fim > inicio, 'função reverterEstoqueNfeDevolucaoVenda não encontrada');
  return src.slice(inicio, fim);
}

async function test01DevolucaoFiscalCreditaERevertDebitaFiscal() {
  const { db, produtoId, empresaId } = await setup(70, 40);
  await estoqueSaldosPublico.creditarSaldo(produtoId, TipoSaldo.FISCAL, 10, {
    db, empresaId
  });
  const aposCredito = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(aposCredito.saldo_fiscal, 80);
  assert.strictEqual(aposCredito.saldo_nao_fiscal, 40);

  await seedNota(db, {
    produtoId,
    qtdNfe: 10,
    qtdVendida: 10,
    qtdFiscal: 10,
    qtdNaoFiscal: 0
  });

  const r = await reverterEstoqueNfeDevolucaoVenda(1, { db, empresaId });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.saldos[0].saldo_fiscal, 70);
  assert.strictEqual(r.saldos[0].saldo_nao_fiscal, 40);
  assert.strictEqual(r.saldos[0].quantidade_fiscal, 10);
  assert.strictEqual(r.saldos[0].quantidade_nao_fiscal, 0);

  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.saldo_fiscal, 70);
  assert.strictEqual(row.saldo_nao_fiscal, 40);
  await closeDb(db);
}

async function test02DevolucaoNaoFiscalCreditaERevertDebitaNF() {
  const { db, produtoId, empresaId } = await setup(70, 40);
  await estoqueSaldosPublico.creditarSaldo(produtoId, TipoSaldo.NAO_FISCAL, 8, {
    db, empresaId
  });
  const aposCredito = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(aposCredito.saldo_fiscal, 70);
  assert.strictEqual(aposCredito.saldo_nao_fiscal, 48);

  await seedNota(db, {
    produtoId,
    qtdNfe: 8,
    qtdVendida: 8,
    qtdFiscal: 0,
    qtdNaoFiscal: 8
  });

  const r = await reverterEstoqueNfeDevolucaoVenda(1, { db, empresaId });
  assert.strictEqual(r.saldos[0].saldo_fiscal, 70);
  assert.strictEqual(r.saldos[0].saldo_nao_fiscal, 40);
  assert.strictEqual(r.saldos[0].quantidade_fiscal, 0);
  assert.strictEqual(r.saldos[0].quantidade_nao_fiscal, 8);
  await closeDb(db);
}

async function test03DevolucaoMistaMantemSeparacao() {
  const { db, produtoId, empresaId } = await setup(70, 40);
  await estoqueSaldosPublico.creditarSaldo(produtoId, TipoSaldo.FISCAL, 6, { db, empresaId });
  await estoqueSaldosPublico.creditarSaldo(produtoId, TipoSaldo.NAO_FISCAL, 4, { db, empresaId });

  await seedNota(db, {
    produtoId,
    qtdNfe: 10,
    qtdVendida: 10,
    qtdFiscal: 6,
    qtdNaoFiscal: 4
  });

  const r = await reverterEstoqueNfeDevolucaoVenda(1, { db, empresaId });
  assert.strictEqual(r.saldos[0].quantidade_fiscal, 6);
  assert.strictEqual(r.saldos[0].quantidade_nao_fiscal, 4);
  assert.strictEqual(r.saldos[0].saldo_fiscal, 70);
  assert.strictEqual(r.saldos[0].saldo_nao_fiscal, 40);

  const qtds = resolverQuantidadesItemDevolucaoNfe({
    produto_id: produtoId,
    quantidade: 10,
    quantidade_vendida: 10,
    quantidade_fiscal: 6,
    quantidade_nao_fiscal: 4
  });
  assert.strictEqual(qtds.qtdFiscal, 6);
  assert.strictEqual(qtds.qtdNaoFiscal, 4);
  await closeDb(db);
}

async function test04EstoqueAtualSfSnf() {
  const { db, produtoId, empresaId } = await setup(100, 50);
  await seedNota(db, {
    produtoId,
    qtdNfe: 12,
    qtdVendida: 20,
    qtdFiscal: 15,
    qtdNaoFiscal: 5
  });

  const r = await reverterEstoqueNfeDevolucaoVenda(1, { db, empresaId });
  assert.strictEqual(r.saldos[0].estoque_atual, r.saldos[0].saldo_fiscal + r.saldos[0].saldo_nao_fiscal);
  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.estoque_atual, row.saldo_fiscal + row.saldo_nao_fiscal);
  assert.strictEqual(row.reservado_fiscal, 3);
  assert.strictEqual(row.reservado_nao_fiscal, 2);
  await closeDb(db);
}

async function test05SemCreditoNemDebitoDuplicado() {
  const { db, produtoId, empresaId } = await setup(100, 50);
  await seedNota(db, {
    produtoId,
    qtdNfe: 10,
    qtdVendida: 10,
    qtdFiscal: 10,
    qtdNaoFiscal: 0
  });

  await reverterEstoqueNfeDevolucaoVenda(1, { db, empresaId });
  const depois1 = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(depois1.saldo_fiscal, 90);

  const r2 = await reverterEstoqueNfeDevolucaoVenda(1, { db, empresaId });
  assert.strictEqual(r2.itens, 0);
  const depois2 = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(depois2.saldo_fiscal, 90);
  assert.strictEqual(depois2.saldo_nao_fiscal, 50);

  const src = fs.readFileSync(SRC_REVERT, 'utf8');
  const fn = extrairFuncaoRevert(src);
  const debitos = (fn.match(/debitarSaldo\s*\(/g) || []).length;
  assert.ok(debitos >= 2, 'revert debita F e/ou NF pela porta');
  assert.ok(!/creditarSaldo\s*\(/.test(fn), 'revert não credita (evita crédito duplicado da autorização)');
  await closeDb(db);
}

async function test06EmpresaIdPropagado() {
  const { db, produtoId, empresaId } = await setup();
  await seedNota(db, {
    produtoId,
    qtdNfe: 1,
    qtdVendida: 1,
    qtdFiscal: 1,
    qtdNaoFiscal: 0
  });

  const r = await reverterEstoqueNfeDevolucaoVenda(1, { db, empresaId });
  assert.strictEqual(r.empresa_id, empresaId);
  assert.strictEqual(r.legado, false);
  assert.strictEqual(r.saldos[0].empresa_id, empresaId);

  const viaOpcoes = montarOptsPortaRevertDevolucaoVenda(db, { empresaId: 1 });
  assert.strictEqual(viaOpcoes.empresaId, 1);
  assert.strictEqual(viaOpcoes.legado, false);

  const viaContexto = montarOptsPortaRevertDevolucaoVenda(db, { contexto: { empresa_id: 1 } });
  assert.strictEqual(viaContexto.empresaId, 1);
  await closeDb(db);
}

async function test07CompatExplicita() {
  const { db, produtoId } = await setup();
  await seedNota(db, {
    produtoId,
    qtdNfe: 2,
    qtdVendida: 2,
    qtdFiscal: 2,
    qtdNaoFiscal: 0
  });

  const r = await reverterEstoqueNfeDevolucaoVenda(1, { db });
  assert.strictEqual(r.legado, true);
  assert.strictEqual(r.motivo_compat, MOTIVO_COMPAT_REVERT_DEVOLUCAO_VENDA);
  assert.strictEqual(r.empresa_id, null);

  await assertRejects(
    reverterEstoqueNfeDevolucaoVenda(1, { db, exigirEmpresa: true }),
    'EMPRESA_OBRIGATORIA'
  );

  const semEmpresa = montarOptsPortaRevertDevolucaoVenda(db, {});
  assert.strictEqual(semEmpresa.empresaId, undefined);
  assert.strictEqual(semEmpresa.legado, true);
  assert.strictEqual(semEmpresa.motivoCompat, MOTIVO_COMPAT_REVERT_DEVOLUCAO_VENDA);

  const src = fs.readFileSync(SRC_REVERT, 'utf8');
  assert.ok(src.includes('COMPAT_REVERT_DEVOLUCAO_VENDA_PRE_MULTIEMPRESA'));
  assert.ok(!/empresaId\s*=\s*1/.test(src));
  assert.ok(!/configuracoes\.cnpj/.test(src));
  await closeDb(db);
}

async function test08RollbackDesfazDebito() {
  const { db, produtoId, empresaId } = await setup(100, 50);
  await seedNota(db, {
    produtoId,
    qtdNfe: 35,
    qtdVendida: 35,
    qtdFiscal: 25,
    qtdNaoFiscal: 10
  });

  await run(db, 'BEGIN');
  await reverterEstoqueNfeDevolucaoVenda(1, { db, empresaId });
  const mid = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(mid.saldo_fiscal, 75);
  assert.strictEqual(mid.saldo_nao_fiscal, 40);
  await run(db, 'ROLLBACK');

  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.saldo_fiscal, 100);
  assert.strictEqual(row.saldo_nao_fiscal, 50);
  assert.strictEqual(row.estoque_atual, 150);
  await closeDb(db);
}

async function test09SqlDiretoRemovido() {
  const src = fs.readFileSync(SRC_REVERT, 'utf8');
  const caller = fs.readFileSync(SRC_CALLER, 'utf8');
  const fn = extrairFuncaoRevert(src);

  assert.ok(src.includes('estoqueSaldosPublico'));
  assert.ok(fn.includes('debitarSaldo'));
  assert.ok(!/UPDATE\s+produtos/i.test(fn), 'revert não deve UPDATE produtos');
  assert.ok(!/SET\s+saldo_fiscal/i.test(fn));
  assert.ok(!/SET\s+saldo_nao_fiscal/i.test(fn));
  assert.ok(!/SET\s+estoque_atual/i.test(fn));
  assert.ok(
    /UPDATE\s+nfe_devolucao_venda_itens\s+SET\s+estoque_retornado/i.test(fn),
    'flag estoque_retornado do item permanece'
  );

  assert.ok(caller.includes('reverterEstoqueNfeDevolucaoVenda'));
  assert.ok(caller.includes('empresaId'));
  assert.ok(!/UPDATE\s+produtos[\s\S]{0,400}saldo_fiscal/i.test(caller));
}

async function test10MotoresIntacto() {
  const mts = fs.readFileSync(SRC_MTS, 'utf8');
  const muc = fs.readFileSync(SRC_MUC, 'utf8');
  const comercial = fs.readFileSync(SRC_COMERCIAL, 'utf8');
  const distribuidor = fs.readFileSync(SRC_DISTRIBUIDOR, 'utf8');
  const porta = fs.readFileSync(SRC_PORTA, 'utf8');
  const constants = fs.readFileSync(SRC_FXNF_CONST, 'utf8');

  assert.ok(!mts.includes('COMPAT_REVERT_DEVOLUCAO_VENDA_PRE_MULTIEMPRESA'));
  assert.ok(!muc.includes('COMPAT_REVERT_DEVOLUCAO_VENDA_PRE_MULTIEMPRESA'));
  assert.ok(!comercial.includes('COMPAT_REVERT_DEVOLUCAO_VENDA_PRE_MULTIEMPRESA'));
  assert.ok(!distribuidor.includes('reverterEstoqueNfeDevolucaoVenda'));
  assert.ok(!porta.includes('COMPAT_REVERT_DEVOLUCAO_VENDA_PRE_MULTIEMPRESA'));
  assert.ok(constants.includes("FISCAL: 'FISCAL'"));
  assert.ok(constants.includes("NAO_FISCAL: 'NAO_FISCAL'"));

  assert.ok(!fs.existsSync(path.join(ROOT, 'backend/services/estoqueDevolucaoPublico2.js')));
  assert.ok(!fs.existsSync(path.join(ROOT, 'backend/services/portaNfeDevolucao.js')));
  assert.ok(!fs.existsSync(path.join(ROOT, 'backend/services/revertEstoqueService2.js')));
}

async function main() {
  const testes = [
    ['01 devolucao fiscal credita e revert debita SF', test01DevolucaoFiscalCreditaERevertDebitaFiscal],
    ['02 devolucao nao fiscal credita e revert debita SNF', test02DevolucaoNaoFiscalCreditaERevertDebitaNF],
    ['03 devolucao mista mantem separacao', test03DevolucaoMistaMantemSeparacao],
    ['04 estoque_atual = SF+SNF e reservas intactas', test04EstoqueAtualSfSnf],
    ['05 sem credito/debito duplicado', test05SemCreditoNemDebitoDuplicado],
    ['06 empresaId propagado', test06EmpresaIdPropagado],
    ['07 COMPAT explicita', test07CompatExplicita],
    ['08 rollback desfaz o debito', test08RollbackDesfazDebito],
    ['09 SQL direto de saldo removido', test09SqlDiretoRemovido],
    ['10 motores F/NF MTS MUC intactos', test10MotoresIntacto]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\nrevert-devolucao-venda-porta-publica: ${ok}/${testes.length} OK`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
