/**
 * Fase 2 / Implementação 03.30 — Pedido / Expedição: req.empresaId até o Motor Comercial / MTS.
 * Não altera MTS nem Motor Comercial. Só a propagação no caller HTTP.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const MotorComercial = require('../../backend/motores/comercial');
const {
  confirmarEstoqueViaMotorComercial,
  empresaIdDoReqPedido
} = require('../../backend/services/pedido/PedidoOperacionalService');
const { TipoSaldo } = require('../../backend/services/fiscalNaoFiscal/constants');
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

async function setup(opts = {}) {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaEstoqueEmpresaAsync(db);
  const sf = opts.saldo_fiscal != null ? opts.saldo_fiscal : 100;
  const snf = opts.saldo_nao_fiscal != null ? opts.saldo_nao_fiscal : 50;
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
     VALUES ('X', ?, ?, ?)`,
    [sf, snf, sf + snf]
  );
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const b = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  await run(db, `
    CREATE TABLE pedidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER,
      status TEXT DEFAULT 'PEDIDO'
    )
  `);
  return { db, produtoId: p.lastID, empresaA: a, empresaB: b };
}

async function seedPedido(db, empresaId) {
  const r = await run(db, `INSERT INTO pedidos (empresa_id, status) VALUES (?, 'PEDIDO')`, [empresaId]);
  return r.lastID;
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

async function seedAB(db, produtoId, empresaA, empresaB, saldos = {}) {
  await EstoqueEmpresaService.criarRegistro({
    produtoId,
    empresaId: empresaA.id,
    saldo_fiscal: saldos.aF != null ? saldos.aF : 10,
    saldo_nao_fiscal: saldos.aNF != null ? saldos.aNF : 40,
    estoque_atual: (saldos.aF != null ? saldos.aF : 10) + (saldos.aNF != null ? saldos.aNF : 40)
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId,
    empresaId: empresaB.id,
    saldo_fiscal: saldos.bF != null ? saldos.bF : 20,
    saldo_nao_fiscal: saldos.bNF != null ? saldos.bNF : 8,
    estoque_atual: (saldos.bF != null ? saldos.bF : 20) + (saldos.bNF != null ? saldos.bNF : 8)
  }, { db });
}

function ee(db, produtoId, empresaId) {
  return get(
    db,
    'SELECT * FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?',
    [produtoId, empresaId]
  );
}

const depsSup = {
  verificarSupervisorToken: async () => ({ id: 99, username: 'sup', perfil: 'SUPERVISOR' })
};

function reqPedido(empresaId, extra = {}) {
  return {
    empresaId,
    body: extra.body || { empresaId: 99, empresa_id: 99 },
    query: extra.query || { empresaId: 99 },
    user: extra.user || { empresaId: 99 }
  };
}

async function test01PedidoChegaAoMotorComercial() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB, { aF: 100, aNF: 50, bF: 20, bNF: 8 });
  const empresaId = empresaIdDoReqPedido(reqPedido(empresaA.id));
  const pedidoId = await seedPedido(db, empresaA.id);
  const r = await confirmarEstoqueViaMotorComercial({
    pedidoId,
    itens: [{ produto_id: produtoId, quantidade: 10 }],
    usuarioId: 1,
    motivo: 'pedido-03-30',
    empresaId
  }, { db });
  assert.strictEqual(r.sucesso, true);
  assert.strictEqual(r.reservas.length, 1);
  const src = fs.readFileSync(
    path.join(ROOT, 'backend/services/pedido/PedidoOperacionalService.js'),
    'utf8'
  );
  assert.ok(/confirmarPedidoFiscal\(\{[\s\S]*?empresaId/.test(src));
  await closeDb(db);
}

async function test02PedidoChegaAoMts() {
  const { db, produtoId, empresaA, empresaB } = await setup({ saldo_fiscal: 10, saldo_nao_fiscal: 90 });
  await seedAB(db, produtoId, empresaA, empresaB, { aF: 10, aNF: 90, bF: 20, bNF: 8 });
  const pedidoId = await seedPedido(db, empresaA.id);
  const r = await confirmarEstoqueViaMotorComercial({
    pedidoId,
    itens: [{ produto_id: produtoId, quantidade: 40 }],
    supervisorToken: 'tok',
    usuarioId: 1,
    motivo: 'mts-pedido',
    empresaId: empresaA.id
  }, { db, ...depsSup });
  assert.strictEqual(r.transferencias.length, 1);
  assert.strictEqual(r.transferencias[0].empresa_id, empresaA.id);
  assert.strictEqual(r.transferencias[0].origem, TipoSaldo.NAO_FISCAL);
  assert.strictEqual(r.transferencias[0].destino, TipoSaldo.FISCAL);
  await closeDb(db);
}

async function test03ExpedicaoChegaAoMotorComercial() {
  const src = fs.readFileSync(
    path.join(ROOT, 'backend/services/pedido/PedidoService.js'),
    'utf8'
  );
  const rota = fs.readFileSync(
    path.join(ROOT, 'backend/rotas/faturamento.js'),
    'utf8'
  );
  assert.ok(/confirmarPedidoFiscal\(\{[\s\S]*?empresaId/.test(src));
  assert.ok(rota.includes('empresaIdDoReqPedido(req)'));
  assert.ok(rota.includes('criarMiddlewareContextoEmpresa'));
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB, { aF: 100, aNF: 50, bF: 20, bNF: 8 });
  const pedidoId = await seedPedido(db, empresaA.id);
  const r = await MotorComercial.confirmarPedidoFiscal({
    pedidoId,
    itens: [{ produto_id: produtoId, quantidade: 8 }],
    motivo: 'expedicao-03-30',
    empresaId: empresaIdDoReqPedido(reqPedido(empresaA.id))
  }, { db });
  assert.strictEqual(r.sucesso, true);
  await closeDb(db);
}

async function test04ExpedicaoChegaAoMts() {
  const { db, produtoId, empresaA, empresaB } = await setup({ saldo_fiscal: 10, saldo_nao_fiscal: 90 });
  await seedAB(db, produtoId, empresaA, empresaB, { aF: 10, aNF: 90, bF: 20, bNF: 8 });
  const pedidoId = await seedPedido(db, empresaA.id);
  const r = await MotorComercial.confirmarPedidoFiscal({
    pedidoId,
    itens: [{ produto_id: produtoId, quantidade: 40 }],
    supervisorToken: 'tok',
    motivo: 'expedicao-mts',
    empresaId: empresaA.id
  }, { db, ...depsSup });
  assert.strictEqual(r.transferencias[0].empresa_id, empresaA.id);
  await closeDb(db);
}

async function test05BodyNaoSubstitui() {
  const a = 7;
  const req = reqPedido(a, { body: { empresaId: 99, empresa_id: 99 } });
  assert.strictEqual(empresaIdDoReqPedido(req), a);
  assert.ok(empresaIdDoReqPedido({
    empresaId: null,
    body: { empresaId: 1 }
  }) == null);
}

async function test06QueryNaoSubstitui() {
  assert.strictEqual(
    empresaIdDoReqPedido({ empresaId: 3, query: { empresaId: 9, empresa_id: 9 } }),
    3
  );
  assert.ok(empresaIdDoReqPedido({ query: { empresaId: 1 } }) == null);
}

async function test07IsolamentoAB() {
  const { db, produtoId, empresaA, empresaB } = await setup({
    saldo_fiscal: 10,
    saldo_nao_fiscal: 90
  });
  await seedAB(db, produtoId, empresaA, empresaB, { aF: 10, aNF: 90, bF: 20, bNF: 8 });
  const pedidoId = await seedPedido(db, empresaA.id);
  await confirmarEstoqueViaMotorComercial({
    pedidoId,
    itens: [{ produto_id: produtoId, quantidade: 40 }],
    supervisorToken: 'tok',
    empresaId: empresaA.id
  }, { db, ...depsSup });
  const a = await ee(db, produtoId, empresaA.id);
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(a.saldo_fiscal, 40);
  assert.strictEqual(a.saldo_nao_fiscal, 60);
  assert.strictEqual(b.saldo_fiscal, 20);
  assert.strictEqual(b.saldo_nao_fiscal, 8);
  await closeDb(db);
}

async function test08PortaPublica() {
  const mts = fs.readFileSync(path.join(ROOT, 'backend/motores/mts/MtsService.js'), 'utf8');
  const comercial = fs.readFileSync(
    path.join(ROOT, 'backend/motores/comercial/MotorComercialService.js'),
    'utf8'
  );
  assert.ok(mts.includes('debitarSaldo'));
  assert.ok(mts.includes('creditarSaldo'));
  assert.ok(comercial.includes('mts.transferirSaldo'));
  assert.ok(comercial.includes('empresaId: portaOpts.empresaId'));
}

async function test09Compat() {
  const { db, produtoId } = await setup({ saldo_fiscal: 10, saldo_nao_fiscal: 90 });
  await assertRejects(
    confirmarEstoqueViaMotorComercial({
      pedidoId: 9,
      itens: [{ produto_id: produtoId, quantidade: 40 }],
      supervisorToken: 'tok',
      empresaId: empresaIdDoReqPedido({ empresaId: null, body: { empresaId: 1 } })
    }, { db, ...depsSup }),
    'PEDIDO_NAO_ENCONTRADO'
  );
  await closeDb(db);
}

async function test10ContratoMts() {
  const src = fs.readFileSync(path.join(ROOT, 'backend/motores/mts/MtsService.js'), 'utf8');
  assert.ok(src.includes('resolverEmpresaId(params)'));
  assert.ok(!/UPDATE\s+produtos/i.test(src));
}

async function test11Rollback() {
  const { db, produtoId, empresaA, empresaB } = await setup({
    saldo_fiscal: 10,
    saldo_nao_fiscal: 90
  });
  await seedAB(db, produtoId, empresaA, empresaB, { aF: 10, aNF: 90, bF: 20, bNF: 8 });
  const pedidoId = await seedPedido(db, empresaA.id);
  await run(db, 'BEGIN');
  await confirmarEstoqueViaMotorComercial({
    pedidoId,
    itens: [{ produto_id: produtoId, quantidade: 40 }],
    supervisorToken: 'tok',
    empresaId: empresaA.id
  }, {
    db,
    ...depsSup,
    executarEmTransacao: async (work) => work(db)
  });
  const mid = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(mid.saldo_fiscal, 40);
  await run(db, 'ROLLBACK');
  const a = await ee(db, produtoId, empresaA.id);
  const b = await ee(db, produtoId, empresaB.id);
  const prod = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(a.saldo_fiscal, 10);
  assert.strictEqual(a.saldo_nao_fiscal, 90);
  assert.strictEqual(b.saldo_fiscal, 20);
  assert.strictEqual(prod.saldo_fiscal, 10);
  assert.strictEqual(prod.saldo_nao_fiscal, 90);
  await closeDb(db);
}

async function test12SemSqlDireto() {
  const arquivos = [
    'backend/services/pedido/PedidoOperacionalService.js',
    'backend/services/pedido/PedidoService.js',
    'backend/services/pedido/empresaIdDoReqPedido.js',
    'backend/rotas/pedidos.js',
    'backend/rotas/faturamento.js'
  ];
  for (const rel of arquivos) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(!/UPDATE\s+produtos/i.test(src), `${rel} não deve UPDATE produtos`);
    assert.ok(!/empresaId\s*=\s*1/.test(src), `${rel} sem fallback empresa 1`);
  }
  const pedidos = fs.readFileSync(path.join(ROOT, 'backend/rotas/pedidos.js'), 'utf8');
  assert.ok(pedidos.includes('criarMiddlewareContextoEmpresa'));
  assert.ok(pedidos.includes('empresaIdDoReqPedido(req)'));
  assert.ok(!pedidos.includes('empresaIdDoReqOperacional'));
}

async function main() {
  const testes = [
    ['01 Pedido com empresaId chega ao Motor Comercial', test01PedidoChegaAoMotorComercial],
    ['02 Pedido com empresaId chega ao MTS', test02PedidoChegaAoMts],
    ['03 Expedicao com empresaId chega ao Motor Comercial', test03ExpedicaoChegaAoMotorComercial],
    ['04 Expedicao com empresaId chega ao MTS', test04ExpedicaoChegaAoMts],
    ['05 body nao substitui req.empresaId', test05BodyNaoSubstitui],
    ['06 query nao substitui req.empresaId', test06QueryNaoSubstitui],
    ['07 empresa A nao altera B', test07IsolamentoAB],
    ['08 operacao chega a porta publica', test08PortaPublica],
    ['09 pedido inexistente nao usa COMPAT', test09Compat],
    ['10 contrato MTS homologado intacto', test10ContratoMts],
    ['11 rollback restaura ambos', test11Rollback],
    ['12 nenhum SQL direto novo', test12SemSqlDireto]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\npedido-expedicao-multiempresa-contexto: ${ok}/${testes.length} OK`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
