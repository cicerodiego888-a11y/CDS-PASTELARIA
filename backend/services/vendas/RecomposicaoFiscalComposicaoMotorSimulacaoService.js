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
  PERCENTUAL_TOLERANCIA_DINHEIRO_PADRAO
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

module.exports = {
  avaliarCandidatosComMotorComposicao,
  avaliarCandidatoComBuscarComposicao,
  /** Expostos para auditoria da Sprint — confirmam a interface oficial. */
  MOTOR_OFICIAL: 'ComposicaoFiscalPedidoService',
  INTERFACE_PUBLICA: 'simularComposicao',
  NUCLEO_BUSCA: 'internos.buscarComposicao'
};
