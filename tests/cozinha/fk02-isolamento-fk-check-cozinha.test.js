/**
 * FK-02 — Isolamento da validação FK do domínio Cozinha (migração v2→v3).
 * Somente banco temporário. Sem tocar banco oficial.
 *
 *   set CDS_BLOQUEAR_BANCO_OFICIAL=1
 *   node --test --test-concurrency=1 tests/cozinha/fk02-isolamento-fk-check-cozinha.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cozinha-fk02-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const {
  garantirSchemaCozinha,
  marcarCozinhaOperacional,
  isCozinhaOperacional,
  lerVersaoSchema,
  obterSqlTabela,
  checkIdempotenciaAceitaPreparacao,
  verificarForeignKeysDominioCozinha,
  TABELAS_COZINHA,
  TABELAS_COZINHA_FK_CHECK,
  IDEMPOTENCIA_COLUNAS,
  COZINHA_SCHEMA_VERSION
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

/** Espelha órfãos legados do diagnóstico FK-01 (ERP → produtos). */
async function semearOrfaosErpLegados(db) {
  await run(db, `
    CREATE TABLE IF NOT EXISTS produtos (
      id INTEGER PRIMARY KEY,
      nome TEXT
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS produto_unidades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produto_id INTEGER NOT NULL,
      unidade TEXT,
      FOREIGN KEY (produto_id) REFERENCES produtos(id)
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS produtos_ajustes_estoque (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produto_id INTEGER NOT NULL,
      qtd REAL,
      FOREIGN KEY (produto_id) REFERENCES produtos(id)
    )
  `);
  // Produtos "atuais" (faixa alta) — órfãos apontam para IDs baixos inexistentes.
  await run(db, `INSERT INTO produtos (id, nome) VALUES (747, 'Pastel A'), (748, 'Pastel B')`);
  await run(db, 'PRAGMA foreign_keys = OFF');
  try {
    await run(db, `
      INSERT INTO produto_unidades (produto_id, unidade) VALUES
        (1, 'UN'), (2, 'UN'), (3, 'UN'), (10, 'UN'), (553, 'UN')
    `);
    await run(db, `
      INSERT INTO produtos_ajustes_estoque (produto_id, qtd) VALUES
        (1, 1), (2, 2), (99, -1)
    `);
  } finally {
    await run(db, 'PRAGMA foreign_keys = ON');
  }
  const globais = await all(db, 'PRAGMA foreign_key_check');
  assert.ok(globais.length >= 8, 'órfãos ERP devem existir no check global');
  return {
    orfaosUnidades: await get(db, `
      SELECT COUNT(*) AS n FROM produto_unidades u
      LEFT JOIN produtos p ON p.id = u.produto_id WHERE p.id IS NULL
    `),
    snapshotUnidades: await all(db, `SELECT id, produto_id, unidade FROM produto_unidades ORDER BY id`),
    snapshotAjustes: await all(db, `SELECT id, produto_id, qtd FROM produtos_ajustes_estoque ORDER BY id`),
    fkGlobalAntes: globais.length
  };
}

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

async function popularCozinhaMinima(db) {
  const un = await run(db, `
    INSERT INTO cozinha_unidades (empresa_id, codigo, sequencia_atual)
    VALUES (1, 'U-FK02', 1)
  `);
  const cmd = await run(db, `
    INSERT INTO cozinha_comandas (empresa_id, atendimento_id, numero_comanda, pedido_id)
    VALUES (1, 1, 1, 10)
  `);
  const rod = await run(db, `
    INSERT INTO cozinha_rodadas (
      empresa_id, unidade_id, mesa_id, atendimento_id,
      numero_rodada, sequencia_global, estado_preparacao
    ) VALUES (1, ?, 1, 1, 1, 1, 'AGUARDANDO')
  `, [un.lastID]);
  await run(db, `
    INSERT INTO cozinha_itens (
      empresa_id, unidade_id, rodada_id, comanda_id, pedido_id, pedido_item_id,
      sequencia_global, tipo_item, qty_solicitada_millis, produto_nome_snapshot
    ) VALUES (1, ?, ?, ?, 10, 20, 1, 'PASTEL', 1000, 'Pastel FK02')
  `, [un.lastID, rod.lastID, cmd.lastID]);
  await run(db, `
    INSERT INTO cozinha_idempotencia (idempotency_key, tipo_operacao, payload_hash, situacao)
    VALUES ('fk02-desp', 'DESPACHO_LOTE', 'h', 'CONCLUIDA')
  `);
  return { unidadeId: un.lastID, rodadaId: rod.lastID, comandaId: cmd.lastID };
}

describe('FK-02 — lista controlada', () => {
  it('TABELAS_COZINHA_FK_CHECK espelha TABELAS_COZINHA e só aceita identificadores internos', () => {
    assert.deepEqual([...TABELAS_COZINHA_FK_CHECK], [...TABELAS_COZINHA]);
    assert.ok(TABELAS_COZINHA_FK_CHECK.includes('cozinha_itens'));
    assert.ok(TABELAS_COZINHA_FK_CHECK.includes('cozinha_idempotencia'));
    assert.equal(TABELAS_COZINHA_FK_CHECK.includes('produto_unidades'), false);
    assert.equal(TABELAS_COZINHA_FK_CHECK.includes('produtos'), false);
  });
});

describe('FK-02 Cenário A — legado ERP não bloqueia Cozinha', () => {
  beforeEach(() => marcarCozinhaOperacional(false));

  it('órfãos ERP persistem e migração v2→v3 conclui', async () => {
    const arquivo = path.join(dbDir, `a-legado-${Date.now()}.sqlite`);
    const db = await open(arquivo);
    await schemaErpMinimo(db);
    const legado = await semearOrfaosErpLegados(db);

    await garantirSchemaCozinha(db);
    await forcarSchemaV2ComCheckAntigo(db);
    assert.equal(await lerVersaoSchema(db), 2);

    marcarCozinhaOperacional(false);
    const info = await garantirSchemaCozinha(db);
    assert.equal(info.operacional, true);
    assert.equal(await lerVersaoSchema(db), 3);
    assert.equal(isCozinhaOperacional(), true);
    assert.equal(COZINHA_SCHEMA_VERSION, 4);
    assert.equal(
      checkIdempotenciaAceitaPreparacao(await obterSqlTabela(db, 'cozinha_idempotencia')),
      true
    );

    const dominio = await verificarForeignKeysDominioCozinha(db);
    assert.equal(dominio.length, 0);

    const globais = await all(db, 'PRAGMA foreign_key_check');
    assert.ok(globais.length >= legado.fkGlobalAntes, 'órfãos ERP ainda visíveis no check global');
    assert.deepEqual(
      await all(db, `SELECT id, produto_id, unidade FROM produto_unidades ORDER BY id`),
      legado.snapshotUnidades
    );
    assert.deepEqual(
      await all(db, `SELECT id, produto_id, qtd FROM produtos_ajustes_estoque ORDER BY id`),
      legado.snapshotAjustes
    );

    await close(db);
  });
});

describe('FK-02 Cenário B — integridade Cozinha válida', () => {
  beforeEach(() => marcarCozinhaOperacional(false));

  it('domínio válido migra e valida relações internas', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    await garantirSchemaCozinha(db);
    await forcarSchemaV2ComCheckAntigo(db);
    await popularCozinhaMinima(db);

    const antes = await verificarForeignKeysDominioCozinha(db);
    assert.equal(antes.length, 0);

    marcarCozinhaOperacional(false);
    const info = await garantirSchemaCozinha(db);
    assert.equal(info.operacional, true);
    assert.equal(await lerVersaoSchema(db), 3);

    const depois = await verificarForeignKeysDominioCozinha(db);
    assert.equal(depois.length, 0);
    const item = await get(db, `SELECT COUNT(*) AS n FROM cozinha_itens`);
    assert.equal(Number(item.n), 1);
    await close(db);
  });
});

describe('FK-02 Cenário C — violação interna bloqueia', () => {
  beforeEach(() => marcarCozinhaOperacional(false));

  it('FK inválida em cozinha_itens impede v3', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    await garantirSchemaCozinha(db);
    await forcarSchemaV2ComCheckAntigo(db);
    const ids = await popularCozinhaMinima(db);

    await run(db, 'PRAGMA foreign_keys = OFF');
    try {
      await run(db, `
        INSERT INTO cozinha_itens (
          empresa_id, unidade_id, rodada_id, comanda_id, pedido_id, pedido_item_id,
          sequencia_global, tipo_item, qty_solicitada_millis, produto_nome_snapshot
        ) VALUES (1, ?, 999999, ?, 10, 21, 2, 'PASTEL', 1000, 'Orfao interno')
      `, [ids.unidadeId, ids.comandaId]);
    } finally {
      await run(db, 'PRAGMA foreign_keys = ON');
    }

    const viol = await verificarForeignKeysDominioCozinha(db);
    assert.ok(viol.length >= 1);
    assert.ok(viol.some((v) => v.table === 'cozinha_itens' && v.parent === 'cozinha_rodadas'));

    marcarCozinhaOperacional(false);
    await assert.rejects(
      () => garantirSchemaCozinha(db),
      (err) => {
        assert.equal(err.codigo, 'COZINHA_FK_CHECK_FALHOU');
        return true;
      }
    );
    assert.equal(await lerVersaoSchema(db), 2);
    assert.equal(isCozinhaOperacional(), false);
    assert.equal(
      checkIdempotenciaAceitaPreparacao(await obterSqlTabela(db, 'cozinha_idempotencia')),
      false
    );
    await close(db);
  });
});

describe('FK-02 Cenário D — referência Cozinha → ERP protegida', () => {
  beforeEach(() => marcarCozinhaOperacional(false));

  it('FK declarada para tabela ERP é detectada no check do domínio', async () => {
    const db = await open();
    await schemaErpMinimo(db);
    await run(db, `
      CREATE TABLE IF NOT EXISTS empresas (
        id INTEGER PRIMARY KEY,
        nome TEXT
      )
    `);
    await garantirSchemaCozinha(db);
    await forcarSchemaV2ComCheckAntigo(db);

    // Reconstrói cozinha_unidades com FK explícita para ERP (empresas),
    // simulando referência compartilhada declarada pelo domínio.
    await run(db, 'PRAGMA foreign_keys = OFF');
    try {
      await run(db, 'ALTER TABLE cozinha_unidades RENAME TO cozinha_unidades__fk02');
      await run(db, `
        CREATE TABLE cozinha_unidades (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          empresa_id INTEGER NOT NULL,
          codigo TEXT NOT NULL,
          ativo INTEGER NOT NULL DEFAULT 1,
          sequencia_atual INTEGER NOT NULL DEFAULT 0,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT,
          CHECK (sequencia_atual >= 0),
          UNIQUE (id, empresa_id),
          FOREIGN KEY (empresa_id) REFERENCES empresas(id)
        )
      `);
      await run(db, `
        INSERT INTO cozinha_unidades (
          id, empresa_id, codigo, ativo, sequencia_atual, created_at, updated_at
        )
        SELECT id, empresa_id, codigo, ativo, sequencia_atual, created_at, updated_at
        FROM cozinha_unidades__fk02
      `);
      await run(db, 'DROP TABLE cozinha_unidades__fk02');
      await run(db, `
        INSERT INTO cozinha_unidades (empresa_id, codigo, sequencia_atual)
        VALUES (424242, 'U-ORFAO-ERP', 0)
      `);
    } finally {
      await run(db, 'PRAGMA foreign_keys = ON');
    }

    const fks = await all(db, `PRAGMA foreign_key_list('cozinha_unidades')`);
    assert.ok(fks.some((f) => f.table === 'empresas' && f.from === 'empresa_id'));

    const viol = await verificarForeignKeysDominioCozinha(db);
    assert.ok(viol.length >= 1);
    assert.ok(viol.some((v) =>
      v.table === 'cozinha_unidades' && v.parent === 'empresas'));

    marcarCozinhaOperacional(false);
    await assert.rejects(
      () => garantirSchemaCozinha(db),
      (err) => err.codigo === 'COZINHA_FK_CHECK_FALHOU'
    );
    assert.equal(await lerVersaoSchema(db), 2);
    await close(db);
  });
});

describe('FK-02 Cenário E — regressão gate / schema', () => {
  beforeEach(() => marcarCozinhaOperacional(false));

  it('gate operacional permanece; lista FK check estável; S04A migration ok', async () => {
    assert.deepEqual([...TABELAS_COZINHA_FK_CHECK], [...TABELAS_COZINHA]);

    const db = await open();
    await schemaErpMinimo(db);
    await semearOrfaosErpLegados(db);
    await garantirSchemaCozinha(db);
    assert.equal(isCozinhaOperacional(), true);
    assert.equal(await lerVersaoSchema(db), 3);

    // Simula módulo off + ensure com domínio limpo → volta a operacional.
    marcarCozinhaOperacional(false, new Error('simulado'));
    assert.equal(isCozinhaOperacional(), false);
    const info = await garantirSchemaCozinha(db);
    assert.equal(info.operacional, true);
    assert.equal(isCozinhaOperacional(), true);

    await close(db);
  });

  it('regressão direcionada Sprint 04A (arquivo de teste intacto no disco)', () => {
    const src = fs.readFileSync(
      path.join(__dirname, 'sprint04a-upgrade-schema-v2-v3.test.js'),
      'utf8'
    );
    assert.match(src, /Sprint 04A/);
    assert.match(src, /migrarCozinhaV2paraV3|garantirSchemaCozinha/);
  });
});
