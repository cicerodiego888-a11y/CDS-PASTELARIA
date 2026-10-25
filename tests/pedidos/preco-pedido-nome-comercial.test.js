'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const vm = require('node:vm');
const sqlite3 = require('sqlite3').verbose();

const databasePath = require.resolve('../../backend/database');
const databaseStub = new Module(databasePath);
databaseStub.filename = databasePath;
databaseStub.loaded = true;
databaseStub.exports = {};
require.cache[databasePath] = databaseStub;
const repo = require('../../backend/services/pedido/PedidoRepository');
const { montarPayloadVendaDoPedido } = require('../../backend/services/faturamento/FaturamentoService');
const ROOT = path.join(__dirname, '..', '..');

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

async function setupDb() {
  const db = await openDb();
  await run(db, `CREATE TABLE produtos (
    id INTEGER PRIMARY KEY,
    codigo TEXT,
    nome TEXT,
    nome_comercial TEXT,
    unidade TEXT,
    tipo_operacional TEXT,
    preco_venda REAL,
    preco_pedido REAL
  )`);
  await run(db, `CREATE TABLE pedidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo TEXT,
    data_pedido TEXT,
    cliente_id INTEGER,
    total REAL,
    desconto REAL,
    frete REAL,
    status TEXT,
    representante_id INTEGER,
    representante_nome TEXT,
    observacao TEXT,
    operador_id INTEGER,
    empresa_id INTEGER,
    updated_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  await run(db, `CREATE TABLE pedidos_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pedido_id INTEGER NOT NULL,
    produto_id INTEGER NOT NULL,
    quantidade REAL NOT NULL,
    preco_unitario REAL NOT NULL,
    desconto_percentual REAL DEFAULT 0,
    subtotal REAL NOT NULL,
    tipo_venda TEXT DEFAULT 'PESO',
    classificacao_operacional_snapshot TEXT,
    produto_codigo_snapshot TEXT,
    produto_nome_snapshot TEXT,
    produto_nome_pedido_snapshot TEXT,
    produto_unidade_snapshot TEXT,
    preco_venda_snapshot REAL,
    preco_pedido_snapshot REAL,
    preco_sugerido_snapshot REAL,
    origem_preco_sugerido TEXT
  )`);
  await run(db, 'CREATE TABLE clientes (id INTEGER PRIMARY KEY, nome TEXT)');
  await run(db, 'CREATE TABLE usuarios (id INTEGER PRIMARY KEY, username TEXT, nome TEXT)');
  await run(db, `INSERT INTO produtos
    (id, codigo, nome, nome_comercial, unidade, tipo_operacional, preco_venda, preco_pedido)
    VALUES (1, 'P1', 'Principal Pastel', 'Pastel da Casa', 'UN', 'COMERCIAL', 17, 14.5),
           (2, 'P2', 'Nome Legado', NULL, 'UN', 'COMERCIAL', 12, NULL)`);
  return db;
}

function pedido(item, codigo, db) {
  return {
    db,
    codigo,
    dataPedido: '2026-10-22',
    clienteId: null,
    total: item.subtotal,
    desconto: 0,
    frete: 0,
    status: 'PEDIDO',
    empresaId: 1,
    itens: [item]
  };
}

describe('Pedido — nome de apresentação e preço unitário persistidos', () => {
  it('snapshota nome comercial, mantém nome principal fiscal e persiste total calculado', async () => {
    const db = await setupDb();
    try {
      const precoUnitario = 17;
      const quantidade = 3;
      const subtotal = Number((precoUnitario * quantidade).toFixed(2));
      const id = await repo.criarPedido(pedido({
        produto_id: 1,
        quantidade,
        preco_unitario: precoUnitario,
        desconto_percentual: 0,
        subtotal,
        preco_venda_snapshot: 17,
        preco_pedido_snapshot: 14.5,
        preco_sugerido_snapshot: 14.5,
        origem_preco_sugerido: 'PRECO_PEDIDO'
      }, 'PED-COMERCIAL', db));
      const carregado = await repo.obterPorId(id, { db });
      assert.equal(carregado.itens[0].produto_nome, 'Pastel da Casa');
      assert.equal(carregado.itens[0].produto_nome_fiscal, 'Principal Pastel');
      assert.equal(carregado.itens[0].produto_nome_snapshot, 'Principal Pastel');
      assert.equal(carregado.itens[0].produto_nome_pedido_snapshot, 'Pastel da Casa');
      assert.equal(Number(carregado.itens[0].preco_unitario), 17);
      assert.equal(Number(carregado.itens[0].quantidade), 3);
      assert.equal(Number(carregado.itens[0].subtotal), 51);
      assert.equal(Number(carregado.itens[0].preco_venda_snapshot), 17);
      assert.equal(Number(carregado.itens[0].preco_pedido_snapshot), 14.5);
      assert.equal(Number(carregado.itens[0].preco_sugerido_snapshot), 14.5);
      assert.equal(carregado.itens[0].origem_preco_sugerido, 'PRECO_PEDIDO');

      await run(db, `UPDATE produtos SET nome = 'Principal alterado', nome_comercial = 'Comercial alterado',
        preco_venda = 99, preco_pedido = 88 WHERE id = 1`);
      await repo.substituirPedido({
        pedidoId: id,
        clienteId: null,
        total: 51,
        desconto: 0,
        frete: 0,
        empresaId: 1,
        itens: [{
          id: carregado.itens[0].id,
          produto_id: 1,
          quantidade,
          preco_unitario: precoUnitario,
          desconto_percentual: 0,
          subtotal
        }],
        db
      });
      const reaberto = await repo.obterPorId(id, { db });
      assert.equal(reaberto.itens[0].produto_nome, 'Pastel da Casa');
      assert.equal(reaberto.itens[0].produto_nome_fiscal, 'Principal Pastel');
      assert.equal(Number(reaberto.itens[0].preco_unitario), 17);
      assert.equal(Number(reaberto.itens[0].subtotal), 51);
      assert.equal(Number(reaberto.itens[0].preco_venda_snapshot), 17);
      assert.equal(Number(reaberto.itens[0].preco_pedido_snapshot), 14.5);
      assert.equal(Number(reaberto.itens[0].preco_sugerido_snapshot), 14.5);
      assert.equal(reaberto.itens[0].origem_preco_sugerido, 'PRECO_PEDIDO');
    } finally {
      await new Promise((resolve, reject) => db.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it('usa o nome principal se o comercial estiver ausente e mantém preço zero como valor explícito', async () => {
    const db = await setupDb();
    try {
      const id = await repo.criarPedido(pedido({
        produto_id: 2,
        quantidade: 2,
        preco_unitario: 0,
        desconto_percentual: 0,
        subtotal: 0
      }, 'PED-LEGADO', db));
      const carregado = await repo.obterPorId(id, { db });
      assert.equal(carregado.itens[0].produto_nome, 'Nome Legado');
      assert.equal(carregado.itens[0].produto_nome_fiscal, 'Nome Legado');
      assert.equal(carregado.itens[0].produto_nome_pedido_snapshot, 'Nome Legado');
      assert.equal(Number(carregado.itens[0].preco_unitario), 0);
      assert.equal(Number(carregado.itens[0].subtotal), 0);
    } finally {
      await new Promise((resolve, reject) => db.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it('persiste sugestão zero sem substituir o preço que o operador escolheu', async () => {
    const db = await setupDb();
    try {
      const id = await repo.criarPedido(pedido({
        produto_id: 2,
        quantidade: 1,
        preco_unitario: 5,
        desconto_percentual: 0,
        subtotal: 5,
        preco_venda_snapshot: 12,
        preco_pedido_snapshot: 0,
        preco_sugerido_snapshot: 0,
        origem_preco_sugerido: 'PRECO_PEDIDO'
      }, 'PED-ZERO-CONFIGURADO', db));
      const carregado = await repo.obterPorId(id, { db });
      assert.equal(Number(carregado.itens[0].preco_pedido_snapshot), 0);
      assert.equal(Number(carregado.itens[0].preco_sugerido_snapshot), 0);
      assert.equal(Number(carregado.itens[0].preco_unitario), 5);
      assert.equal(carregado.itens[0].origem_preco_sugerido, 'PRECO_PEDIDO');
    } finally {
      await new Promise((resolve, reject) => db.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it('conversor Pedido→Venda usa o preço final salvo, não a sugestão congelada', () => {
    const payload = montarPayloadVendaDoPedido({
      id: 9,
      cliente_id: 2,
      total: 15,
      desconto: 0,
      itens: [{
        produto_id: 1,
        quantidade: 3,
        preco_unitario: 5,
        preco_pedido_snapshot: 14.5,
        preco_sugerido_snapshot: 14.5,
        subtotal: 15
      }]
    });
    assert.equal(payload.itens[0].preco_unitario, 5);
    assert.equal(Object.prototype.hasOwnProperty.call(payload.itens[0], 'preco_pedido_snapshot'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(payload.itens[0], 'preco_sugerido_snapshot'), false);
  });

  it('mantém pedidos antigos sem snapshot de apresentação legíveis e não afeta dados fiscais', async () => {
    const db = await setupDb();
    try {
      const pedidoInserido = await run(db, `INSERT INTO pedidos
        (codigo, data_pedido, total, desconto, frete, status, empresa_id)
        VALUES ('ANTIGO', '2025-01-01', 24, 0, 0, 'PEDIDO', 1)`);
      await run(db, `INSERT INTO pedidos_itens
        (pedido_id, produto_id, quantidade, preco_unitario, desconto_percentual, subtotal,
         produto_nome_snapshot, produto_nome_pedido_snapshot)
        VALUES (?, 2, 2, 12, 0, 24, 'Nome legado histórico', NULL)`,
      [pedidoInserido.lastID]);
      const carregado = await repo.obterPorId(pedidoInserido.lastID, { db });
      assert.equal(carregado.itens[0].produto_nome, 'Nome legado histórico');
      assert.equal(carregado.itens[0].produto_nome_fiscal, 'Nome legado histórico');
      assert.equal(Number(carregado.itens[0].preco_unitario), 12);
      assert.equal(Number(carregado.itens[0].subtotal), 24);
      assert.equal(carregado.itens[0].preco_venda_snapshot, null);
      assert.equal(carregado.itens[0].preco_pedido_snapshot, null);
      assert.equal(carregado.itens[0].preco_sugerido_snapshot, null);
      assert.equal(carregado.itens[0].origem_preco_sugerido, null);
      await repo.substituirPedido({
        pedidoId: pedidoInserido.lastID,
        clienteId: null,
        total: 24,
        desconto: 0,
        frete: 0,
        empresaId: 1,
        itens: [{
          id: carregado.itens[0].id,
          produto_id: 2,
          quantidade: 2,
          preco_unitario: 12,
          desconto_percentual: 0,
          subtotal: 24
        }],
        db
      });
      const reaberto = await repo.obterPorId(pedidoInserido.lastID, { db });
      assert.equal(reaberto.itens[0].preco_venda_snapshot, null);
      assert.equal(reaberto.itens[0].preco_pedido_snapshot, null);
      assert.equal(reaberto.itens[0].preco_sugerido_snapshot, null);
      assert.equal(reaberto.itens[0].origem_preco_sugerido, null);

      const ui = fs.readFileSync(path.join(ROOT, 'frontend/erp/js/pedidos.js'), 'utf8');
      assert.match(ui, /precoComercial != null/);
      assert.match(ui, /produto\.preco_pedido !== null/);
      assert.match(ui, /preco_sugerido_snapshot/);
      assert.match(ui, /origem_preco_sugerido/);
      assert.match(ui, /String\(produto\.nome_comercial \|\| ''\)\.trim\(\) \|\| produto\.nome/);
      assert.match(ui, /itensEditor\.map\(\(i\) => \(\{[\s\S]*preco_unitario: i\.preco_unitario,[\s\S]*subtotal: i\.subtotal/);
      const faturamento = fs.readFileSync(
        path.join(ROOT, 'backend/services/faturamento/CentralFaturamentoService.js'),
        'utf8'
      );
      assert.match(faturamento, /p\.nome AS produto_nome/);
      assert.doesNotMatch(faturamento, /nome_comercial|preco_pedido/);
      const xml = fs.readFileSync(path.join(ROOT, 'backend/services/fiscal/xmlBuilder.js'), 'utf8');
      assert.match(xml, /item\.produto_nome \|\| item\.nome \|\| 'desconhecido'/);
      assert.doesNotMatch(xml, /nome_comercial|preco_pedido/);
    } finally {
      await new Promise((resolve, reject) => db.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it('recalcula preço unitário e total do modal sem acumular adicionais', () => {
    const ui = fs.readFileSync(path.join(ROOT, 'frontend/erp/js/pedidos.js'), 'utf8');
    const contexto = { window: {} };
    vm.runInNewContext(ui, contexto);
    const calcular = contexto._pedCalcularTotaisPersonalizacao;
    const ingredientes = [
      { insumo_id: 10, classificacao_comercial: 'OBRIGATORIO_OCULTO', preco_adicional: 100 },
      { insumo_id: 11, classificacao_comercial: 'OPCIONAL', preco_adicional: 0 },
      { insumo_id: 12, classificacao_comercial: 'OPCIONAL_COM_ADICIONAL', preco_adicional: 3 }
    ];
    const calcularCom = (quantidade, selecionados) => calcular({
      precoBase: 21.99,
      quantidade,
      ingredientes,
      ingredientesSelecionados: selecionados,
      desconto: 0
    });

    assert.deepEqual(
      { ...calcularCom(1, []) },
      { precoAdicionais: 0, precoUnitario: 21.99, subtotal: 21.99 }
    );
    assert.deepEqual(
      { ...calcularCom(1, [12]) },
      { precoAdicionais: 3, precoUnitario: 24.99, subtotal: 24.99 }
    );
    assert.deepEqual(
      { ...calcularCom(1, []) },
      { precoAdicionais: 0, precoUnitario: 21.99, subtotal: 21.99 }
    );
    assert.deepEqual(
      { ...calcularCom(2, [11, 12]) },
      { precoAdicionais: 3, precoUnitario: 24.99, subtotal: 49.98 }
    );
    assert.match(ui, /id="pedPersonalizacaoPrecoUnitario"/);
    assert.match(ui, /id="pedPersonalizacaoTotalItem"/);
    assert.match(ui, /input\.pedpersonalizacao change\.pedpersonalizacao/);
  });

  it('considera equivalentes apenas linhas com a mesma configuração comercial e de ingredientes', () => {
    const ui = fs.readFileSync(path.join(ROOT, 'frontend/erp/js/pedidos.js'), 'utf8');
    const contexto = { window: {} };
    vm.runInNewContext(ui, contexto);
    const equivalente = contexto._pedPersonalizacaoEquivalente;
    const linha = {
      produto_id: 5,
      produto_nome: 'Pastel',
      produto_codigo: 'P5',
      preco_base_unitario_snapshot: 10,
      preco_adicionais_unitario_snapshot: 3,
      preco_unitario: 13,
      desconto_percentual: 0,
      tipo_venda: 'PESO',
      preco_venda_snapshot: 12,
      preco_pedido_snapshot: 10,
      preco_sugerido_snapshot: 10,
      origem_preco_sugerido: 'PRECO_PEDIDO',
      quantidade: 1,
      ingredientes_personalizados: [{
        insumo_id: 8,
        insumo_nome_snapshot: 'Carne de Sol',
        quantidade_snapshot: 1,
        unidade_snapshot: 'UN',
        classificacao_comercial_snapshot: 'OPCIONAL_COM_ADICIONAL',
        selecionado: 1,
        preco_adicional_snapshot: 3
      }]
    };

    assert.equal(equivalente(linha, { ...linha, quantidade: 4 }), true);
    assert.equal(equivalente(linha, {
      ...linha,
      ingredientes_personalizados: [{ ...linha.ingredientes_personalizados[0], selecionado: 0 }]
    }), false);
    assert.equal(equivalente(linha, { ...linha, desconto_percentual: 5 }), false);
    assert.equal(equivalente(linha, { ...linha, preco_base_unitario_snapshot: 11 }), false);
  });

  it('prioriza preco_pedido, preserva zero e usa a origem comercial somente quando NULL', () => {
    const ui = fs.readFileSync(path.join(ROOT, 'frontend/erp/js/pedidos.js'), 'utf8');
    const contexto = { window: {} };
    vm.runInNewContext(ui, contexto);
    const resolver = contexto._pedResolverPrecoSugerido;
    const buscarProdutos = ui.slice(
      ui.indexOf('function buscarProdutos'),
      ui.indexOf('function adicionarItem')
    );
    const aplicarProdutoSelecionado = ui.slice(
      ui.indexOf('async function aplicarProdutoSelecionado'),
      ui.indexOf('function aplicarClienteSelecionado')
    );

    assert.match(buscarProdutos, /_pedResolverPrecoSugerido\(p, precoComercial, origemPreco\)/);
    assert.match(buscarProdutos, /escapeHtml\(String\(p\.nome_comercial \|\| ''\)\.trim\(\) \|\| p\.nome\)/);
    assert.match(buscarProdutos, /data-id="\$\{p\.id\}"/);
    assert.match(buscarProdutos, /data-preco="\$\{preco\}"/);
    assert.match(aplicarProdutoSelecionado, /_pedResolverPrecoSugerido\(produto, precoComercial, origemPrecoComercial\)/);
    assert.match(aplicarProdutoSelecionado, /fetch\(`\$\{API_URL\}\/produtos\/\$\{id\}`/);
    assert.match(aplicarProdutoSelecionado, /\$\('#pedProdutoId'\)\.val\(id\)/);
    assert.match(aplicarProdutoSelecionado, /\$\('#pedItemPreco'\)\.val\(precoInicial\)/);
    assert.match(ui, /produto_id: i\.produto_id,[\s\S]*quantidade: i\.quantidade,[\s\S]*preco_unitario: i\.preco_unitario,[\s\S]*desconto_percentual: i\.desconto_percentual/);

    const configurado = resolver(
      { preco_venda: 17, preco_pedido: 14.5 },
      12,
      'PROMOCAO'
    );
    assert.equal(configurado.precoInicial, 14.5);
    assert.equal(configurado.snapshot.origem_preco_sugerido, 'PRECO_PEDIDO');
    assert.equal(
      resolver({ preco_venda: 17, preco_pedido: 14.5 }, 12, 'PROMOCAO').precoInicial,
      configurado.precoInicial,
      'a lista e o campo Valor usam a mesma sugestão configurada'
    );

    const zero = resolver({ preco_venda: 17, preco_pedido: 0 }, 12, 'PROMOCAO');
    assert.equal(zero.precoInicial, 0);
    assert.equal(zero.snapshot.preco_pedido_snapshot, 0);
    assert.equal(
      resolver({ preco_venda: 17, preco_pedido: 0 }, 12, 'PROMOCAO').precoInicial,
      zero.precoInicial,
      'a lista e o campo Valor preservam zero explícito'
    );

    const promocao = resolver(
      { preco_venda: 17, preco_pedido: null },
      11,
      'PROMOCAO'
    );
    assert.equal(promocao.precoInicial, 11);
    assert.equal(promocao.snapshot.origem_preco_sugerido, 'PROMOCAO');
    assert.equal(
      resolver({ preco_venda: 17, preco_pedido: null }, 11, 'PROMOCAO').precoInicial,
      promocao.precoInicial,
      'a lista e o campo Valor preservam promoção quando o preço do Pedido é NULL'
    );

    const comercial = resolver(
      { preco_venda: 17, preco_pedido: null },
      null,
      null
    );
    assert.equal(comercial.precoInicial, 17);
    assert.equal(comercial.snapshot.origem_preco_sugerido, 'PRECO_VENDA');
    assert.throws(
      () => resolver({ preco_venda: 17, preco_pedido: -1 }, 12, 'PRECO_VENDA'),
      /preço do Pedido inválido/i
    );
  });
});
