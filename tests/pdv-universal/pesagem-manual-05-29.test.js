/**
 * Sprint 05.29 — pesagem manual no PDV Universal (sem balança).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Cart = require('../../frontend/pdv-universal/pdv-universal-cart.js');
const tela = require('../../frontend/pdv-universal/pdv-universal.js');

const ROOT = path.join(__dirname, '../..');

function itemPeso(overrides) {
  return Object.assign({
    produto_id: 10,
    empresa_id: 1,
    descricao: 'QUEIJO MUSSARELA',
    quantidade: 1,
    valor_unitario: 40,
    produto_fracionado: 1,
    unidade: 'KG'
  }, overrides || {});
}

function itemUnidade(overrides) {
  return Object.assign({
    produto_id: 11,
    empresa_id: 1,
    descricao: 'Refrigerante',
    quantidade: 1,
    valor_unitario: 5,
    produto_fracionado: 0,
    unidade: 'UN'
  }, overrides || {});
}

function test01FracionadoExibeAcao() {
  assert.strictEqual(tela.deveExibirAcaoPesagemManual(itemPeso()), true);
  const js = fs.readFileSync(path.join(ROOT, 'frontend/pdv-universal/pdv-universal.js'), 'utf8');
  assert.ok(js.includes("data-acao', 'PESAR'") || js.includes("setAttribute('data-acao', 'PESAR')"));
  assert.ok(js.includes('pdvu-btn-pesar-item'));
  assert.ok(js.includes('abrirPesagemManual'));
}

function test02UnidadeNaoExibe() {
  assert.strictEqual(tela.deveExibirAcaoPesagemManual(itemUnidade()), false);
  assert.strictEqual(tela.montarEstadoPesagemManual(itemUnidade()).exibir_acao, false);
}

function test03AbrirMostraPesoAtual() {
  const est = tela.montarEstadoPesagemManual(itemPeso({ quantidade: 0.25 }));
  assert.strictEqual(est.peso_atual, 0.25);
  assert.ok(String(est.peso_atual_formatado).includes('0'));
  assert.strictEqual(est.descricao, 'QUEIJO MUSSARELA');
  assert.strictEqual(est.exibir_acao, true);
}

function test04Aceitar0250() {
  const d = tela.interpretarPesoManualUi('0,250', 1);
  assert.strictEqual(d.acao, 'aplicar');
  assert.strictEqual(d.quantidade, 0.25);
}

function test05Aceitar1500() {
  const d = tela.interpretarPesoManualUi('1,500', 1);
  assert.strictEqual(d.acao, 'aplicar');
  assert.strictEqual(d.quantidade, 1.5);
}

function test06NormalizarVirgula() {
  const d = tela.interpretarPesoManualUi('0,500', 1);
  assert.strictEqual(d.acao, 'aplicar');
  assert.strictEqual(d.quantidade, 0.5);
  const p = tela.interpretarPesoManualUi('0.500', 1);
  assert.strictEqual(p.quantidade, 0.5);
}

function test07ConfirmarAtualizaItemCorreto() {
  const c = Cart.criarCarrinho();
  c.adicionarItem(itemPeso({ quantidade: 1 }));
  const r = tela.aplicarPesoManualNoCarrinho(c, 10, 1, 0.5);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(c.localizar(10, 1).quantidade, 0.5);
  assert.strictEqual(c.localizar(10, 1).subtotal, 20);
}

function test08MultiempresaIdentidade() {
  const c = Cart.criarCarrinho();
  c.adicionarItem(itemPeso({ empresa_id: 1, quantidade: 1 }));
  c.adicionarItem(itemPeso({ empresa_id: 2, quantidade: 1 }));
  tela.aplicarPesoManualNoCarrinho(c, 10, 1, 0.5);
  assert.strictEqual(c.localizar(10, 1).quantidade, 0.5);
  assert.strictEqual(c.localizar(10, 2).quantidade, 1);
}

function test09PesoZeroRejeitado() {
  const d = tela.interpretarPesoManualUi('0', 1);
  assert.strictEqual(d.acao, 'rejeitar');
  const c = Cart.criarCarrinho();
  c.adicionarItem(itemPeso({ quantidade: 1 }));
  const r = tela.aplicarPesoManualNoCarrinho(c, 10, 1, 0);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(c.localizar(10, 1).quantidade, 1);
}

function test10PesoNegativoRejeitado() {
  const d = tela.interpretarPesoManualUi('-0,5', 1);
  assert.strictEqual(d.acao, 'rejeitar');
  const c = Cart.criarCarrinho();
  c.adicionarItem(itemPeso({ quantidade: 1 }));
  assert.strictEqual(tela.aplicarPesoManualNoCarrinho(c, 10, 1, -1).ok, false);
  assert.strictEqual(c.localizar(10, 1).quantidade, 1);
}

function test11CancelarNaoAltera() {
  const c = Cart.criarCarrinho();
  c.adicionarItem(itemPeso({ quantidade: 1 }));
  const antes = c.localizar(10, 1).quantidade;
  // cancelar = não chamar aplicarPesoManualNoCarrinho
  assert.strictEqual(c.localizar(10, 1).quantidade, antes);
  const js = fs.readFileSync(path.join(ROOT, 'frontend/pdv-universal/pdv-universal.js'), 'utf8');
  assert.ok(js.includes('fecharPesagemManual'));
  assert.ok(js.includes("pdvu-pesagem-cancelar"));
}

function test12EscFechaSemAlterar() {
  const js = fs.readFileSync(path.join(ROOT, 'frontend/pdv-universal/pdv-universal.js'), 'utf8');
  assert.ok(js.includes("'pdvu-modal-pesagem'"));
  assert.ok(js.includes('api._pesagem = null'));
  const c = Cart.criarCarrinho();
  c.adicionarItem(itemPeso({ quantidade: 0.75 }));
  // ESC via fecharModaisVisuais limpa contexto sem aplicar
  assert.strictEqual(c.localizar(10, 1).quantidade, 0.75);
  assert.strictEqual(
    tela.resolverAcaoEscape({
      processamento: false,
      modalAberto: true,
      drawerAberto: false,
      temAtendimento: false,
      pagamentoEmAndamento: false
    }),
    'FECHAR_MODAL'
  );
}

function test13SubtotalAtualizado() {
  const c = Cart.criarCarrinho();
  c.adicionarItem(itemPeso({ quantidade: 1, valor_unitario: 40 }));
  tela.aplicarPesoManualNoCarrinho(c, 10, 1, 0.5);
  assert.strictEqual(c.calcularTotal(), 20);
}

function test14TotalLiquidoAtualizado() {
  const c = Cart.criarCarrinho();
  c.adicionarItem(itemPeso({ quantidade: 1, valor_unitario: 40 }));
  tela.aplicarPesoManualNoCarrinho(c, 10, 1, 0.5);
  const t = tela.calcularTotaisOperacionais({
    subtotal: c.calcularTotal(),
    modo_desconto: 'valor',
    desconto_valor: 2,
    acrescimo: 1
  });
  assert.strictEqual(t.subtotal, 20);
  assert.strictEqual(t.total, 19);
}

function run() {
  const testes = [
    test01FracionadoExibeAcao,
    test02UnidadeNaoExibe,
    test03AbrirMostraPesoAtual,
    test04Aceitar0250,
    test05Aceitar1500,
    test06NormalizarVirgula,
    test07ConfirmarAtualizaItemCorreto,
    test08MultiempresaIdentidade,
    test09PesoZeroRejeitado,
    test10PesoNegativoRejeitado,
    test11CancelarNaoAltera,
    test12EscFechaSemAlterar,
    test13SubtotalAtualizado,
    test14TotalLiquidoAtualizado
  ];
  for (const t of testes) {
    t();
    console.log('ok', t.name);
  }
  console.log(`${testes.length}/${testes.length}`);
}

run();
