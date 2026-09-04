/**
 * Ownership empresarial da venda (Sprint 05.40).
 * Fonte definitiva: vendas.empresa_id.
 * Não usa query.empresa_id, empresa 1, último caixa ou config global como ownership.
 *
 * @module services/vendas/VendaEmpresaContextoService
 */
'use strict';

const {
  ModoOperacionalGlobal,
  ContratoOperacionalService,
  erroModoGlobal
} = require('../../core/modo-operacional');
const {
  resolverEmpresaId,
  validarEmpresaId
} = require('../fiscalNaoFiscal/empresaContexto');
const { exigirSessaoDaEmpresa } = require('../caixa/CaixaEmpresaContextoService');

const CODIGO_EMPRESA_CONTEXT_REQUIRED = 'EMPRESA_CONTEXT_REQUIRED';
const CODIGO_EMPRESA_OWNERSHIP_REQUIRED = 'EMPRESA_OWNERSHIP_REQUIRED';

function erroVendaEmpresa(code, message, statusCode = 400, extra = {}) {
  const err = erroModoGlobal(code, message);
  err.statusCode = statusCode;
  Object.assign(err, extra);
  return err;
}

function statusDeErroEmpresaVenda(err) {
  if (!err) return 500;
  if (err.statusCode) return err.statusCode;
  if (err.status) return err.status;
  const code = err.code || '';
  if (code === 'EMPRESA_NAO_ENCONTRADA' || code === 'VENDA_NAO_ENCONTRADA') return 404;
  if (code === 'EMPRESA_NAO_AUTORIZADA' || code === 'CAIXA_SESSAO_EMPRESA_DIVERGENTE') return 403;
  if (
    code === CODIGO_EMPRESA_CONTEXT_REQUIRED
    || code === 'EMPRESA_INATIVA'
    || code === 'EMPRESA_OBRIGATORIA'
    || code === 'EMPRESA_ID_OBRIGATORIO'
    || code === 'EMPRESA_OPERACIONAL_AUSENTE'
    || code === 'EMPRESA_OPERACIONAL_AMBIGUA'
    || code === 'EMPRESA_OPERACIONAL_INVALIDA'
    || code === 'CAIXA_SESSAO_SEM_EMPRESA'
    || code === 'CAIXA_SESSAO_AUSENTE'
    || code === CODIGO_EMPRESA_OWNERSHIP_REQUIRED
  ) {
    return 400;
  }
  return 500;
}

function empresaIdDoHeader(req) {
  const headers = (req && req.headers) || {};
  return resolverEmpresaId(
    headers['x-empresa-id'] != null ? headers['x-empresa-id'] : headers['x-empresaid']
  );
}

/**
 * Resolve empresa do contexto autenticado/contratual.
 * Não lê req.query.empresa_id nem body como substituto.
 */
async function resolverEmpresaIdParaVenda(req, deps = {}) {
  const contrato = deps.contrato
    || await ContratoOperacionalService.montarContratoOperacional(deps);
  const modo = contrato.modo_operacional;

  if (modo === ModoOperacionalGlobal.EMPRESA_SIMPLES) {
    const emp = contrato.empresa_operacional;
    const id = emp && (emp.empresa_id != null ? Number(emp.empresa_id) : null);
    if (!Number.isInteger(id) || id <= 0) {
      throw erroVendaEmpresa(
        'EMPRESA_OPERACIONAL_AUSENTE',
        'Modo EMPRESA_SIMPLES exige empresa operacional válida para a venda.',
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

  const informado = resolverEmpresaId(req && req.empresaId) ?? empresaIdDoHeader(req);

  if (informado == null) {
    throw erroVendaEmpresa(
      CODIGO_EMPRESA_CONTEXT_REQUIRED,
      'Contexto empresarial obrigatório para operação de venda. Informe X-Empresa-Id.',
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
 * Invariante 05.40: venda nova exige empresa_id explícito.
 * Não usa fallback 1 / última empresa / config global.
 */
function exigirEmpresaDaOperacao(reqOrId) {
  const bruto = reqOrId && typeof reqOrId === 'object'
    ? (reqOrId.empresaId != null ? reqOrId.empresaId : reqOrId.empresa_id)
    : reqOrId;
  const id = Number(bruto);
  if (!Number.isInteger(id) || id <= 0) {
    throw erroVendaEmpresa(
      CODIGO_EMPRESA_CONTEXT_REQUIRED,
      'Empresa do contexto é obrigatória para criar venda.',
      400
    );
  }
  return id;
}

/**
 * Se houver sessão de caixa, ela deve ser da mesma empresa da venda.
 * Não altera empresa_id automaticamente.
 */
function exigirCaixaCompativelComVenda(req, empresaId) {
  const id = exigirEmpresaDaOperacao(empresaId != null ? empresaId : req);
  const sessao = req && (req.caixaSessao || req.caixa_sessao);
  if (!sessao) return null;
  return exigirSessaoDaEmpresa(sessao, id);
}

/**
 * Consulta operacional: venda de outra empresa ou legado NULL = NOT_FOUND.
 * Não revela existência cruzada.
 */
function exigirVendaDaEmpresa(venda, empresaId) {
  const idEmpresa = Number(empresaId);
  if (!venda) {
    throw erroVendaEmpresa(
      'VENDA_NAO_ENCONTRADA',
      'Venda não encontrada.',
      404,
      { empresa_id: idEmpresa }
    );
  }
  const sid = venda.empresa_id != null ? Number(venda.empresa_id) : null;
  if (sid == null || sid !== idEmpresa) {
    throw erroVendaEmpresa(
      'VENDA_NAO_ENCONTRADA',
      'Venda não encontrada.',
      404,
      { empresa_id: idEmpresa }
    );
  }
  return venda;
}

/**
 * Fonte autoritativa da empresa da venda (05.42).
 * Não infere caixa, MUV, COMPAT, req.empresaId ou empresa global.
 */
function resolverEmpresaDaVenda(venda) {
  if (!venda) {
    throw erroVendaEmpresa(
      'VENDA_NAO_ENCONTRADA',
      'Venda não encontrada.',
      404
    );
  }
  const sid = venda.empresa_id != null ? Number(venda.empresa_id) : null;
  if (sid == null || !Number.isInteger(sid) || sid <= 0) {
    throw erroVendaEmpresa(
      CODIGO_EMPRESA_OWNERSHIP_REQUIRED,
      'Empresa é obrigatória para cancelar ou devolver a venda.',
      400,
      { venda_id: venda.id != null ? venda.id : undefined }
    );
  }
  return sid;
}

/**
 * Cancelamento/devolução: empresa da venda + autorização do contexto atual.
 * Cruzado → VENDA_NAO_ENCONTRADA. Legado NULL → EMPRESA_OWNERSHIP_REQUIRED.
 */
function exigirOperacaoReversaoDaVenda(venda, empresaIdContexto) {
  if (!venda) {
    throw erroVendaEmpresa(
      'VENDA_NAO_ENCONTRADA',
      'Venda não encontrada.',
      404,
      { empresa_id: empresaIdContexto != null ? Number(empresaIdContexto) : undefined }
    );
  }
  const empresaDaVenda = resolverEmpresaDaVenda(venda);
  exigirVendaDaEmpresa(venda, empresaIdContexto);
  return empresaDaVenda;
}

function middlewareResolverEmpresaVenda(deps = {}) {
  return async function anexarEmpresaVenda(req, res, next) {
    try {
      const resolved = await resolverEmpresaIdParaVenda(req, {
        ...deps,
        db: deps.db || req.db || require('../../database'),
        exigirAutorizacaoUsuario: deps.exigirAutorizacaoUsuario
      });
      req.empresaId = resolved.empresaId;
      req.vendaEmpresaContexto = resolved;
      return next();
    } catch (err) {
      const status = statusDeErroEmpresaVenda(err);
      return res.status(status).json({
        error: err.message || 'Erro ao resolver empresa da venda.',
        code: err.code || CODIGO_EMPRESA_CONTEXT_REQUIRED,
        empresa_id: err.empresa_id != null ? err.empresa_id : undefined
      });
    }
  };
}

function responderErroEmpresaVenda(res, err) {
  const status = statusDeErroEmpresaVenda(err);
  return res.status(status).json({
    error: err.message || 'Erro de ownership da venda.',
    code: err.code || CODIGO_EMPRESA_CONTEXT_REQUIRED,
    empresa_id: err.empresa_id != null ? err.empresa_id : undefined
  });
}

module.exports = {
  CODIGO_EMPRESA_CONTEXT_REQUIRED,
  CODIGO_EMPRESA_OWNERSHIP_REQUIRED,
  resolverEmpresaIdParaVenda,
  resolverEmpresaDaVenda,
  exigirEmpresaDaOperacao,
  exigirCaixaCompativelComVenda,
  exigirVendaDaEmpresa,
  exigirOperacaoReversaoDaVenda,
  middlewareResolverEmpresaVenda,
  statusDeErroEmpresaVenda,
  responderErroEmpresaVenda,
  erroVendaEmpresa
};
