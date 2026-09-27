/**
 * Sincronização operacional Mercado Pago (MBC-16.3).
 *
 * Contrato oficial: Settlement Report (assíncrono) — sem cursor de transações do MP.
 * Paginação modelada como sequência de arquivos/relatórios processados.
 * Checkpoint INTERNO (CDS) em sincronizacao_bancaria.cursor_atual — não é cursor oficial MP.
 *
 * Regra: só avança checkpoint após persistência bem-sucedida (MBC-03).
 *
 * @module motores/bancario/services/MercadoPagoSincronizacaoService
 */
'use strict';

const {
  ERROS,
  CODIGO_PROVIDER,
  STATUS_SINCRONIZACAO,
  CATEGORIA_ERRO_PROVIDER,
  erroMbc
} = require('../contracts/constantes');
const { obterSecretStore } = require('../secrets/EncryptedLocalSecretStore');
const ConfiguracaoIntegracaoBancariaService = require('./ConfiguracaoIntegracaoBancariaService');
const {
  STATUS_OAUTH,
  obterStatus: obterStatusOauth,
  lerPayloadOauth,
  tokenExpirado
} = require('./MercadoPagoOAuthService');
const { MercadoPagoApiClient } = require('../providers/mercadopago/MercadoPagoApiClient');
const {
  COLUNAS_CONFIG,
  mapearCsvParaDtos
} = require('../providers/mercadopago/MercadoPagoAccountMoneyMapper');
const MercadoPagoPersistenciaService = require('./MercadoPagoPersistenciaService');
const {
  garantirConfigRelatorio,
  periodoPadrao,
  SALDO_NAO_DISPONIVEL
} = require('./MercadoPagoLeituraService');

/** Checkpoint interno CDS — NÃO é cursor oficial do Mercado Pago. */
const CHECKPOINT_KIND = 'mp_settlement_checkpoint_v1';
/** Limite oficial documentado do Settlement Report (Account money). */
const MAX_DIAS_PERIODO_OFICIAL = 60;
const MAX_ARQUIVOS_POR_SYNC = 50;
const MAX_RETRY_EXTRA = 2;
const RETRY_AFTER_CAP_MS = 3000;
/** Poll operacional: Settlement Report é assíncrono (pending → processed). */
const POLL_ATTEMPTS_PADRAO = 12;
const POLL_WAIT_MS_PADRAO = 3000;

function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

function agoraIso() {
  return new Date().toISOString();
}

function toIsoZ(d) {
  return new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Valida período solicitado conforme contrato oficial (máx. 60 dias).
 */
function validarPeriodoSettlement(beginDate, endDate) {
  const begin = new Date(beginDate);
  const end = new Date(endDate);
  if (!Number.isFinite(begin.getTime()) || !Number.isFinite(end.getTime())) {
    throw erroMbc(ERROS.DATA_INVALIDA, 'Data inicial ou final inválida para Settlement Report.', 400);
  }
  if (begin.getTime() > end.getTime()) {
    throw erroMbc(ERROS.PERIODO_INVALIDO, 'Período inválido: data inicial posterior à final.', 400);
  }
  const dias = (end.getTime() - begin.getTime()) / (24 * 60 * 60 * 1000);
  if (dias > MAX_DIAS_PERIODO_OFICIAL) {
    throw erroMbc(
      ERROS.PERIODO_INVALIDO,
      `Período acima do limite oficial do Settlement Report (${MAX_DIAS_PERIODO_OFICIAL} dias).`,
      400
    );
  }
  return { begin_date: toIsoZ(begin), end_date: toIsoZ(end) };
}

function parseCheckpointInterno(cursorAtual) {
  const vazio = {
    kind: CHECKPOINT_KIND,
    last_safe_report_key: null,
    processed_report_keys: [],
    last_end_date: null,
    last_file_name: null
  };
  if (cursorAtual == null || String(cursorAtual).trim() === '') return vazio;
  try {
    const o = JSON.parse(String(cursorAtual));
    if (o && o.kind === CHECKPOINT_KIND) {
      return {
        kind: CHECKPOINT_KIND,
        last_safe_report_key: o.last_safe_report_key || null,
        processed_report_keys: Array.isArray(o.processed_report_keys) ? o.processed_report_keys.map(String) : [],
        last_end_date: o.last_end_date || null,
        last_file_name: o.last_file_name || null
      };
    }
  } catch (_) { /* cursor legado OF — reinicia checkpoint MP */ }
  return vazio;
}

function serializarCheckpoint(cp) {
  return JSON.stringify({
    kind: CHECKPOINT_KIND,
    last_safe_report_key: cp.last_safe_report_key || null,
    processed_report_keys: Array.isArray(cp.processed_report_keys) ? cp.processed_report_keys : [],
    last_end_date: cp.last_end_date || null,
    last_file_name: cp.last_file_name || null
  });
}

function chaveRelatorio(rel) {
  if (!rel) return '';
  if (rel.report_id != null) return String(rel.report_id);
  if (rel.id != null) return String(rel.id);
  const fn = rel.file_name || rel.fileName || rel.filename;
  return fn != null ? String(fn) : '';
}

function nomeArquivo(rel) {
  if (!rel) return null;
  return rel.file_name || rel.fileName || rel.filename
    || (rel.report_id != null ? String(rel.report_id) : null)
    || (rel.id != null ? String(rel.id) : null);
}

function statusRelatorio(rel) {
  return String(rel && rel.status || '').toLowerCase();
}

function listarRelatoriosProcessados(lista) {
  const arr = Array.isArray(lista) ? lista.slice() : [];
  const processados = arr.filter((r) => statusRelatorio(r) === 'processed' && nomeArquivo(r));
  processados.sort((a, b) => String(a.generation_date || a.last_modified || a.begin_date || '')
    .localeCompare(String(b.generation_date || b.last_modified || b.begin_date || '')));
  return processados;
}

function haPendente(lista) {
  const arr = Array.isArray(lista) ? lista : [];
  return arr.some((r) => /pending|processing|in_process|queued/i.test(statusRelatorio(r)));
}

function categoriaPermiteRetry(err) {
  const c = err && err.categoria;
  return c === CATEGORIA_ERRO_PROVIDER.TIMEOUT
    || c === CATEGORIA_ERRO_PROVIDER.RATE_LIMIT
    || c === CATEGORIA_ERRO_PROVIDER.INDISPONIBILIDADE
    || err && err.code === ERROS.PROVIDER_TIMEOUT
    || err && err.code === ERROS.PROVIDER_RATE_LIMIT;
}

/**
 * Retry limitado (até 2 extras) usando taxonomia do Client MBC-16.1.
 * Sem retry para 401/403/OAuth/dados inválidos.
 */
async function comRetryLimitado(fn, opts = {}) {
  const maxExtra = opts.maxExtra != null ? Number(opts.maxExtra) : MAX_RETRY_EXTRA;
  let tentativa = 0;
  let ultimo = null;
  while (tentativa <= maxExtra) {
    try {
      return await fn(tentativa);
    } catch (err) {
      ultimo = err;
      if (!categoriaPermiteRetry(err) || tentativa >= maxExtra) throw err;
      let wait = 50 * (tentativa + 1);
      if (err.retry_after != null) {
        const ra = Number(err.retry_after);
        if (Number.isFinite(ra) && ra >= 0) {
          wait = Math.min(ra * 1000, RETRY_AFTER_CAP_MS);
        }
      }
      await sleep(opts.sleepMs != null ? opts.sleepMs : wait);
      tentativa += 1;
    }
  }
  throw ultimo;
}

async function deveUsarSincronizacaoMercadoPago(params, cfg) {
  if (!cfg || String(cfg.provider || '').toUpperCase() !== CODIGO_PROVIDER.OPEN_FINANCE_REAL) {
    return false;
  }
  if (params.apiClient || params.forcarMercadoPago === true) return true;
  const secretStore = params.secretStore || obterSecretStore({ db: params.db });
  try {
    const st = await ConfiguracaoIntegracaoBancariaService.obterStatusCredenciais({
      db: params.db,
      secretStore,
      empresaId: params.empresaId,
      id: cfg.id
    });
    return !!(st.client_id_configurado && st.secret_configurado);
  } catch (_) {
    return false;
  }
}

async function exigirOauthAutorizado(params, cfg) {
  const secretStore = params.secretStore || obterSecretStore({ db: params.db });
  const st = await obterStatusOauth({
    db: params.db,
    secretStore,
    empresaId: params.empresaId,
    id: cfg.id
  });
  if (st.status !== STATUS_OAUTH.AUTORIZADO) {
    throw erroMbc(
      ERROS.AUTORIZACAO_INVALIDA,
      'OAuth Mercado Pago não autorizado para sincronização.',
      409
    );
  }
  const payload = await lerPayloadOauth(secretStore, cfg.id);
  if (!payload || !payload.access_token || tokenExpirado(payload)) {
    throw erroMbc(ERROS.AUTORIZACAO_INVALIDA, 'Conta não autorizada para integração bancária.', 409);
  }
  return { status: st, accessToken: String(payload.access_token), secretStore };
}

/**
 * Executa o ciclo Settlement Report após lock MBC-07.
 * @param {object} ctx
 * @param {function} ctx.atualizarCampos (db, id, campos) => Promise
 */
async function executarAposLock(ctx = {}) {
  const {
    db,
    empresaId,
    conta,
    cfg,
    linhaLock,
    params = {},
    atualizarCampos
  } = ctx;

  const oauth = await exigirOauthAutorizado(params, cfg);
  const client = params.apiClient || new MercadoPagoApiClient({ fetchImpl: params.fetchImpl });

  let periodo;
  if (params.begin_date || params.end_date) {
    const padrao = periodoPadrao(params);
    periodo = validarPeriodoSettlement(
      params.begin_date || padrao.begin_date,
      params.end_date || padrao.end_date
    );
  } else {
    periodo = validarPeriodoSettlement(
      periodoPadrao({}).begin_date,
      periodoPadrao({}).end_date
    );
  }

  const reprocessar = params.reprocessarCatalogo === true;
  let checkpoint = reprocessar
    ? parseCheckpointInterno(null)
    : parseCheckpointInterno(linhaLock.cursor_atual);

  await comRetryLimitado(() => garantirConfigRelatorio(client, oauth.accessToken), {
    maxExtra: MAX_RETRY_EXTRA,
    sleepMs: params.retrySleepMs
  });

  try {
    await comRetryLimitado(
      () => client.criarRelatorio(oauth.accessToken, periodo.begin_date, periodo.end_date),
      { maxExtra: MAX_RETRY_EXTRA, sleepMs: params.retrySleepMs }
    );
  } catch (err) {
    if (err.statusCode !== 203) throw err;
  }

  const pollAttempts = params.pollAttempts != null ? Number(params.pollAttempts) : POLL_ATTEMPTS_PADRAO;
  const pollWaitMs = params.pollWaitMs != null ? Number(params.pollWaitMs) : POLL_WAIT_MS_PADRAO;
  let listaBody = [];
  for (let i = 0; i < Math.max(1, pollAttempts); i += 1) {
    if (i > 0) await sleep(pollWaitMs);
    const lista = await comRetryLimitado(
      () => client.listarRelatorios(oauth.accessToken),
      { maxExtra: MAX_RETRY_EXTRA, sleepMs: params.retrySleepMs }
    );
    listaBody = lista.body;
    if (listarRelatoriosProcessados(listaBody).length) break;
  }

  const arquivos = listarRelatoriosProcessados(listaBody);
  if (!arquivos.length) {
    if (haPendente(listaBody)) {
      const err = erroMbc(
        ERROS.PROVIDER_INDISPONIVEL,
        'Settlement Report ainda em PROCESSANDO. Checkpoint não avançado.',
        409
      );
      err.status_leitura = 'PROCESSANDO';
      throw err;
    }
    const err = erroMbc(
      ERROS.PROVIDER_INDISPONIVEL,
      'Nenhum Settlement Report processado disponível para o período.',
      502
    );
    throw err;
  }

  // Continuidade: retoma do último arquivo seguro (inclusive) se sync anterior incompleto.
  // Se o último seguro já é o último da lista (sync anterior concluído), reprocessa do início (idempotência).
  let startIdx = 0;
  if (checkpoint.last_safe_report_key) {
    const idx = arquivos.findIndex((r) => chaveRelatorio(r) === String(checkpoint.last_safe_report_key));
    if (idx >= 0 && idx < arquivos.length - 1) {
      startIdx = idx;
    }
  }

  let recebidas = 0;
  let criadas = 0;
  let jaExistentes = 0;
  let rejeitadas = 0;
  let arquivosProcessados = 0;
  const detalheArquivos = [];

  for (let i = startIdx; i < arquivos.length && arquivosProcessados < MAX_ARQUIVOS_POR_SYNC; i += 1) {
    const rel = arquivos[i];
    const key = chaveRelatorio(rel);
    const fileName = nomeArquivo(rel);
    if (!fileName) {
      throw erroMbc(ERROS.DTO_INVALIDO, 'Relatório processado sem nome de arquivo.', 502);
    }

    // Falha injetável para testes de continuidade (harness)
    if (params.falharNoArquivo && String(params.falharNoArquivo) === String(fileName)) {
      throw erroMbc(ERROS.PROVIDER_INDISPONIVEL, 'Falha simulada no arquivo ' + fileName, 502);
    }
    if (typeof params.onAntesArquivo === 'function') {
      await params.onAntesArquivo({ fileName, key, indice: i });
    }

    const download = await comRetryLimitado(
      () => client.baixarRelatorio(oauth.accessToken, fileName),
      { maxExtra: MAX_RETRY_EXTRA, sleepMs: params.retrySleepMs }
    );
    const csv = typeof download.body === 'string' ? download.body : '';
    const mapeado = mapearCsvParaDtos(csv, {
      empresaId,
      contaBancariaId: conta.id
    });

    const persistencia = await MercadoPagoPersistenciaService.persistirLote({
      db,
      empresaId,
      conta_bancaria_id: conta.id,
      movimentacoes: mapeado.transacoes
    });

    recebidas += persistencia.recebidas;
    criadas += persistencia.criadas;
    jaExistentes += persistencia.ja_existentes;
    rejeitadas += persistencia.rejeitadas.length + (mapeado.rejeitadas || []).length;
    arquivosProcessados += 1;

    // SOMENTE após persistência: avança checkpoint interno
    if (!checkpoint.processed_report_keys.includes(key)) {
      checkpoint.processed_report_keys.push(key);
    }
    checkpoint.last_safe_report_key = key;
    checkpoint.last_file_name = fileName;
    checkpoint.last_end_date = rel.end_date || periodo.end_date;
    await atualizarCampos(db, linhaLock.id, {
      cursor_atual: serializarCheckpoint(checkpoint)
    });

    detalheArquivos.push({
      report_key: key,
      file_name: fileName,
      criadas: persistencia.criadas,
      ja_existentes: persistencia.ja_existentes,
      rejeitadas: persistencia.rejeitadas.length
    });
  }

  return {
    status: STATUS_SINCRONIZACAO.SUCESSO,
    origem: 'MERCADO_PAGO',
    contrato: 'settlement_report',
    periodo,
    arquivos_processados: arquivosProcessados,
    arquivos: detalheArquivos,
    transacoes_recebidas: recebidas,
    novas_transacoes: criadas,
    duplicadas: jaExistentes,
    rejeitadas,
    checkpoint_interno: checkpoint,
    cursor: serializarCheckpoint(checkpoint),
    saldo_bancario: null,
    saldo_data: null,
    saldo: {
      disponivel: false,
      codigo: SALDO_NAO_DISPONIVEL,
      valor: null
    }
  };
}

module.exports = {
  CHECKPOINT_KIND,
  MAX_DIAS_PERIODO_OFICIAL,
  MAX_ARQUIVOS_POR_SYNC,
  validarPeriodoSettlement,
  parseCheckpointInterno,
  serializarCheckpoint,
  listarRelatoriosProcessados,
  chaveRelatorio,
  deveUsarSincronizacaoMercadoPago,
  exigirOauthAutorizado,
  comRetryLimitado,
  categoriaPermiteRetry,
  executarAposLock
};
