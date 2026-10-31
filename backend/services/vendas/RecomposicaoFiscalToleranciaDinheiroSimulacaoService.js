/**
 * CDS — PAGAMENTO MISTO E RECOMPOSIÇÃO FISCAL — 05
 *
 * Política isolada de tolerância matemática (até 20% do dinheiro)
 * para avaliar candidatos fiscais com quantidades inteiras.
 *
 * NÃO transforma a margem em desconto, valor não fiscal ou ajuste de pagamento.
 * NÃO integra rotas / criarVenda / Motor F×NF. NÃO habilita produção.
 *
 * @module services/vendas/RecomposicaoFiscalToleranciaDinheiroSimulacaoService
 */
'use strict';

const {
  RECOMPOSICAO_HABILITADA_EM_PRODUCAO,
  formaEhDinheiro,
  round2
} = require('./RecomposicaoFiscalContratoService');

const {
  simularDistribuicaoFiscalComResidual
} = require('./RecomposicaoFiscalDistribuicaoSimulacaoService');

const PERCENTUAL_TOLERANCIA_DINHEIRO_PADRAO = 0.2;

function erroTol(code, message, detalhes = null) {
  const err = new Error(message);
  err.code = code;
  err.codigo = code;
  err.statusCode = 400;
  if (detalhes) err.detalhes = detalhes;
  return err;
}

function centavos(valor, campo) {
  const n = Number(valor);
  if (!Number.isFinite(n)) {
    throw erroTol('VALOR_MONETARIO_INVALIDO', `${campo} inválido.`, { campo, valor });
  }
  return Math.round((n + Number.EPSILON) * 100);
}

function deCentavos(c) {
  return round2(c / 100);
}

/**
 * Soma pagamentos em dinheiro (centavos). Não classifica F/NF.
 * @param {Array<{forma_pagamento?:string, valor?:number}>} pagamentos
 */
function somarDinheiroRecebidoCentavos(pagamentos) {
  if (!Array.isArray(pagamentos)) {
    throw erroTol('PAGAMENTOS_INVALIDOS', 'pagamentos deve ser um array.');
  }
  let soma = 0;
  for (let i = 0; i < pagamentos.length; i += 1) {
    const p = pagamentos[i] || {};
    if (!formaEhDinheiro(p.forma_pagamento)) continue;
    const c = centavos(p.valor != null ? p.valor : 0, `pagamentos[${i}].valor`);
    if (c < 0) {
      throw erroTol('PAGAMENTO_NEGATIVO', 'Pagamento em dinheiro não pode ser negativo.', { indice: i });
    }
    soma += c;
  }
  return soma;
}

/**
 * Margem máxima = percentual × dinheiro recebido (padrão 20%).
 * Resultado matemático apenas — não é desconto nem voucher.
 *
 * @param {Array} pagamentos
 * @param {{ percentual?: number }} [opcoes]
 */
function calcularMargemToleranciaDinheiro(pagamentos, opcoes = {}) {
  const percentual = opcoes.percentual != null
    ? Number(opcoes.percentual)
    : PERCENTUAL_TOLERANCIA_DINHEIRO_PADRAO;
  if (!Number.isFinite(percentual) || percentual < 0) {
    throw erroTol(
      'PERCENTUAL_TOLERANCIA_INVALIDO',
      'percentual de tolerância deve ser um número >= 0.'
    );
  }

  const dinheiroC = somarDinheiroRecebidoCentavos(pagamentos);
  const margemC = Math.round(dinheiroC * percentual);

  return Object.freeze({
    dinheiro_recebido: deCentavos(dinheiroC),
    percentual,
    margem_maxima: deCentavos(margemC),
    formula: 'percentual * soma(pagamentos em dinheiro)',
    classificacao: null,
    nao_e_desconto: true,
    nao_e_voucher: true,
    nao_e_ajuste_pagamento: true,
    nao_e_valor_nao_fiscal: true,
    observacao:
      'Margem matemática candidata para avaliação de distribuição. ' +
      'Não aplica desconto comercial automaticamente.'
  });
}

function precoUnitarioItem(item) {
  if (item.preco_unitario != null && Number.isFinite(Number(item.preco_unitario))) {
    return round2(Number(item.preco_unitario));
  }
  const qtd = Number(item.quantidade);
  const sub = Number(item.subtotal);
  if (Number.isFinite(qtd) && qtd > 0 && Number.isFinite(sub)) {
    return round2(sub / qtd);
  }
  return null;
}

/**
 * Lista totais fiscais atingíveis com quantidades inteiras (dados sintéticos).
 * Combinações limitadas — adequado a testes/simulação, não ao Motor oficial.
 */
function listarTotaisFiscaisQuantidadeInteira(itens, totalComercialCentavos) {
  if (!Array.isArray(itens) || !itens.length) return [];

  const faixas = [];
  for (let i = 0; i < itens.length; i += 1) {
    const it = itens[i];
    const qtd = Number(it.quantidade);
    const preco = precoUnitarioItem(it);
    if (!Number.isFinite(qtd) || qtd < 0 || !Number.isInteger(qtd)) {
      return [];
    }
    if (preco == null || !(preco > 0)) {
      return [];
    }
    const precoC = centavos(preco, `itens[${i}].preco_unitario`);
    const opcoesItem = [];
    for (let qF = 0; qF <= qtd; qF += 1) {
      opcoesItem.push(qF * precoC);
    }
    faixas.push(opcoesItem);
  }

  let totais = [0];
  for (const opcoesItem of faixas) {
    const prox = [];
    for (const base of totais) {
      for (const add of opcoesItem) {
        prox.push(base + add);
      }
    }
    totais = prox;
  }

  const unicos = Array.from(new Set(totais))
    .filter((t) => t >= 0 && t <= totalComercialCentavos)
    .sort((a, b) => a - b);

  return unicos.map((c) => deCentavos(c));
}

/**
 * Avalia um (ou mais) candidatos fiscais usando a margem de 20% do dinheiro,
 * buscando distribuição com quantidades inteiras.
 *
 * Não muta a entrada. Não aplica desconto. Não altera fluxo oficial.
 *
 * @param {object} entrada
 */
function avaliarCandidatosComToleranciaDinheiro(entrada = {}) {
  if (entrada.habilitar_em_producao === true || entrada.habilitarEmProducao === true) {
    throw erroTol(
      'RECOMPOSICAO_NAO_HABILITADA_EM_PRODUCAO',
      'A tolerância de dinheiro permanece isolada; recomposição não habilitada em produção.',
      { recomposicao_habilitada_em_producao: false }
    );
  }

  const snapshot = {
    total_comercial: entrada.total_comercial != null ? entrada.total_comercial : entrada.total,
    pagamentos: Array.isArray(entrada.pagamentos)
      ? entrada.pagamentos.map((p) => ({ ...p }))
      : [],
    itens: Array.isArray(entrada.itens)
      ? entrada.itens.map((i) => ({ ...i }))
      : [],
    candidatos: Array.isArray(entrada.candidatos_fiscais)
      ? entrada.candidatos_fiscais.slice()
      : (
        entrada.valor_fiscal_candidato != null
          ? [entrada.valor_fiscal_candidato]
          : (entrada.valorFiscalCandidato != null ? [entrada.valorFiscalCandidato] : [])
      ),
    percentual: entrada.percentual_tolerancia_dinheiro != null
      ? Number(entrada.percentual_tolerancia_dinheiro)
      : (
        entrada.percentualToleranciaDinheiro != null
          ? Number(entrada.percentualToleranciaDinheiro)
          : PERCENTUAL_TOLERANCIA_DINHEIRO_PADRAO
      )
  };

  if (!snapshot.candidatos.length) {
    throw erroTol(
      'CANDIDATO_AUSENTE',
      'Informe valor_fiscal_candidato ou candidatos_fiscais.'
    );
  }

  const margemInfo = calcularMargemToleranciaDinheiro(snapshot.pagamentos, {
    percentual: snapshot.percentual
  });
  const margemC = centavos(margemInfo.margem_maxima, 'margem_maxima');
  const totalC = centavos(snapshot.total_comercial, 'total_comercial');

  const totaisInteiros = listarTotaisFiscaisQuantidadeInteira(snapshot.itens, totalC);

  const avaliacoes = snapshot.candidatos.map((candidatoRaw) => {
    const candidatoC = centavos(candidatoRaw, 'valor_fiscal_candidato');
    const candidato = deCentavos(candidatoC);

    // 1) Tentativa direta com quantidades inteiras (Sprint 04).
    const simulacaoDireta = simularDistribuicaoFiscalComResidual({
      total_comercial: snapshot.total_comercial,
      pagamentos: snapshot.pagamentos,
      valor_fiscal_candidato: candidato,
      itens: snapshot.itens,
      exigir_quantidades_inteiras: true
    });

    if (simulacaoDireta.distribuicao.possivel === true) {
      return Object.freeze({
        valor_fiscal_candidato: candidato,
        margem_maxima: margemInfo.margem_maxima,
        dentro_da_margem: true,
        distancia_ao_inteiro_compativel: 0,
        candidato_inteiro_compativel: candidato,
        distribuicao_possivel: true,
        codigo: 'OK_CANDIDATO_INTEIRO_EXATO',
        motivo: null,
        aplicou_desconto: false,
        alterou_pagamento: false,
        residual: simulacaoDireta.residual,
        distribuicao: simulacaoDireta.distribuicao,
        simulacao: simulacaoDireta
      });
    }

    // 2) Busca total fiscal inteiro mais próximo dentro da margem (só avaliação).
    let melhor = null;
    for (const totalInteiro of totaisInteiros) {
      const totalInteiroC = centavos(totalInteiro, 'total_inteiro');
      const distC = Math.abs(totalInteiroC - candidatoC);
      if (distC > margemC) continue;
      if (
        !melhor
        || distC < melhor.distC
        || (distC === melhor.distC && totalInteiroC < melhor.totalInteiroC)
      ) {
        melhor = { totalInteiro, totalInteiroC, distC };
      }
    }

    if (!melhor) {
      const maisProximo = totaisInteiros.length
        ? totaisInteiros.reduce((acc, t) => {
          const d = Math.abs(centavos(t, 't') - candidatoC);
          if (!acc || d < acc.d) return { t, d };
          return acc;
        }, null)
        : null;

      return Object.freeze({
        valor_fiscal_candidato: candidato,
        margem_maxima: margemInfo.margem_maxima,
        dentro_da_margem: false,
        distancia_ao_inteiro_compativel: maisProximo
          ? deCentavos(maisProximo.d)
          : null,
        candidato_inteiro_compativel: maisProximo ? maisProximo.t : null,
        distribuicao_possivel: false,
        codigo: totaisInteiros.length
          ? 'MARGEM_INSUFICIENTE'
          : 'DISTRIBUICAO_INCOMPATIVEL_QUANTIDADE_INTEIRA',
        motivo: totaisInteiros.length
          ? 'Nenhuma distribuição com quantidade inteira cabe na margem de tolerância do dinheiro. ' +
            'Desconto comercial, se houver, é decisão separada e não é aplicado automaticamente.'
          : 'Não há distribuição com quantidades inteiras compatível com os itens sintéticos.',
        aplicou_desconto: false,
        alterou_pagamento: false,
        residual: Object.freeze({
          valor: deCentavos(totalC - candidatoC),
          formula: 'total_comercial - valor_fiscal_candidato',
          classificacao: null,
          nao_e_desconto: true
        }),
        distribuicao: Object.freeze({
          possivel: false,
          codigo: totaisInteiros.length ? 'MARGEM_INSUFICIENTE' : 'DISTRIBUICAO_INCOMPATIVEL_QUANTIDADE_INTEIRA'
        }),
        simulacao: simulacaoDireta
      });
    }

    const simulacaoAjustada = simularDistribuicaoFiscalComResidual({
      total_comercial: snapshot.total_comercial,
      pagamentos: snapshot.pagamentos,
      valor_fiscal_candidato: melhor.totalInteiro,
      itens: snapshot.itens,
      exigir_quantidades_inteiras: true
    });

    return Object.freeze({
      valor_fiscal_candidato: candidato,
      margem_maxima: margemInfo.margem_maxima,
      dentro_da_margem: true,
      distancia_ao_inteiro_compativel: deCentavos(melhor.distC),
      candidato_inteiro_compativel: melhor.totalInteiro,
      distribuicao_possivel: simulacaoAjustada.distribuicao.possivel === true,
      codigo: simulacaoAjustada.distribuicao.possivel
        ? 'OK_CANDIDATO_DENTRO_DA_MARGEM'
        : 'DISTRIBUICAO_INCOMPATIVEL_APOS_TOLERANCIA',
      motivo: simulacaoAjustada.distribuicao.possivel
        ? 'Existe total fiscal com quantidade inteira dentro da margem. ' +
          'A margem NÃO foi convertida em desconto nem ajuste de pagamento.'
        : (simulacaoAjustada.distribuicao.motivo || 'Falha ao materializar distribuição inteira.'),
      aplicou_desconto: false,
      alterou_pagamento: false,
      residual: simulacaoAjustada.residual,
      distribuicao: simulacaoAjustada.distribuicao,
      simulacao: simulacaoAjustada
    });
  });

  const algumaPossivel = avaliacoes.some((a) => a.distribuicao_possivel === true);

  return Object.freeze({
    sucesso: true,
    sprint: 'CDS-PAGAMENTO-MISTO-RECOMPOSICAO-FISCAL-05',
    aplica_ao_fluxo_oficial: false,
    altera_motor_fxnf: false,
    altera_vendas_total: false,
    cria_voucher: false,
    aplicou_desconto_automatico: false,
    recomposicao_habilitada_em_producao: RECOMPOSICAO_HABILITADA_EM_PRODUCAO,

    total_comercial: round2(Number(snapshot.total_comercial)),
    margem: margemInfo,
    totais_fiscais_quantidade_inteira: Object.freeze(totaisInteiros.slice()),
    avaliacoes: Object.freeze(avaliacoes),
    distribuicao_possivel: algumaPossivel,
    codigo: algumaPossivel ? 'OK' : 'INCOMPATIVEL_DENTRO_DA_MARGEM',

    meta: Object.freeze({
      origem: 'RECOMPOSICAO_FISCAL_TOLERANCIA_DINHEIRO_V1',
      percentual_padrao: PERCENTUAL_TOLERANCIA_DINHEIRO_PADRAO,
      margem_nao_e_desconto: true,
      residual_sem_classificacao_automatica: true,
      observacao:
        'Avaliação isolada. Margem de 20% do dinheiro não altera venda, pagamentos nem composição oficial.'
    })
  });
}

module.exports = {
  PERCENTUAL_TOLERANCIA_DINHEIRO_PADRAO,
  calcularMargemToleranciaDinheiro,
  somarDinheiroRecebidoCentavos,
  listarTotaisFiscaisQuantidadeInteira,
  avaliarCandidatosComToleranciaDinheiro
};
