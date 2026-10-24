/**
 * Schema — saldo fiscal compartilhado por empresa e categoria fiscal (Sprint 2B Motor de Vendas).
 *
 * Controle fiscal lógico em mililitros, separado dos saldos físicos de `produtos`/`estoque_empresa`.
 * O chamador fornece a conexão; nada é ligado ao boot, nem migrado, nem calculado a partir de produtos.
 *
 * @module services/vendas/saldoFiscalCategoriaSchema
 */
'use strict';

const DDL_SALDO = `
  CREATE TABLE IF NOT EXISTS saldo_fiscal_categoria_empresa (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL,
    categoria_fiscal TEXT NOT NULL CHECK (categoria_fiscal IN ('REFRIGERANTE', 'AGUA')),
    unidade_base TEXT NOT NULL DEFAULT 'ML' CHECK (unidade_base = 'ML'),
    saldo_atual_ml INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(saldo_atual_ml) = 'integer' AND saldo_atual_ml >= 0),
    saldo_reservado_ml INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(saldo_reservado_ml) = 'integer' AND saldo_reservado_ml >= 0),
    estoque_minimo_ml INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(estoque_minimo_ml) = 'integer' AND estoque_minimo_ml >= 0),
    ativo INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0, 1)),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (empresa_id, categoria_fiscal),
    CHECK (saldo_reservado_ml <= saldo_atual_ml),
    FOREIGN KEY (empresa_id) REFERENCES empresas(id)
  )
`;

const DDL_MOVIMENTOS = `
  CREATE TABLE IF NOT EXISTS saldo_fiscal_categoria_movimentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL,
    categoria_fiscal TEXT NOT NULL CHECK (categoria_fiscal IN ('REFRIGERANTE', 'AGUA')),
    tipo TEXT NOT NULL CHECK (tipo IN ('ABERTURA', 'AJUSTE_ENTRADA', 'AJUSTE_SAIDA', 'ESTORNO')),
    direcao INTEGER NOT NULL CHECK (direcao IN (1, -1)),
    quantidade_ml INTEGER NOT NULL
      CHECK (typeof(quantidade_ml) = 'integer' AND quantidade_ml > 0),
    saldo_anterior_ml INTEGER NOT NULL
      CHECK (typeof(saldo_anterior_ml) = 'integer' AND saldo_anterior_ml >= 0),
    saldo_posterior_ml INTEGER NOT NULL
      CHECK (typeof(saldo_posterior_ml) = 'integer' AND saldo_posterior_ml >= 0),
    origem TEXT NOT NULL CHECK (origem IN ('MANUAL', 'SISTEMA')),
    referencia_tipo TEXT NOT NULL CHECK (length(trim(referencia_tipo)) > 0),
    referencia_id TEXT NOT NULL CHECK (length(trim(referencia_id)) > 0),
    movimento_estornado_id INTEGER,
    idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) > 0),
    usuario_id INTEGER,
    origem_sistemica TEXT,
    produto_id INTEGER,
    quantidade_origem REAL,
    unidade_origem TEXT,
    motivo TEXT NOT NULL CHECK (length(trim(motivo)) > 0),
    metadados_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (empresa_id, idempotency_key),
    CHECK (saldo_posterior_ml = saldo_anterior_ml + direcao * quantidade_ml),
    CHECK (
      (tipo IN ('ABERTURA', 'AJUSTE_ENTRADA') AND direcao = 1)
      OR (tipo = 'AJUSTE_SAIDA' AND direcao = -1)
      OR tipo = 'ESTORNO'
    ),
    CHECK ((tipo = 'ESTORNO') = (movimento_estornado_id IS NOT NULL)),
    CHECK (usuario_id IS NOT NULL OR origem_sistemica IS NOT NULL),
    FOREIGN KEY (empresa_id) REFERENCES empresas(id),
    FOREIGN KEY (empresa_id, categoria_fiscal)
      REFERENCES saldo_fiscal_categoria_empresa(empresa_id, categoria_fiscal),
    FOREIGN KEY (movimento_estornado_id) REFERENCES saldo_fiscal_categoria_movimentos(id),
    FOREIGN KEY (produto_id) REFERENCES produtos(id)
  )
`;

const DDL_OBJETOS_AUXILIARES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_saldo_fiscal_mov_estorno
     ON saldo_fiscal_categoria_movimentos(movimento_estornado_id)
     WHERE movimento_estornado_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_saldo_fiscal_mov_abertura
     ON saldo_fiscal_categoria_movimentos(empresa_id, categoria_fiscal)
     WHERE tipo = 'ABERTURA'`,
  `CREATE INDEX IF NOT EXISTS idx_saldo_fiscal_mov_empresa_categoria_data
     ON saldo_fiscal_categoria_movimentos(empresa_id, categoria_fiscal, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_saldo_fiscal_saldo_empresa
     ON saldo_fiscal_categoria_empresa(empresa_id, categoria_fiscal)`,
  `CREATE TRIGGER IF NOT EXISTS trg_saldo_fiscal_mov_no_update
     BEFORE UPDATE ON saldo_fiscal_categoria_movimentos
     BEGIN SELECT RAISE(ABORT, 'LEDGER_IMUTAVEL: movimentos nao podem ser alterados'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_saldo_fiscal_mov_no_delete
     BEFORE DELETE ON saldo_fiscal_categoria_movimentos
     BEGIN SELECT RAISE(ABORT, 'LEDGER_IMUTAVEL: movimentos nao podem ser excluidos'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_saldo_fiscal_mov_estorno_mesmo_saldo
     BEFORE INSERT ON saldo_fiscal_categoria_movimentos
     WHEN NEW.movimento_estornado_id IS NOT NULL
     BEGIN
       SELECT RAISE(ABORT, 'ESTORNO_INCONSISTENTE: estorno deve referenciar movimento da mesma empresa e categoria')
        WHERE NOT EXISTS (
          SELECT 1 FROM saldo_fiscal_categoria_movimentos o
           WHERE o.id = NEW.movimento_estornado_id
             AND o.empresa_id = NEW.empresa_id
             AND o.categoria_fiscal = NEW.categoria_fiscal
        );
     END`
];

function run(db, sql) {
  return new Promise((resolve, reject) => {
    db.run(sql, (err) => (err ? reject(err) : resolve()));
  });
}

/** Idempotente. Cria somente estas duas tabelas, seus índices e triggers na conexão fornecida. */
async function garantirSchemaSaldoFiscalCategoriaAsync(db) {
  if (!db) throw new Error('db obrigatório para schema saldo fiscal por categoria');
  await run(db, DDL_SALDO);
  await run(db, DDL_MOVIMENTOS);
  for (const sql of DDL_OBJETOS_AUXILIARES) {
    await run(db, sql);
  }
}

function garantirSchemaSaldoFiscalCategoria(db, callback) {
  const done = typeof callback === 'function' ? callback : () => {};
  garantirSchemaSaldoFiscalCategoriaAsync(db).then(() => done(null), (err) => done(err));
}

module.exports = {
  DDL_SALDO,
  DDL_MOVIMENTOS,
  garantirSchemaSaldoFiscalCategoria,
  garantirSchemaSaldoFiscalCategoriaAsync
};
