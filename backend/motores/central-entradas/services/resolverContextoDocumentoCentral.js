/**
 * Contexto SEFAZ da Central a partir do documento (CENTRAL-XML-MULTICNPJ-01).
 * DistDFe/NSU já é por CNPJ; ciência e consChNFe devem usar a mesma empresa do documento.
 *
 * @module motores/central-entradas/services/resolverContextoDocumentoCentral
 */
'use strict';

const { ModoOperacionalGlobal } = require('../../../core/modo-operacional');

/**
 * @param {string|number|null} cnpj
 * @returns {string|null}
 */
function mascararCnpj(cnpj) {
  const d = String(cnpj || '').replace(/\D/g, '');
  if (d.length !== 14) return d || null;
  return `${d.slice(0, 2)}.***.***/${d.slice(8, 12)}-${d.slice(12)}`;
}

/**
 * @param {string|null} chave
 * @returns {string|null}
 */
function mascararChave(chave) {
  const d = String(chave || '').replace(/\D/g, '');
  if (d.length < 12) return d || null;
  return `${d.slice(0, 6)}…${d.slice(-8)}`;
}

/**
 * @param {Object|null} documento
 * @returns {number|null}
 */
function resolverEmpresaIdDocumento(documento) {
  const emp = Number(documento?.empresaId ?? documento?.empresa_id);
  return Number.isInteger(emp) && emp > 0 ? emp : null;
}

/**
 * Fallback global só em EMPRESA_SIMPLES. MULTIEMPRESA nunca promove filial à matriz.
 * @param {Object} [deps]
 * @returns {boolean}
 */
function permitirFallbackGlobalPorModo(deps = {}) {
  try {
    const { resolverModoOperacionalGlobalAtivo } = require('../../../core/modo-operacional');
    return resolverModoOperacionalGlobalAtivo(deps) === ModoOperacionalGlobal.EMPRESA_SIMPLES;
  } catch {
    return false;
  }
}

/**
 * @param {Function} obterContextoOperacional
 * @param {Object} documento
 * @param {Object} [opcoes]
 * @returns {Promise<{ ok: boolean, codigoErro?: string, mensagem?: string, contexto?: Object }>}
 */
async function obterContextoOperacionalDoDocumento(obterContextoOperacional, documento, opcoes = {}) {
  if (typeof obterContextoOperacional !== 'function') {
    return {
      ok: false,
      codigoErro: 'CONFIG_FISCAL',
      mensagem: 'Resolver de contexto operacional indisponível.'
    };
  }

  const empresaId = resolverEmpresaIdDocumento(documento);
  if (!empresaId) {
    return obterContextoOperacional({
      ...opcoes,
      empresaId: undefined
    });
  }

  const permitirFallbackGlobal = opcoes.permitirFallbackGlobal != null
    ? opcoes.permitirFallbackGlobal === true
    : permitirFallbackGlobalPorModo(opcoes);

  const { obterModoOperacionalGlobal, configService, ...rest } = opcoes;
  void obterModoOperacionalGlobal;
  void configService;

  const result = await obterContextoOperacional({
    ...rest,
    empresaId,
    permitirFallbackGlobal
  });

  if (result?.ok && result.contexto) {
    result.contexto.empresaId = empresaId;
  }
  return result;
}

/**
 * Campos seguros para log técnico (sem senha, PFX, token).
 * @param {Object} [contexto]
 * @param {Object} [documento]
 * @returns {Object}
 */
function camposLogContextoDocumento(contexto = {}, documento = {}) {
  return {
    empresa_id: contexto.empresaId ?? resolverEmpresaIdDocumento(documento),
    cnpj: mascararCnpj(contexto.cnpj),
    chave: mascararChave(documento.chave),
    ambiente: contexto.ambiente != null ? Number(contexto.ambiente) : null,
    origemAmbiente: contexto.origemAmbiente || null,
    certificadoArquivo: contexto.certificadoPath
      ? String(contexto.certificadoPath).replace(/^.*[\\/]/, '')
      : null
  };
}

module.exports = {
  mascararCnpj,
  mascararChave,
  resolverEmpresaIdDocumento,
  permitirFallbackGlobalPorModo,
  obterContextoOperacionalDoDocumento,
  camposLogContextoDocumento
};
