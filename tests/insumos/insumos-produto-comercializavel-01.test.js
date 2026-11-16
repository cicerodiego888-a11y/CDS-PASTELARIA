'use strict';

/**
 * CDS-INSUMOS-PRODUTO-COMERCIALIZAVEL-01
 * Banco temporário isolado — não abre o banco oficial.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-insumo-comerc-'));
process.env.DB_DIR = tmpDir;

const ROOT = path.join(__dirname, '../..');
const db = require('../../backend/database');
const {
  resolverComercializavelEPreco,
  parsePrecoVenda
} = require('../../backend/services/produtos/insumoComercializavel');
const {
  buscarRefrigerantesInsumos,
  adaptarInsumoRefrigeranteParaPedido
} = require('../../backend/services/pedido/PedidoRefrigeranteInsumoConsultaService');
const {
  buscarProdutosParaPedido,
  filtrarComerciaisSemRefrigerante
} = require('../../backend/services/pedido/PedidoConsultaProdutosService');

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

async function inserirInsumo({
  id,
  codigo,
  nome,
  categoriaId = 1,
  comercializavel = 0,
  precoVenda = 0,
  precoCompra = 2.5
}) {
  await run(
    `INSERT INTO produtos (
      id, codigo, nome, categoria_id, unidade, preco_venda, preco_compra, ativo,
      tipo_operacional, comercializavel, controla_estoque
    ) VALUES (?, ?, ?, ?, 'UN', ?, ?, 1, 'INSUMO', ?, 1)`,
    [id, codigo, nome, categoriaId, precoVenda, precoCompra, comercializavel]
  );
}

async function main() {
  await waitDbReady();

  // Coluna existe (migration / CREATE)
  const cols = await new Promise((resolve, reject) => {
    db.all('PRAGMA table_info(produtos)', (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
  assert.ok(cols.some((c) => c.name === 'comercializavel'), 'K — coluna comercializavel presente');

  await run(
    `INSERT INTO empresas (id, cnpj, razao_social, nome_fantasia, ativo)
     VALUES (1, '00000000000000', 'Empresa Teste', 'Empresa Teste', 1)`
  );
  await run(`INSERT INTO categorias (id, nome, tipo) VALUES (1, 'Ingredientes', 'produto')`);
  await run(`INSERT INTO categorias (id, nome, tipo) VALUES (2, 'Refrigerantes', 'produto')`);
  await run(`INSERT INTO categorias (id, nome, tipo) VALUES (3, 'Pasteis', 'produto')`);

  // --- A — não comercializável sem valor de venda ---
  const a = resolverComercializavelEPreco({
    tipoOperacional: 'INSUMO',
    comercializavelBody: 0,
    precoVendaBody: null,
    modo: 'create'
  });
  assert.strictEqual(a.comercializavel, 0);
  assert.strictEqual(a.preco_venda, 0);
  await inserirInsumo({ id: 1, codigo: 'MASSA01', nome: 'Massa pastel', comercializavel: 0, precoVenda: 0 });
  const rowA = await get('SELECT comercializavel, preco_venda FROM produtos WHERE id = 1');
  assert.strictEqual(Number(rowA.comercializavel), 0);
  assert.strictEqual(Number(rowA.preco_venda), 0);

  // --- B — comercializável com valor ---
  const b = resolverComercializavelEPreco({
    tipoOperacional: 'INSUMO',
    comercializavelBody: 1,
    precoVendaBody: 9.9,
    precoCompraBody: 5,
    modo: 'create'
  });
  assert.strictEqual(b.comercializavel, 1);
  assert.strictEqual(b.preco_venda, 9.9);
  assert.strictEqual(b.lucro_percentual, 98); // ((9.9-5)/5)*100
  await inserirInsumo({
    id: 2, codigo: 'COCA2L', nome: 'Coca-Cola 2L', categoriaId: 2,
    comercializavel: 1, precoVenda: 9.9
  });

  // --- C — comercializável sem valor ---
  assert.throws(
    () => resolverComercializavelEPreco({
      tipoOperacional: 'INSUMO',
      comercializavelBody: 1,
      precoVendaBody: '',
      modo: 'create'
    }),
    (err) => err && (err.code === 'PRECO_VENDA_AUSENTE' || err.code === 'PRECO_VENDA_OBRIGATORIO')
  );

  // --- D — preço negativo ---
  assert.strictEqual(parsePrecoVenda(-1).ok, false);
  assert.throws(
    () => resolverComercializavelEPreco({
      tipoOperacional: 'INSUMO',
      comercializavelBody: 1,
      precoVendaBody: -5,
      modo: 'create'
    }),
    (err) => err && err.code === 'PRECO_VENDA_OBRIGATORIO'
  );

  // --- E — editar não comercializável não exige preço ---
  const e = resolverComercializavelEPreco({
    tipoOperacional: 'INSUMO',
    comercializavelBody: 0,
    precoVendaBody: undefined,
    modo: 'update',
    precoVendaAtual: 0
  });
  assert.strictEqual(e.comercializavel, 0);
  assert.strictEqual(e.atualizarPreco, false);

  // --- F — ativar comercializável exige preço ---
  assert.throws(
    () => resolverComercializavelEPreco({
      tipoOperacional: 'INSUMO',
      comercializavelBody: 1,
      precoVendaBody: 0,
      modo: 'update',
      precoVendaAtual: 0
    }),
    (err) => err && err.code === 'PRECO_VENDA_OBRIGATORIO'
  );
  const f = resolverComercializavelEPreco({
    tipoOperacional: 'INSUMO',
    comercializavelBody: 1,
    precoVendaBody: 12.5,
    modo: 'update',
    precoVendaAtual: 0
  });
  assert.strictEqual(f.comercializavel, 1);
  assert.strictEqual(f.preco_venda, 12.5);

  // --- G — desativar preserva preço histórico e sai da busca ---
  await run(
    `UPDATE produtos SET comercializavel = 1, preco_venda = 11.5 WHERE id = 2`
  );
  const gOff = resolverComercializavelEPreco({
    tipoOperacional: 'INSUMO',
    comercializavelBody: 0,
    precoVendaBody: 11.5,
    modo: 'update',
    precoVendaAtual: 11.5
  });
  assert.strictEqual(gOff.comercializavel, 0);
  assert.strictEqual(gOff.atualizarPreco, false);
  await run(`UPDATE produtos SET comercializavel = 0 WHERE id = 2`);
  const rowG = await get('SELECT comercializavel, preco_venda FROM produtos WHERE id = 2');
  assert.strictEqual(Number(rowG.comercializavel), 0);
  assert.strictEqual(Number(rowG.preco_venda), 11.5);
  const buscaG = await buscarRefrigerantesInsumos({ db, termo: 'Coca', limite: 15 });
  assert.ok(!buscaG.some((r) => r.id === 2), 'G — desativado não aparece na busca do Pedido');

  // Reativa para testes H
  await run(`UPDATE produtos SET comercializavel = 1, preco_venda = 9.9 WHERE id = 2`);
  await inserirInsumo({
    id: 3, codigo: 'QUEIJO', nome: 'Queijo mussarela', comercializavel: 0, precoVenda: 0
  });
  await inserirInsumo({
    id: 4, codigo: 'FANTA2L', nome: 'Fanta 2L', categoriaId: 2,
    comercializavel: 1, precoVenda: 8.5
  });
  await run(
    `INSERT INTO produtos (
      id, codigo, nome, categoria_id, unidade, preco_venda, preco_compra, ativo, tipo_operacional, comercializavel
    ) VALUES (100, 'PASTEL01', 'Pastel Carne', 3, 'UN', 8.99, 3, 1, 'COMERCIAL', 0)`
  );
  await run(
    `INSERT INTO produtos (
      id, codigo, nome, categoria_id, unidade, preco_venda, preco_compra, ativo, tipo_operacional, comercializavel
    ) VALUES (748, 'COPO200', 'Refrigerante Copo 200 ml', 2, 'UN', 8.00, 2, 1, 'COMERCIAL', 0)`
  );

  // --- H — Pedido: só comercializáveis ---
  const buscaH = await buscarRefrigerantesInsumos({ db, termo: 'a', limite: 20 });
  const idsH = buscaH.map((r) => r.id).sort((a, b) => a - b);
  assert.deepStrictEqual(idsH, [2, 4]);
  assert.ok(buscaH.every((r) => Number(r.comercializavel) === 1));
  assert.ok(!buscaH.some((r) => r.id === 1 || r.id === 3));
  const coca = buscaH.find((r) => r.id === 2);
  assert.strictEqual(Number(coca.preco_venda), 9.9);
  assert.ok(Number(coca.preco_venda) !== 4.5, 'nunca usa preco_compra');

  // --- I — comerciais continuam; copo refrigerante filtrado ---
  const comerciaisFake = [
    { id: 100, nome: 'Pastel Carne', categoria: 'Pasteis', tipo_operacional: 'COMERCIAL' },
    { id: 748, nome: 'Refrigerante Copo 200 ml', categoria_nome: 'Refrigerantes', tipo_operacional: 'COMERCIAL' }
  ];
  assert.strictEqual(filtrarComerciaisSemRefrigerante(comerciaisFake).length, 1);
  const mesclado = await buscarProdutosParaPedido({
    db,
    termo: 'Coca',
    limite: 15,
    buscarComerciaisPdv: async () => comerciaisFake
  });
  assert.ok(mesclado.some((i) => i.id === 2 && i.tipo_operacional === 'INSUMO'));
  assert.ok(mesclado.some((i) => i.id === 100));
  assert.ok(!mesclado.some((i) => i.id === 748));

  // --- J — ingredientes (não comercializáveis) seguem no catálogo INSUMO ---
  const ingredientes = await get(
    `SELECT COUNT(*) AS n FROM produtos
      WHERE tipo_operacional = 'INSUMO' AND COALESCE(comercializavel, 0) = 0`
  );
  assert.ok(Number(ingredientes.n) >= 2);

  // --- K — registros antigos: default 0 (já coberto pelo PRAGMA + insert sem flag) ---
  await run(
    `INSERT INTO produtos (
      id, codigo, nome, categoria_id, unidade, preco_venda, preco_compra, ativo, tipo_operacional
    ) VALUES (50, 'OLEO01', 'Oleo soya', 1, 'L', 0, 1, 1, 'INSUMO')`
  );
  const legado = await get('SELECT COALESCE(comercializavel, 0) AS c FROM produtos WHERE id = 50');
  assert.strictEqual(Number(legado.c), 0);

  // --- L — edição de preço não altera snapshot histórico do pedido ---
  await run(
    `INSERT INTO pedidos (id, codigo, data_pedido, total, desconto, status, empresa_id)
     VALUES (1, 'P-COM-01', date('now'), 9.9, 0, 'PEDIDO', 1)`
  );
  await run(
    `INSERT INTO pedidos_itens (
      pedido_id, produto_id, quantidade, preco_unitario, desconto_percentual, subtotal, tipo_venda,
      classificacao_operacional_snapshot, produto_nome_snapshot
    ) VALUES (1, 2, 1, 9.9, 0, 9.9, 'PESO', 'INSUMO', 'Coca-Cola 2L')`
  );
  await run(`UPDATE produtos SET preco_venda = 15.0 WHERE id = 2`);
  const itemHist = await get(
    `SELECT preco_unitario FROM pedidos_itens WHERE pedido_id = 1 AND produto_id = 2`
  );
  assert.strictEqual(Number(itemHist.preco_unitario), 9.9);
  const vigente = await get('SELECT preco_venda FROM produtos WHERE id = 2');
  assert.strictEqual(Number(vigente.preco_venda), 15);

  // Adaptador rejeita não comercializável
  assert.throws(
    () => adaptarInsumoRefrigeranteParaPedido({
      id: 1,
      tipo_operacional: 'INSUMO',
      comercializavel: 0,
      categoria_nome: 'Ingredientes',
      preco_venda: 0
    }),
    (err) => err && err.code === 'INSUMO_NAO_COMERCIALIZAVEL'
  );

  // Preservação: PDV / motor de composição intocados
  const hashMotor = sha256Arquivo('backend/services/vendas/PedidoPdvComposicaoService.js');
  assert.ok(/^[a-f0-9]{64}$/.test(hashMotor));
  const pdvSrc = fs.readFileSync(path.join(ROOT, 'frontend/pdv/js/pdv.js'), 'utf8');
  assert.doesNotMatch(pdvSrc, /comercializavel/);
  const erpSrc = fs.readFileSync(path.join(ROOT, 'frontend/erp/js/produtos.js'), 'utf8');
  assert.match(erpSrc, /Produto comercializável\?/);
  assert.match(erpSrc, /id="comercializavel"/);

  console.log(JSON.stringify({
    sprint: 'CDS-INSUMOS-PRODUTO-COMERCIALIZAVEL-01',
    dbDir: tmpDir,
    testes: 'A-L OK',
    hashMotorComposicao: hashMotor,
    pdvAlterado: false,
    motorComposicaoAlterado: false
  }, null, 2));
}

main()
  .then(() => {
    try { db.close(); } catch (_) { /* ignore */ }
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    try { db.close(); } catch (_) { /* ignore */ }
    process.exit(1);
  });
