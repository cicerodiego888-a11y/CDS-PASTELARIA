/**
 * Fase 2 / Implementação 03.35 — Pedido/MTS não autoriza com saldo global.
 * Caller real de consultarSaldo: MtsService.transferirSaldo.
 */
'use strict';

const assert = require('assert');
const sqlite3 = require('sqlite3').verbose();

const { transferirSaldo, TipoSaldo } = require('../../backend/motores/mts');
const MotorComercial = require('../../backend/motores/comercial');
const saldos = require('../../backend/services/fiscalNaoFiscal/estoqueSaldosPublico');
const { COMPAT_CERTIFICADA_PRE_MULTIEMPRESA } = require('../../backend/services/fiscalNaoFiscal/empresaContexto');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';
const CTX_AUTH = Object.freeze({ autorizado: true });

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
    produtoId: p.lastID, empresaId: a.id, saldo_fiscal: 10, estoque_atual: 10
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: p.lastID, empresaId: b.id, saldo_fiscal: 3, estoque_atual: 3
  }, { db });
  return { db, produtoId: p.lastID, empresaA: a, empresaB: b };
}

async function test01MtsBBloqueado() {
  const { db, produtoId, empresaB } = await setup();
  await assertRejects(
    transferirSaldo({
      produto: produtoId,
      empresaId: empresaB.id,
      origem: TipoSaldo.FISCAL,
      destino: TipoSaldo.NAO_FISCAL,
      quantidade: 5,
      motivo: '03.35-B',
      contextoAutorizacao: CTX_AUTH
    }, { db, estoque: saldos }),
    'SALDO_INSUFICIENTE'
  );
  const prod = await get(db, 'SELECT saldo_fiscal FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.saldo_fiscal, 100);
  const b = await get(
    db,
    'SELECT saldo_fiscal FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?',
    [produtoId, empresaB.id]
  );
  assert.strictEqual(b.saldo_fiscal, 3);
  await closeDb(db);
}

async function test02MtsAPermitido() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  const r = await transferirSaldo({
    produto: produtoId,
    empresaId: empresaA.id,
    origem: TipoSaldo.FISCAL,
    destino: TipoSaldo.NAO_FISCAL,
    quantidade: 5,
    motivo: '03.35-A',
    contextoAutorizacao: CTX_AUTH
  }, { db, estoque: saldos });
  assert.strictEqual(r.sucesso, true);
  const a = await get(
    db,
    'SELECT saldo_fiscal, saldo_nao_fiscal FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?',
    [produtoId, empresaA.id]
  );
  const b = await get(
    db,
    'SELECT saldo_fiscal FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?',
    [produtoId, empresaB.id]
  );
  assert.strictEqual(a.saldo_fiscal, 5);
  assert.strictEqual(a.saldo_nao_fiscal, 5);
  assert.strictEqual(b.saldo_fiscal, 3);
  await closeDb(db);
}

async function test03CompatLegado() {
  const { db, produtoId } = await setup();
  const consulta = await saldos.consultarSaldo(produtoId, {
    db,
    ...COMPAT_CERTIFICADA_PRE_MULTIEMPRESA
  });
  assert.strictEqual(consulta.saldo_fiscal, 100);
  const r = await transferirSaldo({
    produto: produtoId,
    origem: TipoSaldo.FISCAL,
    destino: TipoSaldo.NAO_FISCAL,
    quantidade: 5,
    motivo: '03.35-compat',
    contextoAutorizacao: CTX_AUTH,
    modoLegadoSemEmpresa: true
  }, { db, estoque: saldos, modoLegadoSemEmpresa: true });
  assert.strictEqual(r.sucesso, true);
  const prod = await get(db, 'SELECT saldo_fiscal FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.saldo_fiscal, 95);
  await closeDb(db);
}

async function test04ConsultaPortaIsola() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  const a = await saldos.consultarSaldo(produtoId, { db, empresaId: empresaA.id });
  const b = await saldos.consultarSaldo(produtoId, { db, empresaId: empresaB.id });
  assert.strictEqual(a.saldo_fiscal, 10);
  assert.strictEqual(b.saldo_fiscal, 3);
  assert.ok(b.saldo_fiscal + 1e-9 < 5);
  assert.ok(a.saldo_fiscal + 1e-9 >= 5);
  await closeDb(db);
}

async function test05PedidoEncadeiaMts() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await run(db, `UPDATE produtos SET saldo_fiscal = 0, saldo_nao_fiscal = 100, estoque_atual = 100 WHERE id = ?`, [produtoId]);
  await EstoqueEmpresaService.aplicarEfeitoSaldo({
    produtoId, empresaId: empresaA.id, deltaSaldoNaoFiscal: 40
  }, { db });

  const depsSup = {
    verificarSupervisorToken: async () => ({ id: 99, username: 'sup', perfil: 'SUPERVISOR' })
  };

  await assertRejects(
    MotorComercial.confirmarPedidoFiscal({
      pedidoId: 35,
      itens: [{ produto_id: produtoId, quantidade: 5 }],
      supervisorToken: 'tok',
      empresaId: empresaB.id,
      motivo: '03.35-pedido-B'
    }, { db, ...depsSup }),
    'SALDO_INSUFICIENTE'
  );

  const r = await MotorComercial.confirmarPedidoFiscal({
    pedidoId: 36,
    itens: [{ produto_id: produtoId, quantidade: 5 }],
    supervisorToken: 'tok',
    empresaId: empresaA.id,
    motivo: '03.35-pedido-A'
  }, { db, ...depsSup });
  assert.strictEqual(r.sucesso, true);
  assert.ok(r.reservas.length >= 1);

  const b = await get(
    db,
    'SELECT saldo_fiscal FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?',
    [produtoId, empresaB.id]
  );
  assert.strictEqual(b.saldo_fiscal, 3);
  await closeDb(db);
}

async function main() {
  const testes = [
    ['01 MTS empresa B qty 5 bloqueado (produtos=100 nao autoriza)', test01MtsBBloqueado],
    ['02 MTS empresa A qty 5 permitido', test02MtsAPermitido],
    ['03 sem empresaId COMPAT legado', test03CompatLegado],
    ['04 consultarSaldo isola A/B', test04ConsultaPortaIsola],
    ['05 Pedido→MC→MTS: B bloqueado A permitido', test05PedidoEncadeiaMts]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  ok ${nome}`);
  }
  console.log(`\npedido-mts-disponibilidade-multiempresa: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
