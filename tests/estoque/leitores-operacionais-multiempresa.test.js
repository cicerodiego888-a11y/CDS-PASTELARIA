/**
 * Fase 2 / Implementação 03.32 — leitores operacionais restantes → estoque_empresa.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const {
  aplicarSaldosDisponibilidadeVenda
} = require('../../backend/services/estoque/leituraEstoqueEmpresaProduto');
const { calcularEstoqueProduto } = require('../../backend/services/estoque/EstoqueDisponivelService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');

const ROOT = path.resolve(__dirname, '../..');
const BACKEND = path.join(ROOT, 'backend');
const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

const SRC = {
  entrega: path.join(BACKEND, 'services/entrega/CriarVendaEntregaService.js'),
  leitura: path.join(BACKEND, 'services/estoque/leituraEstoqueEmpresaProduto.js'),
  portaSaldo: path.join(BACKEND, 'services/fiscalNaoFiscal/estoqueSaldosPublico.js'),
  portaReserva: path.join(BACKEND, 'services/fiscalNaoFiscal/reservasPublico.js'),
  baixa: path.join(BACKEND, 'services/vendas/debitoEstoqueVendaViaPorta.js'),
  creditoVenda: path.join(BACKEND, 'services/vendas/creditoEstoqueVendaViaPorta.js'),
  reservaPdv: path.join(BACKEND, 'services/estoque/EstoqueReservaService.js'),
  comprasCred: path.join(BACKEND, 'services/compras/creditoEstoqueCompraViaPorta.js'),
  ajuste: path.join(BACKEND, 'services/ajusteEstoqueService.js'),
  mts: path.join(BACKEND, 'motores/mts/MtsService.js'),
  comercial: path.join(BACKEND, 'motores/comercial/MotorComercialService.js'),
  schema: path.join(BACKEND, 'services/estoque/estoqueEmpresaSchema.js'),
  backfill: path.join(BACKEND, 'services/estoque/EstoqueEmpresaBackfillService.js')
};

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

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
      estoque_atual REAL DEFAULT 0,
      reservado_fiscal REAL DEFAULT 0,
      reservado_nao_fiscal REAL DEFAULT 0,
      controla_estoque INTEGER DEFAULT 1
    )
  `);
  const p = await run(
    db,
    `INSERT INTO produtos
       (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual, reservado_fiscal, reservado_nao_fiscal)
     VALUES ('X', 999, 888, 1887, 50, 40)`
  );
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const b = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: p.lastID,
    empresaId: a.id,
    saldo_fiscal: 10,
    saldo_nao_fiscal: 5,
    estoque_atual: 15,
    reservado_fiscal: 2,
    reservado_nao_fiscal: 1
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: p.lastID,
    empresaId: b.id,
    saldo_fiscal: 30,
    saldo_nao_fiscal: 20,
    estoque_atual: 50,
    reservado_fiscal: 3,
    reservado_nao_fiscal: 4
  }, { db });
  const legado = {
    id: p.lastID,
    saldo_fiscal: 999,
    saldo_nao_fiscal: 888,
    estoque_atual: 1887,
    reservado_fiscal: 50,
    reservado_nao_fiscal: 40
  };
  return { db, produtoId: p.lastID, empresaA: a, empresaB: b, legado };
}

async function ler(db, row, empresaId) {
  const [overlay] = await aplicarSaldosDisponibilidadeVenda({
    produtos: [{ ...row }],
    empresaId,
    db
  });
  return { overlay, calc: calcularEstoqueProduto(overlay) };
}

function test01AuditoriaIdentificaLeitores() {
  const entrega = read(SRC.entrega);
  const leitura = read(SRC.leitura);
  assert.ok(entrega.includes('FROM produtos'));
  assert.ok(entrega.includes('saldo_fiscal'));
  assert.ok(entrega.includes('reservado_fiscal'));
  assert.ok(entrega.includes('aplicarSaldosDisponibilidadeVenda'));
  assert.ok(leitura.includes('consultarSaldoParaEmpresa'));
  assert.ok(leitura.includes('aplicarSaldosDisponibilidadeVenda'));
}

async function test02EmpresaAUsaEstoqueEmpresa() {
  const { db, legado, empresaA } = await setup();
  const { overlay } = await ler(db, legado, empresaA.id);
  assert.strictEqual(overlay.saldo_fiscal, 10);
  assert.strictEqual(overlay.saldo_nao_fiscal, 5);
  assert.strictEqual(overlay.estoque_atual, 15);
  await closeDb(db);
}

async function test03EmpresaBIsolada() {
  const { db, legado, empresaA, empresaB } = await setup();
  const a = await ler(db, legado, empresaA.id);
  const b = await ler(db, legado, empresaB.id);
  assert.strictEqual(a.overlay.saldo_fiscal, 10);
  assert.strictEqual(b.overlay.saldo_fiscal, 30);
  assert.strictEqual(b.overlay.saldo_nao_fiscal, 20);
  assert.notStrictEqual(a.overlay.saldo_fiscal, b.overlay.saldo_fiscal);
  await closeDb(db);
}

async function test04RegistroInexistenteZero() {
  const { db, legado, empresaA } = await setup();
  const outro = await EmpresaService.criarEmpresa(
    { cnpj: '65957340000150', razao_social: 'C' },
    { db }
  );
  const { overlay } = await ler(db, legado, outro.id);
  assert.strictEqual(overlay.saldo_fiscal, 0);
  assert.strictEqual(overlay.saldo_nao_fiscal, 0);
  assert.strictEqual(overlay.estoque_atual, 0);
  assert.strictEqual(overlay.reservado_fiscal, 0);
  assert.strictEqual(overlay.reservado_nao_fiscal, 0);
  assert.ok(outro.id !== empresaA.id);
  await closeDb(db);
}

async function test05SemFallbackParaProdutos() {
  const { db, legado } = await setup();
  const outro = await EmpresaService.criarEmpresa(
    { cnpj: '47627408000151', razao_social: 'D' },
    { db }
  );
  const { overlay } = await ler(db, legado, outro.id);
  assert.notStrictEqual(overlay.saldo_fiscal, legado.saldo_fiscal);
  assert.notStrictEqual(overlay.estoque_atual, legado.estoque_atual);
  assert.strictEqual(overlay.saldo_fiscal, 0);
  await closeDb(db);
}

async function test06SemEmpresaLegado() {
  const { db, legado } = await setup();
  const { overlay } = await ler(db, legado, null);
  assert.strictEqual(overlay.saldo_fiscal, 999);
  assert.strictEqual(overlay.saldo_nao_fiscal, 888);
  assert.strictEqual(overlay.estoque_atual, 1887);
  await closeDb(db);
}

function test07ReqEmpresaIdPrevalece() {
  const entrega = read(SRC.entrega);
  assert.ok(entrega.includes('empresaId: req.empresaId'));
  assert.ok(!/empresaId:\s*req\.body/.test(entrega));
  assert.ok(!/empresaId:\s*req\.query/.test(entrega));
  assert.ok(!entrega.includes('empresaIdDoReqOperacional'));
}

async function test08ReservadosDaEmpresaCorreta() {
  const { db, legado, empresaA, empresaB } = await setup();
  const a = await ler(db, legado, empresaA.id);
  const b = await ler(db, legado, empresaB.id);
  assert.strictEqual(a.overlay.reservado_fiscal, 2);
  assert.strictEqual(a.overlay.reservado_nao_fiscal, 1);
  assert.strictEqual(b.overlay.reservado_fiscal, 3);
  assert.strictEqual(b.overlay.reservado_nao_fiscal, 4);
  assert.notStrictEqual(a.overlay.reservado_fiscal, legado.reservado_fiscal);
  await closeDb(db);
}

async function test09DisponibilidadeIsolada() {
  const { db, legado, empresaA, empresaB } = await setup();
  const a = await ler(db, legado, empresaA.id);
  const b = await ler(db, legado, empresaB.id);
  assert.strictEqual(a.overlay.estoque_atual, a.overlay.saldo_fiscal + a.overlay.saldo_nao_fiscal);
  assert.strictEqual(a.calc.disponivel_fiscal, 8);
  assert.strictEqual(a.calc.disponivel_nao_fiscal, 4);
  assert.strictEqual(b.calc.disponivel_fiscal, 27);
  assert.strictEqual(b.calc.disponivel_nao_fiscal, 16);
  assert.ok(5 <= a.calc.disponivel_total);
  assert.ok(5 <= b.calc.disponivel_total);
  await closeDb(db);
}

function test10NenhumWriterAlterado() {
  const portaSaldo = read(SRC.portaSaldo);
  const portaReserva = read(SRC.portaReserva);
  const baixa = read(SRC.baixa);
  const credito = read(SRC.creditoVenda);
  const reserva = read(SRC.reservaPdv);
  const compras = read(SRC.comprasCred);
  const ajuste = read(SRC.ajuste);
  const mts = read(SRC.mts);
  const comercial = read(SRC.comercial);
  const schema = read(SRC.schema);
  const backfill = read(SRC.backfill);

  assert.ok(portaSaldo.includes('aplicarEfeitoSaldo'));
  assert.ok(portaSaldo.includes('FROM produtos WHERE id = ?'));
  assert.ok(portaReserva.includes('aplicarEfeitoReservado'));
  assert.ok(baixa.includes('debitarEstoqueItemVenda'));
  assert.ok(credito.includes('empresaIdDoReqCreditoVenda') || credito.includes('resolverEmpresaId(req && req.empresaId)'));
  assert.ok(reserva.includes('reservasPublico'));
  assert.ok(compras.includes('creditarEstoqueItemCompra'));
  assert.ok(ajuste.includes('aplicarAjusteEstoqueProduto'));
  assert.ok(mts.includes('debitarSaldo'));
  assert.ok(comercial.includes('optsPortaSaldos'));
  assert.ok(schema.includes('CREATE TABLE IF NOT EXISTS estoque_empresa'));
  assert.ok(backfill.includes('executarBackfillProduto'));
}

async function main() {
  const testes = [
    ['01 auditoria identifica leitores', test01AuditoriaIdentificaLeitores],
    ['02 empresa A usa estoque_empresa A', test02EmpresaAUsaEstoqueEmpresa],
    ['03 empresa B permanece isolada', test03EmpresaBIsolada],
    ['04 registro inexistente retorna zero', test04RegistroInexistenteZero],
    ['05 nao faz fallback para produtos', test05SemFallbackParaProdutos],
    ['06 sem empresa mantem legado', test06SemEmpresaLegado],
    ['07 req.empresaId prevalece sobre body/query', test07ReqEmpresaIdPrevalece],
    ['08 reservados vem da empresa correta', test08ReservadosDaEmpresaCorreta],
    ['09 disponibilidade usa valores isolados', test09DisponibilidadeIsolada],
    ['10 nenhum writer foi alterado', test10NenhumWriterAlterado]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  ok ${nome}`);
  }
  console.log(`\nleitores-operacionais-multiempresa: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
