/**
 * CDS — PAGAMENTO MISTO E RECOMPOSIÇÃO FISCAL — 09
 *
 * Adaptador de PREPARAÇÃO da integração com o fechamento real do PDV.
 * Usa Sprint 07 (orquestrador) sem alterar criarVenda / Motor F×NF / NFC-e.
 *
 * PONTO EXATO IDENTIFICADO (leitura de VendaPagamentoService.criarVenda):
 *  1. Total comercial: validação `totalNum` (~linhas 1160–1162)
 *  2. Pagamentos: `pagamentosVenda` (~1098); soma validada em
 *     `validarSomaPagamentosVenda` DENTRO de executarVenda/executarVendaPrazo
 *     (~1779 / ~1560) — APÓS o Motor F×NF
 *  3. Distribuição oficial F×NF: `distribuirItensVendaComValorFiscalEfetivo` (~1308)
 *  4. Persistência: INSERT vendas / vendas_itens (~1634+ / ~1361+)
 *  5. Estoque: `reduzirEstoqueDistribuido` após cada item (~1398)
 *  6. Emissão: `responderVendaComFiscal` → `emitirFiscalSeSolicitado` (~1949)
 *
 * Nota: body.valor_fiscal / valor_nao_fiscal são ignorados (~1106–1108).
 *
 * Sprint 10: `executarDiagnosticoRecomposicaoNoFechamento` é chamado em criarVenda
 * ANTES do Motor F×NF — modo diagnóstico apenas (não substitui resultadoMotor).
 *
 * Sprint 13/14: quando o diagnóstico está autorizado e faltam modelos no harness,
 * tenta carregar o contexto real via PedidoPdvComposicaoService
 * (`carregarModelosRefrigerante`). Sprint 14: `pedido_id` opcional (balcão);
 * exige empresaId+db. Sem empresa/db → não inventa dados.
 * Continua sem substituir o Motor F×NF.
 *
 * @module services/vendas/RecomposicaoFiscalFechamentoAdaptadorService
 */
'use strict';

const {
  RECOMPOSICAO_HABILITADA_EM_PRODUCAO,
  round2
} = require('./RecomposicaoFiscalContratoService');

const {
  calcularValorFiscalLiquido,
  aplicarValorFiscalLiquidoNosItens
} = require('./valorFiscalLiquido');

const {
  simularIntegracaoRecomposicaoFiscal
} = require('./RecomposicaoFiscalIntegracaoSimulacaoService');

/** Contrato estático do ponto — sem wiring operacional. */
const PONTO_INTEGRACAO_FECHAMENTO = Object.freeze({
  arquivo: 'backend/services/vendas/VendaPagamentoService.js',
  funcao: 'criarVenda',
  rota: 'POST /api/vendas → VendaApplicationService.criarVenda → VendaPagamentoService.criarVenda',
  momento_diagnostico_sprint_10:
    'após montar pagamentosParaMotor; imediatamente antes de ' +
    'distribuirItensVendaComValorFiscalEfetivo',
  momento_recomendado_futuro:
    'após validar total/itens e montar pagamentosVenda; antes de ' +
    'distribuirItensVendaComValorFiscalEfetivo e da persistência',
  momento_atual_soma_pagamentos:
    'validarSomaPagamentosVenda ocorre após o Motor, em executarVenda (~1779) ' +
    'e executarVendaPrazo (~1560)',
  body_valor_fiscal_ignorado: true,
  wired_nesta_sprint: true,
  modo: 'DIAGNOSTICO_ISOLADO',
  altera_criar_venda: false,
  substitui_motor_fxnf: false,
  origem_modelos_sprint_13:
    'PedidoPdvComposicaoService.carregarModelosRefrigerante ' +
    '(via obterContextoComposicaoPdvParaDiagnostico) quando empresaId+db ' +
    'estão disponíveis; pedidoId opcional (balcão); harness pode injetar modelos',
  origem_modelos_sprint_14:
    'Mesma fonte: carregarModelosRefrigerante isolado por empresaId; ' +
    'sem pedido_id usa crédito de reserva vazio (obterCreditoReservaPedido)',
  observa:
    'Diagnóstico não altera resultadoMotor, vendas.total, estoque, TEF nem NFC-e. ' +
    'Candidato só via fonte interna legítima — nunca inventado a partir do total. ' +
    'Sprint 13–16: composição mapeada a produtoId/quantidade via comporItens; ' +
    'não reescreve itens do carrinho nem autoriza fiscal. ' +
    'Sprint 16: modo_efetivo distingue proposta / validada / aplicada. ' +
    'Sprint 17: distribuição efetiva só via distribuidor oficial com autorização interna.'
});

const MUDANCAS_OPERACIONAIS_PENDENTES = Object.freeze([
  'Validação fiscal do vale / candidato (R$ 40) — bloqueia aplicação da distribuição oficial.',
  'Decisão de negócio sobre margem 20% do dinheiro vs desconto comercial (não automática).',
  'Autorização PO/Tech Lead para RECOMPOSICAO_HABILITADA_EM_PRODUCAO após vale validado.',
  'Não criar feature flag ativável pelo frontend nesta linha.',
  'CDS_RECOMPOSICAO_APLICAR_DISTRIBUICAO=1 NÃO aplica F×NF — apenas registra bloqueio explícito.'
]);

/**
 * Modos operacionais explícitos (Sprint 16).
 * Nunca confundir diagnóstico/homologação com distribuição aplicada.
 */
const MODOS_OPERACIONAIS = Object.freeze({
  DESLIGADO: 'DESLIGADO',
  DIAGNOSTICO: 'DIAGNOSTICO',
  HOMOLOGACAO: 'HOMOLOGACAO',
  APLICACAO_BLOQUEADA: 'APLICACAO_BLOQUEADA'
});

/** Runbook do primeiro teste presencial (não executa venda física automaticamente). */
const RUNBOOK_TESTE_REAL_PDV = Object.freeze({
  sprint: 'CDS-PAGAMENTO-MISTO-RECOMPOSICAO-FISCAL-16',
  cenario: Object.freeze({
    total_comercial: 50,
    pagamentos: Object.freeze([
      Object.freeze({ forma: 'debito', valor: 20 }),
      Object.freeze({ forma: 'credito', valor: 20 }),
      Object.freeze({ forma: 'dinheiro', valor: 10 })
    ]),
    candidato: 40,
    margem_esperada: 2
  }),
  ativar_teste: Object.freeze([
    'No backend (NÃO no frontend), definir:',
    '  CDS_RECOMPOSICAO_DIAGNOSTICO=1',
    '  CDS_RECOMPOSICAO_DIAGNOSTICO_CANDIDATO=40',
    '  CDS_RECOMPOSICAO_HOMOLOGACAO=1',
    'Opcional (só evidencia bloqueio): CDS_RECOMPOSICAO_APLICAR_DISTRIBUICAO=1',
    'Reiniciar o processo Node/Electron do backend para carregar o env.',
    'Confirmar empresa de teste no PDV (mesmo empresa_id do estoque/catálogo).'
  ]),
  desativar_teste: Object.freeze([
    'Remover ou zerar CDS_RECOMPOSICAO_DIAGNOSTICO, CDS_RECOMPOSICAO_DIAGNOSTICO_CANDIDATO,',
    'CDS_RECOMPOSICAO_HOMOLOGACAO e CDS_RECOMPOSICAO_APLICAR_DISTRIBUICAO.',
    'Reiniciar o backend. Fechamento volta ao legado imediatamente.'
  ]),
  passos_presenciais: Object.freeze([
    '1. Confirmar ambiente/empresa de teste (não produção).',
    '2. Confirmar logs: contexto carregarModelosRefrigerante sem erro de empresa/db.',
    '3. Confirmar modo_efetivo=HOMOLOGACAO (ou APLICACAO_BLOQUEADA se flag aplicar=1).',
    '4. Executar UMA venda PDV: total 50; débito 20; crédito 20; dinheiro 10.',
    '5. NÃO emitir NFC-e; se TEF for físico, usar apenas se o operador autorizar — este runbook não dispara TEF.',
    '6. Ler log [cds-recomposicao-operacional]: proposta_calculada, proposta_validada, distribuicao_aplicada.',
    '7. Conferir vendas.total=50, pagamentos 20+20+10, quantidades F×NF do Motor inalteradas pela proposta.',
    '8. Se divergência inesperada: desativar flags (rollback) e interromper novos testes.'
  ]),
  interpretacao: Object.freeze({
    proposta_calculada: 'Motor de composição retornou itens/quantidades/valor.',
    proposta_validada: 'Checks comerciais + contrato F×NF OK em homologação.',
    distribuicao_aplicada:
      'Sempre false nesta sprint — Motor F×NF oficial não é substituído até vale validado.'
  })
});

/** Contrato de entrada/saída do Motor F×NF (documentação + validação Sprint 15). */
const CONTRATO_MOTOR_FXNF = Object.freeze({
  funcao: 'distribuirItensVendaComValorFiscalEfetivo',
  arquivo: 'backend/services/distribuidorEstoqueVenda.js',
  entrada: Object.freeze({
    entradas: 'itens da venda + saldos F/NF por produto',
    vendaFiscal: 'boolean',
    opcoes: 'pagamentos, desconto, acrescimo, midpAtivo, politicaFiscalComercial'
  }),
  saida: Object.freeze({
    sucesso: 'boolean',
    itens: 'quantidade_fiscal, quantidade_nao_fiscal, valor_fiscal, valor_nao_fiscal',
    valorFiscalEfetivo: 'number',
    totalVenda: 'number (F+NF; espelha comercial líquido)'
  }),
  autoridade: 'Motor F×NF permanece autoridade da distribuição oficial',
  aplicacao_recomposicao_nesta_sprint: false,
  motivo_bloqueio_aplicacao:
    'Tratamento fiscal do vale / redução 50→40 não validado; ' +
    'aplicar candidato alteraria valor_fiscal oficial e estoque F/NF indevidamente.'
});

function erroAdapt(code, message, detalhes = null) {
  const err = new Error(message);
  err.code = code;
  err.codigo = code;
  err.statusCode = 400;
  if (detalhes) err.detalhes = detalhes;
  return err;
}

/**
 * Extrai snapshot imutável a partir do payload de fechamento (body / dados PDV).
 * Não muta `payload`. Não inventa produtos nem modelos de composição.
 *
 * @param {object} payload — tipicamente req.body ou objeto equivalente do PDV
 */
function extrairSnapshotFechamento(payload = {}) {
  const total = payload.total != null ? payload.total : payload.total_comercial;
  const pagamentos = Array.isArray(payload.pagamentos)
    ? payload.pagamentos.map((p) => ({
      forma_pagamento: p.forma_pagamento,
      valor: p.valor,
      tipo_recebimento: p.tipo_recebimento != null ? p.tipo_recebimento : undefined
    }))
    : [];
  const itens = Array.isArray(payload.itens)
    ? payload.itens.map((i) => ({
      produto_id: i.produto_id != null ? i.produto_id : i.id,
      quantidade: i.quantidade,
      subtotal: i.subtotal,
      preco_unitario: i.preco_unitario
    }))
    : [];

  const candidato = payload.valor_fiscal_candidato != null
    ? payload.valor_fiscal_candidato
    : (
      payload.valor_candidato_simulacao != null
        ? payload.valor_candidato_simulacao
        : payload.valorFiscalCandidato
    );

  // Modelos/capacidade só se o chamador fornecer explicitamente (testes / futuro).
  // NÃO deriva modelos a partir dos itens da venda (evita inventar complementos).
  const modelos = Array.isArray(payload.modelos_composicao)
    ? payload.modelos_composicao.slice()
    : (Array.isArray(payload.modelos) ? payload.modelos.slice() : []);
  const capacidade = payload.capacidade_por_categoria
    ? { ...payload.capacidade_por_categoria }
    : (
      payload.capacidadePorCategoria
        ? { ...payload.capacidadePorCategoria }
        : {}
    );

  return Object.freeze({
    total_comercial: total,
    pagamentos: Object.freeze(pagamentos.map((p) => Object.freeze({ ...p }))),
    itens: Object.freeze(itens.map((i) => Object.freeze({ ...i }))),
    valor_fiscal_candidato: candidato,
    modelos,
    capacidade_por_categoria: Object.freeze({ ...capacidade }),
    desconto: payload.desconto != null ? Number(payload.desconto) : 0,
    acrescimo: payload.acrescimo != null ? Number(payload.acrescimo) : 0,
    forma_pagamento: payload.forma_pagamento != null ? String(payload.forma_pagamento) : null,
    // Informativos do body — NÃO usados como fiscal oficial
    valor_fiscal_body_informativo: payload.valor_fiscal,
    valor_nao_fiscal_body_informativo: payload.valor_nao_fiscal
  });
}

/**
 * Prepara proposta diagnóstica a partir dos dados reais do fechamento.
 * Não persiste, não TEF, não SEFAZ, não altera criarVenda.
 *
 * @param {object} payloadFechamento
 * @param {{ db?: object }} [opts]
 */
async function prepararPropostaRecomposicaoDoFechamento(payloadFechamento = {}, opts = {}) {
  if (
    payloadFechamento.habilitar_em_producao === true
    || payloadFechamento.habilitarEmProducao === true
    || payloadFechamento.autorizacao_producao === true
    || payloadFechamento.execucao_operacional === true
    || payloadFechamento.ativar_pelo_frontend === true
  ) {
    throw erroAdapt(
      'RECOMPOSICAO_NAO_HABILITADA_EM_PRODUCAO',
      'Adaptador de fechamento bloqueado para ativação operacional/produção. Sem flag de frontend.',
      { wired_nesta_sprint: false }
    );
  }

  const snapshot = extrairSnapshotFechamento(payloadFechamento);
  const itensOriginais = snapshot.itens.map((i) => ({ ...i }));
  const pagamentosOriginais = snapshot.pagamentos.map((p) => ({ ...p }));
  const totalOriginal = snapshot.total_comercial;

  const simulacao = await simularIntegracaoRecomposicaoFiscal({
    total_comercial: snapshot.total_comercial,
    pagamentos: snapshot.pagamentos,
    itens: snapshot.itens,
    valor_fiscal_candidato: snapshot.valor_fiscal_candidato,
    modelos: snapshot.modelos,
    capacidade_por_categoria: snapshot.capacidade_por_categoria,
    percentual_tolerancia_dinheiro: payloadFechamento.percentual_tolerancia_dinheiro
  }, opts);

  // Garantia explícita: simulacao não pode ter alterado as cópias de origem do adaptador
  const totalPreservado = round2(Number(totalOriginal)) === round2(Number(simulacao.total_comercial));
  const qtdsOriginais = itensOriginais.map((i) => Number(i.quantidade));
  const qtdsSim = (simulacao.etapas && simulacao.etapas.contrato_sprint_02
    && Array.isArray(simulacao.etapas.contrato_sprint_02.itens))
    ? simulacao.etapas.contrato_sprint_02.itens.map((i) => Number(i.quantidade))
    : qtdsOriginais;

  return Object.freeze({
    sucesso: true,
    sprint: 'CDS-PAGAMENTO-MISTO-RECOMPOSICAO-FISCAL-09',
    ponto_integracao: PONTO_INTEGRACAO_FECHAMENTO,
    mudancas_operacionais_pendentes: MUDANCAS_OPERACIONAIS_PENDENTES,

    proposta: Object.freeze({
      total_comercial: simulacao.total_comercial,
      total_pagamentos: simulacao.total_pagamentos,
      valor_dinheiro: simulacao.valor_dinheiro,
      margem_matematica: simulacao.margem_matematica,
      valor_candidato_simulacao: simulacao.valor_candidato_simulacao,
      valor_composicao_simulada: simulacao.valor_composicao_simulada,
      diferenca_composicao: simulacao.diferenca_composicao,
      status_simulacao: simulacao.status_simulacao,
      motivo_status: simulacao.motivo_status,
      codigo_motor: simulacao.codigo_motor,
      valor_fiscal_oficialmente_autorizado: null,
      valor_fiscal_oficial_determinado_por_esta_proposta: false,
      tratamento_fiscal_do_vale_pendente: true,
      body_valor_fiscal_ignorado_pelo_criar_venda: true
    }),

    preservacao: Object.freeze({
      total_comercial_original: totalOriginal != null ? round2(Number(totalOriginal)) : null,
      total_comercial_proposta: simulacao.total_comercial,
      total_comercial_preservado: totalPreservado,
      pagamentos_originais: Object.freeze(pagamentosOriginais.map((p) => Object.freeze({ ...p }))),
      itens_originais: Object.freeze(itensOriginais.map((i) => Object.freeze({ ...i }))),
      quantidades_originais: Object.freeze(qtdsOriginais.slice()),
      quantidades_no_contrato: Object.freeze(qtdsSim.slice()),
      nao_aplicou_desconto: simulacao.aplicou_desconto_automatico === false,
      nao_alterou_pagamentos: simulacao.alterou_pagamentos === false,
      nao_alterou_itens: simulacao.alterou_itens === false
    }),

    simulacao_integrada: simulacao,

    habilitado_em_producao: false,
    recomposicao_habilitada_em_producao: RECOMPOSICAO_HABILITADA_EM_PRODUCAO,
    wired_em_criar_venda: false,
    persistencia_executada: false,
    emissao_fiscal_autorizada: false,
    substitui_motor_fxnf: false,
    altera_vendas_total: false,
    chama_tef: false,
    chama_sefaz: false,

    meta: Object.freeze({
      origem: 'RECOMPOSICAO_FISCAL_FECHAMENTO_ADAPTADOR_V1',
      diagnostico_apenas: true,
      margem_nao_e_desconto: true,
      residual_nao_classificado_automaticamente: true,
      observacao:
        'Proposta diagnóstica a partir do payload de fechamento. ' +
        'Fiscal oficial não determinado por esta proposta.'
    })
  });
}

/** Env backend-only (padrão CDS_*). Nunca lido do body/frontend. */
const ENV_DIAGNOSTICO_ATIVO = 'CDS_RECOMPOSICAO_DIAGNOSTICO';
const ENV_DIAGNOSTICO_CANDIDATO = 'CDS_RECOMPOSICAO_DIAGNOSTICO_CANDIDATO';
/** Sprint 15 — homologação controlada (validação integrada). Desligada por padrão. */
const ENV_HOMOLOGACAO_ATIVA = 'CDS_RECOMPOSICAO_HOMOLOGACAO';
/**
 * Sprint 16 — intenção de aplicar distribuição. NUNCA aplica sozinha.
 * Se =1, o modo efetivo vira APLICACAO_BLOQUEADA (evidência explícita).
 */
const ENV_APLICAR_DISTRIBUICAO = 'CDS_RECOMPOSICAO_APLICAR_DISTRIBUICAO';
/**
 * Sprint 17 — única autorização interna que encaminha a proposta validada
 * ao distribuidor oficial. Desligada por padrão. Não é lida do body/frontend.
 * CDS_RECOMPOSICAO_APLICAR_DISTRIBUICAO continua sendo bloqueio, não habilitação.
 */
const ENV_DISTRIBUICAO_OFICIAL = 'CDS_RECOMPOSICAO_HOMOLOGACAO_DISTRIBUIR';

const CONTRATO_DISTRIBUICAO_OFICIAL = Object.freeze({
  funcao: 'distribuirItensVendaComValorFiscalEfetivo',
  arquivo: 'backend/services/distribuidorEstoqueVenda.js',
  assinatura: 'distribuirItensVendaComValorFiscalEfetivo(entradas, vendaFiscal, opcoes)',
  entradas: '[{ item: { produto_id, quantidade, preco_unitario, subtotal, unidade }, saldoFiscal, saldoNaoFiscal }]',
  venda_fiscal: 'true na quantidade proposta (bucket fiscal); false no residual comercial (bucket não fiscal)',
  opcoes: 'cópia dos pagamentos originais; desconto e acréscimo comerciais rateados uma vez por calcularValorFiscalLiquido; cada chamada recebe só a parcela do seu bucket; a margem de dinheiro não entra como desconto',
  autorizacao: ENV_DISTRIBUICAO_OFICIAL,
  flag_legada_nao_habilita: ENV_APLICAR_DISTRIBUICAO,
  baixa_no_fechamento: 'reduzirEstoqueDistribuido no criarVenda (aplicarSaldo false na ponte)',
  producao_habilitada: false
});

/**
 * Ativação interna de homologação. Nunca lê body/frontend.
 * Desligada por padrão. Não autoriza aplicar distribuição fiscal oficial.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {object} [harness] — req.__cdsRecomposicaoHomologacao (somente testes)
 */
function obterAtivacaoHomologacaoInterna(env = process.env, harness = null) {
  if (harness && typeof harness === 'object' && harness.ativa === true) {
    return Object.freeze({
      ativa: true,
      fonte: 'harness_teste',
      permite_aplicar_distribuicao_oficial: false,
      producao: false,
      env_flag: ENV_HOMOLOGACAO_ATIVA
    });
  }
  if (String(env[ENV_HOMOLOGACAO_ATIVA] || '') !== '1') {
    return Object.freeze({
      ativa: false,
      fonte: null,
      permite_aplicar_distribuicao_oficial: false,
      producao: false,
      env_flag: ENV_HOMOLOGACAO_ATIVA
    });
  }
  return Object.freeze({
    ativa: true,
    fonte: 'backend_env',
    permite_aplicar_distribuicao_oficial: false,
    producao: false,
    env_flag: ENV_HOMOLOGACAO_ATIVA
  });
}

/**
 * Resolve o modo operacional efetivo a partir das flags internas existentes.
 * Frontend/body nunca entram nesta resolução.
 *
 * @param {object} [opcoes]
 */
function resolverModoOperacionalRecomposicao(opcoes = {}) {
  const env = opcoes.env || process.env;
  const diagnosticoInterno = opcoes.diagnosticoInterno != null
    ? opcoes.diagnosticoInterno
    : resolverDiagnosticoInternoParaFechamento({
      harnessReq: opcoes.harnessDiagnostico || null,
      env
    });
  const homolog = obterAtivacaoHomologacaoInterna(
    env,
    opcoes.harnessHomologacao || null
  );
  const tentarAplicar = String(env[ENV_APLICAR_DISTRIBUICAO] || '') === '1'
    || (opcoes.harnessAplicar && opcoes.harnessAplicar.tentar === true);
  const candidato = resolverCandidatoDiagnosticoFechamento({
    diagnosticoInterno,
    candidatoInterno: opcoes.candidatoInterno
  });
  const diagnosticoSolicitado = candidato != null;

  let modo = MODOS_OPERACIONAIS.DESLIGADO;
  if (tentarAplicar) {
    // Intenção de aplicar ≠ aplicação. Sempre bloqueado até vale/produção.
    modo = MODOS_OPERACIONAIS.APLICACAO_BLOQUEADA;
  } else if (homolog.ativa) {
    modo = MODOS_OPERACIONAIS.HOMOLOGACAO;
  } else if (diagnosticoSolicitado) {
    modo = MODOS_OPERACIONAIS.DIAGNOSTICO;
  }

  return Object.freeze({
    modo_efetivo: modo,
    diagnostico_solicitado: diagnosticoSolicitado,
    homologacao_ativa: homolog.ativa === true,
    intencao_aplicar_distribuicao: tentarAplicar === true,
    distribuicao_aplicada: false,
    permite_aplicar_distribuicao_oficial: false,
    producao: RECOMPOSICAO_HABILITADA_EM_PRODUCAO === true,
    candidato,
    flags: Object.freeze({
      [ENV_DIAGNOSTICO_ATIVO]: String(env[ENV_DIAGNOSTICO_ATIVO] || '') === '1',
      [ENV_DIAGNOSTICO_CANDIDATO]: env[ENV_DIAGNOSTICO_CANDIDATO] != null
        ? String(env[ENV_DIAGNOSTICO_CANDIDATO])
        : null,
      [ENV_HOMOLOGACAO_ATIVA]: homolog.ativa === true,
      [ENV_APLICAR_DISTRIBUICAO]: tentarAplicar === true,
      [ENV_DISTRIBUICAO_OFICIAL]: String(env[ENV_DISTRIBUICAO_OFICIAL] || '') === '1'
    }),
    aviso:
      tentarAplicar
        ? 'CDS_RECOMPOSICAO_APLICAR_DISTRIBUICAO=1 detectado: aplicação operacional BLOQUEADA '
          + '(vale fiscal / produção). Distribuição oficial permanece o Motor F×NF.'
        : (
          homolog.ativa && !diagnosticoSolicitado
            ? 'Homologação ligada sem candidato: nenhuma proposta será calculada.'
            : null
        )
  });
}

/**
 * Compatibilidade entre composição (catálogo refrigerantes) e itens vendidos.
 * A composição NÃO reescreve o carrinho; é proposta complementar via mecanismo PDV.
 */
function avaliarCompatibilidadeComItensVendidos(params = {}) {
  const itensVenda = Array.isArray(params.itensVenda) ? params.itensVenda : [];
  const itensProposta = Array.isArray(params.itensProposta) ? params.itensProposta : [];
  const totalComercial = params.totalComercial != null
    ? round2(Number(params.totalComercial))
    : null;
  const valorComposicao = params.valorComposicao != null
    ? round2(Number(params.valorComposicao))
    : null;

  const somaSubtotaisVenda = round2(itensVenda.reduce(
    (s, i) => s + Number(i.subtotal != null ? i.subtotal : 0),
    0
  ));
  const propostaComQuantidadesValidas = itensProposta.length > 0
    && itensProposta.every((it) => (
      Number.isInteger(Number(it.produto_id))
      && Number(it.produto_id) > 0
      && Number.isSafeInteger(Number(it.quantidade))
      && Number(it.quantidade) > 0
    ));

  const comercialPreservado = totalComercial == null
    || itensVenda.length === 0
    || Math.abs(somaSubtotaisVenda - totalComercial) <= 0.05;

  const composicaoDentroDoComercial = valorComposicao == null || totalComercial == null
    || valorComposicao <= totalComercial + 0.009;

  const compativel = propostaComQuantidadesValidas
    && comercialPreservado
    && composicaoDentroDoComercial;

  return Object.freeze({
    compativel,
    proposta_reescreve_carrinho: false,
    itens_venda_preservados: true,
    itens_proposta_sao_catalogo_composicao: true,
    proposta_com_quantidades_validas: propostaComQuantidadesValidas,
    comercial_preservado: comercialPreservado,
    composicao_dentro_do_comercial: composicaoDentroDoComercial,
    soma_subtotais_venda: somaSubtotaisVenda,
    total_comercial: totalComercial,
    valor_composicao: valorComposicao,
    itens_venda: Object.freeze(itensVenda.map((i) => Object.freeze({
      produto_id: i.produto_id != null ? i.produto_id : i.id,
      quantidade: i.quantidade,
      subtotal: i.subtotal
    }))),
    itens_proposta: Object.freeze(itensProposta.map((i) => Object.freeze({ ...i }))),
    motivo: compativel
      ? 'Composição com quantidades válidas; carrinho comercial preservado; proposta não reescreve itens vendidos.'
      : (
        !propostaComQuantidadesValidas
          ? 'Itens/quantidades da proposta inválidos ou ausentes.'
          : (
            !comercialPreservado
              ? 'Subtotais dos itens vendidos divergem do total comercial.'
              : 'Valor da composição excede o total comercial.'
          )
      )
  });
}

/**
 * Relatório operacional unificado: proposta × validada × aplicada.
 */
function montarRelatorioOperacionalRecomposicao(params = {}) {
  const modoInfo = params.modoInfo || resolverModoOperacionalRecomposicao(params);
  const diagnostico = params.diagnostico || null;
  const validacao = params.validacao || null;

  const propostaCalculada = Boolean(
    diagnostico
    && diagnostico.solicitado
    && (
      diagnostico.evento === 'composicao_encontrada'
      || diagnostico.status_simulacao === 'EXATA'
      || diagnostico.status_simulacao === 'COMPATIVEL_MARGEM'
    )
  );
  const propostaValidada = Boolean(
    validacao
    && validacao.composicao_validada_em_homologacao === true
  );
  const distribuicaoAplicada = params.distribuicaoAplicada === true
    && params.resultadoOficial
    && params.resultadoOficial.sucesso === true;

  const itensProposta = (validacao && validacao.itens_composicao)
    || (
      diagnostico && diagnostico.mapeamento_composicao
        ? diagnostico.mapeamento_composicao.itens_proposta
        : []
    )
    || [];

  const compat = avaliarCompatibilidadeComItensVendidos({
    itensVenda: params.itensVenda || params.itens || [],
    itensProposta,
    totalComercial: params.totalComercial,
    valorComposicao: validacao && validacao.valor_composicao != null
      ? validacao.valor_composicao
      : (
        diagnostico && diagnostico.proposta && diagnostico.proposta.proposta
          ? diagnostico.proposta.proposta.valor_composicao_simulada
          : null
      )
  });

  return Object.freeze({
    sprint: 'CDS-PAGAMENTO-MISTO-RECOMPOSICAO-FISCAL-16',
    modo_efetivo: modoInfo.modo_efetivo,
    flags: modoInfo.flags,
    aviso: modoInfo.aviso,
    proposta_calculada: propostaCalculada,
    proposta_validada: propostaValidada,
    distribuicao_aplicada: distribuicaoAplicada,
    // Transparência: homologação ≠ aplicação
    nao_confundir_validacao_com_aplicacao: true,
    resultado_motor_inalterado: params.resultado_motor_inalterado !== false,
    substitui_motor_fxnf: false,
    compatibilidade_itens_vendidos: compat,
    diagnostico_evento: diagnostico ? diagnostico.evento : null,
    validacao_estado: validacao ? validacao.estado : null,
    valor_candidato: validacao && validacao.valor_candidato != null
      ? validacao.valor_candidato
      : modoInfo.candidato,
    valor_composicao: validacao ? validacao.valor_composicao : null,
    margem_matematica: validacao ? validacao.margem_matematica : null,
    motivo_distribuicao_nao_aplicada: distribuicaoAplicada
      ? null
      : (
        modoInfo.modo_efetivo === MODOS_OPERACIONAIS.APLICACAO_BLOQUEADA
          ? CONTRATO_MOTOR_FXNF.motivo_bloqueio_aplicacao
          : (
            modoInfo.modo_efetivo === MODOS_OPERACIONAIS.DESLIGADO
              ? 'Recomposição desligada (sem flags internas).'
              : 'Modo atual calcula/valida proposta; aplicação operacional não habilitada.'
          )
      ),
    runbook: RUNBOOK_TESTE_REAL_PDV
  });
}

/**
 * Configuração interna do backend para acionar o diagnóstico no PDV normal.
 * Exige CDS_RECOMPOSICAO_DIAGNOSTICO=1 e candidato explícito em
 * CDS_RECOMPOSICAO_DIAGNOSTICO_CANDIDATO (não derivado do total da venda).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {object|null} diagnosticoInterno ou null
 */
function obterDiagnosticoInternoBackend(env = process.env) {
  if (String(env[ENV_DIAGNOSTICO_ATIVO] || '') !== '1') {
    return null;
  }
  const bruto = env[ENV_DIAGNOSTICO_CANDIDATO];
  if (bruto == null || String(bruto).trim() === '') {
    return null;
  }
  const n = Number(bruto);
  if (!Number.isFinite(n) || n < 0) {
    return null;
  }
  return Object.freeze({
    fonte: 'backend_env',
    valor_fiscal_candidato: round2(n)
    // modelos não são inventados aqui — ausência ⇒ composição SEM_COMPOSICAO no motor
  });
}

/**
 * Resolve o objeto de diagnóstico interno para o hook de criarVenda.
 * Prioridade: harness de teste (`req.__cdsRecomposicaoDiagnostico`) > env backend.
 * Nunca usa body do cliente.
 *
 * @param {object} [opcoes]
 * @param {object|null} [opcoes.harnessReq] — req.__cdsRecomposicaoDiagnostico
 * @param {NodeJS.ProcessEnv} [opcoes.env]
 */
function resolverDiagnosticoInternoParaFechamento(opcoes = {}) {
  const harness = opcoes.harnessReq;
  if (harness && typeof harness === 'object') {
    return harness;
  }
  return obterDiagnosticoInternoBackend(opcoes.env || process.env);
}

/**
 * Resolve candidato de simulação SEM inventar a partir do total comercial.
 * Fonte legítima: harness interno ou env backend (via diagnosticoInterno).
 * Não usa body.valor_fiscal (ignorado pelo criarVenda oficial).
 * Não habilita produção a partir de flags do cliente.
 *
 * @param {object} fonte
 * @returns {number|null}
 */
function resolverCandidatoDiagnosticoFechamento(fonte = {}) {
  const interno = fonte.diagnosticoInterno && typeof fonte.diagnosticoInterno === 'object'
    ? fonte.diagnosticoInterno
    : null;

  const bruto = fonte.candidatoInterno != null
    ? fonte.candidatoInterno
    : (
      interno && interno.valor_fiscal_candidato != null
        ? interno.valor_fiscal_candidato
        : (interno && interno.valor_candidato_simulacao != null
          ? interno.valor_candidato_simulacao
          : null)
    );

  if (bruto == null || bruto === '') return null;
  const n = Number(bruto);
  if (!Number.isFinite(n) || n < 0) return null;
  return round2(n);
}

function montarResumoSeguroDiagnostico(propostaOut) {
  if (!propostaOut || !propostaOut.proposta) {
    return Object.freeze({ status: 'desconhecido' });
  }
  const p = propostaOut.proposta;
  return Object.freeze({
    status_simulacao: p.status_simulacao || null,
    codigo_motor: p.codigo_motor || null,
    valor_candidato_simulacao: p.valor_candidato_simulacao != null
      ? p.valor_candidato_simulacao
      : null,
    valor_composicao_simulada: p.valor_composicao_simulada != null
      ? p.valor_composicao_simulada
      : null,
    diferenca_composicao: p.diferenca_composicao != null ? p.diferenca_composicao : null,
    margem_matematica: p.margem_matematica != null ? p.margem_matematica : null,
    total_comercial: p.total_comercial != null ? p.total_comercial : null
  });
}

/**
 * Sprint 13 — resolve modelos/capacidade para o diagnóstico.
 * Prioridade: modelos já no harness interno > carga via fonte PDV existente.
 * Nunca inventa catálogo a partir dos itens da venda.
 *
 * @param {object} opcoes
 * @returns {Promise<object>}
 */
async function resolverContextoComposicaoNoFechamento(opcoes = {}) {
  const interno = opcoes.diagnosticoInterno && typeof opcoes.diagnosticoInterno === 'object'
    ? opcoes.diagnosticoInterno
    : {};
  const modelosHarness = Array.isArray(interno.modelos) ? interno.modelos : [];
  if (modelosHarness.length > 0) {
    return Object.freeze({
      suficiente: true,
      motivo: null,
      origem: interno.fonte_modelos || 'harness_diagnostico_interno',
      modelos: modelosHarness,
      capacidade_por_categoria: Object.freeze({
        ...(interno.capacidade_por_categoria || {})
      }),
      modo: interno.modo || 'harness',
      empresa_id: interno.empresa_id != null ? interno.empresa_id : null,
      pedido_id: interno.pedido_id != null ? interno.pedido_id : null,
      carregado_do_pedido: false,
      carregado_do_balcao: false
    });
  }

  let carregar = typeof opcoes.carregarContextoComposicao === 'function'
    ? opcoes.carregarContextoComposicao
    : null;

  if (!carregar) {
    // Lazy require evita acoplamento circular e permite mock nos testes.
    try {
      const pdv = require('./PedidoPdvComposicaoService');
      carregar = typeof pdv.obterContextoComposicaoPdvParaDiagnostico === 'function'
        ? pdv.obterContextoComposicaoPdvParaDiagnostico
        : null;
    } catch (_reqErr) {
      carregar = null;
    }
  }

  if (!carregar) {
    return Object.freeze({
      suficiente: false,
      motivo: 'fonte_pdv_indisponivel',
      origem: 'PedidoPdvComposicaoService.carregarModelosRefrigerante',
      modelos: Object.freeze([]),
      capacidade_por_categoria: Object.freeze({}),
      modo: null,
      empresa_id: null,
      pedido_id: null,
      carregado_do_pedido: false,
      carregado_do_balcao: false
    });
  }

  const residualCentavos = Number.isSafeInteger(Number(opcoes.residualCentavos))
    && Number(opcoes.residualCentavos) > 0
    ? Number(opcoes.residualCentavos)
    : (
      Number.isFinite(Number(opcoes.totalComercial))
        ? Math.round(Number(opcoes.totalComercial) * 100)
        : 0
    );

  const pedidoBruto = opcoes.pedidoId != null && opcoes.pedidoId !== ''
    ? Number(opcoes.pedidoId)
    : null;
  const pedidoId = Number.isInteger(pedidoBruto) && pedidoBruto > 0 ? pedidoBruto : null;

  try {
    const ctx = await carregar({
      empresaId: opcoes.empresaId,
      pedidoId,
      residualCentavos,
      db: opcoes.db,
      agora: opcoes.agora
    });
    const modo = (ctx && ctx.modo)
      || (pedidoId != null ? 'pedido' : 'balcao');
    return Object.freeze({
      suficiente: ctx && ctx.suficiente === true,
      motivo: ctx && ctx.motivo ? ctx.motivo : (ctx && ctx.suficiente ? null : 'contexto_insuficiente'),
      origem: (ctx && ctx.origem) || 'PedidoPdvComposicaoService.carregarModelosRefrigerante',
      modelos: ctx && Array.isArray(ctx.modelos) ? ctx.modelos : [],
      capacidade_por_categoria: Object.freeze({
        ...((ctx && ctx.capacidade_por_categoria) || {})
      }),
      modo,
      empresa_id: ctx && ctx.empresa_id != null
        ? ctx.empresa_id
        : (opcoes.empresaId != null ? Number(opcoes.empresaId) : null),
      pedido_id: ctx && ctx.pedido_id != null ? ctx.pedido_id : pedidoId,
      carregado_do_pedido: modo === 'pedido',
      carregado_do_balcao: modo === 'balcao',
      invalidos: ctx && Array.isArray(ctx.invalidos) ? ctx.invalidos : []
    });
  } catch (err) {
    return Object.freeze({
      suficiente: false,
      motivo: 'erro_carga_contexto_pdv',
      origem: 'PedidoPdvComposicaoService.carregarModelosRefrigerante',
      modelos: Object.freeze([]),
      capacidade_por_categoria: Object.freeze({}),
      modo: pedidoId != null ? 'pedido' : 'balcao',
      empresa_id: opcoes.empresaId != null ? Number(opcoes.empresaId) : null,
      pedido_id: pedidoId,
      carregado_do_pedido: pedidoId != null,
      carregado_do_balcao: pedidoId == null,
      erro_carga: err && (err.code || err.codigo)
        ? (err.code || err.codigo)
        : (err && err.message ? String(err.message).slice(0, 120) : 'ERRO')
    });
  }
}

/**
 * Relaciona resultado da composição aos produtos/quantidades sem mutar a venda.
 * Itens compostos vêm de `comporItens` no motor — proposta diagnóstica apenas.
 */
function mapearComposicaoParaItensProposta(proposta) {
  const avaliacao = proposta
    && proposta.simulacao_integrada
    && proposta.simulacao_integrada.etapas
    && proposta.simulacao_integrada.etapas.motor_sprint_06
    && proposta.simulacao_integrada.etapas.motor_sprint_06.avaliacoes
    && proposta.simulacao_integrada.etapas.motor_sprint_06.avaliacoes[0]
    ? proposta.simulacao_integrada.etapas.motor_sprint_06.avaliacoes[0]
    : null;

  const itensCompostos = avaliacao && Array.isArray(avaliacao.itens_compostos)
    ? avaliacao.itens_compostos
    : [];

  return Object.freeze({
    itens_proposta: Object.freeze(itensCompostos.map((it) => Object.freeze({
      produto_id: it.produtoId != null ? it.produtoId : it.produto_id,
      quantidade: it.quantidade,
      subtotal_centavos: it.subtotalCentavos != null ? it.subtotalCentavos : null,
      preco_unitario: it.precoUnitario != null ? it.precoUnitario : null,
      subtotal: it.subtotalCentavos != null ? round2(Number(it.subtotalCentavos) / 100) : null,
      categoria_fiscal: it.categoriaFiscal || null,
      volume_total_ml: it.volumeTotalMl != null ? it.volumeTotalMl : null,
      nome: it.nome || null
    }))),
    quantidades_inteiras: avaliacao ? avaliacao.quantidades_inteiras === true : false,
    nao_reescreve_itens_da_venda: true,
    nao_autoriza_fiscal: true,
    diferenca_nao_e_desconto: true
  });
}

/**
 * Diagnóstico isolado para o hook em criarVenda.
 * Nunca lança para o chamador — erros retornam em `evento: 'erro_isolado'`.
 * Nunca muta os arrays/objetos recebidos.
 *
 * @param {object} contexto
 * @returns {Promise<object>}
 */
async function executarDiagnosticoRecomposicaoNoFechamento(contexto = {}) {
  const totalComercial = contexto.totalComercial != null
    ? contexto.totalComercial
    : contexto.total;
  const pagamentos = Array.isArray(contexto.pagamentos)
    ? contexto.pagamentos.map((p) => ({ ...p }))
    : [];
  const itens = Array.isArray(contexto.itens)
    ? contexto.itens.map((i) => ({ ...i }))
    : [];

  const candidato = resolverCandidatoDiagnosticoFechamento(contexto);
  if (candidato == null) {
    return Object.freeze({
      solicitado: false,
      evento: 'diagnostico_nao_solicitado',
      motivo: 'Candidato de simulação ausente; nenhum valor foi inventado a partir do total.',
      substitui_motor_fxnf: false,
      alterou_fechamento: false,
      resumoSeguro: Object.freeze({ status: 'nao_solicitado' })
    });
  }

  const internoBase = contexto.diagnosticoInterno && typeof contexto.diagnosticoInterno === 'object'
    ? contexto.diagnosticoInterno
    : {};

  let contextoComposicao;
  try {
    contextoComposicao = await resolverContextoComposicaoNoFechamento({
      diagnosticoInterno: internoBase,
      empresaId: contexto.empresaId != null ? contexto.empresaId : contexto.empresa_id,
      pedidoId: contexto.pedidoId != null ? contexto.pedidoId : contexto.pedido_id,
      residualCentavos: contexto.residualCentavos,
      totalComercial,
      db: contexto.db,
      agora: contexto.agora,
      carregarContextoComposicao: contexto.carregarContextoComposicao
    });
  } catch (ctxErr) {
    return Object.freeze({
      solicitado: true,
      evento: 'erro_isolado',
      codigo: 'ERRO_CONTEXTO_COMPOSICAO',
      motivo: ctxErr && ctxErr.message ? String(ctxErr.message).slice(0, 200) : 'Erro no contexto',
      substitui_motor_fxnf: false,
      alterou_fechamento: false,
      resumoSeguro: Object.freeze({ status: 'erro_isolado', codigo: 'ERRO_CONTEXTO_COMPOSICAO' })
    });
  }

  const modelos = Array.isArray(contextoComposicao.modelos) ? contextoComposicao.modelos : [];
  const capacidade = contextoComposicao.capacidade_por_categoria || {};
  // Sem modelos: não inventa — proposta/motor retornam SEM_COMPOSICAO.
  // Continua a preparar a proposta para preservar validação de contrato/pagamentos
  // e isolamento de erros (Sprint 11).

  try {
    // Nunca encaminha flags de ativação operacional vindas do body/cliente.
    const proposta = await prepararPropostaRecomposicaoDoFechamento({
      total: totalComercial,
      pagamentos,
      itens,
      valor_fiscal_candidato: candidato,
      modelos,
      capacidade_por_categoria: capacidade,
      percentual_tolerancia_dinheiro: internoBase.percentual_tolerancia_dinheiro
    });

    let evento = 'diagnostico_executado';
    const status = proposta.proposta && proposta.proposta.status_simulacao;
    const contextoInsuficiente = !modelos.length && contextoComposicao.suficiente !== true;

    if (contextoInsuficiente) {
      evento = 'contexto_composicao_insuficiente';
    } else if (status === 'EXATA' || status === 'COMPATIVEL_MARGEM') {
      evento = 'composicao_encontrada';
    } else if (
      status === 'INCOMPATIVEL'
      || status === 'SEM_COMPOSICAO'
    ) {
      evento = 'composicao_incompativel';
    }

    const mapeamento = mapearComposicaoParaItensProposta(proposta);

    return Object.freeze({
      solicitado: true,
      evento,
      status_simulacao: status || null,
      origem_modelos: contextoComposicao.origem || null,
      contexto_composicao: Object.freeze({
        suficiente: contextoComposicao.suficiente === true,
        modo: contextoComposicao.modo || null,
        empresa_id: contextoComposicao.empresa_id != null ? contextoComposicao.empresa_id : null,
        pedido_id: contextoComposicao.pedido_id != null ? contextoComposicao.pedido_id : null,
        carregado_do_pedido: contextoComposicao.carregado_do_pedido === true,
        carregado_do_balcao: contextoComposicao.carregado_do_balcao === true,
        origem: contextoComposicao.origem || null,
        motivo: contextoComposicao.motivo
          || (contextoInsuficiente ? 'modelos_cotacoes_ou_capacidades_ausentes' : null)
      }),
      mapeamento_composicao: mapeamento,
      substitui_motor_fxnf: false,
      alterou_fechamento: false,
      aplicou_desconto: false,
      persistencia_executada: false,
      emissao_fiscal_autorizada: false,
      chama_tef: false,
      movimentou_estoque: false,
      resumoSeguro: contextoInsuficiente
        ? Object.freeze({
          status: 'contexto_insuficiente',
          motivo: contextoComposicao.motivo || 'modelos_cotacoes_ou_capacidades_ausentes',
          status_simulacao: status || null
        })
        : montarResumoSeguroDiagnostico(proposta),
      proposta
    });
  } catch (err) {
    return Object.freeze({
      solicitado: true,
      evento: 'erro_isolado',
      codigo: err && (err.code || err.codigo) ? (err.code || err.codigo) : 'ERRO_DIAGNOSTICO',
      motivo: err && err.message ? String(err.message).slice(0, 200) : 'Erro no diagnóstico',
      substitui_motor_fxnf: false,
      alterou_fechamento: false,
      aplicou_desconto: false,
      chama_tef: false,
      movimentou_estoque: false,
      resumoSeguro: Object.freeze({
        status: 'erro_isolado',
        codigo: err && (err.code || err.codigo) ? (err.code || err.codigo) : null
      })
    });
  }
}

/**
 * Valida a proposta de recomposição contra o contrato do Motor F×NF.
 * NÃO altera resultadoMotor. NÃO autoriza emissão/redução fiscal.
 *
 * @param {object} params
 * @param {object} params.diagnostico — saída de executarDiagnosticoRecomposicaoNoFechamento
 * @param {object} [params.resultadoMotorOficial] — saída de distribuirItensVendaComValorFiscalEfetivo
 * @param {number} params.totalComercial
 * @param {Array} params.pagamentos
 * @param {Array} [params.itensVenda]
 */
function validarPropostaContraContratoMotorFxnf(params = {}) {
  const diagnostico = params.diagnostico || {};
  const motor = params.resultadoMotorOficial || null;
  const totalComercial = round2(Number(params.totalComercial));
  const pagamentos = Array.isArray(params.pagamentos) ? params.pagamentos : [];
  const somaPag = round2(pagamentos.reduce((s, p) => s + Number(p.valor || 0), 0));
  const proposta = diagnostico.proposta && diagnostico.proposta.proposta
    ? diagnostico.proposta.proposta
    : null;
  const mapeamento = diagnostico.mapeamento_composicao || null;
  const itensProposta = mapeamento && Array.isArray(mapeamento.itens_proposta)
    ? mapeamento.itens_proposta
    : [];

  const checks = [];
  const push = (codigo, ok, detalhe) => {
    checks.push(Object.freeze({ codigo, ok: ok === true, detalhe: detalhe || null }));
  };

  push(
    'TOTAL_COMERCIAL_PRESERVADO',
    proposta != null && round2(Number(proposta.total_comercial)) === totalComercial,
    { total_comercial: totalComercial, proposta: proposta && proposta.total_comercial }
  );
  push(
    'PAGAMENTOS_PRESERVADOS',
    Math.abs(somaPag - totalComercial) <= 0.009
      && (diagnostico.proposta
        ? diagnostico.proposta.preservacao
          && diagnostico.proposta.preservacao.nao_alterou_pagamentos === true
        : true),
    { soma_pagamentos: somaPag, total_comercial: totalComercial }
  );
  push(
    'SEM_DESCONTO_AUTOMATICO',
    diagnostico.aplicou_desconto !== true
      && (proposta == null || proposta.valor_fiscal_oficial_determinado_por_esta_proposta !== true),
    null
  );

  const statusOk = diagnostico.status_simulacao === 'EXATA'
    || diagnostico.status_simulacao === 'COMPATIVEL_MARGEM';
  push('COMPOSICAO_COMPATIVEL', statusOk, {
    status_simulacao: diagnostico.status_simulacao || null,
    evento: diagnostico.evento || null
  });

  const quantidadesValidas = itensProposta.length > 0
    && itensProposta.every((it) => (
      Number.isInteger(Number(it.produto_id))
      && Number(it.produto_id) > 0
      && Number.isSafeInteger(Number(it.quantidade))
      && Number(it.quantidade) > 0
    ));
  push('ITENS_PROPOSTA_QUANTIDADES_VALIDAS', quantidadesValidas, {
    itens: itensProposta
  });

  // Compatibilidade com venda: proposta NÃO reescreve linhas do carrinho.
  push(
    'NAO_REESCREVE_ITENS_VENDA',
    !mapeamento || mapeamento.nao_reescreve_itens_da_venda === true,
    null
  );

  let divergenciaFiscal = null;
  if (motor && motor.sucesso === true && proposta) {
    const oficial = round2(Number(motor.valorFiscalEfetivo != null
      ? motor.valorFiscalEfetivo
      : motor.valorFiscalLiquido));
    const candidato = round2(Number(proposta.valor_candidato_simulacao));
    const composicao = proposta.valor_composicao_simulada != null
      ? round2(Number(proposta.valor_composicao_simulada))
      : null;
    divergenciaFiscal = Object.freeze({
      valor_fiscal_oficial_motor: oficial,
      valor_candidato: candidato,
      valor_composicao: composicao,
      divergente: Math.abs(oficial - candidato) > 0.009,
      total_venda_motor: motor.totalVenda != null ? round2(Number(motor.totalVenda)) : null
    });
    push(
      'MOTOR_FXNF_EXECUTADO_SEM_SUBSTITUICAO',
      motor.sucesso === true,
      { valor_fiscal_oficial: oficial }
    );
  } else {
    push('MOTOR_FXNF_EXECUTADO_SEM_SUBSTITUICAO', motor == null, {
      motivo: motor == null ? 'motor_ainda_nao_informado' : 'motor_sem_sucesso'
    });
  }

  const integridadeOk = checks
    .filter((c) => [
      'TOTAL_COMERCIAL_PRESERVADO',
      'PAGAMENTOS_PRESERVADOS',
      'SEM_DESCONTO_AUTOMATICO',
      'NAO_REESCREVE_ITENS_VENDA'
    ].includes(c.codigo))
    .every((c) => c.ok === true);

  const composicaoValidada = statusOk && quantidadesValidas && integridadeOk;

  // HARD BLOCK: jamais aplicar redução fiscal nesta sprint.
  const aplicacaoBloqueada = true;
  const motivoBloqueioAplicacao = CONTRATO_MOTOR_FXNF.motivo_bloqueio_aplicacao;

  let estado = 'BLOQUEADO_POR_INCOMPATIBILIDADE';
  if (!diagnostico.solicitado) {
    estado = 'DESABILITADO';
  } else if (diagnostico.evento === 'erro_isolado') {
    estado = 'FALHA_NOS_TESTES';
  } else if (diagnostico.evento === 'contexto_composicao_insuficiente') {
    estado = 'BLOQUEADO_POR_INCOMPATIBILIDADE';
  } else if (composicaoValidada) {
    estado = 'VALIDADO_EM_HOMOLOGACAO';
  } else if (diagnostico.evento === 'composicao_incompativel') {
    estado = 'BLOQUEADO_POR_INCOMPATIBILIDADE';
  }

  return Object.freeze({
    sprint: 'CDS-PAGAMENTO-MISTO-RECOMPOSICAO-FISCAL-15',
    estado,
    composicao_validada_em_homologacao: composicaoValidada,
    aplicacao_distribuicao_oficial_permitida: false,
    aplicacao_distribuicao_oficial_bloqueada: aplicacaoBloqueada,
    motivo_bloqueio_aplicacao: motivoBloqueioAplicacao,
    substitui_motor_fxnf: false,
    alterou_fechamento: false,
    alterou_estoque: false,
    chama_tef: false,
    chama_sefaz: false,
    emissao_fiscal_autorizada: false,
    contrato_motor_fxnf: CONTRATO_MOTOR_FXNF,
    checks: Object.freeze(checks.slice()),
    divergencia_fiscal: divergenciaFiscal,
    itens_composicao: Object.freeze(itensProposta.map((i) => Object.freeze({ ...i }))),
    valor_candidato: proposta ? proposta.valor_candidato_simulacao : null,
    valor_composicao: proposta ? proposta.valor_composicao_simulada : null,
    margem_matematica: proposta ? proposta.margem_matematica : null,
    diferenca_composicao: proposta ? proposta.diferenca_composicao : null,
    diferenca_nao_e_desconto: true
  });
}

/**
 * Orquestra ativação controlada (homologação): diagnóstico + validação pós-Motor.
 * Nunca muta resultadoMotor / itens / pagamentos. Falhas isoladas.
 *
 * @param {object} contexto
 */
async function executarAtivacaoControladaRecomposicaoNoFechamento(contexto = {}) {
  const env = contexto.env || process.env;
  const ativacao = obterAtivacaoHomologacaoInterna(
    env,
    contexto.harnessHomologacao || null
  );
  const authDist = obterAutorizacaoDistribuicaoOficialInterna(
    env,
    contexto.harnessDistribuicaoOficial || null
  );
  const bloqueioLegado = String(env[ENV_APLICAR_DISTRIBUICAO] || '') === '1'
    || (contexto.harnessAplicar && contexto.harnessAplicar.tentar === true);
  const modoInfo = resolverModoOperacionalRecomposicao({
    env,
    diagnosticoInterno: contexto.diagnosticoInterno,
    harnessDiagnostico: contexto.harnessDiagnostico || null,
    harnessHomologacao: contexto.harnessHomologacao || null,
    harnessAplicar: contexto.harnessAplicar || null,
    candidatoInterno: contexto.candidatoInterno
  });

  const fecharCom = (diagnostico, validacao, aplicacao = null) => {
    const aplicada = aplicacao != null && aplicacao.distribuicao_aplicada === true;
    const relatorio = montarRelatorioOperacionalRecomposicao({
      modoInfo,
      diagnostico,
      validacao,
      totalComercial: contexto.totalComercial != null
        ? contexto.totalComercial
        : contexto.total,
      itensVenda: contexto.itens,
      resultado_motor_inalterado: true,
      distribuicaoAplicada: aplicada,
      resultadoOficial: aplicacao && aplicacao.resultado_oficial
    });
    return Object.freeze({
      ativacao,
      autorizacao_distribuicao_oficial: authDist,
      modo: modoInfo,
      diagnostico,
      validacao,
      aplicacao_oficial: aplicacao,
      relatorio_operacional: relatorio,
      resultado_motor_inalterado: true,
      resultado_motor_substituido: aplicada ? aplicacao.resultado_oficial : null,
      distribuicao_aplicada: aplicada
    });
  };

  if (!ativacao.ativa && !authDist.ativa && !contexto.forcarDiagnostico
    && modoInfo.modo_efetivo === MODOS_OPERACIONAIS.DESLIGADO) {
    const diagnostico = await executarDiagnosticoRecomposicaoNoFechamento(contexto);
    return fecharCom(
      diagnostico,
      Object.freeze({
        estado: 'DESABILITADO',
        aplicacao_distribuicao_oficial_permitida: false,
        substitui_motor_fxnf: false,
        alterou_fechamento: false
      })
    );
  }

  let diagnostico;
  try {
    diagnostico = await executarDiagnosticoRecomposicaoNoFechamento(contexto);
  } catch (err) {
    return fecharCom(
      Object.freeze({
        solicitado: true,
        evento: 'erro_isolado',
        codigo: 'ERRO_DIAGNOSTICO_HOMOLOGACAO',
        motivo: err && err.message ? String(err.message).slice(0, 200) : 'erro',
        substitui_motor_fxnf: false,
        alterou_fechamento: false
      }),
      Object.freeze({
        estado: 'FALHA_NOS_TESTES',
        aplicacao_distribuicao_oficial_permitida: false,
        substitui_motor_fxnf: false,
        alterou_fechamento: false,
        motivo: 'Falha isolada no diagnóstico; fechamento legado preservado.'
      })
    );
  }

  let validacao;
  try {
    validacao = validarPropostaContraContratoMotorFxnf({
      diagnostico,
      resultadoMotorOficial: contexto.resultadoMotorOficial || null,
      totalComercial: contexto.totalComercial != null
        ? contexto.totalComercial
        : contexto.total,
      pagamentos: contexto.pagamentos,
      itensVenda: contexto.itens
    });
  } catch (err) {
    validacao = Object.freeze({
      estado: 'FALHA_NOS_TESTES',
      aplicacao_distribuicao_oficial_permitida: false,
      substitui_motor_fxnf: false,
      alterou_fechamento: false,
      motivo: err && err.message ? String(err.message).slice(0, 200) : 'erro_validacao'
    });
  }

  let aplicacao = null;
  if (
    authDist.ativa
    && !bloqueioLegado
    && validacao
    && validacao.composicao_validada_em_homologacao === true
  ) {
    try {
      aplicacao = await encaminharPropostaValidadaAoDistribuidorOficial({
        env,
        autorizacao: authDist,
        diagnostico,
        validacao,
        itensVendidos: contexto.itens,
        pagamentos: contexto.pagamentos,
        totalComercial: contexto.totalComercial != null
          ? contexto.totalComercial
          : contexto.total,
        desconto: Number(contexto.desconto || 0),
        acrescimo: Number(contexto.acrescimo || 0),
        empresaId: contexto.empresaId != null ? contexto.empresaId : contexto.empresa_id,
        db: contexto.db,
        saldosPorProduto: contexto.saldosPorProduto,
        aplicarSaldo: contexto.aplicarSaldo === true,
        jaEmTransacao: contexto.jaEmTransacao === true,
        modelos: contexto.modelos
          || (contexto.diagnosticoInterno && contexto.diagnosticoInterno.modelos),
        capacidade_por_categoria: contexto.capacidade_por_categoria
          || (contexto.diagnosticoInterno && contexto.diagnosticoInterno.capacidade_por_categoria),
        deps: contexto.deps,
        harnessAplicar: contexto.harnessAplicar
      });
    } catch (err) {
      aplicacao = Object.freeze({
        distribuicao_aplicada: false,
        saldo_aplicado: false,
        codigo: 'ERRO_INTEGRACAO_DISTRIBUIDOR',
        motivo: err && err.message ? String(err.message).slice(0, 200) : 'erro',
        rollback: true,
        resultado_oficial: null,
        resultado_motor_legado_inalterado: true
      });
    }
  }

  return fecharCom(diagnostico, validacao, aplicacao);
}

function clonarPagamentosOriginais(pagamentos) {
  return (Array.isArray(pagamentos) ? pagamentos : []).map((p) => ({
    forma_pagamento: p && p.forma_pagamento != null ? p.forma_pagamento : (p && p.forma),
    valor: p && p.valor != null ? p.valor : 0,
    tipo_recebimento: p && p.tipo_recebimento != null ? p.tipo_recebimento : undefined
  }));
}

function quantidadeInteiraPositiva(valor) {
  const n = Number(valor);
  return Number.isSafeInteger(n) && n > 0;
}

function empresaIdOperacional(valor) {
  if (valor == null || valor === '') return null;
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function dbRunLocal(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

function resultadoBloqueado(codigo, motivo, extra = {}) {
  const antes = extra.saldos_antes || null;
  return Object.freeze({
    sprint: 'CDS-PAGAMENTO-MISTO-RECOMPOSICAO-FISCAL-17',
    distribuicao_aplicada: false,
    saldo_aplicado: false,
    codigo,
    motivo,
    resultado_oficial: null,
    chamadas_distribuidor: Object.freeze(extra.chamadas || []),
    saldos_antes: antes,
    saldos_depois: extra.saldos_depois != null ? extra.saldos_depois : antes,
    rollback: extra.rollback === true,
    total_comercial: extra.total_comercial != null ? extra.total_comercial : null,
    total_comercial_preservado: true,
    pagamentos_preservados: true,
    margem_nao_convertida_em_desconto: true,
    desconto_enviado_ao_distribuidor: 0,
    resultado_motor_legado_inalterado: true,
    substitui_motor_fxnf_diretamente: false,
    producao_habilitada: RECOMPOSICAO_HABILITADA_EM_PRODUCAO === true,
    contrato: CONTRATO_DISTRIBUICAO_OFICIAL
  });
}

/**
 * Autorização exclusiva do backend para encaminhar a proposta ao distribuidor.
 * Harness `__cdsRecomposicaoDistribuicaoOficial` existe só para teste interno.
 * Body, payload da venda e CDS_RECOMPOSICAO_APLICAR_DISTRIBUICAO não ativam.
 */
function obterAutorizacaoDistribuicaoOficialInterna(env = process.env, harness = null) {
  const flagLegada = String(env[ENV_APLICAR_DISTRIBUICAO] || '') === '1';
  if (harness && typeof harness === 'object' && harness.ativa === true) {
    return Object.freeze({
      ativa: true,
      fonte: 'harness_teste',
      permite_aplicar_distribuicao_oficial: true,
      producao: false,
      env_flag: ENV_DISTRIBUICAO_OFICIAL,
      flag_legada_nao_considerada: true,
      flag_legada_detectada: flagLegada
    });
  }
  if (String(env[ENV_DISTRIBUICAO_OFICIAL] || '') !== '1') {
    return Object.freeze({
      ativa: false,
      fonte: null,
      permite_aplicar_distribuicao_oficial: false,
      producao: false,
      env_flag: ENV_DISTRIBUICAO_OFICIAL,
      flag_legada_detectada: flagLegada,
      motivo: flagLegada
        ? 'CDS_RECOMPOSICAO_APLICAR_DISTRIBUICAO não habilita a distribuição oficial.'
        : null
    });
  }
  return Object.freeze({
    ativa: true,
    fonte: 'backend_env',
    permite_aplicar_distribuicao_oficial: true,
    producao: RECOMPOSICAO_HABILITADA_EM_PRODUCAO === true,
    env_flag: ENV_DISTRIBUICAO_OFICIAL,
    flag_legada_nao_considerada: true,
    flag_legada_detectada: flagLegada
  });
}

function agregarItensVendidos(itens) {
  const mapa = new Map();
  const ordem = [];
  for (const item of Array.isArray(itens) ? itens : []) {
    const id = Number(item && (item.produto_id != null ? item.produto_id : item.id));
    if (!Number.isInteger(id) || id <= 0) {
      return {
        ok: false,
        codigo: 'PRODUTO_INEXISTENTE',
        motivo: 'Item vendido sem identificação de produto.'
      };
    }
    const qtd = Number(item.quantidade);
    if (!quantidadeInteiraPositiva(qtd)) {
      return {
        ok: false,
        codigo: 'QUANTIDADE_INCOMPATIVEL',
        motivo: 'Quantidade vendida precisa ser inteira e positiva.'
      };
    }
    const subtotal = item.subtotal != null && item.subtotal !== ''
      ? round2(Number(item.subtotal))
      : null;
    const preco = item.preco_unitario != null && item.preco_unitario !== ''
      ? round2(Number(item.preco_unitario))
      : null;
    if (!mapa.has(id)) {
      ordem.push(id);
      mapa.set(id, {
        produto_id: id,
        quantidade: 0,
        subtotal: 0,
        preco_unitario: preco,
        unidade: item.unidade || 'UN',
        base: { ...item, produto_id: id }
      });
    }
    const acc = mapa.get(id);
    if (
      preco != null
      && acc.preco_unitario != null
      && Math.abs(preco - acc.preco_unitario) > 0.02
    ) {
      return {
        ok: false,
        codigo: 'VALOR_INCOMPATIVEL',
        motivo: 'Preço unitário divergente para o mesmo produto vendido.'
      };
    }
    acc.quantidade += qtd;
    acc.subtotal = round2(acc.subtotal + (subtotal != null ? subtotal : 0));
    if (!(acc.preco_unitario > 0) && preco != null) acc.preco_unitario = preco;
  }
  for (const acc of mapa.values()) {
    if (!(acc.preco_unitario > 0) && acc.quantidade > 0 && acc.subtotal > 0) {
      acc.preco_unitario = round2(acc.subtotal / acc.quantidade);
    }
  }
  return { ok: true, mapa, ordem };
}

function validarCapacidadeProposta(itens, capacidade, modelos) {
  const caps = capacidade && typeof capacidade === 'object' ? capacidade : {};
  const usados = {};
  for (const it of itens) {
    const qtd = Number(it.quantidade);
    if (Array.isArray(modelos)) {
      const modelo = modelos.find((m) => Number(
        m && (m.produtoId != null ? m.produtoId : m.produto_id)
      ) === Number(it.produto_id));
      if (
        modelo
        && modelo.quantidadeMaxima != null
        && qtd > Number(modelo.quantidadeMaxima)
      ) {
        return {
          ok: false,
          codigo: 'CAPACIDADE_EXCEDIDA',
          motivo: 'Quantidade proposta acima da capacidade do modelo existente.'
        };
      }
    }
    if (it.volume_total_ml != null && it.categoria_fiscal && caps[it.categoria_fiscal] != null) {
      usados[it.categoria_fiscal] = (usados[it.categoria_fiscal] || 0) + Number(it.volume_total_ml);
    }
  }
  for (const cat of Object.keys(usados)) {
    if (usados[cat] > Number(caps[cat]) + 1e-9) {
      return {
        ok: false,
        codigo: 'CAPACIDADE_EXCEDIDA',
        motivo: `Volume da categoria ${cat} excede a capacidade informada pelo contexto.`
      };
    }
  }
  return { ok: true };
}

function saldoDoMapa(mapa, produtoId) {
  if (!mapa || typeof mapa !== 'object') return null;
  if (mapa[produtoId] != null) return mapa[produtoId];
  if (mapa[String(produtoId)] != null) return mapa[String(produtoId)];
  return null;
}

async function lerSaldoEmpresaProduto(db, empresaId, produtoId) {
  const EstoqueEmpresaService = require('../estoque/EstoqueEmpresaService');
  try {
    const saldo = await EstoqueEmpresaService.consultarSaldoParaEmpresa({
      produtoId,
      empresaId,
      db
    });
    if (!saldo) {
      return {
        ok: true,
        saldoFiscal: 0,
        saldoNaoFiscal: 0,
        origem: 'estoque_empresa'
      };
    }
    return {
      ok: true,
      saldoFiscal: Number(saldo.saldoFiscal || 0),
      saldoNaoFiscal: Number(saldo.saldoNaoFiscal || 0),
      origem: 'estoque_empresa'
    };
  } catch (err) {
    const code = err && (err.code || err.codigo);
    if (code === 'PRODUTO_NAO_ENCONTRADO') {
      return {
        ok: false,
        codigo: 'PRODUTO_INEXISTENTE',
        motivo: 'Produto da proposta não existe.'
      };
    }
    if (code === 'EMPRESA_NAO_ENCONTRADA' || code === 'EMPRESA_OBRIGATORIA') {
      return {
        ok: false,
        codigo: 'EMPRESA_AUSENTE',
        motivo: err.message || 'Empresa ausente para a distribuição.'
      };
    }
    return {
      ok: false,
      codigo: code || 'ERRO_SALDO',
      motivo: err && err.message ? String(err.message).slice(0, 200) : 'Falha ao ler saldo.'
    };
  }
}

function mensagemErroDistribuidor(resultado) {
  if (!resultado) return 'Distribuidor oficial sem retorno.';
  const erro = resultado.erro;
  if (erro && typeof erro === 'object') {
    return erro.mensagem || erro.message || 'Distribuição recusada pelo distribuidor oficial.';
  }
  if (typeof erro === 'string' && erro) return erro;
  return 'Distribuição recusada pelo distribuidor oficial.';
}

function registrarChamada(lista, vendaFiscal, produtoId, quantidade, resultado, parcela) {
  const row = resultado && Array.isArray(resultado.itens) ? resultado.itens[0] : null;
  lista.push(Object.freeze({
    funcao: 'distribuirItensVendaComValorFiscalEfetivo',
    vendaFiscal: vendaFiscal === true,
    produto_id: produtoId,
    quantidade_enviada: quantidade,
    sucesso: !!(resultado && resultado.sucesso === true),
    quantidade_fiscal: row ? Number(row.quantidade_fiscal || 0) : null,
    quantidade_nao_fiscal: row ? Number(row.quantidade_nao_fiscal || 0) : null,
    valor_fiscal: row ? Number(row.valor_fiscal || 0) : null,
    valor_nao_fiscal: row ? Number(row.valor_nao_fiscal || 0) : null,
    desconto_da_chamada: parcela ? round2(Number(parcela.desconto || 0)) : 0,
    acrescimo_da_chamada: parcela ? round2(Number(parcela.acrescimo || 0)) : 0,
    erro: resultado && resultado.sucesso === true ? null : mensagemErroDistribuidor(resultado)
  }));
}

/**
 * Converte o líquido oficial de um bucket nos parâmetros desconto/acréscimo
 * da chamada exclusiva. Não rateia de novo: só devolve o delta já calculado.
 */
function parcelaOficialDoBucket(bruto, liquido) {
  const delta = round2(Number(liquido || 0) - Number(bruto || 0));
  if (delta < 0) return { desconto: round2(-delta), acrescimo: 0 };
  if (delta > 0) return { desconto: 0, acrescimo: delta };
  return { desconto: 0, acrescimo: 0 };
}

/**
 * Mesma regra do Motor legado: calcularValorFiscalLiquido uma vez sobre o
 * bruto fiscal e o não fiscal da composição, depois aplicarValorFiscalLiquidoNosItens.
 * Cada bucket recebe só a própria parcela.
 */
function rateioOficialDaComposicao(planos, desconto, acrescimo) {
  const brutos = planos.map((plano) => ({
    produto_id: plano.produto_id,
    valor_fiscal: round2(plano.quantidade_fiscal * plano.preco_unitario),
    valor_nao_fiscal: round2(plano.quantidade_nao_fiscal * plano.preco_unitario)
  }));
  const valorFiscalBruto = round2(brutos.reduce((s, linha) => s + linha.valor_fiscal, 0));
  const valorNaoFiscalBruto = round2(brutos.reduce((s, linha) => s + linha.valor_nao_fiscal, 0));
  const rateio = calcularValorFiscalLiquido({
    valorFiscalBruto,
    valorNaoFiscalBruto,
    desconto,
    acrescimo
  });
  const liquidos = aplicarValorFiscalLiquidoNosItens(brutos, rateio);
  const porProduto = new Map();
  liquidos.forEach((linha, idx) => {
    const bruto = brutos[idx];
    porProduto.set(bruto.produto_id, {
      valor_fiscal: round2(linha.valor_fiscal),
      valor_nao_fiscal: round2(linha.valor_nao_fiscal),
      bruto_fiscal: bruto.valor_fiscal,
      bruto_nao_fiscal: bruto.valor_nao_fiscal,
      parcela_fiscal: parcelaOficialDoBucket(bruto.valor_fiscal, linha.valor_fiscal),
      parcela_nao_fiscal: parcelaOficialDoBucket(bruto.valor_nao_fiscal, linha.valor_nao_fiscal)
    });
  });
  return { rateio, porProduto, valorFiscalBruto, valorNaoFiscalBruto };
}

function debitarOficialAsync(debitar, db, dados) {
  return new Promise((resolve, reject) => {
    debitar(db, dados, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

/**
 * Encaminha a proposta já validada ao distribuidor oficial F×NF.
 * Não muta o resultado legado do Motor. Não grava saldo quando aplicarSaldo é false
 * (o criarVenda debita depois por reduzirEstoqueDistribuido).
 * Com aplicarSaldo, o débito usa a porta oficial debitarEstoqueItemVenda numa transação.
 * Sprint 19: desconto e acréscimo do criarVenda entram uma vez, pela regra oficial
 * calcularValorFiscalLiquido. A chamada de cada bucket recebe só a parcela dele.
 */
async function encaminharPropostaValidadaAoDistribuidorOficial(params = {}) {
  const env = params.env || process.env;
  const pagamentosOriginais = clonarPagamentosOriginais(params.pagamentos);
  const pagamentosSnapshot = JSON.stringify(pagamentosOriginais);
  const totalComercial = round2(Number(params.totalComercial));

  const legado = String(env[ENV_APLICAR_DISTRIBUICAO] || '') === '1'
    || (params.harnessAplicar && params.harnessAplicar.tentar === true);
  if (legado) {
    return resultadoBloqueado(
      'APLICACAO_BLOQUEADA_FLAG_LEGADA',
      'CDS_RECOMPOSICAO_APLICAR_DISTRIBUICAO não habilita a distribuição oficial.',
      { total_comercial: totalComercial }
    );
  }

  const auth = params.autorizacao
    || obterAutorizacaoDistribuicaoOficialInterna(env, params.harnessDistribuicaoOficial || null);
  if (!auth || auth.ativa !== true) {
    return resultadoBloqueado(
      'AUTORIZACAO_AUSENTE',
      'Distribuição oficial desativada. Autorização interna ausente.',
      { total_comercial: totalComercial }
    );
  }

  const validacao = params.validacao || null;
  if (!validacao || validacao.composicao_validada_em_homologacao !== true) {
    return resultadoBloqueado(
      'PROPOSTA_NAO_VALIDADA',
      'Proposta não validada. Fluxo oficial anterior preservado.',
      { total_comercial: totalComercial }
    );
  }

  const empresaId = empresaIdOperacional(
    params.empresaId != null ? params.empresaId : params.empresa_id
  );
  if (empresaId == null) {
    return resultadoBloqueado(
      'EMPRESA_AUSENTE',
      'Contexto de empresa ausente impede a aplicação.',
      { total_comercial: totalComercial }
    );
  }

  const itensProposta = validacao.itens_composicao
    && Array.isArray(validacao.itens_composicao)
    ? validacao.itens_composicao
    : (
      params.diagnostico
      && params.diagnostico.mapeamento_composicao
      && Array.isArray(params.diagnostico.mapeamento_composicao.itens_proposta)
        ? params.diagnostico.mapeamento_composicao.itens_proposta
        : []
    );

  const idsProposta = [];
  for (const it of itensProposta) {
    const id = Number(it && it.produto_id);
    if (!Number.isInteger(id) || id <= 0 || !quantidadeInteiraPositiva(it.quantidade)) {
      return resultadoBloqueado(
        'QUANTIDADE_INCOMPATIVEL',
        'Produto ou quantidade da proposta não é inteiro e positivo.',
        { total_comercial: totalComercial }
      );
    }
    if (idsProposta.includes(id)) {
      return resultadoBloqueado(
        'QUANTIDADE_DUPLICADA',
        'A proposta repete o mesmo produto. Aplicação bloqueada.',
        { total_comercial: totalComercial }
      );
    }
    idsProposta.push(id);
  }

  const vendidos = agregarItensVendidos(params.itensVendidos || params.itens);
  if (!vendidos.ok) {
    return resultadoBloqueado(vendidos.codigo, vendidos.motivo, { total_comercial: totalComercial });
  }

  const somaSubtotais = round2(
    [...vendidos.mapa.values()].reduce((s, acc) => s + Number(acc.subtotal || 0), 0)
  );
  if (!Number.isFinite(totalComercial) || Math.abs(somaSubtotais - totalComercial) > 0.02) {
    return resultadoBloqueado(
      'TOTAL_COMERCIAL_DIVERGENTE',
      'Subtotais vendidos divergem do total comercial. Nada foi aplicado.',
      { total_comercial: totalComercial }
    );
  }

  const somaPag = round2(pagamentosOriginais.reduce((s, p) => s + Number(p.valor || 0), 0));
  if (Math.abs(somaPag - totalComercial) > 0.02) {
    return resultadoBloqueado(
      'PAGAMENTOS_DIVERGENTES',
      'Pagamentos divergem do total comercial. Nada foi aplicado.',
      { total_comercial: totalComercial }
    );
  }

  const planos = [];
  for (const it of itensProposta) {
    const id = Number(it.produto_id);
    const vendido = vendidos.mapa.get(id);
    if (!vendido) {
      return resultadoBloqueado(
        'PRODUTO_INCOMPATIVEL',
        'Produto da proposta não corresponde a um item vendido.',
        { total_comercial: totalComercial }
      );
    }
    const qtdProposta = Number(it.quantidade);
    if (qtdProposta > vendido.quantidade) {
      return resultadoBloqueado(
        'QUANTIDADE_ACIMA_DA_VENDIDA',
        'Quantidade proposta excede a quantidade vendida do produto.',
        { total_comercial: totalComercial }
      );
    }
    const preco = vendido.preco_unitario;
    if (!(preco > 0)) {
      return resultadoBloqueado(
        'VALOR_INCOMPATIVEL',
        'Preço do item vendido ausente. Nada foi aplicado.',
        { total_comercial: totalComercial }
      );
    }
    if (it.subtotal != null && Math.abs(round2(qtdProposta * preco) - round2(Number(it.subtotal))) > 0.02) {
      return resultadoBloqueado(
        'VALOR_INCOMPATIVEL',
        'Valor da composição não corresponde ao preço do item vendido.',
        { total_comercial: totalComercial }
      );
    }
    planos.push({
      produto_id: id,
      quantidade_vendida: vendido.quantidade,
      quantidade_fiscal: qtdProposta,
      quantidade_nao_fiscal: vendido.quantidade - qtdProposta,
      preco_unitario: preco,
      subtotal: vendido.subtotal,
      unidade: vendido.unidade || 'UN',
      base: vendido.base
    });
  }

  for (const id of vendidos.ordem) {
    if (idsProposta.includes(id)) continue;
    const vendido = vendidos.mapa.get(id);
    if (!(vendido.preco_unitario > 0)) {
      return resultadoBloqueado(
        'VALOR_INCOMPATIVEL',
        'Preço do residual vendido ausente. Nada foi aplicado.',
        { total_comercial: totalComercial }
      );
    }
    planos.push({
      produto_id: id,
      quantidade_vendida: vendido.quantidade,
      quantidade_fiscal: 0,
      quantidade_nao_fiscal: vendido.quantidade,
      preco_unitario: vendido.preco_unitario,
      subtotal: vendido.subtotal,
      unidade: vendido.unidade || 'UN',
      base: vendido.base
    });
  }

  const capacidade = validarCapacidadeProposta(
    itensProposta,
    params.capacidade_por_categoria,
    params.modelos
  );
  if (!capacidade.ok) {
    return resultadoBloqueado(capacidade.codigo, capacidade.motivo, { total_comercial: totalComercial });
  }

  const saldos = new Map();
  for (const plano of planos) {
    const informado = saldoDoMapa(params.saldosPorProduto, plano.produto_id);
    let saldo;
    if (informado) {
      saldo = {
        ok: true,
        saldoFiscal: Number(informado.saldoFiscal != null ? informado.saldoFiscal : informado.saldo_fiscal || 0),
        saldoNaoFiscal: Number(
          informado.saldoNaoFiscal != null ? informado.saldoNaoFiscal : informado.saldo_nao_fiscal || 0
        ),
        origem: 'saldos_do_fechamento'
      };
    } else if (params.db) {
      saldo = await lerSaldoEmpresaProduto(params.db, empresaId, plano.produto_id);
    } else {
      saldo = {
        ok: false,
        codigo: 'SALDO_INDISPONIVEL',
        motivo: 'Saldo fiscal/não fiscal da empresa não está disponível.'
      };
    }
    if (!saldo.ok) {
      return resultadoBloqueado(saldo.codigo, saldo.motivo, { total_comercial: totalComercial });
    }
    saldos.set(plano.produto_id, saldo);
  }

  const saldosAntes = Object.freeze(planos.map((plano) => {
    const saldo = saldos.get(plano.produto_id);
    return Object.freeze({
      produto_id: plano.produto_id,
      empresa_id: empresaId,
      saldo_fiscal: saldo.saldoFiscal,
      saldo_nao_fiscal: saldo.saldoNaoFiscal
    });
  }));

  const distribuir = params.deps && typeof params.deps.distribuir === 'function'
    ? params.deps.distribuir
    : require('../distribuidorEstoqueVenda').distribuirItensVendaComValorFiscalEfetivo;

  const descontoComercial = Math.max(0, round2(Number(params.desconto || 0)));
  const acrescimoComercial = Math.max(0, round2(Number(params.acrescimo || 0)));
  const rateioComposicao = rateioOficialDaComposicao(planos, descontoComercial, acrescimoComercial);

  const chamadas = [];
  const linhas = [];
  for (const plano of planos) {
    const saldo = saldos.get(plano.produto_id);
    const oficial = rateioComposicao.porProduto.get(plano.produto_id);
    let qF = 0;
    let qNF = 0;
    let vF = 0;
    let vNF = 0;

    if (plano.quantidade_fiscal > 0) {
      const item = {
        produto_id: plano.produto_id,
        quantidade: plano.quantidade_fiscal,
        preco_unitario: plano.preco_unitario,
        subtotal: round2(plano.quantidade_fiscal * plano.preco_unitario),
        unidade: plano.unidade || 'UN'
      };
      const parcelaFiscal = oficial.parcela_fiscal;
      const resultado = await distribuir(
        [{ item, saldoFiscal: saldo.saldoFiscal, saldoNaoFiscal: saldo.saldoNaoFiscal }],
        true,
        {
          pagamentos: clonarPagamentosOriginais(pagamentosOriginais),
          desconto: parcelaFiscal.desconto,
          acrescimo: parcelaFiscal.acrescimo,
          midpAtivo: false,
          politicaFiscalComercial: null
        }
      );
      registrarChamada(chamadas, true, plano.produto_id, plano.quantidade_fiscal, resultado, parcelaFiscal);
      const row = resultado && resultado.sucesso === true && Array.isArray(resultado.itens)
        ? resultado.itens[0]
        : null;
      if (
        !row
        || Math.abs(Number(row.quantidade_fiscal || 0) - plano.quantidade_fiscal) > 1e-6
        || Math.abs(Number(row.quantidade_nao_fiscal || 0)) > 1e-6
      ) {
        return resultadoBloqueado(
          resultado && resultado.sucesso === true
            ? 'RESULTADO_DISTRIBUIDOR_INCOMPATIVEL'
            : 'SALDO_INSUFICIENTE',
          resultado && resultado.sucesso === true
            ? 'O distribuidor oficial não devolveu a quantidade fiscal proposta.'
            : mensagemErroDistribuidor(resultado),
          { chamadas, saldos_antes: saldosAntes, total_comercial: totalComercial }
        );
      }
      qF = Number(row.quantidade_fiscal || 0);
      vF = round2(Number(row.valor_fiscal || 0));
    }

    if (plano.quantidade_nao_fiscal > 0) {
      const item = {
        produto_id: plano.produto_id,
        quantidade: plano.quantidade_nao_fiscal,
        preco_unitario: plano.preco_unitario,
        subtotal: round2(plano.quantidade_nao_fiscal * plano.preco_unitario),
        unidade: plano.unidade || 'UN'
      };
      const parcelaNaoFiscal = oficial.parcela_nao_fiscal;
      const resultado = await distribuir(
        [{ item, saldoFiscal: saldo.saldoFiscal, saldoNaoFiscal: saldo.saldoNaoFiscal }],
        false,
        {
          pagamentos: clonarPagamentosOriginais(pagamentosOriginais),
          desconto: parcelaNaoFiscal.desconto,
          acrescimo: parcelaNaoFiscal.acrescimo,
          midpAtivo: false,
          politicaFiscalComercial: null
        }
      );
      registrarChamada(chamadas, false, plano.produto_id, plano.quantidade_nao_fiscal, resultado, parcelaNaoFiscal);
      const row = resultado && resultado.sucesso === true && Array.isArray(resultado.itens)
        ? resultado.itens[0]
        : null;
      if (
        !row
        || Math.abs(Number(row.quantidade_nao_fiscal || 0) - plano.quantidade_nao_fiscal) > 1e-6
        || Math.abs(Number(row.quantidade_fiscal || 0)) > 1e-6
      ) {
        return resultadoBloqueado(
          resultado && resultado.sucesso === true
            ? 'RESULTADO_DISTRIBUIDOR_INCOMPATIVEL'
            : 'SALDO_INSUFICIENTE',
          resultado && resultado.sucesso === true
            ? 'O distribuidor oficial não devolveu a quantidade não fiscal residual.'
            : mensagemErroDistribuidor(resultado),
          { chamadas, saldos_antes: saldosAntes, total_comercial: totalComercial }
        );
      }
      qNF = Number(row.quantidade_nao_fiscal || 0);
      vNF = round2(Number(row.valor_nao_fiscal || 0));
    }

    if (Math.abs((qF + qNF) - plano.quantidade_vendida) > 1e-6) {
      return resultadoBloqueado(
        'QUANTIDADE_INCOMPATIVEL',
        'A soma fiscal e não fiscal diverge da quantidade vendida.',
        { chamadas, saldos_antes: saldosAntes, total_comercial: totalComercial }
      );
    }
    if (Math.abs(round2(oficial.bruto_fiscal + oficial.bruto_nao_fiscal) - round2(Number(plano.subtotal))) > 0.02) {
      return resultadoBloqueado(
        'VALOR_INCOMPATIVEL',
        'Valores fiscais e não fiscais divergem do subtotal vendido.',
        { chamadas, saldos_antes: saldosAntes, total_comercial: totalComercial }
      );
    }
    if (
      Math.abs(vF - oficial.valor_fiscal) > 0.02
      || Math.abs(vNF - oficial.valor_nao_fiscal) > 0.02
    ) {
      return resultadoBloqueado(
        'VALOR_INCOMPATIVEL',
        'O distribuidor oficial não reproduziu o rateio comercial da composição.',
        { chamadas, saldos_antes: saldosAntes, total_comercial: totalComercial }
      );
    }

    linhas.push({
      ...plano.base,
      produto_id: plano.produto_id,
      quantidade: plano.quantidade_vendida,
      preco_unitario: plano.preco_unitario,
      subtotal: plano.subtotal,
      unidade: plano.unidade || 'UN',
      quantidade_fiscal: qF,
      quantidade_nao_fiscal: qNF,
      valor_fiscal: vF,
      valor_nao_fiscal: vNF
    });
  }

  const totalFiscal = round2(linhas.reduce((s, linha) => s + Number(linha.valor_fiscal || 0), 0));
  const totalNaoFiscal = round2(linhas.reduce((s, linha) => s + Number(linha.valor_nao_fiscal || 0), 0));
  const totalDistribuido = round2(totalFiscal + totalNaoFiscal);
  const liquidoOficial = round2(rateioComposicao.rateio.totalLiquido);
  const brutoComposicao = round2(
    rateioComposicao.valorFiscalBruto + rateioComposicao.valorNaoFiscalBruto
  );
  const somaDescontoChamadas = round2(
    chamadas.reduce((s, chamada) => s + Number(chamada.desconto_da_chamada || 0), 0)
  );
  const somaAcrescimoChamadas = round2(
    chamadas.reduce((s, chamada) => s + Number(chamada.acrescimo_da_chamada || 0), 0)
  );
  const liquidoPelasChamadas = round2(brutoComposicao - somaDescontoChamadas + somaAcrescimoChamadas);
  if (Math.abs(liquidoPelasChamadas - liquidoOficial) > 0.02) {
    return resultadoBloqueado(
      'DESCONTO_DUPLICADO',
      'Desconto ou acréscimo foi aplicado mais de uma vez entre os buckets.',
      { chamadas, saldos_antes: saldosAntes, total_comercial: totalComercial }
    );
  }
  if (Math.abs(totalDistribuido - liquidoOficial) > 0.02) {
    return resultadoBloqueado(
      'VALOR_INCOMPATIVEL',
      'O líquido F×NF diverge do rateio oficial do desconto e do acréscimo.',
      { chamadas, saldos_antes: saldosAntes, total_comercial: totalComercial }
    );
  }
  if (
    descontoComercial === 0
    && acrescimoComercial === 0
    && Math.abs(totalDistribuido - totalComercial) > 0.02
  ) {
    return resultadoBloqueado(
      'TOTAL_COMERCIAL_DIVERGENTE',
      'A distribuição oficial não preservou o total comercial.',
      { chamadas, saldos_antes: saldosAntes, total_comercial: totalComercial }
    );
  }
  if (JSON.stringify(clonarPagamentosOriginais(params.pagamentos)) !== pagamentosSnapshot) {
    return resultadoBloqueado(
      'PAGAMENTOS_ALTERADOS',
      'Os pagamentos originais foram alterados. Aplicação bloqueada.',
      { chamadas, saldos_antes: saldosAntes, total_comercial: totalComercial }
    );
  }

  const resultadoOficial = {
    sucesso: true,
    itens: linhas,
    valorFiscalEfetivo: totalFiscal,
    valorFiscalLiquido: totalFiscal,
    valorNaoFiscal: totalNaoFiscal,
    valorNaoFiscalLiquido: totalNaoFiscal,
    valorFiscalBruto: rateioComposicao.valorFiscalBruto,
    valorNaoFiscalBruto: rateioComposicao.valorNaoFiscalBruto,
    valorFiscalMaximo: totalFiscal,
    totalVenda: totalDistribuido,
    totalVendaBruto: brutoComposicao,
    preservacaoAplicada: false,
    origem: 'distribuirItensVendaComValorFiscalEfetivo',
    desconto_enviado_ao_distribuidor: descontoComercial,
    acrescimo_enviado_ao_distribuidor: acrescimoComercial,
    margem_nao_convertida_em_desconto: true
  };

  let saldoAplicado = false;
  let rollback = false;
  let saldosDepois = saldosAntes;

  if (params.aplicarSaldo === true) {
    if (!params.db) {
      return resultadoBloqueado(
        'DB_OBRIGATORIO',
        'Aplicação de saldo exige o banco isolado de teste.',
        { chamadas, saldos_antes: saldosAntes, total_comercial: totalComercial }
      );
    }
    const debitar = params.deps && typeof params.deps.debitarEstoqueItemVenda === 'function'
      ? params.deps.debitarEstoqueItemVenda
      : require('./debitoEstoqueVendaViaPorta').debitarEstoqueItemVenda;
    const propriaTransacao = params.jaEmTransacao !== true;
    try {
      if (propriaTransacao) await dbRunLocal(params.db, 'BEGIN');
      for (const linha of linhas) {
        if (Number(linha.quantidade_fiscal || 0) <= 0 && Number(linha.quantidade_nao_fiscal || 0) <= 0) {
          continue;
        }
        await debitarOficialAsync(debitar, params.db, {
          produtoId: linha.produto_id,
          quantidadeFiscal: linha.quantidade_fiscal,
          quantidadeNaoFiscal: linha.quantidade_nao_fiscal,
          empresaId,
          db: params.db,
          origem: 'recomposicao_distribuicao_oficial'
        });
      }
      if (propriaTransacao) await dbRunLocal(params.db, 'COMMIT');
      saldoAplicado = true;
    } catch (err) {
      if (propriaTransacao) {
        try { await dbRunLocal(params.db, 'ROLLBACK'); } catch (_roll) { /* transação já encerrada */ }
        rollback = true;
      }
      const atualizados = [];
      for (const plano of planos) {
        const relido = await lerSaldoEmpresaProduto(params.db, empresaId, plano.produto_id);
        atualizados.push(Object.freeze({
          produto_id: plano.produto_id,
          empresa_id: empresaId,
          saldo_fiscal: relido.ok ? relido.saldoFiscal : null,
          saldo_nao_fiscal: relido.ok ? relido.saldoNaoFiscal : null
        }));
      }
      return resultadoBloqueado(
        (err && (err.code || err.codigo)) || 'FALHA_APLICACAO_SALDO',
        err && err.message ? String(err.message).slice(0, 200) : 'Falha ao aplicar saldo. Rollback executado.',
        {
          chamadas,
          saldos_antes: saldosAntes,
          saldos_depois: Object.freeze(atualizados),
          rollback,
          total_comercial: totalComercial
        }
      );
    }

    const atualizados = [];
    for (const plano of planos) {
      const relido = await lerSaldoEmpresaProduto(params.db, empresaId, plano.produto_id);
      atualizados.push(Object.freeze({
        produto_id: plano.produto_id,
        empresa_id: empresaId,
        saldo_fiscal: relido.ok ? relido.saldoFiscal : null,
        saldo_nao_fiscal: relido.ok ? relido.saldoNaoFiscal : null
      }));
    }
    saldosDepois = Object.freeze(atualizados);
  }

  return Object.freeze({
    sprint: 'CDS-PAGAMENTO-MISTO-RECOMPOSICAO-FISCAL-17',
    distribuicao_aplicada: true,
    saldo_aplicado: saldoAplicado,
    codigo: 'DISTRIBUICAO_OFICIAL_APLICADA',
    motivo: null,
    resultado_oficial: Object.freeze({
      ...resultadoOficial,
      itens: Object.freeze(linhas.map((linha) => Object.freeze({ ...linha })))
    }),
    chamadas_distribuidor: Object.freeze(chamadas),
    saldos_antes: saldosAntes,
    saldos_depois: saldosDepois,
    rollback,
    total_comercial: totalComercial,
    total_comercial_preservado: true,
    pagamentos_preservados: true,
    margem_nao_convertida_em_desconto: true,
    desconto_enviado_ao_distribuidor: descontoComercial,
    acrescimo_enviado_ao_distribuidor: acrescimoComercial,
    resultado_motor_legado_inalterado: true,
    substitui_motor_fxnf_diretamente: false,
    producao_habilitada: RECOMPOSICAO_HABILITADA_EM_PRODUCAO === true,
    contrato: CONTRATO_DISTRIBUICAO_OFICIAL,
    autorizacao_fonte: auth.fonte || null
  });
}

module.exports = {
  PONTO_INTEGRACAO_FECHAMENTO,
  MUDANCAS_OPERACIONAIS_PENDENTES,
  CONTRATO_MOTOR_FXNF,
  CONTRATO_DISTRIBUICAO_OFICIAL,
  MODOS_OPERACIONAIS,
  RUNBOOK_TESTE_REAL_PDV,
  ENV_DIAGNOSTICO_ATIVO,
  ENV_DIAGNOSTICO_CANDIDATO,
  ENV_HOMOLOGACAO_ATIVA,
  ENV_APLICAR_DISTRIBUICAO,
  ENV_DISTRIBUICAO_OFICIAL,
  extrairSnapshotFechamento,
  prepararPropostaRecomposicaoDoFechamento,
  obterDiagnosticoInternoBackend,
  obterAtivacaoHomologacaoInterna,
  resolverModoOperacionalRecomposicao,
  avaliarCompatibilidadeComItensVendidos,
  montarRelatorioOperacionalRecomposicao,
  resolverDiagnosticoInternoParaFechamento,
  resolverCandidatoDiagnosticoFechamento,
  resolverContextoComposicaoNoFechamento,
  mapearComposicaoParaItensProposta,
  executarDiagnosticoRecomposicaoNoFechamento,
  validarPropostaContraContratoMotorFxnf,
  executarAtivacaoControladaRecomposicaoNoFechamento,
  montarResumoSeguroDiagnostico,
  obterAutorizacaoDistribuicaoOficialInterna,
  encaminharPropostaValidadaAoDistribuidorOficial
};
