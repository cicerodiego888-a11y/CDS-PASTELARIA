/**
 * Fase 2 / Implementação 03.26 — reservas PDV: req.empresaId até a porta 03.20.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const {
  reservarItem,
  liberarReservasDaVenda,
  montarOptsPortaReservaPdv,
  empresaIdDoReqReservaPdv
} = require('../../backend/services/estoque/EstoqueReservaService');
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

function reservarItemAsync(params) {
  return new Promise((resolve, reject) => {
    reservarItem(params, (err) => (err ? reject(err) : resolve()));
  });
}

async function reservarComoPdv(db, req, dados) {
  const opts = montarOptsPortaReservaPdv({
    req,
    empresaId: empresaIdDoReqReservaPdv(req),
    db
  }, db);
  await reservarItemAsync({
    vendaId: dados.vendaId || 1,
    vendaItemId: dados.vendaItemId || 1,
    produtoId: dados.produtoId,
    quantidadeFiscal: dados.quantidadeFiscal || 0,
    quantidadeNaoFiscal: dados.quantidadeNaoFiscal || 0,
    empresaId: opts.empresaId,
    usuarioId: opts.usuarioId,
    db
  });
  return opts;
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
      updated_at DATETIME
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
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      atualizado_em DATETIME
    )
  `);
  const p = await run(
    db,
    `INSERT INTO produtos
       (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual, reservado_fiscal, reservado_nao_fiscal)
     VALUES ('X', 100, 40, 140, 0, 0)`
  );
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const b = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  return { db, produtoId: p.lastID, empresaA: a, empresaB: b };
}

async function seedAB(db, produtoId, empresaA, empresaB) {
  await EstoqueEmpresaService.criarRegistro({
    produtoId,
    empresaId: empresaA.id,
    saldo_fiscal: 10,
    saldo_nao_fiscal: 4,
    estoque_atual: 14,
    reservado_fiscal: 0,
    reservado_nao_fiscal: 0
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId,
    empresaId: empresaB.id,
    saldo_fiscal: 20,
    saldo_nao_fiscal: 8,
    estoque_atual: 28,
    reservado_fiscal: 0,
    reservado_nao_fiscal: 0
  }, { db });
}

async function ee(db, produtoId, empresaId) {
  return get(
    db,
    'SELECT * FROM estoque_empresa WHERE produto_id = ? AND empresa_id = ?',
    [produtoId, empresaId]
  );
}

async function test01ReservaEmpresaA() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  await reservarComoPdv(db, { empresaId: empresaA.id }, {
    produtoId, quantidadeFiscal: 3
  });
  const a = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(a.reservado_fiscal, 3);
  const prod = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.reservado_fiscal, 3);
  await closeDb(db);
}

async function test02NaoAlteraEmpresaB() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  await reservarComoPdv(db, { empresaId: empresaA.id }, {
    produtoId, quantidadeFiscal: 3
  });
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(b.reservado_fiscal, 0);
  assert.strictEqual(b.saldo_fiscal, 20);
  await closeDb(db);
}

async function test03LiberacaoEmpresaCorreta() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  const req = { empresaId: empresaA.id };
  await reservarComoPdv(db, req, { produtoId, quantidadeFiscal: 3, vendaId: 11 });
  await liberarReservasDaVenda(11, montarOptsPortaReservaPdv({
    req,
    empresaId: empresaIdDoReqReservaPdv(req),
    db
  }, db));
  const a = await ee(db, produtoId, empresaA.id);
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(a.reservado_fiscal, 0);
  assert.strictEqual(b.reservado_fiscal, 0);
  const prod = await get(db, 'SELECT reservado_fiscal FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.reservado_fiscal, 0);
  await closeDb(db);
}

async function test04ReqEmpresaIdChegaNaPorta() {
  const { db, produtoId, empresaA } = await setup();
  const req = {
    empresaId: empresaA.id,
    body: { empresaId: 99, empresa_id: 99 },
    query: { empresaId: 99 }
  };
  const opts = montarOptsPortaReservaPdv({ req, empresaId: empresaIdDoReqReservaPdv(req), db }, db);
  assert.strictEqual(opts.empresaId, empresaA.id);
  assert.strictEqual(opts.legado, false);
  await reservarComoPdv(db, req, { produtoId, quantidadeFiscal: 1 });
  const iso = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(iso.reservado_fiscal, 1);
  await closeDb(db);
}

async function test05ReqPrevaleceSobreBodyQuery() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  const req = {
    empresaId: empresaA.id,
    body: { empresaId: empresaB.id, empresa_id: empresaB.id },
    query: { empresaId: empresaB.id, empresa_id: empresaB.id },
    contexto: { empresaId: empresaB.id },
    ctx: { empresaId: empresaB.id }
  };
  assert.strictEqual(empresaIdDoReqReservaPdv(req), empresaA.id);
  const opts = montarOptsPortaReservaPdv({
    req,
    empresaId: empresaIdDoReqReservaPdv(req),
    body: req.body,
    query: req.query,
    contexto: req.contexto,
    ctx: req.ctx,
    db
  }, db);
  assert.strictEqual(opts.empresaId, empresaA.id);
  assert.notStrictEqual(opts.empresaId, empresaB.id);
  await reservarComoPdv(db, req, { produtoId, quantidadeFiscal: 3 });
  const a = await ee(db, produtoId, empresaA.id);
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(a.reservado_fiscal, 3);
  assert.strictEqual(b.reservado_fiscal, 0);
  await closeDb(db);
}

async function test06SemEmpresaMantemCompat() {
  const { db, produtoId } = await setup();
  const req = { empresaId: null, body: { empresaId: 99 }, query: { empresaId: 99 } };
  const opts = await reservarComoPdv(db, req, { produtoId, quantidadeFiscal: 3 });
  assert.strictEqual(opts.legado, true);
  assert.ok(opts.empresaId == null);
  const prod = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.reservado_fiscal, 3);
  await closeDb(db);
}

async function test07SemEmpresaNaoCriaEstoqueEmpresa() {
  const { db, produtoId } = await setup();
  await reservarComoPdv(db, { empresaId: null, body: { empresaId: 1 } }, {
    produtoId, quantidadeFiscal: 3
  });
  const n = await get(db, 'SELECT COUNT(*) AS c FROM estoque_empresa');
  assert.strictEqual(n.c, 0);
  await closeDb(db);
}

async function test08NaoDuplicaReserva() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  const req = { empresaId: empresaA.id };
  const opts = montarOptsPortaReservaPdv({
    req,
    empresaId: empresaIdDoReqReservaPdv(req),
    db
  }, db);
  await reservarItemAsync({
    vendaId: 22,
    vendaItemId: 1,
    produtoId,
    quantidadeFiscal: 3,
    quantidadeNaoFiscal: 0,
    empresaId: opts.empresaId,
    db
  });
  const ativas = await get(
    db,
    `SELECT COUNT(*) AS c FROM venda_estoque_reservas WHERE venda_id = 22 AND status = 'ATIVA'`
  );
  assert.strictEqual(ativas.c, 1);
  await liberarReservasDaVenda(22, opts);
  await liberarReservasDaVenda(22, opts);
  const a = await ee(db, produtoId, empresaA.id);
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(a.reservado_fiscal, 0);
  assert.strictEqual(b.reservado_fiscal, 0);
  const canceladas = await get(
    db,
    `SELECT COUNT(*) AS c FROM venda_estoque_reservas WHERE venda_id = 22 AND status = 'CANCELADA'`
  );
  assert.strictEqual(canceladas.c, 1);
  await closeDb(db);
}

async function test09RollbackExterno() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedAB(db, produtoId, empresaA, empresaB);
  await run(db, 'BEGIN');
  await reservarComoPdv(db, { empresaId: empresaA.id }, {
    produtoId, quantidadeFiscal: 3, vendaId: 33
  });
  const midProd = await get(db, 'SELECT reservado_fiscal FROM produtos WHERE id = ?', [produtoId]);
  const midA = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(midProd.reservado_fiscal, 3);
  assert.strictEqual(midA.reservado_fiscal, 3);
  await run(db, 'ROLLBACK');
  const prod = await get(db, 'SELECT reservado_fiscal FROM produtos WHERE id = ?', [produtoId]);
  const a = await ee(db, produtoId, empresaA.id);
  const b = await ee(db, produtoId, empresaB.id);
  assert.strictEqual(prod.reservado_fiscal, 0);
  assert.strictEqual(a.reservado_fiscal, 0);
  assert.strictEqual(b.reservado_fiscal, 0);
  await closeDb(db);
}

async function test10RegressaoFuncional() {
  const { db, produtoId, empresaA } = await setup();
  await reservarComoPdv(db, { empresaId: empresaA.id }, {
    produtoId, quantidadeFiscal: 2, quantidadeNaoFiscal: 1, vendaId: 44
  });
  const prod = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.reservado_fiscal, 2);
  assert.strictEqual(prod.reservado_nao_fiscal, 1);
  assert.strictEqual(prod.saldo_fiscal, 100);
  assert.strictEqual(prod.estoque_atual, 140);
  const iso = await ee(db, produtoId, empresaA.id);
  assert.strictEqual(iso.reservado_fiscal, 2);
  assert.strictEqual(iso.reservado_nao_fiscal, 1);
  assert.strictEqual(iso.saldo_fiscal, 0);

  const reserva = fs.readFileSync(
    path.join(ROOT, 'backend/services/estoque/EstoqueReservaService.js'),
    'utf8'
  );
  assert.ok(reserva.includes('reservasPublico'));
  assert.ok(reserva.includes('empresaIdDoReqReservaPdv'));
  assert.ok(!reserva.includes('extrairEmpresaIdDeReq'));
  assert.ok(!reserva.includes('EstoqueEmpresaService'));
  assert.ok(!/UPDATE\s+produtos/i.test(reserva));

  const criar = fs.readFileSync(
    path.join(ROOT, 'backend/services/entrega/CriarVendaEntregaService.js'),
    'utf8'
  );
  assert.ok(criar.includes('empresaIdDoReqReservaPdv(req)'));
  assert.ok(!criar.includes('req.body?.empresa_id ?? req.body?.empresaId'));

  const motor = fs.readFileSync(
    path.join(ROOT, 'backend/services/entrega/MotorFinalizacaoVenda.js'),
    'utf8'
  );
  assert.ok(motor.includes('empresaId: req.empresaId'));
  assert.ok(!motor.includes('montarOptsPortaReservaPdv(contextoAuditoria, db)'));

  const rotas = fs.readFileSync(path.join(ROOT, 'backend/rotas/entregas.js'), 'utf8');
  assert.ok(rotas.includes('criarMiddlewareContextoEmpresa'));
  assert.ok(rotas.includes('anexarContextoEmpresa, EntregaController.prestacao'));
  assert.ok(rotas.includes('anexarContextoEmpresa, EntregaController.cancelarEntrega'));

  const porta = fs.readFileSync(
    path.join(ROOT, 'backend/services/fiscalNaoFiscal/reservasPublico.js'),
    'utf8'
  );
  assert.ok(porta.includes('aplicarEfeitoReservado'));

  const pdvEntrega = fs.readFileSync(
    path.join(ROOT, 'frontend/pdv/js/pdv-venda-entrega.js'),
    'utf8'
  );
  assert.ok(pdvEntrega.includes("extra['X-Empresa-Id']"));

  const pdvPrestacao = fs.readFileSync(
    path.join(ROOT, 'frontend/pdv/js/pdv-prestacao-entrega.js'),
    'utf8'
  );
  assert.ok(pdvPrestacao.includes("extra['X-Empresa-Id']"));

  await closeDb(db);
}

async function main() {
  const testes = [
    ['01 reserva PDV com empresa A', test01ReservaEmpresaA],
    ['02 reserva nao altera empresa B', test02NaoAlteraEmpresaB],
    ['03 liberacao na empresa correta', test03LiberacaoEmpresaCorreta],
    ['04 req.empresaId chega ate reservasPublico', test04ReqEmpresaIdChegaNaPorta],
    ['05 req.empresaId prevalece sobre body/query', test05ReqPrevaleceSobreBodyQuery],
    ['06 sem empresa mantem COMPAT', test06SemEmpresaMantemCompat],
    ['07 sem empresa nao cria estoque_empresa', test07SemEmpresaNaoCriaEstoqueEmpresa],
    ['08 nao duplica reserva', test08NaoDuplicaReserva],
    ['09 rollback externo restaura ambos', test09RollbackExterno],
    ['10 regressao funcional reservas PDV', test10RegressaoFuncional]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  }
  console.log(`\nreservas-pdv-multiempresa-contexto: ${ok}/${testes.length} OK`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FALHA:', err);
  process.exit(1);
});
