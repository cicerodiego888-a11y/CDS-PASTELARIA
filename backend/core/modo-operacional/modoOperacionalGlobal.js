/**
 * Ponto único de resolução do Modo Operacional Global (Sprint 05.38.B).
 *
 * @module core/modo-operacional/modoOperacionalGlobal
 */
'use strict';

const {
  validarModoOperacionalGlobal,
  DEFAULT_MODO_OPERACIONAL_GLOBAL,
  CODIGO_MODO_OPERACIONAL_GLOBAL_INVALIDO
} = require('./contratos');

function sanitizarOpcoesResolucao(opcoes) {
  if (!opcoes || typeof opcoes !== 'object') return {};
  if (typeof opcoes.obterModoOperacionalGlobal === 'function') {
    return { obterModoOperacionalGlobal: opcoes.obterModoOperacionalGlobal };
  }
  if (opcoes.configService && typeof opcoes.configService.obterModoOperacionalGlobal === 'function') {
    return {
      obterModoOperacionalGlobal: () => opcoes.configService.obterModoOperacionalGlobal()
    };
  }
  return {};
}

function obterModoOperacionalGlobal(cfg) {
  const configService = require('../../services/configuracaoService');
  return configService.obterModoOperacionalGlobal(cfg);
}

function resolverModoOperacionalGlobalAtivo(opcoes = {}) {
  const limpo = sanitizarOpcoesResolucao(opcoes);
  if (typeof limpo.obterModoOperacionalGlobal === 'function') {
    return validarModoOperacionalGlobal(limpo.obterModoOperacionalGlobal());
  }
  return obterModoOperacionalGlobal();
}

module.exports = {
  DEFAULT_MODO_OPERACIONAL_GLOBAL,
  CODIGO_MODO_OPERACIONAL_GLOBAL_INVALIDO,
  sanitizarOpcoesResolucao,
  obterModoOperacionalGlobal,
  resolverModoOperacionalGlobalAtivo,
  validarModoOperacionalGlobal
};
