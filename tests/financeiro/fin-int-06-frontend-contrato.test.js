'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../..');
const FRONT_RELATORIOS = path.join(ROOT, 'frontend/erp/js/financeiro-relatorios.js');

class ElementoFake {
  constructor() {
    this.attributes = {};
    this.children = [];
    this._textContent = '';
    this.innerHTML = '';
    this.className = '';
  }

  set textContent(value) {
    this._textContent = String(value);
    this.children = [];
  }

  get textContent() {
    return this._textContent + this.children.map(child => child.textContent).join('');
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = children;
    this._textContent = '';
    this.innerHTML = '';
  }
}

function criarModulo({ resposta, modoFiscal = '0' } = {}) {
  const container = new ElementoFake();
  const requisicoes = [];
  const erros = [];
  const documento = {
    getElementById(id) {
      return id === 'relatorioContainer' ? container : null;
    },
    createElement() {
      return new ElementoFake();
    }
  };
  const contexto = {
    document: documento,
    URLSearchParams,
    Intl,
    Date,
    console: { error: (...args) => erros.push(args) },
    localStorage: { getItem: () => '' },
    headersFinanceiro: () => ({ 'X-Empresa-Id': 'empresa-a' }),
    modoFiscalQueryParam: () => modoFiscal,
    fetch: async (url, options) => {
      requisicoes.push({ url: String(url), options });
      return resposta;
    }
  };
  vm.runInNewContext(fs.readFileSync(FRONT_RELATORIOS, 'utf8'), contexto, {
    filename: FRONT_RELATORIOS
  });
  return { contexto, container, requisicoes, erros };
}

function respostaOk(dados) {
  return {
    ok: true,
    status: 200,
    json: async () => dados
  };
}

function contarLinhas(html) {
  const tbody = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
  return tbody ? (tbody[1].match(/<tr>/g) || []).length : 0;
}

const contasComMesmoId = [
  {
    id: 7,
    fonte: 'financeiro',
    chave: 'financeiro:7',
    cliente: 'Cliente Alfa',
    descricao: 'Legado',
    documento: 'DOC-7',
    valor: 125,
    valor_fiscal: 100,
    valor_nao_fiscal: 25,
    valor_total: 125,
    valor_recebido: null,
    valor_restante: null,
    dataVencimento: '2026-10-28',
    status: 'pendente',
    origem: 'manual'
  },
  {
    id: 7,
    fonte: 'contas_receber',
    chave: 'contas_receber:7',
    cliente: 'Cliente Beta',
    descricao: 'Parcela canônica',
    documento: '',
    valor: 80,
    valor_fiscal: 80,
    valor_nao_fiscal: 0,
    valor_total: 80,
    valor_original: 80,
    valor_recebido: 25,
    valor_restante: 55,
    dataVencimento: '2026-10-29',
    status: 'parcial',
    status_persistido: 'parcial',
    origem: 'contas_receber'
  }
];

describe('FIN-INT-06 — compatibilidade frontend do relatório de recebimentos', () => {
  it('renderiza linhas legadas e canônicas sem colidir IDs e mantém os totais originais', () => {
    const { contexto } = criarModulo();
    const html = contexto.renderizarRelatorioReceber({
      modo_fiscal_ativo: false,
      contas: contasComMesmoId,
      totais: { total: 205, fiscal: 180, nao_fiscal: 25 }
    });

    assert.equal(contarLinhas(html), 2);
    assert.match(html, /Cliente Alfa/);
    assert.match(html, /Cliente Beta/);
    assert.match(html, /Total:.*205,00/s);
    assert.match(html, /Fiscal:.*180,00/s);
    assert.match(html, /Não fiscal:.*25,00/s);
  });

  it('não transforma null em zero, mas também não exibe recebido ou saldo', () => {
    const { contexto } = criarModulo();
    const comValores = contexto.renderizarRelatorioReceber({
      modo_fiscal_ativo: false,
      contas: contasComMesmoId,
      totais: { total: 205, fiscal: 180, nao_fiscal: 25 }
    });
    const comCamposNulos = contexto.renderizarRelatorioReceber({
      modo_fiscal_ativo: false,
      contas: contasComMesmoId.map(conta => ({
        ...conta,
        valor_recebido: null,
        valor_restante: null
      })),
      totais: { total: 205, fiscal: 180, nao_fiscal: 25 }
    });

    assert.equal(comCamposNulos, comValores);
    assert.doesNotMatch(comValores, /25,00.*55,00|55,00.*25,00/);
    assert.doesNotMatch(comValores, /Recebido|Saldo restante|Valor original/);
  });

  it('usa os totais fiscais no modo fiscal e tolera o contrato anterior sem campos aditivos', () => {
    const { contexto } = criarModulo();
    const html = contexto.renderizarRelatorioReceber({
      modo_fiscal_ativo: true,
      contas: [{
        id: 1,
        cliente: 'Cliente antigo',
        valor: 120,
        valor_fiscal: 120,
        status: 'recebido'
      }],
      totais: { fiscal: 120 }
    });

    assert.equal(contarLinhas(html), 1);
    assert.match(html, /Valor Fiscal/);
    assert.match(html, /Total fiscal:.*120,00/s);
    assert.doesNotMatch(html, /Não fiscal/);
  });

  it('escapa conteúdo dinâmico das linhas antes de inserir o HTML', () => {
    const { contexto } = criarModulo();
    const nomeMalicioso = '<img src=x onerror="executar()">';
    const html = contexto.renderizarRelatorioReceber({
      modo_fiscal_ativo: false,
      contas: [{
        cliente: nomeMalicioso,
        descricao: nomeMalicioso,
        valor: 10,
        valor_fiscal: 10,
        valor_nao_fiscal: 0,
        valor_total: 10,
        status: 'pendente',
        origem: 'manual'
      }],
      totais: { total: 10, fiscal: 10, nao_fiscal: 0 }
    });

    assert.match(html, /&lt;img src=x onerror=&quot;executar\(\)&quot;&gt;/);
    assert.doesNotMatch(html, /<img/);
  });

  it('exibe estado vazio e estado de erro HTTP em vez de tratar erro como sucesso vazio', async () => {
    const vazio = criarModulo({ resposta: respostaOk({ success: true, contas: [], totais: {} }) });
    await vazio.contexto.gerarRelatorioReceber({
      dataInicio: '2026-10-01',
      dataFim: '2026-10-31',
      status: 'todas',
      cliente: ''
    });
    assert.match(vazio.container.innerHTML, /Nenhum resultado/);
    assert.equal(vazio.container.attributes['aria-busy'], 'false');

    const falha = criarModulo({
      resposta: {
        ok: false,
        status: 500,
        json: async () => ({ error: 'falha sintética' })
      }
    });
    await falha.contexto.gerarRelatorioReceber({
      dataInicio: '',
      dataFim: '',
      status: 'todas',
      cliente: ''
    });
    assert.match(falha.container.textContent, /falha sintética/);
    assert.equal(falha.container.attributes['aria-busy'], 'false');
    assert.equal(falha.erros.length, 1);
  });

  it('envia período, cliente, status, modo fiscal e contexto empresarial', async () => {
    const modulo = criarModulo({
      resposta: respostaOk({ success: true, contas: [], totais: {} }),
      modoFiscal: '1'
    });
    await modulo.contexto.gerarRelatorioReceber({
      dataInicio: '2026-10-01',
      dataFim: '2026-10-31',
      status: 'parcial',
      cliente: 'Cliente Beta'
    });

    const chamada = modulo.requisicoes[0];
    const url = new URL(chamada.url, 'http://localhost');
    assert.equal(url.searchParams.get('dataInicio'), '2026-10-01');
    assert.equal(url.searchParams.get('dataFim'), '2026-10-31');
    assert.equal(url.searchParams.get('status'), 'parcial');
    assert.equal(url.searchParams.get('cliente'), 'Cliente Beta');
    assert.equal(url.searchParams.get('modo_fiscal'), '1');
    assert.equal(chamada.options.headers['X-Empresa-Id'], 'empresa-a');
  });
});
