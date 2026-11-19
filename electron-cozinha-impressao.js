/**
 * IPC Electron — impressão de COZINHA (Sprint 06 Bloco E · correção auditoria).
 *
 * E-02: renderer NÃO pode disparar print genérico (texto/device arbitrários).
 * Print físico só via Worker + adapter de produção (in-process) ou
 * referência canônica a job (imprimir-job), com remetente validado.
 */
'use strict';

const { BrowserWindow } = require('electron');
const {
  IPC_CANAIS,
  validarRemetenteIpc,
  rejeitarImpressaoGenericaPorIpc,
  sanitizarReferenciaJobImpressao,
  isImpressaoFisicaAutorizada
} = require('./backend/services/cozinha/cozinhaImpressaoElectronBridge');

/** Tokens de Worker confiáveis registrados pelo main (E-02/E-03). */
const _tokensWorkerConfiaveis = new Set();

function registrarTokenWorkerConfiavel(token) {
  if (token) _tokensWorkerConfiaveis.add(String(token));
}

function limparTokensWorkerConfiaveis() {
  _tokensWorkerConfiaveis.clear();
}

function criarAdapterListagem(event) {
  return {
    async getPrinters() {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || !win.webContents) return [];
      const lista = await win.webContents.getPrintersAsync();
      return (lista || []).map((imp) => ({
        name: imp.name,
        displayName: imp.displayName || imp.name,
        description: imp.description,
        status: imp.status,
        isDefault: imp.isDefault === true
      }));
    }
  };
}

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {{ obterDb?: () => any, resolveWindow?: (sender: any) => any }} [opts]
 *   obterDb/resolveWindow: injeção opcional (testes isolados); produção usa database + BrowserWindow.
 */
function registrarCozinhaImpressaoHandlers(ipcMain, opts = {}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') return;

  const resolveWindow = typeof opts.resolveWindow === 'function'
    ? opts.resolveWindow
    : (sender) => BrowserWindow.fromWebContents(sender);
  const obterDb = typeof opts.obterDb === 'function'
    ? opts.obterDb
    : () => {
      try { return require('./backend/database'); } catch (_e) { return null; }
    };

  try { ipcMain.removeHandler(IPC_CANAIS.LISTAR); } catch (_e) { /* ignore */ }
  try { ipcMain.removeHandler(IPC_CANAIS.IMPRIMIR); } catch (_e) { /* ignore */ }
  try { ipcMain.removeHandler(IPC_CANAIS.IMPRIMIR_JOB); } catch (_e) { /* ignore */ }

  ipcMain.handle(IPC_CANAIS.LISTAR, async (event) => {
    validarRemetenteIpc(event, { resolveWindow });
    const adapter = criarAdapterListagem(event);
    const lista = await adapter.getPrinters();
    return {
      success: true,
      total: lista.length,
      impressoras: lista,
      impressao_fisica: false,
      canal: IPC_CANAIS.LISTAR
    };
  });

  // E-02: canal genérico sempre bloqueado (renderer não imprime).
  ipcMain.handle(IPC_CANAIS.IMPRIMIR, async (_event, rawPayload = {}) => {
    try {
      rejeitarImpressaoGenericaPorIpc(rawPayload || {});
    } catch (err) {
      return {
        success: false,
        resultado: 'FALHA',
        codigo: err.codigo || 'IMPRESSAO_IPC_PRINT_BLOQUEADO',
        erro: err.message,
        impressao_fisica: false,
        dry_run: true
      };
    }
    return {
      success: false,
      codigo: 'IMPRESSAO_IPC_PRINT_BLOQUEADO',
      impressao_fisica: false
    };
  });

  // E-03: sessão autenticada no main (JWT) — renderer não escolhe empresa/unidade.
  const CANAL_SESSAO = 'cozinha-impressao:sessao-autenticada';
  const CANAL_CONTEXTO = 'cozinha-impressao:contexto-operacional';
  const CANAL_LOGOUT = 'cozinha-impressao:logout';
  try { ipcMain.removeHandler(CANAL_SESSAO); } catch (_e) { /* ignore */ }
  try { ipcMain.removeHandler(CANAL_CONTEXTO); } catch (_e) { /* ignore */ }
  try { ipcMain.removeHandler(CANAL_LOGOUT); } catch (_e) { /* ignore */ }

  ipcMain.handle(CANAL_SESSAO, async (event, rawPayload = {}) => {
    try {
      validarRemetenteIpc(event, { resolveWindow });
    } catch (err) {
      return {
        success: false,
        codigo: err.codigo || 'IMPRESSAO_IPC_REMETENTE_INVALIDO',
        erro: err.message
      };
    }
    try {
      const {
        estabelecerSessaoApartirDoToken
      } = require('./backend/services/cozinha/cozinhaImpressaoSessaoElectron');
      const db = obterDb();
      const sessao = await estabelecerSessaoApartirDoToken({
        token: rawPayload && rawPayload.token,
        db
      });
      const {
        obterIntegracaoAtiva
      } = require('./backend/services/cozinha/CozinhaImpressaoElectronCicloVida');
      const integ = obterIntegracaoAtiva();
      let contexto = null;
      if (integ && typeof integ.notificarContextoOperacional === 'function') {
        contexto = await integ.notificarContextoOperacional({
          empresa_id: sessao.empresaId,
          unidade_id: sessao.unidadeId
        });
      }
      return {
        success: true,
        sessao: {
          empresaId: sessao.empresaId,
          unidadeId: sessao.unidadeId
        },
        contexto
      };
    } catch (err) {
      return {
        success: false,
        codigo: err.codigo || 'IMPRESSAO_SESSAO_ERRO',
        erro: err.message
      };
    }
  });

  // Contexto: IDs opcionais só são aceitos se coincidirem com a sessão do main.
  ipcMain.handle(CANAL_CONTEXTO, async (event, rawPayload = {}) => {
    try {
      validarRemetenteIpc(event, { resolveWindow });
    } catch (err) {
      return {
        success: false,
        codigo: err.codigo || 'IMPRESSAO_IPC_REMETENTE_INVALIDO',
        erro: err.message
      };
    }
    const {
      obterIntegracaoAtiva
    } = require('./backend/services/cozinha/CozinhaImpressaoElectronCicloVida');
    const {
      validarContextoContraSessaoAutenticada,
      obterSessaoAutenticadaCozinha
    } = require('./backend/services/cozinha/cozinhaImpressaoSessaoElectron');

    try {
      // Rejeita divergência antes mesmo de notificar a integração.
      validarContextoContraSessaoAutenticada(rawPayload || {}, obterSessaoAutenticadaCozinha());
    } catch (err) {
      return {
        success: false,
        codigo: err.codigo || 'IMPRESSAO_CONTEXTO_DIVERGENTE_SESSAO',
        erro: err.message,
        detalhes: err.detalhes || null
      };
    }

    const integ = obterIntegracaoAtiva();
    if (!integ || typeof integ.notificarContextoOperacional !== 'function') {
      return { success: false, codigo: 'IMPRESSAO_INTEGRACAO_AUSENTE' };
    }
    const out = await integ.notificarContextoOperacional(rawPayload || {});
    return { success: out.ok === true, ...out };
  });

  // Logout operacional: para agendador, invalida sessão/contexto; mantém Worker para retomada.
  ipcMain.handle(CANAL_LOGOUT, async (event) => {
    try {
      validarRemetenteIpc(event, { resolveWindow });
    } catch (err) {
      return {
        success: false,
        codigo: err.codigo || 'IMPRESSAO_IPC_REMETENTE_INVALIDO',
        erro: err.message
      };
    }
    const {
      obterIntegracaoAtiva
    } = require('./backend/services/cozinha/CozinhaImpressaoElectronCicloVida');
    const {
      limparSessaoAutenticadaCozinha
    } = require('./backend/services/cozinha/cozinhaImpressaoSessaoElectron');

    const integ = obterIntegracaoAtiva();
    if (integ && typeof integ.aoLogoutOperacional === 'function') {
      const out = await integ.aoLogoutOperacional();
      return { success: out.ok === true, ...out };
    }
    // Sem integração ativa: ainda invalida sessão residual no main.
    limparSessaoAutenticadaCozinha();
    return {
      success: true,
      logout: true,
      integracao_ausente: true,
      sessao: null,
      contexto: null
    };
  });

  // Referência a job — ainda exige Worker token + autorização; não aceita texto arbitrário.
  ipcMain.handle(IPC_CANAIS.IMPRIMIR_JOB, async (event, rawPayload = {}) => {
    try {
      validarRemetenteIpc(event, {
        resolveWindow: (sender) => BrowserWindow.fromWebContents(sender),
        tokenWorker: rawPayload && rawPayload.worker_token,
        tokensConfiaveis: [..._tokensWorkerConfiaveis]
      });
      const ref = sanitizarReferenciaJobImpressao(rawPayload || {});
      if (!isImpressaoFisicaAutorizada({
        autorizarSpoolerReal: ref.autorizar_spooler_real
      })) {
        return {
          success: false,
          resultado: 'SIMULADO',
          codigo: 'IMPRESSAO_FISICA_NAO_AUTORIZADA',
          erro: 'Impressão física desabilitada. Dry-run não declara ACEITA.',
          impressao_fisica: false,
          dry_run: true,
          job_id: ref.job_id
        };
      }
      // Print real via IPC ainda não executa daqui: o caminho físico é o adapter
      // in-process do Worker (E-03). Este canal só valida autorização/canonicidade.
      return {
        success: false,
        resultado: 'FALHA',
        codigo: 'IMPRESSAO_USE_WORKER_ADAPTER',
        erro: 'Use o adapter ELECTRON de produção injetado no Worker (in-process).',
        impressao_fisica: false,
        job_id: ref.job_id
      };
    } catch (err) {
      return {
        success: false,
        resultado: 'FALHA',
        codigo: err.codigo || 'IMPRESSAO_IPC_ERRO',
        erro: err.message,
        impressao_fisica: false
      };
    }
  });
}

module.exports = {
  registrarCozinhaImpressaoHandlers,
  registrarTokenWorkerConfiavel,
  limparTokensWorkerConfiaveis,
  IPC_CANAIS
};
