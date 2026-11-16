/**
 * Regras de fluxo TEF no PDV (espelho de backend/services/tef/tefFluxoPagamento.js).
 */
(function (root) {
  function normalizarFormaPagamentoTEF(forma) {
    return String(forma || '')
      .toLowerCase()
      .trim()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  const FORMAS_TEF = new Set([
    'cartao',
    'cartao_credito',
    'cartao_debito',
    'credito',
    'debito',
    'pix',
    'pix_tef',
    'tef'
  ]);

  function formaPagamentoUsaTEF(forma) {
    return FORMAS_TEF.has(normalizarFormaPagamentoTEF(forma));
  }

  function normalizarTipoTef(tipo) {
    const forma = normalizarFormaPagamentoTEF(tipo);
    if (forma === 'pix') {
      return 'pix_tef';
    }
    return forma;
  }

  function formaPagamentoGravacaoFiscal(forma) {
    const normalizada = normalizarFormaPagamentoTEF(forma);
    if (normalizada === 'pix_tef') {
      return 'pix';
    }
    return normalizada;
  }

  function ehPagamentoPixTef(tipo) {
    return normalizarTipoTef(tipo) === 'pix_tef';
  }

  function parseTefHabilitado(valor) {
    return valor === true || valor === 'true' || valor === '1' || valor === 1;
  }

  function pagamentoMistoExigeTef(pagamentos) {
    return (pagamentos || []).some((pagamento) =>
      formaPagamentoUsaTEF(pagamento?.forma_pagamento)
    );
  }

  function formaAceitaConfirmacaoManual(forma, ehPagamentoMisto) {
    if (ehPagamentoMisto) return true;
    const normalizada = normalizarFormaPagamentoTEF(forma);
    // Com TEF desligado, dinheiro e eletrônico usam confirmação operacional no fechamento.
    return normalizada === 'dinheiro'
      || normalizada === 'especie'
      || normalizada === 'cash'
      || formaPagamentoUsaTEF(normalizada);
  }

  function consumirCliqueConfirmacao(estado) {
    if (!estado || estado.consumido === true) {
      return { aceito: false, estado: estado || { consumido: true } };
    }
    return { aceito: true, estado: { consumido: true } };
  }

  function resolverFluxoPagamentoFiscal({
    modoConfirmacaoFiscal,
    tefHabilitado,
    formaPagamento,
    ehPagamentoMisto,
    pagamentosMistos,
    totalFiscal
  }) {
    const formaNormalizada = normalizarFormaPagamentoTEF(formaPagamento);
    const pagamentoExigeTef = ehPagamentoMisto
      ? pagamentoMistoExigeTef(pagamentosMistos)
      : formaPagamentoUsaTEF(formaNormalizada);
    const tefOn = parseTefHabilitado(tefHabilitado);
    const deveUsarTefAutomatico = tefOn && pagamentoExigeTef;
    const modoManual = String(modoConfirmacaoFiscal || 'TEF').toUpperCase() === 'MANUAL';
    const manualPorModo = modoManual
      && Number(totalFiscal) > 0
      && !deveUsarTefAutomatico;
    const manualPorTefDesligado = !tefOn
      && formaAceitaConfirmacaoManual(formaNormalizada, ehPagamentoMisto);
    const usarConfirmacaoManual = manualPorModo || manualPorTefDesligado;
    const quantidadeParcelas = (pagamentosMistos || []).filter((pagamento) =>
      Number(pagamento && pagamento.valor) > 0
    ).length;
    const preservarListaSequencial = Boolean(ehPagamentoMisto) && quantidadeParcelas >= 1;

    return {
      formaNormalizada,
      pagamentoExigeTef,
      deveUsarTefAutomatico,
      usarConfirmacaoManual,
      preservarListaSequencial
    };
  }

  const STATUS_NAO_RECEBIDO = new Set([
    'pendente',
    'rejeitada',
    'rejeitado',
    'falha',
    'negado',
    'negada',
    'timeout',
    'erro'
  ]);

  function parcelaSequencialJaConfirmada(parcela, opcoes = {}) {
    if (!parcela || !(Number(parcela.valor) > 0)) {
      return { ok: false, codigo: 'PARCELA_INVALIDA' };
    }
    const status = String(parcela.status_autorizacao || parcela.status || '').toLowerCase();
    if (STATUS_NAO_RECEBIDO.has(status)) {
      return { ok: false, codigo: 'PARCELA_NAO_CONFIRMADA', status: status || 'nao_confirmada' };
    }
    const forma = normalizarFormaPagamentoTEF(parcela.forma_pagamento);
    if (formaPagamentoUsaTEF(forma)) {
      const id = parcela.tef_transacao_id || (parcela.tef && parcela.tef.transacao_id);
      const aprovada = (status === 'aprovada' || status === 'aprovado' || parcela.aprovado === true)
        && parcela.aprovado !== false;
      if (id && aprovada) {
        return { ok: true };
      }
      const ehPix = forma === 'pix' || forma === 'pix_tef';
      const pixConfirmado = ehPix && (
        parcela.pix_confirmado === true
        || parcela.confirmacao_efetiva === true
      ) && String(parcela.pix_txid || '').trim() !== '';
      if (pixConfirmado && (aprovada || status === 'informada' || status === 'confirmada' || status === '')) {
        return { ok: true };
      }
      // TEF desligado: eletrônico informado segue para confirmação operacional no fechamento.
      if (opcoes.tefHabilitado === false && (status === 'informada' || status === '')) {
        return { ok: true, requerConfirmacaoManual: true };
      }
      if (ehPix) {
        return { ok: false, codigo: 'PIX_SEM_CONFIRMACAO' };
      }
      return { ok: false, codigo: 'PARCELA_ELETRONICA_SEM_AUTORIZACAO' };
    }
    if (status === 'informada' || status === 'aprovada' || status === 'aprovado' || status === '') {
      return { ok: true };
    }
    return { ok: false, codigo: 'PARCELA_NAO_CONFIRMADA', status };
  }

  function listaSequencialJaConfirmada(parcelas, opcoes = {}) {
    const lista = Array.isArray(parcelas) ? parcelas : [];
    if (!lista.length) return { dispensaModalExtra: false, codigo: 'LISTA_VAZIA' };
    let requerConfirmacaoManual = false;
    for (const parcela of lista) {
      const estado = parcelaSequencialJaConfirmada(parcela, opcoes);
      if (!estado.ok) {
        return {
          dispensaModalExtra: false,
          requerConfirmacaoManual: false,
          codigo: estado.codigo,
          status: estado.status || null
        };
      }
      if (estado.requerConfirmacaoManual) requerConfirmacaoManual = true;
    }
    return {
      dispensaModalExtra: !requerConfirmacaoManual,
      requerConfirmacaoManual,
      codigo: null
    };
  }

  function montarParcelasListaSequencial(parcelas, opcoes = {}) {
    const carimbarManual = opcoes.carimbarConfirmacaoManual === true;
    return (parcelas || []).map((pagamento) => {
      if (pagamento && pagamento.tef_transacao_id) {
        return {
          ...pagamento,
          confirmacao_modalidade: 'tef',
          confirmacao_manual: 0,
          tipo_recebimento: 'fiscal',
          recebimento_confirmado: true
        };
      }
      const forma = normalizarFormaPagamentoTEF(pagamento && pagamento.forma_pagamento);
      const eletronica = formaPagamentoUsaTEF(forma);
      const ehPix = forma === 'pix' || forma === 'pix_tef';
      const pixConfirmado = ehPix && (
        pagamento.pix_confirmado === true || pagamento.confirmacao_efetiva === true
      ) && String(pagamento.pix_txid || '').trim() !== '';
      const copia = { ...(pagamento || {}) };
      delete copia.nsu;
      delete copia.autorizacao;
      delete copia.bandeira;
      delete copia.adquirente;
      delete copia.tef_transacao_id;
      delete copia.tef;
      if (pixConfirmado) {
        return {
          ...copia,
          tipo_recebimento: 'fiscal',
          confirmacao_manual: 0,
          confirmacao_modalidade: 'pix',
          recebimento_confirmado: true,
          pix_txid: pagamento.pix_txid,
          pix_confirmado: true
        };
      }
      if (eletronica && !carimbarManual) {
        return {
          ...copia,
          tipo_recebimento: 'fiscal',
          confirmacao_manual: 0,
          confirmacao_modalidade: null,
          recebimento_confirmado: false
        };
      }
      return {
        ...copia,
        tipo_recebimento: eletronica ? 'fiscal' : 'nao_fiscal',
        confirmacao_manual: carimbarManual || !eletronica ? 1 : 0,
        confirmacao_modalidade: carimbarManual || !eletronica ? 'manual' : null,
        recebimento_confirmado: carimbarManual || !eletronica,
        confirmacao_operacional_externa: eletronica && carimbarManual ? true : undefined
      };
    });
  }

  function ramoFechamentoPagamento({
    preservarListaSequencial,
    deveUsarTefAutomatico,
    totalFiscal,
    ehPagamentoMisto,
    usarConfirmacaoManual
  }) {
    if (preservarListaSequencial) return 'lista_sequencial';
    if (deveUsarTefAutomatico && Number(totalFiscal) > 0) return 'pagamento_unico_fiscal';
    if (deveUsarTefAutomatico && ehPagamentoMisto) return 'tef_misto';
    if (deveUsarTefAutomatico) return 'tef_simples';
    if (usarConfirmacaoManual) return 'manual';
    return 'sem_ramo';
  }

  const api = {
    normalizarFormaPagamentoTEF,
    formaPagamentoUsaTEF,
    normalizarTipoTef,
    formaPagamentoGravacaoFiscal,
    ehPagamentoPixTef,
    parseTefHabilitado,
    pagamentoMistoExigeTef,
    formaAceitaConfirmacaoManual,
    consumirCliqueConfirmacao,
    parcelaSequencialJaConfirmada,
    listaSequencialJaConfirmada,
    montarParcelasListaSequencial,
    resolverFluxoPagamentoFiscal,
    ramoFechamentoPagamento
  };

  root.TefFluxoPagamento = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
