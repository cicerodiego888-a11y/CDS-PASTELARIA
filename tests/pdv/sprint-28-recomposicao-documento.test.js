/**
 * Sprint 28 — referência confirmada, composição e XML da NFC-e.
 * Sem banco oficial, sem TEF real e sem emissão à SEFAZ.
 *
 * Executar: node --test --test-concurrency=1 tests/pdv/sprint-28-recomposicao-documento.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  RECOMPOSICAO_HABILITADA_EM_PRODUCAO
} = require('../../backend/services/vendas/RecomposicaoFiscalContratoService');
const {
  integrarPagamentoRecomposicao
} = require('../../backend/services/vendas/PagamentoRecomposicaoDocumentoService');

const ENV_TESTE = Object.freeze({ CDS_RECOMPOSICAO_REFERENCIA_TESTE: '1' });
const HARNESS = Object.freeze({ ativa: true });
const CFG = Object.freeze({
  codigoUf: '23',
  cnpj: '65957340000150',
  ie: '073252638',
  crt: 1,
  ambiente: 2,
  serie: 1,
  nomeEmpresa: 'EMPRESA TESTE LTDA',
  logradouro: 'RUA A',
  numero: '100',
  bairro: 'CENTRO',
  codigo_municipio: '2307304',
  municipio: 'JUAZEIRO DO NORTE',
  uf: 'CE',
  cep: '63000000',
  telefone: '8835110000',
  csosn_padrao: '102'
});

function modeloPrecoFixo(produtoId, precoCentavos, quantidadeMaxima, categoria) {
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

function item(dados) {
  return {
    produto_ncm: '19059090',
    cfop: '5102',
    csosn: '102',
    unidade: 'UN',
    origem: 0,
    ...dados
  };
}

const PASTEL = item({
  produto_id: 1,
  produto_nome: 'Pastel',
  categoria_nome: 'PASTEIS',
  quantidade: 1,
  preco_unitario: 20,
  subtotal: 20,
  produto_ncm: '19059090'
});
const REFRIGERANTE = item({
  produto_id: 2,
  produto_nome: 'Refrigerante',
  categoria_nome: 'REFRIGERANTES',
  quantidade: 6,
  preco_unitario: 5,
  subtotal: 30,
  produto_ncm: '22021000'
});
const SALDOS_A = Object.freeze({
  1: Object.freeze({ saldoFiscal: 1, saldoNaoFiscal: 0 }),
  2: Object.freeze({ saldoFiscal: 4, saldoNaoFiscal: 2 })
});

function eletronicosEDinheiro() {
  return [
    { forma_pagamento: 'cartao_debito', valor: 20, status_autorizacao: 'aprovada' },
    { forma_pagamento: 'cartao_credito', valor: 20, status_autorizacao: 'aprovada' },
    { forma_pagamento: 'dinheiro', valor: 10, status_autorizacao: 'informada' }
  ];
}

function integrar(extra = {}, opcoes = {}) {
  return integrarPagamentoRecomposicao({
    total: 50,
    empresaId: 7,
    pagamentos: eletronicosEDinheiro(),
    itens: [PASTEL, REFRIGERANTE],
    saldosPorProduto: SALDOS_A,
    configFiscal: CFG,
    ...extra
  }, {
    env: ENV_TESTE,
    harnessDistribuicaoOficial: HARNESS,
    modelos: [modeloPrecoFixo(2, 500, 6, 'REFRIGERANTE')],
    capacidade_por_categoria: { REFRIGERANTE: 100 },
    ...opcoes
  });
}

function somaTag(xml, tag) {
  const encontrados = String(xml || '').match(new RegExp(`<${tag}>([0-9.]+)</${tag}>`, 'g')) || [];
  return Math.round(encontrados.reduce((total, trecho) => {
    return total + Number(trecho.replace(/[^\d.]/g, ''));
  }, 0) * 100) / 100;
}

function somaProdutos(xml) {
  const itens = String(xml || '').split('<total>')[0];
  return somaTag(itens, 'vProd');
}

describe('Sprint 28 — pagamento, recomposição e XML', { concurrency: false }, () => {
  beforeEach(() => {
    assert.equal(RECOMPOSICAO_HABILITADA_EM_PRODUCAO, false);
  });

  it('1, 4, 5, 8 e 10. eletrônico 40 e dinheiro 10 geram XML só com o fiscal autorizado', async () => {
    const direto = await integrar();
    const misto = await integrar();
    for (const documento of [direto, misto]) {
      assert.equal(documento.bloqueado, false);
      assert.equal(documento.referencia.valor_fiscal_referencia, 40);
      assert.equal(documento.referencia.valor_nao_fiscal_referencia, 10);
      assert.equal(documento.valores.vNF, 40);
      assert.equal(somaProdutos(documento.xml), 40);
      assert.equal(somaTag(documento.xml, 'vPag'), 40);
      assert.equal(documento.xml.includes('<vTroco>'), false);
      assert.equal(documento.xml.includes('<tPag>01</tPag>'), false);
      const ids = documento.itens_fiscais.map((linha) => Number(linha.produto_id)).sort();
      assert.deepEqual(ids, [1, 2]);
      const refrigerante = documento.itens_fiscais.find((linha) => Number(linha.produto_id) === 2);
      assert.equal(refrigerante.quantidade_fiscal, 4);
      assert.equal(refrigerante.valor_fiscal, 20);
      assert.equal(somaTag(documento.xml, 'vNF'), 40);
    }
  });

  it('2. somente dinheiro não coloca o carrinho de 50 na NFC-e', async () => {
    const documento = await integrar({
      pagamentos: [{ forma_pagamento: 'dinheiro', valor: 50, status_autorizacao: 'informada' }],
      itens: [item({
        produto_id: 3,
        produto_nome: 'Item comercial',
        quantidade: 1,
        preco_unitario: 50,
        subtotal: 50
      })]
    }, { modelos: [] });
    assert.equal(documento.codigo, 'REFERENCIA_FISCAL_ZERO');
    assert.equal(documento.xml, null);
    assert.equal(documento.itens_fiscais.length, 0);
    assert.equal(documento.referencia.valor_fiscal_referencia, 0);
    assert.equal(documento.referencia.valor_nao_fiscal_referencia, 50);
  });

  it('3. somente eletrônico autoriza o carrinho fiscal de 50', async () => {
    const documento = await integrar({
      pagamentos: [
        { forma_pagamento: 'pix', valor: 50, status_autorizacao: 'aprovada' }
      ],
      itens: [item({
        produto_id: 4,
        produto_nome: 'Item fiscal',
        quantidade: 1,
        preco_unitario: 50,
        subtotal: 50,
        produto_ncm: '19059090'
      })],
      saldosPorProduto: { 4: { saldoFiscal: 1, saldoNaoFiscal: 0 } }
    }, { modelos: [] });
    assert.equal(documento.bloqueado, false);
    assert.equal(documento.referencia.valor_fiscal_referencia, 50);
    assert.equal(documento.referencia.valor_nao_fiscal_referencia, 0);
    assert.equal(documento.valores.vNF, 50);
    assert.equal(somaProdutos(documento.xml), 50);
  });

  it('6. parcela rejeitada ou pendente fica fora da referência', async () => {
    const documento = await integrar({
      pagamentos: [
        { forma_pagamento: 'cartao_debito', valor: 20, status_autorizacao: 'aprovada' },
        { forma_pagamento: 'cartao_credito', valor: 20, status_autorizacao: 'rejeitada' },
        { forma_pagamento: 'dinheiro', valor: 10, status_autorizacao: 'informada' }
      ]
    });
    assert.equal(documento.referencia.valor_fiscal_referencia, 20);
    assert.equal(documento.referencia.valor_nao_fiscal_referencia, 10);
    assert.equal(documento.codigo, 'PAGAMENTO_INCOMPLETO');
    assert.equal(documento.xml, null);

    const pendente = await integrar({
      pagamentos: [
        { forma_pagamento: 'cartao_debito', valor: 20, status_autorizacao: 'aprovada' },
        { forma_pagamento: 'pix', valor: 20, status_autorizacao: 'pendente' },
        { forma_pagamento: 'dinheiro', valor: 10, status_autorizacao: 'informada' }
      ]
    });
    assert.equal(pendente.referencia.valor_fiscal_referencia, 20);
    assert.equal(pendente.referencia.valor_nao_fiscal_referencia, 10);
    assert.equal(pendente.codigo, 'PAGAMENTO_INCOMPLETO');
    assert.equal(pendente.xml, null);
  });

  it('7. sem composição elegível o documento é bloqueado e nada é inventado', async () => {
    const documento = await integrar({}, { modelos: [] });
    assert.equal(documento.bloqueado, true);
    assert.equal(documento.codigo, 'COMPOSICAO_AUSENTE_NO_MOTOR');
    assert.equal(documento.xml, null);
    assert.equal(documento.itens_fiscais.length, 0);
  });

  it('9. a distribuição usa o saldo da empresa da venda e não soma outra empresa', async () => {
    const autorizado = await integrar();
    assert.equal(autorizado.bloqueado, false);
    const saldoDaEmpresaA = {
      1: { saldoFiscal: 1, saldoNaoFiscal: 0 },
      2: { saldoFiscal: 1, saldoNaoFiscal: 2 }
    };
    const bloqueado = await integrar({
      saldosPorProduto: saldoDaEmpresaA
    });
    assert.equal(bloqueado.bloqueado, true);
    assert.equal(bloqueado.codigo, 'SALDO_INSUFICIENTE');
    assert.equal(bloqueado.xml, null);
    assert.equal(Object.prototype.hasOwnProperty.call(saldoDaEmpresaA, '99'), false);
  });

  it('direto e misto chamam a mesma avaliação e o catálogo não vem do corpo', () => {
    const pdv = fs.readFileSync(path.join(__dirname, '../../frontend/pdv/js/pdv.js'), 'utf8');
    const rota = fs.readFileSync(path.join(__dirname, '../../backend/rotas/vendas.js'), 'utf8');
    const chamadas = pdv.split('solicitarAvaliacaoComposicaoPagamento(totalVenda, lista)').length - 1;
    assert.equal(chamadas >= 2, true);
    assert.equal(pdv.includes('itens: itensCarrinhoParaComposicao()'), true);
    assert.equal(rota.includes('integrarPagamentoRecomposicao'), true);
    assert.equal(rota.includes('body.modelos'), false);
    assert.equal(rota.includes('RECOMPOSICAO_HABILITADA_EM_PRODUCAO = true'), false);
  });

  it('ambiente de teste desligado não monta XML e a produção continua desligada', async () => {
    const documento = await integrar({}, { env: {} });
    assert.equal(documento.bloqueado, false);
    assert.equal(documento.codigo, 'ambiente_teste_desligado');
    assert.equal(documento.xml, null);
    assert.equal(RECOMPOSICAO_HABILITADA_EM_PRODUCAO, false);
  });
});
