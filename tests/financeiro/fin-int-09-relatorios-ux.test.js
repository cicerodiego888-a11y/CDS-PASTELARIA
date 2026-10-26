'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../..');
const RELATORIOS_PATH = path.join(ROOT, 'frontend/erp/js/financeiro-relatorios.js');
const CONTEXTO_PATH = path.join(ROOT, 'frontend/shared/js/cds-empresa-contexto.js');
const PAGAR_PATH = path.join(ROOT, 'frontend/erp/js/financeiro-pagar.js');
const relatoriosSource = fs.readFileSync(RELATORIOS_PATH, 'utf8');
const contextoSource = fs.readFileSync(CONTEXTO_PATH, 'utf8');
const pagarSource = fs.readFileSync(PAGAR_PATH, 'utf8');

function criarModuloRelatorios({ empresaId = 1, empresas = [], falha = null } = {}) {
  const ids = [
    'financeiroRelatoriosEmpresaNome',
    'financeiroRelatoriosEmpresaCnpj',
    'financeiroRelatoriosEmpresaCardNome',
    'financeiroRelatoriosEmpresaCardCnpj'
  ];
  const elementos = new Map(ids.map((id) => [id, { textContent: '' }]));
  const listeners = new Map();
  const erros = [];
  const document = {
    getElementById: (id) => elementos.get(id) || null,
    addEventListener: (nome, callback) => listeners.set(nome, callback),
    removeEventListener: (nome, callback) => {
      if (listeners.get(nome) === callback) listeners.delete(nome);
    }
  };
  const CdsEmpresaContexto = {
    lerEmpresaId: () => empresaId,
    listarDisponiveis: async () => {
      if (falha) throw falha;
      return empresas;
    },
    formatarCnpj: (valor) => {
      const digitos = String(valor || '').replace(/\D/g, '');
      return digitos.length === 14
        ? digitos.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')
        : String(valor || '');
    }
  };
  const contexto = {
    document,
    CdsEmpresaContexto,
    console: { error: (...args) => erros.push(args) }
  };
  contexto.window = contexto;
  vm.runInNewContext(relatoriosSource, contexto, { filename: RELATORIOS_PATH });
  return { contexto, elementos, listeners, erros, CdsEmpresaContexto };
}

function criarModuloSeletorEmpresa(resposta) {
  const valores = new Map();
  let host = null;
  const footer = {
    firstChild: null,
    insertBefore: (elemento) => { host = elemento; }
  };
  const document = {
    getElementById: (id) => (id === 'cds-empresa-seletor' ? host : null),
    querySelector: (seletor) => (seletor === '.sidebar-footer' ? footer : null),
    createElement: () => ({
      hidden: true,
      className: '',
      innerHTML: ''
    })
  };
  const erros = [];
  const localStorage = {
    getItem: (chave) => valores.get(chave) || null,
    setItem: (chave, valor) => valores.set(chave, String(valor)),
    removeItem: (chave) => valores.delete(chave)
  };
  const contexto = {
    document,
    localStorage,
    fetch: async () => resposta,
    console: { error: (...args) => erros.push(args) }
  };
  contexto.window = contexto;
  vm.runInNewContext(contextoSource, contexto, { filename: CONTEXTO_PATH });
  return { contexto, erros, obterHost: () => host };
}

describe('FIN-INT-09 — UX dos Relatórios Financeiros', () => {
  it('remove dry-run das opções comuns e preserva as opções de relatórios existentes', () => {
    const opcoes = Array.from(relatoriosSource.matchAll(/<option value="([^"]+)"/g))
      .map((match) => match[1]);
    assert.deepEqual(opcoes, ['resumo', 'fluxo', 'receber', 'pagar', 'inadimplencia']);
    assert.doesNotMatch(relatoriosSource, /dry_run_historico|reconciliacao-historica\/dry-run/);
  });

  it('mantém a ação administrativa de dry-run em Contas a Pagar protegida', () => {
    assert.match(
      pagarSource,
      /typeof podeAdministrarFinanceiro === 'function' && podeAdministrarFinanceiro\(\)[\s\S]*?executarDryRunReconciliacaoHistorica/
    );
    assert.match(
      pagarSource,
      /if \(typeof podeAdministrarFinanceiro === 'function' && !podeAdministrarFinanceiro\(\)\)/
    );
    assert.match(pagarSource, /\/api\/contas-pagar\/reconciliacao-historica\/dry-run/);
  });

  it('identifica a empresa validada e atualiza o nome e CNPJ quando o contexto muda', async () => {
    const modulo = criarModuloRelatorios({
      empresaId: 1,
      empresas: [
        { id: 1, nome_fantasia: 'Loja A', cnpj: '11222333000181' },
        { id: 2, razao_social: 'Loja B', cnpj: '04252011000110' }
      ]
    });
    const evento = 'cds-empresa-contexto-alterado';
    modulo.contexto.observarContextoEmpresaRelatorios();

    await modulo.contexto.atualizarContextoEmpresaRelatorios();
    assert.equal(modulo.elementos.get('financeiroRelatoriosEmpresaNome').textContent, 'Loja A');
    assert.equal(
      modulo.elementos.get('financeiroRelatoriosEmpresaCnpj').textContent,
      '11.222.333/0001-81'
    );

    modulo.CdsEmpresaContexto.lerEmpresaId = () => 2;
    await modulo.listeners.get(evento)();
    assert.equal(modulo.elementos.get('financeiroRelatoriosEmpresaNome').textContent, 'Loja B');
    assert.equal(
      modulo.elementos.get('financeiroRelatoriosEmpresaCardCnpj').textContent,
      '04.252.011/0001-10'
    );
    assert.match(relatoriosSource, /observarContextoEmpresaRelatorios\(\);/);
  });

  it('não apresenta empresa sem contexto validado e distingue lista vazia de falha de rede', async () => {
    const semContexto = criarModuloRelatorios({
      empresaId: null,
      empresas: [{ id: 1, nome_fantasia: 'Loja A' }]
    });
    await semContexto.contexto.atualizarContextoEmpresaRelatorios();
    assert.equal(
      semContexto.elementos.get('financeiroRelatoriosEmpresaNome').textContent,
      'Selecione uma empresa no menu global.'
    );
    assert.equal(semContexto.elementos.get('financeiroRelatoriosEmpresaCnpj').textContent, '');

    const contextoInvalido = criarModuloRelatorios({
      empresaId: 99,
      empresas: [{ id: 1, nome_fantasia: 'Loja A' }]
    });
    await contextoInvalido.contexto.atualizarContextoEmpresaRelatorios();
    assert.match(
      contextoInvalido.elementos.get('financeiroRelatoriosEmpresaNome').textContent,
      /Contexto empresarial inválido/
    );

    const vazia = criarModuloSeletorEmpresa({
      ok: true,
      status: 200,
      json: async () => []
    });
    await vazia.contexto.CdsEmpresaContexto.inicializar();
    assert.match(vazia.obterHost().innerHTML, /Você não possui empresa disponível/);

    const falha = criarModuloSeletorEmpresa({
      ok: false,
      status: 503,
      json: async () => ({ error: 'serviço indisponível' })
    });
    await falha.contexto.CdsEmpresaContexto.inicializar();
    assert.match(falha.obterHost().innerHTML, /Não foi possível carregar as empresas/);
    assert.doesNotMatch(falha.obterHost().innerHTML, /Você não possui empresa disponível/);
    assert.equal(falha.erros.length, 1);
  });

  it('renderiza dados do nome empresarial como texto, sem interpretar HTML', async () => {
    const nome = '<img src=x onerror="executar()">';
    const modulo = criarModuloRelatorios({
      empresas: [{ id: 1, nome_fantasia: nome }]
    });
    await modulo.contexto.atualizarContextoEmpresaRelatorios();
    assert.equal(modulo.elementos.get('financeiroRelatoriosEmpresaNome').textContent, nome);
  });
});
