/**
 * Isola testes da Central do banco oficial ANTES de qualquer require de database.js.
 *
 * Uso (primeira linha executável do teste):
 *   const isolamento = require('./helpers/isolarBancoTeste').isolarBancoTeste('rc1-');
 *   const db = require('../../../backend/database');
 *   isolamento.comprobar(db);
 *
 * O require deste módulo já instala o guardião sqlite3 (recusa o caminho oficial).
 * isolarBancoTeste() também aponta DB_DIR para uma pasta temporária.
 *
 * P0.5 — reutiliza backend/lib/sqliteOfficialGuard.js (mesma barreira de database.js).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const guard = require('../../../backend/lib/sqliteOfficialGuard');

const OFICIAL_RE = guard.OFICIAL_DIR_RE;
const MENSAGEM_RECUSA = guard.MENSAGEM_RECUSA;

function caminhoOficialPadrao() {
  return guard.caminhoOficialPadrao();
}

function caminhoEhOficial(alvo) {
  return guard.caminhoEhOficial(alvo);
}

function recusarOficial(filename) {
  return guard.recusarOficial(filename);
}

function instalarGuardiaoSqlite3() {
  process.env.CDS_TEST_ISOLATION = '1';
  process.env.CDS_BLOQUEAR_BANCO_OFICIAL = process.env.CDS_BLOQUEAR_BANCO_OFICIAL || '1';
  return guard.instalarGuardiaoSqlite3({ forcarRecusaOficial: true });
}

function recusarSeDatabaseJaAbertoOficial() {
  let resolved;
  try {
    resolved = require.resolve('../../../backend/database');
  } catch {
    return null;
  }
  if (!require.cache[resolved]) return null;
  const db = require.cache[resolved].exports;
  const aberto = db && (db.dbPath || db.filename);
  recusarOficial(aberto);
  return aberto || null;
}

instalarGuardiaoSqlite3();

function sqlite3Envolvido() {
  try {
    const sqlite3 = require('sqlite3');
    return !!(
      sqlite3.__cdsIsolamentoOficial
      || (sqlite3.Database && sqlite3.Database.__cdsIsolamentoCtor)
    );
  } catch {
    return false;
  }
}

function isolamentoAtivo() {
  const dbDir = process.env.DB_DIR;
  if (!dbDir || caminhoEhOficial(dbDir)) return false;
  return sqlite3Envolvido();
}

function exigirIsolamentoAtivo() {
  recusarSeDatabaseJaAbertoOficial();
  if (!isolamentoAtivo()) {
    throw new Error(
      `${MENSAGEM_RECUSA}: teste protegido executado sem isolamento `
      + '(chame isolarBancoTeste() antes de qualquer import que possa abrir SQLite)'
    );
  }
}

function isolarBancoTeste(prefixo = 'cds-ce-iso-') {
  recusarSeDatabaseJaAbertoOficial();
  if (process.env.DB_DIR && caminhoEhOficial(process.env.DB_DIR)) {
    throw new Error(`DB_DIR aponta para o banco oficial: ${process.env.DB_DIR}`);
  }
  if (!process.env.DB_DIR) {
    process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), prefixo));
  }
  process.env.CDS_FORCAR_LOCAL = process.env.CDS_FORCAR_LOCAL || '1';
  process.env.CDS_TEST_ISOLATION = '1';
  process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
  if (caminhoEhOficial(process.env.DB_DIR)) {
    throw new Error(`Isolamento falhou: DB_DIR oficial ${process.env.DB_DIR}`);
  }

  instalarGuardiaoSqlite3();
  // Valida a mesma regra que database.js usará no require.
  guard.exigirAberturaDatabaseModule({ forcarProtegido: true });
  exigirIsolamentoAtivo();
  console.log(`ISOLAMENTO DE TESTE ATIVO: ${process.env.DB_DIR}`);

  const dbDir = process.env.DB_DIR;
  const dbPathEsperado = path.join(dbDir, 'mercadao.db');

  return {
    dbDir,
    dbPathEsperado,
    comprobar(db) {
      const aberto = db && (db.dbPath || db.filename);
      if (!aberto) {
        throw new Error('database.js não expôs dbPath após o isolamento.');
      }
      recusarOficial(aberto);
      const dirAberto = db.dbDir || path.dirname(String(aberto));
      if (path.resolve(dirAberto) !== path.resolve(dbDir)) {
        throw new Error(
          `Banco aberto fora do isolamento. esperado=${dbDir} aberto=${dirAberto}`
        );
      }
      console.log(`BANCO DE TESTE COMPROVADO: ${aberto}`);
      return String(aberto);
    },
    comprobarSeCarregado() {
      let resolved;
      try {
        resolved = require.resolve('../../../backend/database');
      } catch {
        console.log('BANCO DE TESTE: database.js não resolvido');
        return null;
      }
      if (!require.cache[resolved]) {
        console.log('BANCO DE TESTE: database.js não carregado nesta suíte');
        return null;
      }
      return this.comprobar(require(resolved));
    }
  };
}

module.exports = {
  isolarBancoTeste,
  caminhoEhOficial,
  recusarOficial,
  instalarGuardiaoSqlite3,
  caminhoOficialPadrao,
  recusarSeDatabaseJaAbertoOficial,
  isolamentoAtivo,
  exigirIsolamentoAtivo,
  sqlite3Envolvido,
  OFICIAL_RE,
  MENSAGEM_RECUSA,
  CODIGO_BLOQUEIO: guard.CODIGO_BLOQUEIO,
  detectarContextoProtegido: guard.detectarContextoProtegido,
  exigirAberturaDatabaseModule: guard.exigirAberturaDatabaseModule
};
