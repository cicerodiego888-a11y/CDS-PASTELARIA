/**
 * Schema — estoque_empresa (Fase 2 / Implementação 03.11).
 * Fundação estrutural produto + empresa. Sem backfill. Sem redirecionar a porta.
 * Storage operacional permanece em `produtos`.
 *
 * @module services/estoque/estoqueEmpresaSchema
 */
'use strict';

const DDL_ESTOQUE_EMPRESA = `
  CREATE TABLE IF NOT EXISTS estoque_empresa (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    produto_id INTEGER NOT NULL,
    empresa_id INTEGER NOT NULL,
    saldo_fiscal REAL NOT NULL DEFAULT 0,
    saldo_nao_fiscal REAL NOT NULL DEFAULT 0,
    estoque_atual REAL NOT NULL DEFAULT 0,
    reservado_fiscal REAL NOT NULL DEFAULT 0,
    reservado_nao_fiscal REAL NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(produto_id, empresa_id),
    FOREIGN KEY (produto_id) REFERENCES produtos(id),
    FOREIGN KEY (empresa_id) REFERENCES empresas(id)
  )
`;

const INDICE_PRODUTO_EMPRESA = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_estoque_empresa_produto_empresa
    ON estoque_empresa(produto_id, empresa_id)
`;

/**
 * @param {object} db
 * @param {Function} [callback]
 */
function garantirSchemaEstoqueEmpresa(db, callback) {
  const done = typeof callback === 'function' ? callback : () => {};
  if (!db) return done(new Error('db obrigatório para schema estoque_empresa'));

  db.run(DDL_ESTOQUE_EMPRESA, (err) => {
    if (err) {
      console.error('Erro ao criar tabela estoque_empresa:', err.message);
      return done(err);
    }
    db.run(INDICE_PRODUTO_EMPRESA, (idxErr) => {
      if (idxErr) {
        console.error('Erro ao criar índice estoque_empresa:', idxErr.message);
        return done(idxErr);
      }
      console.log('Tabela estoque_empresa criada/verificada');
      done(null);
    });
  });
}

function garantirSchemaEstoqueEmpresaAsync(db) {
  return new Promise((resolve, reject) => {
    garantirSchemaEstoqueEmpresa(db, (err) => (err ? reject(err) : resolve()));
  });
}

module.exports = {
  DDL_ESTOQUE_EMPRESA,
  garantirSchemaEstoqueEmpresa,
  garantirSchemaEstoqueEmpresaAsync
};
