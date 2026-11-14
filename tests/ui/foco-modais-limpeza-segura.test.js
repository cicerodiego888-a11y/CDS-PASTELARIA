/**
 * Auditoria de foco — limpeza de modais não pode roubar caret em telas/modais.
 * Executar: node tests/ui/foco-modais-limpeza-segura.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');

let ok = 0;
let falhas = 0;

function test(nome, fn) {
  try {
    fn();
    ok += 1;
    console.log(`  OK  ${nome}`);
  } catch (err) {
    falhas += 1;
    console.error(`  FAIL  ${nome}`);
    console.error(`       ${err.message}`);
  }
}

function ler(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

console.log('\n=== Foco — limpeza segura de modais ===\n');

test('core.js: limparModaisTravados respeita modal em uso e não limpa aria-hidden global', () => {
  const src = ler('frontend/shared/js/core.js');
  assert.match(src, /function haModalBootstrapEmUso\s*\(/);
  assert.match(src, /function limparModaisTravados\s*\(/);
  assert.match(src, /if\s*\(\s*haModalBootstrapEmUso\(\)\s*\)\s*return/);
  assert.doesNotMatch(
    src,
    /limparModaisTravados[\s\S]{0,400}querySelectorAll\(['"]\[aria-hidden/
  );
  assert.doesNotMatch(
    src,
    /limparModaisTravados[\s\S]{0,500}querySelectorAll\(['"]\.loading,\s*\.overlay/
  );
});

test('core.js: intervalo de backdrop órfão não limpa com modal ativo', () => {
  const src = ler('frontend/shared/js/core.js');
  assert.match(src, /setInterval\(\s*\(\)\s*=>\s*\{[\s\S]*haModalBootstrapEmUso\(\)/);
});

test('pdv.js: limparModaisTravados também aborta com modal ativo', () => {
  const src = ler('frontend/pdv/js/pdv.js');
  assert.match(src, /function limparModaisTravados\s*\(/);
  assert.match(src, /haModalBootstrapEmUso|\.modal\.show/);
  assert.doesNotMatch(
    src,
    /function limparModaisTravados\(\)\s*\{[\s\S]{0,300}querySelectorAll\(['"]\[aria-hidden/
  );
});

test('mesas-painel.js: redraw não destrói DOM com digitação ou modal aberto', () => {
  const src = ler('frontend/erp/js/mesas-painel.js');
  assert.match(src, /digitandoNoPainel/);
  assert.match(src, /modalAberto/);
  assert.match(src, /input,\s*textarea,\s*select/);
});

console.log(`\n${ok} ok, ${falhas} falha(s)\n`);
process.exit(falhas > 0 ? 1 : 0);
