/**
 * Schema de canais de venda.
 * CREATE TABLE IF NOT EXISTS não altera tabela já existente.
 * A evolução abaixo só acrescenta coluna ou índice ausente.
 * Reversão segura no SQLite: remover o índice. Colunas adicionadas permanecem.
 *
 * Não executa nada sozinha e não abre o banco oficial.
 */
'use strict';

const COLUNAS_CANAL = Object.freeze([
  ['descricao', 'TEXT'],
  ['tipo_origem', "TEXT NOT NULL DEFAULT 'OUTRO'"],
  ['empresa_id', 'INTEGER'],
  ['ativo', 'INTEGER NOT NULL DEFAULT 1'],
  ['criado_em', "TEXT NOT NULL DEFAULT ''"],
  ['atualizado_em', "TEXT NOT NULL DEFAULT ''"]
]);

const COLUNAS_AUDITORIA = Object.freeze([
  ['empresa_anterior_id', 'INTEGER'],
  ['empresa_nova_id', 'INTEGER'],
  ['ativo_anterior', 'INTEGER'],
  ['ativo_novo', 'INTEGER'],
  ['nome_anterior', 'TEXT'],
  ['nome_novo', 'TEXT'],
  ['descricao_anterior', 'TEXT'],
  ['descricao_nova', 'TEXT'],
  ['tipo_origem_anterior', 'TEXT'],
  ['tipo_origem_novo', 'TEXT'],
  ['usuario_id', 'INTEGER'],
  ['criado_em', "TEXT NOT NULL DEFAULT ''"]
]);

function prometer(db, metodo, sql, params) {
  return new Promise((resolve, reject) => {
    db[metodo](sql, params || [], function (err, rows) {
      if (err) reject(err);
      else if (metodo === 'run') resolve({ lastID: this.lastID, changes: this.changes });
      else resolve(rows);
    });
  });
}

async function colunasDe(db, tabela) {
  const rows = await prometer(db, 'all', `PRAGMA table_info(${tabela})`);
  return new Set((rows || []).map((row) => row.name));
}

async function acrescentarColunas(db, tabela, definicoes) {
  const existentes = await colunasDe(db, tabela);
  if (!existentes.size) return;
  for (const [nome, tipo] of definicoes) {
    if (existentes.has(nome)) continue;
    await prometer(db, 'run', `ALTER TABLE ${tabela} ADD COLUMN ${nome} ${tipo}`);
  }
}

async function garantirSchemaCanaisVendaAsync(db) {
  await prometer(db, 'run', `
    CREATE TABLE IF NOT EXISTS canais_venda (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      codigo TEXT NOT NULL UNIQUE,
      descricao TEXT,
      tipo_origem TEXT NOT NULL,
      empresa_id INTEGER,
      ativo INTEGER NOT NULL DEFAULT 1,
      criado_em TEXT NOT NULL,
      atualizado_em TEXT NOT NULL
    )
  `);
  await prometer(db, 'run', `
    CREATE TABLE IF NOT EXISTS canais_venda_auditoria (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      canal_id INTEGER NOT NULL,
      empresa_anterior_id INTEGER,
      empresa_nova_id INTEGER,
      ativo_anterior INTEGER,
      ativo_novo INTEGER,
      nome_anterior TEXT,
      nome_novo TEXT,
      descricao_anterior TEXT,
      descricao_nova TEXT,
      tipo_origem_anterior TEXT,
      tipo_origem_novo TEXT,
      usuario_id INTEGER,
      criado_em TEXT NOT NULL
    )
  `);
  await acrescentarColunas(db, 'canais_venda', COLUNAS_CANAL);
  await acrescentarColunas(db, 'canais_venda_auditoria', COLUNAS_AUDITORIA);
  await prometer(
    db,
    'run',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_canais_venda_codigo ON canais_venda(codigo)'
  );
}

function garantirSchemaCanaisVenda(db, callback) {
  const done = typeof callback === 'function' ? callback : () => {};
  garantirSchemaCanaisVendaAsync(db).then(() => done(null)).catch(done);
}

async function reverterIndiceCodigoCanaisVenda(db) {
  await prometer(db, 'run', 'DROP INDEX IF EXISTS idx_canais_venda_codigo');
}

module.exports = {
  COLUNAS_CANAL,
  garantirSchemaCanaisVenda,
  garantirSchemaCanaisVendaAsync,
  reverterIndiceCodigoCanaisVenda
};
