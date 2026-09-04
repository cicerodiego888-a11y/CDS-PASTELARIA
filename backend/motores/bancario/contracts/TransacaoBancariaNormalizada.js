/**
 * DTO normalizado de transação bancária.
 * O motor opera neste contrato — nunca no payload bruto do banco.
 * @module motores/bancario/contracts/TransacaoBancariaNormalizada
 */
'use strict';

const { DIRECAO, ERROS, erroMbc } = require('./constantes');

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

  const direcao = String(input.direction || input.direcao || '').toLowerCase();
  if (!Object.values(DIRECAO).includes(direcao)) {
    throw erroMbc(ERROS.DTO_INVALIDO, 'direction deve ser entrada, saida ou transferencia.', 400);
  }

  const externalId = input.externalId != null ? String(input.externalId) : (input.external_id != null ? String(input.external_id) : null);
  const externalSource = input.externalSource != null
    ? String(input.externalSource)
    : (input.external_source != null ? String(input.external_source) : null);

  return Object.freeze({
    empresa_id: empresaId,
    conta_bancaria_id: contaId,
    data: input.date || input.data || null,
    valor: num(input.amount != null ? input.amount : input.valor),
    direcao,
    descricao: input.description != null ? String(input.description) : (input.descricao != null ? String(input.descricao) : ''),
    tipo: input.type || input.tipo || direcao,
    external_id: externalId,
    external_source: externalSource,
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
  chaveIdempotenciaFallback
};
