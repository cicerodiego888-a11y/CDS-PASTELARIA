'use strict';

const fs = require('fs');

function inject(file, defaultExpr) {
  let s = fs.readFileSync(file, 'utf8');
  const re = /CozinhaPreparacao\.(iniciarPreparacao|marcarItemPronto|entregarBebida)\(\{([\s\S]*?)\}\s*,/g;
  let count = 0;
  s = s.replace(re, (full, method, body) => {
    if (/\bunidade_id\s*:/.test(body)) return full;
    count += 1;
    let expr = defaultExpr;
    if (/empresaId:\s*infra2\.empresaId/.test(body) || /empresaId:\s*2\b/.test(body)) {
      expr = 'infra2.unidadeId';
    } else if (/empresaId:\s*infra\.empresaId/.test(body) || /empresaId:\s*infra1/.test(body)) {
      expr = 'infra.unidadeId';
    } else if (/empresaId:\s*1\b/.test(body)) {
      expr = defaultExpr;
    }
    // prefer multiline insert after operadorId line
    if (/operadorId:[^\n]*,\s*\n/.test(body)) {
      const body2 = body.replace(
        /(operadorId:[^\n]*,\s*\n)/,
        `$1        unidade_id: ${expr},\n`
      );
      return `CozinhaPreparacao.${method}({${body2}},`;
    }
    // single-line style
    const body2 = body.replace(
      /(operadorId:\s*[^,\n]+,)/,
      `$1 unidade_id: ${expr},`
    );
    return `CozinhaPreparacao.${method}({${body2}},`;
  });
  fs.writeFileSync(file, s);
  console.log(file, 'injected', count);
}

// S05 may have duplicates from prior pass — normalize first
function cleanS05(file) {
  let s = fs.readFileSync(file, 'utf8');
  // remove accidental duplicate consecutive unidade_id lines
  s = s.replace(
    /(\s*unidade_id:\s*[^\n]+,\n)(\s*unidade_id:\s*[^\n]+,\n)+/g,
    '$1'
  );
  fs.writeFileSync(file, s);
}

cleanS05('tests/cozinha/sprint05-operacoes-itens.test.js');
inject('tests/cozinha/sprint03-preparacao.test.js', 'infra.unidadeId');
inject('tests/cozinha/sprint03-correcoes-auditoria.test.js', 'infra.unidadeId');
inject('tests/cozinha/sprint05-operacoes-itens.test.js', 'infra.unidadeId');
