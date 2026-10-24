/**
 * Manutenção destrutiva: apaga usuários e recria admin.
 * Em contexto de teste/verificação a execução é bloqueada pela barreira P0.6
 * (salvo CDS_ALLOW_DESTRUCTIVE_DB_SCRIPT=1 + DB_DIR temporário).
 * Não usar CDS_ALLOW_OFFICIAL_DB como único mecanismo.
 */
'use strict';

const path = require('path');
const bcrypt = require('bcryptjs');
const {
  instalarGuardiaoSqlite3,
  exigirScriptManutencaoDestrutiva,
  CODIGO_BLOQUEIO
} = require('./lib/sqliteOfficialGuard');

instalarGuardiaoSqlite3();

let resolucao;
try {
  resolucao = exigirScriptManutencaoDestrutiva('reset-users');
} catch (err) {
  console.error(`[RESET-USERS] ${err.code || CODIGO_BLOQUEIO}: ${err.message}`);
  process.exit(1);
}

const sqlite3 = require('sqlite3').verbose();
const dbPath = resolucao.dbPath;

console.log(`[RESET-USERS] alvo: ${path.basename(dbPath)} (dir isolado=${!!resolucao.contextoProtegido})`);

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Erro ao conectar ao banco de dados:', err);
    return;
  }
  console.log('Conectado ao banco de dados SQLite');

  db.run('DELETE FROM usuarios', (errDelete) => {
    if (errDelete) {
      console.error('Erro ao deletar usuários:', errDelete);
      return;
    }
    console.log('Usuários deletados');

    const hashedPassword = bcrypt.hashSync('1234', 10);

    db.run(
      'INSERT INTO usuarios (username, password_hash, role) VALUES (?, ?, ?)',
      ['admin', hashedPassword, 'admin'],
      function onInsert(errInsert) {
        if (errInsert) {
          console.error('Erro ao inserir usuário:', errInsert);
          return;
        }
        console.log('Usuário admin inserido com ID:', this.lastID);
        db.close((errClose) => {
          if (errClose) {
            console.error('Erro ao fechar banco:', errClose);
          } else {
            console.log('Banco de dados fechado');
          }
        });
      }
    );
  });
});
