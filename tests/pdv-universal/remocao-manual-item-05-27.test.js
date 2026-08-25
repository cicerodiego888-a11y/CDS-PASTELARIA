/**
 * Sprint 05.27 — remoção manual de item no PDV Universal.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Cart = require('../../frontend/pdv-universal/pdv-universal-cart.js');
const tela = require('../../frontend/pdv-universal/pdv-universal.js');
const checkout = require('../../frontend/pdv-universal/pdv-universal-checkout.js');

const ROOT = path.join(__dirname, '../..');

function itemBase(overrides) {
  return Object.assign({
    produto_id: 10,
    empresa_id: 1,
    descricao: 'Produto',
    quantidade: 2,
    valor_unitario: 10
  }, overrides || {});
}

function test01AcaoRemoverNaRenderizacao() {
  const js = fs.readFileSync(path.join(ROOT, 'frontend/pdv-universal/pdv-universal.js'), 'utf8');
  assert.ok(js.includes('pdvu-btn-remover-item'));
  assert.ok(js.includes("data-acao', 'REMOVER'") || js.includes('data-acao="REMOVER"') || js.includes("setAttribute('data-acao', 'REMOVER')"));
  assert.ok(js.includes('removerItemManualUi'));
  const css = fs.readFileSync(path.join(ROOT, 'frontend/pdv-universal/pdv-universal.css'), 'utf8');
  assert.ok(css.includes('.pdvu-btn-remover-item'));
}

function test02RemoverDoCarrinho() {
  const c = Cart.criarCarrinho();
  c.adicionarItem(itemBase());
  assert.strictEqual(c.removerItem(10, 1), true);
  assert.strictEqual(c.localizar(10, 1), null);
  assert.strictEqual(c.obterItens().length, 0);
}

function test03SubtotalAtualizado() {
  const c = Cart.criarCarrinho();
  c.adicionarItem(itemBase({ quantidade: 2, valor_unitario: 10 }));
  c.adicionarItem(itemBase({ produto_id: 20, quantidade: 1, valor_unitario: 5 }));
  assert.strictEqual(c.calcularTotal(), 25);
  c.removerItem(10, 1);
  assert.strictEqual(c.calcularTotal(), 5);
}

function test04TotalLiquidoAtualizado() {
  const c = Cart.criarCarrinho();
  c.adicionarItem(itemBase({ quantidade: 2, valor_unitario: 50 }));
  c.removerItem(10, 1);
  const t = tela.calcularTotaisOperacionais({
    subtotal: c.calcularTotal(),
    modo_desconto: 'valor',
    desconto_valor: 0,
    acrescimo: 0
  });
  assert.strictEqual(t.subtotal, 0);
  assert.strictEqual(t.total, 0);
}

function test05DescontoRegraExistente() {
  const c = Cart.criarCarrinho();
  c.adicionarItem(itemBase({ quantidade: 3, valor_unitario: 20 }));
  c.removerItem(10, 1);
  const t = tela.calcularTotaisOperacionais({
    subtotal: c.calcularTotal(),
    modo_desconto: 'valor',
    desconto_valor: 15,
    acrescimo: 0
  });
  assert.strictEqual(t.subtotal, 0);
  assert.strictEqual(t.desconto_valor, 0);
  assert.strictEqual(t.total, 0);
}

function test06AcrescimoRegraExistente() {
  const c = Cart.criarCarrinho();
  c.adicionarItem(itemBase({ quantidade: 1, valor_unitario: 40 }));
  c.adicionarItem(itemBase({ produto_id: 11, quantidade: 1, valor_unitario: 10 }));
  c.removerItem(10, 1);
  const t = tela.calcularTotaisOperacionais({
    subtotal: c.calcularTotal(),
    modo_desconto: 'valor',
    desconto_valor: 0,
    acrescimo: 5
  });
  assert.strictEqual(t.subtotal, 10);
  assert.strictEqual(t.acrescimo, 5);
  assert.strictEqual(t.total, 15);
}

function test07UltimoItemDeixaVazio() {
  const c = Cart.criarCarrinho();
  c.adicionarItem(itemBase());
  c.removerItem(10, 1);
  assert.strictEqual(c.obterItens().length, 0);
  assert.strictEqual(c.calcularTotal(), 0);
}

function test08MultiempresaIdentidadeComposta() {
  const c = Cart.criarCarrinho();
  c.adicionarItem(itemBase({ produto_id: 10, empresa_id: 1, quantidade: 2 }));
  c.adicionarItem(itemBase({ produto_id: 10, empresa_id: 2, quantidade: 3 }));
  assert.strictEqual(Cart.chaveItem(10, 1), '10:1');
  c.removerItem(10, 1);
  assert.strictEqual(c.localizar(10, 1), null);
  assert.strictEqual(c.localizar(10, 2).quantidade, 3);
}

function test09InexistenteNaoRemoveOutro() {
  const c = Cart.criarCarrinho();
  c.adicionarItem(itemBase({ produto_id: 10, empresa_id: 2, quantidade: 3 }));
  assert.strictEqual(c.removerItem(10, 1), false);
  assert.strictEqual(c.localizar(10, 2).quantidade, 3);
  assert.strictEqual(c.obterItens().length, 1);
}

function test10FinalizarCarrinhoVazio() {
  const c = Cart.criarCarrinho();
  c.adicionarItem(itemBase());
  const ctx = {
    capacidades: { checkout_empresa_unica: true },
    empresa_selecionada: { id: 1 }
  };
  assert.strictEqual(checkout.podeFinalizar(ctx, c.obterItens()), true);
  c.removerItem(10, 1);
  assert.strictEqual(checkout.podeFinalizar(ctx, c.obterItens()), false);
}

function run() {
  const testes = [
    test01AcaoRemoverNaRenderizacao,
    test02RemoverDoCarrinho,
    test03SubtotalAtualizado,
    test04TotalLiquidoAtualizado,
    test05DescontoRegraExistente,
    test06AcrescimoRegraExistente,
    test07UltimoItemDeixaVazio,
    test08MultiempresaIdentidadeComposta,
    test09InexistenteNaoRemoveOutro,
    test10FinalizarCarrinhoVazio
  ];
  for (const t of testes) {
    t();
    console.log('ok', t.name);
  }
  console.log(`${testes.length}/${testes.length}`);
}

run();
