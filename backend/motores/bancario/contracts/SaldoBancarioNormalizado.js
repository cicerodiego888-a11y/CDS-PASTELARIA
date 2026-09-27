/**
 * DTO normalizado de saldo bancário informado pelo provider.
 * Natureza: informado_banco — não confundir com saldo conceitual MBC.
 * @module motores/bancario/contracts/SaldoBancarioNormalizado
 */
'use strict';

const { ERROS, erroMbc } = require('./constantes');
const { exigirEmpresaId } = require('./TransacaoBancariaNormalizada');

function numOuNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function textoOuNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * @param {object} input
 * @returns {object} saldo normalizado (sem persistir)
 */
function normalizarSaldoBancario(input = {}) {
  const empresaId = exigirEmpresaId(input.empresaId != null ? input.empresaId : input.empresa_id);
  const contaId = Number(input.contaBancariaId != null ? input.contaBancariaId : input.conta_bancaria_id);
  if (!Number.isInteger(contaId) || contaId <= 0) {
    throw erroMbc(ERROS.DTO_INVALIDO, 'conta_bancaria_id é obrigatório no saldo normalizado.', 400);
  }

  const available = numOuNull(
    input.available_balance != null ? input.available_balance : input.availableBalance
  );
  const current = numOuNull(
    input.current_balance != null ? input.current_balance : input.currentBalance
  );
  const legado = numOuNull(input.valor != null ? input.valor : input.saldo);
  const available_balance = available != null ? available : (current == null ? legado : null);
  const current_balance = current != null ? current : (available == null ? legado : null);
  const valor = available_balance != null ? available_balance : current_balance;

  const asOf = textoOuNull(input.as_of || input.asOf || input.data || input.date)
    || new Date().toISOString();
  const currency = String(input.currency || input.moeda || 'BRL').trim().toUpperCase() || 'BRL';

  return Object.freeze({
    empresa_id: empresaId,
    conta_bancaria_id: contaId,
    provider: textoOuNull(input.provider),
    institution: textoOuNull(input.institution || input.instituicao),
    external_account_id: textoOuNull(
      input.external_account_id || input.externalAccountId || input.account_id
    ),
    available_balance,
    current_balance,
    currency,
    as_of: asOf,
    source: textoOuNull(input.source) || 'PROVIDER',
    natureza: 'informado_banco',
    raw_reference: textoOuNull(input.raw_reference || input.rawReference),
    // Compatível com SincronizacaoBancariaService.buscarSaldo
    valor,
    data: String(asOf).slice(0, 10),
    saldo: valor
  });
}

module.exports = {
  normalizarSaldoBancario
};
