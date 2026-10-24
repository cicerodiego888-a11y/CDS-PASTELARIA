'use strict';

/**
 * Sprint 2.7 — Frente B: contrato monetário do carrinho (PROPOSTA, não aplicada em produção).
 * Compara o comportamento ATUAL do PDV real (código de pdv.js via vm) com a política proposta
 * "centavos por linha; total = Σ linhas − desconto + acréscimo", em centavos inteiros.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const Motor = require('../../backend/services/vendas/MotorPrecoAtacado');
const { criarPdvReal } = require('./helpers/pdv-real-adaptador');

const ler = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Política proposta, só inteiros em centavos. Cada linha: arredonda o total interno uma única vez. */
function contratoProposto(linhasInternas, descontoCent, acrescimoCent) {
  const linhasCent = linhasInternas.map((v) => Math.round(Motor.arredondarMoeda(v) * 100));
  const subtotalCent = linhasCent.reduce((s, c) => s + c, 0);
  const totalCent = Math.max(0, subtotalCent - descontoCent + acrescimoCent);
  return { linhasCent, subtotalCent, totalCent };
}

/** Política atual (tela e campo `total` do payload): arredonda o agregado das linhas internas. */
function politicaAtualTela(linhasInternas, descontoCent, acrescimoCent) {
  const subtotalCent = Math.round(Motor.arredondarMoeda(linhasInternas.reduce((s, v) => s + v, 0)) * 100);
  return { subtotalCent, totalCent: Math.max(0, subtotalCent - descontoCent + acrescimoCent) };
}

function carrinhoSintetico(rnd, nLinhas) {
  return Array.from({ length: nLinhas }, () => {
    const preco = (1 + Math.floor(rnd() * 5000)) / 100;
    const qtd = (1 + Math.floor(rnd() * 500)) / 100;
    return Motor.calcularLinhaPrecoUnitarioInformado({ precoOriginal: preco, quantidade: qtd, precoUnitarioInformado: preco });
  });
}

test('B1 contrato proposto: invariantes (Σ itens persistidos = subtotal; total = Σ itens − desconto + acréscimo) valem sempre', () => {
  const rnd = prng(207);
  for (let i = 0; i < 5000; i += 1) {
    const n = 1 + Math.floor(rnd() * 10);
    const linhas = carrinhoSintetico(rnd, n);
    const desc = Math.floor(rnd() * 300);
    const acr = Math.floor(rnd() * 300);
    const c = contratoProposto(linhas.map((l) => l.totalInterno), desc, acr);
    assert.equal(c.linhasCent.reduce((s, x) => s + x, 0), c.subtotalCent);
    assert.equal(c.totalCent, Math.max(0, c.subtotalCent - desc + acr));
    // cada linha do contrato coincide com a linha enviada hoje no payload (subtotal_exibicao)
    linhas.forEach((l, k) => assert.equal(c.linhasCent[k], Math.round(l.total * 100)));
  }
});

test('B2 atual × proposto: a política atual quebra a invariante Σ itens = total; a proposta não (medição, 20.000 carrinhos por tamanho)', () => {
  const rnd = prng(2007);
  const n = 20000;
  const saida = [];
  for (const nLinhas of [1, 2, 3, 5, 10]) {
    let quebraAtual = 0;
    let quebraProposta = 0;
    let maxAbs = 0;
    for (let i = 0; i < n; i += 1) {
      const linhas = carrinhoSintetico(rnd, nLinhas);
      const internos = linhas.map((l) => l.totalInterno);
      const somaItens = linhas.reduce((s, l) => s + Math.round(l.total * 100), 0);
      const atual = politicaAtualTela(internos, 0, 0);
      const prop = contratoProposto(internos, 0, 0);
      const d = somaItens - atual.totalCent;
      if (d !== 0) quebraAtual += 1;
      maxAbs = Math.max(maxAbs, Math.abs(d));
      if (somaItens !== prop.totalCent) quebraProposta += 1;
    }
    saida.push({ linhas: nLinhas, carrinhos: n, quebraAtual, pctAtual: Number((quebraAtual * 100 / n).toFixed(2)), maxAbsCentAtual: maxAbs, quebraProposta });
  }
  console.log('[2.7/B2]', JSON.stringify(saida));
  assert.ok(saida.every((s) => s.quebraProposta === 0));
  assert.equal(saida[0].quebraAtual, 0, 'com 1 linha os dois coincidem');
  assert.ok(saida.slice(1).every((s) => s.quebraAtual > 0));
});

test('B3 PDV real: o Subtotal da tela e o total do payload = política ATUAL; a proposta difere no caso 3×0,25kg×1,99', () => {
  const pdv = criarPdvReal({ produtos: [] });
  for (const id of [1, 2, 3]) {
    const p = { id, nome: `P${id}`, preco_venda: 1.99, unidade: 'kg', produto_fracionado: 1, venda_atacado: 0 };
    pdv.sandbox.produtosDisponiveis.push(p);
    pdv.api.adicionarItemNoCarrinho(p, 0.25, 1.99, '', null, { tipo_venda: 'PESO' });
  }
  const itens = Array.from(pdv.api.carrinho);
  const internos = itens.map((i) => i.subtotal);
  const atual = politicaAtualTela(internos, 0, 0);
  const prop = contratoProposto(internos, 0, 0);
  assert.equal(Math.round(pdv.api.calcularSubtotal() * 100), atual.subtotalCent, 'a função real do PDV = política atual modelada');
  assert.equal(atual.subtotalCent, 149);
  assert.equal(prop.subtotalCent, 150);
  assert.equal(itens.reduce((s, i) => s + Math.round(i.subtotal_exibicao * 100), 0), 150, 'itens do payload já seguem o contrato proposto');
});

test('B4 mapa de impacto: o que a mudança de política tocaria (fonte), sem alterá-lo', () => {
  const pdv = ler('frontend/pdv/js/pdv.js');
  const consumidoresTotal = (pdv.match(/calcularTotalValor\(\)/g) || []).length;
  assert.ok(consumidoresTotal >= 6, `calcularTotalValor é usado em ${consumidoresTotal} pontos do PDV (exibição, pagamento, troco)`);
  assert.match(pdv, /function calcularSubtotal\(\)/);
  assert.match(pdv, /aplicarDescontoProporcionalDistribuicao\(/, 'o fallback fiscal local também parte do subtotal agregado');
  const fin = ler('backend/services/vendas/VendaFinanceiroService.js');
  assert.match(fin.slice(fin.indexOf('function validarSomaPagamentosVenda'), fin.indexOf('function validarSomaPagamentosVenda') + 1800), /0\.01/);
  const dist = ler('backend/services/distribuidorEstoqueVenda.js');
  assert.match(dist, /totalVendaBruto/, 'a distribuição fiscal soma valores dos itens: usa a base por linha');
});

test('B5 nenhuma reconciliação silenciosa: a proposta não distribui resíduo de centavos entre linhas', () => {
  const linhas = [0.4975, 0.4975, 0.4975];
  const c = contratoProposto(linhas, 0, 0);
  assert.deepEqual(c.linhasCent, [50, 50, 50], 'cada linha é arredondada isoladamente');
  assert.equal(c.subtotalCent, 150);
  const fonte = fs.readFileSync(__filename, 'utf8');
  assert.ok(!/resíduo.*(distribu|ajust)|ajustarCentavos/i.test(fonte.replace(/B5[\s\S]*$/, '')));
});
