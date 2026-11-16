/**
 * Backup local: pasta padrão + existência do dia.
 *
 * node --test --test-concurrency=1 tests/backup/backup-local-diario.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  obterPastaBackup,
  dataLocalBrasil,
  prefixoBackupDoDia,
  existeBackupDoDia,
  fazerBackupManual
} = require('../../backend/services/backupManual');

describe('Backup local diário', () => {
  it('usa pasta backups ao lado do banco como padrão', () => {
    const dbPath = path.join('C:', 'tmp', 'cds-test', 'mercadao.db');
    assert.equal(obterPastaBackup(dbPath), path.join('C:', 'tmp', 'cds-test', 'backups'));
  });

  it('detecta backup do dia pelo prefixo do arquivo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-bkp-'));
    const hoje = dataLocalBrasil();
    const nome = `${prefixoBackupDoDia(hoje)}10-00-00.db`;
    assert.equal(existeBackupDoDia(dir, hoje), false);
    fs.writeFileSync(path.join(dir, nome), 'x');
    assert.equal(existeBackupDoDia(dir, hoje), true);
  });

  it('fazerBackupManual cria cópia .db recuperável e espelho -ultimo', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-bkp-src-'));
    const dbPath = path.join(root, 'mercadao.db');
    const dest = path.join(root, 'backups');
    const sqlite3 = require('sqlite3').verbose();
    await new Promise((resolve, reject) => {
      const db = new sqlite3.Database(dbPath);
      db.serialize(() => {
        db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, n TEXT)');
        db.run('INSERT INTO t(n) VALUES (?)', ['ok'], (err) => {
          db.close(() => (err ? reject(err) : resolve()));
        });
      });
    });
    const out = await fazerBackupManual(dbPath, dest);
    assert.equal(out.sucesso, true);
    assert.equal(out.recuperavel, true);
    assert.ok(fs.existsSync(out.caminho));
    assert.ok(out.arquivo.startsWith('backup_pdv_'));
    assert.ok(out.ultimo && fs.existsSync(out.ultimo));
    assert.match(path.basename(out.ultimo), /ultimo\.db$/i);
    assert.ok(Number(out.tamanho_bytes) > 0);
  });

  it('rota manual não exige backup_path prévio (usa resolver)', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../backend/rotas/backup.js'),
      'utf8'
    );
    assert.match(src, /resolverPastaBackupOperacional/);
    assert.doesNotMatch(src, /Configure a pasta de backup primeiro/);
    assert.match(src, /garantir-diario/);
    assert.match(src, /iniciarBackupAutomaticoLocal/);
  });

  it('serviço automático agenda 23:59', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../backend/services/backupAutomaticoLocal.js'),
      'utf8'
    );
    assert.match(src, /59 23 \* \* \*/);
    assert.match(src, /America\/Fortaleza/);
    assert.match(src, /primeira_entrada_sistema/);
  });
});
