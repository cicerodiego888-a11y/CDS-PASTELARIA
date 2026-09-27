/**
 * MotorRecuperacaoXmlService — Recuperação automática de procNFe (RC3.7.5).
 *
 * Monitora XML_INDISPONIVEL + RESUMO_RECEBIDO.
 * Reconsulta SEFAZ via consChNFe (consultarNotaPorChave).
 * Ao localizar PROC_NFE: atualiza o mesmo registro (persistirDocumentoDfe) e
 * dispara processamento → EM_REVISAO / PRONTA_IMPORTACAO.
 *
 * Não cria INSERT duplicado. Respeita Gate SEFAZ (656).
 *
 * @module motores/central-entradas/recuperacao-xml/MotorRecuperacaoXmlService
 */

'use strict';

const CentralDocumentosRepository = require('../repositories/CentralDocumentosRepository');
const CentralConfigRepository = require('../repositories/CentralConfigRepository');
const CentralHistoricoRepository = require('../repositories/CentralHistoricoRepository');
const CentralEventosRepository = require('../repositories/CentralEventosRepository');
const { DocumentoFiscalStatus, normalizarStatus } = require('../core/DocumentoFiscalStatus');
const { DocumentoDfeTipo } = require('../core/DocumentoDfeTipo');
const DocumentoTransitionService = require('../services/DocumentoTransitionService');
const { TIPOS_EVENTO, ORIGENS } = require('../config/centralEventosTipos');
const { criarCorrelationId } = require('../utils/centralOperacaoLog');
const { logCentral, logCentralErro } = require('../utils/centralLog');
const CentralDfePersistenciaService = require('../services/CentralDfePersistenciaService');
const {
  obterContextoOperacionalDoDocumento,
  resolverEmpresaIdDocumento,
  camposLogContextoDocumento
} = require('../services/resolverContextoDocumentoCentral');
const {
  STATUS_MONITORADOS,
  ehElegivelRecuperacaoXml,
  filtrarCandidatosFila,
  ordenarFila
} = require('./FilaRecuperacaoXml');
const {
  CHAVES,
  INTERVALOS_PERMITIDOS,
  DEFAULTS,
  lerConfigDeMapa
} = require('./MotorRecuperacaoXmlConfig');

const {
  INTERVALO_SEGURO_MS,
  POLITICAS_MANIFESTACAO,
  adquirirLockDocumentoSefaz,
  liberarLockDocumentoSefaz
} = require('../services/CentralManifestacaoDfeService');

const ORIGEM_MOTOR = 'recuperacao_xml_automatica';

class MotorRecuperacaoXmlService {
  constructor(deps = {}) {
    this._documentosRepository = deps.documentosRepository
      || new CentralDocumentosRepository({ db: deps.db || null });
    this._configRepository = deps.configRepository || new CentralConfigRepository();
    this._historicoRepository = deps.historicoRepository
      || new CentralHistoricoRepository({ db: deps.db || null });
    this._eventosRepository = deps.eventosRepository
      || new CentralEventosRepository({ db: deps.db || null });
    this._transitionService = deps.transitionService
      || new DocumentoTransitionService({
        documentosRepository: this._documentosRepository,
        historicoRepository: this._historicoRepository
      });
    this._gate = deps.gate || null;
    this._consultarNotaPorChave = deps.consultarNotaPorChave
      || ((chave, opts) => require('../../../services/fiscal/distribuicaoDFe')
        .consultarNotaPorChave(chave, opts));
    this._obterContexto = deps.obterContextoOperacional
      || (async (opcoes = {}) => {
        const cfg = new (require('../services/CentralConfiguracaoService'))();
        return cfg.obterContextoOperacional(opcoes);
      });
    this._criarPersistencia = deps.criarPersistencia || ((empresaId) => (
      new CentralDfePersistenciaService({
        documentosRepository: this._documentosRepository,
        historicoRepository: this._historicoRepository,
        empresaId
      })
    ));
    this._processarDocumento = deps.processarDocumento
      || (async (id, opcoes) => {
        const orch = require('../CentralEntradasOrchestrator');
        if (typeof orch.processarDocumento === 'function') {
          return orch.processarDocumento(id, opcoes);
        }
        return null;
      });
    this._agora = deps.agora || (() => new Date());
    this._manifestacaoService = deps.manifestacaoService || null;
    this._obterPoliticaManifestacao = deps.obterPoliticaManifestacao || null;

    /** @private */
    this._timeoutId = null;
    /** @private */
    this._ativo = false;
    /** @private */
    this._cicloEmExecucao = false;
    /** @private */
    this._estado = this._estadoVazio();
  }

  /** @private */
  _estadoVazio() {
    return {
      ultimaExecucao: null,
      proximaExecucao: null,
      docs: {},
      metricas: {
        ciclos: 0,
        consultas: 0,
        recuperados: 0,
        falhas: 0,
        timeouts: 0,
        removidos: 0,
        gateBloqueios: 0
      }
    };
  }

  /** @private */
  _obterGate() {
    if (this._gate) return this._gate;
    try {
      this._gate = require('../services/CentralSefazOperationalGate');
    } catch {
      this._gate = null;
    }
    return this._gate;
  }

  /** @private */
  _obterServicoManifestacao() {
    if (this._manifestacaoService) return this._manifestacaoService;
    const Svc = require('../services/CentralManifestacaoDfeService');
    return new Svc({
      documentosRepository: this._documentosRepository,
      historicoRepository: this._historicoRepository,
      eventosRepository: this._eventosRepository,
      consultarNotaPorChave: this._consultarNotaPorChave,
      gate: this._obterGate() || undefined
    });
  }

  /**
   * CE-05 P08 — política de manifestação configurada; falha de leitura não autoriza envio.
   * @private
   */
  async _obterPoliticaManifestacaoSegura(svcManif) {
    try {
      if (this._obterPoliticaManifestacao) {
        return await this._obterPoliticaManifestacao();
      }
      return await svcManif._configuracao.obterPoliticaManifestacao();
    } catch (error) {
      logCentralErro('RECUPERACAO_XML', error, { Etapa: 'politica_manifestacao' });
      return null;
    }
  }

  estaAtivo() {
    return this._ativo;
  }

  /**
   * @returns {Promise<Object>}
   */
  async obterConfig() {
    try {
      const CentralConfiguracaoRepository = require('../repositories/CentralConfiguracaoRepository');
      if (this._configRepository instanceof CentralConfiguracaoRepository
        || typeof this._configRepository.ensureDefaults === 'function') {
        await this._configRepository.ensureDefaults();
      }
    } catch { /* ignore */ }
    const mapa = await this._lerMapaConfig();
    return lerConfigDeMapa(mapa);
  }

  /** @private */
  async _lerMapaConfig() {
    const mapa = {};
    try {
      const regs = await this._configRepository.listarTodas();
      for (const reg of regs || []) {
        mapa[reg.chave] = this._configRepository.parseValor(reg);
      }
    } catch {
      for (const chave of Object.values(CHAVES)) {
        if (chave === CHAVES.ESTADO) continue;
        try {
          const reg = await this._configRepository.buscarPorChave(chave);
          if (reg) mapa[chave] = this._configRepository.parseValor(reg);
        } catch { /* ignore */ }
      }
    }
    return mapa;
  }

  /**
   * Painel técnico / API.
   * @returns {Promise<Object>}
   */
  async obterStatus() {
    const config = await this.obterConfig();
    await this._carregarEstado();
    const fila = await this.listarMonitorados({ incluirEstado: true });

    return {
      ativo: this._ativo,
      cicloEmExecucao: this._cicloEmExecucao,
      config,
      intervalosPermitidos: [...INTERVALOS_PERMITIDOS],
      ultimaExecucao: this._estado.ultimaExecucao,
      proximaExecucao: this._estado.proximaExecucao,
      documentosMonitorados: fila.length,
      fila: fila.slice(0, 50),
      metricas: { ...this._estado.metricas },
      defaults: { ...DEFAULTS }
    };
  }

  /**
   * Lista documentos elegíveis + estado de tentativas.
   * @param {Object} [opcoes]
   * @returns {Promise<Object[]>}
   */
  async listarMonitorados(opcoes = {}) {
    await this._carregarEstado();
    const docs = await this._documentosRepository.listar({
      statusIn: [...STATUS_MONITORADOS],
      limite: Math.min(Number(opcoes.limite) || 200, 400),
      ordenarPor: 'created_at',
      ordenarDirecao: 'ASC'
    });
    const candidatos = ordenarFila(filtrarCandidatosFila(docs));
    if (!opcoes.incluirEstado) return candidatos;

    return candidatos.map((doc) => {
      const st = this._estado.docs[String(doc.id)] || {};
      return {
        id: doc.id,
        chave: doc.chave,
        status: doc.status,
        tipoDocumento: doc.tipoDocumento || doc.tipo_documento,
        nsu: doc.nsu,
        numero: doc.numero,
        fornecedor: doc.fornecedor,
        createdAt: doc.createdAt || doc.created_at,
        empresaId: doc.empresaId || doc.empresa_id || null,
        tentativas: Number(st.tentativas) || 0,
        ultimaConsulta: st.ultimaConsulta || null,
        ultimoRetorno: st.ultimoRetorno || null,
        motivo: st.motivo || null,
        correlationId: st.correlationId || null,
        desde: st.desde || doc.createdAt || doc.created_at || null
      };
    });
  }

  async iniciar(opcoes = {}) {
    const config = await this.obterConfig();
    this.parar({ silencioso: true });

    if (!config.ativa && !opcoes.forcar) {
      this._ativo = false;
      logCentral('RECUPERACAO_XML', {
        mensagem: 'Motor desativado por configuração',
        Evento: 'SLEEP'
      });
      return { iniciado: false, motivo: 'desativado' };
    }

    await this._carregarEstado();
    this._ativo = true;
    const delayMs = opcoes.delayMs != null ? opcoes.delayMs : 12 * 1000;
    this._agendar(delayMs, 'boot');
    logCentral('RECUPERACAO_XML', {
      mensagem: 'Motor de recuperação XML iniciado',
      Evento: 'START',
      IntervaloMin: config.intervaloMinutos
    });
    return { iniciado: true, intervaloMinutos: config.intervaloMinutos };
  }

  parar(opcoes = {}) {
    if (this._timeoutId) {
      clearTimeout(this._timeoutId);
      this._timeoutId = null;
    }
    const estava = this._ativo;
    this._ativo = false;
    this._cicloEmExecucao = false;
    if (!opcoes.silencioso && estava) {
      logCentral('RECUPERACAO_XML', { mensagem: 'Motor parado', Evento: 'STOP' });
    }
  }

  /** @private */
  _agendar(delayMs, motivo) {
    if (this._timeoutId) clearTimeout(this._timeoutId);
    const ms = Math.max(3000, Number(delayMs) || 60000);
    const proxima = new Date(this._agora().getTime() + ms).toISOString();
    this._estado.proximaExecucao = proxima;
    this._timeoutId = setTimeout(() => {
      this._timeoutId = null;
      this.executarCiclo({ motivo: motivo || 'agendado' }).catch((err) => {
        logCentralErro('RECUPERACAO_XML', err, { Evento: 'CICLO_ERRO' });
      });
    }, ms);
  }

  /**
   * Ciclo completo do scheduler.
   * @param {Object} [opcoes]
   * @returns {Promise<Object>}
   */
  async executarCiclo(opcoes = {}) {
    if (this._cicloEmExecucao) {
      return { ignorado: true, motivo: 'ciclo_em_execucao' };
    }

    this._cicloEmExecucao = true;
    let config;
    try {
      config = await this.obterConfig();
    } catch (error) {
      this._cicloEmExecucao = false;
      throw error;
    }
    if (!config.ativa && !opcoes.forcar) {
      this._cicloEmExecucao = false;
      this._ativo = false;
      return { ignorado: true, motivo: 'desativado' };
    }

    const correlationId = opcoes.correlationId || criarCorrelationId();
    const inicio = Date.now();
    const relatorio = {
      correlationId,
      consultados: 0,
      recuperados: 0,
      falhas: 0,
      timeouts: 0,
      removidos: 0,
      gateBloqueado: false,
      itens: []
    };

    try {
      await this._carregarEstado();
      this._estado.metricas.ciclos += 1;
      this._estado.ultimaExecucao = this._agora().toISOString();

      const monitorados = await this.listarMonitorados({ incluirEstado: true, limite: 200 });
      const elegiveis = [];

      for (const item of monitorados) {
        const sync = this._sincronizarEntradaFila(item, correlationId);
        if (sync.entrou) {
          await this._emitirEvento({
            tipo: TIPOS_EVENTO.RECUPERACAO_XML_ENTROU_FILA,
            documentoId: item.id,
            descricao: `Documento #${item.id} entrou na fila de recuperação automática`,
            sucesso: true,
            correlationId,
            detalhe: { chave: item.chave, status: item.status }
          });
        }

        const decisao = this._avaliarLimites(item, config);
        if (decisao.remover) {
          await this._removerDaFila(item, decisao.motivo, correlationId, decisao.timeout);
          relatorio.removidos += 1;
          if (decisao.timeout) relatorio.timeouts += 1;
          continue;
        }
        if (decisao.adiar) continue;
        elegiveis.push(item);
      }

      elegiveis.sort((a, b) => {
        const sa = a.status === DocumentoFiscalStatus.XML_INDISPONIVEL ? 0 : 1;
        const sb = b.status === DocumentoFiscalStatus.XML_INDISPONIVEL ? 0 : 1;
        if (sa !== sb) return sa - sb;
        const ta = Number(a.tentativas) || 0;
        const tb = Number(b.tentativas) || 0;
        if (ta !== tb) return ta - tb;
        const ea = Number(a.empresaId || a.empresa_id) || 0;
        const eb = Number(b.empresaId || b.empresa_id) || 0;
        if (ea !== eb) return ea - eb;
        return Number(a.id) - Number(b.id);
      });

      const lote = elegiveis.slice(0, config.lotePorCiclo);

      for (const item of lote) {
        const resultado = await this._consultarDocumento(item, config, correlationId);
        relatorio.itens.push(resultado);
        relatorio.consultados += 1;
        this._estado.metricas.consultas += 1;

        if (resultado.gateBloqueado) {
          relatorio.gateBloqueado = true;
          this._estado.metricas.gateBloqueios += 1;
          break;
        }
        if (resultado.recuperado) {
          relatorio.recuperados += 1;
          this._estado.metricas.recuperados += 1;
        } else if (resultado.falha) {
          relatorio.falhas += 1;
          this._estado.metricas.falhas += 1;
        }
      }

      await this._persistirEstado();
    } catch (error) {
      logCentralErro('RECUPERACAO_XML', error, {
        Evento: 'CICLO_ERRO',
        CorrelationId: correlationId
      });
      relatorio.erro = error.message;
    } finally {
      this._cicloEmExecucao = false;
      const configPos = await this.obterConfig().catch(() => config);
      if (this._ativo && configPos.ativa) {
        this._agendar(configPos.intervaloMinutos * 60 * 1000, 'pos_ciclo');
        await this._persistirEstado().catch(() => {});
      }
      logCentral('RECUPERACAO_XML', {
        mensagem: 'Ciclo concluído',
        CorrelationId: correlationId,
        Tempo: Date.now() - inicio,
        Consultados: relatorio.consultados,
        Recuperados: relatorio.recuperados,
        Falhas: relatorio.falhas
      });
    }

    return relatorio;
  }

  /**
   * @private
   */
  _sincronizarEntradaFila(item, correlationId) {
    const key = String(item.id);
    if (this._estado.docs[key]) {
      return { entrou: false };
    }
    this._estado.docs[key] = {
      tentativas: 0,
      ultimaConsulta: null,
      ultimoRetorno: null,
      motivo: 'monitoramento_ativo',
      correlationId,
      desde: this._agora().toISOString(),
      chave: item.chave
    };
    return { entrou: true };
  }

  /**
   * @private
   */
  _avaliarLimites(item, config) {
    const st = this._estado.docs[String(item.id)] || {};
    const tentativas = Number(st.tentativas) || 0;
    if (tentativas >= config.maxTentativas) {
      return {
        remover: true,
        timeout: true,
        motivo: `Limite de tentativas (${config.maxTentativas}) atingido`
      };
    }

    const desde = st.desde || item.createdAt || item.created_at;
    if (desde) {
      const dias = (this._agora().getTime() - new Date(desde).getTime()) / (24 * 60 * 60 * 1000);
      if (Number.isFinite(dias) && dias > config.maxDiasMonitoramento) {
        return {
          remover: true,
          timeout: true,
          motivo: `Tempo máximo de monitoramento (${config.maxDiasMonitoramento} dias) excedido`
        };
      }
    }

    return { remover: false, adiar: false };
  }

  /**
   * @private
   */
  async _consultarDocumento(item, config, correlationIdCiclo) {
    const id = Number(item.id);
    const correlationId = criarCorrelationId();
    const base = {
      documentoId: id,
      chave: item.chave,
      recuperado: false,
      falha: false,
      gateBloqueado: false,
      mensagem: null
    };

    const doc = await this._documentosRepository.buscarPorId(id);
    if (!doc || !ehElegivelRecuperacaoXml(doc.status)) {
      await this._removerDaFila(item, 'status_nao_elegivel', correlationId, false);
      return { ...base, mensagem: 'Documento saiu da fila (status alterado)' };
    }

    const statusAtual = normalizarStatus(doc.status);
    let rejeicao596 = false;
    if (
      statusAtual === DocumentoFiscalStatus.RESUMO_RECEBIDO
      && typeof this._eventosRepository?.listar === 'function'
    ) {
      const aceita = await this._eventosRepository.listar({
        tipo: TIPOS_EVENTO.MANIFESTACAO_ACEITA,
        documentoId: id,
        limite: 1
      });
      const rejeitada = await this._eventosRepository.listar({
        tipo: TIPOS_EVENTO.MANIFESTACAO_REJEITADA,
        documentoId: id,
        limite: 1
      });
      const cStatRej = String(
        rejeitada?.[0]?.resultado
        || rejeitada?.[0]?.detalhe?.cStat
        || ''
      );
      rejeicao596 = !aceita?.[0] && cStatRej === '596';
      if (!aceita?.[0] && cStatRej !== '596') {
        const svcManif = this._obterServicoManifestacao();
        const politica = await this._obterPoliticaManifestacaoSegura(svcManif);
        if (politica !== POLITICAS_MANIFESTACAO.AUTOMATICA_CIENCIA) {
          const motivo = `Política de manifestação ${politica || 'indisponível'}: `
            + 'Ciência 210210 aguarda ação do operador (sem envio automático)';
          this._atualizarEstadoDoc(id, {
            ultimoRetorno: 'AGUARDANDO_POLITICA_MANIFESTACAO',
            motivo,
            politica: politica || null,
            correlationId
          });
          logCentral('RECUPERACAO_XML', {
            mensagem: motivo,
            Etapa: 'politica_manifestacao',
            documentoId: id,
            politica: politica || null,
            correlationId
          });
          return {
            ...base,
            aguardandoPolitica: true,
            politica: politica || null,
            mensagem: motivo
          };
        }
        const processarManif = this._processarManifestacao
          || ((documentoId, opcoes) => svcManif.processarDocumento(documentoId, opcoes));
        const rManif = await processarManif(id, {
          origemAutomatica: true,
          apenasManifestacao: true,
          correlationId
        });
        this._atualizarEstadoDoc(id, {
          tentativas: (this._estado.docs[String(id)]?.tentativas || 0) + 1,
          ultimaConsulta: this._agora().toISOString(),
          ultimoRetorno: rManif?.cStat || (rManif?.sucesso ? 'CIENCIA' : 'CIENCIA_PENDENTE'),
          motivo: rManif?.mensagem || 'Ciência 210210 (recuperação XML)',
          correlationId
        });
        return {
          ...base,
          recuperado: rManif?.xmlCompleto === true,
          mensagem: rManif?.mensagem || 'Ciência da emissão enviada',
          cStat: rManif?.cStat || null
        };
      }
    }

    if (!doc.chave || String(doc.chave).replace(/\D/g, '').length !== 44) {
      this._atualizarEstadoDoc(id, {
        tentativas: (this._estado.docs[String(id)]?.tentativas || 0) + 1,
        ultimaConsulta: this._agora().toISOString(),
        ultimoRetorno: 'SEM_CHAVE',
        motivo: 'Chave inválida',
        correlationId
      });
      return { ...base, falha: true, mensagem: 'Chave inválida' };
    }

    const proximaConsultaDoc = await this._proximaConsultaDocumento(id);
    if (proximaConsultaDoc && this._agora() < proximaConsultaDoc) {
      this._atualizarEstadoDoc(id, {
        ultimoRetorno: rejeicao596 ? 'AGUARDANDO_JANELA_POS_596' : 'AGUARDANDO_JANELA',
        motivo: rejeicao596
          ? 'Ciência rejeitada por prazo (596); consChNFe aguardando próxima janela'
          : 'Documento já consultado; aguardando próxima janela',
        proximaConsultaEm: proximaConsultaDoc.toISOString(),
        correlationId
      });
      return {
        ...base,
        aguardandoJanela: true,
        cStat: rejeicao596 ? '596' : undefined,
        proximaConsultaEm: proximaConsultaDoc.toISOString(),
        mensagem: 'Aguardando próxima janela de consulta do documento'
      };
    }

    let ctxResult = null;
    let erroContexto = null;
    try {
      ctxResult = await obterContextoOperacionalDoDocumento(this._obterContexto, doc);
    } catch (error) {
      erroContexto = error;
    }
    const contextoGate = ctxResult?.ok ? (ctxResult.contexto || {}) : {};

    const gate = this._obterGate();
    if (gate?.autorizarConsultaDistDfe) {
      const auth = await gate.autorizarConsultaDistDfe({
        correlationId,
        documentoId: id,
        chave: doc.chave,
        nsu: doc.nsu,
        empresaId: contextoGate.empresaId,
        cnpj: contextoGate.cnpj,
        ambiente: contextoGate.ambiente,
        origem: ORIGEM_MOTOR,
        motivo: 'recuperacao_xml_automatica_consChNFe',
        forcar: false
      });
      if (!auth.permitido) {
        this._atualizarEstadoDoc(id, {
          ultimaConsulta: this._agora().toISOString(),
          ultimoRetorno: auth.codigo || 'GATE_BLOQUEADO',
          motivo: auth.mensagem || 'Gate SEFAZ bloqueou consulta',
          correlationId
        });
        await this._emitirEvento({
          tipo: TIPOS_EVENTO.RECUPERACAO_XML_FALHA,
          documentoId: id,
          descricao: `Consulta bloqueada pelo Gate: ${auth.codigo || 'GATE'}`,
          sucesso: false,
          correlationId,
          detalhe: {
            codigo: auth.codigo,
            cStat: auth.cStat,
            escopo: auth.escopo || null,
            empresa_id: auth.empresaId || null,
            proximaConsultaEm: auth.proximaConsultaEm || null
          }
        });
        return {
          ...base,
          gateBloqueado: true,
          proximaConsultaEm: auth.proximaConsultaEm || null,
          mensagem: auth.mensagem || 'Gate bloqueado'
        };
      }
    }

    if (!adquirirLockDocumentoSefaz(id)) {
      return {
        ...base,
        emAndamento: true,
        mensagem: 'Documento já em consulta SEFAZ por outro fluxo'
      };
    }

    let resultadoConsulta = null;
    let consultaEnviada = false;
    try {
      if (erroContexto) throw erroContexto;
      if (!ctxResult?.ok) {
        throw new Error(ctxResult?.mensagem || 'Contexto operacional indisponível');
      }
      const contexto = ctxResult.contexto || {};
      const empresaIdPersistencia = Number(contexto.empresaId)
        || resolverEmpresaIdDocumento(doc);
      const persistencia = Number.isInteger(empresaIdPersistencia) && empresaIdPersistencia > 0
        ? this._criarPersistencia(empresaIdPersistencia)
        : undefined;

      const logCtx = camposLogContextoDocumento(contexto, doc);
      logCentral('RECUPERACAO_XML', {
        mensagem: 'Consulta consChNFe',
        Etapa: 'consChNFe',
        Tentativa: (this._estado.docs[String(id)]?.tentativas || 0) + 1,
        CorrelationId: correlationId,
        ...logCtx
      });

      await this._emitirEvento({
        tipo: TIPOS_EVENTO.RECUPERACAO_XML_CONSULTA,
        documentoId: id,
        descricao: `Consulta automática consChNFe — documento #${id}`,
        sucesso: true,
        correlationId,
        detalhe: {
          chave: logCtx.chave,
          nsu: doc.nsu,
          status: doc.status,
          ciclo: correlationIdCiclo,
          empresa_id: logCtx.empresa_id,
          cnpj: logCtx.cnpj,
          ambiente: logCtx.ambiente
        }
      });

      consultaEnviada = true;
      resultadoConsulta = await this._consultarNotaPorChave(
        String(doc.chave).replace(/\D/g, ''),
        {
          contextoCentral: contexto,
          persistenciaService: persistencia,
          gateSefaz: gate || undefined,
          documentoId: id,
          correlationId,
          origemGate: ORIGEM_MOTOR
        }
      );

      logCentral('RECUPERACAO_XML', {
        mensagem: 'Retorno consChNFe',
        Etapa: 'retorno_sefaz',
        CorrelationId: correlationId,
        ...logCtx,
        cStat: resultadoConsulta?.cStat || null,
        xMotivo: resultadoConsulta?.mensagem || resultadoConsulta?.xMotivo || null,
        httpStatus: resultadoConsulta?.statusCode || resultadoConsulta?.httpStatus || null,
        notasNovas: resultadoConsulta?.notasNovas,
        recuperado: false
      });

      if (rejeicao596) {
        await this._registrarConsultaPos596(id, correlationId, {
          cStat: resultadoConsulta?.cStat || null,
          xMotivo: resultadoConsulta?.xMotivo || resultadoConsulta?.mensagem || null
        });
      }
    } catch (error) {
      if (error?.bloqueadoGate) {
        this._atualizarEstadoDoc(id, {
          ultimaConsulta: this._agora().toISOString(),
          ultimoRetorno: error.codigo || 'GATE_BLOQUEADO',
          motivo: error.message,
          correlationId
        });
        return {
          ...base,
          gateBloqueado: true,
          proximaConsultaEm: error.proximaConsultaEm || null,
          mensagem: error.message
        };
      }
      const cStatErro = error?.cStat ? String(error.cStat) : null;
      if (rejeicao596 && consultaEnviada) {
        await this._registrarConsultaPos596(id, correlationId, {
          cStat: cStatErro,
          xMotivo: error?.xMotivo || error.message
        });
      }
      this._atualizarEstadoDoc(id, {
        tentativas: (this._estado.docs[String(id)]?.tentativas || 0) + 1,
        ultimaConsulta: this._agora().toISOString(),
        ultimoRetorno: cStatErro || 'ERRO',
        motivo: error.message,
        correlationId
      });
      await this._emitirEvento({
        tipo: TIPOS_EVENTO.RECUPERACAO_XML_FALHA,
        documentoId: id,
        descricao: `Falha na consulta automática: ${error.message}`,
        sucesso: false,
        correlationId,
        detalhe: {
          erro: error.message,
          cStat: cStatErro,
          xMotivo: error?.xMotivo || null,
          rejeicaoSefaz: error?.rejeicaoSefaz === true
        }
      });
      return { ...base, falha: true, cStat: cStatErro, mensagem: error.message };
    } finally {
      liberarLockDocumentoSefaz(id);
    }

    const atualizado = await this._documentosRepository.buscarPorId(id);
    const statusNovo = normalizarStatus(atualizado?.status);
    const tipo = atualizado?.tipoDocumento || atualizado?.tipo_documento;
    const xmlCompleto = statusNovo === DocumentoFiscalStatus.XML_COMPLETO
      || tipo === DocumentoDfeTipo.PROC_NFE
      || tipo === DocumentoDfeTipo.NFE;

    this._atualizarEstadoDoc(id, {
      tentativas: (this._estado.docs[String(id)]?.tentativas || 0) + 1,
      ultimaConsulta: this._agora().toISOString(),
      ultimoRetorno: xmlCompleto
        ? 'PROC_NFE'
        : (resultadoConsulta?.cStat || resultadoConsulta?.mensagem || 'SEM_PROC'),
      motivo: xmlCompleto ? 'XML recuperado automaticamente' : 'procNFe ainda indisponível',
      correlationId
    });

    if (!xmlCompleto) {
      await this._historicoRepository.inserir({
        documentoId: id,
        statusAnterior: doc.status,
        statusNovo: doc.status,
        detalhe: [
          'RC3.7.5 — Consulta automática sem procNFe.',
          `Origem: DistDFe consChNFe`,
          `Correlation: ${correlationId}`,
          `cStat: ${resultadoConsulta?.cStat || '—'}`,
          `NSU doc: ${doc.nsu || '—'}`
        ].join('\n')
      });
      return {
        ...base,
        mensagem: 'procNFe ainda indisponível na SEFAZ',
        cStat: resultadoConsulta?.cStat || null
      };
    }

    await this._historicoRepository.inserir({
      documentoId: id,
      statusAnterior: doc.status,
      statusNovo: DocumentoFiscalStatus.XML_COMPLETO,
      detalhe: [
        'XML recuperado automaticamente.',
        'Origem: DistDFe (consChNFe)',
        `Data/Hora: ${this._agora().toISOString()}`,
        `Correlation ID: ${correlationId}`,
        `NSU: ${atualizado.nsu || doc.nsu || '—'}`,
        `cStat consulta: ${resultadoConsulta?.cStat || '—'}`
      ].join('\n')
    });

    await this._emitirEvento({
      tipo: TIPOS_EVENTO.RECUPERACAO_XML_RECUPERADO,
      documentoId: id,
      descricao: `procNFe encontrado — documento #${id} atualizado automaticamente`,
      sucesso: true,
      resultado: 'XML_COMPLETO',
      correlationId,
      detalhe: {
        chave: doc.chave,
        nsu: atualizado.nsu || doc.nsu,
        origem: 'DistDFe',
        statusAnterior: doc.status,
        statusNovo: DocumentoFiscalStatus.XML_COMPLETO
      }
    });

    // Parser + revisão (XML_COMPLETO → EM_REVISAO / PRONTA)
    let statusFinal = DocumentoFiscalStatus.XML_COMPLETO;
    try {
      const proc = await this._processarDocumento(id, {
        usuarioId: null,
        origem: ORIGEM_MOTOR,
        correlationId
      });
      const docPos = await this._documentosRepository.buscarPorId(id);
      statusFinal = normalizarStatus(docPos?.status) || statusFinal;
      if (statusFinal === DocumentoFiscalStatus.XML_COMPLETO) {
        // Fallback: garante EM_REVISAO se pipeline não avançou
        await this._transitionService.transicionar(
          id,
          DocumentoFiscalStatus.XML_COMPLETO,
          DocumentoFiscalStatus.EM_REVISAO,
          {
            detalhe: 'RC3.7.5 — Liberado automaticamente para revisão após recuperação do XML.',
            origem: ORIGEM_MOTOR
          }
        );
        statusFinal = DocumentoFiscalStatus.EM_REVISAO;
      }
      void proc;
    } catch (procErr) {
      try {
        const docPos = await this._documentosRepository.buscarPorId(id);
        const st = normalizarStatus(docPos?.status);
        if (st === DocumentoFiscalStatus.XML_COMPLETO) {
          await this._transitionService.transicionar(
            id,
            DocumentoFiscalStatus.XML_COMPLETO,
            DocumentoFiscalStatus.EM_REVISAO,
            {
              detalhe: `RC3.7.5 — Liberado para revisão (parser: ${procErr.message}).`,
              origem: ORIGEM_MOTOR
            }
          );
          statusFinal = DocumentoFiscalStatus.EM_REVISAO;
        }
      } catch { /* ignore */ }
    }

    delete this._estado.docs[String(id)];
    this._estado.metricas.removidos += 1;

    await this._emitirEvento({
      tipo: TIPOS_EVENTO.RECUPERACAO_XML_REMOVIDO,
      documentoId: id,
      descricao: `Documento #${id} removido da fila — XML recuperado`,
      sucesso: true,
      correlationId,
      detalhe: { motivo: 'recuperado', statusFinal }
    });

    return {
      ...base,
      recuperado: true,
      statusFinal,
      mensagem: 'XML recuperado e documento atualizado',
      cStat: resultadoConsulta?.cStat || null
    };
  }

  /**
   * @private
   */
  async _removerDaFila(item, motivo, correlationId, timeout) {
    const id = Number(item.id);
    delete this._estado.docs[String(id)];
    this._estado.metricas.removidos += 1;
    if (timeout) this._estado.metricas.timeouts += 1;

    await this._historicoRepository.inserir({
      documentoId: id,
      statusAnterior: item.status,
      statusNovo: item.status,
      detalhe: [
        timeout
          ? 'RC3.7.5 — Documento removido da fila (timeout/limite).'
          : 'RC3.7.5 — Documento removido da fila de recuperação.',
        `Motivo: ${motivo}`,
        `Correlation: ${correlationId}`
      ].join('\n')
    }).catch(() => {});

    await this._emitirEvento({
      tipo: timeout
        ? TIPOS_EVENTO.RECUPERACAO_XML_TIMEOUT
        : TIPOS_EVENTO.RECUPERACAO_XML_REMOVIDO,
      documentoId: id,
      descricao: `Documento #${id} removido da fila: ${motivo}`,
      sucesso: !timeout,
      correlationId,
      detalhe: { motivo, timeout: Boolean(timeout), chave: item.chave }
    });
  }

  /** @private */
  _atualizarEstadoDoc(id, patch) {
    const key = String(id);
    this._estado.docs[key] = {
      ...(this._estado.docs[key] || {}),
      ...patch
    };
  }

  /** @private */
  async _proximaConsultaDocumento(documentoId) {
    if (typeof this._eventosRepository?.listar !== 'function') return null;
    try {
      const eventos = await this._eventosRepository.listar({
        tipo: TIPOS_EVENTO.CONSULTA_DFE_POS_MANIFESTACAO,
        documentoId,
        limite: 1
      });
      const valor = eventos?.[0]?.detalhe?.proximaConsultaEm;
      if (!valor) return null;
      const data = new Date(valor);
      return Number.isNaN(data.getTime()) ? null : data;
    } catch {
      return null;
    }
  }

  /** @private */
  async _registrarConsultaPos596(documentoId, correlationId, retorno = {}) {
    const proximaConsultaEm = new Date(
      this._agora().getTime() + INTERVALO_SEGURO_MS
    ).toISOString();
    await this._emitirEvento({
      tipo: TIPOS_EVENTO.CONSULTA_DFE_POS_MANIFESTACAO,
      documentoId,
      descricao: 'Consulta por chave após ciência rejeitada por prazo (596) — recuperação XML',
      resultado: retorno.cStat || 'SEM_CSTAT',
      sucesso: true,
      correlationId,
      detalhe: {
        modo: 'consChNFe',
        origemDist: { cStat: '596', motivo: 'ciencia_210210_prazo' },
        cStat: retorno.cStat || null,
        xMotivo: retorno.xMotivo || null,
        aguardandoXml: true,
        proximaConsultaEm
      }
    });
  }

  /** @private */
  async _emitirEvento(dados) {
    try {
      await this._eventosRepository.inserir({
        tipo: dados.tipo,
        origem: ORIGENS.SISTEMA,
        descricao: dados.descricao,
        resultado: dados.resultado || null,
        sucesso: dados.sucesso !== false,
        documentoId: dados.documentoId || null,
        detalhe: {
          ...(dados.detalhe || {}),
          correlationId: dados.correlationId || null,
          motor: 'RC3.7.5'
        }
      });
    } catch {
      // Eventos não devem derrubar o ciclo
    }
  }

  /** @private */
  async _carregarEstado() {
    try {
      const reg = await this._configRepository.buscarPorChave(CHAVES.ESTADO);
      if (!reg) return;
      const parsed = this._configRepository.parseValor(reg);
      if (parsed && typeof parsed === 'object') {
        this._estado = {
          ...this._estadoVazio(),
          ...parsed,
          docs: parsed.docs && typeof parsed.docs === 'object' ? parsed.docs : {},
          metricas: {
            ...this._estadoVazio().metricas,
            ...(parsed.metricas || {})
          }
        };
      }
    } catch { /* ignore */ }
  }

  /** @private */
  async _persistirEstado() {
    try {
      await this._configRepository.salvar(CHAVES.ESTADO, this._estado, 'json');
    } catch (error) {
      logCentralErro('RECUPERACAO_XML', error, { Evento: 'PERSISTIR_ESTADO' });
    }
  }
}

let _singleton = null;

function obterMotorRecuperacaoXml(deps) {
  if (deps) return new MotorRecuperacaoXmlService(deps);
  if (!_singleton) _singleton = new MotorRecuperacaoXmlService();
  return _singleton;
}

module.exports = MotorRecuperacaoXmlService;
module.exports.obterMotorRecuperacaoXml = obterMotorRecuperacaoXml;
module.exports.ORIGEM_MOTOR = ORIGEM_MOTOR;
