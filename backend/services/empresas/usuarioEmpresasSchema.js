/**
 * Schema — usuario_empresas (Fase 2 / 03.3).
 * Vínculo de autorização. Sem produto_empresa. Sem estoque_empresa.
 *
 * @module services/empresas/usuarioEmpresasSchema
 */
'use strict';

const DDL = `
  CREATE TABLE IF NOT EXISTS usuario_empresas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL,
    empresa_id INTEGER NOT NULL,
    ativo INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(usuario_id, empresa_id),
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id),
    FOREIGN KEY (empresa_id) REFERENCES empresas(id)
  )
`;

const INDICE = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_usuario_empresas_unico
    ON usuario_empresas(usuario_id, empresa_id)
`;

function garantirSchemaUsuarioEmpresas(db, callback) {
  const done = typeof callback === 'function' ? callback : () => {};
  if (!db) return done(new Error('db obrigatório para schema usuario_empresas'));

  db.run(DDL, (err) => {
    if (err) {
      console.error('Erro ao criar tabela usuario_empresas:', err.message);
      return done(err);
    }
    db.run(INDICE, (idxErr) => {
      if (idxErr) {
        console.error('Erro ao criar índice usuario_empresas:', idxErr.message);
        return done(idxErr);
      }
      console.log('Tabela usuario_empresas criada/verificada');
      done(null);
    });
  });
}

function garantirSchemaUsuarioEmpresasAsync(db) {
  return new Promise((resolve, reject) => {
    garantirSchemaUsuarioEmpresas(db, (err) => (err ? reject(err) : resolve()));
  });
}

module.exports = {
  garantirSchemaUsuarioEmpresas,
  garantirSchemaUsuarioEmpresasAsync
};
