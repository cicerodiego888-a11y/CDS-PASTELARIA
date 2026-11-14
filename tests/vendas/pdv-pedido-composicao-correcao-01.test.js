'use strict';

/**
 * CDS-PDV-PEDIDO-COMPOSICAO-CORRECAO-01 (superseded by COMPOSICAO-PEDIDO-02)
 * Mantém apenas regressões compatíveis com a unificação residual.
 * Suite oficial da regra atual: pdv-composicao-pedido-02.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-composicao-correcao-01-'));
process.env.DB_DIR = dbDir;
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { prepararComposicaoPedidoPdv } = require('../../backend/services/vendas/PedidoPdvComposicaoService');
const { iniciarVendaPorValorPasteis } = require('../../backend/services/vendas/VendaPorValorPasteisService');

const OBS_VV = 'VENDA_POR_VALOR_PASTEIS';

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

function fecharDb(db) {
  return new Promise((resolve, reject) => db.close((err) => (err ? reject(err) : resolve())));
}

async function prepararCatalogo() {
  const db = await abrirDb();
  await run(db, 'CREATE TABLE empresas (id INTEGER PRIMARY KEY)');
  await run(db, `CREATE TABLE categorias (
    id INTEGER PRIMARY KEY, nome TEXT NOT NULL, tipo TEXT DEFAULT 'produto'
  )`);
  await run(db, `CREATE TABLE produtos (
    id INTEGER PRIMARY KEY, categoria_id INTEGER, nome TEXT, ativo INTEGER DEFAULT 1,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP, tipo_operacional TEXT DEFAULT 'COMERCIAL',
    utiliza_volume INTEGER DEFAULT 0, volume_valor REAL, volume_unidade TEXT, unidade TEXT,
    utiliza_conversao INTEGER DEFAULT 0, unidade_estoque TEXT, controla_estoque INTEGER DEFAULT 1,
    preco_venda REAL NOT NULL, preco_unidade REAL, permite_venda_unidade INTEGER DEFAULT 0,
    produto_fracionado INTEGER DEFAULT 0, vendido_por_peso INTEGER DEFAULT 0,
    venda_atacado INTEGER DEFAULT 0
  )`);
  await run(db, `CREATE TABLE promocoes (
    id INTEGER PRIMARY KEY, produto_id INTEGER, preco_original REAL, preco_promocional REAL,
    data_inicio TEXT, data_fim TEXT, status TEXT DEFAULT 'ativa'
  )`);
  await run(db, `CREATE TABLE produto_atacado (
    id INTEGER PRIMARY KEY, produto_id INTEGER, quantidade_minima INTEGER, preco_atacado REAL
  )`);
  await run(db, `CREATE TABLE estoque_empresa (
    id INTEGER PRIMARY KEY, produto_id INTEGER, empresa_id INTEGER,
    saldo_fiscal REAL DEFAULT 0, saldo_nao_fiscal REAL DEFAULT 0,
    estoque_atual REAL DEFAULT 0, reservado_fiscal REAL DEFAULT 0,
    reservado_nao_fiscal REAL DEFAULT 0
  )`);
  await run(db, `CREATE TABLE pedidos (
    id INTEGER PRIMARY KEY, codigo TEXT, cliente_id INTEGER, empresa_id INTEGER,
    status TEXT, total REAL, desconto REAL DEFAULT 0, frete REAL DEFAULT 0,
    observacao TEXT, created_at TEXT, updated_at TEXT
  )`);
  await run(db, `CREATE TABLE pedidos_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT, pedido_id INTEGER, produto_id INTEGER,
    quantidade REAL, preco_unitario REAL, subtotal REAL,
    personalizacao_ingredientes_snapshot INTEGER NOT NULL DEFAULT 0
  )`);
  await run(db, 'INSERT INTO empresas (id) VALUES (1)');
  await run(db, `INSERT INTO categorias (id, nome) VALUES
    (43, 'Pasteis'), (44, 'Refrigerantes'), (50, 'Outros')`);
  await run(db, `INSERT INTO produtos (
    id, categoria_id, nome, preco_venda, volume_valor, volume_unidade, unidade,
    utiliza_volume, controla_estoque
  ) VALUES
    (747, 43, 'Pastel do Cheff', 8.99, NULL, NULL, 'un', 0, 1),
    (748, 44, 'Refrigerante Copo 200ML', 12.99, 200, 'ML', 'ml', 1, 1),
    (749, 44, 'Refrigerante Copo 300 ml', 19.80, 300, 'ML', 'ml', 1, 1),
    (750, 44, 'Refrigerante Copo 500 ml', 32.99, 500, 'ML', 'un', 1, 1),
    (900, 50, 'Produto Simples', 5.50, NULL, NULL, 'un', 0, 1)`);
  await run(db, `INSERT INTO estoque_empresa (
    produto_id, empresa_id, saldo_fiscal, saldo_nao_fiscal, estoque_atual
  ) VALUES
    (748, 1, 100, 100, 200), (749, 1, 100, 100, 200), (750, 1, 100, 100, 200),
    (900, 1, 10, 10, 20)`);
  return db;
}

test('compat: pedido com pastel preserva total e quantidade via núcleo residual', async () => {
  const db = await prepararCatalogo();
  try {
    await run(db, `INSERT INTO pedidos (
      id, codigo, empresa_id, status, total, desconto, frete, created_at
    ) VALUES (1, 'PED-1', 1, 'PEDIDO', 61.98, 0, 0, '2026-01-01')`);
    await run(db, `INSERT INTO pedidos_itens (pedido_id, produto_id, quantidade, preco_unitario, subtotal)
      VALUES (1, 747, 2, 21.99, 43.98), (1, 748, 1, 18.00, 18.00)`);
    const c = await prepararComposicaoPedidoPdv({ pedidoId: 1, empresaId: 1 }, { db });
    assert.equal(c.modo, 'COMPOSICAO_PASTEL_REFRIGERANTE');
    assert.equal(c.valorFinalCentavos, 6198);
    assert.equal(c.itens.find((i) => i.produto_id === 747).quantidade, 2);
    assert.equal(c.itens.find((i) => i.produto_id === 747).preco_unitario, 8.99);
  } finally {
    await fecharDb(db);
  }
});

test('compat: produto simples sem pastel permanece identidade de catálogo', async () => {
  const db = await prepararCatalogo();
  try {
    await run(db, `INSERT INTO pedidos (
      id, codigo, empresa_id, status, total, desconto, frete, created_at
    ) VALUES (5, 'PED-5', 1, 'PEDIDO', 11.00, 0, 0, '2026-01-01')`);
    await run(db, `INSERT INTO pedidos_itens (pedido_id, produto_id, quantidade, preco_unitario, subtotal)
      VALUES (5, 900, 2, 5.50, 11.00)`);
    const c = await prepararComposicaoPedidoPdv({ pedidoId: 5, empresaId: 1 }, { db });
    assert.equal(c.modo, 'COMPOSICAO_IDENTIDADE_CATALOGO');
    assert.deepEqual(
      c.itens.map((i) => [i.produto_id, i.quantidade, Number(i.preco_unitario)]),
      [[900, 2, 5.5]]
    );
  } finally {
    await fecharDb(db);
  }
});

test('compat: regressão venda por valor residual', async () => {
  const db = await prepararCatalogo();
  try {
    await run(db, `INSERT INTO pedidos (
      id, codigo, empresa_id, status, total, desconto, frete, observacao, created_at
    ) VALUES (12, 'PED-12', 1, 'PEDIDO', 30.97, 0, 0, ?, '2026-01-01')`, [OBS_VV]);
    await run(db, `INSERT INTO pedidos_itens (pedido_id, produto_id, quantidade, preco_unitario, subtotal)
      VALUES (12, 747, 2, 15.485, 30.97)`);
    const c = await prepararComposicaoPedidoPdv({ pedidoId: 12, empresaId: 1 }, { db });
    assert.equal(c.modo, 'COMPOSICAO_PASTEL_REFRIGERANTE');
    assert.equal(c.valorFinalCentavos, 3097);
    assert.ok(c.itens.some((i) => i.produto_id === 747));
    assert.ok(c.itens.some((i) => i.produto_id !== 747));
    assert.ok(typeof iniciarVendaPorValorPasteis === 'function');
  } finally {
    await fecharDb(db);
  }
});
