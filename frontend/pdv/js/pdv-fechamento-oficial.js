/**
 * Fechamento do PDV pelo mesmo contrato de executarFinalizacaoVenda
 * no ramo lista_sequencial. Não calcula preço, estoque, F×NF nem recomposição.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PdvFechamentoOficial = api;
}(typeof window !== 'undefined' ? window : globalThis, function () {
  function centavos(valor) {
    const numero = Number(valor);
    if (!Number.isFinite(numero)) return null;
    return Math.round(numero * 100);
  }

  function arredondar(valor) {
    return Math.round((Number(valor) + Number.EPSILON) * 100) / 100;
  }

  function conferirSnapshot(handoff) {
    if (!handoff || typeof handoff !== 'object') {
      return { ok: false, mensagem: 'Preparação do pedido ausente.' };
    }
    if (handoff.venda_concluida) {
      return {
        ok: false,
        codigo: 'VENDA_JA_CONCLUIDA',
        vendaId: handoff.venda_id || null,
        mensagem: 'Este pedido já possui a venda ' + (handoff.venda_id || '') + ' concluída.'
      };
    }
    if (Number(handoff.venda_id) > 0) {
      return {
        ok: false,
        codigo: 'VENDA_JA_VINCULADA',
        vendaId: Number(handoff.venda_id),
        mensagem: 'A venda ' + handoff.venda_id + ' já foi registrada para este pedido. Nenhum outro fechamento foi iniciado.'
      };
    }
    if (!Number.isInteger(Number(handoff.pedido_id)) || Number(handoff.pedido_id) <= 0
      || !Number.isInteger(Number(handoff.operacao_id)) || Number(handoff.operacao_id) <= 0
      || !Array.isArray(handoff.itens) || !handoff.itens.length) {
      return { ok: false, mensagem: 'Preparação do pedido incompleta. Nenhum item foi carregado.' };
    }
    const desconto = centavos(handoff.desconto || 0);
    const total = centavos(handoff.total);
    const bruto = handoff.itens.reduce((soma, item) => soma + centavos(item.subtotal), 0);
    if (desconto == null || desconto < 0 || total == null || total < 0 || !Number.isSafeInteger(bruto)
      || desconto > bruto || bruto - desconto !== total) {
      return { ok: false, mensagem: 'Totais da preparação do pedido inválidos. Nenhum item foi carregado.' };
    }
    return { ok: true };
  }

  function empresaCompativel(handoff, empresaId, modelo) {
    const pedidoEmpresa = Number(handoff && handoff.empresa_id);
    const contexto = Number(empresaId);
    if (!(pedidoEmpresa > 0) || pedidoEmpresa !== contexto) {
      return {
        ok: false,
        codigo: 'EMPRESA_DIVERGENTE',
        mensagem: 'A composição não pertence à empresa selecionada. A venda não foi iniciada.'
      };
    }
    if (modelo && String(modelo.pdv_modelo_empresa || '').toUpperCase() === 'UNICA'
      && Number(modelo.pdv_empresa_id) !== pedidoEmpresa) {
      return {
        ok: false,
        codigo: 'EMPRESA_PDV_UNICA_DIVERGENTE',
        mensagem: 'O PDV está fixo em outra empresa. A venda deste pedido não foi iniciada.'
      };
    }
    return { ok: true };
  }

  function itensParaApi(itens) {
    return (itens || []).map((item) => ({
      produto_id: Number(item.produto_id),
      quantidade: Number(item.quantidade),
      preco_unitario: Number(item.preco_unitario),
      desconto_percentual: Number(item.desconto_percentual || 0),
      desconto_valor: Number(item.desconto_valor || 0),
      desconto_manual: Number(item.desconto_manual || 0) === 1 ? 1 : 0,
      promocao_id: item.promocao_id || null,
      desconto_atacado: Number(item.desconto_atacado || 0),
      tipo_preco: item.tipo_preco || 'varejo',
      subtotal: Number(item.subtotal),
      item_fiscal: Number(item.item_fiscal || 0),
      tipo_venda: item.tipo_venda || 'PESO'
    }));
  }

  function itensParaComposicao(itens) {
    return (itens || []).map((item) => ({
      produto_id: Number(item.produto_id),
      nome: item.nome || item.produto_nome || '',
      quantidade: Number(item.quantidade),
      preco_unitario: Number(item.preco_unitario),
      subtotal: Number(item.subtotal),
      categoria_nome: item.categoria_nome || item.categoria || null,
      ncm: item.ncm || null,
      unidade: item.unidade || 'UN'
    }));
  }

  function novaChave(anterior) {
    if (anterior) return anterior;
    return 'pdv-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  }

  function montarCorpo(entrada) {
    const fluxo = entrada.fluxo;
    if (!fluxo || typeof fluxo.montarParcelasListaSequencial !== 'function') {
      return { ok: false, mensagem: 'O fluxo oficial de pagamento não está disponível.' };
    }
    const parcelas = Array.isArray(entrada.parcelas) ? entrada.parcelas : [];
    const total = arredondar(entrada.total);
    const soma = arredondar(parcelas.reduce((acc, parcela) => acc + Number(parcela.valor || 0), 0));
    if (!(total > 0)) {
      return { ok: false, codigo: 'TOTAL_INVALIDO', mensagem: 'O total da venda é inválido.' };
    }
    if (Math.abs(soma - total) > 0.009) {
      return {
        ok: false,
        codigo: 'SALDO_PENDENTE',
        mensagem: 'Ainda há saldo. A venda não foi finalizada.'
      };
    }
    const resolvido = fluxo.resolverFluxoPagamentoFiscal({
      modoConfirmacaoFiscal: entrada.modoConfirmacaoFiscal || 'TEF',
      tefHabilitado: entrada.tefHabilitado === true,
      formaPagamento: 'misto',
      ehPagamentoMisto: true,
      pagamentosMistos: parcelas,
      totalFiscal: Number(entrada.valorFiscal || 0)
    });
    const ramo = fluxo.ramoFechamentoPagamento({
      ...resolvido,
      totalFiscal: Number(entrada.valorFiscal || 0),
      ehPagamentoMisto: true
    });
    if (ramo !== 'lista_sequencial') {
      return {
        ok: false,
        codigo: 'RAMO_NAO_SEQUENCIAL',
        mensagem: 'O fechamento saiu do pagamento sequencial oficial. A venda não foi enviada.'
      };
    }
    const confirmacao = fluxo.listaSequencialJaConfirmada(parcelas);
    if (!confirmacao.dispensaModalExtra) {
      const textos = {
        PARCELA_ELETRONICA_SEM_AUTORIZACAO: 'Há parcela eletrônica sem autorização. A venda não foi finalizada.',
        PARCELA_NAO_CONFIRMADA: 'Há parcela pendente, recusada ou com falha. A venda não foi finalizada.',
        PARCELA_INVALIDA: 'Há parcela inválida. A venda não foi finalizada.',
        LISTA_VAZIA: 'Não há parcelas confirmadas. A venda não foi finalizada.'
      };
      return {
        ok: false,
        codigo: confirmacao.codigo || 'PAGAMENTO_INCOMPLETO',
        mensagem: textos[confirmacao.codigo] || 'O pagamento não está integralmente confirmado.'
      };
    }
    if (entrada.handoff) {
      const conferencia = conferirSnapshot(entrada.handoff);
      if (!conferencia.ok) return conferencia;
      if (centavos(entrada.handoff.total) !== centavos(total)) {
        return {
          ok: false,
          codigo: 'TOTAL_DIVERGENTE',
          mensagem: 'O total do carrinho diverge do total aprovado para o pedido. A venda foi bloqueada.'
        };
      }
    }
    const pagamentos = fluxo.montarParcelasListaSequencial(parcelas);
    const corpo = {
      chave_fechamento_pdv: novaChave(entrada.chave),
      cliente_id: entrada.clienteId || null,
      forma_pagamento: 'misto',
      desconto: arredondar(entrada.desconto || 0),
      acrescimo: 0,
      total,
      pagamento_sequencial: true,
      emitir_fiscal: false,
      cpf_cnpj_nota: null,
      pagamentos,
      itens: itensParaApi(entrada.itens),
      valor_fiscal: Number(entrada.valorFiscal || 0),
      valor_nao_fiscal: Number(entrada.valorNaoFiscal || 0),
      confirmacao_fiscal_manual: pagamentos.some((pagamento) => pagamento.confirmacao_manual === 1)
    };
    if (Number(corpo.valor_fiscal) > 0 && Number(corpo.valor_nao_fiscal) <= 0) {
      corpo.pagamentos_processados_pdv = true;
    }
    if (entrada.handoff) {
      corpo.origem = 'PDV';
      corpo.pedido_id = Number(entrada.handoff.pedido_id);
      corpo.pedido_faturamento_operacao_id = Number(entrada.handoff.operacao_id);
      corpo.cliente_id = entrada.handoff.cliente_id || corpo.cliente_id;
    } else {
      corpo.origem = 'PDV';
    }
    return { ok: true, corpo, ramo };
  }

  return {
    centavos,
    conferirSnapshot,
    empresaCompativel,
    itensParaApi,
    itensParaComposicao,
    novaChave,
    montarCorpo
  };
}));
