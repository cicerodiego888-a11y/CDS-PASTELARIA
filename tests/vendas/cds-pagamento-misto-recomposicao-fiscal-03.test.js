/**
 * CDS — PAGAMENTO MISTO E RECOMPOSIÇÃO FISCAL — 03
 * Integração controlada (demonstração isolada) ao fechamento PDV.
 *
 * Isolamento: puro — sem DB, TEF real, SEFAZ, criarVenda ou rotas.
 * Executar:
 *   node --test tests/vendas/cds-pagamento-misto-recomposicao-fiscal-03.test.js
 *   node --test tests/vendas/cds-pagamento-misto-recomposicao-fiscal-02.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const {
  RECOMPOSICAO_HABILITADA_EM_PRODUCAO
} = require('../../backend/services/vendas/RecomposicaoFiscalContratoService');

const {
  PONTO_INTEGRACAO_RECOMENDADO,
  SEQUENCIA_FECHAMENTO_PDV,
  CONTRATO_MINIMO_PROXIMA_ETAPA,
  mapearSnapshotFechamentoPdvParaEntradaContrato,
  avaliarDivergenciaPreCalculoOficialVsCandidato,
  demonstrarIntegracaoIsoladaFechamento
} = require('../../backend/services/vendas/RecomposicaoFiscalIntegracaoPdvProposta');

/** Snapshot sintético espelhando o payload pós-montagem do PDV Express. */
function snapshotCenarioReferencia(overrides = {}) {
  return {
    total: 50,
    forma_pagamento: 'misto',
    emitir_fiscal: false,
    pagamentos: [
      { forma_pagamento: 'debito', valor: 20 },
      { forma_pagamento: 'credito', valor: 20 },
      { forma_pagamento: 'dinheiro', valor: 10 }
    ],
    itens: [
      {
        produto_id: 1,
        quantidade: 5,
        subtotal: 50,
        quantidade_fiscal: 4,
        quantidade_nao_fiscal: 1,
        valor_fiscal: 40,
        valor_nao_fiscal: 10
      }
    ],
    valor_fiscal_candidato: 40,
    // Simula o que o Motor/pré-cálculo oficial poderia devolver (ex.: 50 fiscal se saldo permitir)
    valor_fiscal_oficial: 50,
    valor_nao_fiscal_oficial: 0,
    ...overrides
  };
}

describe('CDS-PAGAMENTO-MISTO-RECOMPOSICAO-FISCAL-03', { concurrency: false }, () => {
  it('documenta ponto de integração e sequência real do fechamento', () => {
    assert.equal(PONTO_INTEGRACAO_RECOMENDADO.camada, 'backend');
    assert.match(PONTO_INTEGRACAO_RECOMENDADO.servico, /criarVenda/);
    assert.equal(PONTO_INTEGRACAO_RECOMENDADO.altera_motor_fxnf, false);
    assert.equal(PONTO_INTEGRACAO_RECOMENDADO.altera_vendas_total, false);
    assert.ok(SEQUENCIA_FECHAMENTO_PDV.includes('pre_calcular_distribuicao'));
    assert.ok(SEQUENCIA_FECHAMENTO_PDV.includes('post_api_vendas'));
    assert.ok(SEQUENCIA_FECHAMENTO_PDV.includes('recalcular_motor_fxnf_oficial'));
    assert.ok(CONTRATO_MINIMO_PROXIMA_ETAPA.validacoes.length >= 5);
  });

  it('1) recebe dados de pagamento sem alterar objetos de entrada', () => {
    const snapshot = snapshotCenarioReferencia();
    const pagamentosAntes = JSON.stringify(snapshot.pagamentos);
    const itensAntes = JSON.stringify(snapshot.itens);

    const entrada = mapearSnapshotFechamentoPdvParaEntradaContrato(snapshot);
    const demo = demonstrarIntegracaoIsoladaFechamento(snapshot);

    assert.equal(JSON.stringify(snapshot.pagamentos), pagamentosAntes);
    assert.equal(JSON.stringify(snapshot.itens), itensAntes);
    assert.equal(entrada.pagamentos.length, 3);
    assert.equal(demo.contrato.pagamentos.length, 3);
    // mapping usa cópia — mutar entrada não altera snapshot
    entrada.pagamentos[0].valor = 999;
    assert.equal(snapshot.pagamentos[0].valor, 20);
  });

  it('2) preserva total comercial e financeiro de R$ 50,00', () => {
    const demo = demonstrarIntegracaoIsoladaFechamento(snapshotCenarioReferencia());
    assert.equal(demo.contrato.total_comercial, 50);
    assert.equal(demo.contrato.total_financeiro_recebido, 50);
    assert.equal(demo.contrato.altera_vendas_total, false);
  });

  it('3) valida candidato fiscal R$ 40,00 sem aplicação ao fluxo oficial', () => {
    const demo = demonstrarIntegracaoIsoladaFechamento(snapshotCenarioReferencia());
    assert.equal(demo.contrato.valor_fiscal_candidato, 40);
    assert.equal(demo.contrato.valor_nao_fiscal_candidato, 10);
    assert.equal(demo.contrato.aplica_ao_fluxo_oficial, false);
    assert.equal(demo.contrato.altera_motor_fxnf, false);
    assert.equal(demo.divergencia.aplica_candidato_ao_fluxo_oficial, false);
    assert.equal(demo.divergencia.divergente, true);
    assert.equal(demo.divergencia.valor_fiscal_oficial_pre_calculo, 50);
    assert.equal(demo.divergencia.body_valor_fiscal_ignorado_em_criar_venda, true);
  });

  it('4) bloqueia ativação em produção', () => {
    assert.equal(RECOMPOSICAO_HABILITADA_EM_PRODUCAO, false);
    assert.throws(
      () =>
        demonstrarIntegracaoIsoladaFechamento(
          snapshotCenarioReferencia({ habilitar_em_producao: true })
        ),
      (err) => err && err.code === 'RECOMPOSICAO_NAO_HABILITADA_EM_PRODUCAO'
    );
    const demo = demonstrarIntegracaoIsoladaFechamento(snapshotCenarioReferencia());
    assert.equal(demo.contrato.recomposicao_habilitada_em_producao, false);
    assert.equal(demo.efeitos_colaterais.alterou_fluxo_oficial, false);
    assert.equal(demo.efeitos_colaterais.conectou_criar_venda, false);
  });

  it('5) ausência de chamadas TEF e SEFAZ nos testes (efeitos + require guard)', () => {
    const modulosProibidos = new Set([
      'tef/TefManager',
      'tef/tefContrato',
      'fiscal/emissor',
      'nfeCentralService',
      'VendaFiscalService',
      'OrquestradorPagamento',
      'database'
    ]);
    const carregados = [];
    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
      const reqStr = String(request);
      for (const proibido of modulosProibidos) {
        if (reqStr.includes(proibido)) {
          carregados.push(reqStr);
        }
      }
      return originalLoad.apply(this, arguments);
    };

    try {
      // Re-requer proposta em caminho limpo via cache already loaded — demonstra
      // que a execução da demo não aciona providers externos.
      const demo = demonstrarIntegracaoIsoladaFechamento(snapshotCenarioReferencia());
      assert.equal(demo.efeitos_colaterais.chamou_tef, false);
      assert.equal(demo.efeitos_colaterais.chamou_sefaz, false);
      assert.equal(demo.efeitos_colaterais.escreveu_banco, false);
      assert.deepEqual(carregados, []);
    } finally {
      Module._load = originalLoad;
    }
  });

  it('risco: integrar só no pré-cálculo diverge do Motor em criarVenda', () => {
    const contrato = {
      valor_fiscal_candidato: 40,
      total_comercial: 50
    };
    const div = avaliarDivergenciaPreCalculoOficialVsCandidato(
      { valor_fiscal: 50, valor_nao_fiscal: 0 },
      contrato
    );
    assert.equal(div.divergente, true);
    assert.match(div.risco, /Integrar só no PDV/);
  });

  it('quando oficial e candidato coincidem, divergência é falsa', () => {
    const div = avaliarDivergenciaPreCalculoOficialVsCandidato(
      { valor_fiscal: 40, valor_nao_fiscal: 10 },
      { valor_fiscal_candidato: 40 }
    );
    assert.equal(div.divergente, false);
  });
});
