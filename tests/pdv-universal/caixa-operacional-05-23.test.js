/**
 * Sprint 05.23 — status operacional do caixa no PDV Universal.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const tela = require('../../frontend/pdv-universal/pdv-universal.js');

const ROOT = path.join(__dirname, '../..');
function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function test01EstadoInicialVerificando() {
  const info = tela.classificarStatusCaixa(undefined, false);
  assert.strictEqual(info.codigo, 'VERIFICANDO');
  assert.strictEqual(info.rotulo, 'CAIXA: VERIFICANDO');
  assert.ok(src('frontend/pdv-universal/index.html').includes('CAIXA: VERIFICANDO'));
}

async function test02RespostaAberto() {
  const estados = [];
  const info = await tela.atualizarStatusCaixa({
    onEstado: (e) => estados.push(e.codigo),
    fetchFn: async () => ({
      ok: true,
      json: async () => ({ id: 9, status: 'aberto' })
    })
  });
  assert.deepStrictEqual(estados[0], 'VERIFICANDO');
  assert.strictEqual(info.codigo, 'ABERTO');
  assert.strictEqual(info.rotulo, 'CAIXA: ABERTO');
  assert.ok(estados.includes('ABERTO'));
}

async function test03RespostaFechado() {
  const info = await tela.atualizarStatusCaixa({
    onEstado: () => {},
    fetchFn: async () => ({
      ok: true,
      json: async () => null
    })
  });
  assert.strictEqual(info.codigo, 'FECHADO');
  assert.strictEqual(info.rotulo, 'CAIXA: FECHADO');
}

async function test04ErroIndisponivel() {
  const info = await tela.atualizarStatusCaixa({
    onEstado: () => {},
    fetchFn: async () => ({ ok: false, status: 500, json: async () => ({}) })
  });
  assert.strictEqual(info.codigo, 'INDISPONIVEL');
  assert.strictEqual(info.rotulo, 'CAIXA: INDISPONÍVEL');
}

async function test05ErroNaoFazLogout() {
  const js = src('frontend/pdv-universal/pdv-universal.js');
  const trecho = js.slice(js.indexOf('async function atualizarStatusCaixa'), js.indexOf('function arred2'));
  assert.ok(!trecho.includes("location.href = '/login'"));
  assert.ok(!trecho.includes('logout('));
  assert.ok(!trecho.includes('removeItem(\'token\')'));
}

async function test06ErroNaoQuebraPdv() {
  const info = await tela.atualizarStatusCaixa({
    onEstado: () => {},
    fetchFn: async () => { throw new Error('rede'); }
  });
  assert.strictEqual(info.codigo, 'INDISPONIVEL');
}

async function test07AtualizacaoVisualAposResposta() {
  const pintados = [];
  await tela.atualizarStatusCaixa({
    onEstado: (e) => pintados.push(e.rotulo),
    fetchFn: async () => ({
      ok: true,
      json: async () => ({ status: 'aberto', caixa: { id: 1, status: 'aberto' } })
    })
  });
  assert.deepStrictEqual(pintados[0], 'CAIXA: VERIFICANDO');
  assert.deepStrictEqual(pintados[pintados.length - 1], 'CAIXA: ABERTO');
  assert.ok(src('frontend/pdv-universal/index.html').includes('id="pdvu-status-caixa"'));
  assert.ok(src('frontend/pdv-universal/index.html').includes('id="pdvu-btn-atualizar-caixa"'));
}

function test08SemPollingAutomatico() {
  const js = src('frontend/pdv-universal/pdv-universal.js');
  assert.ok(js.includes('atualizarStatusCaixa'));
  assert.ok(js.includes('consultarStatusCaixaOficial'));
  assert.ok(!js.includes('setInterval(consultarStatusCaixa'));
  assert.ok(!js.includes('setInterval(atualizarStatusCaixa'));
  assert.ok(tela.urlStatusCaixa().endsWith('/caixa/aberto'));
  // FINALIZAR não inventa bloqueio por status de caixa no front
  const fin = js.slice(js.indexOf('function atualizarBotaoFinalizar'), js.indexOf('function mostrarAtendimentoCriado'));
  assert.ok(!fin.includes('FECHADO'));
  assert.ok(!fin.includes('caixa'));
}

async function run() {
  const testes = [
    test01EstadoInicialVerificando,
    test02RespostaAberto,
    test03RespostaFechado,
    test04ErroIndisponivel,
    test05ErroNaoFazLogout,
    test06ErroNaoQuebraPdv,
    test07AtualizacaoVisualAposResposta,
    test08SemPollingAutomatico
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
