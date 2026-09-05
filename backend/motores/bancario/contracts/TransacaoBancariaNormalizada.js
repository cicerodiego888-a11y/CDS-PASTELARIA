/**
 * DTO normalizado de transação bancária.
 * O motor opera neste contrato — nunca no payload bruto do banco.
 * @module motores/bancario/contracts/TransacaoBancariaNormalizada
 */
'use strict';

const { DIRECAO, ERROS, erroMbc, TIPOS_TRANSACAO } = require('./constantes');

function exigirEmpresaId(empresaId) {
  const id = Number(empresaId);
  if (!Number.isInteger(id) || id <= 0) {
    throw erroMbc(ERROS.EMPRESA_OBRIGATORIA, 'empresa_id é obrigatório no Motor Bancário.', 400);
  }
  return id;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseDirecao(v) {
  const s = String(v || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (s === 'entrada') return DIRECAO.ENTRADA;
  if (s === 'saida') return DIRECAO.SAIDA;
  if (s === 'transferencia') return DIRECAO.TRANSFERENCIA;
  throw erroMbc(ERROS.DIRECAO_INVALIDA, 'Direção inválida. Use ENTRADA, SAIDA ou TRANSFERENCIA.', 400);
}

function parseTipoTransacao(v) {
  if (v == null || String(v).trim() === '') return 'OUTROS';
  const t = String(v).trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (TIPOS_TRANSACAO.includes(t)) return t;
  throw erroMbc(ERROS.TIPO_TRANSACAO_INVALIDO, 'Tipo de transação inválido.', 400);
}

function textoOuNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * @param {object} input
 * @returns {object} transação normalizada (sem persistir)
 */
function normalizarTransacao(input = {}) {
  const empresaId = exigirEmpresaId(input.empresaId != null ? input.empresaId : input.empresa_id);
  const contaBancariaId = input.accountId != null ? input.accountId : input.conta_bancaria_id;
  const contaId = Number(contaBancariaId);
  if (!Number.isInteger(contaId) || contaId <= 0) {
    throw erroMbc(ERROS.DTO_INVALIDO, 'conta bancária (accountId) é obrigatória na transação normalizada.', 400);
  }

  const direcao = parseDirecao(input.direction || input.direcao);

  const externalId = textoOuNull(input.externalId != null ? input.externalId : input.external_id);
  const externalSource = textoOuNull(input.externalSource != null
    ? input.externalSource
    : input.external_source);

  const dataTransacao = input.dataTransacao || input.data_transacao || input.date || input.data || null;

  return Object.freeze({
    empresa_id: empresaId,
    conta_bancaria_id: contaId,
    data: dataTransacao,
    data_transacao: dataTransacao,
    data_processamento: input.dataProcessamento || input.data_processamento || null,
    valor: num(input.amount != null ? input.amount : input.valor),
    direcao,
    descricao: input.description != null ? String(input.description) : (input.descricao != null ? String(input.descricao) : ''),
    tipo: input.type || input.tipo || direcao,
    external_id: externalId,
    external_source: externalSource,
    saldo_apos_transacao: input.balanceAfterTransaction != null
      ? input.balanceAfterTransaction
      : (input.saldo_apos_transacao != null ? input.saldo_apos_transacao : null),
    referencia_externa: textoOuNull(input.reference != null ? input.reference : input.referencia_externa),
    observacao: textoOuNull(input.observacao),
    raw_reference: input.rawReference != null ? String(input.rawReference) : (input.raw_reference || null)
  });
}

/**
 * Chave de idempotência futura: empresa + conta + fonte + id externo.
 * Sem external_id: retorna null (estratégia alternativa documentada — hash de atributos).
 */
function chaveIdempotencia(params = {}) {
  const empresaId = exigirEmpresaId(params.empresaId != null ? params.empresaId : params.empresa_id);
  const contaId = Number(params.contaBancariaId != null ? params.contaBancariaId : params.conta_bancaria_id);
  const fonte = String(params.externalSource || params.external_source || '').trim();
  const ext = String(params.externalId || params.external_id || '').trim();
  if (!Number.isInteger(contaId) || contaId <= 0 || !fonte || !ext) {
    return null;
  }
  return `${empresaId}|${contaId}|${fonte}|${ext}`;
}

/**
 * Fallback conceitual quando a instituição não envia identificador estável.
 * Não persiste. Não substitui a chave canônica.
 */
function chaveIdempotenciaFallback(dto) {
  const n = normalizarTransacao(dto);
  return [
    n.empresa_id,
    n.conta_bancaria_id,
    n.data,
    n.valor,
    n.direcao,
    n.descricao
  ].join('|');
}

module.exports = {
  exigirEmpresaId,
  normalizarTransacao,
  chaveIdempotencia,
  chaveIdempotenciaFallback,
  parseDirecao,
  parseTipoTransacao,
  textoOuNull
};
