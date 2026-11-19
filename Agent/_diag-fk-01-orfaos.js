'use strict';
const path = require('path');
const os = require('os');
const sqlite3 = require('sqlite3').verbose();

const dbPath = path.join(os.tmpdir(), 'cds-cozinha-fk-diagnostico', 'mercadao-copia-diagnostico.db');
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);

function get(sql, p = []) {
  return new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r))));
}
function all(sql, p = []) {
  return new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r || []))));
}

(async () => {
  const nProd = await get('SELECT COUNT(*) AS n FROM produtos');
  const minMax = await get('SELECT MIN(id) AS mi, MAX(id) AS ma FROM produtos');
  const orphan = await get(`
    SELECT COUNT(*) AS n
    FROM produto_unidades u
    LEFT JOIN produtos p ON p.id = u.produto_id
    WHERE p.id IS NULL
  `);
  const sampleIds = await all(`
    SELECT DISTINCT u.produto_id AS produto_id
    FROM produto_unidades u
    LEFT JOIN produtos p ON p.id = u.produto_id
    WHERE p.id IS NULL
    LIMIT 15
  `);
  const produto1 = await get('SELECT id, nome FROM produtos WHERE id = 1');
  const meta = await get(`SELECT chave, valor FROM cozinha_schema_meta WHERE chave = 'schema_version'`);
  const sumCheck = await get('SELECT COUNT(*) AS n FROM pragma_foreign_key_check');
  // SQLite may not have table-valued pragma; ignore if fails
  let sumCheck2 = null;
  try {
    sumCheck2 = await all('PRAGMA foreign_key_check');
  } catch (_e) {
    sumCheck2 = [];
  }

  const out = {
    nProdutos: nProd && nProd.n,
    produtosMinMax: minMax,
    orphanProdutoUnidades: orphan && orphan.n,
    sampleOrphanProdutoIds: sampleIds.map((r) => r.produto_id),
    produtoId1: produto1,
    schema_meta: meta,
    totalFkCheck: Array.isArray(sumCheck2) ? sumCheck2.length : null
  };
  console.log(JSON.stringify(out, null, 2));
  db.close();
})().catch((e) => {
  console.error(e);
  db.close();
  process.exit(1);
});
