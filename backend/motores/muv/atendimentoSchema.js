/**
 * Schema persistente do ATENDIMENTO multiempresa (Sprint 04.03).
 * Não altera vendas / vendas_itens. Sem pagamento e sem baixa de estoque.
 *
 * @module motores/muv/atendimentoSchema
 */
'use strict';

const DDL_ATENDIMENTOS = `
  CREATE TABLE IF NOT EXISTS atendimentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo TEXT NOT NULL UNIQUE,
    modo_operacao TEXT NOT NULL,
    origem TEXT NOT NULL,
    status TEXT NOT NULL,
    valor_total REAL NOT NULL DEFAULT 0,
    quantidade_operacoes INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`;

const DDL_ATENDIMENTO_OPERACOES = `
  CREATE TABLE IF NOT EXISTS atendimento_operacoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    atendimento_id INTEGER NOT NULL,
    empresa_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    subtotal REAL NOT NULL DEFAULT 0,
    quantidade_itens INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(atendimento_id, empresa_id),
    FOREIGN KEY (atendimento_id) REFERENCES atendimentos(id)
  )
`;

const DDL_ATENDIMENTO_OPERACAO_ITENS = `
  CREATE TABLE IF NOT EXISTS atendimento_operacao_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operacao_id INTEGER NOT NULL,
    produto_id INTEGER NOT NULL,
    empresa_id INTEGER NOT NULL,
    quantidade REAL NOT NULL,
    valor_unitario REAL NOT NULL,
    valor_total REAL NOT NULL,
    tipo_fiscal TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (operacao_id) REFERENCES atendimento_operacoes(id)
  )
`;

const INDICES = [
  `CREATE INDEX IF NOT EXISTS idx_atendimentos_codigo ON atendimentos(codigo)`,
  `CREATE INDEX IF NOT EXISTS idx_atendimentos_status ON atendimentos(status)`,
  `CREATE INDEX IF NOT EXISTS idx_atendimento_operacoes_atendimento
     ON atendimento_operacoes(atendimento_id)`,
  `CREATE INDEX IF NOT EXISTS idx_atendimento_operacoes_empresa
     ON atendimento_operacoes(empresa_id)`,
  `CREATE INDEX IF NOT EXISTS idx_atendimento_operacao_itens_operacao
     ON atendimento_operacao_itens(operacao_id)`
];

function runSql(db, sql) {
  return new Promise((resolve, reject) => {
    db.run(sql, (err) => (err ? reject(err) : resolve()));
  });
}

function garantirSchemaAtendimento(db, callback) {
  const done = typeof callback === 'function' ? callback : () => {};
  if (!db) return done(new Error('db obrigatório para schema de atendimento'));

  garantirSchemaAtendimentoAsync(db).then(() => done(null)).catch(done);
}

async function garantirSchemaAtendimentoAsync(db) {
  if (!db) throw new Error('db obrigatório para schema de atendimento');
  await runSql(db, DDL_ATENDIMENTOS);
  await runSql(db, DDL_ATENDIMENTO_OPERACOES);
  await runSql(db, DDL_ATENDIMENTO_OPERACAO_ITENS);
  for (const sql of INDICES) {
    await runSql(db, sql);
  }
  console.log('Tabelas atendimentos/operacoes/itens criadas/verificadas');
}

module.exports = {
  DDL_ATENDIMENTOS,
  DDL_ATENDIMENTO_OPERACOES,
  DDL_ATENDIMENTO_OPERACAO_ITENS,
  garantirSchemaAtendimento,
  garantirSchemaAtendimentoAsync
};
