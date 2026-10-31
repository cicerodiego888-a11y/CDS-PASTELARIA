/**
 * CDS — PAGAMENTO MISTO E RECOMPOSIÇÃO FISCAL — 06
 * Simulação isolada via motor real de composição (ComposicaoFiscalPedidoService).
 *
 * Isolamento: mocks/sintéticos + núcleo oficial buscarComposicao.
 * Sem DB oficial, TEF, SEFAZ, criarVenda, desconto automático.
 *
 * Executar: node --test tests/vendas/cds-pagamento-misto-recomposicao-fiscal-06.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const ComposicaoFiscalPedidoService = require('../../backend/services/vendas/ComposicaoFiscalPedidoService');
const {
  RECOMPOSICAO_HABILITADA_EM_PRODUCAO
} = require('../../backend/services/vendas/RecomposicaoFiscalContratoService');
const {
  avaliarCandidatosComMotorComposicao,
  MOTOR_OFICIAL,
  INTERFACE_PUBLICA,
  NUCLEO_BUSCA
} = require('../../backend/services/vendas/RecomposicaoFiscalComposicaoMotorSimulacaoService');

const PAGAMENTOS_50 = Object.freeze([
  Object.freeze({ forma_pagamento: 'debito', valor: 20 }),
  Object.freeze({ forma_pagamento: 'credito', valor: 20 }),
  Object.freeze({ forma_pagamento: 'dinheiro', valor: 10 })
]);

/**
 * Modelo sintético no contrato exigido por buscarComposicao
 * (mesmo padrão de tests/vendas/pedido-pdv-composicao.test.js).
 */
function modeloPrecoFixo(produtoId, precoCentavos, quantidadeMaxima = 10, categoria = 'REFRIGERANTE') {
  return {
    produtoId,
    nome: `Produto ${produtoId}`,
    categoriaFiscal: categoria,
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

describe('CDS-PAGAMENTO-MISTO-RECOMPOSICAO-FISCAL-06', { concurrency: false }, () => {
  it('confirma interface oficial do motor de composição', () => {
    assert.equal(MOTOR_OFICIAL, 'ComposicaoFiscalPedidoService');
    assert.equal(INTERFACE_PUBLICA, 'simularComposicao');
    assert.equal(NUCLEO_BUSCA, 'internos.buscarComposicao');
    assert.equal(typeof ComposicaoFiscalPedidoService.simularComposicao, 'function');
    assert.equal(typeof ComposicaoFiscalPedidoService.internos.buscarComposicao, 'function');
    assert.equal(typeof ComposicaoFiscalPedidoService.internos.comporItens, 'function');
  });

  it('1) candidato R$ 40,00 — composição exata com qtd inteiras', async () => {
    const r = await avaliarCandidatosComMotorComposicao({
      total_comercial: 50,
      pagamentos: [...PAGAMENTOS_50],
      valor_fiscal_candidato: 40,
      modelos: [modeloPrecoFixo(1, 1000, 5)],
      capacidade_por_categoria: { REFRIGERANTE: 100 }
    });
    assert.equal(r.margem.margem_maxima, 2);
    assert.equal(r.distribuicao_possivel, true);
    const av = r.avaliacoes[0];
    assert.equal(av.interface_oficial, true);
    assert.equal(av.codigo, 'OK_COMPOSICAO_EXATA');
    assert.equal(av.composicao_encontrada, 40);
    assert.equal(av.diferenca_monetaria, 0);
    assert.equal(av.encontrou_exato, true);
    assert.equal(av.quantidades_inteiras, true);
    assert.equal(av.aplicou_desconto, false);
    assert.ok(av.itens_compostos.every((it) => Number.isSafeInteger(it.quantidade)));
  });

  it('2) candidato R$ 41,90 — NÃO presume troca por 40; reporta composição do motor', async () => {
    const r = await avaliarCandidatosComMotorComposicao({
      total_comercial: 50,
      pagamentos: [...PAGAMENTOS_50],
      valor_fiscal_candidato: 41.9,
      modelos: [modeloPrecoFixo(1, 1000, 5)],
      capacidade_por_categoria: { REFRIGERANTE: 100 }
    });
    const av = r.avaliacoes[0];
    // Motor maximiza ≤ 41,90 → encontra 40,00 (4×R$10); diferença 1,90 ≤ margem 2,00
    assert.equal(av.valor_fiscal_candidato, 41.9);
    assert.equal(av.composicao_encontrada, 40);
    assert.equal(av.diferenca_monetaria, 1.9);
    assert.equal(av.encontrou_exato, false);
    assert.equal(av.codigo, 'OK_COMPOSICAO_DENTRO_DA_MARGEM');
    assert.equal(av.aplicou_desconto, false);
    assert.equal(r.meta.nao_presume_substituicao_4190_por_40, true);
    // Candidato avaliado permanece 41,90 — não foi reescrito para 40
    assert.equal(av.valor_fiscal_candidato, 41.9);
  });

  it('3) candidato sem composição inteira dentro da margem', async () => {
    const r = await avaliarCandidatosComMotorComposicao({
      total_comercial: 50,
      pagamentos: [...PAGAMENTOS_50],
      valor_fiscal_candidato: 35,
      modelos: [modeloPrecoFixo(1, 1000, 5)],
      capacidade_por_categoria: { REFRIGERANTE: 100 }
    });
    const av = r.avaliacoes[0];
    // Sprint 12: motor exige faixa [33,35]; grid R$10 não cabe → incompatível explícito
    assert.equal(av.composicao_encontrada, null);
    assert.equal(av.codigo, 'COMPOSICAO_INCOMPATIVEL_MARGEM_TOLERANCIA');
    assert.equal(av.distribuicao_possivel, false);
    assert.equal(av.aplicou_desconto, false);
  });

  it('4) dinheiro igual a zero → margem zero; 41,90 rejeitado', async () => {
    const r = await avaliarCandidatosComMotorComposicao({
      total_comercial: 50,
      pagamentos: [
        { forma_pagamento: 'debito', valor: 25 },
        { forma_pagamento: 'credito', valor: 25 }
      ],
      valor_fiscal_candidato: 41.9,
      modelos: [modeloPrecoFixo(1, 1000, 5)],
      capacidade_por_categoria: { REFRIGERANTE: 100 }
    });
    assert.equal(r.margem.margem_maxima, 0);
    const av = r.avaliacoes[0];
    // Margem 0 ⇒ somente composição exata 41,90; 40 fica fora
    assert.equal(av.composicao_encontrada, null);
    assert.equal(av.codigo, 'COMPOSICAO_INCOMPATIVEL_MARGEM_TOLERANCIA');
    assert.equal(av.distribuicao_possivel, false);
  });

  it('5) ausência de composição válida no motor', async () => {
    const rVazio = await avaliarCandidatosComMotorComposicao({
      total_comercial: 50,
      pagamentos: [...PAGAMENTOS_50],
      valor_fiscal_candidato: 40,
      modelos: [],
      capacidade_por_categoria: { REFRIGERANTE: 100 }
    });
    assert.equal(rVazio.avaliacoes[0].codigo, 'COMPOSICAO_AUSENTE_NO_MOTOR');
    assert.equal(rVazio.distribuicao_possivel, false);

    const rCap = await avaliarCandidatosComMotorComposicao({
      total_comercial: 50,
      pagamentos: [...PAGAMENTOS_50],
      valor_fiscal_candidato: 40,
      modelos: [modeloPrecoFixo(1, 1000, 5)],
      capacidade_por_categoria: { REFRIGERANTE: 0 }
    });
    // Capacidade 0 ⇒ sem composição (código de incompatibilidade/inexistência do motor)
    assert.ok(
      ['COMPOSICAO_FISCAL_INEXISTENTE', 'COMPOSICAO_INCOMPATIVEL_MARGEM_TOLERANCIA']
        .includes(rCap.avaliacoes[0].codigo)
    );
    assert.equal(rCap.avaliacoes[0].composicao_encontrada, null);
    assert.equal(rCap.distribuicao_possivel, false);
  });

  it('6) preservação dos objetos de entrada', async () => {
    const entrada = {
      total_comercial: 50,
      pagamentos: [
        { forma_pagamento: 'debito', valor: 20 },
        { forma_pagamento: 'credito', valor: 20 },
        { forma_pagamento: 'dinheiro', valor: 10 }
      ],
      candidatos_fiscais: [40, 41.9],
      modelos: [modeloPrecoFixo(1, 1000, 5)],
      capacidade_por_categoria: { REFRIGERANTE: 100 }
    };
    const pagAntes = JSON.stringify(entrada.pagamentos);
    const candAntes = JSON.stringify(entrada.candidatos_fiscais);
    const capAntes = JSON.stringify(entrada.capacidade_por_categoria);
    await avaliarCandidatosComMotorComposicao(entrada);
    assert.equal(JSON.stringify(entrada.pagamentos), pagAntes);
    assert.equal(JSON.stringify(entrada.candidatos_fiscais), candAntes);
    assert.equal(JSON.stringify(entrada.capacidade_por_categoria), capAntes);
  });

  it('7) ausência de persistência e efeitos no carrinho / fluxo oficial', async () => {
    assert.equal(RECOMPOSICAO_HABILITADA_EM_PRODUCAO, false);
    const r = await avaliarCandidatosComMotorComposicao({
      total_comercial: 50,
      pagamentos: [...PAGAMENTOS_50],
      valor_fiscal_candidato: 40,
      modelos: [modeloPrecoFixo(1, 1000, 5)],
      capacidade_por_categoria: { REFRIGERANTE: 100 }
    });
    assert.equal(r.persistiu, false);
    assert.equal(r.alterou_carrinho, false);
    assert.equal(r.aplica_ao_fluxo_oficial, false);
    assert.equal(r.altera_motor_fxnf, false);
    assert.equal(r.aplicou_desconto_automatico, false);
    assert.equal(r.cria_voucher, false);
    assert.equal(r.recomposicao_habilitada_em_producao, false);

    await assert.rejects(
      () => avaliarCandidatosComMotorComposicao({
        total_comercial: 50,
        pagamentos: [...PAGAMENTOS_50],
        valor_fiscal_candidato: 40,
        modelos: [modeloPrecoFixo(1, 1000, 5)],
        capacidade_por_categoria: { REFRIGERANTE: 100 },
        habilitar_em_producao: true
      }),
      (err) => err && err.code === 'RECOMPOSICAO_NAO_HABILITADA_EM_PRODUCAO'
    );
  });

  it('8) tratamento de preços e diferenças em centavos', async () => {
    // Produto R$ 10,05 — candidato 30,15 → 3 unidades = 30,15 exato
    const r = await avaliarCandidatosComMotorComposicao({
      total_comercial: 50,
      pagamentos: [...PAGAMENTOS_50],
      valor_fiscal_candidato: 30.15,
      modelos: [modeloPrecoFixo(7, 1005, 10)],
      capacidade_por_categoria: { REFRIGERANTE: 100 }
    });
    const av = r.avaliacoes[0];
    assert.equal(av.composicao_encontrada, 30.15);
    assert.equal(av.diferenca_monetaria, 0);
    assert.equal(av.codigo, 'OK_COMPOSICAO_EXATA');

    // Candidato 30,20 → motor encontra 30,15; diff 0,05 ≤ margem 2
    const r2 = await avaliarCandidatosComMotorComposicao({
      total_comercial: 50,
      pagamentos: [...PAGAMENTOS_50],
      valor_fiscal_candidato: 30.2,
      modelos: [modeloPrecoFixo(7, 1005, 10)],
      capacidade_por_categoria: { REFRIGERANTE: 100 }
    });
    assert.equal(r2.avaliacoes[0].composicao_encontrada, 30.15);
    assert.equal(r2.avaliacoes[0].diferenca_monetaria, 0.05);
    assert.equal(r2.avaliacoes[0].codigo, 'OK_COMPOSICAO_DENTRO_DA_MARGEM');
  });
});
