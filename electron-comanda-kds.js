'use strict';

const http = require('http');
const https = require('https');
const { htmlComanda } = require('./backend/services/cozinha/CozinhaComandaRenderer');

function requisitar(baseUrl, caminho, sessao, method = 'GET', body) {
  const url = new URL(caminho, `${baseUrl}/`);
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = transport.request(url, {
      method,
      headers: {
        Authorization: `Bearer ${sessao.token}`,
        'X-Empresa-Id': String(sessao.empresaId),
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let data;
        try { data = JSON.parse(raw); } catch (err) {
          reject(new Error('Resposta inválida do servidor de impressão.'));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(data.mensagem || data.error || `Erro HTTP ${res.statusCode}.`);
          err.statusCode = res.statusCode;
          reject(err);
          return;
        }
        resolve(data);
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('Tempo de comunicação esgotado.')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function criarImpressaoComanda({ requisitarBackend, imprimir }) {
  const emCurso = new Set();
  return async function imprimirSnapshot(snapshotId, sessao) {
    if (!Number.isInteger(snapshotId) || snapshotId <= 0) throw new Error('Snapshot inválido.');
    if (emCurso.has(snapshotId)) throw new Error('Impressão já em andamento.');
    emCurso.add(snapshotId);
    let tentativa;
    try {
      try {
        tentativa = await requisitarBackend(`/api/pedidos/comanda-kds/${snapshotId}/tentativas`, sessao, 'POST', {});
      } catch (err) {
        if (err.statusCode) throw err;
        throw new Error(`Não foi possível confirmar o registro da tentativa; verifique antes de repetir: ${err.message}`);
      }
      const base = `/api/pedidos/comanda-kds/${snapshotId}/tentativas/${tentativa.tentativa_id}`;
      let estado;
      let detalhe = null;
      try {
        const configuracao = await requisitarBackend('/api/configuracoes/impressora_cupom', sessao);
        if (!configuracao.caminho) throw new Error('Impressora de cupom não configurada.');
        await imprimir(htmlComanda(tentativa.snapshot), configuracao.caminho);
        estado = 'ACEITA_PELO_SPOOLER';
      } catch (err) {
        if (err.codigo === 'RESULTADO_INCERTO') {
          throw new Error('Resultado da impressão desconhecido; verifique a impressora antes de repetir.');
        }
        estado = 'FALHA';
        detalhe = err.message || 'Falha ao encaminhar impressão.';
      }
      try {
        await requisitarBackend(base, sessao, 'POST', { estado, detalhe });
      } catch (err) {
        throw new Error(`Resultado ${estado} não foi registrado. Não repita sem verificar: ${err.message}`);
      }
      return { estado, detalhe };
    } finally {
      emCurso.delete(snapshotId);
    }
  };
}

function imprimirNoElectron(BrowserWindow, html, deviceName) {
  if (process.env.CDS_TEST_ISOLATION === '1') {
    throw new Error('Impressão física bloqueada em ambiente de teste.');
  }
  const win = new BrowserWindow({
    show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  return Promise.resolve()
    .then(() => win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`))
    .then(() => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const err = new Error('Spooler não respondeu.');
        err.codigo = 'RESULTADO_INCERTO';
        reject(err);
      }, 60000);
      try {
        win.webContents.print({ silent: true, deviceName, printBackground: true }, (ok, motivo) => {
          clearTimeout(timer);
          if (ok) resolve();
          else reject(new Error(motivo || 'Falha do spooler.'));
        });
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    }))
    .finally(() => { if (!win.isDestroyed()) win.destroy(); });
}

function registrarIpcComanda({ ipcMain, obterJanela, obterBaseUrl, imprimirSnapshot }) {
  const sessoes = new Map();
  function validarRemetente(event) {
    const janela = obterJanela();
    const baseUrl = obterBaseUrl();
    if (!janela || janela.isDestroyed() || event.sender !== janela.webContents
      || !baseUrl || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Janela de impressão não autorizada.');
    }
    if (new URL(event.senderFrame.url).origin !== new URL(baseUrl).origin) {
      throw new Error('Origem de impressão não autorizada.');
    }
  }
  ipcMain.handle('comanda-kds:sessao', (event, sessao) => {
    validarRemetente(event);
    const token = sessao && sessao.token;
    const empresaId = Number(sessao && sessao.empresaId);
    if (typeof token !== 'string' || !token.trim() || !Number.isInteger(empresaId) || empresaId <= 0) {
      sessoes.delete(event.sender.id);
      throw new Error('Sessão de impressão inválida.');
    }
    sessoes.set(event.sender.id, { token, empresaId });
    return { success: true };
  });
  ipcMain.handle('comanda-kds:imprimir', async (event, snapshotId) => {
    validarRemetente(event);
    const sessao = sessoes.get(event.sender.id);
    if (!sessao) throw new Error('Sessão de impressão indisponível.');
    sessoes.delete(event.sender.id);
    return imprimirSnapshot(snapshotId, sessao);
  });
}

module.exports = { htmlComanda, requisitar, criarImpressaoComanda, imprimirNoElectron, registrarIpcComanda };
