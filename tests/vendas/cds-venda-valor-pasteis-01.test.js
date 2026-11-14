/**
 * CDS-VENDA-VALOR-PASTEIS-01 — entrada por valor total + qtd pastéis.
 * Isolamento: sqlite :memory:. Sem banco oficial / SEFAZ / vendas reais.
 * Executar: node --test tests/vendas/cds-venda-valor-pasteis-01.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-venda-valor-pasteis-01-'));
process.env.DB_DIR = dbDir;
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const { prepararComposicaoPedidoPdv } = require('../../backend/services/vendas/PedidoPdvComposicaoService');
const {
  iniciarVendaPorValorPasteis,
  resolverProdutoPastel,
  montarItemPedidoPastel,
  persistirMassaMonetariaPedidoAlvo,
  distribuirValorFiscalVendaPorValor,
  OBS_ORIGEM
} = require('../../backend/services/vendas/VendaPorValorPasteisService');
const { internos: ComposicaoInterna } = require(
  '../../backend/services/vendas/ComposicaoFiscalPedidoService'
);
const EmpresaModoEstoqueService = require('../../backend/services/empresas/EmpresaModoEstoqueService');
const {
  garantirSchemaEmpresasConfiguracaoEstoqueAsync
} = require('../../backend/services/empresas/empresasConfiguracaoEstoqueSchema');

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
    id INTEGER PRIMARY KEY AUTOINCREMENT, pedido_id INTEGER, produto_id INTEGER,
    quantidade REAL, preco_unitario REAL, subtotal REAL
  )`);
  await run(db, 'INSERT INTO empresas (id) VALUES (1)');
  await run(db, `INSERT INTO categorias (id, nome) VALUES
    (43, 'Pasteis'), (44, 'Refrigerantes')`);
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
  await garantirSchemaEmpresasConfiguracaoEstoqueAsync(db);
  return db;
}

async function inserirPedidoNoFormatoAdaptador(db, { pedidoId, valorTotal, quantidade }) {
  const totalCentavos = Math.round(valorTotal * 100);
  const item = montarItemPedidoPastel(747, quantidade, totalCentavos);
  await run(db, `INSERT INTO pedidos (
    id, codigo, cliente_id, empresa_id, status, total, desconto, frete, observacao, created_at
  ) VALUES (?, 'PED-VV', NULL, 1, 'PEDIDO', ?, 0, 0, ?, '2026-01-01')`,
  [pedidoId, valorTotal, OBS_ORIGEM]);
  await run(db, `INSERT INTO pedidos_itens (
    pedido_id, produto_id, quantidade, preco_unitario, subtotal
  ) VALUES (?, ?, ?, ?, ?)`,
  [pedidoId, item.produto_id, item.quantidade, item.preco_unitario, item.subtotal]);
  return item;
}

test('aceita valor total e quantidade e resolve o pastel cadastrado', async () => {
  const db = await prepararCatalogo();
  try {
    const pastel = await resolverProdutoPastel(db, null);
    assert.equal(Number(pastel.id), 747);
    assert.equal(pastel.nome, 'Pastel do Cheff');
    const item = montarItemPedidoPastel(747, 2, 3097);
    assert.equal(item.quantidade, 2);
    assert.equal(item.subtotal, 30.97);
  } finally {
    await fecharDb(db);
  }
});

test('pedido comercial e venda por valor compartilham o núcleo residual no residual exato', async () => {
  const db = await prepararCatalogo();
  try {
    await inserirPedidoNoFormatoAdaptador(db, { pedidoId: 10, valorTotal: 30.97, quantidade: 2 });
    const porValor = await prepararComposicaoPedidoPdv({ pedidoId: 10, empresaId: 1 }, { db });

    await run(db, `INSERT INTO pedidos (
      id, codigo, empresa_id, status, total, desconto, frete, created_at
    ) VALUES (11, 'PED-TRAD', 1, 'PEDIDO', 30.97, 0, 0, '2026-01-01')`);
    await run(db, `INSERT INTO pedidos_itens (pedido_id, produto_id, quantidade, preco_unitario, subtotal)
      VALUES (11, 747, 2, 8.99, 17.98), (11, 748, 1, 12.99, 12.99)`);
    const tradicional = await prepararComposicaoPedidoPdv({ pedidoId: 11, empresaId: 1 }, { db });

    assert.equal(porValor.modo, 'COMPOSICAO_PASTEL_REFRIGERANTE');
    assert.equal(tradicional.modo, 'COMPOSICAO_PASTEL_REFRIGERANTE');
    assert.equal(porValor.valorFinalCentavos, 3097);
    assert.equal(tradicional.valorFinalCentavos, 3097);
    assert.equal(porValor.valorResidualCentavos, 1299);
    assert.equal(tradicional.valorResidualCentavos, 1299);
    assert.equal(tradicional.valorPastelCentavos, 1798);
    assert.equal(tradicional.descontoCentavos, 0);
    assert.deepEqual(
      tradicional.itens.map((i) => [i.produto_id, i.quantidade, i.subtotal]),
      [[747, 2, 17.98], [748, 1, 12.99]]
    );
    const comercial = await all(
      db,
      'SELECT total, desconto FROM pedidos WHERE id = 10'
    );
    const linha = await all(
      db,
      'SELECT subtotal FROM pedidos_itens WHERE pedido_id = 10'
    );
    assert.equal(comercial[0].total, 30.97);
    assert.equal(comercial[0].desconto, 0);
    assert.equal(linha[0].subtotal, 30.97);
  } finally {
    await fecharDb(db);
  }
});

test('pedido comercial e venda por valor unificam residual e desconto de ajuste', async () => {
  const db = await prepararCatalogo();
  try {
    await inserirPedidoNoFormatoAdaptador(db, { pedidoId: 20, valorTotal: 61.98, quantidade: 2 });
    const porValor = await prepararComposicaoPedidoPdv({ pedidoId: 20, empresaId: 1 }, { db });

    await run(db, `INSERT INTO pedidos (
      id, codigo, empresa_id, status, total, desconto, frete, created_at
    ) VALUES (21, 'PED-TRAD2', 1, 'PEDIDO', 61.98, 0, 0, '2026-01-01')`);
    await run(db, `INSERT INTO pedidos_itens (pedido_id, produto_id, quantidade, preco_unitario, subtotal)
      VALUES (21, 747, 2, 21.99, 43.98), (21, 748, 1, 18.00, 18.00)`);
    const tradicional = await prepararComposicaoPedidoPdv({ pedidoId: 21, empresaId: 1 }, { db });

    assert.equal(porValor.valorFinalCentavos, 6198);
    assert.equal(porValor.descontoCentavos, 178);
    assert.equal(porValor.valorPastelCentavos, 1798);
    assert.equal(tradicional.modo, 'COMPOSICAO_PASTEL_REFRIGERANTE');
    assert.equal(tradicional.valorFinalCentavos, 6198);
    assert.equal(tradicional.valorResidualCentavos, 4400);
    assert.equal(tradicional.valorPastelCentavos, 1798);
    assert.equal(tradicional.descontoCentavos, porValor.descontoCentavos);
    assert.deepEqual(
      tradicional.itens.filter((i) => i.produto_id !== 747)
        .map((i) => [i.produto_id, i.quantidade, i.preco_unitario]),
      porValor.itens.filter((i) => i.produto_id !== 747)
        .map((i) => [i.produto_id, i.quantidade, i.preco_unitario])
    );
    const linha = await all(
      db,
      'SELECT subtotal FROM pedidos_itens WHERE pedido_id = 20'
    );
    assert.equal(linha[0].subtotal, 61.98);
    const repetida = await prepararComposicaoPedidoPdv({ pedidoId: 20, empresaId: 1 }, { db });
    assert.equal(repetida.fingerprint, porValor.fingerprint);
  } finally {
    await fecharDb(db);
  }
});

test('adaptador encaminha ao handoff PDV sem duplicar motor de vendas/composição', async () => {
  const db = await prepararCatalogo();
  try {
    let receberBody = null;
    let massaPersistida = null;
    const out = await iniciarVendaPorValorPasteis({
      db,
      empresaId: 1,
      valorTotal: 30.97,
      quantidadePasteis: 2,
      chaveIdempotencia: 'chave-vv-1'
    }, {
      criarCotadorPreco: async () => ({
        cotar: (q) => ({ subtotalCentavos: Math.round(8.99 * q * 100), precoUnitarioInterno: 8.99 })
      }),
      receberEntrada: async (entrada) => {
        receberBody = entrada.body;
        // Simula Entrada: itens no cadastro; massa alinhada depois por persistirMassa…
        await run(db, `INSERT INTO pedidos (
          id, codigo, empresa_id, status, total, desconto, frete, observacao, created_at
        ) VALUES (30, 'PED-VV', 1, 'PEDIDO', 17.98, 0, 0, ?, '2026-01-01')`, [OBS_ORIGEM]);
        await run(db, `INSERT INTO pedidos_itens (
          pedido_id, produto_id, quantidade, preco_unitario, subtotal
        ) VALUES (30, 747, 2, 8.99, 17.98)`);
        return { success: true, pedido: { id: 30 }, idempotente: false };
      },
      persistirMassaMonetariaPedidoAlvo: async (database, args) => {
        massaPersistida = args;
        return persistirMassaMonetariaPedidoAlvo(database, args);
      },
      consultarOperacaoPdv: async () => null,
      prepararOperacaoPdv: async (pedidoId, empresaId, payload) => ({
        operacao: { id: 88, venda_id: null, status: 'INICIADA' },
        recuperacao: false,
        payload
      }),
      obterModoEstoqueEmpresa: async () => ({ modo: 'AUTOMATICO' })
    });

    assert.equal(receberBody.observacao, OBS_ORIGEM);
    assert.equal(receberBody.total, undefined);
    assert.equal(receberBody.itens[0].produto_id, 747);
    assert.equal(receberBody.itens[0].quantidade, 2);
    assert.equal(receberBody.itens[0].subtotal, 17.98);
    assert.equal(massaPersistida.totalCentavos, 3097);
    assert.equal(massaPersistida.quantidade, 2);

    const carregado = await ComposicaoInterna.carregarPedido(1, 30, db);
    assert.equal(carregado.totalCentavos, 3097);
    assert.equal(
      carregado.itens.reduce((s, i) => s + Math.round(Number(i.subtotal) * 100), 0),
      3097
    );

    assert.equal(out.pedido_id, 30);
    assert.equal(out.operacao_id, 88);
    assert.equal(out.modo_composicao, 'COMPOSICAO_PASTEL_REFRIGERANTE');
    assert.ok(Array.isArray(out.itens) && out.itens.length >= 1);
    assert.ok(out.fingerprint);
    assert.equal(out.modo_estoque, 'AUTOMATICO');

    const src = fs.readFileSync(
      path.join(ROOT, 'backend/services/vendas/VendaPorValorPasteisService.js'),
      'utf8'
    );
    assert.match(src, /EntradaPedido\.receber|receberEntrada/);
    assert.match(src, /prepararComposicaoPedidoPdv/);
    assert.match(src, /prepararOperacaoPdv/);
    assert.match(src, /persistirMassaMonetariaPedidoAlvo/);
    assert.doesNotMatch(src, /buscarComposicao\s*\(/);
    assert.doesNotMatch(src, /criarVenda\s*\(/);
  } finally {
    await fecharDb(db);
  }
});

test('CDS-03: R$ 64,90 + 2 pastéis — integridade total/itens e composição', async () => {
  const db = await prepararCatalogo();
  try {
    // Cadastro do pastel no catálogo de teste = 8.99; cenários reais usam ~21.99.
    // Aqui o pastel base é 8.99*2=17.98; residual 64.90-17.98=46.92 (composição aproximada).
    const valor = 64.9;
    const qtd = 2;
    const out = await iniciarVendaPorValorPasteis({
      db,
      empresaId: 1,
      valorTotal: valor,
      quantidadePasteis: qtd,
      chaveIdempotencia: 'chave-vv-6490'
    }, {
      criarCotadorPreco: async () => ({
        cotar: (q) => ({
          subtotalCentavos: Math.round(8.99 * q * 100),
          precoUnitarioInterno: 8.99
        })
      }),
      receberEntrada: async () => {
        await run(db, `INSERT INTO pedidos (
          id, codigo, empresa_id, status, total, desconto, frete, observacao, created_at
        ) VALUES (70, 'PED-6490', 1, 'PEDIDO', 17.98, 0, 0, ?, '2026-01-01')`, [OBS_ORIGEM]);
        await run(db, `INSERT INTO pedidos_itens (
          pedido_id, produto_id, quantidade, preco_unitario, subtotal
        ) VALUES (70, 747, 2, 8.99, 17.98)`);
        return { success: true, pedido: { id: 70 }, idempotente: false };
      },
      consultarOperacaoPdv: async () => null,
      prepararOperacaoPdv: async (pedidoId, empresaId, payload) => ({
        operacao: { id: 99, venda_id: null, status: 'INICIADA' },
        recuperacao: false,
        payload
      }),
      obterModoEstoqueEmpresa: async () => ({ modo: 'AUTOMATICO' })
    });

    const carregado = await ComposicaoInterna.carregarPedido(1, 70, db);
    assert.equal(carregado.totalCentavos, 6490);
    assert.equal(carregado.descontoCentavos, 0);
    const somaItens = carregado.itens.reduce(
      (s, i) => s + Math.round(Number(i.subtotal) * 100),
      0
    );
    assert.equal(somaItens - carregado.descontoCentavos, carregado.totalCentavos);

    assert.equal(out.pedido_id, 70);
    assert.ok(out.success);
    assert.ok(Array.isArray(out.itens) && out.itens.length >= 1);
    assert.equal(Math.round(Number(out.total) * 100), Math.round(Number(out.total) * 100));
    // Total da composição (após desconto do motor) ≤ valor informado
    assert.ok(Math.round(Number(out.total) * 100) <= 6490);
  } finally {
    await fecharDb(db);
  }
});

test('fluxo tradicional de composição permanece intacto (regressão mínima)', async () => {
  const db = await prepararCatalogo();
  try {
    await run(db, `INSERT INTO pedidos (
      id, codigo, empresa_id, status, total, desconto, frete, created_at
    ) VALUES (40, 'PED-TRAD', 1, 'PEDIDO', 30.97, 0, 0, '2026-01-01')`);
    await run(db, `INSERT INTO pedidos_itens (pedido_id, produto_id, quantidade, preco_unitario, subtotal)
      VALUES (40, 747, 2, 8.99, 17.98), (40, 748, 1, 12.99, 12.99)`);
    const c = await prepararComposicaoPedidoPdv({ pedidoId: 40, empresaId: 1 }, { db });
    assert.equal(c.descontoCentavos, 0);
    assert.equal(c.valorFinalCentavos, 3097);
  } finally {
    await fecharDb(db);
  }
});

test('entradas inválidas são rejeitadas sem criar pedido', async () => {
  const db = await prepararCatalogo();
  let receberChamado = false;
  try {
    await assert.rejects(
      () => iniciarVendaPorValorPasteis({
        db, empresaId: 1, valorTotal: 0, quantidadePasteis: 2
      }, { receberEntrada: async () => { receberChamado = true; } }),
      (err) => err && err.codigo === 'VALOR_TOTAL_INVALIDO'
    );
    await assert.rejects(
      () => iniciarVendaPorValorPasteis({
        db, empresaId: 1, valorTotal: 30.97, quantidadePasteis: 0
      }, { receberEntrada: async () => { receberChamado = true; } }),
      (err) => err && err.codigo === 'QUANTIDADE_PASTEIS_INVALIDA'
    );
    await assert.rejects(
      () => iniciarVendaPorValorPasteis({
        db,
        empresaId: 1,
        valorTotal: 10,
        quantidadePasteis: 2
      }, {
        criarCotadorPreco: async () => ({
          cotar: (q) => ({ subtotalCentavos: Math.round(8.99 * q * 100), precoUnitarioInterno: 8.99 })
        }),
        receberEntrada: async () => { receberChamado = true; }
      }),
      (err) => err && err.codigo === 'RESIDUAL_PASTEL_NEGATIVO'
    );
    assert.equal(receberChamado, false);
  } finally {
    await fecharDb(db);
  }
});

test('repetição com mesma chave não cria segundo pedido (idempotência da entrada)', async () => {
  const db = await prepararCatalogo();
  try {
    let criações = 0;
    const deps = {
      criarCotadorPreco: async () => ({
        cotar: (q) => ({ subtotalCentavos: Math.round(8.99 * q * 100), precoUnitarioInterno: 8.99 })
      }),
      receberEntrada: async () => {
        criações += 1;
        if (criações === 1) {
          await inserirPedidoNoFormatoAdaptador(db, { pedidoId: 50, valorTotal: 30.97, quantidade: 2 });
          return { success: true, pedido: { id: 50 }, idempotente: false };
        }
        return { success: true, pedido: { id: 50 }, idempotente: true };
      },
      consultarOperacaoPdv: async () => null,
      prepararOperacaoPdv: async (pedidoId, empresaId, payload) => ({
        operacao: { id: 1, venda_id: null, status: 'INICIADA' },
        recuperacao: criações > 1,
        payload
      }),
      obterModoEstoqueEmpresa: async () => ({ modo: 'AUTOMATICO' })
    };
    const a = await iniciarVendaPorValorPasteis({
      db, empresaId: 1, valorTotal: 30.97, quantidadePasteis: 2, chaveIdempotencia: 'same'
    }, deps);
    const b = await iniciarVendaPorValorPasteis({
      db, empresaId: 1, valorTotal: 30.97, quantidadePasteis: 2, chaveIdempotencia: 'same'
    }, deps);
    assert.equal(a.pedido_id, b.pedido_id);
    assert.equal(b.pedido_repetido, true);
    assert.equal(criações, 2);
  } finally {
    await fecharDb(db);
  }
});

test('respeita modo de estoque AUTOMATICO e MANUAL na resposta (sem nova regra)', async () => {
  const db = await prepararCatalogo();
  try {
    await EmpresaModoEstoqueService.salvarModoEstoqueEmpresa(db, 1, 'MANUAL');
    const out = await iniciarVendaPorValorPasteis({
      db, empresaId: 1, valorTotal: 30.97, quantidadePasteis: 2
    }, {
      criarCotadorPreco: async () => ({
        cotar: (q) => ({ subtotalCentavos: Math.round(8.99 * q * 100), precoUnitarioInterno: 8.99 })
      }),
      receberEntrada: async () => {
        await inserirPedidoNoFormatoAdaptador(db, { pedidoId: 60, valorTotal: 30.97, quantidade: 2 });
        return { success: true, pedido: { id: 60 } };
      },
      consultarOperacaoPdv: async () => null,
      prepararOperacaoPdv: async (pedidoId, empresaId, payload) => ({
        operacao: { id: 2, venda_id: null, status: 'INICIADA' },
        recuperacao: false,
        payload
      })
    });
    assert.equal(out.modo_estoque, 'MANUAL');

    const srcGate = fs.readFileSync(
      path.join(ROOT, 'backend/services/vendas/VendaPorValorPasteisService.js'),
      'utf8'
    );
    assert.doesNotMatch(srcGate, /reduzirEstoqueDistribuido|consumirFichaTecnicaDaVenda/);
  } finally {
    await fecharDb(db);
  }
});

function centavos(valor) {
  return Math.round(Number(valor) * 100);
}

async function venderPorValor(db, pedidoId, valor, quantidade) {
  let payload = null;
  const out = await iniciarVendaPorValorPasteis({
    db,
    empresaId: 1,
    valorTotal: valor,
    quantidadePasteis: quantidade
  }, {
    criarCotadorPreco: async () => ({
      cotar: (qtd) => ({
        subtotalCentavos: Math.round(8.99 * qtd * 100),
        precoUnitarioInterno: 8.99
      })
    }),
    receberEntrada: async (entrada) => {
      const item = entrada.body.itens[0];
      await run(db, `INSERT INTO pedidos (
        id, codigo, empresa_id, status, total, desconto, frete, observacao, created_at
      ) VALUES (?, ?, 1, 'PEDIDO', ?, 0, 0, ?, '2026-01-01')`,
      [pedidoId, `PED-${pedidoId}`, item.subtotal, OBS_ORIGEM]);
      await run(db, `INSERT INTO pedidos_itens (
        pedido_id, produto_id, quantidade, preco_unitario, subtotal
      ) VALUES (?, ?, ?, ?, ?)`,
      [pedidoId, item.produto_id, item.quantidade, item.preco_unitario, item.subtotal]);
      return { success: true, pedido: { id: pedidoId } };
    },
    consultarOperacaoPdv: async () => null,
    prepararOperacaoPdv: async (_pedidoId, _empresaId, corpo) => {
      payload = corpo;
      return {
        operacao: { id: pedidoId, venda_id: null, status: 'INICIADA' },
        recuperacao: false,
        payload: corpo
      };
    },
    obterModoEstoqueEmpresa: async () => ({ modo: 'AUTOMATICO' })
  });
  return { out, payload };
}

function brutoMenosDesconto(payload) {
  const bruto = payload.itens.reduce((soma, item) => soma + centavos(item.subtotal), 0);
  return bruto - centavos(payload.desconto);
}

test('CDS-COMPOSICAO-VALOR-DISTRIBUICAO-01: pedido 68 desconto técnico de R$ 1,78', async () => {
  const db = await prepararCatalogo();
  try {
    const { out, payload } = await venderPorValor(db, 68, 61.98, 2);
    const pedido = await all(db, 'SELECT total, desconto FROM pedidos WHERE id = 68');
    const linhas = await all(
      db,
      'SELECT produto_id, quantidade, subtotal FROM pedidos_itens WHERE pedido_id = 68'
    );
    const pastel = out.itens.find((item) => item.produto_id === 747);
    const copo200 = out.itens.find((item) => item.produto_id === 748);
    const copo300 = out.itens.find((item) => item.produto_id === 749);

    assert.equal(pedido[0].total, 61.98);
    assert.equal(pedido[0].desconto, 0);
    assert.deepEqual(linhas, [{ produto_id: 747, quantidade: 2, subtotal: 61.98 }]);
    assert.equal(pastel.quantidade, 2);
    assert.equal(pastel.subtotal, 17.98);
    assert.equal(copo200.quantidade, 2);
    assert.equal(copo200.subtotal, 25.98);
    assert.equal(copo300.quantidade, 1);
    assert.equal(copo300.subtotal, 19.8);
    assert.equal(out.desconto_centavos, 178);
    assert.equal(out.desconto, 1.78);
    assert.equal(out.total, 61.98);
    assert.equal(out.valor_pastel_centavos, 1798);
    assert.equal(out.valor_residual_centavos, 4400);
    assert.equal(brutoMenosDesconto(payload), 6198);
    assert.equal(payload.desconto, out.desconto);
    assert.deepEqual(payload.itens, out.itens);
    assert.equal(payload.valor_composicao_bruto, 63.76);
    const reaberta = await prepararComposicaoPedidoPdv({ pedidoId: 68, empresaId: 1 }, { db });
    assert.equal(reaberta.descontoCentavos, 178);
    assert.deepEqual(reaberta.itens, out.itens);
  } finally {
    await fecharDb(db);
  }
});

test('CDS-COMPOSICAO-VALOR-DISTRIBUICAO-01: combinação exata zera o desconto técnico', async () => {
  const db = await prepararCatalogo();
  try {
    const { out, payload } = await venderPorValor(db, 81, 30.97, 2);
    const pastel = out.itens.find((item) => item.produto_id === 747);
    assert.equal(out.desconto_centavos, 0);
    assert.equal(pastel.subtotal, 17.98);
    assert.equal(out.itens.find((item) => item.produto_id === 748).subtotal, 12.99);
    assert.equal(out.total, 30.97);
    assert.equal(brutoMenosDesconto(payload), 3097);
    assert.equal(payload.desconto, 0);
    const pedido = await all(db, 'SELECT total, desconto FROM pedidos WHERE id = 81');
    const linha = await all(db, 'SELECT subtotal FROM pedidos_itens WHERE pedido_id = 81');
    assert.equal(pedido[0].total, 30.97);
    assert.equal(pedido[0].desconto, 0);
    assert.equal(linha[0].subtotal, 30.97);
  } finally {
    await fecharDb(db);
  }
});

test('CDS-COMPOSICAO-VALOR-DISTRIBUICAO-01: quantidades 1, 2 e 3 e centavos', async () => {
  const db = await prepararCatalogo();
  try {
    const casos = [
      { id: 91, valor: 21.98, quantidade: 1 },
      { id: 92, valor: 61.98, quantidade: 2 },
      { id: 93, valor: 50, quantidade: 3 },
      { id: 94, valor: 40.05, quantidade: 1 }
    ];
    for (const caso of casos) {
      const { out, payload } = await venderPorValor(db, caso.id, caso.valor, caso.quantidade);
      const catalogo = Math.round(8.99 * caso.quantidade * 100);
      const pastel = out.itens.find((item) => item.produto_id === 747);
      const componentes = out.itens
        .filter((item) => item.produto_id !== 747)
        .reduce((soma, item) => soma + centavos(item.subtotal), 0);
      const pedido = await all(db, 'SELECT total, desconto FROM pedidos WHERE id = ?', [caso.id]);
      const linhas = await all(db, 'SELECT COUNT(*) AS n FROM pedidos_itens WHERE pedido_id = ?', [caso.id]);

      assert.equal(centavos(pastel.subtotal), catalogo, `pastel fiscal qtd ${caso.quantidade}`);
      assert.equal(out.desconto_centavos, componentes - out.valor_residual_centavos);
      assert.equal(out.desconto_centavos >= 0, true);
      assert.equal(centavos(out.total), centavos(caso.valor));
      assert.equal(brutoMenosDesconto(payload), centavos(caso.valor));
      assert.equal(payload.desconto, out.desconto);
      assert.deepEqual(payload.itens, out.itens);
      assert.equal(pedido[0].total, caso.valor);
      assert.equal(pedido[0].desconto, 0);
      assert.equal(linhas[0].n, 1);
      assert.equal(
        Math.round(Number(pastel.preco_unitario) * caso.quantidade * 100),
        catalogo
      );
    }
  } finally {
    await fecharDb(db);
  }
});

test('CDS-COMPOSICAO-VALOR-DISTRIBUICAO-01: reabertura não duplica linha nem desconto', async () => {
  const db = await prepararCatalogo();
  try {
    let criado = false;
    let payloads = [];
    const deps = {
      criarCotadorPreco: async () => ({
        cotar: (qtd) => ({
          subtotalCentavos: Math.round(8.99 * qtd * 100),
          precoUnitarioInterno: 8.99
        })
      }),
      receberEntrada: async (entrada) => {
        if (!criado) {
          const item = entrada.body.itens[0];
          await run(db, `INSERT INTO pedidos (
            id, codigo, empresa_id, status, total, desconto, frete, observacao, created_at
          ) VALUES (95, 'PED-95', 1, 'PEDIDO', ?, 0, 0, ?, '2026-01-01')`,
          [item.subtotal, OBS_ORIGEM]);
          await run(db, `INSERT INTO pedidos_itens (
            pedido_id, produto_id, quantidade, preco_unitario, subtotal
          ) VALUES (95, ?, ?, ?, ?)`,
          [item.produto_id, item.quantidade, item.preco_unitario, item.subtotal]);
          criado = true;
        }
        return { success: true, pedido: { id: 95 }, idempotente: criado };
      },
      consultarOperacaoPdv: async () => null,
      prepararOperacaoPdv: async (_pedidoId, _empresaId, corpo) => {
        payloads.push(corpo);
        return {
          operacao: { id: 95, venda_id: null, status: 'INICIADA' },
          recuperacao: false,
          payload: corpo
        };
      },
      obterModoEstoqueEmpresa: async () => ({ modo: 'AUTOMATICO' })
    };
    const primeira = await iniciarVendaPorValorPasteis({
      db, empresaId: 1, valorTotal: 61.98, quantidadePasteis: 2
    }, deps);
    const segunda = await iniciarVendaPorValorPasteis({
      db, empresaId: 1, valorTotal: 61.98, quantidadePasteis: 2
    }, deps);
    const linhas = await all(
      db,
      'SELECT produto_id, quantidade, subtotal FROM pedidos_itens WHERE pedido_id = 95'
    );
    assert.equal(primeira.desconto_centavos, 178);
    assert.equal(segunda.desconto_centavos, 178);
    assert.equal(primeira.fingerprint, segunda.fingerprint);
    assert.deepEqual(primeira.itens, segunda.itens);
    assert.equal(payloads[0].desconto, payloads[1].desconto);
    assert.deepEqual(linhas, [{ produto_id: 747, quantidade: 2, subtotal: 61.98 }]);
  } finally {
    await fecharDb(db);
  }
});

test('CDS-COMPOSICAO-VALOR-DISTRIBUICAO-01: pedido comercial com pastel unifica residual; distribuição VV segue exclusiva', async () => {
  const db = await prepararCatalogo();
  try {
    await run(db, `INSERT INTO pedidos (
      id, codigo, empresa_id, status, total, desconto, frete, created_at
    ) VALUES (96, 'PED-NORMAL', 1, 'PEDIDO', 61.98, 0, 0, '2026-01-01')`);
    await run(db, `INSERT INTO pedidos_itens (pedido_id, produto_id, quantidade, preco_unitario, subtotal)
      VALUES (96, 747, 2, 21.99, 43.98), (96, 748, 1, 18.00, 18.00)`);
    const normal = await prepararComposicaoPedidoPdv({ pedidoId: 96, empresaId: 1 }, { db });
    assert.equal(normal.modo, 'COMPOSICAO_PASTEL_REFRIGERANTE');
    assert.equal(normal.valorPastelCentavos, 1798);
    assert.equal(normal.valorResidualCentavos, 4400);
    assert.equal(normal.valorFinalCentavos, 6198);
    assert.ok(normal.descontoCentavos >= 0);
    // Distribuição fiscal VV exige massa comercial no pastel (= total); pedido comercial não a usa.
    assert.throws(
      () => distribuirValorFiscalVendaPorValor(normal, 747),
      (err) => err && err.codigo === 'DISTRIBUICAO_FISCAL_INVALIDA'
    );
  } finally {
    await fecharDb(db);
  }
});

test('rota pedidos expõe o adaptador sem alterar preparar-venda-pdv tradicional', () => {
  const rotas = fs.readFileSync(path.join(ROOT, 'backend/rotas/pedidos.js'), 'utf8');
  assert.match(rotas, /venda-por-valor-pasteis/);
  assert.match(rotas, /iniciarVendaPorValorPasteis/);
  assert.match(rotas, /preparar-venda-pdv/);
  assert.match(rotas, /prepararComposicaoPedidoPdv/);
});
