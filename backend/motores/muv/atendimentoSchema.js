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
    materializacao_idempotency_key TEXT,
    materializacao_payload_hash TEXT,
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
    venda_id INTEGER UNIQUE,
    materializado_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(atendimento_id, empresa_id),
    FOREIGN KEY (atendimento_id) REFERENCES atendimentos(id)
  )
`;

const DDL_ATENDIMENTO_OPERACAO_RESERVAS = `
  CREATE TABLE IF NOT EXISTS atendimento_operacao_reservas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    atendimento_id INTEGER NOT NULL,
    atendimento_operacao_id INTEGER NOT NULL,
    empresa_id INTEGER NOT NULL,
    produto_id INTEGER NOT NULL,
    item_id INTEGER,
    quantidade_fiscal REAL NOT NULL DEFAULT 0,
    quantidade_nao_fiscal REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (atendimento_id) REFERENCES atendimentos(id),
    FOREIGN KEY (atendimento_operacao_id) REFERENCES atendimento_operacoes(id),
    CHECK (quantidade_fiscal >= 0),
    CHECK (quantidade_nao_fiscal >= 0),
    CHECK (quantidade_fiscal + quantidade_nao_fiscal > 0),
    CHECK (status IN ('ATIVA', 'CANCELADA', 'CONSUMIDA'))
  )
`;

const DDL_ATENDIMENTO_PAGAMENTOS = `
  CREATE TABLE IF NOT EXISTS atendimento_pagamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    atendimento_id INTEGER NOT NULL,
    sequencia INTEGER NOT NULL,
    forma_pagamento TEXT NOT NULL,
    valor_centavos INTEGER NOT NULL,
    valor REAL NOT NULL,
    status TEXT NOT NULL,
    idempotency_key TEXT,
    payload_hash TEXT,
    metadata_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (atendimento_id) REFERENCES atendimentos(id),
    CHECK (valor_centavos >= 0),
    CHECK (valor >= 0),
    UNIQUE(atendimento_id, sequencia)
  )
`;

const DDL_ATENDIMENTO_PAGAMENTO_RATEIOS = `
  CREATE TABLE IF NOT EXISTS atendimento_pagamento_rateios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    atendimento_id INTEGER NOT NULL,
    atendimento_pagamento_id INTEGER NOT NULL,
    atendimento_operacao_id INTEGER NOT NULL,
    empresa_id INTEGER NOT NULL,
    valor_centavos INTEGER NOT NULL,
    valor REAL NOT NULL,
    estrategia_rateio TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (atendimento_id) REFERENCES atendimentos(id),
    FOREIGN KEY (atendimento_pagamento_id) REFERENCES atendimento_pagamentos(id),
    FOREIGN KEY (atendimento_operacao_id) REFERENCES atendimento_operacoes(id),
    CHECK (valor_centavos >= 0),
    CHECK (valor >= 0)
  )
`;

const DDL_ATENDIMENTO_OPERACAO_DOCUMENTOS = `
  CREATE TABLE IF NOT EXISTS atendimento_operacao_documentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    atendimento_id INTEGER NOT NULL,
    atendimento_operacao_id INTEGER NOT NULL UNIQUE,
    empresa_id INTEGER NOT NULL,
    venda_id INTEGER NOT NULL,
    nfce_nota_id INTEGER,
    chave_acesso TEXT,
    numero INTEGER,
    serie INTEGER,
    status TEXT NOT NULL,
    qr_code_url TEXT,
    erro_codigo TEXT,
    erro_mensagem TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (atendimento_id) REFERENCES atendimentos(id),
    FOREIGN KEY (atendimento_operacao_id) REFERENCES atendimento_operacoes(id)
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
     ON atendimento_operacao_itens(operacao_id)`,
  `CREATE INDEX IF NOT EXISTS idx_atendimento_operacao_reservas_atendimento
     ON atendimento_operacao_reservas(atendimento_id)`,
  `CREATE INDEX IF NOT EXISTS idx_atendimento_operacao_reservas_operacao
     ON atendimento_operacao_reservas(atendimento_operacao_id)`,
  `CREATE INDEX IF NOT EXISTS idx_atendimento_operacao_reservas_empresa
     ON atendimento_operacao_reservas(empresa_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_atendimento_operacao_reservas_ativa
     ON atendimento_operacao_reservas(atendimento_operacao_id, produto_id)
     WHERE status = 'ATIVA'`,
  `CREATE INDEX IF NOT EXISTS idx_atendimento_pagamentos_atendimento
     ON atendimento_pagamentos(atendimento_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_atendimento_pagamentos_idem
     ON atendimento_pagamentos(atendimento_id, idempotency_key)
     WHERE idempotency_key IS NOT NULL AND sequencia = 1`,
  `CREATE INDEX IF NOT EXISTS idx_atendimento_pagamento_rateios_atendimento
     ON atendimento_pagamento_rateios(atendimento_id)`,
  `CREATE INDEX IF NOT EXISTS idx_atendimento_pagamento_rateios_pagamento
     ON atendimento_pagamento_rateios(atendimento_pagamento_id)`,
  `CREATE INDEX IF NOT EXISTS idx_atendimento_pagamento_rateios_empresa
     ON atendimento_pagamento_rateios(empresa_id)`,
  `CREATE INDEX IF NOT EXISTS idx_atendimento_pagamento_rateios_operacao
     ON atendimento_pagamento_rateios(atendimento_operacao_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_atendimento_operacoes_venda
     ON atendimento_operacoes(venda_id) WHERE venda_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_atendimento_operacao_documentos_atendimento
     ON atendimento_operacao_documentos(atendimento_id)`,
  `CREATE INDEX IF NOT EXISTS idx_atendimento_operacao_documentos_empresa
     ON atendimento_operacao_documentos(empresa_id)`,
  `CREATE INDEX IF NOT EXISTS idx_atendimento_operacao_documentos_venda
     ON atendimento_operacao_documentos(venda_id)`
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

function tableInfo(db, table) {
  return new Promise((resolve, reject) => {
    db.all(`PRAGMA table_info(${table})`, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function tableSql(db, table) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
      [table],
      (err, row) => (err ? reject(err) : resolve(row && row.sql))
    );
  });
}

async function garantirColuna(db, table, column, ddl) {
  const cols = await tableInfo(db, table);
  if (cols.some((c) => c.name === column)) return;
  await runSql(db, `ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

async function garantirCheckReservaConsumida(db) {
  const sql = await tableSql(db, 'atendimento_operacao_reservas');
  if (!sql || String(sql).includes('CONSUMIDA')) return;
  await runSql(db, 'ALTER TABLE atendimento_operacao_reservas RENAME TO atendimento_operacao_reservas_old');
  await runSql(db, DDL_ATENDIMENTO_OPERACAO_RESERVAS);
  await runSql(db, `
    INSERT INTO atendimento_operacao_reservas (
      id, atendimento_id, atendimento_operacao_id, empresa_id, produto_id, item_id,
      quantidade_fiscal, quantidade_nao_fiscal, status, created_at, updated_at
    )
    SELECT id, atendimento_id, atendimento_operacao_id, empresa_id, produto_id, item_id,
           quantidade_fiscal, quantidade_nao_fiscal, status, created_at, updated_at
      FROM atendimento_operacao_reservas_old
  `);
  await runSql(db, 'DROP TABLE atendimento_operacao_reservas_old');
}

async function garantirSchemaAtendimentoAsync(db) {
  if (!db) throw new Error('db obrigatório para schema de atendimento');
  await runSql(db, DDL_ATENDIMENTOS);
  await runSql(db, DDL_ATENDIMENTO_OPERACOES);
  await runSql(db, DDL_ATENDIMENTO_OPERACAO_ITENS);
  await runSql(db, DDL_ATENDIMENTO_OPERACAO_RESERVAS);
  await runSql(db, DDL_ATENDIMENTO_PAGAMENTOS);
  await runSql(db, DDL_ATENDIMENTO_PAGAMENTO_RATEIOS);
  await runSql(db, DDL_ATENDIMENTO_OPERACAO_DOCUMENTOS);
  await garantirColuna(db, 'atendimentos', 'materializacao_idempotency_key', 'materializacao_idempotency_key TEXT');
  await garantirColuna(db, 'atendimentos', 'materializacao_payload_hash', 'materializacao_payload_hash TEXT');
  await garantirColuna(db, 'atendimento_operacoes', 'venda_id', 'venda_id INTEGER');
  await garantirColuna(db, 'atendimento_operacoes', 'materializado_at', 'materializado_at DATETIME');
  await garantirCheckReservaConsumida(db);
  for (const sql of INDICES) {
    await runSql(db, sql);
  }
  console.log('Tabelas atendimentos/operacoes/itens/reservas/pagamentos criadas/verificadas');
}

module.exports = {
  DDL_ATENDIMENTOS,
  DDL_ATENDIMENTO_OPERACOES,
  DDL_ATENDIMENTO_OPERACAO_ITENS,
  DDL_ATENDIMENTO_OPERACAO_RESERVAS,
  DDL_ATENDIMENTO_PAGAMENTOS,
  DDL_ATENDIMENTO_PAGAMENTO_RATEIOS,
  DDL_ATENDIMENTO_OPERACAO_DOCUMENTOS,
  garantirSchemaAtendimento,
  garantirSchemaAtendimentoAsync
};
