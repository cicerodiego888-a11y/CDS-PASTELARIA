/**
 * CDS — PAGAMENTO MISTO E RECOMPOSIÇÃO FISCAL — 14
 * Contexto real de composição para venda de balcão (sem pedido_id).
 *
 * Executar:
 *   node --test tests/vendas/cds-pagamento-misto-recomposicao-fiscal-14.test.js
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

function modeloPrecoFixo(produtoId, precoCentavos, quantidadeMaxima = 10, empresaTag = null) {
  return {
    produtoId,
    nome: `Produto ${produtoId}`,
    categoriaFiscal: 'REFRIGERANTE',
    volumeMlPorUnidade: 1,
    quantidadeMaxima,
    empresa_tag: empresaTag,
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

/**
 * Simula a carga oficial por empresa (mesmo contrato de carregarModelosRefrigerante).
 * Isola por empresaId — não inventa catálogo cruzado.
 */
function carregarContextoOficialPorEmpresa(catalogoPorEmpresa) {
  return async (args) => {
    const empresaId = Number(args.empresaId);
    const pedidoId = args.pedidoId != null && Number(args.pedidoId) > 0
      ? Number(args.pedidoId)
      : null;
    const modo = pedidoId != null ? 'pedido' : 'balcao';
    const entrada = catalogoPorEmpresa[empresaId];
    if (!entrada || !Array.isArray(entrada.modelos) || !entrada.modelos.length) {
      return Object.freeze({
        suficiente: false,
        motivo: 'modelos_vazios_apos_carga',
        origem: 'PedidoPdvComposicaoService.carregarModelosRefrigerante',
        modo,
        empresa_id: Number.isInteger(empresaId) && empresaId > 0 ? empresaId : null,
        pedido_id: pedidoId,
        modelos: [],
        capacidade_por_categoria: {}
      });
    }
    return Object.freeze({
      suficiente: true,
      motivo: null,
      origem: 'PedidoPdvComposicaoService.carregarModelosRefrigerante',
      modo,
      empresa_id: empresaId,
      pedido_id: pedidoId,
      modelos: entrada.modelos,
      capacidade_por_categoria: Object.freeze({
        REFRIGERANTE: entrada.capacidadeMl
      }),
      capacidadeMl: entrada.capacidadeMl
    });
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

describe('CDS-PAGAMENTO-MISTO-RECOMPOSICAO-FISCAL-14', { concurrency: false }, () => {
  it('documenta balcão sem pedido_id e fonte existente', () => {
    assert.ok(
      String(PONTO_INTEGRACAO_FECHAMENTO.origem_modelos_sprint_14 || '')
        .includes('carregarModelosRefrigerante')
    );
    const srcPdv = fs.readFileSync(
      path.join(ROOT, 'backend/services/vendas/PedidoPdvComposicaoService.js'),
      'utf8'
    );
    assert.ok(srcPdv.includes("modo = pedidoId != null ? 'pedido' : 'balcao'"));
    const srcVenda = fs.readFileSync(
      path.join(ROOT, 'backend/services/vendas/VendaPagamentoService.js'),
      'utf8'
    );
    assert.ok(srcVenda.includes('empresaId: empresaIdVenda'));
    assert.ok(srcVenda.includes('pedidoId: pedidoIdVenda'));
  });

  it('1) balcão sem pedido_id — recupera modelos com empresa+db via mecanismo existente', async () => {
    const modelos = [modeloPrecoFixo(10, 1000, 5, 'emp-7')];
    const carregar = carregarContextoOficialPorEmpresa({
      7: { modelos, capacidadeMl: 100 }
    });

    const ctx = await resolverContextoComposicaoNoFechamento({
      diagnosticoInterno: {},
      empresaId: 7,
      pedidoId: null,
      residualCentavos: 5000,
      db: { fake: true },
      carregarContextoComposicao: carregar
    });

    assert.equal(ctx.suficiente, true);
    assert.equal(ctx.modo, 'balcao');
    assert.equal(ctx.carregado_do_balcao, true);
    assert.equal(ctx.carregado_do_pedido, false);
    assert.equal(ctx.empresa_id, 7);
    assert.equal(ctx.pedido_id, null);
    assert.equal(ctx.modelos[0].produtoId, 10);
    assert.equal(ctx.capacidade_por_categoria.REFRIGERANTE, 100);
    assert.ok(String(ctx.origem).includes('carregarModelosRefrigerante'));

    const diag = await hookFechamento({
      harnessReq: { valor_fiscal_candidato: 40 },
      empresaId: 7,
      pedidoId: null,
      db: { fake: true },
      carregarContextoComposicao: carregar
    });
    assert.equal(diag.evento, 'composicao_encontrada');
    assert.equal(diag.contexto_composicao.carregado_do_balcao, true);
    assert.equal(diag.contexto_composicao.empresa_id, 7);
    assert.equal(diag.contexto_composicao.pedido_id, null);
    assert.equal(diag.substitui_motor_fxnf, false);
  });

  it('2) recupera modelos pelo mecanismo existente (obterContexto permite balcão)', async () => {
    const semPedido = await obterContextoComposicaoPdvParaDiagnostico({
      empresaId: 3,
      pedidoId: null,
      residualCentavos: 5000,
      db: { fake: true },
      // força caminho: sem mock interno — db fake falha na query e retorna insuficiente
    });
    // Sem schema real: não inventa modelos; bloqueia só a proposta
    assert.equal(semPedido.suficiente, false);
    assert.equal(semPedido.modo, 'balcao');
    assert.equal(semPedido.empresa_id, 3);
    assert.equal(semPedido.pedido_id, null);
    assert.equal(semPedido.modelos.length, 0);
    assert.ok(
      semPedido.motivo === 'erro_carga_modelos_refrigerante'
      || semPedido.motivo === 'modelos_vazios_apos_carga'
    );
  });

  it('3) respeita a empresa da venda — não cruza catálogo', async () => {
    const carregar = carregarContextoOficialPorEmpresa({
      1: { modelos: [modeloPrecoFixo(1, 1000, 5, 'e1')], capacidadeMl: 50 },
      2: { modelos: [modeloPrecoFixo(2, 1000, 5, 'e2')], capacidadeMl: 80 }
    });

    const ctx1 = await resolverContextoComposicaoNoFechamento({
      empresaId: 1,
      pedidoId: null,
      db: {},
      residualCentavos: 5000,
      carregarContextoComposicao: carregar
    });
    const ctx2 = await resolverContextoComposicaoNoFechamento({
      empresaId: 2,
      pedidoId: null,
      db: {},
      residualCentavos: 5000,
      carregarContextoComposicao: carregar
    });

    assert.equal(ctx1.empresa_id, 1);
    assert.equal(ctx1.modelos[0].produtoId, 1);
    assert.equal(ctx1.modelos[0].empresa_tag, 'e1');
    assert.equal(ctx2.empresa_id, 2);
    assert.equal(ctx2.modelos[0].produtoId, 2);
    assert.equal(ctx2.capacidade_por_categoria.REFRIGERANTE, 80);
  });

  it('4) cotações e capacidades reais do contexto — usadas na composição', async () => {
    const modelos = [modeloPrecoFixo(5, 1000, 5)];
    const diag = await hookFechamento({
      harnessReq: { valor_fiscal_candidato: 41.9 },
      empresaId: 9,
      pedidoId: null,
      db: { fake: true },
      carregarContextoComposicao: carregarContextoOficialPorEmpresa({
        9: { modelos, capacidadeMl: 120 }
      })
    });
    assert.equal(diag.evento, 'composicao_encontrada');
    assert.equal(diag.status_simulacao, 'COMPATIVEL_MARGEM');
    assert.equal(diag.proposta.proposta.valor_composicao_simulada, 40);
    assert.equal(diag.proposta.proposta.margem_matematica, 2);
    assert.equal(diag.aplicou_desconto, false);
    assert.equal(diag.mapeamento_composicao.itens_proposta[0].quantidade, 4);
  });

  it('5) ausência de modelos/contexto — recomposição não realizada, sem inventar', async () => {
    const diag = await hookFechamento({
      harnessReq: { valor_fiscal_candidato: 40 },
      empresaId: 99,
      pedidoId: null,
      db: { fake: true },
      carregarContextoComposicao: carregarContextoOficialPorEmpresa({})
    });
    assert.equal(diag.evento, 'contexto_composicao_insuficiente');
    assert.equal(diag.alterou_fechamento, false);
    assert.equal(diag.substitui_motor_fxnf, false);
    assert.equal(diag.contexto_composicao.suficiente, false);

    const semEmpresa = await obterContextoComposicaoPdvParaDiagnostico({
      empresaId: null,
      pedidoId: null,
      residualCentavos: 5000,
      db: {}
    });
    assert.equal(semEmpresa.motivo, 'empresa_id_ausente');
    assert.equal(semEmpresa.modelos.length, 0);
  });

  it('6) venda com pedido_id — comportamento anterior preservado', async () => {
    const modelos = [modeloPrecoFixo(42, 1000, 5)];
    const diag = await hookFechamento({
      harnessReq: { valor_fiscal_candidato: 40 },
      empresaId: 1,
      pedidoId: 55,
      db: { fake: true },
      carregarContextoComposicao: carregarContextoOficialPorEmpresa({
        1: { modelos, capacidadeMl: 100 }
      })
    });
    assert.equal(diag.evento, 'composicao_encontrada');
    assert.equal(diag.contexto_composicao.modo, 'pedido');
    assert.equal(diag.contexto_composicao.carregado_do_pedido, true);
    assert.equal(diag.contexto_composicao.carregado_do_balcao, false);
    assert.equal(diag.contexto_composicao.pedido_id, 55);
    assert.equal(diag.mapeamento_composicao.itens_proposta[0].produto_id, 42);
  });

  it('7) integridade financeira — total e pagamentos preservados no balcão', async () => {
    const pagamentos = PAGAMENTOS_50.map((p) => ({ ...p }));
    const itens = ITENS_50.map((i) => ({ ...i }));
    const antes = JSON.stringify({ pagamentos, itens });

    const diag = await hookFechamento({
      totalComercial: 50,
      pagamentos,
      itens,
      harnessReq: { valor_fiscal_candidato: 40 },
      empresaId: 1,
      pedidoId: null,
      db: {},
      carregarContextoComposicao: carregarContextoOficialPorEmpresa({
        1: { modelos: [modeloPrecoFixo(1, 1000, 5)], capacidadeMl: 100 }
      })
    });

    assert.equal(diag.proposta.proposta.total_comercial, 50);
    assert.equal(diag.proposta.preservacao.total_comercial_preservado, true);
    assert.equal(diag.proposta.preservacao.nao_alterou_pagamentos, true);
    assert.equal(JSON.stringify({ pagamentos, itens }), antes);
  });

  it('8) Motor F×NF / estoque / TEF / emissão — inalterados pela proposta', async () => {
    const motorOficial = { valorFiscalLiquido: 50, fonte: 'FXNF' };
    const diag = await hookFechamento({
      harnessReq: { valor_fiscal_candidato: 40 },
      empresaId: 1,
      pedidoId: null,
      db: {},
      carregarContextoComposicao: carregarContextoOficialPorEmpresa({
        1: { modelos: [modeloPrecoFixo(1, 1000, 5)], capacidadeMl: 100 }
      })
    });

    assert.equal(diag.substitui_motor_fxnf, false);
    assert.equal(diag.alterou_fechamento, false);
    assert.equal(diag.chama_tef, false);
    assert.equal(diag.movimentou_estoque, false);
    assert.equal(diag.persistencia_executada, false);
    assert.equal(diag.emissao_fiscal_autorizada, false);
    assert.equal(diag.proposta.chama_tef, false);
    assert.equal(diag.proposta.chama_sefaz, false);
    assert.equal(motorOficial.valorFiscalLiquido, 50);

    // Sem candidato: legado intacto
    const legado = await hookFechamento({
      env: {},
      harnessReq: null,
      empresaId: 1,
      pedidoId: null,
      db: {}
    });
    assert.equal(legado.evento, 'diagnostico_nao_solicitado');
    assert.equal(resolverDiagnosticoInternoParaFechamento({ env: {} }), null);
  });
});
