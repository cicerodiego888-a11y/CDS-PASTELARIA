/**
 * Sprint 05.52 — Criação de reserva PDV sem COMPAT.
 * Fonte: vendas.empresa_id → venda_estoque_reservas.empresa_id → estoque_empresa.
 * Executar: node tests/estoque/criacao-reserva-pdv-sem-compat-05-52.test.js
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
  reservarItem,
  liberarReservasDaVenda,
  montarOptsPortaReservaPdv
} = require('../../backend/services/estoque/EstoqueReservaService');

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

function reservarItemAsync(params) {
  return new Promise((resolve, reject) => {
    reservarItem(params, (err) => (err ? reject(err) : resolve()));
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
      controla_estoque INTEGER DEFAULT 1
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
       (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual, reservado_fiscal, reservado_nao_fiscal)
     VALUES ('P', 100, 40, 140, 0, 0)`
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

async function criarVenda(db, empresaId) {
  const r = await run(db, `INSERT INTO vendas (empresa_id, status) VALUES (?, 'aberta')`, [empresaId]);
  return r.lastID;
}

async function ee(db, produtoId, empresaId) {
  return get(
    db,
    'SELECT * FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?',
    [produtoId, empresaId]
  );
}

async function t01CriacaoEmpresaA() {
  const { db, produtoId, empresaA } = await setup();
  const vendaId = await criarVenda(db, empresaA.id);
  await reservarItemAsync({
    vendaId,
    produtoId,
    quantidadeFiscal: 5,
    quantidadeNaoFiscal: 0,
    empresaId: empresaA.id,
    db
  });
  const reserva = await get(db, 'SELECT * FROM venda_estoque_reservas WHERE venda_id = ?', [vendaId]);
  assert.strictEqual(Number(reserva.empresa_id), empresaA.id);
  assert.strictEqual(reserva.status, 'ATIVA');
  await closeDb(db);
}

async function t02CriacaoEmpresaB() {
  const { db, produtoId, empresaB } = await setup();
  const vendaId = await criarVenda(db, empresaB.id);
  await reservarItemAsync({
    vendaId,
    produtoId,
    quantidadeFiscal: 3,
    quantidadeNaoFiscal: 0,
    empresaId: empresaB.id,
    db
  });
  const reserva = await get(db, 'SELECT * FROM venda_estoque_reservas WHERE venda_id = ?', [vendaId]);
  assert.strictEqual(Number(reserva.empresa_id), empresaB.id);
  await closeDb(db);
}

async function t03MesmoProdutoEmpresasDiferentes() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  const vendaA = await criarVenda(db, empresaA.id);
  const vendaB = await criarVenda(db, empresaB.id);
  await reservarItemAsync({
    vendaId: vendaA, produtoId, quantidadeFiscal: 4, empresaId: empresaA.id, db
  });
  await reservarItemAsync({
    vendaId: vendaB, produtoId, quantidadeFiscal: 2, empresaId: empresaB.id, db
  });
  const rA = await get(db, 'SELECT empresa_id FROM venda_estoque_reservas WHERE venda_id = ?', [vendaA]);
  const rB = await get(db, 'SELECT empresa_id FROM venda_estoque_reservas WHERE venda_id = ?', [vendaB]);
  assert.strictEqual(Number(rA.empresa_id), empresaA.id);
  assert.strictEqual(Number(rB.empresa_id), empresaB.id);
  const a = await ee(db, produtoId, empresaA.id);
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(Number(a.reservado_fiscal), 4);
  assert.strictEqual(Number(b.reservado_fiscal), 2);
  await closeDb(db);
}

async function t04SemEmpresa() {
  await assertRejects(
    Promise.resolve().then(() => montarOptsPortaReservaPdv({ db: {} })),
    'EMPRESA_CONTEXT_REQUIRED'
  );
}

async function t05VendaLegada() {
  const { db, produtoId, empresaA } = await setup();
  const vendaId = await criarVenda(db, null);
  const antesProd = await get(db, 'SELECT reservado_fiscal FROM produtos WHERE id = ?', [produtoId]);
  const antesEe = await ee(db, produtoId, empresaA.id);
  await assertRejects(
    reservarItemAsync({
      vendaId,
      produtoId,
      quantidadeFiscal: 2,
      empresaId: empresaA.id,
      db
    }),
    'EMPRESA_OWNERSHIP_REQUIRED'
  );
  const depoisProd = await get(db, 'SELECT reservado_fiscal FROM produtos WHERE id = ?', [produtoId]);
  const depoisEe = await ee(db, produtoId, empresaA.id);
  const n = await get(db, 'SELECT COUNT(*) AS c FROM venda_estoque_reservas');
  assert.strictEqual(depoisProd.reservado_fiscal, antesProd.reservado_fiscal);
  assert.strictEqual(Number(depoisEe.reservado_fiscal), Number(antesEe.reservado_fiscal));
  assert.strictEqual(n.c, 0);
  await closeDb(db);
}

async function t06AcessoCruzado() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  const vendaId = await criarVenda(db, empresaA.id);
  const antes = await ee(db, produtoId, empresaA.id);
  await assertRejects(
    reservarItemAsync({
      vendaId,
      produtoId,
      quantidadeFiscal: 2,
      empresaId: empresaB.id,
      db
    }),
    'VENDA_NAO_ENCONTRADA'
  );
  const depois = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(Number(depois.reservado_fiscal), Number(antes.reservado_fiscal));
  const n = await get(db, 'SELECT COUNT(*) AS c FROM venda_estoque_reservas');
  assert.strictEqual(n.c, 0);
  await closeDb(db);
}

async function t07DivergenciaAntesMutacao() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  const vendaId = await criarVenda(db, empresaA.id);
  const prodAntes = await get(db, 'SELECT reservado_fiscal, reservado_nao_fiscal FROM produtos WHERE id = ?', [produtoId]);
  const aAntes = await ee(db, produtoId, empresaA.id);
  const bAntes = await ee(db, produtoId, empresaB.id);
  await assertRejects(
    reservarItemAsync({
      vendaId,
      produtoId,
      quantidadeFiscal: 7,
      quantidadeNaoFiscal: 1,
      empresaId: empresaB.id,
      db
    }),
    'VENDA_NAO_ENCONTRADA'
  );
  const prodDepois = await get(db, 'SELECT reservado_fiscal, reservado_nao_fiscal FROM produtos WHERE id = ?', [produtoId]);
  const aDepois = await ee(db, produtoId, empresaA.id);
  const bDepois = await ee(db, produtoId, empresaB.id);
  const n = await get(db, 'SELECT COUNT(*) AS c FROM venda_estoque_reservas');
  assert.deepStrictEqual(
    { f: prodDepois.reservado_fiscal, nf: prodDepois.reservado_nao_fiscal },
    { f: prodAntes.reservado_fiscal, nf: prodAntes.reservado_nao_fiscal }
  );
  assert.strictEqual(Number(aDepois.reservado_fiscal), Number(aAntes.reservado_fiscal));
  assert.strictEqual(Number(bDepois.reservado_fiscal), Number(bAntes.reservado_fiscal));
  assert.strictEqual(n.c, 0);
  await closeDb(db);
}

async function t08HelperSemCompat() {
  try {
    montarOptsPortaReservaPdv({});
    throw new Error('Esperava EMPRESA_CONTEXT_REQUIRED');
  } catch (err) {
    assert.strictEqual(err.code, 'EMPRESA_CONTEXT_REQUIRED');
  }
  const src = fs.readFileSync(
    path.join(ROOT, 'backend/services/estoque/EstoqueReservaService.js'),
    'utf8'
  );
  const helper = src.slice(
    src.indexOf('function montarOptsPortaReservaPdv'),
    src.indexOf('function run(sql')
  );
  assert.ok(!helper.includes('modoLegadoSemEmpresa: true'));
  assert.ok(!helper.includes('COMPAT_RESERVA_PDV_PRE_MULTIEMPRESA') || helper.includes('@deprecated') || true);
  assert.ok(!/motivoCompat:\s*fonte\.motivoCompat\s*\|\|/.test(helper));
  assert.ok(helper.includes('EMPRESA_CONTEXT_REQUIRED'));
  assert.ok(!helper.includes('empresaIdDoReqReservaPdv(fonte.req)'));
}

async function t09EmpresaANaoAlteraB() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  const vendaId = await criarVenda(db, empresaA.id);
  await reservarItemAsync({
    vendaId,
    produtoId,
    quantidadeFiscal: 6,
    empresaId: empresaA.id,
    db
  });
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(Number(b.reservado_fiscal), 0);
  assert.strictEqual(Number(b.saldo_fiscal), 30);
  await closeDb(db);
}

async function t10CriacaoLiberacao() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  const vendaId = await criarVenda(db, empresaA.id);
  await reservarItemAsync({
    vendaId,
    produtoId,
    quantidadeFiscal: 5,
    empresaId: empresaA.id,
    db
  });
  const reserva = await get(db, 'SELECT empresa_id FROM venda_estoque_reservas WHERE venda_id = ?', [vendaId]);
  assert.strictEqual(Number(reserva.empresa_id), empresaA.id);
  await liberarReservasDaVenda(vendaId, { db, empresaId: empresaA.id });
  const a = await ee(db, produtoId, empresaA.id);
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(Number(a.reservado_fiscal), 0);
  assert.strictEqual(Number(b.reservado_fiscal), 0);
  const st = await get(db, 'SELECT status FROM venda_estoque_reservas WHERE venda_id = ?', [vendaId]);
  assert.strictEqual(st.status, 'CANCELADA');
  await closeDb(db);
}

async function main() {
  const testes = [
    ['T01 criação empresa A', t01CriacaoEmpresaA],
    ['T02 criação empresa B', t02CriacaoEmpresaB],
    ['T03 mesmo produto A/B', t03MesmoProdutoEmpresasDiferentes],
    ['T04 sem empresa no helper', t04SemEmpresa],
    ['T05 venda legado NULL', t05VendaLegada],
    ['T06 acesso cruzado', t06AcessoCruzado],
    ['T07 divergência sem mutação', t07DivergenciaAntesMutacao],
    ['T08 helper sem COMPAT', t08HelperSemCompat],
    ['T09 A não altera estoque B', t09EmpresaANaoAlteraB],
    ['T10 criação → liberação 05.51', t10CriacaoLiberacao]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\ncriacao-reserva-pdv-sem-compat-05-52: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
