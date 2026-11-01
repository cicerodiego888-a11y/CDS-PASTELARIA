/**
 * Sprint 32 — gatilho do dinheiro, unidades inteiras e a tolerância já existente.
 * Não liga produção e não transmite documento fiscal.
 *
 * Executar: node --test --test-concurrency=1 tests/pdv/sprint-32-gatilho-dinheiro-recomposicao.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-sprint32-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
process.env.CDS_RECOMPOSICAO_REFERENCIA_TESTE = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;
delete process.env.RECOMPOSICAO_HABILITADA_EM_PRODUCAO;

const { isolarBancoTeste } = require('../central-entradas/helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-sprint32-');
const db = require('../../backend/database');
isolamento.comprobar(db);

const {
  avaliarReferenciaRecomposicao
} = require('../../backend/services/vendas/PagamentoSequencialComposicaoService');
const {
  apresentacaoComposicaoFiscal
} = require('../../backend/services/vendas/PagamentoRecomposicaoDocumentoService');
const {
  RECOMPOSICAO_HABILITADA_EM_PRODUCAO
} = require('../../backend/services/vendas/RecomposicaoFiscalContratoService');
const {
  calcularMargemToleranciaDinheiro,
  avaliarCandidatosComToleranciaDinheiro
} = require('../../backend/services/vendas/RecomposicaoFiscalToleranciaDinheiroSimulacaoService');
const PagamentoSequencial = require('../../frontend/pdv/js/pagamentoSequencial');

const pdvFonte = fs.readFileSync(path.join(__dirname, '../../frontend/pdv/js/pdv.js'), 'utf8');

function autorizar(forma) {
  return {
    aprovado: true,
    status: 'aprovado',
    transacao_id: `sim-${forma}-${Date.now()}`
  };
}

async function montar(linhas) {
  PagamentoSequencial.reset();
  for (const linha of linhas) {
    await PagamentoSequencial.adicionar({
      forma: linha.forma,
      valor: linha.valor,
      totalVenda: 60,
      autorizarTef: linha.autorizar || autorizar
    });
  }
  return PagamentoSequencial.exportar();
}

function referencia(pagamentos) {
  return avaliarReferenciaRecomposicao({
    total: 60,
    pagamentos,
    pagamento_sequencial: true
  });
}

describe('Sprint 32 — dinheiro, ordem e unidades inteiras', { concurrency: false }, () => {
  it('a ordem não muda a referência e o dinheiro permanece não fiscal', async () => {
    const ordens = [
      ['dinheiro', 'pix', 'cartao_debito', 'cartao_credito'],
      ['pix', 'dinheiro', 'cartao_debito', 'cartao_credito'],
      ['pix', 'cartao_debito', 'cartao_credito', 'dinheiro']
    ];
    const valores = { dinheiro: 10, pix: 20, cartao_debito: 20, cartao_credito: 10 };
    for (const ordem of ordens) {
      const exportado = await montar(ordem.map((forma) => ({ forma, valor: valores[forma] })));
      const dinheiro = exportado.filter((linha) => linha.forma_pagamento === 'dinheiro');
      assert.equal(dinheiro.length, 1);
      assert.equal(dinheiro[0].tipo_recebimento, 'nao_fiscal');
      assert.equal(dinheiro[0].aprovado, undefined);
      const ref = referencia(exportado);
      assert.equal(ref.valor_fiscal_referencia, 50);
      assert.equal(ref.valor_nao_fiscal_referencia, 10);
    }
  });

  it('duas parcelas de dinheiro somam no não fiscal e a digital pendente não compõe', async () => {
    const duas = await montar([
      { forma: 'dinheiro', valor: 4 },
      { forma: 'dinheiro', valor: 6 },
      { forma: 'pix', valor: 50 }
    ]);
    assert.equal(duas.filter((linha) => linha.tipo_recebimento === 'nao_fiscal')
      .reduce((total, linha) => total + linha.valor, 0), 10);
    const ref = referencia(duas);
    assert.equal(ref.valor_fiscal_referencia, 50);
    assert.equal(ref.valor_nao_fiscal_referencia, 10);

    PagamentoSequencial.reset();
    await PagamentoSequencial.adicionar({ forma: 'dinheiro', valor: 10, totalVenda: 60 });
    const pendente = await PagamentoSequencial.adicionar({
      forma: 'pix',
      valor: 20,
      totalVenda: 60,
      autorizarTef: async () => ({ status: 'pendente' })
    });
    assert.equal(pendente.ok, false);
    assert.equal(PagamentoSequencial.recomposicaoNecessaria(), true);
    assert.equal(PagamentoSequencial.autorizacaoDigitalPendente(), true);
    assert.equal(PagamentoSequencial.composicaoValida(), false);
    assert.equal(PagamentoSequencial.exportar().some((linha) => linha.forma_pagamento === 'pix'), false);

    const recusada = await PagamentoSequencial.adicionar({
      forma: 'cartao_debito',
      valor: 20,
      totalVenda: 60,
      autorizarTef: async () => ({ aprovado: false, status: 'negado' })
    });
    assert.equal(recusada.ok, false);
    assert.equal(PagamentoSequencial.exportar().some((linha) => linha.forma_pagamento === 'cartao_debito'), false);
  });

  it('a regra dos 20% preserva unidade inteira e não vira desconto', () => {
    const margem = calcularMargemToleranciaDinheiro([
      { forma_pagamento: 'dinheiro', valor: 10 }
    ]);
    assert.equal(margem.percentual, 0.2);
    assert.equal(margem.margem_maxima, 2);
    assert.equal(margem.nao_e_desconto, true);
    assert.equal(margem.formula, 'percentual * soma(pagamentos em dinheiro)');

    const dentro = avaliarCandidatosComToleranciaDinheiro({
      total_comercial: 15,
      pagamentos: [
        { forma_pagamento: 'pix', valor: 5 },
        { forma_pagamento: 'dinheiro', valor: 10 }
      ],
      itens: [{ produto_id: 1, quantidade: 1, preco_unitario: 6, subtotal: 6 }],
      valor_fiscal_candidato: 5
    });
    assert.equal(dentro.avaliacoes[0].aplicou_desconto, false);
    assert.equal(dentro.avaliacoes[0].candidato_inteiro_compativel, 6);
    assert.equal(Number.isInteger(dentro.avaliacoes[0].candidato_inteiro_compativel), true);
    assert.equal(dentro.aplicou_desconto_automatico, false);

    const fora = avaliarCandidatosComToleranciaDinheiro({
      total_comercial: 9,
      pagamentos: [
        { forma_pagamento: 'pix', valor: 8 },
        { forma_pagamento: 'dinheiro', valor: 1 }
      ],
      itens: [{ produto_id: 2, quantidade: 1, preco_unitario: 5, subtotal: 5, volume_ml: 200 }],
      valor_fiscal_candidato: 4
    });
    assert.equal(fora.avaliacoes[0].codigo, 'MARGEM_INSUFICIENTE');
    assert.equal(fora.avaliacoes[0].aplicou_desconto, false);
    assert.equal(fora.avaliacoes[0].distribuicao_possivel, false);

    const fracionada = avaliarCandidatosComToleranciaDinheiro({
      total_comercial: 10,
      pagamentos: [{ forma_pagamento: 'dinheiro', valor: 10 }],
      itens: [{ produto_id: 3, quantidade: 1.8, preco_unitario: 5, subtotal: 9 }],
      valor_fiscal_candidato: 9
    });
    assert.equal(fracionada.avaliacoes[0].codigo, 'DISTRIBUICAO_INCOMPATIVEL_QUANTIDADE_INTEIRA');
    assert.deepEqual(fracionada.totais_fiscais_quantidade_inteira, []);

    const apresentacao = apresentacaoComposicaoFiscal({
      itens_fiscais: [{ produto_id: 2, quantidade_fiscal: 1, valor_fiscal: 5, preco_unitario: 5, volume_total_ml: 200 }],
      motor: { diferenca_monetaria: 1, aplicou_desconto: false }
    }, { valor_fiscal_referencia: 4, valor_nao_fiscal_referencia: 1 });
    assert.equal(apresentacao.editavel, false);
    assert.equal(apresentacao.desconto_ajuste, 0);
    assert.equal(apresentacao.desconto_convertido_da_margem, false);
    assert.equal(apresentacao.itens[0].quantidade, 1);
    assert.equal(apresentacao.itens[0].volume_ml, 200);
    assert.equal(RECOMPOSICAO_HABILITADA_EM_PRODUCAO, false);
  });

  it('a interface marca o gatilho e não deixa o operador editar a composição', () => {
    assert.match(pdvFonte, /painelComposicaoFiscalPdv/);
    assert.match(pdvFonte, /painelComposicaoFiscalDireta/);
    assert.match(pdvFonte, /textoAguardoComposicaoFiscal/);
    assert.match(pdvFonte, /autorizacaoDigitalPendente\(\)/);
    assert.match(pdvFonte, /invalidarComposicao\(\)/);
    assert.match(pdvFonte, /Composição fiscal da venda/);
    const painel = pdvFonte.slice(
      pdvFonte.indexOf('function htmlComposicaoFiscalPdv'),
      pdvFonte.indexOf('function textoAguardoComposicaoFiscal')
    );
    assert.equal(painel.includes('<input'), false);
    assert.match(pdvFonte, /fechamentoMistoConfirmado/);
  });
});
