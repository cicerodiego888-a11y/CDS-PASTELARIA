/**
 * CDS — PAGAMENTO MISTO E RECOMPOSIÇÃO FISCAL — 02
 * Contrato isolado de validação da composição fiscal pretendida.
 *
 * Isolamento: puro (sem DB, sem TEF real, sem SEFAZ, sem vendas oficiais).
 * Executar: node --test tests/vendas/cds-pagamento-misto-recomposicao-fiscal-02.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  RECOMPOSICAO_HABILITADA_EM_PRODUCAO,
  prepararContratoRecomposicaoFiscal,
  pagamentoExigeProcessamentoTef,
  round2
} = require('../../backend/services/vendas/RecomposicaoFiscalContratoService');

const CENARIO_REF = Object.freeze({
  total_comercial: 50,
  pagamentos: Object.freeze([
    Object.freeze({ forma_pagamento: 'debito', valor: 20 }),
    Object.freeze({ forma_pagamento: 'credito', valor: 20 }),
    Object.freeze({ forma_pagamento: 'dinheiro', valor: 10 })
  ]),
  valor_fiscal_candidato: 40
});

describe('CDS-PAGAMENTO-MISTO-RECOMPOSICAO-FISCAL-02', { concurrency: false }, () => {
  it('1) pagamentos 20+20+10 totalizam R$ 50,00', () => {
    const c = prepararContratoRecomposicaoFiscal({ ...CENARIO_REF, pagamentos: [...CENARIO_REF.pagamentos] });
    assert.equal(c.total_comercial, 50);
    assert.equal(c.total_financeiro_recebido, 50);
    assert.equal(c.pagamentos.length, 3);
    const soma = round2(c.pagamentos.reduce((s, p) => s + p.valor, 0));
    assert.equal(soma, 50);
  });

  it('2) dinheiro não solicita processamento TEF', () => {
    assert.equal(pagamentoExigeProcessamentoTef('dinheiro'), false);
    assert.equal(pagamentoExigeProcessamentoTef('especie'), false);
    assert.equal(pagamentoExigeProcessamentoTef('debito'), true);
    assert.equal(pagamentoExigeProcessamentoTef('credito'), true);

    const c = prepararContratoRecomposicaoFiscal({
      total_comercial: 50,
      pagamentos: [
        { forma_pagamento: 'debito', valor: 20 },
        { forma_pagamento: 'credito', valor: 20 },
        { forma_pagamento: 'dinheiro', valor: 10 }
      ]
    });
    const dinheiro = c.pagamentos.find((p) => p.eh_dinheiro);
    assert.ok(dinheiro);
    assert.equal(dinheiro.exige_tef, false);
  });

  it('3) soma de pagamentos divergente do total comercial é rejeitada', () => {
    assert.throws(
      () =>
        prepararContratoRecomposicaoFiscal({
          total_comercial: 50,
          pagamentos: [
            { forma_pagamento: 'debito', valor: 20 },
            { forma_pagamento: 'credito', valor: 20 }
            // falta R$ 10
          ]
        }),
      (err) => err && err.code === 'SOMA_PAGAMENTOS_DIVERGENTE'
    );
  });

  it('4) valor fiscal candidato não pode ser negativo nem superar o comercial sem regra', () => {
    assert.throws(
      () =>
        prepararContratoRecomposicaoFiscal({
          total_comercial: 50,
          pagamentos: [{ forma_pagamento: 'dinheiro', valor: 50 }],
          valor_fiscal_candidato: -1
        }),
      (err) => err && err.code === 'VALOR_FISCAL_CANDIDATO_NEGATIVO'
    );

    assert.throws(
      () =>
        prepararContratoRecomposicaoFiscal({
          total_comercial: 50,
          pagamentos: [{ forma_pagamento: 'dinheiro', valor: 50 }],
          valor_fiscal_candidato: 60
        }),
      (err) => err && err.code === 'VALOR_FISCAL_CANDIDATO_ACIMA_DO_COMERCIAL'
    );

    // Com regra explícita, permite acima do comercial (ainda isolado / não produção).
    const ok = prepararContratoRecomposicaoFiscal({
      total_comercial: 50,
      pagamentos: [{ forma_pagamento: 'dinheiro', valor: 50 }],
      valor_fiscal_candidato: 60,
      permitir_valor_fiscal_acima_do_comercial: true
    });
    assert.equal(ok.valor_fiscal_candidato, 60);
    assert.equal(ok.aplica_ao_fluxo_oficial, false);
  });

  it('5) valores monetários sem erros de arredondamento (centavos)', () => {
    const c = prepararContratoRecomposicaoFiscal({
      total_comercial: 10.1,
      pagamentos: [
        { forma_pagamento: 'debito', valor: 3.33 },
        { forma_pagamento: 'credito', valor: 3.33 },
        { forma_pagamento: 'dinheiro', valor: 3.44 }
      ]
    });
    assert.equal(c.total_financeiro_recebido, 10.1);
    assert.equal(c.total_comercial, 10.1);
  });

  it('6) contrato não modifica os objetos de entrada', () => {
    const entrada = {
      total_comercial: 50,
      pagamentos: [
        { forma_pagamento: 'debito', valor: 20 },
        { forma_pagamento: 'credito', valor: 20 },
        { forma_pagamento: 'dinheiro', valor: 10 }
      ],
      valor_fiscal_candidato: 40,
      itens: [{ produto_id: 1, quantidade: 2, subtotal: 50 }]
    };
    const pagamentosAntes = JSON.stringify(entrada.pagamentos);
    const itensAntes = JSON.stringify(entrada.itens);
    const totalAntes = entrada.total_comercial;

    const c = prepararContratoRecomposicaoFiscal(entrada);
    assert.equal(JSON.stringify(entrada.pagamentos), pagamentosAntes);
    assert.equal(JSON.stringify(entrada.itens), itensAntes);
    assert.equal(entrada.total_comercial, totalAntes);
    assert.equal(c.valor_fiscal_candidato, 40);
    assert.equal(c.valor_nao_fiscal_candidato, 10);
  });

  it('7) cenário R$ 40,00 valida isolado e não altera composição oficial', () => {
    const c = prepararContratoRecomposicaoFiscal({
      total_comercial: 50,
      pagamentos: [
        { forma_pagamento: 'debito', valor: 20 },
        { forma_pagamento: 'credito', valor: 20 },
        { forma_pagamento: 'dinheiro', valor: 10 }
      ],
      valor_fiscal_candidato: 40
    });
    assert.equal(c.valor_fiscal_candidato, 40);
    assert.equal(c.valor_nao_fiscal_candidato, 10);
    assert.equal(c.total_comercial, 50);
    assert.equal(c.altera_motor_fxnf, false);
    assert.equal(c.altera_vendas_total, false);
    assert.equal(c.aplica_ao_fluxo_oficial, false);
    assert.equal(c.meta.motor_fxnf_oficial_preservado, true);
  });

  it('8) quantidade dos itens permanece consistente com distribuição F/NF', () => {
    const c = prepararContratoRecomposicaoFiscal({
      total_comercial: 50,
      pagamentos: [{ forma_pagamento: 'dinheiro', valor: 50 }],
      valor_fiscal_candidato: 40,
      itens: [
        {
          produto_id: 7,
          quantidade: 5,
          subtotal: 50,
          quantidade_fiscal: 4,
          quantidade_nao_fiscal: 1,
          valor_fiscal: 40,
          valor_nao_fiscal: 10
        }
      ]
    });
    assert.equal(c.itens.length, 1);
    assert.equal(c.itens[0].quantidade, 5);
    assert.equal(c.itens[0].quantidade_fiscal, 4);
    assert.equal(c.itens[0].quantidade_nao_fiscal, 1);

    assert.throws(
      () =>
        prepararContratoRecomposicaoFiscal({
          total_comercial: 50,
          pagamentos: [{ forma_pagamento: 'dinheiro', valor: 50 }],
          itens: [
            {
              produto_id: 7,
              quantidade: 5,
              quantidade_fiscal: 3,
              quantidade_nao_fiscal: 1
            }
          ]
        }),
      (err) => err && err.code === 'ITEM_DISTRIBUICAO_INCONSISTENTE'
    );
  });

  it('9) ausência de validação fiscal NÃO habilita recomposição em produção', () => {
    assert.equal(RECOMPOSICAO_HABILITADA_EM_PRODUCAO, false);

    assert.throws(
      () =>
        prepararContratoRecomposicaoFiscal({
          total_comercial: 50,
          pagamentos: [{ forma_pagamento: 'dinheiro', valor: 50 }],
          valor_fiscal_candidato: 40,
          habilitar_em_producao: true
        }),
      (err) => err && err.code === 'RECOMPOSICAO_NAO_HABILITADA_EM_PRODUCAO'
    );

    const c = prepararContratoRecomposicaoFiscal({
      total_comercial: 50,
      pagamentos: [{ forma_pagamento: 'dinheiro', valor: 50 }],
      valor_fiscal_candidato: 40
    });
    assert.equal(c.recomposicao_habilitada_em_producao, false);
    assert.equal(c.aplica_ao_fluxo_oficial, false);
    assert.equal(c.cria_voucher, false);
  });
});
