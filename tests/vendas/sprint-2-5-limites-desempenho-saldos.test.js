'use strict';

/**
 * Sprint 2.5 — Frentes 3, 4 e 5: limites/optimalidade da busca, desempenho e saldos/reservas.
 * Tudo em SQLite :memory:. Nada é escrito fora do processo. Não altera limites do motor.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { performance } = require('node:perf_hooks');
const sqlite3 = require('sqlite3').verbose();

const Composicao = require('../../backend/services/vendas/ComposicaoFiscalPedidoService');
const { criarCotadorPreco } = require('../../backend/services/vendas/CotacaoPrecoProdutoService');
const fx = require('./helpers/composicao-fixture');

const { buscarComposicao, LIMITE_ESTADOS_BUSCA, LIMITE_QUANTIDADES_PARA_PODA } = Composicao.internos;
const AGORA = new Date('2026-10-21T12:00:00Z');

// ------------------------------------------------------------------------------------------
// Infra de busca direta (cotadores reais sobre um banco mínimo)
// ------------------------------------------------------------------------------------------

function abrir() {
  return new Promise((res, rej) => { const db = new sqlite3.Database(':memory:', (e) => (e ? rej(e) : res(db))); });
}
function run(db, sql, p = []) {
  return new Promise((res, rej) => db.run(sql, p, function onRun(e) { return e ? rej(e) : res(this.lastID); }));
}

async function bancoMinimo() {
  const db = await abrir();
  await run(db, `CREATE TABLE produtos (id INTEGER PRIMARY KEY, nome TEXT, unidade TEXT, preco_venda REAL,
    preco_unidade REAL, permite_venda_unidade INTEGER DEFAULT 0, produto_fracionado INTEGER DEFAULT 0,
    vendido_por_peso INTEGER DEFAULT 0, venda_atacado INTEGER DEFAULT 0)`);
  await run(db, `CREATE TABLE promocoes (id INTEGER PRIMARY KEY, produto_id INTEGER, preco_original REAL,
    preco_promocional REAL, data_inicio DATE, data_fim DATE, status TEXT DEFAULT 'ativa')`);
  await run(db, `CREATE TABLE produto_atacado (id INTEGER PRIMARY KEY, produto_id INTEGER,
    quantidade_minima INTEGER, preco_atacado REAL)`);
  return db;
}

/**
 * specs: [{preco, faixas?:[[qmin,preco]], promo?:{preco}, categoria?, vol?}]
 * Devolve modelos no formato consumido por buscarComposicao, com cotador real instrumentado.
 */
async function criarModelos(db, specs) {
  const modelos = [];
  let id = 0;
  for (const s of specs) {
    id += 1;
    await run(db, 'INSERT INTO produtos (id, nome, unidade, preco_venda, venda_atacado) VALUES (?,?,?,?,?)',
      [id, `M${id}`, 'un', s.preco, (s.faixas || []).length ? 1 : 0]);
    for (const [qmin, p] of (s.faixas || [])) {
      await run(db, 'INSERT INTO produto_atacado (produto_id, quantidade_minima, preco_atacado) VALUES (?,?,?)', [id, qmin, p]);
    }
    if (s.promo) {
      await run(db, `INSERT INTO promocoes (produto_id, preco_original, preco_promocional, data_inicio, data_fim, status)
        VALUES (?,?,?, '2026-10-01', '2026-12-31', 'ativa')`, [id, s.preco, s.promo.preco]);
    }
    const real = await criarCotadorPreco({ db, empresaId: 1, produtoId: id, tipoVenda: 'PESO', agora: AGORA });
    const instrumento = { chamadas: [], real };
    const cotador = {
      precoUnitarioMinimoInterno: real.precoUnitarioMinimoInterno,
      cotar(q) { instrumento.chamadas.push(q); return real.cotar(q); }
    };
    modelos.push({
      produtoId: id,
      categoriaFiscal: s.categoria || 'REFRIGERANTE',
      volumeMlPorUnidade: s.vol || 1,
      cotador,
      instrumento
    });
  }
  return modelos;
}

/** Oráculo independente: enumera todos os vetores de quantidade, ordem lexicográfica decrescente. */
function forcaBruta(modelos, capacidade, alvoMax, alvoMin = 0) {
  const n = modelos.length;
  const vec = new Array(n).fill(0);
  const budgets = { ...capacidade };
  let melhor = -1;
  let melhorVec = null;
  function rec(i, usado) {
    if (i === n) {
      const naoVazia = alvoMax === 0 || usado > 0;
      if (naoVazia && usado >= alvoMin && usado > melhor) { melhor = usado; melhorVec = vec.slice(); }
      return;
    }
    const m = modelos[i];
    const maxVol = Math.floor((budgets[m.categoriaFiscal] || 0) / m.volumeMlPorUnidade);
    for (let q = maxVol; q >= 0; q -= 1) {
      const sub = q === 0 ? 0 : m.instrumento.real.cotar(q).subtotalCentavos;
      if (usado + sub > alvoMax) continue;
      vec[i] = q;
      budgets[m.categoriaFiscal] -= q * m.volumeMlPorUnidade;
      rec(i + 1, usado + sub);
      budgets[m.categoriaFiscal] += q * m.volumeMlPorUnidade;
    }
    vec[i] = 0;
  }
  rec(0, 0);
  return { total: melhor, quantidades: melhorVec };
}

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

const CAP_BASE = { REFRIGERANTE: 0, AGUA: 0 };

// ------------------------------------------------------------------------------------------
// Frente 3
// ------------------------------------------------------------------------------------------

test('constantes de limite continuam as da Sprint 2.4 (não foram aumentadas)', () => {
  assert.equal(LIMITE_ESTADOS_BUSCA, 250000);
  assert.equal(LIMITE_QUANTIDADES_PARA_PODA, 20000);
});

test('busca × força bruta independente: 150 cenários aleatórios com atacado/promoção (subtotal não monotônico), 1–3 modelos, 2 categorias', async () => {
  const rnd = prng(251021);
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  let comExato = 0;
  let semExato = 0;
  let naoMonotonicos = 0;
  const falhas = [];
  for (let i = 0; i < 150; i += 1) {
    const db = await bancoMinimo();
    const n = int(1, 3);
    const specs = [];
    for (let k = 0; k < n; k += 1) {
      const preco = int(30, 3000) / 100;
      const faixas = [];
      if (rnd() < 0.7) {
        let qmin = int(2, 5);
        let p = preco;
        for (let f = int(1, 2); f > 0; f -= 1) {
          p = Math.round(p * (0.3 + rnd() * 0.6) * 1000) / 1000;
          if (p > 0) faixas.push([qmin, p]);
          qmin += int(1, 4);
        }
      }
      specs.push({
        preco, faixas, categoria: rnd() < 0.5 ? 'REFRIGERANTE' : 'AGUA', vol: int(1, 3),
        promo: rnd() < 0.25 ? { preco: Math.round(preco * (0.5 + rnd() * 0.5) * 100) / 100 } : null
      });
    }
    const modelos = await criarModelos(db, specs);
    const capacidade = { REFRIGERANTE: int(3, 14), AGUA: int(3, 14) };
    const maxTeorico = modelos.reduce((s, m) => {
      const maxQ = Math.floor(capacidade[m.categoriaFiscal] / m.volumeMlPorUnidade);
      let mx = 0;
      for (let q = 1; q <= maxQ; q += 1) mx = Math.max(mx, m.instrumento.real.cotar(q).subtotalCentavos);
      return s + mx;
    }, 0);
    // detecta subtotais não monotônicos neste cenário
    for (const m of modelos) {
      let anterior = 0;
      const maxQ = Math.floor(capacidade[m.categoriaFiscal] / m.volumeMlPorUnidade);
      for (let q = 1; q <= maxQ; q += 1) {
        const s = m.instrumento.real.cotar(q).subtotalCentavos;
        if (s < anterior) { naoMonotonicos += 1; break; }
        anterior = s;
      }
    }
    let alvo;
    if (rnd() < 0.5) {
      // alvo alcançável: soma de um vetor sorteado respeitando os orçamentos compartilhados
      const restante = { ...capacidade };
      alvo = 0;
      for (const m of modelos) {
        const maxQ = Math.floor(restante[m.categoriaFiscal] / m.volumeMlPorUnidade);
        const q = int(0, maxQ);
        restante[m.categoriaFiscal] -= q * m.volumeMlPorUnidade;
        if (q > 0) alvo += m.instrumento.real.cotar(q).subtotalCentavos;
      }
    } else {
      alvo = int(0, Math.floor(maxTeorico * 1.1) + 5);
    }
    const esperado = forcaBruta(modelos, { ...CAP_BASE, ...capacidade }, alvo);
    const obtido = buscarComposicao(modelos, { ...CAP_BASE, ...capacidade }, alvo);
    if (esperado.total === alvo && alvo > 0) comExato += 1; else semExato += 1;
    const ok = obtido.otimalidadeComprovada === true
      && obtido.completa === true
      && obtido.totalCentavos === esperado.total
      && JSON.stringify(obtido.quantidades) === JSON.stringify(esperado.quantidades)
      && obtido.encontrouExato === (esperado.total === alvo);
    if (!ok) falhas.push({ i, specs, capacidade, alvo, esperado, obtido });
    await new Promise((r) => db.close(r));
  }
  console.log('[2.5/forca-bruta]', JSON.stringify({ cenarios: 150, comExato, semExato, cenariosComSubtotalNaoMonotonico: naoMonotonicos }));
  assert.deepEqual(falhas.slice(0, 2), []);
  assert.ok(naoMonotonicos > 15, 'o conjunto precisa conter subtotais não monotônicos');
  assert.ok(comExato > 10 && semExato > 10, 'precisa haver cenários com e sem composição exata');
});

test('subtotal não monotônico explícito: q=7 a 6,00 custa menos que q=4 a 10,00; melhor total abaixo do residual', async () => {
  const db = await bancoMinimo();
  const modelos = await criarModelos(db, [{ preco: 10, faixas: [[5, 6]], vol: 1 }]);
  const cap = { ...CAP_BASE, REFRIGERANTE: 50 };
  assert.equal(modelos[0].instrumento.real.cotar(4).subtotalCentavos, 4000);
  assert.equal(modelos[0].instrumento.real.cotar(5).subtotalCentavos, 3000);
  const r = buscarComposicao(modelos, cap, 4300);
  // 7×6 = 42,00 é o maior total ≤ 43,00 (8×6 = 48,00 excede; 4×10 = 40,00 é pior)
  assert.equal(r.totalCentavos, 4200);
  assert.deepEqual(r.quantidades, [7]);
  assert.equal(r.encontrouExato, false);
  assert.equal(r.otimalidadeComprovada, true);
  const exato = buscarComposicao(modelos, cap, 4800);
  assert.equal(exato.encontrouExato, true);
  assert.deepEqual(exato.quantidades, [8]);
  await new Promise((rr) => db.close(rr));
});

test('qMax abaixo, igual e acima de 20.000: caminho de varredura × caminho alternativo, ambos conferidos com força bruta', async () => {
  const resultados = [];
  for (const [rotulo, capacidadeMl, alvo] of [
    ['abaixo (19.999)', 19999, 1000000],
    ['igual (20.000)', 20000, 1000000],
    ['acima (20.001)', 20001, 1000000],
    ['acima (25.000)', 25000, 1000000]
  ]) {
    const db = await bancoMinimo();
    // preço 0,02 com faixa a 0,015 a partir de 15.000: subtotal fortemente não monotônico
    const modelos = await criarModelos(db, [{ preco: 0.02, faixas: [[15000, 0.015]], vol: 1 }]);
    const cap = { ...CAP_BASE, REFRIGERANTE: capacidadeMl };
    const esperado = forcaBruta(modelos, cap, alvo);
    modelos[0].instrumento.chamadas.length = 0;
    const obtido = buscarComposicao(modelos, cap, alvo);
    const primeiraCotacao = modelos[0].instrumento.chamadas[0];
    resultados.push({ rotulo, qMax: capacidadeMl, primeiraCotacao, estados: obtido.estadosVisitados, total: obtido.totalCentavos });
    assert.equal(obtido.otimalidadeComprovada, true, rotulo);
    assert.equal(obtido.totalCentavos, esperado.total, rotulo);
    assert.deepEqual(obtido.quantidades, esperado.quantidades, rotulo);
    // caminho de varredura pré-calcula q=1..qMax ascendente; o alternativo não varre (primeira consulta é a de maior q)
    if (capacidadeMl <= LIMITE_QUANTIDADES_PARA_PODA) assert.equal(primeiraCotacao, 1, `${rotulo}: varredura ascendente`);
    else assert.equal(primeiraCotacao, capacidadeMl, `${rotulo}: caminho alternativo (sem varredura)`);
    await new Promise((r) => db.close(r));
  }
  console.log('[2.5/qMax]', JSON.stringify(resultados));
});

test('caminho alternativo (qMax > 20.000): sem solução exata, melhor total abaixo do residual e desempate preservados', async () => {
  const db = await bancoMinimo();
  const modelos = await criarModelos(db, [{ preco: 0.02, vol: 1 }]);
  const cap = { ...CAP_BASE, REFRIGERANTE: 1000000 };
  const casos = [
    [39998, 39998, 19999], [40000, 40000, 20000], [40002, 40002, 20001], // qMax por valor: 19999 / 20000 / 20001
    [39997, 39996, 19998], [40001, 40000, 20000], [40003, 40002, 20001], [40005, 40004, 20002]
  ];
  const linhas = [];
  for (const [alvo, melhor, qtd] of casos) {
    modelos[0].instrumento.chamadas.length = 0;
    const r = buscarComposicao(modelos, cap, alvo);
    assert.equal(r.otimalidadeComprovada, true);
    assert.equal(r.totalCentavos, melhor, `alvo ${alvo}`);
    assert.deepEqual(r.quantidades, [qtd], `alvo ${alvo}`);
    assert.equal(r.encontrouExato, alvo % 2 === 0);
    linhas.push({ alvo, qMaxPorValor: Math.floor((alvo * 10000 + 4999) / 20000), primeira: modelos[0].instrumento.chamadas[0], estados: r.estadosVisitados });
  }
  console.log('[2.5/poda-fallback]', JSON.stringify(linhas));
  await new Promise((r) => db.close(r));
});

test('limites de estados: contadores determinísticos; limite atingido nunca comprova optimalidade nem vira "inexistência"', async () => {
  const rnd = prng(99);
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const violacoes = [];
  let limitados = 0;
  let completos = 0;
  for (let i = 0; i < 40; i += 1) {
    const db = await bancoMinimo();
    const specs = [0, 1, 2].map(() => ({ preco: int(100, 900) / 100, faixas: rnd() < 0.5 ? [[int(2, 4), int(30, 90) / 100]] : [], categoria: 'REFRIGERANTE', vol: int(1, 2) }));
    const modelos = await criarModelos(db, specs);
    const cap = { ...CAP_BASE, REFRIGERANTE: 12 };
    const alvo = int(500, 4000);
    const esperado = forcaBruta(modelos, cap, alvo);
    for (const limite of [1, 3, 10, 40, 400]) {
      const a = buscarComposicao(modelos, cap, alvo, 0, limite);
      const b = buscarComposicao(modelos, cap, alvo, 0, limite);
      if (JSON.stringify(a) !== JSON.stringify(b)) violacoes.push({ i, limite, motivo: 'não determinístico' });
      if (a.estadosVisitados > limite) violacoes.push({ i, limite, motivo: 'excedeu o limite' });
      if (a.limiteAtingido) {
        limitados += 1;
        if (a.estadosVisitados !== limite) violacoes.push({ i, limite, motivo: 'contador ≠ limite' });
        if (a.completa) violacoes.push({ i, limite, motivo: 'completa com limite atingido' });
        if (a.otimalidadeComprovada && !a.encontrouExato) violacoes.push({ i, limite, motivo: 'otimalidade sem exato' });
      } else {
        completos += 1;
        if (!a.otimalidadeComprovada) violacoes.push({ i, limite, motivo: 'completa sem prova' });
      }
      if (a.otimalidadeComprovada && a.totalCentavos !== esperado.total) violacoes.push({ i, limite, motivo: 'prova com total diferente da força bruta', a, esperado });
      if (a.totalCentavos > alvo) violacoes.push({ i, limite, motivo: 'candidato excede o residual' });
    }
    await new Promise((r) => db.close(r));
  }
  console.log('[2.5/limites]', JSON.stringify({ execucoesLimitadas: limitados, execucoesCompletas: completos }));
  assert.deepEqual(violacoes.slice(0, 3), []);
  assert.ok(limitados > 20 && completos > 20);
});

test('limite de 1 estado: não há candidato, não há prova e o resultado difere de "sem composição" (existe solução por força bruta)', async () => {
  const db = await bancoMinimo();
  const modelos = await criarModelos(db, [{ preco: 2, vol: 1 }]);
  const cap = { ...CAP_BASE, REFRIGERANTE: 10 };
  assert.equal(forcaBruta(modelos, cap, 600).total, 600);
  const r = buscarComposicao(modelos, cap, 600, 0, 1);
  assert.equal(r.limiteAtingido, true);
  assert.equal(r.otimalidadeComprovada, false);
  assert.equal(r.totalCentavos, -1);
  assert.equal(r.quantidades, null);
  await new Promise((rr) => db.close(rr));
});

test('limite real de 250.000 estados: INCONCLUSIVA com contador exato e candidato parcial inutilizável (serviço)', async () => {
  const db = await bancoMinimo();
  const modelos = await criarModelos(db, [{ preco: 0.02, vol: 1 }, { preco: 0.04, vol: 1 }]);
  const cap = { ...CAP_BASE, REFRIGERANTE: 10000 };
  const r1 = buscarComposicao(modelos, cap, 4401);
  const r2 = buscarComposicao(modelos, cap, 4401);
  assert.equal(r1.limiteAtingido, true);
  assert.equal(r1.estadosVisitados, LIMITE_ESTADOS_BUSCA);
  assert.equal(r1.otimalidadeComprovada, false);
  assert.deepEqual(r1, r2, 'determinístico');
  await new Promise((rr) => db.close(rr));

  await fx.comContexto(async (ctx) => {
    await fx.run(ctx.db, 'UPDATE pedidos SET total = 61.99 WHERE id = ?', [ctx.pedidoId]);
    await fx.run(ctx.db, 'UPDATE pedidos_itens SET subtotal = 18.01, preco_unitario = 18.01 WHERE pedido_id = ? AND produto_id = ?', [ctx.pedidoId, ctx.coca]);
    await fx.modelo(ctx, { preco: 0.02, volumeMl: 1 });
    await fx.modelo(ctx, { preco: 0.04, volumeMl: 1 });
    await fx.saldo(ctx, 'REFRIGERANTE', 10000);
    const out = await fx.simular(ctx);
    assert.equal(out.status, 'INCONCLUSIVA');
    assert.equal(out.sucesso, false);
    assert.equal(out.composicaoParcialUtilizavel, false);
    assert.equal(out.otimalidadeComprovada, false);
    assert.equal(out.estadosBusca, LIMITE_ESTADOS_BUSCA);
    assert.equal(out.itensCompostos, undefined);
    assert.equal(out.valorFinalCentavos, undefined);
    assert.notEqual(out.codigo, 'COMPOSICAO_FISCAL_INEXISTENTE');
  });
  // a checagem de INCONCLUSIVA precede a de "inexistente" no serviço
  const src = fs.readFileSync(path.join(__dirname, '../../backend/services/vendas/ComposicaoFiscalPedidoService.js'), 'utf8');
  assert.ok(src.indexOf('!busca.otimalidadeComprovada') < src.indexOf("'COMPOSICAO_FISCAL_INEXISTENTE'"));
});

test('desempate determinístico (ordem lexicográfica das quantidades) e modelos múltiplos com quantidades elevadas', async () => {
  const db = await bancoMinimo();
  const modelos = await criarModelos(db, [
    { preco: 0.5, vol: 1 }, { preco: 0.5, vol: 1 }, { preco: 1, vol: 1 }
  ]);
  const cap = { ...CAP_BASE, REFRIGERANTE: 400 };
  const alvo = 15000; // 150,00 — várias combinações exatas; vence a de maior quantidade no 1º modelo
  const esperado = forcaBruta(modelos, cap, alvo);
  const r = buscarComposicao(modelos, cap, alvo);
  assert.equal(r.encontrouExato, true);
  assert.deepEqual(r.quantidades, esperado.quantidades);
  assert.deepEqual(r.quantidades, [300, 0, 0]);
  assert.deepEqual(buscarComposicao(modelos, cap, alvo).quantidades, r.quantidades);
  await new Promise((rr) => db.close(rr));
});

// ------------------------------------------------------------------------------------------
// Frente 4: desempenho (medições reproduzíveis; sem limite comercial inventado)
// ------------------------------------------------------------------------------------------

test('desempenho: cenários progressivos (tempo, estados, cotações e cache) — medição, sem teto de tempo', async () => {
  const cenarios = [
    { nome: 'P1 1 modelo, 2 faixas, qMax 1.000', specs: [{ preco: 0.5, faixas: [[10, 0.45], [100, 0.4]], vol: 1 }], cap: 1000, alvo: 33333 },
    { nome: 'P2 2 modelos, atacado, qMax 2.000 cada', specs: [{ preco: 0.5, faixas: [[10, 0.45]], vol: 1 }, { preco: 0.75, faixas: [[20, 0.6]], vol: 1 }], cap: 2000, alvo: 77777 },
    { nome: 'P3 3 modelos, promoção+atacado, cap 5.000', specs: [{ preco: 1.1, faixas: [[5, 1]], vol: 1 }, { preco: 0.9, vol: 2, promo: { preco: 0.8 } }, { preco: 2.5, faixas: [[3, 2.2]], vol: 3 }], cap: 5000, alvo: 123457 },
    { nome: 'P4 5 modelos mistos, 2 categorias, cap 300/200', specs: [{ preco: 7.5, faixas: [[3, 6.9]], vol: 10 }, { preco: 5.25, vol: 7 }, { preco: 3.1, categoria: 'AGUA', vol: 5, faixas: [[4, 2.9]] }, { preco: 9.9, categoria: 'AGUA', vol: 11 }, { preco: 4.4, vol: 3, promo: { preco: 4 } }], cap: 300, capAgua: 200, alvo: 4400 },
    { nome: 'P5 1 modelo qMax 20.000 (varredura)', specs: [{ preco: 0.02, faixas: [[15000, 0.015]], vol: 1 }], cap: 20000, alvo: 40001 },
    { nome: 'P6 1 modelo qMax 100.000 (caminho alternativo)', specs: [{ preco: 0.02, faixas: [[15000, 0.015]], vol: 1 }], cap: 100000, alvo: 200001 },
    { nome: 'P7 2 modelos, 10.000 ml compartilhados (limite)', specs: [{ preco: 0.02, vol: 1 }, { preco: 0.04, vol: 1 }], cap: 10000, alvo: 4401 },
    { nome: 'P8 8 modelos, 1 categoria, cap 500 (limite)', specs: [3.17, 4.29, 5.43, 6.61, 7.73, 8.87, 9.91, 11.03].map((p, i) => ({ preco: p, vol: i + 1, faixas: i % 2 ? [[3, Math.round(p * 90) / 100]] : [] })), cap: 500, alvo: 9999 }
  ];
  const tabela = [];
  for (const c of cenarios) {
    const db = await bancoMinimo();
    const modelos = await criarModelos(db, c.specs);
    const cap = { ...CAP_BASE, REFRIGERANTE: c.cap, AGUA: c.capAgua || 0 };
    const t0 = performance.now();
    const r = buscarComposicao(modelos, cap, c.alvo);
    const ms = Number((performance.now() - t0).toFixed(1));
    const chamadas = modelos.reduce((s, m) => s + m.instrumento.chamadas.length, 0);
    const unicas = modelos.reduce((s, m) => s + new Set(m.instrumento.chamadas).size, 0);
    const consultasReais = modelos.reduce((s, m) => s + m.instrumento.real.consultasCotacao, 0);
    const repetida = buscarComposicao(modelos, cap, c.alvo);
    assert.equal(repetida.estadosVisitados, r.estadosVisitados, `${c.nome}: contador determinístico`);
    assert.equal(repetida.totalCentavos, r.totalCentavos);
    assert.ok(r.estadosVisitados <= LIMITE_ESTADOS_BUSCA);
    if (r.limiteAtingido) { assert.equal(r.otimalidadeComprovada, false); assert.equal(r.estadosVisitados, LIMITE_ESTADOS_BUSCA); }
    assert.ok(r.totalCentavos <= c.alvo);
    assert.equal(consultasReais, unicas, 'o cache do cotador executa uma cotação real por quantidade distinta');
    tabela.push({
      cenario: c.nome, resultado: r.limiteAtingido ? 'INCONCLUSIVA' : (r.encontrouExato ? 'EXATA' : (r.totalCentavos < 0 ? 'SEM_COMPOSICAO' : 'MELHOR_ABAIXO')),
      ms, estados: r.estadosVisitados, chamadasCotar: chamadas, cotacoesReais: consultasReais, acertosCache: chamadas - consultasReais, total: r.totalCentavos
    });
    await new Promise((rr) => db.close(rr));
  }
  console.log('[2.5/desempenho-busca]\n' + tabela.map((l) => JSON.stringify(l)).join('\n'));
});

test('desempenho do serviço completo: N modelos elegíveis com atacado (carga de dependências + busca)', async () => {
  const linhas = [];
  for (const n of [5, 25, 100]) {
    await fx.comContexto(async (ctx) => {
      const rnd = prng(1000 + n);
      for (let i = 0; i < n; i += 1) {
        const preco = Math.round((3 + rnd() * 12) * 100) / 100;
        await fx.modelo(ctx, {
          categoria: i % 2 ? 'AGUA' : 'REFRIGERANTE', preco, volumeMl: 250 + (i % 7) * 150,
          atacado: i % 3 === 0 ? [[3, Math.round(preco * 0.9 * 100) / 100], [6, Math.round(preco * 0.8 * 100) / 100]] : []
        });
      }
      await fx.saldo(ctx, 'REFRIGERANTE', 20000);
      await fx.saldo(ctx, 'AGUA', 20000);
      const t0 = performance.now();
      const out = await fx.simular(ctx);
      const ms = Number((performance.now() - t0).toFixed(1));
      assert.ok(['INCONCLUSIVA', undefined].includes(out.status) || out.sucesso === true);
      if (out.status === 'INCONCLUSIVA') assert.equal(out.composicaoParcialUtilizavel, false);
      linhas.push({ modelos: n, ms, status: out.sucesso ? 'SUCESSO' : out.status, estados: out.estadosBusca ?? null, criterio: out.criterioSelecao || null });
    });
  }
  console.log('[2.5/desempenho-servico]\n' + linhas.map((l) => JSON.stringify(l)).join('\n'));
});

// ------------------------------------------------------------------------------------------
// Frente 5: saldos e reservas sob cotação por quantidade
// ------------------------------------------------------------------------------------------

test('saldo insuficiente: a quantidade é limitada pelo saldo mesmo quando o atacado tornaria mais unidades vantajosas', async () => {
  await fx.comContexto(async (ctx) => {
    await fx.modelo(ctx, { preco: 10, volumeMl: 1000, atacado: [[3, 8]] });
    await fx.saldo(ctx, 'REFRIGERANTE', 3000);
    const out = await fx.simular(ctx);
    assert.equal(out.sucesso, true);
    assert.equal(out.valorResidualCentavos, 4400);
    assert.deepEqual(out.itensCompostos.map((i) => i.quantidade), [3]);
    assert.equal(out.valorComposicaoCentavos - 1798, 2400);
    assert.equal(out.capacidadeFiscalPorCategoria.REFRIGERANTE.capacidadeMl, 3000);
    assert.ok(out.itensCompostos.reduce((s, i) => s + i.volumeTotalMl, 0) <= 3000);
  });
});

test('saldo parcialmente reservado: reserva de outro Pedido reduz a capacidade; reserva do próprio Pedido é creditada', async () => {
  await fx.comContexto(async (ctx) => {
    await fx.modelo(ctx, { preco: 10, volumeMl: 1000, atacado: [[3, 8]] });
    await fx.saldo(ctx, 'REFRIGERANTE', 5000);
    await fx.reservar(ctx, { pedidoId: await fx.outroPedido(ctx), ml: 3000 });
    let out = await fx.simular(ctx);
    assert.equal(out.capacidadeFiscalPorCategoria.REFRIGERANTE.saldoDisponivelMl, 2000);
    assert.equal(out.capacidadeFiscalPorCategoria.REFRIGERANTE.capacidadeMl, 2000);
    assert.deepEqual(out.itensCompostos.map((i) => i.quantidade), [2]);
    assert.equal(out.valorComposicaoCentavos - 1798, 2000, 'q=2 abaixo da faixa: 2 × 10,00');

    await fx.reservar(ctx, { pedidoId: ctx.pedidoId, ml: 1000 });
    out = await fx.simular(ctx);
    assert.equal(out.capacidadeFiscalPorCategoria.REFRIGERANTE.saldoReservadoMl, 4000);
    assert.equal(out.capacidadeFiscalPorCategoria.REFRIGERANTE.reservaDoPedidoMl, 1000);
    assert.equal(out.capacidadeFiscalPorCategoria.REFRIGERANTE.capacidadeMl, 2000);
  });
});

test('modelos concorrendo pelo mesmo saldo: resultado coincide com a força bruta usando a capacidade e a cotação reais', async () => {
  await fx.comContexto(async (ctx) => {
    const a = await fx.modelo(ctx, { preco: 10, volumeMl: 600, atacado: [[2, 8.5]] });
    const b = await fx.modelo(ctx, { preco: 7, volumeMl: 400, atacado: [[3, 6]] });
    await fx.saldo(ctx, 'REFRIGERANTE', 3000);
    await fx.reservar(ctx, { pedidoId: await fx.outroPedido(ctx), ml: 400 });
    const out = await fx.simular(ctx);
    assert.equal(out.capacidadeFiscalPorCategoria.REFRIGERANTE.capacidadeMl, 2600);

    const cotA = await criarCotadorPreco({ db: ctx.db, empresaId: ctx.empresaId, produtoId: a, agora: new Date(fx.REF) });
    const cotB = await criarCotadorPreco({ db: ctx.db, empresaId: ctx.empresaId, produtoId: b, agora: new Date(fx.REF) });
    const modelos = [
      { categoriaFiscal: 'REFRIGERANTE', volumeMlPorUnidade: 600, instrumento: { real: cotA } },
      { categoriaFiscal: 'REFRIGERANTE', volumeMlPorUnidade: 400, instrumento: { real: cotB } }
    ];
    const esperado = forcaBruta(modelos, { REFRIGERANTE: 2600, AGUA: 0 }, 4400);
    const quantidades = [a, b].map((id) => (out.itensCompostos.find((i) => i.produtoId === id) || { quantidade: 0 }).quantidade);
    assert.equal(out.valorComposicaoCentavos - 1798, esperado.total);
    assert.deepEqual(quantidades, esperado.quantidades);
    const usado = out.itensCompostos.reduce((s, i) => s + i.volumeTotalMl, 0);
    assert.ok(usado <= 2600);
  });
});

test('fingerprint muda com saldo e com reserva; fingerprintEsperado antigo é recusado após mudança', async () => {
  await fx.comContexto(async (ctx) => {
    await fx.modelo(ctx, { preco: 10, volumeMl: 1000, atacado: [[3, 8]] });
    await fx.saldo(ctx, 'REFRIGERANTE', 3000);
    const v1 = await fx.simular(ctx);
    assert.equal((await fx.simular(ctx)).fingerprint, v1.fingerprint, 'estável sem mudanças');

    // banco :memory: isolado; o serviço só permite uma abertura por categoria, então o saldo é alterado direto
    await fx.run(ctx.db, "UPDATE saldo_fiscal_categoria_empresa SET saldo_atual_ml = saldo_atual_ml + 1000 WHERE categoria_fiscal = 'REFRIGERANTE'");
    const v2 = await fx.simular(ctx);
    assert.notEqual(v2.fingerprint, v1.fingerprint, 'saldo alterado');
    assert.deepEqual(v2.itensCompostos.map((i) => i.quantidade), [4], 'dados mudaram entre simulações: agora cabem 4 (faixa 8,00 → 32,00)');
    await assert.rejects(fx.simular(ctx, { fingerprintEsperado: v1.fingerprint }), (e) => e.code === 'COMPOSICAO_DESATUALIZADA');

    await fx.reservar(ctx, { pedidoId: await fx.outroPedido(ctx), ml: 1000 });
    const v3 = await fx.simular(ctx);
    assert.notEqual(v3.fingerprint, v2.fingerprint, 'reserva alterada');
    await assert.rejects(fx.simular(ctx, { fingerprintEsperado: v2.fingerprint }), (e) => e.code === 'COMPOSICAO_DESATUALIZADA');
    const confere = await fx.simular(ctx, { fingerprintEsperado: v3.fingerprint });
    assert.equal(confere.fingerprint, v3.fingerprint);
  });
});

test('limitação de concorrência: duas simulações usam o mesmo saldo (nada é reservado) — snapshot não garante disponibilidade futura', async () => {
  await fx.comContexto(async (ctx) => {
    await fx.modelo(ctx, { preco: 10, volumeMl: 1000, atacado: [[3, 8]] });
    await fx.saldo(ctx, 'REFRIGERANTE', 3000);
    const antes = await fx.snapshotTotal(ctx.db);
    const a = await fx.simular(ctx);
    const b = await fx.simular(ctx);
    assert.deepEqual(a.itensCompostos, b.itensCompostos, 'dois chamadores concorrentes receberiam os mesmos 3000 ml');
    assert.equal(a.fingerprint, b.fingerprint);
    assert.equal(a.simulacaoAutorizaDesconto, false);
    assert.equal(await fx.snapshotTotal(ctx.db), antes, 'nenhuma reserva, saldo, venda, estoque ou movimento foi alterado');
    const saldos = await fx.all(ctx.db, 'SELECT saldo_atual_ml, saldo_reservado_ml FROM saldo_fiscal_categoria_empresa');
    assert.deepEqual(saldos.map((s) => s.saldo_reservado_ml), [0]);
  });
});

test('isolamento entre empresas e ausência de efeitos operacionais nas simulações de limite', async () => {
  await fx.comContexto(async (ctx) => {
    await fx.modelo(ctx, { preco: 0.02, volumeMl: 1 });
    await fx.modelo(ctx, { preco: 0.04, volumeMl: 1 });
    await fx.saldo(ctx, 'REFRIGERANTE', 10000);
    await fx.run(ctx.db, 'UPDATE pedidos SET total = 61.99 WHERE id = ?', [ctx.pedidoId]);
    await fx.run(ctx.db, 'UPDATE pedidos_itens SET subtotal = 18.01, preco_unitario = 18.01 WHERE pedido_id = ? AND produto_id = ?', [ctx.pedidoId, ctx.coca]);
    const antes = await fx.snapshotTotal(ctx.db);
    const out = await fx.simular(ctx);
    assert.equal(out.status, 'INCONCLUSIVA');
    assert.equal(out.efeitosOperacionais, false);
    assert.equal(await fx.snapshotTotal(ctx.db), antes);
  });
});
