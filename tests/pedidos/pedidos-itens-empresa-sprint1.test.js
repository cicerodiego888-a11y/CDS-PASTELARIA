'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-pedidos-itens-sprint1-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const {
  executarMigracaoSprint1,
  verificarAmbienteIsolado
} = require('../../backend/migrations/sprint1-pedidos-itens-empresa');

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => {
      if (err) return reject(err);
      db.run('PRAGMA foreign_keys = ON', (fkErr) => {
        if (fkErr) reject(fkErr);
        else resolve(db);
      });
    });
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function cb(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function close(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

async function schemaBase(db) {
  await run(db, `
    CREATE TABLE pedidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER,
      codigo TEXT,
      total REAL NOT NULL DEFAULT 0
    )
  `);
  await run(db, `
    CREATE TABLE produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT
    )
  `);
  await run(db, `
    CREATE TABLE pedidos_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER NOT NULL,
      produto_id INTEGER NOT NULL,
      quantidade REAL NOT NULL,
      preco_unitario REAL NOT NULL,
      subtotal REAL NOT NULL,
      tipo_venda TEXT DEFAULT 'PESO',
      observacao TEXT,
      FOREIGN KEY (pedido_id) REFERENCES pedidos(id),
      FOREIGN KEY (produto_id) REFERENCES produtos(id)
    )
  `);
  await run(db, 'CREATE INDEX idx_pedidos_itens_pedido ON pedidos_itens(pedido_id)');
  await run(db, `
    CREATE TABLE pedidos_itens_auditoria (
      pedido_item_id INTEGER,
      acao TEXT
    )
  `);
  await run(db, `
    CREATE TRIGGER trg_pedidos_itens_teste
    AFTER INSERT ON pedidos_itens
    BEGIN
      INSERT INTO pedidos_itens_auditoria(pedido_item_id, acao)
      VALUES (NEW.id, 'INSERT');
    END
  `);
}

describe('Sprint 1 — pedidos_itens.empresa_id', () => {
  it('confirma isolamento obrigatório', () => {
    verificarAmbienteIsolado();
  });

  it('preserva linhas, colunas, índices e triggers e faz backfill correto', async () => {
    const db = await openDb();
    await schemaBase(db);
    await run(db, 'INSERT INTO pedidos(id,empresa_id,codigo,total) VALUES (10,1,\'P10\',25)');
    await run(db, 'INSERT INTO produtos(id,nome) VALUES (30,\'Produto 30\')');
    await run(db, `
      INSERT INTO pedidos_itens(id,pedido_id,produto_id,quantidade,preco_unitario,subtotal,tipo_venda,observacao)
      VALUES (40,10,30,2,10,20,'PESO','preservar')
    `);

    const antesContagem = await get(db, 'SELECT COUNT(*) AS n FROM pedidos_itens');
    const antesLinha = await get(db, 'SELECT * FROM pedidos_itens WHERE id=40');
    const antesIndice = await all(db, "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='pedidos_itens'");
    const antesTrigger = await all(db, "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='pedidos_itens'");

    const resultado = await executarMigracaoSprint1(db, { isolamentoExplicito: true });

    assert.equal(resultado.countAntes, Number(antesContagem.n));
    assert.equal(resultado.countDepois, Number(antesContagem.n));
    assert.equal(resultado.foreignKeysEnabled, true);
    assert.deepEqual(resultado.foreignKeyCheck, []);

    const depoisLinha = await get(db, 'SELECT * FROM pedidos_itens WHERE id=40');
    assert.equal(depoisLinha.empresa_id, 1);
    assert.equal(depoisLinha.pedido_id, antesLinha.pedido_id);
    assert.equal(depoisLinha.produto_id, antesLinha.produto_id);
    assert.equal(depoisLinha.quantidade, antesLinha.quantidade);
    assert.equal(depoisLinha.preco_unitario, antesLinha.preco_unitario);
    assert.equal(depoisLinha.subtotal, antesLinha.subtotal);
    assert.equal(depoisLinha.tipo_venda, antesLinha.tipo_venda);
    assert.equal(depoisLinha.observacao, antesLinha.observacao);

    const depoisIndice = await all(db, "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='pedidos_itens'");
    for (const idx of antesIndice) {
      assert.ok(depoisIndice.some((linha) => linha.name === idx.name), `índice removido: ${idx.name}`);
    }
    assert.ok(depoisIndice.some((linha) => linha.name === 'ux_pedidos_itens_id_pedido_empresa'));

    const depoisTrigger = await all(db, "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='pedidos_itens'");
    for (const trg of antesTrigger) {
      assert.ok(depoisTrigger.some((linha) => linha.name === trg.name), `trigger removido: ${trg.name}`);
    }

    await run(db, 'INSERT INTO pedidos_itens(pedido_id,produto_id,quantidade,preco_unitario,subtotal) VALUES (10,30,1,10,10)');
    const auditoria = await get(db, "SELECT acao FROM pedidos_itens_auditoria ORDER BY rowid DESC LIMIT 1");
    assert.equal(auditoria.acao, 'INSERT');

    await close(db);
  });

  it('reexecução segura não duplica nem perde dados', async () => {
    const db = await openDb();
    await schemaBase(db);
    await run(db, 'INSERT INTO pedidos(id,empresa_id,codigo,total) VALUES (11,2,\'P11\',10)');
    await run(db, 'INSERT INTO produtos(id,nome) VALUES (31,\'Produto 31\')');
    await run(db, 'INSERT INTO pedidos_itens(pedido_id,produto_id,quantidade,preco_unitario,subtotal) VALUES (11,31,1,10,10)');

    await executarMigracaoSprint1(db, { isolamentoExplicito: true });
    await executarMigracaoSprint1(db, { isolamentoExplicito: true });

    assert.equal(Number((await get(db, 'SELECT COUNT(*) AS n FROM pedidos_itens')).n), 1);
    assert.equal(Number((await get(db, 'SELECT empresa_id FROM pedidos_itens')).empresa_id), 2);
    assert.deepEqual(await all(db, 'PRAGMA foreign_key_check'), []);
    await close(db);
  });

  it('detecta item órfão e faz rollback', async () => {
    const db = await openDb();
    await schemaBase(db);
    await run(db, 'INSERT INTO produtos(id,nome) VALUES (32,\'Produto 32\')');
    await run(db, 'PRAGMA foreign_keys = OFF');
    await run(db, 'INSERT INTO pedidos_itens(pedido_id,produto_id,quantidade,preco_unitario,subtotal) VALUES (999,32,1,10,10)');
    await run(db, 'PRAGMA foreign_keys = ON');

    await assert.rejects(
      () => executarMigracaoSprint1(db, { isolamentoExplicito: true }),
      (err) => err.codigo === 'PEDIDOS_ITENS_ORFAO'
    );
    assert.equal(Number((await get(db, 'SELECT COUNT(*) AS n FROM pedidos_itens')).n), 1);
    await close(db);
  });

  it('detecta pedido sem empresa e aborta', async () => {
    const db = await openDb();
    await schemaBase(db);
    await run(db, 'INSERT INTO pedidos(id,empresa_id,codigo,total) VALUES (12,NULL,\'P12\',10)');
    await run(db, 'INSERT INTO produtos(id,nome) VALUES (33,\'Produto 33\')');
    await run(db, 'INSERT INTO pedidos_itens(pedido_id,produto_id,quantidade,preco_unitario,subtotal) VALUES (12,33,1,10,10)');

    await assert.rejects(
      () => executarMigracaoSprint1(db, { isolamentoExplicito: true }),
      (err) => err.codigo === 'PEDIDO_EMPRESA_AUSENTE'
    );
    await close(db);
  });

  it('detecta empresa divergente já persistida e aborta', async () => {
    const db = await openDb();
    await schemaBase(db);
    await run(db, 'INSERT INTO pedidos(id,empresa_id,codigo,total) VALUES (13,3,\'P13\',10)');
    await run(db, 'INSERT INTO produtos(id,nome) VALUES (34,\'Produto 34\')');
    await run(db, 'ALTER TABLE pedidos_itens ADD COLUMN empresa_id INTEGER');
    await run(db, 'INSERT INTO pedidos_itens(pedido_id,produto_id,quantidade,preco_unitario,subtotal,empresa_id) VALUES (13,34,1,10,10,4)');

    await assert.rejects(
      () => executarMigracaoSprint1(db, { isolamentoExplicito: true }),
      (err) => err.codigo === 'PEDIDO_ITEM_EMPRESA_DIVERGENTE'
    );
    await close(db);
  });
});
