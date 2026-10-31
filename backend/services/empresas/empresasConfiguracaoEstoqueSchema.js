/**
 * Schema — configuração operacional de estoque por empresa.
 * CDS-ESTOQUE-MANUAL-01. Ausência de linha = AUTOMATICO (legado).
 *
 * @module services/empresas/empresasConfiguracaoEstoqueSchema
 */
'use strict';

const DDL = `
  CREATE TABLE IF NOT EXISTS empresas_configuracao_estoque (
    empresa_id INTEGER PRIMARY KEY,
    modo TEXT NOT NULL DEFAULT 'AUTOMATICO'
      CHECK (modo IN ('AUTOMATICO', 'MANUAL')),
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER,
    FOREIGN KEY (empresa_id) REFERENCES empresas(id)
  )
`;

function garantirSchemaEmpresasConfiguracaoEstoque(db, callback) {
  const done = typeof callback === 'function' ? callback : () => {};
  if (!db) return done(new Error('db obrigatório para schema empresas_configuracao_estoque'));
  db.run(DDL, (err) => {
    if (err) {
      console.error('Erro ao criar empresas_configuracao_estoque:', err.message);
      return done(err);
    }
    done(null);
  });
}

function garantirSchemaEmpresasConfiguracaoEstoqueAsync(db) {
  return new Promise((resolve, reject) => {
    garantirSchemaEmpresasConfiguracaoEstoque(db, (err) => (err ? reject(err) : resolve()));
  });
}

module.exports = {
  DDL_EMPRESAS_CONFIGURACAO_ESTOQUE: DDL,
  garantirSchemaEmpresasConfiguracaoEstoque,
  garantirSchemaEmpresasConfiguracaoEstoqueAsync
};
