/**
 * Ponto único de resolução do modo de operação de venda (Sprint 04.02).
 * Sem orquestração multiempresa: só reconhece o modo e despacha executores.
 *
 * @module motores/muv/modoOperacaoVenda
 */
'use strict';

const {
  ModoOperacaoVenda,
  validarModoOperacaoVenda,
  DEFAULT_MODO_OPERACAO_VENDA
} = require('./contratos');

const CODIGO_MODO_OPERACAO_VENDA_NAO_IMPLEMENTADO = 'MODO_OPERACAO_VENDA_NAO_IMPLEMENTADO';

function erroModo(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Express passa `next` como 3º argumento de criarVenda. Ignorar funções e
 * qualquer objeto que não seja injeção explícita de leitura do modo.
 */
function sanitizarOpcoesResolucao(opcoes) {
  if (!opcoes || typeof opcoes !== 'object') return {};
  if (typeof opcoes.obterModoOperacaoVenda === 'function') {
    return { obterModoOperacaoVenda: opcoes.obterModoOperacaoVenda };
  }
  if (opcoes.configService && typeof opcoes.configService.obterModoOperacaoVenda === 'function') {
    return {
      obterModoOperacaoVenda: () => opcoes.configService.obterModoOperacaoVenda()
    };
  }
  return {};
}

/**
 * Único ponto operacional: lê a configuração oficial e devolve
 * EMPRESA_UNICA | MULTIEMPRESA. Não lê body/query/CNPJ.
 */
function resolverModoOperacaoVendaAtivo(opcoes = {}) {
  const limpo = sanitizarOpcoesResolucao(opcoes);
  if (typeof limpo.obterModoOperacaoVenda === 'function') {
    return validarModoOperacaoVenda(limpo.obterModoOperacaoVenda());
  }
  const configService = require('../../services/configuracaoService');
  return configService.obterModoOperacaoVenda();
}

/**
 * Despacho único. MULTIEMPRESA sem executor NÃO cai em EMPRESA_UNICA.
 */
function executarNoModoOperacaoVenda(modo, executores = {}) {
  const m = validarModoOperacaoVenda(modo);
  if (m === ModoOperacaoVenda.EMPRESA_UNICA) {
    if (typeof executores.EMPRESA_UNICA !== 'function') {
      throw erroModo(
        'MODO_OPERACAO_VENDA_EXECUTOR_AUSENTE',
        'Executor EMPRESA_UNICA não informado.'
      );
    }
    return executores.EMPRESA_UNICA();
  }
  if (m === ModoOperacaoVenda.MULTIEMPRESA) {
    if (typeof executores.MULTIEMPRESA === 'function') {
      return executores.MULTIEMPRESA();
    }
    throw erroModo(
      CODIGO_MODO_OPERACAO_VENDA_NAO_IMPLEMENTADO,
      'Modo MULTIEMPRESA reconhecido. Orquestração de atendimento multiempresa ainda não implementada.'
    );
  }
  throw erroModo(
    'MODO_OPERACAO_VENDA_INVALIDO',
    `modo_operacao_venda inválido: ${m}.`
  );
}

module.exports = {
  DEFAULT_MODO_OPERACAO_VENDA,
  CODIGO_MODO_OPERACAO_VENDA_NAO_IMPLEMENTADO,
  sanitizarOpcoesResolucao,
  resolverModoOperacaoVendaAtivo,
  executarNoModoOperacaoVenda
};
