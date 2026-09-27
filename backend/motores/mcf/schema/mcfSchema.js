/**
 * Schema MCF-01 — Contas a Pagar dedicada + pagamentos.
 * Não substitui financeiro legado. Não altera MBC.
 * @module motores/mcf/schema/mcfSchema
 */
'use strict';

const DDL_CONTAS_PAGAR = `
  CREATE TABLE IF NOT EXISTS contas_pagar (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL,
    fornecedor_id INTEGER,
    descricao TEXT,
    valor_original DECIMAL(10,2) NOT NULL,
    valor_restante DECIMAL(10,2) NOT NULL,
    data_emissao DATE,
    data_vencimento DATE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'aberto',
    documento TEXT,
    origem TEXT DEFAULT 'manual',
    referencia_tipo VARCHAR(50),
    referencia_id INTEGER,
    observacao TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (empresa_id) REFERENCES empresas(id),
    FOREIGN KEY (fornecedor_id) REFERENCES fornecedores(id),
    CHECK (valor_original > 0),
    CHECK (valor_restante >= 0),
    CHECK (valor_restante <= valor_original)
  )
`;

const DDL_CONTAS_PAGAR_PAGAMENTOS = `
  CREATE TABLE IF NOT EXISTS contas_pagar_pagamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conta_pagar_id INTEGER NOT NULL,
    empresa_id INTEGER NOT NULL,
    fornecedor_id INTEGER,
    valor_pago DECIMAL(10,2) NOT NULL,
    data_pagamento DATE NOT NULL,
    forma_pagamento VARCHAR(50),
    observacao TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conta_pagar_id) REFERENCES contas_pagar(id),
    FOREIGN KEY (empresa_id) REFERENCES empresas(id),
    CHECK (valor_pago > 0)
  )
`;

const INDICES = [
  `CREATE INDEX IF NOT EXISTS idx_contas_pagar_empresa
     ON contas_pagar(empresa_id)`,
  `CREATE INDEX IF NOT EXISTS idx_contas_pagar_empresa_status
     ON contas_pagar(empresa_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_contas_pagar_vencimento
     ON contas_pagar(empresa_id, data_vencimento)`,
  `CREATE INDEX IF NOT EXISTS idx_contas_pagar_fornecedor
     ON contas_pagar(fornecedor_id)`,
  `CREATE INDEX IF NOT EXISTS idx_contas_pagar_pagamentos_titulo
     ON contas_pagar_pagamentos(conta_pagar_id)`,
  `CREATE INDEX IF NOT EXISTS idx_contas_pagar_pagamentos_empresa
     ON contas_pagar_pagamentos(empresa_id)`
];

function runSeq(db, statements, cb) {
  let i = 0;
  function next(err) {
    if (err) return cb(err);
    if (i >= statements.length) return cb(null);
    const sql = statements[i++];
    db.run(sql, next);
  }
  next();
}

function garantirSchemaMcf(db, callback) {
  const cb = typeof callback === 'function' ? callback : () => {};
  if (!db) return cb(new Error('db obrigatório'));
  const stmts = [DDL_CONTAS_PAGAR, DDL_CONTAS_PAGAR_PAGAMENTOS].concat(INDICES);
  runSeq(db, stmts, (err) => {
    if (err) {
      console.error('Erro ao garantir schema MCF:', err.message);
      return cb(err);
    }
    console.log('Schema MCF (contas_pagar) criado/verificado');
    cb(null);
  });
}

function garantirSchemaMcfAsync(db) {
  return new Promise((resolve, reject) => {
    garantirSchemaMcf(db, (err) => (err ? reject(err) : resolve()));
  });
}

module.exports = {
  garantirSchemaMcf,
  garantirSchemaMcfAsync,
  DDL_CONTAS_PAGAR,
  DDL_CONTAS_PAGAR_PAGAMENTOS
};
