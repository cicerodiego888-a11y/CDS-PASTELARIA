/**
 * CDS — PAGAMENTO MISTO E RECOMPOSIÇÃO FISCAL — 09
 * Adaptador de preparação da integração com fechamento real (sem wiring).
 *
 * Executar: node --test tests/vendas/cds-pagamento-misto-recomposicao-fiscal-09.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '../..');

const {
  RECOMPOSICAO_HABILITADA_EM_PRODUCAO
} = require('../../backend/services/vendas/RecomposicaoFiscalContratoService');

const {
  PONTO_INTEGRACAO_FECHAMENTO,
  extrairSnapshotFechamento,
  prepararPropostaRecomposicaoDoFechamento
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

/** Payload no formato típico do POST /api/vendas (fechamento PDV). */
function payloadFechamento(overrides = {}) {
  return {
    total: 50,
    forma_pagamento: 'misto',
    desconto: 0,
    acrescimo: 0,
    emitir_fiscal: false,
    valor_fiscal: 40,
    valor_nao_fiscal: 10,
    pagamentos: [
      { forma_pagamento: 'debito', valor: 20 },
      { forma_pagamento: 'credito', valor: 20 },
      { forma_pagamento: 'dinheiro', valor: 10 }
    ],
    itens: [
      { produto_id: 1, quantidade: 5, preco_unitario: 10, subtotal: 50 }
    ],
    valor_fiscal_candidato: 40,
    modelos: [modeloPrecoFixo(1, 1000, 5)],
    capacidade_por_categoria: { REFRIGERANTE: 100 },
    ...overrides
  };
}

describe('CDS-PAGAMENTO-MISTO-RECOMPOSICAO-FISCAL-09', { concurrency: false }, () => {
  it('documenta ponto exato de integração (diagnóstico Sprint 10, sem operação fiscal)', () => {
    assert.equal(PONTO_INTEGRACAO_FECHAMENTO.funcao, 'criarVenda');
    assert.equal(PONTO_INTEGRACAO_FECHAMENTO.modo, 'DIAGNOSTICO_ISOLADO');
    assert.equal(PONTO_INTEGRACAO_FECHAMENTO.substitui_motor_fxnf, false);
    assert.equal(PONTO_INTEGRACAO_FECHAMENTO.body_valor_fiscal_ignorado, true);
    assert.match(PONTO_INTEGRACAO_FECHAMENTO.momento_diagnostico_sprint_10, /antes de/);
    assert.match(PONTO_INTEGRACAO_FECHAMENTO.arquivo, /VendaPagamentoService/);

    const criarVendaSrc = fs.readFileSync(
      path.join(ROOT, 'backend/services/vendas/VendaPagamentoService.js'),
      'utf8'
    );
    // Hook diagnóstico permitido; orquestrador completo e flags de produção não.
    assert.ok(criarVendaSrc.includes('executarDiagnosticoRecomposicaoNoFechamento'));
    assert.equal(criarVendaSrc.includes('simularIntegracaoRecomposicaoFiscal'), false);
    assert.equal(criarVendaSrc.includes('prepararPropostaRecomposicaoDoFechamento'), false);
  });

  it('venda R$ 50 com 20+20+10 e candidato R$ 40 — proposta EXATA sem persistência/TEF/fiscal', async () => {
    const payload = payloadFechamento({ valor_fiscal_candidato: 40 });
    const out = await prepararPropostaRecomposicaoDoFechamento(payload);
    assert.equal(out.proposta.total_comercial, 50);
    assert.equal(out.proposta.total_pagamentos, 50);
    assert.equal(out.proposta.valor_dinheiro, 10);
    assert.equal(out.proposta.margem_matematica, 2);
    assert.equal(out.proposta.valor_candidato_simulacao, 40);
    assert.equal(out.proposta.valor_composicao_simulada, 40);
    assert.equal(out.proposta.status_simulacao, 'EXATA');
    assert.equal(out.proposta.valor_fiscal_oficialmente_autorizado, null);
    assert.equal(out.persistencia_executada, false);
    assert.equal(out.emissao_fiscal_autorizada, false);
    assert.equal(out.chama_tef, false);
    assert.equal(out.chama_sefaz, false);
    assert.equal(out.wired_em_criar_venda, false);
    assert.equal(out.substitui_motor_fxnf, false);
    assert.equal(out.habilitado_em_producao, false);
  });

  it('candidato R$ 41,90 com margem R$ 2 — COMPATIVEL_MARGEM sem desconto', async () => {
    const out = await prepararPropostaRecomposicaoDoFechamento(
      payloadFechamento({ valor_fiscal_candidato: 41.9 })
    );
    assert.equal(out.proposta.margem_matematica, 2);
    assert.equal(out.proposta.valor_candidato_simulacao, 41.9);
    assert.equal(out.proposta.valor_composicao_simulada, 40);
    assert.equal(out.proposta.diferenca_composicao, 1.9);
    assert.equal(out.proposta.status_simulacao, 'COMPATIVEL_MARGEM');
    assert.equal(out.preservacao.nao_aplicou_desconto, true);
  });

  it('pagamentos inconsistentes — rejeita via contrato', async () => {
    await assert.rejects(
      () => prepararPropostaRecomposicaoDoFechamento(payloadFechamento({
        pagamentos: [
          { forma_pagamento: 'debito', valor: 20 },
          { forma_pagamento: 'credito', valor: 20 }
        ]
      })),
      (err) => err && err.code === 'SOMA_PAGAMENTOS_DIVERGENTE'
    );
  });

  it('composição inexistente — diagnóstico explícito sem inventar produtos', async () => {
    const out = await prepararPropostaRecomposicaoDoFechamento(payloadFechamento({
      modelos: [],
      valor_fiscal_candidato: 40
    }));
    assert.equal(out.proposta.status_simulacao, 'SEM_COMPOSICAO');
    assert.equal(out.proposta.valor_composicao_simulada, null);
    assert.equal(out.persistencia_executada, false);
  });

  it('preserva total comercial e quantidades originais; snapshot não muta payload', async () => {
    const payload = payloadFechamento({ valor_fiscal_candidato: 40 });
    const pagAntes = JSON.stringify(payload.pagamentos);
    const itensAntes = JSON.stringify(payload.itens);
    const snap = extrairSnapshotFechamento(payload);
    assert.equal(snap.total_comercial, 50);
    assert.equal(snap.itens[0].quantidade, 5);

    const out = await prepararPropostaRecomposicaoDoFechamento(payload);
    assert.equal(JSON.stringify(payload.pagamentos), pagAntes);
    assert.equal(JSON.stringify(payload.itens), itensAntes);
    assert.equal(out.preservacao.total_comercial_preservado, true);
    assert.deepEqual(out.preservacao.quantidades_originais, [5]);
    assert.equal(out.preservacao.nao_alterou_itens, true);
    assert.equal(out.proposta.body_valor_fiscal_ignorado_pelo_criar_venda, true);
  });

  it('ausência de persistência e de chamadas TEF/fiscais (flags + load guard)', async () => {
    assert.equal(RECOMPOSICAO_HABILITADA_EM_PRODUCAO, false);
    const proibidos = ['TefManager', 'OrquestradorPagamento', 'VendaFiscalService', 'fiscal/emissor'];
    const hits = [];
    const original = Module._load;
    Module._load = function patched(request, parent, isMain) {
      const req = String(request);
      const parentPath = parent && parent.filename ? String(parent.filename) : '';
      if (/RecomposicaoFiscal/i.test(parentPath) || /RecomposicaoFiscal/i.test(req)) {
        for (const p of proibidos) {
          if (req.includes(p)) hits.push(req);
        }
      }
      return original.apply(this, arguments);
    };
    try {
      const out = await prepararPropostaRecomposicaoDoFechamento(payloadFechamento());
      assert.equal(out.chama_tef, false);
      assert.equal(out.chama_sefaz, false);
      assert.equal(out.persistencia_executada, false);
      assert.deepEqual(hits, []);
    } finally {
      Module._load = original;
    }

    await assert.rejects(
      () => prepararPropostaRecomposicaoDoFechamento(payloadFechamento({
        ativar_pelo_frontend: true
      })),
      (err) => err && err.code === 'RECOMPOSICAO_NAO_HABILITADA_EM_PRODUCAO'
    );
  });
});
