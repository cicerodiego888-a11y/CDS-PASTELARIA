/**
 * Schema — categoria fiscal lógica por empresa (Sprint 1 Motor de Vendas).
 * Vínculo explícito produto + empresa -> categoria lógica. Sem saldo, sem reserva, sem movimento.
 * Criado sob demanda (como estoque_empresa); não é aplicado no boot nem no banco oficial.
 *
 * @module services/vendas/categoriaFiscalEmpresaSchema
 */
'use strict';

const CategoriaFiscalLogica = Object.freeze({
  REFRIGERANTE: 'REFRIGERANTE',
  AGUA: 'AGUA'
});

const DDL_CATEGORIA_FISCAL_EMPRESA = `
  CREATE TABLE IF NOT EXISTS produto_categoria_fiscal_empresa (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL,
    produto_id INTEGER NOT NULL,
    categoria_fiscal TEXT NOT NULL CHECK (categoria_fiscal IN ('REFRIGERANTE', 'AGUA')),
    elegivel_composicao INTEGER NOT NULL DEFAULT 0 CHECK (elegivel_composicao IN (0, 1)),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(empresa_id, produto_id),
    FOREIGN KEY (empresa_id) REFERENCES empresas(id),
    FOREIGN KEY (produto_id) REFERENCES produtos(id)
  )
`;

const INDICE_CATEGORIA_FISCAL_EMPRESA = `
  CREATE INDEX IF NOT EXISTS idx_prod_cat_fiscal_empresa_categoria
    ON produto_categoria_fiscal_empresa(empresa_id, categoria_fiscal, elegivel_composicao)
`;

function garantirSchemaCategoriaFiscalEmpresa(db, callback) {
  const done = typeof callback === 'function' ? callback : () => {};
  if (!db) return done(new Error('db obrigatório para schema categoria fiscal'));
  db.run(DDL_CATEGORIA_FISCAL_EMPRESA, (err) => {
    if (err) return done(err);
    db.run(INDICE_CATEGORIA_FISCAL_EMPRESA, (idxErr) => done(idxErr || null));
  });
}

function garantirSchemaCategoriaFiscalEmpresaAsync(db) {
  return new Promise((resolve, reject) => {
    garantirSchemaCategoriaFiscalEmpresa(db, (err) => (err ? reject(err) : resolve()));
  });
}

module.exports = {
  CategoriaFiscalLogica,
  DDL_CATEGORIA_FISCAL_EMPRESA,
  garantirSchemaCategoriaFiscalEmpresa,
  garantirSchemaCategoriaFiscalEmpresaAsync
};
