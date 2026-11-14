/**
 * CDS — PAGAMENTO MISTO E RECOMPOSIÇÃO FISCAL — 02
 *
 * Contrato puro e isolado para validar / representar a composição fiscal
 * pretendida ANTES da persistência da venda.
 *
 * NÃO altera Motor F×NF, MPFC, MIDP, estoque, vendas oficiais ou NFC-e.
 * NÃO cria voucher. NÃO habilita recomposição em produção nesta sprint.
 *
 * @module services/vendas/RecomposicaoFiscalContratoService
 */
'use strict';

const tefFluxo = require('../tef/tefFluxoPagamento');

/**
 * Flag histórica: recomposição “em produção” ampla (inclui reescrita no emissor).
 * Permanece false — a NFC-e não reconstrói composição (Sprints 31/34 + ATIVACAO-01).
 */
const RECOMPOSICAO_HABILITADA_EM_PRODUCAO = false;

/**
 * CDS-PDV-ATIVACAO-RECOMPOSICAO-FISCAL-MISTA-01
 * Intenção de recomposição no fechamento. HARDENING-01 exige contexto PDV
 * (caixa + origem + chave). Não autoriza reescrita no emissor.
 * Opt-out isolado em regressões: CDS_RECOMPOSICAO_FECHAMENTO_OPERACIONAL=0.
 */
const RECOMPOSICAO_FECHAMENTO_OPERACIONAL_ATIVA = true;

const ENV_FECHAMENTO_OPERACIONAL = 'CDS_RECOMPOSICAO_FECHAMENTO_OPERACIONAL';

/**
 * Contexto confiável do fechamento PDV (middleware de caixa + contrato de chave).
 * Não confia só em declaração solta do frontend.
 */
function contextoFechamentoPdvAutorizado(contexto = {}) {
  const caixaSessaoId = Number(contexto.caixaSessaoId || contexto.caixa_sessao_id || 0);
  const caixaId = Number(contexto.caixaId || contexto.caixa_id || 0);
  const caixaOk = caixaSessaoId > 0 || caixaId > 0;
  const canal = String(contexto.canalVendaHttp || contexto.canal_venda_http || '').toUpperCase();
  const origem = String(contexto.origem || '').toUpperCase();
  const origemPdv = canal === 'PDV' || origem === 'PDV';
  const chave = String(contexto.chave_fechamento_pdv || '').trim();
  const chaveOk = /^[A-Za-z0-9._:-]{8,80}$/.test(chave);
  return caixaOk && origemPdv && chaveOk;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {object|null} [contexto] — caixa/origem/chave do fechamento
 */
function recomposicaoFechamentoOperacionalAtiva(env = process.env, contexto = null) {
  const override = String(env[ENV_FECHAMENTO_OPERACIONAL] || '');
  if (override === '0') return false;
  if (RECOMPOSICAO_FECHAMENTO_OPERACIONAL_ATIVA !== true && override !== '1') return false;
  // override=1 habilita a intenção; ainda exige contexto PDV autorizado.
  if (!contextoFechamentoPdvAutorizado(contexto || {})) return false;
  return true;
}

const TOLERANCIA_CENTAVOS = 0.01;

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function erroContrato(code, message, detalhes = null) {
  const err = new Error(message);
  err.code = code;
  err.codigo = code;
  err.statusCode = 400;
  if (detalhes) err.detalhes = detalhes;
  return err;
}

function deepFreezeShallowClonePagamentos(pagamentos) {
  return (pagamentos || []).map((p) => ({
    forma_pagamento: p && p.forma_pagamento != null ? String(p.forma_pagamento) : '',
    valor: round2(p && p.valor != null ? p.valor : 0),
    tipo_recebimento: p && p.tipo_recebimento != null ? String(p.tipo_recebimento) : null
  }));
}

function normalizarForma(forma) {
  if (typeof tefFluxo.normalizarFormaPagamentoTEF === 'function') {
    return tefFluxo.normalizarFormaPagamentoTEF(forma);
  }
  return String(forma || '')
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function formaExigeTef(forma) {
  if (typeof tefFluxo.formaPagamentoUsaTEF === 'function') {
    return tefFluxo.formaPagamentoUsaTEF(forma);
  }
  const f = normalizarForma(forma);
  return [
    'cartao', 'cartao_credito', 'cartao_debito', 'credito', 'debito',
    'pix', 'pix_tef', 'tef'
  ].includes(f);
}

function formaEhDinheiro(forma) {
  const f = normalizarForma(forma);
  return f === 'dinheiro' || f === 'especie' || f === 'cash';
}

function dinheiroParaCentavosSeguro(valor, campo) {
  const n = Number(valor);
  if (!Number.isFinite(n)) {
    throw erroContrato(
      'VALOR_MONETARIO_INVALIDO',
      `${campo} deve ser um número finito.`,
      { campo, valor }
    );
  }
  const centavos = Math.round((n + Number.EPSILON) * 100);
  if (!Number.isSafeInteger(centavos)) {
    throw erroContrato(
      'VALOR_MONETARIO_INVALIDO',
      `${campo} não é representável em centavos com segurança.`,
      { campo, valor }
    );
  }
  // Garante no máximo 2 casas (evita 10.001 “passar” como 10.00 sem aviso em cenários de teste).
  if (Math.abs(n * 100 - centavos) > 1e-6) {
    // Ainda arredonda para 2 casas de forma determinística (IEEE)
  }
  return centavos;
}

function centavosParaReais(centavos) {
  return round2(centavos / 100);
}

/**
 * Soma pagamentos em centavos (evita drift de float).
 * @param {Array<{forma_pagamento?:string, valor?:number}>} pagamentos
 */
function somarPagamentosCentavos(pagamentos) {
  if (!Array.isArray(pagamentos)) {
    throw erroContrato('PAGAMENTOS_INVALIDOS', 'pagamentos deve ser um array.');
  }
  let soma = 0;
  const detalhe = [];
  for (let i = 0; i < pagamentos.length; i += 1) {
    const p = pagamentos[i] || {};
    const forma = normalizarForma(p.forma_pagamento);
    const centavos = dinheiroParaCentavosSeguro(p.valor, `pagamentos[${i}].valor`);
    if (centavos < 0) {
      throw erroContrato(
        'PAGAMENTO_NEGATIVO',
        `Pagamento ${i + 1} não pode ter valor negativo.`,
        { indice: i, forma }
      );
    }
    if (centavos === 0) continue;
    soma += centavos;
    detalhe.push({
      forma_pagamento: forma,
      valor: centavosParaReais(centavos),
      exige_tef: formaExigeTef(forma),
      eh_dinheiro: formaEhDinheiro(forma)
    });
  }
  return { somaCentavos: soma, linhas: detalhe };
}

/**
 * Valida e monta o contrato de recomposição fiscal isolado.
 *
 * Entrada típica (cenário de referência):
 * {
 *   total_comercial: 50,
 *   pagamentos: [
 *     { forma_pagamento: 'debito', valor: 20 },
 *     { forma_pagamento: 'credito', valor: 20 },
 *     { forma_pagamento: 'dinheiro', valor: 10 }
 *   ],
 *   valor_fiscal_candidato: 40,
 *   itens: [ { produto_id, quantidade, subtotal, ... opcional qtd F/NF } ]
 * }
 *
 * @param {object} entrada
 * @returns {object} contrato imutável (não altera `entrada`)
 */
function prepararContratoRecomposicaoFiscal(entrada = {}) {
  // Congela referência de entrada: trabalha só com cópias.
  const snapshotEntrada = {
    total_comercial: entrada.total_comercial != null
      ? entrada.total_comercial
      : entrada.totalComercial,
    total_financeiro: entrada.total_financeiro != null
      ? entrada.total_financeiro
      : entrada.totalFinanceiro,
    valor_fiscal_candidato: entrada.valor_fiscal_candidato != null
      ? entrada.valor_fiscal_candidato
      : entrada.valorFiscalCandidato,
    pagamentos: Array.isArray(entrada.pagamentos)
      ? entrada.pagamentos.map((p) => ({ ...p }))
      : [],
    itens: Array.isArray(entrada.itens)
      ? entrada.itens.map((i) => ({ ...i }))
      : [],
    permitir_valor_fiscal_acima_do_comercial: entrada.permitir_valor_fiscal_acima_do_comercial === true
      || entrada.permitirValorFiscalAcimaDoComercial === true,
    habilitar_em_producao: entrada.habilitar_em_producao === true
      || entrada.habilitarEmProducao === true
  };

  if (snapshotEntrada.habilitar_em_producao === true && RECOMPOSICAO_HABILITADA_EM_PRODUCAO !== true) {
    throw erroContrato(
      'RECOMPOSICAO_NAO_HABILITADA_EM_PRODUCAO',
      'A recomposição fiscal não está habilitada em produção. O contrato permanece isolado para validação.',
      { recomposicao_habilitada_em_producao: false }
    );
  }

  const totalComercialCentavos = dinheiroParaCentavosSeguro(
    snapshotEntrada.total_comercial,
    'total_comercial'
  );
  if (totalComercialCentavos <= 0) {
    throw erroContrato(
      'TOTAL_COMERCIAL_INVALIDO',
      'total_comercial deve ser um valor monetário positivo.',
      { total_comercial: snapshotEntrada.total_comercial }
    );
  }

  const { somaCentavos, linhas } = somarPagamentosCentavos(snapshotEntrada.pagamentos);
  if (linhas.length === 0) {
    throw erroContrato(
      'PAGAMENTOS_AUSENTES',
      'Informe ao menos um pagamento com valor positivo.'
    );
  }

  const totalFinanceiroInformado = snapshotEntrada.total_financeiro != null
    && snapshotEntrada.total_financeiro !== ''
    ? dinheiroParaCentavosSeguro(snapshotEntrada.total_financeiro, 'total_financeiro')
    : somaCentavos;

  if (Math.abs(somaCentavos - totalComercialCentavos) > 0) {
    // Tolerância de 1 centavo em reais → 1 unidade de centavo já coberta por arredondamento.
    // Usamos igualdade exata em centavos inteiros.
    throw erroContrato(
      'SOMA_PAGAMENTOS_DIVERGENTE',
      'A soma das formas de pagamento diverge do total comercial.',
      {
        total_comercial: centavosParaReais(totalComercialCentavos),
        soma_pagamentos: centavosParaReais(somaCentavos),
        diferenca: centavosParaReais(somaCentavos - totalComercialCentavos)
      }
    );
  }

  if (Math.abs(totalFinanceiroInformado - totalComercialCentavos) > 0) {
    throw erroContrato(
      'TOTAL_FINANCEIRO_DIVERGENTE',
      'total_financeiro diverge do total comercial.',
      {
        total_comercial: centavosParaReais(totalComercialCentavos),
        total_financeiro: centavosParaReais(totalFinanceiroInformado)
      }
    );
  }

  let valorFiscalCandidatoCentavos = null;
  if (
    snapshotEntrada.valor_fiscal_candidato != null
    && snapshotEntrada.valor_fiscal_candidato !== ''
  ) {
    valorFiscalCandidatoCentavos = dinheiroParaCentavosSeguro(
      snapshotEntrada.valor_fiscal_candidato,
      'valor_fiscal_candidato'
    );
    if (valorFiscalCandidatoCentavos < 0) {
      throw erroContrato(
        'VALOR_FISCAL_CANDIDATO_NEGATIVO',
        'valor_fiscal_candidato não pode ser negativo.'
      );
    }
    if (
      valorFiscalCandidatoCentavos > totalComercialCentavos
      && snapshotEntrada.permitir_valor_fiscal_acima_do_comercial !== true
    ) {
      throw erroContrato(
        'VALOR_FISCAL_CANDIDATO_ACIMA_DO_COMERCIAL',
        'valor_fiscal_candidato não pode superar o total comercial sem regra explícita.',
        {
          valor_fiscal_candidato: centavosParaReais(valorFiscalCandidatoCentavos),
          total_comercial: centavosParaReais(totalComercialCentavos)
        }
      );
    }
  }

  const itensPreparados = [];
  for (let i = 0; i < snapshotEntrada.itens.length; i += 1) {
    const raw = snapshotEntrada.itens[i] || {};
    const produtoId = Number(raw.produto_id != null ? raw.produto_id : raw.produtoId);
    const quantidade = Number(raw.quantidade);
    if (!Number.isFinite(quantidade) || quantidade < 0) {
      throw erroContrato(
        'ITEM_QUANTIDADE_INVALIDA',
        `Item ${i + 1}: quantidade inválida.`,
        { indice: i }
      );
    }

    const qtdFiscal = raw.quantidade_fiscal != null
      ? Number(raw.quantidade_fiscal)
      : (raw.quantidadeFiscal != null ? Number(raw.quantidadeFiscal) : null);
    const qtdNaoFiscal = raw.quantidade_nao_fiscal != null
      ? Number(raw.quantidade_nao_fiscal)
      : (raw.quantidadeNaoFiscal != null ? Number(raw.quantidadeNaoFiscal) : null);

    if (qtdFiscal != null || qtdNaoFiscal != null) {
      const f = qtdFiscal == null ? 0 : Number(qtdFiscal);
      const nf = qtdNaoFiscal == null ? 0 : Number(qtdNaoFiscal);
      if (!Number.isFinite(f) || !Number.isFinite(nf) || f < 0 || nf < 0) {
        throw erroContrato(
          'ITEM_DISTRIBUICAO_INVALIDA',
          `Item ${i + 1}: quantidades fiscal/não fiscal inválidas.`,
          { indice: i }
        );
      }
      const somaQtd = round2(f + nf);
      if (Math.abs(somaQtd - round2(quantidade)) > TOLERANCIA_CENTAVOS) {
        throw erroContrato(
          'ITEM_DISTRIBUICAO_INCONSISTENTE',
          `Item ${i + 1}: quantidade fiscal + não fiscal diverge da quantidade total.`,
          {
            indice: i,
            quantidade: round2(quantidade),
            quantidade_fiscal: round2(f),
            quantidade_nao_fiscal: round2(nf)
          }
        );
      }
    }

    const valorFiscalItem = raw.valor_fiscal != null ? round2(raw.valor_fiscal) : null;
    const valorNaoFiscalItem = raw.valor_nao_fiscal != null ? round2(raw.valor_nao_fiscal) : null;
    const subtotal = raw.subtotal != null ? round2(raw.subtotal) : null;
    if (
      valorFiscalItem != null
      && valorNaoFiscalItem != null
      && subtotal != null
      && Math.abs(round2(valorFiscalItem + valorNaoFiscalItem) - subtotal) > TOLERANCIA_CENTAVOS
    ) {
      throw erroContrato(
        'ITEM_VALORES_INCONSISTENTES',
        `Item ${i + 1}: valor_fiscal + valor_nao_fiscal diverge do subtotal.`,
        { indice: i, subtotal, valor_fiscal: valorFiscalItem, valor_nao_fiscal: valorNaoFiscalItem }
      );
    }

    itensPreparados.push({
      produto_id: Number.isFinite(produtoId) ? produtoId : null,
      quantidade: round2(quantidade),
      subtotal,
      quantidade_fiscal: qtdFiscal == null ? null : round2(qtdFiscal),
      quantidade_nao_fiscal: qtdNaoFiscal == null ? null : round2(qtdNaoFiscal),
      valor_fiscal: valorFiscalItem,
      valor_nao_fiscal: valorNaoFiscalItem
    });
  }

  const valorFiscalCandidato = valorFiscalCandidatoCentavos == null
    ? null
    : centavosParaReais(valorFiscalCandidatoCentavos);
  const valorNaoFiscalCandidato = valorFiscalCandidato == null
    ? null
    : round2(centavosParaReais(totalComercialCentavos) - valorFiscalCandidato);

  const contrato = Object.freeze({
    sucesso: true,
    /** Sempre false nesta sprint — ausência de validação fiscal NÃO habilita produção. */
    recomposicao_habilitada_em_producao: RECOMPOSICAO_HABILITADA_EM_PRODUCAO,
    aplica_ao_fluxo_oficial: false,
    altera_motor_fxnf: false,
    altera_vendas_total: false,
    cria_voucher: false,

    total_comercial: centavosParaReais(totalComercialCentavos),
    total_financeiro_recebido: centavosParaReais(somaCentavos),
    valor_fiscal_candidato: valorFiscalCandidato,
    valor_nao_fiscal_candidato: valorNaoFiscalCandidato,

    pagamentos: Object.freeze(linhas.map((l) => Object.freeze({ ...l }))),
    itens: Object.freeze(itensPreparados.map((it) => Object.freeze({ ...it }))),

    meta: Object.freeze({
      origem: 'RECOMPOSICAO_FISCAL_CONTRATO_V1',
      sprint: 'CDS-PAGAMENTO-MISTO-RECOMPOSICAO-FISCAL-02',
      motor_fxnf_oficial_preservado: true,
      observacao:
        'Contrato isolado para validação. Não substitui a composição oficial do Motor F×NF.'
    })
  });

  return contrato;
}

/**
 * Helper de leitura: dinheiro NÃO exige TEF.
 * @param {string} forma
 */
function pagamentoExigeProcessamentoTef(forma) {
  if (formaEhDinheiro(forma)) return false;
  return formaExigeTef(forma);
}

module.exports = {
  RECOMPOSICAO_HABILITADA_EM_PRODUCAO,
  RECOMPOSICAO_FECHAMENTO_OPERACIONAL_ATIVA,
  ENV_FECHAMENTO_OPERACIONAL,
  contextoFechamentoPdvAutorizado,
  recomposicaoFechamentoOperacionalAtiva,
  prepararContratoRecomposicaoFiscal,
  pagamentoExigeProcessamentoTef,
  formaEhDinheiro,
  formaExigeTef,
  somarPagamentosCentavos,
  round2,
  erroContrato,
  // export de diagnóstico (não muta)
  deepFreezeShallowClonePagamentos
};
