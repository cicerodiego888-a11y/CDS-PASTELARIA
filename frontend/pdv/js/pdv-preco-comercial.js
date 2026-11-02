/**
 * Formação de preço da venda avulsa.
 * A faixa de atacado continua escolhida em obterPrecoAtacado (pdv.js).
 * O cálculo da faixa e da linha usa MotorPrecoAtacado, o mesmo do PDV Desktop.
 */
(function (root, factory) {
  const api = factory(root.MotorPrecoAtacado);
  root.PdvPrecoComercial = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function (MotorPrecoAtacado) {
  'use strict';

  function motor() {
    if (!MotorPrecoAtacado || typeof MotorPrecoAtacado.calcularLinhaAtacadoFaixa !== 'function') {
      throw new Error('MotorPrecoAtacado indisponível');
    }
    return MotorPrecoAtacado;
  }

  function escolherFaixa(faixas, quantidade) {
    let escolhida = null;
    (faixas || []).forEach((faixa) => {
      const minima = Number(faixa.quantidade_minima || 0);
      if (quantidade >= minima && (!escolhida || minima > Number(escolhida.quantidade_minima || 0))) {
        escolhida = faixa;
      }
    });
    return escolhida;
  }

  function aplicarFaixaEscolhida(entrada) {
    const preco = motor();
    const produto = entrada.produto || {};
    const quantidade = Number(entrada.quantidade);
    const precoBase = Number(entrada.precoBase);
    const precoAtacado = Number(entrada.precoAtacado || 0);
    if (!(precoAtacado > 0)) {
      return { preco: precoBase, descontoAtacado: 0, isAtacado: false };
    }
    const calc = preco.calcularLinhaAtacadoFaixa({
      precoVenda: Number(produto.preco_venda || precoBase),
      precoAtacado,
      quantidade
    });
    const precoAplicado = Math.min(precoBase, calc.precoUnitarioInterno);
    const linha = preco.calcularLinhaPrecoUnitarioInformado({
      precoOriginal: Number(produto.preco_venda || precoBase),
      quantidade,
      precoUnitarioInformado: precoAplicado
    });
    return {
      preco: precoAplicado,
      descontoAtacado: calc.descontoAtacado,
      isAtacado: precoAplicado < precoBase,
      subtotal: linha.total
    };
  }

  function aplicarAtacado(entrada) {
    const escolhida = escolherFaixa(entrada.faixas, Number(entrada.quantidade));
    if (!escolhida) {
      return { preco: Number(entrada.precoBase), descontoAtacado: 0, isAtacado: false };
    }
    return aplicarFaixaEscolhida({
      produto: entrada.produto,
      quantidade: entrada.quantidade,
      precoBase: entrada.precoBase,
      precoAtacado: Number(escolhida.preco_atacado || 0)
    });
  }

  /**
   * Linha nova do carrinho, no mesmo caminho do Desktop:
   * preço de venda, depois promoção, depois atacado se for mais baixo.
   * Não cobre etiqueta de balança nem venda por unidade convertida.
   */
  function montarLinha(entrada) {
    const preco = motor();
    const produto = entrada.produto || {};
    const quantidade = Number(Number(entrada.quantidade || 0).toFixed(2));
    const precoInformado = Number(entrada.precoInformado || produto.preco_venda || 0);
    const promocao = entrada.promocao && entrada.promocao.id ? entrada.promocao : null;
    const precoPromocional = promocao
      ? Number(promocao.preco_promocional || precoInformado)
      : precoInformado;
    let precoFinal = precoPromocional;
    let descontoAtacado = 0;
    let tipoPreco = 'varejo';
    if (Number(produto.venda_atacado || 0) === 1) {
      const atacado = aplicarAtacado({
        produto,
        quantidade,
        precoBase: precoFinal,
        faixas: entrada.faixas || []
      });
      precoFinal = atacado.preco;
      descontoAtacado = atacado.descontoAtacado;
      if (atacado.isAtacado) tipoPreco = 'atacado';
    }
    const precoBase = Number(produto.preco_venda || precoFinal);
    const calc = preco.calcularLinhaPrecoUnitarioInformado({
      precoOriginal: precoBase,
      quantidade,
      precoUnitarioInformado: precoFinal
    });
    return {
      produto_id: Number(produto.id),
      nome: String(produto.nome_comercial || produto.nome || '').trim(),
      quantidade,
      preco_unitario: calc.precoUnitarioInterno,
      preco_base: precoBase,
      preco_origem: precoPromocional,
      desconto_percentual: calc.percentualDesconto,
      desconto_valor: Number(preco.arredondarMoeda(calc.valorDesconto || 0)),
      desconto_atacado: descontoAtacado,
      promocao_id: promocao ? promocao.id : null,
      tipo_preco: tipoPreco,
      subtotal: calc.totalInterno,
      subtotal_exibicao: calc.total,
      tipo_venda: 'PESO',
      item_fiscal: Number(produto.item_fiscal || 0)
    };
  }

  return { escolherFaixa, aplicarFaixaEscolhida, aplicarAtacado, montarLinha };
});
