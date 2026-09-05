/**
 * SecretStore em memória — testes e transição local sem chave mestre.
 * Não é cofre externo. Valores nunca entram em toJSON.
 * @module motores/bancario/secrets/MemorySecretStore
 */
'use strict';

const { ISecretStore } = require('./ISecretStore');

class MemorySecretStore extends ISecretStore {
  constructor() {
    super();
    this._map = new Map();
    this.modo = 'memoria-transicao';
  }

  async set(key, value) {
    this._map.set(String(key), String(value));
    return true;
  }

  async get(key) {
    const k = String(key);
    return this._map.has(k) ? this._map.get(k) : null;
  }

  async delete(key) {
    return this._map.delete(String(key));
  }

  async has(key) {
    return this._map.has(String(key));
  }

  toJSON() {
    return { tipo: 'MemorySecretStore', modo: this.modo, chaves: this._map.size, valores: '[REDACTED]' };
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return this.toJSON();
  }
}

module.exports = { MemorySecretStore };
