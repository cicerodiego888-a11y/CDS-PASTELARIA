/**
 * Bootstrap operacional MBC compartilhado (ERP + Gateway OAuth 3010).
 * Alinha DB_DIR, mercadao.db, MBC_SECRET_STORE_KEY e Redirect URI. Sem logar segredos.
 * @module motores/bancario/secrets/bootstrapAmbienteOperacionalMbc
 */
'use strict';

const path = require('path');
const { garantirMbcSecretStoreKey } = require('./garantirMbcSecretStoreKey');
const { garantirRedirectUriOperacional } = require('../../../mercado-pago/redirectUri');

/** Mesmo fallback oficial de backend/database.js e electron.js. */
function resolverDbDirOficial(env = process.env) {
  if (env.DB_DIR && String(env.DB_DIR).trim()) {
    return String(env.DB_DIR).trim();
  }
  return path.join(
    env.PROGRAMDATA || process.env.PROGRAMDATA || 'C:\\ProgramData',
    'MercantilFiscal',
    'dados'
  );
}

/**
 * @param {object} [deps]
 * @param {NodeJS.ProcessEnv} [deps.env]
 * @param {string} [deps.dbDir]
 * @param {boolean} [deps.exigirRedirectUri]
 */
function bootstrapAmbienteOperacionalMbc(deps = {}) {
  const env = deps.env || process.env;
  const dbDir = deps.dbDir || resolverDbDirOficial(env);
  env.DB_DIR = dbDir;
  process.env.DB_DIR = dbDir;

  const key = garantirMbcSecretStoreKey({ dir: dbDir });
  const redirect = garantirRedirectUriOperacional({ env, dbDir });
  const erros = [];
  if (!key.ok) {
    erros.push('MBC_SECRET_STORE_KEY indisponível');
  }
  if (deps.exigirRedirectUri !== false && redirect.status !== 'CONFIGURADO') {
    erros.push('MERCADO_PAGO_OAUTH_REDIRECT_URI não configurado');
  }

  const ok = key.ok && (deps.exigirRedirectUri === false || redirect.status === 'CONFIGURADO');

  return {
    ok,
    db_dir: dbDir,
    db_path: path.join(dbDir, 'mercadao.db'),
    db_configurado: !!(dbDir && String(dbDir).trim()),
    secret_store_disponivel: !!key.ok,
    secret_store_origem: key.origem || null,
    redirect_uri_configurado: redirect.status === 'CONFIGURADO',
    redirect_uri_status: redirect.status,
    erros
  };
}

module.exports = {
  bootstrapAmbienteOperacionalMbc,
  resolverDbDirOficial
};
