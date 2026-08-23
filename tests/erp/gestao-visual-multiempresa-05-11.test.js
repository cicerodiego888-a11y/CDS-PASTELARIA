/**
 * Sprint 05.11 — gestão visual multiempresa + configuração fiscal.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const G = require('../../frontend/erp/js/gestao-empresas-fiscal.js');
const { dtoPublicoConfiguracao } = require('../../backend/services/fiscal/empresasConfiguracaoFiscal');

const ROOT = path.join(__dirname, '../..');
function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function dtoSeguro(id, extras) {
  return dtoPublicoConfiguracao(
    { id, cnpj: '11222333000181', razao_social: 'Empresa ' + id, ativo: 1 },
    Object.assign({
      ambiente: 2,
      serie: 1,
      token_csc: 'SEGREDO-CSC',
      id_csc: 'ID-CSC',
      certificado_path: `C:/interno/certificado-empresa-${id}.pfx`,
      certificado_senha: 'senha-secreta',
      ws_autorizacao: 'https://sefaz.local/auth'
    }, extras || {})
  );
}

function test01ListaEmpresas() {
  const lista = G.juntarEmpresasComStatus(
    [{ id: 10, razao_social: 'Matriz', cnpj: '11222333000181' }],
    [{ empresa_id: 10, status: 'PRONTA' }]
  );
  assert.strictEqual(lista.length, 1);
  assert.strictEqual(lista[0].razao_social, 'Matriz');
}

function test02StatusFonteOficial() {
  assert.strictEqual(G.urlStatusOficial(), '/api/empresas/configuracao-fiscal/status');
  assert.strictEqual(G.urlAbsoluta(G.urlStatusOficial()), '/api/empresas/configuracao-fiscal/status');
  assert.ok(!G.urlAbsoluta(G.urlStatusOficial()).includes('/api/api/'));
  const js = src('frontend/erp/js/gestao-empresas-fiscal.js');
  assert.ok(js.includes('urlStatusOficial()'));
  assert.ok(!js.includes('avaliarStatusAdmin'));
}

function test03Pronto() {
  const v = G.rotuloStatusOficial('PRONTA');
  assert.strictEqual(v.texto, 'PRONTA');
  assert.ok(v.marca);
}

function test04Incompleta() {
  assert.strictEqual(G.rotuloStatusOficial('INCOMPLETA').texto, 'INCOMPLETA');
}

function test05Invalida() {
  assert.strictEqual(G.rotuloStatusOficial('INVALIDA').texto, 'INVALIDA');
}

function test06Desativada() {
  assert.strictEqual(G.rotuloStatusOficial('DESATIVADA').texto, 'DESATIVADA');
}

function test07AbrirANaoCarregaB() {
  const s = G.abrirEmpresa(G.criarSessaoDetalhe(), 10);
  assert.ok(G.empresaANaoCarregaB(s, 10));
  assert.ok(!G.empresaANaoCarregaB(s, 20));
}

function test08GetEmpresaId() {
  assert.strictEqual(G.urlGetFiscal(10), '/api/empresas/10/configuracao-fiscal');
}

function test09PutEmpresaId() {
  assert.strictEqual(G.urlPutFiscal(20), '/api/empresas/20/configuracao-fiscal');
}

function test10PayloadNaoSubstituiUrl() {
  const envio = G.payloadNaoSubstituiUrl(10, { empresa_id: 99, ambiente: 2 });
  assert.strictEqual(envio.urlEmpresaId, 10);
  assert.ok(!('empresa_id' in envio.payload));
}

function test11MergeParcial() {
  const p = G.montarPayloadFiscal({ ambiente: 2, token_csc: '', serie: 1 }, 10);
  assert.strictEqual(p.ambiente, 2);
  assert.ok(!Object.prototype.hasOwnProperty.call(p, 'token_csc'));
  assert.strictEqual(p.serie, 1);
}

function test12GetNaoExpoeSenha() {
  const dto = dtoSeguro(3);
  assert.ok(G.dtoNaoExpoeSegredos(dto));
  assert.ok(!Object.prototype.hasOwnProperty.call(dto, 'certificado_senha'));
}

function test13GetNaoExpoeCsc() {
  const dto = dtoSeguro(3);
  assert.ok(!Object.prototype.hasOwnProperty.call(dto, 'token_csc'));
  assert.strictEqual(dto.csc_configurado, true);
}

function test14GetNaoExpoePath() {
  const dto = dtoSeguro(3);
  assert.ok(!Object.prototype.hasOwnProperty.call(dto, 'certificado_path'));
  assert.strictEqual(dto.certificado_nome, 'certificado-empresa-3.pfx');
}

function test15CertANaoApareceEmB() {
  const a = dtoSeguro(4);
  const b = dtoSeguro(5);
  assert.ok(G.certificadoIsolado(a, b));
  assert.notStrictEqual(a.certificado_nome, b.certificado_nome);
}

function test16ErroRecuperavel() {
  const js = src('frontend/erp/js/gestao-empresas-fiscal.js');
  assert.ok(js.includes('TENTAR NOVAMENTE'));
  assert.ok(js.includes('ESTADOS.ERROR'));
}

function test17LoadingLimpaLista() {
  const js = src('frontend/erp/js/gestao-empresas-fiscal.js');
  assert.ok(js.includes("_ui.lista = []"));
  assert.ok(js.includes('Carregando empresas...'));
}

function test18SalvarBloqueiaDuplo() {
  const js = src('frontend/erp/js/gestao-empresas-fiscal.js');
  assert.ok(js.includes('if (_ui.saving) return'));
  assert.ok(js.includes('btn.disabled = true'));
}

function test19SucessoRecarregaStatus() {
  const js = src('frontend/erp/js/gestao-empresas-fiscal.js');
  assert.ok(js.includes('await carregarLista()'));
}

function test20SemRegressaoPdv() {
  assert.ok(src('frontend/pdv/js/pdv.js').includes("url: `${API_URL}/vendas`"));
  assert.ok(src('frontend/pdv-universal/pdv-universal-session.js').includes('resetarSessaoPDVUniversal'));
  assert.ok(!src('frontend/erp/js/gestao-empresas-fiscal.js').includes('empresa_id: 1'));
}

function test21MenuConfiguracoes() {
  const html = src('frontend/erp/index.html');
  assert.ok(!/data-page="empresas"/.test(html));
  assert.ok(src('frontend/erp/js/app.js').includes("case 'empresas':"));
  const centro = src('frontend/erp/js/cds-centro-configuracoes.js');
  assert.ok(centro.includes('btnAbrirGestaoEmpresas'));
  assert.ok(centro.includes("loadPage('empresas')"));
}

function test22UploadEmpresaId() {
  const fiscal = src('backend/rotas/fiscal.js');
  assert.ok(fiscal.includes('certificado-empresa-${empresaId}.pfx'));
  assert.ok(fiscal.includes('salvarConfiguracaoFiscalEmpresa(empresaId'));
}

function test23NaoAssumeEmpresa1() {
  const js = src('frontend/erp/js/gestao-empresas-fiscal.js');
  assert.ok(!/fallback.*empresa.?1/i.test(js));
}

async function run() {
  const testes = [
    test01ListaEmpresas,
    test02StatusFonteOficial,
    test03Pronto,
    test04Incompleta,
    test05Invalida,
    test06Desativada,
    test07AbrirANaoCarregaB,
    test08GetEmpresaId,
    test09PutEmpresaId,
    test10PayloadNaoSubstituiUrl,
    test11MergeParcial,
    test12GetNaoExpoeSenha,
    test13GetNaoExpoeCsc,
    test14GetNaoExpoePath,
    test15CertANaoApareceEmB,
    test16ErroRecuperavel,
    test17LoadingLimpaLista,
    test18SalvarBloqueiaDuplo,
    test19SucessoRecarregaStatus,
    test20SemRegressaoPdv,
    test21MenuConfiguracoes,
    test22UploadEmpresaId,
    test23NaoAssumeEmpresa1
  ];
  for (const t of testes) {
    await t();
    console.log('ok', t.name);
  }
  console.log(`05.11 ${testes.length}/${testes.length}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
