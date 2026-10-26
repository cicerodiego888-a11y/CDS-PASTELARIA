'use strict';

const { app, BrowserWindow } = require('electron');
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const frontendRoot = path.join(root, 'frontend');
const reportDir = path.join(root, 'docs', 'financeiro');
const fixture = {
  success: true,
  contas: [
    {
      id: 201,
      empresa_id: 1,
      descricao: 'Compra de farinha',
      pessoa_nome: 'Fornecedor demonstração A',
      fornecedor_nome: 'Fornecedor demonstração A',
      documento: 'MCF-TST-001',
      categoria: 'Insumos',
      origem: 'compra',
      data_emissao: '2026-10-10',
      data_vencimento: '2026-10-30',
      valor_original: 500,
      valor_restante: 350,
      status: 'parcial'
    },
    {
      id: 202,
      empresa_id: 1,
      descricao: 'Serviço de manutenção',
      pessoa_nome: 'Fornecedor demonstração B',
      fornecedor_nome: 'Fornecedor demonstração B',
      documento: 'MCF-TST-002',
      categoria: 'Serviços',
      origem: 'manual',
      data_emissao: '2026-10-01',
      data_vencimento: '2026-10-20',
      valor_original: 250,
      valor_restante: 250,
      status: 'aberto'
    },
    {
      id: 203,
      empresa_id: 1,
      descricao: 'Embalagens',
      pessoa_nome: 'Fornecedor demonstração C',
      fornecedor_nome: 'Fornecedor demonstração C',
      documento: 'MCF-TST-003',
      categoria: 'Insumos',
      origem: 'compra',
      data_emissao: '2026-10-02',
      data_vencimento: '2026-10-18',
      valor_original: 125,
      valor_restante: 0,
      status: 'quitada'
    },
    {
      id: 204,
      empresa_id: 1,
      descricao: 'Título cancelado de teste',
      pessoa_nome: 'Fornecedor demonstração D',
      fornecedor_nome: 'Fornecedor demonstração D',
      documento: 'MCF-TST-004',
      categoria: 'Outros',
      origem: 'manual',
      data_emissao: '2026-10-03',
      data_vencimento: '2026-10-25',
      valor_original: 90,
      valor_restante: 0,
      status: 'cancelada'
    }
  ]
};

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
    script.src = '${baseUrl}/erp/js/financeiro-pagar.js';
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  })`);
}

function configureMocks() {
  return windowRef.webContents.executeJavaScript(`(() => {
    window.CdsEmpresaContexto = {
      headersAuth: extra => Object.assign({ 'X-Empresa-Id': 'empresa-sintetica' }, extra || {})
    };
    window.obterPeriodoFinanceiro = () => ({ dataInicio: '2026-10-01', dataFim: '2026-10-31' });
    window.podeAdministrarFinanceiro = () => true;
    window.alert = message => { window.__lastAlert = message; };
    window.prompt = () => 'Motivo sintético de homologação';
    window.confirm = () => true;
    window.bootstrap = {
      Modal: class {
        show() { this.visible = true; }
        hide() { this.visible = false; }
      }
    };
    window.__finUx02State = {
      fixture: ${JSON.stringify(fixture)},
      calls: [],
      nextList: null,
      responseOverride: null
    };
    window.fetch = async (url, options = {}) => {
      const state = window.__finUx02State;
      const request = {
        url: String(url),
        method: options.method || 'GET',
        headers: options.headers || {},
        body: options.body || null
      };
      state.calls.push(request);
      if (state.nextList) {
        const next = state.nextList;
        state.nextList = null;
        return next;
      }
      if (state.responseOverride) return state.responseOverride;
      if (request.url.includes('/api/contas-pagar?')) {
        return { ok: true, status: 200, json: async () => state.fixture };
      }
      if (request.url.includes('/api/contas-pagar/') && request.url.endsWith('/detalhes')) {
        const id = Number(request.url.split('/')[3]);
        const conta = state.fixture.contas.find(item => item.id === id);
        return { ok: true, status: 200, json: async () => Object.assign({ success: true }, conta) };
      }
      if (
        request.url.includes('/api/contas-pagar/')
        && (request.url.endsWith('/baixar') || request.url.endsWith('/cancelar'))
      ) {
        const id = Number(request.url.split('/')[3]);
        const conta = state.fixture.contas.find(item => item.id === id);
        if (request.url.endsWith('/baixar') && conta) {
          const body = JSON.parse(request.body || '{}');
          conta.valor_restante = Math.max(0, Number((conta.valor_restante - body.valor_pago).toFixed(2)));
          conta.status = conta.valor_restante === 0 ? 'quitada' : 'parcial';
        }
        if (request.url.endsWith('/cancelar') && conta) {
          conta.valor_restante = 0;
          conta.status = 'cancelada';
        }
        return { ok: true, status: 201, json: async () => ({ success: true, idempotente: false }) };
      }
      return { ok: false, status: 404, json: async () => ({ success: false, error: 'Rota sintética não prevista' }) };
    };
    document.querySelectorAll('.financeiro-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.aba === 'pagar');
    });
    window.renderContasPagar({ dataInicio: '2026-10-01', dataFim: '2026-10-31' });
  })()`);
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

async function runAfterValidation() {
  await loadPreview();
  await configureMocks();
  await wait(300);
  const beforeSize = readPngSize('SPRINT-FIN-UX-02-ANTES.png');
  const firstMetrics = await windowRef.webContents.executeJavaScript(`(() => ({
    tabs: document.querySelectorAll('.financeiro-tab').length,
    rows: document.querySelectorAll('#tabelaPagar tbody tr').length,
    headers: Array.from(document.querySelectorAll('#tabelaPagar thead th')).map(th => th.textContent.trim()),
    cancelButtons: document.querySelectorAll('.financeiro-pagar-acoes-linha [aria-label^="Cancelar título"]').length,
    dueDate: window.formatarDataPagar('2026-10-30'),
    request: window.__finUx02State.calls[0]
  }))()`);
  assert.strictEqual(firstMetrics.tabs, 7, 'as sete abas compartilhadas devem permanecer');
  assert.strictEqual(firstMetrics.rows, fixture.contas.length, 'deve listar os títulos sintéticos');
  assert.deepStrictEqual(firstMetrics.headers, [
    'Documento', 'Fornecedor / título', 'Vencimento', 'Valor original', 'Saldo restante', 'Status', 'Ações'
  ]);
  assert.strictEqual(firstMetrics.cancelButtons, 2, 'cancelar deve aparecer apenas para títulos ativos e admin');
  assert.strictEqual(firstMetrics.dueDate, '30/10/2026', 'datas sem horário não devem sofrer deslocamento UTC/local');
  assert.strictEqual(firstMetrics.request.headers['X-Empresa-Id'], 'empresa-sintetica');
  assert.ok(firstMetrics.request.url.includes('dataInicio=2026-10-01'));
  assert.ok(firstMetrics.request.url.includes('dataFim=2026-10-31'));

  const permissionMetrics = await windowRef.webContents.executeJavaScript(`(async () => {
    window.podeAdministrarFinanceiro = () => false;
    window.carregarContasPagar({ dataInicio: '', dataFim: '', status: 'todos', fornecedor: '' });
    await new Promise(resolve => setTimeout(resolve, 50));
    const hidden = document.querySelectorAll('.financeiro-pagar-acoes-linha [aria-label^="Cancelar título"]').length;
    window.podeAdministrarFinanceiro = () => true;
    window.carregarContasPagar({ dataInicio: '', dataFim: '', status: 'todos', fornecedor: '' });
    await new Promise(resolve => setTimeout(resolve, 50));
    return { hidden };
  })()`);
  assert.strictEqual(permissionMetrics.hidden, 0, 'cancelamento deve ser ocultado sem permissão administrativa');

  await windowRef.webContents.executeJavaScript('window.abrirDetalhesPagar(201)');
  await wait(80);
  const detailMetrics = await windowRef.webContents.executeJavaScript(`(() => ({
    text: document.getElementById('modalDetalhesFinanceiroBody').textContent,
    request: window.__finUx02State.calls.find(call => call.url.endsWith('/201/detalhes'))
  }))()`);
  assert.ok(detailMetrics.text.includes('Fornecedor demonstração A'));
  assert.ok(detailMetrics.text.includes('350,00'));
  assert.strictEqual(detailMetrics.request.headers['X-Empresa-Id'], 'empresa-sintetica');

  const filterCall = await windowRef.webContents.executeJavaScript(`(async () => {
    const status = document.getElementById('filtroStatusPagar');
    status.value = 'parcial';
    status.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 40));
    const fornecedor = document.getElementById('filtroFornecedorPagar');
    fornecedor.value = 'MCF-TST-001';
    fornecedor.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 40));
    return window.__finUx02State.calls.slice(-1)[0];
  })()`);
  assert.ok(filterCall.url.includes('status=parcial'), 'o filtro de status deve manter seu parâmetro');
  assert.ok(filterCall.url.includes('fornecedor=MCF-TST-001'), 'a busca deve preservar o parâmetro fornecedor');
  assert.strictEqual(filterCall.headers['X-Empresa-Id'], 'empresa-sintetica');

  const paymentMetrics = await windowRef.webContents.executeJavaScript(`(async () => {
    const pay = async (value) => {
      await window.pagarConta(201);
      await new Promise(resolve => setTimeout(resolve, 25));
      document.getElementById('pagamentoValor').value = String(value);
      document.getElementById('pagamentoForma').value = 'pix';
      document.getElementById('formPagamento').dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true })
      );
      await new Promise(resolve => setTimeout(resolve, 70));
    };
    await pay(150);
    const partial = window.__finUx02State.fixture.contas.find(conta => conta.id === 201);
    const partialSaldo = partial.valor_restante;
    await pay(200);
    const total = window.__finUx02State.fixture.contas.find(conta => conta.id === 201);
    return {
      partial: partialSaldo,
      total: total.valor_restante,
      requests: window.__finUx02State.calls.filter(call => call.url.endsWith('/baixar'))
    };
  })()`);
  assert.strictEqual(paymentMetrics.partial, 200, 'o pagamento parcial deve atualizar o saldo do título sintético');
  assert.strictEqual(paymentMetrics.total, 0, 'o segundo pagamento deve quitar o saldo restante');
  assert.strictEqual(paymentMetrics.requests.length, 2, 'devem ser exercitados os dois envios de baixa');
  paymentMetrics.requests.forEach((request, index) => {
    assert.strictEqual(request.method, 'POST');
    assert.strictEqual(request.headers['X-Empresa-Id'], 'empresa-sintetica');
    assert.ok(request.headers['Idempotency-Key'], 'baixas devem continuar enviando chave de idempotência');
    assert.strictEqual(JSON.parse(request.body).valor_pago, index === 0 ? 150 : 200);
  });

  await windowRef.webContents.executeJavaScript(`(() => {
    document.getElementById('filtroStatusPagar').value = 'todos';
    document.getElementById('filtroStatusPagar').dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await wait(60);
  await windowRef.webContents.executeJavaScript('window.cancelarContaPagar(202)');
  await wait(80);
  const cancellation = await windowRef.webContents.executeJavaScript(`(() => {
    const request = window.__finUx02State.calls.find(call => call.url.endsWith('/cancelar'));
    return {
      status: window.__finUx02State.fixture.contas.find(conta => conta.id === 202).status,
      request
    };
  })()`);
  assert.strictEqual(cancellation.status, 'cancelada', 'cancelamento deve continuar sendo acionado pela operação MCF');
  assert.strictEqual(cancellation.request.method, 'POST');
  assert.strictEqual(cancellation.request.headers['X-Empresa-Id'], 'empresa-sintetica');
  assert.ok(cancellation.request.headers['Idempotency-Key']);
  assert.strictEqual(JSON.parse(cancellation.request.body).motivo, 'Motivo sintético de homologação');

  await windowRef.webContents.executeJavaScript(`(() => {
    const state = window.__finUx02State;
    state.responseOverride = { ok: true, status: 200, json: async () => ({ success: true, contas: [] }) };
    window.carregarContasPagar({ dataInicio: '', dataFim: '', status: 'todos', fornecedor: '' });
  })()`);
  await wait(60);
  const emptyMetrics = await windowRef.webContents.executeJavaScript(`({
    visible: !document.getElementById('contasPagarEstadoVazio').hidden,
    tableHidden: document.getElementById('financeiroTabelaPagar').hidden
  })`);
  assert.strictEqual(emptyMetrics.visible, true);
  assert.strictEqual(emptyMetrics.tableHidden, true);
  const emptySize = await capture('SPRINT-FIN-UX-02-ESTADO-VAZIO.png');

  await windowRef.webContents.executeJavaScript(`(() => {
    const state = window.__finUx02State;
    state.responseOverride = null;
    state.nextList = new Promise(resolve => { window.__resolveFinUx02List = resolve; });
    window.carregarContasPagar({ dataInicio: '', dataFim: '', status: 'todos', fornecedor: '' });
  })()`);
  const loadingMetrics = await windowRef.webContents.executeJavaScript(`({
    visible: !document.getElementById('contasPagarStatus').hidden,
    text: document.getElementById('contasPagarStatus').textContent
  })`);
  assert.strictEqual(loadingMetrics.visible, true, 'o estado de carregamento deve ser exibido');
  assert.ok(loadingMetrics.text.includes('Carregando títulos MCF'));
  await windowRef.webContents.executeJavaScript(`window.__resolveFinUx02List({
    ok: true, status: 200, json: async () => window.__finUx02State.fixture
  })`);
  await wait(70);

  await windowRef.webContents.executeJavaScript(`(() => {
    window.__finUx02State.responseOverride = {
      ok: true, status: 200, json: async () => ({ success: false, error: 'Erro sintético' })
    };
    window.carregarContasPagar({ dataInicio: '', dataFim: '', status: 'todos', fornecedor: '' });
  })()`);
  await wait(60);
  const errorMetrics = await windowRef.webContents.executeJavaScript(`({
    visible: !document.getElementById('contasPagarStatus').hidden,
    error: document.getElementById('contasPagarStatus').classList.contains('is-error'),
    text: document.getElementById('contasPagarStatus').textContent,
    emptyVisible: !document.getElementById('contasPagarEstadoVazio').hidden
  })`);
  assert.strictEqual(errorMetrics.visible, true);
  assert.strictEqual(errorMetrics.error, true);
  assert.ok(errorMetrics.text.includes('Erro sintético'));
  assert.strictEqual(errorMetrics.emptyVisible, false, 'falha não pode parecer lista vazia');

  await windowRef.webContents.executeJavaScript(`(() => {
    window.__finUx02State.responseOverride = null;
    window.__finUx02State.fixture.contas = ${JSON.stringify(fixture.contas)};
    document.getElementById('filtroFornecedorPagar').value = '';
    document.getElementById('filtroStatusPagar').value = 'todos';
    window.carregarContasPagar({ dataInicio: '', dataFim: '', status: 'todos', fornecedor: '' });
  })()`);
  await wait(70);
  const afterSize = await capture('SPRINT-FIN-UX-02-DEPOIS.png');
  assert.deepStrictEqual(afterSize, beforeSize, 'capturas antes/depois devem ter resolução idêntica');

  const responsive = [];
  for (const [width, height] of [[1440, 900], [1024, 768], [768, 768]]) {
    windowRef.setSize(width, height);
    await wait(120);
    const metrics = await windowRef.webContents.executeJavaScript(`({
      viewport: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      tableViewport: document.querySelector('.financeiro-tabela--pagar .table-responsive').clientWidth,
      tableContent: document.querySelector('#tabelaPagar').scrollWidth
    })`);
    assert.strictEqual(metrics.documentWidth, metrics.viewport, `sem overflow horizontal global em ${width}px`);
    assert.ok(metrics.tableContent >= metrics.tableViewport, 'a tabela deve se manter dentro da área responsiva');
    responsive.push({ requested: width, ...metrics });
  }

  console.log(JSON.stringify({
    beforeSize,
    afterSize,
    emptySize,
    firstMetrics,
    permissionMetrics,
    detailMetrics,
    filterCall,
    paymentMetrics,
    cancellation,
    emptyMetrics,
    loadingMetrics,
    errorMetrics,
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
    await runAfterValidation();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (windowRef && !windowRef.isDestroyed()) windowRef.close();
    if (server) server.close();
    app.quit();
  }
});
