/**
 * CDS — PAGAMENTO MISTO E RECOMPOSIÇÃO FISCAL — 06
 *
 * Adaptador isolado que avalia candidatos fiscais usando o motor oficial
 * de composição (`ComposicaoFiscalPedidoService`), combinado à margem
 * matemática de 20% do dinheiro (Sprint 05).
 *
 * Interfaces oficiais utilizadas (sem duplicar o algoritmo):
 *  - `simularComposicao` — API pública; exige db+pedido; efeitosOperacionais=false
 *  - `internos.buscarComposicao` / `internos.comporItens` — núcleo puro da mesma busca
 *
 * NÃO usa `prepararComposicaoPedidoPdv` no fechamento (caminho operacional do PDV).
 * NÃO altera Motor F×NF / MPFC / MIDP / vendas oficiais.
 * NÃO aplica desconto automaticamente.
 *
 * @module services/vendas/RecomposicaoFiscalComposicaoMotorSimulacaoService
 */
'use strict';

const ComposicaoFiscalPedidoService = require('./ComposicaoFiscalPedidoService');
const {
  RECOMPOSICAO_HABILITADA_EM_PRODUCAO,
  round2
} = require('./RecomposicaoFiscalContratoService');
const {
  calcularMargemToleranciaDinheiro,
  PERCENTUAL_TOLERANCIA_DINHEIRO_PADRAO,
  pisoComplementoMoeda5Centavos,
  ceilComplementoMoeda5Centavos,
  ehComplementoMoeda5Centavos
} = require('./RecomposicaoFiscalToleranciaDinheiroSimulacaoService');

const { buscarComposicao, comporItens } = ComposicaoFiscalPedidoService.internos;
const { simularComposicao } = ComposicaoFiscalPedidoService;

function erroAdapt(code, message, detalhes = null) {
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
    throw erroAdapt('VALOR_MONETARIO_INVALIDO', `${campo} inválido.`, { campo, valor });
  }
  return Math.round((n + Number.EPSILON) * 100);
}

function deCentavos(c) {
  return round2(c / 100);
}

function quantidadesSaoInteiras(quantidades) {
  if (!Array.isArray(quantidades)) return false;
  return quantidades.every((q) => Number.isSafeInteger(q) && q >= 0);
}

/**
 * Avalia um candidato via núcleo oficial `buscarComposicao`.
 * Modelos/capacidade devem seguir o contrato do motor (cotador.cotar, volume, etc.).
 *
 * @param {object} params
 * @param {number} params.valorFiscalCandidato
 * @param {number} params.margemMaxima
 * @param {Array} params.modelos
 * @param {object} params.capacidadePorCategoria
 * @param {number} [params.limiteEstados]
 */
function avaliarCandidatoComBuscarComposicao(params = {}) {
  const candidatoC = centavos(params.valorFiscalCandidato, 'valor_fiscal_candidato');
  const margemC = centavos(params.margemMaxima != null ? params.margemMaxima : 0, 'margem_maxima');
  const modelos = Array.isArray(params.modelos) ? params.modelos : [];
  const capacidade = params.capacidadePorCategoria || {};

  if (!modelos.length) {
    return Object.freeze({
      valor_fiscal_candidato: deCentavos(candidatoC),
      margem_maxima: deCentavos(margemC),
      motor: 'ComposicaoFiscalPedidoService.internos.buscarComposicao',
      interface_oficial: true,
      composicao_encontrada_centavos: null,
      composicao_encontrada: null,
      diferenca_monetaria: null,
      dentro_da_margem: false,
      distribuicao_possivel: false,
      quantidades_inteiras: false,
      codigo: 'COMPOSICAO_AUSENTE_NO_MOTOR',
      motivo: 'Nenhum modelo fiscal elegível foi fornecido ao motor de composição.',
      aplicou_desconto: false,
      alterou_pagamento: false,
      busca: null,
      itens_compostos: []
    });
  }

  // Sprint 12: margem de tolerância aplicada no motor existente (alvoMinimo efetivo).
  const busca = buscarComposicao(
    modelos,
    capacidade,
    candidatoC,
    0,
    params.limiteEstados,
    { margemToleranciaCentavos: margemC }
  );

  if (!busca.otimalidadeComprovada) {
    return Object.freeze({
      valor_fiscal_candidato: deCentavos(candidatoC),
      margem_maxima: deCentavos(margemC),
      motor: 'ComposicaoFiscalPedidoService.internos.buscarComposicao',
      interface_oficial: true,
      composicao_encontrada_centavos: busca.totalCentavos >= 0 ? busca.totalCentavos : null,
      composicao_encontrada: busca.totalCentavos >= 0 ? deCentavos(busca.totalCentavos) : null,
      diferenca_monetaria: null,
      dentro_da_margem: false,
      distribuicao_possivel: false,
      quantidades_inteiras: false,
      codigo: 'COMPOSICAO_BUSCA_INCONCLUSIVA',
      motivo:
        'O motor atingiu o limite de estados antes de provar a melhor composição; ' +
        'resultado parcial não é utilizável.',
      aplicou_desconto: false,
      alterou_pagamento: false,
      busca: Object.freeze({ ...busca }),
      itens_compostos: []
    });
  }

  if (busca.totalCentavos < 0 || !busca.quantidades) {
    const foraMargem = busca.aplicouRegraToleranciaDinheiro === true;
    return Object.freeze({
      valor_fiscal_candidato: deCentavos(candidatoC),
      margem_maxima: deCentavos(margemC),
      motor: 'ComposicaoFiscalPedidoService.internos.buscarComposicao',
      interface_oficial: true,
      composicao_encontrada_centavos: null,
      composicao_encontrada: null,
      diferenca_monetaria: null,
      dentro_da_margem: false,
      distribuicao_possivel: false,
      quantidades_inteiras: false,
      codigo: foraMargem
        ? 'COMPOSICAO_INCOMPATIVEL_MARGEM_TOLERANCIA'
        : 'COMPOSICAO_FISCAL_INEXISTENTE',
      motivo: foraMargem
        ? 'Nenhuma composição do motor cabe na faixa [candidato − margem, candidato]. ' +
          'Margem não autoriza desconto nem classificação F/NF.'
        : 'Nenhuma composição válida foi encontrada pelo motor dentro do alvo e das capacidades.',
      aplicou_desconto: false,
      alterou_pagamento: false,
      busca: Object.freeze({ ...busca }),
      itens_compostos: []
    });
  }

  const inteiras = quantidadesSaoInteiras(busca.quantidades);
  const diferencaC = Number.isFinite(busca.diferencaAoAlvoCentavos)
    ? busca.diferencaAoAlvoCentavos
    : (candidatoC - busca.totalCentavos);
  const dentroMargem = busca.dentroDaMargemTolerancia === true;
  const itens = inteiras ? comporItens(modelos, busca.quantidades) : [];

  if (!inteiras) {
    return Object.freeze({
      valor_fiscal_candidato: deCentavos(candidatoC),
      margem_maxima: deCentavos(margemC),
      motor: 'ComposicaoFiscalPedidoService.internos.buscarComposicao',
      interface_oficial: true,
      composicao_encontrada: deCentavos(busca.totalCentavos),
      composicao_encontrada_centavos: busca.totalCentavos,
      diferenca_monetaria: deCentavos(diferencaC),
      dentro_da_margem: false,
      distribuicao_possivel: false,
      quantidades_inteiras: false,
      codigo: 'COMPOSICAO_QUANTIDADES_NAO_INTEIRAS',
      motivo: 'O motor retornou quantidades não inteiras; avaliação rejeitada.',
      aplicou_desconto: false,
      alterou_pagamento: false,
      busca: Object.freeze({ ...busca }),
      itens_compostos: []
    });
  }

  if (!dentroMargem) {
    return Object.freeze({
      valor_fiscal_candidato: deCentavos(candidatoC),
      margem_maxima: deCentavos(margemC),
      motor: 'ComposicaoFiscalPedidoService.internos.buscarComposicao',
      interface_oficial: true,
      composicao_encontrada: deCentavos(busca.totalCentavos),
      composicao_encontrada_centavos: busca.totalCentavos,
      diferenca_monetaria: deCentavos(diferencaC),
      dentro_da_margem: false,
      distribuicao_possivel: false,
      quantidades_inteiras: true,
      codigo: 'MARGEM_INSUFICIENTE',
      motivo:
        'A composição encontrada pelo motor diverge do candidato além da margem de 20% do dinheiro. ' +
        'Não se presume substituição automática do candidato. Desconto comercial não é aplicado.',
      aplicou_desconto: false,
      alterou_pagamento: false,
      encontrou_exato: busca.encontrouExato === true,
      busca: Object.freeze({ ...busca }),
      itens_compostos: Object.freeze(itens.map((it) => Object.freeze({ ...it })))
    });
  }

  const codigo = busca.encontrouExato && diferencaC === 0
    ? 'OK_COMPOSICAO_EXATA'
    : 'OK_COMPOSICAO_DENTRO_DA_MARGEM';

  return Object.freeze({
    valor_fiscal_candidato: deCentavos(candidatoC),
    margem_maxima: deCentavos(margemC),
    motor: 'ComposicaoFiscalPedidoService.internos.buscarComposicao',
    interface_oficial: true,
    composicao_encontrada: deCentavos(busca.totalCentavos),
    composicao_encontrada_centavos: busca.totalCentavos,
    diferenca_monetaria: deCentavos(diferencaC),
    dentro_da_margem: true,
    distribuicao_possivel: true,
    quantidades_inteiras: true,
    codigo,
    motivo: busca.encontrouExato && diferencaC === 0
      ? 'Motor encontrou composição exata no candidato (quantidades inteiras).'
      : 'Motor encontrou composição com quantidades inteiras; diferença ≤ margem do dinheiro. ' +
        'A diferença NÃO foi convertida em desconto nem alterou o candidato oficial.',
    aplicou_desconto: false,
    alterou_pagamento: false,
    encontrou_exato: busca.encontrouExato === true,
    busca: Object.freeze({ ...busca }),
    itens_compostos: Object.freeze(itens.map((it) => Object.freeze({ ...it })))
  });
}

/**
 * Simulação isolada: margem 20% dinheiro + motor real de composição.
 * Não muta entrada. Não persiste. Não altera carrinho/venda oficial.
 *
 * Entrada típica (modelos sintéticos compatíveis com o motor):
 * {
 *   total_comercial, pagamentos, candidatos_fiscais | valor_fiscal_candidato,
 *   modelos, capacidade_por_categoria
 * }
 *
 * Caminho alternativo (API pública completa):
 * { ..., usar_simular_composicao: true, empresaId, pedidoId, categoriasFiscais, db }
 *
 * @param {object} entrada
 * @param {{ db?: object }} [opts]
 */
async function avaliarCandidatosComMotorComposicao(entrada = {}, opts = {}) {
  if (entrada.habilitar_em_producao === true || entrada.habilitarEmProducao === true) {
    throw erroAdapt(
      'RECOMPOSICAO_NAO_HABILITADA_EM_PRODUCAO',
      'Simulação do motor de composição permanece isolada; recomposição não habilitada em produção.'
    );
  }

  const snapshot = {
    total_comercial: entrada.total_comercial != null ? entrada.total_comercial : entrada.total,
    pagamentos: Array.isArray(entrada.pagamentos)
      ? entrada.pagamentos.map((p) => ({ ...p }))
      : [],
    candidatos: Array.isArray(entrada.candidatos_fiscais)
      ? entrada.candidatos_fiscais.slice()
      : (
        entrada.valor_fiscal_candidato != null
          ? [entrada.valor_fiscal_candidato]
          : (entrada.valorFiscalCandidato != null ? [entrada.valorFiscalCandidato] : [])
      ),
    modelos: Array.isArray(entrada.modelos) ? entrada.modelos.slice() : [],
    capacidade_por_categoria: entrada.capacidade_por_categoria
      ? { ...entrada.capacidade_por_categoria }
      : (entrada.capacidadePorCategoria ? { ...entrada.capacidadePorCategoria } : {}),
    percentual: entrada.percentual_tolerancia_dinheiro != null
      ? Number(entrada.percentual_tolerancia_dinheiro)
      : PERCENTUAL_TOLERANCIA_DINHEIRO_PADRAO,
    usar_simular_composicao: entrada.usar_simular_composicao === true
  };

  if (!snapshot.candidatos.length) {
    throw erroAdapt('CANDIDATO_AUSENTE', 'Informe valor_fiscal_candidato ou candidatos_fiscais.');
  }

  const margem = calcularMargemToleranciaDinheiro(snapshot.pagamentos, {
    percentual: snapshot.percentual
  });

  let avaliacoes;

  if (snapshot.usar_simular_composicao) {
    const db = opts.db;
    if (!db) {
      throw erroAdapt(
        'DB_OBRIGATORIO',
        'usar_simular_composicao exige opts.db injetado (nunca usa banco oficial implícito).'
      );
    }
    // API pública oficial — apenas leitura/simulação (efeitosOperacionais=false).
    const out = await simularComposicao({
      empresaId: entrada.empresaId,
      pedidoId: entrada.pedidoId,
      categoriasFiscais: entrada.categoriasFiscais || entrada.categorias_fiscais,
      itensFixos: entrada.itensFixos || [],
      dataReferencia: entrada.dataReferencia
    }, { db });

    const valorComp = out.sucesso
      ? Number(out.valorComposicaoCentavos)
      : null;
    const candidatoUnico = snapshot.candidatos[0];
    const candidatoC = centavos(candidatoUnico, 'valor_fiscal_candidato');
    const margemC = centavos(margem.margem_maxima, 'margem_maxima');
    const diferencaC = valorComp != null ? candidatoC - valorComp : null;
    const dentro = diferencaC != null && diferencaC >= 0 && diferencaC <= margemC;

    avaliacoes = [
      Object.freeze({
        valor_fiscal_candidato: deCentavos(candidatoC),
        margem_maxima: margem.margem_maxima,
        motor: 'ComposicaoFiscalPedidoService.simularComposicao',
        interface_oficial: true,
        composicao_encontrada: valorComp != null ? deCentavos(valorComp) : null,
        composicao_encontrada_centavos: valorComp,
        diferenca_monetaria: diferencaC != null ? deCentavos(diferencaC) : null,
        dentro_da_margem: dentro === true,
        distribuicao_possivel: out.sucesso === true && dentro === true,
        quantidades_inteiras: out.sucesso === true,
        codigo: !out.sucesso
          ? (out.codigo || 'COMPOSICAO_SIMULACAO_FALHOU')
          : (dentro ? (diferencaC === 0 ? 'OK_COMPOSICAO_EXATA' : 'OK_COMPOSICAO_DENTRO_DA_MARGEM') : 'MARGEM_INSUFICIENTE'),
        motivo: out.sucesso
          ? (dentro
            ? 'simularComposicao retornou composição utilizável dentro da margem.'
            : 'Composição do motor fora da margem do dinheiro.')
          : (out.mensagem || 'simularComposicao não retornou composição utilizável.'),
        aplicou_desconto: false,
        alterou_pagamento: false,
        efeitos_operacionais: out.efeitosOperacionais === true,
        simulacao_oficial: out
      })
    ];
  } else {
    avaliacoes = snapshot.candidatos.map((candidato) =>
      avaliarCandidatoComBuscarComposicao({
        valorFiscalCandidato: candidato,
        margemMaxima: margem.margem_maxima,
        modelos: snapshot.modelos,
        capacidadePorCategoria: snapshot.capacidade_por_categoria,
        limiteEstados: entrada.limite_estados
      })
    );
  }

  const alguma = avaliacoes.some((a) => a.distribuicao_possivel === true);

  return Object.freeze({
    sucesso: true,
    sprint: 'CDS-PAGAMENTO-MISTO-RECOMPOSICAO-FISCAL-06',
    motor_oficial: 'ComposicaoFiscalPedidoService',
    interface_publica: 'simularComposicao',
    nucleo_busca: 'internos.buscarComposicao',
    aplica_ao_fluxo_oficial: false,
    altera_motor_fxnf: false,
    altera_vendas_total: false,
    cria_voucher: false,
    aplicou_desconto_automatico: false,
    persistiu: false,
    alterou_carrinho: false,
    recomposicao_habilitada_em_producao: RECOMPOSICAO_HABILITADA_EM_PRODUCAO,

    total_comercial: snapshot.total_comercial != null
      ? round2(Number(snapshot.total_comercial))
      : null,
    margem,
    avaliacoes: Object.freeze(avaliacoes),
    distribuicao_possivel: alguma,
    codigo: alguma ? 'OK' : 'INCOMPATIVEL_COM_MOTOR_COMPOSICAO',

    meta: Object.freeze({
      origem: 'RECOMPOSICAO_FISCAL_COMPOSICAO_MOTOR_SIMULACAO_V1',
      nao_duplica_motor: true,
      nao_presume_substituicao_4190_por_40: true,
      margem_nao_e_desconto: true,
      observacao:
        'Avaliação isolada via motor oficial. Diferença monetária não vira desconto automático; ' +
        'candidato não é substituído silenciosamente.'
    })
  });
}

/**
 * Registra candidato acima com complemento ceildado e candidato oficial atualizado.
 * Desconto de ajuste só quando o bruto supera o fiscal final (nunca negativo).
 */
function registrarCandidatoAcimaComComplemento(candidatos, modelos, busca, candidatoC, complementoC, brutoC) {
  if (
    !(complementoC > 0)
    || !ehComplementoMoeda5Centavos(complementoC)
    || !busca
    || !Array.isArray(busca.quantidades)
    || brutoC == null
  ) {
    return;
  }
  const fiscalResidualFinalC = candidatoC + complementoC;
  if (brutoC < fiscalResidualFinalC) return;
  const descontoC = brutoC - fiscalResidualFinalC;
  if (descontoC < 0) return;
  const itens = comporItens(modelos, busca.quantidades);
  candidatos.push({
    modo: 'acima_com_complemento',
    codigo: descontoC > 0
      ? 'OK_COMPOSICAO_ACIMA_COM_COMPLEMENTO_E_DESCONTO'
      : 'OK_COMPOSICAO_ACIMA_COM_COMPLEMENTO',
    bruto_centavos: brutoC,
    complemento_centavos: complementoC,
    desconto_ajuste_centavos: descontoC,
    distancia_centavos: Math.abs(brutoC - candidatoC),
    valor_fiscal_candidato_oficial_centavos: fiscalResidualFinalC,
    itens_compostos: itens,
    busca,
    motor_abaixo: null
  });
}

/**
 * Completa a referência fiscal somente até a menor composição de produtos inteiros
 * que a cubra. O limite é o dinheiro recebido, sem alterar a regra padrão dos 20%.
 */
function avaliarComplementoFiscalIntegral(params = {}) {
  const candidatoC = centavos(params.valorFiscalCandidato, 'valor_fiscal_candidato');
  const dinheiroC = centavos(params.dinheiroDisponivel != null ? params.dinheiroDisponivel : 0, 'dinheiro_disponivel');
  const modelos = Array.isArray(params.modelos) ? params.modelos : [];
  const capacidade = params.capacidadePorCategoria || {};

  if (candidatoC < 0 || dinheiroC < 0) {
    throw erroAdapt('VALOR_MONETARIO_INVALIDO', 'Referência fiscal e dinheiro disponível não podem ser negativos.');
  }
  if (!modelos.length) {
    return Object.freeze({
      distribuicao_possivel: false,
      codigo: 'COMPOSICAO_AUSENTE_NO_MOTOR',
      motivo: 'Nenhum produto fiscal elegível foi fornecido para completar a referência.',
      complemento_dinheiro: 0,
      desconto_ajuste: 0,
      itens_compostos: []
    });
  }

  const busca = buscarComposicao(
    modelos,
    capacidade,
    candidatoC + dinheiroC,
    candidatoC,
    params.limiteEstados,
    { objetivo: 'MINIMO' }
  );
  const totalC = busca && Number(busca.totalCentavos);
  const complementoC = totalC - candidatoC;
  if (
    !busca
    || !busca.otimalidadeComprovada
    || !Array.isArray(busca.quantidades)
    || !quantidadesSaoInteiras(busca.quantidades)
    || !Number.isSafeInteger(totalC)
    || totalC < candidatoC
    || complementoC > dinheiroC
  ) {
    return Object.freeze({
      distribuicao_possivel: false,
      codigo: 'DINHEIRO_INSUFICIENTE_COMPLEMENTO_INTEGRAL',
      motivo: 'O dinheiro disponível não cobre uma composição fiscal integral.',
      complemento_dinheiro: 0,
      desconto_ajuste: 0,
      margem_complemento_maxima: deCentavos(dinheiroC),
      itens_compostos: [],
      busca
    });
  }

  const itens = comporItens(modelos, busca.quantidades);
  if (!Array.isArray(itens) || itens.some((item) => (
    !Number.isSafeInteger(Number(item.quantidade))
    || Number(item.quantidade) < 0
    || (Number(item.quantidade) > 0 && !(
      Number(item.subtotal != null ? item.subtotal : Number(item.subtotalCentavos || 0) / 100) > 0
    ))
  ))) {
    return Object.freeze({
      distribuicao_possivel: false,
      codigo: 'COMPOSICAO_INTEGRAL_INVALIDA',
      motivo: 'A composição encontrada não preserva quantidades e valores integrais.',
      complemento_dinheiro: 0,
      desconto_ajuste: 0,
      itens_compostos: [],
      busca
    });
  }

  return Object.freeze({
    distribuicao_possivel: true,
    codigo: complementoC > 0
      ? 'OK_COMPLEMENTO_EXCEPCIONAL_INTEGRAL'
      : 'OK_COMPOSICAO_EXATA',
    motivo: complementoC > 0
      ? 'Complemento limitado ao valor necessário para cobrir produtos fiscais integrais.'
      : 'A composição fiscal integral coincide com a referência.',
    valor_fiscal_candidato: deCentavos(candidatoC),
    valor_fiscal_candidato_inicial: deCentavos(candidatoC),
    valor_fiscal_candidato_oficial: deCentavos(totalC),
    valor_fiscal_candidato_oficial_centavos: totalC,
    candidato_oficial_atualizado: totalC !== candidatoC,
    composicao_encontrada: deCentavos(totalC),
    composicao_encontrada_centavos: totalC,
    complemento_dinheiro: deCentavos(complementoC),
    complemento_dinheiro_centavos: complementoC,
    desconto_ajuste: 0,
    desconto_ajuste_centavos: 0,
    margem_complemento_maxima: deCentavos(dinheiroC),
    modo: complementoC > 0 ? 'complemento_excepcional_integral' : 'exata',
    itens_compostos: Object.freeze(itens.map((item) => Object.freeze({ ...item }))),
    busca
  });
}

/**
 * CDS-PDV-RECOMPOSICAO-MISTA-COMPLEMENTO-20-PORCENTO-01
 * + CDS-PDV-CORRECAO-COMPOSICAO-CANDIDATO-OFICIAL-ARREDONDAMENTO-05-CENTAVOS-01
 *
 * Busca residual abaixo e acima da referência eletrônica.
 * Diferença necessária → ceil ao múltiplo de R$ 0,05 (limitado à margem/dinheiro).
 * Atualiza o candidato fiscal oficial e reexecuta a seleção nesse alvo.
 * Desconto de ajuste permanece separado do complemento.
 */
function avaliarCandidatoComComplementoDinheiro(params = {}) {
  const candidatoC = centavos(params.valorFiscalCandidato, 'valor_fiscal_candidato');
  const dinheiroC = centavos(params.dinheiroConfirmado != null ? params.dinheiroConfirmado : 0, 'dinheiro');
  const margemRawC = centavos(params.margemMaxima != null ? params.margemMaxima : 0, 'margem_maxima');
  // Margem máxima continua com piso (nunca arredonda a margem para cima).
  const maxComplementoC = pisoComplementoMoeda5Centavos(Math.min(margemRawC, dinheiroC));
  const modelos = Array.isArray(params.modelos) ? params.modelos : [];
  const capacidade = params.capacidadePorCategoria || {};

  if (!modelos.length) {
    return Object.freeze({
      distribuicao_possivel: false,
      codigo: 'COMPOSICAO_AUSENTE_NO_MOTOR',
      motivo: 'Nenhum modelo fiscal elegível foi fornecido ao motor de composição.',
      complemento_dinheiro: 0,
      desconto_ajuste: 0,
      aplicou_desconto: false,
      itens_compostos: []
    });
  }

  const candidatos = [];
  const alvosComplementoJaAvaliados = new Set();

  const abaixo = avaliarCandidatoComBuscarComposicao({
    valorFiscalCandidato: deCentavos(candidatoC),
    margemMaxima: deCentavos(maxComplementoC),
    modelos,
    capacidadePorCategoria: capacidade,
    limiteEstados: params.limiteEstados
  });
  // Persistência exige fechar o fiscal final: abaixo só entra se for exata
  // (sem complemento). Abaixo com folga na margem não cobre o eletrônico.
  if (
    abaixo.distribuicao_possivel === true
    && abaixo.composicao_encontrada != null
    && (abaixo.encontrou_exato === true
      || centavos(abaixo.composicao_encontrada, 'composicao_abaixo') === candidatoC)
  ) {
    const brutoC = candidatoC;
    candidatos.push({
      modo: 'exata',
      codigo: 'OK_COMPOSICAO_EXATA',
      bruto_centavos: brutoC,
      complemento_centavos: 0,
      desconto_ajuste_centavos: 0,
      distancia_centavos: 0,
      valor_fiscal_candidato_oficial_centavos: candidatoC,
      itens_compostos: abaixo.itens_compostos || [],
      busca: abaixo.busca || null,
      motor_abaixo: abaixo
    });
  }

  function avaliarAlvoComplemento(complementoC, buscaSinal) {
    if (
      !(complementoC > 0)
      || complementoC > maxComplementoC
      || complementoC > dinheiroC
      || !ehComplementoMoeda5Centavos(complementoC)
      || alvosComplementoJaAvaliados.has(complementoC)
    ) {
      return;
    }
    alvosComplementoJaAvaliados.add(complementoC);
    const alvoOficialC = candidatoC + complementoC;
    const alvoMaxFaixaC = candidatoC + maxComplementoC;

    if (
      buscaSinal
      && buscaSinal.otimalidadeComprovada
      && buscaSinal.totalCentavos === alvoOficialC
      && Array.isArray(buscaSinal.quantidades)
    ) {
      registrarCandidatoAcimaComComplemento(
        candidatos, modelos, buscaSinal, candidatoC, complementoC, buscaSinal.totalCentavos
      );
      return;
    }

    // Candidato oficial atualizado: reexecuta a composição no alvo ceildado.
    const rebuscaExata = buscarComposicao(
      modelos,
      capacidade,
      alvoOficialC,
      alvoOficialC,
      params.limiteEstados,
      { objetivo: 'MINIMO' }
    );
    if (
      rebuscaExata.otimalidadeComprovada
      && rebuscaExata.totalCentavos === alvoOficialC
      && Array.isArray(rebuscaExata.quantidades)
    ) {
      registrarCandidatoAcimaComComplemento(
        candidatos, modelos, rebuscaExata, candidatoC, complementoC, rebuscaExata.totalCentavos
      );
      return;
    }

    // Bruto acima do candidato oficial, ainda na faixa da margem → desconto de ajuste.
    if (alvoOficialC < alvoMaxFaixaC) {
      const rebuscaAcima = buscarComposicao(
        modelos,
        capacidade,
        alvoMaxFaixaC,
        alvoOficialC + 1,
        params.limiteEstados,
        { objetivo: 'MINIMO' }
      );
      if (
        rebuscaAcima.otimalidadeComprovada
        && rebuscaAcima.totalCentavos > alvoOficialC
        && rebuscaAcima.totalCentavos <= alvoMaxFaixaC
        && Array.isArray(rebuscaAcima.quantidades)
      ) {
        const excessoFinalC = rebuscaAcima.totalCentavos - candidatoC;
        const complementoFinalC = ceilComplementoMoeda5Centavos(excessoFinalC);
        if (
          complementoFinalC > 0
          && complementoFinalC <= maxComplementoC
          && complementoFinalC <= dinheiroC
          && rebuscaAcima.totalCentavos >= candidatoC + complementoFinalC
        ) {
          registrarCandidatoAcimaComComplemento(
            candidatos,
            modelos,
            rebuscaAcima,
            candidatoC,
            complementoFinalC,
            rebuscaAcima.totalCentavos
          );
        }
      }
    }
  }

  if (maxComplementoC > 0) {
    const alvoMaxC = candidatoC + maxComplementoC;
    // Percorre composições atingíveis acima do eletrônico; cada diferença vira ceil de R$ 0,05.
    let minimoBuscaC = candidatoC + 1;
    let guard = 0;
    while (minimoBuscaC <= alvoMaxC && guard < 64) {
      guard += 1;
      const acima = buscarComposicao(
        modelos,
        capacidade,
        alvoMaxC,
        minimoBuscaC,
        params.limiteEstados,
        { objetivo: 'MINIMO' }
      );
      if (
        !acima.otimalidadeComprovada
        || !(acima.totalCentavos > candidatoC)
        || acima.totalCentavos > alvoMaxC
        || !Array.isArray(acima.quantidades)
      ) {
        break;
      }
      const excessoC = acima.totalCentavos - candidatoC;
      const antesCeil = candidatos.length;
      // 1) Preferir ceil (ex.: 3,96 → 4,00) quando o alvo ceildado for atingível.
      const complementoCeilC = ceilComplementoMoeda5Centavos(excessoC);
      if (complementoCeilC <= maxComplementoC && complementoCeilC <= dinheiroC) {
        avaliarAlvoComplemento(complementoCeilC, acima);
      }
      // 2) Se o alvo ceil não existir no catálogo, fallback piso + desconto de ajuste
      //    (ex.: bruto 19,80 / eletrônico 16,99 → complemento 2,80 + desconto 0,01).
      if (candidatos.length === antesCeil) {
        const complementoPisoC = pisoComplementoMoeda5Centavos(
          Math.min(maxComplementoC, excessoC)
        );
        if (
          complementoPisoC > 0
          && ehComplementoMoeda5Centavos(complementoPisoC)
          && complementoPisoC <= dinheiroC
          && complementoPisoC <= maxComplementoC
        ) {
          const fiscalResidualFinalC = candidatoC + complementoPisoC;
          const descontoC = acima.totalCentavos - fiscalResidualFinalC;
          if (descontoC >= 0 && complementoPisoC + descontoC === excessoC) {
            registrarCandidatoAcimaComComplemento(
              candidatos,
              modelos,
              acima,
              candidatoC,
              complementoPisoC,
              acima.totalCentavos
            );
          }
        }
      }
      minimoBuscaC = acima.totalCentavos + 1;
    }
  }

  // 3) Ultrapassou a faixa dos 20%: usa o teto de 20%, pega a composição
  //    elegível mais próxima acima do eletrônico e aplica desconto de ajuste.
  //    Ex.: eletrônico 26,99 + dinheiro 10 → complemento máx. 2,00; bruto 38,97
  //    → fiscal final 28,99 + desconto 9,98.
  if (!candidatos.length && maxComplementoC > 0) {
    let capacidadeTotalC = 0;
    for (const modelo of modelos) {
      const precoC = Math.round(Number(
        modelo && modelo.cotador && modelo.cotador.precoUnitarioMinimoInterno != null
          ? Number(modelo.cotador.precoUnitarioMinimoInterno) * 100
          : 0
      ));
      const qMax = Number(modelo && modelo.quantidadeMaxima != null ? modelo.quantidadeMaxima : 0);
      if (precoC > 0 && qMax > 0) capacidadeTotalC += precoC * qMax;
    }
    const alvoBuscaLongeC = Math.max(candidatoC + maxComplementoC + 1, capacidadeTotalC);
    if (alvoBuscaLongeC > candidatoC) {
      const proxima = buscarComposicao(
        modelos,
        capacidade,
        alvoBuscaLongeC,
        candidatoC + 1,
        params.limiteEstados,
        { objetivo: 'MINIMO' }
      );
      if (
        proxima
        && proxima.otimalidadeComprovada
        && Array.isArray(proxima.quantidades)
        && proxima.totalCentavos > candidatoC
      ) {
        const brutoC = proxima.totalCentavos;
        const fiscalAlvoC = candidatoC + maxComplementoC;
        if (brutoC >= fiscalAlvoC) {
          registrarCandidatoAcimaComComplemento(
            candidatos,
            modelos,
            proxima,
            candidatoC,
            maxComplementoC,
            brutoC
          );
          if (candidatos.length) {
            candidatos[candidatos.length - 1].modo = 'acima_teto_20_com_desconto';
            candidatos[candidatos.length - 1].codigo = 'OK_COMPOSICAO_TETO_20_COM_DESCONTO';
          }
        }
      }
    }
  }

  if (!candidatos.length) {
    const motivoBloqueio = (() => {
      if (
        abaixo.distribuicao_possivel === true
        && abaixo.composicao_encontrada != null
        && abaixo.codigo === 'OK_COMPOSICAO_DENTRO_DA_MARGEM'
      ) {
        return (
          'Motor encontrou composição abaixo da referência dentro da margem, mas ela não cobre o eletrônico. ' +
          'Nenhum complemento ceildado (múltiplo de R$ 0,05) atualizou o candidato oficial com composição válida na faixa.'
        );
      }
      return abaixo.motivo
        || 'Nenhuma composição válida foi encontrada abaixo ou acima da referência dentro da margem de complemento.';
    })();
    return Object.freeze({
      distribuicao_possivel: false,
      codigo: abaixo.codigo === 'OK_COMPOSICAO_DENTRO_DA_MARGEM'
        ? 'COMPOSICAO_INCOMPATIVEL_MARGEM_TOLERANCIA'
        : (abaixo.codigo || 'COMPOSICAO_INCOMPATIVEL_MARGEM_TOLERANCIA'),
      motivo: motivoBloqueio,
      complemento_dinheiro: 0,
      desconto_ajuste: 0,
      aplicou_desconto: false,
      margem_complemento_maxima: deCentavos(maxComplementoC),
      itens_compostos: [],
      busca_abaixo: abaixo
    });
  }

  candidatos.sort((a, b) => {
    if (a.distancia_centavos !== b.distancia_centavos) {
      return a.distancia_centavos - b.distancia_centavos;
    }
    if (a.complemento_centavos !== b.complemento_centavos) {
      return a.complemento_centavos - b.complemento_centavos;
    }
    if (a.desconto_ajuste_centavos !== b.desconto_ajuste_centavos) {
      return a.desconto_ajuste_centavos - b.desconto_ajuste_centavos;
    }
    if (a.bruto_centavos !== b.bruto_centavos) return a.bruto_centavos - b.bruto_centavos;
    return String(a.modo).localeCompare(String(b.modo));
  });

  const vencedor = candidatos[0];
  const candidatoOficialC = vencedor.valor_fiscal_candidato_oficial_centavos != null
    ? vencedor.valor_fiscal_candidato_oficial_centavos
    : (candidatoC + vencedor.complemento_centavos);
  return Object.freeze({
    distribuicao_possivel: true,
    codigo: vencedor.codigo,
    motivo: vencedor.modo === 'acima_teto_20_com_desconto'
      ? (
        'Composição acima do teto de 20% do dinheiro: complemento limitado ao máximo permitido, '
        + 'elegível mais próximo selecionado e desconto de ajuste no excedente.'
      )
      : (vencedor.modo === 'acima_com_complemento'
        ? (
          'Composição acima da referência eletrônica: diferença ceildada ao múltiplo de R$ 0,05, '
          + 'candidato oficial atualizado e desconto de ajuste aplicado quando o bruto supera o fiscal final.'
        )
        : (vencedor.motor_abaixo && vencedor.motor_abaixo.motivo) || 'Composição selecionada dentro da regra de complemento.'),
    valor_fiscal_candidato: deCentavos(candidatoC),
    valor_fiscal_candidato_inicial: deCentavos(candidatoC),
    valor_fiscal_candidato_oficial: deCentavos(candidatoOficialC),
    valor_fiscal_candidato_oficial_centavos: candidatoOficialC,
    candidato_oficial_atualizado: candidatoOficialC !== candidatoC,
    composicao_encontrada: deCentavos(vencedor.bruto_centavos),
    composicao_encontrada_centavos: vencedor.bruto_centavos,
    complemento_dinheiro: deCentavos(vencedor.complemento_centavos),
    complemento_dinheiro_centavos: vencedor.complemento_centavos,
    desconto_ajuste: deCentavos(vencedor.desconto_ajuste_centavos),
    desconto_ajuste_centavos: vencedor.desconto_ajuste_centavos,
    valor_fiscal_residual_final: deCentavos(candidatoOficialC),
    aplicou_desconto: vencedor.desconto_ajuste_centavos > 0,
    margem_complemento_maxima: deCentavos(maxComplementoC),
    modo: vencedor.modo,
    itens_compostos: Object.freeze((vencedor.itens_compostos || []).map((it) => Object.freeze({ ...it }))),
    busca: vencedor.busca || null,
    candidatos_avaliados: candidatos.length
  });
}

module.exports = {
  avaliarCandidatosComMotorComposicao,
  avaliarCandidatoComBuscarComposicao,
  avaliarCandidatoComComplementoDinheiro,
  avaliarComplementoFiscalIntegral,
  /** Expostos para auditoria da Sprint — confirmam a interface oficial. */
  MOTOR_OFICIAL: 'ComposicaoFiscalPedidoService',
  INTERFACE_PUBLICA: 'simularComposicao',
  NUCLEO_BUSCA: 'internos.buscarComposicao'
};
