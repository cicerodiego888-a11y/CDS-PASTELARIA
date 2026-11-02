'use strict';

/**
 * Adaptador de teste: executa as funções REAIS de formação de preço do carrinho do PDV
 * (frontend/pdv/js/pdv.js) dentro de um contexto `vm`, sem DOM e sem rede.
 *
 * O código das funções é extraído textualmente do arquivo do PDV (nada é reimplementado).
 * Apenas dependências de UI/rede são substituídas por stubs:
 *  - $.ajax síncrono de /produtos/:id/atacado devolve as faixas do fixture (mesma ordem da rota:
 *    quantidade_minima ASC);
 *  - showNotification, atualizarCarrinho, destacarLinhaCarrinho etc. apenas registram/ignoram;
 *  - pdvNotificarEstoqueInsuficiente sempre autoriza (saldo físico não é objeto de paridade de preço);
 *  - MotorPrecoAtacado é o mesmo arquivo UMD que o browser carrega via <script>.
 * Não importa banco, não faz HTTP.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PDV_JS = path.join(__dirname, '../../../frontend/pdv/js/pdv.js');
const PRODUTOS_ROTA = path.join(__dirname, '../../../backend/rotas/produtos.js');
const MotorPrecoAtacado = require('../../../frontend/shared/js/motor-preco-atacado.js');

const FUNCOES_REAIS = [
  'motorPrecoAtacadoDisponivel',
  'obterPrecoBaseItemPdv',
  'aplicarCalculoMotorItemPdv',
  'normalizarTipoVendaItem',
  'tipoVendaEhUnidade',
  'itemVendaPorUnidade',
  'obterQuantidadeEstoqueParaVenda',
  'unidadeEhKg',
  'produtoUsaConversaoUnidadesPdv',
  'quantidadeUsaDecimaisPdv',
  'normalizarQuantidadePdv',
  'normalizarQuantidadeEtiquetaPdv',
  'parseQuantidadePdv',
  'precoUnitarioExibicaoItemPdv',
  'calcularSubtotal',
  'obterPrecoAtacado',
  'itemTemPrecoManualPdv',
  'resolverPrecoComercialItemPdv',
  'restaurarPrecoComercialItemPdv',
  'adicionarItemNoCarrinho',
  'atualizarQuantidade',
  'atualizarPercentual',
  'atualizarDescontoValor',
  'atualizarPrecoUnitario'
];

function lerPdv() {
  return fs.readFileSync(PDV_JS, 'utf8');
}

function extrairFuncao(src, nome) {
  const inicio = src.search(new RegExp(`^function ${nome}\\(`, 'm'));
  if (inicio < 0) throw new Error(`função ${nome} não encontrada em pdv.js`);
  const resto = src.slice(inicio);
  const fim = resto.search(/^\}\r?$/m);
  if (fim < 0) throw new Error(`fim da função ${nome} não encontrado`);
  return resto.slice(0, fim + 1);
}

/** SQL real do endpoint GET /produtos/:id/promocao-ativa. */
function extrairSqlPromocaoAtiva() {
  const src = fs.readFileSync(PRODUTOS_ROTA, 'utf8');
  const ini = src.indexOf("router.get('/:id/promocao-ativa'");
  if (ini < 0) throw new Error('rota promocao-ativa não encontrada');
  const a = src.indexOf('`', ini);
  const b = src.indexOf('`', a + 1);
  return src.slice(a + 1, b);
}

/**
 * @param {{produtos:Array<object>, faixasPorProduto?:Object<number,Array<object>>}} cfg
 */
function criarPdvReal(cfg) {
  const src = lerPdv();
  const codigo = FUNCOES_REAIS.map((n) => extrairFuncao(src, n)).join('\n\n');
  const notificacoes = [];
  const sandbox = {
    console,
    window: {},
    MotorPrecoAtacado,
    API_URL: '',
    localStorage: { getItem: () => '' },
    notificacoes,
    faixasPorProduto: cfg.faixasPorProduto || {},
    produtosDisponiveis: cfg.produtos,
    $: {
      ajax(opts) {
        const m = /\/produtos\/(\d+)\/atacado/.exec(opts.url);
        const faixas = (sandbox.faixasPorProduto[Number(m[1])] || [])
          .slice()
          .sort((x, y) => Number(x.quantidade_minima) - Number(y.quantidade_minima));
        opts.success(faixas);
      }
    }
  };
  const prelude = `
    const TIPO_VENDA_PESO = 'PESO';
    const TIPO_VENDA_UNIDADE = 'UNIDADE';
    var carrinho = [];
    var pdvPedidoHandoff = null;
    var pdvCarregandoHandoff = false;
    function showNotification(msg, tipo) { notificacoes.push({ msg, tipo }); }
    function pdvNotificarEstoqueInsuficiente() { return true; }
    function atualizarCarrinho() {}
    function destacarLinhaCarrinho() {}
    function animarTotalLinhaCarrinho() {}
    function focarCampoCodigo() {}
    function removerItemCarrinho(i) { carrinho.splice(i, 1); }
  `;
  const exporta = `({ ${FUNCOES_REAIS.join(', ')}, limparCarrinho() { carrinho.length = 0; }, get carrinho() { return carrinho; } })`;
  vm.createContext(sandbox);
  const api = vm.runInContext(`${prelude}\n${codigo}\n${exporta}`, sandbox);
  return { api, notificacoes, sandbox };
}

module.exports = {
  criarPdvReal,
  extrairFuncao,
  extrairSqlPromocaoAtiva,
  lerPdv,
  FUNCOES_REAIS
};
