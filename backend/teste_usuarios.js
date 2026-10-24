/**
 * Script ad-hoc de inspeção de usuários.
 * P0.6 — não abre caminhos de produção em contexto de teste/verificação.
 */
'use strict';

const {
  instalarGuardiaoSqlite3,
  exigirAberturaDatabaseModule,
  CODIGO_BLOQUEIO
} = require('./lib/sqliteOfficialGuard');

instalarGuardiaoSqlite3();

let resolucao;
try {
  resolucao = exigirAberturaDatabaseModule();
} catch (err) {
  console.error(`[TESTE_USUARIOS] ${err.code || CODIGO_BLOQUEIO}: ${err.message}`);
  process.exit(1);
}

const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database(resolucao.dbPath);

db.all('PRAGMA table_info(usuarios)', (err, rows) => {
  if (err) {
    console.error(err);
    db.close();
    return;
  }

  console.table(rows);

  db.all('SELECT id, username, role FROM usuarios', (err2, usuarios) => {
    if (err2) {
      console.error(err2);
    } else {
      console.table(usuarios);
    }

    db.close();
  });
});
