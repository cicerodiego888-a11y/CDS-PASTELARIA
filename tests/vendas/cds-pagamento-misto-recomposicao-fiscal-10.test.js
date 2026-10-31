/**
 * CDS — PAGAMENTO MISTO E RECOMPOSIÇÃO FISCAL — 10
 * Conexão diagnóstica com criarVenda (antes do Motor F×NF).
 *
 * Isolamento: mocks do adaptador / Motor; sem DB oficial, TEF, SEFAZ.
 * Executar: node --test tests/vendas/cds-pagamento-misto-recomposicao-fiscal-10.test.js
 */
'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');

const Adaptador = require('../../backend/services/vendas/RecomposicaoFiscalFechamentoAdaptadorService');
const {
  resolverCandidatoDiagnosticoFechamento,
  executarDiagnosticoRecomposicaoNoFechamento,
  PONTO_INTEGRACAO_FECHAMENTO
} = Adaptador;

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

describe('CDS-PAGAMENTO-MISTO-RECOMPOSICAO-FISCAL-10', { concurrency: false }, () => {
  it('hook está imediatamente antes do Motor F×NF em criarVenda', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'backend/services/vendas/VendaPagamentoService.js'),
      'utf8'
    );
    const iDiag = src.indexOf('diagnóstico isolado de recomposição');
    assert.ok(iDiag > 0, 'bloco diagnóstico Sprint 10/11 ausente');
    const iMotorAposDiag = src.indexOf(
      'const resultadoMotor = distribuirItensVendaComValorFiscalEfetivo',
      iDiag
    );
    assert.ok(iMotorAposDiag > iDiag, 'diagnóstico deve preceder o Motor F×NF em criarVenda');
    const trecho = src.slice(iDiag, iMotorAposDiag);
    assert.ok(trecho.includes('executarDiagnosticoRecomposicaoNoFechamento'));
    assert.equal(trecho.includes('emitirFiscal'), false);
    assert.equal(PONTO_INTEGRACAO_FECHAMENTO.modo, 'DIAGNOSTICO_ISOLADO');
    assert.equal(PONTO_INTEGRACAO_FECHAMENTO.substitui_motor_fxnf, false);
  });

  it('A) sem candidato — não inventa valor e não altera fechamento', async () => {
    assert.equal(
      resolverCandidatoDiagnosticoFechamento({
        totalComercial: 50,
        body: { valor_fiscal: 40, total: 50 }
      }),
      null
    );

    const pagamentos = [
      { forma_pagamento: 'debito', valor: 20 },
      { forma_pagamento: 'credito', valor: 20 },
      { forma_pagamento: 'dinheiro', valor: 10 }
    ];
    const itens = [{ produto_id: 1, quantidade: 5, subtotal: 50 }];
    const pagAntes = JSON.stringify(pagamentos);
    const itensAntes = JSON.stringify(itens);

    const diag = await executarDiagnosticoRecomposicaoNoFechamento({
      totalComercial: 50,
      pagamentos,
      itens,
      diagnosticoInterno: null
    });

    assert.equal(diag.solicitado, false);
    assert.equal(diag.evento, 'diagnostico_nao_solicitado');
    assert.equal(diag.substitui_motor_fxnf, false);
    assert.equal(diag.alterou_fechamento, false);
    assert.equal(JSON.stringify(pagamentos), pagAntes);
    assert.equal(JSON.stringify(itens), itensAntes);
    // Não inventa 40 a partir de 50
    assert.equal(resolverCandidatoDiagnosticoFechamento({ totalComercial: 50 }), null);
  });

  it('B) diagnóstico exato R$ 40 — composição encontrada sem substituir Motor', async () => {
    const resultadoMotorOficial = Object.freeze({
      sucesso: true,
      valorFiscalLiquido: 50,
      valorNaoFiscalLiquido: 0,
      fonte: 'MOTOR_FXNF_MOCK'
    });

    const diag = await executarDiagnosticoRecomposicaoNoFechamento({
      totalComercial: 50,
      pagamentos: [
        { forma_pagamento: 'debito', valor: 20 },
        { forma_pagamento: 'credito', valor: 20 },
        { forma_pagamento: 'dinheiro', valor: 10 }
      ],
      itens: [{ produto_id: 1, quantidade: 5, subtotal: 50 }],
      diagnosticoInterno: {
        valor_fiscal_candidato: 40,
        modelos: [modeloPrecoFixo(1, 1000, 5)],
        capacidade_por_categoria: { REFRIGERANTE: 100 }
      }
    });

    assert.equal(diag.solicitado, true);
    assert.equal(diag.evento, 'composicao_encontrada');
    assert.equal(diag.status_simulacao, 'EXATA');
    assert.equal(diag.resumoSeguro.valor_candidato_simulacao, 40);
    assert.equal(diag.resumoSeguro.valor_composicao_simulada, 40);
    assert.equal(diag.substitui_motor_fxnf, false);
    // Motor oficial permanece intacto (objeto distinto / não reescrito)
    assert.equal(resultadoMotorOficial.valorFiscalLiquido, 50);
    assert.equal(resultadoMotorOficial.fonte, 'MOTOR_FXNF_MOCK');
  });

  it('C) candidato R$ 41,90 na margem — sem desconto nem alteração da venda', async () => {
    const pagamentos = [
      { forma_pagamento: 'debito', valor: 20 },
      { forma_pagamento: 'credito', valor: 20 },
      { forma_pagamento: 'dinheiro', valor: 10 }
    ];
    const itens = [{ produto_id: 1, quantidade: 5, subtotal: 50 }];
    const snapPag = JSON.stringify(pagamentos);
    const snapItens = JSON.stringify(itens);

    const diag = await executarDiagnosticoRecomposicaoNoFechamento({
      totalComercial: 50,
      pagamentos,
      itens,
      diagnosticoInterno: {
        valor_fiscal_candidato: 41.9,
        modelos: [modeloPrecoFixo(1, 1000, 5)],
        capacidade_por_categoria: { REFRIGERANTE: 100 }
      }
    });

    assert.equal(diag.status_simulacao, 'COMPATIVEL_MARGEM');
    assert.equal(diag.resumoSeguro.diferenca_composicao, 1.9);
    assert.equal(diag.resumoSeguro.margem_matematica, 2);
    assert.equal(diag.aplicou_desconto, false);
    assert.equal(diag.alterou_fechamento, false);
    assert.equal(JSON.stringify(pagamentos), snapPag);
    assert.equal(JSON.stringify(itens), snapItens);
  });

  it('D) falha do adaptador — erro isolado sem alterar payload/comercial', async () => {
    // Soma de pagamentos divergente força erro no contrato; diagnóstico engole e isola.
    const pagamentos = [
      { forma_pagamento: 'debito', valor: 20 },
      { forma_pagamento: 'credito', valor: 10 }
    ];
    const itens = [{ produto_id: 1, quantidade: 5, subtotal: 50 }];
    const antes = {
      pagamentos: JSON.stringify(pagamentos),
      itens: JSON.stringify(itens)
    };

    const diag = await executarDiagnosticoRecomposicaoNoFechamento({
      totalComercial: 50,
      pagamentos,
      itens,
      diagnosticoInterno: { valor_fiscal_candidato: 40 }
    });
    assert.equal(diag.evento, 'erro_isolado');
    assert.equal(diag.codigo, 'SOMA_PAGAMENTOS_DIVERGENTE');
    assert.equal(diag.alterou_fechamento, false);
    assert.equal(diag.substitui_motor_fxnf, false);
    assert.equal(JSON.stringify(pagamentos), antes.pagamentos);
    assert.equal(JSON.stringify(itens), antes.itens);
  });

  it('E) preservação do total, pagamentos, itens e quantidades', async () => {
    const pagamentos = [
      { forma_pagamento: 'debito', valor: 20 },
      { forma_pagamento: 'credito', valor: 20 },
      { forma_pagamento: 'dinheiro', valor: 10 }
    ];
    const itens = [{ produto_id: 9, quantidade: 5, subtotal: 50, preco_unitario: 10 }];
    const total = 50;
    const copia = {
      total,
      pagamentos: JSON.parse(JSON.stringify(pagamentos)),
      itens: JSON.parse(JSON.stringify(itens))
    };

    await executarDiagnosticoRecomposicaoNoFechamento({
      totalComercial: total,
      pagamentos,
      itens,
      diagnosticoInterno: {
        valor_fiscal_candidato: 40,
        modelos: [modeloPrecoFixo(1, 1000, 5)],
        capacidade_por_categoria: { REFRIGERANTE: 100 }
      }
    });

    assert.equal(total, copia.total);
    assert.deepEqual(pagamentos, copia.pagamentos);
    assert.deepEqual(itens, copia.itens);
    assert.equal(itens[0].quantidade, 5);
  });

  it('F) parâmetros do cliente não habilitam operação/emissão', async () => {
    // Flags no body/cliente NÃO são fonte de candidato nem de produção
    assert.equal(
      resolverCandidatoDiagnosticoFechamento({
        body: {
          valor_fiscal_candidato: 40,
          habilitar_em_producao: true,
          autorizacao_producao: true,
          valor_fiscal: 40
        },
        totalComercial: 50
      }),
      null
    );

    await assert.rejects(
      () => Adaptador.prepararPropostaRecomposicaoDoFechamento({
        total: 50,
        pagamentos: [{ forma_pagamento: 'dinheiro', valor: 50 }],
        itens: [{ produto_id: 1, quantidade: 1, subtotal: 50 }],
        valor_fiscal_candidato: 40,
        habilitar_em_producao: true
      }),
      (err) => err && err.code === 'RECOMPOSICAO_NAO_HABILITADA_EM_PRODUCAO'
    );

    const diag = await executarDiagnosticoRecomposicaoNoFechamento({
      totalComercial: 50,
      pagamentos: [{ forma_pagamento: 'dinheiro', valor: 50 }],
      itens: [{ produto_id: 1, quantidade: 1, subtotal: 50 }],
      // mesmo com flags no body, harness interno controla o candidato
      body: { habilitar_em_producao: true, emitir_fiscal: true },
      diagnosticoInterno: {
        valor_fiscal_candidato: 40,
        modelos: [],
        capacidade_por_categoria: {}
      }
    });
    assert.equal(diag.emissao_fiscal_autorizada, false);
    assert.equal(diag.persistencia_executada, false);
    assert.equal(diag.substitui_motor_fxnf, false);
  });
});
