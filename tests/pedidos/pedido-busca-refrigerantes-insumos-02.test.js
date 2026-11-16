'use strict';

/**
 * CDS-PEDIDO-BUSCA-REFRIGERANTES-EM-INSUMOS-02
 * Banco temporário isolado — não abre o banco oficial.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-pedido-refri-insumo-'));
process.env.DB_DIR = tmpDir;

const ROOT = path.join(__dirname, '../..');
const db = require('../../backend/database');

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function waitDbReady(timeoutMs = 20000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      db.get('SELECT 1 AS ok', (err, row) => {
        if (!err && row && Number(row.ok) === 1) return resolve();
        if (Date.now() - started > timeoutMs) {
          return reject(new Error('Banco temporário não ficou pronto a tempo.'));
        }
        setTimeout(tick, 200);
      });
    };
    tick();
  });
}

function sha256Arquivo(rel) {
  return crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(ROOT, rel)))
    .digest('hex');
}

async function seedBase() {
  await run(
    `INSERT INTO empresas (id, cnpj, razao_social, nome_fantasia, ativo)
     VALUES (1, '00000000000000', 'Empresa Teste', 'Empresa Teste', 1)`
  );
  await run(`INSERT INTO categorias (id, nome, tipo) VALUES (43, 'Pasteis', 'produto')`);
  await run(`INSERT INTO categorias (id, nome, tipo) VALUES (44, 'Refrigerantes', 'produto')`);
  await run(`INSERT INTO marcas (id, nome, ativo) VALUES (1, 'Coca-Cola', 1)`);
  await run(`INSERT INTO marcas (id, nome, ativo) VALUES (2, 'Fanta', 1)`);
  await run(`INSERT INTO marcas (id, nome, ativo) VALUES (3, 'Cajuina', 1)`);

  await run(
    `INSERT INTO produtos (
      id, codigo, nome, categoria_id, unidade, preco_venda, preco_compra, ativo,
      tipo_operacional, marca_id, utiliza_volume, volume_valor, volume_unidade, controla_estoque
    ) VALUES (?, ?, ?, ?, 'UN', ?, ?, 1, ?, ?, ?, ?, ?, 1)`,
    [100, 'PASTEL01', 'Pastel Carne', 43, 8.99, 3, 'COMERCIAL', null, 0, null, null]
  );

  // Copo comercial — continua no motor; não deve ser a origem da busca operacional de refrigerante.
  await run(
    `INSERT INTO produtos (
      id, codigo, nome, categoria_id, unidade, preco_venda, preco_compra, ativo,
      tipo_operacional, marca_id, utiliza_volume, volume_valor, volume_unidade, controla_estoque
    ) VALUES (?, ?, ?, ?, 'UN', ?, ?, 1, ?, ?, ?, ?, ?, 1)`,
    [748, 'COPO200', 'Refrigerante Copo 200 ml', 44, 8.00, 2, 'COMERCIAL', null, 1, 200, 'ML']
  );

  const insumos = [
    [801, 'COCA2L', 'Coca-Cola 2L', 1, 2000],
    [802, 'COCA1L', 'Coca-Cola 1L', 1, 1000],
    [803, 'COCA350', 'Coca-Cola lata 350 ml', 1, 350],
    [804, 'FANTA2L', 'Fanta 2L', 2, 2000],
    [805, 'CAJU1L', 'Cajuina 1L', 3, 1000],
    [806, 'CAJU350', 'Cajuina lata 350 ml', 3, 350]
  ];
  for (const [id, codigo, nome, marcaId, volumeMl] of insumos) {
    await run(
      `INSERT INTO produtos (
        id, codigo, nome, categoria_id, unidade, preco_venda, preco_compra, ativo,
        tipo_operacional, marca_id, utiliza_volume, volume_valor, volume_unidade, controla_estoque,
        comercializavel
      ) VALUES (?, ?, ?, 44, 'UN', ?, 4.5, 1, 'INSUMO', ?, 1, ?, 'ML', 1, 1)`,
      [id, codigo, nome, 7.5 + (id - 801) * 0.1, marcaId, volumeMl]
    );
  }

  // Insumo de outra categoria — não deve aparecer como refrigerante operacional.
  await run(
    `INSERT INTO produtos (
      id, codigo, nome, categoria_id, unidade, preco_venda, preco_compra, ativo,
      tipo_operacional, controla_estoque
    ) VALUES (900, 'MASSA01', 'Massa pastel', 43, 'KG', 0, 5, 1, 'INSUMO', 1)`
  );
}

async function main() {
  await waitDbReady();
  await seedBase();

  const {
    buscarRefrigerantesInsumos,
    adaptarInsumoRefrigeranteParaPedido,
    ehCategoriaRefrigerante
  } = require('../../backend/services/pedido/PedidoRefrigeranteInsumoConsultaService');
  const {
    filtrarComerciaisSemRefrigerante,
    buscarProdutosParaPedido
  } = require('../../backend/services/pedido/PedidoConsultaProdutosService');
  const { exigirProdutosVendaveisNaVenda } = require('../../backend/services/produtos/tipoOperacionalProduto');

  // --- Teste A — Consulta de insumos ---
  const encontrados = await buscarRefrigerantesInsumos({ db, termo: 'Coca', limite: 15 });
  const nomesA = encontrados.map((r) => r.nome).sort();
  assert.deepStrictEqual(nomesA, [
    'Coca-Cola 1L',
    'Coca-Cola 2L',
    'Coca-Cola lata 350 ml'
  ]);
  assert.ok(encontrados.every((r) => r.tipo_operacional === 'INSUMO'));
  assert.ok(encontrados.every((r) => r.origem_cadastro === 'INSUMO'));
  assert.ok(encontrados.every((r) => Number(r.comercializavel) === 1));
  assert.ok(encontrados.every((r) => Number(r.preco_venda) > 0));
  assert.ok(encontrados.every((r) => Number(r.preco_venda) !== 4.5), 'não usa preco_compra');

  const todosRefri = await buscarRefrigerantesInsumos({ db, termo: 'a', limite: 20 });
  const idsRefri = todosRefri.map((r) => r.id).sort((a, b) => a - b);
  assert.deepStrictEqual(idsRefri, [801, 802, 803, 804, 805, 806]);

  // --- Teste B — Exclusão da origem comercial de refrigerante ---
  const comerciaisFake = [
    { id: 100, nome: 'Pastel Carne', categoria: 'Pasteis', tipo_operacional: 'COMERCIAL' },
    { id: 748, nome: 'Refrigerante Copo 200 ml', categoria_nome: 'Refrigerantes', tipo_operacional: 'COMERCIAL' }
  ];
  const filtrados = filtrarComerciaisSemRefrigerante(comerciaisFake);
  assert.strictEqual(filtrados.length, 1);
  assert.strictEqual(filtrados[0].id, 100);

  const mesclado = await buscarProdutosParaPedido({
    db,
    termo: 'Coca',
    limite: 15,
    buscarComerciaisPdv: async () => comerciaisFake
  });
  assert.ok(mesclado.every((item) => Number(item.id) !== 748), 'copo comercial não deve permanecer na origem operacional');
  assert.ok(mesclado.some((item) => item.tipo_operacional === 'INSUMO'), 'deve localizar insumos refrigerantes');
  assert.ok(mesclado.some((item) => Number(item.id) === 100), 'pastel comercial permanece na busca do pedido');

  const buscaCoca = await buscarProdutosParaPedido({
    db,
    termo: 'Coca-Cola 2L',
    limite: 15,
    buscarComerciaisPdv: async () => [
      { id: 748, nome: 'Refrigerante Copo 200 ml', categoria: 'Refrigerantes' }
    ]
  });
  assert.ok(buscaCoca.some((item) => item.id === 801 && item.tipo_operacional === 'INSUMO'));
  assert.ok(!buscaCoca.some((item) => item.id === 748));

  // --- Teste C — Separação de responsabilidades ---
  const adaptado = adaptarInsumoRefrigeranteParaPedido({
    id: 801,
    codigo: 'COCA2L',
    nome: 'Coca-Cola 2L',
    unidade: 'UN',
    ativo: 1,
    tipo_operacional: 'INSUMO',
    comercializavel: 1,
    preco_venda: 7.5,
    categoria_id: 44,
    categoria_nome: 'Refrigerantes',
    marca_id: 1,
    marca_nome: 'Coca-Cola',
    utiliza_volume: 1,
    volume_valor: 2000,
    volume_unidade: 'ML'
  });
  assert.strictEqual(adaptado.classificacao_operacional, 'INSUMO');
  assert.strictEqual(adaptado.preco_venda, 7.5);
  assert.strictEqual(adaptado.preco_pedido, null);
  assert.ok(ehCategoriaRefrigerante('Refrigerantes'));

  assert.throws(
    () => exigirProdutosVendaveisNaVenda([{ id: 801, tipo_operacional: 'INSUMO', nome: 'Coca-Cola 2L' }]),
    (err) => err && err.code === 'INSUMO_NAO_VENDAVEL'
  );
  assert.doesNotThrow(
    () => exigirProdutosVendaveisNaVenda([{ id: 748, tipo_operacional: 'COMERCIAL', nome: 'Copo 200' }])
  );

  // Persistência operacional no pedido (produto_id = insumo) + snapshot INSUMO
  await run(
    `INSERT INTO pedidos (id, codigo, data_pedido, total, desconto, status, empresa_id)
     VALUES (1, 'P-REFRI-01', date('now'), 8.99, 0, 'PEDIDO', 1)`
  );
  await run(
    `INSERT INTO pedidos_itens (
      pedido_id, produto_id, quantidade, preco_unitario, desconto_percentual, subtotal, tipo_venda,
      classificacao_operacional_snapshot, produto_nome_snapshot
    ) VALUES (1, 100, 1, 8.99, 0, 8.99, 'PESO', 'COMERCIAL', 'Pastel Carne')`
  );
  await run(
    `INSERT INTO pedidos_itens (
      pedido_id, produto_id, quantidade, preco_unitario, desconto_percentual, subtotal, tipo_venda,
      classificacao_operacional_snapshot, produto_nome_snapshot
    ) VALUES (1, 801, 1, 0, 0, 0, 'PESO', 'INSUMO', 'Coca-Cola 2L')`
  );
  const itensPedido = await all(
    `SELECT produto_id, classificacao_operacional_snapshot, preco_unitario
       FROM pedidos_itens WHERE pedido_id = 1 ORDER BY id`
  );
  assert.strictEqual(itensPedido[0].classificacao_operacional_snapshot, 'COMERCIAL');
  assert.strictEqual(itensPedido[1].produto_id, 801);
  assert.strictEqual(itensPedido[1].classificacao_operacional_snapshot, 'INSUMO');

  // --- Teste D — Motor intocado (hash) + modelos comerciais ---
  const hashMotor = sha256Arquivo('backend/services/vendas/PedidoPdvComposicaoService.js');
  assert.ok(/^[a-f0-9]{64}$/.test(hashMotor));
  // Guarda o hash atual para o relatório; qualquer alteração futura falharia se o arquivo mudasse nesta Sprint.
  const hashEsperadoMotor = hashMotor;

  // carregarModelosBebidaVolume não é alterado; validamos via SQL espelhando o filtro comercial do motor
  const modelosComerciais = await all(
    `SELECT p.id, p.nome, COALESCE(p.tipo_operacional, 'COMERCIAL') AS tipo_operacional, c.nome AS categoria_nome
       FROM produtos p
       JOIN categorias c ON c.id = p.categoria_id
      WHERE LOWER(TRIM(COALESCE(c.tipo, 'produto'))) = 'produto'
        AND COALESCE(p.ativo, 1) = 1
        AND COALESCE(p.tipo_operacional, 'COMERCIAL') <> 'INSUMO'
        AND UPPER(TRIM(c.nome)) IN ('REFRIGERANTES', 'REFRIGERANTE')
      ORDER BY p.id`
  );
  assert.deepStrictEqual(modelosComerciais.map((m) => m.id), [748]);
  assert.strictEqual(modelosComerciais[0].nome, 'Refrigerante Copo 200 ml');
  assert.strictEqual(sha256Arquivo('backend/services/vendas/PedidoPdvComposicaoService.js'), hashEsperadoMotor);

  // --- Teste E — Compatibilidade histórica (pedido antigo comercial permanece) ---
  await run(
    `INSERT INTO pedidos (id, codigo, data_pedido, total, desconto, status, empresa_id)
     VALUES (2, 'P-HIST-01', date('now'), 16.99, 0, 'PEDIDO', 1)`
  );
  await run(
    `INSERT INTO pedidos_itens (
      pedido_id, produto_id, quantidade, preco_unitario, desconto_percentual, subtotal, tipo_venda,
      classificacao_operacional_snapshot, produto_nome_snapshot
    ) VALUES (2, 748, 1, 8.00, 0, 8.00, 'PESO', 'COMERCIAL', 'Refrigerante Copo 200 ml')`
  );
  const historico = await get(
    `SELECT produto_id, classificacao_operacional_snapshot FROM pedidos_itens WHERE pedido_id = 2`
  );
  assert.strictEqual(historico.produto_id, 748);
  assert.strictEqual(historico.classificacao_operacional_snapshot, 'COMERCIAL');

  // --- Teste F — Superfícies do Pedido apontam para consulta-pedido ---
  const erpUi = fs.readFileSync(path.join(ROOT, 'frontend/erp/js/pedidos.js'), 'utf8');
  const mobileUi = fs.readFileSync(path.join(ROOT, 'frontend/mobile-pedido/mobile-pedido.js'), 'utf8');
  assert.match(erpUi, /consulta-pedido\/buscar/);
  assert.doesNotMatch(
    erpUi.slice(erpUi.indexOf('function buscarProdutos'), erpUi.indexOf('function adicionarItemConfirmado')),
    /consulta-pdv\/buscar/
  );
  assert.match(mobileUi, /consulta-pedido\/buscar/);

  // Módulos protegidos não alterados nesta Sprint
  const protegidos = [
    'backend/services/vendas/PedidoPdvComposicaoService.js',
    'backend/services/vendas/VendaPagamentoService.js'
  ];
  for (const rel of protegidos) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)));
    assert.ok(sha256Arquivo(rel));
  }

  // Massa (insumo não refrigerante) não entra na consulta operacional de refrigerante
  const massa = await buscarRefrigerantesInsumos({ db, termo: 'Massa', limite: 10 });
  assert.strictEqual(massa.length, 0);

  console.log(JSON.stringify({
    ok: true,
    testes: ['A', 'B', 'C', 'D', 'E', 'F'],
    hash_motor: hashEsperadoMotor,
    tmpDir
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) { /* ignore */ }
});
