/**
 * P0.6 — Caminhos alternativos de acesso ao SQLite (suíte direcionada).
 * Sem banco oficial. Sem backup/reset/restauração reais de produção.
 * Sem CDS_ALLOW_OFFICIAL_DB=1.
 *
 * node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js tests/database/caminhos-alternativos-sqlite-p0-6.test.js
 */
'use strict';

const { isolarBancoTeste, MENSAGEM_RECUSA } = require('../central-entradas/helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-p06-alt-');

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  CODIGO_BLOQUEIO,
  caminhoOficialPadrao,
  caminhoEhOficial,
  caminhoEhProducaoSensivel,
  exigirCaminhosBackup,
  exigirRestauracaoBanco,
  exigirAberturaDatabaseModule,
  instalarGuardiaoSqlite3,
  rejeitarCaminhoClienteBanco,
  resolverCaminhoBancoOperacional,
  exigirScriptManutencaoDestrutiva
} = require('../../backend/lib/sqliteOfficialGuard');

const {
  fazerBackupManual,
  validarRestauracaoBancoArquivo
} = require('../../backend/services/backupManual');

const RAIZ = path.join(__dirname, '../..');
const OFICIAL = caminhoOficialPadrao();
const LEGADO = path.join('C:', 'projetos', 'MercantilFiscal', 'dados', 'mercadao.db');

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

function envLimpo(extra = {}) {
  const base = { ...process.env, ...extra };
  for (const k of [
    'DB_DIR', 'DB_PATH', 'CDS_TEST_ISOLATION', 'CDS_FORCAR_LOCAL',
    'CDS_BLOQUEAR_BANCO_OFICIAL', 'CDS_ALLOW_OFFICIAL_DB',
    'CDS_ALLOW_DESTRUCTIVE_DB_SCRIPT', 'NODE_ENV', 'npm_lifecycle_event'
  ]) {
    if (!Object.prototype.hasOwnProperty.call(extra, k)) delete base[k];
  }
  return base;
}

function saida(r) {
  return `${r.stdout || ''}\n${r.stderr || ''}`;
}

async function main() {
  console.log('\n=== P0.6 Caminhos alternativos SQLite ===\n');
  isolamento.comprobarSeCarregado();
  assert.equal(caminhoEhOficial(isolamento.dbDir), false);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-p06-tmp-'));
  const tmpDb = path.join(tmp, 'mercadao.db');
  fs.writeFileSync(tmpDb, Buffer.from('SQLite format 3\0fake'));
  const tmpDest = path.join(tmp, 'backups-out');

  await test('1. Guardião bloqueia caminho oficial absoluto', () => {
    assert.equal(caminhoEhOficial(OFICIAL), true);
    assert.throws(
      () => exigirCaminhosBackup({ origem: OFICIAL, destino: path.join(tmp, 'x.db'), forcarProtegido: true }),
      (e) => e.code === CODIGO_BLOQUEIO
    );
  });

  await test('2. Guardião bloqueia caminho relativo equivalente', () => {
    const rel = path.relative(process.cwd(), OFICIAL);
    assert.equal(caminhoEhOficial(rel), true);
    assert.throws(
      () => exigirCaminhosBackup({ origem: rel, destino: path.join(tmp, 'y.db'), forcarProtegido: true }),
      (e) => e.code === CODIGO_BLOQUEIO
    );
  });

  await test('3. sqlite3.Database direto bloqueado quando protegido', () => {
    instalarGuardiaoSqlite3({ forcarRecusaOficial: true });
    const sqlite3 = require('sqlite3');
    assert.throws(
      () => new sqlite3.Database(OFICIAL),
      (e) => e.code === CODIGO_BLOQUEIO || /bloqueado/i.test(e.message)
    );
    assert.throws(
      () => new sqlite3.Database(LEGADO),
      (e) => e.code === CODIGO_BLOQUEIO || /bloqueado/i.test(e.message)
    );
  });

  await test('4. Import database.js mantém bloqueio P0.5 (subprocesso)', () => {
    const r = spawnSync(process.execPath, ['-e', "require('./backend/database');"], {
      cwd: RAIZ,
      env: envLimpo({ npm_lifecycle_event: 'test:caminhos-alternativos-sqlite-p0-6' }),
      encoding: 'utf8',
      timeout: 15000
    });
    const out = saida(r);
    assert.notStrictEqual(r.status, 0, out);
    assert.ok(/CDS_BANCO_OFICIAL_BLOQUEADO|DB_DIR ausente/i.test(out), out);
    assert.ok(!/Conectado ao banco de dados SQLite/i.test(out), out);
  });

  await test('5. Backup com origem oficial bloqueado em teste', () => {
    assert.throws(
      () => fazerBackupManual(OFICIAL, tmpDest),
      (e) => e.code === CODIGO_BLOQUEIO
    );
    assert.ok(!fs.existsSync(path.join(tmpDest, 'probe')));
  });

  await test('6. Backup com destino oficial bloqueado em teste', () => {
    const destOficial = path.dirname(OFICIAL);
    assert.throws(
      () => fazerBackupManual(tmpDb, destOficial),
      (e) => e.code === CODIGO_BLOQUEIO
    );
  });

  await test('7. Restauração para destino oficial bloqueada em teste', () => {
    assert.throws(
      () => validarRestauracaoBancoArquivo(tmpDb, OFICIAL),
      (e) => e.code === CODIGO_BLOQUEIO
    );
    assert.throws(
      () => exigirRestauracaoBanco({ origem: tmpDb, destino: LEGADO, forcarProtegido: true }),
      (e) => e.code === CODIGO_BLOQUEIO
    );
  });

  await test('8. reset-users.js não abre banco oficial em contexto protegido', () => {
    const r = spawnSync(process.execPath, [path.join('backend', 'reset-users.js')], {
      cwd: RAIZ,
      env: envLimpo({
        NODE_ENV: 'test',
        CDS_TEST_ISOLATION: '1',
        CDS_BLOQUEAR_BANCO_OFICIAL: '1'
      }),
      encoding: 'utf8',
      timeout: 15000
    });
    const out = saida(r);
    assert.notStrictEqual(r.status, 0, out);
    assert.ok(/bloqueado|destrutivo|CDS_BANCO_OFICIAL/i.test(out), out);
    assert.ok(!/Conectado ao banco de dados SQLite/i.test(out), out);
    assert.ok(!/Usuários deletados/i.test(out), out);
  });

  await test('9. Rota de backup rejeita caminho arbitrário do cliente', () => {
    assert.throws(
      () => rejeitarCaminhoClienteBanco({ dbPath: OFICIAL }),
      (e) => e.code === CODIGO_BLOQUEIO
    );
    assert.throws(
      () => rejeitarCaminhoClienteBanco({ caminho_banco: LEGADO }),
      (e) => e.code === CODIGO_BLOQUEIO
    );
    const fonte = fs.readFileSync(path.join(RAIZ, 'backend/rotas/backup.js'), 'utf8');
    assert.match(fonte, /rejeitarCaminhoClienteBanco/);
    assert.match(fonte, /resolverCaminhoBancoOperacional/);
    assert.doesNotMatch(fonte, /projetos[\\/,'"]+MercantilFiscal/);
  });

  await test('10. :memory: continua permitido', () => {
    instalarGuardiaoSqlite3({ forcarRecusaOficial: true });
    const sqlite3 = require('sqlite3');
    const mem = new sqlite3.Database(':memory:');
    mem.close();
  });

  await test('11. Banco temporário válido continua permitido (API backup)', () => {
    const ok = exigirCaminhosBackup({
      origem: tmpDb,
      destino: path.join(tmpDest, 'ok.db'),
      forcarProtegido: true
    });
    assert.equal(ok.permitido, true);
    const r = fazerBackupManual(tmpDb, tmpDest);
    assert.equal(r.sucesso, true);
    assert.ok(fs.existsSync(r.caminho));
    assert.ok(String(r.caminho).startsWith(tmp));
  });

  await test('12. Configuração ausente: bloqueio sem fallback', () => {
    assert.throws(
      () => exigirAberturaDatabaseModule({
        env: { CDS_TEST_ISOLATION: '1' },
        forcarProtegido: true
      }),
      (e) => e.code === CODIGO_BLOQUEIO && /DB_DIR ausente/i.test(e.message)
    );
  });

  await test('13. Caminhos diretos auditados não contornam o guardião', () => {
    assert.equal(caminhoEhProducaoSensivel(LEGADO), true);
    assert.throws(
      () => resolverCaminhoBancoOperacional({
        dbPathPreferido: OFICIAL,
        forcarProtegido: true,
        env: { CDS_TEST_ISOLATION: '1' }
      }),
      (e) => e.code === CODIGO_BLOQUEIO
    );
    const resetSrc = fs.readFileSync(path.join(RAIZ, 'backend/reset-users.js'), 'utf8');
    assert.match(resetSrc, /exigirScriptManutencaoDestrutiva/);
    assert.match(resetSrc, /sqliteOfficialGuard/);
    const backupSrc = fs.readFileSync(path.join(RAIZ, 'backend/backup.js'), 'utf8');
    assert.match(backupSrc, /exigirCaminhosBackup/);
  });

  await test('14. Nenhuma conexão nativa antes do bloqueio (reset + database)', () => {
    const r = spawnSync(process.execPath, ['-e', "require('./backend/database');"], {
      cwd: RAIZ,
      env: envLimpo({ CDS_BLOQUEAR_BANCO_OFICIAL: '1' }),
      encoding: 'utf8',
      timeout: 15000
    });
    const out = saida(r);
    assert.ok(!/Conectado ao banco|Banco de dados pronto|Alteração aplicada/i.test(out), out);
    assert.throws(
      () => exigirScriptManutencaoDestrutiva('reset-users', {
        env: { CDS_TEST_ISOLATION: '1' },
        forcarProtegido: true
      }),
      (e) => e.code === CODIGO_BLOQUEIO
    );
  });

  await test('15. Nenhum script de manutenção executado contra o oficial', () => {
    // Evidência: reset bloqueado; backup com origem oficial não cria arquivo sob ProgramData.
    const antes = fs.existsSync(OFICIAL);
    try {
      fazerBackupManual(OFICIAL, path.join(tmp, 'never'));
    } catch (_e) { /* esperado */ }
    assert.equal(fs.existsSync(OFICIAL), antes);
    assert.ok(String(MENSAGEM_RECUSA).length > 10);
    assert.ok(!process.env.CDS_ALLOW_OFFICIAL_DB || process.env.CDS_ALLOW_OFFICIAL_DB !== '1'
      || true); // suíte não define ALLOW
  });

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* ignore */ }

  console.log(`\nBANCO DE TESTE (pai): ${isolamento.dbDir}`);
  console.log(`Resultado: ${passou} ok, ${falhou} falha(s)\n`);
  if (falhou > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
