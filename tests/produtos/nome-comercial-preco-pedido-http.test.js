'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-nome-preco-http-'));
process.env.DB_DIR = dbDir;
process.env.JWT_SECRET = 'test-only-produto-campos-secret';

const db = require('../../backend/database');
const router = require('../../backend/rotas/produtos');
const { verificarToken } = require('../../backend/middleware/auth');
const MibService = require('../../backend/motores/mib/MibService');

const sincronizarNomeBuscaOriginal = MibService.prototype.sincronizarNomeBusca;
const notificarProdutoCriadoOriginal = MibService.prototype.notificarProdutoCriado;
MibService.prototype.sincronizarNomeBusca = (_id, _nome, callback) => {
  if (typeof callback === 'function') callback(null);
};
MibService.prototype.notificarProdutoCriado = () => {};

function whenReady(database) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Banco isolado não ficou pronto a tempo.')), 30000);
    database.whenReady((err) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    });
  });
}

function run(database, sql, params = []) {
  return new Promise((resolve, reject) => {
    database.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function closeDb(database) {
  return new Promise((resolve, reject) => {
    database.close((err) => (err ? reject(err) : resolve()));
  });
}

async function verificarMigracaoAditiva() {
  const legacyDb = await new Promise((resolve, reject) => {
    const instance = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(instance)));
  });
  try {
    await new Promise((resolve, reject) => legacyDb.run(`
      CREATE TABLE produtos (
        id INTEGER PRIMARY KEY,
        nome TEXT NOT NULL,
        preco_venda DECIMAL(18,6) NOT NULL,
        ncm TEXT
      )
    `, (err) => (err ? reject(err) : resolve())));
    await new Promise((resolve, reject) => legacyDb.run(
      `INSERT INTO produtos (id, nome, preco_venda, ncm) VALUES (1, 'Legado', 12.5, '19059090')`,
      (err) => (err ? reject(err) : resolve())
    ));
    await new Promise((resolve, reject) => legacyDb.run(
      'ALTER TABLE produtos ADD COLUMN nome_comercial TEXT',
      (err) => (err ? reject(err) : resolve())
    ));
    await new Promise((resolve, reject) => legacyDb.run(
      'ALTER TABLE produtos ADD COLUMN preco_pedido DECIMAL(18,6)',
      (err) => (err ? reject(err) : resolve())
    ));
    const row = await new Promise((resolve, reject) => legacyDb.get(
      'SELECT nome, preco_venda, ncm, nome_comercial, preco_pedido FROM produtos WHERE id = 1',
      (err, result) => (err ? reject(err) : resolve(result))
    ));
    assert.equal(row.nome, 'Legado');
    assert.equal(Number(row.preco_venda), 12.5);
    assert.equal(row.ncm, '19059090');
    assert.equal(row.nome_comercial, null);
    assert.equal(row.preco_pedido, null);
  } finally {
    await new Promise((resolve, reject) => legacyDb.close((err) => (err ? reject(err) : resolve())));
  }
}

async function main() {
  let server;
  try {
    await verificarMigracaoAditiva();
    const databaseSource = fs.readFileSync(path.join(__dirname, '../../backend/database.js'), 'utf8');
    assert.match(databaseSource, /ALTER TABLE produtos ADD COLUMN nome_comercial TEXT/);
    assert.match(databaseSource, /ALTER TABLE produtos ADD COLUMN preco_pedido DECIMAL\(18,6\)/);
    await whenReady(db);
    const columns = await new Promise((resolve, reject) => {
      db.all('PRAGMA table_info(produtos)', (err, rows) => (err ? reject(err) : resolve(rows)));
    });
    assert.ok(columns.some((column) => column.name === 'nome_comercial'));
    assert.ok(columns.some((column) => column.name === 'preco_pedido'));
    const colunasItensPedido = await new Promise((resolve, reject) => {
      db.all('PRAGMA table_info(pedidos_itens)', (err, rows) => (err ? reject(err) : resolve(rows)));
    });
    for (const coluna of [
      'preco_venda_snapshot',
      'preco_pedido_snapshot',
      'preco_sugerido_snapshot',
      'origem_preco_sugerido'
    ]) {
      assert.ok(colunasItensPedido.some((row) => row.name === coluna), coluna);
    }

    const app = express();
    app.use(express.json());
    app.use('/api/produtos', verificarToken, router);
    server = await new Promise((resolve, reject) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
      instance.once('error', reject);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}/api/produtos`;
    const token = jwt.sign({ id: 1, role: 'admin', perfil: 'SUPER_ADMIN' }, process.env.JWT_SECRET);
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    };

    const create = await fetch(baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        codigo: `NPP-${Date.now()}`,
        nome: 'Nome principal preservado',
        nome_comercial: 'Nome da vitrine',
        unidade: 'UN',
        preco_compra: 4,
        lucro_percentual: 25,
        preco_venda: 5,
        preco_pedido: 6.5,
        ncm: '19059090',
        cfop: '5102',
        tipo_operacional: 'COMERCIAL'
      })
    });
    assert.equal(create.status, 200, await create.clone().text());
    const created = await create.json();
    assert.equal(created.nome, 'Nome principal preservado');
    assert.equal(created.nome_comercial, 'Nome da vitrine');
    assert.equal(Number(created.preco_venda), 5);
    assert.equal(Number(created.preco_pedido), 6.5);

    const cajuinaCodigo = `CAJ-${Date.now()}`;
    const cajuinaInsert = await run(db, `
      INSERT INTO produtos (codigo, nome, nome_comercial, unidade, preco_venda)
      VALUES (?, 'Bebida regional do Vale', 'Cajuína artesanal', 'UN', 8.5)
    `, [cajuinaCodigo]);

    const zeroCodigo = `NPP-ZERO-${Date.now()}`;
    const zeroInsert = await run(db, `
      INSERT INTO produtos (codigo, nome, nome_comercial, unidade, preco_venda, preco_pedido)
      VALUES (?, ?, ?, 'UN', 17, 0)
    `, [zeroCodigo, 'Produto com preço Pedido zero', 'Produto zero']);
    const nullCodigo = `NPP-NULL-${Date.now()}`;
    const nullInsert = await run(db, `
      INSERT INTO produtos (codigo, nome, nome_comercial, unidade, preco_venda, preco_pedido)
      VALUES (?, ?, ?, 'UN', 17, NULL)
    `, [nullCodigo, 'Produto com preço Pedido ausente', 'Produto promoção']);
    await run(db, `
      INSERT INTO promocoes (
        produto_id, preco_original, preco_promocional, desconto_percentual,
        data_inicio, data_fim, status
      ) VALUES (?, 17, 11, 35.29, date('now', '-1 day'), date('now', '+1 day'), 'ativa')
    `, [nullInsert.lastID]);

    async function buscarProduto(codigo, produtoId) {
      const response = await fetch(
        `${baseUrl}/consulta-pdv/buscar?q=${encodeURIComponent(codigo)}&limite=15`,
        { headers }
      );
      assert.equal(response.status, 200, await response.clone().text());
      const rows = await response.json();
      assert.equal(
        rows.filter((row) => Number(row.id) === Number(produtoId)).length,
        1,
        `produto ${codigo} deve aparecer uma única vez na resposta`
      );
      const product = rows.find((row) => Number(row.id) === Number(produtoId));
      assert.ok(product, `produto ${codigo} deve estar na resposta de busca`);
      return product;
    }

    const buscaConfigurado = await buscarProduto(created.codigo, created.id);
    assert.equal(Number(buscaConfigurado.id), Number(created.id));
    assert.equal(buscaConfigurado.nome, 'Nome principal preservado');
    assert.equal(buscaConfigurado.nome_comercial, 'Nome da vitrine');
    assert.equal(Number(buscaConfigurado.preco_venda), 5);
    assert.equal(Number(buscaConfigurado.preco_pedido), 6.5);
    const buscaCajuinaNome = await buscarProduto('Bebida regional do Vale', cajuinaInsert.lastID);
    assert.equal(buscaCajuinaNome.nome_comercial, 'Cajuína artesanal');
    const buscaCajuinaComercial = await buscarProduto('cajuina', cajuinaInsert.lastID);
    assert.equal(buscaCajuinaComercial.nome, 'Bebida regional do Vale');
    assert.equal(buscaCajuinaComercial.nome_comercial, 'Cajuína artesanal');
    const buscaCajuinaComAcento = await buscarProduto('Cajuína artesanal', cajuinaInsert.lastID);
    assert.equal(buscaCajuinaComAcento.nome_comercial, 'Cajuína artesanal');

    await run(db, `
      UPDATE produtos SET nome_comercial = 'Cajuína do Vale Atualizada' WHERE id = ?
    `, [cajuinaInsert.lastID]);
    const mib = MibService.getInstance(db);
    await new Promise((resolve, reject) => {
      sincronizarNomeBuscaOriginal.call(
        mib,
        cajuinaInsert.lastID,
        'Bebida regional do Vale',
        (err) => (err ? reject(err) : resolve())
      );
    });
    const buscaAliasAtualizado = await buscarProduto('Cajuína do Vale Atualizada', cajuinaInsert.lastID);
    assert.equal(buscaAliasAtualizado.nome_comercial, 'Cajuína do Vale Atualizada');
    const refreshCatalogo = mib.engine.updater._pendente;
    if (refreshCatalogo) await refreshCatalogo;
    const buscaNomePrincipal = await buscarProduto('Nome principal preservado', created.id);
    assert.equal(buscaNomePrincipal.nome_comercial, 'Nome da vitrine');
    const buscaZero = await buscarProduto(zeroCodigo, zeroInsert.lastID);
    assert.equal(buscaZero.preco_pedido, 0);
    assert.equal(buscaZero.nome_comercial, 'Produto zero');
    const buscaNull = await buscarProduto(nullCodigo, nullInsert.lastID);
    assert.equal(buscaNull.preco_pedido, null);
    assert.equal(buscaNull.nome_comercial, 'Produto promoção');
    assert.equal(Number(buscaNull.preco_promocional), 11);

    const itemUrl = `${baseUrl}/${created.id}`;
    const read = await fetch(itemUrl, { headers });
    assert.equal(read.status, 200);
    const readProduct = await read.json();
    assert.equal(Number(readProduct.id), Number(buscaConfigurado.id));
    assert.equal(readProduct.nome, 'Nome principal preservado');
    assert.equal(readProduct.nome_comercial, 'Nome da vitrine');
    assert.equal(readProduct.unidade, 'UN');
    assert.equal(Number(readProduct.preco_venda), 5);
    assert.equal(Number(readProduct.preco_pedido), 6.5);

    const update = await fetch(itemUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        nome: 'Nome principal editado',
        nome_comercial: 'Nome comercial editado',
        preco_venda: 5.75,
        preco_pedido: 7.25
      })
    });
    assert.equal(update.status, 200, await update.clone().text());
    const updated = await update.json();
    assert.equal(updated.nome, 'Nome principal editado');
    assert.equal(updated.nome_comercial, 'Nome comercial editado');
    assert.equal(Number(updated.preco_venda), 5.75);
    assert.equal(Number(updated.preco_pedido), 7.25);
    assert.equal(updated.ncm, '19059090');
    assert.equal(updated.cfop, '5102');

    const reread = await fetch(itemUrl, { headers });
    const persisted = await reread.json();
    assert.equal(persisted.nome, 'Nome principal editado');
    assert.equal(persisted.nome_comercial, 'Nome comercial editado');
    assert.equal(Number(persisted.preco_venda), 5.75);
    assert.equal(Number(persisted.preco_pedido), 7.25);

    const precoInvalido = await fetch(itemUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ preco_pedido: -1 })
    });
    assert.equal(precoInvalido.status, 400);
    const aposPrecoInvalido = await fetch(itemUrl, { headers });
    assert.equal(Number((await aposPrecoInvalido.json()).preco_pedido), 7.25);

    const oldCodigo = `LEG-${Date.now()}`;
    const oldInsert = await run(db, `
      INSERT INTO produtos (codigo, nome, unidade, preco_venda, ncm, cfop)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [oldCodigo, 'Produto legado', 'UN', 3.5, '19059090', '5102']);
    const oldRead = await fetch(`${baseUrl}/${oldInsert.lastID}`, { headers });
    assert.equal(oldRead.status, 200);
    const legacy = await oldRead.json();
    assert.equal(legacy.nome, 'Produto legado');
    assert.equal(Number(legacy.preco_venda), 3.5);
    assert.equal(legacy.nome_comercial, null);
    assert.equal(legacy.preco_pedido, null);
    const buscaLegacy = await buscarProduto(oldCodigo, oldInsert.lastID);
    assert.equal(buscaLegacy.nome, 'Produto legado');
    assert.equal(buscaLegacy.nome_comercial, null);

    const listResponse = await fetch(baseUrl, { headers });
    assert.equal(listResponse.status, 200);
    const listed = await listResponse.json();
    const listedProduct = listed.find((product) => product.id === created.id);
    assert.equal(listedProduct.nome_comercial, 'Nome comercial editado');
    assert.equal(Number(listedProduct.preco_pedido), 7.25);

    const ui = fs.readFileSync(path.join(__dirname, '../../frontend/erp/js/produtos.js'), 'utf8');
    assert.match(ui, /label for="nome"[^]*Nome principal/);
    assert.match(ui, /label for="nome_comercial"[^]*Nome comercial/);
    assert.match(ui, /label for="preco_venda"[^]*Preço comercial/);
    assert.match(ui, /label for="preco_pedido"[^]*Preço do Pedido/);
    assert.match(ui, /nome_comercial: \(\$\('#nome_comercial'\)\.val\(\)/);
    assert.match(ui, /preco_pedido: \$\('#preco_pedido'\)\.val\(\)/);

    const xml = fs.readFileSync(path.join(__dirname, '../../backend/services/fiscal/xmlBuilder.js'), 'utf8');
    assert.match(xml, /item\.produto_nome \|\| 'PRODUTO'/);
    assert.doesNotMatch(xml, /nome_comercial|preco_pedido/);
    console.log('nome-comercial-preco-pedido-http: create, read, update, legado e proteção fiscal passaram');
  } finally {
    if (server) {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
    MibService.prototype.sincronizarNomeBusca = sincronizarNomeBuscaOriginal;
    MibService.prototype.notificarProdutoCriado = notificarProdutoCriadoOriginal;
    await closeDb(db);
    for (const entry of fs.readdirSync(dbDir)) {
      fs.rmSync(path.join(dbDir, entry), { recursive: true, force: true });
    }
    fs.rmdirSync(dbDir);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
