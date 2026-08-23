/**
 * Sprint 05.12 — ativação visual e acesso ao PDV Universal.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const acesso = require('../../frontend/shared/js/pdv-acesso-oficial.js');
const tela = require('../../frontend/pdv-universal/pdv-universal.js');

const ROOT = path.join(__dirname, '../..');
function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function existe(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function test01RotaRegistrada() {
  const server = src('backend/server.js');
  assert.ok(server.includes("'/pdv-universal'"));
  assert.ok(server.includes("frontendRoot, 'pdv-universal/index.html'"));
}

function test02RotaExigeAuth() {
  const server = src('backend/server.js');
  const bloco = server.split("app.get(['/pdv-universal'")[1] || '';
  assert.ok(server.includes("app.get(['/pdv-universal', '/pdv-universal/'], verificarToken"));
  assert.ok(bloco.includes("recursoHabilitado('pdv')"));
}

function test03PermissaoPdv() {
  const server = src('backend/server.js');
  assert.ok(server.includes("responderModuloNaoLicenciado(res, 'pdv')"));
  const erp = src('frontend/erp/index.html');
  assert.ok(erp.includes('id="nav-abrir-pdv"'));
  assert.ok(erp.includes('data-recurso="pdv"'));
}

function test04MenuDestino() {
  assert.strictEqual(acesso.urlPdvUniversalOficial(), '/pdv-universal/');
  const erp = src('frontend/erp/index.html');
  assert.ok(erp.includes('href="/pdv-universal/"'));
  assert.ok(erp.includes('PDV Universal'));
  const dash = src('frontend/erp/js/dashboard-command.js');
  assert.ok(dash.includes('urlPdvUniversalOficial') || dash.includes('/pdv-universal'));
}

function test05AssetsDeclaradosExistem() {
  const html = src('frontend/pdv-universal/index.html');
  const refs = [
    '/pdv-universal/pdv-universal.css',
    '/pdv-universal/pdv-universal-cart.js',
    '/pdv-universal/pdv-universal-checkout.js',
    '/pdv-universal/pdv-universal-pagamento.js',
    '/pdv-universal/pdv-universal-pos-pagamento.js',
    '/pdv-universal/pdv-universal-comprovante-modal.js',
    '/pdv-universal/pdv-universal-session.js',
    '/pdv-universal/pdv-universal.js'
  ];
  refs.forEach((r) => {
    assert.ok(html.includes(r), r);
    assert.ok(existe('frontend' + r), r);
  });
}

function test06AssetsAcessiveis() {
  assert.ok(existe('frontend/pdv-universal/index.html'));
  assert.ok(src('backend/server.js').includes("app.use(express.static(path.join(__dirname, '../frontend')))"));
}

function test07ConsomeContexto() {
  assert.ok(tela.urlContexto().endsWith('/pdv-universal/contexto'));
}

function test08ModoNaoHardcoded() {
  const js = src('frontend/pdv-universal/pdv-universal.js');
  assert.ok(js.includes('contexto.modo_operacao'));
  assert.ok(js.includes("modo === 'MULTIEMPRESA'"));
  assert.ok(js.includes("modo === 'EMPRESA_UNICA'"));
}

function test09NaoAssumeEmpresa1() {
  assert.ok(tela.nuncaAssumirEmpresaUm({ empresa_selecionada: null }));
  assert.ok(tela.nuncaAssumirEmpresaUm({
    empresa_selecionada: { id: 1 },
    empresas_disponiveis: [{ id: 1 }]
  }));
}

function test10MultiSemEmpresa() {
  const ctx = { modo_operacao: 'MULTIEMPRESA', empresa_selecionada: null, capacidades: {} };
  const modelo = tela.montarModeloVisual(ctx);
  assert.ok(!modelo.empresa_rotulo);
  assert.strictEqual(modelo.modo_rotulo, 'MULTIEMPRESA');
}

function test11ErroRecuperavel() {
  const html = src('frontend/pdv-universal/index.html');
  assert.ok(html.includes('Não foi possível carregar o PDV agora.'));
  assert.ok(html.includes('pdvu-retry'));
  assert.ok(!html.includes('location.href = \'/pdv\''));
}

function test12Retry() {
  const js = src('frontend/pdv-universal/pdv-universal.js');
  assert.ok(js.includes('pdvu-retry'));
  assert.ok(js.includes('carregarContexto'));
}

function test13LegadoAcessivel() {
  assert.strictEqual(acesso.urlPdvLegadoOficial(), '/pdv');
  assert.ok(src('backend/server.js').includes("frontendRoot, 'pdv/index.html'"));
  assert.ok(src('frontend/erp/index.html').includes('href="/pdv"'));
}

function test14SemMotorParalelo() {
  const server = src('backend/server.js');
  assert.ok(server.includes("require('./rotas/pdv-universal')"));
  assert.ok(!src('frontend/shared/js/pdv-acesso-oficial.js').includes('criarAtendimento'));
}

function test15NaoAlteraVas() {
  const vas = src('backend/services/vendas/VendaApplicationService.js');
  assert.ok(vas.includes('criarVenda') || vas.includes('module.exports'));
  assert.ok(!src('frontend/shared/js/pdv-acesso-oficial.js').includes('VendaApplicationService'));
}

function test16NaoAlteraMuv() {
  assert.ok(existe('backend/motores/muv/AtendimentoMultiempresaService.js'));
  assert.ok(!src('frontend/shared/js/pdv-acesso-oficial.js').includes('reservarAtendimento'));
}

function test17AberturaNaoCriaVenda() {
  const js = src('frontend/pdv-universal/pdv-universal.js');
  const bind = js.split('function bindUi')[1] || '';
  const inicio = bind.slice(0, 2500);
  assert.ok(!inicio.includes('finalizarCheckout'));
  assert.ok(!inicio.includes('criarAtendimento'));
}

function test18SemFallbackSilencioso() {
  const js = src('frontend/pdv-universal/pdv-universal.js');
  assert.ok(!js.includes("replace('/pdv')"));
  assert.ok(!js.includes('window.location.href = \'/pdv\''));
}

function test19ElectronNaoSubstituiInicio() {
  const pdv = src('electron-pdv.js');
  assert.ok(pdv.includes("modulo: 'pdv'"));
  assert.ok(!pdv.includes('pdv-universal'));
}

async function run() {
  const testes = [
    test01RotaRegistrada,
    test02RotaExigeAuth,
    test03PermissaoPdv,
    test04MenuDestino,
    test05AssetsDeclaradosExistem,
    test06AssetsAcessiveis,
    test07ConsomeContexto,
    test08ModoNaoHardcoded,
    test09NaoAssumeEmpresa1,
    test10MultiSemEmpresa,
    test11ErroRecuperavel,
    test12Retry,
    test13LegadoAcessivel,
    test14SemMotorParalelo,
    test15NaoAlteraVas,
    test16NaoAlteraMuv,
    test17AberturaNaoCriaVenda,
    test18SemFallbackSilencioso,
    test19ElectronNaoSubstituiInicio
  ];
  for (const t of testes) {
    await t();
    console.log('ok', t.name);
  }
  console.log(`05.12 ${testes.length}/${testes.length}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
