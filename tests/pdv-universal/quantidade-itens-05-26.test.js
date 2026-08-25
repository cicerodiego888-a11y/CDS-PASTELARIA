/**
 * Sprint 05.26 — quantidade e edição de itens no carrinho do PDV Universal.
 */
'use strict';

const assert = require('assert');
const Cart = require('../../frontend/pdv-universal/pdv-universal-cart.js');
const tela = require('../../frontend/pdv-universal/pdv-universal.js');

function itemBase(overrides) {
  return Object.assign({
    produto_id: 10,
    empresa_id: 1,
    descricao: 'Produto',
    quantidade: 1,
    valor_unitario: 10
  }, overrides || {});
}

function test01MaisAumentaQuantidade() {
  const c = Cart.criarCarrinho();
  c.adicionarItem(itemBase({ quantidade: 1 }));
  c.aplicarQuantidadeInteira(10, 1, 2);
  assert.strictEqual(c.localizar(10, 1).quantidade, 2);
}

function test02MenosDiminuiQuantidade() {
  const c = Cart.criarCarrinho();
  c.adicionarItem(itemBase({ quantidade: 3 }));
  c.aplicarQuantidadeInteira(10, 1, 2);
  assert.strictEqual(c.localizar(10, 1).quantidade, 2);
}

function test03Qtd1MenosRemove() {
  const c = Cart.criarCarrinho();
  c.adicionarItem(itemBase({ quantidade: 1 }));
  c.aplicarQuantidadeInteira(10, 1, 0);
  assert.strictEqual(c.localizar(10, 1), null);
  assert.strictEqual(c.obterItens().length, 0);
}

function test04EdicaoDiretaValida() {
  const d = Cart.interpretarQuantidadeInteiraUi('5', 3);
  assert.strictEqual(d.acao, 'aplicar');
  assert.strictEqual(d.quantidade, 5);
  const c = Cart.criarCarrinho();
  c.adicionarItem(itemBase({ quantidade: 3 }));
  c.aplicarQuantidadeInteira(10, 1, 5);
  assert.strictEqual(c.localizar(10, 1).quantidade, 5);
}

function test05VazioRestaura() {
  const d = Cart.interpretarQuantidadeInteiraUi('', 4);
  assert.strictEqual(d.acao, 'restaurar');
  assert.strictEqual(d.quantidade, 4);
}

function test06InvalidoRestaura() {
  assert.strictEqual(Cart.interpretarQuantidadeInteiraUi('abc', 2).acao, 'restaurar');
  assert.strictEqual(Cart.interpretarQuantidadeInteiraUi('1.5', 2).acao, 'restaurar');
  assert.strictEqual(Cart.interpretarQuantidadeInteiraUi('2,0', 2).acao, 'restaurar');
}

function test07ZeroRemove() {
  const d = Cart.interpretarQuantidadeInteiraUi('0', 2);
  assert.strictEqual(d.acao, 'remover');
  const c = Cart.criarCarrinho();
  c.adicionarItem(itemBase({ quantidade: 2 }));
  c.aplicarQuantidadeInteira(10, 1, 0);
  assert.strictEqual(c.obterItens().length, 0);
}

function test08NegativoRemove() {
  const d = Cart.interpretarQuantidadeInteiraUi('-3', 2);
  assert.strictEqual(d.acao, 'remover');
  const c = Cart.criarCarrinho();
  c.adicionarItem(itemBase({ quantidade: 2 }));
  c.aplicarQuantidadeInteira(10, 1, -1);
  assert.strictEqual(c.obterItens().length, 0);
}

function test09IdentidadeCompostaMultiempresa() {
  const c = Cart.criarCarrinho();
  c.adicionarItem(itemBase({ produto_id: 10, empresa_id: 1, quantidade: 2, valor_unitario: 10 }));
  c.adicionarItem(itemBase({ produto_id: 10, empresa_id: 2, quantidade: 3, valor_unitario: 10 }));
  c.aplicarQuantidadeInteira(10, 1, 5);
  assert.strictEqual(c.localizar(10, 1).quantidade, 5);
  assert.strictEqual(c.localizar(10, 2).quantidade, 3);
  c.aplicarQuantidadeInteira(10, 1, 0);
  assert.strictEqual(c.localizar(10, 1), null);
  assert.strictEqual(c.localizar(10, 2).quantidade, 3);
}

function test10SubtotalAtualizado() {
  const c = Cart.criarCarrinho();
  c.adicionarItem(itemBase({ quantidade: 1, valor_unitario: 10 }));
  c.aplicarQuantidadeInteira(10, 1, 3);
  assert.strictEqual(c.localizar(10, 1).subtotal, 30);
  assert.strictEqual(c.calcularTotal(), 30);
}

function test11DescontoContinuaCorreto() {
  const c = Cart.criarCarrinho();
  c.adicionarItem(itemBase({ quantidade: 2, valor_unitario: 50 }));
  c.aplicarQuantidadeInteira(10, 1, 4);
  const t = tela.calcularTotaisOperacionais({
    subtotal: c.calcularTotal(),
    modo_desconto: 'valor',
    desconto_valor: 10,
    acrescimo: 0
  });
  assert.strictEqual(t.subtotal, 200);
  assert.strictEqual(t.desconto_valor, 10);
  assert.strictEqual(t.total, 190);
}

function test12AcrescimoContinuaCorreto() {
  const c = Cart.criarCarrinho();
  c.adicionarItem(itemBase({ quantidade: 1, valor_unitario: 40 }));
  c.aplicarQuantidadeInteira(10, 1, 2);
  const t = tela.calcularTotaisOperacionais({
    subtotal: c.calcularTotal(),
    modo_desconto: 'valor',
    desconto_valor: 0,
    acrescimo: 5
  });
  assert.strictEqual(t.subtotal, 80);
  assert.strictEqual(t.acrescimo, 5);
  assert.strictEqual(t.total, 85);
}

function test13TotalLiquidoAtualizado() {
  const c = Cart.criarCarrinho();
  c.adicionarItem(itemBase({ quantidade: 1, valor_unitario: 100 }));
  c.aplicarQuantidadeInteira(10, 1, 2);
  const t = tela.calcularTotaisOperacionais({
    subtotal: c.calcularTotal(),
    modo_desconto: 'valor',
    desconto_valor: 20,
    acrescimo: 10
  });
  assert.strictEqual(t.subtotal, 200);
  assert.strictEqual(t.total, 190);
}

function run() {
  const testes = [
    test01MaisAumentaQuantidade,
    test02MenosDiminuiQuantidade,
    test03Qtd1MenosRemove,
    test04EdicaoDiretaValida,
    test05VazioRestaura,
    test06InvalidoRestaura,
    test07ZeroRemove,
    test08NegativoRemove,
    test09IdentidadeCompostaMultiempresa,
    test10SubtotalAtualizado,
    test11DescontoContinuaCorreto,
    test12AcrescimoContinuaCorreto,
    test13TotalLiquidoAtualizado
  ];
  for (const t of testes) {
    t();
    console.log('ok', t.name);
  }
  console.log(`${testes.length}/${testes.length}`);
}

run();
