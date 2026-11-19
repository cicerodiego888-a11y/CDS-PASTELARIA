'use strict';
/**
 * Regenera DIFF-BLOCO-E-CORRECAO-2A-RODADA.patch (conteúdo integral, sem omissões).
 * Arquivos untracked: new file completo. Tracked (electron*): git diff vs HEAD.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const repo = path.resolve(__dirname, '..', '..');
const out = path.join(__dirname, 'DIFF-BLOCO-E-CORRECAO-2A-RODADA.patch');
const baseDir = path.join(os.tmpdir(), `cds-s06e2-diff-${Date.now()}`);
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
  const escape = (s) => s.replace(/\\/g, '/');
  const variantsA = [absA, absA.replace(/\//g, '\\'), escape(absA)];
  const variantsB = [absB, absB.replace(/\//g, '\\'), escape(absB)];
  for (const v of variantsA) d = d.split(v).join(`a/${logical}`);
  for (const v of variantsB) d = d.split(v).join(`b/${logical}`);
  d = d.replace(/diff --git "a\/[^"]+" "b\/[^"]+"/g, `diff --git a/${logical} b/${logical}`);
  d = d.replace(/^--- .*$/m, `--- a/${logical}`);
  d = d.replace(/^\+\+\+ .*$/m, `+++ b/${logical}`);
  return d;
}

const untrackedNew = [
  'backend/services/cozinha/CozinhaImpressaoWorkerBootstrap.js',
  'backend/services/cozinha/CozinhaImpressaoWorkerService.js',
  'backend/services/cozinha/cozinhaImpressaoDriver.js',
  'backend/services/cozinha/cozinhaImpressaoElectronBridge.js',
  'backend/services/cozinha/cozinhaImpressaoElectronDriver.js',
  'backend/services/cozinha/CozinhaImpressaoElectronProducao.js',
  'electron-cozinha-impressao.js',
  'tests/cozinha/sprint06-bloco-e-electron-integracao.test.js'
];

const tracked = ['electron.js', 'electron-common.js', 'preload.js'];

const chunks = [];
chunks.push('# DIFF — Sprint 06 Bloco E · 2ª rodada (E-01/E-02/E-03)\n');
chunks.push(`# Gerado: ${new Date().toISOString()}\n`);
chunks.push('# Escopo: WorkerService (simulação/canônico), Bootstrap, Electron wiring, suite E.\n');
chunks.push('# Arquivos ainda untracked no git: apresentados como new file completo.\n\n');

for (const logical of untrackedNew) {
  const absB = path.join(repo, logical);
  if (!fs.existsSync(absB)) throw new Error(`missing ${logical}`);
  const absA = path.join(baseDir, logical.replace(/[\\/]/g, '__'));
  fs.writeFileSync(absA, '');
  const raw = gitDiffNoIndex(absA, absB);
  if (!raw || !raw.trim()) throw new Error(`empty diff for ${logical}`);
  chunks.push(normalize(raw, logical, absA, absB));
  if (!chunks[chunks.length - 1].endsWith('\n')) chunks.push('\n');
  chunks.push('\n');
  console.error('ok', logical, Buffer.byteLength(raw, 'utf8'));
}

for (const logical of tracked) {
  const d = execFileSync(
    'git',
    ['-c', 'core.safecrlf=false', 'diff', '--', logical],
    { encoding: 'utf8', cwd: repo, maxBuffer: 16 * 1024 * 1024 }
  );
  if (d && d.trim()) {
    chunks.push(d);
    if (!d.endsWith('\n')) chunks.push('\n');
    chunks.push('\n');
    console.error('ok-git', logical, Buffer.byteLength(d, 'utf8'));
  } else {
    console.error('warn-empty-git-diff', logical);
  }
}

const body = chunks.join('');
if (body.includes('# RELATÓRIO')) {
  throw new Error('patch body looks like relatório — abort');
}
if (!body.includes('simularProximoSemClaim')) {
  throw new Error('patch missing simularProximoSemClaim');
}
if (!body.includes('carregarJobCanonicoParaProcessamento')) {
  throw new Error('patch missing carregarJobCanonico');
}
if (!body.includes('CozinhaImpressaoWorkerBootstrap')) {
  throw new Error('patch missing Bootstrap');
}
if (!body.includes('instalarWorkerImpressaoCozinhaNoElectron')) {
  throw new Error('patch missing electron install');
}

fs.writeFileSync(out, body, 'utf8');
const st = fs.statSync(out);
console.log('wrote', out);
console.log('bytes', st.size);
console.log('lines', body.split(/\r?\n/).length);
