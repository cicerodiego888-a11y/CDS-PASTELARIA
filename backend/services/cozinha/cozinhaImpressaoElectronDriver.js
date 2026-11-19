/**
 * Driver Electron — Sprint 06 Bloco E (correção auditoria).
 * Separado do FAKE. Dry-run → SIMULADO (nunca ACEITA_PELO_SPOOLER).
 */
'use strict';

const {
  ImpressaoDriver,
  RESULTADOS_DRIVER,
  assertResultadoDriver
} = require('./cozinhaImpressaoDriver');
const { erroImpressao, normalizarVias, parsePositiveInteger } = require('./cozinhaImpressaoContratos');
const { renderizarTexto } = require('./CozinhaImpressaoRenderer');
const {
  enviarParaSpoolerCozinha,
  listarImpressorasCozinha,
  isImpressaoFisicaAutorizada
} = require('./cozinhaImpressaoElectronBridge');

class ElectronImpressaoDriver extends ImpressaoDriver {
  /**
   * @param {object} [opts]
   * @param {object} [opts.adapter] — { getPrinters, print }
   * @param {boolean} [opts.autorizarSpoolerReal]
   * @param {number} [opts.timeoutMs]
   * @param {string} [opts.deviceName]
   * @param {boolean} [opts.producao] — marca driver de produção (E-03)
   */
  constructor(opts = {}) {
    super();
    this.adapter = opts.adapter || null;
    this.autorizarSpoolerReal = opts.autorizarSpoolerReal === true;
    this.timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 15000;
    this.deviceNameOverride = opts.deviceName != null ? String(opts.deviceName) : null;
    this.producao = opts.producao === true;
    this.chamadas = [];
    this._seq = 0;
  }

  get nome() {
    return 'ELECTRON';
  }

  get impressaoFisica() {
    return false;
  }

  get spoolerRealHabilitado() {
    return isImpressaoFisicaAutorizada({ autorizarSpoolerReal: this.autorizarSpoolerReal });
  }

  get isProducao() {
    return this.producao === true;
  }

  async listarImpressoras() {
    return listarImpressorasCozinha(this.adapter);
  }

  resolverDeviceName(contexto = {}) {
    if (this.deviceNameOverride) return this.deviceNameOverride;
    if (contexto.estacao && contexto.estacao.device_name) {
      return String(contexto.estacao.device_name);
    }
    if (contexto.device_name) return String(contexto.device_name);
    if (contexto.deviceName) return String(contexto.deviceName);
    const job = contexto.job || {};
    if (job.device_name) return String(job.device_name);
    return '';
  }

  async imprimir(contexto = {}) {
    this._seq += 1;
    const job = contexto.job || {};
    const deviceName = this.resolverDeviceName(contexto);
    const vias = normalizarVias(job.vias != null ? job.vias : 1);
    const snapshotRaw = job.payload_snapshot != null
      ? job.payload_snapshot
      : (job.snapshot || null);

    if (!parsePositiveInteger(job.id)) {
      return assertResultadoDriver({
        resultado: RESULTADOS_DRIVER.FALHA,
        erro: 'ELECTRON: job.id persistido obrigatório',
        impressao_fisica: false,
        driver: 'ELECTRON'
      });
    }

    if (!snapshotRaw) {
      return assertResultadoDriver({
        resultado: RESULTADOS_DRIVER.FALHA,
        erro: 'ELECTRON: snapshot canônico ausente no job persistido',
        impressao_fisica: false,
        driver: 'ELECTRON'
      });
    }

    // Snapshot imutável: render a partir do persistido; nunca aceita texto externo.
    const render = renderizarTexto(snapshotRaw, {
      largura_mm: job.largura_mm
        || (job.snapshot && job.snapshot.largura_mm)
        || (typeof snapshotRaw === 'object' ? snapshotRaw.largura_mm : undefined)
    });

    this.chamadas.push({
      seq: this._seq,
      job_id: job.id,
      deviceName,
      vias,
      largura_mm: render.largura_mm,
      dry_run: !this.spoolerRealHabilitado,
      producao: this.producao,
      em: new Date().toISOString()
    });

    if (!deviceName) {
      return assertResultadoDriver({
        resultado: RESULTADOS_DRIVER.FALHA,
        erro: 'ELECTRON: device_name da estação não configurado',
        impressao_fisica: false,
        driver: 'ELECTRON'
      });
    }

    if (!this.adapter) {
      return assertResultadoDriver({
        resultado: RESULTADOS_DRIVER.FALHA,
        erro: 'ELECTRON: adapter de produção/IPC ausente',
        impressao_fisica: false,
        driver: 'ELECTRON'
      });
    }

    let out;
    try {
      out = await enviarParaSpoolerCozinha({
        deviceName,
        texto: render.texto,
        vias,
        job_id: parsePositiveInteger(job.id),
        largura_mm: render.largura_mm,
        timeout_ms: this.timeoutMs
      }, {
        adapter: this.adapter,
        autorizarSpoolerReal: this.autorizarSpoolerReal,
        origem: 'worker-canonico'
      });
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      return assertResultadoDriver({
        resultado: RESULTADOS_DRIVER.INCERTO,
        erro: `ELECTRON: ${msg}`,
        impressao_fisica: false,
        driver: 'ELECTRON'
      });
    }

    return assertResultadoDriver({
      resultado: out.resultado,
      spooler_job_token: out.spooler_job_token,
      erro: out.erro,
      dry_run: out.dry_run === true,
      impressao_fisica: false,
      driver: 'ELECTRON'
    });
  }
}

function criarElectronDriver(opts = {}) {
  return new ElectronImpressaoDriver(opts);
}

function criarAdapterElectronMock(opts = {}) {
  const printers = Array.isArray(opts.printers) ? opts.printers : [
    { name: 'Cozinha-Termica-80', isDefault: true, status: 0 }
  ];
  const modo = String(opts.modo || 'sucesso').toLowerCase();
  const delayMs = Number(opts.delayMs) > 0 ? Number(opts.delayMs) : 0;
  const prints = [];

  return {
    tipo: 'mock',
    printers,
    prints,
    async getPrinters() {
      return printers.map((p) => ({ ...p }));
    },
    async print(payload) {
      prints.push({ ...payload, em: new Date().toISOString() });
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (modo === 'timeout') {
        const err = new Error('mock timeout');
        err.codigo = 'TIMEOUT';
        throw err;
      }
      if (modo === 'falha-comunicacao') {
        throw new Error('IPC canal indisponível');
      }
      if (modo === 'falha') {
        throw new Error('spooler recusou (mock)');
      }
      if (modo === 'hang') {
        return new Promise(() => {});
      }
      return { token: `mock-spool:${payload.deviceName}:${prints.length}` };
    }
  };
}

module.exports = {
  ElectronImpressaoDriver,
  criarElectronDriver,
  criarAdapterElectronMock,
  erroImpressao
};
