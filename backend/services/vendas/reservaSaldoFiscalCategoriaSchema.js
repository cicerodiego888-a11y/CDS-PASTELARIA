/**
 * Schema — reservas do saldo fiscal compartilhado por Pedido (Sprint 2D Motor de Vendas).
 *
 * - `saldo_fiscal_categoria_reservas`: estado atual de cada reserva (ATIVA/LIBERADA).
 * - `saldo_fiscal_categoria_reserva_eventos`: histórico append-only (RESERVA, AJUSTE_RESERVA, LIBERACAO_RESERVA).
 *
 * O ledger da Sprint 2B (`saldo_fiscal_categoria_movimentos`) NÃO é alterado: reservas não mudam
 * `saldo_atual_ml`, portanto não há fato duplicado entre os dois históricos.
 * Sem FK para `pedidos` (empresa_id do Pedido é anulável no schema real e o vínculo é validado pelo serviço).
 * Depende do schema da 2B já criado. Nada é ligado ao boot.
 *
 * @module services/vendas/reservaSaldoFiscalCategoriaSchema
 */
'use strict';

const DDL_RESERVAS = `
  CREATE TABLE IF NOT EXISTS saldo_fiscal_categoria_reservas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL,
    categoria_fiscal TEXT NOT NULL CHECK (categoria_fiscal IN ('REFRIGERANTE', 'AGUA')),
    pedido_id INTEGER NOT NULL CHECK (typeof(pedido_id) = 'integer' AND pedido_id > 0),
    quantidade_reservada_ml INTEGER NOT NULL
      CHECK (typeof(quantidade_reservada_ml) = 'integer' AND quantidade_reservada_ml >= 0),
    status TEXT NOT NULL CHECK (status IN ('ATIVA', 'LIBERADA')),
    idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) > 0),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    liberada_em DATETIME,
    motivo_liberacao TEXT,
    CHECK (
      (status = 'ATIVA' AND quantidade_reservada_ml > 0 AND liberada_em IS NULL)
      OR (status = 'LIBERADA' AND quantidade_reservada_ml = 0 AND liberada_em IS NOT NULL
          AND motivo_liberacao IS NOT NULL AND length(trim(motivo_liberacao)) > 0)
    ),
    FOREIGN KEY (empresa_id) REFERENCES empresas(id),
    FOREIGN KEY (empresa_id, categoria_fiscal)
      REFERENCES saldo_fiscal_categoria_empresa(empresa_id, categoria_fiscal)
  )
`;

const DDL_EVENTOS = `
  CREATE TABLE IF NOT EXISTS saldo_fiscal_categoria_reserva_eventos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reserva_id INTEGER NOT NULL,
    empresa_id INTEGER NOT NULL,
    categoria_fiscal TEXT NOT NULL CHECK (categoria_fiscal IN ('REFRIGERANTE', 'AGUA')),
    pedido_id INTEGER NOT NULL,
    tipo TEXT NOT NULL CHECK (tipo IN ('RESERVA', 'AJUSTE_RESERVA', 'LIBERACAO_RESERVA')),
    quantidade_anterior_ml INTEGER NOT NULL
      CHECK (typeof(quantidade_anterior_ml) = 'integer' AND quantidade_anterior_ml >= 0),
    quantidade_posterior_ml INTEGER NOT NULL
      CHECK (typeof(quantidade_posterior_ml) = 'integer' AND quantidade_posterior_ml >= 0),
    delta_ml INTEGER NOT NULL CHECK (typeof(delta_ml) = 'integer' AND delta_ml <> 0),
    saldo_atual_ml INTEGER NOT NULL CHECK (typeof(saldo_atual_ml) = 'integer' AND saldo_atual_ml >= 0),
    reservado_anterior_ml INTEGER NOT NULL
      CHECK (typeof(reservado_anterior_ml) = 'integer' AND reservado_anterior_ml >= 0),
    reservado_posterior_ml INTEGER NOT NULL
      CHECK (typeof(reservado_posterior_ml) = 'integer' AND reservado_posterior_ml >= 0),
    origem TEXT NOT NULL CHECK (origem IN ('MANUAL', 'SISTEMA')),
    usuario_id INTEGER,
    origem_sistemica TEXT,
    referencia_tipo TEXT NOT NULL CHECK (length(trim(referencia_tipo)) > 0),
    referencia_id TEXT NOT NULL CHECK (length(trim(referencia_id)) > 0),
    idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) > 0),
    motivo TEXT NOT NULL CHECK (length(trim(motivo)) > 0),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (empresa_id, idempotency_key),
    CHECK (delta_ml = quantidade_posterior_ml - quantidade_anterior_ml),
    CHECK (reservado_posterior_ml = reservado_anterior_ml + delta_ml),
    CHECK (reservado_posterior_ml <= saldo_atual_ml),
    CHECK (
      (tipo = 'RESERVA' AND quantidade_anterior_ml = 0 AND quantidade_posterior_ml > 0)
      OR (tipo = 'AJUSTE_RESERVA' AND quantidade_anterior_ml > 0 AND quantidade_posterior_ml > 0)
      OR (tipo = 'LIBERACAO_RESERVA' AND quantidade_anterior_ml > 0 AND quantidade_posterior_ml = 0)
    ),
    CHECK (usuario_id IS NOT NULL OR origem_sistemica IS NOT NULL),
    FOREIGN KEY (reserva_id) REFERENCES saldo_fiscal_categoria_reservas(id),
    FOREIGN KEY (empresa_id) REFERENCES empresas(id),
    FOREIGN KEY (empresa_id, categoria_fiscal)
      REFERENCES saldo_fiscal_categoria_empresa(empresa_id, categoria_fiscal)
  )
`;

const DDL_AUXILIARES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_saldo_fiscal_reserva_ativa_pedido
     ON saldo_fiscal_categoria_reservas(empresa_id, categoria_fiscal, pedido_id)
     WHERE status = 'ATIVA'`,
  `CREATE INDEX IF NOT EXISTS idx_saldo_fiscal_reserva_pedido
     ON saldo_fiscal_categoria_reservas(empresa_id, pedido_id)`,
  `CREATE INDEX IF NOT EXISTS idx_saldo_fiscal_reserva_ev_reserva
     ON saldo_fiscal_categoria_reserva_eventos(reserva_id, id)`,
  `CREATE TRIGGER IF NOT EXISTS trg_saldo_fiscal_reserva_ev_no_update
     BEFORE UPDATE ON saldo_fiscal_categoria_reserva_eventos
     BEGIN SELECT RAISE(ABORT, 'HISTORICO_IMUTAVEL: eventos de reserva nao podem ser alterados'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_saldo_fiscal_reserva_ev_no_delete
     BEFORE DELETE ON saldo_fiscal_categoria_reserva_eventos
     BEGIN SELECT RAISE(ABORT, 'HISTORICO_IMUTAVEL: eventos de reserva nao podem ser excluidos'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_saldo_fiscal_reserva_no_delete
     BEFORE DELETE ON saldo_fiscal_categoria_reservas
     BEGIN SELECT RAISE(ABORT, 'HISTORICO_IMUTAVEL: reservas nao podem ser excluidas'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_saldo_fiscal_reserva_identidade_imutavel
     BEFORE UPDATE OF empresa_id, categoria_fiscal, pedido_id, idempotency_key, created_at
     ON saldo_fiscal_categoria_reservas
     BEGIN SELECT RAISE(ABORT, 'RESERVA_IDENTIDADE_IMUTAVEL: empresa, categoria, pedido e chave nao podem mudar'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_saldo_fiscal_reserva_liberada_final
     BEFORE UPDATE ON saldo_fiscal_categoria_reservas
     WHEN OLD.status = 'LIBERADA'
     BEGIN SELECT RAISE(ABORT, 'RESERVA_LIBERADA_FINAL: reserva liberada nao pode ser alterada'); END`
];

/** Objetos exigidos pelo serviço (verificação somente leitura, sem DDL). */
const OBJETOS_OBRIGATORIOS = [
  'saldo_fiscal_categoria_empresa',
  'saldo_fiscal_categoria_reservas',
  'saldo_fiscal_categoria_reserva_eventos',
  'uq_saldo_fiscal_reserva_ativa_pedido',
  'trg_saldo_fiscal_reserva_ev_no_update',
  'trg_saldo_fiscal_reserva_ev_no_delete'
];

function run(db, sql) {
  return new Promise((resolve, reject) => {
    db.run(sql, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Idempotente. Exige o schema da Sprint 2B já criado (FKs). Deve ser chamado FORA de transação,
 * em migração/preparação controlada; o serviço de reservas nunca o executa.
 */
async function garantirSchemaReservaSaldoFiscalCategoriaAsync(db) {
  if (!db) throw new Error('db obrigatório para schema de reservas do saldo fiscal');
  await run(db, DDL_RESERVAS);
  await run(db, DDL_EVENTOS);
  for (const sql of DDL_AUXILIARES) await run(db, sql);
}

function garantirSchemaReservaSaldoFiscalCategoria(db, callback) {
  const done = typeof callback === 'function' ? callback : () => {};
  garantirSchemaReservaSaldoFiscalCategoriaAsync(db).then(() => done(null), (err) => done(err));
}

module.exports = {
  DDL_RESERVAS,
  DDL_EVENTOS,
  OBJETOS_OBRIGATORIOS,
  garantirSchemaReservaSaldoFiscalCategoria,
  garantirSchemaReservaSaldoFiscalCategoriaAsync
};
