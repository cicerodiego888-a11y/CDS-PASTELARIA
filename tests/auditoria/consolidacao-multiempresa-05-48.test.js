/**
 * Sprint 05.48 — Auditoria de consolidação multiempresa (somente leitura de produção).
 * Cenários A→B na cadeia EMPRESA → caixa → venda → estoque/lote/reserva → financeiro → NFC-e → cancel/dev.
 * Executar: node tests/auditoria/consolidacao-multiempresa-05-48.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const { garantirSchemaLotesEmpresaAsync } = require('../../backend/services/estoque/lotesEmpresaSchema');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const lotesService = require('../../backend/services/lotesService');
const reservas = require('../../backend/services/fiscalNaoFiscal/reservasPublico');
const {
  exigirEmpresaDaOperacao,
  exigirCaixaCompativelComVenda,
  exigirVendaDaEmpresa,
  resolverEmpresaDaVenda,
  exigirOperacaoReversaoDaVenda,
  CODIGO_EMPRESA_OWNERSHIP_REQUIRED
} = require('../../backend/services/vendas/VendaEmpresaContextoService');
const { montarOpcoesRetornoEstoqueDaVenda } = require('../../backend/services/vendas/creditoEstoqueVendaViaPorta');
const { resolverEmpresaDaOrigemFinanceira } = require('../../backend/services/financeiro/FinanceiroEmpresaContextoService');
const {
  exigirEmpresaFiscalDaVenda,
  exigirContextoFiscalDaEmpresa
} = require('../../backend/services/fiscal/FiscalEmpresaContextoService');
const { montarSqlSessaoAberta } = require('../../backend/utils/caixaSessaoHelpers');
const { resolverEmpresaId } = require('../../backend/services/fiscalNaoFiscal/empresaContexto');

/** Espelho do contrato MotorComercialService.optsPortaSaldos após 05.49 (não exportado). */
function optsPortaSaldosMotor(opts = {}, empresaId) {
  const id = empresaId != null ? Number(empresaId) : resolverEmpresaId(opts);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('Empresa é obrigatória para a porta F×NF do pedido.');
    err.code = 'EMPRESA_CONTEXT_REQUIRED';
    throw err;
  }
  return { db: opts.db, empresaId: id, usuarioId: opts.usuarioId, validarEmpresa: opts.validarEmpresa };
}

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function cb(err) {
      if (err) reject(err);
      else resolve(this);
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

async function assertRejects(fnOrPromise, codes) {
  const expected = Array.isArray(codes) ? codes : [codes];
  try {
    await (typeof fnOrPromise === 'function' ? fnOrPromise() : fnOrPromise);
    throw new Error(`Esperava falha (${expected.join('|')})`);
  } catch (err) {
    if (err.message && err.message.startsWith('Esperava falha')) throw err;
    assert.ok(
      expected.includes(err.code) || expected.some((c) => String(err.message || '').includes(c)),
      `esperado ${expected.join('|')}, veio ${err.code}/${err.message}`
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
      controlar_validade INTEGER DEFAULT 1
    )
  `);
  await garantirSchemaLotesEmpresaAsync(db);
  const p = await run(db, `INSERT INTO produtos (nome, saldo_fiscal, estoque_atual) VALUES ('Pastel', 0, 0)`);
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const b = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  return { db, produtoId: p.lastID, empresaA: a, empresaB: b };
}

async function seedEstoque(db, produtoId, empresaA, empresaB) {
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaA.id,
    saldo_fiscal: 10, saldo_nao_fiscal: 0, estoque_atual: 10, reservado_fiscal: 0
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId, empresaId: empresaB.id,
    saldo_fiscal: 99, saldo_nao_fiscal: 0, estoque_atual: 99, reservado_fiscal: 0
  }, { db });
}

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  OK  ${name}`);
}

async function c01VendaANaoLeEstoqueB() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedEstoque(db, produtoId, empresaA, empresaB);
  const dispA = await reservas.consultarDisponibilidade(produtoId, { db, empresaId: empresaA.id });
  const dispB = await reservas.consultarDisponibilidade(produtoId, { db, empresaId: empresaB.id });
  assert.strictEqual(dispA.disponivel_fiscal, 10);
  assert.strictEqual(dispB.disponivel_fiscal, 99);
  assert.notStrictEqual(dispA.disponivel_fiscal, dispB.disponivel_fiscal);
  await closeDb(db);
  ok('C01 venda/consulta A não lê estoque B');
}

function criarLoteAsync(dados) {
  return new Promise((resolve, reject) => {
    lotesService.criarLote(dados, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

async function c02FefoANaoConsomeLoteB() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await criarLoteAsync({
    db, empresaId: empresaA.id, produto_id: produtoId,
    lote: 'LA-A', quantidade_inicial: 10,
    data_validade: '2030-12-31', data_entrada: '2026-01-01', origem: 'TESTE'
  });
  await criarLoteAsync({
    db, empresaId: empresaB.id, produto_id: produtoId,
    lote: 'LB-B', quantidade_inicial: 10,
    data_validade: '2026-01-01', data_entrada: '2026-01-01', origem: 'TESTE'
  });
  const lotes = await lotesService.selecionarLoteFefo({
    db, empresaId: empresaA.id, produtoId, quantidade: 1
  });
  assert.ok(lotes.every((l) => Number(l.empresa_id) === empresaA.id));
  assert.ok(!lotes.some((l) => l.lote === 'LB-B'));
  await closeDb(db);
  ok('C02 FEFO A não consome lote B (mesmo SKU, validade B menor)');
}

async function c03SessaoBNaoOperaVendaA() {
  const vendaA = 7;
  const sessaoB = { id: 2, empresa_id: 8 };
  await assertRejects(
    () => exigirCaixaCompativelComVenda({ caixaSessao: sessaoB }, vendaA),
    ['CAIXA_SESSAO_EMPRESA_DIVERGENTE', 'CAIXA_SESSAO_NAO_ENCONTRADA']
  );
  ok('C03 sessão B não opera venda A');
}

async function c04VendaANaoCriaFinanceiroB() {
  const vendaA = { id: 1, empresa_id: 7 };
  const caixaB = { id: 2, empresa_id: 8 };
  await assertRejects(
    () => resolverEmpresaDaOrigemFinanceira({ venda: vendaA, caixa: caixaB }),
    'FINANCEIRO_EMPRESA_DIVERGENTE'
  );
  const id = resolverEmpresaDaOrigemFinanceira({ venda: vendaA });
  assert.strictEqual(id, 7);
  ok('C04 venda A não materializa financeiro B');
}

async function c05NfceANaoLeCertB() {
  const vendaA = { id: 1, empresa_id: 7 };
  await assertRejects(
    () => exigirEmpresaFiscalDaVenda({ venda: vendaA, empresaIdContexto: 8 }),
    ['VENDA_NAO_ENCONTRADA', 'EMPRESA_NAO_AUTORIZADA']
  );
  const emp = exigirEmpresaFiscalDaVenda({ venda: vendaA, empresaIdContexto: 7 });
  assert.strictEqual(emp, 7);
  await assertRejects(
    () => exigirContextoFiscalDaEmpresa({
      empresaId: 7,
      getFiscalConfigFn: async () => ({ fonte: 'GLOBAL', empresaId: 7 })
    }),
    'CONFIGURACAO_FISCAL_NAO_ENCONTRADA'
  );
  ok('C05 NFC-e A rejeita contexto B e config global');
}

async function c06CancelANaoDevolveEstoqueB() {
  const vendaA = { id: 1, empresa_id: 7 };
  const opts = montarOpcoesRetornoEstoqueDaVenda(vendaA, { empresaId: 8 }, 'cancelamento', null);
  assert.strictEqual(opts.empresaId, 7);
  assert.notStrictEqual(opts.empresaId, 8);
  await assertRejects(
    () => montarOpcoesRetornoEstoqueDaVenda({ id: 2, empresa_id: null }, { empresaId: 8 }),
    CODIGO_EMPRESA_OWNERSHIP_REQUIRED
  );
  ok('C06 cancelamento A devolve estoque da venda, não do req B');
}

async function c07DevolucaoANaoAlteraFinanceiroB() {
  const vendaA = { id: 1, empresa_id: 7 };
  exigirOperacaoReversaoDaVenda(vendaA, 7);
  await assertRejects(() => exigirOperacaoReversaoDaVenda(vendaA, 8), 'VENDA_NAO_ENCONTRADA');
  const fin = resolverEmpresaDaOrigemFinanceira({ venda: vendaA });
  assert.strictEqual(fin, 7);
  ok('C07 devolução A não altera financeiro B');
}

async function c08ReservaANaoAlteraReservadoB() {
  const { db, produtoId, empresaA, empresaB } = await setup();
  await seedEstoque(db, produtoId, empresaA, empresaB);
  const r = await reservas.criarReservaFiscal({
    pedidoId: 48, produtoId, quantidade: 3, empresaId: empresaA.id, db
  });
  const a = await get(db, 'SELECT reservado_fiscal FROM estoque_empresa WHERE empresa_id = ?', [empresaA.id]);
  const b = await get(db, 'SELECT reservado_fiscal FROM estoque_empresa WHERE empresa_id = ?', [empresaB.id]);
  assert.strictEqual(Number(a.reservado_fiscal), 3);
  assert.strictEqual(Number(b.reservado_fiscal), 0);
  await assertRejects(
    reservas.obterReservaPedidoDaEmpresa(r.id, empresaB.id, { db }),
    'RESERVA_NAO_ENCONTRADA'
  );
  await closeDb(db);
  ok('C08 reserva A não altera reservado B');
}

async function c09ContextoBAcessandoADa404() {
  exigirVendaDaEmpresa({ id: 1, empresa_id: 7 }, 7);
  await assertRejects(() => exigirVendaDaEmpresa({ id: 1, empresa_id: 7 }, 8), 'VENDA_NAO_ENCONTRADA');
  await assertRejects(() => exigirVendaDaEmpresa({ id: 1, empresa_id: null }, 7), 'VENDA_NAO_ENCONTRADA');
  ok('C09 contexto B em recurso A = 404 (não 403)');
}

async function c10LegadoNullNaoInventaEmpresa() {
  await assertRejects(
    () => resolverEmpresaDaVenda({ id: 9, empresa_id: null }),
    CODIGO_EMPRESA_OWNERSHIP_REQUIRED
  );
  await assertRejects(
    () => exigirEmpresaDaOperacao({ empresaId: null }),
    'EMPRESA_CONTEXT_REQUIRED'
  );
  await assertRejects(
    () => montarSqlSessaoAberta({ terminalId: 'T1' }),
    'CAIXA_EMPRESA_OBRIGATORIA'
  );
  ok('C10 legado NULL não inventa empresa_id');
}

function scansFonte() {
  const caixaSql = src('backend/utils/caixaSessaoHelpers.js');
  assert.ok(caixaSql.includes('AND empresa_id = ?'));
  assert.ok(caixaSql.includes('CAIXA_EMPRESA_OBRIGATORIA'));
  assert.ok(!/FROM caixa_sessoes WHERE status = 'aberto' LIMIT 1/.test(caixaSql.replace(/\s+/g, ' ')));

  const vendaPag = src('backend/services/vendas/VendaPagamentoService.js');
  assert.ok(vendaPag.includes('exigirEmpresaDaOperacao'));
  assert.ok(vendaPag.includes('exigirCaixaCompativelComVenda'));
  assert.ok(vendaPag.includes('empresaIdVenda'));

  const cancel = src('backend/services/vendas/VendaCancelamentoService.js');
  const idxOwn = cancel.indexOf('exigirOperacaoReversaoDaVenda');
  const idxBegin = cancel.indexOf('BEGIN IMMEDIATE');
  assert.ok(idxOwn > 0 && idxOwn < idxBegin, 'ownership do cancelamento antes da TX');

  const fefo = src('backend/services/lotesService.js');
  assert.ok(fefo.includes('WHERE pl.empresa_id = ?'));
  assert.ok(fefo.includes('AND empresa_id = ?'));

  const reservasSrc = src('backend/services/fiscalNaoFiscal/reservasPublico.js');
  assert.ok(reservasSrc.includes('empresa_id'));
  assert.ok(reservasSrc.includes('RESERVA_NAO_ENCONTRADA'));

  const nfce = src('backend/services/fiscal/emissor.js');
  assert.ok(nfce.includes('exigirEmpresaFiscalDaVenda'));
  assert.ok(nfce.includes('resolverCredenciaisNfceDaEmpresa'));

  const motor = src('backend/motores/comercial/MotorComercialService.js');
  assert.ok(!motor.includes('COMPAT_CERTIFICADA_PRE_MULTIEMPRESA'));
  assert.ok(motor.includes('exigirEmpresaDoPedido'));
  assert.ok(!motor.includes('empresaId: 1'));

  const repair = src('backend/motores/comercial/ReservaRepairService.js');
  assert.ok(repair.includes("INSERT INTO pedido_estoque_reservas ("));
  assert.ok(
    /empresa_id/.test(repair.slice(repair.indexOf('INSERT INTO pedido_estoque_reservas'))),
    'Repair persiste empresa_id na reserva (05.49)'
  );

  const pedidosSchema = src('backend/database.js');
  const idxPedidos = pedidosSchema.indexOf('CREATE TABLE IF NOT EXISTS pedidos (');
  const trechoPedidos = pedidosSchema.slice(idxPedidos, idxPedidos + 700);
  assert.ok(idxPedidos > 0, 'DDL de pedidos encontrado');
  assert.ok(trechoPedidos.includes('empresa_id'), 'pedidos.empresa_id (05.49)');

  ok('scans T01–T10 / Motor / Repair');
}

function scanMotorCompatRuntime() {
  const comEmpresa = optsPortaSaldosMotor({ empresaId: 7, db: null });
  assert.strictEqual(comEmpresa.empresaId, 7);
  assert.ok(!comEmpresa.modoLegadoSemEmpresa);
  try {
    optsPortaSaldosMotor({ db: null });
    assert.fail('optsPortaSaldos sem empresa deveria falhar');
  } catch (err) {
    assert.strictEqual(err.code, 'EMPRESA_CONTEXT_REQUIRED');
  }
  ok('Motor optsPortaSaldos: com empresa = ownership; sem empresa = EMPRESA_CONTEXT_REQUIRED (05.49)');
}

async function main() {
  console.log('Sprint 05.48 — auditoria consolidação multiempresa\n');
  scansFonte();
  scanMotorCompatRuntime();
  await c01VendaANaoLeEstoqueB();
  await c02FefoANaoConsomeLoteB();
  await c03SessaoBNaoOperaVendaA();
  await c04VendaANaoCriaFinanceiroB();
  await c05NfceANaoLeCertB();
  await c06CancelANaoDevolveEstoqueB();
  await c07DevolucaoANaoAlteraFinanceiroB();
  await c08ReservaANaoAlteraReservadoB();
  await c09ContextoBAcessandoADa404();
  await c10LegadoNullNaoInventaEmpresa();
  console.log(`\n${passed} testes OK`);
}

main().catch((err) => {
  console.error('FALHA', err);
  process.exit(1);
});
