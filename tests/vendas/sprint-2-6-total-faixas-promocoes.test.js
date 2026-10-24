'use strict';

/**
 * Sprint 2.6 — Frentes B, C e D (investigação; NENHUMA regra comercial alterada).
 *  B: total da tela × soma dos subtotais por linha enviados no payload.
 *  C: faixas de atacado duplicadas (PDV × cotação).
 *  D: múltiplas promoções ativas (rota promocao-ativa × cotação).
 * SQLite em memória; código real do PDV via vm (stubs de jQuery/DOM, não é navegador real).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const { cotarPrecoProduto } = require('../../backend/services/vendas/CotacaoPrecoProdutoService');
const Motor = require('../../backend/services/vendas/MotorPrecoAtacado');
const { criarPdvReal, extrairSqlPromocaoAtiva, lerPdv } = require('./helpers/pdv-real-adaptador');

const REF = '2026-10-21T12:00:00Z';
const REF_DATE = new Date(REF);
const raiz = path.join(__dirname, '..', '..');
const ler = (rel) => fs.readFileSync(path.join(raiz, rel), 'utf8');

function abrir() {
  return new Promise((res, rej) => { const db = new sqlite3.Database(':memory:', (e) => (e ? rej(e) : res(db))); });
}
const run = (db, sql, p = []) => new Promise((res, rej) => db.run(sql, p, function onRun(e) { return e ? rej(e) : res(this.lastID); }));
const all = (db, sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r || []))));
const get = (db, sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r))));

async function criarBanco() {
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
// FRENTE B
// ---------------------------------------------------------------------------------------------

test('B1 mapa: o payload envia total agregado e subtotais por linha; o backend não os reconcilia', () => {
  const pdv = lerPdv();
  assert.match(pdv, /function calcularSubtotal\(\) \{\s*const soma = carrinho\.reduce\(\(acc, item\) => acc \+ Number\(item\.subtotal \|\| 0\), 0\);\s*return motorPrecoAtacadoDisponivel\(\) \? MotorPrecoAtacado\.arredondarMoeda\(soma\)/);
  assert.match(pdv, /const total = Math\.round\(\(Math\.max\(0, subtotal - desconto \+ acrescimo\)\) \* 100\) \/ 100;/);
  assert.match(pdv, /subtotal_exibicao \?\? MotorPrecoAtacado\.arredondarMoeda/);

  const pag = ler('backend/services/vendas/VendaFinanceiroService.js');
  const trecho = pag.slice(pag.indexOf('function validarSomaPagamentosVenda'));
  assert.match(trecho.slice(0, 1800), /0\.01/, 'única verificação: pagamentos × total, tolerância de 1 centavo');

  const venda = ler('backend/services/vendas/VendaPagamentoService.js');
  assert.ok(!/SUM\(\s*subtotal/i.test(venda), 'não há soma de subtotais de itens comparada ao total');
  assert.match(venda, /INSERT INTO vendas_itens/);
});

test('B2 PDV real: linhas exibidas × Subtotal da tela × total do payload (casos de borda, desconto e acréscimo)', async () => {
  const db = await criarBanco();
  const pdv = criarPdvReal({ produtos: [] });
  const casos = [
    { nome: '3×0,25kg×1,99', linhas: [[1.99, 0.25], [1.99, 0.25], [1.99, 0.25]], desconto: 0, acrescimo: 0 },
    { nome: 'meio centavo isolado', linhas: [[0.01, 0.5]], desconto: 0, acrescimo: 0 },
    { nome: '2 linhas meio centavo', linhas: [[0.01, 0.5], [0.01, 0.5]], desconto: 0, acrescimo: 0 },
    { nome: '3 linhas 0,4975 com desconto 0,10', linhas: [[1.99, 0.25], [1.99, 0.25], [1.99, 0.25]], desconto: 0.1, acrescimo: 0 },
    { nome: '3 linhas 0,4975 com acréscimo 0,05', linhas: [[1.99, 0.25], [1.99, 0.25], [1.99, 0.25]], desconto: 0, acrescimo: 0.05 },
    { nome: 'linhas inteiras (sem efeito)', linhas: [[10, 2], [3.5, 4]], desconto: 0, acrescimo: 0 }
  ];
  const resultados = [];
  for (const c of casos) {
    pdv.api.limparCarrinho();
    pdv.sandbox.produtosDisponiveis.length = 0;
    let id = 0;
    for (const [preco, qtd] of c.linhas) {
      id += 1;
      await run(db, 'INSERT OR REPLACE INTO produtos (id, nome, unidade, preco_venda, produto_fracionado) VALUES (?,?,?,?,1)', [id, `P${id}`, 'kg', preco]);
      const produto = await get(db, 'SELECT * FROM produtos WHERE id = ?', [id]);
      pdv.sandbox.produtosDisponiveis.push(produto);
      pdv.api.adicionarItemNoCarrinho(produto, qtd, preco, '', null, { tipo_venda: 'PESO' });
    }
    const itens = Array.from(pdv.api.carrinho);
    const somaLinhasCent = itens.reduce((s, it) => s + Math.round(it.subtotal_exibicao * 100), 0);
    const subtotalTelaCent = Math.round(pdv.api.calcularSubtotal() * 100);
    const totalTelaCent = Math.round(Math.max(0, subtotalTelaCent / 100 - c.desconto + c.acrescimo) * 100);
    const totalPorLinhaCent = Math.round(Math.max(0, somaLinhasCent / 100 - c.desconto + c.acrescimo) * 100);
    resultados.push({ caso: c.nome, somaLinhasCent, subtotalTelaCent, totalPayloadCent: totalTelaCent, totalSeSomaLinhasCent: totalPorLinhaCent, diferencaCent: somaLinhasCent - subtotalTelaCent });
    assert.ok(Math.abs(somaLinhasCent - subtotalTelaCent) <= 1, c.nome);
  }
  console.log('[2.6/B2]', JSON.stringify(resultados));
  assert.equal(resultados[0].diferencaCent, 1);
  assert.equal(resultados[5].diferencaCent, 0);
  await new Promise((r) => db.close(r));
});

test('B3 quantificação: divergência soma-por-linha × agregado por número de linhas (1..10), distribuição em centavos', () => {
  const rnd = prng(26);
  const n = 20000;
  const saida = [];
  for (let k = 1; k <= 10; k += 1) {
    let div = 0;
    let max = 0;
    let somaAbs = 0;
    const dist = {};
    for (let i = 0; i < n; i += 1) {
      const linhas = Array.from({ length: k }, () => {
        const preco = (1 + Math.floor(rnd() * 5000)) / 100;
        const qtd = (1 + Math.floor(rnd() * 500)) / 100;
        return Motor.calcularLinhaPrecoUnitarioInformado({ precoOriginal: preco, quantidade: qtd, precoUnitarioInformado: preco });
      });
      const porLinha = linhas.reduce((s, l) => s + Math.round(l.total * 100), 0);
      const agregado = Math.round(Motor.arredondarMoeda(linhas.reduce((s, l) => s + l.totalInterno, 0)) * 100);
      const d = porLinha - agregado;
      if (d !== 0) div += 1;
      max = Math.max(max, Math.abs(d));
      somaAbs += Math.abs(d);
      dist[d] = (dist[d] || 0) + 1;
    }
    saida.push({ linhas: k, carrinhos: n, divergentes: div, pct: Number((div * 100 / n).toFixed(2)), maxAbsCent: max, mediaAbsCent: Number((somaAbs / n).toFixed(4)), distribuicao: dist });
  }
  console.log('[2.6/B3]', JSON.stringify(saida));
  assert.equal(saida[0].divergentes, 0, 'com 1 linha os dois caminhos coincidem');
  assert.ok(saida[2].divergentes > 0);
  assert.ok(saida.some((s) => s.maxAbsCent >= 2), 'com muitas linhas a diferença pode passar de 1 centavo (acima da tolerância de pagamentos)');
});

test('B4 política: nenhuma função de agregação oficial no núcleo compartilhado (nada a alterar nesta sprint)', () => {
  const nomes = Object.keys(Motor);
  assert.ok(!nomes.some((n) => /carrinho|agreg|totalVenda|somaLinhas/i.test(n)), `exports: ${nomes.join(', ')}`);
  const rcm = ler('tests/vendas/rcm-atacado-02-precisao-desconto.test.js');
  assert.match(rcm, /sem arredondar antes do total/);
});

// ---------------------------------------------------------------------------------------------
// FRENTE C
// ---------------------------------------------------------------------------------------------

test('C1 inserirFaixasAtacadoProduto (cadastro/edição do produto) não rejeita duplicatas; POST/PUT de faixa rejeitam', () => {
  const rota = ler('backend/rotas/produtos.js');
  const ini = rota.indexOf('function inserirFaixasAtacadoProduto');
  const corpo = rota.slice(ini, rota.indexOf('function salvarEmbalagensProduto'));
  assert.ok(!/Já existe|COUNT\(|SELECT/i.test(corpo), 'o insert em lote não consulta faixas existentes nem da mesma lista');
  assert.match(rota, /router\.post\('\/:id\/atacado'[\s\S]*Já existe uma faixa com essa quantidade/);
  assert.match(rota, /router\.put\('\/atacado\/:faixaId'[\s\S]*AND id != \?/);
  // caminhos de chamada do insert em lote
  assert.equal((rota.match(/inserirFaixasAtacadoProduto\(/g) || []).length, 3, 'definição + criação + edição de produto');
});

test('C2 o schema não impõe unicidade (produto_id, quantidade_minima)', () => {
  const dbjs = ler('backend/database.js');
  const i = dbjs.indexOf('CREATE TABLE IF NOT EXISTS produto_atacado');
  assert.ok(i > 0);
  assert.ok(!/UNIQUE/i.test(dbjs.slice(i, i + 500)));
  assert.ok(!/CREATE UNIQUE INDEX[^;]*produto_atacado/i.test(dbjs));
});

test('C3 reprodução: faixas duplicadas dão preços diferentes no PDV e na cotação; ordem de inserção inverte o vencedor do PDV', async () => {
  const saida = [];
  for (const ordem of [[[5, 8], [5, 7]], [[5, 7], [5, 8]]]) {
    const db = await criarBanco();
    await run(db, "INSERT INTO produtos (id, nome, unidade, preco_venda, venda_atacado) VALUES (1,'P','un',10,1)");
    for (const [q, p] of ordem) await run(db, 'INSERT INTO produto_atacado (produto_id, quantidade_minima, preco_atacado) VALUES (1,?,?)', [q, p]);
    const faixasRota = await all(db, 'SELECT * FROM produto_atacado WHERE produto_id = 1 ORDER BY quantidade_minima ASC');
    const produto = await get(db, 'SELECT * FROM produtos WHERE id = 1');
    const pdv = criarPdvReal({ produtos: [produto], faixasPorProduto: { 1: faixasRota } });
    pdv.api.adicionarItemNoCarrinho(pdv.sandbox.produtosDisponiveis[0], 6, 10, '', null, { tipo_venda: 'PESO' });
    const cot = await cotarPrecoProduto({ db, empresaId: 1, produtoId: 1, quantidade: 6, tipoVenda: 'PESO', agora: REF_DATE });
    saida.push({ insercao: ordem.map((o) => o[1]), pdv: pdv.api.carrinho[0].preco_unitario, cotacao: cot.precoUnitarioInterno });
    await new Promise((r) => db.close(r));
  }
  console.log('[2.6/C3]', JSON.stringify(saida));
  assert.deepEqual(saida.map((s) => [s.pdv, s.cotacao]), [[8, 7], [7, 8]], 'PDV = primeira linha retornada; cotação = última por id');
});

// ---------------------------------------------------------------------------------------------
// FRENTE D
// ---------------------------------------------------------------------------------------------

const SQL_ROTA = extrairSqlPromocaoAtiva().replace(/date\('now'\)/g, 'date(?)');

test('D1 rota POST /promocoes e o schema permitem sobreposição de promoções ativas do mesmo produto', () => {
  const rota = ler('backend/rotas/produtos.js');
  const ini = rota.indexOf("router.post('/promocoes'");
  const corpo = rota.slice(ini, rota.indexOf("router.put('/promocoes/:id/encerrar'"));
  assert.ok(!/SELECT[\s\S]*FROM promocoes/i.test(corpo), 'sem verificação de promoção ativa/sobreposta antes do INSERT');
  assert.match(corpo, /'ativa'/);
  const dbjs = ler('backend/database.js');
  const i = dbjs.indexOf('CREATE TABLE IF NOT EXISTS promocoes (');
  assert.ok(!/UNIQUE/i.test(dbjs.slice(i, i + 700)));
});

test('D2 duas promoções ativas: rota (LIMIT 1 sem ORDER BY) × cotação (ORDER BY id) — resultado observado', async () => {
  const db = await criarBanco();
  await run(db, "INSERT INTO produtos (id, nome, unidade, preco_venda) VALUES (1,'P','un',10)");
  const ins = (preco, ini, fim) => run(db, "INSERT INTO promocoes (produto_id, preco_original, preco_promocional, data_inicio, data_fim, status) VALUES (1,10,?,?,?, 'ativa')", [preco, ini, fim]);
  const idA = await ins(9, '2026-10-01', '2026-11-01'); // id menor, menos desconto
  const idB = await ins(7, '2026-10-15', '2026-12-01'); // id maior, mais desconto, início mais recente

  const ativas = await all(db, "SELECT id FROM promocoes WHERE produto_id = 1 AND status = 'ativa' AND date(data_inicio) <= date(?) AND date(data_fim) > date(?)", [REF, REF]);
  assert.equal(ativas.length, 2, 'a condição de duas promoções ativas é aceita pelos dados');

  const rota = await get(db, SQL_ROTA, [1, REF, REF]);
  const cot = await cotarPrecoProduto({ db, empresaId: 1, produtoId: 1, quantidade: 1, tipoVenda: 'PESO', agora: REF_DATE });
  const planoSemOrder = await all(db, `EXPLAIN QUERY PLAN ${SQL_ROTA}`, [1, REF, REF]);
  console.log('[2.6/D2]', JSON.stringify({ idA, idB, rotaId: rota.id, rotaPreco: rota.preco_promocional, cotacaoPreco: cot.precoUnitarioInterno, plano: planoSemOrder.map((p) => p.detail) }));

  assert.equal(cot.precoUnitarioInterno, 9, 'cotação: menor id (ORDER BY id ASC)');
  assert.ok([idA, idB].includes(rota.id));
  // Registro do observado neste esquema de teste (sem índices): varredura por rowid => menor id.
  // Com outro plano (ex.: índice em promocoes), a ordem de retorno pode mudar, pois não há ORDER BY.
  assert.equal(rota.id, idA);
  await new Promise((r) => db.close(r));
});

test('D3 sem ORDER BY a escolha é do plano de consulta: registra o resultado antes/depois de um índice (neste caso, inalterado)', async () => {
  const db = await criarBanco();
  await run(db, "INSERT INTO produtos (id, nome, unidade, preco_venda) VALUES (1,'P','un',10)");
  const ins = (preco, ini, fim) => run(db, "INSERT INTO promocoes (produto_id, preco_original, preco_promocional, data_inicio, data_fim, status) VALUES (1,10,?,?,?, 'ativa')", [preco, ini, fim]);
  await ins(9, '2026-10-01', '2026-12-01');
  await ins(7, '2026-10-15', '2026-11-01');
  const antes = (await get(db, SQL_ROTA, [1, REF, REF])).id;
  await run(db, 'CREATE INDEX idx_teste_promo ON promocoes(produto_id, data_fim DESC)'); // índice APENAS no banco em memória
  const depois = (await get(db, SQL_ROTA, [1, REF, REF])).id;
  console.log('[2.6/D3]', JSON.stringify({ antes, depois }));
  assert.ok([1, 2].includes(antes) && [1, 2].includes(depois));
  await new Promise((r) => db.close(r));
});

test('D4 vigência preservada: data_fim exclusiva na rota (sem alteração de regra de data/fuso)', () => {
  const sql = extrairSqlPromocaoAtiva();
  assert.match(sql, /date\(p\.data_fim\) > date\('now'\)/);
  assert.match(sql, /date\(p\.data_inicio\) <= date\('now'\)/);
});
