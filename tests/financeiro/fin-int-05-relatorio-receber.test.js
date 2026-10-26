'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.resolve(__dirname, '../..');
const DB_PATH = path.resolve(ROOT, 'backend/database.js');
const FINANCEIRO_ROUTE = path.resolve(ROOT, 'backend/rotas/financeiro.js');
const CONTEXTO_FINANCEIRO = path.resolve(
  ROOT,
  'backend/services/financeiro/FinanceiroEmpresaContextoService.js'
);
const AUDITORIA = path.resolve(ROOT, 'backend/services/auditoria.js');
const VALIDAR_CAIXA = path.resolve(ROOT, 'backend/middleware/validarCaixaAberto.js');

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

function closeDb(db) {
  return new Promise(resolve => db.close(() => resolve()));
}

function addDays(date, days) {
  const result = new Date(`${date}T12:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

async function createFixture() {
  const db = await openMemoryDb();
  const hoje = new Date().toISOString().slice(0, 10);
  await run(db, 'PRAGMA foreign_keys = ON');
  await run(db, `CREATE TABLE empresas (id INTEGER PRIMARY KEY)`);
  await run(db, `INSERT INTO empresas (id) VALUES (1), (2)`);
  await run(db, `CREATE TABLE clientes (
    id INTEGER PRIMARY KEY, nome TEXT, cpf_cnpj TEXT
  )`);
  await run(db, `CREATE TABLE vendas (
    id INTEGER PRIMARY KEY, codigo TEXT, empresa_id INTEGER REFERENCES empresas(id), total REAL,
    valor_fiscal REAL, valor_nao_fiscal REAL, status TEXT, cancelada INTEGER DEFAULT 0
  )`);
  await run(db, `CREATE TABLE financeiro (
    id INTEGER PRIMARY KEY, tipo TEXT, descricao TEXT, documento TEXT, valor REAL,
    data_movimento TEXT, vencimento TEXT, status TEXT, origem TEXT, pessoa_nome TEXT,
    venda_id INTEGER, referencia_id INTEGER, referencia_tipo TEXT,
    numero_parcela INTEGER, empresa_id INTEGER
  )`);
  await run(db, `CREATE TABLE contas_receber (
    id INTEGER PRIMARY KEY, venda_id INTEGER, cliente_id INTEGER, empresa_id INTEGER,
    numero_parcela INTEGER, total_parcelas INTEGER, componente TEXT,
    valor_parcela REAL, valor_restante REAL, data_vencimento TEXT, status TEXT,
    FOREIGN KEY (venda_id) REFERENCES vendas(id),
    FOREIGN KEY (empresa_id) REFERENCES empresas(id)
  )`);
  await run(db, `INSERT INTO clientes (id, nome, cpf_cnpj) VALUES
    (1, 'Cliente Alfa', '111'), (2, 'Cliente Beta', '222')`);
  await run(db, `INSERT INTO vendas (
    id, codigo, empresa_id, total, valor_fiscal, valor_nao_fiscal, status, cancelada
  ) VALUES
    (10, 'V-10', 1, 500, 400, 100, 'concluida', 0),
    (11, 'V-11', 1, 80, 80, 0, 'concluida', 0),
    (12, 'V-12', 1, 40, 40, 0, 'cancelada', 0),
    (20, 'V-20', 2, 999, 999, 0, 'concluida', 0),
    (21, 'V-21', 2, 60, 60, 0, 'cancelada', 0)`);
  await run(db, `INSERT INTO financeiro (
    id, tipo, descricao, documento, valor, data_movimento, vencimento, status,
    origem, pessoa_nome, venda_id, referencia_id, referencia_tipo, numero_parcela, empresa_id
  ) VALUES
    (1, 'receita', 'Espelho venda 10', 'DOC-10', 500, ?, ?, 'pendente',
     'venda', 'Cliente Alfa', 10, 10, 'venda', 1, 1),
    (2, 'receita', 'Manual legado', 'LEG-2', 25, ?, ?, 'pendente',
     'manual', 'Cliente Alfa', NULL, NULL, NULL, NULL, 1),
    (3, 'receita', 'Venda cancelada', 'DOC-12', 40, ?, ?, 'pendente',
     'venda', 'Cliente Alfa', 12, 12, 'venda', 1, 1),
    (4, 'receita', 'Legado liquidado', 'LEG-4', 40, ?, ?, 'recebido',
     'manual', 'Cliente Alfa', NULL, NULL, NULL, NULL, 1)`,
  [
    addDays(hoje, -2), addDays(hoje, 2),
    addDays(hoje, -2), addDays(hoje, 2),
    addDays(hoje, -2), addDays(hoje, -1),
    addDays(hoje, -3), addDays(hoje, -2)
  ]);
  await run(db, `INSERT INTO contas_receber (
    id, venda_id, cliente_id, empresa_id, numero_parcela, total_parcelas, componente,
    valor_parcela, valor_restante, data_vencimento, status
  ) VALUES
    (101, 10, 1, 1, 1, 1, 'produtos', 300, 300, ?, 'aberto'),
    (102, 10, 1, 1, 1, 1, 'outros', 200, 200, ?, 'aberto'),
    (201, 11, 2, 1, 1, 1, 'produtos', 80, 55, ?, 'parcial'),
    (301, 12, 1, 1, 1, 1, 'produtos', 40, 40, ?, 'aberto'),
    (302, 11, 2, 1, 2, 2, 'produtos', 30, 30, ?, 'aberto'),
    (303, 11, 2, 1, 3, 3, 'produtos', 60, 0, ?, 'pago'),
    (401, 20, 1, 2, 1, 1, 'produtos', 999, 999, ?, 'aberto')`,
  [
    addDays(hoje, 2), addDays(hoje, 2), addDays(hoje, 3),
    addDays(hoje, -1), addDays(hoje, -2), addDays(hoje, 1), addDays(hoje, 2)
  ]);
  return { db, hoje };
}

function loadFinanceiroRouter(db) {
  const originalLoad = Module._load;
  for (const file of [FINANCEIRO_ROUTE, CONTEXTO_FINANCEIRO, VALIDAR_CAIXA, AUDITORIA]) {
    delete require.cache[file];
  }
  Module._load = function loadWithFixture(request, parent, isMain) {
    let resolved;
    try {
      resolved = Module._resolveFilename(request, parent, isMain);
    } catch (_) {
      resolved = null;
    }
    if (resolved === DB_PATH) return db;
    if (resolved === AUDITORIA) return { gravarAuditoria: async () => {} };
    if (resolved === VALIDAR_CAIXA) return { validarCaixaAberto: (_req, _res, next) => next() };
    if (resolved === CONTEXTO_FINANCEIRO) {
      return {
        middlewareResolverEmpresaFinanceiro: () => (_req, _res, next) => next(),
        exigirRegistroDaEmpresa: async () => {},
        exigirLancamentoDaEmpresa: async () => {},
        resolverEmpresaDaOrigemFinanceira: ({ empresaId }) => empresaId,
        obterMetaEmpresaPorId: async () => null,
        statusDeErroEmpresa: () => 400
      };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    return require(FINANCEIRO_ROUTE);
  } finally {
    Module._load = originalLoad;
  }
}

function getHandler(router) {
  const layer = router.stack.find(
    item => item.route && item.route.path === '/relatorios/receber' && item.route.methods.get
  );
  assert.ok(layer, 'GET /relatorios/receber deve existir');
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function invoke(handler, empresaId, query = {}) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout da rota de relatório')), 4000);
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        clearTimeout(timeout);
        resolve({ status: this.statusCode, body });
        return this;
      }
    };
    Promise.resolve(handler({ empresaId, query }, res)).catch(err => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

describe('FIN-INT-05 — relatório unificado de Contas a Receber', () => {
  it('preserva originais, saldo, status, filtros, cancelamentos e isolamento por empresa', async () => {
    const { db, hoje } = await createFixture();
    try {
      const handler = getHandler(loadFinanceiroRouter(db));
      const allA = await invoke(handler, 1, { status: 'todas' });
      assert.equal(allA.status, 200);
      assert.equal(allA.body.success, true);
      const contas = allA.body.contas;
      const chaves = contas.map(conta => conta.chave);

      assert.ok(chaves.includes('financeiro:2'), 'recebível manual legado permanece');
      assert.ok(chaves.includes('contas_receber:201'), 'título sem espelho é incluído');
      assert.equal(chaves.includes('financeiro:1'), false, 'espelho FIN-INT-04 é excluído');
      assert.equal(chaves.includes('financeiro:3'), false, 'venda cancelada é excluída');
      assert.equal(chaves.includes('contas_receber:301'), false, 'CR de venda cancelada é excluído');
      assert.equal(contas.some(conta => conta.venda_id === 10 && conta.fonte === 'financeiro'), false);

      const componentes = contas.filter(
        conta => conta.fonte === 'contas_receber' && conta.venda_id === 10
      );
      assert.equal(componentes.length, 2, 'componentes distintos da mesma parcela permanecem');
      assert.equal(componentes.reduce((total, conta) => total + conta.valor_original, 0), 500);
      assert.equal(allA.body.totais.total, 735);

      const parcial = contas.find(conta => conta.chave === 'contas_receber:201');
      assert.equal(parcial.valor_original, 80);
      assert.equal(parcial.valor_recebido, 25);
      assert.equal(parcial.valor_restante, 55);
      assert.equal(parcial.status, 'parcial');
      assert.equal(parcial.status_persistido, 'parcial');

      const liquidado = contas.find(conta => conta.chave === 'contas_receber:303');
      assert.equal(liquidado.status, 'pago');
      assert.equal(liquidado.valor_original, 60);
      assert.equal(liquidado.valor_recebido, 60);
      assert.equal(liquidado.valor_restante, 0);
      const legadoLiquidado = contas.find(conta => conta.chave === 'financeiro:4');
      assert.equal(legadoLiquidado.status, 'recebido');
      assert.equal(legadoLiquidado.valor_restante, 0);

      const onlyB = await invoke(handler, 2, { status: 'todas' });
      assert.deepEqual(onlyB.body.contas.map(conta => conta.chave), ['contas_receber:401']);
      assert.equal(onlyB.body.totais.total, 999);

      const cliente = await invoke(handler, 1, {
        status: 'todas',
        cliente: 'Cliente Beta'
      });
      assert.deepEqual(
        cliente.body.contas.map(conta => conta.chave).sort(),
        ['contas_receber:201', 'contas_receber:302', 'contas_receber:303']
      );

      const periodo = await invoke(handler, 1, {
        status: 'todas',
        dataInicio: addDays(hoje, 2),
        dataFim: addDays(hoje, 2)
      });
      assert.ok(periodo.body.contas.length > 0);
      assert.ok(periodo.body.contas.every(conta => conta.dataVencimento === addDays(hoje, 2)));

      const pendentes = await invoke(handler, 1, { status: 'pendente' });
      assert.ok(pendentes.body.contas.some(conta => conta.chave === 'contas_receber:101'));
      assert.ok(pendentes.body.contas.some(conta => conta.chave === 'financeiro:2'));
      assert.equal(pendentes.body.contas.some(conta => conta.status_persistido === 'parcial'), false);

      const vencidos = await invoke(handler, 1, { status: 'vencido' });
      assert.ok(vencidos.body.contas.length > 0);
      assert.ok(vencidos.body.contas.every(conta => conta.status === 'vencido'));

      const fiscal = await invoke(handler, 1, { status: 'todas', modo_fiscal: '1' });
      assert.equal(fiscal.body.totais.fiscal, 545);
      assert.equal(fiscal.body.contas.some(conta => conta.chave === 'contas_receber:201'), true);
    } finally {
      await closeDb(db);
    }
  });

  it('não usa dados fiscais ou código de venda de outra empresa e preserva recebíveis sem venda', async () => {
    const { db, hoje } = await createFixture();
    try {
      await run(db, `INSERT INTO contas_receber (
        id, venda_id, cliente_id, empresa_id, numero_parcela, total_parcelas,
        componente, valor_parcela, valor_restante, data_vencimento, status
      ) VALUES
        (402, 20, 1, 1, 1, 1, 'produtos', 70, 70, ?, 'aberto'),
        (404, 21, 1, 1, 1, 1, 'outros', 60, 60, ?, 'aberto'),
        (403, NULL, 1, 1, 1, 1, 'outros', 55, 55, ?, 'aberto')`,
      [addDays(hoje, 2), addDays(hoje, 2), addDays(hoje, 2)]);

      const handler = getHandler(loadFinanceiroRouter(db));
      const allA = await invoke(handler, 1, { status: 'todas' });
      assert.equal(allA.status, 200);

      const cruzada = allA.body.contas.find(conta => conta.chave === 'contas_receber:402');
      assert.ok(cruzada, 'recebível da empresa A permanece no relatório da empresa A');
      assert.equal(cruzada.valor_original, 70);
      assert.equal(cruzada.valor_fiscal, 0);
      assert.equal(cruzada.valor_nao_fiscal, 0);
      assert.equal(cruzada.descricao.includes('V-20'), false);
      assert.equal(allA.body.totais.total, 920);

      const vendaCanceladaDeOutraEmpresa = allA.body.contas.find(
        conta => conta.chave === 'contas_receber:404'
      );
      assert.ok(
        vendaCanceladaDeOutraEmpresa,
        'status de venda de outra empresa não exclui o recebível'
      );

      const valida = allA.body.contas.find(conta => conta.chave === 'contas_receber:101');
      assert.ok(valida.descricao.includes('V-10'));
      assert.equal(valida.valor_fiscal, 400);

      const semVenda = allA.body.contas.find(conta => conta.chave === 'contas_receber:403');
      assert.ok(semVenda, 'recebível canônico sem venda associada é preservado');
      assert.equal(semVenda.valor_original, 55);
      assert.equal(semVenda.valor_fiscal, 55);

      const somenteFiscal = await invoke(handler, 1, {
        status: 'todas',
        modo_fiscal: '1'
      });
      assert.equal(
        somenteFiscal.body.contas.some(conta => conta.chave === 'contas_receber:402'),
        false
      );
      assert.equal(somenteFiscal.body.totais.fiscal, 600);
    } finally {
      await closeDb(db);
    }
  });
});
