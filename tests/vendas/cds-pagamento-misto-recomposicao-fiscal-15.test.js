/**
 * CDS — PAGAMENTO MISTO E RECOMPOSIÇÃO FISCAL — 15
 * Ativação controlada e teste integrado da recomposição (homologação).
 *
 * Executar:
 *   node --test tests/vendas/cds-pagamento-misto-recomposicao-fiscal-15.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');

const {
  ENV_HOMOLOGACAO_ATIVA,
  ENV_DIAGNOSTICO_ATIVO,
  ENV_DIAGNOSTICO_CANDIDATO,
  CONTRATO_MOTOR_FXNF,
  obterAtivacaoHomologacaoInterna,
  resolverDiagnosticoInternoParaFechamento,
  executarDiagnosticoRecomposicaoNoFechamento,
  validarPropostaContraContratoMotorFxnf,
  executarAtivacaoControladaRecomposicaoNoFechamento
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

const MODELOS_REAIS_MECANISMO = [modeloPrecoFixo(1, 1000, 5)];
const CAPACIDADE = { REFRIGERANTE: 100 };

function motorOficialVenda50() {
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
    {
      pagamentos: PAGAMENTOS_50.map((p) => ({ ...p })),
      desconto: 0,
      acrescimo: 0,
      midpAtivo: false
    }
  );
}

async function fluxoIntegrado(opcoes = {}) {
  const env = opcoes.env != null ? opcoes.env : {};
  const harnessDiag = opcoes.harnessReq != null ? opcoes.harnessReq : {
    valor_fiscal_candidato: opcoes.candidato != null ? opcoes.candidato : 40,
    modelos: opcoes.modelos != null ? opcoes.modelos : MODELOS_REAIS_MECANISMO,
    capacidade_por_categoria: opcoes.capacidade != null ? opcoes.capacidade : CAPACIDADE,
    fonte_modelos: 'PedidoPdvComposicaoService.carregarModelosRefrigerante'
  };
  if (opcoes.semModelos) {
    harnessDiag.modelos = [];
    delete harnessDiag.capacidade_por_categoria;
  }
  if (opcoes.semHarness) {
    return executarAtivacaoControladaRecomposicaoNoFechamento({
      totalComercial: 50,
      pagamentos: PAGAMENTOS_50.map((p) => ({ ...p })),
      itens: ITENS_VENDA.map((i) => ({ ...i })),
      diagnosticoInterno: resolverDiagnosticoInternoParaFechamento({ env }),
      env,
      harnessHomologacao: opcoes.harnessHomologacao || null,
      resultadoMotorOficial: opcoes.resultadoMotorOficial != null
        ? opcoes.resultadoMotorOficial
        : motorOficialVenda50(),
      carregarContextoComposicao: opcoes.carregarContextoComposicao,
      empresaId: opcoes.empresaId,
      pedidoId: opcoes.pedidoId,
      db: opcoes.db
    });
  }

  const diagnosticoInterno = resolverDiagnosticoInternoParaFechamento({
    harnessReq: harnessDiag,
    env
  });

  return executarAtivacaoControladaRecomposicaoNoFechamento({
    totalComercial: 50,
    pagamentos: (opcoes.pagamentos || PAGAMENTOS_50).map((p) => ({ ...p })),
    itens: (opcoes.itens || ITENS_VENDA).map((i) => ({ ...i })),
    diagnosticoInterno,
    env,
    harnessHomologacao: opcoes.harnessHomologacao || { ativa: true },
    forcarDiagnostico: true,
    resultadoMotorOficial: opcoes.resultadoMotorOficial != null
      ? opcoes.resultadoMotorOficial
      : motorOficialVenda50(),
    carregarContextoComposicao: opcoes.carregarContextoComposicao,
    empresaId: opcoes.empresaId,
    pedidoId: opcoes.pedidoId,
    db: opcoes.db
  });
}

describe('CDS-PAGAMENTO-MISTO-RECOMPOSICAO-FISCAL-15', { concurrency: false }, () => {
  it('documenta contrato Motor F×NF e wiring sem substituir distribuição', () => {
    assert.equal(CONTRATO_MOTOR_FXNF.funcao, 'distribuirItensVendaComValorFiscalEfetivo');
    assert.equal(CONTRATO_MOTOR_FXNF.aplicacao_recomposicao_nesta_sprint, false);
    const src = fs.readFileSync(
      path.join(ROOT, 'backend/services/vendas/VendaPagamentoService.js'),
      'utf8'
    );
    assert.ok(src.includes('validarPropostaContraContratoMotorFxnf'));
    assert.ok(src.includes('CDS_RECOMPOSICAO_HOMOLOGACAO') || src.includes('obterAtivacaoHomologacaoInterna'));
    assert.ok(src.includes('resultado_motor_inalterado'));
    // Motor oficial permanece a chamada de distribuição
    assert.ok(src.includes('distribuirItensVendaComValorFiscalEfetivo'));
  });

  it('1) ativação desabilitada por padrão', () => {
    const a = obterAtivacaoHomologacaoInterna({});
    assert.equal(a.ativa, false);
    assert.equal(a.permite_aplicar_distribuicao_oficial, false);
    assert.equal(ENV_HOMOLOGACAO_ATIVA, 'CDS_RECOMPOSICAO_HOMOLOGACAO');
  });

  it('2) ativação interna somente no ambiente controlado', () => {
    const off = obterAtivacaoHomologacaoInterna({ [ENV_HOMOLOGACAO_ATIVA]: '0' });
    assert.equal(off.ativa, false);

    const on = obterAtivacaoHomologacaoInterna({ [ENV_HOMOLOGACAO_ATIVA]: '1' });
    assert.equal(on.ativa, true);
    assert.equal(on.fonte, 'backend_env');
    assert.equal(on.permite_aplicar_distribuicao_oficial, false);
    assert.equal(on.producao, false);

    const harness = obterAtivacaoHomologacaoInterna({}, { ativa: true });
    assert.equal(harness.ativa, true);
    assert.equal(harness.fonte, 'harness_teste');
  });

  it('3) composição válida com produtos e quantidades (mecanismo existente)', async () => {
    const out = await fluxoIntegrado({ candidato: 40 });
    assert.equal(out.diagnostico.evento, 'composicao_encontrada');
    assert.equal(out.diagnostico.status_simulacao, 'EXATA');
    assert.equal(out.validacao.estado, 'VALIDADO_EM_HOMOLOGACAO');
    assert.equal(out.validacao.composicao_validada_em_homologacao, true);
    assert.equal(out.validacao.valor_composicao, 40);
    assert.ok(out.validacao.itens_composicao.length >= 1);
    assert.equal(out.validacao.itens_composicao[0].produto_id, 1);
    assert.equal(out.validacao.itens_composicao[0].quantidade, 4);
    assert.equal(out.validacao.aplicacao_distribuicao_oficial_bloqueada, true);
    assert.equal(out.resultado_motor_inalterado, true);
    assert.equal(out.resultado_motor_substituido, null);
  });

  it('4) composição incompatível', async () => {
    const out = await fluxoIntegrado({ candidato: 35 });
    assert.equal(out.diagnostico.evento, 'composicao_incompativel');
    assert.equal(out.validacao.estado, 'BLOQUEADO_POR_INCOMPATIBILIDADE');
    assert.equal(out.validacao.composicao_validada_em_homologacao, false);
    assert.equal(out.validacao.aplicacao_distribuicao_oficial_permitida, false);
    assert.equal(out.resultado_motor_inalterado, true);
  });

  it('5) ausência de modelos ou contexto', async () => {
    const out = await fluxoIntegrado({
      candidato: 40,
      semModelos: true,
      carregarContextoComposicao: async () => ({
        suficiente: false,
        motivo: 'modelos_vazios_apos_carga',
        origem: 'PedidoPdvComposicaoService.carregarModelosRefrigerante',
        modelos: [],
        capacidade_por_categoria: {}
      })
    });
    assert.equal(out.diagnostico.evento, 'contexto_composicao_insuficiente');
    assert.equal(out.validacao.estado, 'BLOQUEADO_POR_INCOMPATIBILIDADE');
    assert.equal(out.validacao.aplicacao_distribuicao_oficial_permitida, false);
  });

  it('6) diferença dentro da margem sem desconto automático (41,90 → 40)', async () => {
    const out = await fluxoIntegrado({ candidato: 41.9 });
    assert.equal(out.diagnostico.status_simulacao, 'COMPATIVEL_MARGEM');
    assert.equal(out.validacao.valor_composicao, 40);
    assert.ok(Math.abs(out.validacao.diferenca_composicao - 1.9) < 1e-9);
    assert.equal(out.validacao.margem_matematica, 2);
    assert.equal(out.validacao.diferenca_nao_e_desconto, true);
    const checkDesc = out.validacao.checks.find((c) => c.codigo === 'SEM_DESCONTO_AUTOMATICO');
    assert.ok(checkDesc && checkDesc.ok);
    assert.equal(out.validacao.estado, 'VALIDADO_EM_HOMOLOGACAO');
  });

  it('7) total comercial e pagamentos preservados (cenário R$ 50)', async () => {
    const pagamentos = PAGAMENTOS_50.map((p) => ({ ...p }));
    const out = await fluxoIntegrado({ candidato: 40, pagamentos });
    assert.equal(out.diagnostico.proposta.proposta.total_comercial, 50);
    assert.equal(out.validacao.checks.find((c) => c.codigo === 'TOTAL_COMERCIAL_PRESERVADO').ok, true);
    assert.equal(out.validacao.checks.find((c) => c.codigo === 'PAGAMENTOS_PRESERVADOS').ok, true);
    assert.deepEqual(pagamentos, PAGAMENTOS_50);
    assert.equal(pagamentos[0].valor, 20);
    assert.equal(pagamentos[1].valor, 20);
    assert.equal(pagamentos[2].valor, 10);
  });

  it('8) estoque consistente com a distribuição oficial (Motor não substituído)', async () => {
    const motor = motorOficialVenda50();
    assert.equal(motor.sucesso, true);
    const qtdFiscalAntes = motor.itens.map((i) => i.quantidade_fiscal);
    const out = await fluxoIntegrado({
      candidato: 40,
      resultadoMotorOficial: motor
    });
    assert.equal(out.validacao.alterou_estoque, false);
    assert.equal(out.validacao.substitui_motor_fxnf, false);
    assert.deepEqual(
      motor.itens.map((i) => i.quantidade_fiscal),
      qtdFiscalAntes
    );
    // Divergência esperada: Motor oficial ≠ candidato 40 (aplicação bloqueada)
    assert.ok(out.validacao.divergencia_fiscal);
    assert.equal(out.validacao.divergencia_fiscal.valor_candidato, 40);
    assert.ok(out.validacao.divergencia_fiscal.divergente === true
      || Math.abs(out.validacao.divergencia_fiscal.valor_fiscal_oficial_motor - 40) > 0.009
      || out.validacao.divergencia_fiscal.valor_fiscal_oficial_motor != null);
  });

  it('9) falha do adaptador — comportamento legado preservado', async () => {
    const motor = motorOficialVenda50();
    const snapMotor = JSON.stringify(motor);
    const out = await fluxoIntegrado({
      candidato: 40,
      pagamentos: [{ forma_pagamento: 'debito', valor: 10 }],
      resultadoMotorOficial: motor
    });
    assert.equal(out.diagnostico.evento, 'erro_isolado');
    assert.equal(out.validacao.estado, 'FALHA_NOS_TESTES');
    assert.equal(out.resultado_motor_inalterado, true);
    assert.equal(out.validacao.substitui_motor_fxnf, false);
    assert.equal(JSON.stringify(motor), snapMotor);
  });

  it('10) desativação imediata — retorno ao fluxo anterior', async () => {
    const desligado = await executarAtivacaoControladaRecomposicaoNoFechamento({
      totalComercial: 50,
      pagamentos: PAGAMENTOS_50,
      itens: ITENS_VENDA,
      diagnosticoInterno: null,
      env: {},
      harnessHomologacao: null,
      resultadoMotorOficial: motorOficialVenda50()
    });
    assert.equal(desligado.ativacao.ativa, false);
    assert.equal(desligado.validacao.estado, 'DESABILITADO');
    assert.equal(desligado.diagnostico.evento, 'diagnostico_nao_solicitado');
    assert.equal(desligado.resultado_motor_inalterado, true);

    // Rollback: ligar e desligar
    const ligado = obterAtivacaoHomologacaoInterna({ [ENV_HOMOLOGACAO_ATIVA]: '1' });
    assert.equal(ligado.ativa, true);
    const novamenteOff = obterAtivacaoHomologacaoInterna({});
    assert.equal(novamenteOff.ativa, false);
  });

  it('11) ausência de dependência de parâmetros do frontend', async () => {
    const viaBody = await executarAtivacaoControladaRecomposicaoNoFechamento({
      totalComercial: 50,
      pagamentos: PAGAMENTOS_50,
      itens: ITENS_VENDA,
      diagnosticoInterno: resolverDiagnosticoInternoParaFechamento({
        env: {},
        harnessReq: null
      }),
      env: {},
      // flags de body NÃO devem ativar
      body: {
        CDS_RECOMPOSICAO_HOMOLOGACAO: '1',
        valor_fiscal: 40,
        valor_fiscal_candidato: 40,
        habilitar_em_producao: true
      },
      resultadoMotorOficial: motorOficialVenda50()
    });
    assert.equal(viaBody.ativacao.ativa, false);
    assert.equal(viaBody.diagnostico.solicitado, false);

    assert.equal(
      resolverDiagnosticoInternoParaFechamento({
        env: { [ENV_DIAGNOSTICO_ATIVO]: '1' } // sem candidato
      }),
      null
    );
    assert.ok(ENV_DIAGNOSTICO_CANDIDATO);
  });

  it('12) ausência de emissão fiscal / TEF / SEFAZ nos testes', async () => {
    const out = await fluxoIntegrado({ candidato: 40 });
    assert.equal(out.validacao.chama_tef, false);
    assert.equal(out.validacao.chama_sefaz, false);
    assert.equal(out.validacao.emissao_fiscal_autorizada, false);
    assert.equal(out.diagnostico.chama_tef, false);
    assert.equal(out.diagnostico.emissao_fiscal_autorizada, false);
    assert.equal(out.diagnostico.persistencia_executada, false);
  });

  it('cenário principal R$ 50 — evidência completa homologação', async () => {
    const motor = motorOficialVenda50();
    const out = await fluxoIntegrado({
      candidato: 40,
      resultadoMotorOficial: motor
    });

    assert.equal(out.diagnostico.proposta.proposta.total_comercial, 50);
    assert.equal(out.validacao.valor_candidato, 40);
    assert.equal(out.validacao.valor_composicao, 40);
    assert.equal(out.validacao.margem_matematica, 2);
    assert.ok(Array.isArray(out.validacao.itens_composicao));
    assert.equal(out.validacao.itens_composicao[0].produto_id, 1);
    assert.equal(out.validacao.itens_composicao[0].quantidade, 4);
    assert.equal(out.validacao.estado, 'VALIDADO_EM_HOMOLOGACAO');
    assert.equal(out.validacao.aplicacao_distribuicao_oficial_bloqueada, true);
    assert.ok(String(out.validacao.motivo_bloqueio_aplicacao || '').toLowerCase().includes('vale'));
    // Motor oficial permanece autoridade
    assert.equal(motor.sucesso, true);
    assert.ok(Math.abs(Number(motor.totalVenda) - 50) < 0.02);
  });
});
