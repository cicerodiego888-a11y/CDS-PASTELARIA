/**
 * Constantes conceituais do Motor Bancário (MBC-01).
 * Sem persistência. Sem Open Finance.
 * @module motores/bancario/contracts/constantes
 */
'use strict';

const DIRECAO = Object.freeze({
  ENTRADA: 'entrada',
  SAIDA: 'saida',
  TRANSFERENCIA: 'transferencia'
});

const STATUS_CONCILIACAO = Object.freeze({
  PENDENTE: 'pendente',
  CONCILIADA: 'conciliada',
  IGNORADA: 'ignorada',
  DIVERGENTE: 'divergente'
});

const ORIGEM_TRANSACAO = Object.freeze({
  MANUAL: 'manual',
  PROVIDER: 'provider',
  OPEN_FINANCE: 'open_finance',
  OFX: 'ofx'
});

const NATUREZA_TRANSFERENCIA = Object.freeze({
  INTERNA: 'interna',
  INTEREMPRESA: 'interempresa'
});

const SALDO = Object.freeze({
  INFORMADO_BANCO: 'informado_banco',
  CALCULADO_SISTEMA: 'calculado_sistema'
});

const ERROS = Object.freeze({
  EMPRESA_OBRIGATORIA: 'MBC_EMPRESA_OBRIGATORIA',
  NAO_IMPLEMENTADO: 'MBC_NAO_IMPLEMENTADO',
  SINCRONIZACAO_FORA_ESCOPO: 'MBC_SINCRONIZACAO_FORA_ESCOPO',
  CONCILIACAO_FORA_ESCOPO: 'MBC_CONCILIACAO_FORA_ESCOPO',
  DTO_INVALIDO: 'MBC_DTO_INVALIDO',
  IDEMPOTENCIA_INCOMPLETA: 'MBC_IDEMPOTENCIA_INCOMPLETA'
});

function erroMbc(code, message, statusCode = 400) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

module.exports = {
  DIRECAO,
  STATUS_CONCILIACAO,
  ORIGEM_TRANSACAO,
  NATUREZA_TRANSFERENCIA,
  SALDO,
  ERROS,
  erroMbc
};
