/**
 * Sprint 05.15 — conclusão visual da gestão fiscal por empresa/CNPJ.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const G = require('../../frontend/erp/js/gestao-empresas-fiscal.js');
const {
  dtoPublicoConfiguracao,
  exigirEmpresaAlvoAdministrativo
} = require('../../backend/services/fiscal/empresasConfiguracaoFiscal');

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

function test01NovaSemFiscal() {
  const html = G.htmlFormNovaEmpresa();
  assert.ok(G.empresaNovaNaoMostraFiscal(html));
  assert.ok(html.includes('SALVAR EMPRESA'));
  assert.ok(html.includes('DADOS GERAIS'));
}

function test02CriadaAbreEdicao() {
  const js = src('frontend/erp/js/gestao-empresas-fiscal.js');
  assert.ok(js.includes('await abrirDetalhe(novaId)'));
  assert.ok(js.includes('data-gef-edicao="1"'));
  assert.ok(js.includes('data-gef-tab="fiscal"'));
  assert.ok(js.includes('data-gef-tab="cert"'));
}

function test03GetStatusCorreto() {
  assert.strictEqual(G.urlStatusOficial(), '/api/empresas/configuracao-fiscal/status');
  assert.ok(src('frontend/erp/js/gestao-empresas-fiscal.js').includes('urlStatusOficial()'));
  assert.ok(!src('frontend/erp/js/gestao-empresas-fiscal.js').includes('avaliarStatusAdmin'));
}

function test04SemApiDuplo() {
  const urls = [
    G.urlAbsoluta(G.urlStatusOficial()),
    G.urlAbsoluta(G.urlGetFiscal(4)),
    G.urlAbsoluta(G.urlPutFiscal(4)),
    G.urlAbsoluta(G.urlCertificadoUpload()),
    G.urlAbsoluta('/empresas')
  ];
  urls.forEach((u) => {
    assert.ok(G.chamadaSemApiDuplo(u), u);
    assert.ok(!String(u).includes('/api/api/'), u);
  });
  const js = src('frontend/erp/js/gestao-empresas-fiscal.js');
  assert.ok(!js.includes('${baseApi()}${url'));
}

function test05EmpresaIdCorreto() {
  assert.strictEqual(G.urlGetFiscal(12), '/api/empresas/12/configuracao-fiscal');
  assert.strictEqual(G.urlPutFiscal(12), '/api/empresas/12/configuracao-fiscal');
  const envio = G.payloadNaoSubstituiUrl(12, { empresa_id: 99, serie: 1 });
  assert.strictEqual(envio.urlEmpresaId, 12);
}

function test06DivergenciaBloqueada() {
  assert.throws(
    () => exigirEmpresaAlvoAdministrativo(12, { empresa_id: 99 }),
    (err) => err.code === 'EMPRESA_CONFIGURACAO_DIVERGENTE'
  );
}

function test07CscPodeSerEnviado() {
  const p = G.montarPayloadFiscal({ token_csc: 'novo-token', id_csc: '1' }, 5);
  assert.strictEqual(p.token_csc, 'novo-token');
  assert.strictEqual(p.id_csc, '1');
}

function test08CscNaoRetornaGet() {
  const dto = dtoSeguro(5);
  assert.ok(!Object.prototype.hasOwnProperty.call(dto, 'token_csc'));
  assert.ok(!Object.prototype.hasOwnProperty.call(dto, 'id_csc'));
  assert.strictEqual(dto.csc_configurado, true);
}

function test09CscIndicadorVisual() {
  assert.strictEqual(G.indicadorCscVisual({ csc_configurado: true }), 'CSC configurado');
  assert.ok(src('frontend/erp/js/gestao-empresas-fiscal.js').includes('data-gef-csc-status'));
}

function test10CertificadoEmpresaId() {
  const js = src('frontend/erp/js/gestao-empresas-fiscal.js');
  assert.ok(js.includes("fd.append('empresa_id', String(id))"));
  assert.strictEqual(G.urlCertificadoUpload(), '/api/fiscal/certificado/upload');
}

function test11SenhaNaoRetorna() {
  const dto = dtoSeguro(5);
  assert.ok(!Object.prototype.hasOwnProperty.call(dto, 'certificado_senha'));
  assert.ok(G.dtoNaoExpoeSegredos(dto));
}

function test12PathNaoRetorna() {
  const dto = dtoSeguro(5);
  assert.ok(!Object.prototype.hasOwnProperty.call(dto, 'certificado_path'));
  assert.strictEqual(dto.certificado_nome, 'certificado-empresa-5.pfx');
}

function test13PfxNaoRetorna() {
  const dto = dtoSeguro(5);
  const blob = JSON.stringify(dto);
  assert.ok(!/pfx_base64|certificado_pfx|-----BEGIN/.test(blob));
}

function test14TrocaRecarregaSoAlvo() {
  const s = G.abrirEmpresa(G.criarSessaoDetalhe(), 10);
  assert.ok(G.empresaANaoCarregaB(s, 10));
  assert.ok(!G.empresaANaoCarregaB(s, 20));
  const a = dtoSeguro(10);
  const b = dtoSeguro(20);
  assert.ok(G.certificadoIsolado(a, b));
}

function test15StatusAposSalvar() {
  const js = src('frontend/erp/js/gestao-empresas-fiscal.js');
  assert.ok(js.includes('await carregarLista()'));
  assert.ok(js.includes('await abrirDetalhe(id)'));
  assert.ok(js.includes('urlStatusOficial()'));
}

function test16EmpresaUnicaNaoInterfere() {
  const js = src('frontend/erp/js/gestao-empresas-fiscal.js');
  assert.ok(!js.includes('EMPRESA_UNICA'));
  assert.ok(!js.includes('VendaApplicationService'));
}

function test17MultiempresaNaoInterfere() {
  const js = src('frontend/erp/js/gestao-empresas-fiscal.js');
  assert.ok(!js.includes('AtendimentoMultiempresaService'));
  assert.ok(!js.includes('criarAtendimento'));
}

function test18NuncaEmpresa1() {
  assert.ok(G.nuncaAssumeEmpresaUm(4));
  assert.ok(!G.nuncaAssumeEmpresaUm(0));
  const js = src('frontend/erp/js/gestao-empresas-fiscal.js');
  assert.ok(!/empresa_id:\s*1/.test(js));
  assert.ok(js.includes('resolverEmpresaId(criada)'));
}

function run() {
  const testes = [
    test01NovaSemFiscal,
    test02CriadaAbreEdicao,
    test03GetStatusCorreto,
    test04SemApiDuplo,
    test05EmpresaIdCorreto,
    test06DivergenciaBloqueada,
    test07CscPodeSerEnviado,
    test08CscNaoRetornaGet,
    test09CscIndicadorVisual,
    test10CertificadoEmpresaId,
    test11SenhaNaoRetorna,
    test12PathNaoRetorna,
    test13PfxNaoRetorna,
    test14TrocaRecarregaSoAlvo,
    test15StatusAposSalvar,
    test16EmpresaUnicaNaoInterfere,
    test17MultiempresaNaoInterfere,
    test18NuncaEmpresa1
  ];
  testes.forEach((t) => {
    t();
    console.log('ok', t.name);
  });
  console.log(`05.15 ${testes.length}/${testes.length}`);
}

run();
