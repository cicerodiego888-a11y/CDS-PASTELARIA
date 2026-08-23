/**
 * Sprint 04.06 — materialização das operações empresariais em vendas reais.
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

function item(produtoId, empresaId, quantidade, valorUnitario, tipoFiscal) {
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
      data_venda TEXT,
      total REAL,
      desconto REAL DEFAULT 0,
      forma_pagamento TEXT,
      status TEXT,
      status_pagamento TEXT,
      origem TEXT
    )
  `);
  await run(db, `
    CREATE TABLE vendas_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venda_id INTEGER,
      produto_id INTEGER,
      quantidade REAL,
      preco_unitario REAL,
      subtotal REAL
    )
  `);
  await run(db, `
    CREATE TABLE venda_pagamentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venda_id INTEGER,
      forma_pagamento TEXT,
      valor REAL
    )
  `);
  await run(db, `
    CREATE TABLE financeiro (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venda_id INTEGER,
      tipo TEXT,
      origem TEXT,
      valor REAL,
      status TEXT
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
    saldo_fiscal: 20, saldo_nao_fiscal: 5, estoque_atual: 25
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: p.lastID, empresaId: b.id,
    saldo_fiscal: 6, saldo_nao_fiscal: 4, estoque_atual: 10
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: p.lastID, empresaId: c.id,
    saldo_fiscal: 15, saldo_nao_fiscal: 8, estoque_atual: 23
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

async function pagoABC(ctx, pagamentos) {
  const { db, produtoId, empresaA, empresaB, empresaC } = ctx;
  const atd = await atendimentoService.criarAtendimento({
    itens: [
      item(produtoId, empresaA.id, 1, 12),
      item(produtoId, empresaB.id, 1, 18),
      item(produtoId, empresaC.id, 1, 21)
    ]
  }, { db });
  await atendimentoService.reservarAtendimento(atd.atendimentoId, { db });
  return atendimentoService.confirmarPagamentoAtendimento(atd.atendimentoId, {
    pagamentos: pagamentos || [{ formaPagamento: 'pix', valor: 51 }]
  }, { db });
}

async function test01MaterializaABC() {
  const ctx = await setupBase();
  const pago = await pagoABC(ctx);
  const r = await atendimentoService.materializarAtendimento(pago.atendimentoId, {}, { db: ctx.db });
  assert.strictEqual(r.status, STATUS_ATENDIMENTO.CONCLUIDO);
  assert.strictEqual(r.venda_concluida, true);
  assert.strictEqual(r.operacoes.length, 3);
  assert.ok(r.operacoes.every((o) => o.status === STATUS_OPERACAO_EMPRESARIAL.CONCLUIDA));
  await closeDb(ctx.db);
}

async function test02UmaVendaPorEmpresa() {
  const ctx = await setupBase();
  const pago = await pagoABC(ctx);
  await atendimentoService.materializarAtendimento(pago.atendimentoId, {}, { db: ctx.db });
  const vendas = await all(ctx.db, 'SELECT * FROM vendas');
  assert.strictEqual(vendas.length, 3);
  const ops = await all(ctx.db, 'SELECT venda_id, empresa_id FROM atendimento_operacoes');
  assert.strictEqual(new Set(ops.map((o) => o.venda_id)).size, 3);
  await closeDb(ctx.db);
}

async function test03ItensCorretos() {
  const ctx = await setupBase();
  const pago = await pagoABC(ctx);
  await atendimentoService.materializarAtendimento(pago.atendimentoId, {}, { db: ctx.db });
  const itens = await all(ctx.db, 'SELECT * FROM vendas_itens');
  assert.strictEqual(itens.length, 3);
  assert.ok(itens.every((i) => i.produto_id === ctx.produtoId));
  await closeDb(ctx.db);
}

async function test04EmpresaCorreta() {
  const ctx = await setupBase();
  const pago = await pagoABC(ctx);
  const r = await atendimentoService.materializarAtendimento(pago.atendimentoId, {}, { db: ctx.db });
  for (const op of r.operacoes) {
    const venda = await get(ctx.db, 'SELECT * FROM vendas WHERE id = ?', [op.vendaId]);
    assert.ok(venda);
    assert.strictEqual(Number(venda.total), op.subtotal);
  }
  await closeDb(ctx.db);
}

async function test05EstoqueAIsolado() {
  const ctx = await setupBase();
  const pago = await pagoABC(ctx);
  const antesB = await saldoEmp(ctx.db, ctx.produtoId, ctx.empresaB.id);
  await atendimentoService.materializarAtendimento(pago.atendimentoId, {}, { db: ctx.db });
  const depoisA = await saldoEmp(ctx.db, ctx.produtoId, ctx.empresaA.id);
  const depoisB = await saldoEmp(ctx.db, ctx.produtoId, ctx.empresaB.id);
  assert.strictEqual(depoisA.saldoFiscal, 19);
  assert.strictEqual(depoisB.saldoFiscal, antesB.saldoFiscal - 1);
  await closeDb(ctx.db);
}

async function test06EstoqueBIsolado() {
  const ctx = await setupBase();
  const pago = await pagoABC(ctx);
  await atendimentoService.materializarAtendimento(pago.atendimentoId, {}, { db: ctx.db });
  const b = await saldoEmp(ctx.db, ctx.produtoId, ctx.empresaB.id);
  assert.strictEqual(b.saldoFiscal, 5);
  await closeDb(ctx.db);
}

async function test07EstoqueCIsolado() {
  const ctx = await setupBase();
  const pago = await pagoABC(ctx);
  await atendimentoService.materializarAtendimento(pago.atendimentoId, {}, { db: ctx.db });
  const c = await saldoEmp(ctx.db, ctx.produtoId, ctx.empresaC.id);
  assert.strictEqual(c.saldoFiscal, 14);
  await closeDb(ctx.db);
}

async function test08LegadoNaoAutoriza() {
  const ctx = await setupBase();
  const pago = await pagoABC(ctx);
  const prod = await get(ctx.db, 'SELECT saldo_fiscal FROM produtos WHERE id = ?', [ctx.produtoId]);
  assert.ok(prod.saldo_fiscal >= 999);
  await atendimentoService.materializarAtendimento(pago.atendimentoId, {}, { db: ctx.db });
  const a = await saldoEmp(ctx.db, ctx.produtoId, ctx.empresaA.id);
  assert.strictEqual(a.saldoFiscal, 19);
  await closeDb(ctx.db);
}

async function test09ReservaFiscalConsumida() {
  const ctx = await setupBase();
  const atd = await atendimentoService.criarAtendimento({
    itens: [item(ctx.produtoId, ctx.empresaA.id, 2, 10, 'FISCAL')]
  }, { db: ctx.db });
  await atendimentoService.reservarAtendimento(atd.atendimentoId, { db: ctx.db });
  await atendimentoService.confirmarPagamentoAtendimento(atd.atendimentoId, {
    pagamentos: [{ formaPagamento: 'pix', valor: 20 }]
  }, { db: ctx.db });
  await atendimentoService.materializarAtendimento(atd.atendimentoId, {}, { db: ctx.db });
  const res = await get(ctx.db, `SELECT status FROM atendimento_operacao_reservas`);
  assert.strictEqual(res.status, STATUS_RESERVA_ATENDIMENTO.CONSUMIDA);
  const s = await saldoEmp(ctx.db, ctx.produtoId, ctx.empresaA.id);
  assert.strictEqual(s.reservadoFiscal, 0);
  assert.strictEqual(s.saldoFiscal, 18);
  await closeDb(ctx.db);
}

async function test10ReservaNaoFiscalConsumida() {
  const ctx = await setupBase();
  const atd = await atendimentoService.criarAtendimento({
    itens: [item(ctx.produtoId, ctx.empresaA.id, 2, 10, 'NAO_FISCAL')]
  }, { db: ctx.db });
  await atendimentoService.reservarAtendimento(atd.atendimentoId, { db: ctx.db });
  await atendimentoService.confirmarPagamentoAtendimento(atd.atendimentoId, {
    pagamentos: [{ formaPagamento: 'dinheiro', valor: 20 }]
  }, { db: ctx.db });
  await atendimentoService.materializarAtendimento(atd.atendimentoId, {}, { db: ctx.db });
  const s = await saldoEmp(ctx.db, ctx.produtoId, ctx.empresaA.id);
  assert.strictEqual(s.reservadoNaoFiscal, 0);
  assert.strictEqual(s.saldoNaoFiscal, 3);
  await closeDb(ctx.db);
}

async function test11ReservaTotal() {
  const ctx = await setupBase();
  const atd = await atendimentoService.criarAtendimento({
    itens: [item(ctx.produtoId, ctx.empresaA.id, 22, 1, 'TOTAL')]
  }, { db: ctx.db });
  await atendimentoService.reservarAtendimento(atd.atendimentoId, { db: ctx.db });
  await atendimentoService.confirmarPagamentoAtendimento(atd.atendimentoId, {
    pagamentos: [{ formaPagamento: 'pix', valor: 22 }]
  }, { db: ctx.db });
  await atendimentoService.materializarAtendimento(atd.atendimentoId, {}, { db: ctx.db });
  const s = await saldoEmp(ctx.db, ctx.produtoId, ctx.empresaA.id);
  assert.strictEqual(s.reservadoFiscal, 0);
  assert.strictEqual(s.reservadoNaoFiscal, 0);
  assert.strictEqual(s.saldoFiscal, 0);
  assert.strictEqual(s.saldoNaoFiscal, 3);
  await closeDb(ctx.db);
}

async function test12PagamentoRateado() {
  const ctx = await setupBase();
  const pago = await pagoABC(ctx);
  await atendimentoService.materializarAtendimento(pago.atendimentoId, {}, { db: ctx.db });
  const pags = await all(ctx.db, 'SELECT v.total, p.forma_pagamento, p.valor FROM venda_pagamentos p JOIN vendas v ON v.id = p.venda_id');
  assert.strictEqual(pags.length, 3);
  assert.ok(pags.every((p) => p.forma_pagamento === 'pix'));
  const totais = pags.map((p) => Number(p.valor)).sort((a, b) => a - b);
  assert.deepStrictEqual(totais, [12, 18, 21]);
  await closeDb(ctx.db);
}

async function test13PagamentoMisto() {
  const ctx = await setupBase();
  const pago = await pagoABC(ctx, [
    { formaPagamento: 'pix', valor: 30 },
    { formaPagamento: 'cartao_credito', valor: 21 }
  ]);
  await atendimentoService.materializarAtendimento(pago.atendimentoId, {}, { db: ctx.db });
  const pags = await all(ctx.db, 'SELECT forma_pagamento, valor FROM venda_pagamentos');
  assert.ok(pags.some((p) => p.forma_pagamento === 'pix'));
  assert.ok(pags.some((p) => p.forma_pagamento === 'cartao_credito'));
  await closeDb(ctx.db);
}

async function test14RateioInconsistente() {
  const ctx = await setupBase();
  const pago = await pagoABC(ctx);
  await run(ctx.db, `UPDATE atendimento_pagamento_rateios SET valor_centavos = 1, valor = 0.01`);
  await assertRejects(
    atendimentoService.materializarAtendimento(pago.atendimentoId, {}, { db: ctx.db }),
    'RATEIO_OPERACAO_INCONSISTENTE'
  );
  assert.strictEqual((await get(ctx.db, 'SELECT COUNT(*) AS q FROM vendas')).q, 0);
  const cab = await get(ctx.db, 'SELECT status FROM atendimentos WHERE id = ?', [pago.atendimentoId]);
  assert.strictEqual(cab.status, 'PAGO');
  await closeDb(ctx.db);
}

async function test15RollbackEmpresaB() {
  const ctx = await setupBase();
  const pago = await pagoABC(ctx);
  let n = 0;
  await assertRejects(
    atendimentoService.materializarAtendimento(pago.atendimentoId, {}, {
      db: ctx.db,
      aposMaterializarOperacao() {
        n += 1;
        if (n >= 2) {
          const err = new Error('falha B');
          err.code = 'ATENDIMENTO_INVALIDO';
          throw err;
        }
      }
    }),
    'ATENDIMENTO_INVALIDO'
  );
  assert.strictEqual((await get(ctx.db, 'SELECT COUNT(*) AS q FROM vendas')).q, 0);
  const cab = await get(ctx.db, 'SELECT status FROM atendimentos WHERE id = ?', [pago.atendimentoId]);
  assert.strictEqual(cab.status, 'PAGO');
  await closeDb(ctx.db);
}

async function test16NenhumaVendaOrfa() {
  const ctx = await setupBase();
  const pago = await pagoABC(ctx);
  await assertRejects(
    atendimentoService.materializarAtendimento(pago.atendimentoId, {}, {
      db: ctx.db,
      aposMaterializarOperacao() {
        const err = new Error('x');
        err.code = 'ATENDIMENTO_INVALIDO';
        throw err;
      }
    }),
    'ATENDIMENTO_INVALIDO'
  );
  assert.strictEqual((await get(ctx.db, 'SELECT COUNT(*) AS q FROM vendas')).q, 0);
  await closeDb(ctx.db);
}

async function test17ReservaNaoParcial() {
  const ctx = await setupBase();
  const pago = await pagoABC(ctx);
  await assertRejects(
    atendimentoService.materializarAtendimento(pago.atendimentoId, {}, {
      db: ctx.db,
      aposMaterializarOperacao() {
        const err = new Error('x');
        err.code = 'ATENDIMENTO_INVALIDO';
        throw err;
      }
    }),
    'ATENDIMENTO_INVALIDO'
  );
  const reservas = await all(ctx.db, 'SELECT status FROM atendimento_operacao_reservas');
  assert.ok(reservas.every((r) => r.status === 'ATIVA'));
  await closeDb(ctx.db);
}

async function test18BaixaNaoParcial() {
  const ctx = await setupBase();
  const pago = await pagoABC(ctx);
  const antes = await saldoEmp(ctx.db, ctx.produtoId, ctx.empresaA.id);
  await assertRejects(
    atendimentoService.materializarAtendimento(pago.atendimentoId, {}, {
      db: ctx.db,
      aposMaterializarOperacao() {
        const err = new Error('x');
        err.code = 'ATENDIMENTO_INVALIDO';
        throw err;
      }
    }),
    'ATENDIMENTO_INVALIDO'
  );
  const depois = await saldoEmp(ctx.db, ctx.produtoId, ctx.empresaA.id);
  assert.strictEqual(depois.saldoFiscal, antes.saldoFiscal);
  await closeDb(ctx.db);
}

async function test19IdempotencyKey() {
  const ctx = await setupBase();
  const pago = await pagoABC(ctx);
  await atendimentoService.materializarAtendimento(pago.atendimentoId, {
    idempotencyKey: 'MAT-1'
  }, { db: ctx.db });
  const r2 = await atendimentoService.materializarAtendimento(pago.atendimentoId, {
    idempotencyKey: 'MAT-1'
  }, { db: ctx.db });
  assert.strictEqual(r2.idempotente, true);
  assert.strictEqual((await get(ctx.db, 'SELECT COUNT(*) AS q FROM vendas')).q, 3);
  await closeDb(ctx.db);
}

async function test20ChaveDiferenteAposConcluido() {
  const ctx = await setupBase();
  const pago = await pagoABC(ctx);
  await atendimentoService.materializarAtendimento(pago.atendimentoId, {
    idempotencyKey: 'MAT-A'
  }, { db: ctx.db });
  const r2 = await atendimentoService.materializarAtendimento(pago.atendimentoId, {
    idempotencyKey: 'MAT-B'
  }, { db: ctx.db });
  assert.strictEqual(r2.status, 'CONCLUIDO');
  assert.strictEqual((await get(ctx.db, 'SELECT COUNT(*) AS q FROM vendas')).q, 3);
  await closeDb(ctx.db);
}

async function test21SimultaneaSerializada() {
  const ctx = await setupBase();
  const pago = await pagoABC(ctx);
  await atendimentoService.materializarAtendimento(pago.atendimentoId, {}, { db: ctx.db });
  const r2 = await atendimentoService.materializarAtendimento(pago.atendimentoId, {}, { db: ctx.db });
  assert.strictEqual(r2.idempotente, true);
  assert.strictEqual((await get(ctx.db, 'SELECT COUNT(*) AS q FROM vendas')).q, 3);
  await closeDb(ctx.db);
}

async function test22OperacaoNaoDuplica() {
  const ctx = await setupBase();
  const pago = await pagoABC(ctx);
  await atendimentoService.materializarAtendimento(pago.atendimentoId, {}, { db: ctx.db });
  const ops = await all(ctx.db, 'SELECT venda_id FROM atendimento_operacoes');
  assert.strictEqual(new Set(ops.map((o) => o.venda_id)).size, 3);
  await closeDb(ctx.db);
}

async function test23CanceladoBloqueia() {
  const ctx = await setupBase();
  const atd = await atendimentoService.criarAtendimento({
    itens: [item(ctx.produtoId, ctx.empresaA.id, 1, 12)]
  }, { db: ctx.db });
  await atendimentoService.reservarAtendimento(atd.atendimentoId, { db: ctx.db });
  await atendimentoService.cancelarAtendimento(atd.atendimentoId, { db: ctx.db });
  await assertRejects(
    atendimentoService.materializarAtendimento(atd.atendimentoId, {}, { db: ctx.db }),
    'ATENDIMENTO_CANCELADO'
  );
  await closeDb(ctx.db);
}

async function test24NaoPagoBloqueia() {
  const ctx = await setupBase();
  const atd = await atendimentoService.criarAtendimento({
    itens: [item(ctx.produtoId, ctx.empresaA.id, 1, 12)]
  }, { db: ctx.db });
  await atendimentoService.reservarAtendimento(atd.atendimentoId, { db: ctx.db });
  await assertRejects(
    atendimentoService.materializarAtendimento(atd.atendimentoId, {}, { db: ctx.db }),
    'ATENDIMENTO_NAO_PAGO'
  );
  await closeDb(ctx.db);
}

async function test25ANaoAlteraB() {
  const ctx = await setupBase();
  const pago = await pagoABC(ctx);
  const antesB = await saldoEmp(ctx.db, ctx.produtoId, ctx.empresaB.id);
  await atendimentoService.materializarAtendimento(pago.atendimentoId, {}, { db: ctx.db });
  const depoisB = await saldoEmp(ctx.db, ctx.produtoId, ctx.empresaB.id);
  assert.strictEqual(depoisB.saldoFiscal, antesB.saldoFiscal - 1);
  const a = await saldoEmp(ctx.db, ctx.produtoId, ctx.empresaA.id);
  assert.strictEqual(a.saldoFiscal, 19);
  await closeDb(ctx.db);
}

async function test26BNaoAlteraC() {
  const ctx = await setupBase();
  const pago = await pagoABC(ctx);
  await atendimentoService.materializarAtendimento(pago.atendimentoId, {}, { db: ctx.db });
  const c = await saldoEmp(ctx.db, ctx.produtoId, ctx.empresaC.id);
  assert.strictEqual(c.saldoFiscal, 14);
  await closeDb(ctx.db);
}

async function test27SemEmpresaInventada() {
  const src = require('fs').readFileSync(
    path.join(__dirname, '../../backend/motores/muv/MaterializarOperacoesAtendimento.js'),
    'utf8'
  );
  assert.ok(src.includes('operacao.empresaId'));
  assert.ok(!src.includes('empresaId = 1'));
}

async function test28VendaVinculada() {
  const ctx = await setupBase();
  const pago = await pagoABC(ctx);
  const r = await atendimentoService.materializarAtendimento(pago.atendimentoId, {}, { db: ctx.db });
  for (const op of r.operacoes) {
    const row = await get(ctx.db, 'SELECT venda_id, empresa_id FROM atendimento_operacoes WHERE id = ?', [op.operacaoId]);
    assert.strictEqual(row.venda_id, op.vendaId);
    assert.strictEqual(row.empresa_id, op.empresaId);
  }
  await closeDb(ctx.db);
}

async function test29MaterializandoNaoFicaPreso() {
  const ctx = await setupBase();
  const pago = await pagoABC(ctx);
  await assertRejects(
    atendimentoService.materializarAtendimento(pago.atendimentoId, {}, {
      db: ctx.db,
      aposConcluirMaterializacao() {
        const err = new Error('falha final');
        err.code = 'ATENDIMENTO_INVALIDO';
        throw err;
      }
    }),
    'ATENDIMENTO_INVALIDO'
  );
  const cab = await get(ctx.db, 'SELECT status FROM atendimentos WHERE id = ?', [pago.atendimentoId]);
  assert.strictEqual(cab.status, 'PAGO');
  assert.notStrictEqual(cab.status, 'MATERIALIZANDO');
  await closeDb(ctx.db);
}

async function test30ConcluidoSomenteCompleto() {
  const ctx = await setupBase();
  const pago = await pagoABC(ctx);
  const r = await atendimentoService.materializarAtendimento(pago.atendimentoId, {}, { db: ctx.db });
  assert.strictEqual(r.status, 'CONCLUIDO');
  assert.ok(r.operacoes.every((o) => o.vendaId && o.status === 'CONCLUIDA'));
  await closeDb(ctx.db);
}

async function test31EmpresaUnica() {
  const { app, getPagamentoChamado, restore } = loadAppWithFakePagamento();
  try {
    const result = app.criarVenda({ body: { total: 10, itens: [] } }, mockRes(), {
      obterModoOperacaoVenda: () => 'EMPRESA_UNICA'
    });
    assert.strictEqual(result, 'DELEGATED_PDV');
    assert.strictEqual(getPagamentoChamado(), 1);
  } finally {
    restore();
  }
}

async function test32NaoChamaOrquestrador() {
  const src = require('fs').readFileSync(
    path.join(__dirname, '../../backend/motores/muv/MaterializarOperacoesAtendimento.js'),
    'utf8'
  );
  assert.ok(!src.includes('require(\'../OrquestradorPagamento\')'));
  assert.ok(!src.includes('VendaPagamentoService.criarVenda'));
  assert.ok(src.includes('debitarEstoqueItemVenda'));
}

async function main() {
  const testes = [
    ['01 materializa A/B/C', test01MaterializaABC],
    ['02 uma venda por empresa', test02UmaVendaPorEmpresa],
    ['03 itens corretos', test03ItensCorretos],
    ['04 empresa correta', test04EmpresaCorreta],
    ['05 estoque A isolado', test05EstoqueAIsolado],
    ['06 estoque B isolado', test06EstoqueBIsolado],
    ['07 estoque C isolado', test07EstoqueCIsolado],
    ['08 produtos legado não autoriza', test08LegadoNaoAutoriza],
    ['09 reserva fiscal consumida', test09ReservaFiscalConsumida],
    ['10 reserva não fiscal consumida', test10ReservaNaoFiscalConsumida],
    ['11 reserva TOTAL distribuída', test11ReservaTotal],
    ['12 pagamento rateado por operação', test12PagamentoRateado],
    ['13 pagamento misto respeitado', test13PagamentoMisto],
    ['14 rateio inconsistente bloqueia', test14RateioInconsistente],
    ['15 falha na empresa B gera rollback', test15RollbackEmpresaB],
    ['16 nenhuma venda órfã', test16NenhumaVendaOrfa],
    ['17 nenhuma reserva parcialmente consumida', test17ReservaNaoParcial],
    ['18 nenhuma baixa parcial', test18BaixaNaoParcial],
    ['19 mesma idempotency key', test19IdempotencyKey],
    ['20 chave diferente após concluído', test20ChaveDiferenteAposConcluido],
    ['21 materialização serializada', test21SimultaneaSerializada],
    ['22 operação não duplica venda', test22OperacaoNaoDuplica],
    ['23 atendimento CANCELADO bloqueia', test23CanceladoBloqueia],
    ['24 atendimento não PAGO bloqueia', test24NaoPagoBloqueia],
    ['25 empresa A não altera B além do próprio débito', test25ANaoAlteraB],
    ['26 empresa B não altera C', test26BNaoAlteraC],
    ['27 sem empresa_id inventada', test27SemEmpresaInventada],
    ['28 venda vinculada à operação', test28VendaVinculada],
    ['29 MATERIALIZANDO não fica preso', test29MaterializandoNaoFicaPreso],
    ['30 CONCLUIDO só com todas operações', test30ConcluidoSomenteCompleto],
    ['31 EMPRESA_UNICA inalterado', test31EmpresaUnica],
    ['32 não chama Orquestrador/criarVenda', test32NaoChamaOrquestrador]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  ok ${nome}`);
  }
  console.log(`\nmaterializacao-operacoes-multiempresa-04-06: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
