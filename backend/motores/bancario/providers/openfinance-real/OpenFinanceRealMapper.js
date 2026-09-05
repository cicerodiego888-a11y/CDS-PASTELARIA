/**
 * Mapper genérico: payload do provider → contratos MBC.
 * Sem SQL. Sem nomes de instituição específica.
 * @module motores/bancario/providers/openfinance-real/OpenFinanceRealMapper
 */
'use strict';

const { ERROS, erroMbc, CATEGORIA_ERRO_PROVIDER } = require('../../contracts/constantes');
const { adaptarTransacaoDoProvider } = require('../adaptarTransacaoProvider');
const { CODIGO } = require('./OpenFinanceRealConstants');

function mapearConta(bruto = {}, contexto = {}) {
  return {
    empresa_id: contexto.empresaId || null,
    identificador_externo: bruto.accountId || bruto.id || bruto.identificador_externo || null,
    nome: bruto.nickname || bruto.name || bruto.nome || null,
    tipo: bruto.type || bruto.tipo || null,
    numero: bruto.number || bruto.numero || null
  };
}

function mapearSaldo(bruto = {}) {
  const valor = Number(bruto.availableAmount != null
    ? bruto.availableAmount
    : (bruto.valor != null ? bruto.valor : bruto.saldo));
  return {
    valor: Number.isFinite(valor) ? Math.round(valor * 100) / 100 : null,
    data: bruto.date || bruto.data || null,
    natureza: 'informado_banco'
  };
}

function identificadorExterno(item = {}) {
  return item.transactionId || item.external_id || item.externalId || item.transactionIdentifier || null;
}

function mapearTransacao(item, contexto = {}) {
  const ext = identificadorExterno(item);
  if (!ext || !String(ext).trim()) {
    const err = erroMbc(
      ERROS.DTO_INVALIDO,
      'Transação sem identificador externo confiável. Importação interrompida para este item.',
      400
    );
    err.categoria = CATEGORIA_ERRO_PROVIDER.DADOS_INVALIDOS;
    throw err;
  }
  return adaptarTransacaoDoProvider({
    ...item,
    amount: item.amount != null ? item.amount : item.valor,
    direction: item.creditDebitType === 'DEBIT' ? 'saida' : (item.direction || item.direcao || 'entrada'),
    date: item.transactionDateTime || item.date || item.data,
    description: item.transactionName || item.description || item.descricao,
    type: item.type || item.tipo,
    external_id: ext,
    external_source: CODIGO,
    reference: item.reference || item.referencia_externa || item.endToEndId
  }, contexto);
}

function mapearPagina(bruto, contexto = {}) {
  const lista = Array.isArray(bruto)
    ? bruto
    : (Array.isArray(bruto && bruto.transacoes) ? bruto.transacoes : (bruto && bruto.data) || []);
  const transacoes = lista.map((item) => mapearTransacao(item, contexto));
  const next = bruto && (bruto.next_cursor || bruto.nextCursor || (bruto.links && bruto.links.next) || bruto.next);
  return {
    transacoes,
    has_more: Array.isArray(bruto) ? false : !!(bruto && (bruto.has_more || bruto.hasMore || next)),
    next_cursor: next ? String(next) : null
  };
}

module.exports = {
  mapearConta,
  mapearSaldo,
  mapearTransacao,
  mapearPagina,
  identificadorExterno
};
