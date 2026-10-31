/**
 * CentralManifestacaoDfeService — Orquestra o fechamento RES_NFE → PROC_NFE.
 *
 * Reutiliza exclusivamente a Plataforma Fiscal existente:
 * manifestacaoRuntime + Registry + Resolver + SoapTransport + distribuicaoDFe.
 * Não implementa transporte SOAP, parser fiscal, MIIP ou promoção de documento.
 */

const crypto = require('crypto');
const { DocumentoFiscalStatus, isTerminal } = require('../core/DocumentoFiscalStatus');
const { DocumentoDfeTipo } = require('../core/DocumentoDfeTipo');
const { TIPOS_EVENTO, ORIGENS } = require('../config/centralEventosTipos');
const CentralDocumentosRepository = require('../repositories/CentralDocumentosRepository');
const CentralHistoricoRepository = require('../repositories/CentralHistoricoRepository');
const CentralEventosRepository = require('../repositories/CentralEventosRepository');
const CentralConfiguracaoService = require('./CentralConfiguracaoService');
const DocumentoTransitionService = require('./DocumentoTransitionService');
const { emitirEvento } = require('../utils/centralEventosEmitter');
const { logCentral, logCentralErro } = require('../utils/centralLog');
const { OperationType } = require('../../../services/fiscal/core/OperationType');
const {
  enviarManifestacao,
  montarEnvelopeManifestacao
} = require('../../../services/fiscal/manifestacaoRuntime');
const { sincronizarDistribuicaoDFe, consultarNotaPorChave } = require('../../../services/fiscal/distribuicaoDFe');
const CentralDfePersistenciaService = require('./CentralDfePersistenciaService');
const {
  obterContextoOperacionalDoDocumento,
  resolverEmpresaIdDocumento,
  camposLogContextoDocumento,
  permitirFallbackGlobalPorModo
} = require('./resolverContextoDocumentoCentral');
const {
  ESTADOS_MANIFESTACAO,
  montarCandidatoManifestacao
} = require('../contracts/CandidatoManifestacaoDTO');
const {
  URGENCIA_MANIFESTACAO,
  ORDEM_URGENCIA,
  calcularPrazoManifestacao,
  formatarDataHoraBrasil,
  formatarTempoRestante,
  montarMensagemAlertaPrazo
} = require('../utils/prazoManifestacao');
const { carregarCertificadoPfx } = require('../../../services/fiscal/certificateService');
const { assinarEvento } = require('../../../services/fiscal/signer');
const CentralNsuRepository = require('../repositories/CentralNsuRepository');
const CentralNsuService = require('./CentralNsuService');
const { criarCorrelationId, logOperacaoCentral } = require('../utils/centralOperacaoLog');
const { ResolutionSource } = require('../../../services/fiscal/core/ResolutionSource');

/**
 * Exceção documentada RC3.3.3:
 * A Plataforma Fiscal ainda possui fallback legado interno (manifestacaoLegado).
 * A Central NÃO aceita esse ramo — exige source PLATFORM e fallbackUtilizado=false.
 */

const POLITICAS_MANIFESTACAO = Object.freeze({
  MANUAL: 'MANUAL',
  AUTOMATICA_CIENCIA: 'AUTOMATICA_CIENCIA',
  CONFIRMAR_OPERADOR: 'CONFIRMAR_OPERADOR'
});

const CSTAT_MANIFESTACAO_ACEITA = new Set(['135', '573']);
/** RC7.4.7 — cStat 596 no evento 210210 (prazo). Não prova ausência de procNFe. */
const CSTAT_XML_INDISPONIVEL = new Set(['596']);
const MENSAGEM_XML_INDISPONIVEL =
  'XML completo indisponível: evento apresentado após o prazo permitido pela SEFAZ.';
const INTERVALO_SEGURO_MS = 60 * 60 * 1000;
/**
 * CE-05 — validade do claim de Ciência (MANIFESTACAO_CLAIM). Precisa superar com folga o
 * timeout SOAP da SEFAZ (FISCAL_SOAP_TIMEOUT_MS, padrão 90 s) para nunca expirar um envio vivo.
 */
const TTL_CLAIM_MANIFESTACAO_MS = 10 * 60 * 1000;
const LIMITE_CANDIDATOS_PADRAO = 10;
/**
 * CE-06 P01 — documentos AGUARDANDO_XML_COMPLETO avaliados por ciclo, dos mais recentes
 * por emissão (os únicos que podem estar dentro do prazo da ciência).
 */
const LIMITE_AVALIACAO_CANDIDATOS = 500;
const MOTIVOS_EXCLUSAO_CANDIDATO = Object.freeze({
  TIPO_NAO_ELEGIVEL: 'TIPO_NAO_ELEGIVEL',
  SEM_EMPRESA: 'SEM_EMPRESA',
  CONTEXTO_INVALIDO: 'CONTEXTO_INVALIDO',
  CIENCIA_ACEITA: 'CIENCIA_ACEITA',
  PRAZO_EXPIRADO_596: 'PRAZO_EXPIRADO_596',
  CLAIM_ATIVO: 'CLAIM_ATIVO',
  GATE_BLOQUEADO: 'GATE_BLOQUEADO',
  JANELA_FUTURA: 'JANELA_FUTURA',
  /** CENTRAL-XML-02 P5 — janela da ciência encerrada: sai da fila automática, sem 210210. */
  FORA_DO_PRAZO: 'CIENCIA_FORA_DO_PRAZO',
  /** Sem dhEmi com hora e offset: prazo real desconhecido, sem ciência automática. */
  PRAZO_INDETERMINADO: 'PRAZO_INDETERMINADO'
});
const CODIGO_CIENCIA_FORA_DO_PRAZO = 'CIENCIA_FORA_DO_PRAZO';
const MENSAGEM_AGUARDANDO_XML =
  'Aguardando disponibilização do XML completo pela SEFAZ.';
const MENSAGEM_AGUARDANDO_JANELA_596 =
  'Consulta por chave aguardando a próxima janela (ciência rejeitada por prazo — 596).';

/**
 * Lock por documento compartilhado entre instâncias (sincronização, botão, MIRX e
 * Motor de Recuperação criam instâncias próprias): no máximo uma operação SEFAZ por documento.
 */
const LOCKS_DOCUMENTO_SEFAZ = new Set();

function adquirirLockDocumentoSefaz(documentoId) {
  const id = Number(documentoId);
  if (!id || LOCKS_DOCUMENTO_SEFAZ.has(id)) return false;
  LOCKS_DOCUMENTO_SEFAZ.add(id);
  return true;
}

function liberarLockDocumentoSefaz(documentoId) {
  LOCKS_DOCUMENTO_SEFAZ.delete(Number(documentoId));
}

/**
 * CENTRAL-XML-02 P3 — um ciclo de manifestação por processo (scheduler e pós-sincronização
 * usam instâncias próprias). Entre processos, o claim atômico continua sendo a garantia.
 */
const CICLO_MANIFESTACAO = { ativo: false, desde: null };

function mascararCnpj(cnpj) {
  const d = String(cnpj || '').replace(/\D/g, '');
  if (d.length !== 14) return d ? '***' : null;
  return `${d.slice(0, 2)}.***.***/${d.slice(8, 12)}-${d.slice(12)}`;
}

function msOuInfinito(iso) {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

/** Menor prazo restante → emissão mais antiga → chave → id (determinístico). */
function compararCandidatos(a, b) {
  const ta = Number.isFinite(a.tempoRestanteMs) ? a.tempoRestanteMs : Infinity;
  const tb = Number.isFinite(b.tempoRestanteMs) ? b.tempoRestanteMs : Infinity;
  if (ta !== tb) return ta < tb ? -1 : 1;
  const limite = msOuInfinito(a.dataLimiteManifestacao) - msOuInfinito(b.dataLimiteManifestacao);
  if (limite !== 0 && !Number.isNaN(limite)) return limite < 0 ? -1 : 1;
  const emissao = msOuInfinito(a.dataEmissao) - msOuInfinito(b.dataEmissao);
  if (emissao !== 0 && !Number.isNaN(emissao)) return emissao < 0 ? -1 : 1;
  const chave = String(a.chave || '').localeCompare(String(b.chave || ''));
  if (chave !== 0) return chave;
  return (Number(a.documentoId) || 0) - (Number(b.documentoId) || 0);
}

/**
 * Cota justa por empresa: round-robin sobre as filas já ordenadas por urgência.
 * Empresas visitadas pela urgência do seu primeiro candidato (empate: menor empresaId).
 * Uma empresa sozinha pode preencher o lote.
 */
function distribuirPorEmpresa(elegiveisOrdenados, limite) {
  const filas = new Map();
  for (const item of elegiveisOrdenados) {
    const chave = item.candidato.empresaId ?? 0;
    if (!filas.has(chave)) filas.set(chave, []);
    filas.get(chave).push(item);
  }
  const ordemEmpresas = [...filas.keys()].sort((a, b) => {
    const c = compararCandidatos(filas.get(a)[0].candidato, filas.get(b)[0].candidato);
    return c !== 0 ? c : Number(a) - Number(b);
  });
  const selecionados = [];
  let restante = true;
  while (selecionados.length < limite && restante) {
    restante = false;
    for (const empresa of ordemEmpresas) {
      if (selecionados.length >= limite) break;
      const fila = filas.get(empresa);
      if (fila.length) {
        selecionados.push(fila.shift());
        restante = true;
      }
    }
  }
  return selecionados;
}

function decodificarEntidadesXml(texto) {
  return String(texto || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function extrairTag(xml, tag) {
  const regex = new RegExp(`<(?:[\\w.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${tag}>`, 'i');
  return String(xml || '').match(regex)?.[1]?.trim() || null;
}

function extrairRetornoManifestacao(body) {
  const xml = decodificarEntidadesXml(body);
  const blocoRetEvento = xml.match(
    /<(?:[\w.-]+:)?retEvento(?:\s[^>]*)?>[\s\S]*?<\/(?:[\w.-]+:)?retEvento>/i
  )?.[0] || xml;
  const blocoInfEvento = blocoRetEvento.match(
    /<(?:[\w.-]+:)?infEvento(?:\s[^>]*)?>[\s\S]*?<\/(?:[\w.-]+:)?infEvento>/i
  )?.[0] || blocoRetEvento;

  const cStat = extrairTag(blocoInfEvento, 'cStat');
  return {
    cStat,
    xMotivo: extrairTag(blocoInfEvento, 'xMotivo'),
    protocolo: extrairTag(blocoInfEvento, 'nProt'),
    dataRegistro: extrairTag(blocoInfEvento, 'dhRegEvento'),
    aceita: CSTAT_MANIFESTACAO_ACEITA.has(String(cStat || '')),
    duplicada: String(cStat || '') === '573'
  };
}

function formatarDhEventoBrasil(data = new Date()) {
  const offsetMin = -data.getTimezoneOffset();
  const sinal = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  const local = new Date(data.getTime() - data.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 19);
  return `${local}${sinal}${hh}:${mm}`;
}

function ajustarEventoManifestacaoDestinatario(eventoXml, params = {}) {
  let evento = String(eventoXml || '');
  // Manifestação do destinatário: cOrgao=91 (Ambiente Nacional) — NT 2020.001 P08.
  evento = evento.replace(
    /(<cOrgao>)[^<]*(<\/cOrgao>)/i,
    `$1${params.cOrgao || '91'}$2`
  );
  const dhEvento = params.dhEvento || formatarDhEventoBrasil();
  evento = evento.replace(
    /(<dhEvento>)[^<]*(<\/dhEvento>)/i,
    `$1${dhEvento}$2`
  );
  return evento;
}

function prepararEnvelopeAssinado(params, deps = {}) {
  const montarEnvelope = deps.montarEnvelopeManifestacao || montarEnvelopeManifestacao;
  const carregarCertificado = deps.carregarCertificado || carregarCertificadoPfx;
  const assinar = deps.assinarEvento || assinarEvento;
  const envelope = montarEnvelope({
    ...params,
    cOrgao: params.cOrgao || '91',
    dhEvento: params.dhEvento || formatarDhEventoBrasil()
  });
  const evento = String(envelope).match(
    /<(?:[\w.-]+:)?evento(?:\s[^>]*)?>[\s\S]*?<\/(?:[\w.-]+:)?evento>/i
  )?.[0];

  if (!evento) {
    throw new Error('Evento de manifestação não encontrado no envelope da Plataforma Fiscal.');
  }

  const eventoAjustado = ajustarEventoManifestacaoDestinatario(evento, {
    cOrgao: '91',
    dhEvento: params.dhEvento || formatarDhEventoBrasil()
  });
  const certificado = carregarCertificado(params.certificadoPath, params.certificadoSenha);
  const assinatura = assinar(eventoAjustado, certificado.privateKeyPem, certificado.certPem);
  if (!assinatura?.xmlAssinado) {
    throw new Error('Assinatura da Ciência da Emissão não foi gerada.');
  }

  return String(envelope).replace(evento, assinatura.xmlAssinado);
}

class CentralManifestacaoDfeService {
  constructor(deps = {}) {
    const repoDeps = { db: deps.db ?? null };
    this._documentosRepository = deps.documentosRepository
      ?? new CentralDocumentosRepository(repoDeps);
    this._historicoRepository = deps.historicoRepository
      ?? new CentralHistoricoRepository(repoDeps);
    this._eventosRepository = deps.eventosRepository
      ?? new CentralEventosRepository(repoDeps);
    this._configuracao = deps.configuracaoService
      ?? new CentralConfiguracaoService({ configuracaoRepository: deps.configuracaoRepository });
    this._enviarManifestacao = deps.enviarManifestacao || enviarManifestacao;
    this._sincronizarDfe = deps.sincronizarDfe || sincronizarDistribuicaoDFe;
    this._consultarNotaPorChave = deps.consultarNotaPorChave || consultarNotaPorChave;
    this._autorizacaoTransmissaoSefaz = deps.autorizacaoTransmissaoSefaz || null;
    this._criarPersistencia = deps.criarPersistencia || ((empresaId) => (
      new CentralDfePersistenciaService({
        documentosRepository: this._documentosRepository,
        historicoRepository: this._historicoRepository,
        db: deps.db ?? null,
        empresaId
      })
    ));
    this._nsuRepository = deps.nsuRepository
      ?? new CentralNsuRepository(repoDeps);
    this._nsuService = deps.nsuService
      ?? new CentralNsuService({ nsuRepository: this._nsuRepository });
    this._syncExecucao = deps.syncExecucao || null;
    this._emitirEvento = deps.emitirEvento || emitirEvento;
    this._prepararEnvelopeAssinado = deps.prepararEnvelopeAssinado || prepararEnvelopeAssinado;
    this._transitionService = deps.transitionService
      ?? new DocumentoTransitionService({
        documentosRepository: this._documentosRepository,
        historicoRepository: this._historicoRepository
      });
    this._cancelarXmlWait = deps.cancelarXmlWait || ((documentoId, motivo) => {
      try {
        require('./CentralXmlWaitScheduler').cancelar(documentoId, motivo || 'xml_indisponivel');
      } catch { /* scheduler opcional em testes */ }
    });
    this._agora = deps.agora || (() => new Date());
    this._emExecucao = deps.locksDocumento || LOCKS_DOCUMENTO_SEFAZ;
    this._ciclo = deps.cicloManifestacao || CICLO_MANIFESTACAO;
    this._gateDep = deps.gate;
    this._obterModoOperacionalGlobal = typeof deps.obterModoOperacionalGlobal === 'function'
      ? deps.obterModoOperacionalGlobal
      : null;
  }

  /** Gate SEFAZ oficial (singleton), ou o injetado; `gate: null` desliga (somente testes legados). */
  _obterGate() {
    if (this._gateDep === null || this._gateDep === false) return null;
    if (this._gateDep) return this._gateDep;
    try {
      return require('./CentralSefazOperationalGate');
    } catch {
      return null;
    }
  }

  _contextoGate(contexto, documento, extra = {}) {
    return {
      empresaId: Number(contexto?.empresaId) || resolverEmpresaIdDocumento(documento) || null,
      cnpj: contexto?.cnpj || null,
      ambiente: contexto?.ambiente,
      documentoId: documento?.id != null ? Number(documento.id) : null,
      chave: documento?.chave || null,
      origem: 'CentralManifestacaoDfeService',
      ...extra
    };
  }

  /**
   * Consulta única ao Gate antes de acessar a SEFAZ. Retorna null se liberado,
   * ou o resultado de espera (sem SOAP, sem evento, sem alterar janela do documento).
   */
  async _verificarGate(contexto, documento, opcoes = {}, motivo = 'central_sefaz') {
    const gate = this._obterGate();
    if (!gate || typeof gate.autorizarConsultaDistDfe !== 'function') return null;
    let auth;
    try {
      auth = await gate.autorizarConsultaDistDfe(this._contextoGate(contexto, documento, {
        correlationId: opcoes.correlationId || null,
        motivo,
        forcarAdminConfirmado: opcoes.forcarAdminConfirmado === true,
        confirmacaoAdmin: opcoes.confirmacaoAdmin === true
      }));
    } catch {
      return null;
    }
    if (!auth || auth.permitido !== false) return null;
    logCentral('MANIFESTACAO', {
      mensagem: 'SEFAZ não acessada: Gate bloqueado para a empresa do documento',
      Etapa: 'gate_bloqueado',
      Motivo: motivo,
      codigo: auth.codigo || null,
      proximaConsultaEm: auth.proximaConsultaEm || null,
      ...camposLogContextoDocumento(contexto, documento)
    });
    return {
      documentoId: documento?.id != null ? Number(documento.id) : null,
      sucesso: false,
      ignorado: true,
      bloqueadoGate: true,
      codigo: auth.codigo || 'GATE_BLOQUEADO',
      escopoGate: auth.escopo || null,
      xmlCompleto: false,
      encerrado: false,
      aguardandoDisponibilizacao: true,
      proximaConsultaEm: auth.proximaConsultaEm || null,
      mensagem: auth.mensagem || 'Consulta bloqueada pelo Gate SEFAZ.'
    };
  }

  async _reportarGate(fiscal, contexto, documento, extra = {}) {
    const gate = this._obterGate();
    if (!gate || typeof gate.processarRespostaSefaz !== 'function' || !fiscal?.cStat) return;
    try {
      await gate.processarRespostaSefaz({
        cStat: String(fiscal.cStat),
        xMotivo: fiscal.xMotivo || null,
        mensagem: fiscal.xMotivo || null
      }, this._contextoGate(contexto, documento, extra));
    } catch { /* Gate indisponível não interrompe a manifestação */ }
  }

  _depsSoap(contexto, documento, opcoes = {}) {
    const gate = this._obterGate();
    return {
      gateSefaz: gate || undefined,
      documentoId: documento?.id != null ? Number(documento.id) : null,
      origemGate: 'CentralManifestacaoDfeService',
      correlationId: opcoes.correlationId || null,
      empresaId: contexto?.empresaId || resolverEmpresaIdDocumento(documento) || null,
      autorizacaoTransmissaoSefaz: opcoes.autorizacaoTransmissaoSefaz
        || this._autorizacaoTransmissaoSefaz
        || null
    };
  }

  async processarCandidatos(opcoes = {}) {
    const politica = opcoes.politica
      || await this._configuracao.obterPoliticaManifestacao();
    const automatico = politica === POLITICAS_MANIFESTACAO.AUTOMATICA_CIENCIA;

    if (!automatico) {
      return {
        politica,
        executado: false,
        candidatos: 0,
        resultados: [],
        mensagem: politica === POLITICAS_MANIFESTACAO.CONFIRMAR_OPERADOR
          ? 'Documentos aguardam confirmação do operador.'
          : 'Manifestação automática desabilitada (modo manual).'
      };
    }

    if (this._ciclo.ativo) {
      logCentral('MANIFESTACAO', {
        mensagem: 'Ciclo de manifestação já em execução neste processo — chamada ignorada',
        Etapa: 'ciclo_em_execucao',
        origem: opcoes.origemCiclo || null,
        desde: this._ciclo.desde
      });
      return {
        politica,
        executado: false,
        emExecucao: true,
        candidatos: 0,
        resultados: [],
        mensagem: 'Ciclo de manifestação já em execução.'
      };
    }

    this._ciclo.ativo = true;
    this._ciclo.desde = this._agora().toISOString();
    try {
      const limite = Math.max(
        1,
        Math.min(Number(opcoes.limite) || LIMITE_CANDIDATOS_PADRAO, 50)
      );
      const selecao = await this._selecionarCandidatosManifestacao({
        limite,
        empresaId: opcoes.empresaId
      });
      const candidatos = selecao.selecionados;
      await this._registrarTelemetriaSelecao(selecao, opcoes);
      const resultados = [];

      for (const documento of candidatos) {
        try {
          // Execução serial deliberada: evita rajada de eventos/consultas à SEFAZ.
          // eslint-disable-next-line no-await-in-loop
          resultados.push(await this.processarDocumento(documento.id, {
            ...opcoes,
            politica,
            automatico: true,
            origemAutomatica: true,
            // DistDFe já é responsabilidade da sincronização oficial (ultNSU).
            apenasManifestacao: opcoes.apenasManifestacao !== false
          }));
        } catch (error) {
          logCentralErro('MANIFESTACAO', error, { documentoId: documento.id });
          resultados.push({
            documentoId: documento.id,
            sucesso: false,
            mensagem: error.message
          });
        }
      }

      return {
        politica,
        executado: true,
        candidatos: candidatos.length,
        concluidos: resultados.filter((r) => r.xmlCompleto).length,
        resultados,
        selecao: {
          avaliados: selecao.avaliados,
          elegiveis: selecao.elegiveis,
          excluidosPorMotivo: selecao.excluidosPorMotivo,
          porEmpresa: selecao.porEmpresa,
          porUrgencia: selecao.porUrgencia
        }
      };
    } finally {
      this._ciclo.ativo = false;
      this._ciclo.desde = null;
    }
  }

  /** Contexto de empresa presente em todo evento de telemetria da manifestação (P9). */
  _contextoTelemetria(contexto, documento, candidato = null) {
    const empresaId = Number(contexto?.empresaId)
      || Number(candidato?.empresaId)
      || resolverEmpresaIdDocumento(documento || {})
      || null;
    return {
      empresaId,
      cnpjMascarado: mascararCnpj(contexto?.cnpj || candidato?.cnpj),
      ambiente: contexto?.ambiente != null ? Number(contexto.ambiente) : null
    };
  }

  _detalhePrazo(prazo) {
    if (!prazo) return {};
    return {
      dhEmi: prazo.dhEmi || null,
      prazoFinal: prazo.prazoFinal || prazo.dataLimiteManifestacao || null,
      prazoFinalLocal: formatarDataHoraBrasil(prazo.prazoFinal || prazo.dataLimiteManifestacao),
      tempoRestanteMs: prazo.tempoRestanteMs ?? null,
      urgencia: prazo.urgencia || null
    };
  }

  async _telemetria(tipo, { documentoId = null, descricao, resultado = null, sucesso = null, detalhe = {} }) {
    try {
      return await this._eventosRepository.inserir({
        tipo,
        origem: ORIGENS.SISTEMA,
        descricao,
        resultado,
        sucesso,
        documentoId,
        detalhe
      });
    } catch (error) {
      logCentralErro('MANIFESTACAO', error, { Etapa: 'telemetria', tipo, documentoId });
      return null;
    }
  }

  async _existeEvento(tipo, documentoId, predicado = () => true) {
    try {
      const eventos = await this._eventosRepository.listar({ tipo, documentoId, limite: 20 });
      return (eventos || []).some((e) => predicado(e));
    } catch {
      return false;
    }
  }

  /**
   * P5 — marca uma única vez: janela da ciência encerrada, sem 210210 e fora da fila automática.
   * @returns {Promise<boolean>} true se o evento foi registrado agora
   */
  async _marcarForaDoPrazo(documento, contexto, prazo, candidato = null) {
    const documentoId = Number(documento?.id ?? documento?.documentoId) || null;
    if (!documentoId) return false;
    if (await this._existeEvento(TIPOS_EVENTO.MANIFESTACAO_FORA_DO_PRAZO, documentoId)) return false;
    await this._telemetria(TIPOS_EVENTO.MANIFESTACAO_FORA_DO_PRAZO, {
      documentoId,
      descricao: `Ciência da Emissão fora do prazo (encerrado em ${formatarDataHoraBrasil(prazo?.prazoFinal || prazo?.dataLimiteManifestacao)}). `
        + '210210 não será enviado; documento retirado da manifestação automática.',
      resultado: CODIGO_CIENCIA_FORA_DO_PRAZO,
      sucesso: false,
      detalhe: {
        codigo: CODIGO_CIENCIA_FORA_DO_PRAZO,
        chave: documento?.chave || candidato?.chave || null,
        ...this._contextoTelemetria(contexto, documento, candidato),
        ...this._detalhePrazo(prazo)
      }
    });
    return true;
  }

  /** P6/P9 — candidatos, alertas de prazo, fora do prazo, Gate e claim (sem SOAP). */
  async _registrarTelemetriaSelecao(selecao, opcoes = {}) {
    const correlationId = opcoes.correlationId || null;
    const contextoDe = (c) => selecao.contextos?.get(c.documentoId) || null;
    for (const c of selecao.candidatos || []) {
      // eslint-disable-next-line no-await-in-loop
      await this._telemetria(TIPOS_EVENTO.MANIFESTACAO_CANDIDATO, {
        documentoId: c.documentoId,
        descricao: `Candidato à Ciência da Emissão (${c.urgencia}).`,
        resultado: c.urgencia,
        detalhe: {
          chave: c.chave,
          correlationId,
          ...this._contextoTelemetria(contextoDe(c), null, c),
          ...this._detalhePrazo(c)
        }
      });
    }

    for (const c of selecao.elegiveisCandidatos || []) {
      if (![URGENCIA_MANIFESTACAO.ATENCAO, URGENCIA_MANIFESTACAO.URGENTE].includes(c.urgencia)) continue;
      // eslint-disable-next-line no-await-in-loop
      const jaAlertado = await this._existeEvento(
        TIPOS_EVENTO.MANIFESTACAO_ALERTA_PRAZO,
        c.documentoId,
        (e) => e.detalhe?.urgencia === c.urgencia
      );
      if (jaAlertado) continue;
      // eslint-disable-next-line no-await-in-loop
      await this._telemetria(TIPOS_EVENTO.MANIFESTACAO_ALERTA_PRAZO, {
        documentoId: c.documentoId,
        descricao: montarMensagemAlertaPrazo({
          numero: c.numero,
          chave: c.chave,
          prazoFinal: c.dataLimiteManifestacao,
          tempoRestanteMs: c.tempoRestanteMs,
          urgencia: c.urgencia
        }),
        resultado: c.urgencia,
        detalhe: { chave: c.chave, ...this._contextoTelemetria(contextoDe(c), null, c), ...this._detalhePrazo(c) }
      });
    }

    const gatePorEmpresa = new Map();
    for (const e of selecao.excluidos || []) {
      if (e.motivo === MOTIVOS_EXCLUSAO_CANDIDATO.FORA_DO_PRAZO && e.candidato) {
        // eslint-disable-next-line no-await-in-loop
        await this._marcarForaDoPrazo(
          { id: e.documentoId, chave: e.candidato.chave, empresaId: e.empresaId },
          e.contexto,
          e.candidato,
          e.candidato
        );
      } else if (e.motivo === MOTIVOS_EXCLUSAO_CANDIDATO.CLAIM_ATIVO) {
        // eslint-disable-next-line no-await-in-loop
        await this._telemetria(TIPOS_EVENTO.MANIFESTACAO_CLAIM_OCUPADO, {
          documentoId: e.documentoId,
          descricao: 'Claim de Ciência ativo em outro worker — documento ignorado neste ciclo.',
          resultado: 'CLAIM_OCUPADO',
          detalhe: { correlationId, ...this._contextoTelemetria(e.contexto, null, e.candidato) }
        });
      } else if (e.motivo === MOTIVOS_EXCLUSAO_CANDIDATO.GATE_BLOQUEADO) {
        const chave = String(e.empresaId ?? 'sem_empresa');
        const atual = gatePorEmpresa.get(chave) || { contexto: e.contexto, candidato: e.candidato, documentos: 0 };
        atual.documentos += 1;
        gatePorEmpresa.set(chave, atual);
      }
    }
    for (const g of gatePorEmpresa.values()) {
      // eslint-disable-next-line no-await-in-loop
      await this._telemetria(TIPOS_EVENTO.MANIFESTACAO_BLOQUEADA_GATE, {
        descricao: `Gate SEFAZ bloqueado para a empresa — ${g.documentos} documento(s) sem ciência neste ciclo.`,
        resultado: 'GATE_BLOQUEADO',
        detalhe: {
          documentos: g.documentos,
          correlationId,
          ...this._contextoTelemetria(g.contexto, null, g.candidato)
        }
      });
    }
  }

  async _listarPendentesManifestacao() {
    const repo = this._documentosRepository;
    if (typeof repo.listarPendentesManifestacao === 'function') {
      return repo.listarPendentesManifestacao(LIMITE_AVALIACAO_CANDIDATOS);
    }
    return repo.listarPorStatus(DocumentoFiscalStatus.AGUARDANDO_XML_COMPLETO, LIMITE_AVALIACAO_CANDIDATOS);
  }

  _opcoesModo() {
    return this._obterModoOperacionalGlobal
      ? { obterModoOperacionalGlobal: this._obterModoOperacionalGlobal }
      : {};
  }

  /**
   * CE-06 P01 — candidatos à ciência 210210: somente pendentes reais, dentro do prazo,
   * com empresa e contexto válidos, sem claim vivo, sem Gate bloqueado e sem janela futura.
   * Urgência: menor prazo restante → emissão → chave/id. Lote distribuído por empresa (round-robin).
   * @returns {Promise<{ selecionados: Object[], candidatos: Object[], excluidos: Object[],
   *   avaliados: number, elegiveis: number, excluidosPorMotivo: Object, porEmpresa: Object }>}
   */
  /**
   * P6 — Estado de prazo da Ciência por empresa (somente leitura; sem Gate, claim ou SOAP).
   * O backend é a autoridade do prazo: a interface apenas exibe estes valores.
   */
  async obterPainelPrazos({ empresaId = null, limiteItens = 100 } = {}) {
    const agora = this._agora();
    const empresaFiltro = empresaId != null ? Number(empresaId) : null;
    const pendentes = await this._listarPendentesManifestacao();
    const contagem = {
      [URGENCIA_MANIFESTACAO.URGENTE]: 0,
      [URGENCIA_MANIFESTACAO.ATENCAO]: 0,
      [URGENCIA_MANIFESTACAO.NORMAL]: 0,
      [URGENCIA_MANIFESTACAO.EXPIRADO]: 0,
      [URGENCIA_MANIFESTACAO.INDETERMINADO]: 0,
      CIENCIA_ACEITA: 0,
      CIENCIA_REJEITADA_596: 0
    };
    const itens = [];

    for (const documento of pendentes) {
      if (documento.tipoDocumento !== DocumentoDfeTipo.RES_NFE) continue;
      const docEmpresa = resolverEmpresaIdDocumento(documento);
      if (empresaFiltro != null && Number(docEmpresa) !== empresaFiltro) continue;

      // eslint-disable-next-line no-await-in-loop
      const estado = await this._estadoManifestacaoCandidato(documento, agora);
      const dto = montarCandidatoManifestacao(documento, estado, agora);
      if (estado.cienciaAceita) {
        contagem.CIENCIA_ACEITA += 1;
        continue;
      }
      if (estado.cStatCiencia === '596') {
        contagem.CIENCIA_REJEITADA_596 += 1;
        continue;
      }
      contagem[dto.urgencia] = (contagem[dto.urgencia] || 0) + 1;
      itens.push(dto);
    }

    itens.sort(compararCandidatos);
    return {
      empresaId: empresaFiltro,
      geradoEm: agora.toISOString(),
      prazoCienciaDias: 10,
      contagem,
      itens: itens.slice(0, Math.max(1, Math.min(Number(limiteItens) || 100, 500))).map((c) => ({
        documentoId: c.documentoId,
        empresaId: c.empresaId,
        chave: c.chave,
        numero: c.numero,
        dhEmi: c.dhEmi,
        prazoFinal: c.dataLimiteManifestacao,
        prazoFinalLocal: formatarDataHoraBrasil(c.dataLimiteManifestacao),
        tempoRestanteMs: c.tempoRestanteMs,
        tempoRestante: formatarTempoRestante(c.tempoRestanteMs),
        urgencia: c.urgencia,
        motivoPrazoInvalido: c.motivoPrazoInvalido,
        mensagem: c.prazoValido
          ? montarMensagemAlertaPrazo({
            numero: c.numero,
            chave: c.chave,
            prazoFinal: c.dataLimiteManifestacao,
            tempoRestanteMs: c.tempoRestanteMs,
            urgencia: c.urgencia
          })
          : 'Prazo indeterminado: documento sem data/hora de emissão com fuso.'
      })),
      scheduler: this._statusScheduler()
    };
  }

  _statusScheduler() {
    try {
      return require('./CentralManifestacaoScheduler').obterStatus();
    } catch {
      return null;
    }
  }

  async _selecionarCandidatosManifestacao({ limite = LIMITE_CANDIDATOS_PADRAO, empresaId = null } = {}) {
    const agora = this._agora();
    let pendentes = await this._listarPendentesManifestacao();
    if (empresaId != null) {
      const alvo = Number(empresaId);
      pendentes = pendentes.filter((documento) => Number(resolverEmpresaIdDocumento(documento)) === alvo);
    }
    const permitirSemEmpresa = permitirFallbackGlobalPorModo(this._opcoesModo());
    const cacheContexto = new Map();
    const cacheGate = new Map();
    const elegiveis = [];
    const excluidos = [];
    const excluir = (documento, motivo, extra = {}) => {
      excluidos.push({
        documentoId: Number(documento.id) || null,
        motivo,
        empresaId: extra.candidato?.empresaId ?? resolverEmpresaIdDocumento(documento) ?? null,
        candidato: extra.candidato || null,
        contexto: extra.contexto
          ? { empresaId: extra.contexto.empresaId ?? null, cnpj: extra.contexto.cnpj || null, ambiente: extra.contexto.ambiente ?? null }
          : null
      });
    };

    for (const documento of pendentes) {
      if (documento.tipoDocumento !== DocumentoDfeTipo.RES_NFE) {
        excluir(documento, MOTIVOS_EXCLUSAO_CANDIDATO.TIPO_NAO_ELEGIVEL);
        continue;
      }
      const empresaId = resolverEmpresaIdDocumento(documento);
      if (!empresaId && !permitirSemEmpresa) {
        excluir(documento, MOTIVOS_EXCLUSAO_CANDIDATO.SEM_EMPRESA);
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const contexto = await this._contextoCandidato(documento, empresaId, cacheContexto);
      if (!contexto) {
        excluir(documento, MOTIVOS_EXCLUSAO_CANDIDATO.CONTEXTO_INVALIDO);
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const estado = await this._estadoManifestacaoCandidato(documento, agora);
      if (estado.cienciaAceita || estado.cStatCiencia === '596') {
        const dto = montarCandidatoManifestacao(documento, { cnpj: contexto.cnpj, ...estado }, agora);
        excluir(documento, dto.estadoManifestacao === ESTADOS_MANIFESTACAO.CIENCIA_ACEITA
          ? MOTIVOS_EXCLUSAO_CANDIDATO.CIENCIA_ACEITA
          : MOTIVOS_EXCLUSAO_CANDIDATO.PRAZO_EXPIRADO_596);
        continue;
      }

      // P5 — prazo antes de claim/Gate: documento vencido nunca consulta o Gate nem gera SOAP.
      const semGate = montarCandidatoManifestacao(documento, { cnpj: contexto.cnpj, ...estado }, agora);
      const extra = { candidato: semGate, contexto };
      if (!semGate.prazoValido) {
        excluir(documento, MOTIVOS_EXCLUSAO_CANDIDATO.PRAZO_INDETERMINADO, extra);
        continue;
      }
      if (semGate.expirado) {
        excluir(documento, MOTIVOS_EXCLUSAO_CANDIDATO.FORA_DO_PRAZO, extra);
        continue;
      }
      if (semGate.claimAtivo) {
        excluir(documento, MOTIVOS_EXCLUSAO_CANDIDATO.CLAIM_ATIVO, extra);
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const gateBloqueado = await this._gateBloqueadoCandidato(contexto, documento, cacheGate);
      const dto = montarCandidatoManifestacao(documento, {
        cnpj: contexto.cnpj,
        ...estado,
        gateBloqueado
      }, agora);

      if (dto.gateBloqueado) {
        excluir(documento, MOTIVOS_EXCLUSAO_CANDIDATO.GATE_BLOQUEADO, { candidato: dto, contexto });
      } else if (dto.proximaConsultaEm && agora < new Date(dto.proximaConsultaEm)) {
        excluir(documento, MOTIVOS_EXCLUSAO_CANDIDATO.JANELA_FUTURA, { candidato: dto, contexto });
      } else if (dto.prioridade == null) {
        excluir(documento, MOTIVOS_EXCLUSAO_CANDIDATO.FORA_DO_PRAZO, { candidato: dto, contexto });
      } else {
        elegiveis.push({
          documento,
          candidato: dto,
          contexto: { empresaId: contexto.empresaId ?? null, cnpj: contexto.cnpj || null, ambiente: contexto.ambiente ?? null }
        });
      }
    }

    // P4 — menor tempo restante → prazo → emissão → chave → id. P3 — URGENTE e ATENCAO em ordem
    // estrita de urgência (tempo curto vence a cota por empresa); NORMAL com round-robin por empresa.
    elegiveis.sort((a, b) => compararCandidatos(a.candidato, b.candidato));
    const selecionadosComCandidato = [];
    const porUrgencia = {};
    for (const urgencia of ORDEM_URGENCIA) {
      const faixa = elegiveis.filter((e) => e.candidato.urgencia === urgencia);
      porUrgencia[urgencia] = faixa.length;
      const restante = limite - selecionadosComCandidato.length;
      if (restante <= 0 || !faixa.length) continue;
      selecionadosComCandidato.push(...(urgencia === URGENCIA_MANIFESTACAO.NORMAL
        ? distribuirPorEmpresa(faixa, restante)
        : faixa.slice(0, restante)));
    }

    const excluidosPorMotivo = {};
    for (const e of excluidos) {
      excluidosPorMotivo[e.motivo] = (excluidosPorMotivo[e.motivo] || 0) + 1;
    }
    const porEmpresa = {};
    for (const s of selecionadosComCandidato) {
      const chave = String(s.candidato.empresaId ?? 'sem_empresa');
      porEmpresa[chave] = (porEmpresa[chave] || 0) + 1;
    }

    logCentral('MANIFESTACAO', {
      mensagem: 'Seleção de candidatos à ciência (P01)',
      Etapa: 'selecao_candidatos',
      avaliados: pendentes.length,
      elegiveis: elegiveis.length,
      selecionados: selecionadosComCandidato.length,
      limite,
      excluidosPorMotivo: JSON.stringify(excluidosPorMotivo),
      porEmpresa: JSON.stringify(porEmpresa),
      porUrgencia: JSON.stringify(porUrgencia)
    });

    return {
      selecionados: selecionadosComCandidato.map((s) => s.documento),
      candidatos: selecionadosComCandidato.map((s) => s.candidato),
      elegiveisCandidatos: elegiveis.map((e) => e.candidato),
      contextos: new Map(elegiveis.map((e) => [e.candidato.documentoId, e.contexto])),
      excluidos,
      avaliados: pendentes.length,
      elegiveis: elegiveis.length,
      excluidosPorMotivo,
      porEmpresa,
      porUrgencia
    };
  }

  async _contextoCandidato(documento, empresaId, cache) {
    const chave = empresaId ? `empresa:${empresaId}` : 'global';
    if (cache.has(chave)) return cache.get(chave);
    let contexto = null;
    try {
      const result = await obterContextoOperacionalDoDocumento(
        (opts) => this._configuracao.obterContextoOperacional(opts),
        documento,
        { db: this._documentosRepository?._db, ...this._opcoesModo() }
      );
      if (result?.ok && result.contexto) contexto = result.contexto;
    } catch (error) {
      logCentralErro('MANIFESTACAO', error, { Etapa: 'selecao_contexto', empresa_id: empresaId });
    }
    cache.set(chave, contexto);
    return contexto;
  }

  async _estadoManifestacaoCandidato(documento, agora) {
    const aceita = await this._obterUltimoEvento(TIPOS_EVENTO.MANIFESTACAO_ACEITA, documento.id);
    if (aceita) return { cienciaAceita: true, ultimoCStat: aceita.resultado || aceita.detalhe?.cStat || null };

    const rejeitada = await this._obterUltimoEvento(TIPOS_EVENTO.MANIFESTACAO_REJEITADA, documento.id);
    if (this._ehRejeicaoXmlIndisponivel(rejeitada)) {
      return { cStatCiencia: '596', ultimoCStat: '596' };
    }

    const claim = await this._obterUltimoEvento(TIPOS_EVENTO.MANIFESTACAO_CLAIM, documento.id);
    const inicioClaim = claim ? this._inicioClaim(claim) : null;
    const claimAtivo = Boolean(claim)
      && (inicioClaim == null || agora.getTime() - inicioClaim < TTL_CLAIM_MANIFESTACAO_MS);

    const ultimaConsulta = await this._obterUltimoEvento(
      TIPOS_EVENTO.CONSULTA_DFE_POS_MANIFESTACAO,
      documento.id
    );
    const bloqueioRejeicao = this._obterBloqueioRejeicao(rejeitada);
    const janelas = [bloqueioRejeicao, this._obterProximaConsulta(ultimaConsulta)]
      .filter((d) => d instanceof Date && !Number.isNaN(d.getTime()));
    const proximaConsultaEm = janelas.length
      ? new Date(Math.max(...janelas.map((d) => d.getTime())))
      : null;

    return {
      claimAtivo,
      proximaConsultaEm,
      ultimoCStat: rejeitada ? (rejeitada.detalhe?.cStat || rejeitada.resultado || null) : null
    };
  }

  async _gateBloqueadoCandidato(contexto, documento, cache) {
    const gate = this._obterGate();
    if (!gate || typeof gate.avaliarBloqueioContexto !== 'function') return false;
    const ctx = this._contextoGate(contexto, documento);
    const chave = `${ctx.empresaId || ''}|${String(ctx.cnpj || '').replace(/\D/g, '')}|${ctx.ambiente ?? ''}`;
    if (cache.has(chave)) return cache.get(chave);
    let bloqueado = false;
    try {
      const r = await gate.avaliarBloqueioContexto(ctx);
      bloqueado = r?.bloqueado === true;
    } catch { /* Gate indisponível: a verificação oficial ocorre antes do SOAP */ }
    cache.set(chave, bloqueado);
    return bloqueado;
  }

  async processarDocumento(documentoId, opcoes = {}) {
    const resultado = await this._processarDocumento(documentoId, opcoes);
    // Respostas SOAP já foram entregues ao Gate por empresa; o chamador não deve reprocessá-las no escopo global.
    if (resultado && typeof resultado === 'object' && this._obterGate()) {
      resultado.gateProcessado = true;
    }
    return resultado;
  }

  async _processarDocumento(documentoId, opcoes = {}) {
    const id = Number(documentoId);
    if (!id) throw new Error('Documento inválido para manifestação.');
    if (this._emExecucao.has(id)) {
      return { documentoId: id, sucesso: false, ignorado: true, mensagem: 'Ciclo DF-e já em execução.' };
    }

    this._emExecucao.add(id);
    try {
      const documento = await this._documentosRepository.buscarPorId(id);
      if (!documento) {
        const erro = new Error('Documento não encontrado.');
        erro.statusCode = 404;
        throw erro;
      }

      if (documento.status === DocumentoFiscalStatus.XML_INDISPONIVEL) {
        const contextoResult = await obterContextoOperacionalDoDocumento(
          (opts) => this._configuracao.obterContextoOperacional(opts),
          documento,
          { db: this._documentosRepository?._db }
        );
        if (!contextoResult.ok) {
          throw new Error(contextoResult.mensagem);
        }
        const contexto = contextoResult.contexto;
        logCentral('MANIFESTACAO', {
          mensagem: 'Retry consChNFe em XML_INDISPONIVEL (sem reenviar ciência 210210)',
          Etapa: 'retry_xml_indisponivel',
          ...camposLogContextoDocumento(contexto, documento)
        });
        return await this._consultarXmlCompletoPorChave(documento, contexto, {
          ...opcoes,
          origemDist: { motivo: 'retry_xml_indisponivel' }
        });
      }

      if (
        documento.status !== DocumentoFiscalStatus.AGUARDANDO_XML_COMPLETO
        || documento.tipoDocumento !== DocumentoDfeTipo.RES_NFE
      ) {
        return {
          documentoId: id,
          sucesso: true,
          ignorado: true,
          encerrado: isTerminal(documento.status),
          xmlCompleto: documento.status !== DocumentoFiscalStatus.AGUARDANDO_XML_COMPLETO
            && documento.status !== DocumentoFiscalStatus.XML_INDISPONIVEL,
          mensagem: isTerminal(documento.status)
            ? `Documento encerrado (${documento.status}). Ciclo DF-e não será reiniciado.`
            : 'Documento não é mais candidato ao ciclo RES_NFE.'
        };
      }

      /** CE-05 P08 — fluxo automático: só a política configurada autoriza a ciência. */
      const origemAutomatica = opcoes.origemAutomatica === true;
      const politica = (!origemAutomatica && opcoes.politica)
        || await this._configuracao.obterPoliticaManifestacao();
      const confirmado = (!origemAutomatica && opcoes.confirmado === true)
        || politica === POLITICAS_MANIFESTACAO.AUTOMATICA_CIENCIA;
      /** RC3.3.6 — recuperação XML_WAIT: só DistDFe, nunca remanifestação. */
      const recuperacaoXml = opcoes.modoRecuperacaoXml === true;

      if (!confirmado && !recuperacaoXml) {
        return {
          documentoId: id,
          sucesso: false,
          ignorado: true,
          requerConfirmacao: politica === POLITICAS_MANIFESTACAO.CONFIRMAR_OPERADOR,
          politica,
          mensagem: politica === POLITICAS_MANIFESTACAO.CONFIRMAR_OPERADOR
            ? 'Confirmação do operador necessária.'
            : 'Manifestação em modo manual.'
        };
      }

      const contextoResult = await obterContextoOperacionalDoDocumento(
        (opts) => this._configuracao.obterContextoOperacional(opts),
        documento,
        { db: this._documentosRepository?._db }
      );
      if (!contextoResult.ok) {
        throw new Error(contextoResult.mensagem);
      }
      const contexto = contextoResult.contexto;
      logCentral('MANIFESTACAO', {
        mensagem: 'Contexto SEFAZ do documento',
        Etapa: recuperacaoXml ? 'recuperacao_xml' : 'ciencia',
        ...camposLogContextoDocumento(contexto, documento)
      });

      // RC3.3.6 / RC3.4.1 — recuperação: DistDFe direto (sem remanifestar).
      // forcarConsulta NÃO é permanente: herda do caller (MIRX = false).
      // Só true com justificativa técnica explícita no caller (ex.: admin).
      if (recuperacaoXml) {
        return await this._consultarDistDfePorNsu(documento, contexto, {
          ...opcoes,
          forcarConsulta: opcoes.forcarConsulta === true,
          apenasManifestacao: false
        });
      }

      let aceita = await this._obterUltimoEvento(
        TIPOS_EVENTO.MANIFESTACAO_ACEITA,
        documento.id
      );
      let cienciaRecemAceita = false;
      if (!aceita) {
        const rejeitada = await this._obterUltimoEvento(
          TIPOS_EVENTO.MANIFESTACAO_REJEITADA,
          documento.id
        );
        // RC7.4.7 — rejeição 596 já registrada: encerra sem retry / XML_WAIT.
        // (Não se aplica ao modoRecuperacaoXml — tratado acima.)
        if (this._ehRejeicaoXmlIndisponivel(rejeitada)) {
          return await this._resolverAposEvento596(documento, contexto, opcoes, {
            cStat: String(rejeitada.resultado || rejeitada.detalhe?.cStat || '596'),
            xMotivo: rejeitada.detalhe?.xMotivo || rejeitada.descricao,
            usuarioId: opcoes.usuarioId,
            correlationId: opcoes.correlationId || rejeitada.detalhe?.correlationId,
            detalhe: rejeitada.detalhe || {}
          });
        }

        const bloqueioRejeicao = this._obterBloqueioRejeicao(rejeitada);
        if (!opcoes.forcarConsulta && bloqueioRejeicao && this._agora() < bloqueioRejeicao) {
          return {
            documentoId: id,
            sucesso: false,
            aguardandoDisponibilizacao: true,
            proximaConsultaEm: bloqueioRejeicao.toISOString(),
            mensagem: 'Manifestação rejeitada recentemente; nova tentativa somente após 1 hora.'
          };
        }

        // P5 — janela encerrada: nenhuma origem (automática, botão, MIRX) envia 210210.
        const prazo = calcularPrazoManifestacao(documento, this._agora());
        if (prazo.valido && prazo.expirado) {
          await this._marcarForaDoPrazo(documento, contexto, prazo);
          return {
            documentoId: id,
            sucesso: false,
            ignorado: true,
            encerrado: false,
            foraDoPrazo: true,
            codigo: CODIGO_CIENCIA_FORA_DO_PRAZO,
            prazoFinal: prazo.prazoFinal,
            mensagem: `Prazo da Ciência da Emissão encerrado em ${formatarDataHoraBrasil(prazo.prazoFinal)}. `
              + '210210 não enviado.'
          };
        }
        if (!prazo.valido && origemAutomatica) {
          return {
            documentoId: id,
            sucesso: false,
            ignorado: true,
            codigo: MOTIVOS_EXCLUSAO_CANDIDATO.PRAZO_INDETERMINADO,
            mensagem: 'Prazo da ciência indeterminado (sem dhEmi com hora e offset); ciência automática não enviada.'
          };
        }

        const esperaGate = await this._verificarGate(contexto, documento, opcoes, 'ciencia_210210');
        if (esperaGate) {
          await this._telemetria(TIPOS_EVENTO.MANIFESTACAO_BLOQUEADA_GATE, {
            documentoId: id,
            descricao: 'Ciência da Emissão não enviada: Gate SEFAZ bloqueado para a empresa.',
            resultado: esperaGate.codigo || 'GATE_BLOQUEADO',
            detalhe: {
              codigo: esperaGate.codigo || null,
              proximaConsultaEm: esperaGate.proximaConsultaEm || null,
              correlationId: opcoes.correlationId || null,
              ...this._contextoTelemetria(contexto, documento),
              ...this._detalhePrazo(prazo)
            }
          });
          return esperaGate;
        }

        const claim = await this._reclamarManifestacao(documento, opcoes);
        if (!claim.ok) {
          await this._telemetria(TIPOS_EVENTO.MANIFESTACAO_CLAIM_OCUPADO, {
            documentoId: id,
            descricao: claim.mensagem,
            resultado: 'CLAIM_OCUPADO',
            detalhe: {
              correlationId: opcoes.correlationId || null,
              ...this._contextoTelemetria(contexto, documento)
            }
          });
          return {
            documentoId: id,
            sucesso: false,
            ignorado: true,
            claimOcupado: true,
            mensagem: claim.mensagem
          };
        }

        try {
          aceita = await this._enviarCiencia(documento, contexto, { ...opcoes, claimToken: claim.token });
          if (aceita?.cienciaRejeitadaPrazo || aceita?.encerrado === true) {
            await this._liberarClaim(documento.id, claim.token);
            return aceita;
          }
          if (!aceita?.sucesso) {
            await this._liberarClaim(documento.id, claim.token);
            return aceita;
          }
          cienciaRecemAceita = true;
        } catch (error) {
          await this._liberarClaim(documento.id, claim.token);
          throw error;
        }
      }

      const atualizado = await this._documentosRepository.buscarPorId(id);
      if (atualizado?.status !== DocumentoFiscalStatus.AGUARDANDO_XML_COMPLETO) {
        return {
          documentoId: id,
          sucesso: true,
          xmlCompleto: true,
          documento: atualizado,
          mensagem: 'XML completo já recebido.'
        };
      }

      // NT 2014.002: após Ciência, o PROC_NFE NÃO é imediato.
      // Aguarda disponibilização de novo NSU pelo Ambiente Nacional.
      if (cienciaRecemAceita || opcoes.apenasManifestacao === true) {
        return await this._registrarAguardandoXml(documento, opcoes, aceita);
      }

      const ultimaConsulta = await this._obterUltimoEvento(
        TIPOS_EVENTO.CONSULTA_DFE_POS_MANIFESTACAO,
        documento.id
      );
      const bloqueioDaSincronizacao = opcoes.bloqueadoConsultaAte
        ? { detalhe: { proximaConsultaEm: opcoes.bloqueadoConsultaAte } }
        : null;
      const proximaConsultaEm = this._obterProximaConsulta(
        aceita,
        ultimaConsulta,
        bloqueioDaSincronizacao
      );
      const agora = this._agora();
      if (!opcoes.forcarConsulta && proximaConsultaEm && agora < proximaConsultaEm) {
        return {
          documentoId: id,
          sucesso: true,
          aguardandoDisponibilizacao: true,
          proximaConsultaEm: proximaConsultaEm.toISOString(),
          mensagem: MENSAGEM_AGUARDANDO_XML
        };
      }

      // DistDFe (ultNSU); se sem PROC, fallback consChNFe em _consultarDistDfePorNsu.
      return await this._consultarDistDfePorNsu(documento, contexto, opcoes);
    } finally {
      this._emExecucao.delete(id);
    }
  }

  async _enviarCiencia(documento, contexto, opcoes) {
    const inicio = Date.now();
    const correlationId = opcoes.correlationId || criarCorrelationId();
    const contextoEmpresa = this._contextoTelemetria(contexto, documento);
    const detalheIntencao = {
      chave: documento.chave,
      evento: '210210',
      correlationId,
      empresaId: contexto.empresaId || resolverEmpresaIdDocumento(documento),
      cnpjMascarado: camposLogContextoDocumento(contexto, documento).cnpj,
      fase: 'INTENCAO',
      transmissaoExecutada: false,
      respostaRecebida: false
    };
    await this._registrarEtapa({
      tipo: TIPOS_EVENTO.CIENCIA_SOLICITADA,
      documento,
      descricao: 'Ciência da Emissão (210210) solicitada. Transmissão ainda não iniciada.',
      resultado: 'SOLICITADA',
      sucesso: null,
      usuarioId: opcoes.usuarioId,
      detalhe: detalheIntencao,
      ignorarHistoricoDuplicado: true
    });

    let envelope;
    try {
      envelope = this._prepararEnvelopeAssinado({
        tpAmb: Number(contexto.ambiente) === 1 ? 1 : 2,
        cOrgao: '91',
        cnpj: contexto.cnpj,
        chave: documento.chave,
        operacao: OperationType.MANIFESTACAO_CIENCIA,
        certificadoPath: contexto.certificadoPath,
        certificadoSenha: contexto.certificadoSenha
      });
    } catch (error) {
      const duracaoMs = Date.now() - inicio;
      const proximaConsultaEm = new Date(
        this._agora().getTime() + INTERVALO_SEGURO_MS
      ).toISOString();
      await this._registrarEtapa({
        tipo: TIPOS_EVENTO.MANIFESTACAO_REJEITADA,
        documento,
        descricao: `Falha antes da transmissão da Ciência: ${error.message}`,
        resultado: 'FALHA_PRE_ENVIO',
        sucesso: false,
        duracaoMs,
        usuarioId: opcoes.usuarioId,
        detalhe: {
          evento: '210210',
          erro: error.message,
          proximaConsultaEm,
          correlationId,
          fase: 'FALHA_PRE_ENVIO',
          transmissaoExecutada: false,
          ...contextoEmpresa
        }
      });
      return {
        documentoId: documento.id,
        sucesso: false,
        consultaExecutada: false,
        transmissaoExecutada: false,
        proximaConsultaEm,
        mensagem: error.message
      };
    }

    try {
      const runtime = await this._enviarManifestacao({
        operacao: OperationType.MANIFESTACAO_CIENCIA,
        ambiente: contexto.ambiente,
        cnpj: contexto.cnpj,
        chave: documento.chave,
        certificadoPath: contexto.certificadoPath,
        certificadoSenha: contexto.certificadoSenha,
        envelope,
        empresaId: contexto.empresaId || resolverEmpresaIdDocumento(documento) || null,
        contextoCentral: contexto,
        autorizacaoTransmissaoSefaz: opcoes.autorizacaoTransmissaoSefaz
          || this._autorizacaoTransmissaoSefaz
          || null
      });

      if (runtime?.bloqueadoAutorizacao || runtime?.consultaExecutada === false) {
        const duracaoMs = Number(runtime.tempoTotalMs) || (Date.now() - inicio);
        return {
          documentoId: documento.id,
          sucesso: false,
          ignorado: true,
          bloqueadoAutorizacao: true,
          consultaExecutada: false,
          sefazConsultada: false,
          codigo: runtime.codigo || runtime.code || 'TRANSMISSAO_SEFAZ_NAO_AUTORIZADA',
          mensagem: runtime.error || runtime.mensagem
            || 'Manifestação 210210 não executada: falta autorização operacional explícita.'
        };
      }

      const respostaRecebida = runtime.body != null && String(runtime.body).trim() !== '';
      await this._registrarEtapa({
        tipo: TIPOS_EVENTO.CIENCIA_ENVIADA,
        documento,
        descricao: 'Ciência da Emissão (210210) enviada.',
        resultado: respostaRecebida ? 'RESPOSTA_RECEBIDA' : 'TRANSMISSAO_INICIADA',
        sucesso: null,
        usuarioId: opcoes.usuarioId,
        detalhe: {
          ...detalheIntencao,
          ...contextoEmpresa,
          fase: respostaRecebida ? 'RESPOSTA_RECEBIDA' : 'TRANSMISSAO_INICIADA',
          transmissaoExecutada: true,
          respostaRecebida,
          consultaExecutada: runtime.consultaExecutada !== false,
          cStat: runtime.cStat || null
        },
        ignorarHistoricoDuplicado: true
      });
      await this._telemetria(TIPOS_EVENTO.MANIFESTACAO_ENVIADA, {
        documentoId: documento.id,
        descricao: 'Ciência da Emissão (210210) enviada ao Ambiente Nacional.',
        resultado: 'ENVIADA',
        detalhe: {
          chave: documento.chave,
          evento: '210210',
          correlationId,
          fase: respostaRecebida ? 'RESPOSTA_RECEBIDA' : 'TRANSMISSAO_INICIADA',
          transmissaoExecutada: true,
          respostaRecebida,
          ...contextoEmpresa,
          ...this._detalhePrazo(calcularPrazoManifestacao(documento, this._agora()))
        }
      });

      // RC3.3.3 — Central rejeita bypass legado da Plataforma Fiscal.
      if (
        runtime.fallbackUtilizado
        || runtime.source === ResolutionSource.FALLBACK
        || String(runtime.source || '').toUpperCase() === 'FALLBACK'
      ) {
        const duracaoMs = Number(runtime.tempoTotalMs) || (Date.now() - inicio);
        const proximaConsultaEm = new Date(
          this._agora().getTime() + INTERVALO_SEGURO_MS
        ).toISOString();
        await this._registrarEtapa({
          tipo: TIPOS_EVENTO.MANIFESTACAO_REJEITADA,
          documento,
          descricao: 'Manifestação rejeitada: fallback legado não é aceito pela Central (RC3.3.3).',
          resultado: 'FALLBACK_REJEITADO',
          sucesso: false,
          duracaoMs,
          usuarioId: opcoes.usuarioId,
          detalhe: {
            evento: '210210',
            correlationId,
            source: runtime.source || null,
            fallbackUtilizado: true,
            proximaConsultaEm,
            ...contextoEmpresa
          }
        });
        logOperacaoCentral({
          correlationId,
          chave: documento.chave,
          operacao: 'MANIFESTACAO_210210',
          tempoMs: duracaoMs,
          resultado: 'FALLBACK_REJEITADO',
          origem: 'CentralManifestacaoDfeService',
          runtime: runtime.source || 'FALLBACK'
        });
        return {
          documentoId: documento.id,
          sucesso: false,
          proximaConsultaEm,
          mensagem: 'Fallback legado da Plataforma Fiscal bloqueado pela Central.'
        };
      }

      const fiscal = extrairRetornoManifestacao(runtime.body);
      await this._reportarGate(fiscal, contexto, documento, {
        correlationId,
        endpoint: runtime.endpoint || null,
        motivo: 'ciencia_210210'
      });
      const duracaoMs = Number(runtime.tempoTotalMs) || (Date.now() - inicio);
      const detalhe = {
        evento: '210210',
        correlationId,
        cStat: fiscal.cStat,
        xMotivo: fiscal.xMotivo,
        protocolo: fiscal.protocolo,
        dataRegistro: fiscal.dataRegistro,
        tempoMs: duracaoMs,
        tempoSoapMs: Number(runtime.tempoSoapMs) || null,
        endpoint: runtime.endpoint || null,
        statusCode: runtime.statusCode || null,
        source: runtime.source || null,
        fallbackUtilizado: Boolean(runtime.fallbackUtilizado),
        ...contextoEmpresa
      };

      if (!runtime.success || !fiscal.aceita) {
        const cStat = String(fiscal.cStat || '');
        const xmlIndisponivel = CSTAT_XML_INDISPONIVEL.has(cStat);
        detalhe.proximaConsultaEm = xmlIndisponivel
          ? null
          : new Date(this._agora().getTime() + INTERVALO_SEGURO_MS).toISOString();
        detalhe.xmlIndisponivel = xmlIndisponivel || undefined;

        await this._registrarEtapa({
          tipo: TIPOS_EVENTO.MANIFESTACAO_REJEITADA,
          documento,
          descricao: xmlIndisponivel
            ? `Manifestação rejeitada (prazo): ${fiscal.xMotivo || 'cStat 596'}`
            : `Manifestação rejeitada: ${fiscal.xMotivo || runtime.error || 'retorno inválido'}`,
          resultado: fiscal.cStat || 'ERRO',
          sucesso: false,
          duracaoMs,
          usuarioId: opcoes.usuarioId,
          detalhe
        });

        if (xmlIndisponivel) {
          // RC3.3.6 — recuperação XML_WAIT nunca encerra por 596 de remanifestação.
          if (opcoes.modoRecuperacaoXml === true) {
            logOperacaoCentral({
              correlationId,
              chave: documento.chave,
              operacao: 'MANIFESTACAO_210210',
              tempoMs: duracaoMs,
              resultado: '596_IGNORADO_RECUPERACAO',
              cStat,
              origem: 'CentralManifestacaoDfeService',
              runtime: runtime.source || 'PLATFORM'
            });
            return {
              documentoId: documento.id,
              sucesso: false,
              cStat,
              xmlCompleto: false,
              aguardandoDisponibilizacao: true,
              recuperacaoSemEncerrar: true,
              mensagem: fiscal.xMotivo || MENSAGEM_XML_INDISPONIVEL,
              detalhe
            };
          }
          // CENTRAL-XML-MULTICNPJ-02: 596 prova prazo do evento 210210, não ausência de procNFe.
          return this._resolverAposEvento596(documento, contexto, opcoes, {
            cStat,
            xMotivo: fiscal.xMotivo,
            correlationId,
            usuarioId: opcoes.usuarioId,
            detalhe,
            duracaoMs
          });
        }

        return {
          documentoId: documento.id,
          sucesso: false,
          cStat: fiscal.cStat,
          proximaConsultaEm: detalhe.proximaConsultaEm,
          mensagem: fiscal.xMotivo || runtime.error || 'Manifestação não registrada pela SEFAZ.'
        };
      }

      const aguardarAte = this._resolverProximaJanela(opcoes.bloqueadoConsultaAte);
      detalhe.proximaConsultaEm = aguardarAte.toISOString();

      const insercao = await this._eventosRepository.inserirUnico({
        tipo: TIPOS_EVENTO.MANIFESTACAO_ACEITA,
        origem: ORIGENS.SISTEMA,
        descricao: fiscal.duplicada
          ? 'Ciência da Emissão já registrada anteriormente.'
          : 'Manifestação aceita pela SEFAZ.',
        resultado: fiscal.cStat,
        sucesso: true,
        documentoId: documento.id,
        duracaoMs,
        detalhe
      });

      await this._historicoRepository.inserir({
        documentoId: documento.id,
        statusAnterior: documento.status,
        statusNovo: documento.status,
        usuarioId: opcoes.usuarioId || null,
        detalhe: fiscal.duplicada
          ? 'Ciência da Emissão já registrada anteriormente.'
          : 'Manifestação aceita pela SEFAZ.'
      });

      await this._liberarClaim(documento.id, opcoes.claimToken || null);

      logOperacaoCentral({
        correlationId,
        chave: documento.chave,
        operacao: 'MANIFESTACAO_210210',
        tempoMs: duracaoMs,
        resultado: 'OK',
        cStat: fiscal.cStat,
        origem: 'CentralManifestacaoDfeService',
        runtime: runtime.source || 'PLATFORM'
      });

      return { ...(insercao.evento || {}), sucesso: true, detalhe };
    } catch (error) {
      const duracaoMs = Date.now() - inicio;
      const proximaConsultaEm = new Date(
        this._agora().getTime() + INTERVALO_SEGURO_MS
      ).toISOString();
      const falhaAntesSoap = error.bloqueadoAutorizacao === true
        || error.consultaExecutada === false;
      if (!falhaAntesSoap) {
        await this._registrarEtapa({
          tipo: TIPOS_EVENTO.CIENCIA_ENVIADA,
          documento,
          descricao: 'Ciência da Emissão (210210) enviada.',
          resultado: 'FALHA_TRANSPORTE',
          sucesso: false,
          duracaoMs,
          usuarioId: opcoes.usuarioId,
          detalhe: {
            ...detalheIntencao,
            ...contextoEmpresa,
            fase: 'FALHA_TRANSPORTE',
            transmissaoExecutada: true,
            respostaRecebida: false,
            erro: error.message
          },
          ignorarHistoricoDuplicado: true
        });
      }
      await this._registrarEtapa({
        tipo: TIPOS_EVENTO.MANIFESTACAO_REJEITADA,
        documento,
        descricao: `Falha ao enviar Ciência da Emissão: ${error.message}`,
        resultado: falhaAntesSoap ? 'FALHA_PRE_ENVIO' : 'FALHA_TRANSPORTE',
        sucesso: false,
        duracaoMs,
        usuarioId: opcoes.usuarioId,
        detalhe: {
          evento: '210210',
          erro: error.message,
          proximaConsultaEm,
          correlationId,
          fase: falhaAntesSoap ? 'FALHA_PRE_ENVIO' : 'FALHA_TRANSPORTE',
          transmissaoExecutada: !falhaAntesSoap,
          ...contextoEmpresa
        }
      });
      return {
        documentoId: documento.id,
        sucesso: false,
        proximaConsultaEm,
        mensagem: error.message
      };
    }
  }

  async _registrarAguardandoXml(documento, opcoes, eventoAceita = null) {
    const proximaConsultaEm = this._resolverProximaJanela(
      opcoes.bloqueadoConsultaAte
      || eventoAceita?.detalhe?.proximaConsultaEm
    ).toISOString();

    const ultimaConsulta = await this._obterUltimoEvento(
      TIPOS_EVENTO.CONSULTA_DFE_POS_MANIFESTACAO,
      documento.id
    );
    const jaRegistrado = ultimaConsulta?.detalhe?.aguardandoXml === true
      || ultimaConsulta?.descricao === MENSAGEM_AGUARDANDO_XML;

    if (!jaRegistrado) {
      await this._registrarEtapa({
        tipo: TIPOS_EVENTO.CONSULTA_DFE_POS_MANIFESTACAO,
        documento,
        descricao: MENSAGEM_AGUARDANDO_XML,
        resultado: 'AGUARDANDO_NSU',
        sucesso: true,
        usuarioId: opcoes.usuarioId,
        detalhe: {
          aguardandoXml: true,
          motivo: 'NT_2014_002',
          proximaConsultaEm
        }
      });
    }

    // RC3.4.1 — enfileira no MIRX (não consulta SEFAZ aqui).
    try {
      const xmlWait = require('./CentralXmlWaitScheduler');
      if (typeof xmlWait.enfileirarRecuperacao === 'function') {
        await xmlWait.enfileirarRecuperacao(documento, {
          origem: ORIGENS.SISTEMA,
          motivo: 'pos_ciencia_aguardar_janela',
          correlationId: opcoes.correlationId,
          proximaEm: proximaConsultaEm
        });
      }
    } catch { /* ignore */ }

    return {
      documentoId: documento.id,
      sucesso: true,
      xmlCompleto: false,
      aguardandoDisponibilizacao: true,
      proximaConsultaEm,
      mensagem: MENSAGEM_AGUARDANDO_XML
    };
  }

  async _consultarDistDfePorNsu(documento, contexto, opcoes) {
    const inicio = Date.now();
    const statusAnterior = documento.status;
    const ambiente = Number(contexto.ambiente) === 1 ? 1 : 2;
    const correlationId = opcoes.correlationId || criarCorrelationId();

    const executarConsulta = async () => {
      const esperaGate = await this._verificarGate(contexto, documento, opcoes, 'distNSU_pos_manifestacao');
      if (esperaGate) {
        return esperaGate;
      }
      try {
        const controle = await this._nsuService.buscarPorCnpjAmbiente(
          contexto.cnpj,
          ambiente
        );
        const cooldown = this._nsuService.avaliarCooldown(controle);
        if (!opcoes.forcarConsulta && cooldown.ativo) {
          const porChave = await this._consultarXmlCompletoPorChave(documento, contexto, {
            ...opcoes,
            correlationId,
            inicioMs: inicio,
            origemDist: {
              cStat: controle?.ultimoCstat || '137',
              motivo: 'nsu_cooldown_consChNFe',
              ultNsu: controle?.ultNsu || null,
              maxNsu: controle?.maxNsu || null
            }
          });
          if (porChave.xmlCompleto) {
            return porChave;
          }
          return {
            documentoId: documento.id,
            sucesso: true,
            xmlCompleto: false,
            aguardandoDisponibilizacao: true,
            consultaPorChave: true,
            cStat: porChave.cStat || controle?.ultimoCstat || '137',
            ultNsu: controle?.ultNsu || null,
            maxNsu: controle?.maxNsu || null,
            proximaConsultaEm: porChave.proximaConsultaEm || cooldown.proximaConsultaEm,
            mensagem: porChave.mensagem || MENSAGEM_AGUARDANDO_XML
          };
        }

        const empresaIdPersistencia = Number(contexto.empresaId)
          || resolverEmpresaIdDocumento(documento);
        const persistencia = Number.isInteger(empresaIdPersistencia) && empresaIdPersistencia > 0
          ? this._criarPersistencia(empresaIdPersistencia)
          : undefined;
        const resultado = await this._sincronizarDfe({
          ...this._depsSoap(contexto, documento, opcoes),
          maxIteracoes: Math.min(Number(opcoes.maxIteracoes) || 5, 20),
          contextoCentral: contexto,
          nsuRepository: this._nsuRepository,
          nsuService: this._nsuService,
          persistenciaService: persistencia,
          correlationId
        });
        if (resultado?.bloqueadoGate) {
          return {
            documentoId: documento.id,
            sucesso: false,
            ignorado: true,
            bloqueadoGate: true,
            codigo: resultado.codigo || 'GATE_BLOQUEADO',
            xmlCompleto: false,
            encerrado: false,
            aguardandoDisponibilizacao: true,
            proximaConsultaEm: resultado.proximaConsultaEm || null,
            mensagem: resultado.mensagem || 'Consulta bloqueada pelo Gate SEFAZ.'
          };
        }
        const atualizado = await this._documentosRepository.buscarPorId(documento.id);
        const xmlCompleto = atualizado
          && atualizado.status !== DocumentoFiscalStatus.AGUARDANDO_XML_COMPLETO
          && [DocumentoDfeTipo.PROC_NFE, DocumentoDfeTipo.NFE].includes(atualizado.tipoDocumento);
        const duracaoMs = Date.now() - inicio;
        const cStat = String(resultado.cStat || '');
        const proximaConsultaEm = xmlCompleto
          ? null
          : (resultado.proximaConsultaEm || this._resolverProximaJanela().toISOString());
        const deveAguardar = !xmlCompleto;

        await this._registrarEtapa({
          tipo: TIPOS_EVENTO.CONSULTA_DFE_POS_MANIFESTACAO,
          documento: atualizado || documento,
          descricao: xmlCompleto
            ? 'XML completo recebido via Distribuição DF-e (NSU).'
            : MENSAGEM_AGUARDANDO_XML,
          resultado: cStat || (xmlCompleto ? 'XML_COMPLETO' : 'AGUARDANDO_NSU'),
          sucesso: cStat !== '656' && resultado.sucesso !== false,
          duracaoMs,
          usuarioId: opcoes.usuarioId,
          detalhe: {
            modo: 'distNSU',
            correlationId,
            cStat,
            mensagem: resultado.mensagem || null,
            ultNsu: resultado.ultNsu || null,
            maxNsu: resultado.maxNsu || null,
            novoNsu: atualizado?.nsu || null,
            tipoDocumento: atualizado?.tipoDocumento || documento.tipoDocumento,
            xmlCompleto,
            aguardandoXml: !xmlCompleto,
            proximaConsultaEm
          }
        });

        logOperacaoCentral({
          correlationId,
          chave: documento.chave,
          nsu: resultado.ultNsu,
          operacao: 'DIST_DFE_POS_MANIFESTACAO',
          cStat,
          tempoMs: duracaoMs,
          resultado: xmlCompleto ? 'PROC_NFE' : (cStat === '656' ? '656' : 'AGUARDANDO'),
          origem: 'CentralManifestacaoDfeService',
          runtime: 'PLATFORM'
        });

        // RC3.3.6+ — DistDFe sem PROC: fallback oficial consChNFe (exceto 656).
        if (!xmlCompleto && cStat !== '656' && resultado.sucesso !== false) {
          const porChave = await this._consultarXmlCompletoPorChave(documento, contexto, {
            ...opcoes,
            correlationId,
            inicioMs: inicio,
            origemDist: {
              cStat,
              ultNsu: resultado.ultNsu || null,
              maxNsu: resultado.maxNsu || null
            }
          });
          if (porChave.xmlCompleto) {
            return porChave;
          }
          // Mantém janela de espera (DistDFe ou consChNFe).
          return {
            documentoId: documento.id,
            sucesso: true,
            cStat: porChave.cStat || cStat,
            ultNsu: resultado.ultNsu || null,
            maxNsu: resultado.maxNsu || null,
            xmlCompleto: false,
            documento: await this._documentosRepository.buscarPorId(documento.id),
            proximaConsultaEm: porChave.proximaConsultaEm || proximaConsultaEm,
            aguardandoDisponibilizacao: true,
            consultaPorChave: true,
            mensagem: MENSAGEM_AGUARDANDO_XML
          };
        }

        return {
          documentoId: documento.id,
          sucesso: cStat !== '656' && resultado.sucesso !== false,
          cStat,
          ultNsu: resultado.ultNsu || null,
          maxNsu: resultado.maxNsu || null,
          xmlCompleto,
          documento: atualizado,
          proximaConsultaEm,
          aguardandoDisponibilizacao: deveAguardar && !xmlCompleto,
          mensagem: xmlCompleto
            ? 'XML completo recebido e promovido automaticamente.'
            : cStat === '656'
              ? 'Consumo indevido informado pela SEFAZ; nova tentativa bloqueada por 1 hora.'
              : MENSAGEM_AGUARDANDO_XML
        };
      } catch (error) {
        const duracaoMs = Date.now() - inicio;
        const proximaConsultaEm = this._resolverProximaJanela().toISOString();
        await this._registrarEtapa({
          tipo: TIPOS_EVENTO.CONSULTA_DFE_POS_MANIFESTACAO,
          documento,
          descricao: MENSAGEM_AGUARDANDO_XML,
          resultado: 'ERRO',
          sucesso: false,
          duracaoMs,
          usuarioId: opcoes.usuarioId,
          detalhe: {
            modo: 'distNSU',
            erro: error.message,
            aguardandoXml: true,
            proximaConsultaEm,
            correlationId
          }
        });
        return {
          documentoId: documento.id,
          sucesso: false,
          xmlCompleto: false,
          aguardandoDisponibilizacao: true,
          proximaConsultaEm,
          mensagem: error.message
        };
      }
    };

    if (this._syncExecucao && typeof this._syncExecucao.comLockDistDfe === 'function') {
      const locked = await this._syncExecucao.comLockDistDfe(
        `ciclo-dfe:${documento.id}`,
        executarConsulta
      );
      if (locked && locked.codigo === 'SYNC_EM_ANDAMENTO') {
        return {
          documentoId: documento.id,
          sucesso: false,
          ignorado: true,
          aguardandoDisponibilizacao: true,
          mensagem: locked.mensagem
        };
      }
      return locked;
    }

    return executarConsulta();
  }

  /**
   * RC3.3.6+ — Fallback após DistDFe sem PROC: consChNFe da mesma chave.
   * Reutiliza consultarNotaPorChave (Plataforma Fiscal) + persistência Central.
   * @private
   */
  async _consultarXmlCompletoPorChave(documento, contexto, opcoes = {}) {
    const correlationId = opcoes.correlationId || criarCorrelationId();
    const inicio = opcoes.inicioMs || Date.now();
    const esperaGate = await this._verificarGate(contexto, documento, opcoes, 'consChNFe');
    if (esperaGate) {
      return { ...esperaGate, consultaPorChave: true };
    }
    try {
      const empresaIdPersistencia = Number(contexto.empresaId)
        || resolverEmpresaIdDocumento(documento);
      const persistencia = Number.isInteger(empresaIdPersistencia) && empresaIdPersistencia > 0
        ? this._criarPersistencia(empresaIdPersistencia)
        : undefined;
      const consultaResult = await this._consultarNotaPorChave(documento.chave, {
        ...this._depsSoap(contexto, documento, { correlationId }),
        contextoCentral: contexto,
        persistenciaService: persistencia
      });
      opcoes._consChNFeRetorno = {
        cStat: consultaResult?.cStat || null,
        xMotivo: consultaResult?.mensagem || consultaResult?.xMotivo || null,
        notasNovas: consultaResult?.notasNovas,
        sucesso: consultaResult?.sucesso !== false
      };
    } catch (error) {
      if (error?.bloqueadoGate) {
        return {
          documentoId: documento.id,
          sucesso: false,
          ignorado: true,
          bloqueadoGate: true,
          codigo: error.codigo || 'GATE_BLOQUEADO',
          xmlCompleto: false,
          encerrado: false,
          aguardandoDisponibilizacao: true,
          proximaConsultaEm: error.proximaConsultaEm || null,
          mensagem: error.message,
          consultaPorChave: true
        };
      }
      const duracaoMs = Date.now() - inicio;
      const proximaConsultaEm = this._resolverProximaJanela().toISOString();
      const cStatErro = error?.cStat ? String(error.cStat) : null;
      await this._registrarEtapa({
        tipo: TIPOS_EVENTO.CONSULTA_DFE_POS_MANIFESTACAO,
        documento,
        descricao: `Consulta por chave sem XML completo: ${error.message}`,
        resultado: cStatErro || 'CONS_CHNFE_ERRO',
        sucesso: false,
        duracaoMs,
        usuarioId: opcoes.usuarioId,
        detalhe: {
          modo: 'consChNFe',
          correlationId,
          erro: error.message,
          cStat: cStatErro,
          xMotivo: error?.xMotivo || null,
          rejeicaoSefaz: error?.rejeicaoSefaz === true,
          origemDist: opcoes.origemDist || null,
          aguardandoXml: true,
          proximaConsultaEm
        }
      });
      logOperacaoCentral({
        correlationId,
        chave: documento.chave,
        operacao: 'CONS_CHNFE_POS_DIST',
        tempoMs: duracaoMs,
        resultado: 'ERRO',
        origem: 'CentralManifestacaoDfeService',
        runtime: 'PLATFORM'
      });
      return {
        documentoId: documento.id,
        sucesso: false,
        xmlCompleto: false,
        cStat: cStatErro,
        aguardandoDisponibilizacao: true,
        proximaConsultaEm,
        mensagem: error.message,
        consultaPorChave: true
      };
    }

    const atualizado = await this._documentosRepository.buscarPorId(documento.id);
    const xmlCompleto = atualizado
      && atualizado.status !== DocumentoFiscalStatus.AGUARDANDO_XML_COMPLETO
      && [DocumentoDfeTipo.PROC_NFE, DocumentoDfeTipo.NFE].includes(atualizado.tipoDocumento);
    const duracaoMs = Date.now() - inicio;
    const proximaConsultaEm = xmlCompleto
      ? null
      : this._resolverProximaJanela().toISOString();

    const consRetorno = opcoes._consChNFeRetorno || {};
    await this._registrarEtapa({
      tipo: TIPOS_EVENTO.CONSULTA_DFE_POS_MANIFESTACAO,
      documento: atualizado || documento,
      descricao: xmlCompleto
        ? 'XML completo recebido via consulta por chave (consChNFe).'
        : MENSAGEM_AGUARDANDO_XML,
      resultado: xmlCompleto ? 'XML_COMPLETO_CHAVE' : 'AGUARDANDO_CHAVE',
      sucesso: true,
      duracaoMs,
      usuarioId: opcoes.usuarioId,
      detalhe: {
        modo: 'consChNFe',
        correlationId,
        origemDist: opcoes.origemDist || null,
        tipoDocumento: atualizado?.tipoDocumento || documento.tipoDocumento,
        xmlCompleto,
        aguardandoXml: !xmlCompleto,
        proximaConsultaEm,
        cStat: consRetorno.cStat || null,
        xMotivo: consRetorno.xMotivo || null
      }
    });

    logOperacaoCentral({
      correlationId,
      chave: documento.chave,
      operacao: 'CONS_CHNFE_POS_DIST',
      tempoMs: duracaoMs,
      resultado: xmlCompleto ? 'PROC_NFE' : 'AGUARDANDO',
      origem: 'CentralManifestacaoDfeService',
      runtime: 'PLATFORM'
    });

    return {
      documentoId: documento.id,
      sucesso: true,
      xmlCompleto,
      cStat: consRetorno.cStat || null,
      documento: atualizado,
      consultaPorChave: true,
      proximaConsultaEm,
      aguardandoDisponibilizacao: !xmlCompleto,
      mensagem: xmlCompleto
        ? 'XML completo recebido via consulta por chave.'
        : (consRetorno.xMotivo || MENSAGEM_AGUARDANDO_XML)
    };
  }

  _montarDetalheClaim(documento, opcoes = {}) {
    const agora = this._agora();
    return {
      chave: documento.chave,
      usuarioId: opcoes.usuarioId || null,
      token: crypto.randomUUID(),
      processo: opcoes.processoId || `pid:${process.pid}`,
      reclamadoEm: agora.toISOString(),
      expiraEm: new Date(agora.getTime() + TTL_CLAIM_MANIFESTACAO_MS).toISOString(),
      ttlMs: TTL_CLAIM_MANIFESTACAO_MS
    };
  }

  /** Início do claim: detalhe.reclamadoEm; claims anteriores ao CE-05 usam created_at (UTC). */
  _inicioClaim(claim) {
    const iso = claim?.detalhe?.reclamadoEm;
    if (iso) {
      const t = new Date(iso).getTime();
      if (Number.isFinite(t)) return t;
    }
    const criado = claim?.createdAt ? String(claim.createdAt) : '';
    if (!criado) return null;
    const t = new Date(/Z|[+-]\d{2}:?\d{2}$/.test(criado) ? criado : `${criado.replace(' ', 'T')}Z`).getTime();
    return Number.isFinite(t) ? t : null;
  }

  async _reclamarManifestacao(documento, opcoes = {}) {
    const detalhe = this._montarDetalheClaim(documento, opcoes);
    const claim = await this._eventosRepository.inserirUnico({
      tipo: TIPOS_EVENTO.MANIFESTACAO_CLAIM,
      origem: ORIGENS.SISTEMA,
      descricao: 'Claim atômico de Ciência da Emissão',
      resultado: 'CLAIM',
      sucesso: null,
      documentoId: documento.id,
      detalhe
    });

    if (!claim.conflito) {
      return this._confirmarClaimSemAceite(documento, detalhe.token, false);
    }

    const aceita = await this._obterUltimoEvento(
      TIPOS_EVENTO.MANIFESTACAO_ACEITA,
      documento.id
    );
    if (aceita) {
      return { ok: false, mensagem: 'Manifestação já aceita para esta chave.' };
    }

    const recuperado = await this._recuperarClaimExpirado(documento, detalhe);
    if (recuperado) {
      return this._confirmarClaimSemAceite(documento, detalhe.token, true);
    }
    return { ok: false, mensagem: 'Manifestação já em andamento para este documento.' };
  }

  /**
   * O aceite é gravado antes da liberação do claim: com o claim em mãos, um aceite
   * existente significa que outro processo concluiu entre a leitura inicial e o claim.
   */
  async _confirmarClaimSemAceite(documento, token, recuperado) {
    const aceita = await this._obterUltimoEvento(
      TIPOS_EVENTO.MANIFESTACAO_ACEITA,
      documento.id
    );
    if (aceita) {
      await this._liberarClaim(documento.id, token);
      return { ok: false, mensagem: 'Manifestação já aceita para esta chave.' };
    }
    return { ok: true, token, recuperado };
  }

  /**
   * CE-05 — claim órfão (processo caiu após reclamar): após TTL_CLAIM_MANIFESTACAO_MS
   * é assumido via compare-and-swap no próprio registro do claim (índice único mantido).
   * Só um recuperador vence; o rastro fica em MANIFESTACAO_CLAIM_RECUPERADO.
   */
  async _recuperarClaimExpirado(documento, novoDetalhe) {
    const repo = this._eventosRepository;
    if (typeof repo.obterUnicoComVersao !== 'function'
      || typeof repo.substituirDetalheSeInalterado !== 'function') {
      return false;
    }

    const atual = await repo.obterUnicoComVersao(TIPOS_EVENTO.MANIFESTACAO_CLAIM, documento.id);
    if (!atual) return false;

    const inicio = this._inicioClaim(atual);
    const agoraMs = this._agora().getTime();
    if (inicio == null || agoraMs - inicio < TTL_CLAIM_MANIFESTACAO_MS) {
      return false;
    }

    const anterior = {
      claimId: atual.id,
      token: atual.detalhe?.token || null,
      processo: atual.detalhe?.processo || null,
      reclamadoEm: new Date(inicio).toISOString(),
      expiradoEm: new Date(inicio + TTL_CLAIM_MANIFESTACAO_MS).toISOString()
    };
    // Sem o token anterior no novo claim: a liberação por dono localiza o token no detalhe_json.
    const { token: _tokenAnterior, ...anteriorSemToken } = anterior;
    const detalhe = { ...novoDetalhe, recuperadoDe: anteriorSemToken };

    const venceu = await repo.substituirDetalheSeInalterado({
      id: atual.id,
      tipo: TIPOS_EVENTO.MANIFESTACAO_CLAIM,
      versao: atual.versao,
      detalhe,
      descricao: 'Claim atômico de Ciência da Emissão (recuperado após expiração)'
    });
    if (!venceu) return false;

    await repo.inserir({
      tipo: TIPOS_EVENTO.MANIFESTACAO_CLAIM_RECUPERADO,
      origem: ORIGENS.SISTEMA,
      descricao: 'Claim de manifestação expirado recuperado',
      resultado: 'CLAIM_RECUPERADO',
      sucesso: null,
      documentoId: documento.id,
      detalhe: {
        chave: documento.chave,
        claimOriginal: anterior,
        ttlMs: TTL_CLAIM_MANIFESTACAO_MS,
        recuperadoPor: { token: novoDetalhe.token, processo: novoDetalhe.processo },
        recuperadoEm: novoDetalhe.reclamadoEm
      }
    });

    logCentral('MANIFESTACAO', {
      mensagem: 'Claim expirado recuperado',
      Etapa: 'claim_recuperado',
      documentoId: documento.id,
      claimOriginalId: anterior.claimId,
      reclamadoEmOriginal: anterior.reclamadoEm,
      expiradoEm: anterior.expiradoEm
    });
    return true;
  }

  /** Com token, só remove o claim do próprio dono (não apaga um claim já recuperado por outro). */
  async _liberarClaim(documentoId, token = null) {
    try {
      if (token && typeof this._eventosRepository.removerPorTipoDocumentoToken === 'function') {
        await this._eventosRepository.removerPorTipoDocumentoToken(
          TIPOS_EVENTO.MANIFESTACAO_CLAIM,
          documentoId,
          token
        );
        return;
      }
      await this._eventosRepository.removerPorTipoDocumento(
        TIPOS_EVENTO.MANIFESTACAO_CLAIM,
        documentoId
      );
    } catch { /* ignore */ }
  }

  async _registrarEtapa(dados) {
    const documento = dados.documento;
    const evento = await this._emitirEvento({
      tipo: dados.tipo,
      origem: ORIGENS.SISTEMA,
      descricao: dados.descricao,
      resultado: dados.resultado,
      sucesso: dados.sucesso,
      documentoId: documento.id,
      usuarioId: dados.usuarioId || null,
      duracaoMs: dados.duracaoMs || null,
      detalhe: dados.detalhe || null
    });

    if (!dados.ignorarHistoricoDuplicado) {
      await this._historicoRepository.inserir({
        documentoId: documento.id,
        statusAnterior: documento.status,
        statusNovo: documento.status,
        usuarioId: dados.usuarioId || null,
        detalhe: dados.descricao
      });
    } else {
      // Timeline: um único histórico por descrição recente evita órfãos/duplicatas de Ciência.
      const historico = await this._historicoRepository.listarPorDocumento?.(documento.id);
      const jaExiste = Array.isArray(historico)
        && historico.some((h) => h.detalhe === dados.descricao);
      if (!jaExiste) {
        await this._historicoRepository.inserir({
          documentoId: documento.id,
          statusAnterior: documento.status,
          statusNovo: documento.status,
          usuarioId: dados.usuarioId || null,
          detalhe: dados.descricao
        });
      }
    }
    return evento;
  }

  async _obterUltimoEvento(tipo, documentoId) {
    const eventos = await this._eventosRepository.listar({
      tipo,
      documentoId,
      limite: 1
    });
    return eventos[0] || null;
  }

  _obterProximaConsulta(...eventos) {
    const datas = eventos
      .map((evento) => evento?.detalhe?.proximaConsultaEm)
      .filter(Boolean)
      .map((valor) => new Date(valor))
      .filter((data) => !Number.isNaN(data.getTime()));
    if (!datas.length) return null;
    return new Date(Math.max(...datas.map((data) => data.getTime())));
  }

  _ehRejeicaoXmlIndisponivel(eventoRejeicao) {
    if (!eventoRejeicao) return false;
    const cStat = String(
      eventoRejeicao.detalhe?.cStat
      || eventoRejeicao.resultado
      || ''
    );
    return CSTAT_XML_INDISPONIVEL.has(cStat);
  }

  /**
   * CENTRAL-XML-MULTICNPJ-02 — cStat 596 do evento 210210 (prazo) não equivale a
   * "SEFAZ não tem procNFe". Tenta consChNFe no CNPJ do documento; só então encerra.
   * @private
   */
  async _resolverAposEvento596(documento, contexto, opcoes, meta = {}) {
    const cStat596 = String(meta.cStat || '596');
    const xMotivo = meta.xMotivo || MENSAGEM_XML_INDISPONIVEL;
    const logCtx = camposLogContextoDocumento(contexto, documento);

    const adminConfirmado = opcoes.forcarAdminConfirmado === true && opcoes.confirmacaoAdmin === true;
    if (!adminConfirmado) {
      const ultimaConsulta = await this._obterUltimoEvento(
        TIPOS_EVENTO.CONSULTA_DFE_POS_MANIFESTACAO,
        documento.id
      );
      const proximaConsultaEm = this._obterProximaConsulta(ultimaConsulta);
      if (proximaConsultaEm && this._agora() < proximaConsultaEm) {
        logCentral('MANIFESTACAO', {
          mensagem: '596 de ciência; consChNFe não executado — dentro da janela do documento',
          Etapa: 'pos_596_aguardando_janela',
          cStat: cStat596,
          proximaConsultaEm: proximaConsultaEm.toISOString(),
          ...logCtx
        });
        return {
          documentoId: documento.id,
          sucesso: false,
          ignorado: true,
          cStat: cStat596,
          cStatConsChNFe: ultimaConsulta?.detalhe?.cStat || null,
          encerrado: false,
          cienciaRejeitadaPrazo: true,
          xmlCompleto: false,
          aguardandoDisponibilizacao: true,
          aguardandoJanela: true,
          motivo: 'AGUARDANDO_JANELA_POS_596',
          proximaConsultaEm: proximaConsultaEm.toISOString(),
          mensagem: MENSAGEM_AGUARDANDO_JANELA_596
        };
      }
    }

    logCentral('MANIFESTACAO', {
      mensagem: 'cStat 596 no evento 210210 — consultando consChNFe antes de XML_INDISPONIVEL',
      Etapa: 'pos_596_consChNFe',
      Tentativa: 1,
      cStat: cStat596,
      xMotivo,
      ...logCtx
    });

    let porChave;
    try {
      porChave = await this._consultarXmlCompletoPorChave(documento, contexto, {
        ...opcoes,
        correlationId: meta.correlationId || opcoes.correlationId,
        origemDist: { cStat: cStat596, motivo: 'ciencia_210210_prazo' }
      });
    } catch (error) {
      porChave = {
        xmlCompleto: false,
        mensagem: error.message,
        cStat: null
      };
    }

    if (porChave.xmlCompleto) {
      logCentral('MANIFESTACAO', {
        mensagem: 'procNFe obtido após 596 de ciência',
        Etapa: 'pos_596_xml_ok',
        cStat: porChave.cStat || '138',
        ...logCtx
      });
      return {
        ...porChave,
        sucesso: true,
        cStat: porChave.cStat || '138',
        cStatCiencia: cStat596,
        encerrado: false,
        cienciaRejeitadaPrazo: true,
        xmlCompleto: true
      };
    }

    const cStatCons = String(porChave.cStat || '');
    const sefazSemDocumento = cStatCons === '137';
    if (!sefazSemDocumento) {
      logCentral('MANIFESTACAO', {
        mensagem: '596 de ciência; consChNFe sem evidência de ausência de XML — não encerra',
        Etapa: 'pos_596_sem_encerrar',
        cStat: cStat596,
        cStatConsChNFe: cStatCons || null,
        xMotivo: porChave.mensagem || xMotivo,
        ...logCtx
      });
      return {
        documentoId: documento.id,
        sucesso: false,
        cStat: cStat596,
        cStatConsChNFe: cStatCons || null,
        encerrado: false,
        cienciaRejeitadaPrazo: true,
        xmlCompleto: false,
        aguardandoDisponibilizacao: true,
        proximaConsultaEm: porChave.proximaConsultaEm || null,
        bloqueadoGate: porChave.bloqueadoGate === true || undefined,
        codigo: porChave.bloqueadoGate ? porChave.codigo : undefined,
        mensagem: porChave.mensagem || xMotivo,
        consultaPorChave: true
      };
    }

    await this._encerrarXmlIndisponivel(documento, {
      cStat: cStat596,
      xMotivo,
      usuarioId: meta.usuarioId || opcoes.usuarioId,
      correlationId: meta.correlationId || opcoes.correlationId,
      detalhe: {
        ...(meta.detalhe || {}),
        consChNFe: {
          cStat: porChave.cStat || null,
          xmlCompleto: false,
          mensagem: porChave.mensagem || null
        }
      }
    });

    logCentral('MANIFESTACAO', {
      mensagem: 'XML_INDISPONIVEL após 596 + consChNFe sem procNFe',
      Etapa: 'xml_indisponivel',
      cStat: cStat596,
      cStatConsChNFe: porChave.cStat || null,
      xMotivo,
      ...logCtx
    });

    return {
      documentoId: documento.id,
      sucesso: false,
      cStat: cStat596,
      cStatConsChNFe: porChave.cStat || null,
      status: DocumentoFiscalStatus.XML_INDISPONIVEL,
      encerrado: true,
      xmlCompleto: false,
      aguardandoDisponibilizacao: false,
      mensagem: xMotivo,
      detalhe: meta.detalhe || null,
      consultaPorChave: true
    };
  }

  /**
   * RC7.4.7 — Encerra documento em XML_INDISPONIVEL e cancela XML_WAIT.
   * @private
   */
  async _encerrarXmlIndisponivel(documento, meta = {}) {
    const cStat = String(meta.cStat || '596');
    const xMotivo = meta.xMotivo || MENSAGEM_XML_INDISPONIVEL;
    const cStatCons = meta.detalhe?.consChNFe?.cStat;
    const detalhe = cStatCons
      ? `XML indisponível (cStat ${cStat}; consChNFe ${cStatCons}): ${xMotivo}`
      : `XML indisponível (cStat ${cStat}): ${xMotivo}`;

    if (documento.status === DocumentoFiscalStatus.AGUARDANDO_XML_COMPLETO) {
      await this._transitionService.transicionar(
        documento.id,
        documento.status,
        DocumentoFiscalStatus.XML_INDISPONIVEL,
        {
          detalhe,
          usuarioId: meta.usuarioId || null,
          origem: 'RC7.4.7_CSTAT_596'
        }
      );
    }

    this._cancelarXmlWait(documento.id, 'xml_indisponivel');

    logOperacaoCentral({
      correlationId: meta.correlationId || null,
      chave: documento.chave,
      operacao: 'MANIFESTACAO_210210',
      tempoMs: null,
      resultado: 'XML_INDISPONIVEL',
      cStat,
      origem: 'CentralManifestacaoDfeService',
      runtime: 'PLATFORM'
    });
  }

  _obterBloqueioRejeicao(eventoRejeicao) {
    if (!eventoRejeicao) return null;
    // RC7.4.7 — 596 nunca entra em cooldown de retry.
    if (this._ehRejeicaoXmlIndisponivel(eventoRejeicao)) return null;
    if (eventoRejeicao.detalhe?.proximaConsultaEm) {
      const data = new Date(eventoRejeicao.detalhe.proximaConsultaEm);
      return Number.isNaN(data.getTime()) ? null : data;
    }
    if (!eventoRejeicao.createdAt) return null;
    const criada = new Date(eventoRejeicao.createdAt);
    if (Number.isNaN(criada.getTime())) return null;
    return new Date(criada.getTime() + INTERVALO_SEGURO_MS);
  }

  _resolverProximaJanela(referencia = null) {
    const candidatas = [];
    if (referencia) {
      const data = new Date(referencia);
      if (!Number.isNaN(data.getTime())) candidatas.push(data);
    }
    candidatas.push(new Date(this._agora().getTime() + INTERVALO_SEGURO_MS));
    return new Date(Math.max(...candidatas.map((data) => data.getTime())));
  }

  _obterCooldownNsu(controle) {
    if (!controle?.dataSincronizacao) return null;
    if (String(controle.ultNsu || '') !== String(controle.maxNsu || '')) return null;
    const ultima = new Date(controle.dataSincronizacao);
    if (Number.isNaN(ultima.getTime())) return null;
    const proxima = new Date(ultima.getTime() + INTERVALO_SEGURO_MS);
    return this._agora() < proxima ? proxima : null;
  }
}

module.exports = CentralManifestacaoDfeService;
module.exports.POLITICAS_MANIFESTACAO = POLITICAS_MANIFESTACAO;
module.exports.CSTAT_MANIFESTACAO_ACEITA = CSTAT_MANIFESTACAO_ACEITA;
module.exports.CSTAT_XML_INDISPONIVEL = CSTAT_XML_INDISPONIVEL;
module.exports.INTERVALO_SEGURO_MS = INTERVALO_SEGURO_MS;
module.exports.TTL_CLAIM_MANIFESTACAO_MS = TTL_CLAIM_MANIFESTACAO_MS;
module.exports.LIMITE_AVALIACAO_CANDIDATOS = LIMITE_AVALIACAO_CANDIDATOS;
module.exports.MOTIVOS_EXCLUSAO_CANDIDATO = MOTIVOS_EXCLUSAO_CANDIDATO;
module.exports.CODIGO_CIENCIA_FORA_DO_PRAZO = CODIGO_CIENCIA_FORA_DO_PRAZO;
module.exports.CICLO_MANIFESTACAO = CICLO_MANIFESTACAO;
module.exports.MENSAGEM_AGUARDANDO_XML = MENSAGEM_AGUARDANDO_XML;
module.exports.MENSAGEM_XML_INDISPONIVEL = MENSAGEM_XML_INDISPONIVEL;
module.exports.MENSAGEM_AGUARDANDO_JANELA_596 = MENSAGEM_AGUARDANDO_JANELA_596;
module.exports.adquirirLockDocumentoSefaz = adquirirLockDocumentoSefaz;
module.exports.liberarLockDocumentoSefaz = liberarLockDocumentoSefaz;
module.exports.extrairRetornoManifestacao = extrairRetornoManifestacao;
module.exports.prepararEnvelopeAssinado = prepararEnvelopeAssinado;
