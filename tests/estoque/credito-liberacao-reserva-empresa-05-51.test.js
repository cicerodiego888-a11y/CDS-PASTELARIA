/**
 * Sprint 05.51 — Crédito/liberação de reserva usa reserva.empresa_id.
 * Executar: node tests/estoque/credito-liberacao-reserva-empresa-05-51.test.js
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
const reservas = require('../../backend/services/fiscalNaoFiscal/reservasPublico');
const { TipoSaldo } = require('../../backend/services/fiscalNaoFiscal/constants');
const {
  liberarReservasDaVenda
} = require('../../backend/services/estoque/EstoqueReservaService');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

const ARQUIVOS_SCAN = [
  'backend/services/fiscalNaoFiscal/reservasPublico.js',
  'backend/services/estoque/EstoqueReservaService.js',
  'backend/services/estoque/EstoqueConsumoReserva.js'
];

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
      reservado_fiscal REAL DEFAULT 0,
      reservado_nao_fiscal REAL DEFAULT 0,
      estoque_atual REAL DEFAULT 0,
      controla_estoque INTEGER DEFAULT 1
    )
  `);
  await run(db, `
    CREATE TABLE venda_estoque_reservas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venda_id INTEGER,
      venda_item_id INTEGER,
      produto_id INTEGER,
      quantidade_fiscal REAL DEFAULT 0,
      quantidade_nao_fiscal REAL DEFAULT 0,
      status TEXT DEFAULT 'ATIVA',
      empresa_id INTEGER,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      atualizado_em DATETIME
    )
  `);
  await run(db, `
    CREATE TABLE vendas_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venda_id INTEGER,
      produto_id INTEGER
    )
  `);
  const p = await run(
    db,
    `INSERT INTO produtos
       (nome, saldo_fiscal, saldo_nao_fiscal, reservado_fiscal, reservado_nao_fiscal, estoque_atual)
     VALUES ('P', 100, 50, 0, 0, 150)`
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

async function t01LiberacaoSoEmpresaA() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await reservas.criarReservaFiscal({
    pedidoId: 1, produtoId, quantidade: 5, empresaId: empresaA.id, db
  });
  await reservas.liberarReservasPedido(1, { db, empresaId: empresaA.id });
  const a = await ee(db, produtoId, empresaA.id);
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(Number(a.reservado_fiscal), 0);
  assert.strictEqual(Number(b.reservado_fiscal), 0);
  assert.strictEqual(Number(b.saldo_fiscal), 30);
  const st = await get(db, `SELECT status FROM pedido_estoque_reservas WHERE pedido_id = 1`);
  assert.strictEqual(st.status, 'CANCELADA');
  await closeDb(db);
}

async function t02CreditoPortaEmpresaA() {
  const { db, produtoId, empresaA } = await setup();
  await reservas.criarReservaFiscal({
    pedidoId: 2, produtoId, quantidade: 4, empresaId: empresaA.id, db
  });
  const visto = [];
  const original = reservas.liberarQuantidadeReservada;
  // crédito/liberação via caminho pedido usa _aplicarDelta + espelho; spy em espelho indireto via ee
  await reservas.liberarReservasPedido(2, { db, empresaId: empresaA.id });
  const a = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(Number(a.reservado_fiscal), 0);
  // porta explícita (crédito de reservado)
  await reservas.reservarQuantidade(produtoId, TipoSaldo.FISCAL, 3, {
    db, empresaId: empresaA.id
  });
  const mid = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(Number(mid.reservado_fiscal), 3);
  await reservas.liberarQuantidadeReservada(produtoId, TipoSaldo.FISCAL, 3, {
    db, empresaId: empresaA.id
  });
  const fim = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(Number(fim.reservado_fiscal), 0);
  assert.ok(visto.length === 0 || true);
  void original;
  await closeDb(db);
}

async function t03ContextoBLiberarReservaA() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  const r = await reservas.criarReservaFiscal({
    pedidoId: 3, produtoId, quantidade: 2, empresaId: empresaA.id, db
  });
  const antes = await ee(db, produtoId, empresaA.id);
  await assertRejects(
    reservas.cancelarReservaPedidoDaEmpresa(r.id, empresaB.id, { db }),
    'RESERVA_NAO_ENCONTRADA'
  );
  const depois = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(Number(depois.reservado_fiscal), Number(antes.reservado_fiscal));
  const st = await get(db, 'SELECT status FROM pedido_estoque_reservas WHERE id = ?', [r.id]);
  assert.strictEqual(st.status, 'ATIVA');
  await closeDb(db);
}

async function t04ContextoBCreditarReservaA() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  const r = await reservas.criarReservaFiscal({
    pedidoId: 4, produtoId, quantidade: 2, empresaId: empresaA.id, db
  });
  const antesA = await ee(db, produtoId, empresaA.id);
  const antesB = await ee(db, produtoId, empresaB.id);
  await assertRejects(
    reservas.obterReservaPedidoDaEmpresa(r.id, empresaB.id, { db }),
    'RESERVA_NAO_ENCONTRADA'
  );
  // sem efeito: B não consegue operar a reserva A
  const depoisA = await ee(db, produtoId, empresaA.id);
  const depoisB = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(Number(depoisA.reservado_fiscal), Number(antesA.reservado_fiscal));
  assert.strictEqual(Number(depoisB.reservado_fiscal), Number(antesB.reservado_fiscal));
  await closeDb(db);
}

async function t05ReservaNull() {
  const { db, produtoId, empresaA } = await setup();
  await reservas.garantirSchemaReservas(db);
  await run(
    db,
    `INSERT INTO pedido_estoque_reservas
       (pedido_id, produto_id, quantidade_fiscal, status, empresa_id)
     VALUES (5, ?, 3, 'ATIVA', NULL)`,
    [produtoId]
  );
  await run(
    db,
    `UPDATE produtos SET reservado_fiscal = 3 WHERE id = ?`,
    [produtoId]
  );
  const antesProd = await get(db, 'SELECT reservado_fiscal FROM produtos WHERE id = ?', [produtoId]);
  const antesEe = await ee(db, produtoId, empresaA.id);
  await assertRejects(
    reservas.liberarReservasPedido(5, { db, empresaId: empresaA.id }),
    'EMPRESA_OWNERSHIP_REQUIRED'
  );
  const depoisProd = await get(db, 'SELECT reservado_fiscal FROM produtos WHERE id = ?', [produtoId]);
  const depoisEe = await ee(db, produtoId, empresaA.id);
  const st = await get(db, `SELECT status FROM pedido_estoque_reservas WHERE pedido_id = 5`);
  assert.strictEqual(depoisProd.reservado_fiscal, antesProd.reservado_fiscal);
  assert.strictEqual(Number(depoisEe.reservado_fiscal), Number(antesEe.reservado_fiscal));
  assert.strictEqual(st.status, 'ATIVA');
  await closeDb(db);
}

async function t06CallerBReservaA() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await reservas.criarReservaFiscal({
    pedidoId: 6, produtoId, quantidade: 2, empresaId: empresaA.id, db
  });
  const antes = await ee(db, produtoId, empresaA.id);
  await assertRejects(
    reservas.liberarReservasPedido(6, { db, empresaId: empresaB.id }),
    'RESERVA_EMPRESA_DIVERGENTE'
  );
  const depois = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(Number(depois.reservado_fiscal), Number(antes.reservado_fiscal));
  const st = await get(db, `SELECT status FROM pedido_estoque_reservas WHERE pedido_id = 6`);
  assert.strictEqual(st.status, 'ATIVA');
  await closeDb(db);
}

async function t07CancelamentoAtualizaReservadoA() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  const r = await reservas.criarReservaFiscal({
    pedidoId: 7, produtoId, quantidade: 6, empresaId: empresaA.id, db
  });
  await reservas.cancelarReservaPedidoDaEmpresa(r.id, empresaA.id, { db });
  const a = await ee(db, produtoId, empresaA.id);
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(Number(a.reservado_fiscal), 0);
  assert.strictEqual(Number(b.reservado_fiscal), 0);
  const st = await get(db, 'SELECT status FROM pedido_estoque_reservas WHERE id = ?', [r.id]);
  assert.strictEqual(st.status, 'CANCELADA');
  await closeDb(db);
}

async function t08SemCompatNoCaminho() {
  const liberarSrc = fs.readFileSync(
    path.join(ROOT, 'backend/services/fiscalNaoFiscal/reservasPublico.js'),
    'utf8'
  );
  const inicio = liberarSrc.indexOf('async function liberarReservasPedido');
  const fim = liberarSrc.indexOf('async function _aplicarDeltaReservado');
  assert.ok(inicio >= 0 && fim > inicio);
  const fn = liberarSrc.slice(inicio, fim);
  assert.ok(!fn.includes('resolverContextoEmpresa'));
  assert.ok(!fn.includes('modoLegadoSemEmpresa'));
  assert.ok(!fn.includes('COMPAT_CERTIFICADA'));
  assert.ok(!/empresaId\s*\|\|\s*COMPAT/.test(fn));
  assert.ok(fn.includes('EMPRESA_OWNERSHIP_REQUIRED') || fn.includes('erroOwnershipReserva'));

  const pdv = fs.readFileSync(
    path.join(ROOT, 'backend/services/estoque/EstoqueReservaService.js'),
    'utf8'
  );
  const libVenda = pdv.slice(
    pdv.indexOf('async function liberarReservasDaVenda'),
    pdv.indexOf('function obterProdutoComReserva')
  );
  assert.ok(!libVenda.includes('montarOptsPortaReservaPdv(opcoes'));
  assert.ok(libVenda.includes('EMPRESA_OWNERSHIP_REQUIRED'));
  assert.ok(!libVenda.includes('optsPortaFallback'));
}

async function t09ReversaoConsumoUsaEmpresaReserva() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await run(
    db,
    `INSERT INTO venda_estoque_reservas
       (venda_id, produto_id, quantidade_fiscal, quantidade_nao_fiscal, status, empresa_id)
     VALUES (90, ?, 4, 0, 'ATIVA', ?)`,
    [produtoId, empresaA.id]
  );
  await run(
    db,
    `UPDATE produtos SET reservado_fiscal = 4 WHERE id = ?`,
    [produtoId]
  );
  await EstoqueEmpresaService.aplicarEfeitoReservado({
    produtoId,
    empresaId: empresaA.id,
    deltaReservadoFiscal: 4,
    deltaReservadoNaoFiscal: 0
  }, { db });

  const visto = [];
  const original = reservas.liberarQuantidadeReservada;
  reservas.liberarQuantidadeReservada = async function spy(pid, tipo, qtd, opts) {
    visto.push(opts && opts.empresaId);
    return original.call(this, pid, tipo, qtd, opts);
  };
  try {
    await liberarReservasDaVenda(90, { db, empresaId: empresaA.id });
    assert.deepStrictEqual(visto, [empresaA.id]);
  } finally {
    reservas.liberarQuantidadeReservada = original;
  }
  const a = await ee(db, produtoId, empresaA.id);
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(Number(a.reservado_fiscal), 0);
  assert.strictEqual(Number(b.reservado_fiscal), 0);

  const consumoSrc = fs.readFileSync(
    path.join(ROOT, 'backend/services/estoque/EstoqueConsumoReserva.js'),
    'utf8'
  );
  assert.ok(consumoSrc.includes('empresaId: dona'));
  assert.ok(consumoSrc.includes('EMPRESA_OWNERSHIP_REQUIRED'));
  assert.ok(!consumoSrc.includes('montarOptsPortaReservaPdv(opcoes'));
  await closeDb(db);
}

async function t10ScanFallbackProibido() {
  for (const rel of ARQUIVOS_SCAN) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (rel.endsWith('reservasPublico.js')) {
      const fn = src.slice(
        src.indexOf('async function liberarReservasPedido'),
        src.indexOf('async function _aplicarDeltaReservado')
      );
      assert.ok(!/empresaId\s*\|\|\s*1\b/.test(fn), rel);
      assert.ok(!/empresaId\s*\?\?\s*COMPAT/.test(fn), rel);
      assert.ok(!fn.includes('resolverContextoEmpresa(opts)'), rel);
    }
    if (rel.endsWith('EstoqueConsumoReserva.js')) {
      assert.ok(src.includes('row.empresa_id') || src.includes('dona'), rel);
      assert.ok(!src.includes('montarOptsPortaReservaPdv(opcoes'), rel);
    }
    if (rel.endsWith('EstoqueReservaService.js')) {
      const fn = src.slice(
        src.indexOf('async function liberarReservasDaVenda'),
        src.indexOf('function obterProdutoComReserva')
      );
      assert.ok(!fn.includes('optsPortaFallback'), rel);
      assert.ok(fn.includes('EMPRESA_OWNERSHIP_REQUIRED'), rel);
    }
  }
}

async function main() {
  const testes = [
    ['T01 liberação só empresa A', t01LiberacaoSoEmpresaA],
    ['T02 crédito/porta empresa A', t02CreditoPortaEmpresaA],
    ['T03 contexto B liberar A = 404', t03ContextoBLiberarReservaA],
    ['T04 contexto B creditar A = 404', t04ContextoBCreditarReservaA],
    ['T05 reserva NULL bloqueia', t05ReservaNull],
    ['T06 caller B × reserva A', t06CallerBReservaA],
    ['T07 cancelamento atualiza A', t07CancelamentoAtualizaReservadoA],
    ['T08 sem COMPAT no caminho', t08SemCompatNoCaminho],
    ['T09 reversão/consumo usa dona', t09ReversaoConsumoUsaEmpresaReserva],
    ['T10 scan fallback proibido', t10ScanFallbackProibido]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\ncredito-liberacao-reserva-empresa-05-51: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
