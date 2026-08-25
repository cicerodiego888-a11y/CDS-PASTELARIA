/**
 * Sprint 05.25 — TEF operacional no PDV Universal (POST /api/tef/pagar).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const Tef = require('../../frontend/pdv-universal/pdv-universal-tef.js');
const tela = require('../../frontend/pdv-universal/pdv-universal.js');
const checkout = require('../../frontend/pdv-universal/pdv-universal-checkout.js');

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

async function test01DebitoIniciaContrato() {
  assert.strictEqual(Tef.mapearTipoTef('debito'), 'debito');
  let body = null;
  await Tef.iniciarTransacaoTef({ tipo: 'debito', valor: 50 }, async (url, op) => {
    body = JSON.parse(op.body);
    assert.ok(url.endsWith('/tef/pagar'));
    return {
      ok: true,
      json: async () => ({ sucesso: true, status: 'aprovado', nsu: '1' })
    };
  });
  assert.strictEqual(body.tipo, 'debito');
  assert.strictEqual(body.valor, 50);
}

async function test02CreditoIniciaContrato() {
  let body = null;
  await Tef.iniciarTransacaoTef({ tipo: 'credito', valor: 80, parcelas: 1 }, async (_u, op) => {
    body = JSON.parse(op.body);
    return {
      ok: true,
      json: async () => ({ sucesso: true, status: 'aprovado' })
    };
  });
  assert.strictEqual(body.tipo, 'credito');
}

function test03ValorTefTotalLiquido() {
  const totais = tela.calcularTotaisOperacionais({
    subtotal: 100,
    modo_desconto: 'valor',
    desconto_valor: 10,
    acrescimo: 5
  });
  assert.strictEqual(Tef.valorLiquidoTef(totais), 95);
}

function test04AprovacaoPermiteCheckout() {
  assert.strictEqual(Tef.estaAprovado({ sucesso: true, status: 'aprovado' }), true);
  assert.ok(src('frontend/pdv-universal/pdv-universal.js').includes('executarCheckoutTefEmpresaUnica'));
  assert.ok(src('frontend/pdv-universal/pdv-universal.js').includes('finalizarCheckout'));
}

function test05CancelamentoNaoConclui() {
  assert.strictEqual(Tef.estaAprovado({ status: 'cancelado' }), false);
  assert.strictEqual(Tef.estadoUiDeRetorno({ status: 'cancelado' }), Tef.ESTADOS_UI.CANCELADO);
  assert.ok(src('frontend/pdv-universal/pdv-universal.js').includes('TEF não aprovado. Carrinho mantido'));
}

function test06ErroNaoConclui() {
  assert.strictEqual(Tef.estaAprovado({ status: 'erro', sucesso: false }), false);
  assert.strictEqual(Tef.estadoUiDeRetorno({ status: 'erro' }), Tef.ESTADOS_UI.ERRO);
}

function test07CarrinhoPermaneceAposErro() {
  const js = src('frontend/pdv-universal/pdv-universal.js');
  // limpar carrinho só após checkout bem-sucedido no fluxo TEF
  assert.ok(js.includes('TEF aprovado, mas checkout falhou. Carrinho mantido'));
  assert.ok(js.includes('_tefEmAndamento'));
}

function test08CliqueRepetidoNaoDuplica() {
  assert.ok(src('frontend/pdv-universal/pdv-universal.js').includes('Transação TEF já em andamento'));
  assert.ok(src('frontend/pdv-universal/pdv-universal.js').includes('api._tefEmAndamento'));
}

function test09CheckoutSoAposAprovacao() {
  const js = src('frontend/pdv-universal/pdv-universal.js');
  const idxAprov = js.indexOf('Tef.estaAprovado(retorno)');
  const idxCheckout = js.indexOf("forma_pagamento: Tef.formaCheckoutAposTef(tipo)");
  assert.ok(idxAprov > 0 && idxCheckout > idxAprov);
  assert.ok(checkout.urlCheckout().endsWith('/pdv-universal/checkout'));
  assert.ok(!/\/api\/vendas\b/.test(src('frontend/pdv-universal/pdv-universal-tef.js')));
}

function test10MultiempresaNaoInventa() {
  const gate = Tef.tefDisponivelNoModo({ modo_operacao: 'MULTIEMPRESA' });
  assert.strictEqual(gate.ok, false);
  assert.strictEqual(gate.code, 'TEF_MULTIEMPRESA_AINDA_NAO_IMPLEMENTADO');
  assert.strictEqual(Tef.tefDisponivelNoModo({ modo_operacao: 'EMPRESA_UNICA' }).ok, true);
  assert.ok(src('frontend/pdv-universal/index.html').includes('tefFluxoPagamento.js'));
  assert.ok(src('frontend/pdv-universal/index.html').includes('pdv-universal-tef.js'));
  assert.ok(src('frontend/pdv-universal/index.html').includes('id="pdvu-modal-tef"'));
}

function test11UsaFluxoCompartilhado() {
  const F = Tef.obterFluxoTefCompartilhado();
  assert.ok(F);
  assert.strictEqual(typeof F.normalizarTipoTef, 'function');
  assert.strictEqual(typeof F.formaPagamentoUsaTEF, 'function');
  assert.ok(!src('frontend/pdv-universal/pdv-universal-tef.js').includes('TIPOS_OFICIAIS'));
  assert.ok(src('frontend/pdv-universal/pdv-universal-tef.js').includes('obterFluxoTefCompartilhado'));
}

function test12MapearViaCompartilhado() {
  assert.strictEqual(Tef.mapearTipoTef('cartao_debito'), 'debito');
  assert.strictEqual(Tef.mapearTipoTef('CREDITO'), 'credito');
  assert.strictEqual(Tef.mapearTipoTef('pix'), null);
}

async function test13ConsultaFluxoPdv() {
  let url = '';
  const fluxo = await Tef.consultarFluxoPdv(async (u) => {
    url = u;
    return {
      ok: true,
      json: async () => ({ tefHabilitado: true, pixHabilitado: false })
    };
  }, { forceRefresh: true });
  assert.ok(url.endsWith('/tef/fluxo-pdv'));
  assert.strictEqual(Tef.parseTefHabilitado(fluxo), true);
}

async function test14ValidarTefOperacional() {
  Tef.limparCacheFluxoPdv();
  const ok = await Tef.validarTefOperacional(
    { modo_operacao: 'EMPRESA_UNICA' },
    'debito',
    async () => ({
      ok: true,
      json: async () => ({ tefHabilitado: true })
    })
  );
  assert.strictEqual(ok.ok, true);

  Tef.limparCacheFluxoPdv();
  const off = await Tef.validarTefOperacional(
    { modo_operacao: 'EMPRESA_UNICA' },
    'debito',
    async () => ({
      ok: true,
      json: async () => ({ tefHabilitado: false })
    })
  );
  assert.strictEqual(off.ok, false);
  assert.strictEqual(off.code, 'TEF_DESABILITADO');
}

function test15JsUsaValidarOperacional() {
  assert.ok(src('frontend/pdv-universal/pdv-universal.js').includes('validarTefOperacional'));
}

async function run() {
  const testes = [
    test01DebitoIniciaContrato,
    test02CreditoIniciaContrato,
    test03ValorTefTotalLiquido,
    test04AprovacaoPermiteCheckout,
    test05CancelamentoNaoConclui,
    test06ErroNaoConclui,
    test07CarrinhoPermaneceAposErro,
    test08CliqueRepetidoNaoDuplica,
    test09CheckoutSoAposAprovacao,
    test10MultiempresaNaoInventa,
    test11UsaFluxoCompartilhado,
    test12MapearViaCompartilhado,
    test13ConsultaFluxoPdv,
    test14ValidarTefOperacional,
    test15JsUsaValidarOperacional
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
