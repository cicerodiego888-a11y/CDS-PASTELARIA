'use strict';

const fs = require('fs');

function repair(file) {
  let s = fs.readFileSync(file, 'utf8');

  // Fix: await seedInfra without binding when later uses infra.unidadeId
  s = s.replace(
    /await seedInfra\(db\);\n(\s*)await assert\.rejects\(\n(\s*)\(\) => CozinhaPreparacao\.(iniciarPreparacao|marcarItemPronto)\(\{\n(\s*)empresaId: 1, operadorId: 7, unidade_id: infra\.unidadeId,/g,
    'const infra = await seedInfra(db);\n$1await assert.rejects(\n$2() => CozinhaPreparacao.$3({\n$4empresaId: 1, operadorId: 7, unidade_id: infra.unidadeId,'
  );

  // Fix calls where operadorId was eaten and only unidade_id remains after empresaId
  s = s.replace(
    /CozinhaPreparacao\.(iniciarPreparacao|marcarItemPronto|entregarBebida)\(\{([\s\S]*?)\}\s*,/g,
    (full, method, body) => {
      let b = body;
      if (!/\boperadorId\s*:/.test(b)) {
        if (/empresaId:\s*[^\n]+,\s*\n/.test(b)) {
          b = b.replace(/(empresaId:\s*[^\n]+,\s*\n)/, '$1        operadorId: 7,\n');
        } else if (/empresaId:\s*[^,\n]+,/.test(b)) {
          b = b.replace(/(empresaId:\s*[^,\n]+,)/, '$1 operadorId: 7,');
        } else {
          b = `\n        operadorId: 7,${b}`;
        }
      }
      // ensure unidade_id exists
      if (!/\bunidade_id\s*:/.test(b)) {
        const expr = /empresaId:\s*infra2/.test(b) || /empresaId:\s*2\b/.test(b)
          ? 'infra2.unidadeId'
          : 'infra.unidadeId';
        if (/operadorId:[^\n]*,\s*\n/.test(b)) {
          b = b.replace(/(operadorId:[^\n]*,\s*\n)/, `$1        unidade_id: ${expr},\n`);
        } else {
          b = b.replace(/(operadorId:\s*[^,\n]+,)/, `$1 unidade_id: ${expr},`);
        }
      }
      // normalize weird indentation on unidade_id-only lines
      b = b.replace(/\n\s+unidade_id:/g, '\n        unidade_id:');
      return `CozinhaPreparacao.${method}({${b}},`;
    }
  );

  fs.writeFileSync(file, s);
  console.log('repaired', file);
}

for (const f of [
  'tests/cozinha/sprint05-operacoes-itens.test.js',
  'tests/cozinha/sprint03-preparacao.test.js',
  'tests/cozinha/sprint03-correcoes-auditoria.test.js'
]) {
  repair(f);
}
