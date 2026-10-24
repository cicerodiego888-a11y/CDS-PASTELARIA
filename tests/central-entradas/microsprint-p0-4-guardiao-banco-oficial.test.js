/**
 * Microsprint P0.4 — Guardião do banco oficial e classificação estática das suítes.
 * Não abre o banco oficial. Não executa DistDFe nem PFX.
 *
 * node --test tests/central-entradas/microsprint-p0-4-guardiao-banco-oficial.test.js
 */
'use strict';

const {
  isolarBancoTeste,
  caminhoOficialPadrao,
  recusarOficial,
  caminhoEhOficial,
  MENSAGEM_RECUSA
} = require('./helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-p04-guard-');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { classificarTodos } = require('./helpers/classificarIsolamentoTestes');

describe('P0.4/P0.5 guardião do banco oficial', () => {
  it('sqlite3.Database (sem verbose) recusa o oficial antes do construtor nativo', () => {
    const raw = require('sqlite3');
    const oficial = caminhoOficialPadrao();
    assert.equal(raw.Database.__cdsIsolamentoCtor, true);
    assert.throws(
      () => new raw.Database(oficial),
      (err) => String(err.message).includes(MENSAGEM_RECUSA)
    );
  });

  it('sqlite3.verbose().Database recusa o oficial antes do construtor nativo', () => {
    const oficial = caminhoOficialPadrao();
    assert.match(oficial, /MercantilFiscal[\\/]dados[\\/]mercadao\.db/i);
    assert.equal(sqlite3.Database.__cdsIsolamentoCtor, true);
    assert.throws(
      () => new sqlite3.Database(oficial),
      (err) => String(err.message).includes(MENSAGEM_RECUSA)
    );
  });

  it('sqlite3.cached.Database recusa o oficial quando a API existir', () => {
    const raw = require('sqlite3');
    const oficial = caminhoOficialPadrao();
    if (!raw.cached || !raw.cached.Database) {
      assert.ok(true, 'sqlite3.cached ausente nesta versão');
      return;
    }
    assert.equal(raw.cached.Database.__cdsIsolamentoCtor, true);
    assert.throws(
      () => new raw.cached.Database(oficial),
      (err) => String(err.message).includes(MENSAGEM_RECUSA)
    );
  });

  it('recusarOficial e caminhoEhOficial reconhecem o banco de produção', () => {
    const oficial = caminhoOficialPadrao();
    assert.equal(caminhoEhOficial(oficial), true);
    assert.throws(
      () => recusarOficial(oficial),
      (err) => String(err.message).includes(MENSAGEM_RECUSA)
    );
  });

  it(':memory: e o DB_DIR temporário continuam permitidos', async () => {
    const mem = new sqlite3.Database(':memory:');
    mem.close();
    const raw = require('sqlite3');
    const tempFile = path.join(isolamento.dbDir, 'guardiao-temp.sqlite');
    await new Promise((resolve, reject) => {
      const db = new raw.Database(tempFile, (err) => {
        if (err) return reject(err);
        db.close((errClose) => (errClose ? reject(errClose) : resolve()));
      });
    });
    recusarSeNaoTemp(isolamento.dbDir);
    recusarSeNaoTemp(isolamento.dbPathEsperado);
    recusarSeNaoTemp(tempFile);
  });

  it('OPEN_READONLY do caminho oficial também é recusado antes da conexão', () => {
    const raw = require('sqlite3');
    const oficial = caminhoOficialPadrao();
    assert.throws(
      () => new raw.Database(oficial, raw.OPEN_READONLY),
      (err) => String(err.message).includes(MENSAGEM_RECUSA)
    );
  });

  it('cached.Database em :memory: não é bloqueado', async () => {
    const raw = require('sqlite3');
    if (!raw.cached || !raw.cached.Database) {
      assert.ok(true, 'sqlite3.cached ausente nesta versão');
      return;
    }
    await new Promise((resolve, reject) => {
      const db = new raw.cached.Database(':memory:', (err) => {
        if (err) return reject(err);
        db.close((errClose) => (errClose ? reject(errClose) : resolve()));
      });
    });
  });

  it('scripts npm da Central em package.json carregam o preload', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
    const semPreload = [];
    for (const [nome, cmd] of Object.entries(pkg.scripts)) {
      if (!String(cmd).includes('tests/central-entradas/')) continue;
      const partes = String(cmd).split('&&').map((s) => s.trim());
      for (const parte of partes) {
        if (!parte.includes('tests/central-entradas/')) continue;
        if (parte.startsWith('npm ')) continue;
        if (!parte.includes('preloadIsolamentoBanco.js')) semPreload.push(`${nome}: ${parte}`);
      }
    }
    assert.deepEqual(semPreload, []);
  });

  it('05.72 configura isolamento antes de CentralSincronizacaoService', () => {
    const src = fs.readFileSync(
      path.join(__dirname, 'isolamento-buscar-chave-empresa-05-72.test.js'),
      'utf8'
    );
    const iIso = src.indexOf('isolarBancoTeste(');
    const iSync = src.indexOf('CentralSincronizacaoService');
    assert.ok(iIso >= 0 && iIso < iSync);
  });

  it('nenhuma suíte da Central permanece BLOQUEADA ATÉ ISOLAMENTO', () => {
    const lista = classificarTodos();
    const bloqueadas = lista.filter((x) => x.classe === 'BLOQUEADA ATÉ ISOLAMENTO');
    assert.deepEqual(bloqueadas, []);
    const isoladas = lista.filter((x) => x.classe === 'ISOLADA COMPROVADA');
    const semBanco = lista.filter((x) => x.classe === 'SEM ACESSO AO BANCO');
    assert.ok(isoladas.length > 0);
    assert.ok(semBanco.length > 0);
    console.log(
      `classificação: isoladas=${isoladas.length} sem-banco=${semBanco.length} bloqueadas=0 total=${lista.length}`
    );
  });

  it('database.js desta suíte, se carregado, não é o oficial', () => {
    const aberto = isolamento.comprobarSeCarregado();
    if (aberto) {
      recusarSeNaoTemp(aberto);
    }
  });
});

function recusarSeNaoTemp(alvo) {
  const texto = String(alvo || '');
  assert.equal(/ProgramData[\\/]MercantilFiscal[\\/]dados/i.test(texto), false);
}
