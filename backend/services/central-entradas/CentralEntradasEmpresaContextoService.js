/**
 * Resolução de empresa operacional para a Central de Entradas (Sprint 05.38.E).
 * Fonte oficial: ContratoOperacionalService (sem heurística empresas.length).
 *
 * @module services/central-entradas/CentralEntradasEmpresaContextoService
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

function erroCentralEmpresa(code, message, statusCode = 400, extra = {}) {
  const err = erroModoGlobal(code, message);
  err.statusCode = statusCode;
  Object.assign(err, extra);
  return err;
}

function statusDeErroEmpresa(err) {
  if (!err) return 500;
  if (err.statusCode) return err.statusCode;
  if (err.status) return err.status;
  const code = err.code || '';
  if (
    code === 'EMPRESA_NAO_ENCONTRADA'
    || code === 'EMPRESA_CENTRAL_INVALIDA'
    || code === 'DOCUMENTO_NAO_ENCONTRADO'
  ) {
    return 404;
  }
  if (
    code === 'DOCUMENTO_EMPRESA_INCOMPATIVEL'
    || code === 'OPERACAO_EMPRESA_DIVERGENTE'
    || code === 'EMPRESA_DOCUMENTO_NAO_RESOLVIDA'
  ) {
    return 409;
  }
  if (
    code === 'EMPRESA_INATIVA'
    || code === 'EMPRESA_CENTRAL_INATIVA'
    || code === 'EMPRESA_CENTRAL_AUSENTE'
    || code === 'EMPRESA_CENTRAL_AMBIGUA'
    || code === 'DOCUMENTO_EMPRESA_AMBIGUA'
    || code === 'EMPRESA_OPERACIONAL_AUSENTE'
    || code === 'EMPRESA_OPERACIONAL_AMBIGUA'
    || code === 'EMPRESA_OPERACIONAL_INVALIDA'
  ) {
    return 400;
  }
  return 500;
}

function normalizarCnpj(valor) {
  return String(valor || '').replace(/\D/g, '');
}

/**
 * Resolve empresa para operação da Central.
 *
 * EMPRESA_SIMPLES → empresa operacional do contrato (ignora complexidade externa).
 * MULTIEMPRESA → empresaId explícito ou CNPJ inequívoco; bloqueia ambiguidade.
 *
 * @param {Object} [params]
 * @param {number|string|null} [params.empresaId]
 * @param {string|null} [params.cnpj]
 * @param {string} [params.operacao]
 * @param {Object} [params.req]
 * @param {Object} [deps]
 */
async function resolverEmpresaParaCentral(params = {}, deps = {}) {
  const contrato = deps.contrato
    || await ContratoOperacionalService.montarContratoOperacional(deps);
  const modo = contrato.modo_operacional;
  const db = deps.db || (params.req && params.req.db) || null;

  if (modo === ModoOperacionalGlobal.EMPRESA_SIMPLES) {
    const emp = contrato.empresa_operacional;
    const id = emp && (emp.empresa_id != null ? Number(emp.empresa_id) : null);
    if (!Number.isInteger(id) || id <= 0) {
      throw erroCentralEmpresa(
        'EMPRESA_OPERACIONAL_AUSENTE',
        'Modo EMPRESA_SIMPLES exige empresa operacional válida para a Central de Entradas.',
        409
      );
    }
    return {
      empresaId: id,
      cnpj: emp.cnpj ? normalizarCnpj(emp.cnpj) : null,
      modo,
      origem: 'CONTRATO_EMPRESA_SIMPLES',
      contrato
    };
  }

  const informado = resolverEmpresaId(params.empresaId)
    ?? resolverEmpresaId(params.req && params.req.empresaId)
    ?? resolverEmpresaIdDaRequisicao(params.req);

  if (informado != null) {
    const empresaId = await validarEmpresaId(informado, { db, ...deps });
    const EmpresaService = deps.EmpresaService || require('../empresas/EmpresaService');
    const empresa = await EmpresaService.buscarEmpresaPorId(empresaId, { db });
    if (!empresa || Number(empresa.ativo) !== 1) {
      throw erroCentralEmpresa(
        'EMPRESA_CENTRAL_INATIVA',
        `Empresa ${empresaId} inativa ou inválida para a Central.`,
        400,
        { empresa_id: empresaId }
      );
    }
    return {
      empresaId,
      cnpj: normalizarCnpj(empresa.cnpj),
      modo,
      origem: 'EMPRESA_EXPLICITA',
      contrato
    };
  }

  const cnpj = normalizarCnpj(params.cnpj);
  if (cnpj.length === 14) {
    const EmpresaService = deps.EmpresaService || require('../empresas/EmpresaService');
    let empresa;
    try {
      empresa = await EmpresaService.buscarEmpresaPorCnpj(cnpj, { db });
    } catch (err) {
      if (err && (err.code === 'EMPRESA_NAO_ENCONTRADA' || err.code === 'CNPJ_EMPRESA_INVALIDO'
        || /CNPJ/i.test(err.message || ''))) {
        throw erroCentralEmpresa(
          'EMPRESA_CENTRAL_INVALIDA',
          `Nenhuma empresa cadastrada para o CNPJ ${cnpj}.`,
          404,
          { cnpj }
        );
      }
      throw err;
    }
    if (!empresa || Number(empresa.ativo) !== 1) {
      throw erroCentralEmpresa(
        'EMPRESA_CENTRAL_INATIVA',
        `Empresa do CNPJ ${cnpj} está inativa.`,
        400,
        { cnpj, empresa_id: empresa && empresa.id }
      );
    }
    return {
      empresaId: Number(empresa.id),
      cnpj,
      modo,
      origem: 'CNPJ_DESTINATARIO',
      contrato
    };
  }

  throw erroCentralEmpresa(
    'EMPRESA_CENTRAL_AUSENTE',
    'Modo MULTIEMPRESA exige empresa explícita (X-Empresa-Id) ou CNPJ de destinatário inequívoco.',
    400
  );
}

/**
 * Lista alvos de sincronização DF-e conforme o modo operacional.
 * Cada item carrega empresaId + cnpj — sem estado global mutável entre iterações.
 *
 * @param {Object} [deps]
 * @returns {Promise<{ modo: string, alvos: Array<{ empresaId: number, cnpj: string|null }> }>}
 */
async function listarAlvosSincronizacaoCentral(deps = {}) {
  const contrato = deps.contrato
    || await ContratoOperacionalService.montarContratoOperacional(deps);
  const modo = contrato.modo_operacional;
  const db = deps.db || null;

  if (modo === ModoOperacionalGlobal.EMPRESA_SIMPLES) {
    const emp = contrato.empresa_operacional;
    const id = emp && (emp.empresa_id != null ? Number(emp.empresa_id) : null);
    if (!Number.isInteger(id) || id <= 0) {
      throw erroCentralEmpresa(
        'EMPRESA_OPERACIONAL_AUSENTE',
        'Modo EMPRESA_SIMPLES exige empresa operacional válida para sincronização.',
        409
      );
    }
    return {
      modo,
      alvos: [{
        empresaId: id,
        cnpj: emp.cnpj ? normalizarCnpj(emp.cnpj) : null
      }]
    };
  }

  const EmpresaService = deps.EmpresaService || require('../empresas/EmpresaService');
  const empresas = await EmpresaService.listarEmpresas({ ativo: 1 }, { db });
  const alvos = (empresas || [])
    .map((e) => ({
      empresaId: Number(e.id),
      cnpj: normalizarCnpj(e.cnpj)
    }))
    .filter((a) => Number.isInteger(a.empresaId) && a.empresaId > 0);

  return { modo, alvos };
}

function idEmpresaValido(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function empresaIdDoDocumento(documento) {
  if (!documento) return null;
  return idEmpresaValido(
    documento.empresaId != null ? documento.empresaId : documento.empresa_id
  );
}

function exigirEmpresaIdDoDocumento(documento) {
  const id = empresaIdDoDocumento(documento);
  if (id == null) {
    throw erroCentralEmpresa(
      'EMPRESA_DOCUMENTO_NAO_RESOLVIDA',
      'Documento sem empresa_id — operação bloqueada. Não há fallback de empresa.',
      409,
      { documento_id: documento && documento.id != null ? Number(documento.id) : undefined }
    );
  }
  return id;
}

function corpoDocumentoNaoEncontrado() {
  return {
    error: 'Documento não encontrado',
    code: 'DOCUMENTO_NAO_ENCONTRADO'
  };
}

/**
 * CONTEXTO autoriza; DOCUMENTO determina.
 * Cruzado → 404 DOCUMENTO_NAO_ENCONTRADO (sem vazamento).
 * empresa_id NULL → EMPRESA_DOCUMENTO_NAO_RESOLVIDA (sem fallback).
 *
 * @param {{ documentoId?: number|string, documento?: Object, empresaId: number|string }} params
 * @param {Object} [deps]
 * @returns {Promise<{ documento: Object, empresaId: number }>}
 */
async function exigirDocumentoDaEmpresa(params = {}, deps = {}) {
  const empresaIdContexto = idEmpresaValido(params.empresaId);
  if (empresaIdContexto == null) {
    throw erroCentralEmpresa(
      'EMPRESA_CENTRAL_AUSENTE',
      'Modo MULTIEMPRESA exige empresa explícita (X-Empresa-Id) para operar o documento.',
      400
    );
  }

  let documento = params.documento || null;
  if (!documento) {
    const documentoId = params.documentoId;
    if (documentoId == null || String(documentoId).trim() === '') {
      throw erroCentralEmpresa(
        'DOCUMENTO_NAO_ENCONTRADO',
        'Documento não encontrado',
        404
      );
    }
    let repo = deps.documentosRepository || params.documentosRepository;
    if (!repo) {
      const CentralDocumentosRepository = require('../../motores/central-entradas/repositories/CentralDocumentosRepository');
      repo = new CentralDocumentosRepository({ db: deps.db || null });
    }
    documento = await repo.buscarPorId(documentoId);
  }

  if (!documento) {
    throw erroCentralEmpresa(
      'DOCUMENTO_NAO_ENCONTRADO',
      'Documento não encontrado',
      404
    );
  }

  const dono = empresaIdDoDocumento(documento);
  if (dono == null) {
    throw erroCentralEmpresa(
      'EMPRESA_DOCUMENTO_NAO_RESOLVIDA',
      'Documento sem empresa_id — operação bloqueada. Não há fallback de empresa.',
      409,
      { documento_id: documento.id != null ? Number(documento.id) : undefined }
    );
  }

  if (dono !== empresaIdContexto) {
    throw erroCentralEmpresa(
      'DOCUMENTO_NAO_ENCONTRADO',
      'Documento não encontrado',
      404
    );
  }

  return { documento, empresaId: dono };
}

/**
 * HTTP: resolve contexto (contrato + X-Empresa-Id) e exige ownership do documento.
 */
async function autorizarDocumentoCentralHttp(req, deps = {}) {
  const documentoId = deps.documentoId != null
    ? deps.documentoId
    : (req && req.params ? req.params.id : null);
  const ctx = await resolverEmpresaParaCentral({
    req,
    empresaId: req && req.empresaId
  }, deps);
  const r = await exigirDocumentoDaEmpresa({
    documentoId,
    empresaId: ctx.empresaId,
    documento: deps.documento
  }, deps);
  if (req) {
    req.documentoCentral = r.documento;
    req.empresaDocumentoId = r.empresaId;
    req.contextoCentral = ctx;
  }
  return { ...r, contexto: ctx };
}

function responderErroDocumentoCentral(res, err) {
  const code = err && err.code;
  const status = statusDeErroEmpresa(err);
  if (code === 'DOCUMENTO_NAO_ENCONTRADO') {
    return res.status(404).json(corpoDocumentoNaoEncontrado());
  }
  return res.status(status).json({
    error: (err && err.message) || 'Erro de ownership do documento.',
    code: code || undefined
  });
}

function exigirDocumentoCompraMesmaEmpresa(documentoEmpresaId, compraEmpresaId) {
  const docId = idEmpresaValido(documentoEmpresaId);
  const compraId = idEmpresaValido(compraEmpresaId);
  if (docId == null) {
    throw erroCentralEmpresa(
      'EMPRESA_DOCUMENTO_NAO_RESOLVIDA',
      'Documento sem empresa_id — não é possível vincular compra.',
      409
    );
  }
  if (compraId == null) {
    throw erroCentralEmpresa(
      'EMPRESA_COMPRA_AUSENTE',
      'Vínculo Central exige empresa_id da compra.',
      409
    );
  }
  if (compraId !== docId) {
    throw erroCentralEmpresa(
      'OPERACAO_EMPRESA_DIVERGENTE',
      'empresa_id do documento diverge da empresa persistida da compra.',
      409
    );
  }
  return docId;
}

/**
 * Leitura consolidada “todas as empresas”: somente IDs autorizados ao usuário.
 * Nunca SELECT sem IN; nunca empresa_id NULL; não usa empresa 1 / primeira / COALESCE.
 * EMPRESA_SIMPLES permanece a empresa operacional (não há consolidação).
 *
 * @param {{ req: object, ctx: { empresaId: number, modo?: string }, dest: object }} params
 * @returns {Promise<{ visao: 'empresa'|'todas', empresaId?: number, empresaIds?: number[] }>}
 */
function queryPedeEscopoTodas(query) {
  const v = String((query && (query.escopo || query.visao)) || '').trim().toLowerCase();
  return v === 'todas';
}

async function aplicarFiltroLeituraEmpresasCentral(params = {}, deps = {}) {
  const req = params.req || {};
  const ctx = params.ctx || {};
  const dest = params.dest;
  if (!dest || typeof dest !== 'object') {
    throw erroCentralEmpresa(
      'EMPRESA_CENTRAL_AUSENTE',
      'Destino de filtro empresarial ausente.',
      500
    );
  }

  if (!queryPedeEscopoTodas(req.query) || ctx.modo === ModoOperacionalGlobal.EMPRESA_SIMPLES) {
    dest.empresaId = ctx.empresaId;
    dest.empresaIds = undefined;
    return { visao: 'empresa', empresaId: ctx.empresaId };
  }

  const UsuarioEmpresaService = deps.UsuarioEmpresaService
    || require('../empresas/UsuarioEmpresaService');
  let lista;
  try {
    lista = await UsuarioEmpresaService.listarEmpresasPermitidas(req.user || req.usuario, {
      db: req.db || deps.db
    });
  } catch (err) {
    if (err && err.code === 'USUARIO_OBRIGATORIO') {
      throw erroCentralEmpresa(
        'EMPRESA_CENTRAL_AUSENTE',
        'Escopo “todas as empresas” exige usuário autenticado.',
        400
      );
    }
    throw err;
  }

  const ids = [...new Set(
    (Array.isArray(lista) ? lista : [])
      .map((e) => Number(e && e.id))
      .filter((n) => Number.isInteger(n) && n > 0)
  )];

  dest.empresaId = null;
  dest.empresaIds = ids;
  return { visao: 'todas', empresaIds: ids };
}

module.exports = {
  resolverEmpresaParaCentral,
  listarAlvosSincronizacaoCentral,
  exigirDocumentoDaEmpresa,
  autorizarDocumentoCentralHttp,
  exigirDocumentoCompraMesmaEmpresa,
  empresaIdDoDocumento,
  exigirEmpresaIdDoDocumento,
  corpoDocumentoNaoEncontrado,
  responderErroDocumentoCentral,
  erroCentralEmpresa,
  statusDeErroEmpresa,
  normalizarCnpj,
  aplicarFiltroLeituraEmpresasCentral,
  queryPedeEscopoTodas
};
