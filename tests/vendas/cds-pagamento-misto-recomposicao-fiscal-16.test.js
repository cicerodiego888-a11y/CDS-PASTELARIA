/**
 * CDS — PAGAMENTO MISTO E RECOMPOSIÇÃO FISCAL — 16
 * Preparação final para o primeiro teste real (modos explícitos + rollback).
 *
 * Executar:
 *   node --test tests/vendas/cds-pagamento-misto-recomposicao-fiscal-16.test.js
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
  ENV_HOMOLOGACAO_ATIVA,
  ENV_APLICAR_DISTRIBUICAO,
  MODOS_OPERACIONAIS,
  RUNBOOK_TESTE_REAL_PDV,
  obterAtivacaoHomologacaoInterna,
  resolverModoOperacionalRecomposicao,
  resolverDiagnosticoInternoParaFechamento,
  avaliarCompatibilidadeComItensVendidos,
  montarRelatorioOperacionalRecomposicao,
  executarAtivacaoControladaRecomposicaoNoFechamento,
  resolverContextoComposicaoNoFechamento
} = require('../../backend/services/vendas/RecomposicaoFiscalFechamentoAdaptadorService');

const { distribuirItensVendaComValorFiscalEfetivo } = require(
  '../../backend/services/distribuidorEstoqueVenda'
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

const ITENS_VENDA = [
  { produto_id: 100, quantidade: 5, subtotal: 50, preco_unitario: 10 }
];

const MODELOS = [modeloPrecoFixo(1, 1000, 5)];
const CAP = { REFRIGERANTE: 100 };

function motorOficial() {
  return distribuirItensVendaComValorFiscalEfetivo(
    [{
      item: {
        produto_id: 100,
        quantidade: 5,
        preco_unitario: 10,
        subtotal: 50,
        unidade: 'UN'
      },
      saldoFiscal: 100,
      saldoNaoFiscal: 100
    }],
    true,
    { pagamentos: PAGAMENTOS_50.map((p) => ({ ...p })), midpAtivo: false }
  );
}

async function pipeline(opcoes = {}) {
  const harnessDiag = opcoes.semHarness
    ? null
    : {
      valor_fiscal_candidato: opcoes.candidato != null ? opcoes.candidato : 40,
      modelos: opcoes.modelos != null ? opcoes.modelos : MODELOS,
      capacidade_por_categoria: opcoes.capacidade != null ? opcoes.capacidade : CAP,
      fonte_modelos: 'PedidoPdvComposicaoService.carregarModelosRefrigerante'
    };
  if (opcoes.semModelos && harnessDiag) {
    harnessDiag.modelos = [];
  }

  return executarAtivacaoControladaRecomposicaoNoFechamento({
    totalComercial: 50,
    pagamentos: (opcoes.pagamentos || PAGAMENTOS_50).map((p) => ({ ...p })),
    itens: (opcoes.itens || ITENS_VENDA).map((i) => ({ ...i })),
    diagnosticoInterno: resolverDiagnosticoInternoParaFechamento({
      harnessReq: harnessDiag,
      env: opcoes.env || {}
    }),
    env: opcoes.env || {},
    harnessHomologacao: opcoes.harnessHomologacao != null
      ? opcoes.harnessHomologacao
      : { ativa: true },
    harnessAplicar: opcoes.harnessAplicar || null,
    forcarDiagnostico: opcoes.forcarDiagnostico !== false,
    resultadoMotorOficial: opcoes.resultadoMotorOficial != null
      ? opcoes.resultadoMotorOficial
      : motorOficial(),
    carregarContextoComposicao: opcoes.carregarContextoComposicao,
    empresaId: opcoes.empresaId,
    pedidoId: opcoes.pedidoId,
    db: opcoes.db
  });
}

describe('CDS-PAGAMENTO-MISTO-RECOMPOSICAO-FISCAL-16', { concurrency: false }, () => {
  it('documenta runbook e wiring operacional sem substituir Motor', () => {
    assert.equal(RUNBOOK_TESTE_REAL_PDV.cenario.total_comercial, 50);
    assert.equal(RUNBOOK_TESTE_REAL_PDV.cenario.candidato, 40);
    assert.ok(RUNBOOK_TESTE_REAL_PDV.ativar_teste.some((l) => l.includes('HOMOLOGACAO')));
    assert.ok(RUNBOOK_TESTE_REAL_PDV.desativar_teste.length >= 2);
    assert.equal(
      RUNBOOK_TESTE_REAL_PDV.interpretacao.distribuicao_aplicada.includes('false')
        || RUNBOOK_TESTE_REAL_PDV.interpretacao.distribuicao_aplicada.includes('Sempre false'),
      true
    );
    const src = fs.readFileSync(
      path.join(ROOT, 'backend/services/vendas/VendaPagamentoService.js'),
      'utf8'
    );
    assert.ok(src.includes('montarRelatorioOperacionalRecomposicao'));
    assert.ok(src.includes('[cds-recomposicao-operacional]'));
    assert.ok(src.includes('distribuicao_aplicada'));
  });

  it('1) ativação desabilitada por padrão', () => {
    const modo = resolverModoOperacionalRecomposicao({ env: {} });
    assert.equal(modo.modo_efetivo, MODOS_OPERACIONAIS.DESLIGADO);
    assert.equal(modo.distribuicao_aplicada, false);
    assert.equal(obterAtivacaoHomologacaoInterna({}).ativa, false);
  });

  it('2) ativação interna no ambiente de teste', () => {
    const env = {
      [ENV_DIAGNOSTICO_ATIVO]: '1',
      [ENV_DIAGNOSTICO_CANDIDATO]: '40',
      [ENV_HOMOLOGACAO_ATIVA]: '1'
    };
    const modo = resolverModoOperacionalRecomposicao({ env });
    assert.equal(modo.modo_efetivo, MODOS_OPERACIONAIS.HOMOLOGACAO);
    assert.equal(modo.candidato, 40);
    assert.equal(modo.permite_aplicar_distribuicao_oficial, false);
    assert.equal(modo.distribuicao_aplicada, false);
  });

  it('3) recuperação do contexto real da empresa (fonte existente)', async () => {
    const ctx = await resolverContextoComposicaoNoFechamento({
      diagnosticoInterno: {},
      empresaId: 3,
      pedidoId: null,
      residualCentavos: 5000,
      db: { fake: true },
      carregarContextoComposicao: async (args) => {
        assert.equal(args.empresaId, 3);
        return {
          suficiente: true,
          modo: 'balcao',
          empresa_id: 3,
          origem: 'PedidoPdvComposicaoService.carregarModelosRefrigerante',
          modelos: MODELOS,
          capacidade_por_categoria: CAP
        };
      }
    });
    assert.equal(ctx.suficiente, true);
    assert.equal(ctx.empresa_id, 3);
    assert.equal(ctx.carregado_do_balcao, true);
    assert.ok(String(ctx.origem).includes('carregarModelosRefrigerante'));
  });

  it('4) composição compatível com os itens vendidos', async () => {
    const out = await pipeline({ candidato: 40 });
    assert.equal(out.diagnostico.evento, 'composicao_encontrada');
    assert.equal(out.relatorio_operacional.proposta_calculada, true);
    assert.equal(out.relatorio_operacional.proposta_validada, true);
    const compat = out.relatorio_operacional.compatibilidade_itens_vendidos;
    assert.equal(compat.compativel, true);
    assert.equal(compat.proposta_reescreve_carrinho, false);
    assert.equal(compat.itens_venda_preservados, true);
    assert.equal(compat.itens_proposta[0].produto_id, 1);
    assert.equal(compat.itens_proposta[0].quantidade, 4);
    assert.equal(compat.valor_composicao, 40);
  });

  it('5) rejeição de composição incompatível', async () => {
    const out = await pipeline({ candidato: 35 });
    assert.equal(out.diagnostico.evento, 'composicao_incompativel');
    assert.equal(out.relatorio_operacional.proposta_calculada, false);
    assert.equal(out.relatorio_operacional.proposta_validada, false);
    assert.equal(out.distribuicao_aplicada, false);
    assert.equal(out.resultado_motor_inalterado, true);
  });

  it('6) preservação do total comercial e dos pagamentos', async () => {
    const pagamentos = PAGAMENTOS_50.map((p) => ({ ...p }));
    const out = await pipeline({ candidato: 40, pagamentos });
    assert.equal(out.diagnostico.proposta.proposta.total_comercial, 50);
    assert.deepEqual(pagamentos, PAGAMENTOS_50);
    assert.equal(out.relatorio_operacional.compatibilidade_itens_vendidos.comercial_preservado, true);
  });

  it('7) integridade das quantidades e da distribuição de estoque (Motor)', async () => {
    const motor = motorOficial();
    const qtds = motor.itens.map((i) => ({
      qf: i.quantidade_fiscal,
      qnf: i.quantidade_nao_fiscal
    }));
    const out = await pipeline({ candidato: 40, resultadoMotorOficial: motor });
    assert.equal(out.validacao.alterou_estoque, false);
    assert.equal(out.resultado_motor_substituido, null);
    assert.deepEqual(
      motor.itens.map((i) => ({ qf: i.quantidade_fiscal, qnf: i.quantidade_nao_fiscal })),
      qtds
    );
    assert.ok(Math.abs(Number(motor.totalVenda) - 50) < 0.02);
  });

  it('8) falha do adaptador sem corrupção do fechamento', async () => {
    const motor = motorOficial();
    const snap = JSON.stringify(motor);
    const out = await pipeline({
      candidato: 40,
      pagamentos: [{ forma_pagamento: 'debito', valor: 10 }],
      resultadoMotorOficial: motor
    });
    assert.equal(out.diagnostico.evento, 'erro_isolado');
    assert.equal(out.resultado_motor_inalterado, true);
    assert.equal(out.distribuicao_aplicada, false);
    assert.equal(JSON.stringify(motor), snap);
  });

  it('9) diferenciação proposta validada × distribuição aplicada', async () => {
    const out = await pipeline({
      candidato: 40,
      env: { [ENV_APLICAR_DISTRIBUICAO]: '1' },
      harnessAplicar: { tentar: true }
    });
    assert.equal(out.modo.modo_efetivo, MODOS_OPERACIONAIS.APLICACAO_BLOQUEADA);
    assert.equal(out.relatorio_operacional.proposta_calculada, true);
    assert.equal(out.relatorio_operacional.proposta_validada, true);
    assert.equal(out.relatorio_operacional.distribuicao_aplicada, false);
    assert.equal(out.relatorio_operacional.nao_confundir_validacao_com_aplicacao, true);
    assert.ok(
      String(out.relatorio_operacional.motivo_distribuicao_nao_aplicada || '')
        .toLowerCase()
        .includes('vale')
    );

    // Relatório isolado também diferencia
    const rel = montarRelatorioOperacionalRecomposicao({
      modoInfo: resolverModoOperacionalRecomposicao({
        env: { [ENV_HOMOLOGACAO_ATIVA]: '1', [ENV_DIAGNOSTICO_ATIVO]: '1', [ENV_DIAGNOSTICO_CANDIDATO]: '40' }
      }),
      diagnostico: out.diagnostico,
      validacao: out.validacao,
      totalComercial: 50,
      itensVenda: ITENS_VENDA
    });
    assert.notEqual(rel.proposta_validada, rel.distribuicao_aplicada);
  });

  it('10) desativação e retorno ao comportamento anterior', async () => {
    const on = resolverModoOperacionalRecomposicao({
      env: {
        [ENV_DIAGNOSTICO_ATIVO]: '1',
        [ENV_DIAGNOSTICO_CANDIDATO]: '40',
        [ENV_HOMOLOGACAO_ATIVA]: '1'
      }
    });
    assert.equal(on.modo_efetivo, MODOS_OPERACIONAIS.HOMOLOGACAO);

    const off = resolverModoOperacionalRecomposicao({ env: {} });
    assert.equal(off.modo_efetivo, MODOS_OPERACIONAIS.DESLIGADO);

    const legado = await executarAtivacaoControladaRecomposicaoNoFechamento({
      totalComercial: 50,
      pagamentos: PAGAMENTOS_50,
      itens: ITENS_VENDA,
      diagnosticoInterno: null,
      env: {},
      harnessHomologacao: null,
      resultadoMotorOficial: motorOficial()
    });
    assert.equal(legado.modo.modo_efetivo, MODOS_OPERACIONAIS.DESLIGADO);
    assert.equal(legado.diagnostico.evento, 'diagnostico_nao_solicitado');
    assert.equal(legado.distribuicao_aplicada, false);
  });

  it('compatibilidade — helper rejeita proposta sem quantidades', () => {
    const bad = avaliarCompatibilidadeComItensVendidos({
      itensVenda: ITENS_VENDA,
      itensProposta: [],
      totalComercial: 50,
      valorComposicao: 40
    });
    assert.equal(bad.compativel, false);
  });

  it('frontend não altera modo operacional', () => {
    const modo = resolverModoOperacionalRecomposicao({
      env: {},
      // body-like noise ignorado pela API (não passado como env)
    });
    assert.equal(modo.modo_efetivo, MODOS_OPERACIONAIS.DESLIGADO);
    assert.equal(
      resolverDiagnosticoInternoParaFechamento({ env: {} }),
      null
    );
  });
});
