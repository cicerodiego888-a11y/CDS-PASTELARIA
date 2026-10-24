/**
 * P0.5 — Blindagem de inicialização do banco SQLite (testes negativos).
 *
 * Prova bloqueio ANTES de conexão nativa / ensure / migração.
 * Não abre o banco oficial. Usa subprocessos e a API da barreira.
 *
 * node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js tests/database/blindagem-inicializacao-banco-p0-5.test.js
 */
'use strict';

const { isolarBancoTeste, MENSAGEM_RECUSA, CODIGO_BLOQUEIO } = require('../central-entradas/helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-p05-barrier-');

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  caminhoEhOficial,
  caminhoOficialPadrao,
  diretorioOficialPadrao,
  detectarContextoProtegido,
  exigirAberturaDatabaseModule,
  instalarGuardiaoSqlite3,
  recusarOficial
} = require('../../backend/lib/sqliteOfficialGuard');

const RAIZ = path.join(__dirname, '../..');
const OFICIAL = caminhoOficialPadrao();

let passou = 0;
let falhou = 0;

function test(nome, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passou += 1;
      console.log(`  OK  ${nome}`);
    })
    .catch((error) => {
      falhou += 1;
      console.error(`  FALHOU  ${nome}`);
      console.error(`         ${error.message}`);
    });
}

function envFilho(extra = {}) {
  const base = { ...process.env, ...extra };
  // Evita herdar isolamento do pai em cenários que testam ausência de config.
  if (!Object.prototype.hasOwnProperty.call(extra, 'DB_DIR')) {
    delete base.DB_DIR;
  }
  if (!Object.prototype.hasOwnProperty.call(extra, 'CDS_TEST_ISOLATION')) {
    delete base.CDS_TEST_ISOLATION;
  }
  if (!Object.prototype.hasOwnProperty.call(extra, 'CDS_FORCAR_LOCAL')) {
    delete base.CDS_FORCAR_LOCAL;
  }
  if (!Object.prototype.hasOwnProperty.call(extra, 'CDS_BLOQUEAR_BANCO_OFICIAL')) {
    delete base.CDS_BLOQUEAR_BANCO_OFICIAL;
  }
  if (!Object.prototype.hasOwnProperty.call(extra, 'CDS_ALLOW_OFFICIAL_DB')) {
    delete base.CDS_ALLOW_OFFICIAL_DB;
  }
  if (!Object.prototype.hasOwnProperty.call(extra, 'NODE_ENV')) {
    delete base.NODE_ENV;
  }
  if (!Object.prototype.hasOwnProperty.call(extra, 'npm_lifecycle_event')) {
    delete base.npm_lifecycle_event;
  }
  return base;
}

function spawnEval(codigo, envExtra = {}, argsExtra = []) {
  return spawnSync(process.execPath, ['-e', codigo, ...argsExtra], {
    cwd: RAIZ,
    env: envFilho(envExtra),
    encoding: 'utf8',
    timeout: 20000
  });
}

function saida(r) {
  return `${r.stdout || ''}\n${r.stderr || ''}`;
}

function assertBloqueadoSemAbrir(r, contexto) {
  const out = saida(r);
  assert.notStrictEqual(r.status, 0, `${contexto}: deveria falhar\n${out}`);
  assert.ok(
    /CDS_BANCO_OFICIAL_BLOQUEADO|banco oficial bloqueado|DB_DIR ausente/i.test(out),
    `${contexto}: mensagem de bloqueio ausente\n${out}`
  );
  assert.ok(
    !/Conectado ao banco de dados SQLite/i.test(out),
    `${contexto}: conexão nativa ocorreu antes do bloqueio`
  );
  assert.ok(
    !/Banco de dados pronto para uso/i.test(out),
    `${contexto}: ensure/prontidão após bloqueio`
  );
  assert.ok(
    !/Alteração aplicada em |Tabela \w+ criada\/verificada/i.test(out),
    `${contexto}: migração/schema após bloqueio`
  );
}

async function main() {
  console.log('\n=== P0.5 Blindagem inicialização banco SQLite ===\n');
  isolamento.comprobarSeCarregado();
  assert.equal(/ProgramData[\\/]MercantilFiscal[\\/]dados/i.test(isolamento.dbDir), false);

  await test('1. Import database.js em teste sem DB_DIR: bloqueio antes da abertura', () => {
    const r = spawnEval(`require('./backend/database');`, {
      npm_lifecycle_event: 'test:fiscal-certificado-p0-5'
    });
    assertBloqueadoSemAbrir(r, 'caso 1');
  });

  await test('2. Caminho absoluto oficial bloqueado (API + construtor)', () => {
    assert.equal(caminhoEhOficial(OFICIAL), true);
    assert.throws(() => recusarOficial(OFICIAL), (e) => e.code === CODIGO_BLOQUEIO);
    assert.throws(
      () => exigirAberturaDatabaseModule({
        env: {
          DB_DIR: diretorioOficialPadrao(),
          CDS_TEST_ISOLATION: '1'
        },
        forcarProtegido: true
      }),
      (e) => e.code === CODIGO_BLOQUEIO
    );
    instalarGuardiaoSqlite3({ forcarRecusaOficial: true });
    const sqlite3 = require('sqlite3');
    assert.throws(
      () => new sqlite3.Database(OFICIAL),
      (e) => String(e.message).includes('bloqueado') || e.code === CODIGO_BLOQUEIO
    );
  });

  await test('3. Caminho relativo equivalente bloqueado', () => {
    const rel = path.relative(process.cwd(), OFICIAL);
    assert.ok(rel, 'relative vazio inesperado');
    assert.equal(caminhoEhOficial(rel), true);
    assert.throws(() => recusarOficial(rel), (e) => e.code === CODIGO_BLOQUEIO);
  });

  await test('4. Separadores / normalização diferentes bloqueados', () => {
    const mix = OFICIAL.replace(/\\/g, '/');
    const lower = OFICIAL.toLowerCase();
    assert.equal(caminhoEhOficial(mix), true);
    assert.equal(caminhoEhOficial(lower), true);
    assert.throws(
      () => exigirAberturaDatabaseModule({
        env: { DB_DIR: mix.replace(/\/mercadao\.db$/i, ''), CDS_BLOQUEAR_BANCO_OFICIAL: '1' },
        forcarProtegido: true
      }),
      (e) => e.code === CODIGO_BLOQUEIO
    );
  });

  await test('5. Wrapper sqlite3.verbose / cached bloqueia oficial', () => {
    instalarGuardiaoSqlite3({ forcarRecusaOficial: true });
    const verbose = require('sqlite3').verbose();
    assert.throws(
      () => new verbose.Database(OFICIAL),
      (e) => /bloqueado|GUARDIÃO|oficial/i.test(String(e.message))
    );
    const raw = require('sqlite3');
    if (raw.cached && raw.cached.Database) {
      assert.throws(
        () => new raw.cached.Database(OFICIAL),
        (e) => /bloqueado|oficial/i.test(String(e.message))
      );
    }
  });

  await test('6. Ausência de DB_DIR em teste: sem seleção automática do oficial', () => {
    assert.throws(
      () => exigirAberturaDatabaseModule({
        env: { NODE_ENV: 'test' },
        argv: ['node', 'tests/database/x.test.js'],
        forcarProtegido: true
      }),
      (e) => e.code === CODIGO_BLOQUEIO && /DB_DIR ausente/i.test(e.message)
    );
    const r = spawnEval(`require('./backend/database');`, { NODE_ENV: 'test' });
    assertBloqueadoSemAbrir(r, 'caso 6');
  });

  await test('7. DB_DIR temporário: abertura permitida (subprocesso isolado)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-p05-ok-'));
    const codigo = `
      const db = require('./backend/database');
      const t = setTimeout(() => { console.error('TIMEOUT'); process.exit(3); }, 60000);
      db.whenReady((err) => {
        clearTimeout(t);
        console.log('PATH=' + db.dbPath);
        db.close(() => process.exit(err ? 2 : 0));
      });
    `;
    const r = spawnSync(process.execPath, ['-e', codigo], {
      cwd: RAIZ,
      env: envFilho({
        DB_DIR: tmp,
        CDS_TEST_ISOLATION: '1',
        CDS_BLOQUEAR_BANCO_OFICIAL: '1'
      }),
      encoding: 'utf8',
      timeout: 90000
    });
    const out = saida(r);
    assert.strictEqual(r.status, 0, `temp deveria abrir\n${out}`);
    assert.ok(/BANCO DE TESTE EM USO/i.test(out), out);
    assert.ok(out.includes(tmp), out);
    assert.ok(!caminhoEhOficial(path.join(tmp, 'mercadao.db')));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  });

  await test('8. SQLite :memory: permitido no construtor guardado', () => {
    instalarGuardiaoSqlite3({ forcarRecusaOficial: true });
    const sqlite3 = require('sqlite3');
    const mem = new sqlite3.Database(':memory:');
    mem.close();
  });

  await test('9. Módulo puro (sem database) não abre SQLite oficial', () => {
    const r = spawnEval(`
      require('./backend/services/fiscal/certificadoEstados');
      console.log('MODULO_OK');
    `, { NODE_ENV: 'test' });
    const out = saida(r);
    assert.strictEqual(r.status, 0, out);
    assert.ok(out.includes('MODULO_OK'));
    assert.ok(!/Conectado ao banco|BANCO OFICIAL EM USO|BANCO DE TESTE EM USO/i.test(out));
  });

  await test('10-11. Bloqueio síncrono: sem conexão/migração (node -e incidente)', () => {
    const r = spawnEval(`require('./backend/database');`);
    assertBloqueadoSemAbrir(r, 'incidente node -e');
    assert.ok(r.status !== 0);
  });

  await test('12. Contornar preload: .test.js no argv ainda bloqueia sem DB_DIR', () => {
    const r = spawnEval(
      `process.argv.push('tests/fiscal/foo.test.js'); require('./backend/database');`,
      {}
    );
    assertBloqueadoSemAbrir(r, 'caso 12');
  });

  await test('13. Ambiente autorizado (server): resolução oficial sem throw na API', () => {
    const r = exigirAberturaDatabaseModule({
      env: { PROGRAMDATA: process.env.PROGRAMDATA || 'C:\\ProgramData' },
      argv: ['node', 'backend/server.js'],
      execArgv: [],
      forcarProtegido: false
    });
    // Sem forcar e sem marcadores de teste — permitir resolução (não abrir).
    assert.equal(r.contextoProtegido, false);
    assert.equal(caminhoEhOficial(r.dbPath), true);
  });

  await test('14. Falha de isolamento: erro explícito sem fallback', () => {
    let codigo = null;
    try {
      exigirAberturaDatabaseModule({
        env: { CDS_TEST_ISOLATION: '1' },
        forcarProtegido: true
      });
      codigo = 'ABRIU';
    } catch (e) {
      codigo = e.code;
      assert.ok(/DB_DIR ausente|bloqueado/i.test(e.message));
    }
    assert.strictEqual(codigo, CODIGO_BLOQUEIO);
  });

  await test('15. Scripts auditados usam preload (fonte package.json)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));
    const obrigados = [
      'test:fiscal-certificado-p0-1',
      'test:fiscal-certificado-p0-2',
      'test:fiscal-certificado-p0-3',
      'test:fiscal-certificado-p0-4',
      'test:fiscal-certificado-empresa',
      'test:central-entradas-rc2',
      'test:blindagem-banco-p0-5',
      'test:gestao-fiscal-visual-05-15',
      'test:isolamento-nfce-empresa-05-46'
    ];
    for (const nome of obrigados) {
      const cmd = pkg.scripts[nome];
      assert.ok(cmd, `script ausente: ${nome}`);
      assert.ok(
        String(cmd).includes('preloadIsolamentoBanco.js'),
        `${nome} sem preload`
      );
    }
    assert.ok(detectarContextoProtegido(
      { npm_lifecycle_event: 'test:blindagem-banco-p0-5' },
      ['node', 'x'],
      []
    ));
    assert.ok(String(MENSAGEM_RECUSA).length > 20);
  });

  console.log(`\nBANCO DE TESTE COMPROVADO (pai): ${isolamento.dbDir}`);
  console.log(`Resultado: ${passou} ok, ${falhou} falha(s)\n`);
  if (falhou > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
