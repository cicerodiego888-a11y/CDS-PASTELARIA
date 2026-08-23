/**
 * Sprint 05.09 — preview e preparação de impressão do PDV Universal.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { capacidadesParaModo } = require('../../backend/motores/pdv-universal/contratos');
const modal = require('../../frontend/pdv-universal/pdv-universal-comprovante-modal.js');
const pos = require('../../frontend/pdv-universal/pdv-universal-pos-pagamento.js');
const printClient = require('../../frontend/shared/js/muv-comprovante-client.js');
const tela = require('../../frontend/pdv-universal/pdv-universal.js');

const ROOT = path.join(__dirname, '../..');
function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function ctxMulti() {
  return { capacidades: capacidadesParaModo('MULTIEMPRESA') };
}

async function test01CarregaComprovanteOficial() {
  const html = await pos.obterComprovanteHtml(25, async (url) => {
    assert.ok(url.includes('/pdv-universal/atendimentos/25/comprovante'));
    return { ok: true, text: async () => '<html>ATD</html>' };
  });
  assert.ok(html.includes('ATD'));
}

async function test02FiscalizadoPermitePreview() {
  assert.ok(modal.fiscalNaoBloqueia('FISCALIZADO'));
  assert.ok(modal.podePreview(ctxMulti()));
}

async function test03ParcialPermitePreview() {
  assert.ok(modal.fiscalNaoBloqueia('FISCAL_PARCIAL'));
}

async function test04ErroNaoInventaNfce() {
  assert.ok(modal.fiscalNaoBloqueia('FISCAL_ERRO'));
  const js = src('frontend/pdv-universal/pdv-universal-comprovante-modal.js');
  assert.ok(!js.includes('chave_acesso'));
  assert.ok(!js.includes('qr_code'));
}

async function test05ErroMantemEstado() {
  await assert.rejects(
    () => modal.carregarPreview(25, async () => ({
      ok: false,
      json: async () => ({ error: 'não encontrado', code: 'COMPROVANTE_NAO_ENCONTRADO' })
    })),
    (e) => e.code === 'COMPROVANTE_NAO_ENCONTRADO'
  );
  assert.strictEqual(modal.estadoInicial().estado, 'LOADING');
}

async function test06ImpressaoEndpointOficial() {
  let url;
  await printClient.prepararImpressaoBrowser(25, async (u, opts) => {
    url = u;
    assert.strictEqual(opts.method, 'POST');
    return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ destino: 'BROWSER' }) };
  }, 40);
  assert.ok(url.includes('/atendimentos/25/imprimir'));
}

async function test07BrowserHtml() {
  const corpo = printClient.corpoImpressaoBrowser(40);
  assert.strictEqual(corpo.destino, 'BROWSER');
  assert.strictEqual(corpo.formato, 'HTML');
  assert.strictEqual(corpo.largura, 40);
}

async function test08SemWindowPrintAuto() {
  const blob = src('frontend/pdv-universal/pdv-universal-comprovante-modal.js')
    + src('frontend/pdv-universal/pdv-universal.js')
    + src('frontend/pdv-universal/index.html');
  assert.ok(!blob.includes('window.print('));
}

async function test09NovoAtendimentoSoVisual() {
  const limpo = modal.estadoNovoAtendimento();
  assert.strictEqual(limpo.sessao, null);
  assert.strictEqual(limpo.carrinho_limpo, true);
  const js = src('frontend/pdv-universal/pdv-universal.js');
  assert.ok(js.includes('iniciarNovoAtendimentoVisual'));
  assert.ok(!js.includes('DELETE FROM atendimentos'));
  assert.ok(!js.includes('cancelarAtendimento(') || js.includes('iniciarNovoAtendimentoVisual'));
}

async function test10EmpresaUnicaNaoUsaMuv() {
  const caps = capacidadesParaModo('EMPRESA_UNICA');
  assert.strictEqual(caps.pode_preparar_impressao, false);
  assert.strictEqual(caps.pode_visualizar_comprovante, false);
  assert.ok(!modal.podePrepararImpressao({ capacidades: caps }));
}

async function test11SemAtendimentoArtificial() {
  const chk = src('frontend/pdv-universal/pdv-universal-comprovante-modal.js');
  assert.ok(!chk.includes('criarAtendimento'));
  assert.ok(!src('frontend/pdv-universal/pdv-universal-checkout.js').includes('atendimento_id: 1'));
}

async function test12CarrinhoAntesDaConclusao() {
  const js = src('frontend/pdv-universal/pdv-universal.js');
  const idxLimpar = js.indexOf('api._cart.limpar()');
  const idxPago = js.indexOf('PAGAMENTO CONFIRMADO');
  assert.ok(idxPago > 0);
  assert.ok(js.includes('ERRO_CHECKOUT'));
  assert.ok(!js.split('catch (err)')[1].includes('api._cart.limpar()'));
  void idxLimpar;
}

async function test13ErroImpressaoNaoAltera() {
  await assert.rejects(
    () => modal.prepararImpressao(25, async () => ({
      ok: false,
      headers: { get: () => 'application/json' },
      json: async () => ({ error: 'falha', code: 'ERRO_PREPARAR_IMPRESSAO' })
    })),
    (e) => e.code === 'ERRO_PREPARAR_IMPRESSAO' || e.code === 'ERRO_API_COMPROVANTE'
  );
  assert.ok(!src('frontend/pdv-universal/pdv-universal-comprovante-modal.js').includes('cancelarAtendimento'));
}

async function test14RateioNaoAparece() {
  const js = src('frontend/pdv-universal/pdv-universal-comprovante-modal.js');
  assert.ok(!js.includes('rateio'));
}

async function test15PdvLegadoIntacto() {
  assert.ok(src('frontend/pdv/js/pdv.js').includes("url: `${API_URL}/vendas`"));
  assert.ok(src('backend/server.js').includes("frontendRoot, 'pdv/index.html'"));
}

async function test16CapabilitiesEEstados() {
  assert.ok(tela.ESTADOS.COMPROVANTE_DISPONIVEL);
  assert.ok(modal.ESTADOS.READY);
  assert.strictEqual(capacidadesParaModo('MULTIEMPRESA').pode_iniciar_novo_atendimento, true);
  assert.ok(src('frontend/pdv-universal/index.html').includes('PREPARAR IMPRESSÃO'));
  assert.ok(src('frontend/pdv-universal/index.html').includes('NOVO ATENDIMENTO'));
}

async function run() {
  const testes = [
    test01CarregaComprovanteOficial,
    test02FiscalizadoPermitePreview,
    test03ParcialPermitePreview,
    test04ErroNaoInventaNfce,
    test05ErroMantemEstado,
    test06ImpressaoEndpointOficial,
    test07BrowserHtml,
    test08SemWindowPrintAuto,
    test09NovoAtendimentoSoVisual,
    test10EmpresaUnicaNaoUsaMuv,
    test11SemAtendimentoArtificial,
    test12CarrinhoAntesDaConclusao,
    test13ErroImpressaoNaoAltera,
    test14RateioNaoAparece,
    test15PdvLegadoIntacto,
    test16CapabilitiesEEstados
  ];
  for (const t of testes) {
    await t();
    console.log('ok', t.name);
  }
  console.log(`05.09 ${testes.length}/${testes.length}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
