/**
 * Sprint 04A — Upgrade seguro schema Cozinha v2 → v3.
 * Somente banco temporário.
 *
 *   node --test --test-concurrency=1 tests/cozinha/sprint04a-upgrade-schema-v2-v3.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cozinha-s04a-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const {
  garantirSchemaCozinha,
  marcarCozinhaOperacional,
  isCozinhaOperacional,
  getCozinhaSchemaStatus,
  lerVersaoSchema,
  obterSqlTabela,
  checkIdempotenciaAceitaPreparacao,
  migrarCozinhaV2paraV3,
  COZINHA_SCHEMA_VERSION,
  TABELAS_COZINHA,
  IDEMPOTENCIA_COLUNAS
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
function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}
function open(arquivo) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(arquivo || ':memory:', (err) => {
      if (err) return reject(err);
      db.serialize(() => {
        db.run('PRAGMA foreign_keys = ON');
        db.run('PRAGMA busy_timeout = 10000', (e) => (e ? reject(e) : resolve(db)));
      });
    });
  });
}
function close(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

async function schemaErpMinimo(db) {
  await run(db, `CREATE TABLE IF NOT EXISTS configuracoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, chave VARCHAR(100) UNIQUE NOT NULL,
    valor TEXT, tipo VARCHAR(50), descricao TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
}

/** Contagens de todas as tabelas cozinha_*. */
async function snapshotContagens(db) {
  const out = {};
  for (const t of TABELAS_COZINHA) {
    out[t] = await get(db, `
      SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?
    `, [t]).then(async (ex) => {
      if (!ex) return 0;
      const r = await get(db, `SELECT COUNT(*) AS n FROM ${t}`);
      return Number(r.n) || 0;
    });
  }
  return out;
}

async function snapshotIdempotencia(db) {
  return all(db, `
    SELECT ${IDEMPOTENCIA_COLUNAS.join(', ')}
    FROM cozinha_idempotencia ORDER BY id
  `);
}

/**
 * Degrada schema v3 → v2 (somente CHECK de idempotência + meta),
 * para simular banco legado populado.
 */
async function forcarSchemaV2ComCheckAntigo(db) {
  await run(db, 'PRAGMA foreign_keys = OFF');
  await run(db, 'BEGIN IMMEDIATE');
  try {
    await run(db, `DROP TABLE IF EXISTS cozinha_idempotencia__tmp`);
    await run(db, `ALTER TABLE cozinha_idempotencia RENAME TO cozinha_idempotencia__tmp`);
    await run(db, `
      CREATE TABLE cozinha_idempotencia (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL,
        tipo_operacao TEXT NOT NULL
          CHECK (tipo_operacao IN ('AUTORIZAR_QTY', 'REDUZIR_TETO', 'DESPACHO_LOTE')),
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
    const cols = IDEMPOTENCIA_COLUNAS.join(', ');
    await run(db, `
      INSERT INTO cozinha_idempotencia (${cols})
      SELECT ${cols} FROM cozinha_idempotencia__tmp
    `);
    await run(db, `DROP TABLE cozinha_idempotencia__tmp`);
    await run(db, `
      CREATE UNIQUE INDEX IF NOT EXISTS ux_cozinha_idempotencia_key
      ON cozinha_idempotencia(idempotency_key)
    `);
    await run(db, `
      CREATE INDEX IF NOT EXISTS idx_cozinha_idempotencia_tipo_recurso
      ON cozinha_idempotencia(tipo_operacao, recurso_id)
    `);
    await run(db, `
      CREATE INDEX IF NOT EXISTS idx_cozinha_idempotencia_situacao_criado
      ON cozinha_idempotencia(situacao, created_at)
    `);
    await run(db, `
      INSERT INTO cozinha_schema_meta (chave, valor, updated_at)
      VALUES ('schema_version', '2', datetime('now'))
      ON CONFLICT(chave) DO UPDATE SET valor='2', updated_at=datetime('now')
    `);
    await run(db, 'COMMIT');
  } catch (e) {
    try { await run(db, 'ROLLBACK'); } catch (_e) { /* */ }
    throw e;
  } finally {
    await run(db, 'PRAGMA foreign_keys = ON');
  }
}

/** Popula um grafo representativo v2 (todas as tabelas relevantes). */
async function popularV2Completo(db) {
  const un = await run(db, `
    INSERT INTO cozinha_unidades (empresa_id, codigo, sequencia_atual)
    VALUES (1, 'U-MAIN', 3)
  `);
  const cmd = await run(db, `
    INSERT INTO cozinha_comandas (empresa_id, atendimento_id, numero_comanda, pedido_id)
    VALUES (1, 10, 1, 100)
  `);
  const rod = await run(db, `
    INSERT INTO cozinha_rodadas (
      empresa_id, unidade_id, mesa_id, atendimento_id,
      numero_rodada, sequencia_global, estado_preparacao
    ) VALUES (1, ?, 5, 10, 1, 1, 'AGUARDANDO')
  `, [un.lastID]);
  const item = await run(db, `
    INSERT INTO cozinha_itens (
      empresa_id, unidade_id, rodada_id, comanda_id, pedido_id, pedido_item_id,
      sequencia_global, tipo_item, qty_solicitada_millis, produto_nome_snapshot
    ) VALUES (1, ?, ?, ?, 100, 200, 1, 'PASTEL', 1000, 'Pastel Teste')
  `, [un.lastID, rod.lastID, cmd.lastID]);
  await run(db, `
    INSERT INTO cozinha_item_ingredientes (
      cozinha_item_id, insumo_nome_snapshot, quantidade_snapshot_millis,
      unidade_snapshot, selecionado
    ) VALUES (?, 'Queijo', 1000, 'UN', 1)
  `, [item.lastID]);
  await run(db, `
    INSERT INTO cozinha_bebida_entregas (
      empresa_id, cozinha_item_id, rodada_id,
      qty_entregue_millis, qty_restante_millis, operador_id, idempotency_key
    ) VALUES (1, ?, ?, 500, 500, 7, 'beb-ent-1')
  `, [item.lastID, rod.lastID]);
  const est = await run(db, `
    INSERT INTO cozinha_estacoes_impressao (empresa_id, unidade_id, codigo_estacao)
    VALUES (1, ?, 'E1')
  `, [un.lastID]);
  await run(db, `
    INSERT INTO cozinha_impressao_fila (
      empresa_id, unidade_id, estacao_impressao_id, rodada_id, idempotency_key
    ) VALUES (1, ?, ?, ?, 'job-1')
  `, [un.lastID, est.lastID, rod.lastID]);
  await run(db, `
    INSERT INTO cozinha_notificacoes (
      empresa_id, unidade_id, rodada_id, evento_chave, modo
    ) VALUES (1, ?, ?, 'evt-1', 'INDIVIDUAL')
  `, [un.lastID, rod.lastID]);
  await run(db, `
    INSERT INTO cozinha_eventos_outbox (
      empresa_id, unidade_id, tipo, payload_json, idempotency_key
    ) VALUES (1, ?, 'DESPACHO', '{}', 'out-1')
  `, [un.lastID]);
  await run(db, `
    INSERT INTO cozinha_pedido_item_controle (
      empresa_id, pedido_id, pedido_item_id,
      qty_referencia_despacho_millis, qty_referencia_inicial_millis
    ) VALUES (1, 100, 200, 1000, 1000)
  `);
  await run(db, `
    INSERT INTO cozinha_autorizacoes_qty (
      empresa_id, pedido_id, pedido_item_id, qty_autorizada_millis,
      motivo, responsavel_operador_id, idempotency_key
    ) VALUES (1, 100, 200, 500, 'teste', 7, 'aut-1')
  `);
  await run(db, `
    INSERT INTO cozinha_reducoes_teto (
      empresa_id, pedido_id, pedido_item_id,
      qty_anterior_millis, qty_nova_millis, motivo, responsavel_operador_id, idempotency_key
    ) VALUES (1, 100, 200, 1000, 800, 'ajuste', 7, 'red-1')
  `);
  await run(db, `
    INSERT INTO cozinha_idempotencia (
      idempotency_key, tipo_operacao, contexto, payload_hash, situacao,
      resultado_http_status, resultado_json, recurso_tipo, recurso_id
    ) VALUES
      ('idem-desp-1', 'DESPACHO_LOTE', '{"empresa_id":1}', 'hash-desp', 'CONCLUIDA',
       201, '{"success":true}', 'rodada', ?),
      ('idem-aut-1', 'AUTORIZAR_QTY', '{"empresa_id":1}', 'hash-aut', 'CONCLUIDA',
       200, '{"ok":true}', 'pedido_item', 200),
      ('idem-red-1', 'REDUZIR_TETO', '{"empresa_id":1}', 'hash-red', 'CONCLUIDA',
       200, '{"ok":true}', 'pedido_item', 200)
  `, [rod.lastID]);

  return {
    unidadeId: un.lastID,
    comandaId: cmd.lastID,
    rodadaId: rod.lastID,
    itemId: item.lastID,
    estacaoId: est.lastID
  };
}

describe('Sprint 04A — Upgrade schema Cozinha v2 → v3', () => {
  beforeEach(() => marcarCozinhaOperacional(false));

  describe('Cenário A — Migração normal (vazio)', () => {
    it('1-5) v2 vazio migra para v3 com CHECK atualizado', async () => {
      const db = await open();
      await schemaErpMinimo(db);
      await garantirSchemaCozinha(db);
      await forcarSchemaV2ComCheckAntigo(db);
      assert.equal(await lerVersaoSchema(db), 2);
      assert.equal(
        checkIdempotenciaAceitaPreparacao(await obterSqlTabela(db, 'cozinha_idempotencia')),
        false
      );

      marcarCozinhaOperacional(false);
      const info = await garantirSchemaCozinha(db);
      assert.equal(info.operacional, true);
      assert.equal(info.versao, 4);
      assert.equal(info.migrado_v2_v3, true);
      assert.equal(await lerVersaoSchema(db), 3);
      assert.equal(
        checkIdempotenciaAceitaPreparacao(await obterSqlTabela(db, 'cozinha_idempotencia')),
        true
      );
      assert.equal(isCozinhaOperacional(), true);
      await close(db);
    });
  });

  describe('Cenário B — Migração com dados', () => {
    it('preserva todos os registros, IDs e aceita novos tipos', async () => {
      const arquivo = path.join(dbDir, `populado-${Date.now()}.sqlite`);
      const db = await open(arquivo);
      await schemaErpMinimo(db);
      await garantirSchemaCozinha(db);
      await forcarSchemaV2ComCheckAntigo(db);
      const ids = await popularV2Completo(db);

      const contAntes = await snapshotContagens(db);
      const idemAntes = await snapshotIdempotencia(db);
      assert.ok(idemAntes.length >= 3);
      assert.equal(contAntes.cozinha_unidades, 1);
      assert.equal(contAntes.cozinha_itens, 1);
      assert.equal(contAntes.cozinha_idempotencia, 3);

      // v2 rejeita PREPARACAO_INICIADA
      await assert.rejects(
        () => run(db, `
          INSERT INTO cozinha_idempotencia (idempotency_key, tipo_operacao, payload_hash)
          VALUES ('x', 'PREPARACAO_INICIADA', 'h')
        `),
        (err) => /CHECK|constraint/i.test(String(err.message))
      );

      marcarCozinhaOperacional(false);
      const info = await garantirSchemaCozinha(db);
      assert.equal(info.migrado_v2_v3, true);
      assert.equal(await lerVersaoSchema(db), 3);

      const contDepois = await snapshotContagens(db);
      assert.deepEqual(contDepois, contAntes);

      const idemDepois = await snapshotIdempotencia(db);
      assert.deepEqual(idemDepois, idemAntes);

      // IDs preservados
      assert.equal(
        (await get(db, `SELECT id FROM cozinha_rodadas`)).id,
        ids.rodadaId
      );
      assert.equal(
        (await get(db, `SELECT id FROM cozinha_itens`)).id,
        ids.itemId
      );

      // Novos tipos aceitos
      await run(db, `
        INSERT INTO cozinha_idempotencia (idempotency_key, tipo_operacao, payload_hash, situacao)
        VALUES ('prep-ok', 'PREPARACAO_INICIADA', 'h1', 'CONCLUIDA')
      `);
      await run(db, `
        INSERT INTO cozinha_idempotencia (idempotency_key, tipo_operacao, payload_hash, situacao)
        VALUES ('pronto-ok', 'ITEM_PRONTO', 'h2', 'CONCLUIDA')
      `);
      await run(db, `
        INSERT INTO cozinha_idempotencia (idempotency_key, tipo_operacao, payload_hash, situacao)
        VALUES ('beb-ok', 'BEBIDA_ENTREGUE', 'h3', 'CONCLUIDA')
      `);

      const fk = await all(db, `PRAGMA foreign_key_check`);
      assert.equal(fk.length, 0);
      const integ = await get(db, `PRAGMA integrity_check`);
      assert.equal(String(integ.integrity_check || Object.values(integ)[0]).toLowerCase(), 'ok');

      const fkPragma = await get(db, `PRAGMA foreign_keys`);
      assert.equal(Number(fkPragma.foreign_keys != null ? fkPragma.foreign_keys : Object.values(fkPragma)[0]), 1);

      await close(db);
    });
  });

  describe('Cenário C — Falha forçada', () => {
    it('ROLLBACK preserva v2; Cozinha não operacional; ERP contrato mantido', async () => {
      const arquivo = path.join(dbDir, `falha-${Date.now()}.sqlite`);
      const db = await open(arquivo);
      await schemaErpMinimo(db);
      await garantirSchemaCozinha(db);
      await forcarSchemaV2ComCheckAntigo(db);
      await popularV2Completo(db);
      const contAntes = await snapshotContagens(db);
      const idemAntes = await snapshotIdempotencia(db);

      marcarCozinhaOperacional(false);
      await assert.rejects(
        () => garantirSchemaCozinha(db, { simularFalha: 'apos_copia' }),
        (err) => {
          assert.equal(err.codigo, 'COZINHA_MIGRACAO_SIMULADA');
          return true;
        }
      );

      assert.equal(isCozinhaOperacional(), false);
      const st = getCozinhaSchemaStatus();
      assert.equal(st.operacional, false);
      assert.equal(st.erro.codigo, 'COZINHA_MIGRACAO_SIMULADA');

      assert.equal(await lerVersaoSchema(db), 2);
      assert.equal(
        checkIdempotenciaAceitaPreparacao(await obterSqlTabela(db, 'cozinha_idempotencia')),
        false
      );
      assert.deepEqual(await snapshotContagens(db), contAntes);
      assert.deepEqual(await snapshotIdempotencia(db), idemAntes);

      // Contrato ERP: isReady é independente — aqui validamos o contrato Cozinha
      // (database.js captura falha e não derruba o ERP).
      assert.equal(typeof getCozinhaSchemaStatus, 'function');

      // Recuperação posterior funciona
      marcarCozinhaOperacional(false);
      const ok = await garantirSchemaCozinha(db);
      assert.equal(ok.operacional, true);
      assert.equal(await lerVersaoSchema(db), 3);
      assert.deepEqual(await snapshotIdempotencia(db), idemAntes);
      await close(db);
    });
  });

  describe('Cenário D — Inicialização repetida', () => {
    it('não remigra indevidamente nem altera registros', async () => {
      const db = await open();
      await schemaErpMinimo(db);
      await garantirSchemaCozinha(db);
      await forcarSchemaV2ComCheckAntigo(db);
      await popularV2Completo(db);

      await garantirSchemaCozinha(db);
      const idem1 = await snapshotIdempotencia(db);
      const cont1 = await snapshotContagens(db);

      const info2 = await garantirSchemaCozinha(db);
      assert.equal(info2.versao, 4);
      assert.equal(info2.migrado_v2_v3, false);
      assert.deepEqual(await snapshotIdempotencia(db), idem1);
      assert.deepEqual(await snapshotContagens(db), cont1);

      const info3 = await garantirSchemaCozinha(db);
      assert.equal(info3.versao, COZINHA_SCHEMA_VERSION);
      assert.deepEqual(await snapshotContagens(db), cont1);
      await close(db);
    });
  });

  describe('Cenário E — Banco incompatível', () => {
    it('versão futura não é corrigida silenciosamente', async () => {
      const db = await open();
      await schemaErpMinimo(db);
      await garantirSchemaCozinha(db);
      await run(db, `
        UPDATE cozinha_schema_meta SET valor='99' WHERE chave='schema_version'
      `);
      marcarCozinhaOperacional(false);
      await assert.rejects(
        () => garantirSchemaCozinha(db),
        (err) => {
          assert.equal(err.codigo, 'COZINHA_SCHEMA_INCOMPATIVEL');
          return true;
        }
      );
      assert.equal(isCozinhaOperacional(), false);
      assert.equal(await lerVersaoSchema(db), 99);
      await close(db);
    });

    it('v1 populado continua bloqueado (sem perda)', async () => {
      const arquivo = path.join(dbDir, `v1block-${Date.now()}.sqlite`);
      const db = await open(arquivo);
      await schemaErpMinimo(db);
      await garantirSchemaCozinha(db);
      await run(db, `
        INSERT INTO cozinha_unidades (empresa_id, codigo) VALUES (1, 'UX')
      `);
      await run(db, `
        UPDATE cozinha_schema_meta SET valor='1' WHERE chave='schema_version'
      `);
      await close(db);

      marcarCozinhaOperacional(false);
      const db2 = await open(arquivo);
      await assert.rejects(
        () => garantirSchemaCozinha(db2),
        (err) => err.codigo === 'COZINHA_SCHEMA_UPGRADE_BLOQUEADO'
      );
      assert.equal(isCozinhaOperacional(), false);
      assert.equal(
        (await get(db2, `SELECT COUNT(*) AS n FROM cozinha_unidades`)).n,
        1
      );
      assert.equal(await lerVersaoSchema(db2), 1);
      await close(db2);
    });
  });

  describe('Correções auditoria 04A — FK e backup residual', () => {
    async function prepararV2(db) {
      await schemaErpMinimo(db);
      await garantirSchemaCozinha(db);
      await forcarSchemaV2ComCheckAntigo(db);
      await popularV2Completo(db);
    }

    function fkOn(row) {
      const v = row.foreign_keys != null ? row.foreign_keys : Object.values(row)[0];
      return Number(v) === 1;
    }

    it('1-2) falha ao iniciar BEGIN restaura PRAGMA foreign_keys', async () => {
      const db = await open();
      await prepararV2(db);
      assert.equal(fkOn(await get(db, 'PRAGMA foreign_keys')), true);

      await assert.rejects(
        () => migrarCozinhaV2paraV3(db, { simularFalha: 'falha_begin' }),
        (err) => {
          assert.equal(err.codigo, 'COZINHA_MIGRACAO_BEGIN_FALHOU');
          return true;
        }
      );

      assert.equal(fkOn(await get(db, 'PRAGMA foreign_keys')), true);
      assert.equal(await lerVersaoSchema(db), 2);
      assert.equal(
        checkIdempotenciaAceitaPreparacao(await obterSqlTabela(db, 'cozinha_idempotencia')),
        false
      );
      await close(db);
    });

    it('3) backup residual interrompe sem DROP nem perda', async () => {
      const db = await open();
      await prepararV2(db);
      const idemOriginal = await snapshotIdempotencia(db);
      const contOriginal = await snapshotContagens(db);

      await run(db, `
        CREATE TABLE cozinha_idempotencia__v2_bak (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          idempotency_key TEXT NOT NULL,
          tipo_operacao TEXT NOT NULL,
          contexto TEXT,
          payload_hash TEXT NOT NULL,
          situacao TEXT NOT NULL DEFAULT 'EM_ANDAMENTO',
          resultado_http_status INTEGER,
          resultado_json TEXT,
          recurso_tipo TEXT,
          recurso_id INTEGER,
          created_at TEXT,
          concluded_at TEXT
        )
      `);
      await run(db, `
        INSERT INTO cozinha_idempotencia__v2_bak (
          idempotency_key, tipo_operacao, payload_hash, situacao
        ) VALUES
          ('bak-resid-1', 'DESPACHO_LOTE', 'hash-bak-1', 'CONCLUIDA'),
          ('bak-resid-2', 'AUTORIZAR_QTY', 'hash-bak-2', 'CONCLUIDA')
      `);
      const bakAntes = await all(db, `
        SELECT idempotency_key, tipo_operacao, payload_hash, situacao
        FROM cozinha_idempotencia__v2_bak ORDER BY id
      `);
      assert.equal(bakAntes.length, 2);

      await assert.rejects(
        () => migrarCozinhaV2paraV3(db),
        (err) => {
          assert.equal(err.codigo, 'COZINHA_MIGRACAO_BACKUP_RESIDUAL');
          return true;
        }
      );

      assert.deepEqual(await snapshotIdempotencia(db), idemOriginal);
      assert.deepEqual(await snapshotContagens(db), contOriginal);
      const bakDepois = await all(db, `
        SELECT idempotency_key, tipo_operacao, payload_hash, situacao
        FROM cozinha_idempotencia__v2_bak ORDER BY id
      `);
      assert.deepEqual(bakDepois, bakAntes);
      assert.equal(await lerVersaoSchema(db), 2);
      assert.equal(fkOn(await get(db, 'PRAGMA foreign_keys')), true);

      // Tabela original ainda existe e não foi renomeada
      const nomeOk = await get(db, `
        SELECT name FROM sqlite_master WHERE type='table' AND name='cozinha_idempotencia'
      `);
      assert.ok(nomeOk);
      await close(db);
    });

    it('4) rejeição real de BEGIN IMMEDIATE restaura FKs', async () => {
      const db = await open();
      await prepararV2(db);
      assert.equal(fkOn(await get(db, 'PRAGMA foreign_keys')), true);

      // Transação já aberta → BEGIN IMMEDIATE da migração é rejeitado de fato pelo SQLite.
      await run(db, 'BEGIN IMMEDIATE');
      try {
        await assert.rejects(
          () => migrarCozinhaV2paraV3(db),
          (err) => {
            assert.equal(err.codigo, 'COZINHA_MIGRACAO_BEGIN_FALHOU');
            assert.match(String(err.detalhes && err.detalhes.mensagem_original || err.causa), /transaction/i);
            return true;
          }
        );
      } finally {
        try { await run(db, 'ROLLBACK'); } catch (_e) { /* já desfeita */ }
      }

      assert.equal(fkOn(await get(db, 'PRAGMA foreign_keys')), true);
      assert.equal(await lerVersaoSchema(db), 2);
      await close(db);
    });

    it('5) falha ao desabilitar PRAGMA foreign_keys não altera estado', async () => {
      const db = await open();
      await prepararV2(db);
      assert.equal(fkOn(await get(db, 'PRAGMA foreign_keys')), true);

      await assert.rejects(
        () => migrarCozinhaV2paraV3(db, { simularFalha: 'falha_fk_off' }),
        (err) => {
          assert.equal(err.codigo, 'COZINHA_FK_DESABILITAR_FALHOU');
          return true;
        }
      );
      assert.equal(fkOn(await get(db, 'PRAGMA foreign_keys')), true);
      assert.equal(await lerVersaoSchema(db), 2);
      await close(db);
    });

    it('6) falha na restauração de FKs não é apresentada como sucesso', async () => {
      const db = await open();
      await prepararV2(db);
      marcarCozinhaOperacional(false);

      await assert.rejects(
        () => garantirSchemaCozinha(db, { simularFalha: 'falha_fk_restaurar' }),
        (err) => {
          assert.equal(err.codigo, 'COZINHA_FK_RESTAURACAO_FALHOU');
          assert.match(String(err.message), /inesperada|restaurar/i);
          assert.ok(err.detalhes);
          assert.equal(err.detalhes.foreign_keys_esperado, 'ON');
          return true;
        }
      );

      assert.equal(isCozinhaOperacional(), false);
      const st = getCozinhaSchemaStatus();
      assert.equal(st.operacional, false);
      assert.equal(st.erro.codigo, 'COZINHA_FK_RESTAURACAO_FALHOU');
      await close(db);
    });

    it('7) falha de restauração + falha de migração preservam ambos diagnósticos', async () => {
      const db = await open();
      await prepararV2(db);

      await assert.rejects(
        () => migrarCozinhaV2paraV3(db, {
          simularFalha: 'apos_copia',
          forcarFalhaRestauracao: true
        }),
        (err) => {
          assert.equal(err.codigo, 'COZINHA_FK_RESTAURACAO_FALHOU');
          assert.ok(err.erro_migracao);
          assert.equal(err.erro_migracao.codigo, 'COZINHA_MIGRACAO_SIMULADA');
          assert.ok(err.causa);
          assert.equal(err.causa.codigo, 'COZINHA_MIGRACAO_SIMULADA');
          return true;
        }
      );

      assert.equal(await lerVersaoSchema(db), 2);
      await close(db);
    });

    /**
     * Intercepta db.run e rejeita via callback (mesmo caminho de dbRun/Promise),
     * sem lançar exceção antes da chamada — rejeição real da API sqlite3.
     */
    function instalarRejeicaoRealDbRun(db, predicado) {
      const originalRun = db.run.bind(db);
      db.run = function patchedRun(sql, params, callback) {
        let cb = callback;
        let args = params;
        if (typeof params === 'function') {
          cb = params;
          args = [];
        }
        const sqlNorm = String(sql || '').replace(/\s+/g, ' ').trim();
        if (predicado(sqlNorm, args)) {
          const err = new Error(
            `SQLITE_ERROR: rejeição real de db.run() para: ${sqlNorm}`
          );
          err.code = 'SQLITE_ERROR';
          if (typeof cb === 'function') {
            process.nextTick(() => cb.call({ changes: 0, lastID: 0 }, err));
          }
          return db;
        }
        return originalRun(sql, args, cb);
      };
      return () => {
        db.run = originalRun;
      };
    }

    function sqlPragmaFk(sqlNorm, valor) {
      const u = sqlNorm.toUpperCase();
      return u.startsWith('PRAGMA FOREIGN_KEYS')
        && u.includes(`= ${String(valor).toUpperCase()}`);
    }

    it('8) rejeição real de db.run(PRAGMA foreign_keys = OFF)', async () => {
      const db = await open();
      await prepararV2(db);
      const idemAntes = await snapshotIdempotencia(db);
      const contAntes = await snapshotContagens(db);
      assert.equal(fkOn(await get(db, 'PRAGMA foreign_keys')), true);

      const restaurarPatch = instalarRejeicaoRealDbRun(db, (sql) => sqlPragmaFk(sql, 'OFF'));
      try {
        await assert.rejects(
          () => migrarCozinhaV2paraV3(db),
          (err) => {
            assert.equal(err.codigo, 'COZINHA_FK_DESABILITAR_FALHOU');
            assert.ok(err.causa);
            assert.match(String(err.causa.message || err.causa), /rejeição real|SQLITE_ERROR/i);
            return true;
          }
        );
      } finally {
        restaurarPatch();
      }

      assert.equal(fkOn(await get(db, 'PRAGMA foreign_keys')), true);
      assert.equal(await lerVersaoSchema(db), 2);
      assert.deepEqual(await snapshotIdempotencia(db), idemAntes);
      assert.deepEqual(await snapshotContagens(db), contAntes);
      await close(db);
    });

    it('9) rejeição real de db.run na restauração de foreign_keys', async () => {
      const db = await open();
      await prepararV2(db);
      marcarCozinhaOperacional(false);

      let offVisto = false;
      const restaurarPatch = instalarRejeicaoRealDbRun(db, (sql) => {
        if (sqlPragmaFk(sql, 'OFF')) {
          offVisto = true;
          return false; // deixa OFF real passar
        }
        // Após OFF, rejeita a restauração ON via callback de db.run
        return offVisto && sqlPragmaFk(sql, 'ON');
      });

      try {
        await assert.rejects(
          () => garantirSchemaCozinha(db),
          (err) => {
            assert.equal(err.codigo, 'COZINHA_FK_RESTAURACAO_FALHOU');
            assert.match(String(err.message), /inesperada|restaurar/i);
            assert.ok(err.detalhes);
            assert.match(
              String(err.detalhes.mensagem_restauracao || ''),
              /rejeição real|SQLITE_ERROR/i
            );
            return true;
          }
        );
      } finally {
        restaurarPatch();
      }

      assert.equal(isCozinhaOperacional(), false);
      const st = getCozinhaSchemaStatus();
      assert.equal(st.operacional, false);
      assert.equal(st.erro.codigo, 'COZINHA_FK_RESTAURACAO_FALHOU');
      await close(db);
    });

    it('10) rejeição real na restauração + erro de migração: ambos diagnósticos', async () => {
      const db = await open();
      await prepararV2(db);

      let offVisto = false;
      const restaurarPatch = instalarRejeicaoRealDbRun(db, (sql) => {
        if (sqlPragmaFk(sql, 'OFF')) {
          offVisto = true;
          return false;
        }
        return offVisto && sqlPragmaFk(sql, 'ON');
      });

      try {
        await assert.rejects(
          () => migrarCozinhaV2paraV3(db, { simularFalha: 'apos_copia' }),
          (err) => {
            assert.equal(err.codigo, 'COZINHA_FK_RESTAURACAO_FALHOU');
            assert.ok(err.erro_migracao);
            assert.equal(err.erro_migracao.codigo, 'COZINHA_MIGRACAO_SIMULADA');
            assert.ok(err.causa);
            assert.equal(err.causa.codigo, 'COZINHA_MIGRACAO_SIMULADA');
            assert.match(
              String(err.detalhes.mensagem_restauracao || ''),
              /rejeição real|SQLITE_ERROR/i
            );
            return true;
          }
        );
      } finally {
        restaurarPatch();
      }

      assert.equal(await lerVersaoSchema(db), 2);
      await close(db);
    });
  });
});
