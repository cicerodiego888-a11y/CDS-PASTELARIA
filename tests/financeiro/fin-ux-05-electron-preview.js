'use strict';

/**
 * FIN-UX-05 — Preview Electron da aba Condições de Pagamento.
 * Dados sintéticos; não acessa banco original.
 * Executar: node_modules\.bin\electron.cmd tests\financeiro\fin-ux-05-electron-preview.js
 */

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const frontendRoot = path.join(root, 'frontend');
const reportDir = path.join(root, 'docs', 'financeiro');

const fixtureLista = [
  {
    id: 1,
    nome: 'À Vista',
    tipo: 'avista',
    dias_parcelas: [0],
    tem_entrada: 0,
    ativo: 1,
    sistema: 1
  },
  {
    id: 2,
    nome: '30/60/90',
    tipo: 'prazo',
    dias_parcelas: [30, 60, 90],
    tem_entrada: 0,
    ativo: 1,
    sistema: 1
  },
  {
    id: 3,
    nome: 'Entrada + 30/60',
    tipo: 'entrada',
    dias_parcelas: [30, 60],
    tem_entrada: 1,
    ativo: 1,
    sistema: 0
  },
  {
    id: 4,
    nome: 'Personalizada demo',
    tipo: 'prazo',
    dias_parcelas: [15, 45],
    tem_entrada: 0,
    ativo: 0,
    sistema: 0
  }
];

const legacyMarkup = `
  <div class="d-flex justify-content-between align-items-center mb-3">
    <div>
      <h5 class="mb-1">Condições de Pagamento</h5>
      <small class="text-muted">Modelos reutilizáveis no lançamento de compras (ex.: 30/60/90).</small>
    </div>
    <button type="button" class="btn btn-primary" id="btnNovaCondicaoPagamentoLegacy">
      <i class="fas fa-plus"></i> Nova condição
    </button>
  </div>
  <div class="table-responsive">
    <table class="table table-striped table-hover align-middle" id="tabelaCondicoesPagamentoLegacy">
      <thead>
        <tr>
          <th>Nome</th>
          <th>Tipo</th>
          <th>Parcelas (dias)</th>
          <th>Entrada</th>
          <th>Status</th>
          <th style="width:140px">Ações</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>À Vista <span class="badge bg-secondary">sistema</span></td>
          <td>avista</td>
          <td>0</td>
          <td>Não</td>
          <td><span class="badge bg-success">Ativa</span></td>
          <td>
            <button type="button" class="btn btn-sm btn-outline-primary me-1"><i class="fas fa-edit"></i></button>
          </td>
        </tr>
        <tr>
          <td>30/60/90 <span class="badge bg-secondary">sistema</span></td>
          <td>prazo</td>
          <td>30/60/90</td>
          <td>Não</td>
          <td><span class="badge bg-success">Ativa</span></td>
          <td>
            <button type="button" class="btn btn-sm btn-outline-primary me-1"><i class="fas fa-edit"></i></button>
          </td>
        </tr>
        <tr>
          <td>Entrada + 30/60</td>
          <td>entrada</td>
          <td>30/60</td>
          <td>Sim</td>
          <td><span class="badge bg-success">Ativa</span></td>
          <td>
            <button type="button" class="btn btn-sm btn-outline-primary me-1"><i class="fas fa-edit"></i></button>
            <button type="button" class="btn btn-sm btn-outline-danger"><i class="fas fa-trash"></i></button>
          </td>
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
      if (pathname === '/__fin_ux_05_preview_blank') {
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
    window.headersFinanceiro = extra => Object.assign({
      Accept: 'application/json',
      'X-Empresa-Id': '7',
      Authorization: 'Bearer sintetic'
    }, extra || {});
    window.showNotification = () => {};
    window.__finUx05 = {
      calls: [],
      lista: ${JSON.stringify(fixtureLista)},
      override: null,
      savedPayload: null,
      deletedId: null
    };
    window.fetch = async (url, options = {}) => {
      const state = window.__finUx05;
      const requestUrl = new URL(String(url), window.location.href);
      const method = String(options.method || 'GET').toUpperCase();
      state.calls.push({
        method,
        url: requestUrl.pathname + requestUrl.search,
        headers: options.headers || {},
        body: options.body || null
      });
      if (state.override) return state.override;
      if (requestUrl.pathname === '/api/condicoes-pagamento' && method === 'GET') {
        const todas = requestUrl.searchParams.get('todas') === '1';
        const body = todas ? state.lista : state.lista.filter(c => Number(c.ativo) === 1);
        return { ok: true, status: 200, json: async () => body };
      }
      if (requestUrl.pathname === '/api/condicoes-pagamento' && method === 'POST') {
        const payload = JSON.parse(options.body || '{}');
        state.savedPayload = payload;
        const row = Object.assign({ id: 99, sistema: 0 }, payload, {
          dias_parcelas: payload.dias_parcelas || [30],
          ativo: payload.ativo === 0 ? 0 : 1,
          tem_entrada: payload.tem_entrada ? 1 : 0
        });
        state.lista = state.lista.concat([row]);
        return { ok: true, status: 201, json: async () => row };
      }
      const putMatch = requestUrl.pathname.match(/^\\/api\\/condicoes-pagamento\\/(\\d+)$/);
      if (putMatch && method === 'PUT') {
        const id = Number(putMatch[1]);
        const payload = JSON.parse(options.body || '{}');
        state.savedPayload = Object.assign({ id }, payload);
        state.lista = state.lista.map(c => Number(c.id) === id ? Object.assign({}, c, payload, { id }) : c);
        const row = state.lista.find(c => Number(c.id) === id);
        return { ok: true, status: 200, json: async () => row };
      }
      if (putMatch && method === 'DELETE') {
        const id = Number(putMatch[1]);
        state.deletedId = id;
        const alvo = state.lista.find(c => Number(c.id) === id);
        if (alvo && Number(alvo.sistema) === 1) {
          return { ok: false, status: 400, json: async () => ({ error: 'Condições padrão do sistema não podem ser excluídas.' }) };
        }
        state.lista = state.lista.filter(c => Number(c.id) !== id);
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'não encontrado' }) };
    };
  })()`);

  await windowRef.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '${baseUrl}/erp/js/financeiro-condicoes.js';
    script.onload = () => resolve(true);
    script.onerror = reject;
    document.head.appendChild(script);
  })`);
}

async function ativarAbaCondicoes() {
  await windowRef.webContents.executeJavaScript(`(() => {
    document.querySelectorAll('.financeiro-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.aba === 'condicoes');
    });
  })()`);
}

async function runPreviewChecks() {
  console.log('Running FIN-UX-05 Electron acceptance checks');
  await loadPreview();
  await ativarAbaCondicoes();
  const antesReady = await windowRef.webContents.executeJavaScript(`(() => {
    document.querySelectorAll('.financeiro-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.aba === 'condicoes');
    });
    document.getElementById('financeiroConteudo').innerHTML = ${JSON.stringify(legacyMarkup)};
    return {
      tab: document.querySelector('.financeiro-tab.active')?.dataset?.aba || '',
      rows: document.querySelectorAll('#tabelaCondicoesPagamentoLegacy tbody tr').length,
      title: document.querySelector('#financeiroConteudo h5')?.textContent || ''
    };
  })()`);
  if (antesReady.tab !== 'condicoes' || antesReady.rows < 3) {
    throw new Error('Pré-captura ANTES inválida: ' + JSON.stringify(antesReady));
  }
  await wait(300);
  const beforeSize = await capture('SPRINT-FIN-UX-05-ANTES.png');
  console.log('ANTES', beforeSize, antesReady);

  await windowRef.webContents.executeJavaScript(`(() => {
    document.querySelectorAll('.modal').forEach(el => el.remove());
    window.renderCondicoesPagamento();
  })()`);
  await wait(400);
  const depoisReady = await windowRef.webContents.executeJavaScript(`(() => ({
    tab: document.querySelector('.financeiro-tab.active')?.dataset?.aba || '',
    rows: document.querySelectorAll('#tabelaCondicoesPagamento tbody tr').length,
    title: document.getElementById('financeiroCondicoesTitulo')?.textContent || '',
    modalOpen: Boolean(document.getElementById('modalCondicaoPagamentoCds'))
  }))()`);
  if (depoisReady.tab !== 'condicoes' || depoisReady.rows !== 4 || depoisReady.modalOpen) {
    throw new Error('Pré-captura DEPOIS inválida: ' + JSON.stringify(depoisReady));
  }
  const depoisSize = await capture('SPRINT-FIN-UX-05-DEPOIS.png');
  console.log('DEPOIS', depoisSize, depoisReady);

  const checks = await windowRef.webContents.executeJavaScript(`(() => {
    const titulo = document.getElementById('financeiroCondicoesTitulo')?.textContent || '';
    const rows = document.querySelectorAll('#tabelaCondicoesPagamento tbody tr').length;
    const tipos = Array.from(document.querySelectorAll('.financeiro-condicoes-tipo')).map(el => el.textContent.trim());
    const headers = window.__finUx05.calls[0]?.headers || {};
    const hasEmpresa = Boolean(headers['X-Empresa-Id'] || headers['x-empresa-id']);
    const listCall = window.__finUx05.calls.find(c => c.method === 'GET' && String(c.url).includes('/api/condicoes-pagamento'));
    const sistemaSemDelete = !document.querySelector('#tabelaCondicoesPagamento [data-del="1"]');
    const customComDelete = Boolean(document.querySelector('#tabelaCondicoesPagamento [data-del="3"]'));
    return {
      titulo,
      rows,
      tipos,
      hasEmpresa,
      listUrl: listCall?.url || '',
      sistemaSemDelete,
      customComDelete
    };
  })()`);

  if (checks.titulo !== 'Condições de Pagamento') throw new Error('Título incorreto: ' + checks.titulo);
  if (checks.rows !== 4) throw new Error('Esperava 4 linhas, veio ' + checks.rows);
  if (!checks.tipos.includes('À vista') || !checks.tipos.includes('À prazo')) {
    throw new Error('Rótulos de tipo não aplicados: ' + JSON.stringify(checks.tipos));
  }
  if (!checks.hasEmpresa) throw new Error('X-Empresa-Id ausente na listagem');
  if (!String(checks.listUrl).includes('todas=1')) throw new Error('Listagem deve usar ?todas=1');
  if (!checks.sistemaSemDelete) throw new Error('Condição de sistema não deve exibir exclusão');
  if (!checks.customComDelete) throw new Error('Condição customizada deve permitir exclusão');

  // Estado vazio
  await windowRef.webContents.executeJavaScript(`(() => {
    window.__finUx05.lista = [];
    window.renderCondicoesPagamento();
  })()`);
  await wait(300);
  const emptySize = await capture('SPRINT-FIN-UX-05-ESTADO-VAZIO.png');
  console.log('VAZIO', emptySize);
  const emptyOk = await windowRef.webContents.executeJavaScript(`(() => {
    const estado = document.getElementById('condicoesPagamentoEstado');
    return {
      visible: estado && !estado.hidden,
      text: estado?.textContent || '',
      tabelaHidden: document.getElementById('condicoesPagamentoTabelaWrap')?.hidden === true
    };
  })()`);
  if (!emptyOk.visible || !/Nenhuma condição cadastrada/i.test(emptyOk.text) || !emptyOk.tabelaHidden) {
    throw new Error('Estado vazio inválido: ' + JSON.stringify(emptyOk));
  }

  // Estado erro
  await windowRef.webContents.executeJavaScript(`(() => {
    window.__finUx05.override = {
      ok: false,
      status: 500,
      json: async () => ({ error: 'Falha sintética <b>xss</b>' })
    };
    window.renderCondicoesPagamento();
  })()`);
  await wait(300);
  const erroOk = await windowRef.webContents.executeJavaScript(`(() => {
    const estado = document.getElementById('condicoesPagamentoEstado');
    const html = estado?.innerHTML || '';
    const text = estado?.textContent || '';
    return {
      isErro: estado?.classList.contains('financeiro-condicoes-estado--erro'),
      text,
      semTag: !html.includes('<b>xss</b>') && text.includes('Falha sintética')
    };
  })()`);
  if (!erroOk.isErro || !erroOk.semTag) {
    throw new Error('Estado de erro inválido / XSS: ' + JSON.stringify(erroOk));
  }

  // Validação de formulário (nome obrigatório) + salvamento
  await windowRef.webContents.executeJavaScript(`(() => {
    window.__finUx05.override = null;
    window.__finUx05.lista = ${JSON.stringify(fixtureLista)};
    window.renderCondicoesPagamento();
  })()`);
  await wait(300);
  const formChecks = await windowRef.webContents.executeJavaScript(`(async () => {
    document.getElementById('btnNovaCondicaoPagamento').click();
    await new Promise(r => setTimeout(r, 120));
    document.getElementById('btnSalvarCondPag').click();
    await new Promise(r => setTimeout(r, 80));
    const erro = document.getElementById('condPagErroForm');
    const erroNome = erro && !erro.hidden && /Informe o nome/i.test(erro.textContent || '');
    document.getElementById('condPagNome').value = '45/90 demo';
    document.getElementById('condPagTipo').value = 'prazo';
    document.getElementById('condPagDias').value = '45/90';
    document.getElementById('btnSalvarCondPag').click();
    await new Promise(r => setTimeout(r, 180));
    return {
      erroNome,
      saved: window.__finUx05.savedPayload,
      rowsAfter: document.querySelectorAll('#tabelaCondicoesPagamento tbody tr').length
    };
  })()`);
  if (!formChecks.erroNome) throw new Error('Validação de nome obrigatório não exibida');
  if (!formChecks.saved || formChecks.saved.nome !== '45/90 demo') {
    throw new Error('Payload de salvamento inválido: ' + JSON.stringify(formChecks.saved));
  }
  if (formChecks.rowsAfter < 4) throw new Error('Lista não atualizou após salvar');

  // Responsividade
  const viewports = [
    { w: 1440, h: 900 },
    { w: 1024, h: 768 },
    { w: 768, h: 900 }
  ];
  const responsive = [];
  for (const vp of viewports) {
    await windowRef.setContentSize(vp.w, vp.h);
    await wait(200);
    const metrics = await windowRef.webContents.executeJavaScript(`(() => {
      const doc = document.documentElement;
      return {
        innerWidth: window.innerWidth,
        scrollWidth: doc.scrollWidth,
        tabelaMin: getComputedStyle(document.querySelector('.financeiro-condicoes-tabela') || document.body).minWidth
      };
    })()`);
    responsive.push(Object.assign({ requested: vp.w }, metrics));
    if (metrics.scrollWidth > metrics.innerWidth + 2) {
      // tabela pode ter scroll interno; documento não deve estourar além do viewport + pequena margem
      // Aceita diferença apenas se a rolagem for da tabela (overflow-x no wrap)
      const overflowDoc = metrics.scrollWidth - metrics.innerWidth;
      if (overflowDoc > 24) {
        throw new Error('Overflow horizontal do documento em ' + vp.w + 'px: ' + JSON.stringify(metrics));
      }
    }
  }
  console.log('Responsive metrics', JSON.stringify(responsive));

  // Restaura captura DEPOIS limpa (sem modal residual)
  await windowRef.setContentSize(1440, 900);
  await windowRef.webContents.executeJavaScript(`(() => {
    document.querySelectorAll('.modal, .modal-backdrop').forEach(el => el.remove());
    document.body.classList.remove('modal-open');
    document.body.style.removeProperty('overflow');
    document.body.style.removeProperty('padding-right');
    window.__finUx05.lista = ${JSON.stringify(fixtureLista)};
    window.__finUx05.override = null;
    window.renderCondicoesPagamento();
  })()`);
  await wait(400);
  const finalDepois = await windowRef.webContents.executeJavaScript(`(() => ({
    rows: document.querySelectorAll('#tabelaCondicoesPagamento tbody tr').length,
    modalOpen: Boolean(document.getElementById('modalCondicaoPagamentoCds')),
    tab: document.querySelector('.financeiro-tab.active')?.dataset?.aba || ''
  }))()`);
  if (finalDepois.rows !== 4 || finalDepois.modalOpen || finalDepois.tab !== 'condicoes') {
    throw new Error('Captura final DEPOIS inválida: ' + JSON.stringify(finalDepois));
  }
  await capture('SPRINT-FIN-UX-05-DEPOIS.png');

  console.log('FIN-UX-05 checks aprovados');
}

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(reportDir, { recursive: true });
    await startServer();
    windowRef = new BrowserWindow({
      width: 1440,
      height: 900,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    await windowRef.loadURL(`${baseUrl}/__fin_ux_05_preview_blank`);
    await runPreviewChecks();
    await windowRef.close();
    await new Promise((resolve) => server.close(resolve));
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
