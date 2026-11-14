/**
 * CDS-ERP-PDV-JANELA-INDEPENDENTE-01
 * Abre/foca uma BrowserWindow PDV a partir do ERP, no mesmo backend.
 */
'use strict';

const path = require('path');
const os = require('os');

const CANAL = 'cds:abrir-pdv';
const CANAL_ERP = 'cds:abrir-erp';

function montarUrlErp(baseUrl, page) {
  const base = String(baseUrl || '').replace(/\/$/, '');
  const pagina = page != null && String(page).trim() !== ''
    ? `?page=${encodeURIComponent(String(page).trim())}`
    : '';
  return `${base}/erp${pagina}`;
}

function ativarRecomposicaoFiscalOperacional() {
  process.env.CDS_RECOMPOSICAO_FECHAMENTO_OPERACIONAL = '1';
  delete process.env.CDS_RECOMPOSICAO_REFERENCIA_TESTE;
  delete process.env.CDS_RECOMPOSICAO_HOMOLOGACAO_DISTRIBUIR;
  delete process.env.CDS_RECOMPOSICAO_APLICAR_DISTRIBUICAO;
  delete process.env.CDS_RECOMPOSICAO_HOMOLOGACAO;
  delete process.env.CDS_RECOMPOSICAO_DIAGNOSTICO;
}

function montarUrlLoginPdv(baseUrl) {
  const base = String(baseUrl || '').replace(/\/$/, '');
  const hostname = encodeURIComponent(os.hostname());
  return `${base}/login?modulo=pdv&estacao_hostname=${hostname}`;
}

function montarUrlPdv(baseUrl) {
  return `${String(baseUrl || '').replace(/\/$/, '')}/pdv`;
}

function focarJanelaExistente(win) {
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return false;
  if (typeof win.isMinimized === 'function' && win.isMinimized()) win.restore();
  if (typeof win.show === 'function') win.show();
  if (typeof win.focus === 'function') win.focus();
  return true;
}

function criarControladorAbrirPdv(deps) {
  let pdvWindow = null;
  let abrindo = false;
  let handoffPendente = null;

  let abrindoErp = false;

  function limparRef() {
    pdvWindow = null;
    handoffPendente = null;
  }

  function janelaConhecida(senderWin) {
    if (!senderWin || senderWin.isDestroyed()) return false;
    const mainWindow = typeof deps.getMainWindow === 'function' ? deps.getMainWindow() : null;
    if (mainWindow && !mainWindow.isDestroyed() && senderWin.id === mainWindow.id) return true;
    if (pdvWindow && !pdvWindow.isDestroyed() && senderWin.id === pdvWindow.id) return true;
    return false;
  }

  async function navegarErpParaPagina(win, page) {
    if (!page || !win || win.isDestroyed()) return;
    const pagina = String(page).trim();
    if (!pagina) return;
    await win.webContents.executeJavaScript(
      `try{if(typeof loadPage==='function'){loadPage(${JSON.stringify(pagina)});}}catch(e){}`,
      true
    ).catch(() => {});
  }

  async function recriarErp(baseUrl, page) {
    if (typeof deps.recriarJanelaErp === 'function') {
      return deps.recriarJanelaErp({ baseUrl, page: page || null });
    }
    const preloadPath = deps.preloadPath
      || path.join(deps.appRoot || __dirname, 'preload.js');
    const win = new deps.BrowserWindow({
      width: 1280,
      height: 800,
      title: 'CDS Sistemas - Plataforma Inteligente de Gestão',
      show: false,
      autoHideMenuBar: true,
      focusable: true,
      skipTaskbar: false,
      icon: typeof deps.resolverIconeJanela === 'function'
        ? deps.resolverIconeJanela()
        : undefined,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        preload: preloadPath
      }
    });
    if (typeof deps.registrarMainWindow === 'function') {
      deps.registrarMainWindow(win);
    }
    win.webContents.on('did-finish-load', () => {
      if (typeof deps.injetarHostnameEstacao === 'function') {
        deps.injetarHostnameEstacao(win.webContents);
      }
    });
    await carregarUrl(win, montarUrlErp(baseUrl, page || null));
    if (typeof win.maximize === 'function') win.maximize();
    win.show();
    win.focus();
    return win;
  }

  async function abrirErp(event, opcoes = {}) {
    const senderWin = deps.BrowserWindow.fromWebContents(event.sender);
    if (!janelaConhecida(senderWin)) {
      return {
        ok: false,
        codigo: 'JANELA_NAO_AUTORIZADA',
        mensagem: 'Solicitação de abertura do ERP rejeitada.'
      };
    }

    const baseUrl = typeof deps.getBackendBaseUrl === 'function' ? deps.getBackendBaseUrl() : null;
    if (!baseUrl) {
      if (deps.dialog && typeof deps.dialog.showErrorBox === 'function') {
        deps.dialog.showErrorBox(
          'ERP indisponível',
          'O backend ainda não está disponível para abrir o ERP.'
        );
      }
      return {
        ok: false,
        codigo: 'BACKEND_INDISPONIVEL',
        mensagem: 'Backend indisponível.'
      };
    }

    const page = opcoes && opcoes.page ? String(opcoes.page).trim() : '';
    const mainWindow = typeof deps.getMainWindow === 'function' ? deps.getMainWindow() : null;

    if (mainWindow && !mainWindow.isDestroyed()) {
      focarJanelaExistente(mainWindow);
      if (page) await navegarErpParaPagina(mainWindow, page);
      return { ok: true, focada: true, repetida: true };
    }

    if (abrindoErp) {
      return { ok: true, repetida: true, codigo: 'ABERTURA_EM_CURSO' };
    }

    abrindoErp = true;
    try {
      await recriarErp(baseUrl, page || null);
      return { ok: true, criada: true };
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (deps.dialog && typeof deps.dialog.showErrorBox === 'function') {
        deps.dialog.showErrorBox(
          'Erro ao abrir ERP',
          `Não foi possível carregar o ERP.\n\n${msg}`
        );
      }
      return { ok: false, codigo: 'FALHA_CARREGAMENTO', mensagem: msg };
    } finally {
      abrindoErp = false;
    }
  }

  async function injetarHandoff(win, handoff) {
    if (!handoff || !win || win.isDestroyed()) return false;
    const payload = JSON.stringify(JSON.stringify(handoff));
    await win.webContents.executeJavaScript(
      `try{sessionStorage.setItem('pdvPedidoHandoff',${payload});}catch(e){}`,
      true
    );
    return true;
  }

  function anexarInjecaoHandoff(win) {
    if (!win || !win.webContents || typeof win.webContents.on !== 'function') return;
    win.webContents.on('did-finish-load', () => {
      if (typeof deps.injetarHostnameEstacao === 'function') {
        deps.injetarHostnameEstacao(win.webContents);
      }
      const pendente = handoffPendente;
      if (!pendente || win.isDestroyed()) return;
      injetarHandoff(win, pendente).catch(() => {});
    });
  }

  async function carregarUrl(win, url) {
    if (typeof deps.carregarJanelaComRobustez === 'function') {
      await deps.carregarJanelaComRobustez(win, url);
    } else {
      await win.loadURL(url);
    }
  }

  async function carregarPdv(win, baseUrl, handoff) {
    handoffPendente = handoff || null;
    // Com pedido: /pdv direto. Sem pedido: login?modulo=pdv.
    const url = handoff ? montarUrlPdv(baseUrl) : montarUrlLoginPdv(baseUrl);
    if (!handoff) {
      await carregarUrl(win, url);
      return;
    }

    // 1) Abre a origem, grava o handoff na janela PDV.
    // 2) Recarrega /pdv uma vez — o loadPDV aplica o handoff só depois do catálogo.
    // Não chamar aplicarHandoffPedidoPdv() aqui: corre antes do AJAX e gera falso "produto indisponível".
    await carregarUrl(win, url);
    await injetarHandoff(win, handoff);
    await win.webContents.executeJavaScript(
      `try{
        var h=sessionStorage.getItem('pdvPedidoHandoff');
        if(h){localStorage.setItem('pdvPedidoHandoff',h);}
      }catch(e){}`,
      true
    ).catch(() => {});
    await carregarUrl(win, url);
    handoffPendente = null;
  }

  async function abrir(event, opcoes = {}) {
    const senderWin = deps.BrowserWindow.fromWebContents(event.sender);
    const mainWindow = typeof deps.getMainWindow === 'function' ? deps.getMainWindow() : null;
    const modulo = String(
      typeof deps.getAppModulo === 'function' ? deps.getAppModulo() : 'erp'
    ).toLowerCase();

    if (modulo !== 'erp') {
      return {
        ok: false,
        codigo: 'MODULO_NAO_AUTORIZADO',
        mensagem: 'Abrir PDV só é permitido a partir do ERP.'
      };
    }
    if (
      !mainWindow
      || mainWindow.isDestroyed()
      || !senderWin
      || senderWin.isDestroyed()
      || senderWin.id !== mainWindow.id
    ) {
      return {
        ok: false,
        codigo: 'JANELA_NAO_AUTORIZADA',
        mensagem: 'Solicitação de abertura do PDV rejeitada.'
      };
    }

    const baseUrl = typeof deps.getBackendBaseUrl === 'function' ? deps.getBackendBaseUrl() : null;
    if (!baseUrl) {
      if (deps.dialog && typeof deps.dialog.showErrorBox === 'function') {
        deps.dialog.showErrorBox(
          'PDV indisponível',
          'O backend ainda não está disponível para abrir o PDV.'
        );
      }
      return {
        ok: false,
        codigo: 'BACKEND_INDISPONIVEL',
        mensagem: 'Backend indisponível.'
      };
    }

    if (abrindo) {
      if (pdvWindow && !pdvWindow.isDestroyed()) focarJanelaExistente(pdvWindow);
      return { ok: true, repetida: true, codigo: 'ABERTURA_EM_CURSO' };
    }

    const handoff = opcoes && opcoes.handoff ? opcoes.handoff : null;

    if (pdvWindow && !pdvWindow.isDestroyed()) {
      focarJanelaExistente(pdvWindow);
      if (!handoff) {
        return { ok: true, focada: true, repetida: true };
      }
      abrindo = true;
      try {
        await carregarPdv(pdvWindow, baseUrl, handoff);
        return { ok: true, focada: true, repetida: true, handoff: true };
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        return { ok: false, codigo: 'FALHA_HANDOFF', mensagem: msg };
      } finally {
        abrindo = false;
      }
    }

    abrindo = true;
    try {
      ativarRecomposicaoFiscalOperacional();
      const preloadPath = deps.preloadPath
        || path.join(deps.appRoot || __dirname, 'preload.js');
      const win = new deps.BrowserWindow({
        width: 1280,
        height: 800,
        title: 'CDS Sistemas - PDV',
        show: false,
        autoHideMenuBar: true,
        focusable: true,
        skipTaskbar: false,
        icon: typeof deps.resolverIconeJanela === 'function'
          ? deps.resolverIconeJanela()
          : undefined,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: false,
          preload: preloadPath
        }
      });

      pdvWindow = win;
      win.on('closed', limparRef);
      anexarInjecaoHandoff(win);

      await carregarPdv(win, baseUrl, handoff);

      if (typeof win.maximize === 'function') win.maximize();
      win.show();
      win.focus();
      return { ok: true, criada: true, handoff: Boolean(handoff) };
    } catch (err) {
      if (pdvWindow && !pdvWindow.isDestroyed()) {
        try { pdvWindow.destroy(); } catch (_e) { /* ignore */ }
      }
      limparRef();
      const msg = err && err.message ? err.message : String(err);
      if (deps.dialog && typeof deps.dialog.showErrorBox === 'function') {
        deps.dialog.showErrorBox(
          'Erro ao abrir PDV',
          `Não foi possível carregar o PDV.\n\n${msg}`
        );
      }
      return { ok: false, codigo: 'FALHA_CARREGAMENTO', mensagem: msg };
    } finally {
      abrindo = false;
    }
  }

  function registrar(ipcMain) {
    if (typeof ipcMain.removeHandler === 'function') {
      try { ipcMain.removeHandler(CANAL); } catch (_e) { /* ignore */ }
      try { ipcMain.removeHandler(CANAL_ERP); } catch (_e2) { /* ignore */ }
    }
    ipcMain.handle(CANAL, (event, opcoes) => abrir(event, opcoes || {}));
    ipcMain.handle(CANAL_ERP, (event, opcoes) => abrirErp(event, opcoes || {}));
  }

  return {
    CANAL,
    CANAL_ERP,
    registrar,
    abrir,
    abrirErp,
    getPdvWindow: () => pdvWindow,
    limparRef
  };
}

module.exports = {
  CANAL,
  CANAL_ERP,
  ativarRecomposicaoFiscalOperacional,
  montarUrlLoginPdv,
  montarUrlPdv,
  montarUrlErp,
  focarJanelaExistente,
  criarControladorAbrirPdv
};
