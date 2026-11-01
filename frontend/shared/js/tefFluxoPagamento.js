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
    return normalizada === 'dinheiro'
      || normalizada === 'debito'
      || normalizada === 'credito'
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

  function parcelaSequencialJaConfirmada(parcela) {
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
      if (!id || !aprovada) {
        return { ok: false, codigo: 'PARCELA_ELETRONICA_SEM_AUTORIZACAO' };
      }
      return { ok: true };
    }
    if (status === 'informada' || status === 'aprovada' || status === 'aprovado' || status === '') {
      return { ok: true };
    }
    return { ok: false, codigo: 'PARCELA_NAO_CONFIRMADA', status };
  }

  function listaSequencialJaConfirmada(parcelas) {
    const lista = Array.isArray(parcelas) ? parcelas : [];
    if (!lista.length) return { dispensaModalExtra: false, codigo: 'LISTA_VAZIA' };
    for (const parcela of lista) {
      const estado = parcelaSequencialJaConfirmada(parcela);
      if (!estado.ok) {
        return {
          dispensaModalExtra: false,
          codigo: estado.codigo,
          status: estado.status || null
        };
      }
    }
    return { dispensaModalExtra: true, codigo: null };
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
    resolverFluxoPagamentoFiscal,
    ramoFechamentoPagamento
  };

  root.TefFluxoPagamento = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
