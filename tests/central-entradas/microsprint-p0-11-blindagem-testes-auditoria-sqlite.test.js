/**
 * Microsprint P0.11 — Blindagem global de testes e preparação da auditoria SQLite.
 * Não abre o banco oficial. Não executa DistDFe, SOAP, PFX nem migrations no oficial.
 *
 * node -r ./tests/central-entradas/helpers/preloadIsolamentoBanco.js --test tests/central-entradas/microsprint-p0-11-blindagem-testes-auditoria-sqlite.test.js
 */
'use strict';

const {
  isolarBancoTeste,
  caminhoOficialPadrao,
  MENSAGEM_RECUSA,
  isolamentoAtivo
} = require('./helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-p011-blindagem-');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  classificarTodos,
  classificarEscopoP011
} = require('./helpers/classificarIsolamentoTestes');

const RAIZ = path.join(__dirname, '../..');
const SONDA_EXIGIR = path.join(__dirname, 'helpers/sondaExigirIsolamentoSemDbDir.js');
const SONDA_RECUSA = path.join(__dirname, 'helpers/sondaRecusaSqliteOficial.js');

const SCRIPTS_FISCAIS_COM_RISCO = [
  'test:fiscal-platform',
  'test:webservice-registry',
  'test:url-resolver',
  'test:soap-transport',
  'test:fiscal-status-runtime',
  'test:fiscal-dfe-runtime',
  'test:fiscal-manifestacao-runtime',
  'test:fiscal-consulta-runtime',
  'test:fiscal-cancelamento-runtime',
  'test:fiscal-autorizacao-runtime',
  'test:fiscal-telemetria',
  'test:dfe-observabilidade-rc3.6.e'
];

function envSemIsolamento() {
  const env = { ...process.env };
  delete env.DB_DIR;
  delete env.CDS_FORCAR_LOCAL;
  delete env.CDS_TEST_DB_PREFIX;
  return env;
}

function recusarSeOficial(texto) {
  const t = String(texto || '');
  assert.equal(/ProgramData[\\/]MercantilFiscal[\\/]dados/i.test(t), false);
  assert.equal(/\[MIB\] iniciado 712/.test(t), false);
}

function spawnNode(args, extra = {}) {
  return spawnSync(process.execPath, args, {
    cwd: RAIZ,
    encoding: 'utf8',
    timeout: extra.timeout || 30000,
    env: extra.env || envSemIsolamento()
  });
}

function saida(proc) {
  return `${proc.stdout || ''}\n${proc.stderr || ''}`;
}

describe('P0.11 blindagem de testes e recusa do SQLite oficial', () => {
  it('isolamento desta suíte está ativo e não é o caminho oficial', () => {
    assert.equal(isolamentoAtivo(), true);
    assert.ok(isolamento.dbDir.startsWith(os.tmpdir()) || isolamento.dbDir.includes(path.sep + 'Temp' + path.sep) || /tmp|Temp/i.test(isolamento.dbDir));
    recusarSeOficial(isolamento.dbDir);
    assert.match(caminhoOficialPadrao(), /MercantilFiscal[\\/]dados[\\/]mercadao\.db/i);
  });

  it('Central não permanece BLOQUEADA ATÉ ISOLAMENTO', () => {
    const lista = classificarTodos();
    const bloqueadas = lista.filter((x) => x.classe === 'BLOQUEADA ATÉ ISOLAMENTO');
    assert.deepEqual(bloqueadas, [], JSON.stringify(bloqueadas, null, 2));
  });

  it('escopo P0.11 (Central + fiscal) não tem BLOQUEADA ATÉ ISOLAMENTO', () => {
    const lista = classificarEscopoP011();
    const bloqueadas = lista.filter((x) => x.classe === 'BLOQUEADA ATÉ ISOLAMENTO');
    const isoladas = lista.filter((x) => x.classe === 'ISOLADA COMPROVADA');
    const semBanco = lista.filter((x) => x.classe === 'SEM ACESSO AO BANCO');
    const memoria = lista.filter((x) => x.classe === 'MEMORIA_OU_TEMP');
    const naoVerificada = lista.filter((x) => x.classe === 'NÃO VERIFICADA');
    assert.deepEqual(bloqueadas, [], JSON.stringify(bloqueadas, null, 2));
    assert.ok(isoladas.length > 0);
    assert.ok(semBanco.length > 0);
    console.log(
      `P0.11 classificação: isoladas=${isoladas.length} memoria/temp=${memoria.length}`
      + ` sem-banco=${semBanco.length} nao-verificada=${naoVerificada.length}`
      + ` bloqueadas=0 total=${lista.length}`
    );
    if (naoVerificada.length) {
      console.log('NÃO VERIFICADA:', naoVerificada.map((x) => x.arquivo).join(', '));
    }
  });

  it('vetores eager conhecidos de fiscal-dfe, DistDFe, DfeAuditoria e cancelamento estão isolados no arquivo', () => {
    const arquivos = [
      'tests/fiscal/fiscal-dfe-runtime.test.js',
      'tests/fiscal/distdfe-blindagem-05-43.test.js',
      'tests/fiscal/rc36e-dfe-observabilidade.test.js',
      'tests/fiscal/fiscal-manifestacao-runtime.test.js',
      'tests/fiscal/fiscal-cancelamento-runtime.test.js',
      'tests/fiscal/cancelamento-nfce-isolamento.test.js'
    ];
    for (const rel of arquivos) {
      const src = fs.readFileSync(path.join(RAIZ, rel), 'utf8');
      const iIso = src.search(/isolarBancoTeste\s*\(/);
      const iRisco = Math.min(
        ...[
          src.search(/require\s*\(\s*['"][^'"]*distribuicaoDFe['"]\s*\)/),
          src.search(/require\s*\(\s*['"][^'"]*DfeAuditoriaService['"]\s*\)/),
          src.search(/require\s*\(\s*['"][^'"]*fiscal\/core['"]\s*\)/),
          src.search(/require\s*\(\s*['"]sqlite3['"]\s*\)/),
          src.search(/require\s*\(\s*['"][^'"]*cancelarNfce['"]\s*\)/)
        ].filter((n) => n >= 0)
      );
      assert.ok(iIso >= 0, `${rel} sem isolarBancoTeste()`);
      assert.ok(Number.isFinite(iRisco), `${rel} sem require de risco detectado`);
      assert.ok(iIso < iRisco, `${rel} isolamento=${iIso} risco=${iRisco}`);
    }
  });

  it('scripts npm fiscais de risco usam -r preloadIsolamentoBanco.js (não basta o package.json sozinho)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));
    const falta = [];
    for (const nome of SCRIPTS_FISCAIS_COM_RISCO) {
      const cmd = pkg.scripts[nome] || '';
      if (!cmd.includes('preloadIsolamentoBanco.js')) falta.push(`${nome}=${cmd}`);
    }
    assert.deepEqual(falta, []);
  });

  it('sonda sem DB_DIR falha em exigirIsolamentoAtivo antes de DfeAuditoriaService', () => {
    const r = spawnNode([SONDA_EXIGIR]);
    const out = saida(r);
    assert.notEqual(r.status, 0);
    assert.match(out, new RegExp(MENSAGEM_RECUSA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(out, /SONDA_NAO_DEVERIA_CHEGAR_AQUI/);
    recusarSeOficial(out);
    assert.doesNotMatch(out, /Conectado ao banco de dados SQLite/);
  });

  it('sonda recusa sqlite3.Database(oficial) antes do construtor nativo', () => {
    const r = spawnNode([SONDA_RECUSA]);
    const out = saida(r);
    assert.equal(r.status, 0, out);
    assert.match(out, /SONDA_RECUSOU_ANTES_DO_SQLITE/);
    recusarSeOficial(out);
    assert.doesNotMatch(out, /Conectado ao banco de dados SQLite/);
    assert.doesNotMatch(out, /SONDA_FALHOU_ABRIU/);
  });

  it('invocação direta de fiscal-dfe-runtime.test.js sem -r não abre o oficial', { timeout: 60000 }, () => {
    const arquivo = path.join(RAIZ, 'tests/fiscal/fiscal-dfe-runtime.test.js');
    const r = spawnNode([arquivo], { timeout: 60000 });
    const out = saida(r);
    recusarSeOficial(out);
    assert.doesNotMatch(out, /C:\\ProgramData\\MercantilFiscal\\dados\\mercadao\.db/);
    assert.match(out, /ISOLAMENTO DE TESTE ATIVO:.*cds-fiscal-dfe-rt-/);
    assert.equal(r.status, 0, out);
  });

  it('invocação direta de fiscal-manifestacao-runtime.test.js sem -r não abre o oficial', { timeout: 60000 }, () => {
    const arquivo = path.join(RAIZ, 'tests/fiscal/fiscal-manifestacao-runtime.test.js');
    const r = spawnNode([arquivo], { timeout: 60000 });
    const out = saida(r);
    recusarSeOficial(out);
    assert.doesNotMatch(out, /C:\\ProgramData\\MercantilFiscal\\dados\\mercadao\.db/);
    assert.match(out, /ISOLAMENTO DE TESTE ATIVO:.*cds-fiscal-manif-rt-/);
    assert.equal(r.status, 0, out);
  });

  it('database.js desta suíte, se carregado, não é o oficial', () => {
    const aberto = isolamento.comprobarSeCarregado();
    if (aberto) recusarSeOficial(aberto);
  });
});
