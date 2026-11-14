'use strict';

/**
 * CDS-PDV-COMPOSICAO-PEDIDO-02
 * Unificação: pedido com pastel usa o mesmo núcleo residual da venda por valor.
 * Banco: exclusivamente :memory: + DB_DIR temporário.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-composicao-pedido-02-'));
process.env.DB_DIR = dbDir;
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { prepararComposicaoPedidoPdv } = require('../../backend/services/vendas/PedidoPdvComposicaoService');
const {
  iniciarVendaPorValorPasteis,
  distribuirValorFiscalVendaPorValor
} = require('../../backend/services/vendas/VendaPorValorPasteisService');

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

async function prepararCatalogo(precos = {}) {
  const db = await abrirDb();
  const pastel = precos.pastel != null ? precos.pastel : 8.99;
  const r200 = precos.r200 != null ? precos.r200 : 12.99;
  const r300 = precos.r300 != null ? precos.r300 : 19.80;
  const r500 = precos.r500 != null ? precos.r500 : 32.99;

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
    (747, 43, 'Pastel do Cheff', ?, NULL, NULL, 'un', 0, 1),
    (748, 44, 'Refrigerante Copo 200ML', ?, 200, 'ML', 'ml', 1, 1),
    (749, 44, 'Refrigerante Copo 300 ml', ?, 300, 'ML', 'ml', 1, 1),
    (750, 44, 'Refrigerante Copo 500 ml', ?, 500, 'ML', 'un', 1, 1),
    (900, 50, 'Produto Simples', 5.50, NULL, NULL, 'un', 0, 1)`,
  [pastel, r200, r300, r500]);
  await run(db, `INSERT INTO estoque_empresa (
    produto_id, empresa_id, saldo_fiscal, saldo_nao_fiscal, estoque_atual
  ) VALUES
    (748, 1, 100, 100, 200), (749, 1, 100, 100, 200), (750, 1, 100, 100, 200),
    (900, 1, 10, 10, 20)`);
  return db;
}

async function inserirPedidoPastel(db, {
  id, total, quantidadePasteis, desconto = 0, observacao = null, precoHistoricoPastel = 8.99
}) {
  const pastelSub = Number((precoHistoricoPastel * quantidadePasteis).toFixed(2));
  let resto = Number((total + desconto - pastelSub).toFixed(2));
  await run(db, `INSERT INTO pedidos (
    id, codigo, empresa_id, status, total, desconto, frete, observacao, created_at
  ) VALUES (?, ?, 1, 'PEDIDO', ?, ?, 0, ?, '2026-01-01')`,
  [id, `PED-${id}`, total, desconto, observacao]);
  await run(db, `INSERT INTO pedidos_itens (
    pedido_id, produto_id, quantidade, preco_unitario, subtotal
  ) VALUES (?, 747, ?, ?, ?)`,
  [id, quantidadePasteis, precoHistoricoPastel, pastelSub]);
  if (resto > 0.0001) {
    await run(db, `INSERT INTO pedidos_itens (
      pedido_id, produto_id, quantidade, preco_unitario, subtotal
    ) VALUES (?, 748, 1, ?, ?)`, [id, resto, resto]);
  }
}

function qtdPastel(composicao) {
  return composicao.itens
    .filter((i) => i.produto_id === 747)
    .reduce((s, i) => s + Number(i.quantidade), 0);
}

function refrigerantes(composicao) {
  return composicao.itens.filter((i) => i.produto_id !== 747);
}

test('01) pedido R$ 56,98 — 1 pastel, residual 47,99, total preservado', async () => {
  const db = await prepararCatalogo();
  try {
    await inserirPedidoPastel(db, { id: 1, total: 56.98, quantidadePasteis: 1 });
    const c = await prepararComposicaoPedidoPdv({ pedidoId: 1, empresaId: 1 }, { db });
    assert.equal(c.modo, 'COMPOSICAO_PASTEL_REFRIGERANTE');
    assert.equal(qtdPastel(c), 1);
    assert.equal(c.itens.find((i) => i.produto_id === 747).preco_unitario, 8.99);
    assert.equal(c.valorPastelCentavos, 899);
    assert.equal(c.valorResidualCentavos, 4799);
    assert.ok(refrigerantes(c).length > 0);
    assert.ok(c.descontoCentavos >= 0);
    assert.equal(c.valorFinalCentavos, 5698);
    assert.equal(
      c.valorCompostoBrutoCentavos - c.descontoCentavos,
      5698
    );
  } finally {
    await fecharDb(db);
  }
});

test('02) pedido R$ 61,98 — 2 pastéis, residual 44,00, total preservado', async () => {
  const db = await prepararCatalogo();
  try {
    await inserirPedidoPastel(db, { id: 2, total: 61.98, quantidadePasteis: 2 });
    const c = await prepararComposicaoPedidoPdv({ pedidoId: 2, empresaId: 1 }, { db });
    assert.equal(c.modo, 'COMPOSICAO_PASTEL_REFRIGERANTE');
    assert.equal(qtdPastel(c), 2);
    assert.equal(c.valorPastelCentavos, 1798);
    assert.equal(c.valorResidualCentavos, 4400);
    assert.ok(refrigerantes(c).length > 0);
    assert.equal(c.valorFinalCentavos, 6198);
  } finally {
    await fecharDb(db);
  }
});

test('03) alteração do preço do pastel recalcula residual e preserva total/qtd', async () => {
  const db = await prepararCatalogo();
  try {
    await inserirPedidoPastel(db, { id: 3, total: 61.98, quantidadePasteis: 2 });
    await run(db, 'UPDATE produtos SET preco_venda = 10.99 WHERE id = 747');
    const c = await prepararComposicaoPedidoPdv({ pedidoId: 3, empresaId: 1 }, { db });
    assert.equal(qtdPastel(c), 2);
    assert.equal(c.itens.find((i) => i.produto_id === 747).preco_unitario, 10.99);
    assert.equal(c.valorPastelCentavos, 2198);
    assert.equal(c.valorResidualCentavos, 4000);
    assert.equal(c.valorFinalCentavos, 6198);
  } finally {
    await fecharDb(db);
  }
});

test('04) alteração dos refrigerantes usa novos preços na composição', async () => {
  const db = await prepararCatalogo();
  try {
    await inserirPedidoPastel(db, { id: 4, total: 56.98, quantidadePasteis: 1 });
    const antes = await prepararComposicaoPedidoPdv({ pedidoId: 4, empresaId: 1 }, { db });
    await run(db, 'UPDATE produtos SET preco_venda = 13.99 WHERE id = 748');
    await run(db, 'UPDATE produtos SET preco_venda = 21.90 WHERE id = 749');
    const depois = await prepararComposicaoPedidoPdv({ pedidoId: 4, empresaId: 1 }, { db });
    assert.equal(depois.valorFinalCentavos, 5698);
    assert.equal(depois.valorResidualCentavos, 4799);
    for (const item of refrigerantes(depois)) {
      if (item.produto_id === 748) assert.equal(Number(item.preco_unitario), 13.99);
      if (item.produto_id === 749) assert.equal(Number(item.preco_unitario), 21.9);
      if (item.produto_id === 750) assert.equal(Number(item.preco_unitario), 32.99);
    }
    assert.notDeepEqual(
      refrigerantes(antes).map((i) => [i.produto_id, i.quantidade, Number(i.preco_unitario)]),
      refrigerantes(depois).map((i) => [i.produto_id, i.quantidade, Number(i.preco_unitario)])
    );
  } finally {
    await fecharDb(db);
  }
});

test('05) quantidades 1, 2, 3 e 5 pastéis são preservadas', async () => {
  const db = await prepararCatalogo();
  try {
    let id = 50;
    for (const qtd of [1, 2, 3, 5]) {
      const total = Number((8.99 * qtd + 44).toFixed(2));
      await inserirPedidoPastel(db, { id, total, quantidadePasteis: qtd });
      const c = await prepararComposicaoPedidoPdv({ pedidoId: id, empresaId: 1 }, { db });
      assert.equal(qtdPastel(c), qtd);
      assert.equal(c.valorFinalCentavos, Math.round(total * 100));
      id += 1;
    }
  } finally {
    await fecharDb(db);
  }
});

test('06) refrigerantes elegíveis dinâmicos (200/300/500), sem produto fixo no código', async () => {
  const db = await prepararCatalogo();
  try {
    await inserirPedidoPastel(db, { id: 6, total: 61.98, quantidadePasteis: 2 });
    const c = await prepararComposicaoPedidoPdv({ pedidoId: 6, empresaId: 1 }, { db });
    const refs = refrigerantes(c);
    assert.ok(refs.length > 0);
    for (const item of refs) {
      assert.ok([748, 749, 750].includes(item.produto_id));
    }
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../backend/services/vendas/PedidoPdvComposicaoService.js'),
      'utf8'
    );
    assert.doesNotMatch(src, /preco_venda\s*=\s*8\.99/);
    assert.doesNotMatch(src, /quantidade:\s*4,\s*produto_id:\s*748/);
  } finally {
    await fecharDb(db);
  }
});

test('07) desconto de ajuste oficial fecha o total sem inventar valor', async () => {
  const db = await prepararCatalogo();
  try {
    await inserirPedidoPastel(db, { id: 7, total: 56.98, quantidadePasteis: 1 });
    const c = await prepararComposicaoPedidoPdv({ pedidoId: 7, empresaId: 1 }, { db });
    assert.equal(c.descontoCentavos, c.valorCompostoBrutoCentavos - 5698);
    assert.ok(c.descontoCentavos >= 0);
    assert.equal(c.valorFinalCentavos, 5698);
  } finally {
    await fecharDb(db);
  }
});

test('08) ausência de composição elegível retorna erro controlado', async () => {
  const db = await prepararCatalogo();
  try {
    await run(db, 'UPDATE produtos SET ativo = 0 WHERE id IN (748, 749, 750)');
    await inserirPedidoPastel(db, { id: 8, total: 56.98, quantidadePasteis: 1 });
    await assert.rejects(
      () => prepararComposicaoPedidoPdv({ pedidoId: 8, empresaId: 1 }, { db }),
      (err) => err && (err.code === 'REFRIGERANTES_INSUFICIENTES'
        || err.codigo === 'REFRIGERANTES_INSUFICIENTES'
        || err.code === 'COMPOSICAO_PDV_SEM_COBERTURA'
        || err.codigo === 'COMPOSICAO_PDV_SEM_COBERTURA')
    );
  } finally {
    await fecharDb(db);
  }
});

test('09) handoff entrega composição completa sem alterar total/vínculo', async () => {
  const db = await prepararCatalogo();
  try {
    await inserirPedidoPastel(db, { id: 9, total: 56.98, quantidadePasteis: 1 });
    const c = await prepararComposicaoPedidoPdv({ pedidoId: 9, empresaId: 1 }, { db });
    assert.equal(c.pedidoId, 9);
    assert.equal(c.empresaId, 1);
    assert.ok(c.fingerprint);
    assert.equal(c.valorFinalCentavos, 5698);
    assert.equal(c.efeitosOperacionais, false);
  } finally {
    await fecharDb(db);
  }
});

test('10) idempotência: mesma fingerprint e mesmos itens', async () => {
  const db = await prepararCatalogo();
  try {
    await inserirPedidoPastel(db, { id: 10, total: 61.98, quantidadePasteis: 2 });
    const a = await prepararComposicaoPedidoPdv({ pedidoId: 10, empresaId: 1 }, { db });
    const b = await prepararComposicaoPedidoPdv({ pedidoId: 10, empresaId: 1 }, { db });
    assert.equal(a.fingerprint, b.fingerprint);
    assert.deepEqual(
      a.itens.map((i) => [i.produto_id, i.quantidade, i.preco_unitario, i.subtotal]),
      b.itens.map((i) => [i.produto_id, i.quantidade, i.preco_unitario, i.subtotal])
    );
  } finally {
    await fecharDb(db);
  }
});

test('11) regressão venda por valor: mesmo núcleo e total preservado', async () => {
  const db = await prepararCatalogo();
  try {
    await inserirPedidoPastel(db, {
      id: 11,
      total: 61.98,
      quantidadePasteis: 2,
      observacao: OBS_VV,
      precoHistoricoPastel: 30.99
    });
    // VV exige massa no pastel = total
    await run(db, 'DELETE FROM pedidos_itens WHERE pedido_id = 11 AND produto_id != 747');
    await run(db, `UPDATE pedidos_itens
      SET preco_unitario = 30.99, subtotal = 61.98 WHERE pedido_id = 11`);
    const vv = await prepararComposicaoPedidoPdv({ pedidoId: 11, empresaId: 1 }, { db });
    assert.equal(vv.modo, 'COMPOSICAO_PASTEL_REFRIGERANTE');
    assert.equal(vv.valorFinalCentavos, 6198);
    assert.equal(qtdPastel(vv), 2);
    assert.ok(refrigerantes(vv).length > 0);

    await inserirPedidoPastel(db, { id: 12, total: 61.98, quantidadePasteis: 2 });
    const comercial = await prepararComposicaoPedidoPdv({ pedidoId: 12, empresaId: 1 }, { db });
    assert.equal(comercial.modo, 'COMPOSICAO_PASTEL_REFRIGERANTE');
    assert.equal(comercial.valorFinalCentavos, 6198);
    assert.equal(comercial.valorResidualCentavos, vv.valorResidualCentavos);
    assert.deepEqual(
      refrigerantes(comercial).map((i) => [i.produto_id, i.quantidade, i.preco_unitario]),
      refrigerantes(vv).map((i) => [i.produto_id, i.quantidade, i.preco_unitario])
    );
    assert.equal(typeof iniciarVendaPorValorPasteis, 'function');
    assert.equal(typeof distribuirValorFiscalVendaPorValor, 'function');
  } finally {
    await fecharDb(db);
  }
});

test('12) pedido sem pastel permanece identidade; F×NF campos da composição intactos', async () => {
  const db = await prepararCatalogo();
  try {
    await run(db, `INSERT INTO pedidos (
      id, codigo, empresa_id, status, total, desconto, frete, created_at
    ) VALUES (96, 'PED-96', 1, 'PEDIDO', 11.00, 0, 0, '2026-01-01')`);
    await run(db, `INSERT INTO pedidos_itens (
      pedido_id, produto_id, quantidade, preco_unitario, subtotal
    ) VALUES (96, 900, 2, 5.50, 11.00)`);
    const normal = await prepararComposicaoPedidoPdv({ pedidoId: 96, empresaId: 1 }, { db });
    assert.equal(normal.modo, 'COMPOSICAO_IDENTIDADE_CATALOGO');
    assert.equal(normal.valorFinalCentavos, 1100);
    assert.equal(normal.valorResidualCentavos, 0);

    await inserirPedidoPastel(db, { id: 97, total: 56.98, quantidadePasteis: 1 });
    const comPastel = await prepararComposicaoPedidoPdv({ pedidoId: 97, empresaId: 1 }, { db });
    assert.equal(comPastel.modo, 'COMPOSICAO_PASTEL_REFRIGERANTE');
    assert.ok(Number.isSafeInteger(comPastel.valorFinalCentavos));
    assert.ok(Number.isSafeInteger(comPastel.valorPastelCentavos));
    assert.ok(Number.isSafeInteger(comPastel.valorResidualCentavos));
    assert.ok(Number.isSafeInteger(comPastel.descontoCentavos));
    assert.equal(comPastel.valorFinalCentavos, 5698);
  } finally {
    await fecharDb(db);
  }
});
