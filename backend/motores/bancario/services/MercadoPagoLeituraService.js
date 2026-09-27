/**
 * Leitura real Mercado Pago (MBC-16.1) — sem persistência.
 * Fluxo oficial Dinheiro em conta (settlement_report).
 * @module motores/bancario/services/MercadoPagoLeituraService
 */
'use strict';

const {
  ERROS,
  CODIGO_PROVIDER,
  erroMbc
} = require('../contracts/constantes');
const { exigirEmpresaId } = require('../contracts/TransacaoBancariaNormalizada');
const { obterSecretStore } = require('../secrets/EncryptedLocalSecretStore');
const ConfiguracaoIntegracaoBancariaService = require('./ConfiguracaoIntegracaoBancariaService');
const ContaBancariaService = require('./ContaBancariaService');
const {
  STATUS_OAUTH,
  lerPayloadOauth,
  tokenExpirado,
  chaveOauthMercadoPago
} = require('./MercadoPagoOAuthService');
const { MercadoPagoApiClient } = require('../providers/mercadopago/MercadoPagoApiClient');
const {
  COLUNAS_CONFIG,
  mapearCsvParaDtos
} = require('../providers/mercadopago/MercadoPagoAccountMoneyMapper');
const MercadoPagoPersistenciaService = require('./MercadoPagoPersistenciaService');

const MSG_NAO_AUTORIZADA = 'Conta não autorizada para integração bancária.';
const SALDO_NAO_DISPONIVEL = 'SALDO_REAL_NAO_DISPONIVEL_NESTA_OPERACAO';

function depsDe(params) {
  return {
    db: params.db,
    secretStore: params.secretStore || obterSecretStore({ db: params.db }),
    fetchImpl: params.fetchImpl || null,
    apiClient: params.apiClient || null,
    pollAttempts: params.pollAttempts != null ? Number(params.pollAttempts) : 12,
    pollWaitMs: params.pollWaitMs != null ? Number(params.pollWaitMs) : 3000,
    persistir: params.persistir === true
  };
}

function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

async function carregarContexto(params) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const deps = depsDe(params);
  const cfg = await ConfiguracaoIntegracaoBancariaService.obterNoContexto({
    db: deps.db,
    secretStore: deps.secretStore,
    empresaId,
    id: params.id
  });
  if (!cfg.ativo) {
    throw erroMbc(ERROS.CONFIG_INATIVA, 'Configuração de integração está inativa.', 409);
  }
  if (cfg.provider !== CODIGO_PROVIDER.OPEN_FINANCE_REAL) {
    throw erroMbc(
      ERROS.PROVIDER_CREDENCIAL_INCOMPATIVEL,
      'Leitura Mercado Pago exige provider OPEN_FINANCE_REAL.',
      409
    );
  }
  const conta = await ContaBancariaService.obterNoContexto({
    db: deps.db,
    empresaId,
    id: cfg.conta_bancaria_id
  });
  if (!conta.ativa) {
    throw erroMbc(ERROS.CONTA_INATIVA, 'Conta bancária está inativa.', 409);
  }
  if (Number(conta.empresa_id) !== Number(empresaId)) {
    throw erroMbc(ERROS.EMPRESA_CONTA_DIVERGENTE, 'Conta não pertence à empresa do contexto.', 400);
  }
  return { cfg, conta, empresaId, ...deps };
}

async function obterAccessToken(secretStore, configId) {
  const payload = await lerPayloadOauth(secretStore, configId);
  if (!payload || !payload.access_token || tokenExpirado(payload)) {
    throw erroMbc(ERROS.AUTORIZACAO_INVALIDA, MSG_NAO_AUTORIZADA, 409);
  }
  return String(payload.access_token);
}

function clientDe(deps) {
  return deps.apiClient || new MercadoPagoApiClient({ fetchImpl: deps.fetchImpl });
}

function periodoPadrao(params = {}) {
  const fim = params.end_date ? new Date(params.end_date) : new Date();
  const ini = params.begin_date
    ? new Date(params.begin_date)
    : new Date(fim.getTime() - 7 * 24 * 60 * 60 * 1000);
  return {
    begin_date: ini.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    end_date: fim.toISOString().replace(/\.\d{3}Z$/, 'Z')
  };
}

async function garantirConfigRelatorio(client, accessToken) {
  try {
    await client.getConfig(accessToken);
    return { ok: true, criada: false };
  } catch (err) {
    if (err.statusCode !== 404) throw err;
  }
  // Contrato oficial MP: frequency/scheduled necessários no POST (senão 400 Error invalid fields).
  const body = {
    file_name_prefix: 'settlement-report',
    display_timezone: 'GMT-04',
    header_language: 'pt',
    separator: ';',
    scheduled: false,
    frequency: { hour: 0, value: 0, type: 'daily' },
    include_withdraw: true,
    columns: COLUNAS_CONFIG.slice()
  };
  try {
    await client.postConfig(accessToken, body);
    return { ok: true, criada: true };
  } catch (errPost) {
    if (errPost.statusCode === 409) {
      await client.putConfig(accessToken, body);
      return { ok: true, criada: false };
    }
    try {
      await client.putConfig(accessToken, body);
      return { ok: true, criada: true };
    } catch (_) {
      throw errPost;
    }
  }
}

function escolherRelatorioPronto(lista, beginDate, endDate) {
  const arr = Array.isArray(lista) ? lista : [];
  const processados = arr.filter((r) => String(r.status || '').toLowerCase() === 'processed');
  if (!processados.length) {
    const pendente = arr.find((r) => /pending|processing|in_process|queued/i.test(String(r.status || '')));
    return { pronto: null, pendente: pendente || null };
  }
  // preferir o mais recente no intervalo solicitado
  const noPeriodo = processados.filter((r) => {
    if (!beginDate || !endDate) return true;
    const b = r.begin_date || r.beginDate;
    const e = r.end_date || r.endDate;
    if (!b || !e) return true;
    return String(b) <= String(endDate) && String(e) >= String(beginDate);
  });
  const candidatos = noPeriodo.length ? noPeriodo : processados;
  candidatos.sort((a, b) => String(b.generation_date || b.last_modified || '').localeCompare(
    String(a.generation_date || a.last_modified || '')
  ));
  return { pronto: candidatos[0], pendente: null };
}

function nomeArquivoRelatorio(rel) {
  if (!rel) return null;
  return rel.file_name || rel.fileName || rel.filename
    || (rel.report_id != null ? String(rel.report_id) : null)
    || (rel.id != null ? String(rel.id) : null);
}

/**
 * Consulta leitura real. Com persistir=true (MBC-16.2), grava via MBC-03.
 * Provider/client NÃO fazem INSERT em transacao_bancaria.
 */
async function consultarLeituraReal(params = {}) {
  const ctx = await carregarContexto(params);
  const accessToken = await obterAccessToken(ctx.secretStore, ctx.cfg.id);
  const client = clientDe(ctx);
  const periodo = periodoPadrao(params);
  const devePersistir = ctx.persistir === true;

  await garantirConfigRelatorio(client, accessToken);

  let criado = null;
  try {
    criado = await client.criarRelatorio(accessToken, periodo.begin_date, periodo.end_date);
  } catch (err) {
    // 203 = não criado; ainda podemos listar existentes
    if (err.statusCode !== 203) throw err;
  }

  let listaBody = null;
  let pronto = null;
  let pendente = null;
  for (let i = 0; i < Math.max(1, ctx.pollAttempts); i += 1) {
    if (i > 0) await sleep(ctx.pollWaitMs);
    const lista = await client.listarRelatorios(accessToken);
    listaBody = lista.body;
    const escolha = escolherRelatorioPronto(listaBody, periodo.begin_date, periodo.end_date);
    pronto = escolha.pronto;
    pendente = escolha.pendente;
    if (pronto) break;
  }

  if (!pronto) {
    return {
      ok: true,
      provider: CODIGO_PROVIDER.OPEN_FINANCE_REAL,
      origem: 'MERCADO_PAGO',
      persistiu: false,
      status_leitura: 'PROCESSANDO',
      mensagem: 'Relatório de Dinheiro em conta solicitado. Aguarde o processamento e tente novamente.',
      periodo,
      relatorio_criado: criado && criado.body ? { status: criado.status } : null,
      relatorio_pendente: pendente ? {
        id: pendente.id || null,
        status: pendente.status || null
      } : null,
      saldo: {
        disponivel: false,
        codigo: SALDO_NAO_DISPONIVEL,
        valor: null,
        moeda: null,
        origem: 'MERCADO_PAGO'
      },
      movimentacoes: [],
      persistencia: null
    };
  }

  const fileName = nomeArquivoRelatorio(pronto);
  if (!fileName) {
    throw erroMbc(ERROS.DTO_INVALIDO, 'Relatório processado sem nome de arquivo para download.', 502);
  }

  const download = await client.baixarRelatorio(accessToken, fileName);
  const csv = typeof download.body === 'string' ? download.body : '';
  const mapeado = mapearCsvParaDtos(csv, {
    empresaId: ctx.empresaId,
    contaBancariaId: ctx.conta.id
  });

  let persistencia = null;
  if (devePersistir) {
    persistencia = await MercadoPagoPersistenciaService.persistirLote({
      db: ctx.db,
      empresaId: ctx.empresaId,
      conta_bancaria_id: ctx.conta.id,
      movimentacoes: mapeado.transacoes
    });
  }

  const rejeitadas = (mapeado.rejeitadas || []).slice();
  if (persistencia && Array.isArray(persistencia.rejeitadas)) {
    for (const r of persistencia.rejeitadas) {
      rejeitadas.push({
        source_id: r.external_id,
        motivo: r.motivo,
        code: r.code || null,
        fase: 'persistencia'
      });
    }
  }

  return {
    ok: true,
    provider: CODIGO_PROVIDER.OPEN_FINANCE_REAL,
    origem: 'MERCADO_PAGO',
    persistiu: devePersistir === true,
    status_leitura: 'PRONTO',
    periodo,
    relatorio: {
      id: pronto.id || null,
      report_id: pronto.report_id || null,
      status: pronto.status || null,
      file_name: fileName,
      currency_id: pronto.currency_id || null
    },
    saldo: {
      disponivel: false,
      codigo: SALDO_NAO_DISPONIVEL,
      valor: null,
      moeda: pronto.currency_id || null,
      origem: 'MERCADO_PAGO',
      observacao: 'Documentação oficial de Dinheiro em conta não expõe endpoint síncrono de saldo; saldo não inventado.'
    },
    movimentacoes: mapeado.transacoes.map((t) => ({
      external_id: t.external_id,
      external_source: t.external_source,
      data_transacao: t.data_transacao,
      data_processamento: t.data_processamento,
      valor: t.valor,
      direcao: t.direcao,
      descricao: t.descricao,
      referencia: t.referencia_externa,
      saldo_apos_transacao: t.saldo_apos_transacao,
      raw_reference: t.raw_reference
    })),
    rejeitadas,
    total_linhas: mapeado.total_linhas,
    persistencia: persistencia
      ? {
        recebidas: persistencia.recebidas,
        criadas: persistencia.criadas,
        ja_existentes: persistencia.ja_existentes,
        rejeitadas: persistencia.rejeitadas.length,
        ids_criados: persistencia.ids_criados
      }
      : null
  };
}

module.exports = {
  MSG_NAO_AUTORIZADA,
  SALDO_NAO_DISPONIVEL,
  consultarLeituraReal,
  garantirConfigRelatorio,
  periodoPadrao,
  escolherRelatorioPronto,
  chaveOauthMercadoPago
};
