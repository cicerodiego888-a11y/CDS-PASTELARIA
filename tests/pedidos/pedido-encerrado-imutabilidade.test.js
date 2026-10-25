'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();

const PedidoRepository = require('../../backend/services/pedido/PedidoRepository');
const PedidoOperacionalService = require('../../backend/services/pedido/PedidoOperacionalService');
const configService = require('../../backend/services/configuracaoService');

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function closeDb(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

async function criarSchema(db) {
  await run(db, `CREATE TABLE produtos (
    id INTEGER PRIMARY KEY,
    codigo TEXT,
    nome TEXT,
    nome_comercial TEXT,
    unidade TEXT,
    tipo_operacional TEXT DEFAULT 'COMERCIAL',
    preco_venda REAL DEFAULT 10,
    preco_pedido REAL,
    permite_personalizacao_ingredientes INTEGER DEFAULT 0,
    utiliza_ficha_tecnica INTEGER DEFAULT 0
  )`);
  await run(db, `CREATE TABLE pedidos (
    id INTEGER PRIMARY KEY,
    codigo TEXT,
    data_pedido TEXT,
    cliente_id INTEGER,
    total REAL DEFAULT 0,
    desconto REAL DEFAULT 0,
    frete REAL DEFAULT 0,
    status TEXT,
    representante_id INTEGER,
    representante_nome TEXT,
    observacao TEXT,
    operador_id INTEGER,
    venda_id INTEGER,
    empresa_id INTEGER,
    updated_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  await run(db, `CREATE TABLE pedidos_itens (
    id INTEGER PRIMARY KEY,
    pedido_id INTEGER NOT NULL,
    produto_id INTEGER NOT NULL,
    quantidade REAL NOT NULL,
    preco_unitario REAL NOT NULL,
    desconto_percentual REAL DEFAULT 0,
    subtotal REAL NOT NULL,
    tipo_venda TEXT DEFAULT 'PESO'
  )`);
  await run(db, 'CREATE TABLE clientes (id INTEGER PRIMARY KEY, nome TEXT)');
  await run(db, 'CREATE TABLE usuarios (id INTEGER PRIMARY KEY, username TEXT, nome TEXT)');
  await run(db, `CREATE TABLE vendas (
    id INTEGER PRIMARY KEY,
    empresa_id INTEGER NOT NULL,
    pedido_id INTEGER
  )`);
  await run(db, `CREATE TABLE pedido_estoque_consumo_finalizacoes (
    pedido_id INTEGER PRIMARY KEY,
    consumo_id INTEGER NOT NULL,
    venda_id INTEGER NOT NULL,
    empresa_id INTEGER NOT NULL
  )`);
  await run(db, `CREATE TABLE pedido_faturamento_operacoes (
    id INTEGER PRIMARY KEY,
    pedido_id INTEGER NOT NULL UNIQUE,
    empresa_id INTEGER NOT NULL,
    venda_id INTEGER,
    status TEXT NOT NULL,
    tipo_operacao TEXT NOT NULL DEFAULT 'PDV_COMPOSICAO'
  )`);
  await run(db, `INSERT INTO produtos (id, codigo, nome, unidade, preco_venda)
                  VALUES (1, 'P001', 'Produto de teste', 'UN', 10)`);
}

async function criarPedido(db, {
  id,
  status = 'ORCAMENTO',
  vendaId = null,
  item = true
}) {
  await run(
    db,
    `INSERT INTO pedidos (id, codigo, data_pedido, total, status, venda_id, empresa_id)
     VALUES (?, ?, '2026-10-25', 10, ?, ?, 1)`,
    [id, `PED-${id}`, status, vendaId]
  );
  if (item) {
    await run(
      db,
      `INSERT INTO pedidos_itens
         (id, pedido_id, produto_id, quantidade, preco_unitario, subtotal)
       VALUES (?, ?, 1, 1, 10, 10)`,
      [id * 10, id]
    );
  }
}

async function comConfigPedidos(callback) {
  const recursoHabilitadoOriginal = configService.recursoHabilitado;
  configService.recursoHabilitado = () => true;
  try {
    await callback();
  } finally {
    configService.recursoHabilitado = recursoHabilitadoOriginal;
  }
}

describe('Imutabilidade de pedidos encerrados', () => {
  it('permite atualizar um orçamento aberto', async () => {
    const db = await openDb();
    try {
      await criarSchema(db);
      await criarPedido(db, { id: 1 });
      await comConfigPedidos(async () => {
        const resultado = await PedidoOperacionalService.atualizar(1, {
          total: 20,
          desconto: 0,
          frete: 0,
          itens: [{
            id: 10,
            produto_id: 1,
            quantidade: 2,
            preco_unitario: 10,
            subtotal: 20
          }]
        }, { empresaId: 1, db });
        assert.equal(resultado.pedido.total, 20);
        assert.equal(resultado.pedido.itens[0].quantidade, 2);
      });
    } finally {
      await closeDb(db);
    }
  });

  it('recusa adição, alteração e remoção em pedido faturado com venda vinculada', async () => {
    const db = await openDb();
    try {
      await criarSchema(db);
      await criarPedido(db, { id: 2, status: 'FATURADO', vendaId: 22 });
      await criarPedido(db, { id: 9, status: 'FATURADO', vendaId: null, item: false });
      const corpos = [
        { itens: [{ id: 20, produto_id: 1, quantidade: 2, preco_unitario: 10, subtotal: 20 }] },
        { itens: [{ produto_id: 1, quantidade: 1, preco_unitario: 10, subtotal: 10 }] },
        { itens: [] }
      ];
      await comConfigPedidos(async () => {
        for (const body of corpos) {
          await assert.rejects(
            PedidoOperacionalService.atualizar(2, body, { empresaId: 1, db }),
            (err) => err.codigo === 'PEDIDO_IMUTAVEL' && err.statusCode === 409
          );
        }
        await assert.rejects(
          PedidoOperacionalService.excluir(2, { empresaId: 1, db }),
          (err) => err.codigo === 'PEDIDO_IMUTAVEL'
        );
        await assert.rejects(
          PedidoOperacionalService.atualizar(9, { itens: [] }, { empresaId: 1, db }),
          (err) => err.codigo === 'PEDIDO_IMUTAVEL'
        );
      });
    } finally {
      await closeDb(db);
    }
  });

  it('bloqueia estado intermediário com venda, finalização PDV ou consumo finalizado', async () => {
    const db = await openDb();
    try {
      await criarSchema(db);
      await criarPedido(db, { id: 3, status: 'PEDIDO', item: false });
      await criarPedido(db, { id: 4, status: 'PEDIDO', item: false });
      await criarPedido(db, { id: 5, status: 'PEDIDO', item: false });
      await run(db, 'INSERT INTO vendas (id, empresa_id, pedido_id) VALUES (33, 1, 3)');
      await run(
        db,
        `INSERT INTO pedido_faturamento_operacoes
           (id, pedido_id, empresa_id, venda_id, status)
         VALUES (44, 4, 1, 44, 'FINALIZADA')`
      );
      await run(
        db,
        `INSERT INTO pedido_estoque_consumo_finalizacoes
           (pedido_id, consumo_id, venda_id, empresa_id)
         VALUES (5, 55, 55, 1)`
      );
      await criarPedido(db, { id: 10, status: 'PEDIDO', item: false });
      await run(
        db,
        `INSERT INTO pedido_faturamento_operacoes
           (id, pedido_id, empresa_id, venda_id, status)
         VALUES (101, 10, 1, NULL, 'INICIADA')`
      );
      await comConfigPedidos(async () => {
        for (const id of [3, 4, 5]) {
          await assert.rejects(
            PedidoOperacionalService.atualizar(id, { itens: [] }, { empresaId: 1, db }),
            (err) => err.codigo === 'PEDIDO_IMUTAVEL'
          );
        }
      });
      const estadoEmAndamento = await PedidoRepository.obterEstadoEdicao({
        id: 10,
        status: 'PEDIDO',
        empresa_id: 1,
        venda_id: null
      }, { db });
      assert.equal(estadoEmAndamento.edicao_bloqueada, false);
    } finally {
      await closeDb(db);
    }
  });

  it('protege também as gravações diretas do repositório', async () => {
    const db = await openDb();
    try {
      await criarSchema(db);
      await criarPedido(db, { id: 6, status: 'PEDIDO', item: false });
      await run(
        db,
        `INSERT INTO pedido_estoque_consumo_finalizacoes
           (pedido_id, consumo_id, venda_id, empresa_id)
         VALUES (6, 66, 66, 1)`
      );
      await assert.rejects(
        PedidoRepository.substituirPedido({
          pedidoId: 6,
          clienteId: null,
          total: 10,
          desconto: 0,
          frete: 0,
          itens: [{ produto_id: 1, quantidade: 1, preco_unitario: 10, subtotal: 10 }],
          empresaId: 1,
          db
        }),
        (err) => err.codigo === 'PEDIDO_IMUTAVEL'
      );
      await assert.rejects(
        PedidoRepository.excluirOrcamento(6, { empresaId: 1, db }),
        (err) => err.codigo === 'PEDIDO_IMUTAVEL'
      );
      const pedido = await PedidoRepository.obterPorId(6, { db });
      assert.equal(pedido.itens.length, 0);
    } finally {
      await closeDb(db);
    }
  });

  it('mantém consulta de pedidos encerrados e informa o bloqueio à interface', async () => {
    const db = await openDb();
    try {
      await criarSchema(db);
      await criarPedido(db, { id: 7, status: 'PEDIDO' });
      await criarPedido(db, { id: 8, status: 'FATURADO', vendaId: 88 });
      await comConfigPedidos(async () => {
        const consulta = await PedidoOperacionalService.obter(8, { empresaId: 1, db });
        assert.equal(consulta.pedido.edicao_bloqueada, true);
        assert.equal(consulta.pedido.somente_consulta, true);
        assert.equal(consulta.pedido.itens.length, 1);

        const lista = await PedidoOperacionalService.listar({ empresaId: 1, db });
        const pedidoAberto = lista.itens.find((pedido) => pedido.id === 7);
        const pedidoFaturado = lista.itens.find((pedido) => pedido.id === 8);
        assert.equal(pedidoAberto.edicao_bloqueada, 0);
        assert.equal(pedidoFaturado.edicao_bloqueada, 1);
        assert.equal(pedidoFaturado.somente_consulta, 1);
      });

      const ui = fs.readFileSync(
        path.join(__dirname, '../../frontend/erp/js/pedidos.js'),
        'utf8'
      );
      assert.match(ui, /Este pedido já foi finalizado e faturado\. A edição está bloqueada\./);
      assert.match(ui, /pedidoEdicaoBloqueada/);
      assert.match(ui, /pedEditorBloqueioAviso/);
      assert.match(ui, /!somenteConsulta \? `<button class="btn btn-sm btn-outline-secondary ped-duplicar/);
    } finally {
      await closeDb(db);
    }
  });
});
