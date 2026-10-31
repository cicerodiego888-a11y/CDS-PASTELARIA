/**
 * CDS — PAGAMENTO MISTO E RECOMPOSIÇÃO FISCAL — 07
 * Orquestrador isolado: Contrato (02) + Tolerância dinheiro (05) + Motor composição (06).
 *
 * Isolamento: memória / mocks. Sem DB oficial, TEF, SEFAZ, criarVenda.
 * Executar: node --test tests/vendas/cds-pagamento-misto-recomposicao-fiscal-07.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  RECOMPOSICAO_HABILITADA_EM_PRODUCAO
} = require('../../backend/services/vendas/RecomposicaoFiscalContratoService');

const {
  simularIntegracaoRecomposicaoFiscal
} = require('../../backend/services/vendas/RecomposicaoFiscalIntegracaoSimulacaoService');

const PAGAMENTOS_50 = Object.freeze([
  Object.freeze({ forma_pagamento: 'debito', valor: 20 }),
  Object.freeze({ forma_pagamento: 'credito', valor: 20 }),
  Object.freeze({ forma_pagamento: 'dinheiro', valor: 10 })
]);

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

function baseEntrada(overrides = {}) {
  return {
    total_comercial: 50,
    pagamentos: [
      { forma_pagamento: 'debito', valor: 20 },
      { forma_pagamento: 'credito', valor: 20 },
      { forma_pagamento: 'dinheiro', valor: 10 }
    ],
    itens: [{ produto_id: 1, quantidade: 5, subtotal: 50 }],
    modelos: [modeloPrecoFixo(1, 1000, 5)],
    capacidade_por_categoria: { REFRIGERANTE: 100 },
    ...overrides
  };
}

function assertProtecoesDiagnostico(r) {
  assert.equal(r.habilitado_em_producao, false);
  assert.equal(r.persistencia_executada, false);
  assert.equal(r.emissao_fiscal_autorizada, false);
  assert.equal(r.aplicou_desconto_automatico, false);
  assert.equal(r.valor_fiscal_oficialmente_autorizado, null);
  assert.equal(r.valor_fiscal_oficial_determinado_por_esta_simulacao, false);
  assert.equal(r.tratamento_fiscal_do_vale_pendente, true);
  assert.equal(r.aplica_ao_fluxo_oficial, false);
}

describe('CDS-PAGAMENTO-MISTO-RECOMPOSICAO-FISCAL-07', { concurrency: false }, () => {
  it('A) composição exata R$ 40 — identifica EXATA sem autorizar fiscal/produção', async () => {
    const r = await simularIntegracaoRecomposicaoFiscal(baseEntrada({
      valor_fiscal_candidato: 40
    }));
    assert.equal(r.total_comercial, 50);
    assert.equal(r.total_pagamentos, 50);
    assert.equal(r.valor_dinheiro, 10);
    assert.equal(r.margem_matematica, 2);
    assert.equal(r.valor_candidato_simulacao, 40);
    assert.equal(r.valor_composicao_simulada, 40);
    assert.equal(r.diferenca_composicao, 0);
    assert.equal(r.status_simulacao, 'EXATA');
    assert.equal(r.codigo_motor, 'OK_COMPOSICAO_EXATA');
    assertProtecoesDiagnostico(r);
    assert.equal(r.etapas.contrato_sprint_02.total_comercial, 50);
    assert.equal(r.etapas.margem_sprint_05.margem_maxima, 2);
  });

  it('B) diferença dentro da margem (41,90 → composição 40) sem desconto automático', async () => {
    const r = await simularIntegracaoRecomposicaoFiscal(baseEntrada({
      valor_fiscal_candidato: 41.9
    }));
    assert.equal(r.total_comercial, 50);
    assert.equal(r.valor_dinheiro, 10);
    assert.equal(r.margem_matematica, 2);
    assert.equal(r.valor_candidato_simulacao, 41.9);
    assert.equal(r.valor_composicao_simulada, 40);
    assert.equal(r.diferenca_composicao, 1.9);
    assert.equal(r.status_simulacao, 'COMPATIVEL_MARGEM');
    assert.equal(r.aplicou_desconto_automatico, false);
    assert.equal(r.alterou_pagamentos, false);
    assert.equal(r.alterou_itens, false);
    assertProtecoesDiagnostico(r);
  });

  it('C) diferença acima da margem (candidato 35 → sem composição na faixa)', async () => {
    const r = await simularIntegracaoRecomposicaoFiscal(baseEntrada({
      valor_fiscal_candidato: 35
    }));
    assert.equal(r.total_comercial, 50);
    assert.equal(r.valor_composicao_simulada, null);
    assert.equal(r.status_simulacao, 'SEM_COMPOSICAO');
    assert.equal(r.codigo_motor, 'COMPOSICAO_INCOMPATIVEL_MARGEM_TOLERANCIA');
    assert.equal(r.aplicou_desconto_automatico, false);
    assertProtecoesDiagnostico(r);
  });

  it('D) sem dinheiro — margem zero; não força composição', async () => {
    const r = await simularIntegracaoRecomposicaoFiscal(baseEntrada({
      pagamentos: [
        { forma_pagamento: 'debito', valor: 25 },
        { forma_pagamento: 'credito', valor: 25 }
      ],
      valor_fiscal_candidato: 41.9
    }));
    assert.equal(r.valor_dinheiro, 0);
    assert.equal(r.margem_matematica, 0);
    assert.equal(r.valor_candidato_simulacao, 41.9);
    assert.equal(r.valor_composicao_simulada, null);
    assert.equal(r.status_simulacao, 'SEM_COMPOSICAO');
    assert.equal(r.codigo_motor, 'COMPOSICAO_INCOMPATIVEL_MARGEM_TOLERANCIA');
    assertProtecoesDiagnostico(r);
  });

  it('E) pagamentos inconsistentes — rejeita no contrato sem composição válida', async () => {
    await assert.rejects(
      () => simularIntegracaoRecomposicaoFiscal(baseEntrada({
        pagamentos: [
          { forma_pagamento: 'debito', valor: 20 },
          { forma_pagamento: 'credito', valor: 20 }
        ],
        valor_fiscal_candidato: 40
      })),
      (err) => err && err.code === 'SOMA_PAGAMENTOS_DIVERGENTE'
    );
  });

  it('F) motor sem composição — diagnóstico explícito sem inventar produtos', async () => {
    const rVazio = await simularIntegracaoRecomposicaoFiscal(baseEntrada({
      valor_fiscal_candidato: 40,
      modelos: []
    }));
    assert.equal(rVazio.status_simulacao, 'SEM_COMPOSICAO');
    assert.equal(rVazio.valor_composicao_simulada, null);
    assert.equal(rVazio.codigo_motor, 'COMPOSICAO_AUSENTE_NO_MOTOR');
    assertProtecoesDiagnostico(rVazio);

    const rCap = await simularIntegracaoRecomposicaoFiscal(baseEntrada({
      valor_fiscal_candidato: 40,
      capacidade_por_categoria: { REFRIGERANTE: 0 }
    }));
    assert.equal(rCap.status_simulacao, 'SEM_COMPOSICAO');
    assert.ok(
      ['COMPOSICAO_FISCAL_INEXISTENTE', 'COMPOSICAO_INCOMPATIVEL_MARGEM_TOLERANCIA']
        .includes(rCap.codigo_motor)
    );
    assert.equal(rCap.valor_composicao_simulada, null);
    assertProtecoesDiagnostico(rCap);
  });

  it('G) proteção de produção — bloqueia autorização operacional', async () => {
    assert.equal(RECOMPOSICAO_HABILITADA_EM_PRODUCAO, false);

    await assert.rejects(
      () => simularIntegracaoRecomposicaoFiscal(baseEntrada({
        valor_fiscal_candidato: 40,
        habilitar_em_producao: true
      })),
      (err) => err && err.code === 'RECOMPOSICAO_NAO_HABILITADA_EM_PRODUCAO'
    );

    await assert.rejects(
      () => simularIntegracaoRecomposicaoFiscal(baseEntrada({
        valor_fiscal_candidato: 40,
        autorizacao_producao: true
      })),
      (err) => err && err.code === 'RECOMPOSICAO_NAO_HABILITADA_EM_PRODUCAO'
    );

    await assert.rejects(
      () => simularIntegracaoRecomposicaoFiscal(baseEntrada({
        valor_fiscal_candidato: 40,
        execucao_operacional: true
      })),
      (err) => err && err.code === 'RECOMPOSICAO_NAO_HABILITADA_EM_PRODUCAO'
    );

    const r = await simularIntegracaoRecomposicaoFiscal(baseEntrada({
      valor_fiscal_candidato: 40
    }));
    assert.equal(r.habilitado_em_producao, false);
    assert.equal(r.persistencia_executada, false);
    assert.equal(r.emissao_fiscal_autorizada, false);
  });

  it('preserva imutabilidade da entrada e pagamentos de referência', async () => {
    const entrada = baseEntrada({ valor_fiscal_candidato: 40 });
    const pagAntes = JSON.stringify(entrada.pagamentos);
    const itensAntes = JSON.stringify(entrada.itens);
    await simularIntegracaoRecomposicaoFiscal(entrada);
    assert.equal(JSON.stringify(entrada.pagamentos), pagAntes);
    assert.equal(JSON.stringify(entrada.itens), itensAntes);
    assert.deepEqual(
      JSON.parse(pagAntes),
      [
        { forma_pagamento: 'debito', valor: 20 },
        { forma_pagamento: 'credito', valor: 20 },
        { forma_pagamento: 'dinheiro', valor: 10 }
      ]
    );
  });
});
