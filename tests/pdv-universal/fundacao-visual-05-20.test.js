/**
 * Sprint 05.20 — Fundação visual do PDV único (Universal com UX operacional).
 * Não altera MUV/VAS/POST /api/vendas. Não remove /pdv.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const tela = require('../../frontend/pdv-universal/pdv-universal.js');
const cart = require('../../frontend/pdv-universal/pdv-universal-cart.js');
const checkout = require('../../frontend/pdv-universal/pdv-universal-checkout.js');

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const html = () => src('frontend/pdv-universal/index.html');
const css = () => src('frontend/pdv-universal/pdv-universal.css');
const js = () => src('frontend/pdv-universal/pdv-universal.js');

function test01UniversalCarregaScriptsOficiais() {
  const h = html();
  assert.ok(h.includes('/pdv-universal/pdv-universal.js'));
  assert.ok(h.includes('/pdv-universal/pdv-universal-checkout.js'));
  assert.ok(h.includes('/pdv-universal/pdv-universal-cart.js'));
  assert.ok(!h.includes('/pdv/js/pdv.js'));
  assert.ok(!h.includes('pdv-venda-entrega.js'));
}

function test02HeaderOperacional() {
  const h = html();
  assert.ok(h.includes('id="pdvu-btn-menu"'));
  assert.ok(h.includes('CDS SISTEMAS'));
  assert.ok(h.includes('PDV UNIVERSAL'));
  assert.ok(h.includes('id="pdvu-modo"'));
  assert.ok(h.includes('id="pdvu-empresa"'));
  assert.ok(h.includes('id="pdvu-operador"'));
  assert.ok(h.includes('id="pdvu-data-hora"'));
  assert.ok(h.includes('id="pdvu-status-caixa"'));
  assert.ok(h.includes('id="pdvu-btn-fechar-caixa"'));
  assert.ok(h.includes('disabled'));
}

function test03ContextoEmpresaUnicaEMultiempresa() {
  assert.strictEqual(tela.rotuloModo({ modo_operacao: 'EMPRESA_UNICA' }), 'EMPRESA ÚNICA');
  assert.strictEqual(tela.rotuloModo({ modo_operacao: 'MULTIEMPRESA' }), 'MULTIEMPRESA');
  const m = tela.montarModeloVisual({
    modo_operacao: 'EMPRESA_UNICA',
    empresa_selecionada: { id: 4, nome: 'Pastelaria' },
    capacidades: { checkout_empresa_unica: true }
  });
  assert.strictEqual(m.empresa_rotulo, 'Pastelaria');
  assert.strictEqual(m.modo_rotulo, 'EMPRESA ÚNICA');
}

function test04BuscaOficialPreservada() {
  assert.ok(tela.urlBuscaProduto('cafe').includes('/produtos/consulta-pdv/buscar?q=cafe'));
  assert.ok(html().includes('id="pdvu-busca-input"'));
  assert.ok(html().includes('id="pdvu-btn-buscar"'));
  assert.ok(html().includes('Código de barras / Código interno / PLU / Nome'));
  assert.ok(js().includes('executarBuscaTextual') || js().includes('executarIdentificacaoOperacional'));
  assert.ok(js().includes("ev.key === 'Enter'"));
}

function test05TabelaCarrinho() {
  const h = html();
  assert.ok(h.includes('class="pdvu-tabela"'));
  ['QTD', 'UN', 'PRODUTO', 'UNITÁRIO', 'DESC %', 'DESC R$', 'TOTAL'].forEach((col) => {
    assert.ok(h.includes(col), `faltou coluna ${col}`);
  });
  assert.ok(h.includes('Nenhum item no carrinho'));
  assert.ok(!h.includes('<h2>ATENDIMENTO</h2>'));
  assert.ok(js().includes('function pintarCarrinho'));
}

function test06TotalAtualizadoPeloCarrinho() {
  const c = cart.criarCarrinho();
  c.adicionarItem({
    produto_id: 10,
    descricao: 'Pastel',
    quantidade: 2,
    valor_unitario: 5.5,
    empresa_id: 4,
    empresa_nome: 'A'
  }, 99);
  const resumo = tela.montarResumoVisual(c);
  assert.strictEqual(resumo.itens, 2);
  assert.strictEqual(resumo.total, 'R$ 11,00');
  assert.strictEqual(resumo.subtotal, 'R$ 11,00');
  assert.strictEqual(resumo.desconto_atacado, '—');
  assert.strictEqual(resumo.desconto, 'R$ 0,00');
  assert.strictEqual(resumo.acrescimo, 'R$ 0,00');
}

function test07FinalizarUsaCheckoutOficial() {
  const j = js();
  assert.ok(j.includes('PdvUniversalCheckout'));
  assert.ok(j.includes('finalizarCheckout'));
  assert.ok(checkout.urlCheckout().endsWith('/pdv-universal/checkout'));
  assert.ok(!j.includes('/api/vendas'));
  assert.ok(!src('frontend/pdv-universal/pdv-universal-checkout.js').includes('${baseApi()}/vendas'));
}

function test08EscNaoDestroiPagamento() {
  assert.strictEqual(tela.resolverAcaoEscape({ processamento: true }), 'BLOQUEAR');
  assert.strictEqual(tela.resolverAcaoEscape({ modalAberto: true }), 'FECHAR_MODAL');
  assert.strictEqual(tela.resolverAcaoEscape({ drawerAberto: true }), 'FECHAR_DRAWER');
  assert.strictEqual(tela.resolverAcaoEscape({ pagamentoEmAndamento: true }), 'PRESERVAR');
  assert.strictEqual(tela.resolverAcaoEscape({ temAtendimento: true }), 'PRESERVAR');
  assert.strictEqual(tela.resolverAcaoEscape({}), 'CANCELAR_CARRINHO');
  assert.ok(html().includes('id="pdvu-cancelar"'));
  assert.ok(js().includes('cancelarAtendimentoOuCarrinho'));
}

function test09F1EFocinBusca() {
  assert.ok(js().includes("ev.key === 'F1'"));
  assert.ok(js().includes('pdvu-busca-input'));
  assert.ok(html().includes('F1 Buscar'));
}

function test10F10SomenteQuandoPermitido() {
  assert.strictEqual(tela.podeDispararF10({ disabled: true, permitido: true }), false);
  assert.strictEqual(tela.podeDispararF10({ processamento: true, permitido: true }), false);
  assert.strictEqual(tela.podeDispararF10({ disabled: false, permitido: false }), false);
  assert.strictEqual(tela.podeDispararF10({ disabled: false, permitido: true, processamento: false }), true);
  assert.ok(html().includes('(F10)'));
  assert.ok(js().includes("ev.key === 'F10'"));
}

function test11NenhumPostApiVendasNoUniversal() {
  const front = [
    'frontend/pdv-universal/pdv-universal.js',
    'frontend/pdv-universal/pdv-universal-checkout.js',
    'frontend/pdv-universal/pdv-universal-cart.js',
    'frontend/pdv-universal/pdv-universal-pagamento.js',
    'frontend/pdv-universal/pdv-universal-pos-pagamento.js',
    'frontend/pdv-universal/index.html'
  ].map(src).join('\n');
  assert.ok(!/\/api\/vendas\b/.test(front));
  assert.ok(!front.includes("url: `${API_URL}/vendas`"));
}

function test12PdvJsNaoCarregado() {
  const h = html();
  assert.ok(!h.includes('/pdv/js/pdv.js'));
  assert.ok(!h.includes('/pdv/js/caixa.js'));
  assert.ok(!h.includes('pdvBuscaProduto.js'));
  assert.ok(src('frontend/pdv/js/pdv.js').includes("url: `${API_URL}/vendas`"));
}

function test13RotasOficiaisIntactas() {
  const server = src('backend/server.js');
  assert.ok(server.includes("app.get(['/pdv', '/pdv/'], verificarToken"));
  assert.ok(server.includes("app.get(['/pdv-universal', '/pdv-universal/'], verificarToken"));
  assert.ok(server.includes("frontendRoot, 'pdv/index.html'"));
  assert.ok(server.includes("frontendRoot, 'pdv-universal/index.html'"));
}

function test14CaixaNaoFake() {
  assert.deepStrictEqual(tela.classificarStatusCaixa(undefined, false), {
    codigo: 'VERIFICANDO',
    rotulo: 'CAIXA: VERIFICANDO'
  });
  assert.deepStrictEqual(tela.classificarStatusCaixa(null, true), {
    codigo: 'INDISPONIVEL',
    rotulo: 'CAIXA: INDISPONÍVEL'
  });
  assert.deepStrictEqual(tela.classificarStatusCaixa(null, false), {
    codigo: 'FECHADO',
    rotulo: 'CAIXA: FECHADO'
  });
  assert.strictEqual(tela.classificarStatusCaixa({ status: 'aberto', id: 9 }, false).codigo, 'ABERTO');
  assert.ok(tela.urlStatusCaixa().endsWith('/caixa/aberto'));
  assert.ok(html().includes('CAIXA: VERIFICANDO'));
  assert.ok(html().includes('disabled'));
  assert.ok(!js().includes("rotulo: 'CAIXA: ABERTO'") || js().includes('classificarStatusCaixa'));
}

function test15SemLinkPermanenteLegadoNoLayout() {
  const h = html();
  assert.ok(!h.includes('href="/pdv"'));
  assert.ok(!h.includes('PDV legado'));
  assert.ok(h.includes('href="/erp"'));
  assert.ok(h.includes('id="pdvu-drawer"'));
}

function test16AtalhosReaisApenas() {
  const h = html();
  assert.ok(h.includes('F1 Buscar'));
  assert.ok(h.includes('F10 Finalizar'));
  assert.ok(h.includes('ESC Fechar / Cancelar'));
  assert.ok(!h.includes('F7'));
  assert.ok(!h.includes('F9 Entrega'));
  assert.ok(!h.includes('F8 Desconto'));
  assert.ok(!h.includes('F11'));
}

function test17GridECalculadoraERelogio() {
  assert.ok(css().includes('75%') || css().includes('minmax(0, 75%)'));
  assert.ok(html().includes('id="pdvu-calc"'));
  assert.ok(js().includes('aplicarTeclaCalc'));
  assert.ok(js().includes('formatarDataHoraPdv'));
  assert.ok(js().includes('setInterval(atualizarRelogio'));
  const calc = tela.aplicarTeclaCalc({ display: '2', acc: 3, op: '+' }, '=');
  assert.strictEqual(calc.display, '5');
}

function test18PainelResumo() {
  const h = html();
  assert.ok(h.includes('id="pdvu-subtotal"'));
  assert.ok(h.includes('id="pdvu-desconto"'));
  assert.ok(h.includes('id="pdvu-acrescimo"'));
  assert.ok(h.includes('id="pdvu-total"'));
  assert.ok(h.includes('FINALIZAR ATENDIMENTO'));
  assert.ok(h.includes('CANCELAR ATENDIMENTO'));
}

async function run() {
  const testes = [
    test01UniversalCarregaScriptsOficiais,
    test02HeaderOperacional,
    test03ContextoEmpresaUnicaEMultiempresa,
    test04BuscaOficialPreservada,
    test05TabelaCarrinho,
    test06TotalAtualizadoPeloCarrinho,
    test07FinalizarUsaCheckoutOficial,
    test08EscNaoDestroiPagamento,
    test09F1EFocinBusca,
    test10F10SomenteQuandoPermitido,
    test11NenhumPostApiVendasNoUniversal,
    test12PdvJsNaoCarregado,
    test13RotasOficiaisIntactas,
    test14CaixaNaoFake,
    test15SemLinkPermanenteLegadoNoLayout,
    test16AtalhosReaisApenas,
    test17GridECalculadoraERelogio,
    test18PainelResumo
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
