'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.resolve(__dirname, '../..');
const DB_PATH = path.resolve(ROOT, 'backend/database.js');
const ROUTE_PATH = path.resolve(ROOT, 'backend/rotas/financeiro.js');
const SERVICE_PATH = path.resolve(ROOT, 'backend/services/vendas/VendaFinanceiroService.js');
const CONTEXTO_PATH = path.resolve(
  ROOT,
  'backend/services/financeiro/FinanceiroEmpresaContextoService.js'
);
const AUDITORIA_PATH = path.resolve(ROOT, 'backend/services/auditoria.js');
const CAIXA_PATH = path.resolve(ROOT, 'backend/middleware/validarCaixaAberto.js');
const contextoReal = require(CONTEXTO_PATH);

function openMemoryDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', err => (err ? reject(err) : resolve(db)));
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
  return new Promise(resolve => db.close(() => resolve()));
}

async function createFixture() {
  const db = await openMemoryDb();
  await run(db, 'PRAGMA foreign_keys = ON');
  await run(db, 'CREATE TABLE empresas (id INTEGER PRIMARY KEY)');
  await run(db, 'INSERT INTO empresas (id) VALUES (1), (2)');
  await run(db, 'CREATE TABLE clientes (id INTEGER PRIMARY KEY, nome TEXT, credito_atual REAL DEFAULT 0)');
  await run(db, `INSERT INTO clientes (id, nome) VALUES (1, 'Cliente A'), (2, 'Cliente B')`);
  await run(db, `CREATE TABLE vendas (
    id INTEGER PRIMARY KEY, codigo TEXT, empresa_id INTEGER, total REAL,
    data_venda TEXT, status TEXT, cancelada INTEGER DEFAULT 0,
    status_pagamento TEXT, forma_pagamento TEXT, cliente_id INTEGER,
    FOREIGN KEY (empresa_id) REFERENCES empresas(id)
  )`);
  await run(db, `INSERT INTO vendas (
    id, codigo, empresa_id, total, data_venda, status, status_pagamento, forma_pagamento, cliente_id
  ) VALUES
    (10, 'V-A', 1, 100, '2026-10-01', 'concluida', 'pendente', 'dinheiro', 1),
    (20, 'V-B', 2, 999, '2026-10-02', 'concluida', 'pendente', 'dinheiro', 2)`);
  await run(db, `CREATE TABLE contas_receber (
    id INTEGER PRIMARY KEY, venda_id INTEGER, cliente_id INTEGER, empresa_id INTEGER,
    numero_parcela INTEGER, total_parcelas INTEGER, componente TEXT,
    valor_parcela REAL, valor_restante REAL, data_vencimento TEXT,
    data_pagamento TEXT, status TEXT, observacao TEXT,
    FOREIGN KEY (venda_id) REFERENCES vendas(id),
    FOREIGN KEY (cliente_id) REFERENCES clientes(id),
    FOREIGN KEY (empresa_id) REFERENCES empresas(id)
  )`);
  await run(db, `INSERT INTO contas_receber (
    id, venda_id, cliente_id, empresa_id, numero_parcela, total_parcelas,
    componente, valor_parcela, valor_restante, data_vencimento, status
  ) VALUES
    (101, 20, 1, 1, 1, 1, 'produtos', 100, 80, '2026-11-01', 'aberto'),
    (102, 10, 1, 1, 1, 1, 'produtos', 50, 50, '2026-11-03', 'aberto'),
    (201, 20, 2, 2, 1, 1, 'produtos', 100, 100, '2026-11-02', 'aberto')`);
  await run(db, `CREATE TABLE financeiro (
    id INTEGER PRIMARY KEY, tipo TEXT, descricao TEXT, valor REAL,
    data_movimento TEXT, vencimento TEXT, categoria TEXT, forma_pagamento TEXT,
    referencia_id INTEGER, referencia_tipo TEXT, status TEXT, origem TEXT,
    documento TEXT, numero_parcela INTEGER, total_parcelas INTEGER, venda_id INTEGER,
    pessoa_nome TEXT, observacao TEXT, baixado_em TEXT, empresa_id INTEGER
  )`);
  await run(db, `INSERT INTO financeiro (
    id, tipo, descricao, valor, data_movimento, vencimento, referencia_id,
    referencia_tipo, status, origem, numero_parcela, total_parcelas, venda_id, empresa_id
  ) VALUES
    (1, 'receita', 'Espelho cruzado A', 25, '2026-10-01', '2026-11-01', 20,
     'venda', 'pendente', 'duplicata', 1, 1, 20, 1),
    (2, 'receita', 'Venda B', 80, '2026-10-01', '2026-11-02', 20,
     'venda', 'pendente', 'duplicata', 1, 1, 20, 2),
    (3, 'receita', 'Venda A', 50, '2026-10-01', '2026-11-03', 10,
     'venda', 'pendente', 'duplicata', 1, 1, 10, 1)`);
  await run(db, `CREATE TABLE contas_receber_pagamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, conta_receber_id INTEGER NOT NULL,
    cliente_id INTEGER NOT NULL, valor_pago REAL NOT NULL, data_pagamento TEXT NOT NULL,
    forma_pagamento TEXT, observacao TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conta_receber_id) REFERENCES contas_receber(id),
    FOREIGN KEY (cliente_id) REFERENCES clientes(id)
  )`);
  return db;
}

function loadFinanceiroModules(db) {
  const originalLoad = Module._load;
  for (const file of [
    ROUTE_PATH,
    SERVICE_PATH,
    CONTEXTO_PATH,
    AUDITORIA_PATH,
    CAIXA_PATH
  ]) {
    delete require.cache[file];
  }
  Module._load = function loadWithFixture(request, parent, isMain) {
    let resolved;
    try {
      resolved = Module._resolveFilename(request, parent, isMain);
    } catch (_err) {
      resolved = null;
    }
    if (resolved === DB_PATH) return db;
    if (resolved === AUDITORIA_PATH) return { gravarAuditoria: async () => {} };
    if (resolved === CAIXA_PATH) {
      return { validarCaixaAberto: (_req, _res, next) => next() };
    }
    if (resolved === CONTEXTO_PATH) {
      return {
        middlewareResolverEmpresaFinanceiro: () => (_req, _res, next) => next(),
        exigirRegistroDaEmpresa: async () => {},
        exigirLancamentoDaEmpresa: async () => {},
        resolverEmpresaDaOrigemFinanceira: contextoReal.resolverEmpresaDaOrigemFinanceira,
        obterMetaEmpresaPorId: async () => null,
        statusDeErroEmpresa: contextoReal.statusDeErroEmpresa
      };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    return {
      router: require(ROUTE_PATH),
      service: require(SERVICE_PATH)
    };
  } finally {
    Module._load = originalLoad;
  }
}

function getHandler(router, routePath, method = 'get') {
  const layer = router.stack.find(
    item => item.route && item.route.path === routePath && item.route.methods[method]
  );
  assert.ok(layer, `${method.toUpperCase()} ${routePath} deve existir`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function invoke(handler, { empresaId, clienteId, body = {} }) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      }
    };
    Promise.resolve(handler({
      empresaId,
      params: { clienteId: String(clienteId) },
      body
    }, res)).catch(reject);
  });
}

describe('FIN-INT-13 — isolamento empresarial nas escritas de Contas a Receber', () => {
  it('cancelamento da empresa B não altera recebíveis nem financeiro cruzados da empresa A', async () => {
    const db = await createFixture();
    try {
      const { service } = loadFinanceiroModules(db);
      const vendaB = await get(db, 'SELECT * FROM vendas WHERE id = 20');

      await assert.rejects(
        service.cancelarFinanceiroVenda(20, { venda: vendaB, empresaId: 1 }),
        err => err.code === 'FINANCEIRO_EMPRESA_DIVERGENTE'
      );
      assert.equal((await get(db, 'SELECT status FROM contas_receber WHERE id = 101')).status, 'aberto');
      assert.equal((await get(db, 'SELECT status FROM financeiro WHERE id = 1')).status, 'pendente');

      const resultado = await service.cancelarFinanceiroVenda(20, {
        venda: vendaB,
        empresaId: 2
      });
      assert.equal(resultado.contas_receber, 1);
      assert.equal((await get(db, 'SELECT status, valor_restante FROM contas_receber WHERE id = 101')).status, 'aberto');
      assert.equal((await get(db, 'SELECT valor_restante FROM contas_receber WHERE id = 101')).valor_restante, 80);
      assert.equal((await get(db, 'SELECT status FROM contas_receber WHERE id = 201')).status, 'cancelado');
      assert.equal((await get(db, 'SELECT status FROM financeiro WHERE id = 1')).status, 'pendente');
      assert.equal((await get(db, 'SELECT status FROM financeiro WHERE id = 2')).status, 'cancelado');
    } finally {
      await closeDb(db);
    }
  });

  it('devolução de B recalcula somente recebíveis e lançamentos da empresa B', async () => {
    const db = await createFixture();
    try {
      const { service } = loadFinanceiroModules(db);
      const vendaB = await get(db, 'SELECT * FROM vendas WHERE id = 20');
      await run(db, 'BEGIN IMMEDIATE');
      const resultado = await service.recalcularFinanceiroDevolucaoVenda(20, 120, vendaB);

      assert.equal(resultado.contas_receber, 1);
      assert.equal((await get(db, 'SELECT valor_restante, status FROM contas_receber WHERE id = 101')).valor_restante, 80);
      assert.equal((await get(db, 'SELECT valor_restante, status FROM contas_receber WHERE id = 201')).valor_restante, 0);
      assert.equal((await get(db, 'SELECT valor, status FROM financeiro WHERE id = 1')).valor, 25);
      assert.equal((await get(db, 'SELECT valor FROM financeiro WHERE id = 2')).valor, 60);
      assert.equal((await get(db, 'SELECT total FROM vendas WHERE id = 20')).total, 879);
      await run(db, 'ROLLBACK');

      assert.equal((await get(db, 'SELECT valor_restante FROM contas_receber WHERE id = 101')).valor_restante, 80);
      assert.equal((await get(db, 'SELECT valor_restante FROM contas_receber WHERE id = 201')).valor_restante, 100);
      assert.equal((await get(db, 'SELECT valor FROM financeiro WHERE id = 2')).valor, 80);
      assert.equal((await get(db, 'SELECT total FROM vendas WHERE id = 20')).total, 999);
    } finally {
      await closeDb(db);
    }
  });

  it('pagamento parcial cruzado retorna 409 sem persistir e o fluxo válido da empresa B funciona', async () => {
    const db = await createFixture();
    try {
      const { router } = loadFinanceiroModules(db);
      const handler = getHandler(
        router,
        '/receber/agrupado/:clienteId/pagamento-parcial',
        'post'
      );
      const cruzado = await invoke(handler, {
        empresaId: 1,
        clienteId: 1,
        body: {
          valor: 10,
          data_pagamento: '2026-10-26',
          forma_pagamento: 'dinheiro'
        }
      });

      assert.equal(cruzado.status, 409);
      assert.equal((await get(db, 'SELECT valor_restante FROM contas_receber WHERE id = 101')).valor_restante, 80);
      assert.equal((await get(db, 'SELECT status FROM contas_receber WHERE id = 102')).status, 'aberto');
      assert.equal((await get(db, 'SELECT COUNT(*) AS total FROM contas_receber_pagamentos')).total, 0);
      assert.equal((await get(db, 'SELECT status FROM financeiro WHERE id = 1')).status, 'pendente');
      assert.equal((await get(db, 'SELECT valor_restante FROM contas_receber WHERE id = 201')).valor_restante, 100);

      const valido = await invoke(handler, {
        empresaId: 2,
        clienteId: 2,
        body: {
          valor: 10,
          data_pagamento: '2026-10-26',
          forma_pagamento: 'dinheiro'
        }
      });
      assert.equal(valido.status, 200);
      assert.equal((await get(db, 'SELECT valor_restante, status FROM contas_receber WHERE id = 201')).valor_restante, 90);
      assert.equal((await get(db, 'SELECT COUNT(*) AS total FROM contas_receber_pagamentos')).total, 1);
      assert.equal((await get(db, 'SELECT status FROM financeiro WHERE id = 2')).status, 'parcial');
      assert.equal((await get(db, 'SELECT status FROM financeiro WHERE id = 1')).status, 'pendente');
    } finally {
      await closeDb(db);
    }
  });
});
