/**
 * Sprint G1 — Cancelamento Operacional
 * Teste de schema v4→v5 e operações de cancelamento.
 * Requisitos de execução:
 * - CDS_BLOQUEAR_BANCO_OFICIAL=1
 * - CDS_TEST_ISOLATION=1
 * - CDS_FORCAR_LOCAL=1
 * - DB_DIR apontando para diretório temporário
 */
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3');

const {
  garantirSchemaCozinha,
  getCozinhaSchemaStatus
} = require('../../backend/utils/cozinhaSchema');
const CozinhaPreparacao = require('../../backend/services/cozinha/CozinhaPreparacaoService');

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

function criarBdPrueba(caminhoTemp) {
  return new Promise((resolve, reject) => {
    const dbPath = path.join(caminhoTemp, 'mercadao.db');
    const db = new sqlite3.Database(dbPath, (err) => {
      if (err) return reject(err);
      resolve({ db, path: dbPath });
    });
  });
}

async function setup() {
  if (!process.env.CDS_BLOQUEAR_BANCO_OFICIAL) {
    throw new Error('Requisito: CDS_BLOQUEAR_BANCO_OFICIAL=1');
  }
  if (!process.env.CDS_TEST_ISOLATION) {
    throw new Error('Requisito: CDS_TEST_ISOLATION=1');
  }
  if (!process.env.CDS_FORCAR_LOCAL) {
    throw new Error('Requisito: CDS_FORCAR_LOCAL=1');
  }

  const tmpDir = process.env.DB_DIR || path.join(__dirname, '../../.test-temp');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  const { db, path: dbPath } = await criarBdPrueba(tmpDir);
  return { db, tmpDir, dbPath };
}

function fechaDb(db) {
  return new Promise((resolve) => {
    db.close(() => resolve());
  });
}

async function removerArquivoComRetry(dbPath) {
  for (let tentativa = 0; tentativa < 10; tentativa += 1) {
    try {
      for (const caminho of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        if (fs.existsSync(caminho)) fs.unlinkSync(caminho);
      }
      return;
    } catch (err) {
      if (err.code !== 'EBUSY' && err.code !== 'EPERM') throw err;
      await new Promise(resolve => setTimeout(resolve, 50 * (tentativa + 1)));
    }
  }
  return;
}

async function teste_schema_v5_criacao_novo_banco() {
  const { db, tmpDir, dbPath } = await setup();
  try {
    console.log('\n[TEST] schema v5 — criação em banco novo');

    const resultado = await garantirSchemaCozinha(db);
    assert(resultado.operacional === true, 'Schema deve estar operacional');
    assert(resultado.versao === 9, `Versão esperada 9, obtida ${resultado.versao}`);

    const rodadasInfo = await dbAll(db, 'PRAGMA table_info(cozinha_rodadas)');
    const colNomes = rodadasInfo.map(c => c.name);
    assert(colNomes.includes('cancelamento_motivo'), 'Falta coluna cancelamento_motivo');
    assert(colNomes.includes('cancelamento_justificativa'), 'Falta coluna cancelamento_justificativa');
    assert(colNomes.includes('cancelamento_por'), 'Falta coluna cancelamento_por');
    assert(colNomes.includes('cancelamento_em'), 'Falta coluna cancelamento_em');
    assert(colNomes.includes('cancelamento_etapa'), 'Falta coluna cancelamento_etapa');

    const idempInfo = await dbAll(db, 'PRAGMA table_info(cozinha_idempotencia)');
    const idempColNomes = idempInfo.map(c => c.name);
    assert(idempColNomes.length > 0, 'Tabela cozinha_idempotencia deve existir');

    const checkConstraint = await dbAll(db, `
      SELECT sql FROM sqlite_master
      WHERE type='table' AND name='cozinha_idempotencia'
    `);
    const sql = checkConstraint[0]?.sql || '';
    assert(sql.includes('CANCELAMENTO_RODADA'), 'CHECK deve aceitar CANCELAMENTO_RODADA');

    console.log('[PASS] schema v5 — criação em banco novo');
  } finally {
    await fechaDb(db);
    await removerArquivoComRetry(dbPath);
  }
}

async function teste_motivos_cancelamento() {
  console.log('\n[TEST] motivos de cancelamento validados');

  const motivos = CozinhaPreparacao.MOTIVOS_CANCELAMENTO;
  assert(Array.isArray(motivos), 'MOTIVOS_CANCELAMENTO deve ser array');
  assert(motivos.length === 7, `Esperado 7 motivos, obtido ${motivos.length}`);
  assert(motivos.includes('PRAZO_EXCEDIDO'), 'Deve incluir PRAZO_EXCEDIDO');
  assert(motivos.includes('CLIENTE_DESISTIU'), 'Deve incluir CLIENTE_DESISTIU');
  assert(motivos.includes('CANCELAMENTO_IFOOD'), 'Deve incluir CANCELAMENTO_IFOOD');
  assert(motivos.includes('PEDIDO_DUPLICADO'), 'Deve incluir PEDIDO_DUPLICADO');
  assert(motivos.includes('ERRO_LANCAMENTO'), 'Deve incluir ERRO_LANCAMENTO');
  assert(motivos.includes('FALTA_PRODUTO'), 'Deve incluir FALTA_PRODUTO');
  assert(motivos.includes('OUTRO'), 'Deve incluir OUTRO');

  console.log('[PASS] motivos de cancelamento validados');
}

async function prepararV4(db, rodadasJaAtualizadas = false) {
  await garantirSchemaCozinha(db);
  const objetos = await dbAll(db, `
    SELECT tbl_name, sql FROM sqlite_master
    WHERE type IN ('table', 'index') AND sql IS NOT NULL
      AND tbl_name IN ('cozinha_rodadas', 'cozinha_idempotencia')
  `);
  const sqlRodadas = objetos.find(o => o.sql.startsWith('CREATE TABLE') && o.tbl_name === 'cozinha_rodadas').sql;
  const sqlIdempotencia = objetos.find(o => o.sql.startsWith('CREATE TABLE') && o.tbl_name === 'cozinha_idempotencia').sql;
  const rodadasV4 = sqlRodadas.replace(
    /cancelamento_motivo TEXT[\s\S]*?cancelamento_etapa TEXT,\s*/,
    ''
  );
  const idempotenciaV4 = sqlIdempotencia
    .replace(/,\s*'CANCELAMENTO_RODADA'/, '')
    .replace(/,\s*'PREPARACAO_REVERTIDA'/, '')
    .replace(/,\s*'CANCELAMENTO_ITEM'/, '');
  assert.notStrictEqual(rodadasV4, sqlRodadas);
  assert.notStrictEqual(idempotenciaV4, sqlIdempotencia);

  await dbRun(db, 'PRAGMA foreign_keys=OFF');
  if (!rodadasJaAtualizadas) {
    await dbRun(db, 'DROP TABLE cozinha_rodadas');
    await dbRun(db, rodadasV4);
  }
  await dbRun(db, 'DROP TABLE cozinha_idempotencia');
  await dbRun(db, idempotenciaV4);
  for (const objeto of objetos.filter(o => o.sql.startsWith('CREATE') && !o.sql.startsWith('CREATE TABLE'))) {
    if (!rodadasJaAtualizadas || objeto.tbl_name === 'cozinha_idempotencia') {
      await dbRun(db, objeto.sql);
    }
  }
  await dbRun(db, `UPDATE cozinha_schema_meta SET valor='4' WHERE chave='schema_version'`);
  await dbRun(db, 'PRAGMA foreign_keys=ON');

  await dbRun(db, `INSERT INTO cozinha_unidades (id, empresa_id, codigo) VALUES (1, 1, 'COZINHA')`);
  await dbRun(db, `INSERT INTO cozinha_comandas (id, empresa_id, atendimento_id, numero_comanda, pedido_id)
    VALUES (1, 1, 1, 1, 1)`);
  await dbRun(db, `INSERT INTO cozinha_rodadas (id, empresa_id, unidade_id, mesa_id, atendimento_id, numero_rodada, sequencia_global)
    VALUES (1, 1, 1, 1, 1, 1, 1)`);
  await dbRun(db, `INSERT INTO cozinha_itens (id, empresa_id, unidade_id, rodada_id, comanda_id, pedido_id,
    pedido_item_id, sequencia_global, tipo_item, qty_solicitada_millis, produto_nome_snapshot)
    VALUES (1, 1, 1, 1, 1, 1, 1, 1, 'PASTEL', 1000, 'Pastel')`);
  await dbRun(db, `INSERT INTO cozinha_idempotencia (id, idempotency_key, tipo_operacao, payload_hash, situacao)
    VALUES (1, 'registro-existente', 'RETIRADA_CONFIRMADA', 'hash', 'CONCLUIDA')`);
  await dbRun(db, `UPDATE sqlite_sequence SET seq=25 WHERE name IN ('cozinha_rodadas', 'cozinha_idempotencia')`);
  await dbRun(db, 'CREATE INDEX idx_teste_rodadas ON cozinha_rodadas(mesa_id)');
}

async function teste_migracao_v4_populado(rodadasJaAtualizadas) {
  const { db, dbPath } = await setup();
  try {
    await prepararV4(db, rodadasJaAtualizadas);
    const rodadaAntes = await dbGet(db, 'SELECT id, empresa_id, unidade_id, mesa_id FROM cozinha_rodadas');
    const itemAntes = await dbGet(db, 'SELECT * FROM cozinha_itens');
    const idempotenciaAntes = await dbGet(db, 'SELECT * FROM cozinha_idempotencia');

    await assert.rejects(() => garantirSchemaCozinha(db, { simularFalha: 'apos_copia' }),
      err => err.codigo === 'COZINHA_MIGRACAO_SIMULADA');
    assert.strictEqual((await dbGet(db, `SELECT valor FROM cozinha_schema_meta WHERE chave='schema_version'`)).valor, '4');
    assert.deepStrictEqual(await dbGet(db, 'SELECT * FROM cozinha_itens'), itemAntes);
    assert.deepStrictEqual(await dbGet(db, 'SELECT * FROM cozinha_idempotencia'), idempotenciaAntes);
    assert.strictEqual((await dbGet(db, 'PRAGMA foreign_keys')).foreign_keys, 1);
    assert.strictEqual(getCozinhaSchemaStatus().operacional, false);

    const resultado = await garantirSchemaCozinha(db);
    assert.strictEqual(resultado.operacional, true);
    assert.strictEqual((await dbGet(db, `SELECT valor FROM cozinha_schema_meta WHERE chave='schema_version'`)).valor, '9');
    assert.deepStrictEqual(await dbGet(db, 'SELECT id, empresa_id, unidade_id, mesa_id FROM cozinha_rodadas'), rodadaAntes);
    assert.deepStrictEqual(await dbGet(db, 'SELECT * FROM cozinha_itens'), itemAntes);
    assert.deepStrictEqual(await dbGet(db, 'SELECT * FROM cozinha_idempotencia'), idempotenciaAntes);
    assert.deepStrictEqual(await dbAll(db, 'PRAGMA foreign_key_check'), []);
    assert((await dbAll(db, 'PRAGMA foreign_key_list(cozinha_itens)')).some(f => f.table === 'cozinha_rodadas'));
    assert(await dbGet(db, `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_teste_rodadas'`));
    const seq = await dbAll(db, `SELECT name, seq FROM sqlite_sequence WHERE name IN ('cozinha_rodadas', 'cozinha_idempotencia')`);
    assert(seq.every(row => row.seq >= 25));
    await dbRun(db, `INSERT INTO cozinha_idempotencia (idempotency_key, tipo_operacao, payload_hash)
      VALUES ('novo-cancelamento', 'CANCELAMENTO_RODADA', 'hash')`);
    assert.strictEqual((await garantirSchemaCozinha(db)).operacional, true);
    console.log(`[PASS] migração v4 populada, rodadas atualizadas: ${rodadasJaAtualizadas}`);
  } finally {
    await fechaDb(db);
    await removerArquivoComRetry(dbPath);
  }
}

async function teste_migracao_preserva_sequencia_vazia() {
  const { db, dbPath } = await setup();
  try {
    await prepararV4(db);
    await dbRun(db, 'DELETE FROM cozinha_itens');
    await dbRun(db, 'DELETE FROM cozinha_rodadas');
    await dbRun(db, 'DELETE FROM cozinha_idempotencia');
    await garantirSchemaCozinha(db);
    const seq = await dbAll(db, `SELECT name, seq FROM sqlite_sequence
      WHERE name IN ('cozinha_rodadas', 'cozinha_idempotencia')`);
    assert.strictEqual(seq.length, 2);
    assert(seq.every(row => row.seq >= 25));
    console.log('[PASS] sequências preservadas em tabelas vazias');
  } finally {
    await fechaDb(db);
    await removerArquivoComRetry(dbPath);
  }
}

async function teste_migracao_v5_para_v6() {
  const { db, dbPath } = await setup();
  try {
    await prepararV4(db);
    await garantirSchemaCozinha(db);
    const sql = (await dbGet(db, `SELECT sql FROM sqlite_master
      WHERE type='table' AND name='cozinha_idempotencia'`)).sql;
    const sqlV5 = sql.replace(/,\s*'PREPARACAO_REVERTIDA'/, '').replace(/,\s*'CANCELAMENTO_ITEM'/, '');
    assert.notStrictEqual(sqlV5, sql);
    const indexes = await dbAll(db, `SELECT sql FROM sqlite_master
      WHERE type='index' AND tbl_name='cozinha_idempotencia' AND sql IS NOT NULL`);
    const dados = await dbAll(db, 'SELECT * FROM cozinha_idempotencia ORDER BY id');
    await dbRun(db, 'PRAGMA foreign_keys=OFF');
    await dbRun(db, 'ALTER TABLE cozinha_idempotencia RENAME TO idempotencia_original_teste');
    await dbRun(db, sqlV5);
    await dbRun(db, 'INSERT INTO cozinha_idempotencia SELECT * FROM idempotencia_original_teste');
    await dbRun(db, 'DROP TABLE idempotencia_original_teste');
    for (const index of indexes) await dbRun(db, index.sql);
    await dbRun(db, 'CREATE INDEX idx_idempotencia_teste ON cozinha_idempotencia(contexto)');
    await dbRun(db, `UPDATE sqlite_sequence SET seq=100 WHERE name='cozinha_idempotencia'`);
    await dbRun(db, `UPDATE cozinha_schema_meta SET valor='5' WHERE chave='schema_version'`);
    await dbRun(db, 'PRAGMA foreign_keys=ON');

    await assert.rejects(() => garantirSchemaCozinha(db, { simularFalha: 'v6_apos_copia' }),
      err => err.codigo === 'COZINHA_MIGRACAO_SIMULADA');
    assert.strictEqual((await dbGet(db, `SELECT valor FROM cozinha_schema_meta WHERE chave='schema_version'`)).valor, '5');
    assert.deepStrictEqual(await dbAll(db, 'SELECT * FROM cozinha_idempotencia ORDER BY id'), dados);
    assert.strictEqual((await dbGet(db, 'PRAGMA foreign_keys')).foreign_keys, 1);

    const resultado = await garantirSchemaCozinha(db);
    assert.strictEqual(resultado.migrado_v5_v6, true);
    assert.deepStrictEqual(await dbAll(db, 'SELECT * FROM cozinha_idempotencia ORDER BY id'), dados);
    assert(await dbGet(db, `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_idempotencia_teste'`));
    assert((await dbGet(db, `SELECT seq FROM sqlite_sequence WHERE name='cozinha_idempotencia'`)).seq >= 100);
    assert.deepStrictEqual(await dbAll(db, 'PRAGMA foreign_key_check'), []);
    const inserido = await dbRun(db, `INSERT INTO cozinha_idempotencia (idempotency_key, tipo_operacao, payload_hash)
      VALUES ('novo-retorno', 'PREPARACAO_REVERTIDA', 'hash')`);
    assert(inserido.lastID > 100);
    assert.strictEqual((await garantirSchemaCozinha(db)).versao, 9);
  } finally {
    await fechaDb(db);
    await removerArquivoComRetry(dbPath);
  }
}

async function teste_migracao_v6_para_v7() {
  const { db, dbPath } = await setup();
  try {
    await prepararV4(db);
    await garantirSchemaCozinha(db);
    const sql = (await dbGet(db, `SELECT sql FROM sqlite_master
      WHERE type='table' AND name='cozinha_idempotencia'`)).sql;
    const sqlV6 = sql.replace(/,\s*'CANCELAMENTO_ITEM'/, '');
    assert.notStrictEqual(sqlV6, sql);
    const indexes = await dbAll(db, `SELECT sql FROM sqlite_master
      WHERE type='index' AND tbl_name='cozinha_idempotencia' AND sql IS NOT NULL`);
    const dados = await dbAll(db, 'SELECT * FROM cozinha_idempotencia ORDER BY id');
    await dbRun(db, 'PRAGMA foreign_keys=OFF');
    await dbRun(db, 'ALTER TABLE cozinha_idempotencia RENAME TO idempotencia_original_teste');
    await dbRun(db, sqlV6);
    await dbRun(db, 'INSERT INTO cozinha_idempotencia SELECT * FROM idempotencia_original_teste');
    await dbRun(db, 'DROP TABLE idempotencia_original_teste');
    for (const index of indexes) await dbRun(db, index.sql);
    await dbRun(db, 'CREATE INDEX idx_idempotencia_v7_teste ON cozinha_idempotencia(contexto)');
    await dbRun(db, `UPDATE sqlite_sequence SET seq=100 WHERE name='cozinha_idempotencia'`);
    await dbRun(db, `UPDATE cozinha_schema_meta SET valor='6' WHERE chave='schema_version'`);
    await dbRun(db, 'PRAGMA foreign_keys=ON');
    await assert.rejects(() => garantirSchemaCozinha(db, { simularFalha: 'v7_apos_copia' }),
      err => err.codigo === 'COZINHA_MIGRACAO_SIMULADA');
    assert.strictEqual((await dbGet(db, `SELECT valor FROM cozinha_schema_meta WHERE chave='schema_version'`)).valor, '6');
    assert.deepStrictEqual(await dbAll(db, 'SELECT * FROM cozinha_idempotencia ORDER BY id'), dados);
    assert.strictEqual((await dbGet(db, 'PRAGMA foreign_keys')).foreign_keys, 1);
    const resultado = await garantirSchemaCozinha(db);
    assert.strictEqual(resultado.migrado_v6_v7, true);
    assert.deepStrictEqual(await dbAll(db, 'SELECT * FROM cozinha_idempotencia ORDER BY id'), dados);
    assert(await dbGet(db, `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_idempotencia_v7_teste'`));
    assert((await dbGet(db, `SELECT seq FROM sqlite_sequence WHERE name='cozinha_idempotencia'`)).seq >= 100);
    assert.deepStrictEqual(await dbAll(db, 'PRAGMA foreign_key_check'), []);
    const inserido = await dbRun(db, `INSERT INTO cozinha_idempotencia (idempotency_key, tipo_operacao, payload_hash)
      VALUES ('novo-item-cancelado', 'CANCELAMENTO_ITEM', 'hash')`);
    assert(inserido.lastID > 100);
  } finally {
    await fechaDb(db);
    await removerArquivoComRetry(dbPath);
  }
}

async function rodarTestes() {
  try {
    await teste_schema_v5_criacao_novo_banco();
    await teste_migracao_v4_populado(false);
    await teste_migracao_v4_populado(true);
    await teste_migracao_preserva_sequencia_vazia();
    await teste_migracao_v5_para_v6();
    await teste_migracao_v6_para_v7();
    await teste_motivos_cancelamento();
    console.log('\n✓ Todos os testes passaram\n');
  } catch (err) {
    console.error('\n✗ Teste falhou:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

rodarTestes();
