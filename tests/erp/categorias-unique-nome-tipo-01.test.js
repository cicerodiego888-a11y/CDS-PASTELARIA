/**
 * Categorias: UNIQUE(nome, tipo) — mesmo nome em produto e insumo.
 * Executar: node --test tests/erp/categorias-unique-nome-tipo-01.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cat-nome-tipo-'));
process.env.DB_DIR = dbDir;
delete process.env.CDS_ALLOW_OFFICIAL_DB;

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}
function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}
function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}
function close(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_) { resolve(); }
  });
}

describe('categorias UNIQUE(nome, tipo)', () => {
  it('permite mesmo nome em produto e insumo', async () => {
    const db = await openDb();
    await run(db, `
      CREATE TABLE categorias (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT NOT NULL,
        descricao TEXT,
        tipo TEXT NOT NULL DEFAULT 'produto',
        ativo INTEGER DEFAULT 1,
        UNIQUE(nome, tipo)
      )
    `);
    await run(db, `INSERT INTO categorias (nome, tipo) VALUES ('Refrigerantes', 'produto')`);
    await run(db, `INSERT INTO categorias (nome, tipo) VALUES ('Refrigerantes', 'insumo')`);
    const n = await get(db, `SELECT COUNT(*) AS n FROM categorias WHERE nome = 'Refrigerantes'`);
    assert.equal(Number(n.n), 2);
    await assert.rejects(
      () => run(db, `INSERT INTO categorias (nome, tipo) VALUES ('Refrigerantes', 'insumo')`),
      /UNIQUE/i
    );
    await close(db);
  });

  it('migração remove UNIQUE só em nome', async () => {
    const db = await openDb();
    await run(db, `
      CREATE TABLE categorias (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT NOT NULL UNIQUE,
        descricao TEXT,
        tipo TEXT NOT NULL DEFAULT 'produto',
        ativo INTEGER DEFAULT 1
      )
    `);
    await run(db, `INSERT INTO categorias (nome, tipo) VALUES ('Refrigerantes', 'produto')`);
    await run(db, 'BEGIN IMMEDIATE');
    await run(db, `
      CREATE TABLE categorias_nome_tipo_mig (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT NOT NULL,
        descricao TEXT,
        tipo TEXT NOT NULL DEFAULT 'produto',
        ativo INTEGER DEFAULT 1,
        UNIQUE(nome, tipo)
      )
    `);
    await run(db, `
      INSERT INTO categorias_nome_tipo_mig (id, nome, descricao, tipo, ativo)
      SELECT id, nome, descricao, tipo, ativo FROM categorias
    `);
    await run(db, 'DROP TABLE categorias');
    await run(db, 'ALTER TABLE categorias_nome_tipo_mig RENAME TO categorias');
    await run(db, 'COMMIT');
    await run(db, `INSERT INTO categorias (nome, tipo) VALUES ('Refrigerantes', 'insumo')`);
    const rows = await get(db, `SELECT COUNT(*) AS n FROM categorias WHERE nome = 'Refrigerantes'`);
    assert.equal(Number(rows.n), 2);
    await close(db);
  });
});
