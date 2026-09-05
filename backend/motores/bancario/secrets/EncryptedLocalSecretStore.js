/**
 * SecretStore local com AES-256-GCM.
 * Chave: process.env.MBC_SECRET_STORE_KEY (não reutiliza TEF/PIX/LICENSE).
 * Sem chave: recusa persistir. Não é Vault/HSM.
 * @module motores/bancario/secrets/EncryptedLocalSecretStore
 */
'use strict';

const crypto = require('crypto');
const { ISecretStore } = require('./ISecretStore');
const { ERROS, erroMbc } = require('../contracts/constantes');
const { dbRun, dbGet } = require('../services/dbPromessas');

function derivarChave() {
  const raw = process.env.MBC_SECRET_STORE_KEY;
  if (!raw || !String(raw).trim()) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return crypto.createHash('sha256').update(String(raw), 'utf8').digest();
}

class EncryptedLocalSecretStore extends ISecretStore {
  constructor(deps = {}) {
    super();
    this.db = deps.db || null;
    this.modo = 'local-cifrado-transicao';
  }

  _exigirChave() {
    const key = derivarChave();
    if (!key) {
      throw erroMbc(
        ERROS.SECRET_KEY_AUSENTE,
        'MBC_SECRET_STORE_KEY não definida. SecretStore local recusa gravar sem chave de ambiente.',
        503
      );
    }
    return key;
  }

  _cifrar(valor) {
    const key = this._exigirChave();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(String(valor), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return iv.toString('hex') + ':' + tag.toString('hex') + ':' + enc.toString('hex');
  }

  _decifrar(blob) {
    const key = this._exigirChave();
    const [ivH, tagH, dataH] = String(blob).split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivH, 'hex'));
    decipher.setAuthTag(Buffer.from(tagH, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataH, 'hex')), decipher.final()]).toString('utf8');
  }

  async set(key, value) {
    const ciphertext = this._cifrar(value);
    await dbRun(
      this.db,
      `INSERT INTO mbc_secret_store (chave, ciphertext, created_at, updated_at)
       VALUES (?, ?, datetime('now','localtime'), datetime('now','localtime'))
       ON CONFLICT(chave) DO UPDATE SET ciphertext = excluded.ciphertext,
         updated_at = datetime('now','localtime')`,
      [String(key), ciphertext]
    );
    return true;
  }

  async get(key) {
    const row = await dbGet(this.db, `SELECT ciphertext FROM mbc_secret_store WHERE chave = ?`, [String(key)]);
    if (!row) return null;
    return this._decifrar(row.ciphertext);
  }

  async delete(key) {
    const r = await dbRun(this.db, `DELETE FROM mbc_secret_store WHERE chave = ?`, [String(key)]);
    return r.changes > 0;
  }

  async has(key) {
    const row = await dbGet(this.db, `SELECT chave FROM mbc_secret_store WHERE chave = ?`, [String(key)]);
    return !!row;
  }

  toJSON() {
    return { tipo: 'EncryptedLocalSecretStore', modo: this.modo, valores: '[REDACTED]' };
  }
}

function obterSecretStore(deps = {}) {
  if (deps.secretStore) return deps.secretStore;
  if (derivarChave() && deps.db) return new EncryptedLocalSecretStore({ db: deps.db });
  return new (require('./MemorySecretStore').MemorySecretStore)();
}

module.exports = { EncryptedLocalSecretStore, obterSecretStore, derivarChave };
