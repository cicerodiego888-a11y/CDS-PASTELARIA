'use strict';

/**
 * FIN-INT-04 — União controlada GET /api/financeiro/receber
 * SQLite :memory: apenas. Sem banco original/cliente.
 * Executar: node --test tests/financeiro/fin-int-04-uniao-receber.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const sqlite3 = require('sqlite3').verbose();
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');

const ROOT = path.resolve(__dirname, '../..');
const DB_PATH = path.resolve(ROOT, 'backend/database.js');
const FINANCEIRO_ROUTE = path.resolve(ROOT, 'backend/rotas/financeiro.js');
const CONTEXTO_FINANCEIRO = path.resolve(
  ROOT,
  'backend/services/financeiro/FinanceiroEmpresaContextoService.js'
);
const AUDITORIA = path.resolve(ROOT, 'backend/services/auditoria.js');
const VALIDAR_CAIXA = path.resolve(ROOT, 'backend/middleware/validarCaixaAberto.js');
const FRONT_RECEBER = path.resolve(ROOT, 'frontend/erp/js/financeiro-receber.js');
const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

function abrirDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
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
function fecharDb(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

async function criarFixture() {
  const db = await abrirDb();
  await garantirSchemaEmpresasAsync(db);
  await executar(db, `CREATE TABLE clientes (
    id INTEGER PRIMARY KEY, nome TEXT, cpf_cnpj TEXT, telefone TEXT
  )`);
  await executar(db, `CREATE TABLE vendas (
    id INTEGER PRIMARY KEY, codigo TEXT, empresa_id INTEGER, total REAL,
    status TEXT, cancelada INTEGER DEFAULT 0
  )`);
  await executar(db, `CREATE TABLE vendas_canceladas (
    id INTEGER PRIMARY KEY, venda_id INTEGER NOT NULL
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
  await executar(db, `CREATE TABLE contas_receber (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    venda_id INTEGER, cliente_id INTEGER, empresa_id INTEGER,
    numero_parcela INTEGER, total_parcelas INTEGER,
    componente TEXT DEFAULT 'produtos',
    valor_parcela REAL, valor_restante REAL,
    data_vencimento TEXT, data_pagamento TEXT, status TEXT
  )`);
  await executar(db, `CREATE TABLE contas_receber_pagamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conta_receber_id INTEGER, cliente_id INTEGER, valor_pago REAL,
    data_pagamento TEXT, forma_pagamento TEXT, observacao TEXT
  )`);
  await executar(db, `CREATE TABLE contas_pagar (
    id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER
  )`);

  const empresaA = await EmpresaService.criarEmpresa(
    { cnpj: CNPJ_A, razao_social: 'Fixture A INT-04' },
    { db }
  );
  const empresaB = await EmpresaService.criarEmpresa(
    { cnpj: CNPJ_B, razao_social: 'Fixture B INT-04' },
    { db }
  );

  await executar(db, `INSERT INTO clientes (id, nome, cpf_cnpj, telefone)
    VALUES (1, 'Cliente Alfa', '111', '9001'), (2, 'Cliente Beta', '222', '9002')`);

  await executar(db, `INSERT INTO vendas (id, codigo, empresa_id, total, status, cancelada)
    VALUES
    (10, 'V-10', ?, 500, 'concluida', 0),
    (11, 'V-11', ?, 80, 'concluida', 0),
    (12, 'V-12', ?, 40, 'cancelada', 0),
    (20, 'V-20', ?, 999, 'concluida', 0)`,
  [empresaA.id, empresaA.id, empresaA.id, empresaB.id]);

  // Dual-write: espelho financeiro + 2 componentes CR mesma parcela
  await executar(db, `INSERT INTO financeiro (
    tipo, descricao, valor, data_movimento, status, origem, documento, vencimento,
    numero_parcela, total_parcelas, referencia_id, referencia_tipo, venda_id, pessoa_nome, empresa_id
  ) VALUES (
    'receita', 'Espelho venda 10', 500, '2026-10-01', 'pendente', 'venda', 'DOC-10',
    '2026-10-20', 1, 1, 10, 'venda', 10, 'Cliente Alfa', ?
  )`, [empresaA.id]);
  await executar(db, `INSERT INTO contas_receber (
    id, venda_id, cliente_id, empresa_id, numero_parcela, total_parcelas, componente,
    valor_parcela, valor_restante, data_vencimento, status
  ) VALUES
    (101, 10, 1, ?, 1, 1, 'produtos', 300, 300, '2026-10-20', 'aberto'),
    (102, 10, 1, ?, 1, 1, 'outros', 200, 200, '2026-10-20', 'aberto')`,
  [empresaA.id, empresaA.id]);

  // Manual só legado
  await executar(db, `INSERT INTO financeiro (
    tipo, descricao, valor, data_movimento, status, origem, documento, vencimento,
    numero_parcela, referencia_id, referencia_tipo, venda_id, pessoa_nome, empresa_id
  ) VALUES (
    'receita', 'Manual legado', 25, '2026-10-02', 'pendente', 'manual', 'LEG-1',
    '2026-10-25', NULL, NULL, NULL, NULL, 'Cliente Alfa', ?
  )`, [empresaA.id]);

  // Só CR (sem espelho)
  await executar(db, `INSERT INTO contas_receber (
    id, venda_id, cliente_id, empresa_id, numero_parcela, total_parcelas, componente,
    valor_parcela, valor_restante, data_vencimento, status
  ) VALUES (201, 11, 2, ?, 1, 1, 'produtos', 80, 55, '2026-10-22', 'parcial')`,
  [empresaA.id]);
  await executar(db, `INSERT INTO contas_receber_pagamentos (
    conta_receber_id, cliente_id, valor_pago, data_pagamento, forma_pagamento
  ) VALUES (201, 2, 25, '2026-10-15', 'pix')`);

  // Venda cancelada + CR + financeiro (devem sumir)
  await executar(db, `INSERT INTO financeiro (
    tipo, descricao, valor, data_movimento, status, origem, vencimento,
    numero_parcela, referencia_id, referencia_tipo, venda_id, pessoa_nome, empresa_id
  ) VALUES (
    'receita', 'Cancelada', 40, '2026-10-03', 'pendente', 'venda', '2026-10-18',
    1, 12, 'venda', 12, 'Cliente Alfa', ?
  )`, [empresaA.id]);
  await executar(db, `INSERT INTO contas_receber (
    id, venda_id, cliente_id, empresa_id, numero_parcela, total_parcelas,
    valor_parcela, valor_restante, data_vencimento, status
  ) VALUES (301, 12, 1, ?, 1, 1, 40, 40, '2026-10-18', 'aberto')`, [empresaA.id]);

  // Empresa B isolada (id de CR próprio)
  await executar(db, `INSERT INTO contas_receber (
    id, venda_id, cliente_id, empresa_id, numero_parcela, total_parcelas,
    valor_parcela, valor_restante, data_vencimento, status
  ) VALUES (401, 20, 1, ?, 1, 1, 999, 999, '2026-10-20', 'aberto')`, [empresaB.id]);

  // Colisão de id entre fontes distintas na mesma empresa: financeiro:201 e contas_receber:201
  await executar(db, `INSERT INTO financeiro (
    id, tipo, descricao, valor, data_movimento, status, origem, documento, vencimento,
    pessoa_nome, empresa_id
  ) VALUES (
    201, 'receita', 'Colisao id 201 legado', 15, '2026-10-04', 'pendente', 'manual', 'COL-201',
    '2026-10-28', 'Cliente Alfa', ?
  )`, [empresaA.id]);

  return { db, empresaA, empresaB };
}

function carregarRotaFinanceiro(db) {
  const carregarOriginal = Module._load;
  for (const arquivo of [FINANCEIRO_ROUTE, CONTEXTO_FINANCEIRO, VALIDAR_CAIXA, AUDITORIA]) {
    delete require.cache[arquivo];
  }
  // Limpar dependências do router que cacheiam database
  delete require.cache[path.resolve(ROOT, 'backend/motores/mcf/services/ContasPagarService.js')];
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
  const layer = router.stack.find(
    (item) => item.route && item.route.path === caminho && item.route.methods.get
  );
  assert.ok(layer, `GET ${caminho} deve existir`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function invocarHandler(handler, empresaId, query = {}) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout rota')), 4000);
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
        retorno.catch((err) => {
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

describe('FIN-INT-04 — união controlada Contas a Receber', () => {
  it('lista unificada sem duplicar espelho, com manual, só-CR, cancelados e isolamento', async () => {
    const fixture = await criarFixture();
    try {
      const { db, empresaA, empresaB } = fixture;
      const router = carregarRotaFinanceiro(db);
      const handler = handlerDaRota(router, '/receber');

      const resp = await invocarHandler(handler, empresaA.id, {
        dataInicio: '2026-10-01',
        dataFim: '2026-10-31',
        status: 'todas'
      });
      assert.equal(resp.status, 200);
      assert.equal(resp.body.success, true);
      assert.equal(resp.body.uniao, true);
      const contas = resp.body.contas;
      assert.ok(Array.isArray(contas));

      const chaves = contas.map((c) => c.chave);
      assert.ok(chaves.includes('contas_receber:101'));
      assert.ok(chaves.includes('contas_receber:102'));
      assert.ok(chaves.includes('contas_receber:201'));
      assert.ok(chaves.includes('financeiro:201')); // colisão de id, fonte distinta
      assert.equal(chaves.some((c) => c.startsWith('financeiro:') && contas.find((x) => x.chave === c && /Espelho venda 10/.test(x.descricao || ''))), false);

      const espelho = contas.find((c) => c.fonte === 'financeiro' && /Espelho venda 10/.test(c.descricao || ''));
      assert.equal(espelho, undefined, 'espelho com CR não deve listar');

      const manual = contas.find((c) => c.fonte === 'financeiro' && c.descricao === 'Manual legado');
      assert.ok(manual);
      assert.equal(manual.valor, 25);

      const soCr = contas.find((c) => c.chave === 'contas_receber:201');
      assert.ok(soCr);
      assert.equal(soCr.valor, 55);
      assert.equal(soCr.status_persistido, 'parcial');

      const componentes = contas.filter((c) => c.venda_id === 10 && c.fonte === 'contas_receber');
      assert.equal(componentes.length, 2);
      assert.equal(componentes.reduce((s, c) => s + c.valor, 0), 500);

      assert.equal(contas.some((c) => /Cancelada/.test(c.descricao || '')), false);
      assert.equal(contas.some((c) => c.chave === 'contas_receber:301'), false);

      // Mesmo id 101 em B não vaza para A
      const linha101 = contas.filter((c) => c.id === 101);
      assert.equal(linha101.length, 1);
      assert.equal(linha101[0].fonte, 'contas_receber');
      assert.equal(linha101[0].valor, 300);

      const respB = await invocarHandler(handler, empresaB.id, { status: 'todas' });
      assert.equal(respB.body.contas.length, 1);
      assert.equal(respB.body.contas[0].chave, 'contas_receber:401');
      assert.equal(respB.body.contas[0].valor, 999);
      assert.equal(respB.body.contas.some((c) => c.chave === 'contas_receber:101'), false);

      // Filtro cliente
      const filtrado = await invocarHandler(handler, empresaA.id, {
        status: 'todas',
        cliente: 'Beta'
      });
      assert.ok(filtrado.body.contas.some((c) => c.chave === 'contas_receber:201'));
      assert.equal(filtrado.body.contas.some((c) => c.chave === 'contas_receber:101'), false);
      assert.ok(filtrado.body.contas.every((c) => /Beta/i.test(String(c.cliente || ''))));

      // Documento: só legado
      const porDoc = await invocarHandler(handler, empresaA.id, {
        status: 'todas',
        documento: 'LEG-1'
      });
      assert.equal(porDoc.body.contas.length, 1);
      assert.equal(porDoc.body.contas[0].fonte, 'financeiro');
      assert.equal(porDoc.body.contas[0].documento, 'LEG-1');

      // Ações por origem / colisão de id
      const colisaoLegado = contas.find((c) => c.chave === 'financeiro:201');
      const colisaoCr = contas.find((c) => c.chave === 'contas_receber:201');
      assert.ok(colisaoLegado && colisaoCr);
      assert.equal(colisaoLegado.id, colisaoCr.id);
      assert.notEqual(colisaoLegado.fonte, colisaoCr.fonte);
      assert.ok(colisaoLegado.acoes_disponiveis.includes('baixar'));
      assert.ok(colisaoCr.acoes_disponiveis.includes('detalhes'));
      assert.equal(colisaoCr.acoes_disponiveis.includes('baixar'), false, 'parcial CR não baixa nesta rota');
    } finally {
      await fecharDb(fixture.db);
    }
  });

  it('UI FIN-INT-02 preserva data/escape e respeita data-fonte nas ações', () => {
    class ElementoFake {
      constructor(tag) {
        this.tagName = String(tag || 'div').toLowerCase();
        this.children = [];
        this.listeners = {};
        this.className = '';
        this._textContent = '';
        this._innerHTML = '';
        this.attributes = {};
        this.hidden = false;
        this.colSpan = 1;
      }
      set id(v) {
        this._id = v;
        if (v && this.ownerDocument) this.ownerDocument.elementos.set(v, this);
      }
      get id() { return this._id; }
      set textContent(v) { this._textContent = String(v); this.children = []; }
      get textContent() {
        return this._textContent + this.children.map((c) => c.textContent).join('');
      }
      set innerHTML(v) { this._innerHTML = String(v); this.children = []; this._textContent = ''; }
      get innerHTML() { return this._innerHTML; }
      appendChild(child) {
        child.ownerDocument = this.ownerDocument;
        this.children.push(child);
        return child;
      }
      replaceChildren(...children) {
        this.children = [];
        this._textContent = '';
        this._innerHTML = '';
        children.forEach((c) => this.appendChild(c));
      }
      setAttribute(n, v) { this.attributes[n] = String(v); }
      getAttribute(n) {
        return Object.prototype.hasOwnProperty.call(this.attributes, n) ? this.attributes[n] : null;
      }
      addEventListener(n, cb) { this.listeners[n] = cb; }
      querySelectorAll(sel) {
        const out = [];
        const walk = (el) => {
          el.children.forEach((child) => {
            if (sel === '[data-acao-receber]' && child.getAttribute('data-acao-receber')) out.push(child);
            walk(child);
          });
        };
        walk(this);
        return out;
      }
    }

    const document = {
      elementos: new Map(),
      createElement(tag) {
        const el = new ElementoFake(tag);
        el.ownerDocument = document;
        return el;
      },
      getElementById(id) { return document.elementos.get(id) || null; },
      querySelector() { return null; }
    };

    const tbody = document.createElement('tbody');
    tbody.id = 'contasReceberTabelaBody';
    const wrap = document.createElement('div');
    wrap.id = 'contasReceberTabelaWrap';
    const vazio = document.createElement('div');
    vazio.id = 'contasReceberEstadoVazio';
    vazio.hidden = true;

    const chamadas = [];
    const contexto = {
      document,
      Element: ElementoFake,
      URLSearchParams,
      Intl,
      localStorage: { getItem: () => 't' },
      headersFinanceiro: (extra) => Object.assign({ 'X-Empresa-Id': '7', Authorization: 'Bearer t' }, extra || {}),
      fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
      console: { error() {} },
      alert() {},
      confirm: () => false,
      baixarRecebimentoPorFonte(...args) { chamadas.push(['baixar', ...args]); },
      abrirDetalhesReceberPorFonte(...args) { chamadas.push(['detalhes', ...args]); },
      editarContaReceber() {},
      renegociarContaReceber() {},
      cancelarContaReceber() {},
      window: {}
    };
    contexto.window = contexto;
    // stubs serão sobrescritos pelo script; reaplicamos após load
    vm.runInNewContext(fs.readFileSync(FRONT_RECEBER, 'utf8'), contexto, { filename: FRONT_RECEBER });

    const xss = '<img src=x onerror="globalThis.x=1">';
    contexto.preencherTabelaContasReceber([
      {
        id: 5,
        fonte: 'financeiro',
        chave: 'financeiro:5',
        cliente: xss,
        descricao: xss,
        documento: 'D',
        dataVencimento: '2026-10-28',
        valor: 10,
        numero_parcela: 1,
        total_parcelas: 1,
        status: 'pendente',
        origem: 'manual',
        acoes_disponiveis: ['baixar', 'detalhes']
      },
      {
        id: 5,
        fonte: 'contas_receber',
        chave: 'contas_receber:5',
        cliente: 'CR',
        descricao: 'Canonico',
        dataVencimento: null,
        valor: 7,
        status: 'aberto',
        status_persistido: 'aberto',
        origem: 'contas_receber',
        acoes_disponiveis: ['baixar', 'detalhes']
      }
    ]);

    assert.equal(tbody.children.length, 2);
    assert.equal(tbody.children[0].children[0].textContent, xss);
    assert.equal(tbody.children[0].children[3].textContent, '28/10/2026');
    assert.equal(tbody.children[1].children[3].textContent, '—');
    assert.equal(globalThis.x, undefined);

    const btnLegado = tbody.children[0].querySelectorAll('[data-acao-receber]')[0];
    const btnCr = tbody.children[1].querySelectorAll('[data-acao-receber]')[0];
    assert.equal(btnLegado.getAttribute('data-fonte'), 'financeiro');
    assert.equal(btnCr.getAttribute('data-fonte'), 'contas_receber');
    assert.equal(btnLegado.getAttribute('data-id'), '5');
    assert.equal(btnCr.getAttribute('data-id'), '5');
  });
});
