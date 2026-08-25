/**
 * Sprint 05.24 — PIX operacional no PDV Universal (contrato oficial /api/pix).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const Pix = require('../../frontend/pdv-universal/pdv-universal-pix.js');
const tela = require('../../frontend/pdv-universal/pdv-universal.js');
const checkout = require('../../frontend/pdv-universal/pdv-universal-checkout.js');

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function test01PixDisponivelComoForma() {
  const h = src('frontend/pdv-universal/index.html');
  assert.ok(h.includes('<option value="pix">PIX</option>'));
  assert.ok(h.includes('id="pdvu-modal-pix"'));
  assert.ok(h.includes('pdv-universal-pix.js'));
}

function test02ValorPixTotalLiquido() {
  const totais = tela.calcularTotaisOperacionais({
    subtotal: 100,
    modo_desconto: 'valor',
    desconto_valor: 10,
    acrescimo: 5
  });
  assert.strictEqual(Pix.valorLiquidoPix(totais), 95);
}

function test03PixIniciaContratoOficial() {
  assert.ok(Pix.urlCriarCobranca().endsWith('/pix/criar-cobranca'));
  assert.ok(Pix.urlStatus('abc').endsWith('/pix/status/abc'));
}

async function test04EstadoPendente() {
  const cob = await Pix.criarCobrancaPix({ valor: 10 }, async () => ({
    ok: true,
    json: async () => ({
      success: true,
      cobranca: { txid: 'tx1', status: 'PENDENTE', copiaCola: 'pix-copia' }
    })
  }));
  assert.strictEqual(cob.txid, 'tx1');
  assert.strictEqual(Pix.normalizarEstadoUi(cob.status), Pix.ESTADOS_UI.PENDENTE);
}

async function test05ConfirmacaoOficial() {
  const st = await Pix.consultarStatusPix('tx1', async () => ({
    ok: true,
    json: async () => ({ success: true, status: { status: 'PAGO' } })
  }));
  assert.strictEqual(Pix.normalizarEstadoUi(st.status), Pix.ESTADOS_UI.CONFIRMADO);
}

function test06ErroNaoConcluiVenda() {
  assert.strictEqual(Pix.normalizarEstadoUi('ERRO'), Pix.ESTADOS_UI.ERRO);
  assert.strictEqual(Pix.normalizarEstadoUi('CANCELADO'), Pix.ESTADOS_UI.ERRO);
  const js = src('frontend/pdv-universal/pdv-universal.js');
  assert.ok(js.includes('aguardarConfirmacaoPixOficial'));
  assert.ok(js.includes('PIX não confirmado. Venda não concluída'));
}

function test07CliqueRepetidoNaoDuplica() {
  assert.strictEqual(
    Pix.deveReutilizarCobranca({ txid: 't', valor: 50, status: 'PENDENTE' }, 50),
    true
  );
  assert.strictEqual(
    Pix.deveReutilizarCobranca({ txid: 't', valor: 50, status: 'PENDENTE' }, 99),
    false
  );
  assert.ok(src('frontend/pdv-universal/pdv-universal.js').includes('_pixEmAndamento'));
}

function test08DescontoAcrescimoNoValorPix() {
  const t = tela.calcularTotaisOperacionais({
    subtotal: 200,
    modo_desconto: 'percentual',
    desconto_percentual: 10,
    acrescimo: 3
  });
  assert.strictEqual(t.total, 183);
  assert.strictEqual(Pix.valorLiquidoPix(t), 183);
}

function test09MultiempresaNaoInventa() {
  const gate = Pix.pixDisponivelNoModo({ modo_operacao: 'MULTIEMPRESA' });
  assert.strictEqual(gate.ok, false);
  assert.strictEqual(gate.code, 'PIX_MULTIEMPRESA_AINDA_NAO_IMPLEMENTADO');
  const okUnica = Pix.pixDisponivelNoModo({ modo_operacao: 'EMPRESA_UNICA' });
  assert.strictEqual(okUnica.ok, true);
}

function test10SemPostApiVendas() {
  const front = [
    'frontend/pdv-universal/pdv-universal-pix.js',
    'frontend/pdv-universal/pdv-universal.js',
    'frontend/pdv-universal/pdv-universal-checkout.js'
  ].map(src).join('\n');
  assert.ok(!/\/api\/vendas\b/.test(front));
  assert.ok(checkout.urlCheckout().endsWith('/pdv-universal/checkout'));
  assert.ok(src('frontend/pdv-universal/pdv-universal.js').includes("forma_pagamento: 'pix'"));
}

async function run() {
  const testes = [
    test01PixDisponivelComoForma,
    test02ValorPixTotalLiquido,
    test03PixIniciaContratoOficial,
    test04EstadoPendente,
    test05ConfirmacaoOficial,
    test06ErroNaoConcluiVenda,
    test07CliqueRepetidoNaoDuplica,
    test08DescontoAcrescimoNoValorPix,
    test09MultiempresaNaoInventa,
    test10SemPostApiVendas
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
