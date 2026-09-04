/**
 * Ficha técnica compartilhada (característica do produto, não por CNPJ).
 * Sprint 03.03 — fundação. Sem baixa automática na venda.
 *
 * @module services/produtos/fichaTecnicaSchema
 */
'use strict';

const DDL_FICHA = `
  CREATE TABLE IF NOT EXISTS ficha_tecnica (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    produto_id INTEGER NOT NULL UNIQUE,
    ativo INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (produto_id) REFERENCES produtos(id)
  )
`;

const DDL_ITENS = `
  CREATE TABLE IF NOT EXISTS ficha_tecnica_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ficha_tecnica_id INTEGER NOT NULL,
    insumo_id INTEGER NOT NULL,
    quantidade REAL NOT NULL,
    unidade TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(ficha_tecnica_id, insumo_id),
    FOREIGN KEY (ficha_tecnica_id) REFERENCES ficha_tecnica(id) ON DELETE CASCADE,
    FOREIGN KEY (insumo_id) REFERENCES produtos(id)
  )
`;

function runSql(db, sql) {
  return new Promise((resolve, reject) => {
    db.run(sql, (err) => (err ? reject(err) : resolve()));
  });
}

function garantirSchemaFichaTecnica(db, callback) {
  const done = typeof callback === 'function' ? callback : () => {};
  if (!db) return done(new Error('db obrigatório para schema ficha_tecnica'));
  db.serialize(() => {
    db.run(DDL_FICHA, (err1) => {
      if (err1) return done(err1);
      db.run(DDL_ITENS, (err2) => done(err2 || null));
    });
  });
}

async function garantirSchemaFichaTecnicaAsync(db) {
  await runSql(db, DDL_FICHA);
  await runSql(db, DDL_ITENS);
}

module.exports = {
  DDL_FICHA,
  DDL_ITENS,
  garantirSchemaFichaTecnica,
  garantirSchemaFichaTecnicaAsync
};
