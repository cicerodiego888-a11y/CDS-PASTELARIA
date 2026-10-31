/**
 * CDS — PAGAMENTO MISTO E RECOMPOSIÇÃO FISCAL — 13
 * Integração controlada da regra de recomposição (Sprint 12) ao fechamento real.
 *
 * Executar:
 *   node --test tests/vendas/cds-pagamento-misto-recomposicao-fiscal-13.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');

const {
  PONTO_INTEGRACAO_FECHAMENTO,
  resolverDiagnosticoInternoParaFechamento,
  executarDiagnosticoRecomposicaoNoFechamento,
  resolverContextoComposicaoNoFechamento
} = require('../../backend/services/vendas/RecomposicaoFiscalFechamentoAdaptadorService');

const { obterContextoComposicaoPdvParaDiagnostico } = require(
  '../../backend/services/vendas/PedidoPdvComposicaoService'
);

const { calcularMargemToleranciaDinheiro } = require(
  '../../backend/services/vendas/RecomposicaoFiscalToleranciaDinheiroSimulacaoService'
);

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

const ITENS_50 = [{ produto_id: 99, quantidade: 5, subtotal: 50 }];

/** Contexto controlado derivado do contrato do mecanismo existente (mesmo shape PDV). */
function contextoControladoDoMecanismo() {
  return {
    modelos: [modeloPrecoFixo(1, 1000, 5)],
    capacidade_por_categoria: { REFRIGERANTE: 100 },
    fonte_modelos: 'PedidoPdvComposicaoService.carregarModelosRefrigerante'
  };
}

async function hookFechamento(opcoes = {}) {
  const diagnosticoInterno = resolverDiagnosticoInternoParaFechamento({
    harnessReq: opcoes.harnessReq != null ? opcoes.harnessReq : null,
    env: opcoes.env || {}
  });
  return executarDiagnosticoRecomposicaoNoFechamento({
    totalComercial: opcoes.totalComercial != null ? opcoes.totalComercial : 50,
    pagamentos: opcoes.pagamentos || PAGAMENTOS_50.map((p) => ({ ...p })),
    itens: opcoes.itens || ITENS_50.map((i) => ({ ...i })),
    diagnosticoInterno,
    pedidoId: opcoes.pedidoId,
    empresaId: opcoes.empresaId,
    db: opcoes.db,
    residualCentavos: opcoes.residualCentavos,
    carregarContextoComposicao: opcoes.carregarContextoComposicao
  });
}

describe('CDS-PAGAMENTO-MISTO-RECOMPOSICAO-FISCAL-13', { concurrency: false }, () => {
  it('documenta ponto de integração e origem PDV no fechamento', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'backend/services/vendas/VendaPagamentoService.js'),
      'utf8'
    );
    assert.ok(src.includes('executarDiagnosticoRecomposicaoNoFechamento'));
    assert.ok(src.includes('pedidoId: pedidoIdVenda'));
    assert.ok(src.includes('empresaId: empresaIdVenda'));
    assert.equal(PONTO_INTEGRACAO_FECHAMENTO.funcao, 'criarVenda');
    assert.ok(
      String(PONTO_INTEGRACAO_FECHAMENTO.origem_modelos_sprint_13 || '')
        .includes('carregarModelosRefrigerante')
    );
    assert.equal(typeof obterContextoComposicaoPdvParaDiagnostico, 'function');
  });

  it('1) composição válida — regra Sprint 12 aplicada no fechamento', async () => {
    const ctx = contextoControladoDoMecanismo();
    const margem = calcularMargemToleranciaDinheiro(PAGAMENTOS_50);
    assert.equal(margem.margem_maxima, 2);

    const diag = await hookFechamento({
      harnessReq: {
        valor_fiscal_candidato: 40,
        modelos: ctx.modelos,
        capacidade_por_categoria: ctx.capacidade_por_categoria,
        fonte_modelos: ctx.fonte_modelos
      }
    });

    assert.equal(diag.solicitado, true);
    assert.equal(diag.evento, 'composicao_encontrada');
    assert.equal(diag.status_simulacao, 'EXATA');
    assert.equal(diag.substitui_motor_fxnf, false);
    assert.equal(diag.alterou_fechamento, false);
    assert.equal(diag.proposta.proposta.valor_composicao_simulada, 40);
    assert.equal(diag.proposta.proposta.margem_matematica, 2);
    assert.equal(diag.proposta.proposta.valor_fiscal_oficial_determinado_por_esta_proposta, false);
    assert.equal(diag.origem_modelos, ctx.fonte_modelos);
    assert.ok(diag.mapeamento_composicao);
    assert.equal(diag.mapeamento_composicao.nao_reescreve_itens_da_venda, true);
    assert.equal(diag.mapeamento_composicao.nao_autoriza_fiscal, true);
    assert.ok(diag.mapeamento_composicao.itens_proposta.length >= 1);
    assert.equal(diag.mapeamento_composicao.itens_proposta[0].produto_id, 1);
    assert.equal(diag.mapeamento_composicao.itens_proposta[0].quantidade, 4);
  });

  it('2) margem de tolerância — 41,90 / margem 2 / composição 40 sem desconto fiscal', async () => {
    const ctx = contextoControladoDoMecanismo();
    const diag = await hookFechamento({
      harnessReq: {
        valor_fiscal_candidato: 41.9,
        modelos: ctx.modelos,
        capacidade_por_categoria: ctx.capacidade_por_categoria
      }
    });

    assert.equal(diag.evento, 'composicao_encontrada');
    assert.equal(diag.status_simulacao, 'COMPATIVEL_MARGEM');
    assert.equal(diag.proposta.proposta.valor_candidato_simulacao, 41.9);
    assert.equal(diag.proposta.proposta.valor_composicao_simulada, 40);
    assert.ok(Math.abs(diag.proposta.proposta.diferenca_composicao - 1.9) < 1e-9);
    assert.equal(diag.proposta.proposta.margem_matematica, 2);
    assert.equal(diag.aplicou_desconto, false);
    assert.equal(diag.proposta.preservacao.nao_aplicou_desconto, true);
    assert.equal(diag.proposta.proposta.valor_fiscal_oficialmente_autorizado, null);
    assert.equal(diag.mapeamento_composicao.diferenca_nao_e_desconto, true);
  });

  it('3) composição incompatível — 35 / margem 2 sem alteração do fechamento', async () => {
    const ctx = contextoControladoDoMecanismo();
    const pagamentos = PAGAMENTOS_50.map((p) => ({ ...p }));
    const itens = ITENS_50.map((i) => ({ ...i }));
    const snap = JSON.stringify({ pagamentos, itens });

    const diag = await hookFechamento({
      pagamentos,
      itens,
      harnessReq: {
        valor_fiscal_candidato: 35,
        modelos: ctx.modelos,
        capacidade_por_categoria: ctx.capacidade_por_categoria
      }
    });

    assert.equal(diag.evento, 'composicao_incompativel');
    assert.ok(
      diag.status_simulacao === 'SEM_COMPOSICAO' || diag.status_simulacao === 'INCOMPATIVEL'
    );
    assert.equal(diag.alterou_fechamento, false);
    assert.equal(diag.substitui_motor_fxnf, false);
    assert.equal(diag.aplicou_desconto, false);
    assert.equal(JSON.stringify({ pagamentos, itens }), snap);
  });

  it('4) contexto insuficiente — não inventa modelos/cotações/capacidades', async () => {
    const cargaVazia = async () => Object.freeze({
      suficiente: false,
      motivo: 'pedido_id_ausente',
      origem: 'PedidoPdvComposicaoService.carregarModelosRefrigerante',
      modelos: [],
      capacidade_por_categoria: {}
    });

    const diag = await hookFechamento({
      harnessReq: { valor_fiscal_candidato: 40 },
      carregarContextoComposicao: cargaVazia
    });

    assert.equal(diag.evento, 'contexto_composicao_insuficiente');
    assert.equal(diag.alterou_fechamento, false);
    assert.equal(diag.substitui_motor_fxnf, false);
    assert.equal(diag.contexto_composicao.suficiente, false);
    assert.ok(
      String(diag.origem_modelos || '').includes('carregarModelosRefrigerante')
      || String(diag.contexto_composicao.origem || '').includes('carregarModelosRefrigerante')
    );

    // Sem empresa: não inventa (pedido_id opcional desde Sprint 14 — balcão)
    const semEmpresa = await obterContextoComposicaoPdvParaDiagnostico({
      empresaId: null,
      pedidoId: null,
      residualCentavos: 5000,
      db: {}
    });
    assert.equal(semEmpresa.suficiente, false);
    assert.equal(semEmpresa.motivo, 'empresa_id_ausente');
    assert.equal(semEmpresa.modelos.length, 0);
  });

  it('5) regra desabilitada — comportamento legado preservado', async () => {
    const diag = await hookFechamento({ env: {}, harnessReq: null });
    assert.equal(diag.solicitado, false);
    assert.equal(diag.evento, 'diagnostico_nao_solicitado');
    assert.equal(diag.substitui_motor_fxnf, false);
    assert.equal(diag.alterou_fechamento, false);

    // Frontend não autoriza
    const viaBody = resolverDiagnosticoInternoParaFechamento({
      harnessReq: null,
      env: {}
    });
    assert.equal(viaBody, null);
  });

  it('6) integridade financeira — total 50 e pagamentos preservados', async () => {
    const ctx = contextoControladoDoMecanismo();
    const pagamentos = PAGAMENTOS_50.map((p) => ({ ...p }));
    const itens = ITENS_50.map((i) => ({ ...i }));
    const antesPag = JSON.stringify(pagamentos);
    const antesItens = JSON.stringify(itens);

    const diag = await hookFechamento({
      totalComercial: 50,
      pagamentos,
      itens,
      harnessReq: {
        valor_fiscal_candidato: 41.9,
        modelos: ctx.modelos,
        capacidade_por_categoria: ctx.capacidade_por_categoria
      }
    });

    assert.equal(diag.proposta.proposta.total_comercial, 50);
    assert.equal(diag.proposta.preservacao.total_comercial_preservado, true);
    assert.equal(diag.proposta.preservacao.nao_alterou_pagamentos, true);
    assert.equal(JSON.stringify(pagamentos), antesPag);
    assert.equal(JSON.stringify(itens), antesItens);
    assert.equal(diag.aplicou_desconto, false);
  });

  it('7) integridade operacional — proposta não provoca TEF/estoque/escrita', async () => {
    const ctx = contextoControladoDoMecanismo();
    let cargaChamadas = 0;
    const diag = await hookFechamento({
      harnessReq: {
        valor_fiscal_candidato: 40,
        modelos: ctx.modelos,
        capacidade_por_categoria: ctx.capacidade_por_categoria
      },
      carregarContextoComposicao: async () => {
        cargaChamadas += 1;
        throw new Error('não deve carregar quando harness já tem modelos');
      }
    });

    assert.equal(cargaChamadas, 0);
    assert.equal(diag.chama_tef, false);
    assert.equal(diag.movimentou_estoque, false);
    assert.equal(diag.persistencia_executada, false);
    assert.equal(diag.emissao_fiscal_autorizada, false);
    assert.equal(diag.proposta.chama_tef, false);
    assert.equal(diag.proposta.chama_sefaz, false);
    assert.equal(diag.proposta.persistencia_executada, false);
  });

  it('8) isolamento de falhas — erro na proposta não altera Motor F×NF', async () => {
    const motorOficial = { valorFiscalLiquido: 50, fonte: 'FXNF' };
    const pagamentos = [{ forma_pagamento: 'debito', valor: 10 }];
    const itens = ITENS_50.map((i) => ({ ...i }));
    const snap = JSON.stringify({ pagamentos, itens, motor: motorOficial });

    const diag = await hookFechamento({
      totalComercial: 50,
      pagamentos,
      itens,
      harnessReq: {
        valor_fiscal_candidato: 40,
        modelos: [modeloPrecoFixo(1, 1000, 5)],
        capacidade_por_categoria: { REFRIGERANTE: 100 }
      }
    });

    assert.equal(diag.evento, 'erro_isolado');
    assert.equal(diag.codigo, 'SOMA_PAGAMENTOS_DIVERGENTE');
    assert.equal(diag.alterou_fechamento, false);
    assert.equal(diag.substitui_motor_fxnf, false);
    assert.equal(motorOficial.valorFiscalLiquido, 50);
    assert.equal(JSON.stringify({ pagamentos, itens, motor: motorOficial }), snap);
  });

  it('carga do pedido — resolver usa fonte PDV injetável sem inventar', async () => {
    const modelos = [modeloPrecoFixo(7, 1000, 5)];
    const ctx = await resolverContextoComposicaoNoFechamento({
      diagnosticoInterno: {},
      empresaId: 1,
      pedidoId: 42,
      residualCentavos: 5000,
      db: { fake: true },
      carregarContextoComposicao: async (args) => {
        assert.equal(args.empresaId, 1);
        assert.equal(args.pedidoId, 42);
        assert.equal(args.residualCentavos, 5000);
        return {
          suficiente: true,
          origem: 'PedidoPdvComposicaoService.carregarModelosRefrigerante',
          modelos,
          capacidade_por_categoria: { REFRIGERANTE: 80 }
        };
      }
    });
    assert.equal(ctx.suficiente, true);
    assert.equal(ctx.carregado_do_pedido, true);
    assert.equal(ctx.modelos[0].produtoId, 7);

    const diag = await hookFechamento({
      harnessReq: { valor_fiscal_candidato: 40 },
      empresaId: 1,
      pedidoId: 42,
      db: { fake: true },
      carregarContextoComposicao: async () => ({
        suficiente: true,
        origem: 'PedidoPdvComposicaoService.carregarModelosRefrigerante',
        modelos,
        capacidade_por_categoria: { REFRIGERANTE: 80 }
      })
    });
    assert.equal(diag.evento, 'composicao_encontrada');
    assert.equal(diag.contexto_composicao.carregado_do_pedido, true);
    assert.equal(diag.mapeamento_composicao.itens_proposta[0].produto_id, 7);
  });
});
