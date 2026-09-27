/**
 * Garante MBC_SECRET_STORE_KEY no processo local (ERP desktop/dev).
 * Preferência: variável de ambiente já definida.
 * Fallback: arquivo em DB_DIR (fora do repositório), gerado uma vez.
 * Nunca loga o valor da chave.
 * @module motores/bancario/secrets/garantirMbcSecretStoreKey
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NOME_ARQUIVO = 'mbc-secret-store.key';

function diretorioBase(deps = {}) {
  if (deps.dir) return deps.dir;
  if (process.env.DB_DIR && String(process.env.DB_DIR).trim()) {
    return String(process.env.DB_DIR).trim();
  }
  // Mesmo fallback oficial de backend/database.js e electron.js
  return path.join(
    process.env.PROGRAMDATA || 'C:\\ProgramData',
    'MercantilFiscal',
    'dados'
  );
}

/**
 * @returns {{ ok: boolean, origem: 'env'|'arquivo'|'gerado'|null, caminho: string|null }}
 */
function garantirMbcSecretStoreKey(deps = {}) {
  const atual = process.env.MBC_SECRET_STORE_KEY;
  if (atual && String(atual).trim()) {
    return { ok: true, origem: 'env', caminho: null };
  }

  const dir = diretorioBase(deps);
  const arquivo = path.join(dir, NOME_ARQUIVO);

  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (fs.existsSync(arquivo)) {
      const lido = String(fs.readFileSync(arquivo, 'utf8') || '').trim();
      if (lido) {
        process.env.MBC_SECRET_STORE_KEY = lido;
        return { ok: true, origem: 'arquivo', caminho: arquivo };
      }
    }
    const gerada = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(arquivo, gerada, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(arquivo, 0o600);
    } catch (_) { /* Windows pode ignorar mode */ }
    process.env.MBC_SECRET_STORE_KEY = gerada;
    return { ok: true, origem: 'gerado', caminho: arquivo };
  } catch (_) {
    return { ok: false, origem: null, caminho: arquivo };
  }
}

module.exports = { garantirMbcSecretStoreKey, NOME_ARQUIVO };
