/**
 * Sprint 05.53 — Consumo físico de reserva PDV sem COMPAT.
 * Fonte da baixa: reserva.empresa_id.
 * Executar: node tests/estoque/consumo-fisico-reserva-pdv-sem-compat-05-53.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.resolve(__dirname, '../..');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const {
  consumirReservasDaVenda,
  montarOpcoesBaixaFisicaDaReserva
} = require('../../backend/services/estoque/EstoqueConsumoReserva');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';
const SRC_CONSUMO = path.join(ROOT, 'backend/services/estoque/EstoqueConsumoReserva.js');

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
    throw new Error(`Esperava falha (${code})`);
  } catch (err) {
    if (err.message && err.message.startsWith('Esperava falha')) throw err;
    assert.ok(
      err.code === code || err.codigo === code || String(err.message || '').includes(code),
      `esperado ${code}, veio ${err.code}/${err.message}`
    );
  }
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
      controla_estoque INTEGER DEFAULT 1,
      controlar_validade INTEGER DEFAULT 0,
      updated_at DATETIME
    )
  `);
  await run(db, `
    CREATE TABLE vendas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER,
      status TEXT DEFAULT 'aberta'
    )
  `);
  await run(db, `
    CREATE TABLE vendas_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venda_id INTEGER,
      produto_id INTEGER
    )
  `);
  await run(db, `
    CREATE TABLE venda_estoque_reservas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venda_id INTEGER NOT NULL,
      venda_item_id INTEGER,
      produto_id INTEGER NOT NULL,
      quantidade_fiscal REAL DEFAULT 0,
      quantidade_nao_fiscal REAL DEFAULT 0,
      status TEXT DEFAULT 'ATIVA',
      empresa_id INTEGER,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      atualizado_em DATETIME
    )
  `);
  const p = await run(
    db,
    `INSERT INTO produtos
       (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual,
        reservado_fiscal, reservado_nao_fiscal, controlar_validade)
     VALUES ('P', 100, 40, 140, 0, 0, 0)`
  );
  const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: p.lastID,
    empresaId: empresaA.id,
    saldo_fiscal: 40,
    saldo_nao_fiscal: 10,
    estoque_atual: 50,
    reservado_fiscal: 0,
    reservado_nao_fiscal: 0
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: p.lastID,
    empresaId: empresaB.id,
    saldo_fiscal: 30,
    saldo_nao_fiscal: 5,
    estoque_atual: 35,
    reservado_fiscal: 0,
    reservado_nao_fiscal: 0
  }, { db });
  return { db, produtoId: p.lastID, empresaA, empresaB };
}

async function ee(db, produtoId, empresaId) {
  return get(
    db,
    'SELECT * FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?',
    [produtoId, empresaId]
  );
}

async function seedReserva(db, {
  produtoId,
  empresaVenda,
  empresaReserva,
  qF = 5,
  qNf = 0,
  status = 'ATIVA'
}) {
  const v = await run(
    db,
    `INSERT INTO vendas (empresa_id, status) VALUES (?, 'aberta')`,
    [empresaVenda]
  );
  const vendaId = v.lastID;
  const item = await run(
    db,
    `INSERT INTO vendas_itens (venda_id, produto_id) VALUES (?, ?)`,
    [vendaId, produtoId]
  );
  await run(
    db,
    `INSERT INTO venda_estoque_reservas
       (venda_id, venda_item_id, produto_id, quantidade_fiscal, quantidade_nao_fiscal,
        status, empresa_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [vendaId, item.lastID, produtoId, qF, qNf, status, empresaReserva]
  );
  await run(
    db,
    `UPDATE produtos SET
       reservado_fiscal = COALESCE(reservado_fiscal, 0) + ?,
       reservado_nao_fiscal = COALESCE(reservado_nao_fiscal, 0) + ?
     WHERE id = ?`,
    [qF, qNf, produtoId]
  );
  if (empresaReserva != null) {
    await EstoqueEmpresaService.aplicarEfeitoReservado({
      produtoId,
      empresaId: empresaReserva,
      deltaReservadoFiscal: qF,
      deltaReservadoNaoFiscal: qNf
    }, { db });
  }
  return { vendaId, itemId: item.lastID, qF, qNf };
}

async function t01ConsomeEstoqueA() {
  const { db, produtoId, empresaA } = await setup();
  const { vendaId } = await seedReserva(db, {
    produtoId,
    empresaVenda: empresaA.id,
    empresaReserva: empresaA.id,
    qF: 5
  });
  await consumirReservasDaVenda(vendaId, { db, empresaId: empresaA.id });
  const a = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(Number(a.saldo_fiscal), 35);
  assert.strictEqual(Number(a.reservado_fiscal), 0);
  const st = await get(db, 'SELECT status FROM venda_estoque_reservas WHERE venda_id = ?', [vendaId]);
  assert.strictEqual(st.status, 'CONSUMIDA');
  await closeDb(db);
}

async function t02NaoAlteraEstoqueB() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  const { vendaId } = await seedReserva(db, {
    produtoId,
    empresaVenda: empresaA.id,
    empresaReserva: empresaA.id,
    qF: 4
  });
  const bAntes = await ee(db, produtoId, empresaB.id);
  await consumirReservasDaVenda(vendaId, { db, empresaId: empresaA.id });
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(Number(b.saldo_fiscal), Number(bAntes.saldo_fiscal));
  assert.strictEqual(Number(b.reservado_fiscal), Number(bAntes.reservado_fiscal));
  await closeDb(db);
}

async function t03CallerCompativel() {
  const { db, produtoId, empresaA } = await setup();
  const { vendaId } = await seedReserva(db, {
    produtoId,
    empresaVenda: empresaA.id,
    empresaReserva: empresaA.id,
    qF: 3
  });
  const r = await consumirReservasDaVenda(vendaId, { db, empresaId: empresaA.id });
  assert.strictEqual(r.consumidas, 1);
  await closeDb(db);
}

async function t04CallerCruzado() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  const { vendaId } = await seedReserva(db, {
    produtoId,
    empresaVenda: empresaA.id,
    empresaReserva: empresaA.id,
    qF: 3
  });
  const aAntes = await ee(db, produtoId, empresaA.id);
  await assertRejects(
    consumirReservasDaVenda(vendaId, { db, empresaId: empresaB.id }),
    'RESERVA_EMPRESA_DIVERGENTE'
  );
  const a = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(Number(a.saldo_fiscal), Number(aAntes.saldo_fiscal));
  assert.strictEqual(Number(a.reservado_fiscal), Number(aAntes.reservado_fiscal));
  const st = await get(db, 'SELECT status FROM venda_estoque_reservas WHERE venda_id = ?', [vendaId]);
  assert.strictEqual(st.status, 'ATIVA');
  await closeDb(db);
}

async function t05ReservaNull() {
  const { db, produtoId, empresaA } = await setup();
  const { vendaId } = await seedReserva(db, {
    produtoId,
    empresaVenda: empresaA.id,
    empresaReserva: null,
    qF: 2
  });
  const aAntes = await ee(db, produtoId, empresaA.id);
  const prodAntes = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  await assertRejects(
    consumirReservasDaVenda(vendaId, { db, empresaId: empresaA.id }),
    'EMPRESA_OWNERSHIP_REQUIRED'
  );
  const a = await ee(db, produtoId, empresaA.id);
  const prod = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(Number(a.saldo_fiscal), Number(aAntes.saldo_fiscal));
  assert.strictEqual(prod.reservado_fiscal, prodAntes.reservado_fiscal);
  const st = await get(db, 'SELECT status FROM venda_estoque_reservas WHERE venda_id = ?', [vendaId]);
  assert.strictEqual(st.status, 'ATIVA');
  await closeDb(db);
}

async function t06VendaAReservaB() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  const { vendaId } = await seedReserva(db, {
    produtoId,
    empresaVenda: empresaA.id,
    empresaReserva: empresaB.id,
    qF: 2
  });
  const aAntes = await ee(db, produtoId, empresaA.id);
  const bAntes = await ee(db, produtoId, empresaB.id);
  await assertRejects(
    consumirReservasDaVenda(vendaId, { db, empresaId: empresaB.id }),
    'OPERACAO_EMPRESA_DIVERGENTE'
  );
  const a = await ee(db, produtoId, empresaA.id);
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(Number(a.saldo_fiscal), Number(aAntes.saldo_fiscal));
  assert.strictEqual(Number(b.saldo_fiscal), Number(bAntes.saldo_fiscal));
  const st = await get(db, 'SELECT status FROM venda_estoque_reservas WHERE venda_id = ?', [vendaId]);
  assert.strictEqual(st.status, 'ATIVA');
  await closeDb(db);
}

async function t07SemModoLegado() {
  const src = fs.readFileSync(SRC_CONSUMO, 'utf8');
  assert.ok(!src.includes('modoLegadoSemEmpresa: true'));
  assert.ok(src.includes('montarOpcoesBaixaFisicaDaReserva'));
  assert.ok(src.includes('exigirEmpresa: true'));
  const opts = montarOpcoesBaixaFisicaDaReserva(10, {});
  assert.strictEqual(opts.empresaId, 10);
  assert.strictEqual(opts.exigirEmpresa, true);
  assert.ok(!Object.prototype.hasOwnProperty.call(opts, 'modoLegadoSemEmpresa')
    || opts.modoLegadoSemEmpresa !== true);
  assert.ok(opts.motivoCompat == null);
}

async function t08SemCompatDecideEmpresa() {
  const src = fs.readFileSync(SRC_CONSUMO, 'utf8');
  assert.ok(!src.includes('COMPAT_CONSUMO_RESERVA_PDV'));
  assert.ok(!src.includes('COMPAT_DEBITO_VENDA'));
  assert.ok(!src.includes('COMPAT_CERTIFICADA'));
  assert.ok(!/{[\s\S]*\.\.\.opcoes[\s\S]*empresaId:\s*dona/.test(src)
    || !src.includes('{ ...opcoes, empresaId: dona }'));
  assert.ok(!src.includes('{ ...opcoes, empresaId: dona }'));
  assert.ok(src.includes('origem: \'consumo_reserva_pdv\''));
}

async function t09ProdutoCompartilhado() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  const { vendaId } = await seedReserva(db, {
    produtoId,
    empresaVenda: empresaA.id,
    empresaReserva: empresaA.id,
    qF: 7
  });
  await consumirReservasDaVenda(vendaId, { db, empresaId: empresaA.id });
  const a = await ee(db, produtoId, empresaA.id);
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(Number(a.saldo_fiscal), 33);
  assert.strictEqual(Number(b.saldo_fiscal), 30);
  assert.strictEqual(Number(b.reservado_fiscal), 0);
  await closeDb(db);
}

async function t10FalhaSemMutacao() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  const { vendaId } = await seedReserva(db, {
    produtoId,
    empresaVenda: empresaA.id,
    empresaReserva: empresaA.id,
    qF: 2
  });
  const snap = async () => ({
    prod: await get(db, 'SELECT reservado_fiscal, saldo_fiscal FROM produtos WHERE id = ?', [produtoId]),
    a: await ee(db, produtoId, empresaA.id),
    st: await get(db, 'SELECT status FROM venda_estoque_reservas WHERE venda_id = ?', [vendaId])
  });
  const antes = await snap();
  await assertRejects(
    consumirReservasDaVenda(vendaId, { db, empresaId: empresaB.id }),
    'RESERVA_EMPRESA_DIVERGENTE'
  );
  const depois = await snap();
  assert.strictEqual(depois.prod.reservado_fiscal, antes.prod.reservado_fiscal);
  assert.strictEqual(depois.prod.saldo_fiscal, antes.prod.saldo_fiscal);
  assert.strictEqual(Number(depois.a.saldo_fiscal), Number(antes.a.saldo_fiscal));
  assert.strictEqual(Number(depois.a.reservado_fiscal), Number(antes.a.reservado_fiscal));
  assert.strictEqual(depois.st.status, 'ATIVA');
  await closeDb(db);
}

async function main() {
  const testes = [
    ['T01 consome estoque A', t01ConsomeEstoqueA],
    ['T02 não altera estoque B', t02NaoAlteraEstoqueB],
    ['T03 caller A compatível', t03CallerCompativel],
    ['T04 caller B cruzado', t04CallerCruzado],
    ['T05 reserva NULL', t05ReservaNull],
    ['T06 venda A × reserva B', t06VendaAReservaB],
    ['T07 sem modoLegadoSemEmpresa', t07SemModoLegado],
    ['T08 COMPAT não decide empresa', t08SemCompatDecideEmpresa],
    ['T09 produto compartilhado', t09ProdutoCompartilhado],
    ['T10 falha sem mutação', t10FalhaSemMutacao]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\nconsumo-fisico-reserva-pdv-sem-compat-05-53: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
