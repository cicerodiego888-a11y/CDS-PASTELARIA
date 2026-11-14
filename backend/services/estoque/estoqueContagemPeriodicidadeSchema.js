/**
 * Schema — periodicidade de contagem física por empresa.
 * CDS-ESTOQUE-CONTAGEM-PERIODICIDADE-05.
 *
 * @module services/estoque/estoqueContagemPeriodicidadeSchema
 */
'use strict';

const DDL = `
  CREATE TABLE IF NOT EXISTS empresas_configuracao_contagem_fisica (
    empresa_id INTEGER PRIMARY KEY,
    periodicidade TEXT NOT NULL DEFAULT 'SEMANAL'
      CHECK (periodicidade IN ('SEMANAL', 'QUINZENAL', 'SOB_DEMANDA')),
    intervalo_dias INTEGER,
    ativo INTEGER NOT NULL DEFAULT 1,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
    atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
    atualizado_por INTEGER,
    FOREIGN KEY (empresa_id) REFERENCES empresas(id)
  )
`;

function runSql(db, sql) {
  return new Promise((resolve, reject) => {
    db.run(sql, (err) => (err ? reject(err) : resolve()));
  });
}

function garantirSchemaEstoqueContagemPeriodicidade(db, callback) {
  const done = typeof callback === 'function' ? callback : () => {};
  if (!db) return done(new Error('db obrigatório para schema empresas_configuracao_contagem_fisica'));
  runSql(db, DDL).then(
    () => done(null),
    (err) => {
      console.error('Erro ao criar empresas_configuracao_contagem_fisica:', err.message);
      done(err);
    }
  );
}

function garantirSchemaEstoqueContagemPeriodicidadeAsync(db) {
  return new Promise((resolve, reject) => {
    garantirSchemaEstoqueContagemPeriodicidade(db, (err) => (err ? reject(err) : resolve()));
  });
}

module.exports = {
  DDL_EMPRESAS_CONFIGURACAO_CONTAGEM_FISICA: DDL,
  garantirSchemaEstoqueContagemPeriodicidade,
  garantirSchemaEstoqueContagemPeriodicidadeAsync
};
