/**
 * CentralProcessamentoService — Pipeline oficial: Parser + MIIP + status.
 *
 * RC1: transições via DocumentoTransitionService.
 *
 * @class CentralProcessamentoService
 */

const NFeParserService = require('../../../shared/nfe/NFeParserService');
const NFeParserError = require('../../../shared/nfe/errors/NFeParserError');
const { enriquecerParseComMiip } = require('../../../shared/nfe/enriquecerParseComMiip');
const { defaultDiagnostics } = require('../../miip/diagnostics/MiipOriginDiagnostics');
const { extrairPendencias } = require('../../miip/utils/miipCentralRevisaoUtils');
const ProcessamentoResultadoDTO = require('../contracts/ProcessamentoResultadoDTO');
const { DocumentoFiscalStatus, normalizarStatus } = require('../core/DocumentoFiscalStatus');
const { paraDocumentoDetalheDTO } = require('../utils/centralEntradasMapper');
const CentralDocumentosRepository = require('../repositories/CentralDocumentosRepository');
const CentralHistoricoService = require('./CentralHistoricoService');
const DocumentoTransitionService = require('./DocumentoTransitionService');

const ETAPAS_PIPELINE = Object.freeze([
  { codigo: 'localizar', label: 'Localizando documento' },
  { codigo: 'parse', label: 'Parser oficial NF-e' },
  { codigo: 'miip', label: 'Identificação MIIP' },
  { codigo: 'persistir', label: 'Persistindo resultados' },
  { codigo: 'status', label: 'Atualizando status' }
]);

const STATUS_PIPELINE_CONCLUIDO = Object.freeze([
  DocumentoFiscalStatus.EM_REVISAO,
  DocumentoFiscalStatus.PRONTA_IMPORTACAO,
  DocumentoFiscalStatus.EM_IMPORTACAO,
  DocumentoFiscalStatus.IMPORTADA,
  DocumentoFiscalStatus.FINALIZADA
]);

const locksProcessamento = new Map();

function parseValido(parseJson) {
  return parseJson != null && typeof parseJson === 'object' && !Array.isArray(parseJson);
}

function miipValido(resumo) {
  if (!resumo || typeof resumo !== 'object' || Array.isArray(resumo)) return false;
  return resumo.resumo != null
    || Array.isArray(resumo.resultados)
    || resumo.operacaoId != null;
}

function pipelineStatusConcluido(status) {
  return STATUS_PIPELINE_CONCLUIDO.includes(normalizarStatus(status));
}

function possuiPendenciasDoResumo(resumo) {
  if (!resumo || typeof resumo !== 'object') return false;
  return extrairPendencias(resumo.resultados || []).length > 0;
}

function montarMiipDePersistido(documento) {
  const bruto = documento.miipResumoJson;
  if (!miipValido(bruto)) return null;
  return {
    operacaoId: documento.miipSessaoId || bruto.operacaoId || null,
    resumo: bruto.resumo || null,
    resultados: Array.isArray(bruto.resultados) ? bruto.resultados : []
  };
}

function enfileirarPorDocumento(documentoId, fn) {
  const key = String(documentoId);
  const anterior = locksProcessamento.get(key) || Promise.resolve();
  const execucao = anterior.catch(() => {}).then(fn);
  locksProcessamento.set(key, execucao);
  return execucao.finally(() => {
    if (locksProcessamento.get(key) === execucao) {
      locksProcessamento.delete(key);
    }
  });
}

class CentralProcessamentoService {
  /**
   * @param {Object} [deps]
   */
  constructor(deps = {}) {
    /** @private */
    this._documentosRepository = deps.documentosRepository
      ?? new CentralDocumentosRepository();
    /** @private */
    this._historicoService = deps.historicoService
      ?? new CentralHistoricoService();
    /** @private */
    this._eventosRepository = deps.eventosRepository || null;
    /** @private */
    this._transitionService = deps.transitionService
      ?? new DocumentoTransitionService({
        documentosRepository: this._documentosRepository,
        historicoRepository: deps.historicoRepository
      });
    /** @private */
    this._parseXml = deps.parseXml || ((xml) => NFeParserService.parse(xml));
    /** @private */
    this._enriquecerParse = deps.enriquecerParse || enriquecerParseComMiip;
    /** @private */
    this._originDiagnostics = deps.originDiagnostics ?? defaultDiagnostics;
  }

  /**
   * @param {number|string} documentoId
   * @param {Object} [opcoes]
   * @returns {Promise<Object>}
   */
  async processar(documentoId, opcoes = {}) {
    return this._originDiagnostics.withContext(
      { documentoId },
      () => enfileirarPorDocumento(documentoId, () => this._processarInterno(documentoId, opcoes))
    );
  }

  /** @private */
  async _processarInterno(documentoId, opcoes = {}) {
    const etapasConcluidas = [];
    const etapasPuladas = [];
    let etapaAtual = ETAPAS_PIPELINE[0].codigo;
    let persistiuResultados = false;

    try {
      etapaAtual = 'localizar';
      const documento = await this._documentosRepository.buscarPorId(documentoId);

      if (!documento) {
        const erro = new Error('Documento não encontrado');
        erro.statusCode = 404;
        erro.code = 'DOCUMENTO_NAO_ENCONTRADO';
        throw erro;
      }

      const {
        exigirDocumentoDaEmpresa,
        resolverEmpresaParaCentral
      } = require('../../../services/central-entradas/CentralEntradasEmpresaContextoService');

      let empresaId = Number(opcoes.empresaId ?? opcoes.empresaIdContexto);
      if (!Number.isInteger(empresaId) || empresaId <= 0) {
        if (opcoes.req) {
          const ctx = await resolverEmpresaParaCentral({
            req: opcoes.req,
            empresaId: opcoes.req.empresaId
          }, opcoes);
          empresaId = ctx.empresaId;
        }
      }
      if (!Number.isInteger(empresaId) || empresaId <= 0) {
        const erro = new Error(
          'Modo MULTIEMPRESA exige empresa explícita para processar o documento.'
        );
        erro.code = 'EMPRESA_CENTRAL_AUSENTE';
        erro.statusCode = 400;
        throw erro;
      }

      await exigirDocumentoDaEmpresa(
        { documento, documentoId, empresaId },
        { documentosRepository: this._documentosRepository }
      );

      const statusCanonico = normalizarStatus(documento.status);
      const forcar = opcoes.forcarReprocessamento === true;
      const temParse = parseValido(documento.parseJson);
      const temMiip = miipValido(documento.miipResumoJson);

      if (!forcar && temParse && pipelineStatusConcluido(statusCanonico)) {
        const operacaoId = documento.miipSessaoId || documento.miipResumoJson?.operacaoId || null;
        this._originDiagnostics.setOperationId(operacaoId);
        this._originDiagnostics.recordImport({
          documentoId,
          operacaoId,
          resultOrigin: 'persistido_reutilizado',
          importResult: documento.miipResumoJson
        });
        const atualizado = await this._documentosRepository.buscarPorId(documentoId);
        return ProcessamentoResultadoDTO.create({
          sucesso: true,
          reutilizado: true,
          recuperado: false,
          documento: paraDocumentoDetalheDTO(atualizado),
          parse: documento.parseJson,
          miipImportacao: documento.miipResumoJson,
          possuiPendencias: statusCanonico === DocumentoFiscalStatus.EM_REVISAO,
          proximaAcao: statusCanonico === DocumentoFiscalStatus.EM_REVISAO
            ? 'revisar_produtos'
            : 'abrir_compra',
          etapaAtual: 'concluido',
          etapas: ETAPAS_PIPELINE.map((e) => ({ ...e, concluida: true })),
          etapasPuladas: ETAPAS_PIPELINE.map((e) => e.codigo),
          mensagem: 'Processamento já existente — resultado reutilizado'
        }).toJSON();
      }

      if (!documento.xml && !temParse) {
        const erro = new Error('XML não disponível para processamento');
        erro.statusCode = 400;
        throw erro;
      }

      const statusInicial = documento.status;
      if (statusCanonico !== DocumentoFiscalStatus.XML_COMPLETO && !forcar) {
        const erro = new Error(`Documento não pode ser processado no status ${statusInicial}`);
        erro.statusCode = 400;
        throw erro;
      }

      etapasConcluidas.push('localizar');

      await this._transitionService.transicionar(
        documentoId,
        statusInicial,
        DocumentoFiscalStatus.EM_PROCESSAMENTO,
        {
          detalhe: temParse
            ? 'Retomada segura do pipeline de processamento incompleto'
            : 'Início do pipeline oficial de processamento',
          usuarioId: opcoes.usuarioId
        }
      );

      const pularParse = temParse && !forcar;
      const pularMiip = pularParse && temMiip && !forcar;

      let parsed = documento.parseJson;
      if (pularParse) {
        etapasPuladas.push('parse');
        etapasConcluidas.push('parse');
      } else {
        etapaAtual = 'parse';
        const inicioParser = Date.now();
        parsed = await this._parseXml(documento.xml);
        etapasConcluidas.push('parse');
        await this._registrarEtapaObservabilidade({
          documentoId,
          tipo: 'PARSER_CONCLUIDO',
          descricao: 'Parser NF-e concluído.',
          duracaoMs: Date.now() - inicioParser,
          usuarioId: opcoes.usuarioId
        });
      }

      let miipImportacao = montarMiipDePersistido(documento);
      let possuiPendencias = possuiPendenciasDoResumo(documento.miipResumoJson);
      let erroMiip = null;

      if (pularMiip) {
        etapasPuladas.push('miip');
        etapasConcluidas.push('miip');
      } else {
        etapaAtual = 'miip';
        const inicioMiip = Date.now();
        const enriquecido = await this._enriquecerParse(parsed);
        parsed = enriquecido.parsed || parsed;
        miipImportacao = enriquecido.miipImportacao;
        possuiPendencias = Boolean(enriquecido.possuiPendencias);
        erroMiip = enriquecido.erroMiip || null;
        etapasConcluidas.push('miip');
        await this._registrarEtapaObservabilidade({
          documentoId,
          tipo: 'MIIP_CONCLUIDO',
          descricao: erroMiip
            ? `MIIP concluído com indisponibilidade: ${erroMiip}`
            : 'MIIP concluído.',
          duracaoMs: Date.now() - inicioMiip,
          usuarioId: opcoes.usuarioId,
          sucesso: !erroMiip,
          detalhe: {
            operacaoId: miipImportacao?.operacaoId || null,
            possuiPendencias: Boolean(possuiPendencias),
            erro: erroMiip || null
          }
        });
      }

      const operacaoId = miipImportacao?.operacaoId || null;
      const origemMiip = pularMiip
        ? 'persistido_reutilizado'
        : (miipImportacao && !erroMiip ? 'novo_processamento' : 'desconhecida');
      this._originDiagnostics.setOperationId(operacaoId);
      this._originDiagnostics.recordImport({
        documentoId,
        operacaoId,
        resultOrigin: origemMiip,
        importResult: miipImportacao
      });

      etapaAtual = 'persistir';
      const miipResumo = miipImportacao
        ? {
          operacaoId: miipImportacao.operacaoId,
          resumo: miipImportacao.resumo,
          resultados: miipImportacao.resultados
        }
        : null;

      if (!pularParse || !pularMiip) {
        await this._documentosRepository.atualizar(documentoId, {
          parseJson: parsed,
          miipSessaoId: miipImportacao?.operacaoId ?? null,
          miipResumoJson: miipResumo,
          processadoEm: new Date().toISOString()
        });
      } else {
        etapasPuladas.push('persistir');
      }
      persistiuResultados = true;
      etapasConcluidas.push('persistir');

      etapaAtual = 'status';
      const relido = await this._documentosRepository.buscarPorId(documentoId);
      if (relido && pipelineStatusConcluido(relido.status)) {
        etapasConcluidas.push('status');
        return ProcessamentoResultadoDTO.create({
          sucesso: true,
          reutilizado: true,
          recuperado: etapasPuladas.length > 0,
          documento: paraDocumentoDetalheDTO(relido),
          parse: parsed,
          miipImportacao,
          possuiPendencias: normalizarStatus(relido.status) === DocumentoFiscalStatus.EM_REVISAO,
          proximaAcao: normalizarStatus(relido.status) === DocumentoFiscalStatus.EM_REVISAO
            ? 'revisar_produtos'
            : 'abrir_compra',
          etapaAtual: 'concluido',
          etapas: ETAPAS_PIPELINE.map((e) => ({
            ...e,
            concluida: true
          })),
          etapasPuladas,
          mensagem: 'Processamento já existente — resultado reutilizado'
        }).toJSON();
      }

      const statusNovo = possuiPendencias
        ? DocumentoFiscalStatus.AGUARDANDO_REVISAO
        : DocumentoFiscalStatus.PRONTA_PARA_COMPRA;

      const detalheStatus = possuiPendencias
        ? 'MIIP identificou pendências — aguardando Central de Revisão'
        : 'Todos os itens identificados — pronto para Compras';

      if (erroMiip) {
        await this._historicoService.registrar({
          documentoId,
          statusAnterior: DocumentoFiscalStatus.EM_PROCESSAMENTO,
          statusNovo: DocumentoFiscalStatus.EM_PROCESSAMENTO,
          usuarioId: opcoes.usuarioId ?? null,
          detalhe: `MIIP indisponível: ${erroMiip}`
        });
      }

      await this._transitionService.transicionar(
        documentoId,
        DocumentoFiscalStatus.EM_PROCESSAMENTO,
        statusNovo,
        { detalhe: detalheStatus, usuarioId: opcoes.usuarioId }
      );
      etapasConcluidas.push('status');

      const atualizado = await this._documentosRepository.buscarPorId(documentoId);
      const recuperado = etapasPuladas.length > 0;

      const { emitirDocumentoProcessado } = require('../utils/centralEventosEmitter');
      emitirDocumentoProcessado(atualizado, {
        sucesso: true,
        mensagem: possuiPendencias
          ? 'Processamento concluído com pendências MIIP'
          : 'Processamento concluído',
        origem: recuperado ? 'recuperacao' : 'api'
      }).catch(() => {});

      return ProcessamentoResultadoDTO.create({
        sucesso: true,
        reutilizado: false,
        recuperado,
        documento: paraDocumentoDetalheDTO(atualizado),
        parse: parsed,
        miipImportacao,
        possuiPendencias,
        proximaAcao: possuiPendencias ? 'revisar_produtos' : 'abrir_compra',
        etapaAtual: 'concluido',
        etapas: ETAPAS_PIPELINE.map((e) => ({
          ...e,
          concluida: etapasConcluidas.includes(e.codigo)
        })),
        etapasPuladas,
        mensagem: recuperado
          ? (possuiPendencias
            ? 'Recuperação segura: etapas pendentes concluídas com pendências MIIP'
            : 'Recuperação segura: etapas pendentes concluídas — pronto para Compras')
          : (possuiPendencias
            ? 'Processamento concluído com pendências MIIP'
            : 'Processamento concluído — pronto para Compras')
      }).toJSON();
    } catch (error) {
      const code = error && error.code;
      if (
        error.statusCode === 404
        || error.statusCode === 409
        || code === 'EMPRESA_CENTRAL_AUSENTE'
        || code === 'EMPRESA_DOCUMENTO_NAO_RESOLVIDA'
        || code === 'DOCUMENTO_NAO_ENCONTRADO'
        || code === 'OPERACAO_EMPRESA_DIVERGENTE'
      ) {
        throw error;
      }

      const mensagemOriginal = String(error && error.message ? error.message : error);
      try {
        await this._historicoService.registrar({
          documentoId,
          statusAnterior: DocumentoFiscalStatus.EM_PROCESSAMENTO,
          statusNovo: DocumentoFiscalStatus.EM_PROCESSAMENTO,
          usuarioId: opcoes.usuarioId ?? null,
          detalhe: `Falha original no pipeline (${etapaAtual}): ${mensagemOriginal}`
        });
      } catch {
        // não mascarar a exceção original
      }

      const parserInvalido = error instanceof NFeParserError
        || (error.statusCode === 400 && etapaAtual === 'parse');
      if (parserInvalido && !persistiuResultados) {
        try {
          const doc = await this._documentosRepository.buscarPorId(documentoId);
          if (normalizarStatus(doc?.status) === DocumentoFiscalStatus.XML_COMPLETO) {
            await this._transitionService.transicionar(
              documentoId,
              DocumentoFiscalStatus.EM_PROCESSAMENTO,
              DocumentoFiscalStatus.ERRO,
              { detalhe: mensagemOriginal, usuarioId: opcoes.usuarioId }
            );
          }
        } catch {
          // ignora falha ao registrar ERRO
        }
      }

      return ProcessamentoResultadoDTO.create({
        sucesso: false,
        recuperado: false,
        etapaAtual,
        etapas: ETAPAS_PIPELINE.map((e) => ({
          ...e,
          concluida: etapasConcluidas.includes(e.codigo)
        })),
        etapasPuladas,
        mensagem: mensagemOriginal,
        erros: [mensagemOriginal]
      }).toJSON();
    }
  }

  /** @private */
  async _registrarEtapaObservabilidade(dados) {
    const { emitirEvento, ORIGENS } = require('../utils/centralEventosEmitter');
    const CentralEventosRepository = require('../repositories/CentralEventosRepository');
    const eventosRepo = this._eventosRepository
      ?? new CentralEventosRepository();

    const unico = await eventosRepo.inserirUnico({
      tipo: dados.tipo,
      origem: ORIGENS.SISTEMA,
      descricao: dados.descricao,
      resultado: dados.sucesso === false ? 'erro' : 'sucesso',
      sucesso: dados.sucesso !== false,
      documentoId: dados.documentoId,
      duracaoMs: dados.duracaoMs,
      detalhe: {
        ...(dados.detalhe || {}),
        usuarioId: dados.usuarioId ?? null
      }
    });

    if (!unico.criado) {
      return;
    }

    await this._historicoService.registrar({
      documentoId: dados.documentoId,
      statusAnterior: DocumentoFiscalStatus.EM_PROCESSAMENTO,
      statusNovo: DocumentoFiscalStatus.EM_PROCESSAMENTO,
      usuarioId: dados.usuarioId ?? null,
      detalhe: dados.descricao
    });
  }
}

module.exports = CentralProcessamentoService;
