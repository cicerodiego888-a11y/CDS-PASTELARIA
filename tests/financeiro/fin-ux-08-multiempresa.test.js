'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.resolve(__dirname, '../..');
const DB_PATH = path.resolve(ROOT, 'backend/database.js');
const ROUTE_PATH = path.resolve(ROOT, 'backend/rotas/financeiro.js');

function openMemoryDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (error) => (error ? reject(error) : resolve(db)));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) return reject(error);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function closeDb(db) {
  return new Promise((resolve, reject) => {
    db.close((error) => (error ? reject(error) : resolve()));
  });
}

async function createFixture() {
  const db = await openMemoryDb();
  await run(db, `CREATE TABLE empresas (
    id INTEGER PRIMARY KEY,
    cnpj TEXT,
    razao_social TEXT,
    nome_fantasia TEXT,
    ativo INTEGER NOT NULL
  )`);
  await run(db, `INSERT INTO empresas (id, cnpj, razao_social, nome_fantasia, ativo) VALUES
    (1, '11111111000111', 'Empresa Um LTDA', 'Empresa Um', 1),
    (2, '22222222000122', 'Empresa Dois LTDA', 'Empresa Dois', 1),
    (3, NULL, 'Empresa Três LTDA', 'Empresa Três', 1),
    (4, '44444444000144', 'Empresa Sem Vínculo LTDA', 'Empresa Sem Vínculo', 1)`);
  await run(db, `CREATE TABLE usuario_empresas (
    id INTEGER PRIMARY KEY,
    usuario_id INTEGER NOT NULL,
    empresa_id INTEGER NOT NULL,
    ativo INTEGER NOT NULL
  )`);
  await run(db, `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES
    (10, 1, 1), (10, 2, 1), (10, 3, 1), (11, 1, 1)`);
  await run(db, `CREATE TABLE vendas (
    id INTEGER PRIMARY KEY,
    empresa_id INTEGER NOT NULL,
    cancelada INTEGER DEFAULT 0,
    status TEXT
  )`);
  await run(db, `INSERT INTO vendas (id, empresa_id, cancelada, status) VALUES
    (10, 1, 0, 'concluida'),
    (20, 2, 0, 'cancelada')`);
  await run(db, `CREATE TABLE contas_receber (
    id INTEGER PRIMARY KEY,
    venda_id INTEGER,
    empresa_id INTEGER NOT NULL,
    numero_parcela INTEGER,
    status TEXT NOT NULL,
    valor_restante REAL NOT NULL
  )`);
  await run(db, `INSERT INTO contas_receber (
    id, venda_id, empresa_id, numero_parcela, status, valor_restante
  ) VALUES
    (101, 10, 1, 1, 'pago', 0),
    (102, NULL, 1, 2, 'aberto', 40),
    (103, 20, 1, 3, 'aberto', 10),
    (201, NULL, 2, 1, 'aberto', 60)`);
  await run(db, `CREATE TABLE contas_receber_pagamentos (
    id INTEGER PRIMARY KEY,
    conta_receber_id INTEGER NOT NULL,
    valor_pago REAL NOT NULL,
    data_pagamento TEXT NOT NULL
  )`);
  await run(db, `INSERT INTO contas_receber_pagamentos (
    id, conta_receber_id, valor_pago, data_pagamento
  ) VALUES (1, 101, 50, '2026-10-07')`);
  await run(db, `CREATE TABLE financeiro (
    id INTEGER PRIMARY KEY,
    empresa_id INTEGER NOT NULL,
    tipo TEXT NOT NULL,
    valor REAL NOT NULL,
    data_movimento TEXT,
    vencimento TEXT,
    status TEXT,
    venda_id INTEGER,
    referencia_id INTEGER,
    referencia_tipo TEXT,
    numero_parcela INTEGER,
    origem TEXT
  )`);
  await run(db, `INSERT INTO financeiro (
    id, empresa_id, tipo, valor, data_movimento, vencimento, status, venda_id,
    referencia_id, referencia_tipo, numero_parcela, origem
  ) VALUES
    (1, 1, 'receita', 100, '2026-10-05', NULL, 'recebido', NULL, NULL, NULL, NULL, 'manual'),
    (2, 1, 'receita', 50, '2026-10-07', NULL, 'recebido', 10, 10, 'venda', 1, 'venda'),
    (3, 1, 'despesa', 30, '2026-10-06', NULL, 'pago', NULL, NULL, NULL, NULL, 'manual'),
    (4, 1, 'despesa', 30, '2026-10-06', NULL, 'pago', NULL, 35, 'contas_pagar_mcf', NULL, 'mcf_compatibilidade'),
    (5, 1, 'receita', 15, '2026-09-01', '2026-11-01', 'pendente', NULL, NULL, NULL, NULL, 'manual'),
    (6, 1, 'despesa', 20, '2026-09-01', '2026-11-02', 'pendente', NULL, NULL, NULL, NULL, 'manual'),
    (7, 2, 'receita', 200, '2026-10-08', NULL, 'recebido', NULL, NULL, NULL, NULL, 'manual'),
    (8, 2, 'despesa', 40, '2026-10-09', NULL, 'pago', NULL, NULL, NULL, NULL, 'manual'),
    (9, 2, 'despesa', 12, '2026-09-02', '2026-11-03', 'pendente', NULL, NULL, NULL, NULL, 'manual')`);
  await run(db, `CREATE TABLE contas_pagar (
    id INTEGER PRIMARY KEY,
    empresa_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    valor_restante REAL NOT NULL
  )`);
  await run(db, `INSERT INTO contas_pagar (id, empresa_id, status, valor_restante) VALUES
    (35, 1, 'aberto', 35),
    (36, 2, 'aberto', 18)`);
  await run(db, `CREATE TABLE contas_pagar_pagamentos (
    id INTEGER PRIMARY KEY,
    empresa_id INTEGER NOT NULL,
    data_pagamento TEXT NOT NULL,
    valor_pago REAL NOT NULL
  )`);
  await run(db, `INSERT INTO contas_pagar_pagamentos (
    id, empresa_id, data_pagamento, valor_pago
  ) VALUES (1, 1, '2026-10-06', 30)`);
  return db;
}

function loadFinanceiroRouter(db) {
  delete require.cache[ROUTE_PATH];
  const originalLoad = Module._load;
  Module._load = function loadWithFixture(request, parent, isMain) {
    let resolved;
    try {
      resolved = Module._resolveFilename(request, parent, isMain);
    } catch (_error) {
      resolved = null;
    }
    if (resolved === DB_PATH) return db;
    return originalLoad.apply(this, arguments);
  };
  try {
    return require(ROUTE_PATH);
  } finally {
    Module._load = originalLoad;
  }
}

function getMultiempresaHandler(router) {
  const layer = router.stack.find(
    (item) => item.route && item.route.path === '/dashboard/multiempresa' && item.route.methods.get
  );
  assert.ok(layer, 'GET /dashboard/multiempresa deve existir');
  assert.equal(layer.route.stack.length, 1, 'A rota consolidada deve validar seu próprio escopo autorizado');
  return layer.route.stack[0].handle;
}

function getRouteHandler(router, routePath) {
  const layer = router.stack.find(
    (item) => item.route && item.route.path === routePath && item.route.methods.get
  );
  assert.ok(layer, `GET ${routePath} deve existir`);
  return layer.route.stack[0].handle;
}

async function requestDashboard(handler, userId, empresaId = 'todas', periodo = {}) {
  const response = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
  await handler({
    user: userId == null ? null : { id: userId },
    query: {
      empresaId,
      dataInicio: periodo.dataInicio || '2026-10-01',
      dataFim: periodo.dataFim || '2026-10-31'
    }
  }, response);
  return response;
}

async function requestHandler(handler, userId, query = {}) {
  const response = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
  await handler({
    user: userId == null ? null : { id: userId },
    query
  }, response);
  return response;
}

describe('FIN-UX-08 — Dashboard Financeiro Multiempresa', () => {
  it('consolida as três empresas autorizadas, sem duplicar CR legado ou projeção MCF', async () => {
    const db = await createFixture();
    try {
      const handler = getMultiempresaHandler(loadFinanceiroRouter(db));
      const response = await requestDashboard(handler, 10);
      assert.equal(response.statusCode, 200);
      assert.equal(response.body.empresas.length, 3);

      const empresaUm = response.body.empresas.find((empresa) => empresa.id === 1);
      const empresaDois = response.body.empresas.find((empresa) => empresa.id === 2);
      const empresaTres = response.body.empresas.find((empresa) => empresa.id === 3);
      assert.deepEqual(empresaUm.resumo, {
        totalRecebido: 150,
        totalPago: 60,
        totalReceber: 65,
        totalPagar: 55
      });
      assert.deepEqual(empresaDois.resumo, {
        totalRecebido: 200,
        totalPago: 40,
        totalReceber: 60,
        totalPagar: 30
      });
      assert.deepEqual(empresaTres.resumo, {
        totalRecebido: 0,
        totalPago: 0,
        totalReceber: 0,
        totalPagar: 0
      });
      assert.deepEqual(response.body.resumo, {
        totalRecebido: 350,
        totalPago: 100,
        totalReceber: 125,
        totalPagar: 85
      });
      assert.equal(response.body.periodo.dataReferenciaAbertos != null, true);
      assert.equal(response.body.serieTemporal.reduce((total, item) => total + item.recebido, 0), 350);
      assert.equal(response.body.serieTemporal.reduce((total, item) => total + item.pago, 0), 100);
    } finally {
      await closeDb(db);
    }
  });

  it('filtra o fluxo pelo período e mantém os saldos em aberto como posição na data de referência', async () => {
    const db = await createFixture();
    try {
      const handler = getMultiempresaHandler(loadFinanceiroRouter(db));
      const response = await requestDashboard(handler, 10, 'todas', {
        dataInicio: '2026-10-08',
        dataFim: '2026-10-08'
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.body.resumo.totalRecebido, 200);
      assert.equal(response.body.resumo.totalPago, 0);
      assert.equal(response.body.resumo.totalReceber, 125);
      assert.equal(response.body.resumo.totalPagar, 85);
      assert.deepEqual(response.body.serieTemporal, [{
        data: '2026-10-08',
        recebido: 200,
        pago: 0
      }]);
    } finally {
      await closeDb(db);
    }
  });

  it('seleciona individualmente cada empresa autorizada e corresponde ao consolidado', async () => {
    const db = await createFixture();
    try {
      const handler = getMultiempresaHandler(loadFinanceiroRouter(db));
      const consolidado = await requestDashboard(handler, 10);
      const respostas = [];
      for (const empresaId of [1, 2, 3]) {
        const response = await requestDashboard(handler, 10, String(empresaId));
        assert.equal(response.statusCode, 200);
        assert.equal(response.body.escopo, 'empresa');
        assert.equal(response.body.empresas.length, 1);
        assert.equal(response.body.empresas[0].id, empresaId);
        respostas.push(response.body.empresas[0].resumo);
      }

      for (const campo of ['totalRecebido', 'totalPago', 'totalReceber', 'totalPagar']) {
        assert.equal(
          respostas.reduce((total, resumo) => total + resumo[campo], 0),
          consolidado.body.resumo[campo]
        );
      }
    } finally {
      await closeDb(db);
    }
  });

  it('bloqueia empresa ativa sem vínculo antes de consultar tabelas financeiras', async () => {
    const db = await createFixture();
    try {
      const handler = getMultiempresaHandler(loadFinanceiroRouter(db));
      const all = db.all;
      let consultasFinanceiras = 0;
      db.all = function countFinancialQueries(sql, params, callback) {
        if (/FROM financeiro f|FROM contas_receber cr|FROM contas_pagar cp/i.test(sql)) {
          consultasFinanceiras += 1;
        }
        return all.call(this, sql, params, callback);
      };

      const response = await requestDashboard(handler, 11, '2');
      assert.equal(response.statusCode, 403);
      assert.equal(response.body.code, 'EMPRESA_NAO_AUTORIZADA');
      assert.equal(consultasFinanceiras, 0);
    } finally {
      await closeDb(db);
    }
  });

  it('não apresenta consolidação parcial quando uma fonte financeira falha', async () => {
    const db = await createFixture();
    try {
      const handler = getMultiempresaHandler(loadFinanceiroRouter(db));
      await run(db, 'DROP TABLE contas_pagar_pagamentos');
      const response = await requestDashboard(handler, 10);
      assert.equal(response.statusCode, 500);
      assert.equal(response.body.success, false);
      assert.equal(Object.prototype.hasOwnProperty.call(response.body, 'resumo'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(response.body, 'empresas'), false);
    } finally {
      await closeDb(db);
    }
  });

  it('consolida o Histórico somente das empresas autorizadas, aplica filtros e identifica a origem', async () => {
    const db = await createFixture();
    try {
      const router = loadFinanceiroRouter(db);
      const handler = getRouteHandler(router, '/multiempresa/historico');
      const response = await requestHandler(handler, 10, {
        dataInicio: '2026-10-01',
        dataFim: '2026-10-31',
        tipo: 'receita',
        status: 'recebido'
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(
        response.body.map((row) => row.empresa_id).sort(),
        [1, 1, 2]
      );
      assert.equal(response.body.find((row) => row.empresa_id === 1).empresa_nome, 'Empresa Um');
      assert.equal(response.body.find((row) => row.empresa_id === 2).empresa_nome, 'Empresa Dois');
      assert.equal(response.body.some((row) => row.empresa_id === 3), false);
      assert.equal(response.body.every((row) => row.tipo === 'receita' && row.status === 'recebido'), true);

      const saidas = await requestHandler(handler, 10, {
        dataInicio: '2026-10-01',
        dataFim: '2026-10-31',
        tipo: 'despesa',
        status: 'pago'
      });
      assert.equal(saidas.statusCode, 200);
      // Projeção MCF de Contas a Pagar (compra/AP) deve aparecer no Histórico de saídas
      assert.equal(saidas.body.some((row) => row.origem === 'mcf_compatibilidade'), true);
      assert.equal(saidas.body.some((row) => Number(row.valor) === 30 && row.empresa_id === 1), true);

      const restrita = await requestHandler(handler, 11);
      assert.equal(restrita.statusCode, 200);
      assert.equal(restrita.body.length > 0, true);
      assert.equal(restrita.body.every((row) => row.empresa_id === 1), true);
    } finally {
      await closeDb(db);
    }
  });

  it('falha o Histórico consolidado integralmente se a consulta compartilhada falhar', async () => {
    const db = await createFixture();
    try {
      const handler = getRouteHandler(loadFinanceiroRouter(db), '/multiempresa/historico');
      const all = db.all;
      db.all = function failFinancialQuery(sql, params, callback) {
        if (/FROM financeiro f/i.test(sql)) {
          return callback(new Error('Falha sintética da consulta do Histórico'));
        }
        return all.call(this, sql, params, callback);
      };

      const response = await requestHandler(handler, 10);
      assert.equal(response.statusCode, 500);
      assert.equal(response.body.success, false);
      assert.equal(Array.isArray(response.body), false);
    } finally {
      await closeDb(db);
    }
  });
});
