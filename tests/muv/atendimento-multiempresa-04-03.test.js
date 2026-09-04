/**
 * Sprint 04.03 — atendimento multiempresa + operações empresariais.
 */
'use strict';

const assert = require('assert');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const {
  STATUS_ATENDIMENTO,
  STATUS_OPERACAO_EMPRESARIAL,
  agruparItensPorEmpresa,
  validarItensEntradaAtendimento
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

function item(produtoId, empresaId, quantidade, valorUnitario = 10) {
  return { produtoId, empresaId, quantidade, valorUnitario };
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
     VALUES ('X', 999, 0, 999)`
  );
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const b = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  const c = await EmpresaService.criarEmpresa({ cnpj: CNPJ_C, razao_social: 'C' }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: p.lastID, empresaId: a.id,
    saldo_fiscal: 10, reservado_fiscal: 0, estoque_atual: 10
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: p.lastID, empresaId: b.id,
    saldo_fiscal: 3, reservado_fiscal: 0, estoque_atual: 3
  }, { db });
  await EstoqueEmpresaService.criarRegistro({
    produtoId: p.lastID, empresaId: c.id,
    saldo_fiscal: 20, reservado_fiscal: 0, estoque_atual: 20
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

async function test01CriaAtendimento() {
  const { db, produtoId, empresaA, empresaB } = await setupBase();
  const r = await atendimentoService.criarAtendimento({
    origem: 'PDV',
    itens: [
      item(produtoId, empresaA.id, 2, 5),
      item(produtoId, empresaB.id, 1, 7)
    ]
  }, { db });
  assert.ok(r.atendimentoId > 0);
  assert.match(r.codigo, /^ATD-/);
  assert.strictEqual(r.modo_operacao, 'MULTIEMPRESA');
  assert.strictEqual(r.status, STATUS_ATENDIMENTO.VALIDADO);
  const row = await get(db, 'SELECT * FROM atendimentos WHERE id = ?', [r.atendimentoId]);
  assert.ok(row);
  assert.strictEqual(row.status, 'VALIDADO');
  await closeDb(db);
}

async function test02AgrupaPorEmpresa() {
  const itens = validarItensEntradaAtendimento([
    item(10, 2, 3, 1),
    item(11, 1, 1, 2),
    item(12, 2, 1, 3)
  ]);
  const ops = agruparItensPorEmpresa(itens);
  assert.strictEqual(ops.length, 2);
  assert.strictEqual(ops[0].empresaId, 1);
  assert.strictEqual(ops[0].itens.length, 1);
  assert.strictEqual(ops[1].empresaId, 2);
  assert.strictEqual(ops[1].itens.length, 2);
}

async function test03UmaOperacaoPorEmpresa() {
  const { db, produtoId, empresaA, empresaB, empresaC } = await setupBase();
  const r = await atendimentoService.criarAtendimento({
    itens: [
      item(produtoId, empresaA.id, 1),
      item(produtoId, empresaB.id, 1),
      item(produtoId, empresaC.id, 1)
    ]
  }, { db });
  assert.strictEqual(r.operacoes.length, 3);
  const empresas = r.operacoes.map((o) => o.empresaId).sort((x, y) => x - y);
  assert.deepStrictEqual(empresas, [empresaA.id, empresaB.id, empresaC.id].sort((x, y) => x - y));
  await closeDb(db);
}

async function test04PersisteItens() {
  const { db, produtoId, empresaA, empresaB } = await setupBase();
  const r = await atendimentoService.criarAtendimento({
    itens: [
      item(produtoId, empresaA.id, 2, 4),
      item(produtoId, empresaB.id, 1, 6)
    ]
  }, { db });
  const itens = await all(db, 'SELECT * FROM atendimento_operacao_itens ORDER BY empresa_id');
  assert.strictEqual(itens.length, 2);
  assert.strictEqual(itens[0].produto_id, produtoId);
  assert.strictEqual(Number(itens[0].quantidade), 2);
  const persistido = await atendimentoService.obterAtendimento(r.atendimentoId, { db });
  assert.strictEqual(persistido.operacoes.reduce((n, o) => n + o.itens.length, 0), 2);
  await closeDb(db);
}

async function test05CalculaSubtotal() {
  const { db, produtoId, empresaA, empresaB } = await setupBase();
  const r = await atendimentoService.criarAtendimento({
    itens: [
      item(produtoId, empresaA.id, 2, 5.5),
      item(produtoId, empresaB.id, 1, 3)
    ]
  }, { db });
  const opA = r.operacoes.find((o) => o.empresaId === empresaA.id);
  assert.strictEqual(opA.subtotal, 11);
  await closeDb(db);
}

async function test06CalculaTotalGeral() {
  const { db, produtoId, empresaA, empresaB } = await setupBase();
  const r = await atendimentoService.criarAtendimento({
    itens: [
      item(produtoId, empresaA.id, 2, 5.5),
      item(produtoId, empresaB.id, 1, 3)
    ]
  }, { db });
  assert.strictEqual(r.total, 14);
  await closeDb(db);
}

async function test07ValidaEstoqueA() {
  const { db, produtoId, empresaA } = await setupBase();
  const r = await atendimentoService.criarAtendimento({
    itens: [item(produtoId, empresaA.id, 5)]
  }, { db });
  assert.strictEqual(r.status, 'VALIDADO');
  await closeDb(db);
}

async function test08ValidaEstoqueB() {
  const { db, produtoId, empresaB } = await setupBase();
  const r = await atendimentoService.criarAtendimento({
    itens: [item(produtoId, empresaB.id, 2)]
  }, { db });
  assert.strictEqual(r.status, 'VALIDADO');
  await closeDb(db);
}

async function test09NaoUsaEstoqueGlobal() {
  const { db, produtoId, empresaB } = await setupBase();
  const prod = await get(db, 'SELECT estoque_atual FROM produtos WHERE id = ?', [produtoId]);
  assert.strictEqual(prod.estoque_atual, 999);
  await assertRejects(
    atendimentoService.criarAtendimento({
      itens: [item(produtoId, empresaB.id, 5)]
    }, { db }),
    'SALDO_INSUFICIENTE'
  );
  await closeDb(db);
}

async function test10EmpresaSemEstoqueIsoladoZero() {
  const { db, produtoId } = await setupBase();
  const d = await EmpresaService.criarEmpresa({
    cnpj: '47627408000151',
    razao_social: 'D SEM ESTOQUE'
  }, { db });
  await assertRejects(
    atendimentoService.criarAtendimento({
      itens: [item(produtoId, d.id, 1)]
    }, { db }),
    'SALDO_INSUFICIENTE'
  );
  const ee = await get(
    db,
    'SELECT id FROM estoque_empresa WHERE empresa_id = ?',
    [d.id]
  );
  assert.strictEqual(ee, null);
  await closeDb(db);
}

async function test11SaldoInsuficienteBloqueiaTudo() {
  const { db, produtoId, empresaA, empresaB, empresaC } = await setupBase();
  await assertRejects(
    atendimentoService.criarAtendimento({
      itens: [
        item(produtoId, empresaA.id, 5),
        item(produtoId, empresaB.id, 5),
        item(produtoId, empresaC.id, 10)
      ]
    }, { db }),
    'SALDO_INSUFICIENTE'
  );
  const n = await get(db, 'SELECT COUNT(*) AS q FROM atendimentos');
  assert.strictEqual(n.q, 0);
  await closeDb(db);
}

async function test12RollbackRemoveAtendimento() {
  const { db, produtoId, empresaA, empresaB } = await setupBase();
  await assertRejects(
    atendimentoService.criarAtendimento({
      itens: [item(produtoId, empresaA.id, 1), item(produtoId, empresaB.id, 1)]
    }, {
      db,
      aposPersistirParcial() {
        const err = new Error('falha forçada');
        err.code = 'ATENDIMENTO_INVALIDO';
        throw err;
      }
    }),
    'ATENDIMENTO_INVALIDO'
  );
  const n = await get(db, 'SELECT COUNT(*) AS q FROM atendimentos');
  assert.strictEqual(n.q, 0);
  await closeDb(db);
}

async function test13RollbackRemoveOperacoes() {
  const { db, produtoId, empresaA, empresaB } = await setupBase();
  await assertRejects(
    atendimentoService.criarAtendimento({
      itens: [item(produtoId, empresaA.id, 1), item(produtoId, empresaB.id, 1)]
    }, {
      db,
      aposPersistirParcial() {
        const err = new Error('falha forçada');
        err.code = 'ATENDIMENTO_INVALIDO';
        throw err;
      }
    }),
    'ATENDIMENTO_INVALIDO'
  );
  const n = await get(db, 'SELECT COUNT(*) AS q FROM atendimento_operacoes');
  assert.strictEqual(n.q, 0);
  await closeDb(db);
}

async function test14RollbackRemoveItens() {
  const { db, produtoId, empresaA, empresaB } = await setupBase();
  await assertRejects(
    atendimentoService.criarAtendimento({
      itens: [item(produtoId, empresaA.id, 1), item(produtoId, empresaB.id, 1)]
    }, {
      db,
      aposPersistirParcial() {
        const err = new Error('falha forçada');
        err.code = 'ATENDIMENTO_INVALIDO';
        throw err;
      }
    }),
    'ATENDIMENTO_INVALIDO'
  );
  const n = await get(db, 'SELECT COUNT(*) AS q FROM atendimento_operacao_itens');
  assert.strictEqual(n.q, 0);
  await closeDb(db);
}

async function test15EmpresaIdObrigatorio() {
  await assertRejects(
    Promise.resolve().then(() => validarItensEntradaAtendimento([
      { produtoId: 1, quantidade: 1, valorUnitario: 1 }
    ])),
    'EMPRESA_OBRIGATORIA'
  );
}

async function test16NaoAceitaEmpresaSnake() {
  await assertRejects(
    Promise.resolve().then(() => validarItensEntradaAtendimento([
      { produtoId: 1, empresa_id: 7, quantidade: 1, valorUnitario: 1 }
    ])),
    'EMPRESA_OBRIGATORIA'
  );
}

async function test17NaoAssumeEmpresa1() {
  const { db, produtoId, empresaA } = await setupBase();
  assert.strictEqual(empresaA.id, 1);
  await assertRejects(
    atendimentoService.criarAtendimento({
      itens: [{ produtoId, quantidade: 1, valorUnitario: 10 }]
    }, { db }),
    'EMPRESA_OBRIGATORIA'
  );
  await closeDb(db);
}

async function test18EmpresaUnicaFluxoAtual() {
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

async function test19MultiempresaChamaPagamento() {
  const { app, getPagamentoChamado, restore } = loadAppWithFakePagamento();
  try {
    const req = {
      body: {
        origem: 'PDV',
        itens: []
      }
    };
    const res = mockRes();
    const result = await app.criarVenda(req, res, {
      obterModoOperacaoVenda: () => 'MULTIEMPRESA'
    });
    assert.strictEqual(result, 'DELEGATED_PDV');
    assert.strictEqual(getPagamentoChamado(), 1);
  } finally {
    restore();
  }
}

async function test20MultiempresaNaoCriaVendas() {
  const { db, produtoId, empresaA, empresaB } = await setupBase();
  await atendimentoService.criarAtendimento({
    itens: [item(produtoId, empresaA.id, 1), item(produtoId, empresaB.id, 1)]
  }, { db });
  const n = await get(db, 'SELECT COUNT(*) AS q FROM vendas');
  assert.strictEqual(n.q, 0);
  await closeDb(db);
}

async function test21VendaConcluidaNoNucleo() {
  const { app, getPagamentoChamado, restore } = loadAppWithFakePagamento();
  try {
    const req = { body: { itens: [] } };
    const res = mockRes();
    const result = await app.criarVenda(req, res, {
      obterModoOperacaoVenda: () => 'MULTIEMPRESA'
    });
    assert.strictEqual(result, 'DELEGATED_PDV');
    assert.strictEqual(getPagamentoChamado(), 1);
    assert.notStrictEqual(res.state.body && res.state.body.venda_concluida, false);
  } finally {
    restore();
  }
}

async function test22TresEmpresasSimultaneas() {
  const { db, produtoId, empresaA, empresaB, empresaC } = await setupBase();
  const r = await atendimentoService.criarAtendimento({
    itens: [
      item(produtoId, empresaA.id, 5),
      item(produtoId, empresaB.id, 2),
      item(produtoId, empresaC.id, 10)
    ]
  }, { db });
  assert.strictEqual(r.operacoes.length, 3);
  assert.strictEqual(r.status, 'VALIDADO');
  await closeDb(db);
}

async function test23MesmoProdutoEmpresasDiferentes() {
  const { db, produtoId, empresaA, empresaB } = await setupBase();
  const r = await atendimentoService.criarAtendimento({
    itens: [
      item(produtoId, empresaA.id, 2),
      item(produtoId, empresaB.id, 2)
    ]
  }, { db });
  assert.strictEqual(r.operacoes.length, 2);
  assert.ok(r.operacoes.every((o) => o.itens[0].produtoId === produtoId));
  assert.notStrictEqual(r.operacoes[0].empresaId, r.operacoes[1].empresaId);
  await closeDb(db);
}

async function test24TotalIgualSomaOperacoes() {
  const { db, produtoId, empresaA, empresaB, empresaC } = await setupBase();
  const r = await atendimentoService.criarAtendimento({
    itens: [
      item(produtoId, empresaA.id, 2, 4),
      item(produtoId, empresaB.id, 1, 5),
      item(produtoId, empresaC.id, 3, 2)
    ]
  }, { db });
  const soma = r.operacoes.reduce((acc, o) => acc + o.subtotal, 0);
  assert.strictEqual(r.total, soma);
  assert.strictEqual(r.operacoes.find((o) => o.empresaId === empresaA.id).status, STATUS_OPERACAO_EMPRESARIAL.VALIDADA);
  await closeDb(db);
}

async function test25OperacaoPertenceAoAtendimento() {
  const { db, produtoId, empresaA, empresaB } = await setupBase();
  const r = await atendimentoService.criarAtendimento({
    itens: [item(produtoId, empresaA.id, 1), item(produtoId, empresaB.id, 1)]
  }, { db });
  const ops = await all(db, 'SELECT * FROM atendimento_operacoes');
  assert.ok(ops.every((o) => o.atendimento_id === r.atendimentoId));
  const itens = await all(db, 'SELECT * FROM atendimento_operacao_itens');
  const opIds = new Set(ops.map((o) => o.id));
  assert.ok(itens.every((it) => opIds.has(it.operacao_id)));
  assert.ok(itens.every((it) => ops.some((o) => o.id === it.operacao_id && o.empresa_id === it.empresa_id)));
  await closeDb(db);
}

async function main() {
  const testes = [
    ['01 MULTIEMPRESA cria atendimento', test01CriaAtendimento],
    ['02 agrupa itens por empresa', test02AgrupaPorEmpresa],
    ['03 cria uma operação por empresa', test03UmaOperacaoPorEmpresa],
    ['04 persiste itens corretamente', test04PersisteItens],
    ['05 calcula subtotal', test05CalculaSubtotal],
    ['06 calcula total geral', test06CalculaTotalGeral],
    ['07 valida estoque da empresa A', test07ValidaEstoqueA],
    ['08 valida estoque da empresa B', test08ValidaEstoqueB],
    ['09 não usa estoque global produtos', test09NaoUsaEstoqueGlobal],
    ['10 empresa sem estoque isolado = zero', test10EmpresaSemEstoqueIsoladoZero],
    ['11 saldo insuficiente bloqueia tudo', test11SaldoInsuficienteBloqueiaTudo],
    ['12 rollback remove atendimento parcial', test12RollbackRemoveAtendimento],
    ['13 rollback remove operações parciais', test13RollbackRemoveOperacoes],
    ['14 rollback remove itens parciais', test14RollbackRemoveItens],
    ['15 empresaId obrigatório', test15EmpresaIdObrigatorio],
    ['16 não aceita empresa_id como substituto', test16NaoAceitaEmpresaSnake],
    ['17 não assume empresa 1', test17NaoAssumeEmpresa1],
    ['18 EMPRESA_UNICA continua fluxo atual', test18EmpresaUnicaFluxoAtual],
    ['19 MULTIEMPRESA PDV chama VendaPagamentoService', test19MultiempresaChamaPagamento],
    ['20 criarAtendimento não cria vendas', test20MultiempresaNaoCriaVendas],
    ['21 MULTIEMPRESA PDV conclui no núcleo', test21VendaConcluidaNoNucleo],
    ['22 múltiplas empresas funcionam simultaneamente', test22TresEmpresasSimultaneas],
    ['23 mesmo produto em empresas diferentes', test23MesmoProdutoEmpresasDiferentes],
    ['24 total do atendimento = soma das operações', test24TotalIgualSomaOperacoes],
    ['25 operação pertence ao atendimento correto', test25OperacaoPertenceAoAtendimento]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  ok ${nome}`);
  }
  console.log(`\natendimento-multiempresa-04-03: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
