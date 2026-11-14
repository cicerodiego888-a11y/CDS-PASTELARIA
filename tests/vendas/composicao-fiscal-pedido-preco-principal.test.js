'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { prepararComposicaoPedidoPdv } = require('../../backend/services/vendas/PedidoPdvComposicaoService');
const { buildNfceXml } = require('../../backend/services/fiscal/xmlBuilder');

function abrirDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (err) => (err ? reject(err) : resolve()));
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function fecharDb(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

async function prepararDb() {
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
    created_at TEXT, updated_at TEXT
  )`);
  await run(db, `CREATE TABLE pedidos_itens (
    id INTEGER PRIMARY KEY, pedido_id INTEGER, produto_id INTEGER,
    quantidade REAL, preco_unitario REAL, subtotal REAL
  )`);
  await run(db, 'INSERT INTO empresas (id) VALUES (1)');
  await run(db, `INSERT INTO categorias (id, nome) VALUES (43, 'Pasteis'), (44, 'Refrigerantes')`);
  await run(db, `INSERT INTO produtos (
    id, categoria_id, nome, preco_venda, volume_valor, volume_unidade, unidade,
    utiliza_volume, controla_estoque
  ) VALUES
    (747, 43, 'Pastel do Cheff', 13.67, NULL, NULL, 'un', 0, 1),
    (748, 44, 'Refrigerante Copo 200 ml', 8.00, 200, 'ML', 'un', 1, 1),
    (749, 44, 'Refrigerante Copo 300 ml', 15.12, 300, 'ML', 'un', 1, 1)`);
  await run(db, `INSERT INTO estoque_empresa (
    produto_id, empresa_id, saldo_fiscal, saldo_nao_fiscal, estoque_atual
  ) VALUES
    (748, 1, 40, 10, 50),
    (749, 1, 30, 5, 35)`);
  await run(db, `INSERT INTO pedidos (
    id, codigo, empresa_id, status, total, desconto, frete, created_at
  ) VALUES (65, 'PED-65', 1, 'PEDIDO', 21.99, 0, 0, '2026-11-11')`);
  await run(db, `INSERT INTO pedidos_itens (
    id, pedido_id, produto_id, quantidade, preco_unitario, subtotal
  ) VALUES (1, 65, 747, 1, 21.99, 21.99)`);
  return db;
}

function itemPorProduto(composicao, produtoId) {
  return composicao.itens.find((item) => item.produto_id === produtoId);
}

function xmlDaComposicao(composicao) {
  return buildNfceXml({
    config: {
      codigoUf: '23',
      cnpj: '65957340000150',
      ie: '073252638',
      crt: 1,
      ambiente: 2,
      serie: 1,
      nomeEmpresa: 'PASTELARIA HOMOLOGACAO LTDA',
      logradouro: 'RUA A',
      numero: '100',
      bairro: 'CENTRO',
      codigo_municipio: '2307304',
      municipio: 'JUAZEIRO DO NORTE',
      uf: 'CE',
      cep: '63000000',
      telefone: '8835110000',
      csosn_padrao: '102'
    },
    venda: {
      total: composicao.valorFinalCentavos / 100,
      desconto: composicao.desconto,
      valor_fiscal: composicao.valorFinalCentavos / 100,
      forma_pagamento: 'pix',
      pagamentos: [{
        forma_pagamento: 'pix',
        valor: composicao.valorFinalCentavos / 100,
        tipo_recebimento: 'fiscal',
        status: 'aprovado'
      }]
    },
    itens: composicao.itens.map((item) => ({
      produto_id: item.produto_id,
      produto_nome: item.produto_id === 747 ? 'Pastel do Cheff' : 'Refrigerante',
      quantidade: item.quantidade,
      quantidade_fiscal: item.quantidade,
      quantidade_nao_fiscal: 0,
      preco_unitario: item.preco_unitario,
      valor_fiscal: item.subtotal,
      valor_nao_fiscal: 0,
      produto_ncm: '19059090',
      cfop: '5102',
      unidade: 'UN',
      origem: 0,
      csosn: '102'
    })),
    numero: 1
  });
}

test('preserva o preço comercial do pastel e escolhe 300 ml quando 200 ml não cobre o residual', async () => {
  const db = await prepararDb();
  try {
    const composicao = await prepararComposicaoPedidoPdv(
      { pedidoId: 65, empresaId: 1 },
      { db }
    );
    const pastel = itemPorProduto(composicao, 747);
    const copo200 = itemPorProduto(composicao, 748);
    const copo300 = itemPorProduto(composicao, 749);

    assert.equal(pastel.preco_unitario, 21.99);
    assert.equal(pastel.subtotal, 21.99);
    assert.equal(pastel.quantidade, 1);
    assert.equal(copo200, undefined);
    assert.equal(copo300.quantidade, 1);
    assert.equal(copo300.preco_unitario, 15.12);
    assert.equal(copo300.subtotal, 15.12);
    assert.equal(composicao.valorResidualCentavos, 832);
    assert.equal(composicao.descontoCentavos, 1512);
    assert.equal(composicao.valorFinalCentavos, 2199);
    assert.equal(composicao.valorCompostoBrutoCentavos, 3711);
    assert.equal(composicao.efeitosOperacionais, false);
    assert.notEqual(pastel.preco_unitario, 6.87);
    assert.notEqual(pastel.subtotal, 6.87);

    const estoque = await all(
      db,
      'SELECT produto_id, saldo_fiscal, saldo_nao_fiscal, estoque_atual FROM estoque_empresa ORDER BY produto_id'
    );
    assert.deepEqual(estoque, [
      { produto_id: 748, saldo_fiscal: 40, saldo_nao_fiscal: 10, estoque_atual: 50 },
      { produto_id: 749, saldo_fiscal: 30, saldo_nao_fiscal: 5, estoque_atual: 35 }
    ]);

    const xml = xmlDaComposicao(composicao);
    assert.equal(xml.valores.vNF, 21.99);
    assert.equal(xml.valores.vDesc, 15.12);
    assert.equal(xml.valores.vProd, 37.11);
    assert.match(xml.xmlSemAssinatura, /<vUnCom>21\.9900000000<\/vUnCom>/);
    assert.match(xml.xmlSemAssinatura, /<vProd>15\.12<\/vProd>/);
    assert.match(xml.xmlSemAssinatura, /<vDesc>15\.12<\/vDesc>/);
    assert.doesNotMatch(xml.xmlSemAssinatura, /6\.87/);
  } finally {
    await fecharDb(db);
  }
});

test('escolhe o copo de 200 ml quando ele fecha o residual e o de 300 ml fica de fora', async () => {
  const db = await prepararDb();
  try {
    await run(db, 'UPDATE produtos SET preco_venda = 8.32 WHERE id = 748');
    const composicao = await prepararComposicaoPedidoPdv(
      { pedidoId: 65, empresaId: 1 },
      { db }
    );
    assert.equal(itemPorProduto(composicao, 747).preco_unitario, 21.99);
    assert.equal(itemPorProduto(composicao, 748).quantidade, 1);
    assert.equal(itemPorProduto(composicao, 748).preco_unitario, 8.32);
    assert.equal(itemPorProduto(composicao, 749), undefined);
    assert.equal(composicao.descontoCentavos, 832);
    assert.equal(composicao.valorFinalCentavos, 2199);
  } finally {
    await fecharDb(db);
  }
});

test('componente mais barato que o residual entra na menor composição acima, sem reduzir o pastel', async () => {
  const db = await prepararDb();
  try {
    await run(db, 'UPDATE produtos SET ativo = 0 WHERE id = 749');
    await run(db, 'UPDATE produtos SET preco_venda = 5.00 WHERE id = 748');
    const composicao = await prepararComposicaoPedidoPdv(
      { pedidoId: 65, empresaId: 1 },
      { db }
    );
    const copo = itemPorProduto(composicao, 748);
    assert.equal(itemPorProduto(composicao, 747).preco_unitario, 21.99);
    assert.equal(copo.quantidade, 2);
    assert.equal(copo.preco_unitario, 5);
    assert.equal(composicao.valorFinalCentavos, 2199);
    assert.ok(composicao.descontoCentavos > 0);
  } finally {
    await fecharDb(db);
  }
});

test('componente mais caro que o produto principal permanece no preço de cadastro', async () => {
  const db = await prepararDb();
  try {
    await run(db, 'UPDATE produtos SET preco_venda = 25.00 WHERE id = 749');
    await run(db, 'UPDATE produtos SET ativo = 0 WHERE id = 748');
    const composicao = await prepararComposicaoPedidoPdv(
      { pedidoId: 65, empresaId: 1 },
      { db }
    );
    assert.equal(itemPorProduto(composicao, 747).preco_unitario, 21.99);
    assert.equal(itemPorProduto(composicao, 749).preco_unitario, 25);
    assert.equal(composicao.valorFinalCentavos, 2199);
    assert.equal(composicao.descontoCentavos, 2500);
  } finally {
    await fecharDb(db);
  }
});

test('fecha sem desconto quando o preço comercial do pastel é o de cadastro e o copo fecha o residual', async () => {
  const db = await prepararDb();
  try {
    await run(db, 'UPDATE produtos SET preco_venda = 13.67 WHERE id = 747');
    await run(db, 'UPDATE pedidos_itens SET preco_unitario = 13.67, subtotal = 13.67 WHERE id = 1');
    await run(db, `INSERT INTO pedidos_itens (
      id, pedido_id, produto_id, quantidade, preco_unitario, subtotal
    ) VALUES (2, 65, 748, 1, 8.32, 8.32)`);
    await run(db, 'UPDATE pedidos SET total = 21.99 WHERE id = 65');
    await run(db, 'UPDATE produtos SET preco_venda = 8.32 WHERE id = 748');
    const composicao = await prepararComposicaoPedidoPdv(
      { pedidoId: 65, empresaId: 1 },
      { db }
    );
    assert.equal(itemPorProduto(composicao, 747).preco_unitario, 13.67);
    assert.equal(itemPorProduto(composicao, 748).preco_unitario, 8.32);
    assert.equal(composicao.descontoCentavos, 0);
    assert.equal(composicao.valorFinalCentavos, 2199);
  } finally {
    await fecharDb(db);
  }
});

test('duas unidades preservam o subtotal comercial e não alteram o financeiro', async () => {
  const db = await prepararDb();
  try {
    await run(db, 'UPDATE pedidos_itens SET quantidade = 2, preco_unitario = 21.99, subtotal = 43.98 WHERE id = 1');
    await run(db, 'UPDATE pedidos SET total = 43.98 WHERE id = 65');
    const composicao = await prepararComposicaoPedidoPdv(
      { pedidoId: 65, empresaId: 1 },
      { db }
    );
    const pastel = itemPorProduto(composicao, 747);
    assert.equal(pastel.quantidade, 2);
    assert.equal(pastel.preco_unitario, 21.99);
    assert.equal(pastel.subtotal, 43.98);
    assert.equal(composicao.valorResidualCentavos, 1664);
    assert.equal(composicao.valorFinalCentavos, 4398);
    assert.equal(composicao.efeitosOperacionais, false);
  } finally {
    await fecharDb(db);
  }
});
