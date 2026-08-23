/**
 * Sprint 04.05 — pagamento unificado + rateio empresarial do atendimento.
 */
'use strict';

const assert = require('assert');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const {
  STATUS_ATENDIMENTO,
  STATUS_RESERVA_ATENDIMENTO,
  EstrategiaDistribuicaoPagamento,
  ratearProporcionalCentavos
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

function item(produtoId, empresaId, quantidade, valorUnitario) {
  return { produtoId, empresaId, quantidade, valorUnitario };
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

async function reservadoABC(ctx) {
  const { db, produtoId, empresaA, empresaB, empresaC } = ctx;
  const atd = await atendimentoService.criarAtendimento({
    itens: [
      item(produtoId, empresaA.id, 1, 12),
      item(produtoId, empresaB.id, 1, 18),
      item(produtoId, empresaC.id, 1, 21)
    ]
  }, { db });
  return atendimentoService.reservarAtendimento(atd.atendimentoId, { db });
}

function pagar(id, pagamentos, extra = {}, db) {
  return atendimentoService.confirmarPagamentoAtendimento(id, {
    pagamentos,
    ...extra
  }, { db, ...extra.deps });
}

function soma(lista, campo) {
  return lista.reduce((acc, x) => acc + Number(x[campo]), 0);
}

async function test01PixUnico() {
  const ctx = await setupBase();
  const r0 = await reservadoABC(ctx);
  const r = await pagar(r0.atendimentoId, [{ formaPagamento: 'pix', valor: 51 }], {}, ctx.db);
  assert.strictEqual(r.status, STATUS_ATENDIMENTO.PAGO);
  assert.strictEqual(r.pagamento_pendente, false);
  assert.strictEqual(r.venda_concluida, false);
  assert.strictEqual(r.pagamentos.length, 1);
  assert.strictEqual(r.pagamentos[0].formaPagamento, 'pix');
  assert.strictEqual(r.pagamentos[0].valorCentavos, 5100);
  await closeDb(ctx.db);
}

async function test02DinheiroUnico() {
  const ctx = await setupBase();
  const r0 = await reservadoABC(ctx);
  const r = await pagar(r0.atendimentoId, [{ formaPagamento: 'dinheiro', valor: 51 }], {}, ctx.db);
  assert.strictEqual(r.pagamentos[0].formaPagamento, 'dinheiro');
  assert.strictEqual(r.status, 'PAGO');
  await closeDb(ctx.db);
}

async function test03Misto() {
  const ctx = await setupBase();
  const r0 = await reservadoABC(ctx);
  const r = await pagar(r0.atendimentoId, [
    { formaPagamento: 'pix', valor: 30 },
    { formaPagamento: 'cartao_credito', valor: 21 }
  ], {}, ctx.db);
  assert.strictEqual(r.pagamentos.length, 2);
  assert.strictEqual(soma(r.pagamentos, 'valorCentavos'), 5100);
  await closeDb(ctx.db);
}

async function test04TresFormas() {
  const ctx = await setupBase();
  const r0 = await reservadoABC(ctx);
  const r = await pagar(r0.atendimentoId, [
    { formaPagamento: 'pix', valor: 20 },
    { formaPagamento: 'dinheiro', valor: 15 },
    { formaPagamento: 'cartao_credito', valor: 16 }
  ], {}, ctx.db);
  assert.strictEqual(r.pagamentos.length, 3);
  assert.strictEqual(soma(r.pagamentos, 'valorCentavos'), 5100);
  await closeDb(ctx.db);
}

async function test05RateioPorItem() {
  const ctx = await setupBase();
  const r0 = await reservadoABC(ctx);
  const r = await pagar(r0.atendimentoId, [
    { formaPagamento: 'pix', valor: 30 },
    { formaPagamento: 'cartao_credito', valor: 21 }
  ], { estrategia: 'RATEIO_POR_ITEM' }, ctx.db);
  assert.strictEqual(r.rateios[0].estrategia, EstrategiaDistribuicaoPagamento.POR_ITEM);
  const porEmp = new Map();
  for (const rt of r.rateios) {
    porEmp.set(rt.empresaId, (porEmp.get(rt.empresaId) || 0) + rt.valorCentavos);
  }
  assert.strictEqual(porEmp.get(ctx.empresaA.id), 1200);
  assert.strictEqual(porEmp.get(ctx.empresaB.id), 1800);
  assert.strictEqual(porEmp.get(ctx.empresaC.id), 2100);
  await closeDb(ctx.db);
}

async function test06RateioProporcional() {
  const ctx = await setupBase();
  const r0 = await reservadoABC(ctx);
  const r = await pagar(r0.atendimentoId, [
    { formaPagamento: 'pix', valor: 30 },
    { formaPagamento: 'cartao_credito', valor: 21 }
  ], { estrategia: 'RATEIO_PROPORCIONAL' }, ctx.db);
  assert.ok(r.rateios.every((rt) => rt.estrategia === 'PROPORCIONAL'));
  assert.strictEqual(soma(r.rateios, 'valorCentavos'), 5100);
  await closeDb(ctx.db);
}

async function test07SomaPagamentos() {
  const ctx = await setupBase();
  const r0 = await reservadoABC(ctx);
  const r = await pagar(r0.atendimentoId, [{ formaPagamento: 'pix', valor: 51 }], {}, ctx.db);
  assert.strictEqual(soma(r.pagamentos, 'valor'), 51);
  await closeDb(ctx.db);
}

async function test08SomaRateios() {
  const ctx = await setupBase();
  const r0 = await reservadoABC(ctx);
  const r = await pagar(r0.atendimentoId, [{ formaPagamento: 'pix', valor: 51 }], {}, ctx.db);
  assert.strictEqual(soma(r.rateios, 'valorCentavos'), 5100);
  await closeDb(ctx.db);
}

async function test09RateioPorPagamento() {
  const ctx = await setupBase();
  const r0 = await reservadoABC(ctx);
  const r = await pagar(r0.atendimentoId, [
    { formaPagamento: 'pix', valor: 30 },
    { formaPagamento: 'dinheiro', valor: 21 }
  ], { estrategia: 'POR_ITEM' }, ctx.db);
  for (const pag of r.pagamentos) {
    const parte = r.rateios.filter((rt) => rt.pagamentoId === pag.pagamentoId);
    assert.strictEqual(soma(parte, 'valorCentavos'), pag.valorCentavos);
  }
  await closeDb(ctx.db);
}

async function test10CentavosSemPerda() {
  const partes = ratearProporcionalCentavos(5099, [
    { empresaId: 3, operacaoId: 3, pesoCentavos: 2100 },
    { empresaId: 1, operacaoId: 1, pesoCentavos: 1200 },
    { empresaId: 2, operacaoId: 2, pesoCentavos: 1799 }
  ]);
  assert.strictEqual(partes.reduce((acc, p) => acc + p.valorCentavos, 0), 5099);
  assert.deepStrictEqual(partes.map((p) => p.empresaId), [1, 2, 3]);
}

async function test11Deterministico() {
  const pesos = [
    { empresaId: 8, operacaoId: 8, pesoCentavos: 100 },
    { empresaId: 2, operacaoId: 2, pesoCentavos: 100 },
    { empresaId: 5, operacaoId: 5, pesoCentavos: 100 }
  ];
  const a = ratearProporcionalCentavos(10, pesos);
  const b = ratearProporcionalCentavos(10, [...pesos].reverse());
  assert.deepStrictEqual(a, b);
}

async function test12EmpresasABC() {
  const ctx = await setupBase();
  const r0 = await reservadoABC(ctx);
  const r = await pagar(r0.atendimentoId, [{ formaPagamento: 'pix', valor: 51 }], {}, ctx.db);
  const ids = new Set(r.rateios.map((rt) => rt.empresaId));
  assert.ok(ids.has(ctx.empresaA.id));
  assert.ok(ids.has(ctx.empresaB.id));
  assert.ok(ids.has(ctx.empresaC.id));
  await closeDb(ctx.db);
}

async function test13EmpresaValorZero() {
  const ctx = await setupBase();
  const atd = await atendimentoService.criarAtendimento({
    itens: [
      item(ctx.produtoId, ctx.empresaA.id, 1, 10),
      item(ctx.produtoId, ctx.empresaB.id, 1, 0)
    ]
  }, { db: ctx.db });
  await atendimentoService.reservarAtendimento(atd.atendimentoId, { db: ctx.db });
  const r = await pagar(atd.atendimentoId, [{ formaPagamento: 'pix', valor: 10 }], {}, ctx.db);
  const b = r.rateios.filter((rt) => rt.empresaId === ctx.empresaB.id);
  assert.ok(b.every((rt) => rt.valorCentavos === 0));
  assert.strictEqual(soma(r.rateios, 'valorCentavos'), 1000);
  await closeDb(ctx.db);
}

async function test14EmpresaInexistente() {
  const ctx = await setupBase();
  const r0 = await reservadoABC(ctx);
  await assertRejects(
    pagar(r0.atendimentoId, [{ formaPagamento: 'pix', valor: 51 }], {
      estrategia: 'MANUAL',
      rateios: [{ sequencia: 0, empresaId: 999, valor: 51 }]
    }, ctx.db),
    'EMPRESA_INVALIDA'
  );
  await closeDb(ctx.db);
}

async function test15RateioNegativo() {
  const ctx = await setupBase();
  const r0 = await reservadoABC(ctx);
  await assertRejects(
    pagar(r0.atendimentoId, [{ formaPagamento: 'pix', valor: 51 }], {
      estrategia: 'MANUAL',
      rateios: [{ sequencia: 0, empresaId: ctx.empresaA.id, valor: -1 }]
    }, ctx.db),
    'RATEIO_NEGATIVO'
  );
  await closeDb(ctx.db);
}

async function test16PagamentoInsuficiente() {
  const ctx = await setupBase();
  const r0 = await reservadoABC(ctx);
  await assertRejects(
    pagar(r0.atendimentoId, [{ formaPagamento: 'pix', valor: 50 }], {}, ctx.db),
    'PAGAMENTO_INSUFICIENTE'
  );
  const cab = await get(ctx.db, 'SELECT status FROM atendimentos WHERE id = ?', [r0.atendimentoId]);
  assert.strictEqual(cab.status, 'RESERVADO');
  await closeDb(ctx.db);
}

async function test17PagamentoExcedente() {
  const ctx = await setupBase();
  const r0 = await reservadoABC(ctx);
  await assertRejects(
    pagar(r0.atendimentoId, [{ formaPagamento: 'pix', valor: 52 }], {}, ctx.db),
    'PAGAMENTO_EXCEDENTE'
  );
  await closeDb(ctx.db);
}

async function test18NaoReservado() {
  const ctx = await setupBase();
  const atd = await atendimentoService.criarAtendimento({
    itens: [item(ctx.produtoId, ctx.empresaA.id, 1, 12)]
  }, { db: ctx.db });
  await assertRejects(
    pagar(atd.atendimentoId, [{ formaPagamento: 'pix', valor: 12 }], {}, ctx.db),
    'ATENDIMENTO_NAO_RESERVADO'
  );
  await closeDb(ctx.db);
}

async function test19Cancelado() {
  const ctx = await setupBase();
  const r0 = await reservadoABC(ctx);
  await atendimentoService.cancelarAtendimento(r0.atendimentoId, { db: ctx.db });
  await assertRejects(
    pagar(r0.atendimentoId, [{ formaPagamento: 'pix', valor: 51 }], {}, ctx.db),
    'ATENDIMENTO_CANCELADO'
  );
  await closeDb(ctx.db);
}

async function test20Idempotente() {
  const ctx = await setupBase();
  const r0 = await reservadoABC(ctx);
  const entrada = {
    pagamentos: [{ formaPagamento: 'pix', valor: 51 }],
    idempotencyKey: 'ATD-PAY-1'
  };
  await pagar(r0.atendimentoId, entrada.pagamentos, entrada, ctx.db);
  const r2 = await pagar(r0.atendimentoId, entrada.pagamentos, entrada, ctx.db);
  assert.strictEqual(r2.idempotente, true);
  assert.strictEqual(r2.status, 'PAGO');
  const n = await get(ctx.db, 'SELECT COUNT(*) AS q FROM atendimento_pagamentos');
  assert.strictEqual(n.q, 1);
  await closeDb(ctx.db);
}

async function test21IdempotencyConflict() {
  const ctx = await setupBase();
  const r0 = await reservadoABC(ctx);
  await pagar(r0.atendimentoId, [{ formaPagamento: 'pix', valor: 51 }], {
    idempotencyKey: 'ATD-PAY-2'
  }, ctx.db);
  await assertRejects(
    pagar(r0.atendimentoId, [{ formaPagamento: 'dinheiro', valor: 51 }], {
      idempotencyKey: 'ATD-PAY-2'
    }, ctx.db),
    'IDEMPOTENCY_KEY_CONFLICT'
  );
  await closeDb(ctx.db);
}

async function test22RollbackPagamento() {
  const ctx = await setupBase();
  const r0 = await reservadoABC(ctx);
  await assertRejects(
    atendimentoService.confirmarPagamentoAtendimento(r0.atendimentoId, {
      pagamentos: [{ formaPagamento: 'pix', valor: 51 }]
    }, {
      db: ctx.db,
      aposPersistirPagamento() {
        const err = new Error('falha pagamento');
        err.code = 'ATENDIMENTO_INVALIDO';
        throw err;
      }
    }),
    'ATENDIMENTO_INVALIDO'
  );
  const cab = await get(ctx.db, 'SELECT status FROM atendimentos WHERE id = ?', [r0.atendimentoId]);
  assert.strictEqual(cab.status, 'RESERVADO');
  assert.strictEqual((await get(ctx.db, 'SELECT COUNT(*) AS q FROM atendimento_pagamentos')).q, 0);
  await closeDb(ctx.db);
}

async function test23RollbackRateio() {
  const ctx = await setupBase();
  const r0 = await reservadoABC(ctx);
  await assertRejects(
    atendimentoService.confirmarPagamentoAtendimento(r0.atendimentoId, {
      pagamentos: [{ formaPagamento: 'pix', valor: 51 }]
    }, {
      db: ctx.db,
      aposPersistirRateio() {
        const err = new Error('falha rateio');
        err.code = 'ATENDIMENTO_INVALIDO';
        throw err;
      }
    }),
    'ATENDIMENTO_INVALIDO'
  );
  assert.strictEqual((await get(ctx.db, 'SELECT COUNT(*) AS q FROM atendimento_pagamento_rateios')).q, 0);
  const cab = await get(ctx.db, 'SELECT status FROM atendimentos WHERE id = ?', [r0.atendimentoId]);
  assert.strictEqual(cab.status, 'RESERVADO');
  await closeDb(ctx.db);
}

async function test24RollbackAtualizarPago() {
  const ctx = await setupBase();
  const r0 = await reservadoABC(ctx);
  await assertRejects(
    atendimentoService.confirmarPagamentoAtendimento(r0.atendimentoId, {
      pagamentos: [{ formaPagamento: 'pix', valor: 51 }]
    }, {
      db: ctx.db,
      aposAtualizarPago() {
        const err = new Error('falha status');
        err.code = 'ATENDIMENTO_INVALIDO';
        throw err;
      }
    }),
    'ATENDIMENTO_INVALIDO'
  );
  const cab = await get(ctx.db, 'SELECT status FROM atendimentos WHERE id = ?', [r0.atendimentoId]);
  assert.strictEqual(cab.status, 'RESERVADO');
  assert.strictEqual((await get(ctx.db, 'SELECT COUNT(*) AS q FROM atendimento_pagamentos')).q, 0);
  await closeDb(ctx.db);
}

async function test25PagoSemPagamentoImpossivel() {
  const ctx = await setupBase();
  const r0 = await reservadoABC(ctx);
  await assertRejects(
    atendimentoService.confirmarPagamentoAtendimento(r0.atendimentoId, {
      pagamentos: [{ formaPagamento: 'pix', valor: 51 }]
    }, {
      db: ctx.db,
      async aposPersistirPagamento({ atendimentoId }) {
        await run(ctx.db, 'DELETE FROM atendimento_pagamentos WHERE atendimento_id = ?', [atendimentoId]);
      }
    }),
    'INVARIANTE_PAGO'
  );
  const cab = await get(ctx.db, 'SELECT status FROM atendimentos WHERE id = ?', [r0.atendimentoId]);
  assert.strictEqual(cab.status, 'RESERVADO');
  await closeDb(ctx.db);
}

async function test26PagoRateioIncompletoImpossivel() {
  const ctx = await setupBase();
  const r0 = await reservadoABC(ctx);
  await assertRejects(
    atendimentoService.confirmarPagamentoAtendimento(r0.atendimentoId, {
      pagamentos: [{ formaPagamento: 'pix', valor: 51 }]
    }, {
      db: ctx.db,
      async aposPersistirRateio({ atendimentoId }) {
        await run(ctx.db, 'DELETE FROM atendimento_pagamento_rateios WHERE atendimento_id = ?', [atendimentoId]);
      }
    }),
    'INVARIANTE_PAGO'
  );
  const cab = await get(ctx.db, 'SELECT status FROM atendimentos WHERE id = ?', [r0.atendimentoId]);
  assert.strictEqual(cab.status, 'RESERVADO');
  await closeDb(ctx.db);
}

async function test27EmpresaUnica() {
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

async function test28NenhumaVenda() {
  const ctx = await setupBase();
  const r0 = await reservadoABC(ctx);
  await pagar(r0.atendimentoId, [{ formaPagamento: 'pix', valor: 51 }], {}, ctx.db);
  assert.strictEqual((await get(ctx.db, 'SELECT COUNT(*) AS q FROM vendas')).q, 0);
  await closeDb(ctx.db);
}

async function test29NenhumaBaixaDefinitiva() {
  const ctx = await setupBase();
  const r0 = await reservadoABC(ctx);
  const antesA = await saldoEmp(ctx.db, ctx.produtoId, ctx.empresaA.id);
  await pagar(r0.atendimentoId, [{ formaPagamento: 'pix', valor: 51 }], {}, ctx.db);
  const depoisA = await saldoEmp(ctx.db, ctx.produtoId, ctx.empresaA.id);
  assert.strictEqual(depoisA.saldoFiscal, antesA.saldoFiscal);
  assert.strictEqual(depoisA.estoqueAtual, antesA.estoqueAtual);
  await closeDb(ctx.db);
}

async function test30ReservasPermanecem() {
  const ctx = await setupBase();
  const r0 = await reservadoABC(ctx);
  const r = await pagar(r0.atendimentoId, [{ formaPagamento: 'pix', valor: 51 }], {}, ctx.db);
  const ativas = r.operacoes.flatMap((o) => o.reservas).filter((x) => x.status === STATUS_RESERVA_ATENDIMENTO.ATIVA);
  assert.ok(ativas.length >= 3);
  const sA = await saldoEmp(ctx.db, ctx.produtoId, ctx.empresaA.id);
  assert.ok(sA.reservadoFiscal > 0);
  await closeDb(ctx.db);
}

async function test31ToleranciaOficialUmCentavo() {
  const ctx = await setupBase();
  const r0 = await reservadoABC(ctx);
  const r = await pagar(r0.atendimentoId, [{ formaPagamento: 'pix', valor: 51.01 }], {}, ctx.db);
  assert.strictEqual(r.status, 'PAGO');
  await closeDb(ctx.db);
}

async function test32NaoChamaTefNemOrquestrador() {
  const src = require('fs').readFileSync(
    path.join(__dirname, '../../backend/motores/muv/AtendimentoMultiempresaService.js'),
    'utf8'
  );
  assert.ok(!src.includes('OrquestradorPagamento'));
  assert.ok(!src.includes('tefManager'));
  assert.ok(src.includes('validarSomaPagamentosVenda'));
}

async function main() {
  const testes = [
    ['01 pagamento único PIX', test01PixUnico],
    ['02 pagamento único dinheiro', test02DinheiroUnico],
    ['03 pagamento misto', test03Misto],
    ['04 três formas de pagamento', test04TresFormas],
    ['05 RATEIO_POR_ITEM', test05RateioPorItem],
    ['06 RATEIO_PROPORCIONAL', test06RateioProporcional],
    ['07 soma dos pagamentos', test07SomaPagamentos],
    ['08 soma dos rateios', test08SomaRateios],
    ['09 rateio individual por pagamento', test09RateioPorPagamento],
    ['10 centavos sem perda', test10CentavosSemPerda],
    ['11 distribuição determinística', test11Deterministico],
    ['12 empresas A/B/C', test12EmpresasABC],
    ['13 empresa com valor zero', test13EmpresaValorZero],
    ['14 empresa inexistente no atendimento', test14EmpresaInexistente],
    ['15 rateio negativo', test15RateioNegativo],
    ['16 pagamento insuficiente', test16PagamentoInsuficiente],
    ['17 pagamento excedente', test17PagamentoExcedente],
    ['18 atendimento não reservado', test18NaoReservado],
    ['19 atendimento cancelado', test19Cancelado],
    ['20 segunda confirmação idempotente', test20Idempotente],
    ['21 idempotency_key com payload diferente', test21IdempotencyConflict],
    ['22 rollback ao falhar persistência de pagamento', test22RollbackPagamento],
    ['23 rollback ao falhar persistência de rateio', test23RollbackRateio],
    ['24 rollback ao falhar atualização do atendimento', test24RollbackAtualizarPago],
    ['25 PAGO sem pagamento é impossível', test25PagoSemPagamentoImpossivel],
    ['26 PAGO com rateio incompleto é impossível', test26PagoRateioIncompletoImpossivel],
    ['27 EMPRESA_UNICA não usa esse fluxo', test27EmpresaUnica],
    ['28 nenhuma venda criada', test28NenhumaVenda],
    ['29 nenhuma baixa definitiva de estoque', test29NenhumaBaixaDefinitiva],
    ['30 reservas permanecem após pagamento', test30ReservasPermanecem],
    ['31 tolerância oficial de 1 centavo', test31ToleranciaOficialUmCentavo],
    ['32 não chama TEF nem OrquestradorPagamento', test32NaoChamaTefNemOrquestrador]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  ok ${nome}`);
  }
  console.log(`\npagamento-unificado-rateio-04-05: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
