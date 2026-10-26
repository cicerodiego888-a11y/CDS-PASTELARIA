'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const frontendRoot = path.join(root, 'frontend');
const reportDir = path.join(root, 'docs', 'financeiro');
const empresasFixture = [
  {
    id: 1,
    nome: 'Empresa Alfa',
    nome_fantasia: 'Empresa Alfa',
    razao_social: 'Empresa Alfa LTDA',
    cnpj: '11111111000111',
    resumo: { totalRecebido: 100, totalPago: 50, totalReceber: 70, totalPagar: 30 }
  },
  {
    id: 2,
    nome: 'Empresa Beta',
    nome_fantasia: 'Empresa Beta',
    razao_social: 'Empresa Beta LTDA',
    cnpj: '22222222000122',
    resumo: { totalRecebido: 200, totalPago: 40, totalReceber: 60, totalPagar: 20 }
  },
  {
    id: 3,
    nome: 'Empresa Gama',
    nome_fantasia: 'Empresa Gama',
    razao_social: 'Empresa Gama LTDA',
    cnpj: null,
    resumo: { totalRecebido: 50, totalPago: 30, totalReceber: 10, totalPagar: 10 }
  }
];

let server;
let windowRef;
let baseUrl;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startServer() {
  const types = {
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2'
  };
  return new Promise((resolve, reject) => {
    server = http.createServer((request, response) => {
      let pathname;
      try {
        pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      } catch (_error) {
        response.writeHead(400).end();
        return;
      }
      if (pathname === '/__fin_ux_08_preview_blank') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><html><head></head><body></body></html>');
        return;
      }
      const file = path.resolve(frontendRoot, `.${pathname}`);
      if (!file.startsWith(frontendRoot + path.sep)) {
        response.writeHead(403).end();
        return;
      }
      fs.readFile(file, (error, content) => {
        if (error) {
          response.writeHead(error.code === 'ENOENT' ? 404 : 500).end();
          return;
        }
        response.writeHead(200, {
          'Cache-Control': 'no-store',
          'Content-Type': types[path.extname(file)] || 'application/octet-stream'
        });
        response.end(content);
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}

async function capture(fileName) {
  const image = await windowRef.webContents.capturePage();
  fs.writeFileSync(path.join(reportDir, fileName), image.toPNG());
  return image.getSize();
}

async function loadPreview() {
  const html = fs.readFileSync(path.join(frontendRoot, 'erp', 'pages', 'financeiro.html'), 'utf8');
  const cssUrls = [
    `${baseUrl}/vendor/bootstrap/css/bootstrap.min.css`,
    `${baseUrl}/vendor/fontawesome/css/all.min.css`,
    `${baseUrl}/css/style.css`,
    `${baseUrl}/shared/design-system/cds-ui-foundation.css`
  ];
  const markup = `<main class="container-fluid py-3">${html}</main>`;
  await windowRef.webContents.executeJavaScript(`(async () => {
    document.head.innerHTML = '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">';
    document.body.innerHTML = ${JSON.stringify(markup)};
    await Promise.all(${JSON.stringify(cssUrls)}.map(url => new Promise(resolve => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = url;
      link.onload = resolve;
      link.onerror = resolve;
      document.head.appendChild(link);
    })));
    const style = document.createElement('style');
    style.textContent = ${JSON.stringify(fs.readFileSync(path.join(root, 'frontend', 'css', 'financeiro.css'), 'utf8'))};
    document.head.appendChild(style);
    const chartScript = document.createElement('script');
    chartScript.src = '${baseUrl}/vendor/chart.js/chart.min.js';
    await new Promise((resolve, reject) => {
      chartScript.onload = resolve;
      chartScript.onerror = reject;
      document.head.appendChild(chartScript);
    });

    window.__finUx08 = {
      calls: [],
      falhar: false,
      empresaAtiva: 1,
      serieTemporalOverride: null,
      empresas: ${JSON.stringify(empresasFixture)},
      empresasOriginais: ${JSON.stringify(empresasFixture)}
    };
    window.CdsEmpresaContexto = {
      listarDisponiveis: async () => window.__finUx08.empresas.map(empresa => ({
        id: empresa.id,
        nome_fantasia: empresa.nome_fantasia,
        razao_social: empresa.razao_social,
        cnpj: empresa.cnpj
      })),
      selecionar: async id => {
        const empresa = window.__finUx08.empresas.find(item => item.id === Number(id));
        if (!empresa) throw new Error('Empresa não autorizada');
        window.__finUx08.empresaAtiva = Number(id);
        document.dispatchEvent(new CustomEvent('cds-empresa-contexto-alterado', {
          detail: { empresaId: Number(id) }
        }));
        return { empresa };
      },
      formatarCnpj: value => {
        const digits = String(value || '').replace(/\\D/g, '');
        return digits.length === 14
          ? digits.replace(/^(\\d{2})(\\d{3})(\\d{3})(\\d{4})(\\d{2})$/, '$1.$2.$3/$4-$5')
          : value || '';
      },
      headersAuth: extra => Object.assign({
        Accept: 'application/json',
        'X-Empresa-Id': String(window.__finUx08.empresaAtiva)
      }, extra || {}),
      temEmpresaSelecionada: () => Number.isInteger(window.__finUx08.empresaAtiva),
      lerEmpresaId: () => window.__finUx08.empresaAtiva,
      mensagemEmpresaObrigatoria: () => 'Selecione uma empresa.'
    };
    window.bootstrap = {
      Modal: class {
        constructor(element) { this.element = element; }
        show() {}
        hide() {}
        static getInstance() { return null; }
        static getOrCreateInstance(element) { return new this(element); }
      }
    };
    window.fetch = async (url, options = {}) => {
      const parsed = new URL(String(url), window.location.href);
      const state = window.__finUx08;
      state.calls.push({
        url: parsed.pathname + parsed.search,
        headers: options.headers || {}
      });
      if (state.falhar) {
        return { ok: false, status: 503, json: async () => ({ success: false, error: 'Consulta indisponível' }) };
      }
      const resposta = payload => ({ ok: true, status: 200, json: async () => payload });
      if (parsed.pathname === '/api/financeiro/multiempresa/receber') {
        return resposta({
          success: true,
          escopo: 'todas',
          contas: [{
            id: 901,
            empresa_id: 1,
            empresa_nome: 'Empresa Alfa',
            cliente: 'Cliente Alfa',
            descricao: 'Recebível sintético',
            documento: 'CR-A',
            dataVencimento: '2026-10-20',
            valor: 25,
            numero_parcela: 1,
            total_parcelas: 1,
            status: 'parcial',
            origem: 'venda',
            fonte: 'contas_receber',
            chave: 'contas_receber:1:901',
            acoes_disponiveis: ['detalhes']
          }]
        });
      }
      if (parsed.pathname === '/api/financeiro/multiempresa/dividas-cliente') {
        return resposta({
          success: true,
          clientes: [{
            cliente_id: 31,
            nome_cliente: 'Cliente Alfa',
            empresa_id: 1,
            empresa_nome: 'Empresa Alfa',
            quantidade_vendas: 1,
            quantidade_titulos: 1,
            total_divida: 25,
            total_pago: 5,
            vencidas: 0,
            a_vencer: 1
          }]
        });
      }
      if (parsed.pathname === '/api/contas-pagar/multiempresa') {
        return resposta({
          success: true,
          contas: [{
            id: 801,
            empresa_id: 2,
            empresa_nome: 'Empresa Beta',
            fornecedor: 'Fornecedor Beta',
            descricao: 'Título sintético',
            data_vencimento: '2026-10-22',
            valor_original: 40,
            valor_restante: 30,
            status: 'aberto',
            documento: 'CP-B'
          }]
        });
      }
      if (parsed.pathname === '/api/financeiro/multiempresa/historico') {
        return resposta([{
          id: 701,
          empresa_id: 3,
          empresa_nome: 'Empresa Gama',
          data_movimento: '2026-10-24',
          tipo: 'receita',
          descricao: 'Movimento sintético',
          pessoa_nome: 'Cliente Gama',
          status: 'recebido',
          forma_pagamento: 'dinheiro',
          valor: 15
        }]);
      }
      if (parsed.pathname === '/api/condicoes-pagamento') {
        return resposta([]);
      }
      if (parsed.pathname.startsWith('/api/financeiro/multiempresa/relatorios/')) {
        return resposta({ success: true, contas: [], totais: {}, resumo: [], fluxo: [], inadimplencia: [] });
      }
      if (parsed.pathname !== '/api/financeiro/dashboard/multiempresa') {
        return { ok: false, status: 404, json: async () => ({ success: false, error: 'Não encontrado' }) };
      }

      const requested = parsed.searchParams.get('empresaId');
      if (requested === 'todas') await new Promise(resolve => setTimeout(resolve, 180));
      const companies = requested === 'todas'
        ? state.empresas
        : state.empresas.filter(empresa => String(empresa.id) === requested);
      if (companies.length === 0) {
        return { ok: false, status: 403, json: async () => ({ success: false, error: 'Empresa não autorizada' }) };
      }
      const resumo = companies.reduce((sum, empresa) => {
        Object.keys(empresa.resumo).forEach(key => { sum[key] += empresa.resumo[key]; });
        return sum;
      }, { totalRecebido: 0, totalPago: 0, totalReceber: 0, totalPagar: 0 });
      const serieTemporal = state.serieTemporalOverride !== null
        ? state.serieTemporalOverride
        : companies.flatMap((empresa, index) => (
          empresa.resumo.totalRecebido === 0 && empresa.resumo.totalPago === 0
            ? []
            : [{
              data: '2026-10-0' + (index + 1),
              recebido: empresa.resumo.totalRecebido,
              pago: empresa.resumo.totalPago
            }]
        ));
      const payload = {
        success: true,
        escopo: requested === 'todas' ? 'todas' : 'empresa',
        periodo: {
          dataInicio: parsed.searchParams.get('dataInicio'),
          dataFim: parsed.searchParams.get('dataFim'),
          dataReferenciaAbertos: '2026-10-26'
        },
        resumo,
        empresas: companies,
        serieTemporal
      };
      state.lastPayload = payload;
      return {
        ok: true,
        status: 200,
        json: async () => payload
      };
    };
  })()`);

  for (const scriptPath of [
    'shared/js/cds-page-shell.js',
    'erp/js/financeiro-dashboard.js',
    'erp/js/financeiro-receber.js',
    'erp/js/financeiro-pagar.js',
    'erp/js/financeiro-historico.js',
    'erp/js/financeiro-relatorios.js',
    'erp/js/financeiro-condicoes.js',
    'erp/js/financeiro.js'
  ]) {
    await windowRef.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '${baseUrl}/${scriptPath}';
      script.onload = () => resolve(true);
      script.onerror = reject;
      document.head.appendChild(script);
    })`);
  }
}

async function waitFor(condition, message, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ready = await windowRef.webContents.executeJavaScript(condition);
    if (ready) return;
    await sleep(30);
  }
  const state = await windowRef.webContents.executeJavaScript(`(() => ({
    selector: document.getElementById('financeiroEmpresaSelect')?.value || '',
    scope: typeof financeiroEscopoEmpresa === 'undefined' ? null : financeiroEscopoEmpresa,
    title: document.getElementById('financeiroDashboardEscopo')?.textContent || '',
    state: document.getElementById('dashboardFinEstado')?.textContent || '',
    payload: window.__finUx08.lastPayload || null,
    calls: window.__finUx08.calls.slice(-3)
  }))()`);
  throw new Error(message + ': ' + JSON.stringify(state));
}

async function runChecks() {
  await loadPreview();
  await waitFor(
    'Boolean(document.querySelector("#financeiroEmpresaSelect option[value=\\"3\\"]") && document.querySelector("#dashboardFinEstado"))',
    'Seletor ou dashboard não inicializou'
  );
  const cabecalhoUnico = await windowRef.webContents.executeJavaScript(`(() => ({
    cabecalhos: document.querySelectorAll('.financeiro-page-header').length,
    titulos: Array.from(document.querySelectorAll('h1')).filter(el => el.textContent.trim() === 'Financeiro').length
  }))()`);
  if (cabecalhoUnico.cabecalhos !== 1 || cabecalhoUnico.titulos !== 1) {
    throw new Error('O cabeçalho antigo continua duplicado: ' + JSON.stringify(cabecalhoUnico));
  }
  await waitFor(
    'window.__finUx08.calls.some(call => call.url.includes("empresaId=todas"))',
    'A consulta inicial não usou todas as empresas'
  );

  await windowRef.webContents.executeJavaScript(`(() => {
    const select = document.getElementById('financeiroEmpresaSelect');
    select.value = '2';
    select.dispatchEvent(new Event('change'));
  })()`);
  await waitFor(
    'document.getElementById("financeiroDashboardEscopo")?.textContent.includes("Empresa Beta") && document.getElementById("dashboardFinConteudo")?.hidden === false',
    'A seleção individual não atualizou o dashboard'
  );
  await sleep(240);
  const individual = await windowRef.webContents.executeJavaScript(`(() => ({
    empresaSelecionada: document.getElementById('financeiroEmpresaSelect').value,
    contextoAtivo: window.__finUx08.empresaAtiva,
    titulo: document.getElementById('financeiroDashboardEscopo').textContent,
    recebido: document.getElementById('totalRecebido').textContent,
    quantidadeCards: document.querySelectorAll('.financeiro-dashboard-empresa').length,
    request: window.__finUx08.calls[window.__finUx08.calls.length - 1]
  }))()`);
  if (individual.empresaSelecionada !== '2' || individual.contextoAtivo !== 2
    || !individual.titulo.includes('Empresa Beta') || !individual.recebido.includes('200,00')
    || individual.quantidadeCards !== 1 || !individual.request.url.includes('empresaId=2')
    || individual.request.headers['X-Empresa-Id'] !== '2') {
    throw new Error('Escopo individual ou atualização após troca inválida: ' + JSON.stringify(individual));
  }

  for (const id of [1, 3]) {
    await windowRef.webContents.executeJavaScript(`(() => {
      const select = document.getElementById('financeiroEmpresaSelect');
      select.value = '${id}';
      select.dispatchEvent(new Event('change'));
    })()`);
    await waitFor(
      `document.getElementById("financeiroDashboardEscopo")?.textContent.includes("${id === 1 ? 'Empresa Alfa' : 'Empresa Gama'}") && document.getElementById("dashboardFinConteudo")?.hidden === false`,
      `A seleção individual da empresa ${id} não atualizou o dashboard`
    );
    const selecionada = await windowRef.webContents.executeJavaScript(`(() => ({
      empresa: document.getElementById('financeiroEmpresaSelect').value,
      contexto: window.__finUx08.empresaAtiva,
      cards: document.querySelectorAll('.financeiro-dashboard-empresa').length,
      titulo: document.getElementById('financeiroDashboardEscopo').textContent
    }))()`);
    if (selecionada.empresa !== String(id) || selecionada.contexto !== id
      || selecionada.cards !== 1) {
      throw new Error(`Escopo individual ${id} inconsistente: ` + JSON.stringify(selecionada));
    }
  }

  await windowRef.webContents.executeJavaScript(`(() => {
    const select = document.getElementById('financeiroEmpresaSelect');
    select.value = 'todas';
    select.dispatchEvent(new Event('change'));
  })()`);
  await waitFor(
    'document.getElementById("financeiroDashboardEscopo")?.textContent.includes("3 EMPRESAS AUTORIZADAS")',
    'A volta ao escopo consolidado não atualizou o dashboard'
  );
  await waitFor(
    'document.getElementById("dashboardFinConteudo")?.hidden === false',
    'Os dados consolidados não foram apresentados'
  );
  const consolidado = await windowRef.webContents.executeJavaScript(`(() => ({
    scope: document.getElementById('financeiroEmpresaSelect').value,
    recebido: document.getElementById('totalRecebido').textContent,
    pago: document.getElementById('totalPago').textContent,
    saldo: document.getElementById('saldoPeriodo').textContent,
    cards: Array.from(document.querySelectorAll('.financeiro-dashboard-empresa h4')).map(item => item.textContent),
    cnpj: document.querySelector('.financeiro-dashboard-empresa small')?.textContent || '',
    flowLabels: chartFluxoFinanceiroMultiempresa.data.datasets.map(dataset => dataset.label),
    openLabels: chartAbertoFinanceiroMultiempresa.data.datasets.map(dataset => dataset.label)
  }))()`);
  if (consolidado.scope !== 'todas' || !consolidado.recebido.includes('350,00')
    || !consolidado.pago.includes('120,00') || !consolidado.saldo.includes('230,00')
    || consolidado.cards.length !== 3 || !consolidado.cards.includes('Empresa Gama')
    || !consolidado.cnpj.includes('CNPJ 11.111.111/0001-11') || consolidado.flowLabels.join(',') !== 'Recebimentos,Pagamentos'
    || consolidado.openLabels.join(',') !== 'A receber,A pagar') {
    throw new Error('Consolidação, cards ou gráficos inconsistentes: ' + JSON.stringify(consolidado));
  }

  await windowRef.webContents.executeJavaScript(`(() => {
    document.querySelector('[data-selecionar-empresa="3"]').click();
  })()`);
  await waitFor(
    'document.getElementById("financeiroDashboardEscopo")?.textContent.includes("Empresa Gama") && document.getElementById("dashboardFinConteudo")?.hidden === false',
    'A ação Ver financeiro da empresa não abriu o escopo individual'
  );
  await windowRef.webContents.executeJavaScript(`(() => {
    const select = document.getElementById('financeiroEmpresaSelect');
    select.value = 'todas';
    select.dispatchEvent(new Event('change'));
  })()`);
  await waitFor(
    'document.getElementById("financeiroDashboardEscopo")?.textContent.includes("3 EMPRESAS AUTORIZADAS")',
    'A ação do card não permitiu retornar ao consolidado'
  );

  await windowRef.webContents.executeJavaScript(`(() => {
    document.querySelector('[data-aba="receber"]').click();
  })()`);
  const allTab = await windowRef.webContents.executeJavaScript(`(() => ({
    selector: document.getElementById('financeiroEmpresaSelect').value,
    blocked: document.getElementById('financeiroConteudo').textContent.includes('permanecem no escopo de uma empresa'),
    tabela: Boolean(document.getElementById('tabelaReceber')),
    conteudo: document.getElementById('financeiroConteudo').textContent.slice(0, 240),
    chamadas: window.__finUx08.calls.slice(-3).map(call => call.url)
  }))()`);
  if (allTab.selector !== 'todas' || allTab.blocked || !allTab.tabela) {
    throw new Error('Contas a Receber não preservou o escopo Todas: ' + JSON.stringify(allTab));
  }
  await waitFor(
    'window.__finUx08.calls.some(call => call.url.startsWith("/api/financeiro/multiempresa/receber")) && document.getElementById("contasReceberTabelaBody")?.textContent.includes("Empresa Alfa")',
    'Contas a Receber não consultou a união autorizada com origem empresarial'
  );

  for (const [aba, endpoint, elemento, texto] of [
    ['duplicata', '/api/financeiro/multiempresa/dividas-cliente', '#tabelaDuplicataClientes tbody', 'Empresa Alfa'],
    ['pagar', '/api/contas-pagar/multiempresa', '#tabelaPagar tbody', 'Empresa Beta'],
    ['historico', '/api/financeiro/multiempresa/historico', '#tabelaHistoricoFinanceiro', 'Empresa Gama']
  ]) {
    await windowRef.webContents.executeJavaScript(`document.querySelector('[data-aba="${aba}"]').click()`);
    await waitFor(
      `window.__finUx08.calls.some(call => call.url.startsWith("${endpoint}")) && document.querySelector("${elemento}")?.textContent.includes("${texto}")`,
      `A aba ${aba} não carregou registros no escopo consolidado`
    );
    const estadoAba = await windowRef.webContents.executeJavaScript(`(() => ({
      escopo: document.getElementById('financeiroEmpresaSelect').value,
      nomeEmpresa: document.querySelector('${elemento}').textContent.includes('${texto}')
    }))()`);
    if (estadoAba.escopo !== 'todas' || !estadoAba.nomeEmpresa) {
      throw new Error(`A aba ${aba} perdeu o escopo ou a origem empresarial: ` + JSON.stringify(estadoAba));
    }
  }

  await windowRef.webContents.executeJavaScript(`document.querySelector('[data-aba="pagar"]').click()`);
  await waitFor(
    'window.__finUx08.calls.some(call => call.url.startsWith("/api/contas-pagar/multiempresa"))',
    'Contas a Pagar não carregou no escopo consolidado'
  );
  const acaoEmpresaEspecifica = await windowRef.webContents.executeJavaScript(`(() => {
    prepararSeletorEmpresaNovaDespesa();
    return {
      escopo: document.getElementById('financeiroEmpresaSelect').value,
      opcoes: Array.from(document.getElementById('despesaEmpresaAcao').options).map(opcao => opcao.value)
    };
  })()`);
  if (acaoEmpresaEspecifica.escopo !== 'todas'
    || acaoEmpresaEspecifica.opcoes.join(',') !== ',1,2,3') {
    throw new Error('A ação de escrita não preservou escopo global e seleção empresarial local: '
      + JSON.stringify(acaoEmpresaEspecifica));
  }

  await windowRef.webContents.executeJavaScript(`document.querySelector('[data-aba="condicoes"]').click()`);
  await waitFor(
    'window.__finUx08.calls.some(call => call.url.startsWith("/api/condicoes-pagamento")) && document.getElementById("financeiroConteudo")?.textContent.includes("Catálogo compartilhado entre empresas")',
    'O escopo compartilhado das Condições de Pagamento não foi explicitado'
  );

  await windowRef.webContents.executeJavaScript(`document.querySelector('[data-aba="relatorios"]').click()`);
  await waitFor(
    'document.getElementById("financeiroRelatoriosEmpresaNome")?.textContent.includes("Todas as empresas autorizadas")',
    'Relatórios não exibiu o escopo consolidado'
  );
  await windowRef.webContents.executeJavaScript(`(() => {
    const tipo = document.getElementById('tipoRelatorio');
    tipo.value = 'receber';
    tipo.dispatchEvent(new Event('change'));
    document.getElementById('btnGerarRelatorio').click();
  })()`);
  await waitFor(
    'window.__finUx08.calls.some(call => call.url.startsWith("/api/financeiro/multiempresa/relatorios/receber"))',
    'Relatório de Contas a Receber não usou a rota consolidada'
  );

  await windowRef.webContents.executeJavaScript(`(() => {
    document.querySelector('[data-aba="dashboard"]').click();
  })()`);
  await waitFor(
    'document.getElementById("dashboardFinConteudo")?.hidden === false',
    'Dashboard não voltou após navegação entre abas'
  );
  await windowRef.webContents.executeJavaScript(`(() => {
    document.getElementById('financeiroPeriodo').value = 'personalizado';
    document.getElementById('financeiroPeriodo').dispatchEvent(new Event('change'));
    document.getElementById('financeiroDataInicio').value = '2026-10-10';
    document.getElementById('financeiroDataFim').value = '2026-10-20';
    document.getElementById('btnAtualizarFinanceiro').click();
  })()`);
  await waitFor(
    'window.__finUx08.calls.some(call => call.url.includes("dataInicio=2026-10-10") && call.url.includes("dataFim=2026-10-20"))',
    'O filtro de período não chegou ao endpoint'
  );
  await waitFor(
    'document.getElementById("dashboardFinConteudo")?.hidden === false',
    'Dashboard não atualizou após trocar o período'
  );

  await windowRef.webContents.executeJavaScript(`(() => {
    const state = window.__finUx08;
    state.empresas[2].resumo.totalRecebido = 0;
    state.empresas[2].resumo.totalPago = 0;
    state.serieTemporalOverride = [
      { data: '2026-01-10', recebido: 100, pago: 30 },
      { data: '2026-01-25', recebido: 50, pago: 20 },
      { data: '2026-02-10', recebido: 200, pago: 40 }
    ];
    document.getElementById('financeiroDataInicio').value = '2026-01-01';
    document.getElementById('financeiroDataFim').value = '2026-10-31';
    document.getElementById('btnAtualizarFinanceiro').click();
  })()`);
  await waitFor(
    'chartFluxoFinanceiroMultiempresa && chartFluxoFinanceiroMultiempresa.data.labels.length === 2',
    'A série com movimentos em meses distintos não foi agrupada mensalmente'
  );
  const mapeamentoMensal = await windowRef.webContents.executeJavaScript(`(() => ({
    tipo: chartFluxoFinanceiroMultiempresa.config.type,
    meses: chartFluxoFinanceiroMultiempresa.data.labels,
    recebimentos: chartFluxoFinanceiroMultiempresa.data.datasets[0].data,
    pagamentos: chartFluxoFinanceiroMultiempresa.data.datasets[1].data,
    legenda: chartFluxoFinanceiroMultiempresa.data.datasets.map(dataset => dataset.label),
    corRecebimentos: chartFluxoFinanceiroMultiempresa.data.datasets[0].backgroundColor,
    corPagamentos: chartFluxoFinanceiroMultiempresa.data.datasets[1].backgroundColor,
    abertosOrientacao: chartAbertoFinanceiroMultiempresa.options.indexAxis,
    nomesEmpresas: chartAbertoFinanceiroMultiempresa.data.labels,
    abertosLegendas: chartAbertoFinanceiroMultiempresa.data.datasets.map(dataset => dataset.label),
    empresaSemMovimento: Array.from(document.querySelectorAll('.financeiro-dashboard-empresa')).find(card => card.querySelector('h4').textContent === 'Empresa Gama')?.textContent
  }))()`);
  if (mapeamentoMensal.tipo !== 'bar' || mapeamentoMensal.meses.join(',') !== 'Jan,Fev'
    || mapeamentoMensal.recebimentos[0] !== 150 || mapeamentoMensal.pagamentos[0] !== 50
    || mapeamentoMensal.recebimentos[1] !== 200 || mapeamentoMensal.pagamentos[1] !== 40
    || mapeamentoMensal.legenda.join(',') !== 'Recebimentos,Pagamentos'
    || mapeamentoMensal.corRecebimentos !== '#159947' || mapeamentoMensal.corPagamentos !== '#e73535'
    || mapeamentoMensal.abertosOrientacao !== 'y'
    || mapeamentoMensal.nomesEmpresas.join(',') !== 'Empresa Alfa,Empresa Beta,Empresa Gama'
    || mapeamentoMensal.abertosLegendas.join(',') !== 'A receber,A pagar'
    || !mapeamentoMensal.empresaSemMovimento.includes('0,00')) {
    throw new Error('Mapeamento mensal ou empresa sem movimentação inválido: ' + JSON.stringify(mapeamentoMensal));
  }

  const escalaZeroAnterior = await windowRef.webContents.executeJavaScript(`(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    document.body.appendChild(canvas);
    const chart = new Chart(canvas, {
      type: 'bar',
      data: { labels: ['Empresa'], datasets: [{ data: [0] }] },
      options: { animation: false, scales: { y: { beginAtZero: true } } }
    });
    const maximo = chart.scales.y.max;
    chart.destroy();
    canvas.remove();
    return maximo;
  })()`);
  if (escalaZeroAnterior <= 0) {
    throw new Error('Não foi possível reproduzir a escala positiva automática da série zero: ' + escalaZeroAnterior);
  }

  await windowRef.webContents.executeJavaScript(`(() => {
    const state = window.__finUx08;
    state.empresas.forEach(empresa => {
      empresa.resumo.totalRecebido = 0;
      empresa.resumo.totalPago = 0;
    });
    state.serieTemporalOverride = [];
    document.getElementById('btnAtualizarFinanceiro').click();
  })()`);
  await waitFor(
    'document.getElementById("graficoFluxoFinanceiro")?.textContent.includes("Sem movimentações no período") && chartFluxoFinanceiroMultiempresa === null',
    'A ausência de movimentações não apresentou estado vazio'
  );
  const semMovimentacoes = await windowRef.webContents.executeJavaScript(`(() => ({
    legendaFalsa: document.querySelector('#graficoFluxoFinanceiro canvas') !== null,
    recebidos: document.getElementById('totalRecebido').textContent
  }))()`);
  if (semMovimentacoes.legendaFalsa || !semMovimentacoes.recebidos.includes('0,00')) {
    throw new Error('A série vazia foi apresentada como movimento: ' + JSON.stringify(semMovimentacoes));
  }

  await windowRef.webContents.executeJavaScript(`(() => {
    window.__finUx08.empresas.forEach(empresa => {
      empresa.resumo.totalReceber = 0;
      empresa.resumo.totalPagar = 0;
    });
    document.getElementById('btnAtualizarFinanceiro').click();
  })()`);
  await waitFor(
    'document.getElementById("graficoAbertoFinanceiro")?.textContent.includes("Nenhum saldo em aberto") && chartAbertoFinanceiroMultiempresa === null',
    'Saldos abertos iguais a zero não foram apresentados com escala coerente'
  );

  await windowRef.webContents.executeJavaScript(`(() => {
    window.__finUx08.serieTemporalOverride = [
      { data: '2026-10-01', recebido: null, pago: 0 }
    ];
    document.getElementById('btnAtualizarFinanceiro').click();
  })()`);
  await waitFor(
    'document.getElementById("dashboardFinEstado")?.classList.contains("financeiro-dashboard-estado--erro")',
    'Um valor ausente na série foi convertido em zero'
  );
  const respostaInvalida = await windowRef.webContents.executeJavaScript(`(() => ({
    mensagem: document.getElementById('dashboardFinEstado').textContent,
    conteudoOculto: document.getElementById('dashboardFinConteudo').hidden
  }))()`);
  if (!respostaInvalida.mensagem.includes('série temporal') || !respostaInvalida.conteudoOculto) {
    throw new Error('Uma resposta incompleta foi apresentada como válida: ' + JSON.stringify(respostaInvalida));
  }

  await windowRef.webContents.executeJavaScript(`(() => {
    window.__finUx08.falhar = true;
    document.getElementById('btnAtualizarFinanceiro').click();
  })()`);
  await waitFor(
    'document.getElementById("dashboardFinEstado")?.classList.contains("financeiro-dashboard-estado--erro")',
    'Falha HTTP não foi apresentada explicitamente'
  );
  const errorState = await windowRef.webContents.executeJavaScript(`(() => ({
    mensagem: document.getElementById('dashboardFinEstado').textContent,
    conteudoOculto: document.getElementById('dashboardFinConteudo').hidden
  }))()`);
  if (!errorState.mensagem.includes('Consulta indisponível') || !errorState.conteudoOculto) {
    throw new Error('A falha do endpoint foi convertida em dados vazios: ' + JSON.stringify(errorState));
  }

  await windowRef.webContents.executeJavaScript(`(() => {
    window.__finUx08.falhar = false;
    window.__finUx08.empresas = JSON.parse(JSON.stringify(window.__finUx08.empresasOriginais));
    window.__finUx08.serieTemporalOverride = null;
    document.getElementById('financeiroEmpresaSelect').value = 'todas';
    document.getElementById('financeiroEmpresaSelect').dispatchEvent(new Event('change'));
  })()`);
  await waitFor(
    'document.getElementById("dashboardFinConteudo")?.hidden === false',
    'Não foi possível restaurar os dados consolidados após a falha'
  );
  await windowRef.webContents.executeJavaScript(`(() => {
    const periodo = document.getElementById('financeiroPeriodo');
    periodo.value = 'mes-atual';
    periodo.dispatchEvent(new Event('change'));
    document.getElementById('btnAtualizarFinanceiro').click();
  })()`);
  await waitFor(
    'window.__finUx08.calls.some(call => call.url.includes("dataInicio=2026-10-01") && call.url.includes("dataFim=2026-10-26"))',
    'Não foi possível restaurar o período da captura'
  );
  await waitFor(
    'document.getElementById("dashboardFinConteudo")?.hidden === false',
    'Dashboard não carregou os valores do período da captura'
  );

  await windowRef.webContents.executeJavaScript(`(() => {
    const state = window.__finUx08;
    state.serieTemporalOverride = [
      { data: '2026-01-10', recebido: 20, pago: 5 },
      { data: '2026-01-25', recebido: 15, pago: 7 },
      ...Array.from({ length: 9 }, (_, index) => ({
        data: '2026-' + String(index + 2).padStart(2, '0') + '-15',
        recebido: 35,
        pago: 12
      }))
    ];
    const periodo = document.getElementById('financeiroPeriodo');
    periodo.value = 'personalizado';
    periodo.dispatchEvent(new Event('change'));
    document.getElementById('financeiroDataInicio').value = '2026-01-01';
    document.getElementById('financeiroDataFim').value = '2026-10-31';
    document.getElementById('btnAtualizarFinanceiro').click();
  })()`);
  await waitFor(
    'window.__finUx08.calls.some(call => call.url.includes("dataInicio=2026-01-01") && call.url.includes("dataFim=2026-10-31")) && chartFluxoFinanceiroMultiempresa && chartFluxoFinanceiroMultiempresa.data.labels.length === 10',
    'A série sintética de captura não produziu dez meses reais'
  );

  const cdpDebugger = windowRef.webContents.debugger;
  if (!cdpDebugger.isAttached()) cdpDebugger.attach('1.3');
  const viewports = [
    { width: 1440, height: 1000 },
    { width: 1024, height: 768 },
    { width: 768, height: 900 }
  ];
  const responsive = [];
  for (const viewport of viewports) {
    await cdpDebugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: false
    });
    await sleep(180);
    const metrics = await windowRef.webContents.executeJavaScript(`(() => ({
      width: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      kpiTracks: getComputedStyle(document.querySelector('.financeiro-dashboard-indicadores')).gridTemplateColumns.split(/\\s+/).filter(track => parseFloat(track) > 0).length,
      kpiCount: document.querySelectorAll('.financeiro-dashboard-kpi').length,
      graphTracks: getComputedStyle(document.querySelector('.financeiro-dashboard-graficos')).gridTemplateColumns.split(/\\s+/).length,
      companyTracks: getComputedStyle(document.querySelector('.financeiro-dashboard-empresas')).gridTemplateColumns.split(/\\s+/).filter(track => parseFloat(track) > 0).length,
      companyMetricTracks: getComputedStyle(document.querySelector('.financeiro-dashboard-empresa dl')).gridTemplateColumns.split(/\\s+/).filter(track => parseFloat(track) > 0).length,
      summaryHeaderHeight: document.querySelector('.financeiro-dashboard-cabecalho').getBoundingClientRect().height
    }))()`);
    responsive.push(metrics);
    if (metrics.scrollWidth > metrics.width + 24) {
      throw new Error('Overflow horizontal em ' + viewport.width + 'px: ' + JSON.stringify(metrics));
    }
    if (viewport.width === 1440 && (metrics.kpiTracks !== 5 || metrics.kpiCount !== 5)) {
      throw new Error('Os cinco indicadores não cabem em uma linha em 1440px: ' + JSON.stringify(metrics));
    }
    if (viewport.width === 1440 && (metrics.graphTracks !== 2 || metrics.companyMetricTracks !== 2)) {
      throw new Error('Gráficos ou métricas das empresas não estão em duas colunas em 1440px: ' + JSON.stringify(metrics));
    }
    if (viewport.width === 1440 && metrics.companyTracks !== 3) {
      throw new Error('Os cards das empresas não estão em grade no desktop: ' + JSON.stringify(metrics));
    }
    if (viewport.width === 1024 && (metrics.kpiTracks > 3 || metrics.graphTracks !== 1)) {
      throw new Error('Layout responsivo inválido em 1024px: ' + JSON.stringify(metrics));
    }
    if (viewport.width === 768 && (metrics.kpiTracks !== 1 || metrics.graphTracks !== 1)) {
      throw new Error('Layout mobile inválido em 768px: ' + JSON.stringify(metrics));
    }
    if (metrics.summaryHeaderHeight > 220) {
      throw new Error('Cabeçalho do resumo ficou excessivamente alto em ' + viewport.width + 'px: ' + JSON.stringify(metrics));
    }
  }
  await cdpDebugger.sendCommand('Emulation.clearDeviceMetricsOverride');
  cdpDebugger.detach();
  console.log('Escala automática anterior para série zero', escalaZeroAnterior);
  console.log('Responsividade financeira', JSON.stringify(responsive));
  await sleep(250);
  return consolidado;
}

app.whenReady().then(async () => {
  try {
    await startServer();
    windowRef = new BrowserWindow({
      width: 1440,
      height: 1000,
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    });
    await windowRef.loadURL(`${baseUrl}/__fin_ux_08_preview_blank`);
    const resultado = await runChecks();
    const prefix = process.env.FIN_UX_SCREENSHOT_PREFIX || 'SPRINT-FIN-UX-09';
    for (const viewport of [
      { width: 1440, height: 1000, suffix: '1440' },
      { width: 1024, height: 1700, suffix: '1024' },
      { width: 768, height: 2300, suffix: '768' }
    ]) {
      await windowRef.setContentSize(viewport.width, viewport.height);
      await sleep(300);
      console.log(
        `Captura sintética ${viewport.width}px`,
        await capture(`${prefix}-${viewport.suffix}.png`)
      );
    }
    console.log('Electron preview financeiro aprovado', JSON.stringify(resultado));
    await windowRef.close();
    await new Promise((resolve) => server.close(resolve));
    app.exit(0);
  } catch (error) {
    console.error(error);
    if (windowRef && !windowRef.isDestroyed()) windowRef.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    process.exit(1);
  }
});
