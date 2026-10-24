'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaProdutoConversaoAsync } = require('../../backend/services/produtos/produtoConversaoSchema');
const { garantirSchemaCategoriaFiscalEmpresaAsync } = require('../../backend/services/vendas/categoriaFiscalEmpresaSchema');
const { garantirSchemaSaldoFiscalCategoriaAsync } = require('../../backend/services/vendas/saldoFiscalCategoriaSchema');
const { garantirSchemaReservaSaldoFiscalCategoriaAsync } = require('../../backend/services/vendas/reservaSaldoFiscalCategoriaSchema');
const CategoriaFiscalEmpresaService = require('../../backend/services/vendas/CategoriaFiscalEmpresaService');
const SaldoFiscalCategoriaService = require('../../backend/services/vendas/SaldoFiscalCategoriaService');
const ReservaSaldoFiscalCategoriaService = require('../../backend/services/vendas/ReservaSaldoFiscalCategoriaService');
const Composicao = require('../../backend/services/vendas/ComposicaoFiscalPedidoService');

function abrirDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function fecharDb(db) {
  return new Promise((resolve, reject) => db.close((err) => (err ? reject(err) : resolve())));
}

async function criarContexto() {
  const db = await abrirDb();
  try {
    await run(db, 'PRAGMA foreign_keys = ON');
    await garantirSchemaEmpresasAsync(db);
    await run(db, `CREATE TABLE produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT,
      nome TEXT NOT NULL,
      unidade TEXT,
      preco_venda REAL NOT NULL,
      ativo INTEGER DEFAULT 1,
      tipo_operacional TEXT DEFAULT 'COMERCIAL',
      utiliza_volume INTEGER DEFAULT 0,
      volume_valor REAL,
      volume_unidade TEXT,
      estoque_atual REAL DEFAULT 0,
      preco_unidade REAL,
      permite_venda_unidade INTEGER DEFAULT 0,
      produto_fracionado INTEGER DEFAULT 0,
      vendido_por_peso INTEGER DEFAULT 0,
      venda_atacado INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    await run(db, `CREATE TABLE promocoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, produto_id INTEGER, preco_original REAL,
      preco_promocional REAL, data_inicio DATE, data_fim DATE, status TEXT DEFAULT 'ativa'
    )`);
    await run(db, `CREATE TABLE produto_atacado (
      id INTEGER PRIMARY KEY AUTOINCREMENT, produto_id INTEGER, quantidade_minima INTEGER, preco_atacado REAL
    )`);
    await garantirSchemaProdutoConversaoAsync(db);
    await garantirSchemaCategoriaFiscalEmpresaAsync(db);
    await garantirSchemaSaldoFiscalCategoriaAsync(db);
    await garantirSchemaReservaSaldoFiscalCategoriaAsync(db);
    await run(db, 'CREATE TABLE clientes (id INTEGER PRIMARY KEY, nome TEXT)');
    await run(db, 'CREATE TABLE usuarios (id INTEGER PRIMARY KEY, username TEXT, nome TEXT)');
    await run(db, `CREATE TABLE pedidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT,
      data_pedido TEXT NOT NULL,
      cliente_id INTEGER,
      total REAL NOT NULL,
      desconto REAL DEFAULT 0,
      frete REAL DEFAULT 0,
      status TEXT NOT NULL,
      empresa_id INTEGER NOT NULL,
      venda_id INTEGER,
      operador_id INTEGER,
      representante_id INTEGER,
      representante_nome TEXT,
      observacao TEXT,
      created_at TEXT,
      updated_at TEXT
    )`);
    await run(db, `CREATE TABLE pedidos_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER NOT NULL,
      produto_id INTEGER NOT NULL,
      quantidade REAL NOT NULL,
      preco_unitario REAL NOT NULL,
      desconto_percentual REAL DEFAULT 0,
      subtotal REAL NOT NULL,
      tipo_venda TEXT DEFAULT 'UN',
      classificacao_operacional_snapshot TEXT,
      produto_codigo_snapshot TEXT,
      produto_nome_snapshot TEXT,
      produto_unidade_snapshot TEXT
    )`);
    const empresaId = (await EmpresaService.criarEmpresa(
      { cnpj: '11222333000181', razao_social: 'Empresa teste composição' },
      { db }
    )).id;
    const pastel = await criarProduto(db, {
      nome: 'Pastel do Chef', preco: 8.99, volume: null, unidade: 'UN'
    });
    const cocaOperacional = await criarProduto(db, {
      nome: 'Coca-Cola 2L operacional', preco: 18, volume: null, unidade: 'UN'
    });
    const pedidoId = await criarPedido(db, empresaId, [
      { produtoId: pastel, quantidade: 2, precoUnitario: 21.99, subtotal: 43.98 },
      { produtoId: cocaOperacional, quantidade: 1, precoUnitario: 18, subtotal: 18 }
    ]);
    return { db, empresaId, pedidoId, pastel, cocaOperacional };
  } catch (err) {
    await fecharDb(db);
    throw err;
  }
}

async function criarProduto(db, entrada) {
  const volume = entrada.volume || null;
  const result = await run(
    db,
    `INSERT INTO produtos
       (nome, unidade, preco_venda, ativo, tipo_operacional, utiliza_volume, volume_valor,
        volume_unidade, utiliza_conversao, unidade_estoque)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entrada.nome,
      entrada.unidade || 'UN',
      entrada.preco,
      entrada.ativo == null ? 1 : entrada.ativo,
      'COMERCIAL',
      volume ? 1 : 0,
      volume ? volume.valor : null,
      volume ? volume.unidade : null,
      entrada.utilizaConversao ? 1 : 0,
      entrada.utilizaConversao ? (entrada.unidadeEstoque || 'UN') : null
    ]
  );
  return result.lastID;
}

async function criarPedido(db, empresaId, itens, entrada = {}) {
  const itensCentavos = itens.reduce((sum, item) => sum + Math.round(item.subtotal * 100), 0);
  const desconto = entrada.desconto || 0;
  const frete = entrada.frete || 0;
  const total = entrada.total == null
    ? (itensCentavos - Math.round(desconto * 100) + Math.round(frete * 100)) / 100
    : entrada.total;
  const pedido = await run(
    db,
    `INSERT INTO pedidos (codigo, data_pedido, total, desconto, frete, status, empresa_id)
     VALUES (?, '2026-10-21', ?, ?, ?, ?, ?)`,
    [`PED-COMP-${Date.now()}-${Math.random()}`, total, desconto, frete, entrada.status || 'PEDIDO', empresaId]
  );
  for (const item of itens) {
    await run(
      db,
      `INSERT INTO pedidos_itens
         (pedido_id, produto_id, quantidade, preco_unitario, desconto_percentual, subtotal, tipo_venda)
       VALUES (?, ?, ?, ?, 0, ?, 'UN')`,
      [pedido.lastID, item.produtoId, item.quantidade, item.precoUnitario, item.subtotal]
    );
  }
  return pedido.lastID;
}

async function vincularModelo(db, empresaId, produtoId, categoria) {
  await CategoriaFiscalEmpresaService.definirVinculo({
    empresaId,
    produtoId,
    categoriaFiscal: categoria,
    elegivelComposicao: true
  }, { db });
}

async function abrirSaldo(db, empresaId, categoria, quantidadeMl) {
  await SaldoFiscalCategoriaService.garantirSaldo({ empresaId, categoriaFiscal: categoria }, { db });
  await SaldoFiscalCategoriaService.registrarAbertura({
    empresaId,
    categoriaFiscal: categoria,
    quantidadeMl,
    usuarioId: 1,
    motivo: 'Abertura sintética para teste isolado',
    referencia: { tipo: 'TESTE', id: `${empresaId}-${categoria}` },
    idempotencyKey: `abertura-${empresaId}-${categoria}`,
    confirmado: true
  }, { db });
}

async function adicionarModelo(ctx, entrada = {}) {
  const produtoId = await criarProduto(ctx.db, {
    nome: entrada.nome || `Modelo ${entrada.categoria}`,
    preco: entrada.preco,
    unidade: entrada.unidade || 'UN',
    volume: entrada.volume === null
      ? null
      : (entrada.volume || { valor: 1000, unidade: 'ML' }),
    ativo: entrada.ativo,
    tipo: entrada.tipo,
    utilizaConversao: entrada.utilizaConversao,
    unidadeEstoque: entrada.unidadeEstoque
  });
  await vincularModelo(ctx.db, ctx.empresaId, produtoId, entrada.categoria);
  if (entrada.tipo === 'INSUMO') {
    await run(ctx.db, "UPDATE produtos SET tipo_operacional = 'INSUMO' WHERE id = ?", [produtoId]);
  }
  if (entrada.relacaoMuc) {
    await run(
      ctx.db,
      `INSERT INTO muc_produto_relacoes (produto_id, unidade_origem, unidade_destino, fator)
       VALUES (?, ?, ?, ?)`,
      [produtoId, entrada.relacaoMuc.de, entrada.relacaoMuc.para, entrada.relacaoMuc.fator]
    );
  }
  return produtoId;
}

function itensFixosPastel(ctx) {
  return [{ produtoId: ctx.pastel, quantidade: 2 }];
}

async function abrirSaldoPadrao(ctx, categoria = 'REFRIGERANTE', quantidadeMl = 10000) {
  await abrirSaldo(ctx.db, ctx.empresaId, categoria, quantidadeMl);
}

async function rejeitaCodigo(promessa, codigo) {
  await assert.rejects(promessa, (err) => {
    assert.equal(err.code, codigo, `Esperado ${codigo}; recebido ${err.code}: ${err.message}`);
    return true;
  });
}

test('composição exata preserva o Pedido e calcula o residual do exemplo', async () => {
  const ctx = await criarContexto();
  try {
    await adicionarModelo(ctx, { categoria: 'REFRIGERANTE', preco: 22 });
    await abrirSaldoPadrao(ctx);
    const antes = await get(ctx.db, 'SELECT total, desconto, frete FROM pedidos WHERE id = ?', [ctx.pedidoId]);
    const out = await Composicao.simularComposicao({
      empresaId: ctx.empresaId,
      pedidoId: ctx.pedidoId,
      itensFixos: itensFixosPastel(ctx)
    }, { db: ctx.db });
    const depois = await get(ctx.db, 'SELECT total, desconto, frete FROM pedidos WHERE id = ?', [ctx.pedidoId]);

    assert.equal(out.valorComercialOriginalCentavos, 6198);
    assert.equal(out.valorItensFixosCentavos, 1798);
    assert.equal(out.valorResidualCentavos, 4400);
    assert.equal(out.valorComposicaoCentavos, 6198);
    assert.equal(out.descontoAplicadoCentavos, 0);
    assert.deepEqual(out.itensCompostos.map((item) => [item.quantidade, item.subtotalCentavos]), [[2, 4400]]);
    assert.deepEqual(depois, antes);
    assert.equal(out.efeitosOperacionais, false);
  } finally {
    await fecharDb(ctx.db);
  }
});

test('composição exata tem prioridade e não depende de política de desconto', async () => {
  const ctx = await criarContexto();
  try {
    await adicionarModelo(ctx, { categoria: 'REFRIGERANTE', preco: 22 });
    await abrirSaldoPadrao(ctx);
    const out = await Composicao.simularComposicao({
      empresaId: ctx.empresaId,
      pedidoId: ctx.pedidoId,
      itensFixos: itensFixosPastel(ctx)
    }, { db: ctx.db });
    assert.equal(out.descontoAplicadoCentavos, 0);
    assert.equal(out.criterioSelecao, 'COMPOSICAO_EXATA');
    assert.equal(out.otimalidadeComprovada, true);
    assert.equal(out.descontoRequerAprovacao, false);
    assert.equal(out.simulacaoAutorizaDesconto, false);
  } finally {
    await fecharDb(ctx.db);
  }
});

test('entre composições válidas escolhe a de menor desconto monetário', async () => {
  const ctx = await criarContexto();
  try {
    const modeloMaisBarato = await adicionarModelo(ctx, {
      categoria: 'REFRIGERANTE', preco: 14.5, volume: { valor: 1000, unidade: 'ML' }
    });
    const modeloMaisAjustado = await adicionarModelo(ctx, {
      categoria: 'REFRIGERANTE', preco: 21.99, volume: { valor: 1000, unidade: 'ML' }
    });
    await abrirSaldoPadrao(ctx, 'REFRIGERANTE', 3000);
    const out = await Composicao.simularComposicao({
      empresaId: ctx.empresaId,
      pedidoId: ctx.pedidoId,
      itensFixos: itensFixosPastel(ctx)
    }, { db: ctx.db });

    assert.deepEqual(out.itensCompostos.map((item) => [item.produtoId, item.quantidade]), [
      [modeloMaisAjustado, 2]
    ]);
    assert.equal(out.valorResidualCentavos, 4400);
    assert.equal(out.valorComposicaoCentavos, 6196);
    assert.equal(out.descontoAplicadoCentavos, 2);
    assert.equal(out.criterioSelecao, 'MENOR_DESCONTO_COMPROVADO');
    assert.equal(out.otimalidadeComprovada, true);
    assert.equal(out.descontoRequerAprovacao, true);
    assert.equal(out.simulacaoAutorizaDesconto, false);
    assert.notEqual(modeloMaisBarato, modeloMaisAjustado);
  } finally {
    await fecharDb(ctx.db);
  }
});

test('desempata composições de mesmo valor por produto_id ascendente', async () => {
  const ctx = await criarContexto();
  try {
    const primeiro = await adicionarModelo(ctx, {
      categoria: 'REFRIGERANTE', preco: 22, volume: { valor: 1000, unidade: 'ML' }
    });
    const segundo = await adicionarModelo(ctx, {
      categoria: 'REFRIGERANTE', preco: 22, volume: { valor: 1000, unidade: 'ML' }
    });
    await abrirSaldoPadrao(ctx, 'REFRIGERANTE', 5000);
    const out = await Composicao.simularComposicao({
      empresaId: ctx.empresaId,
      pedidoId: ctx.pedidoId,
      itensFixos: itensFixosPastel(ctx)
    }, { db: ctx.db });

    assert.deepEqual(out.itensCompostos.map((item) => [item.produtoId, item.quantidade]), [[primeiro, 2]]);
    assert.equal(out.criterioDesempate, Composicao.internos.CRITERIO_DESEMPATE);
    assert.ok(segundo > primeiro);
  } finally {
    await fecharDb(ctx.db);
  }
});

test('composição exata pode combinar modelos elegíveis de REFRIGERANTE e AGUA', async () => {
  const ctx = await criarContexto();
  try {
    const refri = await adicionarModelo(ctx, {
      categoria: 'REFRIGERANTE', preco: 25, volume: { valor: 500, unidade: 'ML' }
    });
    const agua = await adicionarModelo(ctx, {
      categoria: 'AGUA', preco: 19, volume: { valor: 500, unidade: 'ML' }
    });
    await abrirSaldo(ctx.db, ctx.empresaId, 'REFRIGERANTE', 1000);
    await abrirSaldo(ctx.db, ctx.empresaId, 'AGUA', 1000);
    const out = await Composicao.simularComposicao({
      empresaId: ctx.empresaId,
      pedidoId: ctx.pedidoId,
      itensFixos: itensFixosPastel(ctx),
      categoriasFiscais: ['AGUA', 'REFRIGERANTE']
    }, { db: ctx.db });
    assert.deepEqual(out.itensCompostos.map((item) => [item.produtoId, item.subtotalCentavos]), [
      [refri, 2500], [agua, 1900]
    ]);
    assert.equal(out.valorComposicaoCentavos, 6198);
  } finally {
    await fecharDb(ctx.db);
  }
});

test('retorna a melhor composição abaixo do residual sem política ou teto de desconto', async () => {
  const ctx = await criarContexto();
  try {
    await adicionarModelo(ctx, {
      categoria: 'REFRIGERANTE', preco: 14.5, volume: { valor: 1000, unidade: 'ML' }
    });
    await abrirSaldoPadrao(ctx, 'REFRIGERANTE', 3000);
    const out = await Composicao.simularComposicao({
      empresaId: ctx.empresaId,
      pedidoId: ctx.pedidoId,
      itensFixos: itensFixosPastel(ctx)
    }, { db: ctx.db });
    assert.equal(out.valorComposicaoCentavos, 6148);
    assert.equal(out.descontoAplicadoCentavos, 50);
    assert.equal(out.valorFinalCentavos, 6148);
    assert.equal(out.otimalidadeComprovada, true);
  } finally {
    await fecharDb(ctx.db);
  }
});

test('não transforma encontrar desconto em autorização implícita', async () => {
  const ctx = await criarContexto();
  try {
    await adicionarModelo(ctx, {
      categoria: 'REFRIGERANTE', preco: 1, volume: { valor: 1000, unidade: 'ML' }
    });
    await abrirSaldoPadrao(ctx, 'REFRIGERANTE', 2000);
    const out = await Composicao.simularComposicao({
      empresaId: ctx.empresaId,
      pedidoId: ctx.pedidoId,
      itensFixos: itensFixosPastel(ctx)
    }, { db: ctx.db });
    assert.equal(out.valorComposicaoCentavos, 1998);
    assert.equal(out.descontoAplicadoCentavos, 4200);
    assert.equal(out.descontoRequerAprovacao, true);
    assert.equal(out.simulacaoAutorizaDesconto, false);
    assert.equal(out.otimalidadeComprovada, true);
  } finally {
    await fecharDb(ctx.db);
  }
});

test('falha estruturadamente sem modelos fiscais elegíveis suficientes', async () => {
  const ctx = await criarContexto();
  try {
    await abrirSaldoPadrao(ctx);
    await rejeitaCodigo(Composicao.simularComposicao({
      empresaId: ctx.empresaId,
      pedidoId: ctx.pedidoId,
      itensFixos: itensFixosPastel(ctx)
    }, { db: ctx.db }), 'MODELOS_FISCAIS_INSUFICIENTES');
  } finally {
    await fecharDb(ctx.db);
  }
});

test('exclui produto inativo, insumo e modelo sem volume válido', async () => {
  const ctx = await criarContexto();
  try {
    await adicionarModelo(ctx, { categoria: 'REFRIGERANTE', preco: 22, ativo: 0 });
    await adicionarModelo(ctx, { categoria: 'AGUA', preco: 22, tipo: 'INSUMO' });
    await adicionarModelo(ctx, { categoria: 'REFRIGERANTE', preco: 22, volume: null });
    await abrirSaldoPadrao(ctx);
    await rejeitaCodigo(Composicao.simularComposicao({
      empresaId: ctx.empresaId,
      pedidoId: ctx.pedidoId,
      itensFixos: itensFixosPastel(ctx)
    }, { db: ctx.db }), 'MODELOS_FISCAIS_INSUFICIENTES');
  } finally {
    await fecharDb(ctx.db);
  }
});

test('recusa preço fiscal inválido e conversão MUC que resulta em mililitros fracionários', async () => {
  const ctx = await criarContexto();
  try {
    await adicionarModelo(ctx, { categoria: 'REFRIGERANTE', preco: -1 });
    await adicionarModelo(ctx, {
      categoria: 'AGUA',
      preco: 22,
      unidade: 'UN',
      volume: { valor: 1, unidade: 'CAIXA' },
      utilizaConversao: true,
      unidadeEstoque: 'ML',
      relacaoMuc: { de: 'CAIXA', para: 'ML', fator: 1000.5 }
    });
    await abrirSaldoPadrao(ctx);
    await rejeitaCodigo(Composicao.simularComposicao({
      empresaId: ctx.empresaId,
      pedidoId: ctx.pedidoId,
      itensFixos: itensFixosPastel(ctx),
      categoriasFiscais: ['AGUA', 'REFRIGERANTE']
    }, { db: ctx.db }), 'MODELOS_FISCAIS_INSUFICIENTES');
  } finally {
    await fecharDb(ctx.db);
  }
});

test('respeita saldo livre e credita somente a reserva ativa do próprio Pedido', async () => {
  const ctx = await criarContexto();
  try {
    await adicionarModelo(ctx, {
      categoria: 'REFRIGERANTE', preco: 22, volume: { valor: 1000, unidade: 'ML' }
    });
    await abrirSaldoPadrao(ctx, 'REFRIGERANTE', 5000);
    const outroPedido = await criarPedido(ctx.db, ctx.empresaId, [
      { produtoId: ctx.pastel, quantidade: 1, precoUnitario: 1, subtotal: 1 }
    ], { total: 1 });
    const reservaBase = {
      empresaId: ctx.empresaId,
      categoriaFiscal: 'REFRIGERANTE',
      usuarioId: 1,
      motivo: 'Reserva sintética para teste',
      referencia: { tipo: 'TESTE', id: 'reserva-composicao' }
    };
    await ReservaSaldoFiscalCategoriaService.reservar({
      ...reservaBase,
      pedidoId: outroPedido,
      quantidadeMl: 3000,
      idempotencyKey: 'reserva-outro-pedido'
    }, { db: ctx.db });
    await ReservaSaldoFiscalCategoriaService.reservar({
      ...reservaBase,
      pedidoId: ctx.pedidoId,
      quantidadeMl: 1000,
      idempotencyKey: 'reserva-pedido-composicao'
    }, { db: ctx.db });
    const out = await Composicao.simularComposicao({
      empresaId: ctx.empresaId,
      pedidoId: ctx.pedidoId,
      itensFixos: itensFixosPastel(ctx)
    }, { db: ctx.db });
    assert.equal(out.capacidadeFiscalPorCategoria.REFRIGERANTE.saldoAtualMl, 5000);
    assert.equal(out.capacidadeFiscalPorCategoria.REFRIGERANTE.saldoReservadoMl, 4000);
    assert.equal(out.capacidadeFiscalPorCategoria.REFRIGERANTE.saldoDisponivelMl, 1000);
    assert.equal(out.capacidadeFiscalPorCategoria.REFRIGERANTE.reservaDoPedidoMl, 1000);
    assert.equal(out.capacidadeFiscalPorCategoria.REFRIGERANTE.capacidadeMl, 2000);
    assert.equal(out.itensCompostos.reduce((sum, item) => sum + item.volumeTotalMl, 0), 2000);
  } finally {
    await fecharDb(ctx.db);
  }
});

test('bloqueia simulação quando as reservas ativas divergem do saldo reservado persistido', async () => {
  const ctx = await criarContexto();
  try {
    await adicionarModelo(ctx, {
      categoria: 'REFRIGERANTE', preco: 22, volume: { valor: 1000, unidade: 'ML' }
    });
    await abrirSaldoPadrao(ctx, 'REFRIGERANTE', 5000);
    await ReservaSaldoFiscalCategoriaService.reservar({
      empresaId: ctx.empresaId,
      categoriaFiscal: 'REFRIGERANTE',
      pedidoId: ctx.pedidoId,
      quantidadeMl: 1000,
      usuarioId: 1,
      motivo: 'Reserva sintética para teste',
      referencia: { tipo: 'TESTE', id: 'reserva-inconsistente' },
      idempotencyKey: 'reserva-inconsistente'
    }, { db: ctx.db });
    await run(
      ctx.db,
      `UPDATE saldo_fiscal_categoria_empresa
          SET saldo_reservado_ml = 500
        WHERE empresa_id = ? AND categoria_fiscal = 'REFRIGERANTE'`,
      [ctx.empresaId]
    );
    await rejeitaCodigo(Composicao.simularComposicao({
      empresaId: ctx.empresaId,
      pedidoId: ctx.pedidoId,
      itensFixos: itensFixosPastel(ctx)
    }, { db: ctx.db }), 'RESERVA_INCONSISTENTE');
  } finally {
    await fecharDb(ctx.db);
  }
});

test('saldo insuficiente não é contado como estoque físico nem reutilizado duas vezes', async () => {
  const ctx = await criarContexto();
  try {
    await adicionarModelo(ctx, {
      categoria: 'REFRIGERANTE', preco: 22, volume: { valor: 1000, unidade: 'ML' }
    });
    await abrirSaldoPadrao(ctx, 'REFRIGERANTE', 1000);
    const out = await Composicao.simularComposicao({
      empresaId: ctx.empresaId,
      pedidoId: ctx.pedidoId,
      itensFixos: itensFixosPastel(ctx)
    }, { db: ctx.db });
    assert.equal(out.valorComposicaoCentavos, 3998);
    assert.equal(out.descontoAplicadoCentavos, 2200);
    assert.equal(out.otimalidadeComprovada, true);
    const saldoFisico = await get(ctx.db, 'SELECT estoque_atual FROM produtos WHERE id = ?', [ctx.pastel]);
    assert.equal(saldoFisico.estoque_atual, 0);
  } finally {
    await fecharDb(ctx.db);
  }
});

test('retorna ausência de composição quando nenhum modelo cabe no saldo disponível', async () => {
  const ctx = await criarContexto();
  try {
    await adicionarModelo(ctx, {
      categoria: 'REFRIGERANTE', preco: 22, volume: { valor: 5000, unidade: 'ML' }
    });
    await abrirSaldoPadrao(ctx, 'REFRIGERANTE', 1000);
    await rejeitaCodigo(Composicao.simularComposicao({
      empresaId: ctx.empresaId,
      pedidoId: ctx.pedidoId,
      itensFixos: itensFixosPastel(ctx)
    }, { db: ctx.db }), 'COMPOSICAO_FISCAL_INEXISTENTE');
  } finally {
    await fecharDb(ctx.db);
  }
});

test('limite de estados retorna candidato parcial explicitamente inconclusivo e inutilizável', async () => {
  const ctx = await criarContexto();
  try {
    await criarPedido(ctx.db, ctx.empresaId, [], { total: 61.99 });
    const pedidoId = await get(
      ctx.db,
      'SELECT id FROM pedidos WHERE empresa_id = ? ORDER BY id DESC LIMIT 1',
      [ctx.empresaId]
    );
    const currentPedidoId = Number(pedidoId.id);
    await run(
      ctx.db,
      `INSERT INTO pedidos_itens
        (pedido_id, produto_id, quantidade, preco_unitario, desconto_percentual, subtotal, tipo_venda)
       VALUES (?, ?, 2, 21.99, 0, 43.98, 'UN')`,
      [currentPedidoId, ctx.pastel]
    );
    await run(
      ctx.db,
      `INSERT INTO pedidos_itens
        (pedido_id, produto_id, quantidade, preco_unitario, desconto_percentual, subtotal, tipo_venda)
       VALUES (?, ?, 1, 18.01, 0, 18.01, 'UN')`,
      [currentPedidoId, ctx.cocaOperacional]
    );
    const primeiro = await adicionarModelo(ctx, {
      categoria: 'REFRIGERANTE', preco: 0.02, volume: { valor: 1, unidade: 'ML' }
    });
    await adicionarModelo(ctx, {
      categoria: 'REFRIGERANTE', preco: 0.04, volume: { valor: 1, unidade: 'ML' }
    });
    await abrirSaldoPadrao(ctx, 'REFRIGERANTE', 10000);
    const out = await Composicao.simularComposicao({
      empresaId: ctx.empresaId,
      pedidoId: currentPedidoId,
      itensFixos: [{ produtoId: ctx.pastel, quantidade: 2 }]
    }, { db: ctx.db });

    assert.equal(out.sucesso, false);
    assert.equal(out.status, 'INCONCLUSIVA');
    assert.equal(out.codigo, 'COMPOSICAO_BUSCA_INCONCLUSIVA');
    assert.equal(out.valorResidualCentavos, 4401);
    assert.ok(out.valorComposicaoCentavos < 6199);
    assert.equal(out.otimalidadeComprovada, false);
    assert.equal(out.composicaoParcialUtilizavel, false);
    assert.ok(out.estadosBusca <= out.limiteEstadosBusca);
    assert.equal(out.efeitosOperacionais, false);
    assert.ok(primeiro > 0);
  } finally {
    await fecharDb(ctx.db);
  }
});

test('converte o volume comercial por meio do MUC existente', async () => {
  const ctx = await criarContexto();
  try {
    const produtoId = await adicionarModelo(ctx, {
      categoria: 'REFRIGERANTE',
      preco: 22,
      unidade: 'UN',
      volume: { valor: 1, unidade: 'L' },
      utilizaConversao: true,
      relacaoMuc: { de: 'L', para: 'ML', fator: 1000 }
    });
    await abrirSaldoPadrao(ctx);
    const out = await Composicao.simularComposicao({
      empresaId: ctx.empresaId,
      pedidoId: ctx.pedidoId,
      itensFixos: itensFixosPastel(ctx)
    }, { db: ctx.db });
    assert.equal(out.itensCompostos[0].produtoId, produtoId);
    assert.equal(out.itensCompostos[0].volumeMlPorUnidade, 1000);
    assert.equal(out.itensCompostos[0].volumeTotalMl, 2000);
  } finally {
    await fecharDb(ctx.db);
  }
});

test('exige empresa explícita e bloqueia Pedido pertencente a outra empresa', async () => {
  const ctx = await criarContexto();
  try {
    await rejeitaCodigo(Composicao.simularComposicao({
      pedidoId: ctx.pedidoId,
      itensFixos: itensFixosPastel(ctx)
    }, { db: ctx.db }), 'EMPRESA_OBRIGATORIA');
    const outraEmpresaId = (await EmpresaService.criarEmpresa(
      { cnpj: '04252011000110', razao_social: 'Outra empresa teste' },
      { db: ctx.db }
    )).id;
    await rejeitaCodigo(Composicao.simularComposicao({
      empresaId: outraEmpresaId,
      pedidoId: ctx.pedidoId,
      itensFixos: itensFixosPastel(ctx)
    }, { db: ctx.db }), 'PEDIDO_EMPRESA_DIVERGENTE');
  } finally {
    await fecharDb(ctx.db);
  }
});

test('modelos fiscais habilitados em outra empresa não entram na composição', async () => {
  const ctx = await criarContexto();
  try {
    const outraEmpresaId = (await EmpresaService.criarEmpresa(
      { cnpj: '04252011000110', razao_social: 'Outra empresa para modelos' },
      { db: ctx.db }
    )).id;
    const produtoId = await criarProduto(ctx.db, {
      nome: 'Modelo exclusivo de outra empresa',
      preco: 22,
      unidade: 'UN',
      volume: { valor: 1000, unidade: 'ML' }
    });
    await vincularModelo(ctx.db, outraEmpresaId, produtoId, 'REFRIGERANTE');
    await abrirSaldoPadrao(ctx, 'REFRIGERANTE', 10000);
    await rejeitaCodigo(Composicao.simularComposicao({
      empresaId: ctx.empresaId,
      pedidoId: ctx.pedidoId,
      itensFixos: itensFixosPastel(ctx)
    }, { db: ctx.db }), 'MODELOS_FISCAIS_INSUFICIENTES');
  } finally {
    await fecharDb(ctx.db);
  }
});

test('rejeita estados não elegíveis, frete e total inconsistente', async () => {
  const ctx = await criarContexto();
  try {
    const cancelado = await criarPedido(ctx.db, ctx.empresaId, [
      { produtoId: ctx.pastel, quantidade: 1, precoUnitario: 1, subtotal: 1 }
    ], { status: 'CANCELADO', total: 1 });
    await rejeitaCodigo(Composicao.simularComposicao({
      empresaId: ctx.empresaId, pedidoId: cancelado
    }, { db: ctx.db }), 'PEDIDO_STATUS_NAO_ELEGIVEL');
    const comFrete = await criarPedido(ctx.db, ctx.empresaId, [
      { produtoId: ctx.pastel, quantidade: 1, precoUnitario: 1, subtotal: 1 }
    ], { frete: 5 });
    await rejeitaCodigo(Composicao.simularComposicao({
      empresaId: ctx.empresaId, pedidoId: comFrete
    }, { db: ctx.db }), 'PEDIDO_COM_FRETE_NAO_SUPORTADO');
    const inconsistente = await criarPedido(ctx.db, ctx.empresaId, [
      { produtoId: ctx.pastel, quantidade: 1, precoUnitario: 1, subtotal: 1 }
    ], { total: 1.02 });
    await rejeitaCodigo(Composicao.simularComposicao({
      empresaId: ctx.empresaId, pedidoId: inconsistente
    }, { db: ctx.db }), 'PEDIDO_TOTAL_INCONSISTENTE');
  } finally {
    await fecharDb(ctx.db);
  }
});

test('valida quantidades fixas e impede preço ou produto arbitrários', async () => {
  const ctx = await criarContexto();
  try {
    await rejeitaCodigo(Composicao.simularComposicao({
      empresaId: ctx.empresaId,
      pedidoId: ctx.pedidoId,
      itensFixos: [{ produtoId: ctx.pastel, quantidade: 3, precoUnitario: 0.01 }]
    }, { db: ctx.db }), 'ITEM_FIXO_FORA_PEDIDO');
    await rejeitaCodigo(Composicao.simularComposicao({
      empresaId: ctx.empresaId,
      pedidoId: ctx.pedidoId,
      itensFixos: [{ produtoId: ctx.pastel, quantidade: 0.5 }]
    }, { db: ctx.db }), 'ITENS_FIXOS_INVALIDOS');
  } finally {
    await fecharDb(ctx.db);
  }
});

test('usa preços em centavos com arredondamento monetário consistente', () => {
  assert.equal(Composicao.internos.dinheiroEmCentavos(1.005, 'TESTE', 'preço'), 101);
  assert.equal(Composicao.internos.dinheiroEmCentavos(14.505, 'TESTE', 'preço'), 1451);
  assert.equal(Composicao.internos.dinheiroEmCentavos(9.994, 'TESTE', 'preço'), 999);
});

test('arredonda o subtotal da linha a centavos sem arredondar primeiro o preço unitário', async () => {
  const ctx = await criarContexto();
  try {
    const modeloId = await adicionarModelo(ctx, {
      categoria: 'REFRIGERANTE', preco: 21.995, volume: { valor: 1000, unidade: 'ML' }
    });
    await abrirSaldoPadrao(ctx, 'REFRIGERANTE', 3000);
    const out = await Composicao.simularComposicao({
      empresaId: ctx.empresaId,
      pedidoId: ctx.pedidoId,
      itensFixos: itensFixosPastel(ctx)
    }, { db: ctx.db });
    const item = out.itensCompostos.find((composto) => composto.produtoId === modeloId);

    assert.equal(item.quantidade, 2);
    assert.equal(item.precoUnitario, 21.995);
    assert.equal(item.subtotalCentavos, 4399);
    assert.equal(out.descontoAplicadoCentavos, 1);
    assert.equal(out.otimalidadeComprovada, true);
  } finally {
    await fecharDb(ctx.db);
  }
});

test('inclui preço de seis casas cujo subtotal unitário arredonda exatamente ao residual', async () => {
  const ctx = await criarContexto();
  try {
    const modeloId = await adicionarModelo(ctx, {
      categoria: 'REFRIGERANTE', preco: 44.004999, volume: { valor: 1000, unidade: 'ML' }
    });
    await abrirSaldoPadrao(ctx, 'REFRIGERANTE', 1000);
    const out = await Composicao.simularComposicao({
      empresaId: ctx.empresaId,
      pedidoId: ctx.pedidoId,
      itensFixos: itensFixosPastel(ctx)
    }, { db: ctx.db });
    const item = out.itensCompostos.find((composto) => composto.produtoId === modeloId);

    assert.equal(item.quantidade, 1);
    assert.equal(item.subtotalCentavos, 4400);
    assert.equal(out.valorResidualCentavos, 4400);
    assert.equal(out.descontoAplicadoCentavos, 0);
    assert.equal(out.otimalidadeComprovada, true);
  } finally {
    await fecharDb(ctx.db);
  }
});

test('resultado é determinístico e fingerprint cobre dados que influenciam a composição', async () => {
  const casos = [
    ['preço', async (ctx, modelo) => run(ctx.db, 'UPDATE produtos SET preco_venda = 23 WHERE id = ?', [modelo])],
    ['elegibilidade', async (ctx, modelo) => run(
      ctx.db,
      `UPDATE produto_categoria_fiscal_empresa SET elegivel_composicao = 0
        WHERE empresa_id = ? AND produto_id = ?`,
      [ctx.empresaId, modelo]
    )],
    ['volume', async (ctx, modelo) => run(ctx.db, 'UPDATE produtos SET volume_valor = 500 WHERE id = ?', [modelo])],
    ['regra MUC', async (ctx, modelo) => {
      await run(
        ctx.db,
        `UPDATE produtos
            SET utiliza_conversao = 1, unidade_estoque = 'ML',
                volume_valor = 1, volume_unidade = 'L'
          WHERE id = ?`,
        [modelo]
      );
      await run(
        ctx.db,
        `INSERT INTO muc_produto_relacoes (produto_id, unidade_origem, unidade_destino, fator)
         VALUES (?, 'L', 'ML', 1000)`,
        [modelo]
      );
    }],
    ['saldo', async (ctx, modelo) => run(
      ctx.db,
      `UPDATE saldo_fiscal_categoria_empresa SET saldo_atual_ml = 9000
        WHERE empresa_id = ? AND categoria_fiscal = 'REFRIGERANTE'`,
      [ctx.empresaId]
    )],
    ['Pedido', async (ctx) => run(ctx.db, 'UPDATE pedidos SET codigo = ? WHERE id = ?', ['PED-ALTERADO', ctx.pedidoId])],
    ['itens do Pedido', async (ctx) => {
      await run(
        ctx.db,
        `UPDATE pedidos_itens
            SET preco_unitario = 18.01, subtotal = 18.01
          WHERE pedido_id = ? AND produto_id = ?`,
        [ctx.pedidoId, ctx.cocaOperacional]
      );
      await run(ctx.db, 'UPDATE pedidos SET total = 61.99 WHERE id = ?', [ctx.pedidoId]);
    }],
    ['categorias de busca', async () => {}],
    ['reserva', async (ctx) => ReservaSaldoFiscalCategoriaService.reservar({
      empresaId: ctx.empresaId,
      categoriaFiscal: 'REFRIGERANTE',
      pedidoId: ctx.pedidoId,
      quantidadeMl: 1000,
      usuarioId: 1,
      motivo: 'Reserva para teste de fingerprint',
      referencia: { tipo: 'TESTE', id: 'fingerprint-reserva' },
      idempotencyKey: 'fingerprint-reserva'
    }, { db: ctx.db })]
  ];

  for (const [descricao, alterar] of casos) {
    const ctx = await criarContexto();
    try {
      const modelo = await adicionarModelo(ctx, {
        categoria: 'REFRIGERANTE', preco: 22, volume: { valor: 1000, unidade: 'ML' }
      });
      await abrirSaldoPadrao(ctx, 'REFRIGERANTE', 10000);
      const params = {
        empresaId: ctx.empresaId,
        pedidoId: ctx.pedidoId,
        itensFixos: itensFixosPastel(ctx)
      };
      const primeira = await Composicao.simularComposicao(params, { db: ctx.db });
      const repetida = await Composicao.simularComposicao(params, { db: ctx.db });
      assert.equal(primeira.fingerprint, repetida.fingerprint);
      assert.deepEqual(primeira.itensCompostos, repetida.itensCompostos);

      await alterar(ctx, modelo);
      await rejeitaCodigo(Composicao.simularComposicao({
        ...params,
        categoriasFiscais: descricao === 'categorias de busca' ? ['REFRIGERANTE'] : undefined,
        fingerprintEsperado: primeira.fingerprint
      }, { db: ctx.db }), 'COMPOSICAO_DESATUALIZADA');
    } finally {
      await fecharDb(ctx.db);
    }
  }
});

test('recusa fingerprint inválido e não confunde fingerprint com reserva de saldo', async () => {
  const ctx = await criarContexto();
  try {
    await adicionarModelo(ctx, { categoria: 'REFRIGERANTE', preco: 22 });
    await abrirSaldoPadrao(ctx);
    const params = {
      empresaId: ctx.empresaId,
      pedidoId: ctx.pedidoId,
      itensFixos: itensFixosPastel(ctx)
    };
    await rejeitaCodigo(Composicao.simularComposicao({
      ...params,
      fingerprintEsperado: 'not-a-real-fingerprint'
    }, { db: ctx.db }), 'COMPOSICAO_DESATUALIZADA');
  } finally {
    await fecharDb(ctx.db);
  }
});

test('a simulação não cria venda, baixa física, consumo de ficha, lançamento ou movimento', async () => {
  const ctx = await criarContexto();
  try {
    await adicionarModelo(ctx, { categoria: 'REFRIGERANTE', preco: 22 });
    await abrirSaldoPadrao(ctx);
    await run(ctx.db, 'CREATE TABLE vendas (id INTEGER PRIMARY KEY)');
    await run(ctx.db, 'CREATE TABLE venda_ficha_consumo (id INTEGER PRIMARY KEY)');
    await run(ctx.db, 'CREATE TABLE estoque_movimentos (id INTEGER PRIMARY KEY)');
    await run(ctx.db, 'CREATE TABLE ficha_tecnica_consumos (id INTEGER PRIMARY KEY)');
    await run(ctx.db, 'CREATE TABLE cobrancas (id INTEGER PRIMARY KEY)');
    await run(ctx.db, 'CREATE TABLE pagamentos (id INTEGER PRIMARY KEY)');
    await run(ctx.db, 'CREATE TABLE financeiro_lancamentos (id INTEGER PRIMARY KEY)');
    const antes = {
      pedido: await get(ctx.db, 'SELECT * FROM pedidos WHERE id = ?', [ctx.pedidoId]),
      produtos: await all(ctx.db, 'SELECT id, preco_venda, ativo, estoque_atual FROM produtos ORDER BY id'),
      movimentos: await all(ctx.db, 'SELECT * FROM saldo_fiscal_categoria_movimentos ORDER BY id'),
      reservas: await all(ctx.db, 'SELECT * FROM saldo_fiscal_categoria_reservas ORDER BY id'),
      schema: await all(
        ctx.db,
        `SELECT type, name, tbl_name, sql FROM sqlite_master
          WHERE name NOT LIKE 'sqlite_%'
          ORDER BY type, name`
      )
    };
    await Composicao.simularComposicao({
      empresaId: ctx.empresaId,
      pedidoId: ctx.pedidoId,
      itensFixos: itensFixosPastel(ctx)
    }, { db: ctx.db });
    assert.deepEqual(await all(ctx.db, 'SELECT * FROM vendas'), []);
    assert.deepEqual(await all(ctx.db, 'SELECT * FROM venda_ficha_consumo'), []);
    assert.deepEqual(await all(ctx.db, 'SELECT * FROM estoque_movimentos'), []);
    assert.deepEqual(await all(ctx.db, 'SELECT * FROM ficha_tecnica_consumos'), []);
    assert.deepEqual(await all(ctx.db, 'SELECT * FROM cobrancas'), []);
    assert.deepEqual(await all(ctx.db, 'SELECT * FROM pagamentos'), []);
    assert.deepEqual(await all(ctx.db, 'SELECT * FROM financeiro_lancamentos'), []);
    assert.deepEqual(await get(ctx.db, 'SELECT * FROM pedidos WHERE id = ?', [ctx.pedidoId]), antes.pedido);
    assert.deepEqual(
      await all(ctx.db, 'SELECT id, preco_venda, ativo, estoque_atual FROM produtos ORDER BY id'),
      antes.produtos
    );
    assert.deepEqual(
      await all(ctx.db, 'SELECT * FROM saldo_fiscal_categoria_movimentos ORDER BY id'),
      antes.movimentos
    );
    assert.deepEqual(
      await all(ctx.db, 'SELECT * FROM saldo_fiscal_categoria_reservas ORDER BY id'),
      antes.reservas
    );
    assert.deepEqual(
      await all(
        ctx.db,
        `SELECT type, name, tbl_name, sql FROM sqlite_master
          WHERE name NOT LIKE 'sqlite_%'
          ORDER BY type, name`
      ),
      antes.schema
    );
  } finally {
    await fecharDb(ctx.db);
  }
});
