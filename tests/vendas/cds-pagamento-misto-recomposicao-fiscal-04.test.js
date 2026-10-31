/**
 * CDS — PAGAMENTO MISTO E RECOMPOSIÇÃO FISCAL — 04
 * Simulação isolada da distribuição F/NF com residual matemático.
 *
 * Isolamento: puro — sem DB, TEF, SEFAZ, criarVenda.
 * Executar: node --test tests/vendas/cds-pagamento-misto-recomposicao-fiscal-04.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  RECOMPOSICAO_HABILITADA_EM_PRODUCAO
} = require('../../backend/services/vendas/RecomposicaoFiscalContratoService');

const {
  simularDistribuicaoFiscalComResidual,
  calcularResidualMatematico
} = require('../../backend/services/vendas/RecomposicaoFiscalDistribuicaoSimulacaoService');

const PAGAMENTOS_50 = Object.freeze([
  Object.freeze({ forma_pagamento: 'debito', valor: 20 }),
  Object.freeze({ forma_pagamento: 'credito', valor: 20 }),
  Object.freeze({ forma_pagamento: 'dinheiro', valor: 10 })
]);

/** 5 pastéis × R$ 10 = R$ 50 — permite candidato R$ 40 (4+1). */
function itensPasteis10(overridesPorItem = {}) {
  return [
    {
      produto_id: 1,
      quantidade: 5,
      preco_unitario: 10,
      subtotal: 50,
      saldo_fiscal_sintetico: 10,
      saldo_nao_fiscal_sintetico: 10,
      ...overridesPorItem
    }
  ];
}

describe('CDS-PAGAMENTO-MISTO-RECOMPOSICAO-FISCAL-04', { concurrency: false }, () => {
  it('1) total financeiro de R$ 50,00', () => {
    const r = simularDistribuicaoFiscalComResidual({
      total_comercial: 50,
      pagamentos: [...PAGAMENTOS_50],
      valor_fiscal_candidato: 40,
      itens: itensPasteis10()
    });
    assert.equal(r.total_comercial, 50);
    assert.equal(r.total_financeiro_recebido, 50);
  });

  it('2) candidato fiscal de R$ 40,00', () => {
    const r = simularDistribuicaoFiscalComResidual({
      total_comercial: 50,
      pagamentos: [...PAGAMENTOS_50],
      valor_fiscal_candidato: 40,
      itens: itensPasteis10()
    });
    assert.equal(r.valor_fiscal_candidato, 40);
    assert.equal(r.residual.valor, 10);
    assert.equal(r.distribuicao.possivel, true);
    assert.equal(r.distribuicao.valor_fiscal_alocado, 40);
    assert.equal(r.distribuicao.valor_nao_fiscal_alocado, 10);
    assert.equal(r.distribuicao.itens[0].quantidade_fiscal, 4);
    assert.equal(r.distribuicao.itens[0].quantidade_nao_fiscal, 1);
  });

  it('3) candidato R$ 41,90 e residual R$ 8,10 em relação ao comercial', () => {
    const residual = calcularResidualMatematico(50, 41.9);
    assert.equal(residual.valor, 8.1);
    assert.equal(residual.classificacao, null);
    assert.equal(residual.nao_e_desconto, true);
    assert.equal(residual.nao_e_voucher, true);
    assert.equal(residual.formula, 'total_comercial - valor_fiscal_candidato');

    // Matematicamente possível com qtd fracionária (4,19 + 0,81); residual permanece 8,10.
    const rPasteisFrac = simularDistribuicaoFiscalComResidual({
      total_comercial: 50,
      pagamentos: [...PAGAMENTOS_50],
      valor_fiscal_candidato: 41.9,
      itens: itensPasteis10()
    });
    assert.equal(rPasteisFrac.residual.valor, 8.1);
    assert.equal(rPasteisFrac.distribuicao.possivel, true);
    assert.equal(rPasteisFrac.distribuicao.itens[0].quantidade_fiscal, 4.19);
    assert.equal(rPasteisFrac.distribuicao.itens[0].quantidade_nao_fiscal, 0.81);

    // Operacionalmente inviável se a regra exigir unidades inteiras (sem inventar desconto).
    const rPasteisInteiro = simularDistribuicaoFiscalComResidual({
      total_comercial: 50,
      pagamentos: [...PAGAMENTOS_50],
      valor_fiscal_candidato: 41.9,
      exigir_quantidades_inteiras: true,
      itens: itensPasteis10()
    });
    assert.equal(rPasteisInteiro.residual.valor, 8.1);
    assert.equal(rPasteisInteiro.distribuicao.possivel, false);
    assert.equal(rPasteisInteiro.distribuicao.codigo, 'DISTRIBUICAO_EXIGE_QUANTIDADE_FRACIONARIA');

    // Com itens cujos subtotais batem exatamente 41,90 + 8,10, a simulação é possível.
    const rCompativel = simularDistribuicaoFiscalComResidual({
      total_comercial: 50,
      pagamentos: [...PAGAMENTOS_50],
      valor_fiscal_candidato: 41.9,
      itens: [
        {
          produto_id: 2,
          quantidade: 1,
          preco_unitario: 41.9,
          subtotal: 41.9,
          saldo_fiscal_sintetico: 1,
          saldo_nao_fiscal_sintetico: 0
        },
        {
          produto_id: 3,
          quantidade: 1,
          preco_unitario: 8.1,
          subtotal: 8.1,
          saldo_fiscal_sintetico: 0,
          saldo_nao_fiscal_sintetico: 1
        }
      ]
    });
    assert.equal(rCompativel.residual.valor, 8.1);
    assert.equal(rCompativel.distribuicao.possivel, true);
    assert.equal(rCompativel.distribuicao.valor_fiscal_alocado, 41.9);
    assert.equal(rCompativel.distribuicao.valor_nao_fiscal_alocado, 8.1);
    assert.equal(rCompativel.residual.classificacao, null);
  });

  it('4) consistência valor fiscal + não fiscal = total comercial', () => {
    const r = simularDistribuicaoFiscalComResidual({
      total_comercial: 50,
      pagamentos: [...PAGAMENTOS_50],
      valor_fiscal_candidato: 40,
      itens: itensPasteis10()
    });
    const soma = Math.round(
      (r.distribuicao.valor_fiscal_alocado + r.distribuicao.valor_nao_fiscal_alocado) * 100
    );
    assert.equal(soma, 5000);
    assert.equal(
      Math.round((r.valor_fiscal_candidato + r.residual.valor) * 100),
      5000
    );
  });

  it('5) consistência quantidades F/NF com quantidade total', () => {
    const r = simularDistribuicaoFiscalComResidual({
      total_comercial: 50,
      pagamentos: [...PAGAMENTOS_50],
      valor_fiscal_candidato: 40,
      itens: [
        {
          produto_id: 1,
          quantidade: 5,
          subtotal: 50,
          quantidade_fiscal: 4,
          quantidade_nao_fiscal: 1,
          valor_fiscal: 40,
          valor_nao_fiscal: 10,
          saldo_fiscal_sintetico: 4,
          saldo_nao_fiscal_sintetico: 1
        }
      ]
    });
    assert.equal(r.distribuicao.possivel, true);
    const it = r.distribuicao.itens[0];
    assert.equal(it.quantidade_fiscal + it.quantidade_nao_fiscal, it.quantidade);
  });

  it('6) rejeita distribuições incompatíveis com itens/estoque', () => {
    // Qtd F+NF ≠ total
    const rQtd = simularDistribuicaoFiscalComResidual({
      total_comercial: 50,
      pagamentos: [...PAGAMENTOS_50],
      valor_fiscal_candidato: 40,
      itens: [
        {
          produto_id: 1,
          quantidade: 5,
          subtotal: 50,
          quantidade_fiscal: 3,
          quantidade_nao_fiscal: 1,
          valor_fiscal: 40,
          valor_nao_fiscal: 10
        }
      ]
    });
    assert.equal(rQtd.distribuicao.possivel, false);
    assert.equal(rQtd.distribuicao.codigo, 'ITEM_DISTRIBUICAO_INCONSISTENTE');

    // Estoque sintético insuficiente
    const rEstoque = simularDistribuicaoFiscalComResidual({
      total_comercial: 50,
      pagamentos: [...PAGAMENTOS_50],
      valor_fiscal_candidato: 40,
      itens: [
        {
          produto_id: 1,
          quantidade: 5,
          subtotal: 50,
          quantidade_fiscal: 4,
          quantidade_nao_fiscal: 1,
          valor_fiscal: 40,
          valor_nao_fiscal: 10,
          saldo_fiscal_sintetico: 2,
          saldo_nao_fiscal_sintetico: 10
        }
      ]
    });
    assert.equal(rEstoque.distribuicao.possivel, false);
    assert.equal(rEstoque.distribuicao.codigo, 'DISTRIBUICAO_INCOMPATIVEL_ESTOQUE_SINTETICO');
  });

  it('7) imutabilidade dos dados originais', () => {
    const entrada = {
      total_comercial: 50,
      pagamentos: [
        { forma_pagamento: 'debito', valor: 20 },
        { forma_pagamento: 'credito', valor: 20 },
        { forma_pagamento: 'dinheiro', valor: 10 }
      ],
      valor_fiscal_candidato: 40,
      itens: itensPasteis10()
    };
    const pagAntes = JSON.stringify(entrada.pagamentos);
    const itensAntes = JSON.stringify(entrada.itens);
    simularDistribuicaoFiscalComResidual(entrada);
    assert.equal(JSON.stringify(entrada.pagamentos), pagAntes);
    assert.equal(JSON.stringify(entrada.itens), itensAntes);
  });

  it('8) simulação não altera o fluxo oficial', () => {
    assert.equal(RECOMPOSICAO_HABILITADA_EM_PRODUCAO, false);
    const r = simularDistribuicaoFiscalComResidual({
      total_comercial: 50,
      pagamentos: [...PAGAMENTOS_50],
      valor_fiscal_candidato: 40,
      itens: itensPasteis10()
    });
    assert.equal(r.aplica_ao_fluxo_oficial, false);
    assert.equal(r.altera_motor_fxnf, false);
    assert.equal(r.altera_vendas_total, false);
    assert.equal(r.cria_voucher, false);
    assert.equal(r.recomposicao_habilitada_em_producao, false);
    assert.equal(r.meta.dinheiro_nao_classificado_automaticamente, true);
    assert.equal(r.residual.classificacao, null);

    assert.throws(
      () =>
        simularDistribuicaoFiscalComResidual({
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
