/**
 * Schema oficial — tabela empresas (Fase 2 / Implementação 03.1).
 * Sem estoque_empresa. Sem produto_empresa. Sem seed de empresa padrão.
 *
 * @module services/empresas/empresasSchema
 */
'use strict';

const DDL_EMPRESAS = `
  CREATE TABLE IF NOT EXISTS empresas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cnpj TEXT NOT NULL,
    razao_social TEXT NOT NULL,
    nome_fantasia TEXT,
    inscricao_estadual TEXT,
    inscricao_municipal TEXT,
    ativo INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`;

const INDICE_CNPJ = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_empresas_cnpj
    ON empresas(cnpj)
`;

/**
 * @param {object} db
 * @param {Function} [callback]
 */
function garantirSchemaEmpresas(db, callback) {
  const done = typeof callback === 'function' ? callback : () => {};
  if (!db) return done(new Error('db obrigatório para schema empresas'));

  db.run(DDL_EMPRESAS, (err) => {
    if (err) {
      console.error('Erro ao criar tabela empresas:', err.message);
      return done(err);
    }
    db.run(INDICE_CNPJ, (idxErr) => {
      if (idxErr) {
        console.error('Erro ao criar índice CNPJ de empresas:', idxErr.message);
        return done(idxErr);
      }
      console.log('Tabela empresas criada/verificada');
      done(null);
    });
  });
}

function garantirSchemaEmpresasAsync(db) {
  return new Promise((resolve, reject) => {
    garantirSchemaEmpresas(db, (err) => (err ? reject(err) : resolve()));
  });
}

module.exports = {
  DDL_EMPRESAS,
  garantirSchemaEmpresas,
  garantirSchemaEmpresasAsync
};
