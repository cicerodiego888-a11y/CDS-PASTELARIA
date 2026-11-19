'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const repo = path.resolve(__dirname, '..', '..');
const out = path.join(__dirname, 'DIFF-BLOCO-E-E03-INTEGRACAO-OPERACIONAL.patch');
const baseDir = path.join(os.tmpdir(), `cds-s06e03op-${Date.now()}`);
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

const filesNew = [
  'backend/services/cozinha/CozinhaImpressaoElectronCicloVida.js',
  'backend/services/cozinha/CozinhaImpressaoWorkerBootstrap.js',
  'electron-cozinha-impressao.js',
  'tests/cozinha/sprint06-bloco-e-electron-integracao.test.js'
];

const chunks = [];
chunks.push('# DIFF — Sprint 06 Bloco E · E-03 integração operacional\n');
chunks.push(`# Gerado: ${new Date().toISOString()}\n`);
chunks.push('# Entry point efetivo: electron.js (package.json main)\n\n');

for (const logical of filesNew) {
  const absB = path.join(repo, logical);
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
if (!body.includes('anexarAoReadyToShowMainWindow')) throw new Error('missing anexar');
if (!body.includes('tentarAtivarAgendador')) throw new Error('missing agendador');
fs.writeFileSync(out, body, 'utf8');
console.log('wrote', out, 'bytes', fs.statSync(out).size);
