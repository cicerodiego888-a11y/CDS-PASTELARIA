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
  if (code === 'EMPRESA_NAO_ENCONTRADA' || code === 'EMPRESA_CENTRAL_INVALIDA') return 404;
  if (code === 'DOCUMENTO_EMPRESA_INCOMPATIVEL') return 409;
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

/**
 * Valida que documento e compra pertencem à mesma empresa.
 * @param {number|null|undefined} documentoEmpresaId
 * @param {number|null|undefined} compraEmpresaId
 */
function exigirDocumentoCompraMesmaEmpresa(documentoEmpresaId, compraEmpresaId) {
  const docId = documentoEmpresaId != null ? Number(documentoEmpresaId) : null;
  const compraId = compraEmpresaId != null ? Number(compraEmpresaId) : null;
  if (!Number.isInteger(docId) || docId <= 0) {
    throw erroCentralEmpresa(
      'EMPRESA_CENTRAL_AUSENTE',
      'Documento sem empresa_id — não é possível vincular compra com isolamento empresarial.',
      409
    );
  }
  if (Number.isInteger(compraId) && compraId > 0 && compraId !== docId) {
    throw erroCentralEmpresa(
      'DOCUMENTO_EMPRESA_INCOMPATIVEL',
      `Documento pertence à empresa ${docId}, mas a compra aponta para empresa ${compraId}.`,
      409,
      { documento_empresa_id: docId, compra_empresa_id: compraId }
    );
  }
  return docId;
}

module.exports = {
  resolverEmpresaParaCentral,
  listarAlvosSincronizacaoCentral,
  exigirDocumentoCompraMesmaEmpresa,
  erroCentralEmpresa,
  statusDeErroEmpresa,
  normalizarCnpj
};
