'use strict';

/**
 * Sprint 2.7 — Frente A: recálculo do preço comercial ao alterar a quantidade (origem do preço).
 * Executa o código REAL de pdv.js via vm (adaptador). jQuery/DOM/AJAX são stubs: isto NÃO é
 * validação em navegador real.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const { cotarPrecoProduto } = require('../../backend/services/vendas/CotacaoPrecoProdutoService');
const { criarPdvReal, lerPdv } = require('./helpers/pdv-real-adaptador');

const REF = '2026-10-21T12:00:00Z';
const REF_DATE = new Date(REF);
const FAIXAS = [{ quantidade_minima: 5, preco_atacado: 8 }, { quantidade_minima: 10, preco_atacado: 7 }];

function produto(id, preco, atacado, extra = {}) {
  return { id, nome: `P${id}`, preco_venda: preco, venda_atacado: atacado ? 1 : 0, unidade: 'un', produto_fracionado: 0, ...extra };
}
function novoPdv(produtos, faixas) {
  return criarPdvReal({ produtos, faixasPorProduto: faixas });
}
const add = (pdv, p, q, preco, promo = null) =>
  pdv.api.adicionarItemNoCarrinho(p, q, preco, '', promo, { tipo_venda: 'PESO' });
const cent = (v) => Math.round(v * 100);

function bancoCotacao() {
  return new Promise((res, rej) => {
    const db = new sqlite3.Database(':memory:', (e) => (e ? rej(e) : res(db)));
  });
}
const run = (db, sql, p = []) => new Promise((res, rej) => db.run(sql, p, (e) => (e ? rej(e) : res())));

async function criarBanco({ preco, faixas, promo }) {
  const db = await bancoCotacao();
  await run(db, `CREATE TABLE produtos (id INTEGER PRIMARY KEY, nome TEXT, unidade TEXT, preco_venda REAL, preco_unidade REAL,
    permite_venda_unidade INTEGER DEFAULT 0, produto_fracionado INTEGER DEFAULT 0, vendido_por_peso INTEGER DEFAULT 0,
    venda_atacado INTEGER DEFAULT 0, peso_medio_unidade REAL DEFAULT 0)`);
  await run(db, `CREATE TABLE promocoes (id INTEGER PRIMARY KEY, produto_id INTEGER, preco_original REAL, preco_promocional REAL,
    desconto_percentual REAL, data_inicio DATE, data_fim DATE, status TEXT DEFAULT 'ativa')`);
  await run(db, 'CREATE TABLE produto_atacado (id INTEGER PRIMARY KEY, produto_id INTEGER, quantidade_minima INTEGER, preco_atacado REAL)');
  await run(db, "INSERT INTO produtos (id, nome, unidade, preco_venda, venda_atacado) VALUES (1,'P','un',?,1)", [preco]);
  for (const f of faixas) await run(db, 'INSERT INTO produto_atacado (produto_id, quantidade_minima, preco_atacado) VALUES (1,?,?)', [f.quantidade_minima, f.preco_atacado]);
  if (promo) {
    await run(db, "INSERT INTO promocoes (id, produto_id, preco_original, preco_promocional, desconto_percentual, data_inicio, data_fim, status) VALUES (1,1,?,?,?,'2026-10-01','2026-11-01','ativa')",
      [preco, promo.preco_promocional, promo.desconto_percentual]);
  }
  return db;
}

test('A1 sequência pedida: base 10, faixas 5→8 e 10→7, quantidades 10 → 9 → 3 = 7,00 → 8,00 → 10,00', () => {
  const p = produto(1, 10, true);
  const pdv = novoPdv([p], { 1: FAIXAS });
  add(pdv, p, 10, 10);
  const it = pdv.api.carrinho[0];
  assert.equal(it.preco_unitario, 7);
  const passos = [];
  for (const q of [9, 3]) {
    assert.doesNotThrow(() => pdv.api.atualizarQuantidade(0, String(q)));
    passos.push([q, it.preco_unitario, cent(it.subtotal_exibicao), it.tipo_preco]);
  }
  assert.deepEqual(passos, [[9, 8, 7200, 'atacado'], [3, 10, 3000, 'varejo']]);
  assert.equal(it.preco_origem, 10, 'a origem do preço permanece o varejo');
  assert.equal(it.preco_editado_manual, 0);
});

test('A2 promoção: a origem é o preço promocional; o atacado só vale se for mais vantajoso que ela', () => {
  const p = produto(1, 10, true);
  const promo = { id: 7, preco_promocional: 9, desconto_percentual: 10 };
  const pdv = novoPdv([p], { 1: [{ quantidade_minima: 5, preco_atacado: 8.5 }, { quantidade_minima: 20, preco_atacado: 9.5 }] });
  add(pdv, p, 1, 10, promo);
  const it = pdv.api.carrinho[0];
  assert.equal(it.preco_origem, 9);
  const seq = [];
  for (const q of [5, 3, 6, 20, 2, 25]) {
    pdv.api.atualizarQuantidade(0, String(q));
    seq.push([q, it.preco_unitario, it.tipo_preco]);
  }
  assert.deepEqual(seq, [
    [5, 8.5, 'atacado'],
    [3, 9, 'varejo'], // volta à PROMOÇÃO (não ao varejo 10)
    [6, 8.5, 'atacado'],
    [20, 9, 'varejo'], // a faixa mais alta atendida (20→9,50) é pior que a promoção: vale a promoção
    [2, 9, 'varejo'],
    [25, 9, 'varejo']
  ]);
});

test('A3 produto sem atacado: o preço não muda com a quantidade (faixas cadastradas são ignoradas)', () => {
  const p = produto(1, 12.5, false);
  const pdv = novoPdv([p], { 1: FAIXAS });
  add(pdv, p, 1, 12.5);
  for (const q of [3, 7, 12, 1]) {
    pdv.api.atualizarQuantidade(0, String(q));
    const it = pdv.api.carrinho[0];
    assert.equal(it.preco_unitario, 12.5);
    assert.equal(cent(it.subtotal_exibicao), cent(q * 12.5));
  }
});

test('A4 sequência determinística longa de quantidades: PDV real (atualizarQuantidade) = cotação backend em todos os passos', async () => {
  const cenarios = [
    { nome: 'sem promoção', preco: 10, promo: null },
    { nome: 'promoção 9,00', preco: 10, promo: { id: 1, preco_promocional: 9, desconto_percentual: 10 } },
    { nome: 'promoção 7,50 (abaixo das faixas)', preco: 10, promo: { id: 1, preco_promocional: 7.5, desconto_percentual: 25 } }
  ];
  let passos = 0;
  for (const c of cenarios) {
    const db = await criarBanco({ preco: c.preco, faixas: FAIXAS, promo: c.promo });
    const p = produto(1, c.preco, true);
    const pdv = novoPdv([p], { 1: FAIXAS });
    add(pdv, p, 1, c.preco, c.promo);
    let seed = 77;
    for (let i = 0; i < 60; i += 1) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const q = 1 + (seed % 14);
      pdv.api.atualizarQuantidade(0, String(q));
      const it = pdv.api.carrinho[0];
      const cot = await cotarPrecoProduto({ db, empresaId: 1, produtoId: 1, quantidade: q, tipoVenda: 'PESO', agora: REF_DATE });
      assert.equal(it.preco_unitario, cot.precoUnitarioInterno, `${c.nome} q=${q}`);
      assert.equal(cent(it.subtotal_exibicao), cot.subtotalCentavos, `${c.nome} q=${q} centavos`);
      passos += 1;
    }
    await new Promise((r) => db.close(r));
  }
  assert.equal(passos, 180);
});

test('A5 produtos distintos: cada item recalcula a partir da própria origem, sem contaminação', () => {
  const pA = produto(1, 10, true);
  const pB = produto(2, 5, true);
  const pC = produto(3, 2.5, false);
  const promoB = { id: 9, preco_promocional: 4.5, desconto_percentual: 10 };
  const pdv = novoPdv([pA, pB, pC], { 1: FAIXAS, 2: [{ quantidade_minima: 3, preco_atacado: 4 }] });
  add(pdv, pA, 1, 10);
  add(pdv, pB, 1, 5, promoB);
  add(pdv, pC, 1, 2.5);
  const [a, b, c] = pdv.api.carrinho;
  pdv.api.atualizarQuantidade(0, '10');
  pdv.api.atualizarQuantidade(1, '3');
  pdv.api.atualizarQuantidade(2, '8');
  assert.deepEqual([a.preco_unitario, b.preco_unitario, c.preco_unitario], [7, 4, 2.5]);
  pdv.api.atualizarQuantidade(0, '3'); // só o item A muda
  pdv.api.atualizarQuantidade(1, '2');
  assert.deepEqual([a.quantidade, a.preco_unitario], [3, 10]);
  assert.deepEqual([b.quantidade, b.preco_unitario], [2, 4.5], 'B volta à promoção, não ao varejo 5');
  assert.deepEqual([c.quantidade, c.preco_unitario], [8, 2.5]);
  assert.deepEqual([a.preco_origem, b.preco_origem, c.preco_origem], [10, 4.5, 2.5]);
});

test('A6 edição manual de preço unitário é preservada ao mudar a quantidade (sem atacado silencioso)', () => {
  const p = produto(1, 10, true);
  const pdv = novoPdv([p], { 1: FAIXAS });
  add(pdv, p, 1, 10);
  const it = pdv.api.carrinho[0];
  pdv.api.atualizarPrecoUnitario(0, 9.5);
  assert.equal(it.preco_unitario, 9.5);
  assert.equal(it.preco_editado_manual, 1);
  for (const q of [5, 10, 3, 12]) {
    pdv.api.atualizarQuantidade(0, String(q));
    assert.equal(it.preco_unitario, 9.5, `q=${q}: preço manual mantido`);
    assert.equal(it.preco_editado_manual, 1);
  }
  assert.equal(it.preco_origem, 10, 'a origem comercial não é sobrescrita pela edição');
});

test('A7 preço manual MAIOR que o preço calculado também é preservado; adicionar o mesmo produto não o sobrescreve', () => {
  const p = produto(1, 10, true);
  const pdv = novoPdv([p], { 1: FAIXAS });
  add(pdv, p, 5, 10);
  const it = pdv.api.carrinho[0];
  assert.equal(it.preco_unitario, 8);
  pdv.api.atualizarPrecoUnitario(0, 9);
  add(pdv, p, 5, 10); // soma ao item existente: quantidade 10
  assert.equal(it.quantidade, 10);
  assert.equal(it.preco_unitario, 9, 'preço manual não é substituído pelo atacado (7,00) na soma');
  assert.equal(it.preco_editado_manual, 1);
});

test('A8 desconto informado pela interface não congela o preço: o motor recalcula na mudança de quantidade; zerar recalcula', () => {
  const p = produto(1, 10, true);
  const pdv = novoPdv([p], { 1: FAIXAS });
  add(pdv, p, 5, 10);
  const it = pdv.api.carrinho[0];
  assert.equal(it.preco_unitario, 8);
  assert.equal(it.preco_editado_manual, 0, 'desconto automático do atacado não é edição manual');
  assert.equal(it.desconto_manual, 0, 'desconto automático do atacado não é desconto manual');

  // aplicarDescontoPercentualComAuth marca desconto_manual=1 antes de chamar atualizarPercentual
  it.desconto_manual = 1;
  pdv.api.atualizarPercentual(0, 10); // 10% sobre a base de varejo → 9,00
  assert.equal(it.preco_unitario, 9);
  assert.equal(it.preco_editado_manual, 0, 'desconto percentual não ativa a flag de edição de preço');
  pdv.api.atualizarQuantidade(0, '10');
  assert.equal(it.preco_unitario, 7, 'o motor recalcula: desconto informado não congela o preço');
  assert.equal(it.desconto_manual, 0, 'flag legada não sobrevive ao recálculo');
  assert.equal(it.desconto_percentual, 30);
  it.desconto_manual = 1;
  pdv.api.atualizarPercentual(0, 15);
  pdv.api.atualizarQuantidade(0, '3');
  assert.equal(it.preco_unitario, 10, 'desconto informado descartado; preço comercial da quantidade 3');
  assert.equal(it.desconto_percentual, 0);
  it.desconto_manual = 0; // fluxo de zerar (aplicarDescontoPercentualComAuth)
  pdv.api.atualizarQuantidade(0, '10');
  pdv.api.atualizarPercentual(0, 0); // zerar recalcula para a quantidade atual (10 → 7)
  assert.equal(it.preco_editado_manual, 0);
  assert.equal(it.preco_unitario, 7);
  assert.equal(it.tipo_preco, 'atacado');
  pdv.api.atualizarQuantidade(0, '3');
  assert.equal(it.preco_unitario, 10);

  pdv.api.atualizarQuantidade(0, '5');
  pdv.api.atualizarDescontoValor(0, 5); // R$ 5 sobre 5×10 → 9,00 por unidade
  assert.equal(it.preco_unitario, 9);
  assert.equal(it.preco_editado_manual, 0);
  assert.equal(it.desconto_manual, 1);
  pdv.api.atualizarQuantidade(0, '10');
  assert.equal(it.preco_unitario, 7, 'desconto por valor também é recalculado pelo motor');
  assert.equal(it.desconto_manual, 0);
  pdv.api.atualizarDescontoValor(0, 5);
  pdv.api.atualizarDescontoValor(0, 0);
  assert.equal(it.preco_editado_manual, 0);
  assert.equal(it.desconto_manual, 0);
  assert.equal(it.preco_unitario, 7);
});

test('A9 zerar desconto em item com promoção volta à promoção (e não ao varejo, como antes)', () => {
  const p = produto(1, 10, false);
  const promo = { id: 3, preco_promocional: 9, desconto_percentual: 10 };
  const pdv = novoPdv([p], {});
  add(pdv, p, 2, 10, promo);
  const it = pdv.api.carrinho[0];
  it.desconto_manual = 1;
  pdv.api.atualizarPercentual(0, 20);
  assert.equal(it.preco_unitario, 8);
  it.desconto_manual = 0;
  pdv.api.atualizarPercentual(0, 0);
  assert.equal(it.preco_unitario, 9);
  assert.equal(it.preco_editado_manual, 0);
});

test('A14b desconto informado depois de um preço digitado substitui o preço digitado e a flag de edição não fica obsoleta', () => {
  const p = produto(1, 10, true);
  const pdv = novoPdv([p], { 1: FAIXAS });
  add(pdv, p, 1, 10);
  const it = pdv.api.carrinho[0];
  pdv.api.atualizarPrecoUnitario(0, 9.5);
  assert.equal(it.preco_editado_manual, 1);
  it.desconto_manual = 1;
  pdv.api.atualizarPercentual(0, 10);
  assert.equal(it.preco_editado_manual, 0);
  pdv.api.atualizarQuantidade(0, '10');
  assert.equal(it.preco_unitario, 7, 'motor recalcula; nada congela');
  pdv.api.atualizarPrecoUnitario(0, 9);
  pdv.api.atualizarDescontoValor(0, 5);
  assert.equal(it.preco_editado_manual, 0);
  pdv.api.atualizarQuantidade(0, '3');
  assert.equal(it.preco_unitario, 10);
});

test('A15 contrato do payload: desconto_manual é só 0/1 e o recálculo do motor o zera, sem exigir autorização indevida no backend', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../../backend/services/vendas/VendaPagamentoService.js'), 'utf8');
  const i = src.indexOf('function vendaExigeAutorizacaoDescontoManual');
  const trecho = src.slice(i, i + 400);
  assert.match(trecho, /desconto_manual \|\| 0\) === 1/);
  const p = produto(1, 10, true);
  const pdv = novoPdv([p], { 1: FAIXAS });
  add(pdv, p, 1, 10);
  const it = pdv.api.carrinho[0];
  it.desconto_manual = 1;
  pdv.api.atualizarPercentual(0, 10);
  pdv.api.atualizarQuantidade(0, '10');
  assert.equal(it.desconto_manual, 0);
  assert.ok(it.desconto_percentual > 0, 'desconto do atacado presente, mas automático: backend não exige autorização');
});

test('A10 venda por unidade: preço por unidade não recebe atacado e permanece o da origem', () => {
  const p = produto(1, 10, true, { permite_venda_unidade: 1, preco_unidade: 3, peso_medio_unidade: 0.5, unidade: 'kg', produto_fracionado: 1 });
  const pdv = novoPdv([p], { 1: FAIXAS });
  pdv.api.adicionarItemNoCarrinho(p, 2, 3, '', null, { tipo_venda: 'UNIDADE' });
  const it = pdv.api.carrinho[0];
  assert.equal(it.preco_unitario, 3);
  for (const q of [10, 1, 20]) {
    pdv.api.atualizarQuantidade(0, String(q));
    assert.equal(it.preco_unitario, 3, `q=${q}`);
    assert.equal(it.quantidade, q);
  }
});

test('A11 item legado sem preco_origem: sem atacado aplicado usa o preço atual como origem; com atacado aplicado a origem é irrecuperável e o preço é mantido', () => {
  const p = produto(1, 10, true);
  // legado sem atacado aplicado (qtd 1): preço atual 10 é a própria origem, então o atacado passa a valer
  let pdv = novoPdv([p], { 1: FAIXAS });
  add(pdv, p, 1, 10);
  let it = pdv.api.carrinho[0];
  delete it.preco_origem;
  pdv.api.atualizarQuantidade(0, '10');
  assert.equal(it.preco_unitario, 7);

  // legado com atacado já aplicado (preço 7): não se inventa a origem a partir do preço reduzido
  pdv = novoPdv([p], { 1: FAIXAS });
  add(pdv, p, 10, 10);
  it = pdv.api.carrinho[0];
  delete it.preco_origem;
  assert.doesNotThrow(() => pdv.api.atualizarQuantidade(0, '9'));
  assert.equal(it.preco_unitario, 7, 'preço mantido; atacado não é reaplicado sobre preço já reduzido');
  assert.equal(it.preco_editado_manual === undefined || Number(it.preco_editado_manual) === 0, true, 'não vira edição manual');
});

test('A13 desconto automático (atacado/promoção) nunca ativa preco_editado_manual nem desconto_manual e é recalculado a cada quantidade', () => {
  const p = produto(1, 10, true);
  const pdv = novoPdv([p], { 1: FAIXAS });
  add(pdv, p, 10, 10);
  const it = pdv.api.carrinho[0];
  const vistos = [];
  for (const q of [10, 9, 3, 5, 12, 4]) {
    pdv.api.atualizarQuantidade(0, String(q));
    assert.equal(it.preco_editado_manual, 0, `q=${q}`);
    assert.equal(it.desconto_manual, 0, `q=${q}`);
    vistos.push([it.preco_unitario, it.desconto_percentual]);
  }
  assert.deepEqual(vistos, [[7, 30], [8, 20], [10, 0], [8, 20], [7, 30], [10, 0]]);
});

test('A14 edição explícita do preço unitário é a única ação que marca preco_editado_manual; não afeta outros produtos', () => {
  const pA = produto(1, 10, true);
  const pB = produto(2, 10, true);
  const pdv = novoPdv([pA, pB], { 1: FAIXAS, 2: FAIXAS });
  add(pdv, pA, 1, 10);
  add(pdv, pB, 1, 10);
  const [a, b] = pdv.api.carrinho;
  pdv.api.atualizarPrecoUnitario(0, 9.5);
  assert.equal(a.preco_editado_manual, 1);
  assert.equal(a.desconto_manual, 0, 'preço unitário não usa a flag de desconto manual');
  pdv.api.atualizarQuantidade(0, '10');
  pdv.api.atualizarQuantidade(1, '10');
  assert.equal(a.preco_unitario, 9.5);
  assert.equal(b.preco_unitario, 7);
  assert.equal(b.preco_editado_manual, 0);
  assert.notEqual(a.preco_origem, undefined);
  assert.equal(b.desconto_atacado, 30);
});

test('A12 a regra de atacado continua única: nenhuma segunda implementação de faixa, e os campos novos não vão no payload', () => {
  const fonte = lerPdv();
  assert.equal((fonte.match(/function obterPrecoAtacado\(/g) || []).length, 1);
  assert.equal((fonte.match(/\.quantidade_minima/g) || []).length, 2, 'a seleção de faixa só existe dentro de obterPrecoAtacado');
  const ini = fonte.indexOf('const dados = {');
  const fim = fonte.indexOf('precalcularDistribuicaoFiscalVenda(', ini);
  const payload = fonte.slice(ini, fim > ini ? fim : ini + 6000);
  assert.ok(!/preco_origem|preco_editado_manual/.test(payload), 'campos de estado do carrinho não são enviados ao backend');
});

