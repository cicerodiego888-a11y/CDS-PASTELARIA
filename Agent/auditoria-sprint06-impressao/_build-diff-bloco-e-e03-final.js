'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const repo = path.resolve(__dirname, '..', '..');
const out = path.join(__dirname, 'DIFF-BLOCO-E-AUDITORIA-FINAL-E03.patch');
const baseDir = path.join(os.tmpdir(), `cds-s06e03-${Date.now()}`);
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

const untracked = [
  'backend/services/cozinha/CozinhaImpressaoWorkerBootstrap.js',
  'tests/cozinha/sprint06-bloco-e-electron-integracao.test.js',
  'electron-cozinha-impressao.js'
];

const chunks = [];
chunks.push('# DIFF — Sprint 06 Bloco E · auditoria final E-03\n');
chunks.push(`# Gerado: ${new Date().toISOString()}\n\n`);

for (const logical of untracked) {
  const absB = path.join(repo, logical);
  if (!fs.existsSync(absB)) continue;
  const absA = path.join(baseDir, logical.replace(/[\\/]/g, '__'));
  fs.writeFileSync(absA, '');
  chunks.push(normalize(gitDiffNoIndex(absA, absB), logical, absA, absB));
  chunks.push('\n');
}

for (const logical of ['electron.js', 'electron-common.js']) {
  const d = execFileSync(
    'git',
    ['-c', 'core.safecrlf=false', 'diff', '--', logical],
    { encoding: 'utf8', cwd: repo, maxBuffer: 8 * 1024 * 1024 }
  );
  if (d && d.trim()) {
    chunks.push(d);
    if (!d.endsWith('\n')) chunks.push('\n');
    chunks.push('\n');
  }
}

const body = chunks.join('');
if (!body.includes('encerrarWorkerImpressaoCozinhaNoElectron')) {
  throw new Error('patch missing encerrar');
}
if (!body.includes('simularReadyToShowElectronInstalarWorker')) {
  throw new Error('patch missing simularReadyToShow');
}
fs.writeFileSync(out, body, 'utf8');
console.log('wrote', out, 'bytes', fs.statSync(out).size);
