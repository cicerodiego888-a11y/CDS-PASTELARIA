/**
 * CDS — PAGAMENTO MISTO E RECOMPOSIÇÃO FISCAL — 05
 * Tolerância matemática de até 20% do dinheiro (simulação isolada).
 *
 * Isolamento: puro — sem DB, TEF, SEFAZ, criarVenda, desconto automático.
 * Executar: node --test tests/vendas/cds-pagamento-misto-recomposicao-fiscal-05.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  RECOMPOSICAO_HABILITADA_EM_PRODUCAO
} = require('../../backend/services/vendas/RecomposicaoFiscalContratoService');

const {
  PERCENTUAL_TOLERANCIA_DINHEIRO_PADRAO,
  calcularMargemToleranciaDinheiro,
  avaliarCandidatosComToleranciaDinheiro
} = require('../../backend/services/vendas/RecomposicaoFiscalToleranciaDinheiroSimulacaoService');

const PAGAMENTOS_50 = Object.freeze([
  Object.freeze({ forma_pagamento: 'debito', valor: 20 }),
  Object.freeze({ forma_pagamento: 'credito', valor: 20 }),
  Object.freeze({ forma_pagamento: 'dinheiro', valor: 10 })
]);

function itensPasteis10(extra = {}) {
  return [
    {
      produto_id: 1,
      quantidade: 5,
      preco_unitario: 10,
      subtotal: 50,
      saldo_fiscal_sintetico: 10,
      saldo_nao_fiscal_sintetico: 10,
      ...extra
    }
  ];
}

describe('CDS-PAGAMENTO-MISTO-RECOMPOSICAO-FISCAL-05', { concurrency: false }, () => {
  it('1) calcula corretamente 20% do dinheiro recebido', () => {
    assert.equal(PERCENTUAL_TOLERANCIA_DINHEIRO_PADRAO, 0.2);
    const m = calcularMargemToleranciaDinheiro([...PAGAMENTOS_50]);
    assert.equal(m.dinheiro_recebido, 10);
    assert.equal(m.percentual, 0.2);
    assert.equal(m.margem_maxima, 2);
    assert.equal(m.nao_e_desconto, true);
    assert.equal(m.classificacao, null);
  });

  it('2) pagamento em dinheiro igual a zero → margem zero', () => {
    const m = calcularMargemToleranciaDinheiro([
      { forma_pagamento: 'debito', valor: 25 },
      { forma_pagamento: 'credito', valor: 25 }
    ]);
    assert.equal(m.dinheiro_recebido, 0);
    assert.equal(m.margem_maxima, 0);

    const r = avaliarCandidatosComToleranciaDinheiro({
      total_comercial: 50,
      pagamentos: [
        { forma_pagamento: 'debito', valor: 25 },
        { forma_pagamento: 'credito', valor: 25 }
      ],
      valor_fiscal_candidato: 41.9,
      itens: itensPasteis10()
    });
    assert.equal(r.margem.margem_maxima, 0);
    const av = r.avaliacoes[0];
    assert.equal(av.distribuicao_possivel, false);
    assert.equal(av.codigo, 'MARGEM_INSUFICIENTE');
  });

  it('3) distribuição com quantidade inteira dentro da margem (candidato R$ 40)', () => {
    const r = avaliarCandidatosComToleranciaDinheiro({
      total_comercial: 50,
      pagamentos: [...PAGAMENTOS_50],
      valor_fiscal_candidato: 40,
      itens: itensPasteis10()
    });
    assert.equal(r.margem.margem_maxima, 2);
    assert.equal(r.distribuicao_possivel, true);
    const av = r.avaliacoes[0];
    assert.equal(av.codigo, 'OK_CANDIDATO_INTEIRO_EXATO');
    assert.equal(av.candidato_inteiro_compativel, 40);
    assert.equal(av.distancia_ao_inteiro_compativel, 0);
    assert.equal(av.aplicou_desconto, false);
    assert.equal(av.distribuicao.itens[0].quantidade_fiscal, 4);
    assert.equal(av.distribuicao.itens[0].quantidade_nao_fiscal, 1);
  });

  it('4) candidato R$ 41,90 incompatível com qtd inteira exata, mas dentro da margem → 40', () => {
    const r = avaliarCandidatosComToleranciaDinheiro({
      total_comercial: 50,
      pagamentos: [...PAGAMENTOS_50],
      candidatos_fiscais: [40, 41.9],
      itens: itensPasteis10()
    });
    assert.equal(r.margem.margem_maxima, 2);

    const av40 = r.avaliacoes.find((a) => a.valor_fiscal_candidato === 40);
    const av4190 = r.avaliacoes.find((a) => a.valor_fiscal_candidato === 41.9);
    assert.ok(av40 && av4190);
    assert.equal(av40.distribuicao_possivel, true);

    // 41,90 → distância 1,90 até 40,00 ≤ margem 2,00
    assert.equal(av4190.dentro_da_margem, true);
    assert.equal(av4190.distancia_ao_inteiro_compativel, 1.9);
    assert.equal(av4190.candidato_inteiro_compativel, 40);
    assert.equal(av4190.codigo, 'OK_CANDIDATO_DENTRO_DA_MARGEM');
    assert.equal(av4190.aplicou_desconto, false);
    assert.equal(av4190.alterou_pagamento, false);
    assert.equal(av4190.distribuicao_possivel, true);
    assert.equal(av4190.residual.classificacao, null);
  });

  it('5) margem insuficiente (ex.: candidato longe demais do grid inteiro)', () => {
    // Dinheiro R$ 10 → margem R$ 2; candidato 35 fica a R$ 5 de 30 ou 40
    const r = avaliarCandidatosComToleranciaDinheiro({
      total_comercial: 50,
      pagamentos: [...PAGAMENTOS_50],
      valor_fiscal_candidato: 35,
      itens: itensPasteis10()
    });
    const av = r.avaliacoes[0];
    assert.equal(av.distribuicao_possivel, false);
    assert.equal(av.codigo, 'MARGEM_INSUFICIENTE');
    assert.equal(av.dentro_da_margem, false);
    assert.equal(av.aplicou_desconto, false);
    assert.equal(r.aplicou_desconto_automatico, false);
  });

  it('6) valores monetários e arredondamento em centavos', () => {
    const m = calcularMargemToleranciaDinheiro([
      { forma_pagamento: 'dinheiro', valor: 10.05 }
    ]);
    // 20% de 10,05 = 2,01
    assert.equal(m.dinheiro_recebido, 10.05);
    assert.equal(m.margem_maxima, 2.01);

    const m2 = calcularMargemToleranciaDinheiro([
      { forma_pagamento: 'dinheiro', valor: 0.1 },
      { forma_pagamento: 'dinheiro', valor: 0.2 }
    ]);
    assert.equal(m2.dinheiro_recebido, 0.3);
    assert.equal(m2.margem_maxima, 0.06);
  });

  it('7) imutabilidade dos dados de entrada', () => {
    const entrada = {
      total_comercial: 50,
      pagamentos: [
        { forma_pagamento: 'debito', valor: 20 },
        { forma_pagamento: 'credito', valor: 20 },
        { forma_pagamento: 'dinheiro', valor: 10 }
      ],
      candidatos_fiscais: [40, 41.9],
      itens: itensPasteis10()
    };
    const pagAntes = JSON.stringify(entrada.pagamentos);
    const itensAntes = JSON.stringify(entrada.itens);
    const candAntes = JSON.stringify(entrada.candidatos_fiscais);
    avaliarCandidatosComToleranciaDinheiro(entrada);
    assert.equal(JSON.stringify(entrada.pagamentos), pagAntes);
    assert.equal(JSON.stringify(entrada.itens), itensAntes);
    assert.equal(JSON.stringify(entrada.candidatos_fiscais), candAntes);
  });

  it('8) ausência de efeitos no fluxo oficial', () => {
    assert.equal(RECOMPOSICAO_HABILITADA_EM_PRODUCAO, false);
    const r = avaliarCandidatosComToleranciaDinheiro({
      total_comercial: 50,
      pagamentos: [...PAGAMENTOS_50],
      valor_fiscal_candidato: 41.9,
      itens: itensPasteis10()
    });
    assert.equal(r.aplica_ao_fluxo_oficial, false);
    assert.equal(r.altera_motor_fxnf, false);
    assert.equal(r.altera_vendas_total, false);
    assert.equal(r.cria_voucher, false);
    assert.equal(r.aplicou_desconto_automatico, false);
    assert.equal(r.recomposicao_habilitada_em_producao, false);
    assert.equal(r.meta.margem_nao_e_desconto, true);

    assert.throws(
      () =>
        avaliarCandidatosComToleranciaDinheiro({
          total_comercial: 50,
          pagamentos: [...PAGAMENTOS_50],
          valor_fiscal_candidato: 40,
          itens: itensPasteis10(),
          habilitar_em_producao: true
        }),
      (err) => err && err.code === 'RECOMPOSICAO_NAO_HABILITADA_EM_PRODUCAO'
    );
  });
});
