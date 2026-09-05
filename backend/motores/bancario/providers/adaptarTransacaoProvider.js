/**
 * Adapter: payload do provider → TransacaoBancariaNormalizada.
 * Provider não conhece schema SQLite. Sem SQL. Sem escrita financeira.
 * @module motores/bancario/providers/adaptarTransacaoProvider
 */
'use strict';

const { normalizarTransacao } = require('../contracts/TransacaoBancariaNormalizada');

function adaptarTransacaoDoProvider(item, contexto = {}) {
  const empresaId = contexto.empresaId != null ? contexto.empresaId : contexto.empresa_id;
  const contaId = contexto.contaBancariaId != null
    ? contexto.contaBancariaId
    : contexto.conta_bancaria_id;
  return normalizarTransacao({
    ...(item && typeof item === 'object' ? item : {}),
    empresaId,
    empresa_id: empresaId,
    accountId: contaId,
    conta_bancaria_id: contaId
  });
}

function adaptarPaginaDoProvider(bruto, contexto = {}) {
  const transacoesBrutas = Array.isArray(bruto)
    ? bruto
    : (Array.isArray(bruto && bruto.transacoes) ? bruto.transacoes : []);
  return {
    transacoes: transacoesBrutas.map((item) => adaptarTransacaoDoProvider(item, contexto)),
    has_more: Array.isArray(bruto) ? false : !!(bruto && bruto.has_more),
    next_cursor: Array.isArray(bruto)
      ? null
      : (bruto && bruto.next_cursor ? String(bruto.next_cursor) : null)
  };
}

module.exports = {
  adaptarTransacaoDoProvider,
  adaptarPaginaDoProvider
};
