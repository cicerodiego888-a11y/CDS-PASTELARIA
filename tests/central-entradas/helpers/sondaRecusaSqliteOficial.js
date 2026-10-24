/**
 * Sonda P0.11 — recusa do caminho oficial no construtor sqlite3, sem database.js.
 *
 * Instala só o wrap (require de isolarBancoTeste.js). Não define DB_DIR.
 * Tenta `new sqlite3.Database(oficial)` e deve lançar MENSAGEM_RECUSA
 * antes do construtor nativo. Não cria cópia e não abre o original.
 *
 * Uso (processo filho, env sem DB_DIR):
 *   node tests/central-entradas/helpers/sondaRecusaSqliteOficial.js
 */
'use strict';

const {
  caminhoOficialPadrao,
  MENSAGEM_RECUSA
} = require('./isolarBancoTeste');
const sqlite3 = require('sqlite3');

const oficial = caminhoOficialPadrao();

try {
  const db = new sqlite3.Database(oficial);
  try { db.close(); } catch { /* ignore */ }
  console.log('SONDA_FALHOU_ABRIU', oficial);
  process.exit(2);
} catch (err) {
  const msg = String(err && err.message ? err.message : err);
  if (msg.includes(MENSAGEM_RECUSA)) {
    console.log('SONDA_RECUSOU_ANTES_DO_SQLITE');
    process.exit(0);
  }
  console.error('SONDA_ERRO_INESPERADO', msg);
  process.exit(3);
}
