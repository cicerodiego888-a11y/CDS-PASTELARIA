'use strict';

const os = require('node:os');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');

const EVENT_PREFIX = '[MIIP_ORIGIN_DIAG]';
const ENABLE_FLAG = 'CDS_MIIP_ORIGIN_DIAGNOSTICS';
const MOTOR_CODES = new Set([
  'motor_gtin',
  'motor_associacao_fornecedor',
  'motor_mubc',
  'motor_similarity'
]);

function isTemporaryDbDir(env = process.env) {
  const configured = String(env.DB_DIR || '').trim();
  if (!configured) return false;

  const tempRoot = path.resolve(os.tmpdir());
  const dbDir = path.resolve(configured);
  const relative = path.relative(tempRoot, dbDir);
  return relative !== ''
    && relative !== '.'
    && !relative.startsWith(`..${path.sep}`)
    && relative !== '..'
    && !path.isAbsolute(relative);
}

function isEnabled(env = process.env) {
  return env.NODE_ENV === 'test'
    && env[ENABLE_FLAG] === '1'
    && isTemporaryDbDir(env);
}

function internalId(value) {
  if (value == null) return null;
  const text = String(value);
  if (!text || text.length > 80 || /\d{11,}/.test(text)) return null;
  return text;
}

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function token(value) {
  return typeof value === 'string'
    && value.length <= 64
    && !/^\d{11,}$/.test(value)
    && /^[a-z0-9_-]{1,64}$/i.test(value)
    ? value
    : null;
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function candidateId(candidate) {
  return positiveId(candidate?.produtoId
    ?? candidate?.produto_id
    ?? candidate?.produto?.id
    ?? candidate?.snapshot?.id);
}

function candidateSources(candidate, motor) {
  const sources = new Set();
  const dataOrigin = candidate?.atributosExtraidos?.origemDados
    ?? candidate?.atributos_extraidos?.origem_dados;
  const motors = list(candidate?.motoresQueVotaram
    ?? candidate?.motores
    ?? candidate?.motores_que_votaram);
  const matchMotivesRaw = candidate?.atributosExtraidos?.matchMotivos
    ?? candidate?.atributos_extraidos?.match_motivos
    ?? [];
  const relevanceMotivesRaw = candidate?.atributosExtraidos?.motivosRelevancia
    ?? candidate?.atributos_extraidos?.motivos_relevancia
    ?? [];
  const matchMotives = list(matchMotivesRaw);
  const relevanceMotives = list(relevanceMotivesRaw);

  if (dataOrigin === 'MiipAssociacoesRepository' || motors.includes('motor_associacao_fornecedor')) {
    sources.add('associacao_fornecedor');
  }
  if (dataOrigin === 'MUBC' || motors.includes('motor_mubc') || motor === 'motor_mubc') {
    sources.add('busca_textual_ncm');
  }
  if (motors.includes('motor_gtin') || motor === 'motor_gtin'
      || candidate?.atributosExtraidos?.campoOrigem === 'codigo_barras') {
    sources.add('busca_gtin');
  }
  if (matchMotives.includes('descricao') || matchMotives.includes('ncm')
      || relevanceMotives.some((m) => ['descricao', 'ncm', 'sinonimo', 'marca'].includes(m?.tipo))) {
    sources.add('busca_textual_ncm');
  }
  if (sources.size === 0 && ['ProdutoRepository', 'MUBC', 'MiipAssociacoesRepository'].includes(dataOrigin)) {
    sources.add(dataOrigin);
  }
  if (sources.size === 0 && MOTOR_CODES.has(motor)) sources.add(motor);
  if (sources.size === 0) sources.add('desconhecida');
  return [...sources];
}

function identitySources(candidate) {
  const product = candidate?.produto ?? candidate?.snapshot ?? {};
  const source = (value) => value ? 'snapshot_miip' : 'desconhecida';
  return {
    nome: source(product.nome),
    codigo: source(product.codigo),
    gtin: source(product.codigoBarras ?? product.codigo_barras)
  };
}

function evidenceTypes(candidate) {
  const evidencias = Array.isArray(candidate?.evidencias) ? candidate.evidencias : [];
  return evidencias.map((e) => ({
    motor: token(e?.motor),
    tipo: token(e?.tipo),
    score: Number.isFinite(Number(e?.score)) ? Number(e.score) : null
  }));
}

function relevanceTypes(candidate) {
  const attributes = candidate?.atributosExtraidos ?? candidate?.atributos_extraidos ?? {};
  const motives = list(attributes.motivosRelevancia ?? attributes.motivos_relevancia);
  const hitMotives = list(attributes.matchMotivos ?? attributes.match_motivos);
  return [...new Set([
    ...motives.map((m) => token(m?.tipo)),
    ...hitMotives.map(token)
  ].filter(Boolean))];
}

function candidateRecords(result) {
  const selected = result?.candidatoSelecionado ?? result?.candidato_selecionado ?? null;
  const alternatives = Array.isArray(result?.candidatos) ? result.candidatos : [];
  const records = [];
  const seen = new Set();

  [selected, ...alternatives].filter(Boolean).forEach((candidate) => {
    const id = candidateId(candidate);
    const motorCandidate = token(result?.motor) || list(
      candidate?.motoresQueVotaram ?? candidate?.motores ?? candidate?.motores_que_votaram
    )
      .map(token)
      .find(Boolean)
      || null;
    const motor = MOTOR_CODES.has(motorCandidate) ? motorCandidate : null;
    const scoreMotor = Number(candidate?.scoreTotal ?? candidate?.score);
    const scoreOriginal = candidate === selected
      ? Number(result?.score ?? result?.scoreTotal ?? scoreMotor)
      : scoreMotor;
    const key = `${id ?? 'null'}:${motor ?? 'null'}`;
    if (seen.has(key)) return;
    seen.add(key);

    records.push({
      produtoId: id,
      motor,
      fontes: candidateSources(candidate, motor),
      scoreOriginal: Number.isFinite(scoreOriginal) ? scoreOriginal : null,
      scoreCandidato: Number.isFinite(scoreMotor) ? scoreMotor : null,
      evidencias: evidenceTypes(candidate),
      motivosRelevancia: relevanceTypes(candidate),
      origemCamposIdentidade: identitySources(candidate)
    });
  });

  if (records.length === 0 && (result?.produtoEncontrado || result?.produto_encontrado)) {
    const product = result.produtoEncontrado ?? result.produto_encontrado;
    records.push({
      produtoId: positiveId(product?.id),
      motor: token(result?.motor),
      fontes: ['desconhecida'],
      scoreOriginal: Number.isFinite(Number(result?.score)) ? Number(result.score) : null,
      scoreCandidato: null,
      evidencias: [],
      motivosRelevancia: [],
      origemCamposIdentidade: identitySources({ produto: product })
    });
  }

  return records;
}

function createMiipOriginDiagnostics(options = {}) {
  const env = options.env ?? (() => process.env);
  const sink = options.sink ?? ((record) => {
    console.info(EVENT_PREFIX, JSON.stringify(record));
  });
  const storage = new AsyncLocalStorage();

  function environment() {
    return typeof env === 'function' ? env() : env;
  }

  function currentContext() {
    return storage.getStore() || {};
  }

  function emit(fields) {
    const currentEnv = environment();
    if (!isEnabled(currentEnv)) return;

    const context = currentContext();
    try {
      sink({
        ...fields,
        timestamp: new Date().toISOString(),
        documentoId: positiveId(fields.documentoId ?? context.documentoId),
        operacaoId: internalId(fields.operacaoId ?? context.operacaoId)
      });
    } catch {
      process.emitWarning('MIIP origin diagnostic event could not be written; identification continued.', {
        code: 'CDS_MIIP_ORIGIN_DIAGNOSTIC_SINK'
      });
    }
  }

  return Object.freeze({
    isEnabled() {
      return isEnabled(environment());
    },
    withContext(context, callback) {
      if (!isEnabled(environment())) return callback();
      return storage.run({
        ...currentContext(),
        documentoId: positiveId(context?.documentoId ?? currentContext().documentoId),
        operacaoId: internalId(context?.operacaoId ?? currentContext().operacaoId)
      }, callback);
    },
    setOperationId(value) {
      if (!isEnabled(environment())) return;
      const context = currentContext();
      if (context) context.operacaoId = internalId(value);
    },
    recordLookup({ lookup, cacheHit, productId, source, catalogContext }) {
      if (!isEnabled(environment())) return;
      const tipoConsulta = ['id', 'gtin', 'codigo', 'identificador'].includes(lookup)
        ? lookup
        : 'id';
      emit({
        evento: 'consulta_produto',
        tipoConsulta,
        cacheHit: Boolean(cacheHit),
        produtoId: positiveId(productId),
        fonteConsulta: source === 'produto_cache' ? 'produto_cache' : 'sqlite',
        contextoCatalogo: catalogContext === 'sqlite_injetado' ? 'sqlite_injetado' : 'sqlite_padrao'
      });
    },
    recordCatalogCandidates({ candidates, catalogContext }) {
      if (!isEnabled(environment())) return;
      const safeCandidates = list(candidates).map((candidate) => ({
        produtoId: positiveId(candidate?.produtoId),
        motivosBusca: [...new Set(list(candidate?.motivos).map(token).filter(Boolean))]
      }));
      emit({
        evento: 'busca_catalogo_universal',
        contextoCatalogo: catalogContext === 'sqlite_injetado' ? 'sqlite_injetado' : 'sqlite_padrao',
        quantidadeCandidatos: safeCandidates.length,
        candidatos: safeCandidates
      });
    },
    recordImport({ documentoId, operacaoId, resultOrigin, importResult }) {
      if (!isEnabled(environment())) return;
      const safeOrigin = resultOrigin === 'novo_processamento'
        || resultOrigin === 'persistido_reutilizado'
        ? resultOrigin
        : 'desconhecida';
      const results = Array.isArray(importResult?.resultados) ? importResult.resultados : [];
      results.forEach((result, index) => {
        const candidates = candidateRecords(result);
        if (candidates.length === 0) {
          emit({
            evento: 'resultado_item',
            documentoId,
            operacaoId: operacaoId ?? result?.operacaoId,
            indiceItem: index,
            origemResultado: safeOrigin,
            candidatos: [{
              produtoId: null,
              motor: null,
              fontes: ['desconhecida'],
              scoreOriginal: Number.isFinite(Number(result?.score)) ? Number(result.score) : null,
              scoreCandidato: null,
              evidencias: [],
              motivosRelevancia: [],
              origemCamposIdentidade: {
                nome: 'desconhecida',
                codigo: 'desconhecida',
                gtin: 'desconhecida'
              }
            }]
          });
          return;
        }

        emit({
          evento: 'resultado_item',
          documentoId,
          operacaoId: operacaoId ?? result?.operacaoId,
          indiceItem: index,
          origemResultado: safeOrigin,
          candidatos: candidates
        });
      });
    }
  });
}

const defaultDiagnostics = createMiipOriginDiagnostics();

module.exports = {
  ENABLE_FLAG,
  EVENT_PREFIX,
  isEnabled,
  isTemporaryDbDir,
  createMiipOriginDiagnostics,
  defaultDiagnostics
};
