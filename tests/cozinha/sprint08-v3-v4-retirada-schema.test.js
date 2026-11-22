/**
 * S08 KDS — migração isolada do contrato de idempotência para retirada.
 * Usa somente SQLite em memória; sem banco oficial ou serviço operacional.
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_FORCAR_LOCAL = '1';
process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-kds-v4-'));
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const {
  garantirSchemaCozinha,
  migrarCozinhaV3paraV4,
  checkIdempotenciaAceitaRetirada,
  obterSqlTabela,
  lerVersaoSchema
} = require('../../backend/utils/cozinhaSchema');

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function cb(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function open() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => {
      if (err) return reject(err);
      resolve(db);
    });
  });
}

async function seedV3(db) {
  await run(db, `
    CREATE TABLE cozinha_schema_meta (
      chave TEXT PRIMARY KEY NOT NULL,
      valor TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(db, `
    INSERT INTO cozinha_schema_meta (chave, valor) VALUES ('schema_version', '3')
  `);
  await run(db, `
    CREATE TABLE cozinha_idempotencia (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key TEXT NOT NULL,
      tipo_operacao TEXT NOT NULL CHECK (tipo_operacao IN (
        'AUTORIZAR_QTY', 'REDUZIR_TETO', 'DESPACHO_LOTE',
        'PREPARACAO_INICIADA', 'ITEM_PRONTO', 'BEBIDA_ENTREGUE'
      )),
      contexto TEXT,
      payload_hash TEXT NOT NULL,
      situacao TEXT NOT NULL DEFAULT 'EM_ANDAMENTO'
        CHECK (situacao IN ('EM_ANDAMENTO', 'CONCLUIDA', 'FALHA_VALIDACAO')),
      resultado_http_status INTEGER,
      resultado_json TEXT,
      recurso_tipo TEXT,
      recurso_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      concluded_at TEXT
    )
  `);
  await run(db, `
    CREATE UNIQUE INDEX ux_cozinha_idempotencia_key
    ON cozinha_idempotencia(idempotency_key)
  `);
  await run(db, `
    CREATE INDEX idx_cozinha_idempotencia_tipo_recurso
    ON cozinha_idempotencia(tipo_operacao, recurso_id)
  `);
  await run(db, `
    CREATE INDEX idx_cozinha_idempotencia_situacao_criado
    ON cozinha_idempotencia(situacao, created_at)
  `);
  await run(db, `
    INSERT INTO cozinha_idempotencia (
      id, idempotency_key, tipo_operacao, contexto, payload_hash, situacao,
      resultado_http_status, resultado_json, recurso_tipo, recurso_id, created_at, concluded_at
    ) VALUES (
      17, 'prior-operation', 'ITEM_PRONTO', '{"empresa_id":1}', 'hash-v3', 'CONCLUIDA',
      200, '{"success":true}', 'cozinha_item', 8, '2026-11-18 10:00:00', '2026-11-18 10:00:01'
    )
  `);
}

describe('S08 — migração idempotência v3→v4', () => {
  it('cria banco novo diretamente no contrato v4 de retirada', async () => {
    const db = await open();
    try {
      const resultado = await garantirSchemaCozinha(db);
      assert.equal(resultado.operacional, true);
      assert.equal(await lerVersaoSchema(db), 8);
      assert.equal(
        checkIdempotenciaAceitaRetirada(await obterSqlTabela(db, 'cozinha_idempotencia')),
        true
      );
    } finally {
      await new Promise((resolve) => db.close(resolve));
    }
  });

  it('preserva registros e aceita RETIRADA_CONFIRMADA', async () => {
    const db = await open();
    try {
      await seedV3(db);
      const resultado = await migrarCozinhaV3paraV4(db);
      assert.equal(resultado.de, 3);
      assert.equal(resultado.para, 4);
      assert.equal(resultado.registros, 1);

      const row = await get(db, `
        SELECT * FROM cozinha_idempotencia WHERE idempotency_key='prior-operation'
      `);
      assert.equal(row.tipo_operacao, 'ITEM_PRONTO');
      assert.equal(row.payload_hash, 'hash-v3');
      assert.equal(row.resultado_json, '{"success":true}');
      assert.equal(row.concluded_at, '2026-11-18 10:00:01');

      const schema = await get(db, `
        SELECT sql FROM sqlite_master WHERE type='table' AND name='cozinha_idempotencia'
      `);
      assert.equal(checkIdempotenciaAceitaRetirada(schema.sql), true);
      await run(db, `
        INSERT INTO cozinha_idempotencia (
          idempotency_key, tipo_operacao, payload_hash, situacao
        ) VALUES ('pickup-new', 'RETIRADA_CONFIRMADA', 'hash-pickup', 'EM_ANDAMENTO')
      `);
      const integrity = await get(db, 'PRAGMA integrity_check');
      assert.equal(integrity.integrity_check, 'ok');
    } finally {
      await new Promise((resolve) => db.close(resolve));
    }
  });

  it('reverte integralmente se a migração falhar depois da cópia', async () => {
    const db = await open();
    try {
      await seedV3(db);
      await assert.rejects(
        () => migrarCozinhaV3paraV4(db, { simularFalha: 'apos_copia' }),
        (err) => err.codigo === 'COZINHA_MIGRACAO_SIMULADA'
      );
      const row = await get(db, `
        SELECT tipo_operacao, payload_hash
        FROM cozinha_idempotencia WHERE idempotency_key='prior-operation'
      `);
      assert.deepEqual(row, { tipo_operacao: 'ITEM_PRONTO', payload_hash: 'hash-v3' });
      const meta = await get(db, `
        SELECT valor FROM cozinha_schema_meta WHERE chave='schema_version'
      `);
      assert.equal(meta.valor, '3');
      const backup = await get(db, `
        SELECT name FROM sqlite_master WHERE type='table'
          AND name='cozinha_idempotencia__v3_bak'
      `);
      assert.equal(backup, null);
    } finally {
      await new Promise((resolve) => db.close(resolve));
    }
  });
});
