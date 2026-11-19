'use strict';
/**
 * Sprint 06 — execução final de testes (autorizada pelo Product Owner).
 * Somente testes automatizados / simulação. Sem impressão física. Sem banco oficial.
 * Sequencial (--test-concurrency=1). Sem alteração de código de produto.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const repo = path.resolve(__dirname, '..', '..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outLog = path.join(__dirname, 'LOG-SPRINT06-VALIDACAO-FINAL-PO.txt');
const outResumo = path.join(__dirname, 'RELATORIO-SPRINT06-VALIDACAO-FINAL-PO.md');

const env = {
  ...process.env,
  CDS_BLOQUEAR_BANCO_OFICIAL: '1',
  CDS_TEST_ISOLATION: '1',
  CDS_FORCAR_LOCAL: '1',
  JWT_SECRET: process.env.JWT_SECRET || 'cds-test-jwt-secret-sprint06-validacao-final-po'
};
delete env.CDS_COZINHA_IMPRESSAO_FISICA_AUTORIZADA;
delete env.CDS_ALLOW_OFFICIAL_DB;
delete env.CDS_COZINHA_SPOOLER_REAL;
if (env.NODE_ENV === 'production') env.NODE_ENV = 'test';

const electron = 'tests/cozinha/sprint06-bloco-e-electron-integracao.test.js';
const e03comp = 'tests/cozinha/sprint06-bloco-e-e03-auditoria-complementar.test.js';

/** Ordem obrigatória do PO. */
const suites = [
  {
    id: 'A',
    title: 'BLOCO A — Fundação / contratos',
    files: ['tests/cozinha/sprint06-bloco-a-fundacao-contratos.test.js']
  },
  {
    id: 'B1',
    title: 'BLOCO B1 — Fila / persistência',
    files: ['tests/cozinha/sprint06-bloco-b1-fila-persistencia.test.js']
  },
  {
    id: 'B2',
    title: 'BLOCO B2 — Idempotência / despacho',
    files: ['tests/cozinha/sprint06-bloco-b2-idempotencia-despacho.test.js']
  },
  {
    id: 'C',
    title: 'BLOCO C — Roteamento / estações',
    files: ['tests/cozinha/sprint06-bloco-c-roteamento-estacoes.test.js']
  },
  {
    id: 'D',
    title: 'BLOCO D — Worker / FAKE / falhas',
    files: ['tests/cozinha/sprint06-bloco-d-worker-falhas.test.js']
  },
  {
    id: 'E-01',
    title: 'E-01 — Dry-run / simulação (sem spooler)',
    files: [electron],
    // Usa "E-01:" para NÃO casar o describe "E-01/E-02/E-03".
    namePattern: 'E-01:'
  },
  {
    id: 'E-02',
    title: 'E-02 — Concorrência / propriedade / recuperação',
    files: [electron],
    namePattern: 'E-02:'
  },
  {
    id: 'E-03-BASE',
    title: 'E-03 base — Electron (E-03 + cobertura operacional Bloco E)',
    files: [electron],
    namePattern: 'E-03:|E-03 evidência|timeout →|falha não altera|falha de comunicação|IPC genérico'
  },
  {
    id: 'E-03',
    title: 'E-03 complementar — ciclo/auth/logout/claim/gate (C1–C10D)',
    files: [e03comp]
  },
  {
    id: 'S01-S05',
    title: 'REGRESSÃO Sprints 01–05',
    files: [
      'tests/cozinha/sprint01-fundacao-persistencia.test.js',
      'tests/cozinha/sprint01-correcao-isolamento-empresa.test.js',
      'tests/cozinha/sprint02-despacho-fifo.test.js',
      'tests/cozinha/sprint02-correcoes-auditoria.test.js',
      'tests/cozinha/sprint02-http-seguranca.test.js',
      'tests/cozinha/sprint03-preparacao.test.js',
      'tests/cozinha/sprint03-correcoes-auditoria.test.js',
      'tests/cozinha/sprint04a-upgrade-schema-v2-v3.test.js',
      'tests/cozinha/sprint05-login-unidade-auth.test.js',
      'tests/cozinha/sprint05-operacoes-itens.test.js'
    ]
  },
  {
    id: 'ISO-SEG',
    title: 'ISOLAMENTO E SEGURANÇA (final)',
    steps: [
      {
        files: ['tests/cozinha/sprint01-correcao-isolamento-empresa.test.js']
      },
      {
        files: ['tests/cozinha/sprint02-http-seguranca.test.js']
      },
      {
        files: [electron],
        namePattern: 'IPC genérico'
      },
      {
        files: ['tests/cozinha/sprint06-bloco-d-worker-falhas.test.js'],
        namePattern: 'isolamento por empresa'
      },
      {
        files: ['tests/cozinha/sprint06-bloco-c-roteamento-estacoes.test.js'],
        namePattern: 'isolamento: ambiguidade'
      },
      {
        files: ['tests/cozinha/sprint06-bloco-a-fundacao-contratos.test.js'],
        namePattern: 'isolamento JWT|não acopla impressão comercial'
      },
      {
        files: ['tests/cozinha/sprint06-bloco-b1-fila-persistencia.test.js'],
        namePattern: 'isolamento|não acopla'
      }
    ]
  }
];

function parseCounts(text, status) {
  const num = (re) => {
    const m = text.match(re);
    return m ? Number(m[1]) : null;
  };
  let pass = num(/ℹ pass (\d+)/);
  let fail = num(/ℹ fail (\d+)/);
  let skipped = num(/ℹ skipped (\d+)/);
  let todo = num(/ℹ todo (\d+)/);
  let cancelled = num(/ℹ cancelled (\d+)/);
  let tests = num(/ℹ tests (\d+)/);
  if (pass == null) pass = 0;
  if (fail == null) fail = status !== 0 ? 1 : 0;
  if (skipped == null) skipped = 0;
  if (todo == null) todo = 0;
  if (cancelled == null) cancelled = 0;
  if (tests == null) tests = pass + fail + skipped + todo + cancelled;
  return { pass, fail, skipped, todo, cancelled, tests };
}

const parts = [];
parts.push(`=== Sprint 06 — VALIDAÇÃO FINAL (PO) — ${new Date().toISOString()} ===`);
parts.push(`host: ${os.hostname()}`);
parts.push(`cwd: ${repo}`);
parts.push(`node: ${process.version}`);
parts.push('CDS_BLOQUEAR_BANCO_OFICIAL=1');
parts.push('CDS_TEST_ISOLATION=1');
parts.push('CDS_FORCAR_LOCAL=1');
parts.push('CDS_COZINHA_IMPRESSAO_FISICA_AUTORIZADA=AUSENTE');
parts.push('CDS_ALLOW_OFFICIAL_DB=AUSENTE');
parts.push('IMPRESSAO_FISICA=NAO');
parts.push('SPOOLER_REAL=DESABILITADO');
parts.push('BANCO: temporário / :memory: / mkdtemp sob os.tmpdir() (prefixo cds-cozinha-*)');
parts.push('PARALELISMO: desabilitado (--test-concurrency=1)');
parts.push('ALTERACAO_CODIGO: NENHUMA nesta execução');
parts.push('');

const counts = {};
let totalPass = 0;
let totalFail = 0;
let totalSkipped = 0;
let totalTodo = 0;
let totalCancelled = 0;
let totalTests = 0;
const commands = [];

function runOne(label, files, namePattern) {
  const args = ['--test', '--test-concurrency=1', '--test-force-exit'];
  if (namePattern) args.push(`--test-name-pattern=${namePattern}`);
  args.push(...files);
  const cmd = `node ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`;
  const started = Date.now();
  const r = spawnSync(process.execPath, args, {
    cwd: repo,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  const elapsed = Date.now() - started;
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  const c = parseCounts(text, r.status == null ? 1 : r.status);
  return { cmd, text, elapsed, status: r.status, counts: c, files, namePattern: namePattern || null, label };
}

for (const suite of suites) {
  parts.push(`### ${suite.id} — ${suite.title} ###`);
  parts.push(`ENV_FORCE: CDS_BLOQUEAR_BANCO_OFICIAL=1 CDS_TEST_ISOLATION=1`);
  parts.push('');

  const steps = suite.steps
    ? suite.steps
    : [{ files: suite.files, namePattern: suite.namePattern }];

  console.error(`[run] ${suite.id} ...`);
  let suitePass = 0;
  let suiteFail = 0;
  let suiteSkipped = 0;
  let suiteTodo = 0;
  let suiteCancelled = 0;
  let suiteTests = 0;
  let suiteElapsed = 0;
  let suiteExit = 0;

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const label = steps.length > 1 ? `${suite.id}.${i + 1}` : suite.id;
    const out = runOne(label, step.files, step.namePattern);
    commands.push({
      id: label,
      cmd: out.cmd,
      files: out.files,
      namePattern: out.namePattern
    });
    parts.push(`CMD[${label}]: ${out.cmd}`);
    parts.push(out.text.trimEnd());
    parts.push('');
    parts.push(`EXIT_CODE[${label}]: ${out.status == null ? 'null' : out.status}`);
    parts.push(`ELAPSED_MS[${label}]: ${out.elapsed}`);
    parts.push('');

    suitePass += out.counts.pass;
    suiteFail += out.counts.fail;
    suiteSkipped += out.counts.skipped;
    suiteTodo += out.counts.todo;
    suiteCancelled += out.counts.cancelled;
    suiteTests += out.counts.tests;
    suiteElapsed += out.elapsed;
    if (out.status) suiteExit = out.status;
  }

  counts[suite.id] = {
    pass: suitePass,
    fail: suiteFail,
    skipped: suiteSkipped,
    todo: suiteTodo,
    cancelled: suiteCancelled,
    tests: suiteTests,
    elapsed_ms: suiteElapsed,
    exit: suiteExit
  };
  totalPass += suitePass;
  totalFail += suiteFail;
  totalSkipped += suiteSkipped;
  totalTodo += suiteTodo;
  totalCancelled += suiteCancelled;
  totalTests += suiteTests;
  console.error(
    `[log] ${suite.id} tests=${suiteTests} pass=${suitePass} fail=${suiteFail} skipped=${suiteSkipped} elapsed=${suiteElapsed}ms`
  );
}

parts.push('=== RESUMO VALIDAÇÃO FINAL SPRINT 06 ===');
for (const suite of suites) {
  const c = counts[suite.id];
  parts.push(
    `${suite.id}: tests=${c.tests} pass=${c.pass} fail=${c.fail} skipped=${c.skipped} todo=${c.todo} cancelled=${c.cancelled}`
  );
}
parts.push(`TOTAL_TESTS: ${totalTests}`);
parts.push(`TOTAL_PASS: ${totalPass}`);
parts.push(`TOTAL_FAIL: ${totalFail}`);
parts.push(`TOTAL_SKIPPED: ${totalSkipped}`);
parts.push(`TOTAL_TODO: ${totalTodo}`);
parts.push(`TOTAL_CANCELLED: ${totalCancelled}`);
parts.push('BANCO_OFICIAL_ACESSADO: NAO (CDS_BLOQUEAR_BANCO_OFICIAL=1; testes usam :memory:/tmpdir)');
parts.push('IMPRESSAO_FISICA: NAO_EXECUTADA');
parts.push('SPOOLER_REAL: DESABILITADO');
parts.push('HOMOLOGACAO_FISICA: NAO_INICIADA');
parts.push('VEREDITO_EXECUCAO: ENTREGUE PARA AUDITORIA DO TECH LEAD — NÃO AUTOAPROVADO');
if (totalFail === 0) {
  parts.push('RESULTADO_BATERIA: TODAS_AS_SUITES_PASSARAM');
} else {
  parts.push('RESULTADO_BATERIA: HA_FALHAS — ver diagnóstico no relatório; código NÃO alterado');
}
parts.push('');

fs.writeFileSync(outLog, parts.join('\n'), 'utf8');

const md = [];
md.push('# RELATÓRIO — Sprint 06 · Validação Final (autorização PO)');
md.push('');
md.push(`**Data/hora:** ${new Date().toISOString()}`);
md.push('**Executor:** Cursor (execução de testes)');
md.push('**Auditoria:** ChatGPT — Tech Lead/Arquiteto');
md.push('**Escopo:** somente testes automatizados e simulações');
md.push('**Código de produto:** não modificado nesta etapa');
md.push('');
md.push('---');
md.push('');
md.push('## A. Resultado geral');
md.push('');
md.push(`| Métrica | Valor |`);
md.push(`|--------|------:|`);
md.push(`| Total de testes | ${totalTests} |`);
md.push(`| Aprovados (pass) | ${totalPass} |`);
md.push(`| Reprovados (fail) | ${totalFail} |`);
md.push(`| Ignorados (skipped) | ${totalSkipped} |`);
md.push(`| Todo | ${totalTodo} |`);
md.push(`| Cancelados | ${totalCancelled} |`);
md.push(`| TOTAL_FAIL | **${totalFail}** |`);
md.push('');
md.push('## B. Resultado por bloco');
md.push('');
md.push('| Bloco | Tests | Pass | Fail | Skipped | Elapsed ms |');
md.push('|-------|------:|-----:|-----:|--------:|-----------:|');
for (const suite of suites) {
  const c = counts[suite.id];
  md.push(
    `| ${suite.id} | ${c.tests} | ${c.pass} | ${c.fail} | ${c.skipped} | ${c.elapsed_ms} |`
  );
}
md.push('');
md.push('## C. Evidências');
md.push('');
md.push('### Comandos');
md.push('');
for (const c of commands) {
  md.push(`- **${c.id}:** \`${c.cmd}\``);
  if (c.namePattern) md.push(`  - name-pattern: \`${c.namePattern}\``);
}
md.push('');
md.push('### Ambiente');
md.push('');
md.push('- `CDS_BLOQUEAR_BANCO_OFICIAL=1`');
md.push('- `CDS_TEST_ISOLATION=1`');
md.push('- `CDS_FORCAR_LOCAL=1`');
md.push('- `CDS_COZINHA_IMPRESSAO_FISICA_AUTORIZADA` ausente');
md.push('- `CDS_ALLOW_OFFICIAL_DB` ausente');
md.push('- Paralelismo desabilitado (`--test-concurrency=1`)');
md.push('');
md.push('### Banco');
md.push('');
md.push('- Banco oficial: **não acessado**');
md.push('- Bancos de teste: SQLite `:memory:` e diretórios temporários `os.tmpdir()` com prefixos `cds-cozinha-*`');
md.push('');
md.push('### Impressão / spooler');
md.push('');
md.push('- Impressão física: **não executada**');
md.push('- Spooler real: **desabilitado**');
md.push('- Drivers: FAKE / mocks Electron (sem hardware)');
md.push('');
md.push(`### Log integral`);
md.push('');
md.push(`- Arquivo: \`Agent/auditoria-sprint06-impressao/LOG-SPRINT06-VALIDACAO-FINAL-PO.txt\``);
md.push(`- Gerado em: ${stamp}`);
md.push('');
md.push('## D. Pendências');
md.push('');
if (totalFail === 0) {
  md.push('- Nenhuma falha na bateria automatizada.');
  md.push('- Homologação física: **não iniciada** (proibida nesta etapa).');
  md.push('- Validação formal do Sprint 06: **pendente de análise e aprovação do Tech Lead** com base nestas evidências.');
} else {
  md.push('- Há falhas — código de produto **não** foi alterado.');
  md.push('- Diagnóstico deve ser feito pelo Tech Lead a partir do log integral antes de qualquer correção.');
}
md.push('');
md.push('---');
md.push('');
md.push('**VEREDITO DA EXECUÇÃO: ENTREGUE PARA AUDITORIA DO TECH LEAD — NÃO AUTOAPROVADO**');
md.push('');
md.push('**O Sprint 06 somente será considerado validado após análise e aprovação das evidências.**');
md.push('');

fs.writeFileSync(outResumo, md.join('\n'), 'utf8');
console.log('wrote', outLog);
console.log('wrote', outResumo);
console.log('TOTAL_FAIL', totalFail, 'TOTAL_PASS', totalPass, 'TOTAL_TESTS', totalTests);
process.exit(totalFail === 0 ? 0 : 1);
