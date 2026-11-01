'use strict';

/**
 * Sprint 23 — avalia a lista completa de parcelas sequenciais
 * com o contrato e a tolerância de dinheiro já existentes.
 *
 * Não cria motor, não habilita produção e não converte margem em desconto.
 * O valor fiscal oficial continua a cargo do distribuidor F×NF no fechamento.
 */

const {
  RECOMPOSICAO_HABILITADA_EM_PRODUCAO,
  prepararContratoRecomposicaoFiscal,
  formaEhDinheiro
} = require('./RecomposicaoFiscalContratoService');
const {
  calcularMargemToleranciaDinheiro
} = require('./RecomposicaoFiscalToleranciaDinheiroSimulacaoService');
const {
  avaliarCandidatoComBuscarComposicao
} = require('./RecomposicaoFiscalComposicaoMotorSimulacaoService');
const { formaPagamentoUsaTEF } = require('../tef/tefFluxoPagamento');

const STATUS_NAO_CONFIRMADO = new Set([
  'pendente',
  'rejeitada',
  'rejeitado',
  'falha',
  'negado',
  'negada'
]);

const ENV_REFERENCIA_TESTE = 'CDS_RECOMPOSICAO_REFERENCIA_TESTE';

function arredondar(valor) {
  return Math.round((Number(valor) + Number.EPSILON) * 100) / 100;
}

function ambienteTesteRecomposicaoReferencia(env = process.env) {
  return String(env[ENV_REFERENCIA_TESTE] || '') === '1'
    && RECOMPOSICAO_HABILITADA_EM_PRODUCAO !== true;
}

function parcelaManualDeDinheiro(pagamento) {
  if (!formaEhDinheiro(pagamento && pagamento.forma_pagamento)) return false;
  const status = String(pagamento.status_autorizacao || pagamento.status || '').toLowerCase();
  if (STATUS_NAO_CONFIRMADO.has(status)) return false;
  return status === 'informada'
    || status === 'aprovada'
    || status === 'aprovado'
    || status === ''
    || pagamento.confirmacao_manual === 1
    || pagamento.confirmacao_manual === true
    || pagamento.confirmacao_modalidade === 'manual'
    || pagamento.tipo_recebimento === 'nao_fiscal';
}

function classificarTipoRecebimento(pagamento) {
  if (!parcelaEfetivamenteConfirmada(pagamento)) return null;
  if (formaEhDinheiro(pagamento.forma_pagamento)) return 'nao_fiscal';
  if (formaPagamentoUsaTEF(pagamento.forma_pagamento)) return 'fiscal';
  return null;
}

function parcelaEfetivamenteConfirmada(pagamento) {
  if (!pagamento || !(Number(pagamento.valor) > 0)) return false;
  const status = String(pagamento.status_autorizacao || pagamento.status || '').toLowerCase();
  if (STATUS_NAO_CONFIRMADO.has(status)) return false;
  if (parcelaManualDeDinheiro(pagamento)) return true;
  if (pagamento.aprovado === false) return false;
  return true;
}

function calcularReferenciasConfirmadas(pagamentos) {
  let fiscal = 0;
  let naoFiscal = 0;
  for (const pagamento of pagamentos || []) {
    if (!parcelaEfetivamenteConfirmada(pagamento)) continue;
    const valor = Number(pagamento.valor) || 0;
    if (formaEhDinheiro(pagamento.forma_pagamento)) naoFiscal += valor;
    else if (formaPagamentoUsaTEF(pagamento.forma_pagamento)) fiscal += valor;
  }
  return {
    valor_fiscal_referencia: arredondar(fiscal),
    valor_nao_fiscal_referencia: arredondar(naoFiscal)
  };
}

function avaliarPagamentosSequenciais(entrada = {}) {
  const pagamentos = Array.isArray(entrada.pagamentos) ? entrada.pagamentos : [];
  const contrato = prepararContratoRecomposicaoFiscal({
    total_comercial: entrada.total_comercial != null ? entrada.total_comercial : entrada.total,
    total_financeiro: entrada.total_financeiro != null ? entrada.total_financeiro : entrada.total,
    pagamentos,
    itens: Array.isArray(entrada.itens) ? entrada.itens : []
  });

  const margem = calcularMargemToleranciaDinheiro(pagamentos);
  const temDinheiro = pagamentos.some((pagamento) => formaEhDinheiro(pagamento && pagamento.forma_pagamento));

  return Object.freeze({
    sucesso: true,
    composicao_validada: true,
    total_comercial: contrato.total_comercial,
    total_financeiro: contrato.total_financeiro_recebido,
    pagamentos: contrato.pagamentos,
    quantidade_parcelas: contrato.pagamentos.length,
    inclui_dinheiro: temDinheiro,
    margem_dinheiro: margem,
    valor_fiscal_candidato: null,
    valor_fiscal_presumido: false,
    margem_convertida_em_desconto: false,
    recomposicao_habilitada_em_producao: RECOMPOSICAO_HABILITADA_EM_PRODUCAO === true,
    aplica_ao_fluxo_oficial: false,
    autoridade: 'backend'
  });
}

function avaliarReferenciaRecomposicao(entrada = {}, opcoes = {}) {
  const base = avaliarPagamentosSequenciais(entrada);
  const env = opcoes.env || process.env;
  if (!ambienteTesteRecomposicaoReferencia(env)) {
    return Object.freeze({
      ...base,
      recomposicao_executada: false,
      valor_fiscal_referencia: null,
      valor_nao_fiscal_referencia: null,
      distribuicao_oficial_alterada: false,
      motivo_recomposicao: 'ambiente_teste_desligado'
    });
  }

  const referencias = calcularReferenciasConfirmadas(entrada.pagamentos);
  const fiscal = referencias.valor_fiscal_referencia;
  const naoFiscal = referencias.valor_nao_fiscal_referencia;
  if (!(fiscal > 0) && !(naoFiscal > 0)) {
    return Object.freeze({
      ...base,
      recomposicao_executada: false,
      valor_fiscal_referencia: null,
      valor_nao_fiscal_referencia: null,
      distribuicao_oficial_alterada: false,
      motivo_recomposicao: 'sem_parcela_confirmada'
    });
  }
  const avaliacao = avaliarCandidatoComBuscarComposicao({
    valorFiscalCandidato: fiscal,
    margemMaxima: base.margem_dinheiro && base.margem_dinheiro.margem_maxima,
    modelos: [],
    capacidadePorCategoria: {}
  });
  return Object.freeze({
    ...base,
    recomposicao_executada: true,
    valor_fiscal_referencia: fiscal,
    valor_nao_fiscal_referencia: naoFiscal,
    valor_fiscal_candidato: fiscal,
    aplica_ao_fluxo_oficial: false,
    distribuicao_oficial_alterada: false,
    motivo_recomposicao: 'formas_confirmadas',
    avaliacao_motor: Object.freeze({
      codigo: avaliacao.codigo || null,
      distribuicao_possivel: avaliacao.distribuicao_possivel === true,
      aplica_ao_fluxo_oficial: false,
      recomposicao_habilitada_em_producao: false,
      motor: avaliacao.motor
    })
  });
}

function gravarReferenciaRecomposicao(dbConnection, vendaId, avaliacao) {
  if (!avaliacao || avaliacao.recomposicao_executada !== true) {
    return Promise.resolve(null);
  }
  if (RECOMPOSICAO_HABILITADA_EM_PRODUCAO === true) {
    return Promise.resolve(null);
  }
  const sqlTabela = `
    CREATE TABLE IF NOT EXISTS venda_composicao_referencia (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venda_id INTEGER NOT NULL UNIQUE,
      total_financeiro REAL NOT NULL,
      dinheiro_recebido REAL NOT NULL,
      valor_fiscal_referencia REAL NOT NULL,
      valor_nao_fiscal_referencia REAL NOT NULL,
      motor_codigo TEXT,
      distribuicao_possivel INTEGER NOT NULL DEFAULT 0,
      aplica_ao_fluxo_oficial INTEGER NOT NULL DEFAULT 0,
      distribuicao_oficial_alterada INTEGER NOT NULL DEFAULT 0,
      criado_em DATETIME
    )`;
  const inserir = `
    INSERT INTO venda_composicao_referencia (
      venda_id, total_financeiro, dinheiro_recebido,
      valor_fiscal_referencia, valor_nao_fiscal_referencia,
      motor_codigo, distribuicao_possivel, aplica_ao_fluxo_oficial,
      distribuicao_oficial_alterada, criado_em
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, datetime('now'))`;
  const motor = avaliacao.avaliacao_motor || {};
  return new Promise((resolve, reject) => {
    dbConnection.run(sqlTabela, (err) => {
      if (err) {
        reject(err);
        return;
      }
      dbConnection.run(inserir, [
        vendaId,
        avaliacao.total_financeiro,
        avaliacao.valor_nao_fiscal_referencia,
        avaliacao.valor_fiscal_referencia,
        avaliacao.valor_nao_fiscal_referencia,
        motor.codigo || null,
        motor.distribuicao_possivel === true ? 1 : 0
      ], function onInsert(erroInsert) {
        if (erroInsert) reject(erroInsert);
        else resolve({ lastID: this.lastID });
      });
    });
  });
}

module.exports = {
  avaliarPagamentosSequenciais,
  avaliarReferenciaRecomposicao,
  ambienteTesteRecomposicaoReferencia,
  calcularReferenciasConfirmadas,
  classificarTipoRecebimento,
  parcelaEfetivamenteConfirmada,
  gravarReferenciaRecomposicao,
  ENV_REFERENCIA_TESTE
};
