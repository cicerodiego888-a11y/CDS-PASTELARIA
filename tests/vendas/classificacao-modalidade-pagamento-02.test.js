'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  canon,
  classificarFormaPagamento,
  rotuloFormaClassificada,
  formaExibidaDaVenda
} = require('../../frontend/shared/js/classificacaoModalidadePagamento');
const { decidirAtalhoPagamentoPdv } = require('../../frontend/pdv/js/interacaoPagamentoMisto');
require('../../frontend/shared/js/tefFluxoPagamento');
const fechamento = require('../../frontend/pdv/js/pdv-fechamento-oficial');

const raiz = path.join(__dirname, '../..');

function linha(forma, valor, status) {
  return { forma_pagamento: forma, valor, status: status || 'aprovado' };
}

function rotulo(pagamentos) {
  return rotuloFormaClassificada(classificarFormaPagamento(pagamentos));
}

function fechar(parcelas, total) {
  return fechamento.montarCorpo({
    fluxo: global.TefFluxoPagamento,
    parcelas,
    total,
    itens: [{ produto_id: 747, quantidade: 1, preco_unitario: total, subtotal: total }],
    tefHabilitado: false,
    modoConfirmacaoFiscal: 'MANUAL',
    valorFiscal: total,
    valorNaoFiscal: 0
  });
}

const venda71 = {
  id: 71,
  codigo: 'VND-20261112110416',
  forma_pagamento: 'misto',
  total: 61.9,
  venda_pagamentos: [{ forma_pagamento: 'cartao_debito', valor: 61.9 }]
};

test('1. um débito aprovado é DÉBITO', () => {
  assert.equal(rotulo([linha('cartao_debito', 61.9)]), 'Débito');
});

test('2. dois débitos aprovados continuam DÉBITO', () => {
  assert.equal(rotulo([
    linha('cartao_debito', 30),
    linha('debito', 31.9)
  ]), 'Débito');
});

test('3. um crédito aprovado é CRÉDITO', () => {
  assert.equal(rotulo([linha('CRÉDITO', 10)]), 'Crédito');
});

test('4. dois créditos aprovados continuam CRÉDITO', () => {
  assert.equal(rotulo([
    linha('cartao_credito', 4),
    linha('credito', 6)
  ]), 'Crédito');
});

test('5. um PIX aprovado é PIX', () => {
  assert.equal(rotulo([linha('PIX', 10)]), 'PIX');
});

test('6. um dinheiro confirmado é DINHEIRO', () => {
  assert.equal(rotulo([linha('DINHEIRO', 10, 'informada')]), 'Dinheiro');
});

test('7. débito e PIX são MISTO', () => {
  assert.equal(rotulo([linha('debito', 20), linha('pix', 41.9)]), 'Misto');
});

test('8. débito e crédito são MISTO', () => {
  assert.equal(rotulo([linha('cartao_debito', 30), linha('cartao_credito', 31.9)]), 'Misto');
});

test('9. PIX e dinheiro são MISTO', () => {
  assert.equal(rotulo([linha('pix', 30), linha('dinheiro', 31.9, 'informada')]), 'Misto');
});

test('10. débito aprovado com crédito recusado permanece DÉBITO', () => {
  assert.equal(rotulo([
    linha('cartao_credito', 61.9, 'rejeitada'),
    linha('cartao_debito', 61.9, 'aprovada')
  ]), 'Débito');
});

test('11. PIX aprovado com PIX pendente permanece PIX', () => {
  assert.equal(rotulo([
    linha('pix', 61.9, 'aprovado'),
    linha('pix', 10, 'pendente')
  ]), 'PIX');
});

test('12. somente pagamentos pendentes ficam PENDENTE', () => {
  assert.equal(rotulo([linha('pix', 61.9, 'pendente')]), 'Pendente');
});

test('13. reabrir a venda não muda a classificação', () => {
  const primeira = formaExibidaDaVenda(venda71);
  const reaberta = formaExibidaDaVenda({
    ...venda71,
    venda_pagamentos: venda71.venda_pagamentos.map((pagamento) => ({ ...pagamento }))
  });
  assert.equal(primeira, 'Débito');
  assert.equal(reaberta, primeira);
  assert.equal(venda71.forma_pagamento, 'misto');
});

test('14. venda antiga sem parcelas usa o cabeçalho histórico', () => {
  assert.equal(formaExibidaDaVenda({ forma_pagamento: 'cartao_debito', venda_pagamentos: [] }), 'Débito');
  assert.equal(formaExibidaDaVenda({ forma_pagamento: 'misto' }), 'Misto');
});

test('15. cabeçalho misto com uma parcela de débito aparece como DÉBITO', () => {
  assert.equal(formaExibidaDaVenda({
    forma_pagamento: 'misto',
    pagamentos_resumo: 'cartao_debito|61.90'
  }), 'Débito');
});

test('16. venda 71 é DÉBITO sem regravar o histórico', () => {
  const antes = JSON.stringify(venda71);
  assert.equal(venda71.venda_pagamentos[0].forma_pagamento, 'cartao_debito');
  assert.equal(formaExibidaDaVenda(venda71), 'Débito');
  assert.equal(JSON.stringify(venda71), antes);
  assert.equal(venda71.venda_pagamentos.length, 1);
});

test('17 e 18. listagem do ERP e do PDV usam a mesma classificação', () => {
  const erp = fs.readFileSync(path.join(raiz, 'frontend/erp/js/vendas.js'), 'utf8');
  const pdv = fs.readFileSync(path.join(raiz, 'frontend/pdv/js/vendas.js'), 'utf8');
  assert.match(erp, /rotuloPagamentoDaVenda\(v\)/);
  assert.match(pdv, /rotuloPagamentoDaVenda\(v\)/);
  assert.match(erp, /formaExibidaDaVenda/);
  assert.match(pdv, /formaExibidaDaVenda/);
  assert.equal(formaExibidaDaVenda(venda71), 'Débito');
  assert.equal(formaExibidaDaVenda({
    forma_pagamento: 'misto',
    pagamentos_resumo: 'cartao_debito|30.00;pix|31.90'
  }), 'Misto');
});

test('19. fechamento novo com um débito grava cartao_debito', () => {
  const corpo = fechar([
    { forma_pagamento: 'cartao_debito', valor: 61.9, status_autorizacao: 'aprovada', tef_transacao_id: 9 }
  ], 61.9);
  assert.equal(corpo.ok, true);
  assert.equal(corpo.corpo.forma_pagamento, 'cartao_debito');
  assert.equal(corpo.corpo.pagamentos[0].forma_pagamento, 'cartao_debito');
});

test('20. fechamento novo com duas modalidades grava misto', () => {
  const corpo = fechar([
    { forma_pagamento: 'pix', valor: 30, status_autorizacao: 'aprovada', tef_transacao_id: 3 },
    { forma_pagamento: 'dinheiro', valor: 31.9, status_autorizacao: 'informada' }
  ], 61.9);
  assert.equal(corpo.ok, true);
  assert.equal(corpo.corpo.forma_pagamento, 'misto');
  assert.deepEqual(corpo.corpo.pagamentos.map((pagamento) => pagamento.forma_pagamento), ['pix', 'dinheiro']);
});

test('21. modal de valor aberto: tecla 4 não troca para crédito', () => {
  const decisao = decidirAtalhoPagamentoPdv('4', {
    modalPagamentoAberto: true,
    modalValorAberto: true,
    campoFocado: false
  });
  assert.equal(decisao.acao, 'digitar');
  assert.equal(decisao.forma, undefined);
});

test('22. modal de valor aberto: tecla 3 não troca para débito', () => {
  const decisao = decidirAtalhoPagamentoPdv('3', {
    modalPagamentoAberto: true,
    modalValorAberto: true,
    campoFocado: true
  });
  assert.equal(decisao.acao, 'digitar');
});

test('23. digitação do valor permanece no campo', () => {
  const estado = { modalPagamentoAberto: true, modalValorAberto: true, campoFocado: true };
  let texto = '';
  for (const tecla of ['6', '1', ',', '9']) {
    const decisao = decidirAtalhoPagamentoPdv(tecla, estado);
    assert.equal(decisao.acao, 'digitar');
    texto += tecla;
  }
  assert.equal(texto, '61,9');
});

test('24. Enter confirma e Esc cancela somente o modal de valor', () => {
  const aberto = { modalPagamentoAberto: true, modalValorAberto: true, campoFocado: true };
  assert.equal(decidirAtalhoPagamentoPdv('Enter', aberto).acao, 'confirmar_valor');
  assert.equal(decidirAtalhoPagamentoPdv('Escape', aberto).acao, 'cancelar_valor');
  const fechado = { modalPagamentoAberto: false, modalValorAberto: false, campoFocado: false };
  assert.equal(decidirAtalhoPagamentoPdv('4', fechado).acao, 'ignorar');
  assert.equal(decidirAtalhoPagamentoPdv('4', {
    modalPagamentoAberto: true,
    modalValorAberto: false,
    campoFocado: false
  }).forma, 'cartao_credito');
});

test('identificadores equivalentes são a mesma modalidade', () => {
  assert.equal(canon('cartao_debito'), canon('debito'));
  assert.equal(canon('DÉBITO'), canon('debito'));
  assert.equal(canon('cartao_credito'), canon('CRÉDITO'));
  assert.equal(canon('pix'), canon('PIX'));
  assert.equal(canon('dinheiro'), canon('DINHEIRO'));
});

test('o backend e o fechamento direto usam o classificador único', () => {
  const servico = fs.readFileSync(path.join(raiz, 'backend/services/vendas/VendaPagamentoService.js'), 'utf8');
  const pdv = fs.readFileSync(path.join(raiz, 'frontend/pdv/js/pdv.js'), 'utf8');
  assert.match(servico, /classificarFormaPagamento\(pagamentosVenda\)/);
  assert.doesNotMatch(servico, /pagamentosVenda\.length > 1/);
  assert.match(pdv, /formaClassificadaDasParcelas\(/);
  assert.doesNotMatch(pdv, /formaPagamentoSelecionadaPDV = 'misto'/);
  assert.doesNotMatch(pdv, /dados\.forma_pagamento = 'misto'/);
});
