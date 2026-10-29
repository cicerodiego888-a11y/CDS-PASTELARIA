'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(
  path.join(__dirname, '../../frontend/erp/js/compras.js'),
  'utf8'
);

function extractFunction(name) {
  const match = source.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
  assert.ok(match, `Função ${name} não encontrada.`);
  return match[0];
}

const produtosCompraList = [
  { id: 10, nome: 'CEBOLA PERA KG', tipo_operacional: 'INSUMO' },
  { id: 11, nome: 'ERVILHA FUGINI', tipo_operacional: 'COMERCIAL' },
  { id: 12, nome: 'ÓLEO DE SOJA', tipo_operacional: 'INSUMO' },
  { id: 13, nome: 'OVO', tipo_operacional: 'COMERCIAL' },
  { id: 14, nome: 'Cadastro sem tipo', tipo_operacional: '' },
  { id: 15, nome: 'Tipo inválido', tipo_operacional: 'SERVICO' }
];

let htmlRenderizado = '';
const context = {
  produtosCompraList,
  itensCompraAtual: [],
  indiceProximoDestaqueCompra: null,
  isOrigemCompraCentralNfe: () => true,
  clonarDadosItemCompra: (item) => JSON.parse(JSON.stringify(item)),
  clonarNestedMiipItemCompra: (item) => item == null ? null : JSON.parse(JSON.stringify(item)),
  extrairProdutoIdSugestaoMiip(sugestao, item) {
    const id = Number(sugestao?.produtoId ?? sugestao?.produto_id ?? item?.miip_resultado?.produtoEncontrado?.id);
    return Number.isFinite(id) && id > 0 ? id : null;
  },
  obterQuantidadeComercialItemCompra: (item) => Number(item.quantidade_comercial ?? item.quantidade ?? 0),
  obterQuantidadeConvertidaItemCompra: (item) => Number(item.quantidade_convertida ?? item.quantidade ?? 0),
  itemCompraEhFracionado: () => false,
  resolverCustoUnitarioItemCompra: (item) => Number(item.preco_unitario || 0),
  deveReaplicarMargemCadastroItemCompra: () => false,
  itemCompraTemMargemGravada: () => false,
  extrairMargemCadastradaProduto: () => ({ margem: 0, fallback: false }),
  gerarLinhaIdCompra: () => 'ce-compra-class-linha',
  persistirPrecoUnitarioComercialItemCompra: () => 0,
  enriquecerItemFiscalCompraUi: (item) => item,
  sincronizarQuantidadesEstoqueItemCompra: (item) => item,
  sincronizarPrecosCadastroItemCompra: (item) => item,
  formatarQuantidadeItemCompra: () => '1',
  renderResumoConversaoItemCompraHtml: () => '',
  renderMiipSugestaoCard: () => '',
  renderCfopColunaItemCompra: () => '',
  formatarPrecoCompraItem: () => 'R$ 1,00',
  formatNumberInput: () => '0',
  formatCurrency: () => 'R$ 1,00',
  recalcularTotaisCompraNota: () => {},
  $: (selector) => {
    assert.strictEqual(selector, '#itensCompraBody');
    return {
      html(value) {
        htmlRenderizado = value;
      }
    };
  }
};
vm.createContext(context);
vm.runInContext([
  extractFunction('tipoOperacionalCadastroCompra'),
  extractFunction('resolverClassificacaoMiipCadastro'),
  extractFunction('prepararItemQuantidadesImportacaoCentral'),
  extractFunction('calcularSubtotalFinanceiroItemCompra'),
  extractFunction('normalizeItemCompra'),
  extractFunction('escapeHtml'),
  extractFunction('renderAssociacaoProdutoItemCompra'),
  extractFunction('renderItensCompraTabelaCore')
].join('\n'), context);

const itensConfirmadosNaRevisaoMiip = [
  { produto_id: 10, produto_nome: 'CEBOLA PERA KG' },
  { produto_id: 11, produto_nome: 'ERVILHA FUGINI' },
  { produto_id: 12, produto_nome: 'ÓLEO DE SOJA' },
  { produto_id: 13, produto_nome: 'OVO' }
].map((item) => ({
  ...item,
  miip_revisao_status: 'confirmado',
  miip_revisao_origem: 'Confirmacao Manual',
  quantidade: 1,
  preco_unitario: 1
}));

context.itensCompraAtual = itensConfirmadosNaRevisaoMiip.map((item) => context.normalizeItemCompra(item));
const normalizados = context.itensCompraAtual.map((item) => ({
  produto_id: item.produto_id,
  tipo_operacional: item.tipo_operacional,
  classificacao_operacional_confirmada: item.classificacao_operacional_confirmada,
  classificacao_operacional_status: item.classificacao_operacional_status
}));

assert.deepStrictEqual(normalizados, [
  { produto_id: 10, tipo_operacional: 'INSUMO', classificacao_operacional_confirmada: true, classificacao_operacional_status: 'miip_classificado' },
  { produto_id: 11, tipo_operacional: 'COMERCIAL', classificacao_operacional_confirmada: true, classificacao_operacional_status: 'miip_classificado' },
  { produto_id: 12, tipo_operacional: 'INSUMO', classificacao_operacional_confirmada: true, classificacao_operacional_status: 'miip_classificado' },
  { produto_id: 13, tipo_operacional: 'COMERCIAL', classificacao_operacional_confirmada: true, classificacao_operacional_status: 'miip_classificado' }
]);

context.renderItensCompraTabelaCore();
for (const label of ['Insumo', 'Produto Comercial']) {
  assert.ok(htmlRenderizado.includes(`${label} — classificação do cadastro vinculado`), `${label} deve aparecer na linha renderizada`);
}
assert.ok(!htmlRenderizado.includes('Selecione o tipo'), 'linhas com classificação confirmada não devem renderizar o seletor');
assert.ok(!htmlRenderizado.includes('Cadastro vinculado ao item'), 'vínculos confirmados não devem renderizar lista suspensa de produtos');
assert.ok(htmlRenderizado.includes('Produto vinculado: <strong>CEBOLA PERA KG</strong>'));
assert.ok(htmlRenderizado.includes('Produto vinculado: <strong>ERVILHA FUGINI</strong>'));
assert.ok(htmlRenderizado.includes('CEBOLA PERA KG'));
assert.ok(htmlRenderizado.includes('ERVILHA FUGINI'));
assert.ok(htmlRenderizado.includes('ÓLEO DE SOJA'));
assert.ok(htmlRenderizado.includes('OVO'));
assert.deepStrictEqual(
  context.itensCompraAtual.map((item) => item.produto_id),
  [10, 11, 12, 13],
  'renderização não deve alterar o ID vinculado'
);

context.itensCompraAtual = context.itensCompraAtual.map((item) => context.normalizeItemCompra(item));
context.renderItensCompraTabelaCore();
assert.ok(!htmlRenderizado.includes('Cadastro vinculado ao item'), 're-renderização deve manter o vínculo somente informativo');
assert.deepStrictEqual(
  context.itensCompraAtual.map((item) => item.produto_id),
  [10, 11, 12, 13],
  'normalização repetida e renderização devem preservar o ID original'
);

const associacaoAutomaticaValida = context.normalizeItemCompra({
  produto_id: 12,
  produto_nome: 'ÓLEO DE SOJA',
  miip_resultado: {
    associadoAutomaticamente: true,
    produtoEncontrado: { id: 12 }
  },
  quantidade: 1,
  preco_unitario: 1
});
context.itensCompraAtual = [associacaoAutomaticaValida];
context.renderItensCompraTabelaCore();
assert.ok(htmlRenderizado.includes('Produto vinculado: <strong>ÓLEO DE SOJA</strong>'));
assert.ok(!htmlRenderizado.includes('Cadastro vinculado ao item'), 'associação automática válida também não deve exibir seletor');
assert.strictEqual(context.itensCompraAtual[0].produto_id, 12);

const semVinculo = context.normalizeItemCompra({
  produto_id: '',
  produto_nome: 'Item sem vínculo',
  quantidade: 1,
  preco_unitario: 1
});
assert.strictEqual(semVinculo.tipo_operacional, '');
assert.strictEqual(semVinculo.classificacao_operacional_status, '');
const semClassificacao = context.normalizeItemCompra({
  produto_id: 14,
  produto_nome: 'Cadastro sem tipo',
  miip_revisao_status: 'confirmado',
  quantidade: 1,
  preco_unitario: 1
});
const tipoInvalido = context.normalizeItemCompra({
  produto_id: 15,
  produto_nome: 'Tipo inválido',
  miip_revisao_status: 'confirmado',
  quantidade: 1,
  preco_unitario: 1
});
assert.strictEqual(semClassificacao.classificacao_operacional_status, 'miip_sem_classificacao');
assert.strictEqual(tipoInvalido.classificacao_operacional_status, 'miip_sem_classificacao');

const vinculoDivergente = context.normalizeItemCompra({
  produto_id: 10,
  produto_nome: 'CEBOLA PERA KG',
  miip_revisao_status: 'confirmado',
  miip_resultado: {
    associadoAutomaticamente: true,
    produtoEncontrado: { id: 11 }
  },
  quantidade: 1,
  preco_unitario: 1
});
assert.strictEqual(vinculoDivergente.produto_id, 10);
assert.strictEqual(vinculoDivergente.classificacao_operacional_status, 'miip_vinculo_divergente');
const vinculoAusenteDoCatalogo = context.normalizeItemCompra({
  produto_id: 98,
  produto_nome: 'Cadastro indisponível',
  miip_revisao_status: 'confirmado',
  quantidade: 1,
  preco_unitario: 1
});
assert.strictEqual(vinculoAusenteDoCatalogo.produto_id, 98);
assert.strictEqual(vinculoAusenteDoCatalogo.classificacao_operacional_status, 'miip_cadastro_nao_encontrado');

context.itensCompraAtual = [semVinculo, semClassificacao, tipoInvalido, vinculoDivergente, vinculoAusenteDoCatalogo];
context.renderItensCompraTabelaCore();
assert.strictEqual((htmlRenderizado.match(/Cadastro vinculado ao item/g) || []).length, 5);
assert.strictEqual((htmlRenderizado.match(/Selecione o tipo/g) || []).length, 5);
assert.ok(htmlRenderizado.includes('O cadastro vinculado não possui classificação operacional válida.'));
assert.ok(htmlRenderizado.includes('O vínculo MIIP diverge do cadastro selecionado.'));
assert.ok(htmlRenderizado.includes('O cadastro vinculado pelo MIIP não foi encontrado no catálogo carregado.'));
assert.ok(htmlRenderizado.includes('Vínculo MIIP: cadastro #98'));
assert.ok(!htmlRenderizado.includes('Produto vinculado: <strong>ERVILHA FUGINI</strong>'));

assert.match(source, /tipo_operacional:\s*sincronizado\.tipo_operacional/);
assert.match(source, /classificacao_operacional_confirmada:\s*classificacaoMiip\s*\?/);
assert.match(source, /produto_id:\s*sincronizado\.produto_id\s*\|\|\s*null/);

console.log('CE-COMPRA-CLASS-03: vínculo somente informativo, preservação do ID e revisão de pendências validados.');
