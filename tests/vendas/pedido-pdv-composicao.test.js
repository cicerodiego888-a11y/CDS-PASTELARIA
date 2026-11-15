'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-pedido-pdv-composicao-'));
process.env.DB_DIR = dbDir;
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { prepararComposicaoPedidoPdv } = require('../../backend/services/vendas/PedidoPdvComposicaoService');
const { internos: ComposicaoInterna } = require('../../backend/services/vendas/ComposicaoFiscalPedidoService');

function modeloDeTeste(produtoId, precoCentavos, quantidadeMaxima = 10) {
  return {
    produtoId,
    categoriaFiscal: 'REFRIGERANTE',
    volumeMlPorUnidade: 1,
    quantidadeMaxima,
    cotador: {
      precoUnitarioMinimoInterno: precoCentavos / 100,
      cotar(quantidade) {
        return { subtotalCentavos: precoCentavos * quantidade };
      }
    }
  };
}

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

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function fecharDb(db) {
  return new Promise((resolve, reject) => db.close((err) => (err ? reject(err) : resolve())));
}

test('busca o menor excedente e comprova a otimalidade mesmo com valores empatados', () => {
  const modelos = [
    modeloDeTeste(1, 600, 3),
    modeloDeTeste(2, 600, 3),
    modeloDeTeste(3, 650, 3)
  ];
  const resultado = ComposicaoInterna.buscarComposicao(
    modelos,
    { REFRIGERANTE: 10 },
    1800,
    1001,
    undefined,
    { objetivo: 'MINIMO' }
  );

  assert.equal(resultado.otimalidadeComprovada, true);
  assert.equal(resultado.totalCentavos, 1200);
});

test('bloqueia resultado acima do alvo quando o limite de busca impede provar o mínimo', () => {
  const resultado = ComposicaoInterna.buscarComposicao(
    [modeloDeTeste(1, 600, 10)],
    { REFRIGERANTE: 10 },
    1800,
    1001,
    1,
    { objetivo: 'MINIMO' }
  );

  assert.equal(resultado.otimalidadeComprovada, false);
  assert.equal(resultado.limiteAtingido, true);
});

async function prepararBancoCenarioAtual() {
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
    venda_atacado INTEGER DEFAULT 0, saldo_fiscal REAL DEFAULT 0, saldo_nao_fiscal REAL DEFAULT 0,
    estoque_atual REAL DEFAULT 0, reservado_fiscal REAL DEFAULT 0, reservado_nao_fiscal REAL DEFAULT 0
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
    id INTEGER PRIMARY KEY, pedido_id INTEGER, produto_id INTEGER,
    quantidade REAL, preco_unitario REAL, subtotal REAL
  )`);
  await run(db, `INSERT INTO empresas (id) VALUES (1)`);
  await run(db, `INSERT INTO categorias (id, nome) VALUES
    (43, 'Pasteis'), (44, 'Refrigerantes'), (45, 'Água')`);
  await run(db, `INSERT INTO produtos (
    id, categoria_id, nome, preco_venda, volume_valor, volume_unidade, unidade,
    utiliza_volume, utiliza_conversao, controla_estoque
  ) VALUES
    (747, 43, 'Pastel do Cheff', 8.99, NULL, NULL, 'un', 0, 0, 1),
    (748, 44, 'Refrigerante Copo 200ML', 12.99, 200, 'ML', 'ml', 1, 0, 1),
    (749, 44, 'Refrigerante Copo 300 ml', 19.80, 300, 'ML', 'ml', 1, 0, 1),
    (750, 44, 'Refrigerante Copo 500 ml', 32.99, 500, 'ML', 'un', 1, 0, 1)`);
  await run(db, `INSERT INTO estoque_empresa (
    produto_id, empresa_id, saldo_fiscal, saldo_nao_fiscal, estoque_atual
  ) VALUES (748, 1, 100, 100, 200), (749, 1, 100, 100, 200), (750, 1, 100, 100, 200)`);
  await run(db, `INSERT INTO pedidos (
    id, codigo, cliente_id, empresa_id, status, total, desconto, frete, created_at
  ) VALUES (99, 'PED-99', NULL, 1, 'PEDIDO', 61.98, 0, 0, '2026-01-01')`);
  await run(db, `INSERT INTO pedidos_itens (
    id, pedido_id, produto_id, quantidade, preco_unitario, subtotal
  ) VALUES
    (1, 99, 747, 2, 21.99, 43.98),
    (2, 99, 748, 1, 18.00, 18.00)`);
  return db;
}

test('pedido comercial com pastel usa núcleo residual e preserva total/qtd', async () => {
  const db = await prepararBancoCenarioAtual();
  try {
    const composicao = await prepararComposicaoPedidoPdv(
      { pedidoId: 99, empresaId: 1 },
      { db }
    );
    assert.equal(composicao.modo, 'COMPOSICAO_PASTEL_REFRIGERANTE');
    assert.equal(composicao.valorOriginalCentavos, 6198);
    assert.equal(composicao.valorPastelCentavos, 1798);
    assert.equal(composicao.valorResidualCentavos, 4400);
    assert.equal(composicao.valorFinalCentavos, 6198);
    assert.equal(
      composicao.itens.find((item) => item.produto_id === 747).quantidade,
      2
    );
    assert.equal(
      composicao.itens.find((item) => item.produto_id === 747).preco_unitario,
      8.99
    );
    assert.ok(composicao.itens.some((item) => item.produto_id !== 747));
    assert.equal(
      composicao.valorCompostoBrutoCentavos - composicao.descontoCentavos,
      6198
    );
    const repetida = await prepararComposicaoPedidoPdv(
      { pedidoId: 99, empresaId: 1 },
      { db }
    );
    assert.equal(repetida.fingerprint, composicao.fingerprint);
    assert.deepEqual(
      await all(db, 'SELECT produto_id, estoque_atual FROM estoque_empresa ORDER BY produto_id'),
      [
        { produto_id: 748, estoque_atual: 200 },
        { produto_id: 749, estoque_atual: 200 },
        { produto_id: 750, estoque_atual: 200 }
      ]
    );
  } finally {
    await fecharDb(db);
  }
});

test('venda por valor mantém residual com desconto global explícito', async () => {
  const db = await prepararBancoCenarioAtual();
  try {
    await run(db, 'DELETE FROM pedidos_itens WHERE id = 2');
    await run(db, `UPDATE pedidos_itens
      SET preco_unitario = 30.99, subtotal = 61.98 WHERE id = 1`);
    await run(db, `UPDATE pedidos
      SET observacao = 'VENDA_POR_VALOR_PASTEIS', total = 61.98 WHERE id = 99`);
    const composicao = await prepararComposicaoPedidoPdv(
      { pedidoId: 99, empresaId: 1 },
      { db }
    );
    assert.equal(composicao.modo, 'COMPOSICAO_PASTEL_REFRIGERANTE');
    assert.equal(composicao.valorFinalCentavos, 6198);
    assert.ok(composicao.itens.some((item) => item.produto_id === 747));
    assert.ok(composicao.itens.some((item) => item.produto_id !== 747));
    assert.equal(
      composicao.itens.reduce((s, i) => s + Math.round(Number(i.subtotal) * 100), 0)
        - composicao.descontoCentavos,
      6198
    );
  } finally {
    await fecharDb(db);
  }
});

test('compõe exatamente pastéis e refrigerante quando residual fecha no catálogo', async () => {
  const db = await prepararBancoCenarioAtual();
  try {
    await run(db, 'UPDATE pedidos SET total = 30.97 WHERE id = 99');
    await run(db, `
      UPDATE pedidos_itens
      SET preco_unitario = 8.99, subtotal = 17.98
      WHERE id = 1
    `);
    await run(db, `
      UPDATE pedidos_itens
      SET preco_unitario = 12.99, subtotal = 12.99
      WHERE id = 2
    `);

    const composicao = await prepararComposicaoPedidoPdv(
      { pedidoId: 99, empresaId: 1 },
      { db }
    );

    assert.equal(composicao.modo, 'COMPOSICAO_PASTEL_REFRIGERANTE');
    assert.equal(composicao.valorOriginalCentavos, 3097);
    assert.equal(composicao.valorFinalCentavos, 3097);
    assert.equal(composicao.valorResidualCentavos, 1299);
    assert.equal(composicao.descontoCentavos, 0);
    assert.deepEqual(
      composicao.itens.map((item) => [
        item.produto_id,
        item.quantidade,
        item.preco_unitario,
        item.subtotal
      ]),
      [
        [747, 2, 8.99, 17.98],
        [748, 1, 12.99, 12.99]
      ]
    );
    const repetida = await prepararComposicaoPedidoPdv(
      { pedidoId: 99, empresaId: 1 },
      { db }
    );
    assert.equal(repetida.fingerprint, composicao.fingerprint);
    assert.equal(repetida.efeitosOperacionais, false);
    assert.deepEqual(
      await all(db, 'SELECT produto_id, estoque_atual FROM estoque_empresa ORDER BY produto_id'),
      [
        { produto_id: 748, estoque_atual: 200 },
        { produto_id: 749, estoque_atual: 200 },
        { produto_id: 750, estoque_atual: 200 }
      ]
    );
  } finally {
    await fecharDb(db);
  }
});

test('usa o preço vigente do cadastro de pastel em cada preparação', async () => {
  const db = await prepararBancoCenarioAtual();
  try {
    const original = await prepararComposicaoPedidoPdv(
      { pedidoId: 99, empresaId: 1 },
      { db }
    );
    await run(db, 'UPDATE produtos SET preco_venda = 9.50 WHERE id = 747');
    const atualizado = await prepararComposicaoPedidoPdv(
      { pedidoId: 99, empresaId: 1 },
      { db }
    );

    assert.equal(original.itens.find((item) => item.produto_id === 747).preco_unitario, 8.99);
    assert.equal(atualizado.itens.find((item) => item.produto_id === 747).preco_unitario, 9.5);
    assert.equal(original.valorResidualCentavos, 4400);
    assert.equal(atualizado.valorPastelCentavos, 1900);
    assert.equal(atualizado.valorResidualCentavos, 4298);
    assert.equal(atualizado.valorFinalCentavos, 6198);
    assert.equal(original.valorFinalCentavos, 6198);
    assert.notEqual(atualizado.fingerprint, original.fingerprint);
  } finally {
    await fecharDb(db);
  }
});

test('motor seleciona refrigerantes elegíveis dinamicamente para o residual', async () => {
  const db = await prepararBancoCenarioAtual();
  try {
    await run(db, `CREATE TABLE muc_produto_relacoes (
      id INTEGER PRIMARY KEY, produto_id INTEGER, unidade_origem TEXT,
      unidade_destino TEXT, fator REAL
    )`);
    await run(db, `INSERT INTO produtos (
      id, categoria_id, nome, preco_venda, volume_valor, volume_unidade, unidade,
      utiliza_volume, utiliza_conversao, unidade_estoque, controla_estoque
    ) VALUES (751, 44, 'Refrigerante elegível', 12.99, 0.2, 'L', 'un', 1, 1, 'un', 1)`);
    await run(db, `INSERT INTO muc_produto_relacoes (
      produto_id, unidade_origem, unidade_destino, fator
    ) VALUES (751, 'L', 'ML', 1000)`);
    await run(db, `INSERT INTO estoque_empresa (
      produto_id, empresa_id, saldo_fiscal, saldo_nao_fiscal, estoque_atual
    ) VALUES (751, 1, 100, 0, 100)`);
    await run(db, `
      UPDATE pedidos_itens
      SET preco_unitario = 8.99, subtotal = 17.98
      WHERE id = 1
    `);
    await run(db, `
      UPDATE pedidos_itens
      SET produto_id = 751, preco_unitario = 12.99, subtotal = 12.99
      WHERE id = 2
    `);
    await run(db, 'UPDATE pedidos SET total = 30.97 WHERE id = 99');

    const composicao = await prepararComposicaoPedidoPdv(
      { pedidoId: 99, empresaId: 1 },
      { db }
    );

    assert.equal(composicao.modo, 'COMPOSICAO_PASTEL_REFRIGERANTE');
    assert.equal(composicao.valorFinalCentavos, 3097);
    assert.equal(composicao.valorResidualCentavos, 1299);
    assert.equal(composicao.itens.find((item) => item.produto_id === 747).quantidade, 2);
    assert.ok(composicao.itens.some((item) => [748, 749, 750, 751].includes(item.produto_id)));
  } finally {
    await fecharDb(db);
  }
});

test('aceita composição residual com volumes de 300 ml e 500 ml', async () => {
  const db = await prepararBancoCenarioAtual();
  try {
    for (const caso of [
      { produtoId: 749, preco: 19.80, total: 37.78 },
      { produtoId: 750, preco: 32.99, total: 50.97 }
    ]) {
      await run(db, 'UPDATE pedidos SET total = ? WHERE id = 99', [caso.total]);
      await run(db, 'UPDATE pedidos_itens SET preco_unitario = 8.99, subtotal = 17.98 WHERE id = 1');
      await run(db, `UPDATE pedidos_itens
        SET produto_id = ?, preco_unitario = ?, subtotal = ?
        WHERE id = 2`, [caso.produtoId, caso.preco, caso.preco]);
      // Isola o volume alvo para provar elegibilidade daquele modelo.
      await run(db, 'UPDATE produtos SET ativo = 0 WHERE id IN (748, 749, 750) AND id != ?', [caso.produtoId]);
      await run(db, 'UPDATE produtos SET ativo = 1 WHERE id = ?', [caso.produtoId]);

      const composicao = await prepararComposicaoPedidoPdv(
        { pedidoId: 99, empresaId: 1 },
        { db }
      );
      assert.deepEqual(
        composicao.itens.map((item) => item.produto_id),
        [747, caso.produtoId]
      );
      assert.equal(composicao.descontoCentavos, 0);
      assert.equal(composicao.modo, 'COMPOSICAO_PASTEL_REFRIGERANTE');
      assert.equal(composicao.valorFinalCentavos, Math.round(caso.total * 100));
    }
  } finally {
    await fecharDb(db);
  }
});

test('volume MUC novo (ex.: 100 ml) entra sozinho sem allowlist fixa', async () => {
  const db = await prepararBancoCenarioAtual();
  try {
    await run(db, `INSERT INTO produtos (
      id, categoria_id, nome, preco_venda, volume_valor, volume_unidade, unidade,
      utiliza_volume, utiliza_conversao, controla_estoque, ativo
    ) VALUES (753, 44, 'Refrigerante Copo 100 ml', 6.50, 100, 'ML', 'ml', 1, 0, 1, 1)`);
    await run(db, `INSERT INTO estoque_empresa (
      produto_id, empresa_id, saldo_fiscal, saldo_nao_fiscal, estoque_atual
    ) VALUES (753, 1, 100, 100, 200)`);
    await run(db, 'DELETE FROM pedidos_itens');
    await run(db, `INSERT INTO pedidos_itens (
      id, pedido_id, produto_id, quantidade, preco_unitario, subtotal
    ) VALUES (11, 99, 749, 1, 6.50, 6.50)`);
    await run(db, 'UPDATE pedidos SET total = 6.50 WHERE id = 99');

    const composicao = await prepararComposicaoPedidoPdv(
      { pedidoId: 99, empresaId: 1 },
      { db }
    );

    assert.equal(composicao.modo, 'COMPOSICAO_PASTEL_REFRIGERANTE');
    assert.equal(composicao.valorFinalCentavos, 650);
    assert.deepEqual(
      composicao.itens.map((item) => [
        item.produto_id,
        item.quantidade,
        item.preco_unitario,
        item.subtotal
      ]),
      [[753, 1, 6.5, 6.5]]
    );
  } finally {
    await fecharDb(db);
  }
});

test('venda por valor respeita disponibilidade empresarial ao procurar residual', async () => {
  const db = await prepararBancoCenarioAtual();
  try {
    await run(db, 'DELETE FROM pedidos_itens WHERE id = 2');
    await run(db, `UPDATE pedidos_itens
      SET preco_unitario = 15.485, subtotal = 30.97 WHERE id = 1`);
    await run(db, `UPDATE pedidos
      SET observacao = 'VENDA_POR_VALOR_PASTEIS', total = 30.97 WHERE id = 99`);
    await run(db, `
      UPDATE estoque_empresa
      SET saldo_fiscal = 0, saldo_nao_fiscal = 0, estoque_atual = 0
      WHERE produto_id = 748 AND empresa_id = 1
    `);

    const composicao = await prepararComposicaoPedidoPdv(
      { pedidoId: 99, empresaId: 1 },
      { db }
    );
    assert.ok(composicao.itens.some((item) => item.produto_id === 747));
    assert.ok(composicao.itens.some((item) => item.produto_id === 749));
    assert.ok(!composicao.itens.some((item) => item.produto_id === 748));
    assert.equal(composicao.valorFinalCentavos, 3097);
  } finally {
    await fecharDb(db);
  }
});

test('venda por valor bloqueia quando não existe composição válida acima do residual', async () => {
  const db = await prepararBancoCenarioAtual();
  try {
    await run(db, `UPDATE pedidos SET observacao = 'VENDA_POR_VALOR_PASTEIS' WHERE id = 99`);
    await run(db, 'UPDATE produtos SET preco_venda = 3.00 WHERE id = 748');
    await run(db, `UPDATE estoque_empresa
      SET saldo_fiscal = 1, saldo_nao_fiscal = 0, estoque_atual = 1,
          reservado_fiscal = 0, reservado_nao_fiscal = 0
      WHERE produto_id = 748`);
    await run(db, 'UPDATE produtos SET ativo = 0 WHERE id IN (749, 750)');
    await run(db, 'UPDATE pedidos SET total = 21.98 WHERE id = 99');
    await run(db, 'UPDATE pedidos_itens SET preco_unitario = 8.99, subtotal = 17.98 WHERE id = 1');
    await run(db, 'UPDATE pedidos_itens SET preco_unitario = 4.00, subtotal = 4.00 WHERE id = 2');

    await assert.rejects(
      prepararComposicaoPedidoPdv({ pedidoId: 99, empresaId: 1 }, { db }),
      (err) => {
        assert.equal(err.code, 'COMPOSICAO_PDV_SEM_COBERTURA');
        assert.equal(err.detalhes.residual_centavos, 400);
        return true;
      }
    );
  } finally {
    await fecharDb(db);
  }
});

test('arredonda a cotação para centavos e conserva igualdade do total', async () => {
  const db = await prepararBancoCenarioAtual();
  try {
    await run(db, 'UPDATE produtos SET preco_venda = 12.995 WHERE id = 748');
    await run(db, 'UPDATE produtos SET ativo = 0 WHERE id IN (749, 750)');
    await run(db, 'UPDATE pedidos SET total = 30.98 WHERE id = 99');
    await run(db, `
      UPDATE pedidos_itens SET preco_unitario = 8.99, subtotal = 17.98 WHERE id = 1
    `);
    await run(db, `
      UPDATE pedidos_itens SET preco_unitario = 13.00, subtotal = 13.00 WHERE id = 2
    `);

    const composicao = await prepararComposicaoPedidoPdv(
      { pedidoId: 99, empresaId: 1 },
      { db }
    );
    assert.equal(composicao.modo, 'COMPOSICAO_PASTEL_REFRIGERANTE');
    assert.equal(composicao.valorFinalCentavos, 3098);
    assert.deepEqual(
      composicao.itens.map((item) => [item.produto_id, item.preco_unitario, item.subtotal]),
      [[747, 8.99, 17.98], [748, 12.995, 13]]
    );
  } finally {
    await fecharDb(db);
  }
});

test('preserva o preço unitário cadastrado com fração de centavo ao arredondar o subtotal', async () => {
  const db = await prepararBancoCenarioAtual();
  try {
    await run(db, 'UPDATE produtos SET preco_venda = 12.995 WHERE id = 748');
    await run(db, 'UPDATE produtos SET ativo = 0 WHERE id IN (749, 750)');
    await run(db, 'UPDATE pedidos SET total = 43.97 WHERE id = 99');
    await run(db, 'UPDATE pedidos_itens SET preco_unitario = 8.99, subtotal = 17.98 WHERE id = 1');
    await run(db, 'UPDATE pedidos_itens SET quantidade = 2, preco_unitario = 12.995, subtotal = 25.99 WHERE id = 2');

    const composicao = await prepararComposicaoPedidoPdv(
      { pedidoId: 99, empresaId: 1 },
      { db }
    );
    const bebida = composicao.itens.find((item) => item.produto_id === 748);
    assert.equal(bebida.preco_unitario, 12.995);
    assert.equal(bebida.subtotal, 25.99);
    assert.equal(composicao.valorFinalCentavos, 4397);
  } finally {
    await fecharDb(db);
  }
});

test('permite preparar venda somente com refrigerante (valor → copos MUC + desconto)', async () => {
  const db = await prepararBancoCenarioAtual();
  try {
    await run(db, 'DELETE FROM pedidos_itens WHERE id = 1');
    await run(db, 'UPDATE pedidos SET total = 18.00 WHERE id = 99');

    const composicao = await prepararComposicaoPedidoPdv(
      { pedidoId: 99, empresaId: 1 },
      { db }
    );

    assert.equal(composicao.modo, 'COMPOSICAO_PASTEL_REFRIGERANTE');
    assert.equal(composicao.valorPastelCentavos, 0);
    assert.equal(composicao.valorOriginalCentavos, 1800);
    assert.equal(composicao.valorFinalCentavos, 1800);
    assert.equal(composicao.valorResidualCentavos, 1800);
    assert.ok(composicao.descontoCentavos >= 0);
    assert.equal(
      composicao.valorCompostoBrutoCentavos - composicao.descontoCentavos,
      1800
    );
    assert.ok(composicao.itens.every((item) => [748, 749, 750].includes(item.produto_id)));
    assert.equal(composicao.efeitosOperacionais, false);
  } finally {
    await fecharDb(db);
  }
});

test('refrigerante R$ 9,00 escolhe o menor copo acima e aplica desconto técnico', async () => {
  const db = await prepararBancoCenarioAtual();
  try {
    await run(db, 'DELETE FROM pedidos_itens');
    await run(db, `INSERT INTO pedidos_itens (
      id, pedido_id, produto_id, quantidade, preco_unitario, subtotal
    ) VALUES (10, 99, 749, 1, 9.00, 9.00)`);
    await run(db, 'UPDATE pedidos SET total = 9.00 WHERE id = 99');

    const composicao = await prepararComposicaoPedidoPdv(
      { pedidoId: 99, empresaId: 1 },
      { db }
    );

    assert.equal(composicao.modo, 'COMPOSICAO_PASTEL_REFRIGERANTE');
    assert.equal(composicao.valorFinalCentavos, 900);
    assert.equal(composicao.descontoCentavos, 399);
    assert.deepEqual(
      composicao.itens.map((item) => [
        item.produto_id,
        item.quantidade,
        item.preco_unitario,
        item.subtotal
      ]),
      [[748, 1, 12.99, 12.99]]
    );
  } finally {
    await fecharDb(db);
  }
});

test('produto fiscal novo (150 ml) é descoberto no cadastro e vence o 200 ml no residual de R$ 9,00', async () => {
  const db = await prepararBancoCenarioAtual();
  try {
    await run(db, `INSERT INTO produtos (
      id, categoria_id, nome, preco_venda, volume_valor, volume_unidade, unidade,
      utiliza_volume, utiliza_conversao, controla_estoque, ativo
    ) VALUES (752, 44, 'Refrigerante Copo 150 ml', 9.75, 150, 'ML', 'ml', 1, 0, 1, 1)`);
    await run(db, `INSERT INTO estoque_empresa (
      produto_id, empresa_id, saldo_fiscal, saldo_nao_fiscal, estoque_atual
    ) VALUES (752, 1, 100, 100, 200)`);
    await run(db, 'DELETE FROM pedidos_itens');
    await run(db, `INSERT INTO pedidos_itens (
      id, pedido_id, produto_id, quantidade, preco_unitario, subtotal
    ) VALUES (11, 99, 749, 1, 9.00, 9.00)`);
    await run(db, 'UPDATE pedidos SET total = 9.00 WHERE id = 99');

    const composicao = await prepararComposicaoPedidoPdv(
      { pedidoId: 99, empresaId: 1 },
      { db }
    );

    assert.equal(composicao.modo, 'COMPOSICAO_PASTEL_REFRIGERANTE');
    assert.equal(composicao.valorFinalCentavos, 900);
    assert.equal(composicao.descontoCentavos, 75);
    assert.deepEqual(
      composicao.itens.map((item) => [
        item.produto_id,
        item.quantidade,
        item.preco_unitario,
        item.subtotal
      ]),
      [[752, 1, 9.75, 9.75]]
    );
  } finally {
    await fecharDb(db);
  }
});

test('pedido com água usa modelos fiscais da categoria Água (cadastro MUC), não refrigerante', async () => {
  const db = await prepararBancoCenarioAtual();
  try {
    await run(db, `INSERT INTO produtos (
      id, categoria_id, nome, preco_venda, volume_valor, volume_unidade, unidade,
      utiliza_volume, utiliza_conversao, controla_estoque, ativo
    ) VALUES
      (760, 45, 'Água 300 ml', 4.50, 300, 'ML', 'ml', 1, 0, 1, 1),
      (761, 45, 'Água 500 ml', 6.00, 500, 'ML', 'ml', 1, 0, 1, 1)`);
    await run(db, `INSERT INTO estoque_empresa (
      produto_id, empresa_id, saldo_fiscal, saldo_nao_fiscal, estoque_atual
    ) VALUES (760, 1, 100, 100, 200), (761, 1, 100, 100, 200)`);
    await run(db, 'DELETE FROM pedidos_itens');
    await run(db, `INSERT INTO pedidos_itens (
      id, pedido_id, produto_id, quantidade, preco_unitario, subtotal
    ) VALUES (12, 99, 760, 1, 3.50, 3.50)`);
    await run(db, 'UPDATE pedidos SET total = 3.50 WHERE id = 99');

    const composicao = await prepararComposicaoPedidoPdv(
      { pedidoId: 99, empresaId: 1 },
      { db }
    );

    assert.equal(composicao.modo, 'COMPOSICAO_PASTEL_REFRIGERANTE');
    assert.equal(composicao.valorFinalCentavos, 350);
    assert.equal(composicao.descontoCentavos, 100);
    assert.deepEqual(
      composicao.itens.map((item) => [
        item.produto_id,
        item.quantidade,
        item.preco_unitario,
        item.subtotal
      ]),
      [[760, 1, 4.5, 4.5]]
    );
    assert.ok(!composicao.itens.some((item) => [748, 749, 750].includes(item.produto_id)));
  } finally {
    await fecharDb(db);
  }
});

test('água sem volume MUC mas com estoque e preço entra por unidade (não AGUAS_INSUFICIENTES)', async () => {
  const db = await prepararBancoCenarioAtual();
  try {
    await run(db, `INSERT INTO produtos (
      id, categoria_id, nome, preco_venda, volume_valor, volume_unidade, unidade,
      utiliza_volume, utiliza_conversao, controla_estoque, ativo
    ) VALUES (751, 45, 'Agua Mineral', 7.99, NULL, NULL, 'un', 0, 0, 0, 1)`);
    await run(db, `INSERT INTO estoque_empresa (
      produto_id, empresa_id, saldo_fiscal, saldo_nao_fiscal, estoque_atual
    ) VALUES (751, 1, 200, 0, 200)`);
    await run(db, 'DELETE FROM pedidos_itens');
    await run(db, `INSERT INTO pedidos_itens (
      id, pedido_id, produto_id, quantidade, preco_unitario, subtotal
    ) VALUES (13, 99, 751, 1, 7.99, 7.99)`);
    await run(db, 'UPDATE pedidos SET total = 7.99 WHERE id = 99');

    const composicao = await prepararComposicaoPedidoPdv(
      { pedidoId: 99, empresaId: 1 },
      { db }
    );

    assert.equal(composicao.modo, 'COMPOSICAO_PASTEL_REFRIGERANTE');
    assert.equal(composicao.valorFinalCentavos, 799);
    assert.equal(composicao.descontoCentavos, 0);
    assert.deepEqual(
      composicao.itens.map((item) => [
        item.produto_id,
        item.quantidade,
        item.preco_unitario,
        item.subtotal
      ]),
      [[751, 1, 7.99, 7.99]]
    );
  } finally {
    await fecharDb(db);
  }
});

test('pedido só com pastel e residual zero permanece no núcleo pastel→refrigerante', async () => {
  const db = await prepararBancoCenarioAtual();
  try {
    await run(db, 'DELETE FROM pedidos_itens WHERE id = 2');
    await run(db, 'UPDATE pedidos_itens SET preco_unitario = 8.99, subtotal = 17.98 WHERE id = 1');
    await run(db, 'UPDATE pedidos SET total = 17.98 WHERE id = 99');

    const composicao = await prepararComposicaoPedidoPdv(
      { pedidoId: 99, empresaId: 1 },
      { db }
    );

    assert.equal(composicao.modo, 'COMPOSICAO_PASTEL_REFRIGERANTE');
    assert.equal(composicao.valorPastelCentavos, 1798);
    assert.equal(composicao.valorResidualCentavos, 0);
    assert.equal(composicao.descontoCentavos, 0);
    assert.equal(composicao.valorFinalCentavos, 1798);
    assert.deepEqual(
      composicao.itens.map((item) => [item.produto_id, item.quantidade, item.subtotal]),
      [[747, 2, 17.98]]
    );
  } finally {
    await fecharDb(db);
  }
});

test('fecha residual exato com pastel e refrigerante elegível do catálogo', async () => {
  const db = await prepararBancoCenarioAtual();
  try {
    await run(db, 'UPDATE pedidos SET total = 30.97 WHERE id = 99');
    await run(db, `
      UPDATE pedidos_itens SET preco_unitario = 8.99, subtotal = 17.98 WHERE id = 1
    `);
    await run(db, `
      UPDATE pedidos_itens SET preco_unitario = 12.99, subtotal = 12.99 WHERE id = 2
    `);

    const composicao = await prepararComposicaoPedidoPdv(
      { pedidoId: 99, empresaId: 1 },
      { db }
    );

    assert.equal(composicao.modo, 'COMPOSICAO_PASTEL_REFRIGERANTE');
    assert.deepEqual(
      composicao.itens.map((item) => [
        item.produto_id,
        item.quantidade,
        item.preco_unitario,
        item.subtotal
      ]),
      [
        [747, 2, 8.99, 17.98],
        [748, 1, 12.99, 12.99]
      ]
    );
    assert.equal(composicao.valorFinalCentavos, 3097);
  } finally {
    await fecharDb(db);
  }
});

test('permite produto independente sem ficha técnica / sem volume MUC', async () => {
  const db = await prepararBancoCenarioAtual();
  try {
    await run(db, `INSERT INTO categorias (id, nome) VALUES (50, 'Bebidas Diversas')`);
    await run(db, `INSERT INTO produtos (
      id, categoria_id, nome, preco_venda, volume_valor, volume_unidade, unidade,
      utiliza_volume, utiliza_conversao, controla_estoque, ativo
    ) VALUES (800, 50, 'Suco Pronto', 7.50, NULL, NULL, 'un', 0, 0, 0, 1)`);
    await run(db, 'DELETE FROM pedidos_itens');
    await run(db, `INSERT INTO pedidos_itens (
      id, pedido_id, produto_id, quantidade, preco_unitario, subtotal
    ) VALUES (10, 99, 800, 2, 7.50, 15.00)`);
    await run(db, 'UPDATE pedidos SET total = 15.00 WHERE id = 99');

    const composicao = await prepararComposicaoPedidoPdv(
      { pedidoId: 99, empresaId: 1 },
      { db }
    );

    assert.equal(composicao.modo, 'COMPOSICAO_IDENTIDADE_CATALOGO');
    assert.deepEqual(
      composicao.itens.map((item) => [
        item.produto_id,
        item.quantidade,
        item.preco_unitario,
        item.subtotal
      ]),
      [[800, 2, 7.5, 15]]
    );
    assert.equal(composicao.valorFinalCentavos, 1500);
  } finally {
    await fecharDb(db);
  }
});

test('bloqueia pedido sem itens comerciais elegíveis (insumo/inativo)', async () => {
  const db = await prepararBancoCenarioAtual();
  try {
    await run(db, 'DELETE FROM pedidos_itens');
    await run(db, `INSERT INTO produtos (
      id, categoria_id, nome, preco_venda, unidade, ativo, tipo_operacional
    ) VALUES (900, 44, 'Insumo X', 1.00, 'un', 1, 'INSUMO')`);
    await run(db, `INSERT INTO pedidos_itens (
      id, pedido_id, produto_id, quantidade, preco_unitario, subtotal
    ) VALUES (20, 99, 900, 1, 1.00, 1.00)`);
    await run(db, 'UPDATE pedidos SET total = 1.00 WHERE id = 99');

    await assert.rejects(
      prepararComposicaoPedidoPdv({ pedidoId: 99, empresaId: 1 }, { db }),
      (err) => err.code === 'PEDIDO_SEM_ITENS_ELEGIVEIS'
    );

    await run(db, 'UPDATE produtos SET tipo_operacional = \'COMERCIAL\', ativo = 0 WHERE id = 900');
    await assert.rejects(
      prepararComposicaoPedidoPdv({ pedidoId: 99, empresaId: 1 }, { db }),
      (err) => err.code === 'PEDIDO_SEM_ITENS_ELEGIVEIS'
    );
  } finally {
    await fecharDb(db);
  }
});

test('mantém regra de composição residual na venda por valor com pastel elegível', async () => {
  const db = await prepararBancoCenarioAtual();
  try {
    await run(db, 'DELETE FROM pedidos_itens WHERE id = 2');
    await run(db, `UPDATE pedidos_itens
      SET preco_unitario = 30.99, subtotal = 61.98 WHERE id = 1`);
    await run(db, `UPDATE pedidos
      SET observacao = 'VENDA_POR_VALOR_PASTEIS', total = 61.98 WHERE id = 99`);
    const composicao = await prepararComposicaoPedidoPdv(
      { pedidoId: 99, empresaId: 1 },
      { db }
    );
    assert.equal(composicao.modo, 'COMPOSICAO_PASTEL_REFRIGERANTE');
    assert.equal(composicao.valorFinalCentavos, 6198);
    assert.ok(composicao.itens.some((item) => item.produto_id === 747));
    assert.ok(composicao.itens.some((item) => item.produto_id === 748 || item.produto_id === 749));
  } finally {
    await fecharDb(db);
  }
});

test('venda por valor bloqueia o residual negativo antes de consultar refrigerantes', async () => {
  const db = await prepararBancoCenarioAtual();
  try {
    await run(db, `UPDATE pedidos SET observacao = 'VENDA_POR_VALOR_PASTEIS' WHERE id = 99`);
    await run(db, 'DELETE FROM pedidos_itens WHERE id = 2');
    await run(db, 'UPDATE pedidos_itens SET subtotal = 17.97 WHERE id = 1');
    await run(db, 'UPDATE pedidos SET total = 17.97 WHERE id = 99');

    await assert.rejects(
      prepararComposicaoPedidoPdv({ pedidoId: 99, empresaId: 1 }, { db }),
      (err) => err.code === 'RESIDUAL_PASTEL_NEGATIVO'
    );
  } finally {
    await fecharDb(db);
  }
});
