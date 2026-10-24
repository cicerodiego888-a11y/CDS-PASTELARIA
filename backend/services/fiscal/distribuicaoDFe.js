/**
 * Distribuição DF-e — SEFAZ → SOAP → Download XML → Central de Entradas.
 *
 * Sprint 4: responsabilidade exclusiva de sincronizar documentos na inbox.
 * Sprint F6: envio SOAP via Plataforma Fiscal + fallback legado.
 * NÃO cria compras, NÃO altera estoque/financeiro, NÃO chama MIIP.
 *
 * @module services/fiscal/distribuicaoDFe
 */

const { getFiscalConfig } = require('./configService');
const {
  enviarDistribuicaoDfe,
  getDfeUrl
} = require('./distribuicaoDfeRuntime');
const CentralDfePersistenciaService = require('../../motores/central-entradas/services/CentralDfePersistenciaService');
const CentralDocumentosRepository = require('../../motores/central-entradas/repositories/CentralDocumentosRepository');
const CentralNsuRepository = require('../../motores/central-entradas/repositories/CentralNsuRepository');
const CentralNsuService = require('../../motores/central-entradas/services/CentralNsuService');
const {
  NSU_ZERADO,
  normalizarNsu,
  normalizarNsuOuZero,
  nsuMenorQue,
  extrairMetadadosRetorno,
  extrairDocumentosZip,
  retornoDistSucesso,
  salvarXmlRetorno656
} = require('./dfeRetornoParser');
const { fiscalSoapTelemetry } = require('./core/FiscalSoapTelemetry');
const {
  DfeAuditoriaService,
  DfeAuditoriaResultado,
  DfeAuditoriaEtapa,
  criarCorrelationIdDfeSync
} = require('./DfeAuditoriaService');
const { montarErroPersistenciaDfe } = require('./pendenciasPersistenciaDfe');
const { emitirSefazConsulta } = require('../../motores/central-entradas/observability/SefazConsultaTrace');
const { resolverIdentidadeConsultaChave } = require('./identidadeConsultaChave');
const {
  avaliarAutorizacaoTransmissao,
  exigirAutorizacaoTransmissao,
  criarErroTransmissaoNaoAutorizada,
  resultadoConsultaNaoExecutada,
  ESTADOS_CONSULTA_SEFAZ,
  MODO_OPERACAO_REAL
} = require('./autorizacaoTransmissaoSefaz');
const { obterMutexTransmissaoSefaz } = require('./SefazTransmissaoMutex');

const MAX_ITERACOES_SYNC = 50;

/**
 * P0.9 — OPERACAO_REAL só transmite se a ativação persistida ainda estiver viva
 * (desativação revoga seed imediatamente, mesmo com TTL restante).
 */
async function exigirOperacaoRealVivaSeAplicavel(deps, { empresaId, cnpj, tipoConsulta } = {}) {
  const auth = deps && deps.autorizacaoTransmissaoSefaz;
  if (!auth || auth.modo !== MODO_OPERACAO_REAL) return null;
  if (typeof deps.validarOperacaoRealViva === 'function') {
    return deps.validarOperacaoRealViva(auth, { empresaId, cnpj, tipoConsulta });
  }
  const CentralOperacaoFiscalRealService = require(
    '../../motores/central-entradas/services/CentralOperacaoFiscalRealService'
  );
  const svc = deps.operacaoFiscalRealService
    || new CentralOperacaoFiscalRealService({ db: deps.db || null });
  return svc.assertAutorizacaoViva(auth, { empresaId, cnpj, tipoConsulta });
}

/**
 * @param {Object} config
 * @returns {string}
 */
function obterCodigoUf(config) {
  const codigo = config.fiscal_codigo_uf || config.codigo_uf || '23';
  return String(codigo).replace(/\D/g, '').padStart(2, '0');
}

/**
 * @param {Object} config
 * @throws {Error}
 */
function validarConfigFiscal(config) {
  if (!config.certificadoPath || !config.certificadoSenha) {
    throw new Error('Certificado não configurado');
  }

  const cnpjEmitente = String(config.cnpj || '').replace(/\D/g, '');
  if (!cnpjEmitente || cnpjEmitente.length !== 14) {
    throw new Error('CNPJ do emitente não configurado');
  }
}

/**
 * @param {Object} params
 * @returns {string}
 */
function montarXmlDistNsu({ ambiente, codigoUf, cnpj, ultNsu }) {
  return `
<distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">
  <tpAmb>${ambiente}</tpAmb>
  <cUFAutor>${codigoUf}</cUFAutor>
  <CNPJ>${cnpj}</CNPJ>
  <distNSU>
    <ultNSU>${normalizarNsuOuZero(ultNsu)}</ultNSU>
  </distNSU>
</distDFeInt>`;
}

/**
 * @param {Object} params
 * @returns {string}
 */
function montarXmlConsChave({ ambiente, codigoUf, cnpj, chave }) {
  return `
<distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">
  <tpAmb>${ambiente}</tpAmb>
  <cUFAutor>${codigoUf}</cUFAutor>
  <CNPJ>${cnpj}</CNPJ>
  <consChNFe>
    <chNFe>${String(chave).replace(/\D/g, '')}</chNFe>
  </consChNFe>
</distDFeInt>`;
}

/**
 * Envia consulta DF-e via Plataforma Fiscal (F6) com fallback legado.
 * Retorna body + metadados de telemetria (RC6.6) sem alterar o SOAP.
 *
 * @param {string} xmlConsulta
 * @param {Object} config
 * @param {number} ambiente
 * @param {Object} [deps]
 * @returns {Promise<{ body: string, requestId: string|null, correlationId: string|null, tempoResolverMs: number, tempoXmlMs: number, tempoTransporteMs: number, tempoTotalMs: number, endpoint: string|null, fallbackUtilizado: boolean, httpStatus: number|null }>}
 */
function inferirTipoConsultaDfe(xmlConsulta, fallback) {
  const xml = String(xmlConsulta || '');
  if (/<(?:\w+:)?consChNFe\b/i.test(xml)) return 'consChNFe';
  if (/<(?:\w+:)?consNSU\b/i.test(xml)) return 'consNSU';
  if (/<(?:\w+:)?distNSU\b/i.test(xml)) return 'distNSU';
  return fallback || 'desconhecido';
}

async function executarEnvioConsultaDfe(xmlConsulta, config, ambiente, deps = {}) {
  const runtimeSend = deps.enviarDistribuicaoDfe || enviarDistribuicaoDfe;
  const tipoConsulta = deps.tipoConsulta || inferirTipoConsultaDfe(xmlConsulta, 'distNSU');
  const cnpj = String(config && config.cnpj ? config.cnpj : deps.cnpjConsulta || '').replace(/\D/g, '') || null;
  const empresaId = deps.empresaId ?? deps.contextoCentral?.empresaId ?? null;
  const nsuAnterior = deps.nsuEnviado != null ? String(deps.nsuEnviado) : null;

  exigirAutorizacaoTransmissao({
    autorizacao: deps.autorizacaoTransmissaoSefaz,
    empresaId,
    tipoConsulta
  });
  await exigirOperacaoRealVivaSeAplicavel(deps, { empresaId, cnpj, tipoConsulta });

  emitirSefazConsulta('CONSULTA_EXECUTADA', {
    origem: deps.origemConsulta || null,
    correlationId: deps.correlationId || null,
    empresaId,
    cnpj,
    tipoConsulta,
    nsuAnterior,
    resultado: 'enviada'
  });

  let resultado;
  try {
    resultado = await runtimeSend({
      xmlConsulta,
      ambiente,
      cUF: obterCodigoUf(config),
      certificadoPath: config.certificadoPath,
      certificadoSenha: config.certificadoSenha,
      versao: '1.01',
      legadoHttpClient: deps.legadoHttpClient || null,
      correlationId: deps.correlationId || null,
      autorizacaoTransmissaoSefaz: deps.autorizacaoTransmissaoSefaz || null,
      empresaId,
      cnpj,
      tipoConsulta
    });
  } catch (errEnvio) {
    emitirSefazConsulta('RESPOSTA_RECEBIDA', {
      origem: deps.origemConsulta || null,
      correlationId: deps.correlationId || null,
      empresaId,
      cnpj,
      tipoConsulta,
      nsuAnterior,
      resultado: 'erro_transporte',
      motivo: errEnvio && errEnvio.message
    });
    throw errEnvio;
  }

  const requestId = resultado.telemetryRequestId || null;

  if (!resultado.success || resultado.body == null) {
    emitirSefazConsulta('RESPOSTA_RECEBIDA', {
      origem: deps.origemConsulta || null,
      correlationId: deps.correlationId || resultado.correlationId || null,
      empresaId,
      cnpj,
      tipoConsulta,
      nsuAnterior,
      resultado: 'erro_sefaz',
      motivo: resultado.error || 'Falha na Distribuição DF-e (plataforma/legado).'
    });
    if (requestId) {
      fiscalSoapTelemetry.finalizar(requestId, {
        sucesso: false,
        resultado: 'ERRO',
        tempoResolverMs: resultado.tempoResolverMs,
        tempoXmlMs: resultado.tempoXmlMs,
        tempoTransporteMs: resultado.tempoTransporteMs,
        tempoTotalMs: resultado.tempoTotalMs,
        fallbackUtilizado: resultado.fallbackUtilizado,
        endpoint: resultado.endpoint
      });
    }
    throw new Error(resultado.error || 'Falha na Distribuição DF-e (plataforma/legado).');
  }

  let nsuRetornado = null;
  let maxNsu = null;
  let cStat = null;
  try {
    const meta = extrairMetadadosRetorno(resultado.body);
    nsuRetornado = meta && meta.ultNSU != null ? String(meta.ultNSU) : null;
    maxNsu = meta && meta.maxNSU != null ? String(meta.maxNSU) : null;
    cStat = meta && meta.cStat != null ? String(meta.cStat) : null;
  } catch { /* parse opcional para rastreio */ }

  emitirSefazConsulta('RESPOSTA_RECEBIDA', {
    origem: deps.origemConsulta || null,
    correlationId: resultado.correlationId || deps.correlationId || null,
    empresaId,
    cnpj,
    tipoConsulta,
    nsuAnterior,
    nsuRetornado,
    maxNsu,
    cStat,
    resultado: 'ok'
  });

  return {
    body: resultado.body,
    requestId,
    correlationId: resultado.correlationId || null,
    tempoResolverMs: resultado.tempoResolverMs,
    tempoXmlMs: resultado.tempoXmlMs,
    tempoTransporteMs: resultado.tempoTransporteMs,
    tempoTotalMs: resultado.tempoTotalMs,
    endpoint: resultado.endpoint || null,
    fallbackUtilizado: Boolean(resultado.fallbackUtilizado),
    httpStatus: resultado.statusCode != null ? resultado.statusCode : null
  };
}

/**
 * Compatibilidade: retorna apenas o XML de retorno.
 *
 * @param {string} xmlConsulta
 * @param {Object} config
 * @param {number} ambiente
 * @param {Object} [deps]
 * @returns {Promise<string>}
 */
async function enviarConsultaDfe(xmlConsulta, config, ambiente, deps = {}) {
  const envio = await executarEnvioConsultaDfe(xmlConsulta, config, ambiente, deps);
  if (envio.requestId) {
    fiscalSoapTelemetry.finalizar(envio.requestId, {
      sucesso: true,
      xmlRetorno: envio.body,
      tempoResolverMs: envio.tempoResolverMs,
      tempoXmlMs: envio.tempoXmlMs,
      tempoTransporteMs: envio.tempoTransporteMs,
      tempoTotalMs: envio.tempoTotalMs,
      fallbackUtilizado: envio.fallbackUtilizado,
      endpoint: envio.endpoint,
      resultado: 'OK'
    });
  }
  return envio.body;
}

/**
 * Finaliza telemetria SOAP após parse/persistência (observe-only).
 * @param {object|null} envio
 * @param {object} [extra]
 */
function finalizarTelemetriaEnvio(envio, extra = {}) {
  if (!envio || !envio.requestId) return;
  fiscalSoapTelemetry.finalizar(envio.requestId, {
    sucesso: extra.sucesso !== false,
    xmlRetorno: envio.body,
    persistidos: extra.persistidos,
    duplicados: extra.duplicados,
    descartados: extra.descartados,
    cStat: extra.cStat,
    xMotivo: extra.xMotivo,
    ultNSU: extra.ultNSU,
    maxNSU: extra.maxNSU,
    tempoResolverMs: envio.tempoResolverMs,
    tempoXmlMs: envio.tempoXmlMs,
    tempoTransporteMs: envio.tempoTransporteMs,
    tempoTotalMs: envio.tempoTotalMs,
    fallbackUtilizado: envio.fallbackUtilizado,
    endpoint: envio.endpoint,
    resultado: extra.resultado || (extra.sucesso === false ? 'ERRO' : 'OK')
  });
}

/**
 * Contexto do Gate SEFAZ da Central (empresa + CNPJ + ambiente) para a chamada.
 * @param {Object} deps
 * @param {string} cnpj
 * @param {number} ambiente
 * @param {Object} [extra]
 * @returns {Object}
 */
function montarContextoGateSefaz(deps, cnpj, ambiente, extra = {}) {
  return {
    empresaId: deps.contextoCentral?.empresaId ?? null,
    cnpj,
    ambiente,
    documentoId: deps.documentoId ?? null,
    correlationId: deps.correlationId || null,
    origem: deps.origemGate || 'distribuicaoDFe',
    ...extra
  };
}

/**
 * Consulta o Gate SEFAZ injetado (opcional). Retorna a negativa ou null se liberado.
 * @param {Object} deps
 * @param {Object} ctxGate
 * @returns {Promise<Object|null>}
 */
async function verificarGateSefaz(deps, ctxGate) {
  const gate = deps.gateSefaz;
  if (!gate || typeof gate.autorizarConsultaDistDfe !== 'function') return null;
  let auth;
  try {
    auth = await gate.autorizarConsultaDistDfe(ctxGate);
  } catch {
    return null;
  }
  return auth && auth.permitido === false ? auth : null;
}

/**
 * Informa ao Gate SEFAZ injetado o cStat recebido (inclusive 656).
 * @param {Object} deps
 * @param {{ cStat?: string, xMotivo?: string }} metadados
 * @param {Object} ctxGate
 */
async function reportarGateSefaz(deps, metadados, ctxGate) {
  const gate = deps.gateSefaz;
  if (!gate || typeof gate.processarRespostaSefaz !== 'function' || !metadados?.cStat) return;
  try {
    await gate.processarRespostaSefaz({
      cStat: String(metadados.cStat),
      xMotivo: metadados.xMotivo || null,
      mensagem: metadados.xMotivo || null,
      ultNsu: metadados.ultNSU || null
    }, ctxGate);
  } catch { /* Gate indisponível não interrompe o fluxo fiscal */ }
}

function erroBloqueioGate(auth) {
  const erro = new Error(auth.mensagem || 'Consulta bloqueada pelo Gate SEFAZ.');
  erro.bloqueadoGate = true;
  erro.codigo = auth.codigo || 'GATE_BLOQUEADO';
  erro.proximaConsultaEm = auth.proximaConsultaEm || null;
  erro.gate = auth;
  erro.consultaExecutada = false;
  erro.sefazConsultada = false;
  erro.respostaRecebida = false;
  erro.recuperacaoConcluida = false;
  erro.estadoConsulta = ESTADOS_CONSULTA_SEFAZ.NAO_EXECUTADA;
  return erro;
}

async function confirmarDocumentoConsultaChave(persistencia, chave, empresaId) {
  const emp = Number(empresaId);
  const repo = persistencia && persistencia._documentosRepository;
  if (!repo || typeof repo.buscarPorChave !== 'function' || !Number.isInteger(emp) || emp <= 0) {
    return { conferido: false, documento: null, xmlPersistido: false };
  }
  const documento = await repo.buscarPorChave(chave, emp);
  const xml = documento && String(documento.xml || documento.xml_completo || '').trim();
  return {
    conferido: true,
    documento: documento || null,
    xmlPersistido: Boolean(xml)
  };
}

function classificarResultadoConsultaChave({ persistidos, metadados, confirmacao }) {
  const errosPersistencia = Array.isArray(persistidos.errosPersistencia)
    ? persistidos.errosPersistencia
    : [];
  const persistenciaCompleta = errosPersistencia.length === 0;
  const cStat = metadados && metadados.cStat != null ? String(metadados.cStat) : null;
  const semDocumentoSefaz = cStat === '137'
    || (
      persistenciaCompleta
      && (Number(persistidos.notasNovas) || 0) === 0
      && (Number(persistidos.notasDuplicadas) || 0) === 0
      && (Number(persistidos.atualizados) || 0) === 0
      && (Number(persistidos.recebidosZip) || 0) === 0
    );

  if (!persistenciaCompleta) {
    return {
      sucesso: false,
      persistenciaCompleta: false,
      recuperacaoConcluida: false,
      estadoConsulta: ESTADOS_CONSULTA_SEFAZ.PERSISTENCIA_PENDENTE,
      codigo: 'PERSISTENCIA_DFE_INCOMPLETA'
    };
  }

  if (semDocumentoSefaz) {
    return {
      sucesso: true,
      persistenciaCompleta: true,
      recuperacaoConcluida: false,
      estadoConsulta: ESTADOS_CONSULTA_SEFAZ.SEM_DOCUMENTO
    };
  }

  const xmlConfirmado = confirmacao.conferido
    ? confirmacao.xmlPersistido === true
    : ((Number(persistidos.notasNovas) || 0)
      + (Number(persistidos.notasDuplicadas) || 0)
      + (Number(persistidos.atualizados) || 0)) > 0;

  if (xmlConfirmado) {
    return {
      sucesso: true,
      persistenciaCompleta: true,
      recuperacaoConcluida: true,
      estadoConsulta: ESTADOS_CONSULTA_SEFAZ.RECUPERACAO_CONCLUIDA
    };
  }

  return {
    sucesso: false,
    persistenciaCompleta: true,
    recuperacaoConcluida: false,
    estadoConsulta: ESTADOS_CONSULTA_SEFAZ.RESPOSTA_RECEBIDA
  };
}

/**
 * Resolve empresa da ingestão DistDFe sem ler `deps` fora de escopo.
 * Ordem: contexto da chamada → persistencia._empresaId → null.
 *
 * @param {Object|null} ctxAudit
 * @param {Object|null} persistencia
 * @returns {number|string|null}
 */
function resolverEmpresaIdPersistenciaDfe(ctxAudit, persistencia) {
  if (ctxAudit != null && ctxAudit.empresaId != null && ctxAudit.empresaId !== '') {
    return ctxAudit.empresaId;
  }
  if (persistencia != null && persistencia._empresaId != null && persistencia._empresaId !== '') {
    return persistencia._empresaId;
  }
  return null;
}

/**
 * Falha estrutural de persistência DistDFe: não pode virar "ignorado" nem sucesso falso.
 *
 * @param {Error} err
 * @returns {boolean}
 */
function isFalhaEstruturalPersistenciaDfe(err) {
  if (!err) return false;
  if (err.code === 'DISTDFE_PERSISTENCIA_AUSENTE' || err.code === 'DISTDFE_DEPS_INVALIDAS') {
    return true;
  }
  return err instanceof ReferenceError;
}

/**
 * @param {Object|null} persistencia
 * @throws {Error} DISTDFE_PERSISTENCIA_AUSENTE
 */
function exigirPersistenciaDocumentoDfe(persistencia) {
  if (!persistencia || typeof persistencia.persistirDocumentoDfe !== 'function') {
    const err = new Error('Persistência DistDFe indisponível para ingestão de documentos.');
    err.code = 'DISTDFE_PERSISTENCIA_AUSENTE';
    throw err;
  }
}

/**
 * @param {string} xmlRetorno
 * @param {CentralDfePersistenciaService} persistencia
 * @param {string} origem
 * @param {Object} [ctxAudit]
 * @param {string|number|null} [ctxAudit.empresaId]
 * @returns {Promise<{ notasNovas: number, notasDuplicadas: number, ignorados: number, atualizados: number, eventos: number, errosZip: number, errosSchema: number, recebidosZip: number }>}
 */
async function persistirDocumentosRetorno(xmlRetorno, persistencia, origem, ctxAudit = null) {
  const auditoria = ctxAudit?.auditoria || null;
  const correlationId = ctxAudit?.correlationId || null;
  const cnpj = ctxAudit?.cnpj || null;
  const ambiente = ctxAudit?.ambiente != null ? ctxAudit.ambiente : null;

  let eventos = 0;
  let errosZip = 0;
  let errosSchema = 0;
  let recebidosZip = 0;
  const descartes = [];

  const documentos = extrairDocumentosZip(xmlRetorno, {
    onDescarte: (evt) => {
      descartes.push(evt);
    }
  });

  const empresaIdPersistencia = resolverEmpresaIdPersistenciaDfe(ctxAudit, persistencia);

  for (const evt of descartes) {
    recebidosZip += 1;
    if (evt.resultado === 'EVENTO') eventos += 1;
    else if (evt.resultado === 'ERRO_ZIP') errosZip += 1;
    else errosSchema += 1;

    // RC3.7.1 — evento 110111/110112 aplica CANCELADA no documento da chave
    if (evt.resultado === 'EVENTO' && evt.xml && typeof persistencia.aplicarEventoDfe === 'function') {
      try {
        const aplicado = await persistencia.aplicarEventoDfe({
          xml: evt.xml,
          nsu: evt.nsu,
          chave: evt.chave,
          origem,
          empresaId: empresaIdPersistencia
        });
        if (aplicado?.aplicado && auditoria) {
          await auditoria.registrar({
            correlation_id: correlationId,
            empresa_id: empresaIdPersistencia,
            empresaId: empresaIdPersistencia,
            cnpj,
            ambiente,
            nsu: evt.nsu,
            tipo: 'EVENTO',
            schema: evt.schema,
            chave: evt.chave || aplicado.chave,
            resultado: aplicado.status || 'CANCELADA',
            motivo: aplicado.documento?.statusDetalhe || 'Evento fiscal aplicado',
            tempo_ms: evt.tempoMs
          });
        }
      } catch (errEvt) {
        console.warn('[DFE] falha ao aplicar evento:', errEvt.message);
      }
    }

    if (auditoria) {
      await auditoria.registrar({
        correlation_id: correlationId,
        empresa_id: empresaIdPersistencia,
        empresaId: empresaIdPersistencia,
        cnpj,
        ambiente,
        nsu: evt.nsu,
        tipo: evt.tipo || DfeAuditoriaEtapa.ZIP,
        schema: evt.schema,
        chave: evt.chave || null,
        resultado: evt.resultado,
        motivo: evt.motivo,
        tempo_ms: evt.tempoMs,
        detalhe: { tamanhoZip: evt.tamanhoZip, empresaId: empresaIdPersistencia }
      });
    }
  }

  let notasNovas = 0;
  let notasDuplicadas = 0;
  let ignorados = 0;
  let atualizados = 0;
  const errosPersistencia = [];
  const MAX_TENTATIVAS_PERSISTENCIA = 2;

  async function persistirComRetentativa(payload) {
    let ultimoErro = null;
    for (let tentativa = 1; tentativa <= MAX_TENTATIVAS_PERSISTENCIA; tentativa += 1) {
      try {
        return await persistencia.persistirDocumentoDfe(payload);
      } catch (err) {
        if (isFalhaEstruturalPersistenciaDfe(err)) throw err;
        ultimoErro = err;
        console.warn('[DistDFe] Retentativa de persistência', {
          nsu: payload.nsu || null,
          tentativa,
          max: MAX_TENTATIVAS_PERSISTENCIA,
          codigo: err.code || null,
          mensagem: err.message
        });
      }
    }
    throw ultimoErro;
  }

  if (documentos.length > 0) {
    try {
      exigirPersistenciaDocumentoDfe(persistencia);
    } catch (err) {
      console.error('[DistDFe] Falha estrutural na persistência', {
        etapa: 'exigirPersistenciaDocumentoDfe',
        codigo: err.code || err.name,
        nsu: documentos[0] && documentos[0].nsu ? documentos[0].nsu : null,
        recebidos: documentos.length,
        origem,
        mensagem: err.message
      });
      throw err;
    }
  }

  for (const doc of documentos) {
    recebidosZip += 1;
    const tParser = Date.now();

    if (auditoria) {
      await auditoria.registrar({
        correlation_id: correlationId,
        empresa_id: empresaIdPersistencia,
        empresaId: empresaIdPersistencia,
        cnpj,
        ambiente,
        nsu: doc.nsu,
        tipo: DfeAuditoriaEtapa.ZIP,
        schema: doc.schema,
        resultado: 'PROCESSADO',
        motivo: `ZIP OK · ${doc.tamanhoZip || 0} bytes · descompactado`,
        tempo_ms: doc.tempoZipMs,
        detalhe: { tamanhoZip: doc.tamanhoZip, tipoAuditoria: doc.tipoAuditoria }
      });
      await auditoria.registrar({
        correlation_id: correlationId,
        empresa_id: empresaIdPersistencia,
        empresaId: empresaIdPersistencia,
        cnpj,
        ambiente,
        nsu: doc.nsu,
        tipo: DfeAuditoriaEtapa.PARSER,
        schema: doc.schema,
        resultado: 'PROCESSADO',
        motivo: `Parser=${doc.tipoAuditoria || 'NF'} Resultado=OK`,
        tempo_ms: Date.now() - tParser,
        detalhe: { parser: doc.tipoAuditoria }
      });
    }

    let resultado;
    const tPers = Date.now();
    try {
      resultado = await persistirComRetentativa({
        xml: doc.xml,
        nsu: doc.nsu,
        origem,
        empresaId: empresaIdPersistencia
      });
    } catch (err) {
      if (isFalhaEstruturalPersistenciaDfe(err)) {
        console.error('[DistDFe] Falha estrutural na persistência', {
          etapa: 'persistirDocumentoDfe',
          codigo: err.code || err.name,
          nsu: doc.nsu,
          origem,
          mensagem: err.message
        });
        throw err;
      }
      const pendencia = montarErroPersistenciaDfe({
        nsu: doc.nsu,
        xml: doc.xml,
        err,
        empresaId: empresaIdPersistencia
      });
      errosPersistencia.push(pendencia);
      console.error('[DistDFe] Falha ao persistir documento DF-e — lote incompleto, NSU não deve avançar', {
        etapa: 'persistirDocumentoDfe',
        codigo: pendencia.codigo,
        nsu: pendencia.nsu,
        chave: pendencia.chave,
        origem,
        mensagem: pendencia.mensagem
      });
      if (auditoria) {
        await auditoria.registrar({
          correlation_id: correlationId,
          cnpj,
          ambiente,
          empresa_id: empresaIdPersistencia,
          nsu: pendencia.nsu,
          chave: pendencia.chave,
          tipo: DfeAuditoriaEtapa.PERSISTENCIA,
          schema: doc.schema,
          resultado: DfeAuditoriaResultado.ERRO_BANCO,
          motivo: pendencia.mensagem,
          tempo_ms: Date.now() - tPers,
          detalhe: {
            codigo: pendencia.codigo,
            empresaId: pendencia.empresaId,
            retomavel: true
          }
        });
      }
      continue;
    }

    if (resultado.novo) notasNovas += 1;
    else if (resultado.duplicado) notasDuplicadas += 1;
    else if (resultado.atualizado) atualizados += 1;
    else if (resultado.ignorado) ignorados += 1;

    if (auditoria) {
      let resCode = DfeAuditoriaResultado.PROCESSADO;
      if (resultado.duplicado) resCode = DfeAuditoriaResultado.DUPLICADO;
      else if (resultado.ignorado) resCode = DfeAuditoriaResultado.IGNORADO;
      else if (resultado.atualizado) resCode = DfeAuditoriaResultado.XML_COMPLETO;
      else if (resultado.tipoDfe === 'RES_NFE' || doc.tipoAuditoria === 'RES_NFE') {
        resCode = DfeAuditoriaResultado.RESUMO;
      } else if (resultado.novo) {
        resCode = DfeAuditoriaResultado.XML_COMPLETO;
      }

      await auditoria.registrar({
        correlation_id: correlationId,
        empresa_id: empresaIdPersistencia,
        empresaId: empresaIdPersistencia,
        cnpj,
        ambiente,
        nsu: doc.nsu,
        tipo: DfeAuditoriaEtapa.PERSISTENCIA,
        schema: doc.schema,
        chave: resultado.documento?.chave || null,
        resultado: resCode,
        motivo: resultado.motivo
          || (resultado.novo ? 'INSERT' : resultado.atualizado ? 'UPDATE XML' : resultado.duplicado ? 'DUPLICADO' : 'SKIP'),
        tempo_ms: Date.now() - tPers,
        detalhe: {
          novo: !!resultado.novo,
          duplicado: !!resultado.duplicado,
          atualizado: !!resultado.atualizado,
          ignorado: !!resultado.ignorado,
          tipoDfe: resultado.tipoDfe || null,
          documentoId: resultado.documento?.id || null,
          empresaId: empresaIdPersistencia
        }
      });
    }
  }

  const persistenciaOk = errosPersistencia.length === 0;
  emitirSefazConsulta(persistenciaOk ? 'PERSISTENCIA_CONCLUIDA' : 'PERSISTENCIA_FALHOU', {
    origem: ctxAudit?.origemConsulta || origem || null,
    correlationId,
    empresaId: empresaIdPersistencia,
    cnpj,
    tipoConsulta: ctxAudit?.tipoConsulta || null,
    resultado: persistenciaOk ? 'ok' : 'falhou',
    motivo: persistenciaOk
      ? null
      : `${errosPersistencia.length} documento(s) DistDFe não persistidos`,
    detalhe: {
      notasNovas,
      notasDuplicadas,
      ignorados,
      errosPersistencia: errosPersistencia.length,
      chaves: errosPersistencia.map((e) => e.chave).filter(Boolean).slice(0, 10)
    }
  });

  return {
    notasNovas,
    notasDuplicadas,
    ignorados,
    atualizados,
    eventos,
    errosZip,
    errosSchema,
    recebidosZip,
    errosPersistencia
  };
}

/**
 * @param {Object} [deps]
 * @returns {Promise<Object>}
 */
async function sincronizarDistribuicaoDFe(deps = {}) {
  const empresaIdAuth = deps.empresaId ?? deps.contextoCentral?.empresaId ?? null;
  const auth = avaliarAutorizacaoTransmissao({
    autorizacao: deps.autorizacaoTransmissaoSefaz,
    empresaId: empresaIdAuth,
    tipoConsulta: 'distNSU'
  });
  if (!auth.ok) {
    emitirSefazConsulta('BLOQUEADA_AUTORIZACAO', {
      origem: deps.origemConsulta || null,
      correlationId: deps.correlationId || null,
      empresaId: empresaIdAuth,
      tipoConsulta: 'distNSU',
      codigo: auth.codigo,
      motivo: auth.mensagem,
      resultado: 'bloqueada'
    });
    return resultadoConsultaNaoExecutada({
      codigo: auth.codigo,
      mensagem: auth.mensagem
    });
  }

  try {
    await exigirOperacaoRealVivaSeAplicavel(deps, {
      empresaId: empresaIdAuth,
      cnpj: deps.contextoCentral?.cnpj || auth.cnpj || null,
      tipoConsulta: 'distNSU'
    });
  } catch (errViva) {
    emitirSefazConsulta('BLOQUEADA_AUTORIZACAO', {
      origem: deps.origemConsulta || null,
      correlationId: deps.correlationId || null,
      empresaId: empresaIdAuth,
      tipoConsulta: 'distNSU',
      codigo: errViva.codigo || errViva.code,
      motivo: errViva.message,
      resultado: 'bloqueada'
    });
    return resultadoConsultaNaoExecutada({
      codigo: errViva.codigo || errViva.code,
      mensagem: errViva.message
    });
  }

  const mutex = deps.mutexTransmissaoSefaz || obterMutexTransmissaoSefaz();
  if (!deps.jaPossuiLockTransmissao && mutex && typeof mutex.comLock === 'function' && !mutex.estaNoContexto()) {
    const cnpjLock = String(
      deps.contextoCentral?.cnpj || deps.cnpj || ''
    ).replace(/\D/g, '');
    const ambLock = deps.contextoCentral?.ambiente != null
      ? (Number(deps.contextoCentral.ambiente) === 1 ? 1 : 2)
      : null;
    const locked = await mutex.comLock(
      'distNSU',
      () => sincronizarDistribuicaoDFe({
        ...deps,
        jaPossuiLockTransmissao: true
      }),
      { cnpj: cnpjLock || null, ambiente: ambLock, tipo: 'distNSU' }
    );
    if (!locked.ok) {
      return resultadoConsultaNaoExecutada({
        codigo: locked.codigo || 'TRANSMISSAO_SEFAZ_EM_ANDAMENTO',
        motivoIgnorado: locked.codigo || 'TRANSMISSAO_SEFAZ_EM_ANDAMENTO',
        bloqueadoAutorizacao: false,
        mensagem: locked.mensagem || 'Consulta DistDFe não executada: transmissão SEFAZ já em andamento.'
      });
    }
    return locked.valor;
  }

  let config;
  let ambiente;

  if (deps.contextoCentral) {
    const ctx = deps.contextoCentral;
    config = {
      certificadoPath: ctx.certificadoPath,
      certificadoSenha: ctx.certificadoSenha,
      cnpj: ctx.cnpj,
      fiscal_codigo_uf: ctx.codigoUf,
      codigo_uf: ctx.codigoUf,
      ambiente: ctx.ambiente,
      fiscal_ambiente: ctx.ambiente
    };
    ambiente = Number(ctx.ambiente) === 1 ? 1 : 2;
  } else {
    // DF-e não depende de URL de autorização NFC-e
    config = await getFiscalConfig({ validarUrls: false });
    ambiente = Number(config.fiscal_ambiente || config.ambiente || 2);
  }

  validarConfigFiscal(config);
  const cnpj = String(config.cnpj).replace(/\D/g, '');
  const codigoUf = obterCodigoUf(config);

  const ctxGate = montarContextoGateSefaz(deps, cnpj, ambiente, { motivo: 'distNSU' });
  const negadoGate = await verificarGateSefaz(deps, ctxGate);
  if (negadoGate) {
    return {
      sucesso: false,
      consultaExecutada: false,
      ignorado: true,
      bloqueadoGate: true,
      codigo: negadoGate.codigo || 'GATE_BLOQUEADO',
      motivoIgnorado: 'GATE_BLOQUEADO',
      cStat: null,
      notasNovas: 0,
      notasDuplicadas: 0,
      ignorados: 0,
      iteracoes: 0,
      proximaConsultaEm: negadoGate.proximaConsultaEm || null,
      mensagem: negadoGate.mensagem || 'Consulta DF-e não executada: bloqueada pelo Gate SEFAZ.'
    };
  }

  const nsuRepository = deps.nsuRepository ?? new CentralNsuRepository();
  const nsuService = deps.nsuService
    ?? new CentralNsuService({ nsuRepository });
  const persistencia = deps.persistenciaService ?? new CentralDfePersistenciaService();
  const auditoria = deps.auditoriaService ?? new DfeAuditoriaService();
  // Unifica correlationId da orquestração quando presente (CE-ENCERRAMENTO-01).
  const correlationId = deps.correlationId || criarCorrelationIdDfeSync();
  const syncInicio = Date.now();
  const empresaIdAudit = empresaIdAuth
    ?? deps.contextoCentral?.empresaId
    ?? null;

  let controleNsu = await nsuService.obterOuCriar(cnpj, ambiente);
  let ultNsuAtual = normalizarNsuOuZero(controleNsu.ultNsu);
  let maxNsuAtual = normalizarNsuOuZero(controleNsu.maxNsu);

  let notasNovasTotal = 0;
  let notasDuplicadasTotal = 0;
  let ignoradosTotal = 0;
  let atualizadosTotal = 0;
  let eventosTotal = 0;
  let errosZipTotal = 0;
  let errosSchemaTotal = 0;
  let recebidosZipTotal = 0;
  let iteracoes = 0;
  let ultimoRetorno = null;

  console.log(`[DFE][SYNC] ${correlationId} | CNPJ=${cnpj} | ambiente=${ambiente} | ultNSU=${ultNsuAtual}`);

  while (iteracoes < (deps.maxIteracoes ?? MAX_ITERACOES_SYNC)) {
    iteracoes += 1;

    if (iteracoes > 1) {
      const negadoIter = await verificarGateSefaz(deps, ctxGate);
      if (negadoIter) break;
    }

    const xmlConsulta = montarXmlDistNsu({
      ambiente,
      codigoUf,
      cnpj,
      ultNsu: ultNsuAtual
    });

    const tConsulta = Date.now();
    const envio = await executarEnvioConsultaDfe(xmlConsulta, config, ambiente, {
      ...deps,
      tipoConsulta: 'distNSU',
      cnpjConsulta: cnpj,
      empresaId: ctxGate.empresaId || deps.contextoCentral?.empresaId || null,
      nsuEnviado: ultNsuAtual
    });
    let ultimoRetornoIter = null;
    try {
      ultimoRetornoIter = extrairMetadadosRetorno(envio.body);
      ultimoRetorno = ultimoRetornoIter;
      await reportarGateSefaz(deps, ultimoRetornoIter, {
        ...ctxGate,
        nsu: ultNsuAtual,
        endpoint: envio.endpoint || null
      });
      const tempoConsulta = Date.now() - tConsulta;
      const lotesEstimados = (String(envio.body || '').match(/<docZip/gi) || []).length;

      await auditoria.registrarConsulta({
        correlation_id: correlationId,
        empresa_id: empresaIdAudit,
        empresaId: empresaIdAudit,
        cnpj,
        ambiente,
        empresa: cnpj,
        ultNsuEnviado: ultNsuAtual,
        ultNsuRecebido: ultimoRetorno.ultNSU,
        maxNsuRecebido: ultimoRetorno.maxNSU,
        cStat: ultimoRetorno.cStat,
        xMotivo: ultimoRetorno.xMotivo,
        lotes: lotesEstimados,
        tempoMs: tempoConsulta,
        motivo: `ultNSU=${ultNsuAtual} maxNSU=${ultimoRetorno.maxNSU} cStat=${ultimoRetorno.cStat} lotes=${lotesEstimados} tempo=${tempoConsulta}ms`,
        detalhe: {
          empresaId: empresaIdAudit,
          sefazConsultada: true,
          consultaExecutada: true
        }
      });

      console.log(
        `[DFE][SYNC] ${correlationId} | ultNSU=${ultNsuAtual} maxNSU=${ultimoRetorno.maxNSU}`
        + ` cStat=${ultimoRetorno.cStat} lotes=${lotesEstimados} tempo=${tempoConsulta}ms`
      );

      if (!retornoDistSucesso(ultimoRetorno.cStat)) {
        finalizarTelemetriaEnvio(envio, {
          sucesso: false,
          cStat: ultimoRetorno.cStat,
          xMotivo: ultimoRetorno.xMotivo,
          ultNSU: ultimoRetorno.ultNSU,
          maxNSU: ultimoRetorno.maxNSU,
          resultado: 'ERRO'
        });
        throw new Error(
          ultimoRetorno.xMotivo
            || `SEFAZ retornou cStat ${ultimoRetorno.cStat || 'desconhecido'}`
        );
      }

      // cStat 656: cooldown obrigatório. Cursor local NÃO avança (nem com ultNSU remoto maior).
      if (String(ultimoRetorno.cStat) === '656') {
        const xmlPath656 = salvarXmlRetorno656(envio.body, { correlationId });
        if (xmlPath656) {
          console.log(`[DFE][SYNC] ${correlationId} | XML 656 salvo: ${xmlPath656}`);
        }
        const nsuLocalAntes = normalizarNsuOuZero(controleNsu.ultNsu);
        const maxLocalAntes = normalizarNsuOuZero(controleNsu.maxNsu);
        const aplicado = await nsuService.aplicarRetornoDistDfe({
          controle: controleNsu,
          cStat: '656',
          xmlRetorno: envio.body,
          ultNsu: ultimoRetorno.ultNSU,
          maxNsu: ultimoRetorno.maxNSU,
          correlationId,
          cnpj,
          empresa: cnpj
        });
        controleNsu = aplicado.controle;
        ultNsuAtual = normalizarNsuOuZero(aplicado.ultNsu);
        maxNsuAtual = normalizarNsuOuZero(aplicado.maxNsu);
        const motivoPreserva = aplicado.recuperacaoNsu?.motivo || 'NSU_PRESERVADO';
        await auditoria.registrarNsuAvanco({
          correlation_id: correlationId,
          empresa_id: empresaIdAudit,
          empresaId: empresaIdAudit,
          cnpj,
          ambiente,
          nsu: ultNsuAtual,
          avancou: false,
          motivo: `cStat 656 — Cursor atualizado=FALSE (NSU preservado: ${motivoPreserva})`,
          cStat: '656',
          ultNsuAnterior: aplicado.recuperacaoNsu?.nsuLocal || nsuLocalAntes,
          ultNsuNovo: ultNsuAtual,
          maxNsu: maxNsuAtual,
          maxNsuAnterior: maxLocalAntes,
          nsuRemoto: aplicado.recuperacaoNsu?.nsuRemoto || null
        });
        finalizarTelemetriaEnvio(envio, {
          sucesso: false,
          cStat: '656',
          xMotivo: ultimoRetorno.xMotivo,
          ultNSU: ultimoRetorno.ultNSU,
          maxNSU: ultimoRetorno.maxNSU,
          persistidos: 0,
          duplicados: 0,
          descartados: 0,
          resultado: 'CONSUMO_INDEVIDO'
        });
        await auditoria.registrarResumoSync({
          correlation_id: correlationId,
          empresa_id: empresaIdAudit,
          empresaId: empresaIdAudit,
          cnpj,
          ambiente,
          recebidos: 0,
          processados: 0,
          atualizados: 0,
          duplicados: 0,
          eventos: 0,
          xml: 0,
          resumo: 0,
          erros: 1,
          tempoTotalMs: Date.now() - syncInicio,
          ultNsu: ultNsuAtual,
          maxNsu: maxNsuAtual,
          cStat: '656',
          motivo: 'CONSUMO_INDEVIDO'
        });
        return {
          sucesso: false,
          consultaExecutada: true,
          codigo: 'CONSUMO_INDEVIDO',
          notasNovas: notasNovasTotal,
          notasDuplicadas: notasDuplicadasTotal,
          ignorados: ignoradosTotal,
          ultNsu: ultNsuAtual,
          maxNsu: maxNsuAtual,
          iteracoes,
          cStat: '656',
          xMotivo: ultimoRetorno.xMotivo || null,
          correlationId,
          nsuRecuperado: false,
          proximaConsultaEm: aplicado.proximaConsultaEm,
          mensagem: ultimoRetorno.xMotivo
            || 'Consumo indevido (cStat 656) — NSU preservado; nova consulta após 1 hora.',
          ultimaSincronizacao: controleNsu.dataSincronizacao || controleNsu.updatedAt
        };
      }

      const persistidos = await persistirDocumentosRetorno(envio.body, persistencia, 'dfe', {
        auditoria,
        correlationId,
        cnpj,
        ambiente,
        empresaId: deps.contextoCentral?.empresaId ?? persistencia._empresaId ?? null,
        origemConsulta: deps.origemConsulta || null,
        tipoConsulta: 'distNSU'
      });
      notasNovasTotal += persistidos.notasNovas;
      notasDuplicadasTotal += persistidos.notasDuplicadas;
      ignoradosTotal += persistidos.ignorados;
      atualizadosTotal += persistidos.atualizados || 0;
      eventosTotal += persistidos.eventos || 0;
      errosZipTotal += persistidos.errosZip || 0;
      errosSchemaTotal += persistidos.errosSchema || 0;
      recebidosZipTotal += persistidos.recebidosZip || 0;
      const errosPersistenciaLote = Array.isArray(persistidos.errosPersistencia)
        ? persistidos.errosPersistencia
        : [];

      finalizarTelemetriaEnvio(envio, {
        sucesso: errosPersistenciaLote.length === 0,
        cStat: ultimoRetorno.cStat,
        xMotivo: ultimoRetorno.xMotivo,
        ultNSU: ultimoRetorno.ultNSU,
        maxNSU: ultimoRetorno.maxNSU,
        persistidos: persistidos.notasNovas,
        duplicados: persistidos.notasDuplicadas,
        descartados: persistidos.ignorados,
        resultado: errosPersistenciaLote.length ? 'PERSISTENCIA_INCOMPLETA' : 'OK'
      });

      if (errosPersistenciaLote.length > 0) {
        await auditoria.registrarResumoSync({
          correlation_id: correlationId,
          empresa_id: empresaIdAudit,
          empresaId: empresaIdAudit,
          cnpj,
          ambiente,
          recebidos: recebidosZipTotal,
          processados: notasNovasTotal + atualizadosTotal,
          atualizados: atualizadosTotal,
          duplicados: notasDuplicadasTotal,
          eventos: eventosTotal,
          xml: notasNovasTotal + atualizadosTotal,
          resumo: 0,
          erros: errosPersistenciaLote.length + ignoradosTotal + errosZipTotal + errosSchemaTotal,
          tempoTotalMs: Date.now() - syncInicio,
          ultNsu: ultNsuAtual,
          maxNsu: maxNsuAtual,
          cStat: ultimoRetorno.cStat,
          motivo: 'PERSISTENCIA_DFE_INCOMPLETA — NSU preservado para retomada idempotente',
          errosPersistencia: errosPersistenciaLote,
          pendenciasPersistencia: errosPersistenciaLote
        });
        return {
          sucesso: false,
          consultaExecutada: true,
          codigo: 'PERSISTENCIA_DFE_INCOMPLETA',
          notasNovas: notasNovasTotal,
          notasDuplicadas: notasDuplicadasTotal,
          ignorados: ignoradosTotal,
          atualizados: atualizadosTotal,
          errosPersistencia: errosPersistenciaLote,
          ultNsu: ultNsuAtual,
          maxNsu: maxNsuAtual,
          iteracoes,
          cStat: ultimoRetorno.cStat,
          correlationId,
          mensagem: `${errosPersistenciaLote.length} documento(s) DistDFe não persistidos — NSU preservado para retomada.`,
          ultimaSincronizacao: controleNsu.dataSincronizacao || controleNsu.updatedAt
        };
      }

      const ultAntes = ultNsuAtual;
      const aplicado = await nsuService.aplicarRetornoDistDfe({
        controle: controleNsu,
        cStat: ultimoRetorno.cStat,
        xmlRetorno: envio.body,
        ultNsu: ultimoRetorno.ultNSU,
        maxNsu: ultimoRetorno.maxNSU,
        correlationId
      });
      controleNsu = aplicado.controle;
      ultNsuAtual = normalizarNsuOuZero(aplicado.ultNsu);
      maxNsuAtual = normalizarNsuOuZero(aplicado.maxNsu);

      await auditoria.registrarNsuAvanco({
        correlation_id: correlationId,
        empresa_id: empresaIdAudit,
        empresaId: empresaIdAudit,
        cnpj,
        ambiente,
        nsu: ultNsuAtual,
        avancou: !!aplicado.atualizouNsu,
        motivo: aplicado.atualizouNsu
          ? `Cursor atualizado=TRUE (${ultAntes} → ${ultNsuAtual})`
          : `Cursor atualizado=FALSE (${aplicado.preservado ? 'preservado' : 'sem avanço'})`,
        cStat: ultimoRetorno.cStat,
        ultNsuAnterior: ultAntes,
        ultNsuNovo: ultNsuAtual,
        maxNsu: maxNsuAtual
      });

      if (!nsuMenorQue(ultNsuAtual, maxNsuAtual)) {
        break;
      }
    } catch (erro) {
      finalizarTelemetriaEnvio(envio, {
        sucesso: false,
        cStat: ultimoRetornoIter?.cStat,
        xMotivo: ultimoRetornoIter?.xMotivo || erro.message,
        resultado: 'ERRO'
      });
      await auditoria.registrar({
        correlation_id: correlationId,
        empresa_id: empresaIdAudit,
        empresaId: empresaIdAudit,
        cnpj,
        ambiente,
        tipo: DfeAuditoriaEtapa.SYNC,
        resultado: DfeAuditoriaResultado.ERRO_PARSER,
        motivo: erro.message || 'Erro na sincronização DistDFe',
        tempo_ms: Date.now() - syncInicio
      });
      throw erro;
    }
  }

  const tempoTotal = Date.now() - syncInicio;
  await auditoria.registrarResumoSync({
    correlation_id: correlationId,
    empresa_id: empresaIdAudit,
    empresaId: empresaIdAudit,
    cnpj,
    ambiente,
    recebidos: recebidosZipTotal,
    processados: notasNovasTotal + atualizadosTotal,
    atualizados: atualizadosTotal,
    duplicados: notasDuplicadasTotal,
    eventos: eventosTotal,
    xml: notasNovasTotal + atualizadosTotal,
    resumo: 0,
    erros: ignoradosTotal + errosZipTotal + errosSchemaTotal,
    tempoTotalMs: tempoTotal,
    ultNsu: ultNsuAtual,
    maxNsu: maxNsuAtual,
    cStat: ultimoRetorno?.cStat || '138',
    motivo: `recebidos=${recebidosZipTotal} processados=${notasNovasTotal} atualizados=${atualizadosTotal} duplicados=${notasDuplicadasTotal} eventos=${eventosTotal} erros=${ignoradosTotal + errosZipTotal + errosSchemaTotal} tempo=${tempoTotal}ms`
  });

  console.log(
    `[DFE][SYNC] ${correlationId} | FIM | novas=${notasNovasTotal} dup=${notasDuplicadasTotal}`
    + ` ign=${ignoradosTotal} eventos=${eventosTotal} tempo=${tempoTotal}ms`
  );

  return {
    sucesso: true,
    consultaExecutada: true,
    notasNovas: notasNovasTotal,
    notasDuplicadas: notasDuplicadasTotal,
    ignorados: ignoradosTotal,
    atualizados: atualizadosTotal,
    errosPersistencia: [],
    ultNsu: ultNsuAtual,
    maxNsu: maxNsuAtual,
    iteracoes,
    cStat: ultimoRetorno?.cStat || '138',
    correlationId,
    mensagem: notasNovasTotal > 0
      ? `${notasNovasTotal} nova(s) nota(s) sincronizada(s)`
      : 'Sincronização concluída — nenhuma nota nova',
    ultimaSincronizacao: controleNsu.dataSincronizacao || controleNsu.updatedAt
  };
}

/**
 * Compatibilidade legada — delega à sincronização oficial.
 *
 * @deprecated RC1 — Use POST /api/central-entradas/sincronizar
 * @returns {Promise<Object>}
 */
async function distribuirDocumentosRecebidos() {
  const resultado = await sincronizarDistribuicaoDFe();
  return {
    sucesso: resultado.sucesso,
    notasNovas: resultado.notasNovas,
    mensagem: resultado.mensagem,
    ultNsu: resultado.ultNsu,
    maxNsu: resultado.maxNsu
  };
}

/**
 * @param {string} chave
 * @param {Object} [deps]
 * @returns {Promise<Object>}
 */
async function consultarNotaPorChave(chave, deps = {}) {
  const identidade = await resolverIdentidadeConsultaChave(deps, {
    getFiscalConfig: deps.getFiscalConfig || getFiscalConfig
  });
  const config = identidade.config;
  const ambiente = identidade.ambiente;

  validarConfigFiscal(config);

  const chaveLimpa = String(chave || '').replace(/\D/g, '');
  if (chaveLimpa.length !== 44) {
    throw new Error('Chave deve conter 44 dígitos');
  }

  const cnpj = String(config.cnpj).replace(/\D/g, '');
  const codigoUf = obterCodigoUf(config);

  const ctxGate = montarContextoGateSefaz(deps, cnpj, ambiente, {
    chave: chaveLimpa,
    motivo: 'consChNFe',
    empresaId: identidade.empresaId ?? deps.contextoCentral?.empresaId ?? null
  });
  const negadoGate = await verificarGateSefaz(deps, ctxGate);
  if (negadoGate) {
    throw erroBloqueioGate(negadoGate);
  }

  const empresaIdOperacao = identidade.empresaId || ctxGate.empresaId || null;
  const auth = avaliarAutorizacaoTransmissao({
    autorizacao: deps.autorizacaoTransmissaoSefaz,
    empresaId: empresaIdOperacao,
    tipoConsulta: 'consChNFe'
  });
  if (!auth.ok) {
    emitirSefazConsulta('BLOQUEADA_AUTORIZACAO', {
      origem: deps.origemConsulta || deps.origemGate || null,
      correlationId: deps.correlationId || null,
      empresaId: empresaIdOperacao,
      tipoConsulta: 'consChNFe',
      codigo: auth.codigo,
      motivo: auth.mensagem,
      resultado: 'bloqueada'
    });
    throw criarErroTransmissaoNaoAutorizada(auth.mensagem, { codigo: auth.codigo });
  }
  await exigirOperacaoRealVivaSeAplicavel(deps, {
    empresaId: empresaIdOperacao,
    cnpj: cnpj || identidade.cnpj || auth.cnpj || null,
    tipoConsulta: 'consChNFe'
  });

  const executarConsultaAutorizada = async () => {
  const persistencia = deps.persistenciaService ?? new CentralDfePersistenciaService();

  const xmlConsulta = montarXmlConsChave({
    ambiente,
    codigoUf,
    cnpj,
    chave: chaveLimpa
  });

  const envio = await executarEnvioConsultaDfe(xmlConsulta, config, ambiente, {
    ...deps,
    tipoConsulta: 'consChNFe',
    cnpjConsulta: cnpj,
    empresaId: empresaIdOperacao
  });
  try {
    const metadados = extrairMetadadosRetorno(envio.body);
    await reportarGateSefaz(deps, metadados, { ...ctxGate, endpoint: envio.endpoint || null });

    if (!retornoDistSucesso(metadados.cStat) && metadados.cStat !== '138') {
      finalizarTelemetriaEnvio(envio, {
        sucesso: false,
        cStat: metadados.cStat,
        xMotivo: metadados.xMotivo,
        resultado: 'ERRO'
      });
      const erroRejeicao = new Error(metadados.xMotivo || `SEFAZ retornou cStat ${metadados.cStat}`);
      erroRejeicao.cStat = metadados.cStat || null;
      erroRejeicao.xMotivo = metadados.xMotivo || null;
      erroRejeicao.rejeicaoSefaz = true;
      erroRejeicao.consultaExecutada = true;
      erroRejeicao.respostaRecebida = true;
      erroRejeicao.recuperacaoConcluida = false;
      throw erroRejeicao;
    }

    const persistidos = await persistirDocumentosRetorno(envio.body, persistencia, 'consulta_chave', {
      cnpj,
      ambiente,
      empresaId: identidade.empresaId ?? persistencia._empresaId ?? null
    });

    const errosPersistencia = Array.isArray(persistidos.errosPersistencia)
      ? persistidos.errosPersistencia
      : [];
    const confirmacao = await confirmarDocumentoConsultaChave(
      persistencia,
      chaveLimpa,
      identidade.empresaId ?? persistencia._empresaId ?? empresaIdOperacao
    );
    const classificacao = classificarResultadoConsultaChave({
      persistidos,
      metadados,
      confirmacao
    });

    finalizarTelemetriaEnvio(envio, {
      sucesso: classificacao.recuperacaoConcluida || classificacao.estadoConsulta === ESTADOS_CONSULTA_SEFAZ.SEM_DOCUMENTO,
      cStat: metadados.cStat,
      xMotivo: metadados.xMotivo,
      persistidos: persistidos.notasNovas,
      duplicados: persistidos.notasDuplicadas,
      descartados: persistidos.ignorados,
      resultado: classificacao.persistenciaCompleta
        ? (classificacao.recuperacaoConcluida ? 'OK' : classificacao.estadoConsulta)
        : 'PERSISTENCIA_INCOMPLETA'
    });

    return {
      sucesso: classificacao.sucesso,
      consultaExecutada: true,
      sefazConsultada: true,
      respostaRecebida: true,
      persistenciaCompleta: classificacao.persistenciaCompleta,
      recuperacaoConcluida: classificacao.recuperacaoConcluida,
      estadoConsulta: classificacao.estadoConsulta,
      codigo: classificacao.codigo || null,
      chave: chaveLimpa,
      empresaId: identidade.empresaId ?? persistencia._empresaId ?? empresaIdOperacao,
      cStat: metadados.cStat,
      xMotivo: metadados.xMotivo || null,
      mensagem: classificacao.persistenciaCompleta
        ? metadados.xMotivo
        : `${errosPersistencia.length} documento(s) da consulta por chave não persistidos.`,
      notasNovas: persistidos.notasNovas,
      notasDuplicadas: persistidos.notasDuplicadas,
      ignorados: persistidos.ignorados,
      errosPersistencia,
      xmlPersistido: confirmacao.xmlPersistido === true
    };
  } catch (erro) {
    finalizarTelemetriaEnvio(envio, {
      sucesso: false,
      xMotivo: erro.message,
      resultado: 'ERRO'
    });
    throw erro;
  }
  };

  const mutex = deps.mutexTransmissaoSefaz || obterMutexTransmissaoSefaz();
  if (!deps.jaPossuiLockTransmissao && mutex && typeof mutex.comLock === 'function' && !mutex.estaNoContexto()) {
    const locked = await mutex.comLock('consChNFe', executarConsultaAutorizada);
    if (!locked.ok) {
      throw criarErroTransmissaoNaoAutorizada(
        locked.mensagem || 'Consulta por chave não executada: transmissão SEFAZ já em andamento.',
        {
          codigo: locked.codigo || 'TRANSMISSAO_SEFAZ_EM_ANDAMENTO',
          statusCode: 429,
          bloqueadoAutorizacao: false
        }
      );
    }
    return locked.valor;
  }

  return executarConsultaAutorizada();
}

/**
 * Lista documentos da Central (compatibilidade legada /api/dfe/consultar-notas).
 *
 * @deprecated RC1 — Use GET /api/central-entradas/documentos
 * @returns {Promise<Object>}
 */
async function consultarNotasRecebidas() {
  const repository = new CentralDocumentosRepository();
  const documentos = await repository.listar({ limite: 200, ordenarPor: 'created_at', ordenarDirecao: 'DESC' });

  return {
    sucesso: true,
    mensagem: 'Notas da Central Inteligente de Entradas',
    notas: documentos.map((doc) => ({
      id: doc.id,
      chave: doc.chave,
      numero: doc.numero,
      serie: doc.serie,
      fornecedor: doc.fornecedor,
      cnpj_fornecedor: doc.cnpjFornecedor,
      data_emissao: doc.dataEmissao,
      valor_total: doc.valorTotal,
      status: doc.status,
      origem: doc.origem,
      nsu: doc.nsu,
      created_at: doc.createdAt
    }))
  };
}

module.exports = {
  sincronizarDistribuicaoDFe,
  distribuirDocumentosRecebidos,
  consultarNotaPorChave,
  consultarNotasRecebidas,
  getDfeUrl,
  montarXmlDistNsu,
  montarXmlConsChave,
  extrairMetadadosRetorno,
  extrairDocumentosZip,
  persistirDocumentosRetorno,
  resolverEmpresaIdPersistenciaDfe,
  enviarConsultaDfe,
  validarConfigFiscal
};
