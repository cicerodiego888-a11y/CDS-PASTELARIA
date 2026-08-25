/**
 * Sprint 05.35 — preço atacado no PDV Universal (motor compartilhado).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../../frontend/shared/js/motor-preco-atacado.js');
const Atacado = require('../../frontend/pdv-universal/pdv-universal-preco-atacado.js');
const Cart = require('../../frontend/pdv-universal/pdv-universal-cart.js');
const checkout = require('../../frontend/pdv-universal/pdv-universal-checkout.js');
const tela = require('../../frontend/pdv-universal/pdv-universal.js');

const ROOT = path.join(__dirname, '../..');
const FAIXAS = [
  { quantidade_minima: 10, preco_atacado: 8 },
  { quantidade_minima: 50, preco_atacado: 7 }
];

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function itemBase(overrides) {
  return Object.assign({
    produto_id: 1,
    empresa_id: 10,
    descricao: 'Prod A',
    quantidade: 5,
    valor_unitario: 10,
    subtotal: 50,
    venda_atacado: 1,
    preco_base: 10
  }, overrides || {});
}

function test01SemRegraMantemPrecoNormal() {
  const r = Atacado.calcularPrecoAtacado({ precoBase: 10, quantidade: 5, faixas: [] });
  assert.strictEqual(r.precoUnitario, 10);
  assert.strictEqual(r.isAtacado, false);
  assert.strictEqual(r.descontoAtacado, 0);
}

function test02AbaixoFaixaMantemNormal() {
  const r = Atacado.calcularPrecoAtacado({ precoBase: 10, quantidade: 9, faixas: FAIXAS });
  assert.strictEqual(r.isAtacado, false);
  assert.strictEqual(r.precoUnitario, 10);
}

function test03DentroFaixaAplicaAtacado() {
  const r = Atacado.calcularPrecoAtacado({ precoBase: 10, quantidade: 10, faixas: FAIXAS });
  assert.strictEqual(r.isAtacado, true);
  assert.strictEqual(r.precoUnitario, 8);
  assert.strictEqual(r.subtotal, 80);
  assert.ok(r.descontoAtacado > 0);
}

function test04AlterarQuantidadeRecalcula() {
  const item = itemBase({ quantidade: 10 });
  Atacado.aplicarResultadoNoItem(item, Atacado.calcularPrecoAtacado({
    precoBase: 10,
    quantidade: 10,
    faixas: FAIXAS
  }), 10);
  assert.strictEqual(item.valor_unitario, 8);
  Atacado.aplicarResultadoNoItem(item, Atacado.calcularPrecoAtacado({
    precoBase: 10,
    quantidade: 50,
    faixas: FAIXAS
  }), 10);
  assert.strictEqual(item.valor_unitario, 7);
  assert.strictEqual(item.subtotal, 350);
}

function test05ReduzirAbaixoFaixaRestauraNormal() {
  const item = itemBase({ quantidade: 50, valor_unitario: 7, subtotal: 350 });
  Atacado.aplicarResultadoNoItem(item, Atacado.calcularPrecoAtacado({
    precoBase: 10,
    quantidade: 5,
    faixas: FAIXAS
  }), 10);
  assert.strictEqual(item.valor_unitario, 10);
  assert.strictEqual(item.tipo_preco, 'varejo');
}

function test06ProdutosIsolados() {
  const a = itemBase({ produto_id: 1, quantidade: 50 });
  const b = itemBase({ produto_id: 2, quantidade: 50, preco_base: 20, valor_unitario: 20 });
  Atacado.aplicarResultadoNoItem(a, Atacado.calcularPrecoAtacado({ precoBase: 10, quantidade: 50, faixas: FAIXAS }), 10);
  Atacado.aplicarResultadoNoItem(b, Atacado.calcularPrecoAtacado({ precoBase: 20, quantidade: 50, faixas: [] }), 20);
  assert.strictEqual(a.valor_unitario, 7);
  assert.strictEqual(b.valor_unitario, 20);
}

function test07MesmoProdutoEmpresasIsoladas() {
  const c = Cart.criarCarrinho();
  c.adicionarItem({ produto_id: 5, empresa_id: 1, descricao: 'X', quantidade: 50, valor_unitario: 10, venda_atacado: 1, preco_base: 10 });
  c.adicionarItem({ produto_id: 5, empresa_id: 2, descricao: 'X', quantidade: 5, valor_unitario: 10, venda_atacado: 1, preco_base: 10 });
  const i1 = c.localizar(5, 1);
  const i2 = c.localizar(5, 2);
  Atacado.aplicarResultadoNoItem(i1, Atacado.calcularPrecoAtacado({ precoBase: 10, quantidade: 50, faixas: FAIXAS }), 10);
  Atacado.aplicarResultadoNoItem(i2, Atacado.calcularPrecoAtacado({ precoBase: 10, quantidade: 5, faixas: FAIXAS }), 10);
  assert.strictEqual(i1.valor_unitario, 7);
  assert.strictEqual(i2.valor_unitario, 10);
}

function test08NaoAlteraDescontoManual() {
  const ajusteAntes = { modo_desconto: 'valor', desconto_valor: 5, acrescimo: 2 };
  const cart = Cart.criarCarrinho();
  cart.adicionarItem({ produto_id: 1, empresa_id: 1, descricao: 'A', quantidade: 10, valor_unitario: 10 });
  const item = cart.localizar(1, 1);
  Atacado.aplicarResultadoNoItem(item, Atacado.calcularPrecoAtacado({ precoBase: 10, quantidade: 10, faixas: FAIXAS }), 10);
  const totais = tela.calcularTotaisOperacionais(Object.assign({ subtotal: cart.calcularTotal() }, ajusteAntes));
  assert.strictEqual(totais.desconto_valor, 5);
  assert.strictEqual(totais.acrescimo, 2);
  assert.strictEqual(totais.total, 77);
}

function test09AtacadoAntesAcrescimo() {
  const cart = Cart.criarCarrinho();
  cart.adicionarItem({ produto_id: 1, empresa_id: 1, descricao: 'A', quantidade: 10, valor_unitario: 10 });
  const item = cart.localizar(1, 1);
  Atacado.aplicarResultadoNoItem(item, Atacado.calcularPrecoAtacado({ precoBase: 10, quantidade: 10, faixas: FAIXAS }), 10);
  assert.strictEqual(cart.calcularTotal(), 80);
  const totais = tela.calcularTotaisOperacionais({ subtotal: 80, acrescimo: 3 });
  assert.strictEqual(totais.total, 83);
}

function test10FracionadoRespeitaQuantidade() {
  const c = Cart.criarCarrinho();
  c.adicionarItem({
    produto_id: 9,
    empresa_id: 1,
    descricao: 'Peso',
    quantidade: 1.5,
    valor_unitario: 20,
    produto_fracionado: 1,
    venda_atacado: 1,
    preco_base: 20
  });
  const item = c.localizar(9, 1);
  assert.strictEqual(item.quantidade, 1.5);
  Atacado.aplicarResultadoNoItem(item, Atacado.calcularPrecoAtacado({
    precoBase: 20,
    quantidade: 1.5,
    faixas: [{ quantidade_minima: 1, preco_atacado: 18 }]
  }), 20);
  assert.strictEqual(item.quantidade, 1.5);
  assert.strictEqual(item.subtotal, 27);
}

async function test11BuscaFaixasEndpointExistente() {
  Atacado.limparCacheFaixas();
  let url = '';
  await Atacado.buscarFaixasAtacado(99, async (u) => {
    url = u;
    return { ok: true, json: async () => FAIXAS };
  });
  assert.ok(url.endsWith('/produtos/99/atacado'));
}

function test12CheckoutIntacto() {
  assert.ok(checkout.urlCheckout().endsWith('/pdv-universal/checkout'));
  assert.ok(!src('frontend/pdv-universal/pdv-universal-checkout.js').includes('atacado'));
  assert.ok(src('frontend/pdv-universal/pdv-universal.js').includes('recalcularAtacadoItem'));
}

async function run() {
  const testes = [
    test01SemRegraMantemPrecoNormal,
    test02AbaixoFaixaMantemNormal,
    test03DentroFaixaAplicaAtacado,
    test04AlterarQuantidadeRecalcula,
    test05ReduzirAbaixoFaixaRestauraNormal,
    test06ProdutosIsolados,
    test07MesmoProdutoEmpresasIsoladas,
    test08NaoAlteraDescontoManual,
    test09AtacadoAntesAcrescimo,
    test10FracionadoRespeitaQuantidade,
    test11BuscaFaixasEndpointExistente,
    test12CheckoutIntacto
  ];
  for (const t of testes) {
    await t();
    console.log('ok', t.name);
  }
  console.log(`${testes.length}/${testes.length}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
