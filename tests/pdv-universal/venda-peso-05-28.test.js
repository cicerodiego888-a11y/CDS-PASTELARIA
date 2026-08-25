/**
 * Sprint 05.28 — quantidade decimal para produtos por peso no PDV Universal.
 */
'use strict';

const assert = require('assert');
const Cart = require('../../frontend/pdv-universal/pdv-universal-cart.js');
const tela = require('../../frontend/pdv-universal/pdv-universal.js');

function itemUnidade(overrides) {
  return Object.assign({
    produto_id: 10,
    empresa_id: 1,
    descricao: 'Unidade',
    quantidade: 1,
    valor_unitario: 10,
    produto_fracionado: 0
  }, overrides || {});
}

function itemPeso(overrides) {
  return Object.assign({
    produto_id: 20,
    empresa_id: 1,
    descricao: 'Peso',
    quantidade: 1,
    valor_unitario: 20,
    produto_fracionado: 1,
    unidade: 'KG'
  }, overrides || {});
}

function test01UnidadeAceitaInteiro() {
  const c = Cart.criarCarrinho();
  c.adicionarItem(itemUnidade({ quantidade: 2 }));
  assert.strictEqual(c.localizar(10, 1).quantidade, 2);
  const d = Cart.interpretarQuantidadeUi('3', 2, { permiteDecimal: false });
  assert.strictEqual(d.acao, 'aplicar');
  assert.strictEqual(d.quantidade, 3);
}

function test02UnidadeRejeitaDecimal() {
  assert.strictEqual(
    Cart.interpretarQuantidadeUi('1,5', 2, { permiteDecimal: false }).acao,
    'restaurar'
  );
  assert.strictEqual(
    Cart.interpretarQuantidadeUi('0,250', 2, { permiteDecimal: false }).acao,
    'restaurar'
  );
  const c = Cart.criarCarrinho();
  c.adicionarItem(itemUnidade({ quantidade: 2 }));
  assert.throws(() => c.aplicarQuantidadeInteira(10, 1, 1.5), /inteira|QUANTIDADE/i);
  assert.strictEqual(c.localizar(10, 1).quantidade, 2);
}

function test03PesoAceita0250() {
  const d = Cart.interpretarQuantidadeUi('0,250', 1, { permiteDecimal: true });
  assert.strictEqual(d.acao, 'aplicar');
  assert.strictEqual(d.quantidade, 0.25);
  const c = Cart.criarCarrinho();
  c.adicionarItem(itemPeso({ quantidade: 1 }));
  c.aplicarQuantidadeInteira(20, 1, 0.25);
  assert.strictEqual(c.localizar(20, 1).quantidade, 0.25);
}

function test04PesoAceita1500() {
  const d = Cart.interpretarQuantidadeUi('1,500', 1, { permiteDecimal: true });
  assert.strictEqual(d.acao, 'aplicar');
  assert.strictEqual(d.quantidade, 1.5);
}

function test05PontoNormalizado() {
  const d = Cart.interpretarQuantidadeUi('0.250', 1, { permiteDecimal: true });
  assert.strictEqual(d.acao, 'aplicar');
  assert.strictEqual(d.quantidade, 0.25);
}

function test06VirgulaNormalizada() {
  const d = Cart.interpretarQuantidadeUi('1,250', 1, { permiteDecimal: true });
  assert.strictEqual(d.acao, 'aplicar');
  assert.strictEqual(d.quantidade, 1.25);
}

function test07TresCasasPreservadas() {
  const d = Cart.interpretarQuantidadeUi('10,125', 1, { permiteDecimal: true });
  assert.strictEqual(d.acao, 'aplicar');
  assert.strictEqual(d.quantidade, 10.125);
  assert.strictEqual(Cart.arredQtd3(0.001), 0.001);
}

function test08MaisDeTresCasasInvalido() {
  assert.strictEqual(
    Cart.interpretarQuantidadeUi('0,2501', 1, { permiteDecimal: true }).acao,
    'restaurar'
  );
  assert.strictEqual(
    Cart.interpretarQuantidadeUi('1.1234', 1, { permiteDecimal: true }).acao,
    'restaurar'
  );
}

function test09InvalidoRestaura() {
  assert.strictEqual(
    Cart.interpretarQuantidadeUi('abc', 0.5, { permiteDecimal: true }).acao,
    'restaurar'
  );
  assert.strictEqual(
    Cart.interpretarQuantidadeUi('', 0.5, { permiteDecimal: true }).quantidade,
    0.5
  );
}

function test10ZeroRemove() {
  assert.strictEqual(
    Cart.interpretarQuantidadeUi('0', 0.5, { permiteDecimal: true }).acao,
    'remover'
  );
  const c = Cart.criarCarrinho();
  c.adicionarItem(itemPeso({ quantidade: 0.5 }));
  c.aplicarQuantidadeInteira(20, 1, 0);
  assert.strictEqual(c.obterItens().length, 0);
}

function test11NegativoRemove() {
  assert.strictEqual(
    Cart.interpretarQuantidadeUi('-0,1', 0.5, { permiteDecimal: true }).acao,
    'remover'
  );
  const c = Cart.criarCarrinho();
  c.adicionarItem(itemPeso({ quantidade: 0.5 }));
  c.aplicarQuantidadeInteira(20, 1, -1);
  assert.strictEqual(c.obterItens().length, 0);
}

function test12Subtotal0500() {
  const c = Cart.criarCarrinho();
  c.adicionarItem(itemPeso({ quantidade: 0.5, valor_unitario: 20 }));
  assert.strictEqual(c.localizar(20, 1).quantidade, 0.5);
  assert.strictEqual(c.localizar(20, 1).subtotal, 10);
  assert.strictEqual(c.calcularTotal(), 10);
}

function test13DescontoContinua() {
  const c = Cart.criarCarrinho();
  c.adicionarItem(itemPeso({ quantidade: 0.5, valor_unitario: 20 }));
  const t = tela.calcularTotaisOperacionais({
    subtotal: c.calcularTotal(),
    modo_desconto: 'valor',
    desconto_valor: 2,
    acrescimo: 0
  });
  assert.strictEqual(t.subtotal, 10);
  assert.strictEqual(t.desconto_valor, 2);
  assert.strictEqual(t.total, 8);
}

function test14AcrescimoContinua() {
  const c = Cart.criarCarrinho();
  c.adicionarItem(itemPeso({ quantidade: 1.5, valor_unitario: 20 }));
  const t = tela.calcularTotaisOperacionais({
    subtotal: c.calcularTotal(),
    modo_desconto: 'valor',
    desconto_valor: 0,
    acrescimo: 3
  });
  assert.strictEqual(t.subtotal, 30);
  assert.strictEqual(t.acrescimo, 3);
  assert.strictEqual(t.total, 33);
}

function test15IdentidadeComposta() {
  assert.ok(Cart.produtoVendidoPorPeso({ produto_fracionado: 1 }));
  assert.ok(Cart.produtoVendidoPorPeso({ produto_pesavel: 1 }));
  assert.ok(!Cart.produtoVendidoPorPeso({ produto_fracionado: 0 }));
  const c = Cart.criarCarrinho();
  c.adicionarItem(itemPeso({ produto_id: 10, empresa_id: 1, quantidade: 0.25 }));
  c.adicionarItem(itemPeso({ produto_id: 10, empresa_id: 2, quantidade: 0.5 }));
  c.aplicarQuantidadeInteira(10, 1, 1.25);
  assert.strictEqual(c.localizar(10, 1).quantidade, 1.25);
  assert.strictEqual(c.localizar(10, 2).quantidade, 0.5);
}

function run() {
  const testes = [
    test01UnidadeAceitaInteiro,
    test02UnidadeRejeitaDecimal,
    test03PesoAceita0250,
    test04PesoAceita1500,
    test05PontoNormalizado,
    test06VirgulaNormalizada,
    test07TresCasasPreservadas,
    test08MaisDeTresCasasInvalido,
    test09InvalidoRestaura,
    test10ZeroRemove,
    test11NegativoRemove,
    test12Subtotal0500,
    test13DescontoContinua,
    test14AcrescimoContinua,
    test15IdentidadeComposta
  ];
  for (const t of testes) {
    t();
    console.log('ok', t.name);
  }
  console.log(`${testes.length}/${testes.length}`);
}

run();
