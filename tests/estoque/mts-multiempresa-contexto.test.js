/**
 * Fase 2 / Implementação 03.29 — MTS: auditoria de contexto multiempresa.
 *
 * MTS transfere Fiscal ↔ Não Fiscal no mesmo produto. Não há rota HTTP própria.
 * Não há transferência entre empresas. Stop rule: motor já propaga empresaId
 * quando o caller informa; Pedido/Faturamento (outro domínio) não passam contexto.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const {
  transferirSaldo,
  consultarTransferencia,
  TipoSaldo,
  ResultadoTransferencia
} = require('../../backend/motores/mts');
const estoqueSaldosPublico = require('../../backend/services/fiscalNaoFiscal/estoqueSaldosPublico');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');

const ROOT = path.resolve(__dirname, '../..');
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
      updated_at DATETIME
    )
  `);
  const p = await run(
    db,
    `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual)
     VALUES ('X', 100, 50, 150)`
  );
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const b = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  return { db, produtoId: p.lastID, empresaA: a, empresaB: b };
}

async function seedAB(db, produtoId, empresaA, empresaB) {
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaA.id, saldo_fiscal: 10, saldo_nao_fiscal: 40, estoque_atual: 50
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaB.id, saldo_fiscal: 20, saldo_nao_fiscal: 8, estoque_atual: 28
  }, { db });
}

function ee(db, produtoId, empresaId) {
  return get(
    db,
    'SELECT * FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?',
    [produtoId, empresaId]
  );
}

function transferir(db, dados) {
  return transferirSaldo({
    produto: dados.produtoId,
    empresaId: dados.empresaId,
    origem: dados.origem || TipoSaldo.NAO_FISCAL,
    destino: dados.destino || TipoSaldo.FISCAL,
    quantidade: dados.quantidade || 10,
    motivo: dados.motivo || 'mts-03-29',
    contextoAutorizacao: CTX_AUTH,
    modoLegadoSemEmpresa: dados.modoLegadoSemEmpresa,
    body: dados.body,
    query: dados.query,
    user: dados.user,
    contexto: dados.contexto,
    ctx: dados.ctx
  }, {
    db,
    estoque: estoqueSaldosPublico,
    jaEmTransacao: dados.jaEmTransacao === true,
    modoLegadoSemEmpresa: dados.modoLegadoSemEmpresa === true
  });
}

async function test01ContextoChega() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  const r = await transferir(db, { produtoId, empresaId: empresaA.id, quantidade: 5 });
  assert.strictEqual(r.sucesso, true);
  assert.strictEqual(r.empresa_id, empresaA.id);
  assert.strictEqual(r.origem, TipoSaldo.NAO_FISCAL);
  assert.strictEqual(r.destino, TipoSaldo.FISCAL);
  await closeDb(db);
}

async function test02EmpresaChegaNaPorta() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  await transferir(db, { produtoId, empresaId: empresaA.id, quantidade: 10 });
  const a = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(a.saldo_fiscal, 20);
  assert.strictEqual(a.saldo_nao_fiscal, 30);
  const prod = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.saldo_fiscal, 110);
  assert.strictEqual(prod.saldo_nao_fiscal, 40);
  await closeDb(db);
}

async function test03BodyQueryNaoSubstitui() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  await transferir(db, {
    produtoId,
    empresaId: empresaA.id,
    quantidade: 10,
    body: { empresaId: empresaB.id },
    query: { empresaId: empresaB.id },
    user: { empresaId: empresaB.id },
    contexto: { empresaId: empresaB.id },
    ctx: { empresaId: empresaB.id }
  });
  const a = await ee(db, produtoId, empresaA.id);
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(a.saldo_fiscal, 20);
  assert.strictEqual(b.saldo_fiscal, 20);
  assert.strictEqual(b.saldo_nao_fiscal, 8);
  await closeDb(db);
}

async function test04Compat() {
  const { db, produtoId } = await setup();
  const r = await transferir(db, {
    produtoId,
    empresaId: null,
    quantidade: 5,
    modoLegadoSemEmpresa: true,
    body: { empresaId: 99 }
  });
  assert.strictEqual(r.sucesso, true);
  assert.ok(r.empresa_id == null);
  const prod = await get(db, 'SELECT saldo_fiscal, saldo_nao_fiscal FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.saldo_fiscal, 105);
  assert.strictEqual(prod.saldo_nao_fiscal, 45);
  const n = await get(db, 'SELECT COUNT(*) AS c FROM estoque_empresa');
  assert.strictEqual(n.c, 0);
  await closeDb(db);
}

async function test05IsolamentoAB() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  await transferir(db, { produtoId, empresaId: empresaA.id, quantidade: 10 });
  await transferir(db, {
    produtoId,
    empresaId: empresaB.id,
    origem: TipoSaldo.FISCAL,
    destino: TipoSaldo.NAO_FISCAL,
    quantidade: 5
  });
  const a = await ee(db, produtoId, empresaA.id);
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(a.saldo_fiscal, 20);
  assert.strictEqual(a.saldo_nao_fiscal, 30);
  assert.strictEqual(b.saldo_fiscal, 15);
  assert.strictEqual(b.saldo_nao_fiscal, 13);
  await closeDb(db);
}

async function test06Rollback() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  await run(db, 'BEGIN');
  await transferir(db, {
    produtoId,
    empresaId: empresaA.id,
    quantidade: 10,
    jaEmTransacao: true
  });
  const midA = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(midA.saldo_fiscal, 20);
  await run(db, 'ROLLBACK');
  const a = await ee(db, produtoId, empresaA.id);
  const b = await ee(db, produtoId, empresaB.id);
  const prod = await get(db, 'SELECT saldo_fiscal, saldo_nao_fiscal FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(a.saldo_fiscal, 10);
  assert.strictEqual(a.saldo_nao_fiscal, 40);
  assert.strictEqual(b.saldo_fiscal, 20);
  assert.strictEqual(prod.saldo_fiscal, 100);
  assert.strictEqual(prod.saldo_nao_fiscal, 50);
  await closeDb(db);
}

async function test07PortaPublica() {
  const src = fs.readFileSync(path.join(ROOT, 'backend/motores/mts/MtsService.js'), 'utf8');
  assert.ok(src.includes('estoqueSaldosPublico'));
  assert.ok(src.includes('debitarSaldo'));
  assert.ok(src.includes('creditarSaldo'));
  assert.ok(!src.includes('EstoqueEmpresaService'));
  assert.ok(!src.includes('transferirSaldoEntreTipos'));
}

async function test08SemSqlDireto() {
  const dir = path.join(ROOT, 'backend/motores/mts');
  for (const nome of fs.readdirSync(dir)) {
    if (!nome.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(dir, nome), 'utf8');
    assert.ok(!/UPDATE\s+produtos/i.test(src), `${nome} não deve UPDATE produtos`);
  }
}

async function test09ContratoMts() {
  assert.strictEqual(typeof transferirSaldo, 'function');
  assert.strictEqual(typeof consultarTransferencia, 'function');
  assert.strictEqual(TipoSaldo.FISCAL, 'FISCAL');
  assert.strictEqual(TipoSaldo.NAO_FISCAL, 'NAO_FISCAL');
  assert.ok(ResultadoTransferencia.SUCESSO);

  const rotas = fs.readdirSync(path.join(ROOT, 'backend/rotas'))
    .filter((f) => /mts/i.test(f));
  assert.strictEqual(rotas.length, 0, 'MTS não possui rota HTTP própria');

  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  const r = await transferir(db, { produtoId, empresaId: empresaA.id, quantidade: 3 });
  const row = await consultarTransferencia(r.transferencia_id, { db });
  assert.strictEqual(row.resultado, ResultadoTransferencia.SUCESSO);
  assert.strictEqual(row.quantidade, 3);
  await closeDb(db);
}

async function test10AuditoriaCallersSemEmpresa() {
  const pedidoOp = fs.readFileSync(
    path.join(ROOT, 'backend/services/pedido/PedidoOperacionalService.js'),
    'utf8'
  );
  const pedidoSvc = fs.readFileSync(
    path.join(ROOT, 'backend/services/pedido/PedidoService.js'),
    'utf8'
  );
  const comercial = fs.readFileSync(
    path.join(ROOT, 'backend/motores/comercial/MotorComercialService.js'),
    'utf8'
  );
  assert.ok(comercial.includes('mts.transferirSaldo'));
  assert.ok(comercial.includes('empresaId: portaOpts.empresaId'));
  assert.ok(pedidoOp.includes('confirmarPedidoFiscal'));
  assert.ok(/confirmarPedidoFiscal\(\{[\s\S]*?empresaId/.test(pedidoOp));
  assert.ok(/confirmarPedidoFiscal\(\{[\s\S]*?empresaId/.test(pedidoSvc));
}

async function main() {
  const testes = [
    ['01 contexto empresa chega ao fluxo', test01ContextoChega],
    ['02 empresa correta chega a porta', test02EmpresaChegaNaPorta],
    ['03 body/query nao substituem empresaId', test03BodyQueryNaoSubstitui],
    ['04 COMPAT preservado', test04Compat],
    ['05 isolamento empresa A/B', test05IsolamentoAB],
    ['06 rollback preserva consistencia', test06Rollback],
    ['07 porta publica continua sendo utilizada', test07PortaPublica],
    ['08 nenhum SQL direto de saldo', test08SemSqlDireto],
    ['09 contrato MTS permanece compativel', test09ContratoMts],
    ['10 callers Pedido passam empresaId (03.30)', test10AuditoriaCallersSemEmpresa]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\nmts-multiempresa-contexto: ${ok}/${testes.length} OK`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
