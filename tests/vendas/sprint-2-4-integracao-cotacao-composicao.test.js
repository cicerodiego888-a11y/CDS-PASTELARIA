'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaProdutoConversaoAsync } = require('../../backend/services/produtos/produtoConversaoSchema');
const { garantirSchemaCategoriaFiscalEmpresaAsync } = require('../../backend/services/vendas/categoriaFiscalEmpresaSchema');
const { garantirSchemaSaldoFiscalCategoriaAsync } = require('../../backend/services/vendas/saldoFiscalCategoriaSchema');
const { garantirSchemaReservaSaldoFiscalCategoriaAsync } = require('../../backend/services/vendas/reservaSaldoFiscalCategoriaSchema');
const CategoriaFiscalEmpresaService = require('../../backend/services/vendas/CategoriaFiscalEmpresaService');
const SaldoFiscalCategoriaService = require('../../backend/services/vendas/SaldoFiscalCategoriaService');
const Composicao = require('../../backend/services/vendas/ComposicaoFiscalPedidoService');
const { cotarPrecoProduto, criarCotadorPreco } = require('../../backend/services/vendas/CotacaoPrecoProdutoService');
const Motor = require('../../backend/services/vendas/MotorPrecoAtacado');

const REF = '2026-10-21T12:00:00Z';

function abrirDb() {
  return new Promise((res, rej) => {
    const db = new sqlite3.Database(':memory:', (e) => (e ? rej(e) : res(db)));
  });
}
function run(db, sql, p = []) {
  return new Promise((res, rej) => db.run(sql, p, function onRun(e) { return e ? rej(e) : res({ lastID: this.lastID }); }));
}
function all(db, sql, p = []) {
  return new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r || []))));
}
function fechar(db) {
  return new Promise((res, rej) => db.close((e) => (e ? rej(e) : res())));
}

async function criarContexto() {
  const db = await abrirDb();
  await garantirSchemaEmpresasAsync(db);
  await run(db, `CREATE TABLE produtos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT, nome TEXT NOT NULL, unidade TEXT,
    preco_venda REAL NOT NULL, ativo INTEGER DEFAULT 1, tipo_operacional TEXT DEFAULT 'COMERCIAL',
    utiliza_volume INTEGER DEFAULT 0, volume_valor REAL, volume_unidade TEXT, estoque_atual REAL DEFAULT 0,
    preco_unidade REAL, permite_venda_unidade INTEGER DEFAULT 0, produto_fracionado INTEGER DEFAULT 0,
    vendido_por_peso INTEGER DEFAULT 0, venda_atacado INTEGER DEFAULT 0, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  await run(db, `CREATE TABLE promocoes (id INTEGER PRIMARY KEY AUTOINCREMENT, produto_id INTEGER, preco_original REAL,
    preco_promocional REAL, data_inicio DATE, data_fim DATE, status TEXT DEFAULT 'ativa')`);
  await run(db, `CREATE TABLE produto_atacado (id INTEGER PRIMARY KEY AUTOINCREMENT, produto_id INTEGER,
    quantidade_minima INTEGER, preco_atacado REAL)`);
  await garantirSchemaProdutoConversaoAsync(db);
  await garantirSchemaCategoriaFiscalEmpresaAsync(db);
  await garantirSchemaSaldoFiscalCategoriaAsync(db);
  await garantirSchemaReservaSaldoFiscalCategoriaAsync(db);
  await run(db, 'CREATE TABLE clientes (id INTEGER PRIMARY KEY, nome TEXT)');
  await run(db, 'CREATE TABLE usuarios (id INTEGER PRIMARY KEY, username TEXT, nome TEXT)');
  await run(db, `CREATE TABLE pedidos (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT, data_pedido TEXT NOT NULL,
    cliente_id INTEGER, total REAL NOT NULL, desconto REAL DEFAULT 0, frete REAL DEFAULT 0, status TEXT NOT NULL,
    empresa_id INTEGER NOT NULL, venda_id INTEGER, operador_id INTEGER, representante_id INTEGER,
    representante_nome TEXT, observacao TEXT, created_at TEXT, updated_at TEXT)`);
  await run(db, `CREATE TABLE pedidos_itens (id INTEGER PRIMARY KEY AUTOINCREMENT, pedido_id INTEGER NOT NULL,
    produto_id INTEGER NOT NULL, quantidade REAL NOT NULL, preco_unitario REAL NOT NULL,
    desconto_percentual REAL DEFAULT 0, subtotal REAL NOT NULL, tipo_venda TEXT DEFAULT 'UN',
    classificacao_operacional_snapshot TEXT, produto_codigo_snapshot TEXT, produto_nome_snapshot TEXT,
    produto_unidade_snapshot TEXT)`);
  const empresaId = (await EmpresaService.criarEmpresa(
    { cnpj: '11222333000181', razao_social: 'Empresa teste cotação' }, { db }
  )).id;
  const pastel = await criarProduto(db, { nome: 'Pastel', preco: 8.99 });
  const coca = await criarProduto(db, { nome: 'Coca operacional', preco: 18 });
  const pedido = await run(db,
    `INSERT INTO pedidos (codigo, data_pedido, total, desconto, frete, status, empresa_id)
     VALUES ('PED-2-4', '2026-10-21', 61.98, 0, 0, 'PEDIDO', ?)`, [empresaId]);
  await run(db, `INSERT INTO pedidos_itens (pedido_id, produto_id, quantidade, preco_unitario, subtotal)
    VALUES (?, ?, 2, 21.99, 43.98)`, [pedido.lastID, pastel]);
  await run(db, `INSERT INTO pedidos_itens (pedido_id, produto_id, quantidade, preco_unitario, subtotal)
    VALUES (?, ?, 1, 18, 18)`, [pedido.lastID, coca]);
  return { db, empresaId, pedidoId: pedido.lastID, pastel, coca };
}

async function criarProduto(db, e) {
  const volume = e.volume || null;
  return (await run(db,
    `INSERT INTO produtos (nome, unidade, preco_venda, ativo, tipo_operacional, utiliza_volume, volume_valor, volume_unidade)
     VALUES (?, 'UN', ?, 1, 'COMERCIAL', ?, ?, ?)`,
    [e.nome, e.preco, volume ? 1 : 0, volume ? volume.valor : null, volume ? volume.unidade : null])).lastID;
}

async function modelo(ctx, { categoria = 'REFRIGERANTE', preco, volumeMl = 1000, atacado = [], promocao = null }) {
  const id = await criarProduto(ctx.db, { nome: `Modelo ${preco}`, preco, volume: { valor: volumeMl, unidade: 'ML' } });
  await CategoriaFiscalEmpresaService.definirVinculo({
    empresaId: ctx.empresaId, produtoId: id, categoriaFiscal: categoria, elegivelComposicao: true
  }, { db: ctx.db });
  if (atacado.length) {
    await run(ctx.db, 'UPDATE produtos SET venda_atacado = 1 WHERE id = ?', [id]);
    for (const [qmin, p] of atacado) {
      await run(ctx.db, 'INSERT INTO produto_atacado (produto_id, quantidade_minima, preco_atacado) VALUES (?,?,?)', [id, qmin, p]);
    }
  }
  if (promocao) {
    await run(ctx.db,
      `INSERT INTO promocoes (produto_id, preco_original, preco_promocional, data_inicio, data_fim, status)
       VALUES (?, ?, ?, ?, ?, 'ativa')`,
      [id, preco, promocao.preco, promocao.inicio, promocao.fim]);
  }
  return id;
}

async function saldo(ctx, categoria, ml) {
  await SaldoFiscalCategoriaService.garantirSaldo({ empresaId: ctx.empresaId, categoriaFiscal: categoria }, { db: ctx.db });
  await SaldoFiscalCategoriaService.registrarAbertura({
    empresaId: ctx.empresaId, categoriaFiscal: categoria, quantidadeMl: ml, usuarioId: 1,
    motivo: 'Abertura sintética para teste isolado', referencia: { tipo: 'TESTE', id: `${ctx.empresaId}-${categoria}` },
    idempotencyKey: `abertura-${ctx.empresaId}-${categoria}`, confirmado: true
  }, { db: ctx.db });
}

function simular(ctx, extra = {}) {
  return Composicao.simularComposicao({
    empresaId: ctx.empresaId,
    pedidoId: ctx.pedidoId,
    itensFixos: [{ produtoId: ctx.pastel, quantidade: 2 }],
    dataReferencia: REF,
    ...extra
  }, { db: ctx.db });
}

async function comContexto(fn) {
  const ctx = await criarContexto();
  try { await fn(ctx); } finally { await fechar(ctx.db); }
}

async function snapshotTotal(db) {
  const tabelas = await all(db, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  const out = { schema: await all(db, 'SELECT type,name,sql FROM sqlite_master ORDER BY type,name') };
  for (const { name } of tabelas) out[name] = await all(db, `SELECT * FROM "${name}"`);
  return JSON.stringify(out);
}

// Residual dos fixtures: 61,98 - 2 x 8,99 = 44,00 (4400 centavos)

test('composição exata usa a cotação por quantidade (atacado) e ignora preço unitário constante', async () => {
  await comContexto(async (ctx) => {
    const m = await modelo(ctx, { preco: 10, atacado: [[5, 8.8]] });
    await saldo(ctx, 'REFRIGERANTE', 10000);
    const out = await simular(ctx);
    assert.equal(out.sucesso, true);
    assert.equal(out.criterioSelecao, 'COMPOSICAO_EXATA');
    assert.equal(out.valorResidualCentavos, 4400);
    const item = out.itensCompostos.find((i) => i.produtoId === m);
    assert.equal(item.quantidade, 5);
    assert.equal(item.subtotalCentavos, 4400);
    assert.equal(item.precoUnitario, 8.8);
    assert.ok(item.regrasAplicadas.some((r) => r.tipo === 'ATACADO'));
    assert.equal(out.descontoAplicadoCentavos, 0);
    assert.equal(out.simulacaoAutorizaDesconto, false);
    assert.equal(out.modoVendaModelos, 'PESO');
    assert.match(out.fontePrecoModelos, /CotacaoPrecoProdutoService/);
  });
});

test('subtotal não monotônico: quantidade maior que o residual é descartada sem encerrar a varredura', async () => {
  await comContexto(async (ctx) => {
    const m = await modelo(ctx, { preco: 10, atacado: [[5, 6]] });
    await saldo(ctx, 'REFRIGERANTE', 10000);
    const out = await simular(ctx);
    const item = out.itensCompostos.find((i) => i.produtoId === m);
    // q=4 -> 40,00; q=5 -> 30,00; q=7 -> 42,00; q=8 -> 48,00 (excede). O melhor abaixo de 44,00 é q=7.
    assert.equal(item.quantidade, 7);
    assert.equal(item.subtotalCentavos, 4200);
    assert.equal(out.criterioSelecao, 'MENOR_DESCONTO_COMPROVADO');
    assert.equal(out.otimalidadeComprovada, true);
    assert.equal(out.descontoAplicadoCentavos, 200);
    assert.equal(out.descontoRequerAprovacao, true);
    assert.equal(out.simulacaoAutorizaDesconto, false);
  });
});

test('promoção combinada com atacado e data de referência explícita', async () => {
  await comContexto(async (ctx) => {
    const m = await modelo(ctx, {
      preco: 10, atacado: [[5, 8]], promocao: { preco: 9, inicio: '2026-10-01', fim: '2026-11-01' }
    });
    await saldo(ctx, 'REFRIGERANTE', 10000);
    const out = await simular(ctx);
    const item = out.itensCompostos.find((i) => i.produtoId === m);
    assert.equal(item.quantidade, 5);
    assert.equal(item.subtotalCentavos, 4000);
    assert.deepEqual(item.regrasAplicadas.map((r) => r.tipo), ['PRECO_REGULAR', 'PROMOCAO', 'ATACADO']);
    assert.equal(out.dataReferenciaCotacao, new Date(REF).toISOString());
  });
});

test('promoção expirada na data de referência (data_fim exclusiva) muda o resultado e o fingerprint', async () => {
  await comContexto(async (ctx) => {
    await modelo(ctx, { preco: 10, promocao: { preco: 9.5, inicio: '2026-10-01', fim: '2026-11-01' } });
    await saldo(ctx, 'REFRIGERANTE', 10000);
    const ativa = await simular(ctx, { dataReferencia: '2026-10-21T12:00:00Z' });
    const fimExclusivo = await simular(ctx, { dataReferencia: '2026-11-01T12:00:00Z' });
    assert.equal(ativa.itensCompostos[0].quantidade, 4);
    assert.equal(ativa.itensCompostos[0].subtotalCentavos, 3800);
    assert.equal(fimExclusivo.itensCompostos[0].quantidade, 4);
    assert.equal(fimExclusivo.itensCompostos[0].subtotalCentavos, 4000);
    assert.notEqual(ativa.fingerprint, fimExclusivo.fingerprint);
  });
});

test('modo de venda é explícito: unidade não é escolhida implicitamente e modos não definidos são bloqueados', async () => {
  await comContexto(async (ctx) => {
    const m = await modelo(ctx, { preco: 10 });
    await run(ctx.db,
      'UPDATE produtos SET preco_unidade = 3, permite_venda_unidade = 1, produto_fracionado = 1 WHERE id = ?', [m]);
    await saldo(ctx, 'REFRIGERANTE', 10000);
    const out = await simular(ctx);
    assert.equal(out.modoVendaModelos, 'PESO');
    const item = out.itensCompostos.find((i) => i.produtoId === m);
    assert.equal(item.precoUnitario, 10);
    assert.equal(item.quantidade, 4);
    for (const modo of ['UNIDADE', 'ETIQUETA_BALANCA', 'XYZ']) {
      await assert.rejects(simular(ctx, { modoVenda: modo }), (e) => e.code === 'MODO_VENDA_NAO_SUPORTADO');
    }
  });
});

test('arredondamento e reconciliação de centavos: soma das linhas cotadas = total da composição', async () => {
  await comContexto(async (ctx) => {
    const m = await modelo(ctx, { preco: 3.333333 });
    await saldo(ctx, 'REFRIGERANTE', 20000);
    const out = await simular(ctx);
    const item = out.itensCompostos.find((i) => i.produtoId === m);
    const esperado = Math.round(Motor.arredondarMoeda(Motor.arredondarInterno(3.333333 * item.quantidade)) * 100);
    assert.equal(item.subtotalCentavos, esperado);
    assert.equal(item.quantidade, 13);
    assert.equal(item.subtotalCentavos, 4333);
    const somaLinhas = out.itensFixos.reduce((s, i) => s + i.subtotalCentavos, 0)
      + out.itensCompostos.reduce((s, i) => s + i.subtotalCentavos, 0);
    assert.equal(out.valorComposicaoCentavos, somaLinhas);
    assert.equal(out.valorComercialOriginalCentavos - out.valorComposicaoCentavos, out.descontoAplicadoCentavos);
    const direta = await cotarPrecoProduto({
      db: ctx.db, empresaId: ctx.empresaId, produtoId: m, quantidade: item.quantidade, agora: REF
    });
    assert.equal(direta.subtotalCentavos, item.subtotalCentavos);
    assert.equal(direta.fingerprint, item.cotacaoFingerprint);
  });
});

test('itens fixos também usam a cotação (atacado no item do Pedido)', async () => {
  await comContexto(async (ctx) => {
    await run(ctx.db, 'UPDATE produtos SET venda_atacado = 1 WHERE id = ?', [ctx.pastel]);
    await run(ctx.db, 'INSERT INTO produto_atacado (produto_id, quantidade_minima, preco_atacado) VALUES (?, 2, 7)', [ctx.pastel]);
    await modelo(ctx, { preco: 10 });
    await saldo(ctx, 'REFRIGERANTE', 10000);
    const out = await simular(ctx);
    assert.equal(out.itensFixos[0].subtotalCentavos, 1400);
    assert.equal(out.valorResidualCentavos, 4798);
    assert.ok(out.itensFixos[0].regrasAplicadas.some((r) => r.tipo === 'ATACADO'));
  });
});

test('menor desconto comprovado: resultado coincide com força bruta usando a cotação real', async () => {
  await comContexto(async (ctx) => {
    const a = await modelo(ctx, { preco: 10, atacado: [[3, 7.5]] });
    const b = await modelo(ctx, { preco: 13, atacado: [[2, 11.9]] });
    await saldo(ctx, 'REFRIGERANTE', 6000);
    const out = await simular(ctx);

    let melhor = { total: -1, qa: 0, qb: 0 };
    const cot = async (id, q) => (q === 0 ? 0 : (await cotarPrecoProduto({
      db: ctx.db, empresaId: ctx.empresaId, produtoId: id, quantidade: q, agora: REF
    })).subtotalCentavos);
    for (let qa = 0; qa <= 6; qa += 1) {
      for (let qb = 0; qa + qb <= 6; qb += 1) {
        const total = (await cot(a, qa)) + (await cot(b, qb));
        if (total > 4400 || total === 0) continue;
        if (total > melhor.total) melhor = { total, qa, qb };
      }
    }
    // tie-break documentado: quantidades lexicograficamente maiores; a varredura acima só substitui em '>'.
    // Para empates, recalcula o lexicograficamente maior.
    for (let qa = 6; qa >= 0; qa -= 1) {
      for (let qb = 6 - qa; qb >= 0; qb -= 1) {
        const total = (await cot(a, qa)) + (await cot(b, qb));
        if (total === melhor.total) { melhor = { total, qa, qb }; qa = -1; break; }
      }
    }
    assert.equal(out.sucesso, true);
    assert.equal(out.otimalidadeComprovada, true);
    const qa = out.itensCompostos.find((i) => i.produtoId === a)?.quantidade || 0;
    const qb = out.itensCompostos.find((i) => i.produtoId === b)?.quantidade || 0;
    assert.equal(out.valorComposicaoCentavos - 1798, melhor.total);
    assert.deepEqual([qa, qb], [melhor.qa, melhor.qb]);
  });
});

test('desempate determinístico entre modelos com o mesmo subtotal', async () => {
  await comContexto(async (ctx) => {
    const a = await modelo(ctx, { preco: 21 });
    const b = await modelo(ctx, { preco: 21 });
    await saldo(ctx, 'REFRIGERANTE', 10000);
    const primeira = await simular(ctx);
    const segunda = await simular(ctx);
    assert.equal(primeira.valorComposicaoCentavos - 1798, 4200);
    assert.equal(primeira.itensCompostos.length, 1);
    assert.equal(primeira.itensCompostos[0].produtoId, Math.min(a, b));
    assert.equal(primeira.itensCompostos[0].quantidade, 2);
    assert.deepEqual(primeira.itensCompostos, segunda.itensCompostos);
    assert.equal(primeira.fingerprint, segunda.fingerprint);
  });
});

test('saldo fiscal e volume limitam a composição sob cotação por quantidade', async () => {
  await comContexto(async (ctx) => {
    const m = await modelo(ctx, { preco: 10, atacado: [[5, 6]] });
    await saldo(ctx, 'REFRIGERANTE', 3000);
    const out = await simular(ctx);
    const item = out.itensCompostos.find((i) => i.produtoId === m);
    assert.equal(item.quantidade, 3);
    assert.equal(item.subtotalCentavos, 3000);
    assert.equal(out.descontoAplicadoCentavos, 1400);
    assert.ok(out.capacidadeUsadaMlPorCategoria.REFRIGERANTE <= 3000);

    await run(ctx.db, 'UPDATE produtos SET volume_valor = 500 WHERE id = ?', [m]);
    const meioVolume = await simular(ctx);
    // q=4 -> 40,00; q=5 -> 30,00; q=6 -> 36,00 (faixa): a cotação não monotônica favorece q=4.
    assert.equal(meioVolume.itensCompostos.find((i) => i.produtoId === m).quantidade, 4);
    assert.equal(meioVolume.valorComposicaoCentavos - 1798, 4000);
    assert.notEqual(meioVolume.fingerprint, out.fingerprint);
  });
});

test('limite de busca: inconclusivo, candidato parcial inutilizável e sem afirmar inexistência', async () => {
  await comContexto(async (ctx) => {
    await run(ctx.db, 'UPDATE pedidos SET total = 61.99 WHERE id = ?', [ctx.pedidoId]);
    await run(ctx.db, 'UPDATE pedidos_itens SET subtotal = 18.01, preco_unitario = 18.01 WHERE pedido_id = ? AND produto_id = ?',
      [ctx.pedidoId, ctx.coca]);
    await modelo(ctx, { preco: 0.02, volumeMl: 1 });
    await modelo(ctx, { preco: 0.04, volumeMl: 1 });
    await saldo(ctx, 'REFRIGERANTE', 10000);
    const out = await simular(ctx);
    assert.equal(out.sucesso, false);
    assert.equal(out.status, 'INCONCLUSIVA');
    assert.equal(out.composicaoParcialUtilizavel, false);
    assert.equal(out.otimalidadeComprovada, false);
    assert.equal(out.codigo, 'COMPOSICAO_BUSCA_INCONCLUSIVA');
    assert.ok(out.estadosBusca <= out.limiteEstadosBusca);
    assert.equal(out.itensCompostos, undefined);
    assert.equal(out.efeitosOperacionais, false);
  });
});

test('sem composição válida continua explícito (não confundir com limite de busca)', async () => {
  await comContexto(async (ctx) => {
    await modelo(ctx, { preco: 50 });
    await saldo(ctx, 'REFRIGERANTE', 10000);
    await assert.rejects(simular(ctx), (e) => e.code === 'COMPOSICAO_FISCAL_INEXISTENTE');
  });
});

test('fingerprint é invalidado por promoção, faixa, preço-base, modo e data de referência', async () => {
  await comContexto(async (ctx) => {
    const m = await modelo(ctx, { preco: 10, atacado: [[5, 8]], promocao: { preco: 9, inicio: '2026-10-01', fim: '2026-11-01' } });
    await saldo(ctx, 'REFRIGERANTE', 10000);
    const base = (await simular(ctx)).fingerprint;
    assert.equal((await simular(ctx)).fingerprint, base);

    const mudancas = [
      ['preço da faixa', "UPDATE produto_atacado SET preco_atacado = 7.9 WHERE produto_id = ?"],
      ['quantidade mínima da faixa', "UPDATE produto_atacado SET quantidade_minima = 6 WHERE produto_id = ?"],
      ['promoção', "UPDATE promocoes SET preco_promocional = 9.1 WHERE produto_id = ?"],
      ['status da promoção', "UPDATE promocoes SET status = 'encerrada' WHERE produto_id = ?"],
      ['preço-base', "UPDATE produtos SET preco_venda = 10.5 WHERE id = ?"],
      ['flag de atacado', "UPDATE produtos SET venda_atacado = 0 WHERE id = ?"]
    ];
    let anterior = base;
    for (const [rotulo, sql] of mudancas) {
      await run(ctx.db, sql, [m]);
      const atual = (await simular(ctx)).fingerprint;
      assert.notEqual(atual, anterior, `fingerprint deveria mudar após: ${rotulo}`);
      anterior = atual;
    }
    await rejeitaDesatualizada(ctx, base);
  });
});

async function rejeitaDesatualizada(ctx, fingerprintAntigo) {
  await assert.rejects(simular(ctx, { fingerprintEsperado: fingerprintAntigo }), (e) => e.code === 'COMPOSICAO_DESATUALIZADA');
}

test('cache vive só na simulação: cotador não enxerga mudanças posteriores, novo cotador/simulação sim', async () => {
  await comContexto(async (ctx) => {
    const m = await modelo(ctx, { preco: 10 });
    await saldo(ctx, 'REFRIGERANTE', 10000);
    const cotador = await criarCotadorPreco({ db: ctx.db, empresaId: ctx.empresaId, produtoId: m, tipoVenda: 'PESO', agora: REF });
    const a = cotador.cotar(3);
    assert.equal(cotador.cotar(3), a, 'mesma quantidade reaproveita o cálculo local');
    assert.equal(cotador.consultasCotacao, 1);
    cotador.cotar(4);
    assert.equal(cotador.consultasCotacao, 2);

    const antes = await simular(ctx);
    await run(ctx.db, 'UPDATE produtos SET preco_venda = 11 WHERE id = ?', [m]);
    assert.equal(cotador.cotar(3).subtotalCentavos, 3000, 'snapshot da simulação em curso é consistente');
    const depois = await simular(ctx);
    assert.notEqual(depois.fingerprint, antes.fingerprint);
    assert.equal(depois.itensCompostos[0].precoUnitario, 11);
  });
});

test('isolamento: simulação não altera Pedido, schema nem dados operacionais', async () => {
  await comContexto(async (ctx) => {
    await modelo(ctx, { preco: 10, atacado: [[5, 6]], promocao: { preco: 9, inicio: '2026-10-01', fim: '2026-11-01' } });
    await saldo(ctx, 'REFRIGERANTE', 10000);
    const antes = await snapshotTotal(ctx.db);
    const out = await simular(ctx);
    assert.equal(out.sucesso, true);
    assert.equal(out.efeitosOperacionais, false);
    assert.equal(await snapshotTotal(ctx.db), antes);
  });
});

test('fonte: composição reutiliza a cotação e não copia regras de preço nem importa o banco padrão', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../backend/services/vendas/ComposicaoFiscalPedidoService.js'), 'utf8');
  assert.match(src, /require\('\.\/CotacaoPrecoProdutoService'\)/);
  assert.ok(!/FROM\s+promocoes|FROM\s+produto_atacado|p\.preco_venda/i.test(src));
  assert.ok(!/preco_atacado|preco_unidade|preco_promocional|quantidade_minima/.test(src));
  assert.ok(!/require\(['"][^'"]*\/database['"]\)/.test(src));
  assert.ok(!/\b(CREATE|ALTER|DROP)\s+TABLE|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM/i.test(src));
});
