'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const repo = path.resolve(__dirname, '..', '..');
const baseDir = path.join(os.tmpdir(), 'cds-s05-baseline');
const outPatch = path.join(__dirname, 'DIFF-CODIGO-PRODUCAO-S05.patch');

fs.mkdirSync(baseDir, { recursive: true });

const srcService = path.join(repo, 'backend', 'services', 'cozinha', 'CozinhaPreparacaoService.js');
const srcRoutes = path.join(repo, 'backend', 'rotas', 'cozinha.js');
const baseService = path.join(baseDir, 'CozinhaPreparacaoService.js');
const baseRoutes = path.join(baseDir, 'cozinha.js');

let s = fs.readFileSync(srcService, 'utf8');

s = s.replace(
  `/**
 * CozinhaPreparacaoService — Sprint 03 (+ auditoria) / Sprint 05 (operações homologadas)
 * Motor de preparação: iniciar, pronto, entrega de bebida, estado derivado da rodada.
 * Idempotência via tabela central cozinha_idempotencia (não só outbox).
 * Sprint 05: reforço de integridade item↔rodada↔comanda↔unidade sem duplicar o motor.
 */`,
  `/**
 * CozinhaPreparacaoService — Sprint 03 (+ auditoria)
 * Motor de preparação: iniciar, pronto, entrega de bebida, estado derivado da rodada.
 * Idempotência via tabela central cozinha_idempotencia (não só outbox).
 */`
);

const markerStart = '/**\n * Garante vínculo item ↔ rodada ↔ unidade ↔ comanda na mesma empresa.';
const markerEnd = '  return { comanda };\n}\n';
const i0 = s.indexOf(markerStart);
const i1 = s.indexOf(markerEnd, i0);
if (i0 < 0 || i1 < 0) {
  throw new Error('não localizei bloco validarIntegridadeOperacional');
}
s = s.slice(0, i0) + s.slice(i1 + markerEnd.length);

s = s.replace(
  /\n    await validarIntegridadeOperacional\(db, item, rodada, \{\n      empresaId,\n      unidadeIdOpcional: entrada\.unidade_id != null \? entrada\.unidade_id : entrada\.unidadeId\n    \}\);\n/g,
  '\n'
);

s = s.replace(
  /\n    if \(opts\.simularFalha === 'antes_commit'\) \{\n      throw erro\('Falha simulada antes do commit\.', 500, 'FALHA_SIMULADA'\);\n    \}\n/g,
  '\n'
);

if (s.includes('validarIntegridadeOperacional') || s.includes('simularFalha')) {
  throw new Error('baseline ainda contém marcadores S05');
}

fs.writeFileSync(baseService, s);

let r = fs.readFileSync(srcRoutes, 'utf8');
r = r.replace(
  'Rotas — Cozinha (Sprint 02: despacho | Sprint 03/05: preparação e operações de itens)',
  'Rotas — Cozinha (Sprint 02: despacho | Sprint 03: preparação)'
);

function revertRoute(blockName, withBodyForQty) {
  const re = new RegExp(
    `router\\.post\\('${blockName}', async \\(req, res\\) => \\{[\\s\\S]*?\\n\\}\\);`,
    'm'
  );
  const m = r.match(re);
  if (!m) throw new Error('rota ausente: ' + blockName);
  let block = m[0];
  if (withBodyForQty) {
    block = block.replace(
      /\n      unidade_id: body\.unidade_id != null \? body\.unidade_id : req\.query\.unidade_id,\n/,
      '\n'
    );
  } else {
    block = block.replace(/\n    const body = req\.body \|\| \{\};\n/, '\n');
    block = block.replace(
      /\n      unidade_id: body\.unidade_id != null \? body\.unidade_id : req\.query\.unidade_id\n/,
      '\n'
    );
  }
  r = r.replace(m[0], block);
}

revertRoute('/itens/:id/iniciar', false);
revertRoute('/itens/:id/pronto', false);
revertRoute('/itens/:id/bebida/entregar', true);

if (/iniciar[\s\S]{0,350}unidade_id/.test(r)) {
  throw new Error('baseline rotas ainda propaga unidade_id em iniciar');
}

fs.writeFileSync(baseRoutes, r);

function gitDiff(a, b) {
  try {
    return execFileSync(
      'git',
      ['-c', 'core.safecrlf=false', 'diff', '--no-index', '--', a, b],
      { encoding: 'utf8', cwd: repo, maxBuffer: 10 * 1024 * 1024 }
    );
  } catch (e) {
    if (typeof e.stdout === 'string' && e.stdout.length) return e.stdout;
    throw e;
  }
}

function normalizePaths(diffText, logicalA, logicalB, absA, absB) {
  let out = diffText;
  const variants = [absA, absA.replace(/\//g, '\\'), path.resolve(absA)];
  for (const v of variants) {
    out = out.split(v).join(logicalA);
    out = out.split(JSON.stringify(v).slice(1, -1)).join(logicalA);
  }
  const variantsB = [absB, absB.replace(/\//g, '\\'), path.resolve(absB)];
  for (const v of variantsB) {
    out = out.split(v).join(logicalB);
    out = out.split(JSON.stringify(v).slice(1, -1)).join(logicalB);
  }
  // git --no-index may quote paths
  out = out.replace(/diff --git "a\/[^"]+" "b\/[^"]+"/g, `diff --git a/${logicalA} b/${logicalB}`);
  out = out.replace(/^--- .*$/m, `--- a/${logicalA}`);
  out = out.replace(/^\+\+\+ .*$/m, `+++ b/${logicalB}`);
  return out;
}

let d1 = gitDiff(baseService, srcService);
d1 = normalizePaths(
  d1,
  'backend/services/cozinha/CozinhaPreparacaoService.js',
  'backend/services/cozinha/CozinhaPreparacaoService.js',
  baseService,
  srcService
);

let d2 = gitDiff(baseRoutes, srcRoutes);
d2 = normalizePaths(
  d2,
  'backend/rotas/cozinha.js',
  'backend/rotas/cozinha.js',
  baseRoutes,
  srcRoutes
);

const header = [
  '# DIFF REAL — código de produção Sprint 05',
  '# Baseline reconstruída = S03 homologada (sem validarIntegridadeOperacional, sem unidade_id nas rotas de item, sem simularFalha).',
  '# Arquivos: CozinhaPreparacaoService.js | rotas/cozinha.js',
  '',
  ''
].join('\n');

fs.writeFileSync(outPatch, header + d1 + '\n' + d2 + '\n', 'utf8');

console.log('OK', outPatch);
console.log('service hunks', (d1.match(/^@@/gm) || []).length, 'bytes', Buffer.byteLength(d1));
console.log('routes hunks', (d2.match(/^@@/gm) || []).length, 'bytes', Buffer.byteLength(d2));
console.log('service adds validar?', d1.includes('+async function validarIntegridadeOperacional'));
console.log('service false-add claim?', /\+async function claimIdempotenciaCentral/.test(d1));
