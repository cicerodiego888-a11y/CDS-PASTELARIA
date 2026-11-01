'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-moeda-'));
process.env.DB_DIR = dir;

const {
  itensFiscaisInteirosParaReferencia
} = require('../../backend/services/vendas/PagamentoRecomposicaoDocumentoService');

function pagamentos(fiscal, dinheiro) {
  return [
    { forma_pagamento: 'pix', valor: fiscal, status: 'aprovado' },
    { forma_pagamento: 'dinheiro', valor: dinheiro, status: 'aprovado' }
  ];
}

test('venda com fiscal zerado fecha pelo preço de catálogo', async () => {
  const fechamento = await itensFiscaisInteirosParaReferencia({
    pagamentos: [
      { forma_pagamento: 'pix', valor: 20, status: 'aprovado' },
      { forma_pagamento: 'cartao_debito', valor: 21.9, status: 'aprovado' },
      { forma_pagamento: 'cartao_credito', valor: 13, status: 'aprovado' },
      { forma_pagamento: 'dinheiro', valor: 7, status: 'aprovado' }
    ],
    itens: [
      { produto_id: 747, categoria_nome: 'Pasteis', quantidade: 2, quantidade_fiscal: 0, valor_fiscal: 0, preco_unitario: 8.99, subtotal: 17.98, unidade: 'un' },
      { produto_id: 748, categoria_nome: 'Refrigerantes', quantidade: 2, quantidade_fiscal: 0, valor_fiscal: 0, preco_unitario: 12.99, preco_venda: 12.99, subtotal: 25.98, unidade: 'ml', produto_fracionado: 0 },
      { produto_id: 749, categoria_nome: 'Refrigerantes', quantidade: 1, quantidade_fiscal: 0, valor_fiscal: 0, preco_unitario: 19.8, preco_venda: 19.8, subtotal: 19.8, unidade: 'ml', produto_fracionado: 0 }
    ]
  });
  assert.equal(fechamento.valor_produtos, 63.76);
  assert.equal(fechamento.dinheiro_aplicado, 1.4);
  assert.equal(fechamento.desconto, 7.46);
  assert.equal(fechamento.valor_fiscal_liquido, 56.3);
  assert.equal(fechamento.itens.find((item) => item.produto_id === 748).unidade, 'UN');
  assert.equal(fechamento.itens.find((item) => item.produto_id === 748).preco_unitario, 12.99);
  assert.equal(fechamento.itens.find((item) => item.produto_id === 749).quantidade_fiscal, 1);
});

test('combinação exata não gera desconto nem dinheiro na nota', async () => {
  const fechamento = await itensFiscaisInteirosParaReferencia({
    pagamentos: pagamentos(50, 10),
    itens: [
      { produto_id: 1, categoria_nome: 'PASTEIS', quantidade: 2, preco_unitario: 10, subtotal: 20 },
      { produto_id: 2, categoria_nome: 'REFRIGERANTES', quantidade: 8, preco_unitario: 5, subtotal: 40 }
    ]
  });
  assert.equal(fechamento.desconto, 0);
  assert.equal(fechamento.dinheiro_aplicado, 0);
  assert.equal(fechamento.valor_fiscal_liquido, 50);
  assert.equal(fechamento.valor_produtos, 50);
  const refrigerante = fechamento.itens.find((item) => item.produto_id === 2);
  assert.equal(refrigerante.quantidade_fiscal, 6);
  assert.equal(refrigerante.valor_fiscal, 30);
});

test('produto inteiro acima da referência usa 20% do dinheiro e desconta o resto', async () => {
  const fechamento = await itensFiscaisInteirosParaReferencia({
    pagamentos: pagamentos(40, 10),
    itens: [
      { produto_id: 1, categoria_nome: 'PASTEIS', quantidade: 2, preco_unitario: 10, subtotal: 20 },
      { produto_id: 2, categoria_nome: 'REFRIGERANTES', quantidade: 4, preco_unitario: 6, subtotal: 24 }
    ]
  });
  assert.equal(fechamento.valor_produtos, 44);
  assert.equal(fechamento.dinheiro_aplicado, 2);
  assert.equal(fechamento.desconto, 2);
  assert.equal(fechamento.valor_fiscal_liquido, 42);
  assert.equal(fechamento.itens.find((item) => item.produto_id === 2).quantidade_fiscal, 4);
});

test('dinheiro aplicado não fica em centavo quebrado', async () => {
  const fechamento = await itensFiscaisInteirosParaReferencia({
    pagamentos: pagamentos(10, 10),
    itens: [
      { produto_id: 1, categoria_nome: 'PASTEIS', quantidade: 1, preco_unitario: 10.53, subtotal: 10.53 }
    ]
  });
  assert.equal(fechamento.dinheiro_aplicado, 0.5);
  assert.equal(fechamento.desconto, 0.03);
  assert.equal(fechamento.valor_fiscal_liquido, 10.5);
  assert.notEqual(fechamento.dinheiro_aplicado, 0.53);
});

test('copo em ML sai em unidade inteira e não usa preço quebrado', async () => {
  const fechamento = await itensFiscaisInteirosParaReferencia({
    pagamentos: pagamentos(40, 10),
    itens: [
      { produto_id: 747, categoria_nome: 'PASTEIS', quantidade: 2, preco_unitario: 10, subtotal: 20, unidade: 'UN' },
      {
        produto_id: 748,
        categoria_nome: 'REFRIGERANTES',
        quantidade: 2,
        preco_unitario: 12.225,
        preco_venda: 12,
        subtotal: 24.45,
        unidade: 'ML',
        produto_fracionado: 0
      }
    ]
  });
  const copo = fechamento.itens.find((item) => item.produto_id === 748);
  assert.equal(copo.unidade, 'UN');
  assert.equal(copo.preco_unitario, 12);
  assert.equal(copo.quantidade_fiscal, 2);
  assert.equal(copo.valor_fiscal, 24);
  assert.equal(fechamento.dinheiro_aplicado, 2);
  assert.equal(fechamento.desconto, 2);
  assert.equal(fechamento.valor_fiscal_liquido, 42);
});

test('vinte por cento que não forma moeda desce para o múltiplo de cinco centavos', async () => {
  const fechamento = await itensFiscaisInteirosParaReferencia({
    pagamentos: pagamentos(10, 0.6),
    itens: [
      { produto_id: 1, categoria_nome: 'PASTEIS', quantidade: 1, preco_unitario: 10.12, subtotal: 10.12 }
    ]
  });
  assert.equal(fechamento.dinheiro_aplicado, 0.1);
  assert.equal(fechamento.desconto, 0.02);
  assert.equal(fechamento.valor_fiscal_liquido, 10.1);
});
