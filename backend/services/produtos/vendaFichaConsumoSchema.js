/**
 * Rastreio de consumo de ficha técnica por venda (03.04).
 * Sem empresa_id na ficha; ownership do consumo = vendas.empresa_id.
 *
 * @module services/produtos/vendaFichaConsumoSchema
 */
'use strict';

const DDL_CAB = `
  CREATE TABLE IF NOT EXISTS venda_ficha_consumo (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    venda_id INTEGER NOT NULL UNIQUE,
    empresa_id INTEGER NOT NULL,
    estornado_em DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (venda_id) REFERENCES vendas(id)
  )
`;

const DDL_ITENS = `
  CREATE TABLE IF NOT EXISTS venda_ficha_consumo_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    venda_id INTEGER NOT NULL,
    empresa_id INTEGER NOT NULL,
    produto_id INTEGER NOT NULL,
    insumo_id INTEGER NOT NULL,
    quantidade REAL NOT NULL,
    unidade TEXT NOT NULL,
    quantidade_ficha REAL NOT NULL,
    unidade_ficha TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (venda_id) REFERENCES vendas(id)
  )
`;

const DDL_ESTORNOS = `
  CREATE TABLE IF NOT EXISTS venda_ficha_consumo_estornos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    venda_id INTEGER NOT NULL,
    empresa_id INTEGER NOT NULL,
    venda_devolucao_id INTEGER,
    origem TEXT NOT NULL,
    produto_id INTEGER,
    insumo_id INTEGER NOT NULL,
    quantidade REAL NOT NULL,
    unidade TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`;

const DDL_IDX_ESTORNO_DEV = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_ficha_estorno_devolucao_insumo
    ON venda_ficha_consumo_estornos (venda_devolucao_id, insumo_id)
    WHERE venda_devolucao_id IS NOT NULL
`;

function garantirColunaEstornadoEm(db, callback) {
  db.all('PRAGMA table_info(venda_ficha_consumo)', (err, cols) => {
    if (err) return callback(err);
    const names = (cols || []).map((c) => String(c.name || ''));
    if (names.includes('estornado_em')) return callback(null);
    db.run('ALTER TABLE venda_ficha_consumo ADD COLUMN estornado_em DATETIME', callback);
  });
}

function garantirSchemaVendaFichaConsumo(db, callback) {
  const done = typeof callback === 'function' ? callback : () => {};
  if (!db) return done(new Error('db obrigatório para schema venda_ficha_consumo'));
  db.serialize(() => {
    db.run(DDL_CAB, (err1) => {
      if (err1) return done(err1);
      db.run(DDL_ITENS, (err2) => {
        if (err2) return done(err2);
        garantirColunaEstornadoEm(db, (err3) => {
          if (err3) return done(err3);
          db.run(DDL_ESTORNOS, (err4) => {
            if (err4) return done(err4);
            db.run(DDL_IDX_ESTORNO_DEV, done);
          });
        });
      });
    });
  });
}

function garantirSchemaVendaFichaConsumoAsync(db) {
  return new Promise((resolve, reject) => {
    garantirSchemaVendaFichaConsumo(db, (err) => (err ? reject(err) : resolve()));
  });
}

module.exports = {
  DDL_CAB,
  DDL_ITENS,
  DDL_ESTORNOS,
  garantirSchemaVendaFichaConsumo,
  garantirSchemaVendaFichaConsumoAsync
};
