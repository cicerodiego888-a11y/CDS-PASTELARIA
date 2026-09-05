/**
 * Contrato do SecretStore do MBC. Sem acesso por rotas.
 * @module motores/bancario/secrets/ISecretStore
 */
'use strict';

class ISecretStore {
  async set() {
    throw new Error('SecretStore.set não implementado');
  }

  async get() {
    throw new Error('SecretStore.get não implementado');
  }

  async delete() {
    throw new Error('SecretStore.delete não implementado');
  }

  async has() {
    throw new Error('SecretStore.has não implementado');
  }

  toJSON() {
    return { tipo: this.constructor.name, valores: '[REDACTED]' };
  }
}

module.exports = { ISecretStore };
