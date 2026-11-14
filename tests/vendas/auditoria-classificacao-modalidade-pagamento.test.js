'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classificarFormaPagamento,
  formaExibidaDaVenda
} = require('../../frontend/shared/js/classificacaoModalidadePagamento');
const adapter = require('../../backend/services/pdv-universal/PDVUniversalVendaAdapter');
require('../../frontend/shared/js/tefFluxoPagamento');
const fechamento = require('../../frontend/pdv/js/pdv-fechamento-oficial');

function linha(forma, valor, status) {
  return { forma_pagamento: forma, valor, status: status || 'aprovado' };
}

test('uma modalidade recebida guarda o próprio código', () => {
  assert.equal(classificarFormaPagamento([linha('cartao_debito', 61.9)]), 'cartao_debito');
  assert.equal(classificarFormaPagamento([linha('debito', 10)]), 'cartao_debito');
  assert.equal(classificarFormaPagamento([linha('DÉBITO', 10)]), 'cartao_debito');
  assert.equal(classificarFormaPagamento([linha('cartao_credito', 10)]), 'cartao_credito');
  assert.equal(classificarFormaPagamento([linha('pix', 10)]), 'pix');
  assert.equal(classificarFormaPagamento([linha('dinheiro', 10, 'informada')]), 'dinheiro');
});

test('duas modalidades distintas são mistas e dois débitos continuam débito', () => {
  assert.equal(classificarFormaPagamento([
    linha('cartao_debito', 30),
    linha('cartao_credito', 31.9)
  ]), 'misto');
  assert.equal(classificarFormaPagamento([
    linha('debito', 20),
    linha('pix', 41.9)
  ]), 'misto');
  assert.equal(classificarFormaPagamento([
    linha('PIX', 30),
    linha('dinheiro', 31.9, 'informada')
  ]), 'misto');
  assert.equal(classificarFormaPagamento([
    linha('cartao_debito', 30),
    linha('DÉBITO', 31.9)
  ]), 'cartao_debito');
});

test('recusa e pendência não alteram o que foi recebido', () => {
  assert.equal(classificarFormaPagamento([
    linha('cartao_credito', 61.9, 'rejeitada'),
    linha('cartao_debito', 61.9, 'aprovada')
  ]), 'cartao_debito');
  assert.equal(classificarFormaPagamento([
    linha('pix', 61.9, 'pendente')
  ]), 'pendente');
  assert.equal(classificarFormaPagamento([
    linha('pix', 10, 'pendente'),
    linha('cartao_debito', 51.9, 'aprovado')
  ]), 'cartao_debito');
});

test('venda 71 com cabeçalho misto e uma parcela de débito aparece como Débito', () => {
  const venda = {
    id: 71,
    codigo: 'VND-20261112110416',
    forma_pagamento: 'misto',
    total: 61.9,
    venda_pagamentos: [
      { forma_pagamento: 'cartao_debito', valor: 61.9 }
    ]
  };
  assert.equal(formaExibidaDaVenda(venda), 'Débito');
  assert.equal(formaExibidaDaVenda({
    forma_pagamento: 'misto',
    pagamentos_resumo: 'cartao_debito|61.90'
  }), 'Débito');
  assert.equal(formaExibidaDaVenda({
    forma_pagamento: 'misto',
    pagamentos_resumo: 'cartao_debito|30.00;pix|31.90'
  }), 'Misto');
});

test('fechamento e adapter gravam a modalidade distinta, não a quantidade de registros', () => {
  const fluxo = global.TefFluxoPagamento;
  const unico = fechamento.montarCorpo({
    fluxo,
    parcelas: [{ forma_pagamento: 'cartao_debito', valor: 61.9, status_autorizacao: 'aprovada', tef_transacao_id: 9 }],
    total: 61.9,
    itens: [{ produto_id: 1, quantidade: 1, preco_unitario: 61.9, subtotal: 61.9 }],
    tefHabilitado: false,
    modoConfirmacaoFiscal: 'MANUAL',
    valorFiscal: 61.9,
    valorNaoFiscal: 0
  });
  assert.equal(unico.ok, true);
  assert.equal(unico.corpo.forma_pagamento, 'cartao_debito');

  const doisDebitos = adapter.montarPayloadVendaOficial({
    itens: [{ produto_id: 1, empresa_id: 1, quantidade: 1, valor_unitario: 20, subtotal: 20 }],
    pagamentos: [
      { forma_pagamento: 'cartao_debito', valor: 10 },
      { forma_pagamento: 'debito', valor: 10 }
    ]
  });
  assert.equal(doisDebitos.forma_pagamento, 'cartao_debito');

  const misto = adapter.montarPayloadVendaOficial({
    itens: [{ produto_id: 1, empresa_id: 1, quantidade: 1, valor_unitario: 10, subtotal: 10 }],
    pagamentos: [
      { forma_pagamento: 'dinheiro', valor: 4 },
      { forma_pagamento: 'pix', valor: 6 }
    ]
  });
  assert.equal(misto.forma_pagamento, 'misto');
});
