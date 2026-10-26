'use strict';

const { app, BrowserWindow } = require('electron');
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const frontendRoot = path.join(root, 'frontend');
const reportDir = path.join(root, 'docs', 'financeiro');
const fixture = [
  {
    id: 301,
    data_movimento: '2026-10-20',
    tipo: 'receita',
    descricao: 'Venda balcão #301',
    documento: 'NF-UX03-001',
    pessoa_nome: 'Cliente demonstração A',
    status: 'recebido',
    forma_pagamento: 'pix',
    valor: 200,
    referencia_tipo: 'venda',
    referencia_id: 301
  },
  {
    id: 302,
    data_movimento: '2026-10-18',
    tipo: 'despesa',
    descricao: 'Insumos de produção',
    documento: 'DOC-UX03-002',
    pessoa_nome: 'Fornecedor demonstração B',
    status: 'pago',
    forma_pagamento: 'transferencia',
    valor: 85.5,
    referencia_tipo: 'compra',
    referencia_id: 302
  },
  {
    id: 303,
    data_movimento: '2026-10-15',
    tipo: 'despesa',
    descricao: 'Despesa avulsa sem referência',
    documento: null,
    pessoa_nome: 'Fornecedor demonstração C',
    status: 'pendente',
    forma_pagamento: 'boleto',
    valor: 40,
    referencia_tipo: null,
    referencia_id: null
  }
];

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
      if (pathname === '/__fin_ux_preview_blank') {
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
  const html = fs.readFileSync(path.join(frontendRoot, 'erp', 'pages', 'financeiro.html'), 'utf8')
    .replace(/<script src="js\/financeiro-historico\.js"><\/script>/, '');
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
  })()`);
  await windowRef.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '${baseUrl}/erp/js/financeiro-historico.js';
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  })`);
}

function capture(fileName) {
  return windowRef.webContents.capturePage().then(image => {
    fs.writeFileSync(path.join(reportDir, fileName), image.toPNG());
    return image.getSize();
  });
}

function readPngSize(fileName) {
  const png = fs.readFileSync(path.join(reportDir, fileName));
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runPreviewChecks() {
  await loadPreview();
  await windowRef.webContents.executeJavaScript(`(() => {
    window.headersFinanceiro = extra => Object.assign({
      'X-Empresa-Id': 'empresa-sintetica'
    }, extra || {});
    window.abrirReferenciaFinanceira = (id, tipo) => {
      window.__finUx03State.references.push({ id, tipo });
    };
    window.__finUx03State = {
      fixture: ${JSON.stringify(fixture)},
      response: ${JSON.stringify(fixture)},
      responseOverride: null,
      nextResponse: null,
      calls: [],
      references: []
    };
    window.fetch = async (url, options = {}) => {
      const state = window.__finUx03State;
      state.calls.push({
        url: String(url),
        headers: options.headers || {}
      });
      if (state.nextResponse) {
        const next = state.nextResponse;
        state.nextResponse = null;
        return next;
      }
      if (state.responseOverride) return state.responseOverride;
      return {
        ok: true,
        status: 200,
        json: async () => state.response
      };
    };
    document.querySelectorAll('.financeiro-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.aba === 'historico');
    });
    window.renderHistoricoFinanceiro({
      dataInicio: '2026-10-01',
      dataFim: '2026-10-31'
    });
  })()`);
  await wait(250);

  const beforeSize = readPngSize('SPRINT-FIN-UX-03-ANTES.png');
  const initial = await windowRef.webContents.executeJavaScript(`(() => ({
    tabCount: document.querySelectorAll('.financeiro-tab').length,
    rowCount: document.querySelectorAll('#tabelaHistoricoFinanceiro tr').length,
    headers: Array.from(document.querySelectorAll('#tabelaHistorico thead th')).map(th => th.textContent.trim()),
    types: Array.from(document.querySelectorAll('.financeiro-historico-tipo')).map(el => el.textContent),
    references: document.querySelectorAll('.financeiro-historico-referencia').length,
    request: window.__finUx03State.calls[0]
  }))()`);
  assert.strictEqual(initial.tabCount, 7, 'as sete abas do Financeiro devem permanecer');
  assert.strictEqual(initial.rowCount, fixture.length);
  assert.deepStrictEqual(initial.headers, [
    'Data', 'Movimento', 'Descrição', 'Referência', 'Documento', 'Pessoa', 'Status', 'Forma', 'Valor'
  ]);
  assert.ok(initial.types[0].includes('Entrada'));
  assert.ok(initial.types[1].includes('Saída'));
  assert.strictEqual(initial.references, 2);
  assert.ok(initial.request.url.includes('dataInicio=2026-10-01'));
  assert.ok(initial.request.url.includes('dataFim=2026-10-31'));
  assert.strictEqual(initial.request.headers['X-Empresa-Id'], 'empresa-sintetica');

  const referenceCalls = await windowRef.webContents.executeJavaScript(`(() => {
    document.querySelectorAll('.financeiro-historico-referencia')[0].click();
    document.querySelectorAll('.financeiro-historico-referencia')[1].click();
    return window.__finUx03State.references.slice();
  })()`);
  assert.deepStrictEqual(referenceCalls, [
    { id: 301, tipo: 'venda' },
    { id: 302, tipo: 'compra' }
  ]);

  const filterMetrics = await windowRef.webContents.executeJavaScript(`(async () => {
    document.getElementById('filtroDescricao').value = 'NF-UX03-001';
    document.getElementById('filtroTipo').value = 'receita';
    document.getElementById('filtroStatus').value = 'recebido';
    document.getElementById('filtrosAvancadosHistorico').open = true;
    document.getElementById('btnFiltrarHistorico').click();
    await new Promise(resolve => setTimeout(resolve, 60));
    return window.__finUx03State.calls.slice(-1)[0];
  })()`);
  assert.ok(filterMetrics.url.includes('busca=NF-UX03-001'));
  assert.ok(filterMetrics.url.includes('tipo=receita'));
  assert.ok(filterMetrics.url.includes('status=recebido'));
  assert.strictEqual(filterMetrics.headers['X-Empresa-Id'], 'empresa-sintetica');

  const emptyMetrics = await windowRef.webContents.executeJavaScript(`(async () => {
    const state = window.__finUx03State;
    state.responseOverride = { ok: true, status: 200, json: async () => [] };
    await window.carregarHistoricoFinanceiro({ dataInicio: '2026-10-01', dataFim: '2026-10-31' });
    return {
      visible: !document.getElementById('historicoEstadoVazio').hidden,
      tableHidden: document.getElementById('historicoTabelaContainer').hidden,
      clearVisible: !document.getElementById('btnLimparFiltrosHistoricoVazio').hidden
    };
  })()`);
  assert.deepStrictEqual(emptyMetrics, { visible: true, tableHidden: true, clearVisible: true });
  const emptySize = await capture('SPRINT-FIN-UX-03-ESTADO-VAZIO.png');

  const resetMetrics = await windowRef.webContents.executeJavaScript(`(async () => {
    document.getElementById('btnLimparFiltrosHistoricoVazio').click();
    await new Promise(resolve => setTimeout(resolve, 60));
    const state = window.__finUx03State;
    const last = state.calls[state.calls.length - 1];
    return {
      busca: document.getElementById('filtroDescricao').value,
      tipo: document.getElementById('filtroTipo').value,
      status: document.getElementById('filtroStatus').value,
      advancedOpen: document.getElementById('filtrosAvancadosHistorico').open,
      url: last.url
    };
  })()`);
  assert.strictEqual(resetMetrics.busca, '');
  assert.strictEqual(resetMetrics.tipo, '');
  assert.strictEqual(resetMetrics.status, '');
  assert.strictEqual(resetMetrics.advancedOpen, false);
  assert.ok(!resetMetrics.url.includes('busca='));
  assert.ok(!resetMetrics.url.includes('tipo='));

  const loadingMetrics = await windowRef.webContents.executeJavaScript(`(() => {
    const state = window.__finUx03State;
    state.responseOverride = null;
    state.nextResponse = new Promise(resolve => { window.__resolveFinUx03 = resolve; });
    window.carregarHistoricoFinanceiro({ dataInicio: '2026-10-01', dataFim: '2026-10-31' });
    return {
      visible: !document.getElementById('historicoEstadoStatus').hidden,
      text: document.getElementById('historicoEstadoStatus').textContent
    };
  })()`);
  assert.strictEqual(loadingMetrics.visible, true);
  assert.ok(loadingMetrics.text.includes('Carregando movimentações'));
  await windowRef.webContents.executeJavaScript(`window.__resolveFinUx03({
    ok: true, status: 200, json: async () => window.__finUx03State.fixture
  })`);
  await wait(60);

  const errorMetrics = await windowRef.webContents.executeJavaScript(`(async () => {
    const state = window.__finUx03State;
    state.responseOverride = {
      ok: false, status: 500, json: async () => ({ error: '<svg onload=alert(1)>' })
    };
    await window.carregarHistoricoFinanceiro({ dataInicio: '2026-10-01', dataFim: '2026-10-31' });
    return {
      visible: !document.getElementById('historicoEstadoStatus').hidden,
      emptyVisible: !document.getElementById('historicoEstadoVazio').hidden,
      message: document.getElementById('historicoEstadoStatus').textContent,
      insertedSvg: document.querySelectorAll('#historicoEstadoStatus svg').length
    };
  })()`);
  assert.strictEqual(errorMetrics.visible, true);
  assert.strictEqual(errorMetrics.emptyVisible, false);
  assert.ok(errorMetrics.message.includes('<svg onload=alert(1)>'));
  assert.strictEqual(errorMetrics.insertedSvg, 0);

  const invalidShapeMetrics = await windowRef.webContents.executeJavaScript(`(async () => {
    const state = window.__finUx03State;
    state.responseOverride = {
      ok: true, status: 200, json: async () => ({ success: true, rows: [] })
    };
    await window.carregarHistoricoFinanceiro({ dataInicio: '2026-10-01', dataFim: '2026-10-31' });
    return {
      errorVisible: !document.getElementById('historicoEstadoStatus').hidden,
      emptyVisible: !document.getElementById('historicoEstadoVazio').hidden,
      message: document.getElementById('historicoEstadoStatus').textContent
    };
  })()`);
  assert.strictEqual(invalidShapeMetrics.errorVisible, true);
  assert.strictEqual(invalidShapeMetrics.emptyVisible, false);
  assert.ok(invalidShapeMetrics.message.includes('formato esperado'));

  const malicious = '<img src=x onerror="globalThis.__finUx03Xss=true">';
  const securityMetrics = await windowRef.webContents.executeJavaScript(`(async () => {
    const malicious = ${JSON.stringify(malicious)};
    const state = window.__finUx03State;
    state.responseOverride = null;
    state.response = [{
      data_movimento: '2026-10-25',
      tipo: malicious,
      descricao: malicious,
      documento: malicious,
      pessoa_nome: malicious,
      status: malicious,
      forma_pagamento: malicious,
      referencia_tipo: malicious,
      referencia_id: '1);alert(1)//',
      valor: 10
    }];
    await window.carregarHistoricoFinanceiro({ dataInicio: '2026-10-01', dataFim: '2026-10-31' });
    const row = document.querySelector('#tabelaHistoricoFinanceiro tr');
    return {
      cells: Array.from(row.children).map(cell => cell.textContent),
      htmlElements: row.querySelectorAll('img, svg, script').length,
      inlineHandlers: row.querySelectorAll('[onclick], [onerror]').length,
      referenceActions: row.querySelectorAll('.financeiro-historico-referencia').length,
      xssRan: window.__finUx03Xss === true
    };
  })()`);
  assert.ok(securityMetrics.cells[1].includes(malicious));
  assert.strictEqual(securityMetrics.cells[2], malicious);
  assert.ok(securityMetrics.cells[3].includes(malicious));
  assert.strictEqual(securityMetrics.cells[4], malicious);
  assert.strictEqual(securityMetrics.cells[5], malicious);
  assert.strictEqual(securityMetrics.cells[6], malicious);
  assert.strictEqual(securityMetrics.cells[7], malicious);
  assert.strictEqual(securityMetrics.htmlElements, 0);
  assert.strictEqual(securityMetrics.inlineHandlers, 0);
  assert.strictEqual(securityMetrics.referenceActions, 0);
  assert.strictEqual(securityMetrics.xssRan, false);

  const afterMetrics = await windowRef.webContents.executeJavaScript(`(async () => {
    const state = window.__finUx03State;
    state.response = state.fixture;
    state.responseOverride = null;
    await window.limparFiltrosHistorico({
      dataInicio: '2026-10-01',
      dataFim: '2026-10-31'
    });
    return {
      rows: document.querySelectorAll('#tabelaHistoricoFinanceiro tr').length,
      search: document.getElementById('filtroDescricao').value,
      type: document.getElementById('filtroTipo').value,
      status: document.getElementById('filtroStatus').value
    };
  })()`);
  assert.strictEqual(afterMetrics.rows, fixture.length);
  assert.strictEqual(afterMetrics.search, '');
  assert.strictEqual(afterMetrics.type, '');
  assert.strictEqual(afterMetrics.status, '');

  const afterSize = await capture('SPRINT-FIN-UX-03-DEPOIS.png');
  assert.deepStrictEqual(afterSize, beforeSize, 'capturas comparativas devem ter a mesma resolução');

  const responsive = [];
  for (const [width, height] of [[1440, 900], [1024, 768], [768, 768]]) {
    windowRef.setSize(width, height);
    await wait(300);
    const metrics = await windowRef.webContents.executeJavaScript(`({
      viewport: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      tableViewport: document.querySelector('.financeiro-tabela--historico .table-responsive').clientWidth,
      tableContent: document.querySelector('#tabelaHistorico').scrollWidth
    })`);
    const windowSize = windowRef.getSize();
    assert.ok(Math.abs(metrics.viewport - (width - 14)) <= 2, `Electron viewport deve refletir janela ${width}px`);
    assert.strictEqual(metrics.documentWidth, metrics.viewport, `sem overflow global em ${width}px`);
    assert.ok(metrics.tableContent >= metrics.tableViewport, 'tabela deve rolar dentro da própria área');
    responsive.push({ requested: width, windowSize, ...metrics });
  }

  console.log(JSON.stringify({
    beforeSize,
    afterSize,
    emptySize,
    initial,
    referenceCalls,
    filterMetrics,
    emptyMetrics,
    resetMetrics,
    loadingMetrics,
    errorMetrics,
    invalidShapeMetrics,
    securityMetrics,
    responsive
  }));
}

app.whenReady().then(async () => {
  try {
    await startServer();
    windowRef = new BrowserWindow({
      width: 1440,
      height: 900,
      show: true,
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    });
    windowRef.webContents.on('console-message', (_event, level, message, line, source) => {
      console.error(`[renderer:${level}] ${source}:${line} ${message}`);
    });
    await windowRef.loadURL(`${baseUrl}/__fin_ux_preview_blank`);
    await runPreviewChecks();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (windowRef && !windowRef.isDestroyed()) windowRef.close();
    if (server) server.close();
    app.quit();
  }
});
