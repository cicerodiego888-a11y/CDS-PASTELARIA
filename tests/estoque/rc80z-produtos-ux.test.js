'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const produtosJs = fs.readFileSync(
  path.join(__dirname, '../../frontend/erp/js/produtos.js'),
  'utf8'
);

test('RC8.0.Z: placeholder de busca atualizado', () => {
  assert.match(
    produtosJs,
    /Buscar por nome, PLU, código ou código de barras\.\.\./
  );
  assert.doesNotMatch(produtosJs, /placeholder="Buscar produto\.\.\."/);
});

test('RC8.0.Z: confirmação ao desativar controle de estoque', () => {
  assert.match(produtosJs, /Desativar Controle de Estoque/);
  assert.match(produtosJs, /Este produto não terá movimentação de estoque/);
  assert.match(produtosJs, /inicializarConfirmacaoControlaEstoque/);
});

test('RC8.0.Z: listagem exibe PLU no nome', () => {
  assert.match(produtosJs, /formatarNomeProdutoComPlu/);
  assert.match(produtosJs, /produtoCorrespondeBuscaInteligente/);
});

test('RC8.0.Z: busca inteligente cobre PLU e código de barras', () => {
  assert.match(produtosJs, /produto\.plu/);
  assert.match(produtosJs, /produto\.codigo_barras/);
  assert.match(produtosJs, /termoDigits/);
});
