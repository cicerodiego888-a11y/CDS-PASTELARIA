/**
 * ORQUESTRADOR DE PAGAMENTOS - ARQUITETURA OFICIAL CDS SISTEMAS
 * 
 * Este é o ÚNICO local onde todas as decisões de pagamento devem existir.
 * O frontend (PDV) NÃO deve tomar nenhuma decisão de fluxo de pagamento.
 * 
 * FLUXO OBRIGATÓRIO:
 * Venda → Motor Fiscal → totais F/NF → MIDP (distribuição de meios) →
 * Orquestrador (TEF/confirmação) → status → NFC-e / Financeiro
 */

const tefManager = require('./tef/TefManager');
const tefContrato = require('./tef/tefContrato');
const tefConfigService = require('./tef/tefConfigService');
const tefFluxoPagamento = require('./tef/tefFluxoPagamento');
const midp = require('./midp');

const FORMAS_PRAZO = new Set([
  'prazo',
  'parcelado',
  'crediario',
  'boleto',
  'boleto_bancario'
]);
const FORMAS_TEF = new Set(['cartao_debito', 'cartao_credito']);
const ERRO_AUTORIZACAO_PAGAMENTO =
  'Não foi possível confirmar a autorização do pagamento. A venda não foi registrada.';

function confirmacaoFiscalManualExplicita(valor) {
  return valor === true || valor === 'true' || valor === 1 || valor === '1';
}

function modoManualVigente(modoConfirmacaoFiscal) {
  return String(modoConfirmacaoFiscal || 'TEF').toUpperCase() === 'MANUAL';
}

function confirmacaoManualAceita(modoConfirmacaoFiscal, confirmacaoFiscalManual, tefHabilitado) {
  if (!confirmacaoFiscalManualExplicita(confirmacaoFiscalManual)) return false;
  if (!tefFluxoPagamento.parseTefHabilitado(tefHabilitado)) return true;
  return modoManualVigente(modoConfirmacaoFiscal);
}

function listarPagamentosQueExigemTef(pagamentos) {
  return (Array.isArray(pagamentos) ? pagamentos : []).filter((pagamento) =>
    tefFluxoPagamento.formaPagamentoUsaTEF(pagamento && pagamento.forma_pagamento)
  );
}

function identificadorTefInformado(valor) {
  return valor != null && String(valor).trim() !== '';
}

function valoresMonetariosCompativeis(aprovado, pagamento) {
  return Math.abs(arredondarCentavos(aprovado) - arredondarCentavos(pagamento)) <= 0.009;
}

function buscarTransacaoTefPorId(id) {
  const db = require('../database');
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT id, status, valor, tipo, nsu, autorizacao, venda_id, empresa_id
       FROM tef_transacoes WHERE id = ?`,
      [Number(id)],
      (err, row) => {
        if (err) reject(err);
        else resolve(row || null);
      }
    );
  });
}

async function comprovarTransacoesTefAprovadas(pagamentosTef, empresaIdVenda) {
  const ids = pagamentosTef.map((pagamento) => Number(pagamento.tef_transacao_id));
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    return { sucesso: false, erro: 'Transação TEF não encontrada ou não aprovada.' };
  }
  if (new Set(ids).size !== ids.length) {
    return { sucesso: false, erro: 'A mesma transação TEF não pode quitar mais de um pagamento.' };
  }
  if (!Number(empresaIdVenda)) {
    return { sucesso: false, erro: 'Venda sem empresa autorizada para vincular a transação TEF.' };
  }

  const transacoes = [];
  for (const pagamento of pagamentosTef) {
    let row;
    try {
      row = await buscarTransacaoTefPorId(pagamento.tef_transacao_id);
    } catch (error) {
      return { sucesso: false, erro: 'Não foi possível confirmar a transação TEF.' };
    }
    if (!row || !tefContrato.estaAprovado({ status: row.status })) {
      return { sucesso: false, erro: 'Transação TEF não encontrada ou não aprovada.' };
    }
    if (row.empresa_id == null) {
      return { sucesso: false, erro: 'Transação TEF sem vínculo empresarial não pode quitar a venda.' };
    }
    if (Number(row.empresa_id) !== Number(empresaIdVenda)) {
      return { sucesso: false, erro: 'Transação TEF pertence a outra empresa.' };
    }
    if (!valoresMonetariosCompativeis(row.valor, pagamento.valor)) {
      return { sucesso: false, erro: 'Valor da transação TEF não confere com o pagamento.' };
    }
    const tipoPagamento = tefFluxoPagamento.normalizarTipoTef(pagamento.forma_pagamento);
    const tipoTransacao = tefFluxoPagamento.normalizarTipoTef(row.tipo);
    if (tipoPagamento !== tipoTransacao) {
      return { sucesso: false, erro: 'Forma de pagamento incompatível com a transação TEF.' };
    }
    if (identificadorTefInformado(pagamento.nsu) && String(pagamento.nsu) !== String(row.nsu || '')) {
      return { sucesso: false, erro: 'NSU informado não confere com a transação TEF.' };
    }
    if (
      identificadorTefInformado(pagamento.autorizacao)
      && String(pagamento.autorizacao) !== String(row.autorizacao || '')
    ) {
      return { sucesso: false, erro: 'Autorização informada não confere com a transação TEF.' };
    }
    if (row.venda_id != null) {
      return { sucesso: false, erro: 'Transação TEF já vinculada a outra venda.' };
    }
    pagamento.nsu = row.nsu || null;
    pagamento.autorizacao = row.autorizacao || null;
    transacoes.push(row.id);
  }
  return { sucesso: true, transacoes };
}

function arredondarCentavos(valor) {
  return Math.round((Number(valor || 0) + Number.EPSILON) * 100) / 100;
}

function chavePagamento(pagamento) {
  return JSON.stringify([
    String(pagamento.forma_pagamento || '').toLowerCase().trim(),
    pagamento.tef_transacao_id || '',
    pagamento.nsu || '',
    pagamento.autorizacao || ''
  ]);
}

function distribuirRecebimentosOutros(
  pagamentos,
  recebimentosFiscal,
  recebimentosNaoFiscal,
  totalOutros
) {
  let saldoOutros = arredondarCentavos(totalOutros);
  const originais = new Map();
  const usados = new Map();
  const metadados = new Map();

  (Array.isArray(pagamentos) ? pagamentos : []).forEach((pagamento) => {
    const chave = chavePagamento(pagamento);
    originais.set(chave, arredondarCentavos(
      (originais.get(chave) || 0) + Number(pagamento.valor || 0)
    ));
    metadados.set(chave, pagamento);
  });

  [...(recebimentosFiscal || []), ...(recebimentosNaoFiscal || [])].forEach((recebimento) => {
    const chave = chavePagamento(recebimento);
    usados.set(chave, arredondarCentavos(
      (usados.get(chave) || 0) + Number(recebimento.valor || 0)
    ));
  });

  const recebimentosOutros = [];
  for (const [chave, valorOriginal] of originais.entries()) {
    const pagamento = metadados.get(chave);
    const forma = String(pagamento.forma_pagamento || '').toLowerCase().trim();
    if (FORMAS_PRAZO.has(forma) || FORMAS_TEF.has(forma)) continue;

    const saldoForma = arredondarCentavos(
      Math.max(0, valorOriginal - Number(usados.get(chave) || 0))
    );
    const valor = Math.min(saldoForma, saldoOutros);
    if (valor <= 0) continue;

    recebimentosOutros.push({
      forma_pagamento: pagamento.forma_pagamento,
      valor,
      tipo_recebimento: 'outros'
    });
    saldoOutros = arredondarCentavos(saldoOutros - valor);
  }

  const valorRecebidoOutros = recebimentosOutros.reduce(
    (soma, recebimento) => soma + Number(recebimento.valor || 0),
    0
  );

  return {
    recebimentosOutros,
    saldoOutros: arredondarCentavos(
      Math.max(0, Number(totalOutros || 0) - valorRecebidoOutros)
    )
  };
}

function validarCoberturaOutrosTef(distribuicao, pagamentos) {
  const saldo = Number(distribuicao?.saldoOutros || 0);
  const usaTef = (Array.isArray(pagamentos) ? pagamentos : []).some((pagamento) =>
    FORMAS_TEF.has(String(pagamento.forma_pagamento || '').toLowerCase().trim())
  );
  return saldo > 0.009 && usaTef
    ? 'Informe uma forma de pagamento sem TEF separada para cobrir o valor de Outros.'
    : null;
}

/**
 * ORQUESTRADOR DE PAGAMENTOS - ARQUITETURA OFICIAL CDS SISTEMAS
 *
 * FLUXO OBRIGATÓRIO (RC8.2+):
 * Venda → Motor F×NF → MPFC (política) → MIDP (distribuição de meios) →
 * Orquestrador (TEF/confirmação) → status → NFC-e / Financeiro
 *
 * Sprint 3.8C — MIDP V1: política PRESERVAR DINHEIRO (via midpAtivo da política MPFC).
 * RC8.2.2 — Orquestrador NÃO lê isMidpAtivado(); recebe midpAtivo do núcleo/MPFC.
 */

/**
 * Processa o fluxo completo de pagamento de uma venda
 * Esta é a entrada principal do orquestrador
 */
async function processarFluxoPagamentoVenda({
  totalFiscal,
  totalNaoFiscal,
  totalOutros = 0,
  formaPagamento,
  pagamentos,
  tefHabilitado,
  modoConfirmacaoFiscal,
  valorFiscalMaximo,
  preservacaoAplicada,
  midpAtivo: midpAtivoEntrada,
  desconto,
  acrescimo,
  subtotalBruto,
  debugDescontoFiscal,
  confirmacaoFiscalManual,
  empresaId
}) {
  // Validações básicas — totalFiscal/totalNaoFiscal DEVEM ser líquidos (RC7.10.1 / FISCAL-4.0.2)
  totalFiscal = Number(totalFiscal || 0);
  totalNaoFiscal = Number(totalNaoFiscal || 0);
  totalOutros = Number(totalOutros || 0);
  if (!Number.isFinite(totalOutros) || totalOutros < 0) {
    return { sucesso: false, erro: 'Valor de Outros inválido.' };
  }
  const fiscalMaximo = Number(
    valorFiscalMaximo != null ? valorFiscalMaximo : totalFiscal
  );
  const totalLiquidoEsperado = arredondarCentavos(
    totalFiscal + totalNaoFiscal + totalOutros
  );
  
  // Normalizar pagamentos de entrada (fallback cobre o líquido F+NF)
  const pagamentosEntrada = normalizarPagamentosEntrada(
    pagamentos,
    formaPagamento,
    totalLiquidoEsperado
  );

  const pagamentosTefEntrada = listarPagamentosQueExigemTef(pagamentosEntrada);
  if (pagamentosTefEntrada.length > 0 && pagamentosTefEntrada.every((pagamento) => pagamento.tef_transacao_id)) {
    const prova = await comprovarTransacoesTefAprovadas(pagamentosTefEntrada, empresaId);
    if (!prova.sucesso) {
      return { sucesso: false, erro: prova.erro };
    }
  }
  
  // RC8.2.2 — midpAtivo vem exclusivamente da política MPFC (núcleo).
  // Migração: omitido → false (não consulta configuracaoService).
  const midpAtivo = midpAtivoEntrada != null ? Boolean(midpAtivoEntrada) : false;
  const resultadoMidp = midp.executar({
    pagamentosComerciais: pagamentosEntrada,
    valorFiscalLiquido: totalFiscal,
    valorFiscalEfetivo: totalFiscal,
    valorNaoFiscal: totalNaoFiscal,
    valorFiscalMaximo: fiscalMaximo,
    preservacaoAplicada: Boolean(preservacaoAplicada),
    midpAtivo
  });
  const resultadoOutros = distribuirRecebimentosOutros(
    pagamentosEntrada,
    resultadoMidp.recebimentosFiscal,
    resultadoMidp.recebimentosNaoFiscal,
    totalOutros
  );
  const distribuicao = {
    recebimentosFiscal: resultadoMidp.recebimentosFiscal,
    recebimentosNaoFiscal: resultadoMidp.recebimentosNaoFiscal,
    recebimentosOutros: resultadoOutros.recebimentosOutros,
    saldoFiscal: resultadoMidp.saldoFiscal,
    saldoNaoFiscal: resultadoMidp.saldoNaoFiscal,
    saldoOutros: resultadoOutros.saldoOutros,
    midp: {
      versao: resultadoMidp.versao,
      politica: resultadoMidp.politica,
      auditoria: resultadoMidp.auditoria
    }
  };
  const erroCoberturaOutros = validarCoberturaOutrosTef(distribuicao, pagamentosEntrada);
  if (erroCoberturaOutros) {
    return {
      sucesso: false,
      erro: erroCoberturaOutros,
      distribuicao
    };
  }

  const totalPagamentos = pagamentosEntrada.reduce(
    (s, p) => s + Number(p.valor || 0),
    0
  );
  const pagamentoFiscalRecebido = (distribuicao.recebimentosFiscal || []).reduce(
    (s, p) => s + Number(p.valor || 0),
    0
  );

  logDebugDescontoFiscal({
    ativo: debugDescontoFiscal,
    subtotal: subtotalBruto,
    desconto,
    acrescimo,
    total: totalLiquidoEsperado,
    valorFiscal: totalFiscal,
    valorNaoFiscal: totalNaoFiscal,
    pagamentoFiscal: pagamentoFiscalRecebido,
    pagamentoNaoFiscal: (distribuicao.recebimentosNaoFiscal || []).reduce(
      (s, p) => s + Number(p.valor || 0),
      0
    ),
    valorEsperado: totalFiscal,
    valorRecebido: totalPagamentos,
    saldoFiscal: distribuicao.saldoFiscal,
    saldoNaoFiscal: distribuicao.saldoNaoFiscal
  });
  
  // Validar se o pagamento fiscal é suficiente (tolerância de centavos)
  if (Number(distribuicao.saldoFiscal || 0) > 0.009) {
    logDebugDescontoFiscal({
      ativo: debugDescontoFiscal,
      motivoRejeicao: 'Pagamento fiscal insuficiente.',
      subtotal: subtotalBruto,
      desconto,
      total: totalLiquidoEsperado,
      valorFiscal: totalFiscal,
      valorNaoFiscal: totalNaoFiscal,
      valorEsperado: totalFiscal,
      valorRecebido: totalPagamentos,
      saldoFiscal: distribuicao.saldoFiscal
    });
    return {
      sucesso: false,
      erro: 'Pagamento fiscal insuficiente.',
      distribuicao
    };
  }
  
  if (Number(totalFiscal) <= 0) {
    const pagamentosTef = listarPagamentosQueExigemTef(pagamentosEntrada);
    const todosComId = pagamentosTef.length > 0 && pagamentosTef.every((pagamento) => pagamento.tef_transacao_id);
    if (pagamentosTef.length > 0 && !todosComId) {
      const aceita = confirmacaoManualAceita(
        modoConfirmacaoFiscal,
        confirmacaoFiscalManual,
        tefHabilitado
      );
      const tefOn = tefFluxoPagamento.parseTefHabilitado(tefHabilitado);
      if (!aceita && !tefOn) {
        return {
          sucesso: false,
          erro: ERRO_AUTORIZACAO_PAGAMENTO,
          distribuicao
        };
      }
    }
  }

  // Processar recebimento fiscal (TEF ou Confirmação Manual)
  const resultadoFiscal = await processarRecebimentoFiscal({
    recebimentosFiscal: distribuicao.recebimentosFiscal,
    totalFiscal,
    tefHabilitado,
    modoConfirmacaoFiscal,
    formaPagamento,
    confirmacaoFiscalManual,
    empresaId
  });
  
  if (!resultadoFiscal.sucesso) {
    return {
      sucesso: false,
      erro: resultadoFiscal.erro,
      tef: resultadoFiscal.tef,
      distribuicao
    };
  }

  /**
   * Pagamento integral: totais comerciais cobrem F+NF e MIDP zerou saldos.
   * Nesse caso a parcela não fiscal já está confirmada nesta operação
   * (ex.: prestação de entrega / PDV com pagamento completo).
   * Caso contrário, venda mista permanece em 2 etapas (aguardando_nao_fiscal).
   */
  const pagamentoIntegralConfirmado = isPagamentoIntegralConfirmado({
    totalPagamentos,
    totalLiquidoEsperado,
    saldoFiscal: distribuicao.saldoFiscal,
    saldoNaoFiscal: distribuicao.saldoNaoFiscal,
    saldoOutros: distribuicao.saldoOutros
  });

  const vendaMista = totalFiscal > 0 && totalNaoFiscal > 0;

  // Somente recebimentos efetivamente confirmados — nunca o plano MIDP “pendente”
  const recebimentosNaoFiscalConfirmados = vendaMista
    ? (pagamentoIntegralConfirmado ? (distribuicao.recebimentosNaoFiscal || []) : [])
    : (distribuicao.recebimentosNaoFiscal || []);

  const statusPagamento = determinarStatusPagamento({
    totalFiscal,
    totalNaoFiscal,
    fiscalProcessado: resultadoFiscal.sucesso,
    recebimentosNaoFiscalConfirmados
  });
  const statusComOutrosPendente =
    distribuicao.saldoOutros > 0.009 && statusPagamento === 'quitada'
      ? 'pendente'
      : statusPagamento;

  // Montar recebimentos para gravar
  const recebimentosParaGravar = montarRecebimentosParaGravar({
    distribuicao,
    statusPagamento: statusComOutrosPendente,
    totalFiscal,
    totalNaoFiscal,
    resultadoFiscal
  });
  
  return {
    sucesso: true,
    statusPagamento: statusComOutrosPendente,
    recebimentos: recebimentosParaGravar,
    distribuicao,
    resultadoFiscal,
    pagamentoIntegralConfirmado,
    proximaAcao: determinarProximaAcao(statusComOutrosPendente, totalNaoFiscal)
  };
}

/**
 * Processa o recebimento fiscal (TEF ou Confirmação Manual)
 */
async function processarRecebimentoFiscal({
  recebimentosFiscal,
  totalFiscal,
  tefHabilitado,
  modoConfirmacaoFiscal,
  formaPagamento,
  confirmacaoFiscalManual,
  empresaId
}) {
  // Se não há fiscal, não processa nada
  if (totalFiscal <= 0 || !recebimentosFiscal || recebimentosFiscal.length === 0) {
    return { sucesso: true, tipo: 'sem_fiscal' };
  }

  const recebimentosTef = listarPagamentosQueExigemTef(recebimentosFiscal);
  if (recebimentosTef.length === 0) {
    return await processarConfirmacaoManualFiscal(recebimentosFiscal);
  }

  const comId = recebimentosTef.filter((recebimento) =>
    identificadorTefInformado(recebimento.tef_transacao_id)
  );
  const semId = recebimentosTef.filter((recebimento) =>
    !identificadorTefInformado(recebimento.tef_transacao_id)
  );
  const manualAceita = confirmacaoManualAceita(
    modoConfirmacaoFiscal,
    confirmacaoFiscalManual,
    tefHabilitado
  );

  if (semId.length === 0) {
    return {
      sucesso: true,
      tipo: 'tef',
      transacoes: [...new Set(comId.map((recebimento) => recebimento.tef_transacao_id))],
      recebimentos: recebimentosFiscal
    };
  }

  if (comId.length > 0 && manualAceita) {
    const prova = await comprovarTransacoesTefAprovadas(comId, empresaId);
    if (!prova.sucesso) return prova;
    return await processarConfirmacaoManualFiscal(recebimentosFiscal);
  }

  if (manualAceita) {
    return await processarConfirmacaoManualFiscal(recebimentosFiscal);
  }

  const deveUsarTef = await deveUsarTEFParaFiscal({
    tefHabilitado,
    modoConfirmacaoFiscal,
    formaPagamento,
    totalFiscal
  });

  if (deveUsarTef) {
    return await processarTEFFiscal(recebimentosFiscal, empresaId);
  }

  return { sucesso: false, erro: ERRO_AUTORIZACAO_PAGAMENTO };
}

/**
 * Processa TEF para recebimentos fiscais
 */
async function processarTEFFiscal(recebimentosFiscal, empresaId) {
  const tefConfig = await tefConfigService.obterConfiguracao();
  const tefOn = tefFluxoPagamento.parseTefHabilitado(tefConfig.tefHabilitado);
  
  if (!tefOn) {
    return { sucesso: false, erro: 'TEF desabilitado no sistema.' };
  }
  
  // Filtrar apenas recebimentos que exigem TEF
  const recebimentosTEF = recebimentosFiscal.filter(r => 
    tefFluxoPagamento.formaPagamentoUsaTEF(r.forma_pagamento)
  );
  
  if (recebimentosTEF.length === 0) {
    // Não há TEF, considerar como confirmado manualmente
    return { sucesso: true, tipo: 'manual', recebimentos: recebimentosFiscal };
  }
  
  const transacoesAutorizadas = [];
  
  for (const recebimento of recebimentosTEF) {
    if (recebimento.tef_transacao_id) {
      const prova = await comprovarTransacoesTefAprovadas([recebimento], empresaId);
      if (!prova.sucesso) return prova;
      transacoesAutorizadas.push(prova.transacoes[0]);
      continue;
    }
    
    try {
      const tipoTef = tefFluxoPagamento.normalizarTipoTef(recebimento.forma_pagamento);
      const retornoTEF = await tefManager.autorizar({
        venda_id: null,
        empresa_id: empresaId,
        tipo: tipoTef,
        valor: recebimento.valor,
        parcelas: 1
      });
      
      if (!tefContrato.estaAprovado(retornoTEF)) {
        // Cancelar transações anteriores
        for (const transacaoId of transacoesAutorizadas) {
          try {
            await tefManager.cancelar(transacaoId, 'Pagamento fiscal não aprovado');
          } catch (cancelError) {
            console.error(`Erro ao cancelar transação TEF ${transacaoId}:`, cancelError);
          }
        }
        return { 
          sucesso: false, 
          erro: retornoTEF.mensagem || 'Pagamento TEF não aprovado',
          tef: retornoTEF 
        };
      }
      
      if (retornoTEF.transacao_id) {
        transacoesAutorizadas.push(retornoTEF.transacao_id);
        recebimento.tef_transacao_id = retornoTEF.transacao_id;
        recebimento.nsu = retornoTEF.nsu;
        recebimento.autorizacao = retornoTEF.autorizacao;
      }
    } catch (error) {
      console.error('Erro ao autorizar pagamento TEF fiscal:', error);
      // Cancelar transações anteriores
      for (const transacaoId of transacoesAutorizadas) {
        try {
          await tefManager.cancelar(transacaoId, 'Erro no pagamento fiscal');
        } catch (cancelError) {
          console.error(`Erro ao cancelar transação TEF ${transacaoId}:`, cancelError);
        }
      }
      return { sucesso: false, erro: error.message };
    }
  }
  
  return { 
    sucesso: true, 
    tipo: 'tef', 
    transacoes: transacoesAutorizadas,
    recebimentos: recebimentosFiscal 
  };
}

/**
 * Processa confirmação manual do recebimento fiscal
 */
async function processarConfirmacaoManualFiscal(recebimentosFiscal) {
  // Confirmação manual apenas marca como aprovado
  const recebimentosConfirmados = recebimentosFiscal.map(r => ({
    ...r,
    status: 'aprovado'
  }));
  
  return { 
    sucesso: true, 
    tipo: 'manual', 
    recebimentos: recebimentosConfirmados 
  };
}

/**
 * Determina se deve usar TEF para pagamento fiscal
 */
async function deveUsarTEFParaFiscal({
  tefHabilitado,
  modoConfirmacaoFiscal,
  formaPagamento,
  totalFiscal
}) {
  if (totalFiscal <= 0) return false;
  
  const tefOn = tefFluxoPagamento.parseTefHabilitado(tefHabilitado);
  if (!tefOn) return false;
  
  const modoManual = String(modoConfirmacaoFiscal || 'TEF').toUpperCase() === 'MANUAL';
  if (modoManual) return false;
  
  // Verificar se a forma de pagamento exige TEF
  const formaNormalizada = tefFluxoPagamento.normalizarFormaPagamentoTEF(formaPagamento);
  return tefFluxoPagamento.formaPagamentoUsaTEF(formaNormalizada);
}

/**
 * Determina o status do pagamento.
 * A distribuição matemática NÃO confirma recebimento — apenas recebimentos efetivos.
 */
function determinarStatusPagamento({
  totalFiscal,
  totalNaoFiscal,
  fiscalProcessado,
  recebimentosNaoFiscalConfirmados
}) {
  const temFiscal = totalFiscal > 0;
  const temNaoFiscal = totalNaoFiscal > 0;
  const confirmados = Array.isArray(recebimentosNaoFiscalConfirmados)
    ? recebimentosNaoFiscalConfirmados
    : [];

  const totalConfirmadoNaoFiscal = confirmados.reduce(
    (acc, recebimento) => acc + Number(recebimento.valor || 0),
    0
  );
  const naoFiscalConfirmado =
    confirmados.length > 0
    && Math.abs(totalConfirmadoNaoFiscal - totalNaoFiscal) <= 0.01;

  if (!temFiscal && !temNaoFiscal) {
    return 'quitada';
  }

  // Venda mista: fiscal + não fiscal — 2ª etapa obrigatória
  if (temFiscal && temNaoFiscal) {
    if (!fiscalProcessado) {
      return 'pendente';
    }

    if (naoFiscalConfirmado) {
      return 'quitada';
    }

    return 'aguardando_nao_fiscal';
  }

  // Venda somente não fiscal — pagamento único na criação
  if (!temFiscal && temNaoFiscal) {
    return naoFiscalConfirmado ? 'quitada' : 'pendente';
  }

  // Venda somente fiscal
  if (temFiscal && !temNaoFiscal) {
    return fiscalProcessado ? 'quitada' : 'pendente';
  }

  return 'pendente';
}

/**
 * Pagamento cobre F+NF e MIDP não deixou saldo pendente.
 */
function isPagamentoIntegralConfirmado({
  totalPagamentos,
  totalLiquidoEsperado,
  saldoFiscal,
  saldoNaoFiscal,
  saldoOutros = 0
}) {
  const pagos = Math.round((Number(totalPagamentos || 0) + Number.EPSILON) * 100) / 100;
  const esperado = Math.round((Number(totalLiquidoEsperado || 0) + Number.EPSILON) * 100) / 100;
  return (
    Math.abs(pagos - esperado) <= 0.01
    && Number(saldoFiscal || 0) <= 0.009
    && Number(saldoNaoFiscal || 0) <= 0.009
    && Number(saldoOutros || 0) <= 0.009
  );
}

/**
 * Monta os recebimentos para gravar no banco.
 *
 * - aguardando_nao_fiscal (2ª etapa legítima): grava somente fiscais.
 * - quitada / demais: grava fiscais + não fiscais da distribuição MIDP.
 */
function montarRecebimentosParaGravar({
  distribuicao,
  statusPagamento,
  totalFiscal,
  totalNaoFiscal,
  resultadoFiscal
}) {
  const { recebimentosFiscal, recebimentosNaoFiscal, recebimentosOutros } = distribuicao;
  const fiscais = (Array.isArray(recebimentosFiscal) ? recebimentosFiscal : []).map((recebimento) => ({
    ...recebimento,
    tipo_recebimento: 'fiscal',
    status: 'aprovado'
  }));

  if (statusPagamento === 'aguardando_nao_fiscal') {
    const outros = (Array.isArray(recebimentosOutros) ? recebimentosOutros : []).map((recebimento) => ({
      ...recebimento,
      tipo_recebimento: 'outros',
      status: 'aprovado'
    }));
    return [...fiscais, ...outros];
  }

  const naoFiscais = (Array.isArray(recebimentosNaoFiscal) ? recebimentosNaoFiscal : []).map((recebimento) => ({
    ...recebimento,
    tipo_recebimento: 'nao_fiscal',
    status: 'aprovado'
  }));

  const outros = (Array.isArray(recebimentosOutros) ? recebimentosOutros : []).map((recebimento) => ({
    ...recebimento,
    tipo_recebimento: 'outros',
    status: 'aprovado'
  }));

  return [...fiscais, ...naoFiscais, ...outros];
}

/**
 * Determina a próxima ação a ser executada
 */
function determinarProximaAcao(statusPagamento, totalNaoFiscal) {
  if (statusPagamento === 'aguardando_nao_fiscal') {
    return 'registrar_pagamento_nao_fiscal';
  }
  
  if (statusPagamento === 'quitada' && totalNaoFiscal > 0) {
    return 'emitir_nfce';
  }
  
  if (statusPagamento === 'quitada') {
    return 'concluida';
  }
  
  return 'aguardando';
}

/**
 * Normaliza os pagamentos de entrada.
 * HOTFIX FISCAL-4.0.2: fallback usa o total líquido F+NF (nunca 0).
 */
function normalizarPagamentosEntrada(pagamentos, formaPagamentoPadrao, totalLiquidoEsperado = 0) {
  if (!Array.isArray(pagamentos) || pagamentos.length === 0) {
    return [{
      forma_pagamento: formaPagamentoPadrao || 'dinheiro',
      valor: Number(totalLiquidoEsperado || 0)
    }];
  }
  
  return pagamentos.map(p => ({
    forma_pagamento: p.forma_pagamento || formaPagamentoPadrao || 'dinheiro',
    valor: Number(p.valor || 0),
    tef_transacao_id: p.tef_transacao_id || null,
    nsu: p.nsu || null,
    autorizacao: p.autorizacao || null
  }));
}

/**
 * Log temporário de auditoria desconto × pagamento (só com CDS_DEBUG_DESCONTO_FISCAL=1).
 */
function logDebugDescontoFiscal(payload = {}) {
  const ativoEnv = process.env.CDS_DEBUG_DESCONTO_FISCAL === '1';
  if (!ativoEnv && !payload.ativo) return;
  const {
    ativo,
    ...resto
  } = payload;
  console.log('[DEBUG_DESCONTO_FISCAL]', JSON.stringify({
    subtotal: resto.subtotal != null ? Number(resto.subtotal) : null,
    desconto: resto.desconto != null ? Number(resto.desconto) : null,
    acrescimo: resto.acrescimo != null ? Number(resto.acrescimo) : null,
    total: resto.total != null ? Number(resto.total) : null,
    valorFiscal: resto.valorFiscal != null ? Number(resto.valorFiscal) : null,
    valorNaoFiscal: resto.valorNaoFiscal != null ? Number(resto.valorNaoFiscal) : null,
    pagamentoFiscal: resto.pagamentoFiscal != null ? Number(resto.pagamentoFiscal) : null,
    pagamentoNaoFiscal: resto.pagamentoNaoFiscal != null ? Number(resto.pagamentoNaoFiscal) : null,
    valorEsperado: resto.valorEsperado != null ? Number(resto.valorEsperado) : null,
    valorRecebido: resto.valorRecebido != null ? Number(resto.valorRecebido) : null,
    saldoFiscal: resto.saldoFiscal != null ? Number(resto.saldoFiscal) : null,
    saldoNaoFiscal: resto.saldoNaoFiscal != null ? Number(resto.saldoNaoFiscal) : null,
    motivoRejeicao: resto.motivoRejeicao || null
  }));
}

/**
 * Processa o pagamento não fiscal (segunda etapa do fluxo)
 */
async function processarPagamentoNaoFiscal({
  vendaId,
  valorNaoFiscal,
  pagamentosInformados
}) {
  const totalInformado = pagamentosInformados.reduce(
    (acc, p) => acc + Number(p.valor || 0),
    0
  );
  
  if (Math.abs(totalInformado - valorNaoFiscal) > 0.01) {
    return {
      sucesso: false,
      erro: 'Valor informado não confere com o saldo não fiscal pendente.',
      saldo_pendente: valorNaoFiscal
    };
  }
  
  const recebimentos = pagamentosInformados.map(pagamento => ({
    tipo_recebimento: 'nao_fiscal',
    forma_pagamento: String(pagamento.forma_pagamento).toLowerCase().trim(),
    valor: Number(pagamento.valor || 0),
    tef_transacao_id: null,
    nsu: pagamento.nsu || null,
    autorizacao: pagamento.autorizacao || null,
    status: 'aprovado'
  }));
  
  return {
    sucesso: true,
    recebimentos,
    statusPagamento: 'quitada'
  };
}

module.exports = {
  processarFluxoPagamentoVenda,
  processarPagamentoNaoFiscal,
  determinarStatusPagamento,
  montarRecebimentosParaGravar,
  isPagamentoIntegralConfirmado,
  distribuirRecebimentosOutros,
  validarCoberturaOutrosTef,
  normalizarPagamentosEntrada,
  logDebugDescontoFiscal
};
