/**
 * Schema auxiliar para ensaio/migração histórica MCF (lotes + idempotência + auditoria).
 * Não altera MBC.
 * @module motores/mcf/schema/mcfMigracaoHistoricaSchema
 */
'use strict';

const DDL = [
  `CREATE TABLE IF NOT EXISTS mcf_ensaio_ambiente (
    chave TEXT PRIMARY KEY,
    valor TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS contas_pagar_migracao_lotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lote_id TEXT NOT NULL UNIQUE,
    empresa_id INTEGER NOT NULL,
    ambiente_id TEXT NOT NULL,
    fingerprint_capturado TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'aberto',
    itens_planejados INTEGER NOT NULL DEFAULT 0,
    itens_ok INTEGER NOT NULL DEFAULT 0,
    itens_erro INTEGER NOT NULL DEFAULT 0,
    itens_pulados INTEGER NOT NULL DEFAULT 0,
    criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
    atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
    CHECK (status IN ('aberto','em_andamento','interrupido','concluido','abortado'))
  )`,
  `CREATE TABLE IF NOT EXISTS contas_pagar_migracao_historica (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lote_id TEXT NOT NULL,
    empresa_id INTEGER NOT NULL,
    financeiro_id INTEGER NOT NULL,
    conta_pagar_id INTEGER,
    acao TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    payload_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pendente',
    mensagem TEXT,
    dry_run_fingerprint TEXT,
    executed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CHECK (acao IN ('vincular','criar_titulo','ignorar','revisao_manual')),
    CHECK (status IN ('pendente','ok','erro','pulado'))
  )`,
  `CREATE TABLE IF NOT EXISTS contas_pagar_migracao_auditoria (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lote_id TEXT NOT NULL,
    empresa_id INTEGER NOT NULL,
    acao TEXT NOT NULL,
    financeiro_id INTEGER,
    conta_pagar_id INTEGER,
    idempotency_key TEXT,
    detalhes_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mcf_migracao_hist_lote
     ON contas_pagar_migracao_historica(lote_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_mcf_migracao_aud_lote
     ON contas_pagar_migracao_auditoria(lote_id)`
];

function garantirSchemaMcfMigracaoHistorica(db, callback) {
  const cb = typeof callback === 'function' ? callback : () => {};
  if (!db) return cb(new Error('db obrigatório'));
  let i = 0;
  function next(err) {
    if (err) return cb(err);
    if (i >= DDL.length) return cb(null);
    db.run(DDL[i++], next);
  }
  next();
}

function garantirSchemaMcfMigracaoHistoricaAsync(db) {
  return new Promise((resolve, reject) => {
    garantirSchemaMcfMigracaoHistorica(db, (err) => (err ? reject(err) : resolve()));
  });
}

module.exports = {
  garantirSchemaMcfMigracaoHistorica,
  garantirSchemaMcfMigracaoHistoricaAsync,
  DDL_MIGRACAO: DDL
};
