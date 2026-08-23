/**
 * Sprint 05.17 — fluxo real da gestão de empresas (estrutura + URLs).
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

function test01AbrirEmpresas() {
  const app = src('frontend/erp/js/app.js');
  assert.ok(app.includes('CDS_ERP_ASSET_VERSION'));
  assert.ok(app.includes("cdsErpAsset('/erp/js/gestao-empresas-fiscal.js')"));
  assert.ok(app.includes('loadGestaoEmpresasFiscal()'));
}

function test02ListaSemApiDuplo() {
  const lista = G.urlAbsoluta('/empresas');
  const status = G.urlAbsoluta(G.urlStatusOficial());
  assert.strictEqual(lista, '/api/empresas');
  assert.strictEqual(status, '/api/empresas/configuracao-fiscal/status');
  assert.ok(!lista.includes('/api/api/'));
  assert.ok(!status.includes('/api/api/'));
}

function test03FiscalSemApiDuplo() {
  assert.strictEqual(G.urlAbsoluta(G.urlGetFiscal(8)), '/api/empresas/8/configuracao-fiscal');
  assert.strictEqual(G.urlAbsoluta(G.urlPutFiscal(8)), '/api/empresas/8/configuracao-fiscal');
  assert.ok(G.chamadaSemApiDuplo(G.urlAbsoluta('/api/empresas/configuracao-fiscal/status')));
}

function test04ResolverId() {
  assert.strictEqual(G.resolverEmpresaId({ id: 4 }), 4);
  assert.strictEqual(G.resolverEmpresaId({ empresa_id: 5 }), 5);
  assert.strictEqual(G.resolverEmpresaId({ data: { id: 6 } }), 6);
  assert.strictEqual(G.resolverEmpresaId({}), null);
}

function test05EdicaoAposCadastro() {
  const js = src('frontend/erp/js/gestao-empresas-fiscal.js');
  assert.ok(js.includes('resolverEmpresaId(criada)'));
  assert.ok(js.includes('await abrirDetalhe(novaId)'));
  assert.ok(js.includes('data-gef-edicao="1"'));
  assert.ok(js.includes('data-gef-tab="gerais"'));
  assert.ok(js.includes('data-gef-tab="fiscal"'));
  assert.ok(js.includes('data-gef-tab="cert"'));
}

function test06CertificadoEmpresaId() {
  assert.strictEqual(G.urlAbsoluta(G.urlCertificadoUpload()), '/api/fiscal/certificado/upload');
  assert.ok(src('frontend/erp/js/gestao-empresas-fiscal.js').includes("fd.append('empresa_id'"));
  assert.ok(src('frontend/erp/js/gestao-empresas-fiscal.js').includes('ENVIAR CERTIFICADO'));
}

function test07StatusNaoDestroi() {
  const js = src('frontend/erp/js/gestao-empresas-fiscal.js');
  assert.ok(js.includes('Não foi possível atualizar o status fiscal.'));
  assert.ok(js.includes('gef-retry-status'));
  assert.ok(js.includes('avisoStatusFiscal'));
}

function run() {
  [
    test01AbrirEmpresas,
    test02ListaSemApiDuplo,
    test03FiscalSemApiDuplo,
    test04ResolverId,
    test05EdicaoAposCadastro,
    test06CertificadoEmpresaId,
    test07StatusNaoDestroi
  ].forEach((t) => {
    t();
    console.log('ok', t.name);
  });
  console.log('05.17 gestao 7/7');
}

run();
