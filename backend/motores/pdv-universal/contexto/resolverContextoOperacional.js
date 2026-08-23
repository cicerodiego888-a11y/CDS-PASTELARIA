/**
 * Contexto operacional do PDV Universal (preparação 05.01; seleção na 05.02).
 */
'use strict';

function resolverOperadorId(entrada = {}) {
  const user = entrada.user || entrada.usuario || (entrada.req && entrada.req.user);
  const raw = entrada.operador_id
    || entrada.operadorId
    || (user && (user.id || user.usuario_id || user.usuarioId));
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function resolverTerminalId(entrada = {}) {
  const req = entrada.req;
  const raw = entrada.terminal_id
    || entrada.terminalId
    || (req && req.headers && (req.headers['x-terminal-id'] || req.headers['x-estacao']));
  if (raw == null || raw === '') return null;
  return String(raw);
}

function resolverEmpresaIdOpcional(entrada = {}) {
  const { resolverEmpresaId, resolverEmpresaIdDaRequisicao } = require('../../../services/fiscalNaoFiscal/empresaContexto');
  const direto = resolverEmpresaId(entrada);
  if (direto != null) return direto;
  if (entrada.req) return resolverEmpresaIdDaRequisicao(entrada.req);
  return null;
}

function mapearEmpresaPublica(empresa) {
  if (!empresa) return null;
  return {
    id: Number(empresa.id),
    cnpj: empresa.cnpj || null,
    razao_social: empresa.razao_social || empresa.razaoSocial || null,
    nome_fantasia: empresa.nome_fantasia || empresa.nomeFantasia || null,
    ativo: empresa.ativo == null ? 1 : Number(empresa.ativo)
  };
}

async function listarEmpresasDisponiveisSeguro(entrada = {}, deps = {}) {
  if (typeof deps.listarEmpresasDisponiveis === 'function') {
    return deps.listarEmpresasDisponiveis(entrada);
  }
  const operadorId = resolverOperadorId(entrada);
  if (!operadorId) return [];
  try {
    const EmpresaService = deps.EmpresaService || require('../../../services/empresas/EmpresaService');
    const lista = await EmpresaService.listarEmpresasDisponiveis({
      db: deps.db,
      user: entrada.user || entrada.usuario || (entrada.req && entrada.req.user),
      usuarioId: operadorId
    });
    return (lista || []).map(mapearEmpresaPublica);
  } catch (err) {
    if (err && err.code === 'USUARIO_OBRIGATORIO') return [];
    throw err;
  }
}

module.exports = {
  resolverOperadorId,
  resolverTerminalId,
  resolverEmpresaIdOpcional,
  mapearEmpresaPublica,
  listarEmpresasDisponiveisSeguro
};
