/**
 * CDS-ERP-PDV-JANELA-INDEPENDENTE-01
 * node --test --test-concurrency=1 tests/electron/erp-pdv-janela-independente-01.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const {
  CANAL,
  montarUrlLoginPdv,
  focarJanelaExistente,
  ativarRecomposicaoFiscalOperacional,
  criarControladorAbrirPdv
} = require('../../electron-abrir-pdv');
const pdvAcesso = require('../../frontend/shared/js/pdv-acesso-oficial.js');

function ler(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function fakeWindow(id = 1) {
  const state = {
    id,
    destroyed: false,
    minimized: false,
    focused: false,
    shown: false,
    maximized: false,
    title: '',
    loadedUrl: null,
    closedHandlers: [],
    finishHandlers: [],
    scripts: []
  };
  const win = {
    id,
    isDestroyed: () => state.destroyed,
    isMinimized: () => state.minimized,
    restore: () => { state.minimized = false; },
    show: () => { state.shown = true; },
    focus: () => { state.focused = true; },
    maximize: () => { state.maximized = true; },
    destroy: () => {
      state.destroyed = true;
      state.closedHandlers.forEach((fn) => fn());
    },
    on: (evt, fn) => {
      if (evt === 'closed') state.closedHandlers.push(fn);
    },
    loadURL: async (url) => { state.loadedUrl = url; },
    webContents: {
      executeJavaScript: async (script) => { state.scripts.push(script); },
      on: (evt, fn) => {
        if (evt === 'did-finish-load') state.finishHandlers.push(fn);
      }
    },
    _state: state
  };
  return win;
}

describe('CDS-ERP-PDV-JANELA-INDEPENDENTE-01 — contrato estático', () => {
  it('expõe IPC, preload e botão ERP sem navegação forçada no Electron', () => {
    assert.equal(CANAL, 'cds:abrir-pdv');
    assert.match(ler('preload.js'), /abrirPdv:\s*\(opcoes\)\s*=>\s*ipcRenderer\.invoke\('cds:abrir-pdv'/);
    assert.match(ler('preload.js'), /abrirErp:\s*\(opcoes\)\s*=>\s*ipcRenderer\.invoke\('cds:abrir-erp'/);
    assert.match(ler('frontend/erp/index.html'), /data-cds-abrir-pdv="1"/);
    assert.match(ler('frontend/pdv/index.html'), /data-cds-abrir-erp="1"/);
    assert.match(ler('frontend/shared/js/core.js'), /data-cds-abrir-pdv/);
    assert.match(ler('frontend/shared/js/core.js'), /data-cds-abrir-erp/);
    assert.match(ler('frontend/shared/js/core.js'), /abrirPdvOficial/);
    assert.match(ler('frontend/shared/js/core.js'), /abrirErpOficial/);
    assert.match(ler('frontend/shared/js/pdv-acesso-oficial.js'), /function abrirPdvOficial/);
    assert.match(ler('frontend/shared/js/pdv-acesso-oficial.js'), /function abrirErpOficial/);
    assert.match(ler('electron.js'), /criarControladorAbrirPdv/);
    assert.match(ler('electron-common.js'), /criarControladorAbrirPdv/);
    assert.doesNotMatch(ler('preload.js'), /exposeInMainWorld\('ipcRenderer'/);
  });

  it('monta URL de login do módulo PDV no mesmo host', () => {
    const url = montarUrlLoginPdv('http://127.0.0.1:3001/');
    assert.match(url, /^http:\/\/127\.0\.0\.1:3001\/login\?modulo=pdv&estacao_hostname=/);
  });

  it('ativa recomposição operacional sem flags de homologação', () => {
    process.env.CDS_RECOMPOSICAO_REFERENCIA_TESTE = '1';
    process.env.CDS_RECOMPOSICAO_HOMOLOGACAO = '1';
    process.env.CDS_RECOMPOSICAO_DIAGNOSTICO = '1';
    ativarRecomposicaoFiscalOperacional();
    assert.equal(process.env.CDS_RECOMPOSICAO_FECHAMENTO_OPERACIONAL, '1');
    assert.equal(process.env.CDS_RECOMPOSICAO_REFERENCIA_TESTE, undefined);
    assert.equal(process.env.CDS_RECOMPOSICAO_HOMOLOGACAO, undefined);
    assert.equal(process.env.CDS_RECOMPOSICAO_DIAGNOSTICO, undefined);
  });
});

describe('CDS-ERP-PDV-JANELA-INDEPENDENTE-01 — controlador', () => {
  it('cria uma janela, foca na repetição e limpa ao fechar', async () => {
    const criadas = [];
    const erp = fakeWindow(10);
    const FakeBrowserWindow = function FakeBrowserWindow(opts) {
      const win = fakeWindow(20 + criadas.length);
      win.title = opts.title;
      win._opts = opts;
      criadas.push(win);
      return win;
    };
    FakeBrowserWindow.fromWebContents = () => erp;

    const ctrl = criarControladorAbrirPdv({
      BrowserWindow: FakeBrowserWindow,
      getMainWindow: () => erp,
      getAppModulo: () => 'erp',
      getBackendBaseUrl: () => 'http://127.0.0.1:3001',
      resolverIconeJanela: () => null,
      carregarJanelaComRobustez: async (win, url) => {
        await win.loadURL(url);
      }
    });

    const event = { sender: {} };
    const r1 = await ctrl.abrir(event, {});
    assert.equal(r1.ok, true);
    assert.equal(r1.criada, true);
    assert.equal(criadas.length, 1);
    assert.equal(criadas[0].title, 'CDS Sistemas - PDV');
    assert.equal(criadas[0]._opts.webPreferences.contextIsolation, true);
    assert.equal(criadas[0]._opts.webPreferences.nodeIntegration, false);
    assert.equal(criadas[0]._opts.parent, undefined);
    assert.match(criadas[0]._state.loadedUrl, /modulo=pdv/);
    assert.equal(criadas[0]._state.maximized, true);
    assert.equal(criadas[0]._state.focused, true);

    criadas[0]._state.minimized = true;
    const r2 = await ctrl.abrir(event, {});
    assert.equal(r2.ok, true);
    assert.equal(r2.focada, true);
    assert.equal(r2.repetida, true);
    assert.equal(criadas.length, 1);
    assert.equal(criadas[0]._state.minimized, false);
    assert.equal(criadas[0]._state.focused, true);

    criadas[0].destroy();
    assert.equal(ctrl.getPdvWindow(), null);

    const r3 = await ctrl.abrir(event, { handoff: { pedido_id: 40, itens: [{ produto_id: 1 }] } });
    assert.equal(r3.ok, true);
    assert.equal(r3.criada, true);
    assert.equal(criadas.length, 2);
    assert.match(criadas[1]._state.loadedUrl, /\/pdv$/);
    assert.match(criadas[1]._state.scripts.join('\n'), /pdvPedidoHandoff/);
  });

  it('rejeita solicitação fora da janela ERP', async () => {
    const erp = fakeWindow(1);
    const outra = fakeWindow(2);
    const FakeBrowserWindow = function FakeBrowserWindow() {
      return fakeWindow(99);
    };
    FakeBrowserWindow.fromWebContents = () => outra;
    const ctrl = criarControladorAbrirPdv({
      BrowserWindow: FakeBrowserWindow,
      getMainWindow: () => erp,
      getAppModulo: () => 'erp',
      getBackendBaseUrl: () => 'http://127.0.0.1:3001'
    });
    const r = await ctrl.abrir({ sender: {} }, {});
    assert.equal(r.ok, false);
    assert.equal(r.codigo, 'JANELA_NAO_AUTORIZADA');
  });

  it('rejeita quando backend ainda não tem URL', async () => {
    const erp = fakeWindow(1);
    const FakeBrowserWindow = function FakeBrowserWindow() {
      return fakeWindow(99);
    };
    FakeBrowserWindow.fromWebContents = () => erp;
    const erros = [];
    const ctrl = criarControladorAbrirPdv({
      BrowserWindow: FakeBrowserWindow,
      dialog: { showErrorBox: (t, m) => erros.push({ t, m }) },
      getMainWindow: () => erp,
      getAppModulo: () => 'erp',
      getBackendBaseUrl: () => null
    });
    const r = await ctrl.abrir({ sender: {} }, {});
    assert.equal(r.ok, false);
    assert.equal(r.codigo, 'BACKEND_INDISPONIVEL');
    assert.equal(erros.length, 1);
  });

  it('focarJanelaExistente restaura minimizada', () => {
    const win = fakeWindow(3);
    win._state.minimized = true;
    assert.equal(focarJanelaExistente(win), true);
    assert.equal(win._state.minimized, false);
    assert.equal(win._state.focused, true);
  });

  it('Abrir ERP a partir do PDV foca o ERP existente sem criar outro', async () => {
    const erp = fakeWindow(1);
    erp._state.minimized = true;
    const criadas = [];
    const FakeBrowserWindow = function FakeBrowserWindow(opts) {
      const win = fakeWindow(50 + criadas.length);
      win._opts = opts;
      criadas.push(win);
      return win;
    };
    FakeBrowserWindow.fromWebContents = () => erp;

    const ctrl = criarControladorAbrirPdv({
      BrowserWindow: FakeBrowserWindow,
      getMainWindow: () => erp,
      getAppModulo: () => 'erp',
      getBackendBaseUrl: () => 'http://127.0.0.1:3001',
      carregarJanelaComRobustez: async (win, url) => { await win.loadURL(url); }
    });

    const aberto = await ctrl.abrir({ sender: {} }, {});
    assert.equal(aberto.ok, true);
    assert.equal(criadas.length, 1);

    const pdvWin = ctrl.getPdvWindow();
    FakeBrowserWindow.fromWebContents = () => pdvWin;
    const r = await ctrl.abrirErp({ sender: {} }, {});
    assert.equal(r.ok, true);
    assert.equal(r.focada, true);
    assert.equal(r.repetida, true);
    assert.equal(criadas.length, 1);
    assert.equal(erp._state.minimized, false);
    assert.equal(erp._state.focused, true);
  });
});

describe('CDS-ERP-PDV-JANELA-INDEPENDENTE-01 — fallback web', () => {
  it('abrirPdvOficial no navegador usa /pdv e preserva handoff', async () => {
    const assigns = [];
    const session = {};
    const local = {};
    globalThis.electronAPI = undefined;
    globalThis.sessionStorage = {
      setItem: (k, v) => { session[k] = v; },
      getItem: (k) => session[k] || null
    };
    globalThis.localStorage = {
      setItem: (k, v) => { local[k] = v; },
      getItem: (k) => local[k] || null,
      removeItem: (k) => { delete local[k]; }
    };
    globalThis.location = {
      assign: (url) => { assigns.push(url); }
    };
    const r = await pdvAcesso.abrirPdvOficial({ handoff: { pedido_id: 7 } });
    assert.equal(r.ok, true);
    assert.equal(r.modo, 'web');
    assert.deepEqual(assigns, ['/pdv']);
    assert.match(session.pdvPedidoHandoff, /"pedido_id":7/);
    assert.match(local.pdvPedidoHandoff, /"pedido_id":7/);
  });
});
