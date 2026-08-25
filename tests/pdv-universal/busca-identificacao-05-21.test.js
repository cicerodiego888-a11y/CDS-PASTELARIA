/**
 * Sprint 05.21 — busca operacional, PLU, código e adição inteligente (PDV Universal).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const Ident = require('../../frontend/pdv-universal/pdv-universal-identificacao.js');
const tela = require('../../frontend/pdv-universal/pdv-universal.js');
const cart = require('../../frontend/pdv-universal/pdv-universal-cart.js');
const checkout = require('../../frontend/pdv-universal/pdv-universal-checkout.js');

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function test01BuscaTextualPreservada() {
  assert.ok(tela.urlBuscaProduto('pastel').includes('/produtos/consulta-pdv/buscar?q=pastel'));
  assert.ok(src('frontend/pdv-universal/pdv-universal.js').includes('executarBuscaTextual'));
  assert.ok(src('frontend/pdv-universal/pdv-universal.js').includes('buscarProdutos'));
}

async function test02BarrasIdentificaQuandoSuportado() {
  const resolucao = await Ident.identificarEntradaPdv('7891000100103', {}, {
    identificar: async () => ({
      encontrado: true,
      habilitado: true,
      produtoId: 44,
      produto: { id: 44, nome: 'Leite', preco_venda: 5, codigo_barras: '7891000100103' },
      strategy: 'EAN13',
      metodo: 'EAN13'
    }),
    consultar: async () => []
  });
  assert.strictEqual(resolucao.tipo, Ident.TIPOS.UNICO);
  assert.strictEqual(resolucao.produtos[0].id, 44);
  assert.strictEqual(resolucao.metodo, 'EAN13');
  assert.strictEqual(resolucao.quantidade, 1);
}

async function test03CodigoInterno() {
  const resolucao = await Ident.identificarEntradaPdv('67', {}, {
    identificar: async () => ({
      encontrado: true,
      habilitado: true,
      produtoId: 67,
      produto: { id: 67, nome: 'Interno', preco_venda: 2, codigo: '67' },
      strategy: 'INTERNO'
    }),
    consultar: async () => [{ id: 1, nome: 'outro' }]
  });
  assert.strictEqual(resolucao.tipo, Ident.TIPOS.UNICO);
  assert.strictEqual(resolucao.metodo, 'INTERNO');
  assert.strictEqual(resolucao.produtos[0].codigo, '67');
}

async function test04PluConformeContrato() {
  const resolucao = await Ident.identificarEntradaPdv('1234', {}, {
    identificar: async () => ({
      encontrado: true,
      habilitado: true,
      produtoId: 9,
      produto: { id: 9, nome: 'Banana', preco_venda: 8, plu: '1234' },
      strategy: 'PLU',
      meta: { plu: '1234' }
    }),
    consultar: async () => []
  });
  assert.strictEqual(resolucao.tipo, Ident.TIPOS.UNICO);
  assert.strictEqual(resolucao.metodo, 'PLU');
  assert.ok(Ident.urlIdentificar().endsWith('/produtos/identificar'));
  assert.ok(tela.urlIdentificarProduto().endsWith('/produtos/identificar'));
}

async function test05EnterAdicionaUnicoAoCarrinho() {
  const c = cart.criarCarrinho();
  const resolucao = await Ident.identificarEntradaPdv('ABC', {}, {
    identificar: async () => ({
      encontrado: true,
      produtoId: 3,
      produto: { id: 3, nome: 'X', preco_venda: 10 },
      strategy: 'INTERNO'
    }),
    consultar: async () => []
  });
  assert.strictEqual(resolucao.tipo, Ident.TIPOS.UNICO);
  c.adicionarItem({
    produto_id: resolucao.produtos[0].id,
    descricao: resolucao.produtos[0].nome,
    quantidade: resolucao.quantidade,
    valor_unitario: resolucao.produtos[0].preco_venda,
    empresa_id: 4
  }, 99);
  assert.strictEqual(c.obterItens().length, 1);
  assert.strictEqual(c.calcularTotal(), 10);
}

async function test06MultiplosNaoAdicionaErrado() {
  const resolucao = await Ident.identificarEntradaPdv('pa', {}, {
    identificar: async () => ({ encontrado: false, habilitado: true }),
    consultar: async () => [
      { id: 1, nome: 'Pastel' },
      { id: 2, nome: 'Pão' }
    ]
  });
  assert.strictEqual(resolucao.tipo, Ident.TIPOS.MULTIPLOS);
  assert.strictEqual(resolucao.produtos.length, 2);
}

async function test07InexistenteNaoQuebra() {
  const resolucao = await Ident.identificarEntradaPdv('ZZZ999', {}, {
    identificar: async () => ({ encontrado: false, habilitado: true }),
    consultar: async () => []
  });
  assert.strictEqual(resolucao.tipo, Ident.TIPOS.NAO_ENCONTRADO);
  assert.ok(resolucao.mensagem);
}

function test08FocoRetornaAposAdicao() {
  const js = src('frontend/pdv-universal/pdv-universal.js');
  assert.ok(js.includes('limparBuscaEFocar'));
  assert.ok(js.includes('focarBuscaSeApropriado'));
  assert.ok(js.includes("ev.key === 'F1'"));
}

function test09EmpresaUnicaFuncional() {
  const caps = tela.aplicarCapabilities({
    modo_operacao: 'EMPRESA_UNICA',
    empresa_selecionada: { id: 4, nome: 'A' },
    capacidades: { checkout_empresa_unica: true, empresa_por_item: false }
  });
  assert.strictEqual(caps.empresa_por_item, false);
  const idf = cart.identificarEmpresaOperacional({
    empresa_por_item: false,
    empresa_contexto_id: 4,
    empresas_disponiveis: [{ empresa_id: 4, nome: 'A', disponibilidade: { total: 5 } }]
  });
  assert.strictEqual(idf.empresa_id, 4);
  assert.strictEqual(idf.exige_escolha, false);
}

function test10MultiempresaDisponibilidade() {
  const idf = cart.identificarEmpresaOperacional({
    empresa_por_item: true,
    empresa_contexto_id: null,
    empresas_disponiveis: [
      { empresa_id: 2, nome: 'A', disponibilidade: { total: 1 } },
      { empresa_id: 3, nome: 'B', disponibilidade: { total: 2 } }
    ]
  });
  assert.strictEqual(idf.exige_escolha, true);
  assert.ok(Array.isArray(idf.candidatos));
  assert.ok(!src('frontend/pdv-universal/pdv-universal-identificacao.js').includes('empresa_id = 1'));
  assert.ok(!src('frontend/pdv-universal/pdv-universal-identificacao.js').includes('empresa_id: 1'));
}

function test11SemPostApiVendas() {
  const front = [
    'frontend/pdv-universal/pdv-universal.js',
    'frontend/pdv-universal/pdv-universal-identificacao.js',
    'frontend/pdv-universal/pdv-universal-checkout.js',
    'frontend/pdv-universal/index.html'
  ].map(src).join('\n');
  assert.ok(!/\/api\/vendas\b/.test(front));
}

function test12PdvJsNaoCarregado() {
  const h = src('frontend/pdv-universal/index.html');
  assert.ok(!h.includes('/pdv/js/pdv.js'));
  assert.ok(h.includes('pdv-universal-identificacao.js'));
  assert.ok(src('frontend/pdv/js/pdv.js').includes("url: `${API_URL}/vendas`"));
}

function test13CheckoutIntact() {
  assert.ok(checkout.urlCheckout().endsWith('/pdv-universal/checkout'));
  assert.ok(!src('frontend/pdv-universal/pdv-universal-checkout.js').includes('${baseApi()}/vendas'));
  assert.ok(src('frontend/pdv-universal/pdv-universal.js').includes('PdvUniversalCheckout'));
}

function test14PdvLegadoSemRegressao() {
  const server = src('backend/server.js');
  assert.ok(server.includes("app.get(['/pdv', '/pdv/'], verificarToken"));
  assert.ok(server.includes("app.get(['/pdv-universal', '/pdv-universal/'], verificarToken"));
  assert.ok(src('frontend/pdv/js/pdv.js').includes('/produtos/identificar'));
}

async function test15MipOffCaiNaConsulta() {
  const resolucao = await Ident.identificarEntradaPdv('bolo', {}, {
    identificar: async () => ({ encontrado: false, habilitado: false }),
    consultar: async () => [{ id: 8, nome: 'Bolo' }]
  });
  assert.strictEqual(resolucao.tipo, Ident.TIPOS.UNICO);
  assert.strictEqual(resolucao.metodo, 'CONSULTA_PDV');
}

async function test16ConsultaExataEntreMultiplos() {
  const resolucao = await Ident.identificarEntradaPdv('55', {}, {
    identificar: async () => ({ encontrado: false, habilitado: true }),
    consultar: async () => [
      { id: 1, nome: 'A', codigo: '550' },
      { id: 2, nome: 'B', codigo: '55' }
    ]
  });
  assert.strictEqual(resolucao.tipo, Ident.TIPOS.UNICO);
  assert.strictEqual(resolucao.produtos[0].id, 2);
  assert.strictEqual(resolucao.metodo, 'CONSULTA_EXATA');
}

function test17PesoMipComumPermaneceQty1() {
  assert.strictEqual(Ident.quantidadeOperacionalPadrao({ meta: { peso: 0.453 } }), 1);
  assert.ok(Ident.urlInterpretarEtiqueta().endsWith('/equipamentos/etiquetas/interpretar'));
}

function test18PipelineOficialNoJs() {
  const js = src('frontend/pdv-universal/pdv-universal.js');
  assert.ok(js.includes('executarIdentificacaoOperacional'));
  assert.ok(js.includes('IdentLib'));
  assert.ok(js.includes('identificarEntradaPdv'));
  assert.ok(!js.includes('interpretarEtiquetaViaMotorEquipamentos'));
}

async function run() {
  const testes = [
    test01BuscaTextualPreservada,
    test02BarrasIdentificaQuandoSuportado,
    test03CodigoInterno,
    test04PluConformeContrato,
    test05EnterAdicionaUnicoAoCarrinho,
    test06MultiplosNaoAdicionaErrado,
    test07InexistenteNaoQuebra,
    test08FocoRetornaAposAdicao,
    test09EmpresaUnicaFuncional,
    test10MultiempresaDisponibilidade,
    test11SemPostApiVendas,
    test12PdvJsNaoCarregado,
    test13CheckoutIntact,
    test14PdvLegadoSemRegressao,
    test15MipOffCaiNaConsulta,
    test16ConsultaExataEntreMultiplos,
    test17PesoMipComumPermaneceQty1,
    test18PipelineOficialNoJs
  ];
  for (const t of testes) {
    await t();
    console.log('ok', t.name);
  }
  console.log(`${testes.length}/${testes.length}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
