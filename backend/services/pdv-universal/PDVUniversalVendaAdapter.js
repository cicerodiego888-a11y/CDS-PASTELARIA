/**
 * Adapter carrinho PDV Universal → contrato oficial de venda (EMPRESA_UNICA).
 * Sem inventar preço, desconto, empresa ou quantidades fiscais.
 */
'use strict';

function erroCheckout(code, message, statusCode = 400, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  Object.assign(err, extra);
  return err;
}

function arred2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function validarCarrinhoEmpresaUnica(itens, empresaOperacionalId) {
  if (!Number.isInteger(Number(empresaOperacionalId)) || Number(empresaOperacionalId) <= 0) {
    throw erroCheckout(
      'EMPRESA_OPERACIONAL_NAO_SELECIONADA',
      'Selecione a empresa operacional antes do checkout.'
    );
  }
  if (!Array.isArray(itens) || itens.length === 0) {
    throw erroCheckout('CARRINHO_VAZIO', 'Carrinho vazio.');
  }

  const empresas = new Set();
  for (const item of itens) {
    const empresaId = Number(item.empresa_id != null ? item.empresa_id : item.empresaId);
    if (!Number.isInteger(empresaId) || empresaId <= 0) {
      throw erroCheckout('EMPRESA_OBRIGATORIA', 'Todo item do checkout exige empresa_id.');
    }
    if (empresaId !== Number(empresaOperacionalId)) {
      throw erroCheckout(
        'CARRINHO_EMPRESA_INCONSISTENTE',
        'A empresa do item diverge da empresa operacional.'
      );
    }
    empresas.add(empresaId);
    const produtoId = Number(item.produto_id != null ? item.produto_id : item.produtoId);
    if (!Number.isInteger(produtoId) || produtoId <= 0) {
      throw erroCheckout('PRODUTO_OBRIGATORIO', 'produto_id é obrigatório.');
    }
    const qtd = Number(item.quantidade);
    if (!(qtd > 0)) {
      throw erroCheckout('QUANTIDADE_INVALIDA', 'Quantidade deve ser maior que zero.');
    }
  }
  if (empresas.size > 1) {
    throw erroCheckout(
      'CARRINHO_EMPRESA_INCONSISTENTE',
      'Checkout EMPRESA_UNICA exige uma única empresa no carrinho.'
    );
  }
  return Number(empresaOperacionalId);
}

function montarItensOficiais(itens) {
  return itens.map((item) => {
    const quantidade = Number(item.quantidade);
    const preco = item.preco_unitario != null
      ? Number(item.preco_unitario)
      : Number(item.valor_unitario);
    const subtotal = item.subtotal != null ? Number(item.subtotal) : arred2(quantidade * preco);
    return {
      produto_id: Number(item.produto_id != null ? item.produto_id : item.produtoId),
      quantidade,
      preco_unitario: preco,
      subtotal,
      tipo_venda: item.tipo_venda || 'UNIDADE',
      item_fiscal: Number(item.item_fiscal || 0)
    };
  });
}

function montarPagamentosOficiais(pagamentos, total) {
  if (Array.isArray(pagamentos) && pagamentos.length > 0) {
    return pagamentos.map((p) => ({
      forma_pagamento: String(p.forma_pagamento || p.forma || 'dinheiro').toLowerCase(),
      valor: arred2(p.valor != null ? p.valor : total)
    }));
  }
  return [{ forma_pagamento: 'dinheiro', valor: arred2(total) }];
}

function montarPayloadVendaOficial({ itens, pagamentos, emitir_fiscal, origem, desconto, acrescimo }) {
  const oficiais = montarItensOficiais(itens);
  const subtotal = arred2(oficiais.reduce((acc, i) => acc + Number(i.subtotal || 0), 0));
  let desc = Number(desconto);
  if (!Number.isFinite(desc) || desc < 0) desc = 0;
  desc = arred2(Math.min(subtotal, desc));
  let acr = Number(acrescimo);
  if (!Number.isFinite(acr) || acr < 0) acr = 0;
  acr = arred2(acr);
  const total = arred2(Math.max(0, subtotal - desc + acr));
  const pags = montarPagamentosOficiais(pagamentos, total);
  return {
    origem: origem || 'PDV',
    tipo_venda: 'BALCAO',
    forma_pagamento: pags.length > 1 ? 'misto' : pags[0].forma_pagamento,
    pagamentos: pags,
    total,
    desconto: desc,
    acrescimo: acr,
    emitir_fiscal: emitir_fiscal === true,
    itens: oficiais
  };
}

function normalizarRespostaNucleo(body) {
  const vendaId = body && (body.venda_id || body.id || body.vendaId || (body.venda && body.venda.id));
  return {
    sucesso: body && body.sucesso !== false,
    modo: 'EMPRESA_UNICA',
    checkout_concluido: true,
    venda_id: vendaId != null ? Number(vendaId) : null,
    atendimento_id: null,
    pagamento: {
      status: (body && (body.status_pagamento || (body.pagamento && body.pagamento.status))) || 'CONFIRMADO'
    },
    fiscal: body && body.fiscal ? body.fiscal : { status: body && body.emitir_fiscal ? 'PENDENTE' : 'NAO_APLICAVEL' },
    proximas_acoes: {
      mostrar_comprovante: false,
      mostrar_danfe: !!(body && (body.emitir_fiscal || (body.fiscal && body.fiscal.status)))
    },
    nucleo: body || null
  };
}

module.exports = {
  validarCarrinhoEmpresaUnica,
  montarPayloadVendaOficial,
  montarItensOficiais,
  montarPagamentosOficiais,
  normalizarRespostaNucleo,
  erroCheckout
};
