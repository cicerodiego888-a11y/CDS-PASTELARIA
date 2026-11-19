/**
 * Ponte local Electron — Sprint 06 Bloco E (correção auditoria).
 * Isolada da impressão comercial/fiscal. Sem HTTP/LAN.
 *
 * E-01: dry-run → SIMULADO (nunca ACEITA / ACEITA_PELO_SPOOLER).
 * E-02: print físico só com job canônico; IPC genérico bloqueado.
 */
'use strict';

const { erroImpressao, parsePositiveInteger } = require('./cozinhaImpressaoContratos');
const { RESULTADOS_DRIVER } = require('./cozinhaImpressaoDriver');

const IPC_CANAIS = Object.freeze({
  LISTAR: 'cozinha-impressao:listar-impressoras',
  /** Canal legado/genérico — sempre rejeitado para print físico. */
  IMPRIMIR: 'cozinha-impressao:imprimir',
  /** Print só com referência a job persistido (Worker confiável). */
  IMPRIMIR_JOB: 'cozinha-impressao:imprimir-job'
});

function isImpressaoFisicaAutorizada(opts = {}) {
  const envOk = String(process.env.CDS_COZINHA_IMPRESSAO_FISICA_AUTORIZADA || '') === '1';
  const optOk = opts.autorizarSpoolerReal === true || opts.autorizar_spooler_real === true;
  if (String(process.env.CDS_TEST_ISOLATION || '') === '1') return false;
  if (String(process.env.CDS_BLOQUEAR_BANCO_OFICIAL || '') === '1'
    && String(process.env.CDS_COZINHA_IMPRESSAO_FISICA_AUTORIZADA || '') !== '1') {
    return false;
  }
  return envOk && optOk;
}

/**
 * Valida remetente IPC (webContents de janela conhecida da app).
 * @param {object} event — evento Electron IPC
 * @param {{ permitirSemJanela?: boolean, tokensConfiaveis?: string[] }} [opts]
 */
function validarRemetenteIpc(event, opts = {}) {
  if (opts.tokenWorker && Array.isArray(opts.tokensConfiaveis)) {
    if (opts.tokensConfiaveis.includes(String(opts.tokenWorker))) {
      return { ok: true, origem: 'worker-token' };
    }
  }
  const sender = event && event.sender;
  if (!sender || (typeof sender.isDestroyed === 'function' && sender.isDestroyed())) {
    throw erroImpressao(
      'Remetente IPC inválido ou destruído.',
      403,
      'IMPRESSAO_IPC_REMETENTE_INVALIDO'
    );
  }
  // BrowserWindow.fromWebContents injetável nos testes via opts.resolveWindow
  const resolveWindow = typeof opts.resolveWindow === 'function'
    ? opts.resolveWindow
    : null;
  let win = null;
  if (resolveWindow) {
    win = resolveWindow(sender);
  } else {
    try {
      // lazy require para não quebrar testes Node sem Electron
      const { BrowserWindow } = require('electron');
      win = BrowserWindow.fromWebContents(sender);
    } catch (_e) {
      win = null;
    }
  }
  if (!win && !opts.permitirSemJanela) {
    throw erroImpressao(
      'Remetente IPC não pertence a janela autorizada da aplicação.',
      403,
      'IMPRESSAO_IPC_REMETENTE_INVALIDO'
    );
  }
  return { ok: true, origem: 'browser-window', window_id: win && win.id };
}

/**
 * Payload genérico do renderer (texto/device arbitrários) — NÃO autoriza print.
 * Mantido só para rejeição explícita / listagem auxiliar.
 */
function rejeitarImpressaoGenericaPorIpc(raw = {}) {
  throw erroImpressao(
    'Impressão física de cozinha não pode ser disparada por IPC genérico do renderer. '
      + 'Use o Worker com job persistido e snapshot canônico.',
    403,
    'IMPRESSAO_IPC_PRINT_BLOQUEADO',
    {
      detalhes: {
        recebeu_texto: raw.texto != null || raw.conteudo != null,
        recebeu_device: raw.deviceName != null || raw.device_name != null
      }
    }
  );
}

/**
 * Referência canônica a job persistido (único caminho físico permitido via IPC).
 */
function sanitizarReferenciaJobImpressao(raw = {}) {
  const proibidos = [
    'texto', 'conteudo', 'payload_snapshot', 'snapshot', 'itens',
    'preco', 'danfe', 'nfce', 'tef'
  ];
  for (const k of proibidos) {
    if (Object.prototype.hasOwnProperty.call(raw, k)) {
      throw erroImpressao(
        `Campo proibido na referência de job IPC: ${k}`,
        400,
        'IMPRESSAO_IPC_CAMPO_PROIBIDO',
        { detalhes: { campo: k } }
      );
    }
  }

  const jobId = parsePositiveInteger(raw.jobId != null ? raw.jobId : raw.job_id);
  const empresaId = parsePositiveInteger(raw.empresaId != null ? raw.empresaId : raw.empresa_id);
  const unidadeId = parsePositiveInteger(raw.unidadeId != null ? raw.unidadeId : raw.unidade_id);
  const workerId = String(raw.workerId != null ? raw.workerId : raw.worker_id || '').trim();

  if (!jobId || !empresaId || !unidadeId || !workerId) {
    throw erroImpressao(
      'Referência de job incompleta (job_id, empresa_id, unidade_id, worker_id).',
      400,
      'IMPRESSAO_JOB_REF_INVALIDA'
    );
  }

  return Object.freeze({
    job_id: jobId,
    empresa_id: empresaId,
    unidade_id: unidadeId,
    worker_id: workerId,
    autorizar_spooler_real: raw.autorizarSpoolerReal === true || raw.autorizar_spooler_real === true
  });
}

/**
 * @deprecated Use sanitizarReferenciaJobImpressao / rejeitarImpressaoGenericaPorIpc.
 * Mantido para testes de rejeição de payload arbitrário.
 */
function sanitizarPayloadImpressao(raw = {}) {
  // Qualquer tentativa de payload com texto+device é bloqueio E-02.
  if (raw && (raw.texto != null || raw.conteudo != null)) {
    rejeitarImpressaoGenericaPorIpc(raw);
  }
  return sanitizarReferenciaJobImpressao(raw);
}

async function listarImpressorasCozinha(adapter) {
  if (!adapter || typeof adapter.getPrinters !== 'function') {
    throw erroImpressao(
      'Adapter Electron ausente para listar impressoras.',
      500,
      'IMPRESSAO_ELECTRON_ADAPTER_AUSENTE'
    );
  }
  const lista = await adapter.getPrinters();
  const arr = Array.isArray(lista) ? lista : [];
  return {
    success: true,
    total: arr.length,
    impressoras: arr.map((p) => ({
      name: String(p.name || p.deviceName || ''),
      displayName: p.displayName != null ? String(p.displayName) : String(p.name || ''),
      isDefault: p.isDefault === true,
      status: p.status != null ? p.status : null
    })).filter((p) => p.name),
    impressao_fisica: false,
    canal: IPC_CANAIS.LISTAR
  };
}

/**
 * Envio ao spooler a partir de conteúdo já renderizado pelo Worker (snapshot canônico).
 * Dry-run → SIMULADO (nunca ACEITA).
 */
async function enviarParaSpoolerCozinha(entrada = {}, opts = {}) {
  const adapter = opts.adapter || entrada.adapter;
  if (!adapter || typeof adapter.print !== 'function') {
    throw erroImpressao(
      'Adapter Electron ausente para impressão.',
      500,
      'IMPRESSAO_ELECTRON_ADAPTER_AUSENTE'
    );
  }

  const jobId = parsePositiveInteger(entrada.job_id != null ? entrada.job_id : entrada.jobId);
  const deviceName = String(entrada.deviceName != null ? entrada.deviceName : entrada.device_name || '').trim();
  const texto = String(entrada.texto != null ? entrada.texto : '');
  const vias = parsePositiveInteger(entrada.vias) || 1;
  const larguraMm = entrada.largura_mm != null ? Number(entrada.largura_mm) : null;
  const timeoutMs = Number(entrada.timeoutMs != null ? entrada.timeoutMs : entrada.timeout_ms);
  const limTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000;

  if (!jobId) {
    throw erroImpressao(
      'job_id obrigatório para envio ao spooler de cozinha.',
      400,
      'IMPRESSAO_JOB_ID_OBRIGATORIO'
    );
  }
  if (!deviceName) {
    throw erroImpressao('deviceName obrigatório.', 400, 'IMPRESSAO_DEVICE_OBRIGATORIO');
  }
  if (!texto.trim()) {
    throw erroImpressao('texto de impressão vazio.', 400, 'IMPRESSAO_TEXTO_VAZIO');
  }
  // Conteúdo deve ter origem canônica (Worker), não IPC renderer.
  if (opts.origem !== 'worker-canonico' && opts.origem !== 'teste-mock') {
    throw erroImpressao(
      'Envio ao spooler exige origem worker-canonico (job persistido + snapshot).',
      403,
      'IMPRESSAO_ORIGEM_NAO_CANONICA'
    );
  }

  const autorizada = (
    process.env.CDS_TEST_ISOLATION === '1' && opts.__testeForcarSpooler === true
  ) || isImpressaoFisicaAutorizada(opts);

  const printers = await listarImpressorasCozinha(adapter);
  const existe = printers.impressoras.some((p) => p.name === deviceName);
  if (!existe) {
    return {
      resultado: RESULTADOS_DRIVER.FALHA,
      spooler_job_token: null,
      erro: `Impressora inexistente: ${deviceName}`,
      impressao_fisica: false,
      vias_enviadas: 0,
      dry_run: !autorizada
    };
  }

  if (!autorizada) {
    // E-01: simulação distinta — NÃO declara ACEITA.
    return {
      resultado: RESULTADOS_DRIVER.SIMULADO,
      spooler_job_token: null,
      erro: 'SIMULADO: impressão real desabilitada (dry-run). Sem aceitação do spooler.',
      impressao_fisica: false,
      vias_enviadas: 0,
      dry_run: true,
      aviso: 'Requer CDS_COZINHA_IMPRESSAO_FISICA_AUTORIZADA=1 + autorizarSpoolerReal=true'
    };
  }

  const tokens = [];
  try {
    for (let i = 1; i <= vias; i += 1) {
      const printPromise = adapter.print({
        deviceName,
        texto,
        silent: true,
        via: i,
        vias,
        job_id: jobId,
        largura_mm: larguraMm
      });
      const result = await Promise.race([
        printPromise,
        new Promise((_, reject) => {
          setTimeout(
            () => reject(Object.assign(new Error('Timeout no spooler Electron'), { codigo: 'TIMEOUT' })),
            limTimeout
          );
        })
      ]);
      tokens.push(result && result.token ? String(result.token) : `electron:${jobId}:${i}`);
    }
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (err && (err.codigo === 'TIMEOUT' || /timeout/i.test(msg))) {
      return {
        resultado: RESULTADOS_DRIVER.INCERTO,
        spooler_job_token: tokens[0] || null,
        erro: `Timeout Electron: ${msg}`,
        impressao_fisica: false,
        vias_enviadas: tokens.length,
        dry_run: false
      };
    }
    if (/communica|ECONN|ENOTFOUND|IPC|canal|adapter/i.test(msg)) {
      return {
        resultado: RESULTADOS_DRIVER.FALHA,
        spooler_job_token: null,
        erro: `Falha de comunicação Electron: ${msg}`,
        impressao_fisica: false,
        vias_enviadas: tokens.length,
        dry_run: false
      };
    }
    return {
      resultado: RESULTADOS_DRIVER.INCERTO,
      spooler_job_token: tokens[0] || null,
      erro: `Resultado inconclusivo Electron: ${msg}`,
      impressao_fisica: false,
      vias_enviadas: tokens.length,
      dry_run: false
    };
  }

  return {
    resultado: RESULTADOS_DRIVER.ACEITA,
    spooler_job_token: tokens[tokens.length - 1] || `electron:${jobId}`,
    erro: null,
    impressao_fisica: false,
    vias_enviadas: vias,
    dry_run: false
  };
}

module.exports = {
  IPC_CANAIS,
  RESULTADOS_DRIVER,
  isImpressaoFisicaAutorizada,
  validarRemetenteIpc,
  rejeitarImpressaoGenericaPorIpc,
  sanitizarReferenciaJobImpressao,
  sanitizarPayloadImpressao,
  listarImpressorasCozinha,
  enviarParaSpoolerCozinha
};
