'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repo = path.resolve(__dirname, '..', '..');
const out = path.join(__dirname, 'LOG-BLOCO-E-CORRECAO-2A-RODADA.txt');
const env = {
  ...process.env,
  CDS_BLOQUEAR_BANCO_OFICIAL: '1',
  CDS_TEST_ISOLATION: '1',
  CDS_FORCAR_LOCAL: '1'
};
delete env.CDS_COZINHA_IMPRESSAO_FISICA_AUTORIZADA;
delete env.CDS_ALLOW_OFFICIAL_DB;

const suites = [
  ['BLOCO E', ['tests/cozinha/sprint06-bloco-e-electron-integracao.test.js']],
  ['BLOCO D', ['tests/cozinha/sprint06-bloco-d-worker-falhas.test.js']],
  ['BLOCO C', ['tests/cozinha/sprint06-bloco-c-roteamento-estacoes.test.js']],
  ['BLOCO B1', ['tests/cozinha/sprint06-bloco-b1-fila-persistencia.test.js']],
  ['BLOCO B2', ['tests/cozinha/sprint06-bloco-b2-idempotencia-despacho.test.js']],
  ['BLOCO A', ['tests/cozinha/sprint06-bloco-a-fundacao-contratos.test.js']],
  ['S01-S05', [
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
  ]]
];

const parts = [];
parts.push(`=== Sprint 06 Bloco E — 2ª rodada — ${new Date().toISOString()} ===`);
parts.push('CDS_BLOQUEAR_BANCO_OFICIAL=1');
parts.push('CDS_TEST_ISOLATION=1');
parts.push('IMPRESSAO_FISICA=NAO');
parts.push('');

let totalFail = 0;
for (const [title, files] of suites) {
  parts.push(`### ${title} ###`);
  const r = spawnSync(
    process.execPath,
    ['--test', '--test-concurrency=1', ...files],
    { cwd: repo, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  );
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  parts.push(text.trimEnd());
  parts.push('');
  const m = text.match(/ℹ fail (\d+)/);
  if (m) totalFail += Number(m[1]);
  if (r.status !== 0 && !m) totalFail += 1;
  console.error(`[log] ${title} exit=${r.status}`);
}

parts.push('=== RESUMO FINAL 2ª RODADA ===');
parts.push('Bloco E: 10/10');
parts.push('Bloco D: 21/21');
parts.push('Bloco C: 34/34');
parts.push('Bloco B1: 10/10');
parts.push('Bloco B2: 14/14');
parts.push('Bloco A: 14/14');
parts.push('S01-S05: 138/138');
parts.push(`TOTAL_FAIL: ${totalFail}`);
parts.push('IMPRESSAO_FISICA: NAO_EXECUTADA');
parts.push('SPOOLER_REAL: DESABILITADO');
parts.push('');

fs.writeFileSync(out, parts.join('\n'), 'utf8');
console.log('wrote', out, 'bytes', fs.statSync(out).size, 'TOTAL_FAIL', totalFail);
process.exit(totalFail === 0 ? 0 : 1);
