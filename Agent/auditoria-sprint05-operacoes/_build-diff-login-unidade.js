'use strict';
/**
 * Diff real da última correção S05 (login operador↔unidade).
 * Baseline = pós-homologação (JWT claim sem validação de cadastro).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const repo = path.resolve(__dirname, '..', '..');
const out = path.join(__dirname, 'DIFF-ULTIMA-CORRECAO-LOGIN-UNIDADE-S05.patch');
const baseDir = path.join(os.tmpdir(), 'cds-s05-login-baseline');
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

function baselineAuth(src) {
  let s = src;
  s = s.replace(
    /const \{\r?\n  validarUnidadeCozinhaNoLogin\r?\n\} = require\('\.\.\/services\/cozinha\/cozinhaAuthUnidade'\);\r?\n/,
    ''
  );

  // emitirToken(unidade, extra) → emitirToken(extra) com unidade do body sem validação
  s = s.replace(
    /const emitirToken = \(unidadeCozinhaId, extraDetalhe = \{\}\) => \{/,
    `const unidadeCozinhaId = (() => {
      const n = Number(unidadeCozinhaIdRaw);
      return Number.isInteger(n) && n > 0 ? n : null;
    })();

    const emitirToken = (extraDetalhe = {}) => {`
  );

  // Remover concluirLogin e voltar a chamar emitirToken direto
  s = s.replace(
    /\r?\n    const concluirLogin = \(extraDetalhe = \{\}\) => \{[\s\S]*?\n    \};\r?\n\r?\n    \/\/ Garante vínculo/,
    '\n\n    // Garante vínculo'
  );

  s = s.replace(
    /concluirLogin\(\{\r?\n          empresas_disponiveis: Array\.isArray\(acesso\.empresas\) \? acesso\.empresas\.length : 0,\r?\n          empresas_vinculo_auto: !!acesso\.healed\r?\n        \}\);/,
    `emitirToken({
          empresas_disponiveis: Array.isArray(acesso.empresas) ? acesso.empresas.length : 0,
          empresas_vinculo_auto: !!acesso.healed
        });`
  );

  s = s.replace(
    /\/\/ Unidade, se solicitada, ainda é validada em concluirLogin\.\r?\n        concluirLogin\(\{ empresas_vinculo_erro: errAcesso && errAcesso\.message \}\);/,
    'emitirToken({ empresas_vinculo_erro: errAcesso && errAcesso.message });'
  );

  return s;
}

function baselineSchema(src) {
  return src.replace(
    /\r?\n    \/\/ Auxiliar de autorização[\s\S]*?await dbRun\(db, 'DROP TABLE IF EXISTS cozinha_operador_unidades'\);\r?\n/,
    '\n'
  );
}

const files = [
  {
    logical: 'backend/services/cozinha/cozinhaAuthUnidade.js',
    src: path.join(repo, 'backend/services/cozinha/cozinhaAuthUnidade.js'),
    empty: true
  },
  {
    logical: 'backend/rotas/auth.js',
    src: path.join(repo, 'backend/rotas/auth.js'),
    transform: baselineAuth
  },
  {
    logical: 'backend/utils/cozinhaSchema.js',
    src: path.join(repo, 'backend/utils/cozinhaSchema.js'),
    transform: baselineSchema
  }
];

let patch = [
  '# DIFF REAL — Última correção S05: validação operador↔unidade no login',
  '# Baseline: pós-homologação (JWT claim sem validação de cadastro)',
  '# Alvo: código atual (validarUnidadeCozinhaNoLogin antes de jwt.sign)',
  ''
].join('\n');

for (const f of files) {
  const src = fs.readFileSync(f.src, 'utf8');
  const baselinePath = path.join(baseDir, path.basename(f.logical));
  if (f.empty) {
    fs.writeFileSync(baselinePath, '');
  } else {
    const baseline = f.transform(src);
    if (baseline === src) {
      console.error('WARN: transform did not change', f.logical);
    }
    fs.writeFileSync(baselinePath, baseline);
  }
  patch += normalize(gitDiff(baselinePath, f.src), f.logical, baselinePath, f.src) + '\n';
}

fs.writeFileSync(out, patch);
const hunks = (patch.match(/^@@/gm) || []).length;
const authHunk = patch.includes('concluirLogin') && patch.includes('validarUnidadeCozinhaNoLogin');
console.log(JSON.stringify({
  out,
  bytes: Buffer.byteLength(patch),
  hunks,
  authLooksOk: authHunk,
  authDiffLines: (patch.split('diff --git a/backend/rotas/auth.js')[1] || '').split('\ndiff --git')[0].split('\n').length
}, null, 2));
