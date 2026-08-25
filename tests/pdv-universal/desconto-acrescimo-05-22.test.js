/**
 * Sprint 05.22 — desconto R$ / % e acréscimo R$ no PDV Universal.
 */
'use strict';

const assert = require('assert');
const tela = require('../../frontend/pdv-universal/pdv-universal.js');
const checkout = require('../../frontend/pdv-universal/pdv-universal-checkout.js');
const vendaAdapter = require('../../backend/services/pdv-universal/PDVUniversalVendaAdapter');

function test01SubtotalSemAlteracoes() {
  const t = tela.calcularTotaisOperacionais({
    subtotal: 100,
    modo_desconto: 'valor',
    desconto_valor: '',
    desconto_percentual: '',
    acrescimo: ''
  });
  assert.strictEqual(t.subtotal, 100);
  assert.strictEqual(t.desconto_valor, 0);
  assert.strictEqual(t.acrescimo, 0);
  assert.strictEqual(t.total, 100);
}

function test02DescontoEmRs() {
  const t = tela.calcularTotaisOperacionais({
    subtotal: 100,
    modo_desconto: 'valor',
    desconto_valor: 15,
    acrescimo: 0
  });
  assert.strictEqual(t.desconto_valor, 15);
  assert.strictEqual(t.total, 85);
}

function test03DescontoPercentual() {
  const t = tela.calcularTotaisOperacionais({
    subtotal: 200,
    modo_desconto: 'percentual',
    desconto_percentual: 10,
    acrescimo: 0
  });
  assert.strictEqual(t.desconto_valor, 20);
  assert.strictEqual(t.desconto_percentual, 10);
  assert.strictEqual(t.total, 180);
}

function test04AcrescimoEmRs() {
  const t = tela.calcularTotaisOperacionais({
    subtotal: 50,
    modo_desconto: 'valor',
    desconto_valor: 0,
    acrescimo: 7.5
  });
  assert.strictEqual(t.acrescimo, 7.5);
  assert.strictEqual(t.total, 57.5);
}

function test05DescontoMaisAcrescimo() {
  const t = tela.calcularTotaisOperacionais({
    subtotal: 100,
    modo_desconto: 'valor',
    desconto_valor: 10,
    acrescimo: 5
  });
  assert.strictEqual(t.total, 95);
}

function test06DescontoMaximo() {
  const t = tela.calcularTotaisOperacionais({
    subtotal: 40,
    modo_desconto: 'valor',
    desconto_valor: 999,
    acrescimo: 0
  });
  assert.strictEqual(t.desconto_valor, 40);
  assert.strictEqual(t.total, 0);
}

function test07TotalNuncaNegativo() {
  const t = tela.calcularTotaisOperacionais({
    subtotal: 10,
    modo_desconto: 'percentual',
    desconto_percentual: 100,
    acrescimo: -50
  });
  assert.ok(t.total >= 0);
  assert.strictEqual(t.acrescimo, 0);
  assert.strictEqual(t.total, 0);
}

function test08CampoVazioZero() {
  const t = tela.calcularTotaisOperacionais({
    subtotal: 80,
    modo_desconto: 'valor',
    desconto_valor: '',
    desconto_percentual: '',
    acrescimo: null
  });
  assert.strictEqual(t.desconto_valor, 0);
  assert.strictEqual(t.acrescimo, 0);
  assert.strictEqual(t.total, 80);
}

function test09AtualizacaoResumo() {
  const cart = {
    obterItens: () => [{ quantidade: 2, subtotal: 50 }],
    calcularTotal: () => 100
  };
  const resumo = tela.montarResumoVisual(cart, {
    modo_desconto: 'percentual',
    desconto_percentual: 10,
    acrescimo: 5
  });
  assert.strictEqual(resumo.subtotal, 'R$ 100,00');
  assert.strictEqual(resumo.desconto, 'R$ 10,00');
  assert.strictEqual(resumo.acrescimo, 'R$ 5,00');
  assert.strictEqual(resumo.total, 'R$ 95,00');
  assert.strictEqual(resumo.itens, 2);
}

async function test10PayloadCheckout() {
  let enviado = null;
  await checkout.finalizarCheckout({
    itens: [{ produto_id: 1, quantidade: 1, valor_unitario: 100, empresa_id: 4, subtotal: 100 }],
    pagamentos: [{ forma_pagamento: 'dinheiro', valor: 90 }],
    desconto: 10,
    acrescimo: 0,
    idempotency_key: 't-05-22'
  }, async (url, op) => {
    enviado = { url, body: JSON.parse(op.body) };
    return { ok: true, json: async () => ({ venda_id: 1, sucesso: true }) };
  });
  assert.ok(enviado.url.endsWith('/pdv-universal/checkout'));
  assert.strictEqual(enviado.body.desconto, 10);
  assert.strictEqual(enviado.body.acrescimo, 0);
  assert.strictEqual(enviado.body.pagamentos[0].valor, 90);

  const payload = vendaAdapter.montarPayloadVendaOficial({
    itens: [{ produto_id: 1, quantidade: 1, valor_unitario: 100, subtotal: 100 }],
    pagamentos: [{ forma_pagamento: 'dinheiro', valor: 90 }],
    desconto: 10,
    acrescimo: 0
  });
  assert.strictEqual(payload.desconto, 10);
  assert.strictEqual(payload.acrescimo, 0);
  assert.strictEqual(payload.total, 90);
}

async function run() {
  const testes = [
    test01SubtotalSemAlteracoes,
    test02DescontoEmRs,
    test03DescontoPercentual,
    test04AcrescimoEmRs,
    test05DescontoMaisAcrescimo,
    test06DescontoMaximo,
    test07TotalNuncaNegativo,
    test08CampoVazioZero,
    test09AtualizacaoResumo,
    test10PayloadCheckout
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
