'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const repo = path.resolve(__dirname, '..', '..');
const out = path.join(__dirname, 'DIFF-BLOCO-A-S06.patch');
const baseDir = path.join(os.tmpdir(), 'cds-s06a-baseline');
fs.mkdirSync(baseDir, { recursive: true });

function gitDiff(a, b) {
  try {
    return execFileSync('git', ['-c', 'core.safecrlf=false', 'diff', '--no-index', '--', a, b], {
      encoding: 'utf8', cwd: repo, maxBuffer: 8 * 1024 * 1024
    });
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
  {
    logical: 'backend/services/cozinha/cozinhaImpressaoContratos.js',
    src: path.join(repo, 'backend/services/cozinha/cozinhaImpressaoContratos.js'),
    empty: true
  },
  {
    logical: 'backend/services/cozinha/CozinhaImpressaoRenderer.js',
    src: path.join(repo, 'backend/services/cozinha/CozinhaImpressaoRenderer.js'),
    empty: true
  },
  {
    logical: 'backend/services/cozinha/CozinhaImpressaoEstacaoService.js',
    src: path.join(repo, 'backend/services/cozinha/CozinhaImpressaoEstacaoService.js'),
    empty: true
  },
  {
    logical: 'tests/cozinha/sprint06-bloco-a-fundacao-contratos.test.js',
    src: path.join(repo, 'tests/cozinha/sprint06-bloco-a-fundacao-contratos.test.js'),
    empty: true
  },
  {
    logical: 'backend/utils/cozinhaSchema.js',
    src: path.join(repo, 'backend/utils/cozinhaSchema.js'),
    transform(s) {
      return s
        .replace(
          /\/\/ UNIQUE por \(empresa, unidade, codigo\)[\s\S]*?CREATE UNIQUE INDEX IF NOT EXISTS ux_cozinha_estacoes_empresa_unidade_codigo\r?\n    ON cozinha_estacoes_impressao\(empresa_id, unidade_id, codigo_estacao\)\r?\n/,
          `CREATE UNIQUE INDEX IF NOT EXISTS ux_cozinha_estacoes_empresa_codigo
    ON cozinha_estacoes_impressao(empresa_id, codigo_estacao)
`
        )
        .replace(/\r?\n  await garantirIndiceEstacoesCodigoPorUnidade\(db\);\r?\n/, '\n')
        .replace(
          /\r?\n\/\*\*\r?\n \* Sprint 06 Bloco A[\s\S]*?async function garantirIndiceEstacoesCodigoPorUnidade\(db\) \{[\s\S]*?\}\r?\n\r?\nasync function garantirSchemaCozinha/,
          '\n\nasync function garantirSchemaCozinha'
        )
        .replace(/\r?\n  garantirIndiceEstacoesCodigoPorUnidade,\r?\n/, '\n');
    }
  },
  {
    logical: 'backend/rotas/cozinha.js',
    src: path.join(repo, 'backend/rotas/cozinha.js'),
    transform(s) {
      return s
        .replace(
          /\r?\nconst CozinhaImpressaoEstacao = require\('\.\.\/services\/cozinha\/CozinhaImpressaoEstacaoService'\);\r?\nconst \{\r?\n  montarPayloadSnapshot,\r?\n  serializarSnapshot,\r?\n  snapshotContemCamposProibidos\r?\n\} = require\('\.\.\/services\/cozinha\/cozinhaImpressaoContratos'\);\r?\nconst \{ renderizarTexto \} = require\('\.\.\/services\/cozinha\/CozinhaImpressaoRenderer'\);\r?\n/,
          '\n'
        )
        .replace(
          / \* Sprint 02: despacho \| Sprint 03\/05: preparação\r?\n \* Sprint 06 Bloco A: estações\/contratos de impressão \(sem print físico\)\r?\n/,
          ' * Sprint 02: despacho | Sprint 03/05: preparação e operações de itens\n'
        )
        .replace(
          /\r?\n\/\/ —— Sprint 06 Bloco A[\s\S]*?module\.exports = router;/,
          '\n\nmodule.exports = router;'
        );
    }
  }
];

let patch = [
  '# DIFF REAL — Sprint 06 Bloco A (fundação e contratos de impressão)',
  '# Schema permanece v3. Sem Blocos B–E.',
  ''
].join('\n');

for (const f of files) {
  const src = fs.readFileSync(f.src, 'utf8');
  const baselinePath = path.join(baseDir, path.basename(f.logical).replace(/\//g, '_'));
  if (f.empty) fs.writeFileSync(baselinePath, '');
  else {
    const b = f.transform(src);
    if (b === src) console.error('WARN unchanged', f.logical);
    fs.writeFileSync(baselinePath, b);
  }
  patch += normalize(gitDiff(baselinePath, f.src), f.logical, baselinePath, f.src) + '\n';
}

fs.writeFileSync(out, patch);
console.log('wrote', out, 'bytes', Buffer.byteLength(patch), 'hunks', (patch.match(/^@@/gm) || []).length);
