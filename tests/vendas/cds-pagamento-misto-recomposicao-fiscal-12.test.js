/**
 * CDS — PAGAMENTO MISTO E RECOMPOSIÇÃO FISCAL — 12
 * Regra de tolerância em dinheiro incorporada ao motor existente (buscarComposicao).
 *
 * Executar: node --test tests/vendas/cds-pagamento-misto-recomposicao-fiscal-12.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const Composicao = require('../../backend/services/vendas/ComposicaoFiscalPedidoService');
const { calcularMargemToleranciaDinheiro } = require(
  '../../backend/services/vendas/RecomposicaoFiscalToleranciaDinheiroSimulacaoService'
);
const {
  avaliarCandidatoComBuscarComposicao
} = require('../../backend/services/vendas/RecomposicaoFiscalComposicaoMotorSimulacaoService');

const { buscarComposicao, resolverAlvoMinimoComToleranciaDinheiro, comporItens } = Composicao.internos;

function modeloPrecoFixo(produtoId, precoCentavos, quantidadeMaxima = 10) {
  return {
    produtoId,
    nome: `Produto ${produtoId}`,
    categoriaFiscal: 'REFRIGERANTE',
    volumeMlPorUnidade: 1,
    quantidadeMaxima,
    cotador: {
      precoUnitarioMinimoInterno: precoCentavos / 100,
      cotar(quantidade) {
        return {
          subtotalCentavos: precoCentavos * quantidade,
          precoUnitarioInterno: precoCentavos / 100,
          regrasAplicadas: [],
          fingerprint: `fix-${produtoId}-${quantidade}`
        };
      }
    }
  };
}

const PAGAMENTOS_50 = [
  { forma_pagamento: 'debito', valor: 20 },
  { forma_pagamento: 'credito', valor: 20 },
  { forma_pagamento: 'dinheiro', valor: 10 }
];

describe('CDS-PAGAMENTO-MISTO-RECOMPOSICAO-FISCAL-12', { concurrency: false }, () => {
  it('A) composição compatível — motor aplica margem no mecanismo existente', () => {
    const margem = calcularMargemToleranciaDinheiro(PAGAMENTOS_50);
    assert.equal(margem.margem_maxima, 2);

    const modelos = [modeloPrecoFixo(1, 1000, 5)];
    const capacidade = { REFRIGERANTE: 100 };
    // Candidato R$ 40 → exato
    const exata = buscarComposicao(modelos, capacidade, 4000, 0, undefined, {
      margemToleranciaCentavos: 200
    });
    assert.equal(exata.aplicouRegraToleranciaDinheiro, true);
    assert.equal(exata.totalCentavos, 4000);
    assert.equal(exata.encontrouExato, true);
    assert.equal(exata.dentroDaMargemTolerancia, true);
    assert.equal(exata.naoAutorizaDesconto, true);
    assert.equal(exata.valorFiscalOficialAutorizado, null);

    // Candidato R$ 41,90 → composição R$ 40 dentro da margem R$ 2
    const naMargem = buscarComposicao(modelos, capacidade, 4190, 0, undefined, {
      margemToleranciaCentavos: 200
    });
    assert.equal(naMargem.totalCentavos, 4000);
    assert.equal(naMargem.diferencaAoAlvoCentavos, 190);
    assert.equal(naMargem.dentroDaMargemTolerancia, true);
    assert.equal(naMargem.encontrouExato, false);
    assert.ok(Array.isArray(naMargem.quantidades));
    assert.ok(naMargem.quantidades.every((q) => Number.isSafeInteger(q)));
  });

  it('B) composição inexistente — resultado explícito sem inventar itens', () => {
    const modelos = [modeloPrecoFixo(1, 1000, 5)];
    // Candidato 35 / margem 2 → faixa [33, 35]; grid de R$ 10 não cabe
    const fora = buscarComposicao(modelos, { REFRIGERANTE: 100 }, 3500, 0, undefined, {
      margemToleranciaCentavos: 200
    });
    assert.equal(fora.aplicouRegraToleranciaDinheiro, true);
    assert.equal(fora.totalCentavos, -1);
    assert.equal(fora.quantidades, null);
    assert.equal(fora.dentroDaMargemTolerancia, false);

    const viaAdaptador = avaliarCandidatoComBuscarComposicao({
      valorFiscalCandidato: 35,
      margemMaxima: 2,
      modelos,
      capacidadePorCategoria: { REFRIGERANTE: 100 }
    });
    assert.equal(viaAdaptador.codigo, 'COMPOSICAO_INCOMPATIVEL_MARGEM_TOLERANCIA');
    assert.equal(viaAdaptador.composicao_encontrada, null);
    assert.equal(viaAdaptador.aplicou_desconto, false);
  });

  it('C) preservação dos itens — quantidades inteiras e regras do motor', () => {
    const modelos = [modeloPrecoFixo(7, 1000, 5)];
    const busca = buscarComposicao(modelos, { REFRIGERANTE: 100 }, 4000, 0, undefined, {
      margemToleranciaCentavos: 200
    });
    assert.deepEqual(busca.quantidades, [4]);
    const itens = comporItens(modelos, busca.quantidades);
    assert.equal(itens.length, 1);
    assert.equal(itens[0].produtoId, 7);
    assert.equal(itens[0].quantidade, 4);
    assert.equal(itens[0].subtotalCentavos, 4000);
  });

  it('D) preservação financeira — total/pagamentos não alterados pela regra', () => {
    const margem = calcularMargemToleranciaDinheiro(PAGAMENTOS_50);
    assert.equal(margem.margem_maxima, 2);
    assert.equal(margem.nao_e_desconto, true);

    const totalComercial = 50;
    const somaPag = PAGAMENTOS_50.reduce((s, p) => s + p.valor, 0);
    assert.equal(somaPag, totalComercial);

    buscarComposicao(
      [modeloPrecoFixo(1, 1000, 5)],
      { REFRIGERANTE: 100 },
      4000,
      0,
      undefined,
      { margemToleranciaCentavos: 200 }
    );
    // Pagamentos e total de referência intactos (objetos de teste não mutados)
    assert.equal(PAGAMENTOS_50[2].valor, 10);
    assert.equal(totalComercial, 50);
  });

  it('E) margem matemática é critério — não desconto nem classificação fiscal', () => {
    const r = resolverAlvoMinimoComToleranciaDinheiro(4190, 0, {
      margemToleranciaCentavos: 200
    });
    assert.equal(r.aplicouRegraToleranciaDinheiro, true);
    assert.equal(r.alvoMinimoEfetivo, 3990);
    assert.equal(r.margemToleranciaCentavos, 200);

    const busca = buscarComposicao(
      [modeloPrecoFixo(1, 1000, 5)],
      { REFRIGERANTE: 100 },
      4190,
      0,
      undefined,
      { margemToleranciaCentavos: 200 }
    );
    assert.equal(busca.naoAutorizaDesconto, true);
    assert.equal(busca.naoClassificaResidualComoNaoFiscal, true);
    assert.equal(busca.valorFiscalOficialAutorizado, null);
    // Diferença 1,90 ≠ desconto aplicado
    assert.equal(busca.diferencaAoAlvoCentavos, 190);
  });

  it('F) compatibilidade anterior — sem margem o comportamento legado permanece', () => {
    const modelos = [
      modeloPrecoFixo(1, 600, 3),
      modeloPrecoFixo(2, 600, 3),
      modeloPrecoFixo(3, 650, 3)
    ];
    // Caso legado MINIMO (pedido-pdv-composicao)
    const minimo = buscarComposicao(
      modelos,
      { REFRIGERANTE: 10 },
      1800,
      1001,
      undefined,
      { objetivo: 'MINIMO' }
    );
    assert.equal(minimo.otimalidadeComprovada, true);
    assert.equal(minimo.totalCentavos, 1200);
    assert.equal(minimo.aplicouRegraToleranciaDinheiro, false);

    // Maximização sem margem: aceita qualquer ≤ alvo (ex.: 30 para alvo 35)
    const legadoMax = buscarComposicao(
      [modeloPrecoFixo(1, 1000, 5)],
      { REFRIGERANTE: 100 },
      3500
    );
    assert.equal(legadoMax.aplicouRegraToleranciaDinheiro, false);
    assert.equal(legadoMax.totalCentavos, 3000);
    assert.equal(legadoMax.dentroDaMargemTolerancia, true);
  });
});
