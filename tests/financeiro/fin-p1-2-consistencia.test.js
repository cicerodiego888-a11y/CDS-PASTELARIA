'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const sqlite3 = require('sqlite3').verbose();
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaMcfAsync } = require('../../backend/motores/mcf/schema/mcfSchema');
const ContasPagarService = require('../../backend/motores/mcf/services/ContasPagarService');
const { FILTRO_VENDA_VALIDA } = require('../../backend/services/reportFiscalHelpers');

const ROOT = path.resolve(__dirname, '../..');
const DB_PATH = path.resolve(ROOT, 'backend/database.js');
const FINANCEIRO_ROUTE = path.resolve(ROOT, 'backend/rotas/financeiro.js');
const CONTEXTO_FINANCEIRO = path.resolve(
  ROOT,
  'backend/services/financeiro/FinanceiroEmpresaContextoService.js'
);
const AUDITORIA = path.resolve(ROOT, 'backend/services/auditoria.js');
const VALIDAR_CAIXA = path.resolve(ROOT, 'backend/middleware/validarCaixaAberto.js');
const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

function abrirDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', err => (err ? reject(err) : resolve(db)));
  });
}

function executar(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function obter(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function fecharDb(db) {
  return new Promise(resolve => db.close(() => resolve()));
}

async function criarFixtureFinanceira() {
  const db = await abrirDb();
  await garantirSchemaEmpresasAsync(db);
  await executar(db, `CREATE TABLE fornecedores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    cpf_cnpj TEXT
  )`);
  await executar(db, `CREATE TABLE financeiro (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT, descricao TEXT, valor REAL, data_movimento TEXT,
    categoria TEXT, forma_pagamento TEXT, referencia_id INTEGER,
    referencia_tipo TEXT, status TEXT, origem TEXT, documento TEXT,
    vencimento TEXT, numero_parcela INTEGER, total_parcelas INTEGER,
    compra_id INTEGER, venda_id INTEGER, pessoa_nome TEXT, observacao TEXT,
    baixado_em TEXT, empresa_id INTEGER
  )`);
  await executar(db, `CREATE TABLE vendas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER, total REAL, valor_fiscal REAL, valor_nao_fiscal REAL,
    status TEXT, cancelada INTEGER DEFAULT 0, data_venda TEXT
  )`);
  await executar(db, `CREATE TABLE vendas_canceladas (
    id INTEGER PRIMARY KEY AUTOINCREMENT, venda_id INTEGER NOT NULL
  )`);
  await executar(db, `CREATE TABLE contas_receber (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    venda_id INTEGER, empresa_id INTEGER, numero_parcela INTEGER,
    valor_parcela REAL, valor_restante REAL, data_vencimento TEXT, status TEXT
  )`);
  await executar(db, `CREATE TABLE contas_receber_pagamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conta_receber_id INTEGER, cliente_id INTEGER, valor_pago REAL,
    data_pagamento TEXT, forma_pagamento TEXT, observacao TEXT
  )`);
  await executar(db, `CREATE TABLE venda_recebimentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, venda_id INTEGER,
    tipo_recebimento TEXT, forma_pagamento TEXT, valor REAL, status TEXT
  )`);
  await garantirSchemaMcfAsync(db);

  const empresaA = await EmpresaService.criarEmpresa(
    { cnpj: CNPJ_A, razao_social: 'Fixture A' },
    { db }
  );
  const empresaB = await EmpresaService.criarEmpresa(
    { cnpj: CNPJ_B, razao_social: 'Fixture B' },
    { db }
  );

  await executar(db, `INSERT INTO vendas
    (id, empresa_id, total, valor_fiscal, valor_nao_fiscal, status, cancelada, data_venda)
    VALUES
    (1, ?, 200, 200, 0, 'concluida', 0, '2026-10-10'),
    (2, ?, 100, 100, 0, 'cancelada', 0, '2026-10-11'),
    (3, ?, 75, 75, 0, 'concluida', 1, '2026-10-12'),
    (4, ?, 900, 900, 0, 'concluida', 0, '2026-10-12')`,
  [empresaA.id, empresaA.id, empresaA.id, empresaB.id]);
  await executar(db, `INSERT INTO venda_recebimentos
    (venda_id, tipo_recebimento, forma_pagamento, valor, status)
    VALUES (1, 'fiscal', 'dinheiro', 200, 'aprovado'),
           (2, 'fiscal', 'dinheiro', 100, 'aprovado'),
           (3, 'fiscal', 'dinheiro', 75, 'aprovado'),
           (4, 'fiscal', 'dinheiro', 900, 'aprovado')`);

  await executar(db, `INSERT INTO contas_receber
    (id, venda_id, empresa_id, numero_parcela, valor_parcela, valor_restante, data_vencimento, status)
    VALUES (1, 1, ?, 1, 300, 200, '2026-10-01', 'parcial'),
           (3, 1, ?, 1, 999, 999, '2026-10-01', 'aberto')`,
  [empresaA.id, empresaB.id]);
  await executar(db, `INSERT INTO contas_receber_pagamentos
    (conta_receber_id, cliente_id, valor_pago, data_pagamento, forma_pagamento)
    VALUES (1, 7, 100, '2026-10-15', 'dinheiro')`);

  await executar(db, `INSERT INTO financeiro
    (tipo, descricao, valor, data_movimento, status, origem, documento, vencimento,
     numero_parcela, referencia_id, referencia_tipo, venda_id, pessoa_nome, empresa_id)
    VALUES
    ('receita', 'Venda válida parcial', 300, '2026-09-20', 'parcial', 'venda', 'NF-A',
     '2026-10-01', 1, 1, 'venda', 1, 'Cliente A', ?),
    ('receita', 'Venda cancelada por status', 100, '2026-09-21', 'pendente', 'venda',
     'NF-B', '2026-10-01', 1, 2, 'venda', 2, 'Cliente B', ?),
    ('receita', 'Venda cancelada por flag', 75, '2026-09-22', 'pendente', 'venda',
     'NF-C', '2026-10-01', 1, 3, 'venda', 3, 'Cliente C', ?),
    ('receita', 'Recebível legado independente', 25, '2026-09-23', 'pendente', 'manual',
     'LEG-1', '2026-10-01', NULL, NULL, NULL, NULL, 'Cliente legado', ?),
    ('receita', 'Empresa B isolada', 900, '2026-09-23', 'pendente', 'manual',
     'LEG-B', '2026-10-01', NULL, NULL, NULL, NULL, 'Cliente B', ?)`,
  [empresaA.id, empresaA.id, empresaA.id, empresaA.id, empresaB.id]);

  const apParcial = await ContasPagarService.criar({
    db,
    empresaId: empresaA.id,
    descricao: 'Título MCF parcial',
    valor_original: 500,
    data_vencimento: '2026-10-01',
    origem: 'manual',
    idempotency_key: 'fin-p1-2-ap-a-1'
  });
  await ContasPagarService.baixar({
    db,
    empresaId: empresaA.id,
    id: apParcial.id,
    valor_pago: 150,
    data_pagamento: '2026-10-15',
    idempotency_key: 'fin-p1-2-ap-pag-1'
  });
  await ContasPagarService.criar({
    db,
    empresaId: empresaA.id,
    descricao: 'Título MCF aberto',
    valor_original: 250,
    // Vencimento futuro — não entra em inadimplência do cenário de referência
    data_vencimento: '2027-06-01',
    origem: 'manual',
    idempotency_key: 'fin-p1-2-ap-a-2'
  });
  await ContasPagarService.criar({
    db,
    empresaId: empresaB.id,
    descricao: 'Título MCF empresa B',
    valor_original: 900,
    data_vencimento: '2026-10-01',
    origem: 'manual',
    idempotency_key: 'fin-p1-2-ap-b-1'
  });

  return { db, empresaA, empresaB };
}

function carregarRotaFinanceiro(db) {
  const carregarOriginal = Module._load;
  for (const arquivo of [FINANCEIRO_ROUTE, CONTEXTO_FINANCEIRO, VALIDAR_CAIXA, AUDITORIA]) {
    delete require.cache[arquivo];
  }
  Module._load = function carregarComFixture(request, parent, isMain) {
    let resolvido;
    try {
      resolvido = Module._resolveFilename(request, parent, isMain);
    } catch (_) {
      resolvido = null;
    }
    if (resolvido === DB_PATH) return db;
    if (resolvido === AUDITORIA) return { gravarAuditoria: async () => {} };
    if (resolvido === VALIDAR_CAIXA) return { validarCaixaAberto: (_req, _res, next) => next() };
    if (resolvido === CONTEXTO_FINANCEIRO) {
      return {
        middlewareResolverEmpresaFinanceiro: () => (_req, _res, next) => next(),
        exigirRegistroDaEmpresa: async () => {},
        exigirLancamentoDaEmpresa: async () => {},
        resolverEmpresaDaOrigemFinanceira: ({ empresaId }) => empresaId,
        obterMetaEmpresaPorId: async () => null,
        statusDeErroEmpresa: () => 400
      };
    }
    return carregarOriginal.apply(this, arguments);
  };
  try {
    return require(FINANCEIRO_ROUTE);
  } finally {
    Module._load = carregarOriginal;
  }
}

function handlerDaRota(router, caminho) {
  const layer = router.stack.find(item => item.route && item.route.path === caminho && item.route.methods.get);
  assert.ok(layer, `GET ${caminho} deve estar registrado`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function invocarHandler(handler, empresaId, query = {}) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout aguardando resposta da rota')), 3000);
    const res = {
      statusCode: 200,
      status(codigo) {
        this.statusCode = codigo;
        return this;
      },
      json(body) {
        clearTimeout(timeout);
        resolve({ status: this.statusCode, body });
        return this;
      }
    };
    try {
      const retorno = handler({ empresaId, query }, res);
      if (retorno && typeof retorno.catch === 'function') {
        retorno.catch(err => {
          clearTimeout(timeout);
          reject(err);
        });
      }
    } catch (err) {
      clearTimeout(timeout);
      reject(err);
    }
  });
}

class ElementoFake {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.listeners = {};
    this.style = {};
    this.dataset = {};
    this.className = '';
    this._textContent = '';
    this._innerHTML = '';
    this.value = '';
    this.hidden = false;
    this.attributes = {};
  }

  set id(valor) {
    this._id = valor;
    if (valor) this.ownerDocument.elementos.set(valor, this);
  }
  get id() { return this._id; }

  set textContent(valor) {
    this._textContent = String(valor);
    this.children = [];
  }
  get textContent() {
    return this._textContent + this.children.map(child => child.textContent).join('');
  }

  set innerHTML(valor) { this._innerHTML = String(valor); }
  get innerHTML() { return this._innerHTML; }

  appendChild(child) {
    child.ownerDocument = this.ownerDocument;
    this.children.push(child);
    if (child.id) this.ownerDocument.elementos.set(child.id, child);
    return child;
  }

  replaceChildren(...children) {
    this.children = [];
    this._textContent = '';
    children.forEach(child => this.appendChild(child));
  }

  append(...children) {
    children.forEach(child => this.appendChild(child));
  }

  setAttribute(nome, valor) {
    this.attributes[nome] = String(valor);
  }

  getAttribute(nome) {
    return this.attributes[nome] || null;
  }

  addEventListener(nome, callback) {
    this.listeners[nome] = callback;
  }
}

function criarDocumentFake() {
  return {
    elementos: new Map(),
    createElement(tag) {
      const elemento = new ElementoFake(tag);
      elemento.ownerDocument = this;
      return elemento;
    },
    getElementById(id) {
      return this.elementos.get(id) || null;
    }
  };
}

describe('FIN-P1.2 — segurança e consistência financeira', () => {
  it('renderiza valores e erros do Histórico como texto e mantém filtros funcionais', async () => {
    const arquivo = path.join(ROOT, 'frontend/erp/js/financeiro-historico.js');
    const document = criarDocumentFake();
    const container = document.createElement('main');
    container.id = 'financeiroConteudo';
    document.elementos.set(container.id, container);
    const textoMalicioso = `<img src=x onerror="globalThis.executado=true">`;
    const requisicoes = [];
    let resposta = {
      ok: true,
      status: 200,
      json: async () => [{
        data_movimento: '2026-10-25',
        tipo: textoMalicioso,
        descricao: textoMalicioso,
        documento: textoMalicioso,
        pessoa_nome: textoMalicioso,
        status: textoMalicioso,
        forma_pagamento: textoMalicioso,
        referencia_tipo: textoMalicioso,
        referencia_id: '1);alert(1)//',
        valor: 10
      }]
    };
    const contexto = {
      document,
      Element: ElementoFake,
      URLSearchParams,
      localStorage: { getItem: () => 'test-token' },
      headersFinanceiro: extra => Object.assign({ 'X-Empresa-Id': 'empresa-sintetica' }, extra || {}),
      fetch: async (url, options) => {
        requisicoes.push({ url: String(url), options });
        return resposta;
      },
      abrirReferenciaFinanceira() {},
      console: { error() {} },
      globalThis: {}
    };
    vm.runInNewContext(fs.readFileSync(arquivo, 'utf8'), contexto, { filename: arquivo });
    contexto.renderHistoricoFinanceiro({ dataInicio: '2026-10-01', dataFim: '2026-10-31' });
    await contexto.carregarHistoricoFinanceiro({ dataInicio: '2026-10-01', dataFim: '2026-10-31' });

    const tbody = document.getElementById('tabelaHistoricoFinanceiro');
    assert.equal(tbody.children.length, 1);
    assert.equal(tbody.children[0].children[1].children[0].textContent, textoMalicioso);
    assert.equal(tbody.children[0].children[2].textContent, textoMalicioso);
    assert.ok(tbody.children[0].children[3].textContent.includes(textoMalicioso));
    assert.equal(tbody.children[0].children[4].textContent, textoMalicioso);
    assert.equal(tbody.children[0].children[5].textContent, textoMalicioso);
    assert.equal(tbody.children[0].children[6].textContent, '—');
    assert.equal(tbody.children[0].children[7].children[0].textContent, textoMalicioso);
    assert.equal(tbody.children[0].children[8].textContent, textoMalicioso);
    assert.equal(
      tbody.children[0].children[7].children[0].className,
      'financeiro-historico-status financeiro-historico-status--outro'
    );
    assert.equal(contexto.globalThis.executado, undefined);
    assert.equal(tbody._innerHTML, '');
    assert.equal(document.getElementById('filtroTipo').children.length, 3);
    assert.equal(document.getElementById('filtroStatus').children.length, 5);
    assert.equal(typeof document.getElementById('btnFiltrarHistorico').listeners.click, 'function');
    assert.equal(tbody.children[0].children[3].children.length, 0, 'referência inválida não vira ação');
    assert.equal(document.getElementById('historicoTabelaContainer').hidden, false);
    assert.equal(requisicoes[0].options.headers['X-Empresa-Id'], 'empresa-sintetica');
    assert.equal(
      contexto.criarCelulaReferenciaHistorico({ referencia_tipo: 'venda', referencia_id: '42' }).children.length,
      1,
      'referência compra/venda com ID inteiro pode abrir detalhes'
    );
    assert.equal(
      contexto.criarCelulaReferenciaHistorico({ referencia_tipo: 'venda', referencia_id: true }).children.length,
      0,
      'booleano não pode ser convertido implicitamente em ID'
    );

    document.getElementById('filtroDescricao').value = 'busca & documento';
    document.getElementById('filtroTipo').value = 'despesa';
    document.getElementById('filtroStatus').value = 'pendente';
    await document.getElementById('btnFiltrarHistorico').listeners.click();
    const chamadaFiltrada = requisicoes[requisicoes.length - 1];
    assert.ok(chamadaFiltrada.url.includes('dataInicio=2026-10-01'));
    assert.ok(chamadaFiltrada.url.includes('dataFim=2026-10-31'));
    assert.ok(chamadaFiltrada.url.includes('busca=busca+%26+documento'));
    assert.ok(chamadaFiltrada.url.includes('tipo=despesa'));
    assert.ok(chamadaFiltrada.url.includes('status=pendente'));
    assert.equal(chamadaFiltrada.options.headers['X-Empresa-Id'], 'empresa-sintetica');

    resposta = {
      ok: false,
      status: 500,
      json: async () => ({ error: textoMalicioso })
    };
    await contexto.carregarHistoricoFinanceiro();
    assert.ok(document.getElementById('historicoEstadoStatus').textContent.includes(textoMalicioso));
    assert.equal(document.getElementById('historicoEstadoStatus').hidden, false);
    assert.equal(document.getElementById('historicoEstadoVazio').hidden, true);
    assert.equal(document.getElementById('historicoTabelaContainer').hidden, true);
    assert.equal(tbody._innerHTML, '');
  });

  it('rejeita IDs e tipos de referência inválidos antes de abrir detalhes', () => {
    const arquivo = path.join(ROOT, 'frontend/erp/js/financeiro.js');
    const chamadas = [];
    const contexto = {
      document: {
        readyState: 'loading',
        addEventListener() {},
        getElementById() { return null; }
      },
      viewCompra: id => chamadas.push(['compra', id]),
      viewVenda: id => chamadas.push(['venda', id]),
      showNotification() {}
    };
    vm.runInNewContext(fs.readFileSync(arquivo, 'utf8'), contexto, { filename: arquivo });
    contexto.abrirReferenciaFinanceira('1);alert(1)//', 'venda');
    contexto.abrirReferenciaFinanceira(0, 'compra');
    contexto.abrirReferenciaFinanceira(2, 'despesa');
    contexto.abrirReferenciaFinanceira(3, 'compra');
    contexto.abrirReferenciaFinanceira(4, 'venda');
    assert.deepEqual(chamadas, [['compra', 3], ['venda', 4]]);
  });

  it('escapa dados da API na tabela de lançamentos e não gera ações inline dinâmicas', () => {
    const arquivo = path.join(ROOT, 'frontend/erp/js/financeiro.js');
    const textoMalicioso = `<img src=x onerror="executado=true">`;
    let htmlRenderizado = '';
    const tbody = { addEventListener() {} };
    const contexto = {
      document: {
        readyState: 'loading',
        addEventListener() {},
        getElementById() { return null; },
        querySelector() { return tbody; }
      },
      $: () => ({ html: html => { htmlRenderizado = html; } }),
      FINANCEIRO_STATUS: [],
      FINANCEIRO_ORIGENS: [],
      FINANCEIRO_FORMAS_PAGAMENTO: [],
      buildSelectOptions: () => '',
      formatCurrency: valor => String(valor),
      formatDate: valor => String(valor),
      nomeFormaPagamento: valor => String(valor)
    };
    vm.runInNewContext(fs.readFileSync(arquivo, 'utf8'), contexto, { filename: arquivo });
    contexto.renderFinanceiro([{
      id: '9',
      referencia_id: `1" onclick="executado=true`,
      referencia_tipo: 'venda',
      tipo: 'receita',
      origem: textoMalicioso,
      descricao: textoMalicioso,
      documento: textoMalicioso,
      pessoa_nome: textoMalicioso,
      status: textoMalicioso,
      forma_pagamento: textoMalicioso,
      valor: 1
    }], {}, { data_inicio: textoMalicioso, data_fim: '2026-10-31' });

    assert.equal(htmlRenderizado.includes(textoMalicioso), false);
    assert.equal(htmlRenderizado.includes('&lt;img src=x onerror=&quot;executado=true&quot;&gt;'), true);
    assert.equal(htmlRenderizado.includes('data-referencia-id="1"'), false);
    assert.equal(htmlRenderizado.includes('onclick="abrirReferenciaFinanceira'), false);
    assert.equal(htmlRenderizado.includes('onclick="event.stopPropagation(); baixarMovimentacao'), false);
  });

  it('prova os saldos de referência, exclusão de cancelamentos/projeções e isolamento por empresa', async () => {
    const fixture = await criarFixtureFinanceira();
    try {
      const { db, empresaA, empresaB } = fixture;
      const router = carregarRotaFinanceiro(db);
      const apParcial = await obter(
        db,
        'SELECT valor_original, valor_restante, status FROM contas_pagar WHERE empresa_id = ? AND descricao = ?',
        [empresaA.id, 'Título MCF parcial']
      );
      const arParcial = await obter(
        db,
        'SELECT valor_parcela, valor_restante FROM contas_receber WHERE id = 1 AND empresa_id = ?',
        [empresaA.id]
      );
      const recebimentoAr = await obter(
        db,
        'SELECT SUM(valor_pago) AS total FROM contas_receber_pagamentos WHERE conta_receber_id = 1'
      );
      const totalMcfAberto = await obter(
        db,
        "SELECT SUM(valor_restante) AS total FROM contas_pagar WHERE empresa_id = ? AND status IN ('aberto', 'parcial')",
        [empresaA.id]
      );
      assert.deepEqual(apParcial, {
        valor_original: 500,
        valor_restante: 350,
        status: 'parcial'
      });
      assert.deepEqual(arParcial, { valor_parcela: 300, valor_restante: 200 });
      assert.equal(recebimentoAr.total, 100);
      assert.equal(totalMcfAberto.total, 600);

      const serviceVenda = require('../../backend/services/vendas/VendaFinanceiroService');
      const predicateFinanceiro = serviceVenda.sqlExcluirFinanceiroReceberComContaCanonica('f');
      const restanteLegado = await obter(
        db,
        `SELECT SUM(f.valor) AS total FROM financeiro f
         WHERE f.tipo = 'receita' AND f.empresa_id = ?
           AND ${predicateFinanceiro}
           AND ${serviceVenda.sqlExcluirFinanceiroVendaCancelada('f')}`,
        [empresaA.id]
      );
      assert.equal(restanteLegado.total, 25);

      const vendasValidas = await obter(
        db,
        `SELECT SUM(v.total) AS total FROM vendas v
         WHERE v.empresa_id = ? AND ${FILTRO_VENDA_VALIDA}`,
        [empresaA.id]
      );
      assert.equal(vendasValidas.total, 200);

      const dashboard = await invocarHandler(handlerDaRota(router, '/dashboard'), empresaA.id);
      assert.equal(dashboard.status, 200);
      assert.equal(dashboard.body.resumo.totalRecebido, 100);
      assert.equal(dashboard.body.resumo.totalPago, 150);
      assert.equal(dashboard.body.resumo.totalPagar, 600);
      assert.equal(dashboard.body.resumo.totalReceber, 225);
      assert.equal(dashboard.body.grafico.recebido, 100);
      assert.equal(dashboard.body.grafico.receber, 225);

      const listagemLegada = await invocarHandler(handlerDaRota(router, '/'), empresaA.id);
      assert.equal(listagemLegada.status, 200);
      assert.equal(listagemLegada.body.some(row => row.descricao === 'Venda cancelada por status'), false);
      assert.equal(listagemLegada.body.some(row => row.descricao === 'Venda cancelada por flag'), false);
      assert.equal(listagemLegada.body.some(row => row.origem === 'mcf_compatibilidade'), false);
      assert.equal(listagemLegada.body.some(row => row.empresa_id === empresaB.id), false);

      const historico = await invocarHandler(handlerDaRota(router, '/historico'), empresaA.id);
      assert.equal(historico.status, 200);
      assert.equal(historico.body.some(row => row.origem === 'mcf_compatibilidade'), true);
      assert.equal(historico.body.some(row => row.empresa_id === empresaB.id), false);

      const inadimplencia = await invocarHandler(
        handlerDaRota(router, '/relatorios/inadimplencia'),
        empresaA.id
      );
      assert.equal(inadimplencia.status, 200);
      assert.equal(inadimplencia.body.contasAtraso.length, 3);
      assert.equal(inadimplencia.body.contasAtraso.some(row => row.descricao.includes('cancelada')), false);
      assert.equal(inadimplencia.body.contasAtraso.find(row => row.fonte === 'contas_receber').valor, 200);
      assert.equal(inadimplencia.body.contasAtraso.find(row => row.fonte === 'contas_pagar').valor, 350);
      assert.equal(inadimplencia.body.valorAtraso, 575);

      const resumo = await invocarHandler(
        handlerDaRota(router, '/relatorios/resumo'),
        empresaA.id
      );
      assert.equal(resumo.status, 200);
      assert.equal(resumo.body.resumo.receitas.total, 325);
      assert.equal(resumo.body.recebimentos_venda.total.total, 200);

      const fluxo = await invocarHandler(
        handlerDaRota(router, '/relatorios/fluxo'),
        empresaA.id
      );
      assert.equal(fluxo.status, 200);
      assert.equal(fluxo.body.entradas_venda.total, 200);
      assert.equal(fluxo.body.entradas_financeiro, 325);

      const registrosEmpresaB = await obter(
        db,
        'SELECT COUNT(*) AS total FROM contas_pagar WHERE empresa_id = ?',
        [empresaB.id]
      );
      assert.equal(registrosEmpresaB.total, 1);

      const resumoFinanceiro = await invocarHandler(
        handlerDaRota(router, '/resumo'),
        empresaA.id
      );
      assert.equal(resumoFinanceiro.status, 200);
      assert.equal(resumoFinanceiro.body.total_recebido, 100);
      assert.equal(resumoFinanceiro.body.total_a_receber, 225);
      assert.equal(resumoFinanceiro.body.total_pago, 150);
      assert.equal(resumoFinanceiro.body.total_a_pagar, 600);
    } finally {
      await fecharDb(fixture.db);
    }
  });
});
