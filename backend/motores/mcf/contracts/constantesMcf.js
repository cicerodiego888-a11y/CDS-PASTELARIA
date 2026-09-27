/**
 * Constantes oficiais do MCF — Fundação (MCF-01).
 * @module motores/mcf/contracts/constantesMcf
 */
'use strict';

const STATUS_CONTA_PAGAR = Object.freeze({
  ABERTA: 'aberto',
  PARCIAL: 'parcial',
  QUITADA: 'quitada',
  CANCELADA: 'cancelada'
});

const ERROS_MCF = Object.freeze({
  EMPRESA_OBRIGATORIA: 'MCF_EMPRESA_OBRIGATORIA',
  VALOR_INVALIDO: 'MCF_VALOR_INVALIDO',
  DATA_INVALIDA: 'MCF_DATA_INVALIDA',
  CONTA_NAO_ENCONTRADA: 'MCF_CONTA_PAGAR_NAO_ENCONTRADA',
  FORNECEDOR_NAO_ENCONTRADO: 'MCF_FORNECEDOR_NAO_ENCONTRADO',
  STATUS_INVALIDO: 'MCF_STATUS_INVALIDO',
  BAIXA_EXCEDE_RESTANTE: 'MCF_BAIXA_EXCEDE_RESTANTE',
  TITULO_CANCELADO: 'MCF_TITULO_CANCELADO',
  TITULO_QUITADO: 'MCF_TITULO_QUITADO',
  INCONSISTENCIA: 'MCF_INCONSISTENCIA'
});

function erroMcf(code, message, statusCode = 400, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  Object.assign(err, extra);
  return err;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

module.exports = {
  STATUS_CONTA_PAGAR,
  ERROS_MCF,
  erroMcf,
  round2,
  VERSAO_MCF: Object.freeze({
    MOTOR: 'MCF',
    SPRINT: 'MCF-01',
    DESCRICAO: 'Fundação Contas a Pagar'
  })
};
