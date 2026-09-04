/**
 * MUC-03 — Schema de configuração de conversão do produto (catálogo compartilhado).
 * Sem empresa_id: a regra é do produto; o saldo é da movimentação.
 * @module services/produtos/produtoConversaoSchema
 */
'use strict';

const DDL_RELACOES = `
  CREATE TABLE IF NOT EXISTS muc_produto_relacoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    produto_id INTEGER NOT NULL,
    unidade_origem TEXT NOT NULL,
    unidade_destino TEXT NOT NULL,
    fator REAL NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(produto_id, unidade_origem, unidade_destino),
    FOREIGN KEY (produto_id) REFERENCES produtos(id) ON DELETE CASCADE
  )
`;

const IDX = [
  `CREATE INDEX IF NOT EXISTS idx_muc_produto_relacoes_produto
    ON muc_produto_relacoes(produto_id)`
];

const ALTER_PRODUTOS = [
  `ALTER TABLE produtos ADD COLUMN utiliza_conversao INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE produtos ADD COLUMN unidade_estoque TEXT`
];

function aplicarAlterSeguro(db, sql, callback) {
  db.run(sql, (err) => {
    if (err && !String(err.message).includes('duplicate column name')) {
      return callback(err);
    }
    callback(null);
  });
}

function garantirSchemaProdutoConversao(db, callback) {
  const done = typeof callback === 'function' ? callback : () => {};
  if (!db) return done(new Error('db obrigatório para schema de conversão do produto'));

  db.run(DDL_RELACOES, (errTabela) => {
    if (errTabela) return done(errTabela);
    let pendentes = ALTER_PRODUTOS.length + IDX.length;
    let falha = null;
    const tick = () => {
      pendentes -= 1;
      if (pendentes === 0) done(falha);
    };
    ALTER_PRODUTOS.forEach((sql) => {
      aplicarAlterSeguro(db, sql, (err) => {
        if (err && !falha) falha = err;
        tick();
      });
    });
    IDX.forEach((sql) => {
      db.run(sql, (idxErr) => {
        if (idxErr && !falha) falha = idxErr;
        tick();
      });
    });
  });
}

function garantirSchemaProdutoConversaoAsync(db) {
  return new Promise((resolve, reject) => {
    garantirSchemaProdutoConversao(db, (err) => (err ? reject(err) : resolve()));
  });
}

module.exports = {
  DDL_RELACOES,
  garantirSchemaProdutoConversao,
  garantirSchemaProdutoConversaoAsync
};
