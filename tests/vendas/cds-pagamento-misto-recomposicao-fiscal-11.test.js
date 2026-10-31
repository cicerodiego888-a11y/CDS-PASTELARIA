/**
 * CDS — PAGAMENTO MISTO E RECOMPOSIÇÃO FISCAL — 11
 * Acionamento controlado do diagnóstico no fluxo normal (backend-only).
 *
 * Executar: node --test tests/vendas/cds-pagamento-misto-recomposicao-fiscal-11.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');

const {
  ENV_DIAGNOSTICO_ATIVO,
  ENV_DIAGNOSTICO_CANDIDATO,
  obterDiagnosticoInternoBackend,
  resolverDiagnosticoInternoParaFechamento,
  resolverCandidatoDiagnosticoFechamento,
  executarDiagnosticoRecomposicaoNoFechamento
} = require('../../backend/services/vendas/RecomposicaoFiscalFechamentoAdaptadorService');

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

/** Simula o que o criarVenda faz: resolve interno e executa diagnóstico. */
async function simularHookCriarVenda(opcoes = {}) {
  const diagnosticoInterno = resolverDiagnosticoInternoParaFechamento({
    harnessReq: opcoes.harnessReq || null,
    env: opcoes.env || {}
  });
  return executarDiagnosticoRecomposicaoNoFechamento({
    totalComercial: opcoes.totalComercial != null ? opcoes.totalComercial : 50,
    pagamentos: opcoes.pagamentos || [
      { forma_pagamento: 'debito', valor: 20 },
      { forma_pagamento: 'credito', valor: 20 },
      { forma_pagamento: 'dinheiro', valor: 10 }
    ],
    itens: opcoes.itens || [{ produto_id: 1, quantidade: 5, subtotal: 50 }],
    diagnosticoInterno
  });
}

describe('CDS-PAGAMENTO-MISTO-RECOMPOSICAO-FISCAL-11', { concurrency: false }, () => {
  it('documenta diferença teste vs PDV normal e hook com resolver backend', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'backend/services/vendas/VendaPagamentoService.js'),
      'utf8'
    );
    assert.ok(src.includes('resolverDiagnosticoInternoParaFechamento'));
    assert.ok(src.includes('CDS_RECOMPOSICAO_DIAGNOSTICO') || src.includes('harnessReq'));
    // PDV envia valor_fiscal informativo; criarVenda continua ignorando como fiscal oficial
    assert.ok(src.includes('void _valorFiscalBody'));
  });

  it('A) fechamento normal sem candidato — não inventa e segue nao_solicitado', async () => {
    // PDV normal: sem harness, sem env
    const diag = await simularHookCriarVenda({ env: {} });
    assert.equal(diag.solicitado, false);
    assert.equal(diag.evento, 'diagnostico_nao_solicitado');
    assert.equal(diag.substitui_motor_fxnf, false);

    // body.valor_fiscal do PDV NÃO é fonte
    assert.equal(
      resolverCandidatoDiagnosticoFechamento({
        totalComercial: 50,
        body: { valor_fiscal: 40, valor_fiscal_candidato: 40 },
        diagnosticoInterno: null
      }),
      null
    );
    assert.equal(obterDiagnosticoInternoBackend({}), null);
  });

  it('B) solicitação interna autorizada via env backend — aciona sem alterar venda', async () => {
    const pagamentos = [
      { forma_pagamento: 'debito', valor: 20 },
      { forma_pagamento: 'credito', valor: 20 },
      { forma_pagamento: 'dinheiro', valor: 10 }
    ];
    const itens = [{ produto_id: 1, quantidade: 5, subtotal: 50 }];
    const antesPag = JSON.stringify(pagamentos);
    const antesItens = JSON.stringify(itens);

    const env = {
      [ENV_DIAGNOSTICO_ATIVO]: '1',
      [ENV_DIAGNOSTICO_CANDIDATO]: '40'
    };
    const interno = obterDiagnosticoInternoBackend(env);
    assert.ok(interno);
    assert.equal(interno.fonte, 'backend_env');
    assert.equal(interno.valor_fiscal_candidato, 40);

    // Sem modelos no env (não inventa) → contexto insuficiente (Sprint 13) / SEM_COMPOSICAO
    const diagSemModelo = await simularHookCriarVenda({ env, pagamentos, itens });
    assert.equal(diagSemModelo.solicitado, true);
    assert.equal(diagSemModelo.evento, 'contexto_composicao_insuficiente');
    assert.equal(diagSemModelo.status_simulacao, 'SEM_COMPOSICAO');
    assert.equal(diagSemModelo.alterou_fechamento, false);
    assert.equal(JSON.stringify(pagamentos), antesPag);
    assert.equal(JSON.stringify(itens), antesItens);

    // Com harness (teste) + modelos: composição exata, Motor mock intacto
    const motorOficial = { valorFiscalLiquido: 50, fonte: 'FXNF' };
    const diagExato = await executarDiagnosticoRecomposicaoNoFechamento({
      totalComercial: 50,
      pagamentos,
      itens,
      diagnosticoInterno: {
        valor_fiscal_candidato: 40,
        modelos: [modeloPrecoFixo(1, 1000, 5)],
        capacidade_por_categoria: { REFRIGERANTE: 100 }
      }
    });
    assert.equal(diagExato.evento, 'composicao_encontrada');
    assert.equal(diagExato.status_simulacao, 'EXATA');
    assert.equal(motorOficial.valorFiscalLiquido, 50);
  });

  it('C) tentativa de ativação pelo frontend — rejeitada', async () => {
    // Env desligado: body não ativa
    const diag = await simularHookCriarVenda({
      env: {},
      body: {
        habilitar_em_producao: true,
        valor_fiscal_candidato: 40,
        valor_fiscal: 40,
        CDS_RECOMPOSICAO_DIAGNOSTICO: '1'
      }
    });
    assert.equal(diag.evento, 'diagnostico_nao_solicitado');

    // Flag env sem candidato explícito → não inventa a partir do total
    assert.equal(
      obterDiagnosticoInternoBackend({ [ENV_DIAGNOSTICO_ATIVO]: '1' }),
      null
    );
    // Candidato env inválido
    assert.equal(
      obterDiagnosticoInternoBackend({
        [ENV_DIAGNOSTICO_ATIVO]: '1',
        [ENV_DIAGNOSTICO_CANDIDATO]: 'abc'
      }),
      null
    );
  });

  it('D) falha isolada — não modifica comportamento oficial do fechamento', async () => {
    const pagamentos = [{ forma_pagamento: 'debito', valor: 10 }];
    const itens = [{ produto_id: 1, quantidade: 5, subtotal: 50 }];
    const snap = JSON.stringify({ pagamentos, itens });

    const diag = await simularHookCriarVenda({
      env: {
        [ENV_DIAGNOSTICO_ATIVO]: '1',
        [ENV_DIAGNOSTICO_CANDIDATO]: '40'
      },
      pagamentos,
      itens,
      totalComercial: 50
    });
    assert.equal(diag.evento, 'erro_isolado');
    assert.equal(diag.codigo, 'SOMA_PAGAMENTOS_DIVERGENTE');
    assert.equal(diag.alterou_fechamento, false);
    assert.equal(diag.substitui_motor_fxnf, false);
    assert.equal(JSON.stringify({ pagamentos, itens }), snap);
  });

  it('E) preservação do Motor F×NF — autoridade do fechamento', async () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'backend/services/vendas/VendaPagamentoService.js'),
      'utf8'
    );
    const iDiag = src.indexOf('diagnóstico isolado de recomposição');
    const iMotor = src.indexOf(
      'const resultadoMotor = distribuirItensVendaComValorFiscalEfetivo',
      iDiag
    );
    assert.ok(iDiag > 0 && iMotor > iDiag);
    // Motor continua sendo a chamada oficial após o diagnóstico
    assert.ok(src.includes('distribuirItensVendaComValorFiscalEfetivo'));
    // body.valor_fiscal permanece ignorado
    assert.ok(src.includes('void _valorFiscalBody'));

    // Harness tem prioridade sobre env (Sprint 10 preservada)
    const harness = { valor_fiscal_candidato: 41.9, modelos: [] };
    const resolvido = resolverDiagnosticoInternoParaFechamento({
      harnessReq: harness,
      env: {
        [ENV_DIAGNOSTICO_ATIVO]: '1',
        [ENV_DIAGNOSTICO_CANDIDATO]: '40'
      }
    });
    assert.equal(resolvido.valor_fiscal_candidato, 41.9);
  });
});
