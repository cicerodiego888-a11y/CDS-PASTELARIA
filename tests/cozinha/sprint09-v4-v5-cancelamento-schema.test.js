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

const { garantirSchemaCozinha } = require('../../backend/utils/cozinhaSchema');
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

async function teste_schema_v5_criacao_novo_banco() {
  const { db, tmpDir, dbPath } = await setup();
  try {
    console.log('\n[TEST] schema v5 — criação em banco novo');

    const resultado = await garantirSchemaCozinha(db);
    assert(resultado.operacional === true, 'Schema deve estar operacional');
    assert(resultado.versao === 5, `Versão esperada 5, obtida ${resultado.versao}`);

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
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
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

async function rodarTestes() {
  try {
    await teste_schema_v5_criacao_novo_banco();
    await teste_motivos_cancelamento();
    console.log('\n✓ Todos os testes passaram\n');
  } catch (err) {
    console.error('\n✗ Teste falhou:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

rodarTestes();
