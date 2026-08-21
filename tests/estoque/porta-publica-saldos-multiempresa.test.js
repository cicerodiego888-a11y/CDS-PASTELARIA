/**
 * Fase 1 / Implementação 01 — Porta Pública de Saldos + Contexto de Empresa
 *
 * TESTES 01–15 do contrato multiempresa (storage ainda em produtos).
 */
'use strict';

const assert = require('assert');
const sqlite3 = require('sqlite3').verbose();

const saldos = require('../../backend/services/fiscalNaoFiscal/estoqueSaldosPublico');
const reservas = require('../../backend/services/fiscalNaoFiscal/reservasPublico');
const { TipoSaldo } = require('../../backend/services/fiscalNaoFiscal/constants');
const {
  COMPAT_CERTIFICADA_PRE_MULTIEMPRESA
} = require('../../backend/services/fiscalNaoFiscal/empresaContexto');

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

async function setup({ comEmpresas = true } = {}) {
  const db = await openDb();
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

  if (comEmpresas) {
    await run(db, `
      CREATE TABLE empresas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        razao_social TEXT,
        cnpj TEXT
      )
    `);
    await run(db, `INSERT INTO empresas (id, razao_social, cnpj) VALUES (1, 'Empresa A', '111')`);
    await run(db, `INSERT INTO empresas (id, razao_social, cnpj) VALUES (2, 'Empresa B', '222')`);
  }

  const p = await run(
    db,
    `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual, reservado_fiscal, reservado_nao_fiscal)
     VALUES ('Cebola', 100, 40, 140, 10, 5)`
  );

  return { db, produtoId: p.lastID, empresaId: 1 };
}

async function test01ConsultarComEmpresa() {
  const { db, produtoId, empresaId } = await setup();
  const r = await saldos.consultarSaldo(produtoId, { db, empresaId });
  assert.strictEqual(r.produto_id, produtoId);
  assert.strictEqual(r.empresa_id, empresaId);
  assert.strictEqual(r.saldo_fiscal, 100);
  assert.strictEqual(r.saldo_nao_fiscal, 40);
  assert.strictEqual(r.estoque_atual, 140);
  assert.strictEqual(r.reservado_fiscal, 10);
  assert.strictEqual(r.reservado_nao_fiscal, 5);
  await closeDb(db);
}

async function test02DebitarFiscal() {
  const { db, produtoId, empresaId } = await setup();
  const r = await saldos.debitarSaldo(produtoId, TipoSaldo.FISCAL, 15, { db, empresaId });
  assert.strictEqual(r.empresa_id, empresaId);
  assert.strictEqual(r.saldo_fiscal_depois, 85);
  assert.strictEqual(r.estoque_atual_depois, 125);
  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.saldo_fiscal, 85);
  assert.strictEqual(row.estoque_atual, 125);
  await closeDb(db);
}

async function test03DebitarNaoFiscal() {
  const { db, produtoId, empresaId } = await setup();
  const r = await saldos.debitarSaldo(produtoId, TipoSaldo.NAO_FISCAL, 10, { db, empresaId });
  assert.strictEqual(r.saldo_nao_fiscal_depois, 30);
  assert.strictEqual(r.estoque_atual_depois, 130);
  await closeDb(db);
}

async function test04CreditarFiscal() {
  const { db, produtoId, empresaId } = await setup();
  const r = await saldos.creditarSaldo(produtoId, TipoSaldo.FISCAL, 7, { db, empresaId });
  assert.strictEqual(r.saldo_fiscal_depois, 107);
  assert.strictEqual(r.estoque_atual_depois, 147);
  await closeDb(db);
}

async function test05CreditarNaoFiscal() {
  const { db, produtoId, empresaId } = await setup();
  const r = await saldos.creditarSaldo(produtoId, TipoSaldo.NAO_FISCAL, 3, { db, empresaId });
  assert.strictEqual(r.saldo_nao_fiscal_depois, 43);
  assert.strictEqual(r.estoque_atual_depois, 143);
  await closeDb(db);
}

async function test06TransferirFiscalParaNaoFiscal() {
  const { db, produtoId, empresaId } = await setup();
  const r = await saldos.transferirSaldoEntreTipos({
    produtoId,
    empresaId,
    origem: TipoSaldo.FISCAL,
    destino: TipoSaldo.NAO_FISCAL,
    quantidade: 20
  }, { db });
  assert.strictEqual(r.empresa_id, empresaId);
  assert.strictEqual(r.saldo_origem_depois, 80);
  assert.strictEqual(r.saldo_destino_depois, 60);
  const row = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.estoque_atual, 140);
  await closeDb(db);
}

async function test07TransferirNaoFiscalParaFiscal() {
  const { db, produtoId, empresaId } = await setup();
  const r = await saldos.transferirSaldoEntreTipos({
    produtoId,
    empresaId,
    origem: TipoSaldo.NAO_FISCAL,
    destino: TipoSaldo.FISCAL,
    quantidade: 8
  }, { db });
  assert.strictEqual(r.saldo_origem_depois, 32);
  assert.strictEqual(r.saldo_destino_depois, 108);
  await closeDb(db);
}

async function test08ReservarFiscal() {
  const { db, produtoId, empresaId } = await setup();
  const r = await reservas.criarReservaFiscal({
    pedidoId: 10,
    produtoId,
    empresaId,
    quantidade: 12
  }, { db });
  assert.strictEqual(r.status, 'ATIVA');
  assert.strictEqual(r.empresa_id, empresaId);
  assert.strictEqual(r.quantidade_fiscal, 12);
  const row = await get(db, 'SELECT reservado_fiscal FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.reservado_fiscal, 22);
  await closeDb(db);
}

async function test09ReservarNaoFiscal() {
  const { db, produtoId, empresaId } = await setup();
  const r = await reservas.criarReservaNaoFiscal({
    pedidoId: 11,
    produtoId,
    empresaId,
    quantidade: 4
  }, { db });
  assert.strictEqual(r.status, 'ATIVA');
  assert.strictEqual(r.tipo, TipoSaldo.NAO_FISCAL);
  assert.strictEqual(r.quantidade_nao_fiscal, 4);
  const row = await get(db, 'SELECT reservado_nao_fiscal FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(row.reservado_nao_fiscal, 9);
  await closeDb(db);
}

async function test10EmpresaAusente() {
  const { db, produtoId } = await setup();
  await assertRejects(
    saldos.consultarSaldo(produtoId, { db }),
    'EMPRESA_OBRIGATORIA'
  );
  await assertRejects(
    saldos.debitarSaldo(produtoId, TipoSaldo.FISCAL, 1, { db }),
    'EMPRESA_OBRIGATORIA'
  );
  await closeDb(db);
}

async function test11ProdutoInexistente() {
  const { db, empresaId } = await setup();
  await assertRejects(
    saldos.consultarSaldo(99999, { db, empresaId }),
    'PRODUTO_NAO_ENCONTRADO'
  );
  await closeDb(db);
}

async function test12EmpresaInexistente() {
  const { db, produtoId } = await setup({ comEmpresas: true });
  await assertRejects(
    saldos.consultarSaldo(produtoId, { db, empresaId: 999 }),
    'EMPRESA_NAO_ENCONTRADA'
  );
  await closeDb(db);
}

async function test13InvarianteEstoqueAtual() {
  const { db, produtoId, empresaId } = await setup();
  await saldos.debitarSaldo(produtoId, TipoSaldo.FISCAL, 11, { db, empresaId });
  await saldos.creditarSaldo(produtoId, TipoSaldo.NAO_FISCAL, 6, { db, empresaId });
  const r = await saldos.consultarSaldo(produtoId, { db, empresaId });
  assert.strictEqual(
    r.estoque_atual,
    r.saldo_fiscal + r.saldo_nao_fiscal
  );
  await closeDb(db);
}

async function test14DisponivelFiscal() {
  const { db, produtoId, empresaId } = await setup();
  const r = await saldos.consultarSaldo(produtoId, { db, empresaId });
  assert.strictEqual(
    r.disponivel_fiscal,
    Math.max(0, r.saldo_fiscal - r.reservado_fiscal)
  );
  await closeDb(db);
}

async function test15DisponivelNaoFiscal() {
  const { db, produtoId, empresaId } = await setup();
  const r = await saldos.consultarSaldo(produtoId, { db, empresaId });
  assert.strictEqual(
    r.disponivel_nao_fiscal,
    Math.max(0, r.saldo_nao_fiscal - r.reservado_nao_fiscal)
  );
  await closeDb(db);
}

async function testCompatLegadoExplicito() {
  const { db, produtoId } = await setup({ comEmpresas: false });
  const r = await saldos.consultarSaldo(produtoId, {
    db,
    ...COMPAT_CERTIFICADA_PRE_MULTIEMPRESA
  });
  assert.strictEqual(r.legado, true);
  assert.strictEqual(r.empresa_id, null);
  assert.strictEqual(r.saldo_fiscal, 100);
  await closeDb(db);
}

async function testAssinaturaObjeto() {
  const { db, produtoId, empresaId } = await setup();
  const r = await saldos.consultarSaldo({ produtoId, empresaId, db });
  assert.strictEqual(r.empresa_id, empresaId);
  assert.strictEqual(r.produto_id, produtoId);
  await closeDb(db);
}

async function main() {
  const testes = [
    ['01 consultar produto+empresa', test01ConsultarComEmpresa],
    ['02 debitar fiscal', test02DebitarFiscal],
    ['03 debitar nao fiscal', test03DebitarNaoFiscal],
    ['04 creditar fiscal', test04CreditarFiscal],
    ['05 creditar nao fiscal', test05CreditarNaoFiscal],
    ['06 transferir F→NF', test06TransferirFiscalParaNaoFiscal],
    ['07 transferir NF→F', test07TransferirNaoFiscalParaFiscal],
    ['08 reservar fiscal', test08ReservarFiscal],
    ['09 reservar nao fiscal', test09ReservarNaoFiscal],
    ['10 empresa ausente', test10EmpresaAusente],
    ['11 produto inexistente', test11ProdutoInexistente],
    ['12 empresa inexistente', test12EmpresaInexistente],
    ['13 estoque_atual = SF+SNF', test13InvarianteEstoqueAtual],
    ['14 disponivel_fiscal', test14DisponivelFiscal],
    ['15 disponivel_nao_fiscal', test15DisponivelNaoFiscal],
    ['compat legado explícito', testCompatLegadoExplicito],
    ['assinatura objeto', testAssinaturaObjeto]
  ];

  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\nporta-publica-saldos-multiempresa: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
