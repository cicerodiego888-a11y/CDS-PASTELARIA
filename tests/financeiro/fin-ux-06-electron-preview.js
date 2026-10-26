'use strict';

/**
 * FIN-UX-06 — Preview Electron da aba Dívidas por Cliente.
 * Fonte simulada: contas_receber agrupado. Sem acesso ao banco original.
 * Executar: node_modules\.bin\electron.cmd tests\financeiro\fin-ux-06-electron-preview.js
 */

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const frontendRoot = path.join(root, 'frontend');
const reportDir = path.join(root, 'docs', 'financeiro');

const fixtureClientes = [
  {
    cliente_id: 11,
    nome_cliente: 'Cliente Alfa <b>xss</b>',
    cpf: '123.456.789-00',
    telefone: '(11) 90000-0001',
    quantidade_vendas: 2,
    quantidade_titulos: 3,
    total_divida: 450.5,
    total_pago: 0,
    saldo_atual: 450.5,
    vencidas: 1,
    a_vencer: 2
  },
  {
    cliente_id: 12,
    nome_cliente: 'Cliente Beta',
    cpf: '987.654.321-00',
    telefone: '(11) 90000-0002',
    quantidade_vendas: 1,
    quantidade_titulos: 1,
    total_divida: 80,
    total_pago: 0,
    saldo_atual: 80,
    vencidas: 0,
    a_vencer: 1
  }
];

const fixtureDetalhe = {
  success: true,
  cliente: {
    id: 11,
    nome: 'Cliente Alfa',
    cpf: '123.456.789-00',
    telefone: '(11) 90000-0001',
    endereco: 'Rua Sintética, 100'
  },
  resumo: {
    totalDivida: 500,
    totalPago: 49.5,
    saldoAtual: 450.5,
    quantidadeVendas: 1,
    quantidadeTitulos: 2,
    vencidas: 1,
    aVencer: 1
  },
  vendas: [{
    venda_id: 201,
    numero_venda: 'V-201',
    data_venda: '2026-10-01',
    data_vencimento: '2026-10-20',
    valor_total: 500,
    valor_pago: 49.5,
    saldo_aberto: 450.5,
    status: 'parcial',
    produtos: [{
      nome_produto: 'Produto demo',
      quantidade: 2,
      preco_unitario: 250,
      subtotal: 500
    }],
    parcelas: [{
      parcela: '1 / 2',
      componente: 'produtos',
      valor_parcela: 250,
      valor_restante: 200.5,
      vencimento: '2026-10-20',
      status: 'parcial'
    }, {
      parcela: '2 / 2',
      componente: 'produtos',
      valor_parcela: 250,
      valor_restante: 250,
      vencimento: '2026-11-20',
      status: 'aberto'
    }]
  }]
};

const legacyMarkup = `
  <div class="financeiro-filtros">
    <div class="financeiro-filtro-grupo">
      <label>Cliente:</label>
      <input type="text" class="form-control" value="" placeholder="Nome, CPF ou telefone" />
    </div>
    <div class="financeiro-filtro-grupo">
      <label>Status:</label>
      <select class="form-control"><option>Todas</option></select>
    </div>
    <div class="financeiro-acoes">
      <button class="btn btn-primary"><i class="fas fa-filter"></i> Filtrar</button>
    </div>
  </div>
  <div class="financeiro-tabela">
    <table>
      <thead>
        <tr>
          <th>Cliente</th><th>CPF / Telefone</th><th>Vendas</th><th>Títulos</th>
          <th>Total em Aberto</th><th>Vencidas</th><th>A Vencer</th><th>Ações</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Cliente Alfa</td><td>123.456.789-00<br>(11) 90000-0001</td>
          <td>2</td><td>3</td><td class="font-weight-bold">R$ 450,50</td>
          <td>1</td><td>2</td>
          <td><button class="btn btn-sm btn-primary">Ver Duplicata</button></td>
        </tr>
        <tr>
          <td>Cliente Beta</td><td>987.654.321-00<br>(11) 90000-0002</td>
          <td>1</td><td>1</td><td class="font-weight-bold">R$ 80,00</td>
          <td>0</td><td>1</td>
          <td><button class="btn btn-sm btn-primary">Ver Duplicata</button></td>
        </tr>
      </tbody>
    </table>
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
      if (pathname === '/__fin_ux_06_preview_blank') {
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
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    window.obterPeriodoFinanceiro = () => ({ dataInicio: '2026-10-01', dataFim: '2026-10-31' });
    window.headersFinanceiro = extra => Object.assign({
      Accept: 'application/json',
      'X-Empresa-Id': '7',
      Authorization: 'Bearer sintetic'
    }, extra || {});
    window.__finUx06 = {
      calls: [],
      clientes: ${JSON.stringify(fixtureClientes)},
      detalhe: ${JSON.stringify(fixtureDetalhe)},
      override: null
    };
    window.fetch = async (url, options = {}) => {
      const state = window.__finUx06;
      const requestUrl = new URL(String(url), window.location.href);
      const method = String(options.method || 'GET').toUpperCase();
      state.calls.push({
        method,
        url: requestUrl.pathname + requestUrl.search,
        headers: options.headers || {}
      });
      if (state.override) return state.override;
      if (requestUrl.pathname === '/api/financeiro/receber/agrupado' && method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ success: true, clientes: state.clientes }) };
      }
      const det = requestUrl.pathname.match(/^\\/api\\/financeiro\\/receber\\/agrupado\\/(\\d+)$/);
      if (det && method === 'GET') {
        return { ok: true, status: 200, json: async () => state.detalhe };
      }
      if (/\\/extrato$/.test(requestUrl.pathname)) {
        return {
          ok: true,
          status: 200,
          json: async () => Object.assign({}, state.detalhe, {
            empresa: { nome: 'Empresa Sintética', cnpj: '11.222.333/0001-81' },
            geradoEm: '26/10/2026'
          })
        };
      }
      return { ok: false, status: 404, json: async () => ({ success: false, error: 'não encontrado' }) };
    };
  })()`);

  await windowRef.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '${baseUrl}/erp/js/financeiro-receber.js';
    script.onload = () => resolve(true);
    script.onerror = reject;
    document.head.appendChild(script);
  })`);
}

async function runPreviewChecks() {
  console.log('Running FIN-UX-06 Electron acceptance checks');
  await loadPreview();

  const antesReady = await windowRef.webContents.executeJavaScript(`(() => {
    document.querySelectorAll('.financeiro-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.aba === 'duplicata');
    });
    document.getElementById('financeiroConteudo').innerHTML = ${JSON.stringify(legacyMarkup)};
    return {
      tab: document.querySelector('.financeiro-tab.active')?.dataset?.aba || '',
      rows: document.querySelectorAll('#financeiroConteudo table tbody tr').length
    };
  })()`);
  if (antesReady.tab !== 'duplicata' || antesReady.rows < 2) {
    throw new Error('Pré-captura ANTES inválida: ' + JSON.stringify(antesReady));
  }
  await wait(300);
  const beforeSize = await capture('SPRINT-FIN-UX-06-ANTES.png');
  console.log('ANTES', beforeSize, antesReady);

  await windowRef.webContents.executeJavaScript(`(() => {
    window.renderDuplicataClientes(window.obterPeriodoFinanceiro());
  })()`);
  await wait(400);

  const depoisReady = await windowRef.webContents.executeJavaScript(`(() => {
    const rows = document.querySelectorAll('#tabelaDuplicataClientes tbody tr');
    const html = document.getElementById('financeiroConteudo')?.innerHTML || '';
    const firstCall = window.__finUx06.calls.find(c => String(c.url).includes('/receber/agrupado'));
    return {
      title: document.getElementById('financeiroDuplicataTitulo')?.textContent || '',
      rows: rows.length,
      escaped: !html.includes('<b>xss</b>') && html.includes('&lt;b&gt;xss&lt;/b&gt;'),
      hasEmpresa: Boolean(firstCall?.headers?.['X-Empresa-Id']),
      listUrl: firstCall?.url || '',
      totalCell: rows[0]?.querySelector('.financeiro-duplicata-valor')?.textContent || ''
    };
  })()`);
  if (depoisReady.title !== 'Dívidas por Cliente' || depoisReady.rows !== 2) {
    throw new Error('Lista redesenhada inválida: ' + JSON.stringify(depoisReady));
  }
  if (!depoisReady.escaped) throw new Error('XSS na lista não escapado');
  if (!depoisReady.hasEmpresa) throw new Error('X-Empresa-Id ausente');
  if (!/cliente=|status=|dataInicio=|dataFim=/.test(depoisReady.listUrl)) {
    // filtros podem estar vazios no query; dataInicio/dataFim devem existir
    if (!String(depoisReady.listUrl).includes('dataInicio=')) {
      throw new Error('Query de listagem sem período: ' + depoisReady.listUrl);
    }
  }
  const depoisSize = await capture('SPRINT-FIN-UX-06-DEPOIS.png');
  console.log('DEPOIS', depoisSize, depoisReady);

  // Detalhe
  await windowRef.webContents.executeJavaScript(`(() => {
    document.querySelector('[data-abrir-duplicata="11"]').click();
  })()`);
  await wait(350);
  const detalheOk = await windowRef.webContents.executeJavaScript(`(() => {
    const resumo = Array.from(document.querySelectorAll('.financeiro-duplicata-resumo-card strong')).map(el => el.textContent.trim());
    return {
      title: document.getElementById('financeiroDuplicataDetalheTitulo')?.textContent || '',
      resumo,
      vendas: document.querySelectorAll('.financeiro-duplicata-venda').length,
      temPago: resumo.some(t => /49/.test(t)),
      temSaldo: resumo.some(t => /450/.test(t))
    };
  })()`);
  if (detalheOk.title !== 'Cliente Alfa' || detalheOk.vendas !== 1 || !detalheOk.temPago || !detalheOk.temSaldo) {
    throw new Error('Detalhe inválido: ' + JSON.stringify(detalheOk));
  }

  // Voltar + estado vazio
  await windowRef.webContents.executeJavaScript(`(() => {
    document.getElementById('btnVoltarDuplicataLista').click();
  })()`);
  await wait(250);
  await windowRef.webContents.executeJavaScript(`(() => {
    window.__finUx06.clientes = [];
    window.renderDuplicataClientes(window.obterPeriodoFinanceiro());
  })()`);
  await wait(300);
  const emptySize = await capture('SPRINT-FIN-UX-06-ESTADO-VAZIO.png');
  console.log('VAZIO', emptySize);
  const emptyOk = await windowRef.webContents.executeJavaScript(`(() => {
    const el = document.getElementById('duplicataListaEstado');
    return {
      visible: el && !el.hidden,
      text: el?.textContent || '',
      tabelaHidden: document.getElementById('duplicataTabelaWrap')?.hidden === true
    };
  })()`);
  if (!emptyOk.visible || !/Nenhuma dívida agrupada/i.test(emptyOk.text) || !emptyOk.tabelaHidden) {
    throw new Error('Estado vazio inválido: ' + JSON.stringify(emptyOk));
  }

  // Erro
  await windowRef.webContents.executeJavaScript(`(() => {
    window.__finUx06.override = {
      ok: false,
      status: 500,
      json: async () => ({ success: false, error: 'Falha sintética <img src=x onerror=alert(1)>' })
    };
    window.renderDuplicataClientes(window.obterPeriodoFinanceiro());
  })()`);
  await wait(300);
  const erroOk = await windowRef.webContents.executeJavaScript(`(() => {
    const el = document.getElementById('duplicataListaEstado');
    return {
      isErro: el?.classList.contains('financeiro-duplicata-estado--erro'),
      text: el?.textContent || '',
      semTag: !(el?.innerHTML || '').includes('<img')
    };
  })()`);
  if (!erroOk.isErro || !erroOk.semTag || !/Falha sintética/i.test(erroOk.text)) {
    throw new Error('Estado de erro inválido: ' + JSON.stringify(erroOk));
  }

  // Responsividade
  await windowRef.webContents.executeJavaScript(`(() => {
    window.__finUx06.override = null;
    window.__finUx06.clientes = ${JSON.stringify(fixtureClientes)};
    window.renderDuplicataClientes(window.obterPeriodoFinanceiro());
  })()`);
  await wait(300);
  const viewports = [
    { w: 1440, h: 900 },
    { w: 1024, h: 768 },
    { w: 768, h: 900 }
  ];
  const responsive = [];
  for (const vp of viewports) {
    await windowRef.setContentSize(vp.w, vp.h);
    await wait(200);
    const metrics = await windowRef.webContents.executeJavaScript(`(() => ({
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth
    }))()`);
    responsive.push(Object.assign({ requested: vp.w }, metrics));
    if (metrics.scrollWidth > metrics.innerWidth + 24) {
      throw new Error('Overflow horizontal em ' + vp.w + ': ' + JSON.stringify(metrics));
    }
  }
  console.log('Responsive metrics', JSON.stringify(responsive));

  await windowRef.setContentSize(1440, 900);
  await windowRef.webContents.executeJavaScript(`(() => {
    window.renderDuplicataClientes(window.obterPeriodoFinanceiro());
  })()`);
  await wait(350);
  await capture('SPRINT-FIN-UX-06-DEPOIS.png');
  console.log('FIN-UX-06 checks aprovados');
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
    await windowRef.loadURL(`${baseUrl}/__fin_ux_06_preview_blank`);
    await runPreviewChecks();
    await windowRef.close();
    await new Promise((resolve) => server.close(resolve));
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
