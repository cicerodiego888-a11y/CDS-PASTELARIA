'use strict';

/**
 * FIN-UX-07 — Preview Electron do Dashboard Financeiro.
 * API mockada com payload sintético (contrato GET /api/financeiro/dashboard).
 * Sem acesso ao banco original.
 * Executar: node_modules\.bin\electron.cmd tests\financeiro\fin-ux-07-electron-preview.js
 */

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const frontendRoot = path.join(root, 'frontend');
const reportDir = path.join(root, 'docs', 'financeiro');

const fixtureDashboard = {
  success: true,
  resumo: {
    totalRecebido: 1250.75,
    totalPago: 890.4,
    totalReceber: 640.2,
    totalPagar: 1120.55
  },
  proximos_recebimentos: [
    {
      id: 1,
      descricao: 'Recebimento sintético <b>xss</b>',
      valor: 320.1,
      dataVencimento: '2026-10-28',
      cliente: 'Cliente Alfa',
      status: 'aberto'
    },
    {
      id: 2,
      descricao: 'Parcela CR sintética',
      valor: 320.1,
      dataVencimento: '2026-11-05',
      cliente: 'Cliente Beta',
      status: 'parcial'
    }
  ],
  proximos_pagamentos: [
    {
      id: 101,
      descricao: 'Fornecedor sintético MCF',
      valor: 450.0,
      dataVencimento: '2026-10-30',
      fornecedor: 'Fornecedor Demo',
      status: 'aberto',
      fonte: 'contas_pagar'
    },
    {
      id: 102,
      descricao: 'Insumos pasta',
      valor: 200.55,
      dataVencimento: '2026-11-10',
      fornecedor: 'Mercado Central',
      status: 'parcial',
      fonte: 'contas_pagar'
    }
  ],
  alertas: [
    {
      id: 201,
      descricao: 'Título vencido a receber',
      valor: 180.0,
      dataVencimento: '2026-10-10',
      pessoa: 'Cliente Gama',
      tipo: 'receita',
      status: 'vencido'
    },
    {
      id: 202,
      descricao: 'Título MCF vencido',
      valor: 470.0,
      dataVencimento: '2026-10-05',
      pessoa: 'Fornecedor Demo',
      tipo: 'despesa',
      status: 'vencido'
    }
  ],
  grafico: {
    recebido: 1250.75,
    pago: 890.4,
    receber: 640.2,
    pagar: 1120.55
  }
};

const legacyMarkup = `
  <div class="dashboard-cards">
    <div class="dashboard-card recebido">
      <h3>Total Recebido</h3>
      <p class="valor">R$ 1.250,75</p>
    </div>
    <div class="dashboard-card pagar">
      <h3>Total Pago</h3>
      <p class="valor">R$ 890,40</p>
    </div>
    <div class="dashboard-card receber">
      <h3>Total a Receber</h3>
      <p class="valor">R$ 640,20</p>
    </div>
    <div class="dashboard-card saldo">
      <h3>Saldo do Período</h3>
      <p class="valor">R$ 360,35</p>
    </div>
  </div>
  <div class="dashboard-grid">
    <div class="dashboard-box">
      <div class="dashboard-box-header">
        <h4>Próximos Recebimentos</h4>
        <button class="btn btn-sm btn-outline-primary">Ver Todos</button>
      </div>
      <div class="dashboard-lista">
        <div class="dashboard-item"><span>Recebimento sintético</span><strong>R$ 320,10</strong></div>
      </div>
    </div>
    <div class="dashboard-box">
      <div class="dashboard-box-header">
        <h4>Próximos Pagamentos</h4>
        <button class="btn btn-sm btn-outline-primary">Ver Todos</button>
      </div>
      <div class="dashboard-lista">
        <div class="dashboard-item"><span>Fornecedor sintético MCF</span><strong>R$ 450,00</strong></div>
      </div>
    </div>
  </div>
  <div class="dashboard-box">
    <div class="dashboard-box-header"><h4>Alertas Financeiros</h4></div>
    <div class="dashboard-lista">
      <div class="dashboard-item"><span>Título vencido a receber</span><strong>R$ 180,00</strong></div>
    </div>
  </div>
  <p class="text-muted small mb-0">Legado: quatro cards (sem indicador de contas a pagar em aberto).</p>
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
      if (pathname === '/__fin_ux_07_preview_blank') {
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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function capture(fileName) {
  const image = await windowRef.webContents.capturePage();
  fs.writeFileSync(path.join(reportDir, fileName), image.toPNG());
  return image.getSize();
}

async function loadPreview() {
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
    const jq = document.createElement('script');
    jq.src = ${JSON.stringify(`${baseUrl}/vendor/jquery/jquery.min.js`)};
    await new Promise((resolve, reject) => { jq.onload = resolve; jq.onerror = reject; document.head.appendChild(jq); });
    const bs = document.createElement('script');
    bs.src = ${JSON.stringify(`${baseUrl}/vendor/bootstrap/js/bootstrap.bundle.min.js`)};
    await new Promise((resolve, reject) => { bs.onload = resolve; bs.onerror = reject; document.head.appendChild(bs); });
    const chart = document.createElement('script');
    chart.src = ${JSON.stringify(`${baseUrl}/vendor/chart.js/chart.min.js`)};
    await new Promise((resolve) => { chart.onload = resolve; chart.onerror = resolve; document.head.appendChild(chart); });
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    window.obterPeriodoFinanceiro = () => ({ dataInicio: '2026-10-01', dataFim: '2026-10-31' });
    window.abrirAbaFinanceiro = (aba) => { window.__finUx07.lastAba = aba; };
    window.headersFinanceiro = extra => Object.assign({
      Accept: 'application/json',
      'X-Empresa-Id': '7',
      Authorization: 'Bearer sintetic'
    }, extra || {});
    window.__finUx07 = {
      calls: [],
      payload: ${JSON.stringify(fixtureDashboard)},
      override: null,
      lastAba: null
    };
    window.fetch = async (url, options = {}) => {
      const state = window.__finUx07;
      const requestUrl = new URL(String(url), window.location.href);
      const method = String(options.method || 'GET').toUpperCase();
      state.calls.push({
        method,
        url: requestUrl.pathname + requestUrl.search,
        headers: options.headers || {}
      });
      if (state.override) return state.override;
      if (requestUrl.pathname === '/api/financeiro/dashboard' && method === 'GET') {
        return { ok: true, status: 200, json: async () => state.payload };
      }
      return { ok: false, status: 404, json: async () => ({ success: false, error: 'não encontrado' }) };
    };
  })()`);

  await windowRef.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '${baseUrl}/erp/js/financeiro-dashboard.js';
    script.onload = () => resolve(true);
    script.onerror = reject;
    document.head.appendChild(script);
  })`);
}

async function runPreviewChecks() {
  console.log('Running FIN-UX-07 Electron acceptance checks');
  await loadPreview();

  const antesReady = await windowRef.webContents.executeJavaScript(`(() => {
    document.querySelectorAll('.financeiro-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.aba === 'dashboard');
    });
    document.getElementById('financeiroConteudo').innerHTML = ${JSON.stringify(legacyMarkup)};
    return {
      tab: document.querySelector('.financeiro-tab.active')?.dataset?.aba || '',
      cards: document.querySelectorAll('#financeiroConteudo .dashboard-card').length,
      temKpiPagar: Boolean(document.getElementById('totalPagar')),
      cardsTexto: Array.from(document.querySelectorAll('#financeiroConteudo .dashboard-card h3')).map(el => el.textContent.trim())
    };
  })()`);
  if (antesReady.tab !== 'dashboard' || antesReady.cards !== 4 || antesReady.temKpiPagar) {
    throw new Error('Pré-captura ANTES inválida: ' + JSON.stringify(antesReady));
  }
  await wait(300);
  const beforeSize = await capture('SPRINT-FIN-UX-07-ANTES.png');
  console.log('ANTES', beforeSize, antesReady);

  await windowRef.webContents.executeJavaScript(`(() => {
    window.renderDashboardFinanceiro(window.obterPeriodoFinanceiro());
  })()`);
  await wait(500);

  const depoisReady = await windowRef.webContents.executeJavaScript(`(() => {
    const html = document.getElementById('financeiroConteudo')?.innerHTML || '';
    const call = window.__finUx07.calls.find(c => String(c.url).includes('/financeiro/dashboard'));
    const saldo = Number(1250.75) - Number(890.4);
    return {
      title: document.getElementById('financeiroDashboardTitulo')?.textContent || '',
      totalRecebido: document.getElementById('totalRecebido')?.textContent || '',
      totalPago: document.getElementById('totalPago')?.textContent || '',
      totalReceber: document.getElementById('totalReceber')?.textContent || '',
      totalPagar: document.getElementById('totalPagar')?.textContent || '',
      saldoPeriodo: document.getElementById('saldoPeriodo')?.textContent || '',
      saldoEsperado: saldo,
      escaped: !html.includes('<b>xss</b>') && html.includes('&lt;b&gt;xss&lt;/b&gt;'),
      hasEmpresa: Boolean(call?.headers?.['X-Empresa-Id']),
      listUrl: call?.url || '',
      receberCount: document.querySelectorAll('#proximosRecebimentos .financeiro-dashboard-item').length,
      pagarCount: document.querySelectorAll('#proximosPagamentos .financeiro-dashboard-item').length,
      alertasCount: document.querySelectorAll('#listaAlertas .financeiro-dashboard-alerta').length,
      blocoReceber: Boolean(document.querySelector('.financeiro-dashboard-bloco--receber')),
      blocoPagar: Boolean(document.querySelector('.financeiro-dashboard-bloco--pagar')),
      dataBr: /28\\/10\\/2026/.test(html),
      conteudoVisivel: document.getElementById('dashboardFinConteudo')?.hidden === false
    };
  })()`);

  if (depoisReady.title !== 'Dashboard Financeiro') {
    throw new Error('Título inválido: ' + JSON.stringify(depoisReady));
  }
  const normMoney = (s) => String(s || '').replace(/\u00a0/g, ' ').replace(/\s/g, ' ').trim();
  if (!normMoney(depoisReady.totalRecebido).includes('1.250,75')) {
    throw new Error('totalRecebido inválido: ' + depoisReady.totalRecebido);
  }
  if (!normMoney(depoisReady.totalPago).includes('890,40')) {
    throw new Error('totalPago inválido: ' + depoisReady.totalPago);
  }
  if (!normMoney(depoisReady.totalReceber).includes('640,20')) {
    throw new Error('totalReceber inválido: ' + depoisReady.totalReceber);
  }
  if (!normMoney(depoisReady.totalPagar).includes('1.120,55')) {
    throw new Error('totalPagar inválido: ' + depoisReady.totalPagar);
  }
  if (!normMoney(depoisReady.saldoPeriodo).includes('360,35')) {
    throw new Error('saldoPeriodo inválido (recebido−pago): ' + depoisReady.saldoPeriodo);
  }
  if (!depoisReady.escaped) throw new Error('XSS não escapado na lista');
  if (!depoisReady.hasEmpresa) throw new Error('X-Empresa-Id ausente');
  if (!String(depoisReady.listUrl).includes('dataInicio=') || !String(depoisReady.listUrl).includes('dataFim=')) {
    throw new Error('Query sem período: ' + depoisReady.listUrl);
  }
  if (depoisReady.receberCount !== 2 || depoisReady.pagarCount !== 2 || depoisReady.alertasCount !== 2) {
    throw new Error('Listas inválidas: ' + JSON.stringify(depoisReady));
  }
  if (!depoisReady.blocoReceber || !depoisReady.blocoPagar) {
    throw new Error('Separação visual AR/AP ausente');
  }
  if (!depoisReady.dataBr) throw new Error('Data BR ausente nos próximos recebimentos');
  if (!depoisReady.conteudoVisivel) throw new Error('Conteúdo do dashboard oculto após carga');

  const depoisSize = await capture('SPRINT-FIN-UX-07-DEPOIS.png');
  console.log('DEPOIS', depoisSize, depoisReady);

  // Estado vazio (listas sem itens; KPIs zerados)
  await windowRef.webContents.executeJavaScript(`(() => {
    window.__finUx07.payload = {
      success: true,
      resumo: { totalRecebido: 0, totalPago: 0, totalReceber: 0, totalPagar: 0 },
      proximos_recebimentos: [],
      proximos_pagamentos: [],
      alertas: [],
      grafico: { recebido: 0, pago: 0, receber: 0, pagar: 0 }
    };
    window.renderDashboardFinanceiro(window.obterPeriodoFinanceiro());
  })()`);
  await wait(400);
  const emptySize = await capture('SPRINT-FIN-UX-07-ESTADO-VAZIO.png');
  console.log('VAZIO', emptySize);
  const emptyOk = await windowRef.webContents.executeJavaScript(`(() => {
    const vazias = Array.from(document.querySelectorAll('.financeiro-dashboard-lista-vazia')).map(el => el.textContent.trim());
    return {
      vazias,
      totalPagar: document.getElementById('totalPagar')?.textContent || '',
      conteudoVisivel: document.getElementById('dashboardFinConteudo')?.hidden === false
    };
  })()`);
  if (!emptyOk.conteudoVisivel || emptyOk.vazias.length < 3) {
    throw new Error('Estado vazio inválido: ' + JSON.stringify(emptyOk));
  }
  if (!/Nenhum recebimento|Nenhum pagamento|Nenhum alerta/i.test(emptyOk.vazias.join(' | '))) {
    throw new Error('Mensagens de lista vazia ausentes: ' + JSON.stringify(emptyOk));
  }

  // Erro
  await windowRef.webContents.executeJavaScript(`(() => {
    window.__finUx07.override = {
      ok: false,
      status: 500,
      json: async () => ({ success: false, error: 'Falha sintética <img src=x onerror=alert(1)>' })
    };
    window.renderDashboardFinanceiro(window.obterPeriodoFinanceiro());
  })()`);
  await wait(350);
  const erroOk = await windowRef.webContents.executeJavaScript(`(() => {
    const el = document.getElementById('dashboardFinEstado');
    return {
      isErro: el?.classList.contains('financeiro-dashboard-estado--erro'),
      text: el?.textContent || '',
      semTag: !(el?.innerHTML || '').includes('<img'),
      conteudoHidden: document.getElementById('dashboardFinConteudo')?.hidden === true
    };
  })()`);
  if (!erroOk.isErro || !erroOk.semTag || !erroOk.conteudoHidden || !/Falha sintética/i.test(erroOk.text)) {
    throw new Error('Estado de erro inválido: ' + JSON.stringify(erroOk));
  }

  // Empresa obrigatória (400)
  await windowRef.webContents.executeJavaScript(`(() => {
    window.__finUx07.override = {
      ok: false,
      status: 400,
      json: async () => ({ success: false, error: 'X-Empresa-Id obrigatório' })
    };
    window.renderDashboardFinanceiro(window.obterPeriodoFinanceiro());
  })()`);
  await wait(300);
  const empOk = await windowRef.webContents.executeJavaScript(`(() => {
    const el = document.getElementById('dashboardFinEstado');
    return {
      isErro: el?.classList.contains('financeiro-dashboard-estado--erro'),
      text: el?.textContent || ''
    };
  })()`);
  if (!empOk.isErro || !/X-Empresa-Id|empresa/i.test(empOk.text)) {
    throw new Error('Erro de empresa inválido: ' + JSON.stringify(empOk));
  }

  // Responsividade com dados sintéticos
  await windowRef.webContents.executeJavaScript(`(() => {
    window.__finUx07.override = null;
    window.__finUx07.payload = ${JSON.stringify(fixtureDashboard)};
    window.renderDashboardFinanceiro(window.obterPeriodoFinanceiro());
  })()`);
  await wait(450);
  // Emula viewports via CDP (media queries reais; evita DPI Windows no setContentSize).
  const viewports = [
    { w: 1440, h: 900 },
    { w: 1024, h: 768 },
    { w: 768, h: 900 }
  ];
  const responsive = [];
  const dbg = windowRef.webContents.debugger;
  if (!dbg.isAttached()) dbg.attach('1.3');
  for (const vp of viewports) {
    await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: vp.w,
      height: vp.h,
      deviceScaleFactor: 1,
      mobile: false
    });
    await wait(250);
    const metrics = await windowRef.webContents.executeJavaScript(`(() => {
      const kpis = getComputedStyle(document.querySelector('.financeiro-dashboard-indicadores') || document.body).gridTemplateColumns;
      const blocos = getComputedStyle(document.querySelector('.financeiro-dashboard-blocos') || document.body).gridTemplateColumns;
      return {
        requested: ${vp.w},
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        kpiTracks: String(kpis).trim().split(/\\s+/).filter(Boolean).length,
        blocoTracks: String(blocos).trim().split(/\\s+/).filter(Boolean).length
      };
    })()`);
    responsive.push(metrics);
    if (metrics.scrollWidth > metrics.innerWidth + 24) {
      throw new Error('Overflow horizontal em ' + vp.w + ': ' + JSON.stringify(metrics));
    }
    if (vp.w === 1440 && metrics.kpiTracks < 5) {
      throw new Error('KPIs sem 5 colunas em 1440: ' + JSON.stringify(metrics));
    }
    if (vp.w === 1024 && (metrics.kpiTracks > 3 || metrics.blocoTracks !== 1)) {
      throw new Error('Layout 1024 inválido: ' + JSON.stringify(metrics));
    }
    if (vp.w === 768 && metrics.kpiTracks !== 1) {
      throw new Error('Layout 768 inválido: ' + JSON.stringify(metrics));
    }
  }
  console.log('Responsive metrics', JSON.stringify(responsive));

  await dbg.sendCommand('Emulation.clearDeviceMetricsOverride');
  await windowRef.setContentSize(1440, 900);
  await windowRef.webContents.executeJavaScript(`(() => {
    window.renderDashboardFinanceiro(window.obterPeriodoFinanceiro());
  })()`);
  await wait(450);
  await capture('SPRINT-FIN-UX-07-DEPOIS.png');
  console.log('FIN-UX-07 checks aprovados');
}

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(reportDir, { recursive: true });
    await startServer();
    windowRef = new BrowserWindow({
      width: 1440,
      height: 900,
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    });
    await windowRef.loadURL(`${baseUrl}/__fin_ux_07_preview_blank`);
    await runPreviewChecks();
    await windowRef.close();
    await new Promise((resolve) => server.close(resolve));
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
