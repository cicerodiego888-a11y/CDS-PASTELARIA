/**
 * Sprint 04.04 — reserva atômica do atendimento MULTIEMPRESA.
 */
'use strict';

const assert = require('assert');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const {
  STATUS_ATENDIMENTO,
  STATUS_OPERACAO_EMPRESARIAL,
  STATUS_RESERVA_ATENDIMENTO
} = require('../../backend/motores/muv');
const atendimentoService = require('../../backend/motores/muv/AtendimentoMultiempresaService');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';
const CNPJ_C = '65957340000150';

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

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
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

function item(produtoId, empresaId, quantidade, valorUnitario = 10, tipoFiscal) {
  const base = { produtoId, empresaId, quantidade, valorUnitario };
  if (tipoFiscal) base.tipoFiscal = tipoFiscal;
  return base;
}

async function saldoEmp(db, produtoId, empresaId) {
  return EstoqueEmpresaService.consultarSaldoParaEmpresa({ produtoId, empresaId, db });
}

async function setupBase() {
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
    CREATE TABLE vendas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT,
      total REAL
    )
  `);
  const p = await run(
    db,
    `INSERT INTO produtos (nome, saldo_fiscal, saldo_nao_fiscal, estoque_atual)
     VALUES ('X', 999, 999, 1998)`
  );
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const b = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  const c = await EmpresaService.criarEmpresa({ cnpj: CNPJ_C, razao_social: 'C' }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: p.lastID, empresaId: a.id,
    saldo_fiscal: 20, saldo_nao_fiscal: 5, reservado_fiscal: 0, reservado_nao_fiscal: 0, estoque_atual: 25
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: p.lastID, empresaId: b.id,
    saldo_fiscal: 6, saldo_nao_fiscal: 4, reservado_fiscal: 0, reservado_nao_fiscal: 0, estoque_atual: 10
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: p.lastID, empresaId: c.id,
    saldo_fiscal: 15, saldo_nao_fiscal: 8, reservado_fiscal: 0, reservado_nao_fiscal: 0, estoque_atual: 23
  }, { db });
  return { db, produtoId: p.lastID, empresaA: a, empresaB: b, empresaC: c };
}

function mockRes() {
  const state = { statusCode: null, body: null };
  return {
    state,
    status(code) {
      state.statusCode = code;
      return this;
    },
    json(payload) {
      state.body = payload;
      return payload;
    }
  };
}

function loadAppWithFakePagamento() {
  const pagamentoPath = require.resolve('../../backend/services/vendas/VendaPagamentoService');
  const appPath = path.resolve(__dirname, '../../backend/services/vendas/VendaApplicationService.js');
  const originalPag = require.cache[pagamentoPath];
  const originalApp = require.cache[appPath];
  let pagamentoChamado = 0;
  require.cache[pagamentoPath] = {
    id: pagamentoPath,
    filename: pagamentoPath,
    loaded: true,
    exports: {
      criarVenda() {
        pagamentoChamado += 1;
        return 'DELEGATED_PDV';
      }
    }
  };
  delete require.cache[appPath];
  const app = require('../../backend/services/vendas/VendaApplicationService');
  return {
    app,
    getPagamentoChamado: () => pagamentoChamado,
    restore() {
      if (originalPag) require.cache[pagamentoPath] = originalPag;
      else delete require.cache[pagamentoPath];
      if (originalApp) require.cache[appPath] = originalApp;
      else delete require.cache[appPath];
    }
  };
}

async function criarValidado(db, itens) {
  return atendimentoService.criarAtendimento({ origem: 'PDV', itens }, { db });
}

function reservaDaEmpresa(r, empresaId) {
  const op = r.operacoes.find((o) => o.empresaId === empresaId);
  assert.ok(op, `operação da empresa ${empresaId} ausente`);
  return op;
}

async function test01ReservaUmaEmpresa() {
  const { db, produtoId, empresaA } = await setupBase();
  const atd = await criarValidado(db, [item(produtoId, empresaA.id, 2)]);
  const r = await atendimentoService.reservarAtendimento(atd.atendimentoId, { db });
  assert.strictEqual(r.status, STATUS_ATENDIMENTO.RESERVADO);
  assert.strictEqual(r.pagamento_pendente, true);
  assert.strictEqual(r.venda_concluida, false);
  const op = reservaDaEmpresa(r, empresaA.id);
  assert.strictEqual(op.status, STATUS_OPERACAO_EMPRESARIAL.RESERVADA);
  assert.strictEqual(op.reservas.length, 1);
  assert.strictEqual(op.reservas[0].empresaId, empresaA.id);
  assert.strictEqual(op.reservas[0].quantidadeFiscal, 2);
  const s = await saldoEmp(db, produtoId, empresaA.id);
  assert.strictEqual(s.reservadoFiscal, 2);
  await closeDb(db);
}

async function test02ReservaDuasEmpresas() {
  const { db, produtoId, empresaA, empresaB } = await setupBase();
  const atd = await criarValidado(db, [
    item(produtoId, empresaA.id, 2),
    item(produtoId, empresaB.id, 3)
  ]);
  const r = await atendimentoService.reservarAtendimento(atd.atendimentoId, { db });
  assert.strictEqual(r.operacoes.length, 2);
  assert.strictEqual((await saldoEmp(db, produtoId, empresaA.id)).reservadoFiscal, 2);
  assert.strictEqual((await saldoEmp(db, produtoId, empresaB.id)).reservadoFiscal, 3);
  await closeDb(db);
}

async function test03ReservaTresEmpresas() {
  const { db, produtoId, empresaA, empresaB, empresaC } = await setupBase();
  const atd = await criarValidado(db, [
    item(produtoId, empresaA.id, 2),
    item(produtoId, empresaB.id, 6),
    item(produtoId, empresaC.id, 4)
  ]);
  const r = await atendimentoService.reservarAtendimento(atd.atendimentoId, { db });
  assert.strictEqual(r.status, 'RESERVADO');
  assert.strictEqual(r.operacoes.length, 3);
  assert.strictEqual((await saldoEmp(db, produtoId, empresaA.id)).reservadoFiscal, 2);
  assert.strictEqual((await saldoEmp(db, produtoId, empresaB.id)).reservadoFiscal, 6);
  assert.strictEqual((await saldoEmp(db, produtoId, empresaC.id)).reservadoFiscal, 4);
  await closeDb(db);
}

async function test04MesmoProdutoEmpresasDiferentes() {
  const { db, produtoId, empresaA, empresaB, empresaC } = await setupBase();
  const atd = await criarValidado(db, [
    item(produtoId, empresaA.id, 2),
    item(produtoId, empresaB.id, 6)
  ]);
  await atendimentoService.reservarAtendimento(atd.atendimentoId, { db });
  assert.strictEqual((await saldoEmp(db, produtoId, empresaC.id)).reservadoFiscal, 0);
  await closeDb(db);
}

async function test05IsolamentoAB() {
  const { db, produtoId, empresaA, empresaB } = await setupBase();
  const atd = await criarValidado(db, [
    item(produtoId, empresaA.id, 2, 10, 'FISCAL'),
    item(produtoId, empresaB.id, 6, 10, 'FISCAL')
  ]);
  const segundo = await criarValidado(db, [item(produtoId, empresaB.id, 1, 10, 'FISCAL')]);
  await atendimentoService.reservarAtendimento(atd.atendimentoId, { db });
  await assertRejects(
    atendimentoService.reservarAtendimento(segundo.atendimentoId, { db }),
    'SALDO_INSUFICIENTE'
  );
  const sA = await saldoEmp(db, produtoId, empresaA.id);
  assert.strictEqual(sA.reservadoFiscal, 2);
  const sB = await saldoEmp(db, produtoId, empresaB.id);
  assert.strictEqual(sB.reservadoFiscal, 6);
  const cab2 = await get(db, 'SELECT status FROM atendimentos WHERE id = ?', [segundo.atendimentoId]);
  assert.strictEqual(cab2.status, 'VALIDADO');
  await closeDb(db);
}

async function test06EstoqueSuficiente() {
  const { db, produtoId, empresaA } = await setupBase();
  const atd = await criarValidado(db, [item(produtoId, empresaA.id, 20)]);
  const r = await atendimentoService.reservarAtendimento(atd.atendimentoId, { db });
  assert.strictEqual(r.status, 'RESERVADO');
  await closeDb(db);
}

async function test07EstoqueInsuficiente() {
  const { db, produtoId, empresaB } = await setupBase();
  const atd = await criarValidado(db, [item(produtoId, empresaB.id, 6, 10, 'FISCAL')]);
  const segundo = await criarValidado(db, [item(produtoId, empresaB.id, 1, 10, 'FISCAL')]);
  await atendimentoService.reservarAtendimento(atd.atendimentoId, { db });
  await assertRejects(
    atendimentoService.reservarAtendimento(segundo.atendimentoId, { db }),
    'SALDO_INSUFICIENTE'
  );
  await closeDb(db);
}

async function test08SaldoLegadoNaoAutoriza() {
  const { db, produtoId, empresaA } = await setupBase();
  const d = await EmpresaService.criarEmpresa({ cnpj: '47627408000151', razao_social: 'D' }, { db });
  const prod = await get(db, 'SELECT saldo_fiscal FROM produtos WHERE id = ?', [produtoId]);
  assert.ok(prod.saldo_fiscal >= 999);
  await assertRejects(
    criarValidado(db, [item(produtoId, d.id, 1)]),
    'SALDO_INSUFICIENTE'
  );
  const n = await get(db, 'SELECT COUNT(*) AS q FROM atendimentos');
  assert.strictEqual(n.q, 0);
  assert.strictEqual(empresaA.id, 1);
  await closeDb(db);
}

async function test09EmpresaSemRegistroZero() {
  const { db, produtoId } = await setupBase();
  const d = await EmpresaService.criarEmpresa({ cnpj: '47627408000151', razao_social: 'D' }, { db });
  const existe = await EstoqueEmpresaService.existeRegistro({ produtoId, empresaId: d.id }, { db });
  assert.strictEqual(existe, false);
  await assertRejects(
    criarValidado(db, [item(produtoId, d.id, 1)]),
    'SALDO_INSUFICIENTE'
  );
  await closeDb(db);
}

async function test10RollbackQuandoOperacaoFalha() {
  const { db, produtoId, empresaA, empresaB, empresaC } = await setupBase();
  const atd = await criarValidado(db, [
    item(produtoId, empresaA.id, 2),
    item(produtoId, empresaB.id, 1),
    item(produtoId, empresaC.id, 1)
  ]);
  let chamadas = 0;
  await assertRejects(
    atendimentoService.reservarAtendimento(atd.atendimentoId, {
      db,
      reservarQuantidade() {
        chamadas += 1;
        if (chamadas >= 3) {
          const err = new Error('falha C');
          err.code = 'SALDO_INSUFICIENTE';
          err.statusCode = 409;
          throw err;
        }
        return Promise.resolve({});
      }
    }),
    'SALDO_INSUFICIENTE'
  );
  const cab = await get(db, 'SELECT status FROM atendimentos WHERE id = ?', [atd.atendimentoId]);
  assert.strictEqual(cab.status, 'VALIDADO');
  assert.strictEqual((await saldoEmp(db, produtoId, empresaA.id)).reservadoFiscal, 0);
  assert.strictEqual((await saldoEmp(db, produtoId, empresaB.id)).reservadoFiscal, 0);
  assert.strictEqual((await saldoEmp(db, produtoId, empresaC.id)).reservadoFiscal, 0);
  await closeDb(db);
}

async function test11NenhumRegistroOrfao() {
  const { db, produtoId, empresaA, empresaB } = await setupBase();
  const atd = await criarValidado(db, [
    item(produtoId, empresaA.id, 2),
    item(produtoId, empresaB.id, 1)
  ]);
  await assertRejects(
    atendimentoService.reservarAtendimento(atd.atendimentoId, {
      db,
      aposReservarParcial() {
        const err = new Error('falha forçada');
        err.code = 'ATENDIMENTO_INVALIDO';
        throw err;
      }
    }),
    'ATENDIMENTO_INVALIDO'
  );
  const n = await get(db, 'SELECT COUNT(*) AS q FROM atendimento_operacao_reservas');
  assert.strictEqual(n.q, 0);
  assert.strictEqual((await saldoEmp(db, produtoId, empresaA.id)).reservadoFiscal, 0);
  await closeDb(db);
}

async function test12IdempotenciaReserva() {
  const { db, produtoId, empresaA } = await setupBase();
  const atd = await criarValidado(db, [item(produtoId, empresaA.id, 6)]);
  await atendimentoService.reservarAtendimento(atd.atendimentoId, { db });
  const r2 = await atendimentoService.reservarAtendimento(atd.atendimentoId, { db });
  assert.strictEqual(r2.status, 'RESERVADO');
  assert.strictEqual(r2.idempotente, true);
  assert.strictEqual((await saldoEmp(db, produtoId, empresaA.id)).reservadoFiscal, 6);
  const n = await get(db, 'SELECT COUNT(*) AS q FROM atendimento_operacao_reservas WHERE status = ?', ['ATIVA']);
  assert.strictEqual(n.q, 1);
  await closeDb(db);
}

async function test13IdempotenciaLiberacao() {
  const { db, produtoId, empresaA } = await setupBase();
  const atd = await criarValidado(db, [item(produtoId, empresaA.id, 6)]);
  await atendimentoService.reservarAtendimento(atd.atendimentoId, { db });
  await atendimentoService.cancelarAtendimento(atd.atendimentoId, { db });
  const r2 = await atendimentoService.cancelarAtendimento(atd.atendimentoId, { db });
  assert.strictEqual(r2.status, 'CANCELADO');
  assert.strictEqual(r2.liberacao, 'RESERVA_JA_LIBERADA');
  assert.strictEqual((await saldoEmp(db, produtoId, empresaA.id)).reservadoFiscal, 0);
  await closeDb(db);
}

async function test14CancelamentoLiberaTodas() {
  const { db, produtoId, empresaA, empresaB, empresaC } = await setupBase();
  const atd = await criarValidado(db, [
    item(produtoId, empresaA.id, 2),
    item(produtoId, empresaB.id, 3),
    item(produtoId, empresaC.id, 4)
  ]);
  await atendimentoService.reservarAtendimento(atd.atendimentoId, { db });
  const r = await atendimentoService.cancelarAtendimento(atd.atendimentoId, { db });
  assert.strictEqual(r.status, STATUS_ATENDIMENTO.CANCELADO);
  assert.ok(r.operacoes.every((o) => o.status === STATUS_OPERACAO_EMPRESARIAL.CANCELADA));
  assert.strictEqual((await saldoEmp(db, produtoId, empresaA.id)).reservadoFiscal, 0);
  assert.strictEqual((await saldoEmp(db, produtoId, empresaB.id)).reservadoFiscal, 0);
  assert.strictEqual((await saldoEmp(db, produtoId, empresaC.id)).reservadoFiscal, 0);
  const ativas = await get(db, `SELECT COUNT(*) AS q FROM atendimento_operacao_reservas WHERE status = 'ATIVA'`);
  assert.strictEqual(ativas.q, 0);
  await closeDb(db);
}

async function test15CancelamentoNaoAfetaOutraEmpresa() {
  const { db, produtoId, empresaA, empresaB } = await setupBase();
  const atd1 = await criarValidado(db, [item(produtoId, empresaA.id, 5)]);
  const atd2 = await criarValidado(db, [item(produtoId, empresaB.id, 3)]);
  await atendimentoService.reservarAtendimento(atd1.atendimentoId, { db });
  await atendimentoService.reservarAtendimento(atd2.atendimentoId, { db });
  await atendimentoService.cancelarAtendimento(atd1.atendimentoId, { db });
  assert.strictEqual((await saldoEmp(db, produtoId, empresaA.id)).reservadoFiscal, 0);
  assert.strictEqual((await saldoEmp(db, produtoId, empresaB.id)).reservadoFiscal, 3);
  const cab2 = await get(db, 'SELECT status FROM atendimentos WHERE id = ?', [atd2.atendimentoId]);
  assert.strictEqual(cab2.status, 'RESERVADO');
  await closeDb(db);
}

async function test16ReservaFiscal() {
  const { db, produtoId, empresaA } = await setupBase();
  const atd = await criarValidado(db, [item(produtoId, empresaA.id, 4, 10, 'FISCAL')]);
  const r = await atendimentoService.reservarAtendimento(atd.atendimentoId, { db });
  const reserva = r.operacoes[0].reservas[0];
  assert.strictEqual(reserva.quantidadeFiscal, 4);
  assert.strictEqual(reserva.quantidadeNaoFiscal, 0);
  const s = await saldoEmp(db, produtoId, empresaA.id);
  assert.strictEqual(s.reservadoFiscal, 4);
  assert.strictEqual(s.reservadoNaoFiscal, 0);
  await closeDb(db);
}

async function test17ReservaNaoFiscal() {
  const { db, produtoId, empresaA } = await setupBase();
  const atd = await criarValidado(db, [item(produtoId, empresaA.id, 3, 10, 'NAO_FISCAL')]);
  const r = await atendimentoService.reservarAtendimento(atd.atendimentoId, { db });
  const reserva = r.operacoes[0].reservas[0];
  assert.strictEqual(reserva.quantidadeFiscal, 0);
  assert.strictEqual(reserva.quantidadeNaoFiscal, 3);
  const s = await saldoEmp(db, produtoId, empresaA.id);
  assert.strictEqual(s.reservadoFiscal, 0);
  assert.strictEqual(s.reservadoNaoFiscal, 3);
  await closeDb(db);
}

async function test18MisturaFiscalNaoFiscal() {
  const { db, produtoId, empresaA } = await setupBase();
  const atd = await criarValidado(db, [item(produtoId, empresaA.id, 22, 10, 'TOTAL')]);
  const r = await atendimentoService.reservarAtendimento(atd.atendimentoId, { db });
  const reserva = r.operacoes[0].reservas[0];
  assert.strictEqual(reserva.quantidadeFiscal, 20);
  assert.strictEqual(reserva.quantidadeNaoFiscal, 2);
  const s = await saldoEmp(db, produtoId, empresaA.id);
  assert.strictEqual(s.reservadoFiscal, 20);
  assert.strictEqual(s.reservadoNaoFiscal, 2);
  await closeDb(db);
}

async function test19EmpresaUnicaInalterado() {
  const { app, getPagamentoChamado, restore } = loadAppWithFakePagamento();
  try {
    const req = { body: { total: 10, itens: [] } };
    const res = mockRes();
    const result = app.criarVenda(req, res, {
      obterModoOperacaoVenda: () => 'EMPRESA_UNICA'
    });
    assert.strictEqual(result, 'DELEGATED_PDV');
    assert.strictEqual(getPagamentoChamado(), 1);
  } finally {
    restore();
  }
}

async function test20MultiempresaNaoCriaVendas() {
  const { db, produtoId, empresaA, empresaB } = await setupBase();
  const atd = await criarValidado(db, [
    item(produtoId, empresaA.id, 1),
    item(produtoId, empresaB.id, 1)
  ]);
  await atendimentoService.reservarAtendimento(atd.atendimentoId, { db });
  const n = await get(db, 'SELECT COUNT(*) AS q FROM vendas');
  assert.strictEqual(n.q, 0);
  await closeDb(db);
}

async function test21MultiempresaNaoChamaPagamento() {
  const { db, produtoId, empresaA } = await setupBase();
  const { app, getPagamentoChamado, restore } = loadAppWithFakePagamento();
  try {
    const req = { body: { origem: 'PDV', itens: [item(produtoId, empresaA.id, 1, 10)] } };
    const res = mockRes();
    await app.criarVenda(req, res, {
      obterModoOperacaoVenda: () => 'MULTIEMPRESA',
      db
    });
    const id = res.state.body.atendimentoId;
    await atendimentoService.reservarAtendimento(id, { db });
    assert.strictEqual(getPagamentoChamado(), 0);
  } finally {
    restore();
    await closeDb(db);
  }
}

async function test22TransacaoPreservaConsistencia() {
  const { db, produtoId, empresaA, empresaB } = await setupBase();
  const atd = await criarValidado(db, [
    item(produtoId, empresaA.id, 2),
    item(produtoId, empresaB.id, 2)
  ]);
  await assertRejects(
    atendimentoService.reservarAtendimento(atd.atendimentoId, {
      db,
      aposReservarParcial() {
        const err = new Error('quebra');
        err.code = 'ATENDIMENTO_INVALIDO';
        throw err;
      }
    }),
    'ATENDIMENTO_INVALIDO'
  );
  const cab = await get(db, 'SELECT status FROM atendimentos WHERE id = ?', [atd.atendimentoId]);
  const ops = await all(db, 'SELECT status FROM atendimento_operacoes WHERE atendimento_id = ?', [atd.atendimentoId]);
  assert.strictEqual(cab.status, 'VALIDADO');
  assert.ok(ops.every((o) => o.status === 'VALIDADA'));
  const reservas = await all(db, 'SELECT * FROM atendimento_operacao_reservas');
  assert.strictEqual(reservas.length, 0);
  await closeDb(db);
}

async function test23CanceladoNaoReserva() {
  const { db, produtoId, empresaA } = await setupBase();
  const atd = await criarValidado(db, [item(produtoId, empresaA.id, 2)]);
  await atendimentoService.reservarAtendimento(atd.atendimentoId, { db });
  await atendimentoService.cancelarAtendimento(atd.atendimentoId, { db });
  await assertRejects(
    atendimentoService.reservarAtendimento(atd.atendimentoId, { db }),
    'ATENDIMENTO_CANCELADO'
  );
  assert.strictEqual((await saldoEmp(db, produtoId, empresaA.id)).reservadoFiscal, 0);
  await closeDb(db);
}

async function test24OperacaoNaoDuplica() {
  const { db, produtoId, empresaA } = await setupBase();
  const atd = await criarValidado(db, [item(produtoId, empresaA.id, 4)]);
  await atendimentoService.reservarAtendimento(atd.atendimentoId, { db });
  await atendimentoService.reservarAtendimento(atd.atendimentoId, { db });
  const rows = await all(db, 'SELECT * FROM atendimento_operacao_reservas');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].status, STATUS_RESERVA_ATENDIMENTO.ATIVA);
  assert.strictEqual((await saldoEmp(db, produtoId, empresaA.id)).reservadoFiscal, 4);
  await closeDb(db);
}

async function test25ConcorrenciaSerializadaNaoSuperaSaldo() {
  const { db, produtoId, empresaB } = await setupBase();
  const a1 = await criarValidado(db, [item(produtoId, empresaB.id, 6, 10, 'FISCAL')]);
  const a2 = await criarValidado(db, [item(produtoId, empresaB.id, 6, 10, 'FISCAL')]);
  await atendimentoService.reservarAtendimento(a1.atendimentoId, { db });
  await assertRejects(
    atendimentoService.reservarAtendimento(a2.atendimentoId, { db }),
    'SALDO_INSUFICIENTE'
  );
  assert.strictEqual((await saldoEmp(db, produtoId, empresaB.id)).reservadoFiscal, 6);
  const cab2 = await get(db, 'SELECT status FROM atendimentos WHERE id = ?', [a2.atendimentoId]);
  assert.strictEqual(cab2.status, 'VALIDADO');
  const nAtivas = await get(db, `SELECT COUNT(*) AS q FROM atendimento_operacao_reservas WHERE status = 'ATIVA'`);
  assert.strictEqual(nAtivas.q, 1);
  await closeDb(db);
}

async function test26ContratoNaoMisturaEmpresas() {
  const { db, produtoId, empresaA, empresaB } = await setupBase();
  const atd = await criarValidado(db, [
    item(produtoId, empresaA.id, 2),
    item(produtoId, empresaB.id, 1)
  ]);
  const r = await atendimentoService.reservarAtendimento(atd.atendimentoId, { db });
  for (const op of r.operacoes) {
    assert.ok(op.reservas.every((res) => res.empresaId === op.empresaId));
  }
  await closeDb(db);
}

async function test27CancelamentoRollbackTotal() {
  const { db, produtoId, empresaA, empresaB } = await setupBase();
  const atd = await criarValidado(db, [
    item(produtoId, empresaA.id, 2),
    item(produtoId, empresaB.id, 2)
  ]);
  await atendimentoService.reservarAtendimento(atd.atendimentoId, { db });
  await assertRejects(
    atendimentoService.cancelarAtendimento(atd.atendimentoId, {
      db,
      aposCancelarParcial() {
        const err = new Error('falha cancel');
        err.code = 'ATENDIMENTO_INVALIDO';
        throw err;
      }
    }),
    'ATENDIMENTO_INVALIDO'
  );
  const cab = await get(db, 'SELECT status FROM atendimentos WHERE id = ?', [atd.atendimentoId]);
  assert.strictEqual(cab.status, 'RESERVADO');
  assert.strictEqual((await saldoEmp(db, produtoId, empresaA.id)).reservadoFiscal, 2);
  assert.strictEqual((await saldoEmp(db, produtoId, empresaB.id)).reservadoFiscal, 2);
  await closeDb(db);
}

async function main() {
  const testes = [
    ['01 reserva de uma empresa', test01ReservaUmaEmpresa],
    ['02 reserva de duas empresas', test02ReservaDuasEmpresas],
    ['03 reserva de três empresas', test03ReservaTresEmpresas],
    ['04 mesmo produto em empresas diferentes', test04MesmoProdutoEmpresasDiferentes],
    ['05 isolamento A/B', test05IsolamentoAB],
    ['06 estoque suficiente', test06EstoqueSuficiente],
    ['07 estoque insuficiente', test07EstoqueInsuficiente],
    ['08 saldo legado alto não autoriza empresa sem saldo', test08SaldoLegadoNaoAutoriza],
    ['09 empresa sem estoque_empresa = zero', test09EmpresaSemRegistroZero],
    ['10 rollback quando uma operação falha', test10RollbackQuandoOperacaoFalha],
    ['11 nenhum registro órfão', test11NenhumRegistroOrfao],
    ['12 idempotência da reserva', test12IdempotenciaReserva],
    ['13 idempotência da liberação', test13IdempotenciaLiberacao],
    ['14 cancelamento libera todas as empresas', test14CancelamentoLiberaTodas],
    ['15 cancelamento não afeta estoque de outra empresa', test15CancelamentoNaoAfetaOutraEmpresa],
    ['16 reserva fiscal', test16ReservaFiscal],
    ['17 reserva não fiscal', test17ReservaNaoFiscal],
    ['18 mistura fiscal/não fiscal', test18MisturaFiscalNaoFiscal],
    ['19 EMPRESA_UNICA permanece inalterado', test19EmpresaUnicaInalterado],
    ['20 MULTIEMPRESA não cria vendas', test20MultiempresaNaoCriaVendas],
    ['21 MULTIEMPRESA não chama pagamento', test21MultiempresaNaoChamaPagamento],
    ['22 transação preserva consistência', test22TransacaoPreservaConsistencia],
    ['23 atendimento cancelado não volta a reservar', test23CanceladoNaoReserva],
    ['24 operação já reservada não duplica', test24OperacaoNaoDuplica],
    ['25 tentativas serializadas não superam o saldo', test25ConcorrenciaSerializadaNaoSuperaSaldo],
    ['26 contrato não mistura reservas entre empresas', test26ContratoNaoMisturaEmpresas],
    ['27 cancelamento com falha faz rollback total', test27CancelamentoRollbackTotal]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  ok ${nome}`);
  }
  console.log(`\nreserva-atendimento-multiempresa-04-04: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
