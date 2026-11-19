/**
 * Correção pontual Sprint 01 — isolamento referencial por empresa + falha de init.
 * Banco temporário apenas.
 *
 *   node --test --test-concurrency=1 tests/cozinha/sprint01-correcao-isolamento-empresa.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cozinha-s01-fix-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const {
  garantirSchemaCozinha,
  isCozinhaOperacional,
  getCozinhaSchemaStatus,
  marcarCozinhaOperacional,
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

function open(arquivo) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(arquivo || ':memory:', (err) => {
      if (err) return reject(err);
      db.run('PRAGMA foreign_keys = ON', (fkErr) => (fkErr ? reject(fkErr) : resolve(db)));
    });
  });
}

function close(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

async function base(db) {
  await run(db, `
    CREATE TABLE IF NOT EXISTS configuracoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chave VARCHAR(100) UNIQUE NOT NULL,
      valor TEXT, tipo VARCHAR(50), descricao TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const info = await garantirSchemaCozinha(db);
  assert.equal(info.operacional, true);
  assert.equal(isCozinhaOperacional(), true);
  return info;
}

async function semearEmpresas(db) {
  await run(db, `INSERT INTO cozinha_unidades (empresa_id, codigo) VALUES (1, 'U-A')`);
  await run(db, `INSERT INTO cozinha_unidades (empresa_id, codigo) VALUES (2, 'U-B')`);
  const uA = await get(db, `SELECT id FROM cozinha_unidades WHERE empresa_id=1`);
  const uB = await get(db, `SELECT id FROM cozinha_unidades WHERE empresa_id=2`);

  await run(db, `
    INSERT INTO cozinha_comandas (empresa_id, atendimento_id, numero_comanda, rotulo)
    VALUES (1, 10, 1, 'A1')
  `);
  await run(db, `
    INSERT INTO cozinha_comandas (empresa_id, atendimento_id, numero_comanda, rotulo)
    VALUES (2, 20, 1, 'B1')
  `);
  const cA = await get(db, `SELECT id FROM cozinha_comandas WHERE empresa_id=1`);
  const cB = await get(db, `SELECT id FROM cozinha_comandas WHERE empresa_id=2`);

  await run(db, `
    INSERT INTO cozinha_rodadas (
      empresa_id, unidade_id, mesa_id, atendimento_id, numero_rodada, sequencia_global
    ) VALUES (1, ?, 1, 10, 1, 1)
  `, [uA.id]);
  await run(db, `
    INSERT INTO cozinha_rodadas (
      empresa_id, unidade_id, mesa_id, atendimento_id, numero_rodada, sequencia_global
    ) VALUES (2, ?, 2, 20, 1, 1)
  `, [uB.id]);
  const rA = await get(db, `SELECT id FROM cozinha_rodadas WHERE empresa_id=1`);
  const rB = await get(db, `SELECT id FROM cozinha_rodadas WHERE empresa_id=2`);

  await run(db, `
    INSERT INTO cozinha_estacoes_impressao (empresa_id, unidade_id, codigo_estacao)
    VALUES (1, ?, 'E-A')
  `, [uA.id]);
  await run(db, `
    INSERT INTO cozinha_estacoes_impressao (empresa_id, unidade_id, codigo_estacao)
    VALUES (2, ?, 'E-B')
  `, [uB.id]);
  const eA = await get(db, `SELECT id FROM cozinha_estacoes_impressao WHERE empresa_id=1`);
  const eB = await get(db, `SELECT id FROM cozinha_estacoes_impressao WHERE empresa_id=2`);

  return { uA, uB, cA, cB, rA, rB, eA, eB };
}

function assertFk(err) {
  assert.match(String(err && err.message), /FOREIGN KEY|constraint/i);
  return true;
}

describe('Correção Sprint 01 — isolamento empresa (FK composta)', () => {
  beforeEach(() => {
    marcarCozinhaOperacional(false);
  });

  it('1) impede rodada empresa A → unidade empresa B', async () => {
    const db = await open();
    await base(db);
    const { uB } = await semearEmpresas(db);
    await assert.rejects(
      () => run(db, `
        INSERT INTO cozinha_rodadas (
          empresa_id, unidade_id, mesa_id, atendimento_id, numero_rodada, sequencia_global
        ) VALUES (1, ?, 9, 99, 2, 2)
      `, [uB.id]),
      assertFk
    );
    await close(db);
  });

  it('2) impede item empresa A → rodada empresa B', async () => {
    const db = await open();
    await base(db);
    const { uA, cA, rB } = await semearEmpresas(db);
    await assert.rejects(
      () => run(db, `
        INSERT INTO cozinha_itens (
          empresa_id, unidade_id, rodada_id, comanda_id, pedido_id, pedido_item_id,
          sequencia_global, tipo_item, qty_solicitada_millis
        ) VALUES (1, ?, ?, ?, 1, 1, 1, 'PASTEL', 1000)
      `, [uA.id, rB.id, cA.id]),
      assertFk
    );
    await close(db);
  });

  it('3) impede item empresa A → comanda empresa B', async () => {
    const db = await open();
    await base(db);
    const { uA, cB, rA } = await semearEmpresas(db);
    await assert.rejects(
      () => run(db, `
        INSERT INTO cozinha_itens (
          empresa_id, unidade_id, rodada_id, comanda_id, pedido_id, pedido_item_id,
          sequencia_global, tipo_item, qty_solicitada_millis
        ) VALUES (1, ?, ?, ?, 1, 2, 1, 'PASTEL', 1000)
      `, [uA.id, rA.id, cB.id]),
      assertFk
    );
    await close(db);
  });

  it('4) impede estação vinculada à unidade de outra empresa', async () => {
    const db = await open();
    await base(db);
    const { uB } = await semearEmpresas(db);
    await assert.rejects(
      () => run(db, `
        INSERT INTO cozinha_estacoes_impressao (empresa_id, unidade_id, codigo_estacao)
        VALUES (1, ?, 'E-X')
      `, [uB.id]),
      assertFk
    );
    await close(db);
  });

  it('5) impede fila de impressão com relacionamentos cruzados', async () => {
    const db = await open();
    await base(db);
    const { uA, rA, eB } = await semearEmpresas(db);
    await assert.rejects(
      () => run(db, `
        INSERT INTO cozinha_impressao_fila (
          empresa_id, unidade_id, estacao_impressao_id, rodada_id, idempotency_key
        ) VALUES (1, ?, ?, ?, 'job-cross')
      `, [uA.id, eB.id, rA.id]),
      assertFk
    );
    // unidade B + rodada A
    await assert.rejects(
      () => run(db, `
        INSERT INTO cozinha_impressao_fila (
          empresa_id, unidade_id, rodada_id, idempotency_key
        ) VALUES (1, (SELECT id FROM cozinha_unidades WHERE empresa_id=2), ?, 'job-cross-2')
      `, [rA.id]),
      assertFk
    );
    await close(db);
  });

  it('6) relacionamentos válidos na mesma empresa funcionam', async () => {
    const db = await open();
    await base(db);
    const { uA, cA, rA, eA } = await semearEmpresas(db);

    await run(db, `
      INSERT INTO cozinha_itens (
        empresa_id, unidade_id, rodada_id, comanda_id, pedido_id, pedido_item_id,
        sequencia_global, tipo_item, qty_solicitada_millis
      ) VALUES (1, ?, ?, ?, 10, 20, 1, 'PASTEL', 2000)
    `, [uA.id, rA.id, cA.id]);
    const item = await get(db, `SELECT id FROM cozinha_itens WHERE empresa_id=1`);

    await run(db, `
      INSERT INTO cozinha_bebida_entregas (
        empresa_id, cozinha_item_id, rodada_id, qty_entregue_millis, qty_restante_millis, operador_id
      ) VALUES (1, ?, ?, 500, 1500, 1)
    `, [item.id, rA.id]);

    await run(db, `
      INSERT INTO cozinha_impressao_fila (
        empresa_id, unidade_id, estacao_impressao_id, rodada_id, idempotency_key
      ) VALUES (1, ?, ?, ?, 'job-ok')
    `, [uA.id, eA.id, rA.id]);

    await run(db, `
      INSERT INTO cozinha_notificacoes (
        empresa_id, unidade_id, rodada_id, evento_chave, modo
      ) VALUES (1, ?, ?, 'evt-ok', 'INDIVIDUAL')
    `, [uA.id, rA.id]);

    const n = await get(db, `SELECT COUNT(*) AS n FROM cozinha_itens WHERE empresa_id=1`);
    assert.equal(n.n, 1);
    await close(db);
  });
});

describe('Correção Sprint 01 — falha de inicialização', () => {
  beforeEach(() => {
    marcarCozinhaOperacional(false);
  });

  it('7) migração falha → Cozinha não operacional + erro específico', async () => {
    const arquivo = path.join(dbDir, 'upgrade-block.sqlite');
    const db = await open(arquivo);
    await base(db);
    const { uA } = await semearEmpresas(db);
    assert.ok(uA.id);

    // Simula schema antigo com dados: força version=1 sem apagar linhas
    await run(db, `
      UPDATE cozinha_schema_meta SET valor='1' WHERE chave='schema_version'
    `);
    await close(db);

    marcarCozinhaOperacional(false);
    const db2 = await open(arquivo);
    await assert.rejects(
      () => garantirSchemaCozinha(db2),
      (err) => err && err.codigo === 'COZINHA_SCHEMA_UPGRADE_BLOQUEADO'
    );
    assert.equal(isCozinhaOperacional(), false);
    const st = getCozinhaSchemaStatus();
    assert.equal(st.operacional, false);
    assert.equal(st.erro.codigo, 'COZINHA_SCHEMA_UPGRADE_BLOQUEADO');
    assert.match(st.erro.mensagem, /FALHA_SCHEMA|recriação/i);
    await close(db2);
  });

  it('8) ERP/banco pode estar pronto enquanto Cozinha não é operacional', async () => {
    // Simula o contrato exportado por database.js sem carregar o banco oficial:
    // falha de schema → isCozinhaOperacional() === false (ERP segue independente).
    marcarCozinhaOperacional(false, {
      message: '[COZINHA] FALHA_SCHEMA: teste',
      codigo: 'COZINHA_SCHEMA_FALHA'
    });
    assert.equal(isCozinhaOperacional(), false);
    const st = getCozinhaSchemaStatus();
    assert.equal(st.operacional, false);
    assert.equal(st.versaoAlvo, COZINHA_SCHEMA_VERSION);

    // Sucesso restaura operacionalidade sem afetar outros módulos
    const db = await open();
    await base(db);
    assert.equal(isCozinhaOperacional(), true);
    assert.equal(getCozinhaSchemaStatus().operacional, true);
    await close(db);
  });
});
