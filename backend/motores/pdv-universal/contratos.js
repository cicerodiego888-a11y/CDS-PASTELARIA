/**
 * Contratos oficiais do PDV Universal (Sprint 05.01).
 * Sem UI, sem checkout, sem motor paralelo.
 */
'use strict';

const {
  ModoOperacaoVenda,
  DEFAULT_MODO_OPERACAO_VENDA,
  STATUS_ATENDIMENTO
} = require('../muv/contratos');

const CAMADA = 'PDV_UNIVERSAL';

const CICLO_MULTIEMPRESA = Object.freeze([
  STATUS_ATENDIMENTO.VALIDADO,
  STATUS_ATENDIMENTO.RESERVADO,
  STATUS_ATENDIMENTO.PAGO,
  STATUS_ATENDIMENTO.CONCLUIDO,
  STATUS_ATENDIMENTO.FISCALIZADO,
  STATUS_ATENDIMENTO.FISCAL_PARCIAL,
  STATUS_ATENDIMENTO.FISCAL_ERRO
]);

const CAPACIDADES_EMPRESA_UNICA = Object.freeze({
  multiempresa: false,
  atendimento: false,
  pagamento_unificado: false,
  fiscalizacao_por_empresa: false,
  comprovante_unificado: false,
  permite_selecao_empresa: true,
  exige_empresa_unica_para_checkout: true,
  permite_multiplas_empresas_no_atendimento: false,
  empresa_por_item: false,
  checkout_empresa_unica: true,
  checkout_multiempresa: false,
  pode_reservar_atendimento: false,
  pode_confirmar_pagamento_unificado: false,
  pode_cancelar_atendimento_reservado: false,
  pode_materializar_atendimento: false,
  pode_fiscalizar_atendimento: false,
  pode_visualizar_comprovante: false,
  pode_preparar_impressao: false,
  pode_iniciar_novo_atendimento: true
});

const CAPACIDADES_MULTIEMPRESA = Object.freeze({
  multiempresa: true,
  atendimento: true,
  pagamento_unificado: true,
  fiscalizacao_por_empresa: true,
  comprovante_unificado: true,
  permite_selecao_empresa: true,
  exige_empresa_unica_para_checkout: false,
  permite_multiplas_empresas_no_atendimento: true,
  empresa_por_item: true,
  checkout_empresa_unica: false,
  checkout_multiempresa: true,
  pode_reservar_atendimento: true,
  pode_confirmar_pagamento_unificado: true,
  pode_cancelar_atendimento_reservado: true,
  pode_materializar_atendimento: true,
  pode_fiscalizar_atendimento: true,
  pode_visualizar_comprovante: true,
  pode_preparar_impressao: true,
  pode_iniciar_novo_atendimento: true
});

function capacidadesParaModo(modo) {
  if (modo === ModoOperacaoVenda.MULTIEMPRESA) {
    return { ...CAPACIDADES_MULTIEMPRESA };
  }
  if (modo === ModoOperacaoVenda.EMPRESA_UNICA) {
    return { ...CAPACIDADES_EMPRESA_UNICA };
  }
  const err = new Error(`modo_operacao_venda inválido: ${modo}.`);
  err.code = 'MODO_OPERACAO_VENDA_INVALIDO';
  throw err;
}

const CAMPOS_SECRETOS_PROIBIDOS = Object.freeze([
  'token_csc',
  'csc',
  'senha_certificado',
  'certificado_senha',
  'certificado_pfx',
  'pfx',
  'path_certificado',
  'certificado_path'
]);

function dtoContemSegredo(obj, profundidade = 0) {
  if (!obj || typeof obj !== 'object' || profundidade > 8) return false;
  return Object.keys(obj).some((k) => {
    const kl = k.toLowerCase();
    if (CAMPOS_SECRETOS_PROIBIDOS.some((s) => kl === s || kl.includes('token_csc'))) {
      return true;
    }
    return dtoContemSegredo(obj[k], profundidade + 1);
  });
}

module.exports = {
  CAMADA,
  ModoOperacaoVenda,
  DEFAULT_MODO_OPERACAO_VENDA,
  CICLO_MULTIEMPRESA,
  CAPACIDADES_EMPRESA_UNICA,
  CAPACIDADES_MULTIEMPRESA,
  capacidadesParaModo,
  CAMPOS_SECRETOS_PROIBIDOS,
  dtoContemSegredo
};
