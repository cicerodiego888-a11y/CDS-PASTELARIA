'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const frontendRoot = path.join(root, 'frontend');
const reportDir = path.join(root, 'docs', 'financeiro');
const fixture = {
  success: true,
  modo_fiscal_ativo: false,
  contas: [{
    id: 401,
    cliente: 'Cliente sintético',
    descricao: 'Recebimento de demonstração',
    documento: 'DOC-FIN-UX04-001',
    valor: 240,
    valor_fiscal: 180,
    valor_nao_fiscal: 60,
    valor_total: 240,
    dataVencimento: '2026-10-24',
    status: 'pendente',
    origem: 'venda'
  }],
  totais: { total: 240, fiscal: 180, nao_fiscal: 60 }
};
const reportResponses = {
  '/api/financeiro/relatorios/resumo': {
    success: true,
    modo_fiscal_ativo: false,
    resumo: {
      receitas: { total: 420, recebidas: 320, pendentes: 100, quantidade: 2 },
      despesas: { total: 175, pagas: 125, pendentes: 50, quantidade: 2 }
    },
    recebimentos_venda: {
      fiscal: { total: 200 },
      nao_fiscal: { total: 50 },
      total: { total: 250 }
    }
  },
  '/api/financeiro/relatorios/receber': fixture,
  '/api/contas-pagar': {
    success: true,
    contas: [{
      id: 402,
      pessoa_nome: 'Fornecedor sintético',
      descricao: 'Compra de insumos',
      documento: 'DOC-FIN-UX04-002',
      categoria: 'Insumos',
      valor_original: 85,
      data_vencimento: '2026-10-26',
      status: 'aberto',
      forma_pagamento: 'boleto',
      origem: 'compra'
    }]
  },
  '/api/financeiro/relatorios/fluxo': {
    success: true,
    modo_fiscal_ativo: false,
    entradas: 250,
    entradas_financeiro: 100,
    entradas_venda: { fiscal: 200, nao_fiscal: 50, total: 250 },
    saidas: 125
  },
  '/api/financeiro/relatorios/inadimplencia': {
    success: true,
    vencidas: 1,
    vencer7dias: 1,
    valorAtraso: 90,
    contasAtraso: [{
      id: 403,
      pessoa: 'Cliente em atraso',
      valor: 90,
      dataVencimento: '2026-10-20',
      dias_atraso: 5,
      status: 'aberto',
      fonte: 'contas_receber'
    }]
  },
  '/api/contas-pagar/reconciliacao-historica/dry-run': {
    success: true,
    empresa_id: 7,
    itens: [{
      financeiro_id: 404,
      descricao: 'Despesa legado demonstrativa',
      status_legado: 'pendente',
      valor_lancamento: 45,
      acao_sugerida: 'vincular',
      confianca: 'alta',
      candidato_mcf: { conta_pagar_id: 405 },
      justificativa: 'Referência encontrada'
    }],
    totais_empresa: {
      gerais: { quantidade: 1, valor_conhecido: 45, valor_nao_verificavel_qtd: 0 },
      por_acao: {
        vincular: { quantidade: 1, valor_conhecido: 45 },
        criar_titulo: { quantidade: 0, valor_conhecido: 0 },
        ignorar: { quantidade: 0 },
        revisao_manual: { quantidade: 0 }
      }
    },
    meta: { projecoes_excluidas_do_universo: 2 }
  }
};
const legacyReportMarkup = `
  <div class="financeiro-filtros">
    <div class="financeiro-filtro-grupo">
      <label for="tipoRelatorio">Tipo de Relatório:</label>
      <select id="tipoRelatorio" class="form-control">
        <option>Resumo Financeiro</option>
        <option selected>Contas a Receber</option>
        <option>Contas a Pagar</option>
        <option>Fluxo Financeiro</option>
        <option>Inadimplência</option>
      </select>
    </div>
    <div class="financeiro-acoes">
      <button class="btn btn-primary">Gerar Relatório</button>
      <button class="btn btn-success">Exportar</button>
    </div>
  </div>
  <div id="relatorioContainer" class="mt-4">
    <div class="card">
      <div class="card-header">
        <h4 class="mb-0">Contas a Receber</h4>
        <small class="text-muted">Período: 01/10/2026 a 31/10/2026 · Fiscal + Não fiscal + Total</small>
      </div>
      <div class="card-body">
        <div class="financeiro-tabela">
          <table>
            <thead><tr>
              <th>Cliente</th><th>Descrição</th><th>Documento</th><th>Vencimento</th>
              <th>Fiscal</th><th>Não Fiscal</th><th>Total</th><th>Status</th><th>Origem</th>
            </tr></thead>
            <tbody><tr>
              <td>Cliente sintético</td><td>Recebimento de demonstração</td><td>DOC-FIN-UX04-001</td>
              <td>24/10/2026</td><td>R$ 180,00</td><td>R$ 60,00</td><td>R$ 240,00</td>
              <td>pendente</td><td>venda</td>
            </tr></tbody>
          </table>
        </div>
        <div class="mt-3 text-end">
          <strong>Total: R$ 240,00</strong>
          <small class="text-muted d-block">Fiscal: R$ 180,00 | Não fiscal: R$ 60,00</small>
        </div>
      </div>
    </div>
  </div>
`;

let server;
let windowRef;
let baseUrl;

function startServer() {
  const contentTypes = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
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
      if (pathname === '/__fin_ux_04_preview_blank') {
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
          'Content-Type': contentTypes[path.extname(file)] || 'application/octet-stream'
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

async function loadPreview() {
  console.log('Loading preview HTML and styles');
  const html = fs.readFileSync(path.join(frontendRoot, 'erp', 'pages', 'financeiro.html'), 'utf8');
  const css = fs.readFileSync(path.join(frontendRoot, 'css', 'financeiro.css'), 'utf8');
  const wrapped = `<main class="container-fluid py-3">${html}</main>`;
  const cssUrls = [
    `${baseUrl}/vendor/bootstrap/css/bootstrap.min.css`,
    `${baseUrl}/vendor/fontawesome/css/all.min.css`,
    `${baseUrl}/css/style.css`,
    `${baseUrl}/shared/design-system/cds-ui-foundation.css`
  ];
  await windowRef.webContents.executeJavaScript(`(async () => {
    document.head.innerHTML = '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">';
    document.body.innerHTML = ${JSON.stringify(wrapped)};
    await Promise.all(${JSON.stringify(cssUrls)}.map(url => new Promise(resolve => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = url;
      link.onload = resolve;
      link.onerror = resolve;
      document.head.appendChild(link);
    })));
    const style = document.createElement('style');
    style.textContent = ${JSON.stringify(css)};
    document.head.appendChild(style);
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    window.obterPeriodoFinanceiro = () => ({
      dataInicio: '2026-10-01',
      dataFim: '2026-10-31'
    });
    window.modoFiscalQueryParam = () => '0';
    window.headersFinanceiro = extra => Object.assign({
      'X-Empresa-Id': 'empresa-sintetica'
    }, extra || {});
    window.__finUx04 = {
      calls: [],
      responses: ${JSON.stringify(reportResponses)},
      override: null,
      alertMessage: null
    };
    window.fetch = async (url, options = {}) => {
      const state = window.__finUx04;
      const requestUrl = new URL(String(url), window.location.href);
      state.calls.push({
        url: requestUrl.pathname + requestUrl.search,
        headers: options.headers || {}
      });
      if (state.override) return state.override;
      const body = state.responses[requestUrl.pathname];
      return {
        ok: true,
        status: 200,
        json: async () => body
      };
    };
    window.alert = message => {
      window.__finUx04.alertMessage = String(message);
    };
  })()`);
  console.log('Preview HTML and styles loaded');
  await windowRef.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '${baseUrl}/erp/js/financeiro-relatorios.js';
    script.onload = () => resolve(true);
    script.onerror = reject;
    document.head.appendChild(script);
  })`);
  console.log('Report script loaded');
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function capture(fileName) {
  const image = await windowRef.webContents.capturePage();
  fs.writeFileSync(path.join(reportDir, fileName), image.toPNG());
  return image.getSize();
}

async function selecionarEGerar(tipo, filtros = {}) {
  return windowRef.webContents.executeJavaScript(`(async () => {
    const seletor = document.getElementById('tipoRelatorio');
    seletor.value = ${JSON.stringify(tipo)};
    seletor.dispatchEvent(new Event('change'));
    const filtros = ${JSON.stringify(filtros)};
    if (Object.prototype.hasOwnProperty.call(filtros, 'status')) {
      document.getElementById('filtroStatusRelatorio').value = filtros.status;
    }
    if (Object.prototype.hasOwnProperty.call(filtros, 'cliente')) {
      document.getElementById('filtroClienteRelatorio').value = filtros.cliente;
    }
    if (Object.prototype.hasOwnProperty.call(filtros, 'fornecedor')) {
      document.getElementById('filtroFornecedorRelatorio').value = filtros.fornecedor;
    }
    await window.carregarRelatorioSelecionado();
    return {
      title: document.querySelector('.financeiro-relatorios-card-cabecalho h3')?.textContent || '',
      rows: document.querySelectorAll('.financeiro-relatorios-tabela tbody tr').length,
      busy: document.getElementById('relatorioContainer').getAttribute('aria-busy')
    };
  })()`);
}

async function runPreviewChecks() {
  console.log('Running FIN-UX-04 Electron acceptance checks');
  await loadPreview();
  await windowRef.webContents.executeJavaScript(`(() => {
    document.querySelectorAll('.financeiro-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.aba === 'relatorios');
    });
    document.getElementById('financeiroConteudo').innerHTML = ${JSON.stringify(legacyReportMarkup)};
  })()`);
  await wait(250);
  const beforeSize = await capture('SPRINT-FIN-UX-04-ANTES.png');

  await windowRef.webContents.executeJavaScript(`(() => {
    renderRelatoriosFinanceiros({
      dataInicio: '2026-10-01',
      dataFim: '2026-10-31'
    });
  })()`);
  console.log('Reports tab initialized');
  const initial = await windowRef.webContents.executeJavaScript(`(() => ({
    tabs: document.querySelectorAll('.financeiro-tab').length,
    reportTypes: Array.from(document.querySelectorAll('#tipoRelatorio option')).map(option => option.value),
    inlineHandlers: document.querySelectorAll('#financeiroConteudo [onclick]').length
  }))()`);
  if (initial.tabs !== 7 || initial.reportTypes.length !== 6 || initial.inlineHandlers !== 0) {
    throw new Error('A navegação, os tipos de relatório ou a instalação segura dos eventos regrediu.');
  }
  console.log('Initial report controls verified');

  const receberMetrics = await selecionarEGerar('receber');
  console.log('Receiving report queried');
  if (!receberMetrics.title.includes('Contas a Receber') || receberMetrics.rows !== 1) {
    throw new Error('O relatório de Contas a Receber não apresentou o resultado sintético.');
  }
  await wait(250);
  const afterSize = await capture('SPRINT-FIN-UX-04-DEPOIS.png');
  if (beforeSize.width !== afterSize.width || beforeSize.height !== afterSize.height) {
    throw new Error(`As capturas antes/depois diferem: ${JSON.stringify({ beforeSize, afterSize })}.`);
  }

  const receberFiltroMetrics = await selecionarEGerar('receber', {
    status: 'vencido',
    cliente: 'Cliente & Loja'
  });
  console.log('Receiving filters queried');
  const summaryMetrics = await selecionarEGerar('resumo');
  const fluxoMetrics = await selecionarEGerar('fluxo');
  const pagarMetrics = await selecionarEGerar('pagar', {
    status: 'parcial',
    fornecedor: 'Padaria & Filhos'
  });
  const inadMetrics = await selecionarEGerar('inadimplencia');
  const dryRunMetrics = await selecionarEGerar('dry_run_historico');
  const requests = await windowRef.webContents.executeJavaScript('window.__finUx04.calls');
  const parsedRequests = requests.map(request => ({
    ...request,
    url: new URL(request.url, 'http://127.0.0.1')
  }));
  const requestFor = pathname => parsedRequests.filter(request => request.url.pathname === pathname).pop();
  const receivingRequest = requestFor('/api/financeiro/relatorios/receber');
  const payableRequest = requestFor('/api/contas-pagar');
  const summaryRequest = requestFor('/api/financeiro/relatorios/resumo');
  const flowRequest = requestFor('/api/financeiro/relatorios/fluxo');
  const overdueRequest = requestFor('/api/financeiro/relatorios/inadimplencia');
  if (receivingRequest?.url.searchParams.get('status') !== 'vencido'
      || receivingRequest.url.searchParams.get('cliente') !== 'Cliente & Loja') {
    throw new Error('Os filtros existentes de status/cliente não chegaram à rota de receber.');
  }
  if (payableRequest?.url.searchParams.get('status') !== 'parcial'
      || payableRequest.url.searchParams.get('fornecedor') !== 'Padaria & Filhos') {
    throw new Error('Os filtros existentes de status/fornecedor não chegaram à rota MCF.');
  }
  for (const request of [summaryRequest, receivingRequest, payableRequest, flowRequest, overdueRequest]) {
    if (request.url.searchParams.get('dataInicio') !== '2026-10-01'
        || request.url.searchParams.get('dataFim') !== '2026-10-31') {
      throw new Error(`O período global não foi enviado para ${request.url.pathname}.`);
    }
  }
  for (const request of [summaryRequest, receivingRequest, flowRequest]) {
    if (request.url.searchParams.get('modo_fiscal') !== '0') {
      throw new Error(`O modo fiscal não foi enviado para ${request.url.pathname}.`);
    }
  }
  for (const request of parsedRequests) {
    if (request.headers['X-Empresa-Id'] !== 'empresa-sintetica') {
      throw new Error(`A consulta ${request.url.pathname} não propagou X-Empresa-Id.`);
    }
  }
  for (const pathname of [
    '/api/financeiro/relatorios/resumo',
    '/api/financeiro/relatorios/receber',
    '/api/contas-pagar',
    '/api/financeiro/relatorios/fluxo',
    '/api/financeiro/relatorios/inadimplencia',
    '/api/contas-pagar/reconciliacao-historica/dry-run'
  ]) {
    if (!requestFor(pathname)) throw new Error(`Tipo de relatório sem consulta: ${pathname}`);
  }
  const dryRunRequest = requestFor('/api/contas-pagar/reconciliacao-historica/dry-run');
  if (dryRunRequest.url.search) throw new Error('O dry-run passou a receber filtros de período.');
  if (!summaryMetrics.title.includes('Resumo') || !fluxoMetrics.title.includes('Fluxo')
      || !pagarMetrics.title.includes('Contas a Pagar') || !inadMetrics.title.includes('Inadimplência')
      || !dryRunMetrics.title.includes('Dry-run')) {
    throw new Error('Um dos tipos existentes de relatório não foi renderizado.');
  }
  if (!receberFiltroMetrics.title.includes('Contas a Receber')) {
    throw new Error('O filtro de recebíveis falhou.');
  }

  const loadingMetrics = await windowRef.webContents.executeJavaScript(`(async () => {
    const state = window.__finUx04;
    document.getElementById('tipoRelatorio').value = 'resumo';
    state.override = new Promise(resolve => {
      state.resolveOverride = resolve;
    });
    state.pendingRequest = window.carregarRelatorioSelecionado();
    await new Promise(resolve => setTimeout(resolve, 0));
    return {
      visible: Boolean(document.querySelector('#relatorioContainer .financeiro-relatorios-estado--carregando')),
      busy: document.getElementById('relatorioContainer').getAttribute('aria-busy'),
      text: document.getElementById('relatorioContainer').textContent
    };
  })()`);
  if (!loadingMetrics.visible || loadingMetrics.busy !== 'true') {
    throw new Error('O estado de carregamento não foi apresentado.');
  }
  await windowRef.webContents.executeJavaScript(`(async () => {
    const state = window.__finUx04;
    state.resolveOverride({
      ok: true,
      status: 200,
      json: async () => state.responses['/api/financeiro/relatorios/resumo']
    });
    await state.pendingRequest;
    state.override = null;
  })()`);

  await windowRef.webContents.executeJavaScript(`(() => {
    window.__finUx04.responses['/api/financeiro/relatorios/receber'] = {
      ...${JSON.stringify(fixture)},
      contas: [],
      totais: { total: 0, fiscal: 0, nao_fiscal: 0 }
    };
  })()`);
  await selecionarEGerar('receber');
  const emptyState = await windowRef.webContents.executeJavaScript(`(() => ({
    visible: Boolean(document.querySelector('#relatorioContainer .financeiro-relatorios-estado--vazio')),
    tableCount: document.querySelectorAll('#relatorioContainer .financeiro-relatorios-tabela').length,
    text: document.getElementById('relatorioContainer').textContent
  }))()`);
  await wait(250);
  const emptySize = await capture('SPRINT-FIN-UX-04-ESTADO-VAZIO.png');
  if (!emptyState.visible || emptyState.tableCount !== 0 || !emptyState.text.includes('Nenhum resultado')) {
    throw new Error('O estado vazio do relatório não foi apresentado corretamente.');
  }

  await windowRef.webContents.executeJavaScript(`(() => {
    window.__finUx04.override = {
      ok: false,
      status: 500,
      json: async () => ({ error: '<svg onload=alert(1)>' })
    };
  })()`);
  await selecionarEGerar('receber');
  const errorMetrics = await windowRef.webContents.executeJavaScript(`(() => ({
    errorVisible: Boolean(document.querySelector('#relatorioContainer .financeiro-relatorios-estado--erro')),
    emptyVisible: Boolean(document.querySelector('#relatorioContainer .financeiro-relatorios-estado--vazio')),
    message: document.getElementById('relatorioContainer').textContent,
    svgCount: document.querySelectorAll('#relatorioContainer svg').length
  }))()`);
  if (!errorMetrics.errorVisible || errorMetrics.emptyVisible || errorMetrics.svgCount !== 0) {
    throw new Error('Erro de API foi ocultado ou inserido como HTML.');
  }

  await windowRef.webContents.executeJavaScript(`(() => {
    window.__finUx04.override = {
      ok: true,
      status: 200,
      json: async () => ({ success: true, contas: { inesperado: true } })
    };
  })()`);
  await selecionarEGerar('receber');
  const invalidMetrics = await windowRef.webContents.executeJavaScript(`(() => ({
    errorVisible: Boolean(document.querySelector('#relatorioContainer .financeiro-relatorios-estado--erro')),
    emptyVisible: Boolean(document.querySelector('#relatorioContainer .financeiro-relatorios-estado--vazio')),
    message: document.getElementById('relatorioContainer').textContent
  }))()`);
  if (!invalidMetrics.errorVisible || invalidMetrics.emptyVisible
      || !invalidMetrics.message.includes('formato esperado')) {
    throw new Error('Payload inválido foi tratado como ausência de resultados.');
  }

  await windowRef.webContents.executeJavaScript(`(() => {
    const payload = '<img src=x onerror="globalThis.__finUx04Xss=true">';
    const response = JSON.parse(JSON.stringify(${JSON.stringify(fixture)}));
    response.contas = [{
      ...response.contas[0],
      cliente: payload,
      descricao: payload,
      documento: payload,
      status: payload,
      origem: payload
    }];
    window.__finUx04.responses['/api/financeiro/relatorios/receber'] = response;
    window.__finUx04.override = null;
    window.__finUx04Xss = false;
  })()`);
  await selecionarEGerar('receber');
  const securityMetrics = await windowRef.webContents.executeJavaScript(`(() => ({
    text: document.getElementById('relatorioContainer').textContent,
    injectedElements: document.querySelectorAll('#relatorioContainer img, #relatorioContainer svg, #relatorioContainer iframe').length,
    inlineHandlers: document.querySelectorAll('#relatorioContainer [onerror], #relatorioContainer [onclick]').length,
    xssRan: window.__finUx04Xss
  }))()`);
  if (!securityMetrics.text.includes('<img src=x onerror=') || securityMetrics.injectedElements
      || securityMetrics.inlineHandlers || securityMetrics.xssRan) {
    throw new Error('Dados não confiáveis foram executados ou interpretados como HTML.');
  }
  await windowRef.webContents.executeJavaScript(`(() => {
    const payload = '<img src=x onerror="globalThis.__finUx04Xss=true">';
    const response = JSON.parse(JSON.stringify(
      ${JSON.stringify(reportResponses['/api/contas-pagar/reconciliacao-historica/dry-run'])}
    ));
    response.empresa_id = payload;
    response.itens[0] = {
      ...response.itens[0],
      financeiro_id: payload,
      descricao: payload,
      status_legado: payload,
      acao_sugerida: payload,
      confianca: payload,
      candidato_mcf: { conta_pagar_id: payload },
      justificativa: payload
    };
    window.__finUx04.responses['/api/contas-pagar/reconciliacao-historica/dry-run'] = response;
    window.__finUx04Xss = false;
  })()`);
  await selecionarEGerar('dry_run_historico');
  const dryRunSecurityMetrics = await windowRef.webContents.executeJavaScript(`(() => ({
    text: document.getElementById('relatorioContainer').textContent,
    injectedElements: document.querySelectorAll('#relatorioContainer img, #relatorioContainer svg, #relatorioContainer iframe').length,
    inlineHandlers: document.querySelectorAll('#relatorioContainer [onerror], #relatorioContainer [onclick]').length,
    xssRan: window.__finUx04Xss
  }))()`);
  if (!dryRunSecurityMetrics.text.includes('<img src=x onerror=') || dryRunSecurityMetrics.injectedElements
      || dryRunSecurityMetrics.inlineHandlers || dryRunSecurityMetrics.xssRan) {
    throw new Error('Dados do dry-run foram executados ou interpretados como HTML.');
  }

  await windowRef.webContents.executeJavaScript(`(() => {
    window.__finUx04.alertMessage = null;
    document.getElementById('btnExportarRelatorio').click();
  })()`);
  const exportMessage = await windowRef.webContents.executeJavaScript('window.__finUx04.alertMessage');
  if (!exportMessage || !exportMessage.includes('em desenvolvimento')) {
    throw new Error('A ação de exportação existente não foi preservada.');
  }

  windowRef.show();
  await wait(300);
  const responsive = [];
  for (const [width, height] of [[1440, 900], [1024, 768], [768, 768]]) {
    windowRef.setSize(width, height);
    await wait(300);
    const metrics = await windowRef.webContents.executeJavaScript(`(() => ({
      viewport: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      tableViewport: document.querySelector('.financeiro-relatorios-tabela-scroll')?.clientWidth || 0,
      tableContent: document.querySelector('.financeiro-relatorios-tabela-scroll')?.scrollWidth || 0
    }))()`);
    const windowSize = windowRef.getSize();
    if (windowSize[0] !== width) {
      throw new Error(`O Electron não aplicou a largura solicitada de ${width}px.`);
    }
    if (Math.abs(metrics.viewport - (width - 14)) > 2) {
      throw new Error(`O viewport do Electron não refletiu a largura de ${width}px.`);
    }
    if (metrics.documentWidth > metrics.viewport) {
      throw new Error(`Overflow horizontal no viewport de ${width}px.`);
    }
    responsive.push({ requested: width, windowSize, ...metrics });
  }
  console.log(JSON.stringify({
    beforeSize,
    afterSize,
    emptySize,
    initial,
    receberMetrics,
    receberFiltroMetrics,
    summaryMetrics,
    fluxoMetrics,
    pagarMetrics,
    inadMetrics,
    dryRunMetrics,
    requestUrls: requests.map(request => request.url),
    contextHeaders: requests.map(request => request.headers['X-Empresa-Id']),
    loadingMetrics,
    emptyState,
    errorMetrics,
    invalidMetrics,
    securityMetrics,
    dryRunSecurityMetrics,
    exportMessage,
    responsive
  }, null, 2));
}

async function main() {
  await app.whenReady();
  await startServer();
  windowRef = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false
    }
  });
  windowRef.webContents.on('console-message', (_event, level, message, line, source) => {
    console.log(`[renderer:${level}] ${source}:${line} ${message}`);
  });
  windowRef.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`Renderer failed to load ${url}: ${code} ${description}`);
  });
  await windowRef.loadURL(`${baseUrl}/__fin_ux_04_preview_blank`);
  await runPreviewChecks();
  windowRef.destroy();
  server.close();
  app.quit();
}

main().catch(error => {
  console.error(error);
  if (windowRef && !windowRef.isDestroyed()) windowRef.destroy();
  if (server) server.close();
  app.quit();
  process.exitCode = 1;
});
