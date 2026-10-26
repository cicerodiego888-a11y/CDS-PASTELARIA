const { app, BrowserWindow } = require('electron');
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
let baseUrl = '';
const reportDir = path.join(root, 'docs', 'financeiro');
let previewServer = null;
let previewWindow = null;
const fixture = {
  success: true,
  contas: [
    {
      id: 101,
      cliente: 'Cliente demonstração A',
      descricao: 'Pedido balcão',
      documento: 'TST-001',
      dataVencimento: '2026-10-30',
      valor: 240,
      numero_parcela: 1,
      total_parcelas: 2,
      status: 'pendente',
      origem: 'venda'
    },
    {
      id: 102,
      cliente: 'Cliente demonstração B',
      descricao: 'Venda faturada',
      documento: 'TST-002',
      dataVencimento: '2026-11-05',
      valor: 125.5,
      numero_parcela: 2,
      total_parcelas: 3,
      status: 'parcial',
      origem: 'venda'
    }
  ]
};

function readHeadFile(file) {
  return execFileSync('git', ['show', `HEAD:${file}`], {
    cwd: root,
    encoding: 'utf8'
  });
}

function startPreviewServer() {
  const frontendRoot = path.join(root, 'frontend');
  const contentTypes = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2'
  };

  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      let pathname;
      try {
        pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      } catch (_error) {
        response.writeHead(400).end();
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
      const address = server.address();
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve(server);
    });
  });
}

async function renderPage(window, fragment, financeCss) {
  const cleanFragment = fragment.replace(/<script src="js\/financeiro-historico\.js"><\/script>/, '');
  const bodyHtml = `<main class="container-fluid py-3">${cleanFragment}</main>`;
  const cssUrls = [
    `${baseUrl}/vendor/bootstrap/css/bootstrap.min.css`,
    `${baseUrl}/vendor/fontawesome/css/all.min.css`,
    `${baseUrl}/css/style.css`,
    `${baseUrl}/shared/design-system/cds-ui-foundation.css`
  ];

  await window.webContents.executeJavaScript(`(async () => {
    document.head.innerHTML = '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">';
    document.body.innerHTML = ${JSON.stringify(bodyHtml)};
    const urls = ${JSON.stringify(cssUrls)};
    await Promise.all(urls.map(url => new Promise(resolve => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = url;
      link.onload = resolve;
      link.onerror = resolve;
      document.head.appendChild(link);
    })));
    const style = document.createElement('style');
    style.textContent = ${JSON.stringify(financeCss)};
    document.head.appendChild(style);
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
  })()`);
}

function oldReceivablesMarkup() {
  return `
    <div class="financeiro-filtros">
      <div class="financeiro-filtro-grupo">
        <label for="filtroClienteReceber">Cliente:</label>
        <input type="text" id="filtroClienteReceber" class="form-control" placeholder="Nome ou CPF do cliente">
      </div>
      <div class="financeiro-filtro-grupo">
        <label for="filtroStatusReceber">Status:</label>
        <select id="filtroStatusReceber" class="form-control">
          <option>Todas</option><option>Vencidas</option><option>A Vencer</option><option>Recebidas</option>
        </select>
      </div>
      <div class="financeiro-filtro-grupo">
        <label for="filtroDocumentoReceber">Documento:</label>
        <input type="text" id="filtroDocumentoReceber" class="form-control" placeholder="Número do documento">
      </div>
      <div class="financeiro-filtro-grupo">
        <label for="filtroDataInicioReceber">Data Início:</label>
        <input type="date" id="filtroDataInicioReceber" class="form-control" value="2026-10-01">
      </div>
      <div class="financeiro-filtro-grupo">
        <label for="filtroDataFimReceber">Data Fim:</label>
        <input type="date" id="filtroDataFimReceber" class="form-control" value="2026-10-31">
      </div>
      <div class="financeiro-acoes">
        <button class="btn btn-primary">Nova Conta a Receber</button>
        <button class="btn btn-success">Exportar PDF</button>
        <button class="btn btn-success">Exportar Excel</button>
        <button class="btn btn-secondary">Filtrar</button>
      </div>
    </div>
    <div class="financeiro-tabela">
      <table id="tabelaReceber">
        <thead><tr><th>Cliente</th><th>Descrição</th><th>Documento</th><th>Vencimento</th><th>Valor</th><th>Parcela</th><th>Status</th><th>Origem</th><th>Ações</th></tr></thead>
        <tbody>
          <tr><td>Cliente demonstração A</td><td>Pedido balcão</td><td>TST-001</td><td>30/10/2026</td><td>R$ 240,00</td><td>1 / 2</td><td>pendente</td><td>venda</td><td>✓　◉　✎　↔　×</td></tr>
          <tr><td>Cliente demonstração B</td><td>Venda faturada</td><td>TST-002</td><td>05/11/2026</td><td>R$ 125,50</td><td>2 / 3</td><td>parcial</td><td>venda</td><td>✓　◉　✎　↔　×</td></tr>
        </tbody>
      </table>
    </div>`;
}

function capture(window, fileName) {
  return window.webContents.capturePage().then((image) => {
    fs.writeFileSync(path.join(reportDir, fileName), image.toPNG());
    return image.getSize();
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

app.whenReady().then(async () => {
  try {
    previewServer = await startPreviewServer();
    previewWindow = new BrowserWindow({
      width: 1440,
      height: 900,
      show: true,
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    const window = previewWindow;
    await window.loadURL(`${baseUrl}/erp/pages/financeiro.html?electron-preview=1`);
    const previousHtml = readHeadFile('frontend/erp/pages/financeiro.html')
      .replace('class="financeiro-tab active" data-aba="dashboard"', 'class="financeiro-tab" data-aba="dashboard"')
      .replace('class="financeiro-tab" data-aba="receber"', 'class="financeiro-tab active" data-aba="receber"')
      .replace(
        '<div id="financeiroConteudo" class="financeiro-conteudo">\n    <!-- Conteúdo das abas será carregado aqui -->\n  </div>',
        `<div id="financeiroConteudo" class="financeiro-conteudo">${oldReceivablesMarkup()}</div>`
      );
    const previousCss = readHeadFile('frontend/css/financeiro.css');
    await renderPage(window, previousHtml, previousCss);
    await wait(300);
    const beforeSize = await capture(window, 'SPRINT-FIN-UX-01-ANTES.png');

    const currentHtml = fs.readFileSync(path.join(root, 'frontend', 'erp', 'pages', 'financeiro.html'), 'utf8');
    const currentCss = fs.readFileSync(path.join(root, 'frontend', 'css', 'financeiro.css'), 'utf8');
    await renderPage(window, currentHtml, currentCss);
    await wait(200);
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '${baseUrl}/erp/js/financeiro-receber.js';
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    })`);
    await window.webContents.executeJavaScript(`(() => {
      const contas = ${JSON.stringify(fixture.contas)};
      window.CdsEmpresaContexto = {
        headersAuth: extra => Object.assign({ 'X-Empresa-Id': 'empresa-sintetica' }, extra || {})
      };
      window.formatarData = value => new Date(value + 'T00:00:00').toLocaleDateString('pt-BR');
      window.formatarMoeda = value => Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
      window.obterPeriodoFinanceiro = () => ({ dataInicio: '2026-10-01', dataFim: '2026-10-31' });
      window.__finUxState = {
        response: { success: true, contas },
        calls: []
      };
      window.fetch = async (url, options) => {
        const state = window.__finUxState;
        const headers = options && options.headers;
        state.calls.push({ url: String(url), headers });
        window.__empresaTeste = headers;
        const payload = state.response || {};
        const ok = payload.ok !== false && payload.success !== false;
        const status = payload.status || (ok ? 200 : 500);
        return {
          ok,
          status,
          json: async () => payload
        };
      };
      document.querySelectorAll('.financeiro-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.aba === 'receber');
      });
      window.renderContasReceber({ dataInicio: '2026-10-01', dataFim: '2026-10-31' });
    })()`);
    await wait(300);
    const afterMetrics = await window.webContents.executeJavaScript(`({
      viewport: [window.innerWidth, window.innerHeight],
      tabs: document.querySelectorAll('.financeiro-tab').length,
      rows: document.querySelectorAll('#tabelaReceber tbody tr').length,
      actions: document.querySelectorAll('.financeiro-acoes-linha button').length,
      empresaHeader: window.__empresaTeste ? window.__empresaTeste['X-Empresa-Id'] : null
    })`);
    assert.strictEqual(afterMetrics.tabs, 7, 'deve manter as sete abas');
    assert.strictEqual(afterMetrics.rows, 2, 'deve renderizar os registros sintéticos');
    assert.strictEqual(afterMetrics.actions, 10, 'deve manter as cinco ações por registro');
    assert.strictEqual(afterMetrics.empresaHeader, 'empresa-sintetica', 'deve preservar o cabeçalho empresarial');
    const afterSize = await capture(window, 'SPRINT-FIN-UX-01-DEPOIS.png');
    assert.deepStrictEqual(afterSize, beforeSize, 'capturas antes/depois devem ter a mesma resolução');

    const filterMetrics = await window.webContents.executeJavaScript(`(async () => {
      document.querySelector('.financeiro-filtros-avancados').open = true;
      document.getElementById('filtroDocumentoReceber').value = 'TST-001';
      document.querySelector('button[onclick="filtrarReceber()"]').click();
      await new Promise(resolve => setTimeout(resolve, 50));
      const calls = window.__finUxState.calls;
      return calls[calls.length - 1];
    })()`);
    assert.ok(filterMetrics.url.includes('documento=TST-001'), 'deve enviar o filtro de documento');
    assert.ok(filterMetrics.url.includes('dataInicio=2026-10-01'), 'deve manter o início do período');
    assert.strictEqual(filterMetrics.headers['X-Empresa-Id'], 'empresa-sintetica');

    await window.webContents.executeJavaScript("window.__finUxState.response = { success: true, contas: [] }; window.preencherTabelaContasReceber([])");
    await wait(100);
    const emptyMetrics = await window.webContents.executeJavaScript(`({
      visible: !document.getElementById('contasReceberEstadoVazio').hidden,
      tableHidden: document.querySelector('.financeiro-tabela--receber').hidden
    })`);
    assert.strictEqual(emptyMetrics.visible, true, 'deve apresentar estado vazio');
    assert.strictEqual(emptyMetrics.tableHidden, true, 'deve ocultar a tabela sem resultados');
    await window.webContents.executeJavaScript("document.querySelector('.financeiro-filtros-avancados').open = false");
    const emptySize = await capture(window, 'SPRINT-FIN-UX-01-ESTADO-VAZIO.png');

    await window.webContents.executeJavaScript('window.limparFiltrosReceber()');
    await wait(100);
    const resetMetrics = await window.webContents.executeJavaScript(`(() => {
      const calls = window.__finUxState.calls;
      return {
        url: calls[calls.length - 1].url,
        documento: document.getElementById('filtroDocumentoReceber').value
      };
    })()`);
    assert.ok(resetMetrics.url.includes('documento='), 'limpar filtros deve remover o documento');
    assert.strictEqual(resetMetrics.documento, '');

    await window.webContents.executeJavaScript(`window.__finUxState.response = {
      success: false,
      ok: false,
      status: 500,
      error: 'Falha sintética'
    };
      window.carregarContasReceber({ dataInicio: '2026-10-01', dataFim: '2026-10-31' })`);
    await wait(100);
    const errorMetrics = await window.webContents.executeJavaScript(`({
      visible: !document.querySelector('.financeiro-tabela--receber').hidden,
      emptyVisible: !document.getElementById('contasReceberEstadoVazio').hidden,
      message: document.querySelector('#tabelaReceber tbody').innerText,
      dataBr: Array.from(document.querySelectorAll('#tabelaReceber tbody tr td')).some(td => /30\\/10\\/2026/.test(td.textContent || ''))
    })`);
    assert.strictEqual(errorMetrics.visible, true, 'erro de API deve manter a região da tabela');
    assert.strictEqual(errorMetrics.emptyVisible, false, 'erro não deve parecer resultado vazio');
    assert.ok(/Não foi possível carregar|Tente novamente|Falha sintética/i.test(errorMetrics.message));

    const responsive = [];
    for (const [width, height] of [[1024, 768], [768, 768]]) {
      window.setSize(width, height);
      await wait(150);
      const metrics = await window.webContents.executeJavaScript(`({
        viewport: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        filterWidth: document.querySelector('.financeiro-filtros--receber').getBoundingClientRect().width
      })`);
      assert.strictEqual(metrics.documentWidth, metrics.viewport, `não deve haver overflow global em ${width}px`);
      responsive.push(metrics);
    }

    console.log(JSON.stringify({
      beforeSize,
      afterSize,
      emptySize,
      afterMetrics,
      filterMetrics,
      emptyMetrics,
      resetMetrics,
      errorMetrics,
      responsive
    }));
  } finally {
    if (previewWindow && !previewWindow.isDestroyed()) previewWindow.destroy();
    if (previewServer) {
      await new Promise((resolve) => previewServer.close(resolve));
      previewServer = null;
    }
    app.quit();
  }
}).catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  if (previewServer) previewServer.close();
  app.exit(1);
});
