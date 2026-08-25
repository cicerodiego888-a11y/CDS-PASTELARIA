/**
 * Política central EMPRESA_SIMPLES — uma única empresa operacional determinística.
 *
 * @module core/modo-operacional/PoliticaEmpresaSimples
 */
'use strict';

const { erroModoGlobal } = require('./contratos');

function erroPolitica(code, message, statusCode = 409, extra = {}) {
  const err = erroModoGlobal(code, message);
  err.statusCode = statusCode;
  Object.assign(err, extra);
  return err;
}

function normalizarEmpresaOperacionalId(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function mapearEmpresaResumo(empresa) {
  if (!empresa) return null;
  const id = Number(empresa.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  return {
    empresa_id: id,
    cnpj: empresa.cnpj || null,
    razao_social: empresa.razao_social || empresa.razaoSocial || null,
    nome_fantasia: empresa.nome_fantasia || empresa.nomeFantasia || null
  };
}

async function listarEmpresasAtivas(deps = {}) {
  if (typeof deps.listarEmpresasAtivas === 'function') {
    return deps.listarEmpresasAtivas();
  }
  const EmpresaService = deps.EmpresaService || require('../../services/empresas/EmpresaService');
  return EmpresaService.listarEmpresas({ ativo: 1 }, { db: deps.db });
}

async function buscarEmpresaAtivaPorId(empresaId, deps = {}) {
  if (typeof deps.buscarEmpresaAtivaPorId === 'function') {
    return deps.buscarEmpresaAtivaPorId(empresaId);
  }
  const EmpresaService = deps.EmpresaService || require('../../services/empresas/EmpresaService');
  const empresa = await EmpresaService.buscarEmpresaPorId(empresaId, { db: deps.db });
  if (!empresa || Number(empresa.ativo) !== 1) {
    throw erroPolitica(
      'EMPRESA_OPERACIONAL_INVALIDA',
      `Empresa operacional inválida ou inativa: ${empresaId}.`,
      409,
      { empresa_id: empresaId }
    );
  }
  return empresa;
}

function obterEmpresaOperacionalIdConfig(deps = {}) {
  if (deps.empresa_operacional_id != null) {
    return normalizarEmpresaOperacionalId(deps.empresa_operacional_id);
  }
  if (typeof deps.obterEmpresaOperacionalId === 'function') {
    return normalizarEmpresaOperacionalId(deps.obterEmpresaOperacionalId());
  }
  const configService = deps.configService || require('../../services/configuracaoService');
  const cfg = deps.cfg || configService.readConfig();
  return normalizarEmpresaOperacionalId(cfg.empresa_operacional_id);
}

/**
 * Resolve a empresa operacional única da instalação.
 * Nunca usa "primeira da lista" quando há ambiguidade (N>1 sem vínculo explícito).
 */
async function resolverEmpresaOperacional(deps = {}) {
  const configuradoId = obterEmpresaOperacionalIdConfig(deps);

  if (configuradoId != null) {
    const empresa = await buscarEmpresaAtivaPorId(configuradoId, deps);
    return {
      empresa: mapearEmpresaResumo(empresa),
      origem: 'CONFIGURACAO_EXPLICITA'
    };
  }

  const ativas = await listarEmpresasAtivas(deps);

  if (ativas.length === 0) {
    throw erroPolitica(
      'EMPRESA_OPERACIONAL_AUSENTE',
      'Modo EMPRESA_SIMPLES exige uma empresa operacional válida. Cadastre uma empresa ativa ou defina empresa_operacional_id.',
      409
    );
  }

  if (ativas.length === 1) {
    return {
      empresa: mapearEmpresaResumo(ativas[0]),
      origem: 'UNICA_EMPRESA_ATIVA'
    };
  }

  throw erroPolitica(
    'EMPRESA_OPERACIONAL_AMBIGUA',
    'Modo EMPRESA_SIMPLES com múltiplas empresas ativas exige empresa_operacional_id explícito nas configurações.',
    409,
    { empresas_ativas: ativas.map((e) => Number(e.id)) }
  );
}

module.exports = {
  resolverEmpresaOperacional,
  obterEmpresaOperacionalIdConfig,
  mapearEmpresaResumo,
  normalizarEmpresaOperacionalId
};
