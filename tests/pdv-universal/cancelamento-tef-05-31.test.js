/**
 * Sprint 05.31 — Cancelamento seguro TEF no PDV Universal (POST /api/tef/cancelar).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const Tef = require('../../frontend/pdv-universal/pdv-universal-tef.js');

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

async function test01CancelarChamaEndpointExistente() {
  let url = '';
  let body = null;
  const ret = await Tef.cancelarTransacaoTef({ transacao_id: 42, motivo: 'Cancelamento operador' }, async (u, op) => {
    url = u;
    body = JSON.parse(op.body);
    assert.strictEqual(op.method, 'POST');
    return {
      ok: true,
      json: async () => ({ cancelado: true, status: 'cancelado', mensagem: 'ok' })
    };
  });
  assert.ok(url.endsWith('/tef/cancelar'));
  assert.strictEqual(body.transacao_id, 42);
  assert.strictEqual(body.motivo, 'Cancelamento operador');
  assert.strictEqual(Tef.cancelamentoConfirmado(ret), true);
}

function test02SemTefPendenteNaoChamaApi() {
  assert.strictEqual(Tef.transacaoTefCancelavel(null), false);
  assert.strictEqual(Tef.transacaoTefCancelavel({}), false);
  assert.strictEqual(Tef.transacaoTefCancelavel({ transacao_id: null }), false);
  const js = src('frontend/pdv-universal/pdv-universal.js');
  assert.ok(js.includes('if (!api._tefEmAndamento && !transacaoId)'));
  assert.ok(js.includes('limparEstadoTefOperacional()'));
  assert.ok(!js.includes('cancelarTransacaoTef') || js.includes('Tef.transacaoTefCancelavel'));
}

function test03CancelamentoLiberaNovaTentativa() {
  const js = src('frontend/pdv-universal/pdv-universal.js');
  assert.ok(js.includes('limparEstadoTefOperacional'));
  assert.ok(js.includes('api._tefEmAndamento = false'));
  assert.ok(js.includes('api._tefCancelamentoEmAndamento = false'));
  assert.ok(js.includes('Carrinho mantido'));
}

function test04CarrinhoPermaneceIntacto() {
  const js = src('frontend/pdv-universal/pdv-universal.js');
  const fn = js.slice(js.indexOf('async function abortarOperacaoTef'), js.indexOf('function pintarModalTef'));
  assert.ok(!fn.includes('_cart.limpar'));
  assert.ok(!fn.includes('cancelarAtendimento'));
}

function test05DuploCancelamentoNaoDuplicaRequest() {
  const js = src('frontend/pdv-universal/pdv-universal.js');
  assert.ok(js.includes('if (api._tefCancelamentoEmAndamento) return'));
  assert.ok(js.includes('api._tefCancelamentoEmAndamento = true'));
}

async function test06FalhaApiNaoExecutaCheckout() {
  try {
    await Tef.cancelarTransacaoTef({ transacao_id: 1 }, async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'falha' })
    }));
    assert.fail('deveria lançar');
  } catch (err) {
    assert.strictEqual(err.code, 'TEF_CANCEL_ERRO');
  }
  const js = src('frontend/pdv-universal/pdv-universal.js');
  const abort = js.slice(js.indexOf('async function abortarOperacaoTef'), js.indexOf('function pintarModalTef'));
  assert.ok(!abort.includes('Checkout.finalizarCheckout'));
  assert.ok(abort.includes('Tef.ESTADOS_UI.ERRO'));
}

function test07NaoCancelaPagamentoAprovadoComCheckout() {
  assert.strictEqual(Tef.transacaoTefCancelavel({
    transacao_id: 10,
    aprovado: true,
    checkoutIniciado: true
  }), false);
  assert.strictEqual(Tef.transacaoTefCancelavel({
    transacao_id: 10,
    aprovado: true,
    checkoutIniciado: false
  }), false);
  const js = src('frontend/pdv-universal/pdv-universal.js');
  assert.ok(js.includes('api._checkoutLock && api._tefPendente && api._tefPendente.aprovado'));
  assert.ok(js.includes('if (pendente && pendente.aprovado)'));
}

function test08NovaTentativaAposCancelamento() {
  const js = src('frontend/pdv-universal/pdv-universal.js');
  assert.ok(js.includes('api._tefCancelamentoSolicitado = false'));
  assert.ok(js.includes('api._tefPendente = { valor, tipo'));
  assert.ok(js.includes('Tef.cancelarTransacaoTef'));
  assert.strictEqual(Tef.urlCancelar().endsWith('/tef/cancelar'), true);
}

async function run() {
  const testes = [
    test01CancelarChamaEndpointExistente,
    test02SemTefPendenteNaoChamaApi,
    test03CancelamentoLiberaNovaTentativa,
    test04CarrinhoPermaneceIntacto,
    test05DuploCancelamentoNaoDuplicaRequest,
    test06FalhaApiNaoExecutaCheckout,
    test07NaoCancelaPagamentoAprovadoComCheckout,
    test08NovaTentativaAposCancelamento
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
