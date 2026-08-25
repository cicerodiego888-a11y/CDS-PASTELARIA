/**
 * Resolução de empresa operacional para Compras (Sprint 05.38.F.B).
 * Adaptador fino — não é motor de compras.
 * Fonte: ContratoOperacionalService + documento Central + contexto HTTP.
 *
 * @module services/compras/ComprasEmpresaContextoService
 */
'use strict';

const {
  ModoOperacionalGlobal,
  ContratoOperacionalService,
  erroModoGlobal
} = require('../../core/modo-operacional');
const {
  resolverEmpresaId,
  resolverEmpresaIdDaRequisicao,
  validarEmpresaId
} = require('../fiscalNaoFiscal/empresaContexto');

function erroCompraEmpresa(code, message, statusCode = 400, extra = {}) {
  const err = erroModoGlobal(code, message);
  err.statusCode = statusCode;
  Object.assign(err, extra);
  return err;
}

function statusDeErroCompraEmpresa(err) {
  if (!err) return 500;
  if (err.statusCode) return err.statusCode;
  if (err.status) return err.status;
  const code = err.code || '';
  if (code === 'EMPRESA_NAO_ENCONTRADA') return 404;
  if (
    code === 'COMPRA_EMPRESA_INCOMPATIVEL'
    || code === 'EMPRESA_COMPRA_INCOMPATIVEL'
    || code === 'DOCUMENTO_EMPRESA_INCOMPATIVEL'
    || code === 'FINANCEIRO_EMPRESA_DIVERGENTE'
  ) {
    return 403;
  }
  if (
    code === 'EMPRESA_INATIVA'
    || code === 'EMPRESA_COMPRA_AUSENTE'
    || code === 'EMPRESA_COMPRA_NAO_RESOLVIDA'
    || code === 'EMPRESA_OPERACIONAL_AUSENTE'
    || code === 'EMPRESA_OPERACIONAL_AMBIGUA'
    || code === 'EMPRESA_OPERACIONAL_INVALIDA'
    || code === 'EMPRESA_OBRIGATORIA'
    || code === 'EMPRESA_CENTRAL_INATIVA'
  ) {
    return 400;
  }
  return 500;
}

async function carregarDocumentoCentral(centralDocumentoId, deps = {}) {
  const id = Number(centralDocumentoId);
  if (!Number.isInteger(id) || id <= 0) return null;
  if (typeof deps.buscarDocumentoCentral === 'function') {
    return deps.buscarDocumentoCentral(id);
  }
  const CentralDocumentosRepository = deps.CentralDocumentosRepository
    || require('../../motores/central-entradas/repositories/CentralDocumentosRepository');
  const repo = new CentralDocumentosRepository({ db: deps.db || null });
  return repo.buscarPorId(id);
}

/**
 * Resolve empresa_id único para criação de compra (antes do BEGIN).
 *
 * Prioridade:
 * 1. Documento Central
 * 2. Contexto HTTP (req.empresaId / X-Empresa-Id)
 * 3. Body explícito (validação cruzada)
 * 4. Contrato EMPRESA_SIMPLES
 *
 * @param {object} req
 * @param {object} [opts]
 * @param {number|string|null} [opts.centralDocumentoId]
 * @param {number|string|null} [opts.empresaIdBody]
 * @param {object} [deps]
 */
async function resolverEmpresaDaCompra(req, opts = {}, deps = {}) {
  const contrato = deps.contrato
    || await ContratoOperacionalService.montarContratoOperacional(deps);
  const modo = contrato.modo_operacional;
  const db = deps.db || (req && req.db) || null;

  const httpId = resolverEmpresaId(req && req.empresaId)
    ?? resolverEmpresaIdDaRequisicao(req);
  const bodyId = resolverEmpresaId(opts.empresaIdBody)
    ?? resolverEmpresaId(opts.empresa_id)
    ?? resolverEmpresaId(opts);

  let documentoEmpresaId = null;
  let documento = null;
  const centralDocumentoId = opts.centralDocumentoId != null
    ? opts.centralDocumentoId
    : (opts.central_documento_id != null ? opts.central_documento_id : null);

  if (centralDocumentoId != null && String(centralDocumentoId).trim() !== '') {
    documento = await carregarDocumentoCentral(centralDocumentoId, { db, ...deps });
    if (!documento) {
      throw erroCompraEmpresa(
        'DOCUMENTO_CENTRAL_AUSENTE',
        `Documento Central ${centralDocumentoId} não encontrado.`,
        404,
        { central_documento_id: centralDocumentoId }
      );
    }
    documentoEmpresaId = documento.empresaId != null
      ? Number(documento.empresaId)
      : (documento.empresa_id != null ? Number(documento.empresa_id) : null);

    if (!Number.isInteger(documentoEmpresaId) || documentoEmpresaId <= 0) {
      if (modo === ModoOperacionalGlobal.MULTIEMPRESA) {
        throw erroCompraEmpresa(
          'EMPRESA_COMPRA_AUSENTE',
          'Documento Central sem empresa_id. Não é possível criar compra em MULTIEMPRESA.',
          400,
          { central_documento_id: Number(centralDocumentoId) }
        );
      }
      documentoEmpresaId = null;
    } else {
      await validarEmpresaId(documentoEmpresaId, { db, ...deps });
    }
  }

  if (documentoEmpresaId != null && httpId != null && Number(httpId) !== Number(documentoEmpresaId)) {
    throw erroCompraEmpresa(
      'EMPRESA_COMPRA_INCOMPATIVEL',
      `Documento Central pertence à empresa ${documentoEmpresaId}, mas o contexto HTTP é ${httpId}.`,
      403,
      {
        documento_empresa_id: documentoEmpresaId,
        contexto_empresa_id: httpId,
        central_documento_id: centralDocumentoId != null ? Number(centralDocumentoId) : null
      }
    );
  }

  if (bodyId != null) {
    if (documentoEmpresaId != null && Number(bodyId) !== Number(documentoEmpresaId)) {
      throw erroCompraEmpresa(
        'EMPRESA_COMPRA_INCOMPATIVEL',
        `empresa_id do body (${bodyId}) diverge do documento Central (${documentoEmpresaId}).`,
        403,
        { body_empresa_id: bodyId, documento_empresa_id: documentoEmpresaId }
      );
    }
    if (httpId != null && Number(bodyId) !== Number(httpId)) {
      throw erroCompraEmpresa(
        'EMPRESA_COMPRA_INCOMPATIVEL',
        `empresa_id do body (${bodyId}) diverge do contexto HTTP (${httpId}).`,
        403,
        { body_empresa_id: bodyId, contexto_empresa_id: httpId }
      );
    }
  }

  let empresaCompraId = documentoEmpresaId != null
    ? documentoEmpresaId
    : (httpId != null ? Number(httpId) : (bodyId != null ? Number(bodyId) : null));

  if (empresaCompraId != null) {
    empresaCompraId = await validarEmpresaId(empresaCompraId, { db, ...deps });
    return {
      empresaId: empresaCompraId,
      modo,
      origem: documentoEmpresaId != null
        ? 'DOCUMENTO_CENTRAL'
        : (httpId != null ? 'CONTEXTO_HTTP' : 'BODY_EXPLICITO'),
      contrato,
      documento,
      exigirEmpresaEstoque: modo === ModoOperacionalGlobal.MULTIEMPRESA
    };
  }

  if (modo === ModoOperacionalGlobal.EMPRESA_SIMPLES) {
    const emp = contrato.empresa_operacional;
    const id = emp && (emp.empresa_id != null ? Number(emp.empresa_id) : null);
    if (!Number.isInteger(id) || id <= 0) {
      throw erroCompraEmpresa(
        'EMPRESA_OPERACIONAL_AUSENTE',
        'Modo EMPRESA_SIMPLES exige empresa operacional válida para criar compra.',
        409
      );
    }
    return {
      empresaId: id,
      modo,
      origem: 'CONTRATO_EMPRESA_SIMPLES',
      contrato,
      documento,
      exigirEmpresaEstoque: false
    };
  }

  throw erroCompraEmpresa(
    'EMPRESA_COMPRA_AUSENTE',
    'Modo MULTIEMPRESA exige empresa resolvida para criar compra (Central, X-Empresa-Id ou contexto válido).',
    400
  );
}

/**
 * Resolve empresa do contexto para listagem / ownership de compra existente.
 */
async function resolverEmpresaContextoCompra(req, deps = {}) {
  const contrato = deps.contrato
    || await ContratoOperacionalService.montarContratoOperacional(deps);
  const modo = contrato.modo_operacional;
  const db = deps.db || (req && req.db) || null;

  if (modo === ModoOperacionalGlobal.EMPRESA_SIMPLES) {
    const emp = contrato.empresa_operacional;
    const id = emp && (emp.empresa_id != null ? Number(emp.empresa_id) : null);
    if (!Number.isInteger(id) || id <= 0) {
      throw erroCompraEmpresa(
        'EMPRESA_OPERACIONAL_AUSENTE',
        'Modo EMPRESA_SIMPLES exige empresa operacional válida.',
        409
      );
    }
    return { empresaId: id, modo, origem: 'CONTRATO_EMPRESA_SIMPLES', contrato };
  }

  const informado = resolverEmpresaId(req && req.empresaId)
    ?? resolverEmpresaIdDaRequisicao(req);
  if (informado == null) {
    throw erroCompraEmpresa(
      'EMPRESA_COMPRA_AUSENTE',
      'Modo MULTIEMPRESA exige X-Empresa-Id / contexto empresarial para operações de compra.',
      400
    );
  }
  const empresaId = await validarEmpresaId(informado, { db, ...deps });
  return { empresaId, modo, origem: 'CONTEXTO_HTTP', contrato };
}

/**
 * Ownership: compra.empresa_id deve bater com o contexto.
 * Registros legados NULL: EMPRESA_COMPRA_NAO_RESOLVIDA em MULTIEMPRESA;
 * EMPRESA_SIMPLES só se empresa operacional == contexto (determinístico).
 */
function exigirCompraDaEmpresa(compra, empresaId, opts = {}) {
  const rotulo = opts.rotulo || 'Compra';
  if (!compra) {
    throw erroCompraEmpresa(
      'COMPRA_AUSENTE',
      `${rotulo} não encontrada.`,
      404,
      { empresa_id: empresaId }
    );
  }

  const cid = compra.empresa_id != null ? Number(compra.empresa_id) : null;
  const esperado = Number(empresaId);

  if (cid == null || !Number.isInteger(cid) || cid <= 0) {
    if (opts.modo === ModoOperacionalGlobal.EMPRESA_SIMPLES
      && Number.isInteger(esperado) && esperado > 0
      && opts.permitirLegadoSimples === true) {
      return compra;
    }
    throw erroCompraEmpresa(
      'EMPRESA_COMPRA_NAO_RESOLVIDA',
      `${rotulo} legada sem empresa_id. Não é possível operar com isolamento multiempresa.`,
      409,
      { id: compra.id }
    );
  }

  if (cid !== esperado) {
    throw erroCompraEmpresa(
      'COMPRA_EMPRESA_INCOMPATIVEL',
      `${rotulo} não pertence à empresa do contexto atual.`,
      403,
      {
        id: compra.id,
        empresa_id: esperado,
        compra_empresa_id: cid
      }
    );
  }
  return compra;
}

module.exports = {
  resolverEmpresaDaCompra,
  resolverEmpresaContextoCompra,
  exigirCompraDaEmpresa,
  erroCompraEmpresa,
  statusDeErroCompraEmpresa,
  carregarDocumentoCentral
};
