/**
 * Schema — contagem física absoluta F×NF por empresa.
 * CDS-ESTOQUE-MANUAL-01. Extensão mínima: produtos_ajustes_estoque não guarda
 * quantidade contada absoluta; esta tabela registra a contagem e os deltas
 * continuam podendo ser espelhados no histórico de ajuste existente.
 *
 * @module services/estoque/estoqueContagemFisicaSchema
 */
'use strict';

const DDL_CABECALHO = `
  CREATE TABLE IF NOT EXISTS estoque_contagens_fisicas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL,
    usuario_id INTEGER,
    usuario_nome TEXT,
    observacao TEXT,
    chave_idempotencia TEXT,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (empresa_id) REFERENCES empresas(id)
  )
`;

const DDL_ITENS = `
  CREATE TABLE IF NOT EXISTS estoque_contagens_fisicas_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contagem_id INTEGER NOT NULL,
    empresa_id INTEGER NOT NULL,
    produto_id INTEGER NOT NULL,
    saldo_fiscal_anterior REAL NOT NULL,
    saldo_nao_fiscal_anterior REAL NOT NULL,
    quantidade_fiscal_contada REAL NOT NULL,
    quantidade_nao_fiscal_contada REAL NOT NULL,
    diferenca_fiscal REAL NOT NULL,
    diferenca_nao_fiscal REAL NOT NULL,
    ajuste_id INTEGER,
    FOREIGN KEY (contagem_id) REFERENCES estoque_contagens_fisicas(id) ON DELETE CASCADE,
    FOREIGN KEY (empresa_id) REFERENCES empresas(id),
    FOREIGN KEY (produto_id) REFERENCES produtos(id)
  )
`;

const IDX_IDEMPOTENCIA = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_estoque_contagens_idempotencia
    ON estoque_contagens_fisicas (empresa_id, chave_idempotencia)
    WHERE chave_idempotencia IS NOT NULL AND chave_idempotencia != ''
`;

const IDX_ITENS_CONTAGEM = `
  CREATE INDEX IF NOT EXISTS idx_estoque_contagens_itens_contagem
    ON estoque_contagens_fisicas_itens (contagem_id)
`;

function runSql(db, sql) {
  return new Promise((resolve, reject) => {
    db.run(sql, (err) => (err ? reject(err) : resolve()));
  });
}

function garantirSchemaEstoqueContagemFisica(db, callback) {
  const done = typeof callback === 'function' ? callback : () => {};
  if (!db) return done(new Error('db obrigatório para schema estoque_contagens_fisicas'));
  (async () => {
    await runSql(db, DDL_CABECALHO);
    await runSql(db, DDL_ITENS);
    await runSql(db, IDX_IDEMPOTENCIA);
    await runSql(db, IDX_ITENS_CONTAGEM);
  })().then(
    () => done(null),
    (err) => {
      console.error('Erro ao garantir schema contagem física:', err.message);
      done(err);
    }
  );
}

function garantirSchemaEstoqueContagemFisicaAsync(db) {
  return new Promise((resolve, reject) => {
    garantirSchemaEstoqueContagemFisica(db, (err) => (err ? reject(err) : resolve()));
  });
}

module.exports = {
  garantirSchemaEstoqueContagemFisica,
  garantirSchemaEstoqueContagemFisicaAsync
};
