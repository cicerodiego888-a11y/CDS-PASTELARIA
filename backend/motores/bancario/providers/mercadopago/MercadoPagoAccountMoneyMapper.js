/**
 * Mapper Dinheiro em conta (settlement_report) → DTO MBC.
 * Fonte oficial: relatório Account money / settlement_report.
 *
 * Decisões documentadas:
 * - external_id = SOURCE_ID (identificador da operação nos sistemas MP)
 * - referencia = EXTERNAL_REFERENCE (quando existir; não substitui SOURCE_ID)
 * - valor = |SETTLEMENT_NET_AMOUNT| (impacto líquido no dinheiro em conta)
 * - direção = sinal de SETTLEMENT_NET_AMOUNT (>=0 entrada; <0 saída)
 *   com reforço por TRANSACTION_TYPE (withdrawal/refund/chargeback → saída)
 *
 * @module motores/bancario/providers/mercadopago/MercadoPagoAccountMoneyMapper
 */
'use strict';

const { ERROS, erroMbc, CATEGORIA_ERRO_PROVIDER } = require('../../contracts/constantes');
const { adaptarTransacaoDoProvider } = require('../adaptarTransacaoProvider');

const EXTERNAL_SOURCE = 'MERCADO_PAGO_SETTLEMENT_REPORT';

const COLUNAS_CONFIG = Object.freeze([
  { key: 'TRANSACTION_DATE' },
  { key: 'SETTLEMENT_DATE' },
  { key: 'SOURCE_ID' },
  { key: 'EXTERNAL_REFERENCE' },
  { key: 'TRANSACTION_TYPE' },
  { key: 'TRANSACTION_AMOUNT' },
  { key: 'SETTLEMENT_NET_AMOUNT' },
  { key: 'SETTLEMENT_CURRENCY' },
  { key: 'REAL_AMOUNT' }
]);

function parseCsvLinha(line, sep) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQ = !inQ;
      }
    } else if ((ch === sep) && !inQ) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function detectarSeparador(headerLine) {
  if (headerLine.includes(';') && headerLine.split(';').length >= headerLine.split(',').length) {
    return ';';
  }
  return ',';
}

function parseCsv(texto) {
  const raw = String(texto || '').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/).filter((l) => String(l).trim() !== '');
  if (!lines.length) return [];
  const sep = detectarSeparador(lines[0]);
  const headers = parseCsvLinha(lines[0], sep).map((h) => String(h || '').trim().toUpperCase());
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = parseCsvLinha(lines[i], sep);
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = cols[idx] != null ? String(cols[idx]).trim() : '';
    });
    rows.push(obj);
  }
  return rows;
}

function numCampo(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function tipoSugereSaida(tipo) {
  const t = String(tipo || '').toLowerCase();
  return /withdraw|refund|chargeback|payout|debit|saque|estorno|retirada/.test(t);
}

function tipoSugereEntrada(tipo) {
  const t = String(tipo || '').toLowerCase();
  return /settlement|payment|credit|release|receb|pago/.test(t);
}

/**
 * @returns {{ direcao: 'entrada'|'saida', valor: number, liquido: number }}
 */
function resolverValorDirecao(row) {
  const liquido = numCampo(row.SETTLEMENT_NET_AMOUNT);
  if (liquido == null) {
    const err = erroMbc(
      ERROS.DTO_INVALIDO,
      'Movimentação sem SETTLEMENT_NET_AMOUNT — impacto financeiro não confirmável.',
      400
    );
    err.categoria = CATEGORIA_ERRO_PROVIDER.DADOS_INVALIDOS;
    throw err;
  }
  let direcao;
  if (liquido < 0) direcao = 'saida';
  else if (liquido > 0) direcao = 'entrada';
  else {
    // zero líquido: usar tipo se possível
    if (tipoSugereSaida(row.TRANSACTION_TYPE)) direcao = 'saida';
    else if (tipoSugereEntrada(row.TRANSACTION_TYPE)) direcao = 'entrada';
    else {
      const err = erroMbc(
        ERROS.DTO_INVALIDO,
        'Movimentação com impacto zero e tipo não classificável com segurança.',
        400
      );
      err.categoria = CATEGORIA_ERRO_PROVIDER.DADOS_INVALIDOS;
      throw err;
    }
  }
  if (tipoSugereSaida(row.TRANSACTION_TYPE) && liquido > 0) {
    // tipo oficial de saída prevalece sobre sinal ambíguo raro
    direcao = 'saida';
  }
  return {
    direcao,
    valor: Math.abs(liquido),
    liquido
  };
}

function mapearLinhaRelatorio(row, contexto = {}) {
  const sourceId = row.SOURCE_ID != null ? String(row.SOURCE_ID).trim() : '';
  if (!sourceId) {
    const err = erroMbc(
      ERROS.DTO_INVALIDO,
      'Movimentação sem SOURCE_ID — identificador externo obrigatório ausente.',
      400
    );
    err.categoria = CATEGORIA_ERRO_PROVIDER.DADOS_INVALIDOS;
    throw err;
  }
  const { direcao, valor } = resolverValorDirecao(row);
  const moeda = row.SETTLEMENT_CURRENCY != null ? String(row.SETTLEMENT_CURRENCY).trim().toUpperCase() : '';
  if (moeda && moeda !== 'BRL') {
    const err = erroMbc(
      ERROS.DTO_INVALIDO,
      'Moeda incompatível com o contrato MBC atual (somente BRL). Conversão não implementada.',
      400
    );
    err.categoria = CATEGORIA_ERRO_PROVIDER.DADOS_INVALIDOS;
    throw err;
  }
  const dataTx = row.TRANSACTION_DATE || row.SETTLEMENT_DATE || null;
  const dataProc = row.SETTLEMENT_DATE || row.TRANSACTION_DATE || null;
  const descricao = [
    row.TRANSACTION_TYPE || '',
    row.EXTERNAL_REFERENCE || ''
  ].filter(Boolean).join(' · ') || 'Movimentação Mercado Pago';

  const rawSafe = JSON.stringify({
    source_id: sourceId,
    external_reference: row.EXTERNAL_REFERENCE || null,
    transaction_type: row.TRANSACTION_TYPE || null,
    settlement_currency: row.SETTLEMENT_CURRENCY || null,
    transaction_amount: row.TRANSACTION_AMOUNT || null,
    settlement_net_amount: row.SETTLEMENT_NET_AMOUNT || null
  });

  return adaptarTransacaoDoProvider({
    external_id: sourceId,
    external_source: EXTERNAL_SOURCE,
    data_transacao: dataTx,
    data_processamento: dataProc,
    valor,
    direcao,
    descricao,
    referencia_externa: row.EXTERNAL_REFERENCE || null,
    saldo_apos_transacao: null,
    raw_reference: rawSafe,
    tipo: 'OUTROS'
  }, contexto);
}

function mapearCsvParaDtos(csvTexto, contexto = {}) {
  const rows = parseCsv(csvTexto);
  const transacoes = [];
  const rejeitadas = [];
  for (const row of rows) {
    try {
      transacoes.push(mapearLinhaRelatorio(row, contexto));
    } catch (err) {
      rejeitadas.push({
        source_id: row.SOURCE_ID || null,
        motivo: err.message || 'erro_normalizacao'
      });
    }
  }
  return { transacoes, rejeitadas, total_linhas: rows.length };
}

module.exports = {
  EXTERNAL_SOURCE,
  COLUNAS_CONFIG,
  parseCsv,
  mapearLinhaRelatorio,
  mapearCsvParaDtos,
  resolverValorDirecao
};
