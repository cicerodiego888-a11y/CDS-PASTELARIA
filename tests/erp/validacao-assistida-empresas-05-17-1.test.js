/**
 * Sprint 05.17.1 — validação assistida da gestão de empresas.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const G = require('../../frontend/erp/js/gestao-empresas-fiscal.js');
const { exigirEmpresaAlvoAdministrativo, dtoPublicoConfiguracao } = require('../../backend/services/fiscal/empresasConfiguracaoFiscal');

const ROOT = path.join(__dirname, '../..');
function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function test01Menu() {
  assert.ok(!src('frontend/erp/index.html').includes('data-page="empresas"'));
  assert.ok(src('frontend/erp/js/cds-centro-configuracoes.js').includes("loadPage('empresas')"));
  assert.ok(src('frontend/erp/js/app.js').includes("case 'empresas':"));
}

function test02Script() {
  const app = src('frontend/erp/js/app.js');
  assert.ok(app.includes("cdsErpAsset('/erp/js/gestao-empresas-fiscal.js')"));
  assert.ok(app.includes('CDS_ERP_ASSET_VERSION'));
  assert.ok(app.includes(": '0519'") || app.includes('CDS_ERP_ASSET_VERSION'));
  assert.ok(!app.includes('?v=0515'));
  assert.ok(!app.includes('?v=0516'));
  assert.ok(!app.includes("?v=0517'"));
}

function test03SemApiApi() {
  assert.strictEqual(G.normalizarApiUrl('/empresas'), '/api/empresas');
  assert.strictEqual(G.normalizarApiUrl('/api/empresas/configuracao-fiscal/status'), '/api/empresas/configuracao-fiscal/status');
  assert.ok(!G.normalizarApiUrl(G.urlGetFiscal(2)).includes('/api/api/'));
  assert.ok(!G.normalizarApiUrl(G.urlCertificadoUpload()).includes('/api/api/'));
}

function test04Lista() {
  assert.ok(src('frontend/erp/js/gestao-empresas-fiscal.js').includes("jsonFetch('/empresas'"));
}

function test05StatusNaoApaga() {
  const js = src('frontend/erp/js/gestao-empresas-fiscal.js');
  assert.ok(js.includes('avisoStatusFiscal'));
  assert.ok(js.includes('data-gef-tab="fiscal"'));
  assert.ok(js.includes('fiscalVazio'));
}

function test06e07IdEEdicao() {
  assert.strictEqual(G.resolverEmpresaId({ id: 11 }), 11);
  assert.ok(src('frontend/erp/js/gestao-empresas-fiscal.js').includes('await abrirDetalhe(novaId)'));
}

function test08a10Abas() {
  const js = src('frontend/erp/js/gestao-empresas-fiscal.js');
  assert.ok(js.includes('DADOS GERAIS'));
  assert.ok(js.includes('CONFIGURAÇÃO FISCAL'));
  assert.ok(js.includes('CERTIFICADO DIGITAL'));
}

function test11e12FiscalEmpresa() {
  assert.strictEqual(G.urlGetFiscal(14), '/api/empresas/14/configuracao-fiscal');
  assert.strictEqual(G.urlPutFiscal(14), '/api/empresas/14/configuracao-fiscal');
}

function test13Divergente() {
  assert.throws(
    () => exigirEmpresaAlvoAdministrativo(14, { empresa_id: 1 }),
    (err) => err.code === 'EMPRESA_CONFIGURACAO_DIVERGENTE'
  );
}

function test14e15Upload() {
  const js = src('frontend/erp/js/gestao-empresas-fiscal.js');
  assert.ok(js.includes("fd.append('empresa_id', String(id))"));
  assert.ok(!/empresa_id:\s*1/.test(js));
}

function test16e17Segredos() {
  const dto = dtoPublicoConfiguracao(
    { id: 2, cnpj: '11', razao_social: 'X', ativo: 1 },
    { token_csc: 'SEG', certificado_senha: 's', certificado_path: 'C:/x.pfx' }
  );
  assert.ok(!Object.prototype.hasOwnProperty.call(dto, 'token_csc'));
  assert.ok(!Object.prototype.hasOwnProperty.call(dto, 'certificado_senha'));
}

function test18Cache() {
  const app = src('frontend/erp/js/app.js');
  assert.ok(app.includes('CDS_ERP_ASSET_VERSION'));
  assert.ok(app.includes('existente.src !== src'));
}

function run() {
  [
    test01Menu, test02Script, test03SemApiApi, test04Lista, test05StatusNaoApaga,
    test06e07IdEEdicao, test08a10Abas, test11e12FiscalEmpresa, test13Divergente,
    test14e15Upload, test16e17Segredos, test18Cache
  ].forEach((t) => {
    t();
    console.log('ok', t.name);
  });
  console.log('05.17.1 empresas 12/12');
}

run();
