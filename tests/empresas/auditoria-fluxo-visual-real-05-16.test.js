/**
 * Sprint 05.16 — auditoria do fluxo visual real da gestão de empresas.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const G = require('../../frontend/erp/js/gestao-empresas-fiscal.js');

const ROOT = path.join(__dirname, '../..');
function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function testCaminhoReal() {
  const app = src('frontend/erp/js/app.js');
  assert.ok(app.includes("cdsErpAsset('/erp/js/gestao-empresas-fiscal.js')"));
  assert.ok(app.includes("case 'empresas':"));
  assert.ok(app.includes('loadGestaoEmpresasFiscal()'));
  const html = src('frontend/erp/index.html');
  assert.ok(!html.includes('data-page="empresas"'));
  assert.ok(src('frontend/erp/js/cds-centro-configuracoes.js').includes("loadPage('empresas')"));
}

function testPosCreateAbreEdicao() {
  const js = src('frontend/erp/js/gestao-empresas-fiscal.js');
  assert.ok(js.includes('resolverEmpresaId(criada)'));
  assert.ok(js.includes('await abrirDetalhe(novaId)'));
  assert.strictEqual(G.idEmpresaResposta({ id: 7 }), 7);
  assert.strictEqual(G.idEmpresaResposta({ empresa_id: 9 }), 9);
  assert.strictEqual(G.idEmpresaResposta({}), null);
}

function testAbasNoCodigoENoFluxo() {
  const js = src('frontend/erp/js/gestao-empresas-fiscal.js');
  assert.ok(js.includes('data-gef-tab="fiscal"'));
  assert.ok(js.includes('data-gef-tab="cert"'));
  assert.ok(js.includes('data-gef-edicao="1"'));
  assert.ok(G.empresaNovaNaoMostraFiscal(G.htmlFormNovaEmpresa()));
}

function testSemApiDuplo() {
  assert.ok(G.chamadaSemApiDuplo(G.urlAbsoluta(G.urlStatusOficial())));
  assert.ok(G.chamadaSemApiDuplo(G.urlAbsoluta(G.urlGetFiscal(3))));
  assert.ok(!G.urlAbsoluta('/empresas').includes('/api/api/'));
}

function testStatusNaoDerrubaLista() {
  const js = src('frontend/erp/js/gestao-empresas-fiscal.js');
  assert.ok(js.includes('status = []'));
  assert.ok(js.includes('fiscalVazio(empresaId)'));
}

function testFiscalECertificadoOficiais() {
  assert.strictEqual(G.urlGetFiscal(4), '/api/empresas/4/configuracao-fiscal');
  assert.strictEqual(G.urlPutFiscal(4), '/api/empresas/4/configuracao-fiscal');
  assert.strictEqual(G.urlCertificadoUpload(), '/api/fiscal/certificado/upload');
  const js = src('frontend/erp/js/gestao-empresas-fiscal.js');
  assert.ok(js.includes("fd.append('empresa_id'"));
}

function run() {
  [
    testCaminhoReal,
    testPosCreateAbreEdicao,
    testAbasNoCodigoENoFluxo,
    testSemApiDuplo,
    testStatusNaoDerrubaLista,
    testFiscalECertificadoOficiais
  ].forEach((t) => {
    t();
    console.log('ok', t.name);
  });
  console.log('05.16 empresas 6/6');
}

run();
