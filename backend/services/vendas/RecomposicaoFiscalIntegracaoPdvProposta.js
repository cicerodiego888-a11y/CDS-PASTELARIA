/**
 * CDS — PAGAMENTO MISTO E RECOMPOSIÇÃO FISCAL — 03
 *
 * Proposta técnica de integração do contrato ao fechamento do PDV Express.
 * Módulo PURO e isolado: NÃO é importado por rotas, criarVenda ou Motor F×NF.
 *
 * Sequência real observada no código (somente leitura):
 *  1. PDV monta `dados` (total comercial, pagamentos, itens)
 *  2. GET/POST pré-cálculo → `POST /api/vendas/pre-calcular-distribuicao`
 *     (Motor F×NF oficial via distribuirItensVendaComValorFiscalEfetivo)
 *  3. PDV grava valor_fiscal / valor_nao_fiscal no payload (informativos)
 *  4. Aprovação TEF (misto sequencial ou fiscal único) — se aplicável
 *  5. `POST /api/vendas` → VendaApplicationService.criarVenda
 *     → VendaPagamentoService.criarVenda
 *  6. Backend RECALCULA Motor F×NF (ignora body.valor_fiscal / valor_nao_fiscal)
 *  7. Persistência (vendas.total = comercial) + baixa estoque pela distribuição oficial
 *  8. OrquestradorPagamento + emissão NFC-e (VendaFiscalService) se solicitado
 *
 * Ponto recomendado (futuro, com autorização explícita):
 *  - No backend, DENTRO de criarVenda, APÓS validar soma de pagamentos e
 *    ANTES de distribuirItensVendaComValorFiscalEfetivo / persistência —
 *    validar o contrato; NUNCA sobrescrever o Motor silenciosamente.
 *  - No PDV, opcionalmente espelhar a mesma validação após o pré-cálculo e
 *    antes do TEF, apenas como UX; a autoridade permanece no backend.
 *
 * @module services/vendas/RecomposicaoFiscalIntegracaoPdvProposta
 */
'use strict';

const {
  RECOMPOSICAO_HABILITADA_EM_PRODUCAO,
  prepararContratoRecomposicaoFiscal
} = require('./RecomposicaoFiscalContratoService');

/** Documentação estável do ponto de integração futura (não executa wiring). */
const PONTO_INTEGRACAO_RECOMENDADO = Object.freeze({
  camada: 'backend',
  servico: 'VendaPagamentoService.criarVenda',
  momento:
    'após validarSomaPagamentosVenda / montagem de pagamentosVenda e antes de ' +
    'distribuirItensVendaComValorFiscalEfetivo e da persistência',
  espelho_pdv_opcional:
    'após precalcularDistribuicaoFiscalVenda e antes de processarPagamentosMistosTEF',
  autoridade: 'backend',
  altera_motor_fxnf: false,
  altera_vendas_total: false,
  cria_voucher: false,
  flag_producao: 'RECOMPOSICAO_HABILITADA_EM_PRODUCAO',
  observacao:
    'body.valor_fiscal do PDV é ignorado pelo criarVenda oficial (_valorFiscalBody). ' +
    'Integrar só no pré-cálculo ou só no PDV gera divergência com persistência/estoque/NFC-e.'
});

const SEQUENCIA_FECHAMENTO_PDV = Object.freeze([
  'montar_dados_comerciais',
  'pre_calcular_distribuicao',
  'anexar_valor_fiscal_informativo_payload',
  'aprovar_tef_se_aplicavel',
  'post_api_vendas',
  'recalcular_motor_fxnf_oficial',
  'persistir_venda_e_estoque',
  'orquestrar_pagamento_e_emitir_fiscal'
]);

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Mapeia um snapshot sintético do fechamento PDV → entrada do contrato.
 * Não muta `snapshot`. Não chama TEF/SEFAZ/DB.
 *
 * @param {object} snapshot
 * @returns {object} entrada para prepararContratoRecomposicaoFiscal
 */
function mapearSnapshotFechamentoPdvParaEntradaContrato(snapshot = {}) {
  const totalComercial = snapshot.total != null
    ? snapshot.total
    : snapshot.total_comercial;
  const pagamentos = Array.isArray(snapshot.pagamentos)
    ? snapshot.pagamentos.map((p) => ({
      forma_pagamento: p.forma_pagamento,
      valor: p.valor,
      tipo_recebimento: p.tipo_recebimento
    }))
    : [];
  const itens = Array.isArray(snapshot.itens)
    ? snapshot.itens.map((i) => ({
      produto_id: i.produto_id != null ? i.produto_id : i.id,
      quantidade: i.quantidade,
      subtotal: i.subtotal,
      quantidade_fiscal: i.quantidade_fiscal,
      quantidade_nao_fiscal: i.quantidade_nao_fiscal,
      valor_fiscal: i.valor_fiscal,
      valor_nao_fiscal: i.valor_nao_fiscal
    }))
    : [];

  return {
    total_comercial: totalComercial,
    total_financeiro: snapshot.total_financeiro != null
      ? snapshot.total_financeiro
      : totalComercial,
    valor_fiscal_candidato: snapshot.valor_fiscal_candidato != null
      ? snapshot.valor_fiscal_candidato
      : snapshot.valor_fiscal,
    pagamentos,
    itens,
    habilitar_em_producao: snapshot.habilitar_em_producao === true,
    permitir_valor_fiscal_acima_do_comercial:
      snapshot.permitir_valor_fiscal_acima_do_comercial === true
  };
}

/**
 * Compara o valor fiscal oficial do pré-cálculo/Motor com o candidato do contrato.
 * Usado para evidenciar risco de divergência se a integração for parcial.
 *
 * @param {{ valor_fiscal?: number, valor_nao_fiscal?: number }} preCalculoOficial
 * @param {{ valor_fiscal_candidato?: number|null, total_comercial?: number }} contrato
 */
function avaliarDivergenciaPreCalculoOficialVsCandidato(preCalculoOficial = {}, contrato = {}) {
  const oficialFiscal = round2(preCalculoOficial.valor_fiscal || 0);
  const oficialNaoFiscal = round2(preCalculoOficial.valor_nao_fiscal || 0);
  const candidato = contrato.valor_fiscal_candidato == null
    ? null
    : round2(contrato.valor_fiscal_candidato);
  const divergente = candidato != null && Math.abs(oficialFiscal - candidato) > 0.009;

  return Object.freeze({
    valor_fiscal_oficial_pre_calculo: oficialFiscal,
    valor_nao_fiscal_oficial_pre_calculo: oficialNaoFiscal,
    valor_fiscal_candidato: candidato,
    divergente,
    risco:
      divergente
        ? 'Integrar só no PDV/pré-cálculo sem alterar a autoridade do Motor em criarVenda ' +
          'faria NFC-e/estoque seguirem o oficial e o cupom/UX seguirem o candidato.'
        : 'Sem divergência numérica entre oficial e candidato neste snapshot.',
    body_valor_fiscal_ignorado_em_criar_venda: true,
    aplica_candidato_ao_fluxo_oficial: false
  });
}

/**
 * Demonstração isolada: recebe snapshot do fechamento, valida contrato,
 * compara com pré-cálculo sintético. Nunca habilita produção nem muta entrada.
 *
 * @param {object} snapshotFechamentoPdv
 * @param {object} [preCalculoOficialSimulado] resultado sintético do Motor/pré-cálculo
 */
function demonstrarIntegracaoIsoladaFechamento(snapshotFechamentoPdv = {}, preCalculoOficialSimulado = null) {
  if (RECOMPOSICAO_HABILITADA_EM_PRODUCAO === true) {
    // Defesa: mesmo se a flag for alterada indevidamente, este módulo não aplica.
    throw Object.assign(new Error('Demonstração isolada recusa flag de produção ativa.'), {
      code: 'DEMONSTRACAO_RECUSA_PRODUCAO'
    });
  }

  const entrada = mapearSnapshotFechamentoPdvParaEntradaContrato(snapshotFechamentoPdv);
  const contrato = prepararContratoRecomposicaoFiscal(entrada);

  const pre = preCalculoOficialSimulado || {
    valor_fiscal: snapshotFechamentoPdv.valor_fiscal_oficial,
    valor_nao_fiscal: snapshotFechamentoPdv.valor_nao_fiscal_oficial
  };

  const divergencia = avaliarDivergenciaPreCalculoOficialVsCandidato(pre, contrato);

  return Object.freeze({
    sucesso: true,
    sprint: 'CDS-PAGAMENTO-MISTO-RECOMPOSICAO-FISCAL-03',
    ponto_integracao_recomendado: PONTO_INTEGRACAO_RECOMENDADO,
    sequencia_fechamento: SEQUENCIA_FECHAMENTO_PDV,
    contrato,
    divergencia,
    efeitos_colaterais: Object.freeze({
      chamou_tef: false,
      chamou_sefaz: false,
      escreveu_banco: false,
      alterou_fluxo_oficial: false,
      conectou_criar_venda: false
    })
  });
}

/**
 * Contrato mínimo exigido antes de qualquer ativação futura.
 */
const CONTRATO_MINIMO_PROXIMA_ETAPA = Object.freeze({
  validacoes: Object.freeze([
    'soma pagamentos === total comercial (centavos)',
    'valor_fiscal_candidato >= 0 e <= total comercial (ou regra explícita)',
    'quantidades F+NF === quantidade item quando distribuição preparada',
    'RECOMPOSICAO_HABILITADA_EM_PRODUCAO === true somente com autorização',
    'Motor F×NF permanece autoridade da composição oficial até regra fiscal validada',
    'vendas.total permanece o total comercial',
    'integração simétrica: backend autoridade; PDV apenas espelho UX',
    'não criar voucher nesta linha sem sprint dedicada'
  ]),
  nao_fazer: Object.freeze([
    'não confiar em body.valor_fiscal do PDV como fonte oficial',
    'não integrar só em pre-calcular-distribuicao',
    'não alterar estoque pela composição candidata sem autoridade do Motor',
    'não emitir NFC-e pelo candidato sem regra fiscal aprovada'
  ])
});

module.exports = {
  PONTO_INTEGRACAO_RECOMENDADO,
  SEQUENCIA_FECHAMENTO_PDV,
  CONTRATO_MINIMO_PROXIMA_ETAPA,
  mapearSnapshotFechamentoPdvParaEntradaContrato,
  avaliarDivergenciaPreCalculoOficialVsCandidato,
  demonstrarIntegracaoIsoladaFechamento
};
