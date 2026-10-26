'use strict';

/**
 * FIN-INT-02 — Correções Contas a Receber (vencimento, erros, escape).
 * Fixtures/mocks isolados; não prova integração operacional.
 * Executar: node --test tests/financeiro/fin-int-02-contas-receber.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../..');
const ARQUIVO = path.join(ROOT, 'frontend/erp/js/financeiro-receber.js');

class ElementoFake {
  constructor(tag) {
    this.tagName = String(tag || 'div').toLowerCase();
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
    this.colSpan = 1;
    this.open = false;
  }

  set id(valor) {
    this._id = valor;
    if (valor && this.ownerDocument) this.ownerDocument.elementos.set(valor, this);
  }
  get id() { return this._id; }

  set textContent(valor) {
    this._textContent = String(valor);
    this.children = [];
  }
  get textContent() {
    return this._textContent + this.children.map((child) => child.textContent).join('');
  }

  set innerHTML(valor) {
    this._innerHTML = String(valor);
    this.children = [];
    this._textContent = '';
  }
  get innerHTML() {
    return this._innerHTML;
  }

  appendChild(child) {
    child.ownerDocument = this.ownerDocument;
    this.children.push(child);
    if (child.id && this.ownerDocument) this.ownerDocument.elementos.set(child.id, child);
    return child;
  }

  replaceChildren(...children) {
    this.children = [];
    this._textContent = '';
    this._innerHTML = '';
    children.forEach((child) => this.appendChild(child));
  }

  setAttribute(nome, valor) {
    this.attributes[nome] = String(valor);
  }

  getAttribute(nome) {
    return Object.prototype.hasOwnProperty.call(this.attributes, nome)
      ? this.attributes[nome]
      : null;
  }

  addEventListener(nome, callback) {
    this.listeners[nome] = callback;
  }

  querySelectorAll(sel) {
    const out = [];
    const walk = (el) => {
      if (!el || !el.children) return;
      el.children.forEach((child) => {
        if (sel === '[data-acao-receber]' && child.getAttribute('data-acao-receber')) {
          out.push(child);
        }
        walk(child);
      });
    };
    walk(this);
    return out;
  }

  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
}

function criarDocumentFake() {
  const doc = {
    elementos: new Map(),
    createElement(tag) {
      const el = new ElementoFake(tag);
      el.ownerDocument = doc;
      return el;
    },
    getElementById(id) {
      return doc.elementos.get(id) || null;
    },
    querySelector(sel) {
      if (sel === '#tabelaReceber tbody') return doc.getElementById('contasReceberTabelaBody');
      if (sel === '.financeiro-tabela--receber') return doc.getElementById('contasReceberTabelaWrap');
      if (sel === '.financeiro-filtros-avancados') {
        return [...doc.elementos.values()].find((el) => el.className.includes('financeiro-filtros-avancados')) || null;
      }
      return null;
    }
  };
  return doc;
}

function montarShellReceber(document) {
  const conteudo = document.createElement('main');
  conteudo.id = 'financeiroConteudo';
  document.elementos.set('financeiroConteudo', conteudo);

  // Espelha os nós que renderContasReceber criaria via innerHTML (fake não parseia HTML).
  const estadoVazio = document.createElement('div');
  estadoVazio.id = 'contasReceberEstadoVazio';
  estadoVazio.hidden = true;
  document.elementos.set('contasReceberEstadoVazio', estadoVazio);

  const wrap = document.createElement('div');
  wrap.id = 'contasReceberTabelaWrap';
  wrap.className = 'financeiro-tabela financeiro-tabela--receber';
  document.elementos.set('contasReceberTabelaWrap', wrap);

  const tbody = document.createElement('tbody');
  tbody.id = 'contasReceberTabelaBody';
  document.elementos.set('contasReceberTabelaBody', tbody);

  const filtroCliente = document.createElement('input');
  filtroCliente.id = 'filtroClienteReceber';
  filtroCliente.value = '';
  document.elementos.set('filtroClienteReceber', filtroCliente);

  const filtroStatus = document.createElement('select');
  filtroStatus.id = 'filtroStatusReceber';
  filtroStatus.value = 'todas';
  document.elementos.set('filtroStatusReceber', filtroStatus);

  const filtroDocumento = document.createElement('input');
  filtroDocumento.id = 'filtroDocumentoReceber';
  filtroDocumento.value = '';
  document.elementos.set('filtroDocumentoReceber', filtroDocumento);

  const filtroInicio = document.createElement('input');
  filtroInicio.id = 'filtroDataInicioReceber';
  filtroInicio.value = '2026-10-01';
  document.elementos.set('filtroDataInicioReceber', filtroInicio);

  const filtroFim = document.createElement('input');
  filtroFim.id = 'filtroDataFimReceber';
  filtroFim.value = '2026-10-31';
  document.elementos.set('filtroDataFimReceber', filtroFim);

  return { tbody, wrap, estadoVazio };
}

function carregarModulo(document, fetchImpl) {
  const requisicoes = [];
  const contexto = {
    document,
    Element: ElementoFake,
    URLSearchParams,
    Intl,
    localStorage: { getItem: () => 'token-sintetico' },
    headersFinanceiro: (extra) => Object.assign({
      Accept: 'application/json',
      Authorization: 'Bearer token-sintetico',
      'X-Empresa-Id': '7'
    }, extra || {}),
    financeiroMensagemEmpresaObrigatoria: () =>
      'Selecione a empresa no seletor da barra lateral para continuar.',
    obterPeriodoFinanceiro: () => ({ dataInicio: '2026-10-01', dataFim: '2026-10-31' }),
    fetch: async (url, options) => {
      requisicoes.push({ url: String(url), options: options || {} });
      return fetchImpl(url, options, requisicoes);
    },
    console: { error() {}, warn() {} },
    alert() {},
    confirm: () => false,
    baixarRecebimento() {},
    abrirDetalhesReceber() {},
    editarContaReceber() {},
    renegociarContaReceber() {},
    cancelarContaReceber() {},
    window: {}
  };
  contexto.window = contexto;
  vm.runInNewContext(fs.readFileSync(ARQUIVO, 'utf8'), contexto, { filename: ARQUIVO });
  return { contexto, requisicoes };
}

describe('FIN-INT-02 — Contas a Receber (vencimento, erro, escape)', () => {
  it('exibe dataVencimento em formato BR e tolera vencimento nulo', () => {
    const document = criarDocumentFake();
    const { tbody, wrap, estadoVazio } = montarShellReceber(document);
    const { contexto } = carregarModulo(document, async () => ({ ok: true, status: 200, json: async () => ({}) }));

    contexto.preencherTabelaContasReceber([
      {
        id: 11,
        cliente: 'Cliente Alfa',
        descricao: 'Parcela 1',
        documento: 'DOC-1',
        dataVencimento: '2026-10-28',
        valor: 150.5,
        numero_parcela: 1,
        total_parcelas: 2,
        status: 'aberto',
        origem: 'manual'
      },
      {
        id: 12,
        cliente: 'Cliente Beta',
        descricao: 'Sem vencimento',
        documento: null,
        dataVencimento: null,
        valor: 10,
        status: 'parcial',
        origem: 'venda'
      }
    ]);

    assert.equal(wrap.hidden, false);
    assert.equal(estadoVazio.hidden, true);
    assert.equal(tbody.children.length, 2);
    assert.equal(tbody.children[0].children[3].textContent, '28/10/2026');
    assert.equal(tbody.children[1].children[3].textContent, '—');
    assert.equal(tbody.children[0].children[4].textContent.includes('150'), true);
  });

  it('escapa HTML malicioso em cliente/descrição via textContent', () => {
    const document = criarDocumentFake();
    const { tbody } = montarShellReceber(document);
    const { contexto } = carregarModulo(document, async () => ({ ok: true, status: 200, json: async () => ({}) }));
    const xss = '<img src=x onerror="globalThis.xssReceber=1">';

    contexto.preencherTabelaContasReceber([{
      id: 99,
      cliente: xss,
      descricao: xss,
      documento: xss,
      dataVencimento: '2026-11-01',
      valor: 1,
      status: xss,
      origem: xss
    }]);

    const linha = tbody.children[0];
    assert.equal(linha.children[0].textContent, xss);
    assert.equal(linha.children[1].textContent, xss);
    assert.equal(linha.children[2].textContent, xss);
    assert.equal(linha.children[6].children[0].textContent, xss);
    assert.equal(linha.children[6].children[0].className, 'status-outro');
    assert.ok(linha.children[7].textContent.includes(xss));
    assert.ok(/legado|canônico/i.test(linha.children[7].textContent));
    assert.equal(tbody._innerHTML, '');
    assert.equal(globalThis.xssReceber, undefined);
    assert.equal(linha.children[8].querySelectorAll('[data-acao-receber]').length, 5);
    assert.equal(linha.children[8].innerHTML.includes('onclick='), false);
  });

  it('propaga 400/401/403/500 com mensagens seguras (sem HTML)', async () => {
    const document = criarDocumentFake();
    const { tbody, wrap, estadoVazio } = montarShellReceber(document);
    let resposta = {
      ok: false,
      status: 400,
      json: async () => ({ success: false, error: 'X-Empresa-Id obrigatório' })
    };
    const { contexto, requisicoes } = carregarModulo(document, async () => resposta);

    await contexto.carregarContasReceber({
      cliente: '',
      status: 'todas',
      documento: '',
      dataInicio: '2026-10-01',
      dataFim: '2026-10-31'
    });
    assert.equal(wrap.hidden, false);
    assert.equal(estadoVazio.hidden, true);
    assert.ok(tbody.children[0].children[0].textContent.includes('X-Empresa-Id'));
    assert.equal(tbody.children[0].children[0].textContent.includes('<'), false);

    resposta = {
      ok: false,
      status: 401,
      json: async () => ({ error: '<script>alert(1)</script>' })
    };
    await contexto.carregarContasReceber({ dataInicio: '2026-10-01', dataFim: '2026-10-31' });
    assert.equal(tbody.children[0].children[0].textContent, 'Sessão expirada. Faça login novamente.');

    resposta = {
      ok: false,
      status: 403,
      json: async () => ({ error: 'Empresa não autorizada' })
    };
    await contexto.carregarContasReceber({ dataInicio: '2026-10-01', dataFim: '2026-10-31' });
    assert.ok(tbody.children[0].children[0].textContent.includes('Empresa não autorizada'));

    resposta = {
      ok: false,
      status: 500,
      json: async () => ({ error: 'SQLITE_ERROR SELECT * FROM financeiro' })
    };
    await contexto.carregarContasReceber({ dataInicio: '2026-10-01', dataFim: '2026-10-31' });
    assert.equal(
      tbody.children[0].children[0].textContent,
      'Não foi possível carregar as contas a receber. Tente novamente.'
    );

    assert.ok(requisicoes.length >= 4);
    assert.equal(requisicoes[0].options.headers['X-Empresa-Id'], '7');
    assert.ok(String(requisicoes[0].options.headers.Authorization || '').startsWith('Bearer '));
    assert.ok(requisicoes[0].url.includes('/api/financeiro/receber?'));
    assert.ok(requisicoes[0].url.includes('dataInicio=2026-10-01'));
  });

  it('falha de rede usa mensagem segura e filtros/headers permanecem disponíveis', async () => {
    const document = criarDocumentFake();
    const { tbody } = montarShellReceber(document);
    const { contexto, requisicoes } = carregarModulo(document, async () => {
      throw new Error('Failed to fetch <img src=x onerror=alert(1)>');
    });

    document.getElementById('filtroClienteReceber').value = 'Alfa';
    document.getElementById('filtroStatusReceber').value = 'vencidas';
    document.getElementById('filtroDocumentoReceber').value = 'DOC';

    await contexto.carregarContasReceber(contexto.coletarFiltrosReceber({
      dataInicio: '2026-10-01',
      dataFim: '2026-10-31'
    }));

    assert.ok(tbody.children[0].children[0].textContent.includes('conexão')
      || tbody.children[0].children[0].textContent.includes('Não foi possível'));
    assert.equal(tbody.children[0].children[0].textContent.includes('<img'), false);
    assert.ok(requisicoes[0].url.includes('cliente=Alfa'));
    assert.ok(requisicoes[0].url.includes('status=vencidas'));
    assert.ok(requisicoes[0].url.includes('documento=DOC'));
    assert.equal(requisicoes[0].options.headers['X-Empresa-Id'], '7');
  });

  it('carga bem-sucedida preenche a tabela a partir do contrato da API', async () => {
    const document = criarDocumentFake();
    const { tbody, estadoVazio } = montarShellReceber(document);
    const { contexto } = carregarModulo(document, async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        contas: [{
          id: 3,
          cliente: 'Cliente',
          descricao: 'Titulo',
          documento: 'X',
          dataVencimento: '2026-10-15',
          valor: 99,
          numero_parcela: 1,
          total_parcelas: 1,
          status: 'vencido',
          origem: 'manual'
        }]
      })
    }));

    await contexto.carregarContasReceber({
      dataInicio: '2026-10-01',
      dataFim: '2026-10-31',
      status: 'todas',
      cliente: '',
      documento: ''
    });

    assert.equal(estadoVazio.hidden, true);
    assert.equal(tbody.children.length, 1);
    assert.equal(tbody.children[0].children[3].textContent, '15/10/2026');
    assert.equal(tbody.children[0].children[6].children[0].className, 'status-vencido');
  });
});
