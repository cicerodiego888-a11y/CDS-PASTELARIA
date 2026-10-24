'use strict';

const assert = require('assert');
const Module = require('module');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database(':memory:');
const databasePath = path.resolve(__dirname, '../../backend/database.js');
const auditoriaPath = path.resolve(__dirname, '../../backend/services/auditoria.js');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  let resolved;
  try {
    resolved = Module._resolveFilename(request, parent, isMain);
  } catch (_) {
    resolved = null;
  }
  if (resolved === databasePath) return db;
  if (resolved === auditoriaPath) return { gravarAuditoria: async () => {} };
  return originalLoad.apply(this, arguments);
};
const router = require('../../backend/rotas/financeiro');
Module._load = originalLoad;

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

async function setup() {
  await run('CREATE TABLE clientes (id INTEGER PRIMARY KEY, nome TEXT)');
  await run(`CREATE TABLE vendas (
    id INTEGER PRIMARY KEY, codigo TEXT, empresa_id INTEGER, cancelada INTEGER DEFAULT 0,
    status TEXT, status_pagamento TEXT
  )`);
  await run(`CREATE TABLE contas_receber (
    id INTEGER PRIMARY KEY, venda_id INTEGER, cliente_id INTEGER, numero_parcela INTEGER,
    total_parcelas INTEGER, componente TEXT, valor_parcela REAL, valor_restante REAL,
    data_vencimento TEXT, data_pagamento TEXT, status TEXT, empresa_id INTEGER
  )`);
  await run(`CREATE TABLE financeiro (
    id INTEGER PRIMARY KEY, tipo TEXT, descricao TEXT, valor REAL, data_movimento TEXT,
    categoria TEXT, forma_pagamento TEXT, referencia_id INTEGER, referencia_tipo TEXT,
    status TEXT, origem TEXT, documento TEXT, vencimento TEXT, numero_parcela INTEGER,
    total_parcelas INTEGER, venda_id INTEGER, pessoa_nome TEXT, observacao TEXT,
    baixado_em TEXT, empresa_id INTEGER
  )`);
  await run(`CREATE TABLE contas_receber_pagamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, conta_receber_id INTEGER, cliente_id INTEGER,
    valor_pago REAL, data_pagamento TEXT, forma_pagamento TEXT, observacao TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  await run(`INSERT INTO clientes (id, nome) VALUES (1, 'Cliente integrado')`);
  await run(`INSERT INTO vendas (id, codigo, empresa_id, status, status_pagamento)
    VALUES (10, 'V-10', 1, 'concluida', 'pendente')`);
  await run(`INSERT INTO contas_receber (
    id, venda_id, cliente_id, numero_parcela, total_parcelas, componente,
    valor_parcela, valor_restante, data_vencimento, status, empresa_id
  ) VALUES
    (101, 10, 1, 1, 1, 'produtos', 16, 16, '2026-04-01', 'aberto', 1),
    (102, 10, 1, 1, 1, 'outros', 5, 5, '2026-04-01', 'aberto', 1)`);
  await run(`INSERT INTO financeiro (
    id, tipo, descricao, valor, data_movimento, categoria, forma_pagamento,
    referencia_id, referencia_tipo, status, origem, vencimento, numero_parcela,
    total_parcelas, venda_id, empresa_id
  ) VALUES (201, 'receita', 'Venda V-10', 21, '2026-03-01', 'vendas', 'prazo',
    10, 'venda', 'pendente', 'venda', '2026-04-01', 1, 1, 10, 1)`);
}

function handler() {
  const layer = router.stack.find((entry) =>
    entry.route && entry.route.path === '/receber/agrupado/:clienteId/pagamento-parcial'
  );
  assert.ok(layer, 'rota de pagamento parcial agrupado registrada');
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function request(valor) {
  const req = {
    params: { clienteId: '1' },
    empresaId: 1,
    body: { valor, data_pagamento: '2026-03-15', forma_pagamento: 'pix' }
  };
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  await handler()(req, res);
  return res;
}

async function main() {
  try {
    await setup();

    const primeiraBaixa = await request(16);
    assert.strictEqual(primeiraBaixa.statusCode, 200);
    assert.strictEqual((await get('SELECT status FROM contas_receber WHERE id = 101')).status, 'recebido');
    assert.strictEqual((await get('SELECT valor_restante FROM contas_receber WHERE id = 102')).valor_restante, 5);
    assert.strictEqual((await get('SELECT status FROM financeiro WHERE id = 201')).status, 'parcial');
    assert.strictEqual((await get('SELECT status_pagamento FROM vendas WHERE id = 10')).status_pagamento, 'pendente');
    assert.strictEqual((await get('SELECT COUNT(*) AS total FROM contas_receber_pagamentos')).total, 1);

    const repeticaoExcedente = await request(16);
    assert.strictEqual(repeticaoExcedente.statusCode, 400);
    assert.strictEqual((await get('SELECT COUNT(*) AS total FROM contas_receber_pagamentos')).total, 1);

    const segundaBaixa = await request(5);
    assert.strictEqual(segundaBaixa.statusCode, 200);
    assert.strictEqual((await get('SELECT status FROM contas_receber WHERE id = 102')).status, 'recebido');
    assert.strictEqual((await get('SELECT status FROM financeiro WHERE id = 201')).status, 'recebido');
    assert.strictEqual((await get('SELECT status_pagamento FROM vendas WHERE id = 10')).status_pagamento, 'quitada');
    assert.strictEqual((await get('SELECT COUNT(*) AS total FROM contas_receber_pagamentos')).total, 2);

    await setupSaldoObsoleto();
    const saldoObsoleto = await request(16);
    assert.strictEqual(saldoObsoleto.statusCode, 409);
    assert.strictEqual((await get('SELECT valor_restante FROM contas_receber WHERE id = 101')).valor_restante, 16);
    assert.strictEqual((await get('SELECT COUNT(*) AS total FROM contas_receber_pagamentos')).total, 0);

    console.log('Sprint 2.3.1 recebimentos integrados OK — componentes, repetição, saldo obsoleto e rollback');
  } finally {
    await new Promise((resolve) => db.close(resolve));
  }
}

async function setupSaldoObsoleto() {
  await run('DELETE FROM contas_receber_pagamentos');
  await run('DELETE FROM financeiro');
  await run('DELETE FROM contas_receber');
  await run(`INSERT INTO contas_receber (
    id, venda_id, cliente_id, numero_parcela, total_parcelas, componente,
    valor_parcela, valor_restante, data_vencimento, status, empresa_id
  ) VALUES (101, 10, 1, 1, 1, 'produtos', 16, 16, '2026-04-01', 'aberto', 1)`);
  await run(`INSERT INTO financeiro (
    id, tipo, descricao, valor, data_movimento, categoria, forma_pagamento,
    referencia_id, referencia_tipo, status, origem, vencimento, numero_parcela,
    total_parcelas, venda_id, empresa_id
  ) VALUES (201, 'receita', 'Venda V-10', 16, '2026-03-01', 'vendas', 'prazo',
    10, 'venda', 'pendente', 'venda', '2026-04-01', 1, 1, 10, 1)`);
  await run(`CREATE TRIGGER alterar_saldo_antes_da_atualizacao
    AFTER INSERT ON contas_receber_pagamentos
    BEGIN
      UPDATE contas_receber
      SET valor_restante = 0, status = 'recebido'
      WHERE id = 101;
    END`);
}

main().catch((err) => {
  console.error('Sprint 2.3.1 recebimentos integrados FALHOU:', err);
  process.exitCode = 1;
});
