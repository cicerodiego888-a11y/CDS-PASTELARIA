/**
 * Integração de produção Worker ↔ Electron — Sprint 06 Bloco E (E-03).
 *
 * Instancia o adapter real (webContents.getPrintersAsync / print) e injeta
 * o driver ELECTRON no Worker. FAKE permanece isolado para testes.
 *
 * Impressão física continua desabilitada por padrão.
 */
'use strict';

const { criarFakeDriver } = require('./cozinhaImpressaoDriver');
const { criarElectronDriver } = require('./cozinhaImpressaoElectronDriver');
const { isImpressaoFisicaAutorizada } = require('./cozinhaImpressaoElectronBridge');
const { erroImpressao } = require('./cozinhaImpressaoContratos');

/**
 * Adapter Electron real (processo main). Não usa IPC do renderer para print.
 * @param {object} deps
 * @param {function(): object|null} deps.obterWebContents — retorna webContents vivo
 * @param {function(object): Promise<object>} [deps.criarJanelaImpressao] — opcional
 */
function criarAdapterElectronProducao(deps = {}) {
  if (typeof deps.obterWebContents !== 'function') {
    throw erroImpressao(
      'Adapter de produção exige obterWebContents().',
      500,
      'IMPRESSAO_ADAPTER_PRODUCAO_INVALIDO'
    );
  }

  return {
    tipo: 'electron-producao',
    async getPrinters() {
      const wc = deps.obterWebContents();
      if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) {
        return [];
      }
      if (typeof wc.getPrintersAsync !== 'function') {
        throw new Error('webContents.getPrintersAsync indisponível');
      }
      const lista = await wc.getPrintersAsync();
      return (lista || []).map((imp) => ({
        name: imp.name,
        displayName: imp.displayName || imp.name,
        description: imp.description,
        status: imp.status,
        isDefault: imp.isDefault === true
      }));
    },
    async print({ deviceName, texto, silent }) {
      // Print em janela oculta dedicada (mesmo processo main — sem renderer genérico).
      let win = null;
      let wc = null;
      if (typeof deps.criarJanelaImpressao === 'function') {
        win = await deps.criarJanelaImpressao();
        wc = win && win.webContents;
      } else {
        wc = deps.obterWebContents();
      }
      if (!wc || typeof wc.print !== 'function') {
        throw new Error('webContents.print indisponível no adapter de produção');
      }

      const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  @page { margin: 0; }
  body { margin: 0; font-family: monospace; white-space: pre-wrap; font-size: 12px; }
</style></head><body>${String(texto)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')}</body></html>`;

      if (typeof wc.loadURL === 'function') {
        await wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      }

      return new Promise((resolve, reject) => {
        wc.print(
          {
            silent: silent !== false,
            deviceName: deviceName || undefined,
            printBackground: false
          },
          (success, failureReason) => {
            if (win && typeof win.destroy === 'function') {
              try { win.destroy(); } catch (_e) { /* ignore */ }
            }
            if (!success) {
              reject(new Error(failureReason || 'webContents.print falhou'));
              return;
            }
            resolve({ token: `electron-prod:${deviceName}:${Date.now()}` });
          }
        );
      });
    }
  };
}

/**
 * Driver ELECTRON de produção injetável no Worker.
 */
function criarDriverElectronProducao(opts = {}) {
  const adapter = opts.adapter || criarAdapterElectronProducao(opts);
  if (adapter.tipo !== 'electron-producao' && opts.exigirTipoProducao !== false) {
    // Permite injeção de adapter produção-compatível em testes de ligação.
    if (!opts.permitirAdapterCompat) {
      throw erroImpressao(
        'Driver de produção exige adapter electron-producao.',
        500,
        'IMPRESSAO_ADAPTER_PRODUCAO_INVALIDO'
      );
    }
  }
  return criarElectronDriver({
    adapter,
    autorizarSpoolerReal: opts.autorizarSpoolerReal === true,
    timeoutMs: opts.timeoutMs,
    deviceName: opts.deviceName,
    producao: true
  });
}

/**
 * Fábrica usada pelo bootstrap do Worker em produção.
 * @param {'FAKE'|'ELECTRON'} [modo]
 */
function criarDriverParaWorker(modo = 'FAKE', opts = {}) {
  const m = String(modo || 'FAKE').toUpperCase();
  if (m === 'ELECTRON') {
    return criarDriverElectronProducao(opts);
  }
  return criarFakeDriver(opts.fake || { modo: 'sucesso' });
}

/**
 * Evidência de ligação produção: retorna metadados do driver injetado.
 */
function descreverIntegracaoProducao(driver) {
  if (!driver) {
    return { ok: false, motivo: 'driver ausente' };
  }
  return {
    ok: driver.nome === 'ELECTRON' && driver.isProducao === true,
    driver: driver.nome,
    producao: driver.isProducao === true,
    adapter_tipo: driver.adapter && driver.adapter.tipo,
    spooler_real_habilitado: typeof driver.spoolerRealHabilitado === 'boolean'
      ? driver.spoolerRealHabilitado
      : isImpressaoFisicaAutorizada({ autorizarSpoolerReal: !!driver.autorizarSpoolerReal }),
    impressao_fisica: driver.impressaoFisica === true
  };
}

module.exports = {
  criarAdapterElectronProducao,
  criarDriverElectronProducao,
  criarDriverParaWorker,
  descreverIntegracaoProducao
};
