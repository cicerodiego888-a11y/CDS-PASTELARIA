/**
 * Fase 2 / Implementação 03.36 — Pedido usa disponibilidade isolada.
 * Fluxo real: Pedido → Motor Comercial → reservasPublico.consultarDisponibilidade.
 */
'use strict';

const assert = require('assert');
const sqlite3 = require('sqlite3').verbose();

const MotorComercial = require('../../backend/motores/comercial');
const {
  confirmarEstoqueViaMotorComercial
} = require('../../backend/services/pedido/PedidoOperacionalService');
const reservas = require('../../backend/services/fiscalNaoFiscal/reservasPublico');
const { COMPAT_CERTIFICADA_PRE_MULTIEMPRESA } = require('../../backend/services/fiscalNaoFiscal/empresaContexto');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');

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

async function assertRejects(promise, code) {
  try {
    await promise;
    throw new Error(`Esperava ${code}`);
  } catch (err) {
    if (err.message === `Esperava ${code}`) throw err;
    assert.strictEqual(err.code || err.codigo, code, err.message);
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
      controla_estoque INTEGER DEFAULT 1,
      estoque_atual REAL DEFAULT 0,
      updated_at DATETIME
    )
  `);
  await run(db, `
    CREATE TABLE movimentos_transferencia_saldos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produto_id INTEGER NOT NULL,
      origem TEXT NOT NULL,
      destino TEXT NOT NULL,
      quantidade REAL NOT NULL,
      saldo_origem_antes REAL NOT NULL,
      saldo_origem_depois REAL NOT NULL,
      saldo_destino_antes REAL NOT NULL,
      saldo_destino_depois REAL NOT NULL,
      motivo TEXT,
      usuario_id INTEGER,
      data_hora DATETIME DEFAULT CURRENT_TIMESTAMP,
      resultado TEXT NOT NULL
    )
  `);
  await run(db, `
    CREATE TABLE auditoria_pedido_estoque_fiscal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER,
      produto_id INTEGER,
      evento TEXT NOT NULL,
      quantidade REAL,
      saldo_fiscal REAL,
      saldo_nao_fiscal REAL,
      disponivel_fiscal REAL,
      disponivel_nao_fiscal REAL,
      detalhes TEXT,
      usuario_id INTEGER,
      supervisor_id INTEGER,
      data_hora DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const p = await run(
    db,
    `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual)
     VALUES ('X', 100, 0, 100)`
  );
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const b = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: p.lastID, empresaId: a.id,
    saldo_fiscal: 10, reservado_fiscal: 2, estoque_atual: 10
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: p.lastID, empresaId: b.id,
    saldo_fiscal: 3, reservado_fiscal: 0, estoque_atual: 3
  }, { db });
  return { db, produtoId: p.lastID, empresaA: a, empresaB: b };
}

async function test01PedidoBBloqueado() {
  const { db, produtoId, empresaB } = await setup();
  await assertRejects(
    confirmarEstoqueViaMotorComercial({
      pedidoId: 36,
      itens: [{ produto_id: produtoId, quantidade: 5 }],
      empresaId: empresaB.id,
      motivo: '03.36-B'
    }, { db }),
    'SALDO_INSUFICIENTE'
  );
  const prod = await get(db, 'SELECT saldo_fiscal FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.saldo_fiscal, 100);
  await closeDb(db);
}

async function test02PedidoAPermitido() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  const r = await confirmarEstoqueViaMotorComercial({
    pedidoId: 36,
    itens: [{ produto_id: produtoId, quantidade: 5 }],
    empresaId: empresaA.id,
    motivo: '03.36-A'
  }, { db });
  assert.strictEqual(r.sucesso, true);
  assert.strictEqual(r.reservas.length, 1);
  const b = await get(
    db,
    'SELECT saldo_fiscal, reservado_fiscal FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?',
    [produtoId, empresaB.id]
  );
  assert.strictEqual(b.saldo_fiscal, 3);
  assert.strictEqual(b.reservado_fiscal, 0);
  await closeDb(db);
}

async function test03AnaliseMotorComercial() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  const analiseB = await MotorComercial.analisarDisponibilidadeFiscal(
    [{ produto_id: produtoId, quantidade: 5 }],
    { db, pedidoId: 1, empresaId: empresaB.id }
  );
  assert.strictEqual(analiseB.bloqueado, true);

  const analiseA = await MotorComercial.analisarDisponibilidadeFiscal(
    [{ produto_id: produtoId, quantidade: 5 }],
    { db, pedidoId: 2, empresaId: empresaA.id }
  );
  assert.strictEqual(analiseA.bloqueado, false);
  assert.strictEqual(analiseA.ok, true);
  await closeDb(db);
}

async function test04MesmaOrigemQueConsulta() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  const dispA = await reservas.consultarDisponibilidade(produtoId, { db, empresaId: empresaA.id });
  const dispB = await reservas.consultarDisponibilidade(produtoId, { db, empresaId: empresaB.id });
  assert.strictEqual(dispA.disponivel_fiscal, 8);
  assert.strictEqual(dispB.disponivel_fiscal, 3);
  const legado = await reservas.consultarDisponibilidade(produtoId, {
    db,
    ...COMPAT_CERTIFICADA_PRE_MULTIEMPRESA
  });
  assert.strictEqual(legado.saldo_fiscal, 100);
  await closeDb(db);
}

async function main() {
  const testes = [
    ['01 Pedido B qty 5 bloqueado (produtos=100 nao autoriza)', test01PedidoBBloqueado],
    ['02 Pedido A qty 5 permitido (disponivel=8)', test02PedidoAPermitido],
    ['03 Motor Comercial analisa isolado', test03AnaliseMotorComercial],
    ['04 mesma origem que consultarDisponibilidade', test04MesmaOrigemQueConsulta]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  ok ${nome}`);
  }
  console.log(`\npedido-disponibilidade-multiempresa: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
