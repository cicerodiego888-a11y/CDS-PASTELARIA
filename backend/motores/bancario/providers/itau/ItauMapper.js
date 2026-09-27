/**
 * Mapper Itaú → DTOs MBC (saldo + movimentações).
 * Sem SQL. Sem persistência. Sem inventar valores.
 * @module motores/bancario/providers/itau/ItauMapper
 */
'use strict';

const { ERROS, erroMbc, CATEGORIA_ERRO_PROVIDER } = require('../../contracts/constantes');
const { normalizarSaldoBancario } = require('../../contracts/SaldoBancarioNormalizado');
const { adaptarTransacaoDoProvider } = require('../adaptarTransacaoProvider');
const { CODIGO, EXTERNAL_SOURCE, NOME } = require('./ItauConstants');

function primeiroDefinido(...vals) {
  for (let i = 0; i < vals.length; i += 1) {
    if (vals[i] != null && vals[i] !== '') return vals[i];
  }
  return null;
}

function mapearDirecaoItau(item = {}) {
  const raw = primeiroDefinido(
    item.direction,
    item.direcao,
    item.creditDebitType,
    item.creditDebitIndicator,
    item.tipo_lancamento,
    item.tipoLancamento,
    item.nature,
    item.natureza
  );
  const s = String(raw || '').trim().toUpperCase();
  if (!s) return null;
  if (s === 'CREDIT' || s === 'C' || s === 'CREDITO' || s === 'CRÉDITO' || s === 'ENTRADA') {
    return 'CREDIT';
  }
  if (s === 'DEBIT' || s === 'D' || s === 'DEBITO' || s === 'DÉBITO' || s === 'SAIDA' || s === 'SAÍDA') {
    return 'DEBIT';
  }
  // Valor com sinal (último recurso, documentado)
  const amt = Number(item.amount != null ? item.amount : item.valor);
  if (Number.isFinite(amt) && amt < 0) return 'DEBIT';
  if (Number.isFinite(amt) && amt > 0 && /sinal|signed/i.test(String(item.amount_type || ''))) {
    return 'CREDIT';
  }
  return raw;
}

function identificadorExterno(item = {}) {
  return primeiroDefinido(
    item.transactionId,
    item.transaction_id,
    item.id,
    item.external_id,
    item.externalId,
    item.identificador,
    item.codigo_lancamento,
    item.endToEndId
  );
}

function mapearSaldo(bruto = {}, contexto = {}) {
  const data = bruto.data || bruto;
  const available = primeiroDefinido(
    data.available_balance,
    data.availableBalance,
    data.availableAmount,
    data.saldo_disponivel,
    data.available
  );
  const current = primeiroDefinido(
    data.current_balance,
    data.currentBalance,
    data.currentAmount,
    data.saldo_atual,
    data.balance,
    data.saldo,
    data.valor
  );
  return normalizarSaldoBancario({
    empresa_id: contexto.empresaId != null ? contexto.empresaId : contexto.empresa_id,
    conta_bancaria_id: contexto.contaBancariaId != null
      ? contexto.contaBancariaId
      : contexto.conta_bancaria_id,
    provider: CODIGO,
    institution: NOME,
    external_account_id: primeiroDefinido(
      contexto.external_account_id,
      data.accountId,
      data.account_id,
      data.conta
    ),
    available_balance: available,
    current_balance: current,
    currency: primeiroDefinido(data.currency, data.moeda, 'BRL'),
    as_of: primeiroDefinido(
      data.as_of,
      data.asOf,
      data.referenceDate,
      data.date,
      data.data,
      data.data_saldo
    ),
    source: 'PROVIDER',
    raw_reference: data.raw_reference || null
  });
}

function mapearTransacao(item, contexto = {}) {
  const ext = identificadorExterno(item);
  if (!ext || !String(ext).trim()) {
    const err = erroMbc(
      ERROS.DTO_INVALIDO,
      'Movimentação Itaú sem identificador externo confiável.',
      400
    );
    err.categoria = CATEGORIA_ERRO_PROVIDER.DADOS_INVALIDOS;
    err.errorCode = 'EXTERNAL_ID_AUSENTE';
    throw err;
  }

  const dirNorm = mapearDirecaoItau(item);
  if (!dirNorm) {
    const err = erroMbc(ERROS.DIRECAO_INVALIDA, 'Movimentação Itaú sem direção CREDIT/DEBIT.', 400);
    err.errorCode = 'DIRECAO_AUSENTE';
    throw err;
  }

  let amount = Number(item.amount != null ? item.amount : item.valor);
  if (!Number.isFinite(amount)) {
    const err = erroMbc(ERROS.VALOR_INVALIDO, 'Movimentação Itaú com valor inválido.', 400);
    err.errorCode = 'VALOR_INVALIDO';
    throw err;
  }
  amount = Math.abs(amount);

  const transactionDate = primeiroDefinido(
    item.transaction_date,
    item.transactionDate,
    item.transactionDateTime,
    item.data_lancamento,
    item.date,
    item.data
  );
  const postingDate = primeiroDefinido(
    item.posting_date,
    item.postingDate,
    item.data_processamento,
    item.valueDate
  );

  return adaptarTransacaoDoProvider({
    amount,
    valor: amount,
    direction: dirNorm,
    date: transactionDate,
    data_transacao: transactionDate,
    data_processamento: postingDate,
    description: primeiroDefinido(
      item.description,
      item.descricao,
      item.historico,
      item.transactionName,
      item.memo
    ),
    type: item.type || item.tipo || 'OUTROS',
    external_id: String(ext).trim(),
    external_source: EXTERNAL_SOURCE,
    reference: primeiroDefinido(
      item.external_reference,
      item.referencia_externa,
      item.reference,
      item.endToEndId
    ),
    balanceAfterTransaction: primeiroDefinido(
      item.balance_after,
      item.balanceAfter,
      item.saldo_apos_transacao,
      item.saldo
    ),
    raw_reference: item.raw_reference || null
  }, contexto);
}

function mapearPagina(bruto, contexto = {}) {
  const lista = Array.isArray(bruto)
    ? bruto
    : (Array.isArray(bruto && bruto.transacoes)
      ? bruto.transacoes
      : (Array.isArray(bruto && bruto.data)
        ? bruto.data
        : (Array.isArray(bruto && bruto.items) ? bruto.items : [])));
  const transacoes = lista.map((item) => mapearTransacao(item, contexto));
  const next = bruto && (
    bruto.next_cursor
    || bruto.nextCursor
    || (bruto.links && bruto.links.next)
    || bruto.next
  );
  return {
    transacoes,
    has_more: Array.isArray(bruto) ? false : !!(bruto && (bruto.has_more || bruto.hasMore || next)),
    next_cursor: next ? String(next) : null
  };
}

module.exports = {
  mapearSaldo,
  mapearTransacao,
  mapearPagina,
  mapearDirecaoItau,
  identificadorExterno,
  EXTERNAL_SOURCE
};
