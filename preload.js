const { contextBridge, ipcRenderer } = require('electron');
const os = require('os');

function obterDestinoClienteRemoto() {
  const arg = process.argv.find((item) => item.startsWith('--cds-modo-cliente='));
  if (!arg) {
    return null;
  }
  return arg.replace('--cds-modo-cliente=', '');
}

const destinoClienteRemoto = obterDestinoClienteRemoto();

contextBridge.exposeInMainWorld('electronAPI', {
  app: 'cds-sistemas',

  getTerminalInfo: () => ({
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch()
  }),

  forcarReflow: () => ipcRenderer.send('forcar-reflow'),

  /** CDS-ERP-PDV-JANELA-INDEPENDENTE-01 — abre/foca janela PDV independente. */
  abrirPdv: (opcoes) => ipcRenderer.invoke('cds:abrir-pdv', opcoes || {}),

  /** Foca o ERP já aberto; não cria segunda janela ERP se já existir. */
  abrirErp: (opcoes) => ipcRenderer.invoke('cds:abrir-erp', opcoes || {}),

  abrirComprovante: (html, options) =>
    ipcRenderer.send('abrir-comprovante', html, options || {}),

  selecionarPastaBackup: () =>
    ipcRenderer.invoke('selecionar-pasta-backup'),

  listarImpressoras: () =>
    ipcRenderer.invoke('listar-impressoras'),

  imprimirDANFESilencioso: (html, deviceName) =>
    ipcRenderer.invoke('imprimir-danfe-silencioso', html, deviceName),

  /**
   * Sprint 06 Bloco E — cozinha.
   * Renderer só lista impressoras. Print genérico bloqueado (E-02).
   * Print físico: Worker + adapter ELECTRON de produção (in-process).
   */
  cozinhaImpressao: {
    listarImpressoras: () => ipcRenderer.invoke('cozinha-impressao:listar-impressoras'),
    /** @deprecated Sempre rejeitado — não use do renderer. */
    imprimir: (payload) => ipcRenderer.invoke('cozinha-impressao:imprimir', payload || {}),
    /** Estabelece sessão no main a partir do JWT (retomada pós-login). */
    estabelecerSessao: (payload) =>
      ipcRenderer.invoke('cozinha-impressao:sessao-autenticada', payload || {}),
    /** Notifica contexto operacional (IDs só aceitos se coincidirem com a sessão). */
    notificarContexto: (payload) =>
      ipcRenderer.invoke('cozinha-impressao:contexto-operacional', payload || {}),
    /** Logout operacional: invalida sessão/contexto e para o agendador no main. */
    logout: () => ipcRenderer.invoke('cozinha-impressao:logout')
  },

  fecharJanela: () => window.close(),

  obterModoEstacao: () => ipcRenderer.invoke('rede-obter-modo-estacao'),
  voltarModoLocal: () => ipcRenderer.invoke('rede-voltar-modo-local'),
  salvarModoEstacao: (config) => ipcRenderer.invoke('rede-salvar-modo-estacao', config),
  obterHostnameEstacao: () => ipcRenderer.invoke('rede-obter-hostname'),
  estaEmModoClienteRemoto: () => ipcRenderer.invoke('rede-esta-em-modo-cliente'),
  obterServidorRemoto: () => destinoClienteRemoto,

  // RC3.16.5 — Diagnóstico Electron
  obterDiagnosticoElectron: (extra) => ipcRenderer.invoke('electron-diagnostico', extra || {}),
  abrirDiagnosticoElectron: (extra) => ipcRenderer.invoke('electron-diagnostico-abrir', extra || {}),
  copiarDiagnosticoElectron: (extra) => ipcRenderer.invoke('electron-diagnostico-copiar', extra || {}),

  // RC3.5.0 — Portal Nacional da NF-e (recuperação oficial)
  portalNfe: {
    validar: () => ipcRenderer.invoke('portal-nfe-validar'),
    abrir: (payload) => ipcRenderer.invoke('portal-nfe-abrir', payload || {}),
    fechar: (payload) => ipcRenderer.invoke('portal-nfe-fechar', payload || {}),
    status: () => ipcRenderer.invoke('portal-nfe-status'),
    download: () => ipcRenderer.invoke('portal-nfe-download'),
    abrirPasta: (payload) => ipcRenderer.invoke('portal-nfe-abrir-pasta', payload || {}),
    sucesso: (payload) => ipcRenderer.invoke('portal-nfe-sucesso', payload || {}),
    dirDownloads: () => ipcRenderer.invoke('portal-nfe-dir-downloads'),
    onEvento: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on('portal-nfe-evento', handler);
      return () => ipcRenderer.removeListener('portal-nfe-evento', handler);
    }
  }
});
