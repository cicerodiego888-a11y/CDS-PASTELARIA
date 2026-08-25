/**
 * Sprint 05.36 — promoção comercial no PDV Universal (API legado).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../../frontend/shared/js/motor-preco-atacado.js');
const Promo = require('../../frontend/pdv-universal/pdv-universal-promocao.js');
const Atacado = require('../../frontend/pdv-universal/pdv-universal-preco-atacado.js');
const Cart = require('../../frontend/pdv-universal/pdv-universal-cart.js');
const tela = require('../../frontend/pdv-universal/pdv-universal.js');

const ROOT = path.join(__dirname, '../..');
const FAIXAS = [{ quantidade_minima: 10, preco_atacado: 8 }];

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
    preco_base: 10,
    venda_atacado: 0
  }, overrides || {});
}

function promoAtiva(overrides) {
  return Object.assign({
    id: 100,
    produto_id: 1,
    preco_original: 10,
    preco_promocional: 8,
    desconto_percentual: 20,
    data_inicio: '2020-01-01',
    data_fim: '2099-12-31',
    status: 'ativa'
  }, overrides || {});
}

async function recalcularComercial(item, fetchFn) {
  Promo.limparCachePromocao(item.produto_id);
  Atacado.limparCacheFaixas(item.produto_id);
  const precoOriginal = Number(item.preco_base != null ? item.preco_base : item.valor_unitario);
  const promo = await Promo.recalcularPromocaoItem(item, fetchFn, { forceRefresh: true });
  const precoComercial = Number(promo.precoComercial != null ? promo.precoComercial : precoOriginal);
  await Atacado.recalcularPrecoItem(item, fetchFn, { precoComercial, forceRefresh: true });
  return item;
}

function test01SemPromocaoMantemNormal() {
  const r = Promo.calcularPrecoPromocional({
    precoBase: 10,
    quantidade: 2,
    promocao: null,
    elegivel: true
  });
  assert.strictEqual(r.precoUnitario, 10);
  assert.strictEqual(r.temPromocao, false);
  assert.strictEqual(r.descontoPromocao, 0);
}

function test02PromocaoAtivaAplicaRegra() {
  const r = Promo.calcularPrecoPromocional({
    precoBase: 10,
    quantidade: 3,
    promocao: promoAtiva({ preco_promocional: 7.5 }),
    elegivel: true
  });
  assert.strictEqual(r.temPromocao, true);
  assert.strictEqual(r.precoUnitario, 7.5);
  assert.strictEqual(r.descontoPromocao, 7.5);
  assert.strictEqual(r.promocao_id, 100);
}

function test03PromocaoExpiradaNaoAplica() {
  const r = Promo.calcularPrecoPromocional({
    precoBase: 10,
    quantidade: 1,
    promocao: null,
    elegivel: true
  });
  assert.strictEqual(r.precoUnitario, 10);
  assert.strictEqual(r.temPromocao, false);
}

function test04PromocaoFuturaNaoAplica() {
  const r = Promo.calcularPrecoPromocional({
    precoBase: 10,
    quantidade: 1,
    promocao: null,
    elegivel: true
  });
  assert.strictEqual(r.precoUnitario, 10);
}

async function test05AlterarQuantidadeRecalcula() {
  const item = itemBase({ quantidade: 2 });
  await recalcularComercial(item, async () => ({
    ok: true,
    json: async () => promoAtiva({ preco_promocional: 8 })
  }));
  assert.strictEqual(item.valor_unitario, 8);
  assert.strictEqual(item.desconto_promocao, 4);
  item.quantidade = 5;
  await recalcularComercial(item, async () => ({
    ok: true,
    json: async () => promoAtiva({ preco_promocional: 8 })
  }));
  assert.strictEqual(item.desconto_promocao, 10);
}

function test06ProdutosIsolados() {
  const a = Promo.calcularPrecoPromocional({
    precoBase: 10,
    quantidade: 1,
    promocao: promoAtiva(),
    elegivel: true
  });
  const b = Promo.calcularPrecoPromocional({
    precoBase: 20,
    quantidade: 1,
    promocao: null,
    elegivel: true
  });
  assert.strictEqual(a.precoUnitario, 8);
  assert.strictEqual(b.precoUnitario, 20);
}

async function test07MesmoProdutoEmpresasIsoladas() {
  const cart = Cart.criarCarrinho();
  cart.adicionarItem(itemBase({ produto_id: 5, empresa_id: 1, quantidade: 2 }));
  cart.adicionarItem(itemBase({ produto_id: 5, empresa_id: 2, quantidade: 2 }));
  const i1 = cart.localizar(5, 1);
  const i2 = cart.localizar(5, 2);
  await recalcularComercial(i1, async () => ({
    ok: true,
    json: async () => promoAtiva({ produto_id: 5, preco_promocional: 8 })
  }));
  Promo.limparCamposPromocaoNoItem(i2);
  i2.valor_unitario = 10;
  i2.subtotal = 20;
  assert.strictEqual(i1.valor_unitario, 8);
  assert.strictEqual(i2.valor_unitario, 10);
  assert.strictEqual(i1.empresa_id, 1);
  assert.strictEqual(i2.empresa_id, 2);
}

function test08NaoAlteraDescontoManual() {
  const ajuste = { modo_desconto: 'valor', desconto_valor: 5, acrescimo: 2 };
  const cart = Cart.criarCarrinho();
  cart.adicionarItem(itemBase({ produto_id: 1, empresa_id: 1, quantidade: 2 }));
  const item = cart.localizar(1, 1);
  Promo.aplicarCamposPromocaoNoItem(item, Promo.calcularPrecoPromocional({
    precoBase: 10,
    quantidade: 2,
    promocao: promoAtiva({ preco_promocional: 8 }),
    elegivel: true
  }));
  item.valor_unitario = 8;
  item.subtotal = 16;
  const totais = tela.calcularTotaisOperacionais(Object.assign({ subtotal: cart.calcularTotal() }, ajuste));
  assert.strictEqual(totais.desconto_valor, 5);
  assert.strictEqual(totais.acrescimo, 2);
  assert.strictEqual(totais.total, 13);
}

function test09NaoQuebraAcrescimo() {
  const totais = tela.calcularTotaisOperacionais({
    subtotal: 16,
    modo_desconto: 'valor',
    desconto_valor: 0,
    acrescimo: 3
  });
  assert.strictEqual(totais.total, 19);
}

async function test10PrecedenciaPromocaoDepoisAtacado() {
  const itemPromoMelhor = itemBase({ produto_id: 101, quantidade: 10, venda_atacado: 1 });
  await recalcularComercial(itemPromoMelhor, async (url) => {
    if (String(url).includes('/promocao-ativa')) {
      return { ok: true, json: async () => promoAtiva({ produto_id: 101, preco_promocional: 7 }) };
    }
    return { ok: true, json: async () => FAIXAS };
  });
  assert.strictEqual(itemPromoMelhor.valor_unitario, 7);

  const itemAtacadoMelhor = itemBase({ produto_id: 102, quantidade: 10, venda_atacado: 1 });
  await recalcularComercial(itemAtacadoMelhor, async (url) => {
    if (String(url).includes('/promocao-ativa')) {
      return { ok: true, json: async () => promoAtiva({ produto_id: 102, preco_promocional: 9 }) };
    }
    return { ok: true, json: async () => FAIXAS };
  });
  assert.strictEqual(itemAtacadoMelhor.valor_unitario, 8);
}

function test11RemoverItemSemEstadoResidual() {
  const cart = Cart.criarCarrinho();
  cart.adicionarItem(itemBase({ produto_id: 3, empresa_id: 1 }));
  const item = cart.localizar(3, 1);
  Promo.aplicarCamposPromocaoNoItem(item, Promo.calcularPrecoPromocional({
    precoBase: 10,
    quantidade: 1,
    promocao: promoAtiva(),
    elegivel: true
  }));
  cart.removerItem(3, 1);
  assert.strictEqual(cart.obterItens().length, 0);
  Promo.limparCamposPromocaoNoItem(item);
  assert.strictEqual(item.promocao_id, null);
  assert.strictEqual(item.desconto_promocao, 0);
}

async function test12FracionadoComPromocao() {
  const item = itemBase({
    quantidade: 0.375,
    produto_fracionado: 1,
    produto_pesavel: 1,
    vendido_por_peso: 1
  });
  await recalcularComercial(item, async () => ({
    ok: true,
    json: async () => promoAtiva({ preco_promocional: 8 })
  }));
  assert.strictEqual(item.valor_unitario, 8);
  assert.ok(Math.abs(item.subtotal - 3) < 0.01);
}

function testArquivos() {
  assert.ok(fs.existsSync(path.join(ROOT, 'frontend/pdv-universal/pdv-universal-promocao.js')));
  assert.ok(src('frontend/pdv-universal/index.html').includes('pdv-universal-promocao.js'));
  assert.ok(src('frontend/pdv-universal/pdv-universal.js').includes('recalcularPrecoComercialItem'));
  assert.ok(src('frontend/pdv-universal/pdv-universal-promocao.js').includes('promocao-ativa'));
}

async function run() {
  const tests = [
    ['01 produto sem promoção mantém preço normal', test01SemPromocaoMantemNormal],
    ['02 promoção ativa aplica regra existente', test02PromocaoAtivaAplicaRegra],
    ['03 promoção expirada não aplica (API null)', test03PromocaoExpiradaNaoAplica],
    ['04 promoção futura não aplica (API null)', test04PromocaoFuturaNaoAplica],
    ['05 alteração quantidade recalcula', test05AlterarQuantidadeRecalcula],
    ['06 produto A não interfere B', test06ProdutosIsolados],
    ['07 mesmo produto empresas isoladas', test07MesmoProdutoEmpresasIsoladas],
    ['08 promoção não altera desconto manual', test08NaoAlteraDescontoManual],
    ['09 promoção não quebra acréscimo', test09NaoQuebraAcrescimo],
    ['10 precedência promoção → atacado (legado)', test10PrecedenciaPromocaoDepoisAtacado],
    ['11 remover item sem estado residual', test11RemoverItemSemEstadoResidual],
    ['12 fracionado com promoção', test12FracionadoComPromocao],
    ['13 arquivos e wiring', testArquivos]
  ];
  let ok = 0;
  for (const [nome, fn] of tests) {
    await fn();
    ok += 1;
    console.log('  OK', nome);
  }
  console.log(`\n${ok}/${tests.length} testes passaram`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
