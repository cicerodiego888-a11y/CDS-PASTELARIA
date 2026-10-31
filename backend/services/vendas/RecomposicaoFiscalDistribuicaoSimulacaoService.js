/**
 * CDS — PAGAMENTO MISTO E RECOMPOSIÇÃO FISCAL — 04
 *
 * Simulação PURA da distribuição fiscal / não fiscal com valor residual.
 * Não altera Motor F×NF, MPFC, MIDP, rotas, criarVenda, estoque ou NFC-e.
 * Não classifica residual como dinheiro fiscal, desconto ou voucher.
 * Não presume que dinheiro é automaticamente fiscal ou não fiscal.
 *
 * @module services/vendas/RecomposicaoFiscalDistribuicaoSimulacaoService
 */
'use strict';

const {
  RECOMPOSICAO_HABILITADA_EM_PRODUCAO,
  prepararContratoRecomposicaoFiscal,
  round2
} = require('./RecomposicaoFiscalContratoService');

const TOLERANCIA_CENTAVOS = 0.01;

function erroSim(code, message, detalhes = null) {
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
    throw erroSim('VALOR_MONETARIO_INVALIDO', `${campo} inválido.`, { campo, valor });
  }
  return Math.round((n + Number.EPSILON) * 100);
}

function deCentavos(c) {
  return round2(c / 100);
}

/**
 * Residual matemático: total_comercial − valor_fiscal_candidato.
 * Sem classificação automática (não é desconto, voucher nem “dinheiro fiscal”).
 */
function calcularResidualMatematico(totalComercial, valorFiscalCandidato) {
  const totalC = centavos(totalComercial, 'total_comercial');
  const fiscalC = centavos(valorFiscalCandidato, 'valor_fiscal_candidato');
  const residualC = totalC - fiscalC;
  return Object.freeze({
    valor: deCentavos(residualC),
    formula: 'total_comercial - valor_fiscal_candidato',
    total_comercial: deCentavos(totalC),
    valor_fiscal_candidato: deCentavos(fiscalC),
    classificacao: null,
    nao_e_desconto: true,
    nao_e_voucher: true,
    nao_presume_dinheiro_fiscal: true,
    nao_presume_dinheiro_nao_fiscal: true,
    observacao:
      'Residual matemático isolado. Exige regra de negócio futura para classificação ' +
      '(fiscal, não fiscal, ou outro tratamento). Não inventa desconto nem voucher.'
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
 * Tenta ratear o candidato fiscal pelos itens na proporção dos subtotais,
 * ajustando centavos no último item, e deriva quantidades pelo preço unitário.
 * Valida saldos sintéticos quando informados.
 */
function quantidadeEhInteira(q) {
  if (q == null || !Number.isFinite(Number(q))) return false;
  return Math.abs(Number(q) - Math.round(Number(q))) <= 1e-9;
}

function tentarDistribuicaoPorProporcaoValor(
  itens,
  valorFiscalCandidatoCentavos,
  totalComercialCentavos,
  opcoes = {}
) {
  const exigirQuantidadesInteiras = opcoes.exigir_quantidades_inteiras === true;
  if (!itens.length) {
    return {
      possivel: false,
      codigo: 'ITENS_AUSENTES',
      motivo: 'Sem itens para simular distribuição.'
    };
  }

  const subtotaisC = itens.map((it, i) => {
    const sub = it.subtotal != null
      ? centavos(it.subtotal, `itens[${i}].subtotal`)
      : centavos(
        round2(Number(it.quantidade || 0) * Number(precoUnitarioItem(it) || 0)),
        `itens[${i}].subtotal_derivado`
      );
    return sub;
  });
  const somaSub = subtotaisC.reduce((s, v) => s + v, 0);
  if (somaSub !== totalComercialCentavos) {
    return {
      possivel: false,
      codigo: 'ITENS_TOTAL_INCONSISTENTE',
      motivo:
        'Soma dos subtotais dos itens diverge do total comercial; ' +
        'simulação não inventa desconto nem altera valores comerciais.',
      detalhes: {
        soma_subtotais: deCentavos(somaSub),
        total_comercial: deCentavos(totalComercialCentavos)
      }
    };
  }

  if (valorFiscalCandidatoCentavos < 0 || valorFiscalCandidatoCentavos > totalComercialCentavos) {
    return {
      possivel: false,
      codigo: 'CANDIDATO_FORA_DO_COMERCIAL',
      motivo: 'Candidato fiscal fora do intervalo [0, total_comercial].'
    };
  }

  // Alocação gulosa por ordem dos itens: consome o candidato fiscal sem
  // alterar subtotais comerciais (não inventa desconto / não reduz preços).
  const alocados = [];
  let fiscalRestante = valorFiscalCandidatoCentavos;

  for (let i = 0; i < itens.length; i += 1) {
    const subC = subtotaisC[i];
    const fiscalItemC = Math.min(subC, fiscalRestante);
    if (fiscalItemC < 0 || fiscalItemC > subC) {
      return {
        possivel: false,
        codigo: 'ALOCACAO_ITEM_INVALIDA',
        motivo: `Não foi possível alocar valor fiscal no item ${i + 1} sem alterar o subtotal comercial.`,
        detalhes: { indice: i, subtotal: deCentavos(subC), valor_fiscal_tentativa: deCentavos(fiscalItemC) }
      };
    }
    const naoFiscalItemC = subC - fiscalItemC;
    fiscalRestante -= fiscalItemC;

    const item = itens[i];
    const qtd = Number(item.quantidade);
    const preco = precoUnitarioItem(item);

    let qtdFiscal = null;
    let qtdNaoFiscal = null;
    let inconsistenciaQtd = null;

    if (Number.isFinite(qtd) && qtd >= 0 && preco != null && preco > 0) {
      // Derivação: qtd_fiscal = valor_fiscal / preco_unitario
      const qF = round2(deCentavos(fiscalItemC) / preco);
      const qNF = round2(deCentavos(naoFiscalItemC) / preco);
      const somaQ = round2(qF + qNF);
      if (Math.abs(somaQ - round2(qtd)) > TOLERANCIA_CENTAVOS) {
        inconsistenciaQtd = {
          codigo: 'QUANTIDADE_DERIVADA_INCONSISTENTE',
          quantidade: round2(qtd),
          quantidade_fiscal_derivada: qF,
          quantidade_nao_fiscal_derivada: qNF
        };
      } else {
        // Checa se valor bate com qtd * preco (centavos)
        const valorFCheck = Math.round(qF * preco * 100);
        const valorNFCheck = Math.round(qNF * preco * 100);
        if (
          Math.abs(valorFCheck - fiscalItemC) > 1
          || Math.abs(valorNFCheck - naoFiscalItemC) > 1
        ) {
          inconsistenciaQtd = {
            codigo: 'VALOR_QUANTIDADE_PRECO_INCOMPATIVEL',
            preco_unitario: preco,
            valor_fiscal: deCentavos(fiscalItemC),
            valor_nao_fiscal: deCentavos(naoFiscalItemC)
          };
        } else {
          qtdFiscal = qF;
          qtdNaoFiscal = qNF;
        }
      }
    }

    // Saldos sintéticos (opcionais)
    let estoqueOk = true;
    let estoqueMotivo = null;
    const saldoF = item.saldo_fiscal_sintetico != null
      ? Number(item.saldo_fiscal_sintetico)
      : (item.saldoFiscalSintetico != null ? Number(item.saldoFiscalSintetico) : null);
    const saldoNF = item.saldo_nao_fiscal_sintetico != null
      ? Number(item.saldo_nao_fiscal_sintetico)
      : (item.saldoNaoFiscalSintetico != null ? Number(item.saldoNaoFiscalSintetico) : null);

    if (qtdFiscal != null && saldoF != null && Number.isFinite(saldoF) && qtdFiscal > saldoF + TOLERANCIA_CENTAVOS) {
      estoqueOk = false;
      estoqueMotivo = 'quantidade_fiscal excede saldo_fiscal_sintetico';
    }
    if (qtdNaoFiscal != null && saldoNF != null && Number.isFinite(saldoNF) && qtdNaoFiscal > saldoNF + TOLERANCIA_CENTAVOS) {
      estoqueOk = false;
      estoqueMotivo = (estoqueMotivo ? `${estoqueMotivo}; ` : '') +
        'quantidade_nao_fiscal excede saldo_nao_fiscal_sintetico';
    }

    alocados.push({
      produto_id: item.produto_id != null ? Number(item.produto_id) : null,
      quantidade: Number.isFinite(qtd) ? round2(qtd) : null,
      subtotal: deCentavos(subC),
      preco_unitario: preco,
      valor_fiscal: deCentavos(fiscalItemC),
      valor_nao_fiscal: deCentavos(naoFiscalItemC),
      quantidade_fiscal: qtdFiscal,
      quantidade_nao_fiscal: qtdNaoFiscal,
      inconsistencia_quantidade: inconsistenciaQtd,
      estoque_sintetico_ok: estoqueOk,
      estoque_sintetico_motivo: estoqueMotivo,
      saldo_fiscal_sintetico: saldoF,
      saldo_nao_fiscal_sintetico: saldoNF
    });
  }

  if (fiscalRestante !== 0) {
    return {
      possivel: false,
      codigo: 'RESIDUO_ALOCACAO_FISCAL',
      motivo: 'Falha ao consumir integralmente o candidato fiscal na alocação por item.',
      detalhes: { residual_alocacao_centavos: fiscalRestante }
    };
  }

  const somaFiscal = alocados.reduce((s, a) => s + centavos(a.valor_fiscal, 'vf'), 0);
  const somaNaoFiscal = alocados.reduce((s, a) => s + centavos(a.valor_nao_fiscal, 'vnf'), 0);
  if (somaFiscal !== valorFiscalCandidatoCentavos || somaFiscal + somaNaoFiscal !== totalComercialCentavos) {
    return {
      possivel: false,
      codigo: 'SOMA_VALORES_INCONSISTENTE',
      motivo: 'Soma F + NF dos itens não reconstitui o total comercial / candidato.',
      detalhes: {
        soma_fiscal: deCentavos(somaFiscal),
        soma_nao_fiscal: deCentavos(somaNaoFiscal)
      }
    };
  }

  const comInconsistenciaQtd = alocados.filter((a) => a.inconsistencia_quantidade);
  const comEstoqueInsuficiente = alocados.filter((a) => a.estoque_sintetico_ok === false);
  const comQtdFracionaria = exigirQuantidadesInteiras
    ? alocados.filter((a) =>
      (a.quantidade_fiscal != null && !quantidadeEhInteira(a.quantidade_fiscal))
      || (a.quantidade_nao_fiscal != null && !quantidadeEhInteira(a.quantidade_nao_fiscal))
    )
    : [];

  if (comInconsistenciaQtd.length) {
    return {
      possivel: false,
      codigo: 'DISTRIBUICAO_INCOMPATIVEL_ITENS',
      motivo:
        'O candidato fiscal não é realizável com as quantidades/preços dos itens ' +
        'sem alterar valores comerciais ou fracionar de forma inconsistente.',
      itens: alocados,
      itens_inconsistentes: comInconsistenciaQtd.map((a) => a.produto_id)
    };
  }

  if (comQtdFracionaria.length) {
    return {
      possivel: false,
      codigo: 'DISTRIBUICAO_EXIGE_QUANTIDADE_FRACIONARIA',
      motivo:
        'Candidato fiscal só é atingível com quantidades fracionárias; ' +
        'operacionalmente incompatível quando se exige unidade inteira ' +
        '(sem inventar desconto nem reduzir valor comercial).',
      itens: alocados,
      itens_inconsistentes: comQtdFracionaria.map((a) => a.produto_id)
    };
  }

  if (comEstoqueInsuficiente.length) {
    return {
      possivel: false,
      codigo: 'DISTRIBUICAO_INCOMPATIVEL_ESTOQUE_SINTETICO',
      motivo: 'Distribuição viola saldos fiscais/não fiscais sintéticos informados.',
      itens: alocados,
      itens_estoque: comEstoqueInsuficiente.map((a) => ({
        produto_id: a.produto_id,
        motivo: a.estoque_sintetico_motivo
      }))
    };
  }

  return {
    possivel: true,
    codigo: 'OK',
    motivo: null,
    itens: alocados,
    valor_fiscal_alocado: deCentavos(somaFiscal),
    valor_nao_fiscal_alocado: deCentavos(somaNaoFiscal)
  };
}

/**
 * Valida distribuição já proposta nos itens (quantidade_fiscal / valor_fiscal explícitos).
 */
function validarDistribuicaoExplicita(itens, valorFiscalCandidatoCentavos, totalComercialCentavos) {
  const alocados = [];
  let somaFiscal = 0;
  let somaNaoFiscal = 0;

  for (let i = 0; i < itens.length; i += 1) {
    const item = itens[i];
    const qtd = Number(item.quantidade);
    const qF = item.quantidade_fiscal != null ? Number(item.quantidade_fiscal) : null;
    const qNF = item.quantidade_nao_fiscal != null ? Number(item.quantidade_nao_fiscal) : null;
    const vF = item.valor_fiscal != null ? centavos(item.valor_fiscal, `itens[${i}].valor_fiscal`) : null;
    const vNF = item.valor_nao_fiscal != null
      ? centavos(item.valor_nao_fiscal, `itens[${i}].valor_nao_fiscal`)
      : null;
    const subC = item.subtotal != null
      ? centavos(item.subtotal, `itens[${i}].subtotal`)
      : null;

    if (qF != null || qNF != null) {
      const f = qF == null ? 0 : qF;
      const nf = qNF == null ? 0 : qNF;
      if (!Number.isFinite(f) || !Number.isFinite(nf) || f < 0 || nf < 0) {
        return {
          possivel: false,
          codigo: 'ITEM_DISTRIBUICAO_INVALIDA',
          motivo: `Item ${i + 1}: quantidades F/NF inválidas.`
        };
      }
      if (Math.abs(round2(f + nf) - round2(qtd)) > TOLERANCIA_CENTAVOS) {
        return {
          possivel: false,
          codigo: 'ITEM_DISTRIBUICAO_INCONSISTENTE',
          motivo: `Item ${i + 1}: quantidade fiscal + não fiscal diverge da quantidade total.`,
          detalhes: { quantidade: qtd, quantidade_fiscal: f, quantidade_nao_fiscal: nf }
        };
      }
    }

    if (vF != null && vNF != null && subC != null && vF + vNF !== subC) {
      return {
        possivel: false,
        codigo: 'ITEM_VALORES_INCONSISTENTES',
        motivo: `Item ${i + 1}: valor_fiscal + valor_nao_fiscal diverge do subtotal.`
      };
    }

    if (vF != null) somaFiscal += vF;
    if (vNF != null) somaNaoFiscal += vNF;

    const saldoF = item.saldo_fiscal_sintetico != null ? Number(item.saldo_fiscal_sintetico) : null;
    const saldoNF = item.saldo_nao_fiscal_sintetico != null ? Number(item.saldo_nao_fiscal_sintetico) : null;
    if (qF != null && saldoF != null && qF > saldoF + TOLERANCIA_CENTAVOS) {
      return {
        possivel: false,
        codigo: 'DISTRIBUICAO_INCOMPATIVEL_ESTOQUE_SINTETICO',
        motivo: `Item ${i + 1}: quantidade_fiscal excede saldo_fiscal_sintetico.`
      };
    }
    if (qNF != null && saldoNF != null && qNF > saldoNF + TOLERANCIA_CENTAVOS) {
      return {
        possivel: false,
        codigo: 'DISTRIBUICAO_INCOMPATIVEL_ESTOQUE_SINTETICO',
        motivo: `Item ${i + 1}: quantidade_nao_fiscal excede saldo_nao_fiscal_sintetico.`
      };
    }

    alocados.push({
      produto_id: item.produto_id != null ? Number(item.produto_id) : null,
      quantidade: round2(qtd),
      subtotal: subC != null ? deCentavos(subC) : null,
      valor_fiscal: vF != null ? deCentavos(vF) : null,
      valor_nao_fiscal: vNF != null ? deCentavos(vNF) : null,
      quantidade_fiscal: qF == null ? null : round2(qF),
      quantidade_nao_fiscal: qNF == null ? null : round2(qNF),
      estoque_sintetico_ok: true
    });
  }

  if (somaFiscal !== valorFiscalCandidatoCentavos) {
    return {
      possivel: false,
      codigo: 'VALOR_FISCAL_ITENS_DIVERGE_CANDIDATO',
      motivo: 'Soma dos valor_fiscal dos itens diverge do candidato.',
      detalhes: {
        soma_fiscal_itens: deCentavos(somaFiscal),
        valor_fiscal_candidato: deCentavos(valorFiscalCandidatoCentavos)
      }
    };
  }
  if (somaFiscal + somaNaoFiscal !== totalComercialCentavos) {
    return {
      possivel: false,
      codigo: 'SOMA_VALORES_INCONSISTENTE',
      motivo: 'Soma F + NF dos itens não reconstitui o total comercial.'
    };
  }

  return {
    possivel: true,
    codigo: 'OK',
    motivo: null,
    itens: alocados,
    valor_fiscal_alocado: deCentavos(somaFiscal),
    valor_nao_fiscal_alocado: deCentavos(somaNaoFiscal)
  };
}

function itensTemDistribuicaoExplicita(itens) {
  return itens.some((it) =>
    it.quantidade_fiscal != null
    || it.quantidade_nao_fiscal != null
    || it.valor_fiscal != null
    || it.valor_nao_fiscal != null
  );
}

/**
 * Simula distribuição F/NF para um candidato, com residual matemático separado.
 * Não muta a entrada. Não aplica ao fluxo oficial.
 *
 * @param {object} entrada
 * @returns {object}
 */
function simularDistribuicaoFiscalComResidual(entrada = {}) {
  if (entrada.habilitar_em_producao === true || entrada.habilitarEmProducao === true) {
    // Reaproveita a barreira do contrato.
    prepararContratoRecomposicaoFiscal({
      total_comercial: entrada.total_comercial != null ? entrada.total_comercial : entrada.total,
      pagamentos: entrada.pagamentos || [],
      valor_fiscal_candidato: entrada.valor_fiscal_candidato,
      habilitar_em_producao: true
    });
  }

  const snapshot = {
    total_comercial: entrada.total_comercial != null ? entrada.total_comercial : entrada.total,
    pagamentos: Array.isArray(entrada.pagamentos)
      ? entrada.pagamentos.map((p) => ({ ...p }))
      : [],
    valor_fiscal_candidato: entrada.valor_fiscal_candidato != null
      ? entrada.valor_fiscal_candidato
      : entrada.valorFiscalCandidato,
    itens: Array.isArray(entrada.itens)
      ? entrada.itens.map((i) => ({ ...i }))
      : []
  };

  if (snapshot.valor_fiscal_candidato == null || snapshot.valor_fiscal_candidato === '') {
    throw erroSim(
      'CANDIDATO_AUSENTE',
      'Informe valor_fiscal_candidato para a simulação.'
    );
  }

  const contrato = prepararContratoRecomposicaoFiscal({
    total_comercial: snapshot.total_comercial,
    pagamentos: snapshot.pagamentos,
    valor_fiscal_candidato: snapshot.valor_fiscal_candidato,
    itens: snapshot.itens.map((i) => ({
      produto_id: i.produto_id,
      quantidade: i.quantidade,
      subtotal: i.subtotal
      // não passa F/NF ao contrato aqui — simulação trata distribuição
    }))
  });

  const residual = calcularResidualMatematico(
    contrato.total_comercial,
    snapshot.valor_fiscal_candidato
  );

  const totalC = centavos(contrato.total_comercial, 'total_comercial');
  const fiscalC = centavos(snapshot.valor_fiscal_candidato, 'valor_fiscal_candidato');

  const exigirQuantidadesInteiras =
    entrada.exigir_quantidades_inteiras === true
    || entrada.exigirQuantidadesInteiras === true;

  let distribuicao;
  if (itensTemDistribuicaoExplicita(snapshot.itens)) {
    distribuicao = validarDistribuicaoExplicita(snapshot.itens, fiscalC, totalC);
  } else {
    distribuicao = tentarDistribuicaoPorProporcaoValor(
      snapshot.itens,
      fiscalC,
      totalC,
      { exigir_quantidades_inteiras: exigirQuantidadesInteiras }
    );
  }

  return Object.freeze({
    sucesso: true,
    sprint: 'CDS-PAGAMENTO-MISTO-RECOMPOSICAO-FISCAL-04',
    aplica_ao_fluxo_oficial: false,
    altera_motor_fxnf: false,
    altera_vendas_total: false,
    cria_voucher: false,
    recomposicao_habilitada_em_producao: RECOMPOSICAO_HABILITADA_EM_PRODUCAO,

    total_comercial: contrato.total_comercial,
    total_financeiro_recebido: contrato.total_financeiro_recebido,
    valor_fiscal_candidato: round2(Number(snapshot.valor_fiscal_candidato)),
    residual,
    /** Parte complementar matematicamente = residual; NÃO implica classificação NF. */
    valor_complementar_matematico: residual.valor,

    pagamentos: contrato.pagamentos,
    distribuicao: Object.freeze({
      possivel: distribuicao.possivel === true,
      codigo: distribuicao.codigo,
      motivo: distribuicao.motivo || null,
      valor_fiscal_alocado: distribuicao.valor_fiscal_alocado != null
        ? distribuicao.valor_fiscal_alocado
        : null,
      valor_nao_fiscal_alocado: distribuicao.valor_nao_fiscal_alocado != null
        ? distribuicao.valor_nao_fiscal_alocado
        : null,
      itens: Object.freeze((distribuicao.itens || []).map((it) => Object.freeze({ ...it }))),
      detalhes: distribuicao.detalhes || null,
      itens_inconsistentes: distribuicao.itens_inconsistentes || null,
      itens_estoque: distribuicao.itens_estoque || null
    }),

    meta: Object.freeze({
      origem: 'RECOMPOSICAO_FISCAL_DISTRIBUICAO_SIMULACAO_V1',
      dinheiro_nao_classificado_automaticamente: true,
      residual_sem_classificacao_automatica: true,
      observacao:
        'Simulação isolada. Residual e pagamentos em dinheiro não recebem rótulo F/NF automático.'
    })
  });
}

module.exports = {
  simularDistribuicaoFiscalComResidual,
  calcularResidualMatematico,
  tentarDistribuicaoPorProporcaoValor,
  validarDistribuicaoExplicita
};
