/**
 * CentralComprasBridgeService — Ponte entre Central de Entradas e Compras.
 *
 * RC1: transições via DocumentoTransitionService; reutiliza parse/MIIP persistido.
 *
 * @class CentralComprasBridgeService
 */

const { DocumentoFiscalStatus } = require('../core/DocumentoFiscalStatus');
const { validarTransicao } = require('../core/MaquinaEstadosDocumento');
const { paraDocumentoDetalheDTO } = require('../utils/centralEntradasMapper');
const CentralDocumentosRepository = require('../repositories/CentralDocumentosRepository');
const DocumentoTransitionService = require('./DocumentoTransitionService');
const { financeiroPayloadCompleto } = require('./centralComprasFinanceiroBridge');

class CentralComprasBridgeService {
  /**
   * @param {Object} [deps]
   */
  constructor(deps = {}) {
    /** @private */
    this._documentosRepository = deps.documentosRepository
      ?? new CentralDocumentosRepository();
    /** @private */
    this._transitionService = deps.transitionService
      ?? new DocumentoTransitionService({
        documentosRepository: this._documentosRepository,
        historicoRepository: deps.historicoRepository
      });
  }

  /**
   * @private
   * @param {Object} documento
   * @returns {Object}
   */
  _obterPayloadParsePersistido(documento) {
    if (!documento.parseJson) {
      const erro = new Error(
        'Documento ainda não processado. O pipeline Parser + MIIP deve ser concluído antes de abrir Compras.'
      );
      erro.statusCode = 400;
      throw erro;
    }

    // RC8.4.0 — deep clone para isolar itens (evita referências compartilhadas)
    try {
      if (typeof structuredClone === 'function') {
        return structuredClone(documento.parseJson);
      }
    } catch {
      /* fallback */
    }
    return JSON.parse(JSON.stringify(documento.parseJson));
  }

  /**
   * RC COMPRAS 5.4.1 — completa financeiro a partir do XML se parse antigo não tiver.
   * Não reprocessa MIIP/itens; só enriquece pag/cobr/IPI.
   * @private
   */
  async _enriquecerFinanceiroDoXml(payload, xml) {
    if (!xml || typeof xml !== 'string') return payload;

    if (financeiroPayloadCompleto(payload)) return payload;

    try {
      const NFeParserService = require('../../../shared/nfe/NFeParserService');
      const json = await NFeParserService.parse(xml);
      const parcelasXml = Array.isArray(json.parcelas_detalhe) ? json.parcelas_detalhe : [];
      const duplicatasXml = Array.isArray(json.duplicatas) ? json.duplicatas : [];
      const gradeAtual = Array.isArray(payload.parcelas_detalhe) ? payload.parcelas_detalhe : [];
      const gradeComVencimento = gradeAtual.length > 0
        && gradeAtual.every((p) => String(p?.vencimento || p?.dVenc || '').trim().length >= 10);

      return {
        ...payload,
        valor_ipi: payload.valor_ipi ?? json.valor_ipi ?? 0,
        valor_seguro: payload.valor_seguro ?? json.valor_seguro ?? 0,
        forma_pagamento: payload.forma_pagamento || json.forma_pagamento || null,
        condicao_pagamento: payload.condicao_pagamento || json.condicao_pagamento || null,
        pagamentos: (payload.pagamentos && payload.pagamentos.length)
          ? payload.pagamentos
          : (json.pagamentos || []),
        duplicatas: (payload.duplicatas && payload.duplicatas.length)
          ? payload.duplicatas
          : duplicatasXml,
        parcelas_detalhe: gradeComVencimento
          ? gradeAtual
          : (parcelasXml.length ? parcelasXml : gradeAtual),
        parcelas: parcelasXml.length
          ? parcelasXml.length
          : (payload.parcelas || json.parcelas || 1),
        data_vencimento: payload.data_vencimento
          || json.data_vencimento
          || parcelasXml[0]?.vencimento
          || null,
        valor_total_nota: payload.valor_total_nota || json.valor_total_nota
      };
    } catch {
      return payload;
    }
  }

  /**
   * @param {number|string} documentoId
   * @returns {Promise<Object>}
   */
  async _autorizarDocumentoSeContexto(documento, documentoId, opcoes = {}) {
    if (opcoes.empresaIdContexto == null && !opcoes.req) {
      return documento;
    }
    const {
      exigirDocumentoDaEmpresa,
      resolverEmpresaParaCentral
    } = require('../../../services/central-entradas/CentralEntradasEmpresaContextoService');
    let empresaId = opcoes.empresaIdContexto;
    if (empresaId == null && opcoes.req) {
      const ctx = await resolverEmpresaParaCentral({
        req: opcoes.req,
        empresaId: opcoes.req.empresaId
      }, opcoes);
      empresaId = ctx.empresaId;
    }
    const r = await exigirDocumentoDaEmpresa(
      { documento, documentoId, empresaId },
      { documentosRepository: this._documentosRepository }
    );
    return r.documento;
  }

  async _empresaIdPersistidaDaCompra(compraId) {
    try {
      const sql = this._documentosRepository._obterSql();
      await sql.whenReady();
      const row = await sql.get(
        'SELECT empresa_id FROM compras WHERE id = ?',
        [Number(compraId)]
      );
      if (row && row.empresa_id != null) {
        const n = Number(row.empresa_id);
        return Number.isInteger(n) && n > 0 ? n : null;
      }
    } catch { /* compras ausente em teste isolado */ }
    return null;
  }

  async montarPayloadAbrirCompra(documentoId, opcoes = {}) {
    const documentoBruto = await this._documentosRepository.buscarPorId(documentoId);
    if (!documentoBruto) {
      const erro = new Error('Documento não encontrado');
      erro.statusCode = 404;
      erro.code = 'DOCUMENTO_NAO_ENCONTRADO';
      throw erro;
    }
    const documento = await this._autorizarDocumentoSeContexto(documentoBruto, documentoId, opcoes);
    const {
      exigirEmpresaIdDoDocumento
    } = require('../../../services/central-entradas/CentralEntradasEmpresaContextoService');
    const empresaDocumentoId = exigirEmpresaIdDoDocumento(documento);

    let payload = this._obterPayloadParsePersistido(documento);
    payload = await this._enriquecerFinanceiroDoXml(payload, documento.xml);

    return {
      sucesso: true,
      documentoId: documento.id,
      chave: documento.chave,
      status: documento.status,
      empresaId: empresaDocumentoId,
      dadosCompra: {
        ...payload,
        xml: documento.xml || null,
        natureza_operacao: payload.natureza_operacao || payload.natureza || null,
        cfop: payload.cfop || null,
        empresa_id: empresaDocumentoId,
        empresaId: empresaDocumentoId
      }
    };
  }

  /**
   * @param {number|string} documentoId
   * @param {Object} [opcoes]
   * @returns {Promise<Object>}
   */
  async registrarAberturaCompra(documentoId, opcoes = {}) {
    const documentoBruto = await this._documentosRepository.buscarPorId(documentoId);
    if (!documentoBruto) {
      const erro = new Error('Documento não encontrado');
      erro.statusCode = 404;
      erro.code = 'DOCUMENTO_NAO_ENCONTRADO';
      throw erro;
    }
    const documento = await this._autorizarDocumentoSeContexto(documentoBruto, documentoId, opcoes);
    const {
      exigirEmpresaIdDoDocumento,
      exigirDocumentoCompraMesmaEmpresa
    } = require('../../../services/central-entradas/CentralEntradasEmpresaContextoService');
    exigirEmpresaIdDoDocumento(documento);

    const compraJaVinculada = documento.compraId != null ? Number(documento.compraId) : null;
    if (Number.isInteger(compraJaVinculada) && compraJaVinculada > 0) {
      const compraEmpresaId = await this._empresaIdPersistidaDaCompra(compraJaVinculada);
      exigirDocumentoCompraMesmaEmpresa(exigirEmpresaIdDoDocumento(documento), compraEmpresaId);
    }

    const statusPermitidos = [
      DocumentoFiscalStatus.PRONTA_PARA_COMPRA,
      DocumentoFiscalStatus.REVISADA,
      DocumentoFiscalStatus.EM_COMPRA
    ];

    if (!statusPermitidos.includes(documento.status)) {
      const erro = new Error(`Documento não está pronto para Compras (status: ${documento.status})`);
      erro.statusCode = 400;
      throw erro;
    }

    if (documento.status !== DocumentoFiscalStatus.EM_COMPRA) {
      await this._transitionService.transicionar(
        documentoId,
        documento.status,
        DocumentoFiscalStatus.EM_COMPRA,
        {
          detalhe: 'Compra aberta na tela de Compras',
          usuarioId: opcoes.usuarioId
        }
      );
    }

    const payload = await this.montarPayloadAbrirCompra(documentoId, opcoes);
    const atualizado = await this._documentosRepository.buscarPorId(documentoId);

    return {
      ...payload,
      documento: paraDocumentoDetalheDTO(atualizado)
    };
  }

  /**
   * @param {number|string} documentoId
   * @param {Object} dados
   * @returns {Promise<Object>}
   */
  async concluirRevisao(documentoId, dados = {}) {
    const documentoBruto = await this._documentosRepository.buscarPorId(documentoId);
    if (!documentoBruto) {
      const erro = new Error('Documento não encontrado');
      erro.statusCode = 404;
      erro.code = 'DOCUMENTO_NAO_ENCONTRADO';
      throw erro;
    }
    const documento = await this._autorizarDocumentoSeContexto(documentoBruto, documentoId, dados);

    if (documento.status !== DocumentoFiscalStatus.AGUARDANDO_REVISAO) {
      const erro = new Error(`Revisão só pode ser concluída em AGUARDANDO_REVISAO (atual: ${documento.status})`);
      erro.statusCode = 400;
      throw erro;
    }

    const parseAtual = documento.parseJson || {};
    const itensAtualizados = Array.isArray(dados.itens) ? dados.itens : parseAtual.itens;

    const parseAtualizado = {
      ...parseAtual,
      itens: itensAtualizados
    };

    await this._documentosRepository.atualizar(documentoId, {
      parseJson: parseAtualizado,
      processadoEm: new Date().toISOString()
    });

    await this._transitionService.transicionar(
      documentoId,
      DocumentoFiscalStatus.AGUARDANDO_REVISAO,
      DocumentoFiscalStatus.REVISADA,
      {
        detalhe: 'Central de Revisão MIIP concluída',
        usuarioId: dados.usuarioId
      }
    );

    await this._transitionService.transicionar(
      documentoId,
      DocumentoFiscalStatus.REVISADA,
      DocumentoFiscalStatus.PRONTA_PARA_COMPRA,
      {
        detalhe: 'Documento liberado para Compras',
        usuarioId: dados.usuarioId
      }
    );

    const atualizado = await this._documentosRepository.buscarPorId(documentoId);

    return {
      sucesso: true,
      documento: paraDocumentoDetalheDTO(atualizado),
      parse: parseAtualizado,
      proximaAcao: 'abrir_compra'
    };
  }

  /**
   * @param {number|string} documentoId
   * @param {number|string} compraId
   * @param {Object} [opcoes]
   * @returns {Promise<Object>}
   */
  async vincularCompra(documentoId, compraId, opcoes = {}) {
    const documentoBruto = await this._documentosRepository.buscarPorId(documentoId);
    if (!documentoBruto) {
      const erro = new Error('Documento não encontrado');
      erro.statusCode = 404;
      erro.code = 'DOCUMENTO_NAO_ENCONTRADO';
      throw erro;
    }
    const documento = await this._autorizarDocumentoSeContexto(documentoBruto, documentoId, opcoes);

    const {
      exigirDocumentoCompraMesmaEmpresa,
      erroCentralEmpresa,
      empresaIdDoDocumento
    } = require('../../../services/central-entradas/CentralEntradasEmpresaContextoService');

    const docEmpresaId = empresaIdDoDocumento(documento);
    if (docEmpresaId == null) {
      throw erroCentralEmpresa(
        'EMPRESA_DOCUMENTO_NAO_RESOLVIDA',
        'Documento sem empresa_id — vínculo com compra bloqueado.',
        409
      );
    }

    const compraEmpresaId = await this._empresaIdPersistidaDaCompra(compraId);
    exigirDocumentoCompraMesmaEmpresa(docEmpresaId, compraEmpresaId);

    const jaVinculado = documento.compraId != null ? Number(documento.compraId) : null;
    if (Number.isInteger(jaVinculado) && jaVinculado > 0 && jaVinculado !== Number(compraId)) {
      throw erroCentralEmpresa(
        'OPERACAO_EMPRESA_DIVERGENTE',
        'Documento já vinculado a outra compra. Vínculo empresarial inconsistente bloqueado.',
        409
      );
    }

    const statusAtual = documento.status;
    const statusDestino = DocumentoFiscalStatus.GRAVADA;

    if (statusAtual !== DocumentoFiscalStatus.EM_COMPRA && statusAtual !== DocumentoFiscalStatus.PRONTA_PARA_COMPRA) {
      const validacao = validarTransicao(statusAtual, statusDestino);
      if (!validacao.valido) {
        const erro = new Error(validacao.erro);
        erro.statusCode = 400;
        throw erro;
      }
    }

    if (statusAtual === DocumentoFiscalStatus.PRONTA_PARA_COMPRA) {
      await this._transitionService.transicionar(documentoId, statusAtual, DocumentoFiscalStatus.EM_COMPRA, {
        detalhe: 'Vínculo com compra gravada',
        usuarioId: opcoes.usuarioId
      });
    }

    await this._documentosRepository.atualizar(documentoId, {
      compraId: Number(compraId),
      processadoEm: new Date().toISOString()
    });

    await this._transitionService.transicionar(
      documentoId,
      DocumentoFiscalStatus.EM_COMPRA,
      DocumentoFiscalStatus.GRAVADA,
      {
        detalhe: `Compra #${compraId} gravada via saveCompra()`,
        usuarioId: opcoes.usuarioId
      }
    );

    const atualizado = await this._documentosRepository.buscarPorId(documentoId);

    const { emitirCompraGravada } = require('../utils/centralEventosEmitter');
    emitirCompraGravada(atualizado, compraId).catch(() => {});

    return {
      sucesso: true,
      documento: paraDocumentoDetalheDTO(atualizado),
      compraId: Number(compraId)
    };
  }
}

module.exports = CentralComprasBridgeService;
