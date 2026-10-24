'use strict';

// Auditoria multiempresa: a composição fiscal é parametrizada por empresaId e não tem limite de empresas.
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
const Composicao = require('../../backend/services/vendas/ComposicaoFiscalPedidoService');

const CNPJS = ['11222333000181', '04252011000110', '11444777000161', '45997418000153'];

function abrirDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID });
    });
  });
}

function fecharDb(db) {
  return new Promise((resolve, reject) => db.close((err) => (err ? reject(err) : resolve())));
}

async function criarSchema(db) {
  await run(db, 'PRAGMA foreign_keys = ON');
  await garantirSchemaEmpresasAsync(db);
  await run(db, `CREATE TABLE produtos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT, nome TEXT NOT NULL, unidade TEXT,
    preco_venda REAL NOT NULL, ativo INTEGER DEFAULT 1, tipo_operacional TEXT DEFAULT 'COMERCIAL',
    utiliza_volume INTEGER DEFAULT 0, volume_valor REAL, volume_unidade TEXT, estoque_atual REAL DEFAULT 0,
    preco_unidade REAL, permite_venda_unidade INTEGER DEFAULT 0, produto_fracionado INTEGER DEFAULT 0,
    vendido_por_peso INTEGER DEFAULT 0, venda_atacado INTEGER DEFAULT 0, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
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
    id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT, data_pedido TEXT NOT NULL, cliente_id INTEGER,
    total REAL NOT NULL, desconto REAL DEFAULT 0, frete REAL DEFAULT 0, status TEXT NOT NULL,
    empresa_id INTEGER NOT NULL, venda_id INTEGER, operador_id INTEGER, representante_id INTEGER,
    representante_nome TEXT, observacao TEXT, created_at TEXT, updated_at TEXT
  )`);
  await run(db, `CREATE TABLE pedidos_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT, pedido_id INTEGER NOT NULL, produto_id INTEGER NOT NULL,
    quantidade REAL NOT NULL, preco_unitario REAL NOT NULL, desconto_percentual REAL DEFAULT 0,
    subtotal REAL NOT NULL, tipo_venda TEXT DEFAULT 'UN', classificacao_operacional_snapshot TEXT,
    produto_codigo_snapshot TEXT, produto_nome_snapshot TEXT, produto_unidade_snapshot TEXT
  )`);
}

async function criarProduto(db, nome, preco, volume) {
  const r = await run(
    db,
    `INSERT INTO produtos (nome, unidade, preco_venda, ativo, tipo_operacional, utiliza_volume,
       volume_valor, volume_unidade, utiliza_conversao, unidade_estoque)
     VALUES (?, 'UN', ?, 1, 'COMERCIAL', ?, ?, ?, 0, NULL)`,
    [nome, preco, volume ? 1 : 0, volume ? 1000 : null, volume ? 'ML' : null]
  );
  return r.lastID;
}

async function criarPedido(db, empresaId, pastel, outro) {
  const p = await run(
    db,
    `INSERT INTO pedidos (codigo, data_pedido, total, desconto, frete, status, empresa_id)
     VALUES (?, '2026-10-21', 61.98, 0, 0, 'PEDIDO', ?)`,
    [`PED-MULTI-${empresaId}`, empresaId]
  );
  const ins = `INSERT INTO pedidos_itens
    (pedido_id, produto_id, quantidade, preco_unitario, desconto_percentual, subtotal, tipo_venda)
    VALUES (?, ?, ?, ?, 0, ?, 'UN')`;
  await run(db, ins, [p.lastID, pastel, 2, 21.99, 43.98]);
  await run(db, ins, [p.lastID, outro, 1, 18, 18]);
  return p.lastID;
}

async function abrirSaldo(db, empresaId, categoria, ml) {
  await SaldoFiscalCategoriaService.garantirSaldo({ empresaId, categoriaFiscal: categoria }, { db });
  await SaldoFiscalCategoriaService.registrarAbertura({
    empresaId,
    categoriaFiscal: categoria,
    quantidadeMl: ml,
    usuarioId: 1,
    motivo: 'Abertura sintética para teste isolado',
    referencia: { tipo: 'TESTE', id: `${empresaId}-${categoria}` },
    idempotencyKey: `abertura-${empresaId}-${categoria}`,
    confirmado: true
  }, { db });
}

test('composição fiscal opera com 3 ou mais empresas, cada uma com seu contexto, saldo e modelo', async () => {
  const db = await abrirDb();
  try {
    await criarSchema(db);
    const pastel = await criarProduto(db, 'Pastel do Chef', 8.99, null);
    const operacional = await criarProduto(db, 'Item operacional', 18, null);

    const empresas = [];
    for (let i = 0; i < CNPJS.length; i += 1) {
      const emp = await EmpresaService.criarEmpresa(
        { cnpj: CNPJS[i], razao_social: `Empresa multiempresa ${i + 1}` },
        { db }
      );
      empresas.push(emp.id);
    }
    assert.equal(new Set(empresas).size, 4);

    // Empresas 1..3 têm modelo próprio e saldo próprio; a 4ª não tem vínculo nem saldo.
    const precosModelo = [22, 11, 44];
    const modelos = [];
    const pedidos = [];
    for (let i = 0; i < 3; i += 1) {
      const modelo = await criarProduto(db, `Modelo empresa ${i + 1}`, precosModelo[i], true);
      await CategoriaFiscalEmpresaService.definirVinculo({
        empresaId: empresas[i], produtoId: modelo, categoriaFiscal: 'REFRIGERANTE', elegivelComposicao: true
      }, { db });
      await abrirSaldo(db, empresas[i], 'REFRIGERANTE', 10000);
      modelos.push(modelo);
    }
    for (const empresaId of empresas) pedidos.push(await criarPedido(db, empresaId, pastel, operacional));

    for (let i = 0; i < 3; i += 1) {
      const out = await Composicao.simularComposicao({
        empresaId: empresas[i],
        pedidoId: pedidos[i],
        itensFixos: [{ produtoId: pastel, quantidade: 2 }]
      }, { db });
      assert.equal(out.empresaId, empresas[i]);
      assert.equal(out.valorComposicaoCentavos, 6198);
      assert.equal(out.efeitosOperacionais, false);
      assert.deepEqual(out.itensCompostos.map((it) => it.produtoId), [modelos[i]]);
    }

    await assert.rejects(Composicao.simularComposicao({
      empresaId: empresas[3],
      pedidoId: pedidos[3],
      itensFixos: [{ produtoId: pastel, quantidade: 2 }]
    }, { db }), (err) => {
      assert.equal(err.code, 'MODELOS_FISCAIS_INSUFICIENTES');
      return true;
    });

    await assert.rejects(Composicao.simularComposicao({
      empresaId: empresas[2],
      pedidoId: pedidos[0],
      itensFixos: [{ produtoId: pastel, quantidade: 2 }]
    }, { db }), (err) => {
      assert.equal(err.code, 'PEDIDO_EMPRESA_DIVERGENTE');
      return true;
    });
  } finally {
    await fecharDb(db);
  }
});
