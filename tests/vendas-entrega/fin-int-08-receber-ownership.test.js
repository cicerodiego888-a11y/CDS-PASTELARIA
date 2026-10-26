'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const MOTOR_PATH = path.resolve(ROOT, 'backend/services/entrega/MotorFinalizacaoVenda.js');
const DATABASE_PATH = path.resolve(ROOT, 'backend/database.js');

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
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

async function criarFixture() {
  const db = await openDb();
  await run(db, `CREATE TABLE clientes (
    id INTEGER PRIMARY KEY,
    nome TEXT,
    cpf_cnpj TEXT,
    credito_atual REAL DEFAULT 0
  )`);
  await run(db, `CREATE TABLE vendas (
    id INTEGER PRIMARY KEY,
    codigo TEXT,
    tipo_venda TEXT,
    cliente_id INTEGER,
    total REAL,
    valor_fiscal REAL,
    valor_nao_fiscal REAL,
    status TEXT,
    status_venda TEXT,
    status_entrega TEXT,
    status_pagamento TEXT,
    pagamento_previsto TEXT,
    cancelada INTEGER DEFAULT 0,
    prestacao_realizada INTEGER DEFAULT 0,
    caixa_sessao_id INTEGER,
    caixa_id INTEGER,
    empresa_id INTEGER,
    troco_para REAL,
    leva_maquineta INTEGER,
    entregador TEXT,
    endereco_entrega TEXT,
    prestado_por INTEGER,
    prestado_em TEXT,
    forma_pagamento TEXT,
    valor_recebido REAL,
    data_cancelamento TEXT
  )`);
  await run(db, `CREATE TABLE vendas_itens (
    id INTEGER PRIMARY KEY,
    venda_id INTEGER NOT NULL
  )`);
  await run(db, `CREATE TABLE venda_pagamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    venda_id INTEGER,
    forma_pagamento TEXT,
    valor REAL,
    tef_transacao_id TEXT,
    tef_nsu TEXT,
    tef_autorizacao TEXT,
    tef_bandeira TEXT,
    tef_adquirente TEXT,
    tef_comprovante_cliente TEXT,
    tef_comprovante_estabelecimento TEXT
  )`);
  await run(db, `CREATE TABLE financeiro (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT,
    descricao TEXT,
    valor REAL,
    data_movimento TEXT,
    categoria TEXT,
    forma_pagamento TEXT,
    referencia_id INTEGER,
    referencia_tipo TEXT,
    status TEXT,
    origem TEXT,
    documento TEXT,
    vencimento TEXT,
    numero_parcela INTEGER,
    total_parcelas INTEGER,
    venda_id INTEGER,
    pessoa_nome TEXT,
    baixado_em TEXT,
    empresa_id INTEGER
  )`);
  await run(db, `CREATE TABLE contas_receber (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    venda_id INTEGER,
    cliente_id INTEGER,
    numero_parcela INTEGER,
    total_parcelas INTEGER,
    valor_parcela REAL,
    valor_restante REAL,
    data_vencimento TEXT,
    status TEXT,
    empresa_id INTEGER
  )`);
  await run(db, `INSERT INTO clientes (id, nome, cpf_cnpj) VALUES (10, 'Cliente teste', '123')`);
  return db;
}

function carregarMotor(db) {
  const mocks = new Map([
    [DATABASE_PATH, db],
    [path.resolve(ROOT, 'backend/services/configuracaoService.js'), {
      recursoHabilitado: () => true,
      getModoConfirmacaoFiscal: () => 'TEF'
    }],
    [path.resolve(ROOT, 'backend/services/OrquestradorPagamento.js'), {
      processarFluxoPagamentoVenda: async () => ({
        sucesso: true,
        statusPagamento: 'pendente',
        recebimentos: []
      })
    }],
    [path.resolve(ROOT, 'backend/services/tef/tefConfigService.js'), {
      obterConfiguracao: async () => ({ tefHabilitado: false })
    }],
    [path.resolve(ROOT, 'backend/services/tef/tefFluxoPagamento.js'), {
      parseTefHabilitado: () => false
    }],
    [path.resolve(ROOT, 'backend/services/vendas/VendaFinanceiroService.js'), {
      agoraLocalBrasil: () => '2026-10-26T12:00:00-03:00',
      validarSomaPagamentosVenda: () => null
    }],
    [path.resolve(ROOT, 'backend/services/vendas/VendaFiscalService.js'), {
      emitirFiscalSeSolicitado: async () => null
    }],
    [path.resolve(ROOT, 'backend/services/vendas/VendaPagamentoService.js'), {
      gravarRecebimentos: (_vendaId, _recebimentos, callback) => callback(),
      aplicarRegraStatusPagamentoVenda: ({ statusPagamento, recebimentos }) => ({
        statusPagamento,
        recebimentos
      })
    }],
    [path.resolve(ROOT, 'backend/services/estoque/EstoqueConsumoReserva.js'), {
      consumirReservasDaVenda: async () => ({})
    }],
    [path.resolve(ROOT, 'backend/services/estoque/EstoqueReservaService.js'), {
      liberarReservasDaVenda: async () => ({}),
      montarOptsPortaReservaPdv: () => ({})
    }],
    [path.resolve(ROOT, 'backend/services/auditoria.js'), {
      gravarAuditoria: async () => {}
    }],
    [path.resolve(ROOT, 'backend/services/entrega/ComprovantePrestacao.js'), {
      montarHtmlComprovantePrestacao: () => '<div>comprovante isolado</div>'
    }]
  ]);
  const originalLoad = Module._load;
  delete require.cache[MOTOR_PATH];
  let motor;
  try {
    Module._load = function(request, parent, isMain) {
      let resolved;
      try {
        resolved = Module._resolveFilename(request, parent, isMain);
      } catch (_err) {
        resolved = null;
      }
      if (mocks.has(resolved)) return mocks.get(resolved);
      return originalLoad.apply(this, arguments);
    };
    motor = require(MOTOR_PATH);
  } finally {
    Module._load = originalLoad;
  }
  return {
    motor,
    restaurar() {
      delete require.cache[MOTOR_PATH];
    }
  };
}

async function criarVenda(db, { id, empresaId }) {
  await run(
    db,
    `INSERT INTO vendas (
       id, codigo, tipo_venda, cliente_id, total, valor_fiscal, valor_nao_fiscal,
       status, status_venda, status_entrega, pagamento_previsto, empresa_id
     ) VALUES (?, ?, 'ENTREGA', 10, 125, 0, 125, 'aberta', 'ABERTA',
               'AGUARDANDO_PRESTACAO', 'prazo', ?)`,
    [id, `V-${id}`, empresaId]
  );
  await run(db, `INSERT INTO vendas_itens (venda_id) VALUES (?)`, [id]);
}

async function finalizar(motor, vendaId, empresaId) {
  return motor.finalizarPrestacao({
    vendaId,
    body: { forma_pagamento: 'prazo' },
    req: {
      empresaId,
      caixaSessao: { empresa_id: empresaId },
      user: { id: 7, nome: 'Operador teste' }
    }
  });
}

describe('FIN-INT-08 — ownership dos recebíveis em finalização de entrega', () => {
  it('grava contas a receber e financeiro com a empresa da venda A e B, sem duplicar', async () => {
    const db = await criarFixture();
    const { motor, restaurar } = carregarMotor(db);
    try {
      await criarVenda(db, { id: 101, empresaId: 1 });
      await criarVenda(db, { id: 202, empresaId: 2 });
      await finalizar(motor, 101, 1);
      await finalizar(motor, 202, 2);

      const recebiveisA = await all(
        db,
        `SELECT venda_id, empresa_id FROM contas_receber WHERE empresa_id = ?`,
        [1]
      );
      const recebiveisB = await all(
        db,
        `SELECT venda_id, empresa_id FROM contas_receber WHERE empresa_id = ?`,
        [2]
      );
      assert.deepEqual(recebiveisA, [{ venda_id: 101, empresa_id: 1 }]);
      assert.deepEqual(recebiveisB, [{ venda_id: 202, empresa_id: 2 }]);

      const financeiros = await all(
        db,
        `SELECT venda_id, empresa_id FROM financeiro ORDER BY venda_id`
      );
      assert.deepEqual(financeiros, [
        { venda_id: 101, empresa_id: 1 },
        { venda_id: 202, empresa_id: 2 }
      ]);

      const duplicados = await get(
        db,
        `SELECT
           (SELECT COUNT(*) FROM contas_receber WHERE venda_id IN (101, 202)) AS recebiveis,
           (SELECT COUNT(*) FROM financeiro WHERE venda_id IN (101, 202) AND origem = 'venda') AS legados`
      );
      assert.equal(duplicados.recebiveis, 2);
      assert.equal(duplicados.legados, 2);
    } finally {
      restaurar();
      await closeDb(db);
    }
  });

  it('falha antes de gravar quando a venda não tem empresa proprietária', async () => {
    const db = await criarFixture();
    const { motor, restaurar } = carregarMotor(db);
    try {
      await criarVenda(db, { id: 303, empresaId: null });
      await assert.rejects(
        finalizar(motor, 303, 1),
        (err) => err.code === 'EMPRESA_OWNERSHIP_REQUIRED'
      );
      const contas = await get(db, `SELECT COUNT(*) AS n FROM contas_receber WHERE venda_id = 303`);
      const financeiros = await get(db, `SELECT COUNT(*) AS n FROM financeiro WHERE venda_id = 303`);
      const venda = await get(db, `SELECT prestacao_realizada FROM vendas WHERE id = 303`);
      assert.equal(contas.n, 0);
      assert.equal(financeiros.n, 0);
      assert.equal(venda.prestacao_realizada, 0);
    } finally {
      restaurar();
      await closeDb(db);
    }
  });

  it('rejeita contexto ou caixa divergente da empresa proprietária da venda', async () => {
    const db = await criarFixture();
    const { motor, restaurar } = carregarMotor(db);
    try {
      await criarVenda(db, { id: 404, empresaId: 1 });
      await assert.rejects(
        motor.finalizarPrestacao({
          vendaId: 404,
          body: { forma_pagamento: 'prazo' },
          req: {
            empresaId: 2,
            caixaSessao: { empresa_id: 2 },
            user: { id: 7, nome: 'Operador teste' }
          }
        }),
        (err) => err.code === 'FINANCEIRO_EMPRESA_DIVERGENTE'
      );
      const contas = await get(db, `SELECT COUNT(*) AS n FROM contas_receber WHERE venda_id = 404`);
      const financeiros = await get(db, `SELECT COUNT(*) AS n FROM financeiro WHERE venda_id = 404`);
      assert.equal(contas.n, 0);
      assert.equal(financeiros.n, 0);
    } finally {
      restaurar();
      await closeDb(db);
    }
  });
});
