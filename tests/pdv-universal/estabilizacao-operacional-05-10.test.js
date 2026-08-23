/**
 * Sprint 05.10 — estabilização operacional do PDV Universal.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const S = require('../../frontend/pdv-universal/pdv-universal-session.js');
const checkout = require('../../frontend/pdv-universal/pdv-universal-checkout.js');
const { capacidadesParaModo } = require('../../backend/motores/pdv-universal/contratos');

const ROOT = path.join(__dirname, '../..');
function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function test01CheckoutNaoDuplica() {
  const s = S.criarSessao();
  assert.strictEqual(S.adquirir(s, S.ACOES.CHECKOUT), true);
  assert.strictEqual(S.adquirir(s, S.ACOES.CHECKOUT), false);
}

function test02ReservaNaoDuplica() {
  const s = S.criarSessao();
  assert.ok(S.adquirir(s, S.ACOES.RESERVAR));
  assert.ok(!S.adquirir(s, S.ACOES.RESERVAR));
}

function test03PagamentoNaoDuplica() {
  const s = S.criarSessao();
  assert.ok(S.adquirir(s, S.ACOES.PAGAR));
  assert.ok(!S.adquirir(s, S.ACOES.PAGAR));
}

function test04MaterializacaoNaoDuplica() {
  const s = S.criarSessao();
  assert.ok(S.adquirir(s, S.ACOES.MATERIALIZAR));
  assert.ok(!S.adquirir(s, S.ACOES.MATERIALIZAR));
}

function test05FiscalizacaoNaoDuplica() {
  const s = S.criarSessao();
  assert.ok(S.adquirir(s, S.ACOES.FISCALIZAR));
  assert.ok(!S.adquirir(s, S.ACOES.FISCALIZAR));
}

function test06ErroReservaVoltaValidado() {
  const s = S.criarSessao();
  S.marcarSeguro(s, S.ESTADOS.ATENDIMENTO_VALIDADO, { atendimento_id: 9 });
  S.adquirir(s, S.ACOES.RESERVAR);
  const seguro = S.recuperarErro(s, S.ACOES.RESERVAR);
  assert.strictEqual(seguro, S.ESTADOS.ATENDIMENTO_VALIDADO);
  assert.strictEqual(s.atendimento_id, 9);
}

function test07ErroPagamentoVoltaReservado() {
  const s = S.criarSessao();
  S.marcarSeguro(s, S.ESTADOS.ATENDIMENTO_RESERVADO, { atendimento_id: 9 });
  S.adquirir(s, S.ACOES.PAGAR);
  assert.strictEqual(S.recuperarErro(s, S.ACOES.PAGAR), S.ESTADOS.ATENDIMENTO_RESERVADO);
}

function test08ErroMaterializacaoMantemPago() {
  const s = S.criarSessao();
  S.marcarSeguro(s, S.ESTADOS.ATENDIMENTO_PAGO, { atendimento_id: 9, status: 'PAGO' });
  S.adquirir(s, S.ACOES.MATERIALIZAR);
  assert.strictEqual(S.recuperarErro(s, S.ACOES.MATERIALIZAR), S.ESTADOS.ATENDIMENTO_PAGO);
}

function test09ErroFiscalRecuperavel() {
  const s = S.criarSessao();
  S.adquirir(s, S.ACOES.FISCALIZAR);
  S.recuperarErro(s, S.ACOES.FISCALIZAR);
  assert.strictEqual(s.estado, S.ESTADOS.ERRO_RECUPERAVEL);
}

function test10FecharModalNaoCancela() {
  const s = S.criarSessao();
  S.marcarSeguro(s, S.ESTADOS.ATENDIMENTO_RESERVADO, { atendimento_id: 4, status: 'RESERVADO' });
  const snap = S.fecharModalPreservaDominio(s);
  assert.strictEqual(snap.atendimento_id, 4);
  assert.strictEqual(s.status, 'RESERVADO');
  const js = src('frontend/pdv-universal/pdv-universal.js');
  assert.ok(js.includes("pdvu-pgto-fechar"));
  assert.ok(js.includes('fecharModalPreservaDominio'));
}

function test11FecharPreviewPreserva() {
  const s = S.criarSessao();
  S.marcarSeguro(s, S.ESTADOS.COMPROVANTE_DISPONIVEL, { atendimento_id: 5 });
  const snap = S.fecharModalPreservaDominio(s);
  assert.strictEqual(snap.atendimento_id, 5);
}

function test12CarrinhoErro() {
  const js = src('frontend/pdv-universal/pdv-universal.js');
  assert.ok(js.includes('ERRO_RECUPERAVEL'));
  const catchCheckout = js.split("aviso(err.message || 'Erro no checkout.')")[1] || '';
  assert.ok(!catchCheckout.slice(0, 400).includes('api._cart.limpar()'));
}

function test13CancelamentoApiOficial() {
  const js = src('frontend/pdv-universal/pdv-universal.js');
  assert.ok(js.includes('cancelarAtendimento(s.atendimento_id)'));
  assert.ok(js.includes("confirm('Cancelar atendimento?')"));
  assert.ok(!js.includes('reservado_fiscal'));
}

function test14CancelamentoLimpaVisual() {
  const js = src('frontend/pdv-universal/pdv-universal.js');
  assert.ok(js.includes('resetarSessaoPDVUniversal()'));
}

function test15NovoSoTemporario() {
  const s = S.criarSessao();
  s.empresa_operacional_persistida = '7';
  S.marcarSeguro(s, S.ESTADOS.ATENDIMENTO_PAGO, { atendimento_id: 8 });
  const limpa = S.resetarSessaoPDVUniversal(s, { empresa_operacional_persistida: '7' });
  assert.strictEqual(limpa.atendimento_id, null);
  assert.strictEqual(limpa.empresa_operacional_persistida, '7');
  assert.strictEqual(limpa.estado, S.ESTADOS.INICIAL);
}

function test16UnicaNaoUsaMuv() {
  assert.ok(S.nuncaUsaMuvPagamento({ capacidades: capacidadesParaModo('EMPRESA_UNICA') }));
  assert.ok(!checkout.podeFinalizar({
    capacidades: capacidadesParaModo('EMPRESA_UNICA')
  }, [{ produto_id: 1, empresa_id: 2 }]));
}

function test17MultiNaoCaiLegado() {
  assert.ok(S.nuncaCaiNoLegado({ capacidades: capacidadesParaModo('MULTIEMPRESA') }));
  const chk = src('frontend/pdv-universal/pdv-universal-checkout.js');
  assert.ok(!chk.includes('${baseApi()}/vendas'));
}

function test18AcaoDuranteLock() {
  const s = S.criarSessao();
  S.adquirir(s, S.ACOES.CHECKOUT);
  assert.ok(!S.atalhoPermitido(s));
  assert.ok(S.emProcessamento(s));
}

function test19ResetNaoAlteraEmpresa() {
  const js = src('frontend/pdv-universal/pdv-universal.js');
  assert.ok(js.includes("localStorage.getItem('cds_empresa_id')"));
  assert.ok(!src('frontend/pdv-universal/pdv-universal-session.js').includes("removeItem('cds_empresa_id')"));
}

function test20PdvLegado() {
  assert.ok(src('frontend/pdv/js/pdv.js').includes("url: `${API_URL}/vendas`"));
  assert.ok(src('backend/server.js').includes("frontendRoot, 'pdv/index.html'"));
}

async function run() {
  const testes = [
    test01CheckoutNaoDuplica,
    test02ReservaNaoDuplica,
    test03PagamentoNaoDuplica,
    test04MaterializacaoNaoDuplica,
    test05FiscalizacaoNaoDuplica,
    test06ErroReservaVoltaValidado,
    test07ErroPagamentoVoltaReservado,
    test08ErroMaterializacaoMantemPago,
    test09ErroFiscalRecuperavel,
    test10FecharModalNaoCancela,
    test11FecharPreviewPreserva,
    test12CarrinhoErro,
    test13CancelamentoApiOficial,
    test14CancelamentoLimpaVisual,
    test15NovoSoTemporario,
    test16UnicaNaoUsaMuv,
    test17MultiNaoCaiLegado,
    test18AcaoDuranteLock,
    test19ResetNaoAlteraEmpresa,
    test20PdvLegado
  ];
  for (const t of testes) {
    await t();
    console.log('ok', t.name);
  }
  console.log(`05.10 ${testes.length}/${testes.length}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
