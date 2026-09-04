/**
 * Resolução de empresa operacional para o módulo Caixa (Sprint 05.38.C).
 * Fonte oficial: ContratoOperacionalService + empresaContexto (sem resolver paralelo).
 *
 * @module services/caixa/CaixaEmpresaContextoService
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

function erroCaixaEmpresa(code, message, statusCode = 400, extra = {}) {
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
  if (code === 'EMPRESA_NAO_ENCONTRADA' || code === 'CAIXA_NAO_ENCONTRADO' || code === 'CAIXA_SESSAO_NAO_ENCONTRADA' || code === 'CAIXA_MOVIMENTACAO_NAO_ENCONTRADA' || code === 'CAIXA_FECHAMENTO_NAO_ENCONTRADO') return 404;
  if (code === 'EMPRESA_NAO_AUTORIZADA') return 403;
  if (
    code === 'EMPRESA_INATIVA'
    || code === 'EMPRESA_OBRIGATORIA'
    || code === 'EMPRESA_ID_OBRIGATORIO'
    || code === 'EMPRESA_OPERACIONAL_AUSENTE'
    || code === 'EMPRESA_OPERACIONAL_AMBIGUA'
    || code === 'EMPRESA_OPERACIONAL_INVALIDA'
    || code === 'CAIXA_EMPRESA_OBRIGATORIA'
    || code === 'CAIXA_SESSAO_EMPRESA_DIVERGENTE'
    || code === 'CAIXA_SESSAO_SEM_EMPRESA'
    || code === 'CAIXA_SESSAO_AUSENTE'
    || code === 'EMPRESA_OWNERSHIP_REQUIRED'
  ) {
    return 400;
  }
  return 500;
}

/**
 * Resolve empresa_id oficial para operações de Caixa.
 *
 * EMPRESA_SIMPLES → ContratoOperacional (empresa operacional única).
 * MULTIEMPRESA → contexto da requisição (X-Empresa-Id / req.empresaId), validado.
 */
async function resolverEmpresaIdParaCaixa(req, deps = {}) {
  const contrato = deps.contrato
    || await ContratoOperacionalService.montarContratoOperacional(deps);
  const modo = contrato.modo_operacional;

  if (modo === ModoOperacionalGlobal.EMPRESA_SIMPLES) {
    const emp = contrato.empresa_operacional;
    const id = emp && (emp.empresa_id != null ? Number(emp.empresa_id) : null);
    if (!Number.isInteger(id) || id <= 0) {
      throw erroCaixaEmpresa(
        'EMPRESA_OPERACIONAL_AUSENTE',
        'Modo EMPRESA_SIMPLES exige empresa operacional válida para o Caixa.',
        409
      );
    }
    return {
      empresaId: id,
      modo,
      origem: 'CONTRATO_EMPRESA_SIMPLES',
      contrato
    };
  }

  const informado = resolverEmpresaId(req && req.empresaId)
    ?? resolverEmpresaIdDaRequisicao(req);

  if (informado == null) {
    throw erroCaixaEmpresa(
      'CAIXA_EMPRESA_OBRIGATORIA',
      'Modo MULTIEMPRESA exige contexto empresarial válido para o Caixa. Informe X-Empresa-Id.',
      400
    );
  }

  const db = deps.db || (req && req.db) || null;
  const empresaId = await validarEmpresaId(informado, { db, ...deps });

  if (deps.exigirAutorizacaoUsuario !== false && req && req.user) {
    const uid = req.user.id != null ? req.user.id : req.user.usuario_id;
    if (uid) {
      const { exigirEmpresaAutorizada } = deps.UsuarioEmpresaService
        || require('../empresas/UsuarioEmpresaService');
      await exigirEmpresaAutorizada(uid, empresaId, { db });
    }
  }

  return {
    empresaId,
    modo,
    origem: 'CONTEXTO_REQUISICAO',
    contrato
  };
}

/**
 * Garante que a sessão pertence à empresa operacional atual.
 */
function exigirSessaoDaEmpresa(sessao, empresaId) {
  if (!sessao) {
    throw erroCaixaEmpresa(
      'CAIXA_SESSAO_AUSENTE',
      'Nenhuma sessão de caixa encontrada para a empresa atual.',
      400,
      { empresa_id: empresaId }
    );
  }
  const sid = sessao.empresa_id != null ? Number(sessao.empresa_id) : null;
  if (sid == null || !Number.isInteger(sid) || sid <= 0) {
    throw erroCaixaEmpresa(
      'EMPRESA_OWNERSHIP_REQUIRED',
      'Sessão de caixa sem empresa_id. Ownership é obrigatório para operação empresarial.',
      400,
      { sessao_id: sessao.id }
    );
  }
  if (sid !== Number(empresaId)) {
    throw erroCaixaEmpresa(
      'CAIXA_SESSAO_EMPRESA_DIVERGENTE',
      'A sessão de caixa não pertence à empresa do contexto atual.',
      403,
      { sessao_id: sessao.id, empresa_id: empresaId }
    );
  }
  return sessao;
}

/**
 * Metadados de empresa para cupom/fechamento a partir de empresa_id (não configuracoes.cnpj).
 */
async function obterMetaEmpresaPorId(empresaId, deps = {}) {
  const id = Number(empresaId);
  if (!Number.isInteger(id) || id <= 0) {
    return { empresa_nome: 'CDS Sistemas', empresa_cnpj: '', empresa_id: null };
  }

  if (typeof deps.buscarEmpresaPorId === 'function') {
    const emp = await deps.buscarEmpresaPorId(id);
    return {
      empresa_id: id,
      empresa_nome: (emp && (emp.nome_fantasia || emp.razao_social)) || 'CDS Sistemas',
      empresa_cnpj: (emp && emp.cnpj) || ''
    };
  }

  const EmpresaService = deps.EmpresaService || require('../empresas/EmpresaService');
  try {
    const emp = await EmpresaService.buscarEmpresaPorId(id, { db: deps.db });
    return {
      empresa_id: id,
      empresa_nome: emp.nome_fantasia || emp.razao_social || 'CDS Sistemas',
      empresa_cnpj: emp.cnpj || ''
    };
  } catch (err) {
    if (err && err.code === 'EMPRESA_NAO_ENCONTRADA') {
      return { empresa_id: id, empresa_nome: 'CDS Sistemas', empresa_cnpj: '' };
    }
    throw err;
  }
}

function middlewareResolverEmpresaCaixa(deps = {}) {
  return async function anexarEmpresaCaixa(req, res, next) {
    try {
      const resolved = await resolverEmpresaIdParaCaixa(req, {
        ...deps,
        db: deps.db || req.db || require('../../database')
      });
      req.empresaId = resolved.empresaId;
      req.caixaEmpresaContexto = resolved;
      return next();
    } catch (err) {
      const status = statusDeErroEmpresa(err);
      return res.status(status).json({
        error: err.message || 'Erro ao resolver empresa do Caixa.',
        code: err.code || 'CAIXA_EMPRESA_ERRO',
        empresa_id: err.empresa_id != null ? err.empresa_id : undefined
      });
    }
  };
}

module.exports = {
  resolverEmpresaIdParaCaixa,
  exigirSessaoDaEmpresa,
  obterMetaEmpresaPorId,
  middlewareResolverEmpresaCaixa,
  statusDeErroEmpresa,
  erroCaixaEmpresa
};
