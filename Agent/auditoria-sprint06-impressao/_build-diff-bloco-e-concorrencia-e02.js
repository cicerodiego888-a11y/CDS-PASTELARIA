'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const repo = path.resolve(__dirname, '..', '..');
const out = path.join(__dirname, 'DIFF-BLOCO-E-CORRECAO-CONCORRENCIA-E02.patch');
const baseDir = path.join(os.tmpdir(), `cds-s06e-conc-${Date.now()}`);
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
  'tests/cozinha/sprint06-bloco-e-electron-integracao.test.js'
];

const chunks = [];
chunks.push('# DIFF — Sprint 06 Bloco E · correção concorrência E-02\n');
chunks.push(`# Gerado: ${new Date().toISOString()}\n\n`);

for (const logical of files) {
  const absB = path.join(repo, logical);
  const absA = path.join(baseDir, logical.replace(/[\\/]/g, '__'));
  fs.writeFileSync(absA, '');
  const raw = gitDiffNoIndex(absA, absB);
  chunks.push(normalize(raw, logical, absA, absB));
  if (!chunks[chunks.length - 1].endsWith('\n')) chunks.push('\n');
  chunks.push('\n');
}

const body = chunks.join('');
if (!body.includes('processando_em IS ?') || !body.includes('worker_id IS ?')) {
  throw new Error('UPDATE condicional versionado ausente no patch');
}
if (!body.includes('ignorados_versao')) {
  throw new Error('ignorados_versao ausente');
}
fs.writeFileSync(out, body, 'utf8');
console.log('wrote', out, 'bytes', fs.statSync(out).size);
