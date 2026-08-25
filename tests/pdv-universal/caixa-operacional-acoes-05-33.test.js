/**
 * Sprint 05.33 — ações operacionais de caixa no PDV Universal.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const Caixa = require('../../frontend/pdv-universal/pdv-universal-caixa.js');
const tela = require('../../frontend/pdv-universal/pdv-universal.js');
const Cart = require('../../frontend/pdv-universal/pdv-universal-cart.js');

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function test01FechadoMostraAbrir() {
  const v = Caixa.acoesVisiveisPorStatus('FECHADO');
  assert.strictEqual(v.abrir, true);
  assert.strictEqual(v.sangria, false);
  assert.strictEqual(v.fechar, false);
  assert.ok(src('frontend/pdv-universal/index.html').includes('id="pdvu-btn-abrir-caixa"'));
}

async function test02AbrirChamaEndpointExistente() {
  let url = '';
  let body = null;
  await Caixa.abrirCaixa({ valor_inicial: 50 }, async (u, op) => {
    url = u;
    body = JSON.parse(op.body);
    assert.strictEqual(op.method, 'POST');
    return { ok: true, json: async () => ({ message: 'ok', id: 1 }) };
  });
  assert.ok(url.endsWith('/caixa/abrir'));
  assert.strictEqual(body.valor_inicial, 50);
}

function test03SucessoAtualizaStatus() {
  const js = src('frontend/pdv-universal/pdv-universal.js');
  assert.ok(js.includes('await consultarStatusCaixaOficial()'));
  assert.ok(js.includes('Caixa.abrirCaixa'));
  assert.ok(tela.urlStatusCaixa().endsWith('/caixa/aberto'));
}

function test04AbertoMostraSangria() {
  const v = Caixa.acoesVisiveisPorStatus('ABERTO');
  assert.strictEqual(v.sangria, true);
  assert.ok(src('frontend/pdv-universal/index.html').includes('id="pdvu-btn-sangria"'));
}

function test05AbertoMostraSuprimento() {
  const v = Caixa.acoesVisiveisPorStatus('ABERTO');
  assert.strictEqual(v.suprimento, true);
  assert.ok(src('frontend/pdv-universal/index.html').includes('id="pdvu-btn-suprimento"'));
}

function test06AbertoMostraFechar() {
  const v = Caixa.acoesVisiveisPorStatus('ABERTO');
  assert.strictEqual(v.fechar, true);
  assert.ok(src('frontend/pdv-universal/index.html').includes('id="pdvu-btn-fechar-caixa"'));
}

async function test07SangriaEndpoint() {
  let url = '';
  let body = null;
  await Caixa.registrarSangria({ valor: 10, motivo: 'teste' }, async (u, op) => {
    url = u;
    body = JSON.parse(op.body);
    return { ok: true, json: async () => ({ message: 'Sangria ok' }) };
  });
  assert.ok(url.endsWith('/caixa/sangria'));
  assert.strictEqual(body.valor, 10);
  assert.strictEqual(body.motivo, 'teste');
}

async function test08SuprimentoEndpoint() {
  let url = '';
  let body = null;
  await Caixa.registrarSuprimento({ valor: 20, motivo: 'troco' }, async (u, op) => {
    url = u;
    body = JSON.parse(op.body);
    return { ok: true, json: async () => ({ message: 'Suprimento ok' }) };
  });
  assert.ok(url.endsWith('/caixa/suprimento'));
  assert.strictEqual(body.valor, 20);
}

async function test09FecharFluxoExistente() {
  let url = '';
  let body = null;
  await Caixa.fecharCaixa({ valor_informado: 100, observacao: 'fim' }, async (u, op) => {
    url = u;
    body = JSON.parse(op.body);
    return { ok: true, json: async () => ({ message: 'fechado', cupom_html: null }) };
  });
  assert.ok(url.endsWith('/caixa/fechar'));
  assert.strictEqual(body.valor_informado, 100);
  assert.strictEqual(body.observacao, 'fim');
}

async function test10ErroMantemEstado() {
  try {
    await Caixa.abrirCaixa({ valor_inicial: 10 }, async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Terminal inválido' })
    }));
    assert.fail('deveria lançar');
  } catch (err) {
    assert.ok(String(err.message).includes('Terminal'));
  }
  const indisp = Caixa.acoesVisiveisPorStatus('INDISPONIVEL');
  assert.strictEqual(indisp.abrir, false);
  assert.strictEqual(indisp.sangria, false);
}

function test11NenhumEndpointNovo() {
  const cx = src('frontend/pdv-universal/pdv-universal-caixa.js');
  assert.ok(cx.includes('/caixa/abrir'));
  assert.ok(cx.includes('/caixa/sangria'));
  assert.ok(cx.includes('/caixa/suprimento'));
  assert.ok(cx.includes('/caixa/fechar'));
  assert.ok(cx.includes('/caixa/aberto'));
  assert.ok(!cx.includes('/caixa/universal'));
  assert.ok(!cx.includes('/pdv-universal/caixa'));
}

function test12CarrinhoNaoAlterado() {
  const c = Cart.criarCarrinho();
  c.adicionarItem({
    produto_id: 1,
    empresa_id: 1,
    descricao: 'X',
    quantidade: 2,
    valor_unitario: 5
  });
  const js = src('frontend/pdv-universal/pdv-universal.js');
  const trecho = js.slice(js.indexOf('async function confirmarOperacaoCaixa'), js.indexOf('async function consultarStatusCaixaOficial'));
  assert.ok(!trecho.includes('_cart.limpar'));
  assert.ok(!trecho.includes('adicionarItem'));
  assert.strictEqual(c.localizar(1, 1).quantidade, 2);
}

async function run() {
  const testes = [
    test01FechadoMostraAbrir,
    test02AbrirChamaEndpointExistente,
    test03SucessoAtualizaStatus,
    test04AbertoMostraSangria,
    test05AbertoMostraSuprimento,
    test06AbertoMostraFechar,
    test07SangriaEndpoint,
    test08SuprimentoEndpoint,
    test09FecharFluxoExistente,
    test10ErroMantemEstado,
    test11NenhumEndpointNovo,
    test12CarrinhoNaoAlterado
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
