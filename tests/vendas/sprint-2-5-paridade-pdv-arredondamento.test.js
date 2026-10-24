'use strict';

/**
 * Sprint 2.5 — Frentes 1 e 2: arredondamento e paridade executável com o carrinho real do PDV.
 *
 * Caminhos comparados com os MESMOS dados de entrada:
 *   (A) PDV real: funções extraídas de frontend/pdv/js/pdv.js e executadas (adicionarItemNoCarrinho etc.)
 *   (B) cotação backend: CotacaoPrecoProdutoService.cotarPrecoProduto
 *   (C) núcleo compartilhado: MotorPrecoAtacado chamado diretamente
 *   (D) oráculo decimal exato (aritmética inteira, meio-centavo "half-up"), usado só para auditar o arredondamento.
 * A promoção é obtida executando o SQL real da rota GET /produtos/:id/promocao-ativa
 * (apenas date('now') é substituído por uma data de referência explícita).
 * Isto NÃO integra a composição ao PDV; compara formação de preço.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const { cotarPrecoProduto } = require('../../backend/services/vendas/CotacaoPrecoProdutoService');
const Motor = require('../../backend/services/vendas/MotorPrecoAtacado');
const { criarPdvReal, extrairSqlPromocaoAtiva, lerPdv } = require('./helpers/pdv-real-adaptador');
const fx = require('./helpers/composicao-fixture');

const REF = '2026-10-21T12:00:00Z';
const REF_DATE = new Date(REF);

function abrir() {
  return new Promise((res, rej) => { const db = new sqlite3.Database(':memory:', (e) => (e ? rej(e) : res(db))); });
}
function run(db, sql, p = []) {
  return new Promise((res, rej) => db.run(sql, p, function onRun(e) { return e ? rej(e) : res(this.lastID); }));
}
function all(db, sql, p = []) {
  return new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r || []))));
}
function get(db, sql, p = []) {
  return new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r))));
}

async function criarBancoPreco() {
  const db = await abrir();
  await run(db, `CREATE TABLE produtos (id INTEGER PRIMARY KEY, nome TEXT, unidade TEXT, preco_venda REAL,
    preco_unidade REAL, permite_venda_unidade INTEGER DEFAULT 0, produto_fracionado INTEGER DEFAULT 0,
    vendido_por_peso INTEGER DEFAULT 0, venda_atacado INTEGER DEFAULT 0, peso_medio_unidade REAL DEFAULT 0)`);
  await run(db, `CREATE TABLE promocoes (id INTEGER PRIMARY KEY, produto_id INTEGER, preco_original REAL,
    preco_promocional REAL, desconto_percentual REAL, data_inicio DATE, data_fim DATE, status TEXT DEFAULT 'ativa')`);
  await run(db, `CREATE TABLE produto_atacado (id INTEGER PRIMARY KEY, produto_id INTEGER,
    quantidade_minima INTEGER, preco_atacado REAL)`);
  return db;
}

async function inserirProduto(db, p) {
  await run(db, `INSERT INTO produtos (id, nome, unidade, preco_venda, preco_unidade, permite_venda_unidade,
    produto_fracionado, venda_atacado, peso_medio_unidade) VALUES (?,?,?,?,?,?,?,?,?)`,
  [p.id, `P${p.id}`, p.unidade || 'un', p.preco_venda, p.preco_unidade ?? null, p.permite_venda_unidade ?? 0,
    p.produto_fracionado ?? 0, p.venda_atacado ?? 0, p.peso_medio_unidade ?? 0]);
  for (const [qmin, preco] of (p.faixas || [])) {
    await run(db, 'INSERT INTO produto_atacado (produto_id, quantidade_minima, preco_atacado) VALUES (?,?,?)', [p.id, qmin, preco]);
  }
  if (p.promocao) {
    await run(db, `INSERT INTO promocoes (produto_id, preco_original, preco_promocional, data_inicio, data_fim, status)
      VALUES (?,?,?,?,?,?)`, [p.id, p.preco_venda, p.promocao.preco, p.promocao.inicio, p.promocao.fim, p.promocao.status || 'ativa']);
  }
}

// SQL real da rota; só date('now') vira a data de referência explícita.
const SQL_PROMO_ROTA = extrairSqlPromocaoAtiva().replace(/date\('now'\)/g, 'date(?)');
async function promocaoDoEndpoint(db, produtoId, refIso = REF) {
  const row = await get(db, SQL_PROMO_ROTA, [produtoId, refIso, refIso]);
  return row || null;
}

/** Executa os caminhos A e B para o mesmo produto/quantidade/data. */
async function compararCaso(db, pdv, produtoId, qtd, { refIso = REF } = {}) {
  const produto = await get(db, 'SELECT * FROM produtos WHERE id = ?', [produtoId]);
  pdv.sandbox.produtosDisponiveis.length = 0;
  pdv.sandbox.produtosDisponiveis.push(produto);
  pdv.sandbox.faixasPorProduto[produtoId] = await all(db,
    'SELECT * FROM produto_atacado WHERE produto_id = ? ORDER BY quantidade_minima ASC', [produtoId]);
  const promocao = await promocaoDoEndpoint(db, produtoId, refIso);

  pdv.api.limparCarrinho();
  pdv.notificacoes.length = 0;
  pdv.api.adicionarItemNoCarrinho(produto, qtd, Number(produto.preco_venda), '', promocao, { tipo_venda: 'PESO' });
  const item = pdv.api.carrinho[0];
  if (!item) return null;

  const cot = await cotarPrecoProduto({
    db, empresaId: 1, produtoId, quantidade: qtd, tipoVenda: 'PESO', agora: new Date(refIso)
  });
  return {
    produto,
    promocao,
    pdv: {
      quantidade: item.quantidade,
      precoInterno: item.preco_unitario,
      precoExibido: Number(pdv.api.precoUnitarioExibicaoItemPdv(item)),
      subtotalInterno: item.subtotal,
      subtotalExibicao: item.subtotal_exibicao,
      subtotalCentavos: Math.round(item.subtotal_exibicao * 100)
    },
    cot: {
      quantidade: cot.quantidade,
      precoInterno: cot.precoUnitarioInterno,
      precoExibido: cot.precoUnitarioExibicao,
      subtotalInterno: cot.subtotalInterno,
      subtotalCentavos: cot.subtotalCentavos,
      regras: cot.regrasAplicadas.map((r) => r.tipo)
    }
  };
}

function diferencas(r) {
  const d = [];
  if (r.pdv.quantidade !== r.cot.quantidade) d.push('quantidade');
  if (r.pdv.precoInterno !== r.cot.precoInterno) d.push('precoInterno');
  if (r.pdv.precoExibido !== r.cot.precoExibido) d.push('precoExibido');
  if (r.pdv.subtotalInterno !== r.cot.subtotalInterno) d.push('subtotalInterno');
  if (r.pdv.subtotalCentavos !== r.cot.subtotalCentavos) d.push('subtotalCentavos');
  return d;
}

// PRNG determinístico (mulberry32)
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

// ---------------------------------------------------------------------------------------------
// Paridade A×B: grade determinística (preço-base, promoção, vigência, atacado, quantidades)
// ---------------------------------------------------------------------------------------------

test('paridade PDV real × cotação: grade determinística de 900 casos (base, promoção, vigência, atacado, quantidade)', async () => {
  const db = await criarBancoPreco();
  const pdv = criarPdvReal({ produtos: [] });
  const rnd = prng(20261021);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const casos = [];
  let id = 0;
  const estat = { total: 0, comPromocao: 0, comAtacado: 0, promocaoMaisAtacado: 0, promoExpirada: 0, fracionado: 0 };

  for (let i = 0; i < 900; i += 1) {
    id += 1;
    const centavos = 1 + Math.floor(rnd() * 20000);
    const casas3 = rnd() < 0.15;
    const preco = casas3 ? (centavos * 10 + Math.floor(rnd() * 10)) / 1000 : centavos / 100;
    const fracionado = rnd() < 0.5;
    const vendaAtacado = rnd() < 0.7 ? 1 : 0;
    const faixas = [];
    const nFaixas = Math.floor(rnd() * 4);
    let qmin = 1;
    let precoFaixa = preco;
    for (let f = 0; f < nFaixas; f += 1) {
      qmin += 1 + Math.floor(rnd() * 12);
      precoFaixa = Math.round(precoFaixa * (0.6 + rnd() * 0.38) * 1000) / 1000;
      if (precoFaixa > 0) faixas.push([qmin, precoFaixa]);
    }
    if (rnd() < 0.1 && faixas.length) faixas[0][1] = Math.round((preco + 0.5) * 100) / 100; // faixa >= base (PDV ignora)
    if (rnd() < 0.05 && faixas.length) faixas[faixas.length - 1][1] = 0; // faixa legada com preço 0
    let promocao = null;
    if (rnd() < 0.4) {
      const fim = pick(['2026-10-21', '2026-10-22', '2026-12-31']);
      const inicio = rnd() < 0.1 ? '2026-10-22' : '2026-10-01';
      const preco = rnd() < 0.1 ? 0 : Math.round(centavos * (0.5 + rnd() * 0.55)) / 100;
      promocao = { preco, inicio, fim, status: rnd() < 0.1 ? 'inativa' : 'ativa' };
    }
    const prod = {
      id, preco_venda: preco, unidade: fracionado ? 'kg' : 'un', produto_fracionado: fracionado ? 1 : 0,
      venda_atacado: vendaAtacado, faixas, promocao
    };
    await inserirProduto(db, prod);
    let qtd;
    if (fracionado) {
      qtd = rnd() < 0.2 ? Math.round(rnd() * 300000) / 10000 : Math.round(rnd() * 3000 + 1) / 100;
    } else {
      qtd = rnd() < 0.15 ? Math.floor(rnd() * 60) + 0.5 : Math.floor(rnd() * 60) + 1;
    }
    casos.push({ id, qtd, prod });
  }

  const divergentes = [];
  for (const c of casos) {
    const r = await compararCaso(db, pdv, c.id, c.qtd);
    if (!r) { continue; }
    estat.total += 1;
    if (r.promocao) estat.comPromocao += 1;
    if (r.cot.regras.includes('ATACADO')) estat.comAtacado += 1;
    if (r.cot.regras.includes('ATACADO') && r.cot.regras.includes('PROMOCAO')) estat.promocaoMaisAtacado += 1;
    if (c.prod.promocao && !r.promocao) estat.promoExpirada += 1;
    if (c.prod.produto_fracionado) estat.fracionado += 1;
    const d = diferencas(r);
    if (d.length) divergentes.push({ caso: c, d, r });
  }
  console.log('[2.5/paridade] estatística da grade', JSON.stringify(estat));
  assert.deepEqual(divergentes.map((x) => ({ id: x.caso.id, d: x.d })), []);
  assert.ok(estat.total >= 800, 'a grade deve ter exercitado a maioria dos casos');
  assert.ok(estat.comAtacado > 50 && estat.promocaoMaisAtacado > 10 && estat.promoExpirada > 10 && estat.comPromocao > 100,
    `grade sem cobertura suficiente: ${JSON.stringify(estat)}`);
  await new Promise((r) => db.close(r));
});

test('paridade nos limiares: faixa de atacado abaixo, no limiar e acima; promoção + atacado; vigência no dia da data_fim', async () => {
  const db = await criarBancoPreco();
  const pdv = criarPdvReal({ produtos: [] });
  await inserirProduto(db, { id: 1, preco_venda: 10, venda_atacado: 1, faixas: [[5, 8], [10, 7.333]] });
  await inserirProduto(db, { id: 2, preco_venda: 10, venda_atacado: 1, faixas: [[5, 8]], promocao: { preco: 9, inicio: '2026-10-01', fim: '2026-11-01' } });
  await inserirProduto(db, { id: 3, preco_venda: 10, venda_atacado: 1, faixas: [[5, 8]], promocao: { preco: 7, inicio: '2026-10-01', fim: '2026-11-01' } });
  await inserirProduto(db, { id: 4, preco_venda: 10, promocao: { preco: 9, inicio: '2026-10-01', fim: '2026-10-21' } });

  const tabela = [];
  for (const [pid, q, esperadoInterno] of [
    [1, 4, 10], [1, 5, 8], [1, 6, 8], [1, 9, 8], [1, 10, 7.333], [1, 11, 7.333],
    [2, 4, 9], [2, 5, 8], [3, 5, 7], [3, 4, 7]
  ]) {
    const r = await compararCaso(db, pdv, pid, q);
    assert.deepEqual(diferencas(r), [], `produto ${pid} q=${q}`);
    assert.equal(r.pdv.precoInterno, esperadoInterno, `preço esperado produto ${pid} q=${q}`);
    tabela.push({ pid, q, precoInterno: r.pdv.precoInterno, subtotalCentavos: r.pdv.subtotalCentavos });
  }
  // data_fim exclusiva: no dia da data_fim a promoção já não vale (endpoint real) — igual na cotação
  const noDia = await compararCaso(db, pdv, 4, 2, { refIso: '2026-10-21T12:00:00Z' });
  assert.equal(noDia.promocao, null);
  assert.deepEqual(diferencas(noDia), []);
  assert.equal(noDia.pdv.precoInterno, 10);
  const vespera = await compararCaso(db, pdv, 4, 2, { refIso: '2026-10-20T12:00:00Z' });
  assert.notEqual(vespera.promocao, null);
  assert.deepEqual(diferencas(vespera), []);
  assert.equal(vespera.pdv.precoInterno, 9);
  console.log('[2.5/paridade] limiares', JSON.stringify(tabela));
  await new Promise((r) => db.close(r));
});

test('paridade: adicionar o mesmo produto duas vezes no PDV equivale a cotar a quantidade somada (recalcula faixa)', async () => {
  const db = await criarBancoPreco();
  const pdv = criarPdvReal({ produtos: [] });
  await inserirProduto(db, { id: 1, preco_venda: 12.9, venda_atacado: 1, faixas: [[5, 11.5], [12, 10.25]], promocao: { preco: 12, inicio: '2026-10-01', fim: '2026-11-01' } });
  await inserirProduto(db, { id: 2, preco_venda: 39.9, unidade: 'kg', produto_fracionado: 1, venda_atacado: 1, faixas: [[3, 35.5]] });
  for (const [pid, partes] of [[1, [2, 2, 1, 8]], [2, [1.25, 0.8, 1.01]]]) {
    const produto = await get(db, 'SELECT * FROM produtos WHERE id = ?', [pid]);
    pdv.sandbox.produtosDisponiveis.length = 0;
    pdv.sandbox.produtosDisponiveis.push(produto);
    pdv.sandbox.faixasPorProduto[pid] = await all(db, 'SELECT * FROM produto_atacado WHERE produto_id = ?', [pid]);
    const promocao = await promocaoDoEndpoint(db, pid);
    pdv.api.limparCarrinho();
    let acumulado = 0;
    for (const p of partes) {
      pdv.api.adicionarItemNoCarrinho(produto, p, Number(produto.preco_venda), '', promocao, { tipo_venda: 'PESO' });
      acumulado = Number((acumulado + p).toFixed(2));
      const item = pdv.api.carrinho[0];
      const cot = await cotarPrecoProduto({ db, empresaId: 1, produtoId: pid, quantidade: acumulado, agora: REF_DATE });
      assert.equal(item.quantidade, cot.quantidade, `quantidade acumulada ${pid}/${acumulado}`);
      assert.equal(item.preco_unitario, cot.precoUnitarioInterno, `preço ${pid}/${acumulado}`);
      assert.equal(item.subtotal, cot.subtotalInterno, `subtotal interno ${pid}/${acumulado}`);
      assert.equal(Math.round(item.subtotal_exibicao * 100), cot.subtotalCentavos, `centavos ${pid}/${acumulado}`);
    }
  }
  await new Promise((r) => db.close(r));
});

test('paridade em UNIDADE e ETIQUETA_BALANCA: sem promoção/atacado, quantidades 0 e 3 casas', async () => {
  const db = await criarBancoPreco();
  const produto = { id: 1, preco_venda: 49.9, unidade: 'kg', produto_fracionado: 1, venda_atacado: 1, preco_unidade: 7.35, permite_venda_unidade: 1, peso_medio_unidade: 0.15,
    faixas: [[1, 1]], promocao: { preco: 1, inicio: '2026-10-01', fim: '2026-11-01' } };
  await inserirProduto(db, produto);
  const row = await get(db, 'SELECT * FROM produtos WHERE id = 1');
  const pdv = criarPdvReal({ produtos: [row] });
  pdv.sandbox.faixasPorProduto[1] = await all(db, 'SELECT * FROM produto_atacado');

  for (const q of [1, 3, 7, 2.6]) {
    pdv.api.limparCarrinho();
    pdv.api.adicionarItemNoCarrinho(row, q, 0, '', null, { tipo_venda: 'UNIDADE' });
    const item = pdv.api.carrinho[0];
    const cot = await cotarPrecoProduto({ db, empresaId: 1, produtoId: 1, quantidade: q, tipoVenda: 'UNIDADE', agora: REF_DATE });
    assert.equal(item.quantidade, cot.quantidade);
    assert.equal(item.preco_unitario, cot.precoUnitarioInterno);
    assert.equal(Math.round(item.subtotal_exibicao * 100), cot.subtotalCentavos);
  }
  for (const q of [0.4567, 1.2, 0.123, 2.0004]) {
    pdv.api.limparCarrinho();
    pdv.api.adicionarItemNoCarrinho(row, q, Number(row.preco_venda), '', { id: 9, preco_promocional: 1 }, { etiquetaBalanca: { layout: 'x' } });
    const item = pdv.api.carrinho[0];
    const cot = await cotarPrecoProduto({ db, empresaId: 1, produtoId: 1, quantidade: q, tipoVenda: 'ETIQUETA_BALANCA', agora: REF_DATE });
    assert.equal(item.quantidade, cot.quantidade);
    assert.equal(item.preco_unitario, cot.precoUnitarioInterno);
    assert.equal(Math.round(item.subtotal_exibicao * 100), cot.subtotalCentavos);
  }
  await new Promise((r) => db.close(r));
});

// ---------------------------------------------------------------------------------------------
// Frente 1: arredondamento
// ---------------------------------------------------------------------------------------------

function centavosExatosInt(precoMilesimos, quantidadeCentesimos) {
  // preço (milésimos) × quantidade (centésimos) = unidades de 1e-5; meio-centavo sempre para cima
  return Math.floor((precoMilesimos * quantidadeCentesimos + 500) / 1000);
}

test('arredondamento: caminhos PDV real, cotação e núcleo coincidem; diferença para o decimal exato é medida (não corrigida)', async () => {
  const db = await criarBancoPreco();
  const pdv = criarPdvReal({ produtos: [] });
  const casos = [
    // preço, qtd, descrição
    [0.335, 3, 'preço 3 casas, subtotal 1,005'],
    [1.005, 1, 'preço 3 casas, meio centavo'],
    [2.675, 1, 'preço 3 casas, meio centavo'],
    [1.99, 0.25, 'kg 0,25 -> 0,4975'],
    [3.333333, 13, 'preço 6 casas'],
    [0.1, 3, 'dízima binária 0,3'],
    [21.995, 2, 'meio centavo no preço, subtotal inteiro'],
    [10.005, 3, 'meio centavo repetido'],
    [4.5, 0.01, 'quantidade mínima 0,01'],
    [8.99, 2.35, 'kg normal']
  ];
  const linhas = [];
  let id = 0;
  for (const [preco, qtd, desc] of casos) {
    id += 1;
    await inserirProduto(db, { id, preco_venda: preco, unidade: 'kg', produto_fracionado: 1 });
    const r = await compararCaso(db, pdv, id, qtd);
    assert.deepEqual(diferencas(r), [], desc);
    const nucleo = Motor.calcularLinhaPrecoUnitarioInformado({ precoOriginal: preco, quantidade: qtd, precoUnitarioInformado: preco });
    assert.equal(nucleo.precoUnitarioInterno, r.pdv.precoInterno);
    assert.equal(nucleo.precoUnitarioExibicao, r.pdv.precoExibido);
    assert.equal(nucleo.totalInterno, r.pdv.subtotalInterno);
    assert.equal(Math.round(nucleo.total * 100), r.pdv.subtotalCentavos);
    const milesimos = Math.round(preco * 1000);
    const exato = Number.isInteger(preco * 1000 + 0) || Math.abs(preco * 1000 - milesimos) < 1e-6
      ? centavosExatosInt(milesimos, Math.round(qtd * 100))
      : null;
    linhas.push({
      desc, preco, qtd,
      precoInterno: r.pdv.precoInterno, precoExibido: r.pdv.precoExibido,
      subtotalInterno: r.pdv.subtotalInterno, subtotalCentavosPdv: r.pdv.subtotalCentavos,
      subtotalCentavosCotacao: r.cot.subtotalCentavos, subtotalCentavosNucleo: Math.round(nucleo.total * 100),
      centavosDecimalExato: exato,
      difPdvCotacao: r.pdv.subtotalCentavos - r.cot.subtotalCentavos,
      difPdvExato: exato == null ? null : r.pdv.subtotalCentavos - exato
    });
  }
  console.log('[2.5/arredondamento]\n' + linhas.map((l) => JSON.stringify(l)).join('\n'));
  assert.ok(linhas.every((l) => l.difPdvCotacao === 0));
  const meioCentavo = linhas.find((l) => l.preco === 0.335);
  assert.equal(meioCentavo.subtotalCentavosPdv, 100, '0,335 × 3 = 1,005 → o núcleo em ponto flutuante arredonda para 1,00');
  assert.equal(meioCentavo.centavosDecimalExato, 101, 'half-up decimal exato daria 1,01');
  await new Promise((r) => db.close(r));
});

test('varredura de arredondamento: núcleo (usado pelo PDV e pela cotação) × decimal exato half-up', () => {
  let total = 0;
  let divergentes = 0;
  let maxDif = 0;
  const amostras = [];
  // preços de 2 casas (0,01..20,00) × quantidades de 2 casas (0,01..4,99)
  for (let pc = 1; pc <= 2000; pc += 1) {
    for (let qc = 1; qc <= 499; qc += 1) {
      total += 1;
      const preco = pc / 100;
      const qtd = qc / 100;
      const nucleo = Math.round(Motor.calcularLinhaPrecoUnitarioInformado({ precoOriginal: preco, quantidade: qtd, precoUnitarioInformado: preco }).total * 100);
      const exato = centavosExatosInt(pc * 10, qc);
      if (nucleo !== exato) {
        divergentes += 1;
        maxDif = Math.max(maxDif, Math.abs(nucleo - exato));
        if (amostras.length < 5) amostras.push({ preco, qtd, nucleo, exato });
      }
    }
  }
  let total3 = 0;
  let divergentes3 = 0;
  const amostras3 = [];
  // preços de 3 casas (0,001..2,000) × quantidades inteiras 1..60
  for (let pm = 1; pm <= 2000; pm += 1) {
    for (let q = 1; q <= 60; q += 1) {
      total3 += 1;
      const nucleo = Math.round(Motor.calcularLinhaPrecoUnitarioInformado({ precoOriginal: pm / 1000, quantidade: q, precoUnitarioInformado: pm / 1000 }).total * 100);
      const exato = centavosExatosInt(pm, q * 100);
      if (nucleo !== exato) {
        divergentes3 += 1;
        maxDif = Math.max(maxDif, Math.abs(nucleo - exato));
        if (amostras3.length < 5) amostras3.push({ preco: pm / 1000, qtd: q, nucleo, exato });
      }
    }
  }
  console.log('[2.5/varredura] 2 casas×2 casas:', JSON.stringify({ total, divergentes, amostras }));
  console.log('[2.5/varredura] 3 casas×inteiro:', JSON.stringify({ total: total3, divergentes: divergentes3, amostras: amostras3 }));
  assert.ok(maxDif <= 1, 'a diferença para o decimal exato, quando existe, é de no máximo 1 centavo');
  assert.ok(divergentes + divergentes3 > 0, 'a medição precisa registrar a existência do efeito de ponto flutuante');
});

test('linhas múltiplas: soma das linhas arredondadas (payload) × arredondamento do total agregado (tela) no PDV real', async () => {
  const db = await criarBancoPreco();
  const pdv = criarPdvReal({ produtos: [] });
  // três produtos a 1,99/kg × 0,25 kg → 0,4975 por linha
  for (const id of [1, 2, 3]) await inserirProduto(db, { id, preco_venda: 1.99, unidade: 'kg', produto_fracionado: 1 });
  pdv.api.limparCarrinho();
  let somaCotacao = 0;
  for (const id of [1, 2, 3]) {
    const produto = await get(db, 'SELECT * FROM produtos WHERE id = ?', [id]);
    pdv.sandbox.produtosDisponiveis.push(produto);
    pdv.api.adicionarItemNoCarrinho(produto, 0.25, 1.99, '', null, { tipo_venda: 'PESO' });
    somaCotacao += (await cotarPrecoProduto({ db, empresaId: 1, produtoId: id, quantidade: 0.25, agora: REF_DATE })).subtotalCentavos;
  }
  const carrinho = pdv.api.carrinho;
  const somaLinhasPayload = carrinho.reduce((s, it) => s + Math.round(it.subtotal_exibicao * 100), 0);
  const subtotalTela = Math.round(pdv.api.calcularSubtotal() * 100);
  console.log('[2.5/agregado]', JSON.stringify({ linhasInternas: carrinho.map((i) => i.subtotal), linhasExibicao: carrinho.map((i) => i.subtotal_exibicao), somaLinhasPayload, subtotalTela, somaCotacao }));
  assert.equal(somaCotacao, somaLinhasPayload, 'a cotação reproduz a soma por linha usada no payload do PDV');
  assert.equal(somaLinhasPayload, 150);
  assert.equal(subtotalTela, 149, 'o subtotal exibido na tela arredonda o agregado (3 × 0,4975 = 1,4925)');
  assert.equal(somaLinhasPayload - subtotalTela, 1, 'divergência interna do PDV: 1 centavo entre soma das linhas e agregado');
  await new Promise((r) => db.close(r));
});

test('varredura de linhas múltiplas: frequência de divergência entre soma por linha e agregado (3 linhas, 2 casas)', () => {
  const rnd = prng(7);
  let divergentes = 0;
  const n = 20000;
  for (let i = 0; i < n; i += 1) {
    const linhas = [0, 1, 2].map(() => {
      const preco = (1 + Math.floor(rnd() * 5000)) / 100;
      const qtd = (1 + Math.floor(rnd() * 500)) / 100;
      return Motor.calcularLinhaPrecoUnitarioInformado({ precoOriginal: preco, quantidade: qtd, precoUnitarioInformado: preco });
    });
    const porLinha = linhas.reduce((s, l) => s + Math.round(l.total * 100), 0);
    const agregado = Math.round(Motor.arredondarMoeda(linhas.reduce((s, l) => s + l.totalInterno, 0)) * 100);
    if (porLinha !== agregado) divergentes += 1;
  }
  console.log('[2.5/agregado-varredura]', JSON.stringify({ casos: n, divergentes, percentual: Number((divergentes * 100 / n).toFixed(2)) }));
  assert.ok(divergentes > 0, 'o efeito existe e precisa de decisão de negócio (agregado × por linha)');
});

// ---------------------------------------------------------------------------------------------
// Divergências conhecidas (documentam o comportamento ATUAL; não alteram regra)
// ---------------------------------------------------------------------------------------------

test('CORRIGIDO NA SPRINT 2.6: obterPrecoAtacado está no escopo do módulo e atualizarQuantidade não lança ReferenceError (histórico da 2.5)', async () => {
  const db = await criarBancoPreco();
  await inserirProduto(db, { id: 1, preco_venda: 10, venda_atacado: 1, faixas: [[5, 8]] });
  await inserirProduto(db, { id: 2, preco_venda: 10, venda_atacado: 0, promocao: { preco: 9, inicio: '2026-10-01', fim: '2026-11-01' } });
  const pdv = criarPdvReal({ produtos: [] });
  const p1 = await get(db, 'SELECT * FROM produtos WHERE id = 1');
  const p2 = await get(db, 'SELECT * FROM produtos WHERE id = 2');
  pdv.sandbox.produtosDisponiveis.push(p1, p2);
  pdv.sandbox.faixasPorProduto[1] = await all(db, 'SELECT * FROM produto_atacado WHERE produto_id = 1');

  const fonte = lerPdv();
  const defs = fonte.match(/function obterPrecoAtacado\(/g) || [];
  assert.equal(defs.length, 1, 'há uma única definição de obterPrecoAtacado');
  assert.match(fonte, /^function obterPrecoAtacado\(/m, 'definida no escopo do módulo');

  pdv.api.limparCarrinho();
  pdv.api.adicionarItemNoCarrinho(p1, 1, 10, '', null, { tipo_venda: 'PESO' });
  assert.doesNotThrow(() => pdv.api.atualizarQuantidade(0, '6'));
  assert.equal(pdv.api.carrinho[0].preco_unitario, 8);

  // Sem atacado, o caminho funciona e coincide com a cotação (promoção preservada)
  pdv.api.limparCarrinho();
  const promo = await promocaoDoEndpoint(db, 2);
  pdv.api.adicionarItemNoCarrinho(p2, 1, 10, '', promo, { tipo_venda: 'PESO' });
  pdv.api.atualizarQuantidade(0, '4');
  const item = pdv.api.carrinho[0];
  const cot = await cotarPrecoProduto({ db, empresaId: 1, produtoId: 2, quantidade: 4, agora: REF_DATE });
  assert.equal(item.preco_unitario, cot.precoUnitarioInterno);
  assert.equal(Math.round(item.subtotal_exibicao * 100), cot.subtotalCentavos);
  await new Promise((r) => db.close(r));
});

test('DIVERGÊNCIA CONHECIDA (dados legados): faixas com a mesma quantidade mínima — PDV usa a primeira, cotação a última', async () => {
  const db = await criarBancoPreco();
  // A rota POST /produtos/:id/atacado bloqueia duplicata; só dados legados/importados chegam aqui.
  await inserirProduto(db, { id: 1, preco_venda: 10, venda_atacado: 1, faixas: [[5, 8], [5, 7]] });
  const pdv = criarPdvReal({ produtos: [] });
  const r = await compararCaso(db, pdv, 1, 6);
  assert.equal(r.pdv.precoInterno, 8, 'PDV: primeira faixa retornada pela rota entre as de mesma quantidade_minima');
  assert.equal(r.cot.precoInterno, 7, 'cotação: última faixa (id maior) entre as de mesma quantidade_minima');
  assert.deepEqual(diferencas(r).sort(), ['precoExibido', 'precoInterno', 'subtotalCentavos', 'subtotalInterno'].sort());
  const rota = require('fs').readFileSync(require('path').join(__dirname, '../../backend/rotas/produtos.js'), 'utf8');
  assert.match(rota, /Já existe uma faixa com essa quantidade/);
  await new Promise((r2) => db.close(r2));
});

test('rota promocao-ativa: SQL real mantém data_fim exclusiva e não ordena (cotação ordena por id)', () => {
  const sql = extrairSqlPromocaoAtiva();
  assert.match(sql, /date\(p\.data_inicio\) <= date\('now'\)/);
  assert.match(sql, /date\(p\.data_fim\) > date\('now'\)/);
  assert.ok(!/ORDER BY/i.test(sql), 'a rota não define ORDER BY; com mais de uma promoção ativa a escolha é do plano do SQLite');
});

test('payload do PDV envia subtotal por linha (subtotal_exibicao) e preço de exibição; núcleo é o UMD único', () => {
  const fonte = lerPdv();
  assert.match(fonte, /Number\(item\.subtotal_exibicao \?\? MotorPrecoAtacado\.arredondarMoeda\(Number\(item\.subtotal \|\| 0\)\)\)/);
  assert.match(fonte, /preco_unitario_interno: motorPrecoAtacadoDisponivel\(\)/);
  assert.equal(require('../../frontend/shared/js/motor-preco-atacado.js'), Motor);
});

// ---------------------------------------------------------------------------------------------
// Composição: itens fixos + modelos fiscais × PDV real (linha a linha)
// ---------------------------------------------------------------------------------------------

test('composição com itens fixos e modelos fiscais: cada linha e o total coincidem com o carrinho real do PDV', async () => {
  await fx.comContexto(async (ctx) => {
    const m1 = await fx.modelo(ctx, { preco: 7.33, volumeMl: 350, atacado: [[3, 6.499], [6, 5.995]] });
    const m2 = await fx.modelo(ctx, { categoria: 'AGUA', preco: 3.35, volumeMl: 500, atacado: [[4, 3.1]], promocao: { preco: 3.2, inicio: '2026-10-01', fim: '2026-11-01' } });
    await fx.saldo(ctx, 'REFRIGERANTE', 3500);
    await fx.saldo(ctx, 'AGUA', 5000);
    await fx.run(ctx.db, 'UPDATE pedidos SET total = 90.05 WHERE id = ?', [ctx.pedidoId]);
    await fx.run(ctx.db, 'UPDATE pedidos_itens SET subtotal = 46.07, preco_unitario = 46.07 WHERE pedido_id = ? AND produto_id = ?', [ctx.pedidoId, ctx.coca]);
    const out = await fx.simular(ctx);
    assert.equal(out.sucesso, true);
    const linhasEngine = [...out.itensFixos, ...out.itensCompostos];

    const produtos = await fx.all(ctx.db, 'SELECT * FROM produtos');
    const faixas = await fx.all(ctx.db, 'SELECT * FROM produto_atacado');
    const pdv = criarPdvReal({ produtos });
    pdv.sandbox.faixasPorProduto = {};
    for (const f of faixas) (pdv.sandbox.faixasPorProduto[f.produto_id] ||= []).push(f);
    const SQL = extrairSqlPromocaoAtiva().replace(/date\('now'\)/g, 'date(?)');

    let somaPdv = 0;
    const tabela = [];
    for (const l of linhasEngine) {
      const produto = produtos.find((p) => p.id === l.produtoId);
      const promo = await new Promise((res, rej) => ctx.db.get(SQL, [l.produtoId, REF, REF], (e, r) => (e ? rej(e) : res(r || null))));
      pdv.api.limparCarrinho();
      pdv.api.adicionarItemNoCarrinho(produto, l.quantidade, Number(produto.preco_venda), '', promo, { tipo_venda: 'PESO' });
      const it = pdv.api.carrinho[0];
      assert.equal(Math.round(it.subtotal_exibicao * 100), l.subtotalCentavos, `subtotal da linha ${l.produtoId}`);
      assert.equal(it.preco_unitario, l.precoUnitario, `preço interno da linha ${l.produtoId}`);
      somaPdv += Math.round(it.subtotal_exibicao * 100);
      tabela.push({ produtoId: l.produtoId, qtd: l.quantidade, precoInternoEngine: l.precoUnitario, precoInternoPdv: it.preco_unitario, centavosEngine: l.subtotalCentavos, centavosPdv: Math.round(it.subtotal_exibicao * 100) });
    }
    console.log('[2.5/composicao×pdv]', JSON.stringify({ tabela, totalEngine: out.valorComposicaoCentavos, somaPdvPorLinha: somaPdv }));
    assert.equal(somaPdv, out.valorComposicaoCentavos);
    assert.ok(m1 && m2);
  });
});

test('cotação do backend não executa DDL nem escreve: bancos de teste ficam idênticos', async () => {
  const db = await criarBancoPreco();
  await inserirProduto(db, { id: 1, preco_venda: 10, venda_atacado: 1, faixas: [[5, 8]], promocao: { preco: 9, inicio: '2026-10-01', fim: '2026-11-01' } });
  const snap = async () => JSON.stringify({
    s: await all(db, 'SELECT type,name,sql FROM sqlite_master ORDER BY name'),
    p: await all(db, 'SELECT * FROM produtos'), a: await all(db, 'SELECT * FROM produto_atacado'), m: await all(db, 'SELECT * FROM promocoes')
  });
  const antes = await snap();
  await cotarPrecoProduto({ db, empresaId: 1, produtoId: 1, quantidade: 7, agora: REF_DATE });
  assert.equal(await snap(), antes);
  await new Promise((r) => db.close(r));
});
