'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const tela = require('../../frontend/pdv-universal/pdv-universal.js');
const cart = require('../../frontend/pdv-universal/pdv-universal-cart.js');
const checkout = require('../../frontend/pdv-universal/pdv-universal-checkout.js');
const pag = require('../../frontend/pdv-universal/pdv-universal-pagamento.js');
const pos = require('../../frontend/pdv-universal/pdv-universal-pos-pagamento.js');
const S = require('../../frontend/pdv-universal/pdv-universal-session.js');
const { capacidadesParaModo } = require('../../backend/motores/pdv-universal/contratos');

const ROOT = path.join(__dirname, '../..');
function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function test01PdvLegado() {
  assert.ok(src('backend/server.js').includes("frontendRoot, 'pdv/index.html'"));
}

function test02UniversalEntrega() {
  assert.ok(src('backend/server.js').includes("frontendRoot, 'pdv-universal/index.html'"));
  assert.ok(src('frontend/pdv-universal/index.html').includes('id="pdvu-root"'));
}

function test03Menu() {
  assert.ok(src('frontend/erp/index.html').includes('href="/pdv-universal/"'));
}

function test04Root() {
  assert.ok(src('frontend/pdv-universal/index.html').includes('id="pdvu-root"'));
}

function test05Scripts() {
  const html = src('frontend/pdv-universal/index.html');
  [
    'pdv-universal-cart.js',
    'pdv-universal-checkout.js',
    'pdv-universal-pagamento.js',
    'pdv-universal-pos-pagamento.js',
    'pdv-universal-session.js',
    'pdv-universal.js'
  ].forEach((f) => assert.ok(html.includes(f), f));
}

function test06Css() {
  assert.ok(src('frontend/pdv-universal/index.html').includes('/pdv-universal/pdv-universal.css'));
}

function test07Contexto() {
  assert.ok(tela.urlContexto().endsWith('/pdv-universal/contexto'));
}

function test08Loading() {
  assert.ok(src('frontend/pdv-universal/index.html').includes('id="pdvu-loading"'));
}

function test09Erro() {
  assert.ok(src('frontend/pdv-universal/index.html').includes('id="pdvu-error"'));
}

function test10Retry() {
  assert.ok(src('frontend/pdv-universal/index.html').includes('id="pdvu-retry"'));
}

function test11NaoEmpresa1() {
  assert.ok(tela.nuncaAssumirEmpresaUm({ empresa_selecionada: null }));
}

function test12MultiSemEmpresa() {
  const m = tela.montarModeloVisual({ modo_operacao: 'MULTIEMPRESA', empresa_selecionada: null, capacidades: {} });
  assert.strictEqual(m.modo_rotulo, 'MULTIEMPRESA');
}

function test13Busca() {
  assert.ok(tela.urlBuscaProduto('x').includes('consulta-pdv/buscar'));
  assert.ok(src('frontend/pdv-universal/index.html').includes('id="pdvu-busca-input"'));
}

function test14Disponibilidade() {
  assert.ok(tela.urlDisponibilidade(9).includes('/pdv-universal/produtos/9/disponibilidade'));
}

function test15Identidade() {
  const c = cart.criarCarrinho();
  c.adicionarItem({ produto_id: 1, empresa_id: 2, quantidade: 1, valor_unitario: 1, descricao: 'A' }, 10);
  const i = c.obterItens()[0];
  assert.strictEqual(i.produto_id, 1);
  assert.strictEqual(i.empresa_id, 2);
}

function test16NaoFunde() {
  const c = cart.criarCarrinho();
  c.adicionarItem({ produto_id: 1, empresa_id: 2, quantidade: 1, valor_unitario: 1, descricao: 'A' }, 10);
  c.adicionarItem({ produto_id: 1, empresa_id: 3, quantidade: 1, valor_unitario: 1, descricao: 'A' }, 10);
  assert.strictEqual(c.obterItens().length, 2);
}

function test17SelecaoMulti() {
  const r = cart.identificarEmpresaOperacional({
    empresa_por_item: true,
    empresas_disponiveis: [
      { empresa_id: 2, nome: 'A', disponibilidade: { total: 1 } },
      { empresa_id: 3, nome: 'B', disponibilidade: { total: 2 } }
    ]
  });
  assert.strictEqual(r.exige_escolha, true);
  assert.ok(src('frontend/pdv-universal/index.html').includes('ESTE PRODUTO POSSUI ESTOQUE EM'));
}

function test18Finalizar() {
  assert.ok(src('frontend/pdv-universal/index.html').includes('id="pdvu-finalizar"'));
}

function test19UnicaIsolada() {
  assert.ok(!checkout.podeFinalizar({
    capacidades: capacidadesParaModo('EMPRESA_UNICA')
  }, [{ produto_id: 1, empresa_id: 2 }]));
}

function test20MultiCheckout() {
  assert.ok(src('frontend/pdv-universal/pdv-universal-checkout.js').includes('/pdv-universal/checkout'));
  assert.ok(!src('frontend/pdv-universal/pdv-universal-checkout.js').includes('${baseApi()}/vendas'));
}

function test21PagamentoUi() {
  assert.ok(src('frontend/pdv-universal/index.html').includes('id="pdvu-modal-pagamento"'));
  assert.ok(pag.urlPagamento(8).includes('/atendimentos/8/pagamento'));
}

function test22CancelMuv() {
  assert.ok(src('frontend/pdv-universal/pdv-universal.js').includes('cancelarAtendimento'));
}

function test23Materializar() {
  assert.ok(pos.urlMaterializar(1).includes('materializar'));
  assert.ok(src('frontend/pdv-universal/index.html').includes('pdvu-materializar-main'));
}

function test24Fiscalizar() {
  assert.ok(pos.urlFiscalizar(1).includes('fiscalizar'));
}

function test25ComprovanteAtd() {
  assert.ok(pos.urlComprovante(44).includes('/atendimentos/44/comprovante'));
}

function test26NovoNaoApagaPersistido() {
  const js = src('frontend/pdv-universal/pdv-universal-session.js');
  assert.ok(js.includes('empresa_operacional_persistida'));
  assert.ok(!js.includes("removeItem('cds_empresa_id')"));
}

function test27Locks() {
  const s = S.criarSessao();
  assert.ok(S.adquirir(s, S.ACOES.CHECKOUT));
  assert.ok(!S.adquirir(s, S.ACOES.CHECKOUT));
}

function test28LegadoIntacto() {
  assert.ok(src('frontend/pdv/js/pdv.js').includes("url: `${API_URL}/vendas`"));
  assert.ok(!src('frontend/pdv-universal/index.html').includes('/pdv/js/pdv.js'));
}

function test29SemCoreJs() {
  assert.ok(!src('frontend/pdv-universal/index.html').includes('/shared/js/core.js'));
}

async function run() {
  const testes = [
    test01PdvLegado, test02UniversalEntrega, test03Menu, test04Root, test05Scripts,
    test06Css, test07Contexto, test08Loading, test09Erro, test10Retry, test11NaoEmpresa1,
    test12MultiSemEmpresa, test13Busca, test14Disponibilidade, test15Identidade, test16NaoFunde,
    test17SelecaoMulti, test18Finalizar, test19UnicaIsolada, test20MultiCheckout, test21PagamentoUi,
    test22CancelMuv, test23Materializar, test24Fiscalizar, test25ComprovanteAtd,
    test26NovoNaoApagaPersistido, test27Locks, test28LegadoIntacto, test29SemCoreJs
  ];
  for (const t of testes) {
    await t();
    console.log('ok', t.name);
  }
  console.log(`05.13 ${testes.length}/${testes.length}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
