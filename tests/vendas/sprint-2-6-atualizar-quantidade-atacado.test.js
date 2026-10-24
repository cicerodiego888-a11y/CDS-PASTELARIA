'use strict';

/**
 * Sprint 2.6 — Frente A: atualizarQuantidade × obterPrecoAtacado (escopo).
 * Executa o código REAL de pdv.js via vm (adaptador da Sprint 2.5). jQuery, DOM, notificações
 * e a rota /produtos/:id/atacado são stubs; isto NÃO equivale a validação em navegador real.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const { cotarPrecoProduto } = require('../../backend/services/vendas/CotacaoPrecoProdutoService');
const { criarPdvReal, lerPdv } = require('./helpers/pdv-real-adaptador');

const REF = new Date('2026-10-21T12:00:00Z');

function produto(id, preco, atacado, extra = {}) {
  return { id, nome: `P${id}`, preco_venda: preco, venda_atacado: atacado ? 1 : 0, unidade: 'un', produto_fracionado: 0, ...extra };
}

function novoPdv(produtos, faixas) {
  const pdv = criarPdvReal({ produtos, faixasPorProduto: faixas });
  return pdv;
}

const FAIXAS_1 = [{ quantidade_minima: 5, preco_atacado: 8 }, { quantidade_minima: 10, preco_atacado: 7 }];

test('estrutura: obterPrecoAtacado existe uma única vez, no escopo do módulo, e as três chamadas passam o produto', () => {
  const fonte = lerPdv();
  assert.equal((fonte.match(/function obterPrecoAtacado\(/g) || []).length, 1);
  assert.match(fonte, /^function obterPrecoAtacado\(produtoId, quantidadeTotal, precoBase, produto\)/m);
  const chamadas = fonte.match(/obterPrecoAtacado\([^)]*\)/g).filter((c) => !c.startsWith('obterPrecoAtacado(produtoId'));
  assert.equal(chamadas.length, 3);
  assert.ok(chamadas.every((c) => /, produto\)$/.test(c)), `chamadas: ${chamadas.join(' | ')}`);
});

test('produto sem atacado: atualizar quantidade mantém o preço e recalcula o subtotal', () => {
  const pdv = novoPdv([produto(1, 12.5, false)], { 1: FAIXAS_1 });
  pdv.api.adicionarItemNoCarrinho(pdv.sandbox.produtosDisponiveis[0], 1, 12.5, '', null, { tipo_venda: 'PESO' });
  for (const q of [3, 7, 12, 1]) {
    assert.doesNotThrow(() => pdv.api.atualizarQuantidade(0, String(q)));
    const it = pdv.api.carrinho[0];
    assert.equal(it.quantidade, q);
    assert.equal(it.preco_unitario, 12.5, 'faixas existentes são ignoradas quando venda_atacado=0');
    assert.equal(Math.round(it.subtotal_exibicao * 100), Math.round(q * 12.5 * 100));
  }
});

test('produto com atacado: abaixo do limiar, no limiar e acima (sem ReferenceError)', () => {
  const pdv = novoPdv([produto(1, 10, true)], { 1: FAIXAS_1 });
  pdv.api.adicionarItemNoCarrinho(pdv.sandbox.produtosDisponiveis[0], 1, 10, '', null, { tipo_venda: 'PESO' });
  const esperado = [[4, 10, 4000], [5, 8, 4000], [6, 8, 4800], [9, 8, 7200], [10, 7, 7000], [11, 7, 7700]];
  // cada quantidade parte de um carrinho novo para isolar a seleção da faixa
  for (const [q, preco, centavos] of esperado) {
    pdv.api.limparCarrinho();
    pdv.api.adicionarItemNoCarrinho(pdv.sandbox.produtosDisponiveis[0], 1, 10, '', null, { tipo_venda: 'PESO' });
    assert.doesNotThrow(() => pdv.api.atualizarQuantidade(0, String(q)), `q=${q}`);
    const it = pdv.api.carrinho[0];
    assert.equal(it.quantidade, q);
    assert.equal(it.preco_unitario, preco, `preço em q=${q}`);
    assert.equal(Math.round(it.subtotal_exibicao * 100), centavos, `subtotal em q=${q}`);
    assert.equal(it.desconto_atacado > 0, preco < 10, `desconto_atacado em q=${q}`);
  }
});

test('atualizar para a mesma quantidade ou ascendente reproduz a cotação backend (paridade na direção crescente)', async () => {
  const db = await new Promise((r, j) => { const d = new sqlite3.Database(':memory:', (e) => (e ? j(e) : r(d))); });
  const run = (sql, p = []) => new Promise((r, j) => db.run(sql, p, (e) => (e ? j(e) : r())));
  await run(`CREATE TABLE produtos (id INTEGER PRIMARY KEY, preco_venda REAL, preco_unidade REAL, permite_venda_unidade INTEGER DEFAULT 0,
    produto_fracionado INTEGER DEFAULT 0, vendido_por_peso INTEGER DEFAULT 0, unidade TEXT, venda_atacado INTEGER DEFAULT 0)`);
  await run(`CREATE TABLE promocoes (id INTEGER PRIMARY KEY, produto_id INTEGER, preco_original REAL, preco_promocional REAL, data_inicio DATE, data_fim DATE, status TEXT)`);
  await run(`CREATE TABLE produto_atacado (id INTEGER PRIMARY KEY, produto_id INTEGER, quantidade_minima INTEGER, preco_atacado REAL)`);
  await run('INSERT INTO produtos (id, preco_venda, unidade, venda_atacado) VALUES (1, 10, \'un\', 1)');
  for (const f of FAIXAS_1) await run('INSERT INTO produto_atacado (produto_id, quantidade_minima, preco_atacado) VALUES (1, ?, ?)', [f.quantidade_minima, f.preco_atacado]);

  const pdv = novoPdv([produto(1, 10, true)], { 1: FAIXAS_1 });
  pdv.api.adicionarItemNoCarrinho(pdv.sandbox.produtosDisponiveis[0], 1, 10, '', null, { tipo_venda: 'PESO' });
  for (const q of [2, 4, 5, 6, 9, 10, 15]) {
    pdv.api.atualizarQuantidade(0, String(q));
    const it = pdv.api.carrinho[0];
    const cot = await cotarPrecoProduto({ db, empresaId: 1, produtoId: 1, quantidade: q, agora: REF });
    assert.equal(it.preco_unitario, cot.precoUnitarioInterno, `preço q=${q}`);
    assert.equal(Math.round(it.subtotal_exibicao * 100), cot.subtotalCentavos, `centavos q=${q}`);
  }
  await new Promise((r) => db.close(r));
});

test('SPRINT 2.7: ao alternar entre faixas o preço é recalculado da origem (não fica preso ao atacado anterior)', () => {
  // Na Sprint 2.6 este teste caracterizava o preço preso (…9→7, 3→7, 1→7). A Sprint 2.7 corrige
  // atualizarQuantidade para partir de preco_origem; a expectativa mudou por causa da correção pretendida.
  const pdv = novoPdv([produto(1, 10, true)], { 1: FAIXAS_1 });
  pdv.api.adicionarItemNoCarrinho(pdv.sandbox.produtosDisponiveis[0], 1, 10, '', null, { tipo_venda: 'PESO' });
  const observado = [];
  for (const q of [4, 5, 10, 9, 3, 1, 12]) {
    assert.doesNotThrow(() => pdv.api.atualizarQuantidade(0, String(q)));
    observado.push({ q, preco: pdv.api.carrinho[0].preco_unitario });
  }
  assert.deepEqual(observado, [
    { q: 4, preco: 10 },
    { q: 5, preco: 8 },
    { q: 10, preco: 7 },
    { q: 9, preco: 8 },
    { q: 3, preco: 10 },
    { q: 1, preco: 10 },
    { q: 12, preco: 7 }
  ]);
  // coincide com adicionarItemNoCarrinho em carrinho novo
  pdv.api.limparCarrinho();
  pdv.api.adicionarItemNoCarrinho(pdv.sandbox.produtosDisponiveis[0], 3, 10, '', null, { tipo_venda: 'PESO' });
  assert.equal(pdv.api.carrinho[0].preco_unitario, 10);
});

test('produtos distintos no mesmo carrinho não contaminam preços nem quantidades', () => {
  const faixasB = [{ quantidade_minima: 3, preco_atacado: 4 }];
  const produtos = [produto(1, 10, true), produto(2, 5, true), produto(3, 2.5, false)];
  const pdv = novoPdv(produtos, { 1: FAIXAS_1, 2: faixasB });
  pdv.api.adicionarItemNoCarrinho(produtos[0], 1, 10, '', null, { tipo_venda: 'PESO' });
  pdv.api.adicionarItemNoCarrinho(produtos[1], 1, 5, '', null, { tipo_venda: 'PESO' });
  pdv.api.adicionarItemNoCarrinho(produtos[2], 1, 2.5, '', null, { tipo_venda: 'PESO' });
  assert.equal(pdv.api.carrinho.length, 3);

  pdv.api.atualizarQuantidade(0, '10');
  pdv.api.atualizarQuantidade(1, '3');
  pdv.api.atualizarQuantidade(2, '8');
  const [a, b, c] = pdv.api.carrinho;
  assert.deepEqual([a.id, a.quantidade, a.preco_unitario], [1, 10, 7]);
  assert.deepEqual([b.id, b.quantidade, b.preco_unitario], [2, 3, 4]);
  assert.deepEqual([c.id, c.quantidade, c.preco_unitario], [3, 8, 2.5]);

  pdv.api.atualizarQuantidade(1, '2'); // somente o item 2 muda
  assert.deepEqual([a.quantidade, a.preco_unitario], [10, 7]);
  assert.deepEqual([c.quantidade, c.preco_unitario], [8, 2.5]);
  assert.equal(b.quantidade, 2);
  // Sprint 2.7: abaixo da faixa 3→4,00 o item B volta ao varejo (5,00); antes ficava preso em 4,00 (800)
  assert.equal(b.preco_unitario, 5);
  const faturaLinhas = Array.from(pdv.api.carrinho, (i) => Math.round(i.subtotal_exibicao * 100));
  assert.deepEqual(faturaLinhas, [7000, 1000, 2000]);
});

test('promoção + atacado: a faixa é aplicada sobre o preço promocional vigente, como na inclusão', () => {
  const p = produto(1, 10, true);
  const pdv = novoPdv([p], { 1: [{ quantidade_minima: 5, preco_atacado: 8.5 }] });
  const promo = { id: 7, preco_promocional: 9, desconto_percentual: 10 };
  pdv.api.adicionarItemNoCarrinho(p, 1, 10, '', promo, { tipo_venda: 'PESO' });
  assert.equal(pdv.api.carrinho[0].preco_unitario, 9);
  assert.doesNotThrow(() => pdv.api.atualizarQuantidade(0, '5'));
  assert.equal(pdv.api.carrinho[0].preco_unitario, 8.5);
  assert.doesNotThrow(() => pdv.api.atualizarQuantidade(0, '6'));
  assert.equal(pdv.api.carrinho[0].preco_unitario, 8.5);
});

test('quantidade zero ou inválida remove o item sem lançar erro (comportamento preservado)', () => {
  const p = produto(1, 10, true);
  const pdv = novoPdv([p], { 1: FAIXAS_1 });
  pdv.api.adicionarItemNoCarrinho(p, 2, 10, '', null, { tipo_venda: 'PESO' });
  assert.doesNotThrow(() => pdv.api.atualizarQuantidade(0, '0'));
  assert.equal(pdv.api.carrinho.length, 0);
});

test('adicionarItemNoCarrinho com atacado continua igual após a elevação (inclusão e soma ao item existente)', () => {
  const p = produto(1, 10, true);
  const pdv = novoPdv([p], { 1: FAIXAS_1 });
  pdv.api.adicionarItemNoCarrinho(p, 4, 10, '', null, { tipo_venda: 'PESO' });
  assert.equal(pdv.api.carrinho[0].preco_unitario, 10);
  pdv.api.adicionarItemNoCarrinho(p, 1, 10, '', null, { tipo_venda: 'PESO' });
  assert.equal(pdv.api.carrinho[0].quantidade, 5);
  assert.equal(pdv.api.carrinho[0].preco_unitario, 8);
  pdv.api.adicionarItemNoCarrinho(p, 5, 10, '', null, { tipo_venda: 'PESO' });
  assert.equal(pdv.api.carrinho[0].quantidade, 10);
  assert.equal(pdv.api.carrinho[0].preco_unitario, 7);
});
