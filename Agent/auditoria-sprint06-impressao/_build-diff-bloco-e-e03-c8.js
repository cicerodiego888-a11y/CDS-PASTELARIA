'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const repo = path.resolve(__dirname, '..', '..');
const out = path.join(__dirname, 'DIFF-BLOCO-E-E03-C8-LOGOUT-TICK.patch');
const baseDir = path.join(os.tmpdir(), `cds-s06e03c8-${Date.now()}`);
fs.mkdirSync(baseDir, { recursive: true });

function gitDiffNoIndex(a, b) {
  try {
    return execFileSync(
      'git',
      ['-c', 'core.safecrlf=false', 'diff', '--no-index', '--', a, b],
      { encoding: 'utf8', cwd: repo, maxBuffer: 32 * 1024 * 1024 }
    );
  } catch (e) {
    if (typeof e.stdout === 'string') return e.stdout;
    throw e;
  }
}

function baselineContent(logical) {
  try {
    return execFileSync('git', ['show', `HEAD:${logical.replace(/\\/g, '/')}`], {
      encoding: 'utf8',
      cwd: repo,
      maxBuffer: 32 * 1024 * 1024
    });
  } catch (_e) {
    return '';
  }
}

function normalize(diff, logical, absA, absB) {
  let d = diff;
  for (const v of [absA, absA.replace(/\//g, '\\')]) d = d.split(v).join(`a/${logical}`);
  for (const v of [absB, absB.replace(/\//g, '\\')]) d = d.split(v).join(`b/${logical}`);
  d = d.replace(/diff --git "a\/[^"]+" "b\/[^"]+"/g, `diff --git a/${logical} b/${logical}`);
  d = d.replace(/^--- .*$/m, `--- a/${logical}`);
  d = d.replace(/^\+\+\+ .*$/m, `+++ b/${logical}`);
  return d;
}

const files = [
  'backend/services/cozinha/CozinhaImpressaoWorkerService.js',
  'backend/services/cozinha/CozinhaImpressaoWorkerBootstrap.js',
  'backend/services/cozinha/CozinhaImpressaoElectronCicloVida.js',
  'tests/cozinha/sprint06-bloco-e-e03-auditoria-complementar.test.js'
];

const chunks = [];
chunks.push('# DIFF — Sprint 06 E-03 C8 logout concorrente com tick\n');
chunks.push(`# Gerado: ${new Date().toISOString()}\n\n`);

for (const logical of files) {
  const absB = path.join(repo, logical);
  if (!fs.existsSync(absB)) throw new Error(`missing ${logical}`);
  const absA = path.join(baseDir, logical.replace(/[\\/]/g, '__'));
  fs.writeFileSync(absA, baselineContent(logical), 'utf8');
  chunks.push(normalize(gitDiffNoIndex(absA, absB), logical, absA, absB));
  chunks.push('\n');
}

const body = chunks.join('');
for (const c of [
  'IMPRESSAO_TICK_INVALIDADO',
  'invalidarGeracaoOperacional',
  'claim_sem_driver',
  'C8-A)',
  'C8-B)',
  'C8-C)'
]) {
  if (!body.includes(c)) throw new Error(`diff missing evidence: ${c}`);
}
fs.writeFileSync(out, body, 'utf8');
console.log('wrote', out, 'bytes', fs.statSync(out).size);
