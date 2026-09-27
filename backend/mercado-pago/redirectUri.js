/**
 * Redirect URI oficial do Mercado Pago. Sem valor padrão inventado.
 * Fonte: MERCADO_PAGO_OAUTH_REDIRECT_URI ou arquivo em DB_DIR (ops local).
 * @module mercado-pago/redirectUri
 */
'use strict';

const fs = require('fs');
const path = require('path');

const NOME_ARQUIVO = 'mbc-oauth-redirect.uri';

function validarUri(raw) {
  if (raw == null || !String(raw).trim()) {
    return { status: 'NAO_CONFIGURADO', uri: null };
  }
  const uri = String(raw).trim();
  if (/^http:\/\//i.test(uri) || /localhost/i.test(uri)) {
    return { status: 'NAO_CONFIGURADO', uri: null };
  }
  if (!/^https:\/\//i.test(uri)) {
    return { status: 'NAO_CONFIGURADO', uri: null };
  }
  return { status: 'CONFIGURADO', uri };
}

function caminhoArquivoRedirect(dbDir) {
  if (!dbDir || !String(dbDir).trim()) return null;
  return path.join(String(dbDir).trim(), NOME_ARQUIVO);
}

function lerRedirectDoArquivo(dbDir) {
  const arquivo = caminhoArquivoRedirect(dbDir);
  if (!arquivo || !fs.existsSync(arquivo)) return null;
  try {
    return String(fs.readFileSync(arquivo, 'utf8') || '').trim() || null;
  } catch (_) {
    return null;
  }
}

function gravarRedirectNoArquivo(dbDir, uri) {
  const arquivo = caminhoArquivoRedirect(dbDir);
  if (!arquivo || !uri) return false;
  try {
    const dir = path.dirname(arquivo);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(arquivo, String(uri).trim() + '\n', { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Sincroniza env ↔ arquivo em DB_DIR (ERP e Gateway no mesmo diretório).
 * Nunca inventa URL. Não loga o valor.
 */
function garantirRedirectUriOperacional(deps = {}) {
  const env = deps.env || process.env;
  const dbDir = deps.dbDir
    || (env.DB_DIR && String(env.DB_DIR).trim())
    || (process.env.DB_DIR && String(process.env.DB_DIR).trim())
    || null;

  const doEnv = validarUri(env.MERCADO_PAGO_OAUTH_REDIRECT_URI);
  if (doEnv.status === 'CONFIGURADO') {
    if (dbDir) gravarRedirectNoArquivo(dbDir, doEnv.uri);
    if (!process.env.MERCADO_PAGO_OAUTH_REDIRECT_URI) {
      process.env.MERCADO_PAGO_OAUTH_REDIRECT_URI = doEnv.uri;
    }
    return doEnv;
  }

  const doArquivo = validarUri(lerRedirectDoArquivo(dbDir));
  if (doArquivo.status === 'CONFIGURADO') {
    process.env.MERCADO_PAGO_OAUTH_REDIRECT_URI = doArquivo.uri;
    if (env !== process.env) env.MERCADO_PAGO_OAUTH_REDIRECT_URI = doArquivo.uri;
    return doArquivo;
  }

  return { status: 'NAO_CONFIGURADO', uri: null };
}

function statusRedirectUriOficial(env) {
  const usarProcesso = (env == null);
  const e = usarProcesso ? process.env : env;
  const raw = e && e.MERCADO_PAGO_OAUTH_REDIRECT_URI;
  // Valor explícito (mesmo inválido) tem prioridade — não cair no arquivo.
  if (raw != null && String(raw).trim()) {
    return validarUri(raw);
  }
  // Env isolado sem DB_DIR: não ler arquivo do processo (testes).
  if (!usarProcesso && !(e && e.DB_DIR)) {
    return { status: 'NAO_CONFIGURADO', uri: null };
  }
  const dbDir = (e && e.DB_DIR) || (usarProcesso ? process.env.DB_DIR : null);
  return validarUri(lerRedirectDoArquivo(dbDir));
}

module.exports = {
  statusRedirectUriOficial,
  garantirRedirectUriOperacional,
  NOME_ARQUIVO_REDIRECT: NOME_ARQUIVO
};
