'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const FichaTecnicaService = require('../../backend/services/produtos/FichaTecnicaService');
const {
  garantirSchemaFichaTecnicaAsync
} = require('../../backend/services/produtos/fichaTecnicaSchema');
const {
  garantirConversaoInsumoSemReferencias,
  exigirProdutosVendaveisNaVenda,
  filtrarItensVendaveisPdv
} = require('../../backend/services/produtos/tipoOperacionalProduto');
const CatalogSnapshot = require('../../backend/motores/mib/catalog/CatalogSnapshot');

function source(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function openDb() {
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

async function main() {
  const db = await openDb();
  try {
    await run(db, `
      CREATE TABLE produtos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        codigo TEXT,
        nome TEXT NOT NULL,
        unidade TEXT,
        preco_compra REAL DEFAULT 0,
        preco_venda REAL DEFAULT 0,
        ativo INTEGER DEFAULT 1,
        tipo_operacional TEXT NOT NULL DEFAULT 'COMERCIAL'
      )
    `);
    await garantirSchemaFichaTecnicaAsync(db);
    await run(db, 'CREATE TABLE compras_itens (id INTEGER PRIMARY KEY, produto_id INTEGER)');
    await run(db, 'CREATE TABLE vendas_itens (id INTEGER PRIMARY KEY, produto_id INTEGER)');
    await run(db, 'CREATE TABLE produtos_ajustes_estoque (id INTEGER PRIMARY KEY, produto_id INTEGER)');
    await run(db, 'CREATE TABLE estoque_empresa (id INTEGER PRIMARY KEY, produto_id INTEGER)');

    const comercial = (await run(
      db,
      `INSERT INTO produtos (nome, unidade, preco_compra, preco_venda)
       VALUES ('Pastel de carne', 'UN', 2, 8)`
    )).lastID;
    const insumoFicha = (await run(
      db,
      `INSERT INTO produtos (codigo, nome, unidade, preco_compra, tipo_operacional)
       VALUES ('INS-1', 'Massa', 'KG', 4.5, 'INSUMO')`
    )).lastID;
    const insumoCompra = (await run(
      db,
      `INSERT INTO produtos (codigo, nome, unidade, preco_compra, tipo_operacional)
       VALUES ('INS-2', 'Farinha', 'KG', 5, 'INSUMO')`
    )).lastID;
    const insumoLivre = (await run(
      db,
      `INSERT INTO produtos (codigo, nome, unidade, preco_compra, tipo_operacional)
       VALUES ('INS-3', 'Óleo', 'L', 8, 'INSUMO')`
    )).lastID;
    const insumoComEstoque = (await run(
      db,
      `INSERT INTO produtos (codigo, nome, unidade, preco_compra, tipo_operacional)
       VALUES ('INS-4', 'Queijo', 'KG', 20, 'INSUMO')`
    )).lastID;

    const ficha = await FichaTecnicaService.salvar(comercial, {
      ativo: 1,
      itens: [{ insumo_id: insumoFicha, quantidade: 0.12, unidade: 'KG' }]
    }, { db });
    assert.strictEqual(Number(ficha.produto_id), comercial);
    await assert.rejects(
      () => FichaTecnicaService.salvar(insumoFicha, { itens: [] }, { db }),
      (err) => err.code === 'FICHA_SOMENTE_COMERCIAL'
    );
    await assert.rejects(
      () => garantirConversaoInsumoSemReferencias(db, insumoFicha),
      (err) => err.code === 'INSUMO_REFERENCIADO_NAO_CONVERSIVEL'
    );

    await run(
      db,
      'INSERT INTO compras_itens (produto_id) VALUES (?)',
      [insumoCompra]
    );
    await assert.rejects(
      () => garantirConversaoInsumoSemReferencias(db, insumoCompra),
      (err) => err.code === 'INSUMO_REFERENCIADO_NAO_CONVERSIVEL'
    );
    await run(db, 'INSERT INTO estoque_empresa (produto_id) VALUES (?)', [insumoComEstoque]);
    await assert.rejects(
      () => garantirConversaoInsumoSemReferencias(db, insumoComEstoque),
      (err) => err.code === 'INSUMO_REFERENCIADO_NAO_CONVERSIVEL'
    );
    await garantirConversaoInsumoSemReferencias(db, insumoLivre);

    const legados = await all(
      db,
      `SELECT id, COALESCE(tipo_operacional, 'COMERCIAL') AS tipo_operacional
       FROM produtos WHERE id = ?`,
      [comercial]
    );
    assert.strictEqual(legados[0].tipo_operacional, 'COMERCIAL');
    const listaComercial = await all(
      db,
      `SELECT id FROM produtos WHERE COALESCE(tipo_operacional, 'COMERCIAL') = 'COMERCIAL'`
    );
    const listaInsumos = await all(
      db,
      `SELECT id FROM produtos WHERE COALESCE(tipo_operacional, 'COMERCIAL') = 'INSUMO'`
    );
    assert.deepStrictEqual(listaComercial.map((item) => item.id), [comercial]);
    assert.deepStrictEqual(
      listaInsumos.map((item) => item.id).sort((a, b) => a - b),
      [insumoFicha, insumoCompra, insumoLivre, insumoComEstoque].sort((a, b) => a - b)
    );

    const snapshot = CatalogSnapshot.fromRows([
      { id: comercial, nome: 'Pastel', tipo_operacional: 'COMERCIAL' },
      { id: insumoFicha, nome: 'Massa', tipo_operacional: 'INSUMO' }
    ]);
    assert.strictEqual(snapshot.get(insumoFicha).tipo_operacional, 'INSUMO');
    assert.deepStrictEqual(
      filtrarItensVendaveisPdv(snapshot.lista).map((item) => item.id),
      [comercial]
    );
    assert.throws(
      () => exigirProdutosVendaveisNaVenda([{ id: insumoFicha, nome: 'Massa', tipo_operacional: 'INSUMO' }]),
      (err) => err.code === 'INSUMO_NAO_VENDAVEL'
    );

    const routes = source('backend/rotas/produtos.js');
    const erpNavigation = source('frontend/erp/index.html');
    const erpRouter = source('frontend/erp/js/app.js');
    const access = source('frontend/shared/js/access-control.js');
    const productUi = source('frontend/erp/js/produtos.js');
    const pageShell = source('frontend/shared/js/cds-page-shell.js');
    assert.ok(routes.includes("COALESCE(p.tipo_operacional, 'COMERCIAL') = ?"));
    assert.ok(routes.includes("router.put('/:id/ativacao'"));
    assert.ok(routes.includes('garantirConversaoInsumoSemReferencias'));
    assert.ok(routes.includes('imagemPrincipalGravar,\n    tipoOperacionalGravar'));
    assert.ok(erpNavigation.includes('data-page="insumos"'));
    assert.ok(erpRouter.includes("case 'insumos':"));
    assert.ok(access.includes("insumos: 'produtos'"));
    assert.ok(pageShell.includes("insumos: { grupo: 'Suprimentos'"));
    assert.ok(productUi.includes('tipo_operacional=INSUMO'));
    assert.ok(productUi.includes('alterarStatusInsumo'));
    assert.ok(source('backend/services/vendas/VendaPagamentoService.js')
      .includes('exigirProdutosVendaveisNaVenda'));
    assert.ok(source('backend/rotas/produtos.js').includes('/consulta-pdv/buscar'));

    console.log('Separação produtos/insumos OK — banco SQLite em memória.');
  } finally {
    await new Promise((resolve) => db.close(resolve));
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
