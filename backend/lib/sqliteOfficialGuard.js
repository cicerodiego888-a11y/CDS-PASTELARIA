/**
 * Barreira central contra abertura acidental do banco oficial SQLite.
 *
 * Usada por backend/database.js (antes de mkdir/conexão/ensure) e pelos
 * helpers de isolamento de teste. Não abre o banco.
 *
 * Produção autorizada: comportamento padrão (DB_DIR ou ProgramData).
 * Teste/verificação: exige DB_DIR temporário inequívoco; recusa o oficial.
 *
 * Override explícito (manutenção autorizada): CDS_ALLOW_OFFICIAL_DB=1
 */
'use strict';

const path = require('path');

const CODIGO_BLOQUEIO = 'CDS_BANCO_OFICIAL_BLOQUEADO';
const MENSAGEM_RECUSA =
  'Acesso ao banco oficial bloqueado em contexto de teste/verificação. '
  + 'Configure DB_DIR para um diretório temporário (ou use o preload de isolamento) '
  + 'antes de carregar backend/database.js. '
  + 'Para execução autorizada no banco oficial, defina CDS_ALLOW_OFFICIAL_DB=1.';

const OFICIAL_DIR_RE = /[\\/]ProgramData[\\/]MercantilFiscal[\\/]dados(?:[\\/]|$)/i;
const OFICIAL_DB_RE = /mercantilfiscal[\\/]dados[\\/]mercadao\.db$/i;
/** Legado usado em rotas/scripts (C:\projetos\MercantilFiscal\dados) — também bloqueado em teste. */
const LEGADO_MF_DIR_RE = /[\\/]projetos[\\/]MercantilFiscal[\\/]dados(?:[\\/]|$)/i;

function caminhoOficialPadrao(env = process.env) {
  return path.join(
    env.PROGRAMDATA || 'C:\\ProgramData',
    'MercantilFiscal',
    'dados',
    'mercadao.db'
  );
}

function diretorioOficialPadrao(env = process.env) {
  return path.join(
    env.PROGRAMDATA || 'C:\\ProgramData',
    'MercantilFiscal',
    'dados'
  );
}

function normalizarParaComparacao(alvo) {
  const texto = String(alvo || '').trim();
  if (!texto) return '';
  if (texto === ':memory:') return ':memory:';
  try {
    return path.resolve(texto).replace(/\//g, path.sep).toLowerCase();
  } catch {
    return texto.replace(/\//g, path.sep).toLowerCase();
  }
}

function caminhoEhOficial(alvo, env = process.env) {
  const texto = String(alvo || '').trim();
  if (!texto || texto === ':memory:') return false;
  if (OFICIAL_DIR_RE.test(texto) || OFICIAL_DB_RE.test(texto)) return true;
  const norm = normalizarParaComparacao(texto);
  const oficialDb = normalizarParaComparacao(caminhoOficialPadrao(env));
  const oficialDir = normalizarParaComparacao(diretorioOficialPadrao(env));
  if (norm === oficialDb || norm === oficialDir) return true;
  if (norm.startsWith(oficialDir + path.sep.toLowerCase())) return true;
  // Relativos que resolvem para o oficial
  try {
    if (path.resolve(texto) === path.resolve(caminhoOficialPadrao(env))) return true;
    if (path.resolve(texto) === path.resolve(diretorioOficialPadrao(env))) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/** Oficial ProgramData + legado MercantilFiscal em projetos/ — caminhos sensíveis em teste. */
function caminhoEhProducaoSensivel(alvo, env = process.env) {
  const texto = String(alvo || '').trim();
  if (!texto || texto === ':memory:') return false;
  if (caminhoEhOficial(texto, env)) return true;
  if (LEGADO_MF_DIR_RE.test(texto)) return true;
  try {
    const norm = normalizarParaComparacao(texto);
    if (/[\\/]projetos[\\/]mercantilfiscal[\\/]dados(?:[\\/]|$)/i.test(norm)) return true;
  } catch {
    /* ignore */
  }
  return false;
}

function recusarProducaoSensivel(filename, env = process.env) {
  const alvo = String(filename || '');
  if (!alvo || alvo === ':memory:') return;
  if (caminhoEhProducaoSensivel(alvo, env)) {
    throw erroBloqueio(alvo);
  }
}

/**
 * Contextos em que o fallback silencioso para ProgramData é proibido.
 * CDS_ALLOW_OFFICIAL_DB=1 desliga a proteção (uso autorizado explícito).
 */
function detectarContextoProtegido(env = process.env, argv = process.argv, execArgv = process.execArgv) {
  if (String(env.CDS_ALLOW_OFFICIAL_DB || '') === '1') return false;
  if (String(env.CDS_BLOQUEAR_BANCO_OFICIAL || '') === '1') return true;
  if (String(env.CDS_TEST_ISOLATION || '') === '1') return true;
  if (String(env.CDS_FORCAR_LOCAL || '') === '1') return true;
  if (String(env.NODE_ENV || '').toLowerCase() === 'test') return true;

  const life = String(env.npm_lifecycle_event || '');
  if (life === 'test' || life.startsWith('test:')) return true;

  const args = Array.isArray(argv) ? argv : [];
  const exec = Array.isArray(execArgv) ? execArgv : [];

  // node -e / --eval / -p — no Windows/Node atual ficam em execArgv (não em argv).
  // Padrão do incidente P0.4 (verificação ad-hoc / agente).
  const flagsEval = new Set(['-e', '--eval', '-p', '--print', '--check', '-c']);
  if (exec.some((a) => flagsEval.has(String(a))) || args.some((a) => flagsEval.has(String(a)))) {
    return true;
  }
  if (args.some((a) => /\.test\.m?js$/i.test(String(a)) || /[\\/]tests[\\/]/i.test(String(a)))) {
    return true;
  }
  if (exec.some((a) => /preloadIsolamentoBanco|isolarBancoTeste/i.test(String(a)))) {
    return true;
  }
  // node -e frequentemente deixa require.main === undefined/false e argv só com o binário
  if (!require.main && args.length <= 1 && exec.length > 0) {
    return true;
  }
  return false;
}

function erroBloqueio(detalhe) {
  const err = new Error(detalhe ? `${MENSAGEM_RECUSA} (${detalhe})` : MENSAGEM_RECUSA);
  err.code = CODIGO_BLOQUEIO;
  err.bloqueioBancoOficial = true;
  return err;
}

function recusarOficial(filename, env = process.env) {
  const alvo = String(filename || '');
  if (!alvo || alvo === ':memory:') return;
  if (caminhoEhOficial(alvo, env)) {
    throw erroBloqueio(alvo);
  }
}

/**
 * Resolve e valida o caminho ANTES de mkdir / new Database / ensure.
 * Em contexto protegido: DB_DIR obrigatório e não oficial.
 */
function exigirAberturaDatabaseModule(opts = {}) {
  const env = opts.env || process.env;
  const argv = opts.argv || process.argv;
  const execArgv = opts.execArgv || process.execArgv;
  const protegido = opts.forcarProtegido === true
    || detectarContextoProtegido(env, argv, execArgv);

  const dbDirEnv = env.DB_DIR != null ? String(env.DB_DIR).trim() : '';

  if (!protegido) {
    const dbDir = dbDirEnv || diretorioOficialPadrao(env);
    const dbPath = path.join(dbDir, 'mercadao.db');
    return {
      permitido: true,
      contextoProtegido: false,
      dbDir,
      dbPath,
      rotuloLog: caminhoEhOficial(dbPath, env) ? 'BANCO OFICIAL EM USO' : 'BANCO EM USO'
    };
  }

  if (!dbDirEnv) {
    throw erroBloqueio('DB_DIR ausente — fallback para ProgramData recusado');
  }
  if (caminhoEhOficial(dbDirEnv, env)) {
    throw erroBloqueio('DB_DIR aponta para o diretório oficial');
  }

  const dbPath = path.join(dbDirEnv, 'mercadao.db');
  if (caminhoEhOficial(dbPath, env)) {
    throw erroBloqueio('caminho do arquivo resolve para o banco oficial');
  }

  return {
    permitido: true,
    contextoProtegido: true,
    dbDir: dbDirEnv,
    dbPath,
    rotuloLog: 'BANCO DE TESTE EM USO'
  };
}

/**
 * Valida origem/destino de backup ou restauração de arquivo .db ANTES de I/O.
 * Em contexto protegido, recusa qualquer ponta em caminho de produção sensível.
 */
function exigirCaminhosBackup(opts = {}) {
  const env = opts.env || process.env;
  const protegido = opts.forcarProtegido === true
    || detectarContextoProtegido(env, opts.argv || process.argv, opts.execArgv || process.execArgv);
  const origem = opts.origem != null ? String(opts.origem).trim() : '';
  const destino = opts.destino != null ? String(opts.destino).trim() : '';

  if (!protegido) {
    return { permitido: true, contextoProtegido: false, origem, destino };
  }

  if (origem) recusarProducaoSensivel(origem, env);
  if (destino) recusarProducaoSensivel(destino, env);
  return { permitido: true, contextoProtegido: true, origem, destino };
}

function exigirRestauracaoBanco(opts = {}) {
  const env = opts.env || process.env;
  const protegido = opts.forcarProtegido === true
    || detectarContextoProtegido(env, opts.argv || process.argv, opts.execArgv || process.execArgv);
  const origem = opts.origem != null ? String(opts.origem).trim() : '';
  const destino = opts.destino != null ? String(opts.destino).trim() : '';

  if (!destino) {
    throw erroBloqueio('destino de restauração ausente');
  }
  if (!protegido) {
    return { permitido: true, contextoProtegido: false, origem, destino };
  }
  // Em teste: nunca restaurar para produção sensível (oficial ou legado).
  recusarProducaoSensivel(destino, env);
  if (origem) recusarProducaoSensivel(origem, env);
  return { permitido: true, contextoProtegido: true, origem, destino };
}

/**
 * Scripts destrutivos (ex.: reset-users) — bloqueados em contexto de teste
 * salvo autorização explícita de manutenção de teste + DB_DIR temporário.
 * Não usa CDS_ALLOW_OFFICIAL_DB como único mecanismo.
 */
function exigirScriptManutencaoDestrutiva(nomeScript, opts = {}) {
  const env = opts.env || process.env;
  const protegido = opts.forcarProtegido === true
    || detectarContextoProtegido(env, opts.argv || process.argv, opts.execArgv || process.execArgv);
  if (!protegido) {
    return exigirAberturaDatabaseModule({ env, argv: opts.argv, execArgv: opts.execArgv });
  }
  if (String(env.CDS_ALLOW_DESTRUCTIVE_DB_SCRIPT || '') !== '1') {
    throw erroBloqueio(
      `script destrutivo "${nomeScript || 'manutencao'}" bloqueado em contexto de teste `
      + '(defina CDS_ALLOW_DESTRUCTIVE_DB_SCRIPT=1 e DB_DIR temporário só para teste isolado)'
    );
  }
  return exigirAberturaDatabaseModule({
    env,
    argv: opts.argv,
    execArgv: opts.execArgv,
    forcarProtegido: true
  });
}

/** Resolve caminho do banco operacional sem hardcode legado; valida em teste. */
function resolverCaminhoBancoOperacional(opts = {}) {
  const env = opts.env || process.env;
  if (opts.dbPathPreferido && String(opts.dbPathPreferido).trim()) {
    const preferido = path.resolve(String(opts.dbPathPreferido).trim());
    if (detectarContextoProtegido(env) || opts.forcarProtegido) {
      recusarProducaoSensivel(preferido, env);
    }
    return preferido;
  }
  if (env.DB_PATH && String(env.DB_PATH).trim()) {
    const p = path.resolve(String(env.DB_PATH).trim());
    if (detectarContextoProtegido(env) || opts.forcarProtegido) {
      recusarProducaoSensivel(p, env);
    }
    return p;
  }
  const resolvido = exigirAberturaDatabaseModule({
    env,
    forcarProtegido: opts.forcarProtegido,
    argv: opts.argv,
    execArgv: opts.execArgv
  });
  return resolvido.dbPath;
}

function rejeitarCaminhoClienteBanco(body) {
  if (!body || typeof body !== 'object') return;
  const candidatos = [
    body.dbPath, body.db_path, body.caminhoBanco, body.caminho_banco,
    body.databasePath, body.sqlitePath, body.path, body.origem, body.destino
  ];
  for (const c of candidatos) {
    if (c != null && String(c).trim() !== '') {
      const err = erroBloqueio('caminho de banco fornecido pelo cliente rejeitado');
      err.statusCode = 400;
      throw err;
    }
  }
}

function wrapCtor(DatabaseOrig, { forcarRecusaOficial = false } = {}) {
  if (DatabaseOrig && DatabaseOrig.__cdsIsolamentoCtor) return DatabaseOrig;
  function DatabaseGuardado(filename, mode, callback) {
    const alvo = String(filename || '');
    if (alvo && alvo !== ':memory:' && caminhoEhProducaoSensivel(alvo)) {
      if (forcarRecusaOficial || detectarContextoProtegido()) {
        throw erroBloqueio(alvo);
      }
    }
    if (typeof mode === 'function') {
      return new DatabaseOrig(filename, mode);
    }
    return new DatabaseOrig(filename, mode, callback);
  }
  DatabaseGuardado.__cdsIsolamentoCtor = true;
  DatabaseGuardado.prototype = DatabaseOrig.prototype;
  Object.setPrototypeOf(DatabaseGuardado, DatabaseOrig);
  return DatabaseGuardado;
}

function wrapApiSqlite(api, opts = {}) {
  if (!api) return api;
  // Reaplica wrap se o modo forçar recusa absoluta (testes).
  if (api.__cdsIsolamentoOficial && !opts.forcarRecusaOficial) return api;
  api.Database = wrapCtor(api.Database, opts);
  if (api.cached && api.cached.Database) {
    api.cached.Database = wrapCtor(api.cached.Database, opts);
  }
  api.__cdsIsolamentoOficial = true;
  return api;
}

/**
 * Envolve sqlite3.Database / verbose / cached.
 * forcarRecusaOficial=true: sempre bloqueia oficial (helpers de teste).
 * Caso contrário: só bloqueia em contexto protegido.
 */
function instalarGuardiaoSqlite3(opts = {}) {
  const sqlite3 = require('sqlite3');
  const forcar = opts.forcarRecusaOficial === true
    || String(process.env.CDS_TEST_ISOLATION || '') === '1';
  wrapApiSqlite(sqlite3, { forcarRecusaOficial: forcar });
  const origVerbose = sqlite3.verbose.bind(sqlite3);
  if (!sqlite3.__cdsVerboseGuardado) {
    sqlite3.verbose = function verboseGuardado() {
      return wrapApiSqlite(origVerbose(), {
        forcarRecusaOficial: forcar || String(process.env.CDS_TEST_ISOLATION || '') === '1'
      });
    };
    sqlite3.__cdsVerboseGuardado = true;
  } else if (forcar) {
    // Garante rewrap do verbose atual
    wrapApiSqlite(sqlite3.verbose(), { forcarRecusaOficial: true });
  }
  return sqlite3;
}

module.exports = {
  CODIGO_BLOQUEIO,
  MENSAGEM_RECUSA,
  OFICIAL_DIR_RE,
  LEGADO_MF_DIR_RE,
  caminhoOficialPadrao,
  diretorioOficialPadrao,
  normalizarParaComparacao,
  caminhoEhOficial,
  caminhoEhProducaoSensivel,
  detectarContextoProtegido,
  recusarOficial,
  recusarProducaoSensivel,
  exigirAberturaDatabaseModule,
  exigirCaminhosBackup,
  exigirRestauracaoBanco,
  exigirScriptManutencaoDestrutiva,
  resolverCaminhoBancoOperacional,
  rejeitarCaminhoClienteBanco,
  instalarGuardiaoSqlite3,
  wrapApiSqlite,
  erroBloqueio
};
