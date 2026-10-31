/**
 * CDS — PAGAMENTO MISTO E RECOMPOSIÇÃO FISCAL — 07
 *
 * Orquestrador de simulação isolada:
 *  1) Sprint 02 — prepararContratoRecomposicaoFiscal
 *  2) Sprint 05 — calcularMargemToleranciaDinheiro
 *  3) Sprint 06 — avaliarCandidatosComMotorComposicao
 *
 * Resultado exclusivamente diagnóstico. Não fecha venda, não altera F×NF,
 * não persiste, não TEF, não SEFAZ, não autoriza NFC-e.
 *
 * @module services/vendas/RecomposicaoFiscalIntegracaoSimulacaoService
 */
'use strict';

const {
  RECOMPOSICAO_HABILITADA_EM_PRODUCAO,
  prepararContratoRecomposicaoFiscal,
  formaEhDinheiro,
  round2
} = require('./RecomposicaoFiscalContratoService');

const {
  calcularMargemToleranciaDinheiro,
  PERCENTUAL_TOLERANCIA_DINHEIRO_PADRAO
} = require('./RecomposicaoFiscalToleranciaDinheiroSimulacaoService');

const {
  avaliarCandidatosComMotorComposicao
} = require('./RecomposicaoFiscalComposicaoMotorSimulacaoService');

function erroOrq(code, message, detalhes = null) {
  const err = new Error(message);
  err.code = code;
  err.codigo = code;
  err.statusCode = 400;
  if (detalhes) err.detalhes = detalhes;
  return err;
}

function mapearStatusSimulacao(avaliacaoMotor) {
  if (!avaliacaoMotor) {
    return {
      status_simulacao: 'INCOMPATIVEL',
      motivo: 'Avaliação do motor de composição ausente.'
    };
  }
  const codigo = avaliacaoMotor.codigo;
  if (codigo === 'OK_COMPOSICAO_EXATA') {
    return {
      status_simulacao: 'EXATA',
      motivo: avaliacaoMotor.motivo || 'Composição matemática exata no candidato.'
    };
  }
  if (codigo === 'OK_COMPOSICAO_DENTRO_DA_MARGEM') {
    return {
      status_simulacao: 'COMPATIVEL_MARGEM',
      motivo: avaliacaoMotor.motivo
        || 'Composição inteira dentro da margem matemática do dinheiro.'
    };
  }
  if (
    codigo === 'COMPOSICAO_AUSENTE_NO_MOTOR'
    || codigo === 'COMPOSICAO_FISCAL_INEXISTENTE'
    || codigo === 'COMPOSICAO_BUSCA_INCONCLUSIVA'
    || codigo === 'COMPOSICAO_INCOMPATIVEL_MARGEM_TOLERANCIA'
  ) {
    return {
      status_simulacao: 'SEM_COMPOSICAO',
      motivo: avaliacaoMotor.motivo || 'Motor sem composição compatível.'
    };
  }
  return {
    status_simulacao: 'INCOMPATIVEL',
    motivo: avaliacaoMotor.motivo || 'Simulação incompatível com as regras existentes.'
  };
}

/**
 * Orquestra a simulação integrada (diagnóstico apenas).
 *
 * @param {object} entrada
 * @param {{ db?: object }} [opts] — só se usar_simular_composicao (Sprint 06)
 * @returns {Promise<object>}
 */
async function simularIntegracaoRecomposicaoFiscal(entrada = {}, opts = {}) {
  const tentaProducao = entrada.habilitar_em_producao === true
    || entrada.habilitarEmProducao === true
    || entrada.autorizacao_producao === true
    || entrada.autorizacaoProducao === true
    || entrada.execucao_operacional === true
    || entrada.execucaoOperacional === true;

  if (tentaProducao || RECOMPOSICAO_HABILITADA_EM_PRODUCAO === true) {
    throw erroOrq(
      'RECOMPOSICAO_NAO_HABILITADA_EM_PRODUCAO',
      'Integração de simulação bloqueada para produção. Sem caminho de persistência ou emissão fiscal.',
      {
        recomposicao_habilitada_em_producao: false,
        persistencia_executada: false,
        emissao_fiscal_autorizada: false
      }
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
    valor_candidato: entrada.valor_fiscal_candidato != null
      ? entrada.valor_fiscal_candidato
      : (
        entrada.valor_candidato_simulacao != null
          ? entrada.valor_candidato_simulacao
          : entrada.valorFiscalCandidato
      ),
    modelos: Array.isArray(entrada.modelos) ? entrada.modelos.slice() : [],
    capacidade_por_categoria: entrada.capacidade_por_categoria
      ? { ...entrada.capacidade_por_categoria }
      : (entrada.capacidadePorCategoria ? { ...entrada.capacidadePorCategoria } : {}),
    percentual: entrada.percentual_tolerancia_dinheiro != null
      ? Number(entrada.percentual_tolerancia_dinheiro)
      : PERCENTUAL_TOLERANCIA_DINHEIRO_PADRAO
  };

  if (snapshot.valor_candidato == null || snapshot.valor_candidato === '') {
    throw erroOrq(
      'CANDIDATO_AUSENTE',
      'Informe valor_fiscal_candidato (candidato de simulação).'
    );
  }

  // 1) Sprint 02 — contrato (valida soma pagamentos === comercial; imutabilidade).
  const contrato = prepararContratoRecomposicaoFiscal({
    total_comercial: snapshot.total_comercial,
    pagamentos: snapshot.pagamentos,
    valor_fiscal_candidato: snapshot.valor_candidato,
    itens: snapshot.itens.map((i) => ({
      produto_id: i.produto_id,
      quantidade: i.quantidade,
      subtotal: i.subtotal
    }))
  });

  // 2) Sprint 05 — margem matemática sobre dinheiro (não autoriza desconto).
  const margem = calcularMargemToleranciaDinheiro(snapshot.pagamentos, {
    percentual: snapshot.percentual
  });

  const valorDinheiro = margem.dinheiro_recebido;

  // 3) Sprint 06 — motor real de composição (simulação).
  const motor = await avaliarCandidatosComMotorComposicao({
    total_comercial: contrato.total_comercial,
    pagamentos: snapshot.pagamentos,
    valor_fiscal_candidato: snapshot.valor_candidato,
    modelos: snapshot.modelos,
    capacidade_por_categoria: snapshot.capacidade_por_categoria,
    percentual_tolerancia_dinheiro: snapshot.percentual,
    limite_estados: entrada.limite_estados,
    usar_simular_composicao: entrada.usar_simular_composicao === true,
    empresaId: entrada.empresaId,
    pedidoId: entrada.pedidoId,
    categoriasFiscais: entrada.categoriasFiscais || entrada.categorias_fiscais,
    itensFixos: entrada.itensFixos,
    dataReferencia: entrada.dataReferencia
  }, opts);

  const avaliacao = motor.avaliacoes && motor.avaliacoes[0] ? motor.avaliacoes[0] : null;
  const { status_simulacao, motivo } = mapearStatusSimulacao(avaliacao);

  const dinheiroLinhas = (contrato.pagamentos || []).filter((p) =>
    p.eh_dinheiro === true || formaEhDinheiro(p.forma_pagamento)
  );

  return Object.freeze({
    sucesso: true,
    sprint: 'CDS-PAGAMENTO-MISTO-RECOMPOSICAO-FISCAL-07',

    total_comercial: contrato.total_comercial,
    total_pagamentos: contrato.total_financeiro_recebido,
    total_financeiro_recebido: contrato.total_financeiro_recebido,
    valor_dinheiro: valorDinheiro,
    margem_matematica: margem.margem_maxima,
    percentual_tolerancia_dinheiro: margem.percentual,

    valor_candidato_simulacao: round2(Number(snapshot.valor_candidato)),
    valor_composicao_simulada: avaliacao && avaliacao.composicao_encontrada != null
      ? avaliacao.composicao_encontrada
      : null,
    diferenca_composicao: avaliacao && avaliacao.diferenca_monetaria != null
      ? avaliacao.diferenca_monetaria
      : null,

    status_simulacao,
    motivo_status: motivo,
    codigo_motor: avaliacao ? avaliacao.codigo : null,

    /** Distinção explícita: esta simulação NÃO determina o fiscal oficial. */
    valor_fiscal_oficialmente_autorizado: null,
    valor_fiscal_oficial_determinado_por_esta_simulacao: false,
    tratamento_fiscal_do_vale_pendente: true,

    habilitado_em_producao: false,
    recomposicao_habilitada_em_producao: RECOMPOSICAO_HABILITADA_EM_PRODUCAO,
    persistencia_executada: false,
    emissao_fiscal_autorizada: false,
    aplicou_desconto_automatico: false,
    alterou_pagamentos: false,
    alterou_itens: false,
    aplica_ao_fluxo_oficial: false,
    altera_motor_fxnf: false,

    etapas: Object.freeze({
      contrato_sprint_02: contrato,
      margem_sprint_05: margem,
      motor_sprint_06: motor,
      pagamentos_dinheiro_contrato: Object.freeze(dinheiroLinhas.map((p) => Object.freeze({ ...p })))
    }),

    meta: Object.freeze({
      origem: 'RECOMPOSICAO_FISCAL_INTEGRACAO_SIMULACAO_V1',
      diagnostico_apenas: true,
      margem_nao_autoriza_reducao_base_fiscal: true,
      residual_nao_classificado_automaticamente: true,
      observacao:
        'Resultado diagnóstico. Não autoriza NFC-e, desconto, alteração de estoque ' +
        'nem classificação F/NF. Validação fiscal do vale permanece pendente.'
    })
  });
}

module.exports = {
  simularIntegracaoRecomposicaoFiscal,
  mapearStatusSimulacao
};
