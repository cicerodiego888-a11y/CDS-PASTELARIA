'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repo = path.resolve(__dirname, '..', '..');
const out = path.join(__dirname, 'LOG-BLOCO-E-E03-CONTEXTO-OPERACIONAL.txt');
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
parts.push(`=== Sprint 06 E-03 contexto operacional — ${new Date().toISOString()} ===`);
parts.push('CDS_BLOQUEAR_BANCO_OFICIAL=1');
parts.push('CDS_TEST_ISOLATION=1');
parts.push('IMPRESSAO_FISICA=NAO');
parts.push('');

let totalFail = 0;
const counts = {};
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
  const failM = text.match(/ℹ fail (\d+)/);
  const passM = text.match(/ℹ pass (\d+)/);
  const fail = failM ? Number(failM[1]) : (r.status !== 0 ? 1 : 0);
  const pass = passM ? Number(passM[1]) : 0;
  totalFail += fail;
  counts[title] = { pass, fail };
  console.error(`[log] ${title} pass=${pass} fail=${fail}`);
}

parts.push('=== RESUMO E-03 CONTEXTO OPERACIONAL ===');
for (const k of Object.keys(counts)) {
  parts.push(`${k}: ${counts[k].pass} pass / ${counts[k].fail} fail`);
}
parts.push(`TOTAL_FAIL: ${totalFail}`);
if (totalFail === 0) {
  parts.push('VEREDITO: E-03 APROVADO — troca segura de contexto + identidade operacional');
  parts.push('BLOCO E — PRONTO PARA HOMOLOGAÇÃO CONTROLADA');
}
parts.push('IMPRESSAO_FISICA: NAO_EXECUTADA');
parts.push('');

fs.writeFileSync(out, parts.join('\n'), 'utf8');
console.log('wrote', out, 'TOTAL_FAIL', totalFail);
process.exit(totalFail === 0 ? 0 : 1);
