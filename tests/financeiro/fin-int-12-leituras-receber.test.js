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

async function createFixture() {
  const db = await openMemoryDb();
  await run(db, 'PRAGMA foreign_keys = ON');
  await run(db, `CREATE TABLE empresas (
    id INTEGER PRIMARY KEY, cnpj TEXT, razao_social TEXT, nome_fantasia TEXT, ativo INTEGER
  )`);
  await run(db, `INSERT INTO empresas (
    id, cnpj, razao_social, nome_fantasia, ativo
  ) VALUES
    (1, '11111111000111', 'Empresa A LTDA', 'Empresa A', 1),
    (2, '22222222000122', 'Empresa B LTDA', 'Empresa B', 1)`);
  await run(db, `CREATE TABLE usuario_empresas (
    id INTEGER PRIMARY KEY, usuario_id INTEGER, empresa_id INTEGER, ativo INTEGER
  )`);
  await run(db, `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES
    (10, 1, 1), (10, 2, 1), (11, 1, 1)`);
  await run(db, `CREATE TABLE clientes (
    id INTEGER PRIMARY KEY, nome TEXT, cpf_cnpj TEXT, telefone TEXT, email TEXT,
    endereco TEXT, cep TEXT, rua TEXT, numero TEXT, bairro TEXT, cidade TEXT, uf TEXT
  )`);
  await run(db, `INSERT INTO clientes (id, nome, cpf_cnpj, telefone) VALUES
    (1, 'Cliente A', '111', '111'),
    (3, 'Cliente B', '333', '333'),
    (4, 'Cliente sem venda', '444', '444')`);
  await run(db, `CREATE TABLE vendas (
    id INTEGER PRIMARY KEY, codigo TEXT, empresa_id INTEGER, total REAL, data_venda TEXT,
    valor_fiscal REAL, valor_nao_fiscal REAL, status TEXT, cancelada INTEGER DEFAULT 0,
    FOREIGN KEY (empresa_id) REFERENCES empresas(id)
  )`);
  await run(db, `INSERT INTO vendas (
    id, codigo, empresa_id, total, data_venda, valor_fiscal, valor_nao_fiscal, status, cancelada
  ) VALUES
    (10, 'V-A', 1, 100, '2026-10-01', 100, 0, 'concluida', 0),
    (11, 'V-A-CANCELADA', 1, 5, '2026-10-04', 5, 0, 'cancelada', 0),
    (20, 'V-B', 2, 999, '2026-10-02', 900, 99, 'concluida', 0),
    (21, 'V-B-CANCELADA', 2, 600, '2026-10-03', 600, 0, 'cancelada', 0)`);
  await run(db, `CREATE TABLE contas_receber (
    id INTEGER PRIMARY KEY, venda_id INTEGER, cliente_id INTEGER, empresa_id INTEGER,
    numero_parcela INTEGER, total_parcelas INTEGER, componente TEXT, valor_parcela REAL,
    valor_restante REAL, data_vencimento TEXT, data_pagamento TEXT, status TEXT,
    FOREIGN KEY (venda_id) REFERENCES vendas(id),
    FOREIGN KEY (cliente_id) REFERENCES clientes(id),
    FOREIGN KEY (empresa_id) REFERENCES empresas(id)
  )`);
  await run(db, `INSERT INTO contas_receber (
    id, venda_id, cliente_id, empresa_id, numero_parcela, total_parcelas, componente,
    valor_parcela, valor_restante, data_vencimento, status
  ) VALUES
    (101, 10, 1, 1, 1, 1, 'produtos', 100, 70, '2026-11-01', 'aberto'),
    (102, 20, 1, 1, 2, 3, 'produtos', 40, 40, '2026-11-02', 'aberto'),
    (103, 21, 1, 1, 3, 3, 'produtos', 60, 60, '2026-11-03', 'aberto'),
    (104, NULL, 1, 1, 4, 4, 'outros', 20, 20, '2026-11-04', 'aberto'),
    (105, NULL, 4, 1, 1, 1, 'outros', 15, 15, '2026-11-05', 'aberto'),
    (106, 11, 1, 1, 5, 5, 'produtos', 5, 5, '2026-11-07', 'aberto'),
    (201, 20, 3, 2, 1, 1, 'produtos', 30, 30, '2026-11-06', 'aberto')`);
  await run(db, `CREATE TABLE financeiro (
    id INTEGER PRIMARY KEY, tipo TEXT, descricao TEXT, valor REAL, data_movimento TEXT,
    vencimento TEXT, status TEXT, origem TEXT, pessoa_nome TEXT, documento TEXT,
    numero_parcela INTEGER, total_parcelas INTEGER, venda_id INTEGER, referencia_id INTEGER,
    referencia_tipo TEXT, empresa_id INTEGER, observacao TEXT, categoria TEXT,
    forma_pagamento TEXT, baixado_em TEXT
  )`);
  await run(db, `INSERT INTO financeiro (
    id, tipo, descricao, valor, data_movimento, vencimento, status, origem, pessoa_nome,
    numero_parcela, total_parcelas, venda_id, referencia_id, referencia_tipo, empresa_id
  ) VALUES
    (1, 'receita', 'Espelho venda A', 100, '2026-10-01', '2026-11-01', 'pendente',
     'venda', 'Cliente A', 1, 1, 10, 10, 'venda', 1),
    (2, 'receita', 'Manual legado', 25, '2026-10-01', '2026-11-01', 'pendente',
     'manual', 'Cliente A', NULL, NULL, NULL, NULL, NULL, 1)`);
  await run(db, `CREATE TABLE contas_receber_pagamentos (
    id INTEGER PRIMARY KEY, conta_receber_id INTEGER, cliente_id INTEGER, valor_pago REAL,
    data_pagamento TEXT, forma_pagamento TEXT, observacao TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conta_receber_id) REFERENCES contas_receber(id),
    FOREIGN KEY (cliente_id) REFERENCES clientes(id)
  )`);
  await run(db, `INSERT INTO contas_receber_pagamentos (
    id, conta_receber_id, cliente_id, valor_pago, data_pagamento, forma_pagamento, observacao
  ) VALUES
    (1, 101, 1, 30, '2026-10-20', 'dinheiro', 'válido'),
    (2, 102, 1, 10, '2026-10-21', 'dinheiro', 'vínculo cruzado'),
    (3, 201, 3, 5, '2026-10-22', 'dinheiro', 'empresa B')`);
  await run(db, 'CREATE TABLE produtos (id INTEGER PRIMARY KEY, nome TEXT)');
  await run(db, `INSERT INTO produtos (id, nome) VALUES
    (1, 'Produto A'), (2, 'Produto B')`);
  await run(db, `CREATE TABLE vendas_itens (
    id INTEGER PRIMARY KEY, venda_id INTEGER, produto_id INTEGER, quantidade REAL,
    quantidade_fiscal REAL, quantidade_nao_fiscal REAL, valor_fiscal REAL,
    valor_nao_fiscal REAL, preco_unitario REAL, subtotal REAL
  )`);
  await run(db, `INSERT INTO vendas_itens (
    id, venda_id, produto_id, quantidade, quantidade_fiscal, quantidade_nao_fiscal,
    valor_fiscal, valor_nao_fiscal, preco_unitario, subtotal
  ) VALUES
    (1, 10, 1, 1, 1, 0, 100, 0, 100, 100),
    (2, 20, 2, 1, 1, 0, 900, 99, 999, 999)`);
  return db;
}

function loadFinanceiroRouter(db) {
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
        resolverEmpresaDaOrigemFinanceira: ({ empresaId }) => empresaId,
        obterMetaEmpresaPorId: async () => ({
          empresa_nome: 'Empresa A',
          empresa_cnpj: 'A-CNPJ'
        }),
        statusDeErroEmpresa: () => 400
      };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    return require(ROUTE_PATH);
  } finally {
    Module._load = originalLoad;
  }
}

function getHandler(router, routePath) {
  const layer = router.stack.find(
    item => item.route && item.route.path === routePath && item.route.methods.get
  );
  assert.ok(layer, `GET ${routePath} deve existir`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function invoke(handler, empresaId, { params = {}, query = {}, user = { id: 10 } } = {}) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout da rota')), 4000);
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
    Promise.resolve(handler({ empresaId, params, query, user }, res)).catch(err => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

describe('FIN-INT-12 — isolamento empresarial nas leituras de Contas a Receber', () => {
  it('consolida recebíveis das empresas autorizadas, preserva origem e ignora empresas não autorizadas', async () => {
    const db = await createFixture();
    try {
      const router = loadFinanceiroRouter(db);
      const handler = getHandler(router, '/multiempresa/receber');
      const resposta = await invoke(handler, null, { query: { status: 'todas' } });
      assert.equal(resposta.status, 200);
      assert.equal(resposta.body.success, true);
      assert.deepEqual(resposta.body.empresas.map(empresa => empresa.empresa_id), [1, 2]);
      assert.ok(resposta.body.contas.some(conta => conta.chave === 'financeiro:1:2'));
      assert.equal(resposta.body.contas.some(conta => conta.chave === 'financeiro:1:1'), false);
      assert.ok(resposta.body.contas.some(conta => conta.chave === 'contas_receber:1:101'));
      assert.ok(resposta.body.contas.some(conta => conta.chave === 'contas_receber:2:201'));
      assert.equal(resposta.body.contas.find(conta => conta.empresa_id === 1).empresa_nome, 'Empresa A');
      assert.equal(resposta.body.contas.find(conta => conta.empresa_id === 2).empresa_nome, 'Empresa B');

      const filtrada = await invoke(handler, null, {
        user: { id: 11 },
        query: { status: 'todas' }
      });
      assert.equal(filtrada.status, 200);
      assert.equal(filtrada.body.contas.length > 0, true);
      assert.equal(filtrada.body.contas.every(conta => conta.empresa_id === 1), true);

      const porCliente = await invoke(handler, null, {
        query: { status: 'todas', cliente: 'Cliente B' }
      });
      assert.equal(porCliente.status, 200);
      assert.equal(porCliente.body.contas.some(conta => conta.empresa_id === 2), true);
      assert.equal(porCliente.body.contas.some(conta => conta.empresa_id === 1), false);
    } finally {
      await closeDb(db);
    }
  });

  it('consolida o Relatório de Contas a Receber sem duplicar espelhos e respeita filtros por empresa', async () => {
    const db = await createFixture();
    try {
      const router = loadFinanceiroRouter(db);
      const handler = getHandler(router, '/multiempresa/relatorios/receber');
      const resposta = await invoke(handler, null, {
        query: {
          dataInicio: '2026-11-01',
          dataFim: '2026-11-30',
          status: 'todas',
          modo_fiscal: '0'
        }
      });
      assert.equal(resposta.status, 200);
      assert.equal(resposta.body.success, true);
      assert.equal(resposta.body.contas.some(conta => conta.chave === 'financeiro:1:1'), false);
      assert.ok(resposta.body.contas.some(conta => conta.chave === 'financeiro:1:2'));
      assert.ok(resposta.body.contas.some(conta => conta.chave === 'contas_receber:1:101'));
      assert.ok(resposta.body.contas.some(conta => conta.chave === 'contas_receber:2:201'));
      assert.equal(
        resposta.body.contas.find(conta => conta.chave === 'contas_receber:2:201').empresa_nome,
        'Empresa B'
      );
      assert.equal(resposta.body.periodo.dataInicio, '2026-11-01');

      const cliente = await invoke(handler, null, {
        query: {
          dataInicio: '2026-11-01',
          dataFim: '2026-11-30',
          status: 'todas',
          cliente: 'Cliente B',
          modo_fiscal: '0'
        }
      });
      assert.equal(cliente.status, 200);
      assert.equal(cliente.body.contas.length > 0, true);
      assert.equal(cliente.body.contas.every(conta => conta.empresa_id === 2), true);
    } finally {
      await closeDb(db);
    }
  });

  it('filtra listagem por empresa/cliente e preserva união, títulos cruzados e sem venda', async () => {
    const db = await createFixture();
    try {
      const router = loadFinanceiroRouter(db);
      const handler = getHandler(router, '/receber');
      const empresaA = await invoke(handler, 1, { query: { status: 'todas' } });
      const chavesA = empresaA.body.contas.map(conta => conta.chave);

      assert.equal(empresaA.status, 200);
      assert.ok(chavesA.includes('financeiro:2'), 'lançamento manual legado é preservado');
      assert.equal(chavesA.includes('financeiro:1'), false, 'espelho legado não duplica CR');
      assert.ok(chavesA.includes('contas_receber:101'));
      assert.ok(chavesA.includes('contas_receber:102'));
      assert.ok(chavesA.includes('contas_receber:103'), 'venda estrangeira cancelada não exclui o CR');
      assert.ok(chavesA.includes('contas_receber:104'), 'recebível sem venda é preservado');
      assert.equal(chavesA.includes('contas_receber:106'), false, 'venda cancelada da própria empresa continua excluída');
      assert.ok(
        empresaA.body.contas.find(conta => conta.chave === 'contas_receber:101')
          .descricao.includes('V-A'),
        'relação válida mantém o código da venda da empresa A'
      );
      assert.equal(
        empresaA.body.contas.find(conta => conta.chave === 'contas_receber:102')
          .descricao.includes('V-B'),
        false,
        'venda ativa da empresa B não fornece código à listagem A'
      );
      assert.equal(
        empresaA.body.contas.find(conta => conta.chave === 'contas_receber:102')
          .descricao.includes('Venda 20'),
        false,
        'ID de venda estrangeira não é usado como rótulo de fallback'
      );
      assert.equal(
        empresaA.body.contas.find(conta => conta.chave === 'contas_receber:102').venda_id,
        20,
        'o campo venda_id do recebível mantém o contrato existente'
      );

      const filtradoClienteB = await invoke(handler, 1, {
        query: { status: 'todas', cliente: 'Cliente B' }
      });
      assert.equal(filtradoClienteB.body.contas.length, 0);

      const empresaB = await invoke(handler, 2, { query: { status: 'todas' } });
      assert.ok(empresaB.body.contas.some(conta => conta.chave === 'contas_receber:201'));
      assert.equal(empresaB.body.contas.some(conta => conta.chave === 'contas_receber:101'), false);
    } finally {
      await closeDb(db);
    }
  });

  it('mantém totais de CR e conta vendas somente quando a relação pertence à empresa', async () => {
    const db = await createFixture();
    try {
      const router = loadFinanceiroRouter(db);
      const handler = getHandler(router, '/receber/agrupado');
      const resumoA = await invoke(handler, 1);
      const clienteA = resumoA.body.clientes.find(cliente => cliente.cliente_id === 1);
      const clienteSemVenda = resumoA.body.clientes.find(cliente => cliente.cliente_id === 4);

      assert.equal(resumoA.status, 200);
      assert.equal(clienteA.total_divida, 190);
      assert.equal(clienteA.quantidade_vendas, 1);
      assert.equal(clienteSemVenda.total_divida, 15);
      assert.equal(clienteSemVenda.quantidade_vendas, 0);

      const filtradoClienteB = await invoke(handler, 1, {
        query: { cliente: 'Cliente B' }
      });
      assert.deepEqual(filtradoClienteB.body.clientes, []);

      const resumoB = await invoke(handler, 2);
      assert.deepEqual(
        resumoB.body.clientes.map(cliente => cliente.cliente_id),
        [3]
      );
    } finally {
      await closeDb(db);
    }
  });

  it('isola detalhes, produtos e acesso direto ao cliente por empresa', async () => {
    const db = await createFixture();
    try {
      const router = loadFinanceiroRouter(db);
      const handler = getHandler(router, '/receber/agrupado/:clienteId');
      const detalheA = await invoke(handler, 1, { params: { clienteId: '1' } });

      assert.equal(detalheA.status, 200);
      assert.deepEqual(
        detalheA.body.vendas.map(venda => venda.venda_id),
        [10]
      );
      assert.equal(detalheA.body.vendas[0].numero_venda, 'V-A');
      assert.deepEqual(
        detalheA.body.vendas[0].produtos.map(produto => produto.nome_produto),
        ['Produto A']
      );

      const detalheSemVenda = await invoke(handler, 1, {
        params: { clienteId: '4' }
      });
      assert.equal(detalheSemVenda.status, 200);
      assert.deepEqual(detalheSemVenda.body.vendas, []);

      const clienteB = await invoke(handler, 1, { params: { clienteId: '3' } });
      assert.equal(clienteB.status, 404);
      assert.equal(clienteB.body.cliente, undefined);
    } finally {
      await closeDb(db);
    }
  });

  it('isola o extrato, mantém o contexto da empresa e omite venda estrangeira', async () => {
    const db = await createFixture();
    try {
      const router = loadFinanceiroRouter(db);
      const handler = getHandler(router, '/receber/agrupado/:clienteId/extrato');
      const extratoA = await invoke(handler, 1, { params: { clienteId: '1' } });

      assert.equal(extratoA.status, 200);
      assert.equal(extratoA.body.empresa.nome, 'Empresa A');
      assert.deepEqual(
        extratoA.body.vendas.map(venda => venda.venda_id),
        [10, 11],
        'extrato preserva vendas da empresa A, inclusive canceladas como antes'
      );
      assert.equal(extratoA.body.vendas[0].numero_venda, 'V-A');
      assert.deepEqual(
        extratoA.body.vendas[0].produtos.map(produto => produto.nome_produto),
        ['Produto A']
      );

      const extratoSemVenda = await invoke(handler, 1, {
        params: { clienteId: '4' }
      });
      assert.equal(extratoSemVenda.status, 200);
      assert.deepEqual(extratoSemVenda.body.vendas, []);

      const extratoClienteB = await invoke(handler, 1, {
        params: { clienteId: '3' }
      });
      assert.equal(extratoClienteB.status, 404);
      assert.equal(extratoClienteB.body.cliente, undefined);
    } finally {
      await closeDb(db);
    }
  });

  it('corrige o histórico de pagamentos e não associa pagamento à venda estrangeira', async () => {
    const db = await createFixture();
    try {
      const router = loadFinanceiroRouter(db);
      const handler = getHandler(router, '/receber/agrupado/:clienteId/pagamentos');
      const pagamentosA = await invoke(handler, 1, {
        params: { clienteId: '1' }
      });

      assert.equal(pagamentosA.status, 200);
      assert.equal(pagamentosA.body.pagamentos.length, 1);
      assert.equal(pagamentosA.body.pagamentos[0].conta_receber_id, 101);
      assert.equal(pagamentosA.body.pagamentos[0].venda_codigo, 'V-A');

      const clienteEmpresaB = await invoke(handler, 1, {
        params: { clienteId: '3' }
      });
      assert.deepEqual(clienteEmpresaB.body.pagamentos, []);

      const semPagamentos = await invoke(handler, 1, {
        params: { clienteId: '4' }
      });
      assert.equal(semPagamentos.status, 200);
      assert.deepEqual(semPagamentos.body.pagamentos, []);
    } finally {
      await closeDb(db);
    }
  });
});
