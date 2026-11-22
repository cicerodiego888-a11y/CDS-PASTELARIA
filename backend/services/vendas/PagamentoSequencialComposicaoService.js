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
  recomposicaoFechamentoOperacionalAtiva,
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

const STATUS_CANCELADO = new Set([
  'cancelado',
  'cancelada',
  'cancelados',
  'canceladas',
  'cancelled',
  'canceled',
  'estornado',
  'estornada',
  'estorno'
]);

const STATUS_ELETRONICO_APROVADO = new Set(['aprovada', 'aprovado']);

const ENV_REFERENCIA_TESTE = 'CDS_RECOMPOSICAO_REFERENCIA_TESTE';

function arredondar(valor) {
  return Math.round((Number(valor) + Number.EPSILON) * 100) / 100;
}

function ambienteTesteRecomposicaoReferencia(env = process.env) {
  return String(env[ENV_REFERENCIA_TESTE] || '') === '1'
    && RECOMPOSICAO_HABILITADA_EM_PRODUCAO !== true;
}

/**
 * Porta operacional (contexto PDV) ou ambiente de teste (Sprint 26).
 * Não liga reescrita no emissor.
 */
function ambienteRecomposicaoReferenciaAtivo(env = process.env, contexto = null) {
  if (recomposicaoFechamentoOperacionalAtiva(env, contexto)) return true;
  return ambienteTesteRecomposicaoReferencia(env);
}

function parcelaManualDeDinheiro(pagamento) {
  if (!formaEhDinheiro(pagamento && pagamento.forma_pagamento)) return false;
  const status = String(pagamento.status_autorizacao || pagamento.status || '').toLowerCase();
  if (STATUS_NAO_CONFIRMADO.has(status) || STATUS_CANCELADO.has(status)) return false;
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

/**
 * CONFIRMACAO-AUTORITATIVA-01: só carimbo pós-consulta a tef_transacoes.
 * Payload com tef_transacao_id / NSU / autorização NÃO prova sozinho.
 */
function evidenciaConfirmacaoEletronica(pagamento) {
  return !!(pagamento && pagamento.confirmacao_eletronica_comprovada === true);
}

/**
 * TEF desligado: operador confirma recebimento na maquininha/app externo.
 * Não confunde com TEF real — exige carimbo manual explícito e sem tef_transacao_id.
 */
function evidenciaConfirmacaoOperacionalExterna(pagamento) {
  if (!pagamento || !formaPagamentoUsaTEF(pagamento.forma_pagamento)) return false;
  if (evidenciaConfirmacaoEletronica(pagamento)) return false;
  const tefId = pagamento.tef_transacao_id != null
    ? pagamento.tef_transacao_id
    : (pagamento.tef && pagamento.tef.transacao_id);
  if (tefId != null && String(tefId).trim() !== '') return false;
  const status = String(pagamento.status_autorizacao || pagamento.status || '').toLowerCase();
  if (STATUS_NAO_CONFIRMADO.has(status) || STATUS_CANCELADO.has(status)) return false;
  if (pagamento.confirmacao_operacional_externa === true) return true;
  const manual = pagamento.confirmacao_manual === 1
    || pagamento.confirmacao_manual === true
    || pagamento.confirmacao_manual === '1';
  const modalidadeManual = String(pagamento.confirmacao_modalidade || '').toLowerCase() === 'manual';
  // Persistido no fechamento TEF-off: confirmacao_manual + modalidade manual.
  if (manual && (modalidadeManual || status === 'confirmada' || status === 'informada' || status === 'aprovado' || status === 'aprovada' || status === '')) {
    return true;
  }
  return false;
}

function parcelaEfetivamenteConfirmada(pagamento) {
  if (!pagamento || !(Number(pagamento.valor) > 0)) return false;
  const status = String(pagamento.status_autorizacao || pagamento.status || '').toLowerCase();
  if (STATUS_NAO_CONFIRMADO.has(status) || STATUS_CANCELADO.has(status)) return false;
  if (parcelaManualDeDinheiro(pagamento)) return true;
  if (!formaPagamentoUsaTEF(pagamento.forma_pagamento)) return false;
  // TEF off: PIX/cartão confirmados operacionalmente contam como fiscal.
  if (evidenciaConfirmacaoOperacionalExterna(pagamento)) return true;
  // Já classificado no fechamento (venda_recebimentos) — fonte persistida.
  if (
    String(pagamento.tipo_recebimento || '').toLowerCase() === 'fiscal'
    && (status === 'aprovado' || status === 'aprovada' || STATUS_ELETRONICO_APROVADO.has(status) || status === '')
  ) {
    return true;
  }
  if (!STATUS_ELETRONICO_APROVADO.has(status)) return false;
  if (pagamento.aprovado === false) return false;
  return evidenciaConfirmacaoEletronica(pagamento);
}

/**
 * Atalho de teste/fixtures: carimba parcela já comprovada pelo backend.
 * Não usar a partir do frontend.
 */
function marcarParcelaEletronicaComprovada(pagamento, extras = {}) {
  return {
    ...pagamento,
    ...extras,
    status: extras.status || pagamento.status || 'aprovado',
    status_autorizacao: extras.status_autorizacao || pagamento.status_autorizacao || 'aprovado',
    confirmacao_eletronica_comprovada: true
  };
}

/**
 * Planejamento F×NF: eletrônico já informado (TEF off / aguardando modal operacional)
 * entra como fiscal candidato. Emissão final continua exigindo parcelaEfetivamenteConfirmada.
 */
function parcelaAlocaReferenciaPlanejamento(pagamento) {
  if (parcelaEfetivamenteConfirmada(pagamento)) return true;
  if (!pagamento || !(Number(pagamento.valor) > 0)) return false;
  if (!formaPagamentoUsaTEF(pagamento.forma_pagamento)) return false;
  const status = String(pagamento.status_autorizacao || pagamento.status || '').toLowerCase();
  if (STATUS_NAO_CONFIRMADO.has(status) || STATUS_CANCELADO.has(status)) return false;
  return status === 'informada'
    || status === 'confirmada'
    || status === 'aprovada'
    || status === 'aprovado'
    || status === '';
}

function calcularReferenciasConfirmadas(pagamentos, opcoes = {}) {
  const planejamento = opcoes.planejamento === true;
  let fiscal = 0;
  let naoFiscal = 0;
  for (const pagamento of pagamentos || []) {
    const conta = planejamento
      ? parcelaAlocaReferenciaPlanejamento(pagamento)
      : parcelaEfetivamenteConfirmada(pagamento);
    if (!conta) continue;
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
  const contexto = opcoes.contexto || entrada.contexto || null;
  // Preview PDV (/composicao-sequencial) e fechamento operacional autorizam a referência F×NF.
  const ativo = opcoes.forcarReferencia === true
    || ambienteRecomposicaoReferenciaAtivo(env, contexto);
  if (!ativo) {
    return Object.freeze({
      ...base,
      recomposicao_executada: false,
      valor_fiscal_referencia: null,
      valor_nao_fiscal_referencia: null,
      distribuicao_oficial_alterada: false,
      motivo_recomposicao: 'ambiente_teste_desligado'
    });
  }

  // Planejamento: TEF-off informado (débito/PIX) já conta como fiscal candidato.
  const referencias = calcularReferenciasConfirmadas(entrada.pagamentos, { planejamento: true });
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

const SQL_TABELA_COMPOSICAO_REFERENCIA = `
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

const COLUNAS_COMPLEMENTO_COMPOSICAO = Object.freeze([
  ['complemento_dinheiro_utilizado', 'REAL NOT NULL DEFAULT 0'],
  ['desconto_ajuste', 'REAL NOT NULL DEFAULT 0'],
  ['valor_fiscal_referencia_inicial', 'REAL'],
  ['valor_nao_fiscal_referencia_inicial', 'REAL'],
  ['origem_recomposicao', 'TEXT']
]);

function runSql(dbConnection, sql, params = []) {
  return new Promise((resolve, reject) => {
    dbConnection.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function getSql(dbConnection, sql, params = []) {
  return new Promise((resolve, reject) => {
    dbConnection.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

/**
 * CDS-PDV-NFCE-HANDOFF-COMPLEMENTO-FISCAL-01
 * Garante tabela + colunas do complemento fiscal persistido por venda.
 */
async function garantirSchemaVendaComposicaoReferencia(dbConnection) {
  await runSql(dbConnection, SQL_TABELA_COMPOSICAO_REFERENCIA);
  for (const [coluna, tipo] of COLUNAS_COMPLEMENTO_COMPOSICAO) {
    try {
      await runSql(
        dbConnection,
        `ALTER TABLE venda_composicao_referencia ADD COLUMN ${coluna} ${tipo}`
      );
    } catch (erro) {
      const msg = String(erro && erro.message || erro || '');
      if (!/duplicate column|already exists/i.test(msg)) throw erro;
    }
  }
}

function gravarReferenciaRecomposicao(dbConnection, vendaId, avaliacao) {
  if (!avaliacao || avaliacao.recomposicao_executada !== true) {
    return Promise.resolve(null);
  }
  if (RECOMPOSICAO_HABILITADA_EM_PRODUCAO === true) {
    return Promise.resolve(null);
  }
  const motor = avaliacao.avaliacao_motor || {};
  const fiscalFinal = Number(avaliacao.valor_fiscal_referencia || 0);
  const naoFiscalFinal = Number(avaliacao.valor_nao_fiscal_referencia || 0);
  const fiscalInicial = Number(
    avaliacao.valor_fiscal_referencia_inicial != null
      ? avaliacao.valor_fiscal_referencia_inicial
      : fiscalFinal
  );
  const naoFiscalInicial = Number(
    avaliacao.valor_nao_fiscal_referencia_inicial != null
      ? avaliacao.valor_nao_fiscal_referencia_inicial
      : naoFiscalFinal
  );
  const complemento = Number(avaliacao.complemento_dinheiro_utilizado || 0);
  const descontoAjuste = Number(avaliacao.desconto_ajuste || 0);
  const dinheiroRecebido = naoFiscalInicial > 0.009 ? naoFiscalInicial : naoFiscalFinal;
  const origem = avaliacao.origem_recomposicao === 'complemento_integral_produto_excepcional'
    ? avaliacao.origem_recomposicao
    : (complemento > 0.009
      ? 'recomposicao_complemento_20'
      : (avaliacao.origem_recomposicao || 'recomposicao_referencia'));

  return garantirSchemaVendaComposicaoReferencia(dbConnection).then(() => runSql(
    dbConnection,
    `INSERT INTO venda_composicao_referencia (
      venda_id, total_financeiro, dinheiro_recebido,
      valor_fiscal_referencia, valor_nao_fiscal_referencia,
      motor_codigo, distribuicao_possivel, aplica_ao_fluxo_oficial,
      distribuicao_oficial_alterada, criado_em,
      complemento_dinheiro_utilizado, desconto_ajuste,
      valor_fiscal_referencia_inicial, valor_nao_fiscal_referencia_inicial,
      origem_recomposicao
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, datetime('now'), ?, ?, ?, ?, ?)`,
    [
      vendaId,
      Number(avaliacao.total_financeiro != null ? avaliacao.total_financeiro : (fiscalFinal + naoFiscalFinal)),
      dinheiroRecebido,
      fiscalFinal,
      naoFiscalFinal,
      motor.codigo || null,
      motor.distribuicao_possivel === true ? 1 : 0,
      complemento,
      descontoAjuste,
      fiscalInicial,
      naoFiscalInicial,
      origem
    ]
  ).then((result) => ({ lastID: result.lastID })));
}

function carregarReferenciaRecomposicao(dbConnection, vendaId) {
  const id = Number(vendaId);
  if (!Number.isInteger(id) || id <= 0 || !dbConnection) {
    return Promise.resolve(null);
  }
  return garantirSchemaVendaComposicaoReferencia(dbConnection).then(() => getSql(
    dbConnection,
    `SELECT * FROM venda_composicao_referencia WHERE venda_id = ?`,
    [id]
  )).catch(() => null);
}

/**
 * Valida complemento persistido contra pagamentos confirmados e totais da venda/itens.
 * Não aceita complemento vindo só do payload do frontend.
 */
function validarReferenciaFiscalFinalComComplemento({
  pagamentos,
  itens,
  venda,
  referenciaPersistida
} = {}) {
  const refsPag = calcularReferenciasConfirmadas(pagamentos);
  const eletronicoPagamentos = arredondar(refsPag.valor_fiscal_referencia || 0);
  const dinheiroPagamentos = arredondar(refsPag.valor_nao_fiscal_referencia || 0);
  const lista = Array.isArray(itens) ? itens : [];
  const somaFiscal = arredondar(lista.reduce(
    (total, item) => total + Number(item && item.valor_fiscal || 0),
    0
  ));
  const somaNao = arredondar(lista.reduce(
    (total, item) => total + Number(item && item.valor_nao_fiscal || 0),
    0
  ));
  const totalVenda = arredondar(Number(venda && venda.total || 0));
  const valorFiscalVenda = arredondar(Number(venda && venda.valor_fiscal || 0));
  const valorNaoFiscalVenda = arredondar(Number(venda && venda.valor_nao_fiscal || 0));

  const {
    complementoMaximoPermitidoCentavos,
    ehComplementoMoeda5Centavos,
    pisoComplementoMoeda5Centavos
  } = require('./RecomposicaoFiscalToleranciaDinheiroSimulacaoService');

  const persistida = referenciaPersistida || null;
  let complemento = 0;
  let descontoAjuste = 0;
  // Base do complemento: preferir snapshot persistido na composição.
  // Releitura sem carimbo TEF zera o eletrônico e gerava falso
  // COMPLEMENTO_INCOERENTE_COM_ELETRONICO após a venda já gravada.
  let eletronico = eletronicoPagamentos;
  let dinheiro = dinheiroPagamentos;
  let fiscalFinal = eletronico;
  let gerencialFinal = dinheiro;

  if (persistida) {
    complemento = arredondar(Number(persistida.complemento_dinheiro_utilizado || 0));
    descontoAjuste = arredondar(Number(persistida.desconto_ajuste || 0));
    if (persistida.valor_fiscal_referencia_inicial != null) {
      const inicialF = arredondar(Number(persistida.valor_fiscal_referencia_inicial));
      if (eletronicoPagamentos <= 0.009 && inicialF > 0.009) {
        eletronico = inicialF;
      } else if (
        eletronicoPagamentos > 0.009
        && Math.abs(eletronicoPagamentos - inicialF) <= 0.02
      ) {
        eletronico = eletronicoPagamentos;
      } else if (inicialF > 0.009) {
        eletronico = inicialF;
      }
    }
    if (persistida.valor_nao_fiscal_referencia_inicial != null) {
      const inicialNf = arredondar(Number(persistida.valor_nao_fiscal_referencia_inicial));
      if (dinheiroPagamentos <= 0.009 && inicialNf > 0.009) {
        dinheiro = inicialNf;
      } else if (
        dinheiroPagamentos > 0.009
        && Math.abs(dinheiroPagamentos - inicialNf) <= 0.02
      ) {
        dinheiro = dinheiroPagamentos;
      } else if (inicialNf > 0.009) {
        dinheiro = inicialNf;
      }
    }
    const fiscalPersistido = persistida.valor_fiscal_referencia != null
      ? arredondar(Number(persistida.valor_fiscal_referencia))
      : null;
    const gerencialPersistido = persistida.valor_nao_fiscal_referencia != null
      ? arredondar(Number(persistida.valor_nao_fiscal_referencia))
      : null;
    // Snapshot zerado indevidamente (ex.: PIX TEF-off não contado na gravação):
    // prioriza o eletrônico/dinheiro recalculados dos pagamentos confirmados.
    fiscalFinal = (fiscalPersistido != null && fiscalPersistido > 0.009)
      ? fiscalPersistido
      : arredondar(eletronico + complemento);
    gerencialFinal = (gerencialPersistido != null && gerencialPersistido > 0.009)
      ? gerencialPersistido
      : (
        dinheiro > 0.009
          ? arredondar(Math.max(0, dinheiro - complemento))
          : (gerencialPersistido != null ? gerencialPersistido : 0)
      );
    if (fiscalPersistido != null && fiscalPersistido <= 0.009 && eletronico > 0.009) {
      fiscalFinal = arredondar(eletronico + complemento);
    }
    if (
      gerencialPersistido != null
      && gerencialPersistido > 0.009
      && dinheiro > 0.009
      && Math.abs(gerencialPersistido - (dinheiro - complemento)) <= 0.05
    ) {
      gerencialFinal = arredondar(dinheiro - complemento);
    }
  }

  // Itens com fatia acima do eletrônico sem evidência persistida válida → bloqueio.
  if ((!persistida || !(complemento > 0.009)) && eletronico > 0.009 && dinheiro > 0.009) {
    if (somaFiscal - eletronico > 0.02) {
      return Object.freeze({
        ok: false,
        codigo: 'COMPLEMENTO_NAO_PERSISTIDO',
        motivo:
          'Os itens fiscais excedem o eletrônico confirmado sem complemento persistido e validado.',
        referencia_pagamentos: refsPag,
        somaFiscal,
        somaNao
      });
    }
  }

  if (!(complemento > 0.009) && persistida && eletronico > 0.009) {
    if (Math.abs(fiscalFinal - eletronico) > 0.02) {
      return Object.freeze({
        ok: false,
        codigo: 'REFERENCIA_FISCAL_SEM_COMPLEMENTO_DIVERGENTE',
        motivo:
          'Referência fiscal persistida diverge do eletrônico sem complemento registrado.',
        fiscalFinal,
        eletronico,
        referencia_pagamentos: refsPag,
        somaFiscal,
        somaNao
      });
    }
  }

  if (complemento > 0.009) {
    if (!persistida || (
      venda && venda.id != null
      && Number(persistida.venda_id) !== Number(venda.id)
    )) {
      return Object.freeze({
        ok: false,
        codigo: 'COMPLEMENTO_SEM_VINCULO',
        motivo: 'Complemento fiscal sem vínculo persistido com a venda.',
        referencia_pagamentos: refsPag,
        somaFiscal,
        somaNao
      });
    }
    const margem = complementoMaximoPermitidoCentavos(pagamentos || []);
    const complementoC = Math.round(complemento * 100);
    const complementoExcepcionalIntegral = persistida.origem_recomposicao
      === 'complemento_integral_produto_excepcional';
    if (complementoExcepcionalIntegral && lista.some((item) => (
      Number(item && item.valor_fiscal || 0) > 0.009
      && (
        !Number.isSafeInteger(Number(item.quantidade_fiscal))
        || Number(item.quantidade_fiscal) <= 0
      )
    ))) {
      return Object.freeze({
        ok: false,
        codigo: 'COMPLEMENTO_EXCEPCIONAL_QUANTIDADE_FRACIONADA',
        motivo: 'Complemento excepcional exige quantidades fiscais integrais em todos os produtos fiscais.',
        complemento,
        referencia_pagamentos: refsPag,
        somaFiscal,
        somaNao
      });
    }
    // Dinheiro pode vir do snapshot persistido (releitura sem carimbo); a margem
    // efetiva é o maior entre a live e 20% desse dinheiro restaurado.
    const dinheiroC = Math.round(Number(dinheiro || 0) * 100);
    const margemSnapshotC = pisoComplementoMoeda5Centavos(
      Math.min(dinheiroC, Math.floor(dinheiroC * 0.2))
    );
    const margemEfetivaC = Math.max(
      Number(margem.complemento_maximo_centavos || 0),
      margemSnapshotC
    );
    if (!complementoExcepcionalIntegral && !ehComplementoMoeda5Centavos(complementoC)) {
      return Object.freeze({
        ok: false,
        codigo: 'COMPLEMENTO_MOEDA_INVALIDA',
        motivo: 'Complemento persistido não é múltiplo de R$ 0,05.',
        complemento,
        referencia_pagamentos: refsPag,
        somaFiscal,
        somaNao
      });
    }
    if (
      (!complementoExcepcionalIntegral && complementoC > margemEfetivaC)
      || complemento - dinheiro > 0.009
      || (complementoExcepcionalIntegral && descontoAjuste > 0.009)
    ) {
      return Object.freeze({
        ok: false,
        codigo: complementoExcepcionalIntegral
          ? 'COMPLEMENTO_EXCEPCIONAL_INTEGRAL_INVALIDO'
          : 'COMPLEMENTO_ACIMA_DA_MARGEM',
        motivo: complementoExcepcionalIntegral
          ? 'Complemento excepcional deve usar somente dinheiro disponível e não pode reduzir o valor integral dos produtos.'
          : 'Complemento persistido ultrapassa 20% do dinheiro ou o disponível.',
        complemento,
        margem_maxima: arredondar(margemEfetivaC / 100),
        referencia_pagamentos: refsPag,
        somaFiscal,
        somaNao
      });
    }
    if (Math.abs(fiscalFinal - (eletronico + complemento)) > 0.02) {
      return Object.freeze({
        ok: false,
        codigo: 'COMPLEMENTO_INCOERENTE_COM_ELETRONICO',
        motivo: 'Referência fiscal final não fecha eletrônico + complemento.',
        complemento,
        fiscalFinal,
        eletronico,
        referencia_pagamentos: refsPag,
        somaFiscal,
        somaNao
      });
    }
    if (Math.abs(gerencialFinal - (dinheiro - complemento)) > 0.02) {
      return Object.freeze({
        ok: false,
        codigo: 'COMPLEMENTO_INCOERENTE_COM_DINHEIRO',
        motivo: 'Referência gerencial final não fecha dinheiro − complemento.',
        complemento,
        gerencialFinal,
        dinheiro,
        referencia_pagamentos: refsPag,
        somaFiscal,
        somaNao
      });
    }
    // Defesa: piso da margem efetiva nunca arredonda para cima.
    if (
      !complementoExcepcionalIntegral
      && pisoComplementoMoeda5Centavos(margemEfetivaC) < complementoC
    ) {
      return Object.freeze({
        ok: false,
        codigo: 'COMPLEMENTO_ACIMA_DA_MARGEM',
        motivo: 'Complemento excede o piso de R$ 0,05 da margem.',
        complemento,
        referencia_pagamentos: refsPag,
        somaFiscal,
        somaNao
      });
    }
  }

  const separacao = fiscalFinal > 0.009 && gerencialFinal > 0.009;
  if (separacao && Math.abs(somaFiscal - fiscalFinal) > 0.02) {
    return Object.freeze({
      ok: false,
      codigo: 'DISTRIBUICAO_NAO_AUTORIZADA',
      motivo:
        'A referência fiscal final não corresponde aos itens persistidos. A NFC-e não foi montada com o carrinho comercial.',
      referencia_pagamentos: refsPag,
      referencia_final: Object.freeze({
        valor_fiscal_referencia: fiscalFinal,
        valor_nao_fiscal_referencia: gerencialFinal,
        complemento_dinheiro_utilizado: complemento,
        desconto_ajuste: descontoAjuste
      }),
      somaFiscal,
      somaNao
    });
  }
  if (separacao && somaFiscal <= 0.009) {
    return Object.freeze({
      ok: false,
      codigo: 'DISTRIBUICAO_NAO_AUTORIZADA',
      motivo: 'Não há distribuição fiscal autorizada para a referência da venda.',
      referencia_pagamentos: refsPag,
      somaFiscal,
      somaNao
    });
  }
  if (separacao && Math.abs(somaNao - gerencialFinal) > 0.05) {
    return Object.freeze({
      ok: false,
      codigo: 'DISTRIBUICAO_NAO_FISCAL_DIVERGENTE',
      motivo: 'A referência gerencial final não corresponde aos itens persistidos.',
      referencia_pagamentos: refsPag,
      somaFiscal,
      somaNao,
      gerencialFinal
    });
  }
  // Itens já líquidos (= total) OU itens brutos com desconto/acréscimo no cabeçalho
  // (contrato preservar composição de pedido / desconto comercial). Ambos fecham a venda.
  const descontoVenda = arredondar(Number(venda && venda.desconto || 0));
  const acrescimoVenda = arredondar(Number(venda && venda.acrescimo || 0));
  const somaItensFnNf = arredondar(somaFiscal + somaNao);
  const liquidoViaCabecalho = arredondar(somaItensFnNf - descontoVenda + acrescimoVenda);
  const fechaTotalDireto = Math.abs(somaItensFnNf - totalVenda) <= 0.05;
  const fechaTotalComDescontoCabecalho = (descontoVenda > 0.009 || acrescimoVenda > 0.009)
    && Math.abs(liquidoViaCabecalho - totalVenda) <= 0.05;
  // Venda só eletrônica sem fatias F/NF preenchidas: não aplicar o contrato misto aqui.
  const exclusivamenteEletronico = eletronico > 0.009
    && dinheiro <= 0.009
    && complemento <= 0.009;
  const fatiasAusentes = somaItensFnNf <= 0.009;
  if (
    totalVenda > 0.009
    && !(exclusivamenteEletronico && fatiasAusentes)
    && !fechaTotalDireto
    && !fechaTotalComDescontoCabecalho
  ) {
    return Object.freeze({
      ok: false,
      codigo: 'TOTAL_VENDA_DIVERGENTE',
      motivo: 'A soma fiscal + gerencial diverge do total da venda.',
      somaFiscal,
      somaNao,
      totalVenda,
      desconto: descontoVenda,
      acrescimo: acrescimoVenda
    });
  }
  if (fiscalFinal > 0.009 && Math.abs(valorFiscalVenda - fiscalFinal) > 0.05) {
    return Object.freeze({
      ok: false,
      codigo: 'CABECALHO_FISCAL_DIVERGENTE',
      motivo: 'vendas.valor_fiscal diverge da referência fiscal final.',
      valorFiscalVenda,
      fiscalFinal,
      somaFiscal
    });
  }
  // Também detecta cabeçalho gerencial zerado indevidamente (não só divergência > 0).
  if (gerencialFinal > 0.009 && Math.abs(valorNaoFiscalVenda - gerencialFinal) > 0.05) {
    return Object.freeze({
      ok: false,
      codigo: 'CABECALHO_NAO_FISCAL_DIVERGENTE',
      motivo: 'vendas.valor_nao_fiscal diverge da referência gerencial final.',
      valorNaoFiscalVenda,
      gerencialFinal,
      somaNao
    });
  }

  return Object.freeze({
    ok: true,
    codigo: null,
    motivo: null,
    referencia_pagamentos: refsPag,
    referencia_final: Object.freeze({
      valor_fiscal_referencia: fiscalFinal,
      valor_nao_fiscal_referencia: gerencialFinal,
      valor_fiscal_referencia_inicial: eletronico,
      valor_nao_fiscal_referencia_inicial: dinheiro,
      complemento_dinheiro_utilizado: complemento,
      desconto_ajuste: descontoAjuste
    }),
    complemento_dinheiro_utilizado: complemento,
    desconto_ajuste: descontoAjuste,
    somaFiscal,
    somaNao
  });
}

module.exports = {
  avaliarPagamentosSequenciais,
  avaliarReferenciaRecomposicao,
  ambienteTesteRecomposicaoReferencia,
  ambienteRecomposicaoReferenciaAtivo,
  calcularReferenciasConfirmadas,
  classificarTipoRecebimento,
  parcelaEfetivamenteConfirmada,
  parcelaAlocaReferenciaPlanejamento,
  evidenciaConfirmacaoEletronica,
  evidenciaConfirmacaoOperacionalExterna,
  marcarParcelaEletronicaComprovada,
  gravarReferenciaRecomposicao,
  carregarReferenciaRecomposicao,
  garantirSchemaVendaComposicaoReferencia,
  validarReferenciaFiscalFinalComComplemento,
  ENV_REFERENCIA_TESTE,
  STATUS_CANCELADO
};
