'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '../..');
const revisao = fs.readFileSync(
  path.join(root, 'frontend/erp/js/miip-central-revisao.js'),
  'utf8'
);
const produtos = fs.readFileSync(
  path.join(root, 'frontend/erp/js/produtos.js'),
  'utf8'
);

assert.match(revisao, /data-miip-tipo-cadastro="COMERCIAL">Produto comercial/);
assert.match(revisao, /data-miip-tipo-cadastro="INSUMO">Insumo/);
assert.match(revisao, /data-bs-dismiss="modal">Cancelar/);
assert.match(revisao, /if \(tipoSelecionado\) onSelecionar\(tipoSelecionado\);/);
assert.match(revisao, /abrirCadastroProdutoPadrao\(item, aoCadastrar, tipoCadastro\)/);
assert.match(
  revisao,
  /String\(tipoCadastro \|\| item\?\.tipo_operacional \|\| ''\)\.trim\(\)\.toUpperCase\(\)/
);
assert.match(
  revisao,
  /showProdutoModal\(null, \{[\s\S]*?tipo_operacional: tipoOperacional/
);
assert.match(produtos, /tipoOperacionalSolicitado[\s\S]*?\['COMERCIAL', 'INSUMO'\]/);
assert.match(produtos, /const tipoOperacionalForcado = !isEdit && tipoOperacionalSolicitado/);

console.log('CE-CAD-01: escolha, cancelamento e encaminhamento explícito validados.');
