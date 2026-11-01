/**
 * Contexto empresarial do Motor Bancário.
 * Reutiliza o resolver oficial de venda + UsuarioEmpresaService.
 * "Todas as empresas" é somente escopo de consulta — não cria empresa TODAS.
 * Sem fallback para a primeira empresa. Sem inferir empresa pelo usuário.
 * @module motores/bancario/BancarioEmpresaContextoService
 */
'use strict';

const { ModoOperacionalGlobal } = require('../../core/modo-operacional');
const { resolverEmpresaId } = require('../../services/fiscalNaoFiscal/empresaContexto');
const {
  resolverEmpresaIdParaVenda,
  statusDeErroEmpresaVenda
} = require('../../services/vendas/VendaEmpresaContextoService');
const { ERROS, erroMbc } = require('./contracts/constantes');

function queryPedeEscopoTodas(query) {
  const v = String((query && (query.escopo || query.visao)) || '').trim().toLowerCase();
  return v === 'todas';
}

function bodyPedeEscopoTodas(body) {
  const v = String((body && (body.escopo || body.visao)) || '').trim().toLowerCase();
  return v === 'todas';
}

function requisicaoPedeEscopoTodas(req) {
  return queryPedeEscopoTodas(req && req.query) || bodyPedeEscopoTodas(req && req.body);
}

function idsUnicosValidos(lista) {
  return [...new Set(
    (Array.isArray(lista) ? lista : [])
      .map((e) => Number(e && (e.id != null ? e.id : e)))
      .filter((n) => Number.isInteger(n) && n > 0)
  )];
}

function erroEmpresaNaoAutorizada(empresaId) {
  const err = erroMbc(
    'EMPRESA_NAO_AUTORIZADA',
    'Usuário não está autorizado a usar esta empresa.',
    403
  );
  err.empresa_id = empresaId;
  return err;
}

async function resolverEmpresaIdParaBancario(req, deps = {}) {
  const db = deps.db || (req && req.db) || null;
  const resolved = await resolverEmpresaIdParaVenda(req, {
    ...deps,
    db,
    exigirAutorizacaoUsuario: false
  });

  if (deps.exigirAutorizacaoUsuario !== false && req && req.user) {
    const uid = req.user.id != null ? req.user.id : req.user.usuario_id;
    if (uid) {
      const UsuarioEmpresaService = deps.UsuarioEmpresaService
        || require('../../services/empresas/UsuarioEmpresaService');
      await UsuarioEmpresaService.exigirEmpresaAutorizada(uid, resolved.empresaId, { db, user: req.user });
    }
  }

  return resolved;
}

async function listarEmpresasAutorizadasBancario(req, deps = {}) {
  const db = deps.db || (req && req.db) || null;
  const UsuarioEmpresaService = deps.UsuarioEmpresaService
    || require('../../services/empresas/UsuarioEmpresaService');
  const fonte = (req && (req.user || req.usuario)) || deps.usuario;
  let lista;
  try {
    lista = await UsuarioEmpresaService.listarEmpresasPermitidas(fonte, { db });
  } catch (err) {
    if (err && err.code === 'USUARIO_OBRIGATORIO') {
      throw erroMbc(
        ERROS.EMPRESA_OBRIGATORIA,
        'Escopo “todas as empresas” exige usuário autenticado.',
        400
      );
    }
    throw err;
  }
  return Array.isArray(lista) ? lista : [];
}

async function resolverContextoBancario(req, deps = {}) {
  const resolverBase = typeof deps.resolverEmpresaIdParaBancario === 'function'
    ? deps.resolverEmpresaIdParaBancario
    : resolverEmpresaIdParaBancario;
  const base = await resolverBase(req, deps);
  const pedeTodas = requisicaoPedeEscopoTodas(req);

  if (!pedeTodas || base.modo === ModoOperacionalGlobal.EMPRESA_SIMPLES) {
    return {
      ...base,
      visao: 'empresa',
      empresaIds: [base.empresaId]
    };
  }

  const empresas = await listarEmpresasAutorizadasBancario(req, deps);
  const empresaIds = idsUnicosValidos(empresas);
  return {
    ...base,
    visao: 'todas',
    empresaIds,
    empresas
  };
}

function candidatoEmpresaDaRequisicao(req) {
  const queryId = resolverEmpresaId(
    req && req.query && (req.query.empresa_id != null ? req.query.empresa_id : req.query.empresaId)
  );
  const bodyId = resolverEmpresaId(
    req && req.body && (req.body.empresa_id != null ? req.body.empresa_id : req.body.empresaId)
  );
  return { queryId, bodyId };
}

function exigirEmpresaNoConjuntoAutorizado(empresaId, empresaIds) {
  const id = Number(empresaId);
  if (!Number.isInteger(id) || id <= 0) {
    throw erroMbc(ERROS.EMPRESA_OBRIGATORIA, 'Empresa é obrigatória para esta operação.', 400);
  }
  const autorizadas = idsUnicosValidos(empresaIds);
  if (autorizadas.indexOf(id) === -1) {
    throw erroEmpresaNaoAutorizada(id);
  }
  return id;
}

/**
 * Empresa da listagem: contexto individual ignora query/body.
 * Escopo todas: filtro query/body só vale se autorizado (senão 403).
 */
function resolverEmpresaFiltroLeitura(ctx, req) {
  if (!ctx || ctx.visao !== 'todas') {
    return { visao: 'empresa', empresaId: ctx.empresaId, empresaIds: [ctx.empresaId] };
  }
  const { queryId } = candidatoEmpresaDaRequisicao(req);
  if (queryId == null) {
    return { visao: 'todas', empresaId: null, empresaIds: ctx.empresaIds || [] };
  }
  const id = exigirEmpresaNoConjuntoAutorizado(queryId, ctx.empresaIds);
  return { visao: 'todas', empresaId: id, empresaIds: [id] };
}

/**
 * Empresa de criação: contexto individual usa só o contexto.
 * Escopo todas exige empresa escolhida e autorizada.
 */
function resolverEmpresaEscritaConta(ctx, req) {
  if (!ctx || ctx.visao !== 'todas') {
    return ctx.empresaId;
  }
  const { bodyId } = candidatoEmpresaDaRequisicao(req);
  if (bodyId == null) {
    throw erroMbc(
      ERROS.EMPRESA_OBRIGATORIA,
      'Selecione a empresa da conta bancária.',
      400
    );
  }
  return exigirEmpresaNoConjuntoAutorizado(bodyId, ctx.empresaIds);
}

module.exports = {
  resolverEmpresaIdParaBancario,
  resolverContextoBancario,
  resolverEmpresaFiltroLeitura,
  resolverEmpresaEscritaConta,
  listarEmpresasAutorizadasBancario,
  queryPedeEscopoTodas,
  requisicaoPedeEscopoTodas,
  exigirEmpresaNoConjuntoAutorizado,
  statusDeErroEmpresaBancario: statusDeErroEmpresaVenda
};
