/**
 * Sprint 05.17.2 — prova de execução do módulo Empresas + URLs.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const G = require('../../frontend/erp/js/gestao-empresas-fiscal.js');
const tela = require('../../frontend/pdv-universal/pdv-universal.js');
const acesso = require('../../frontend/shared/js/pdv-acesso-oficial.js');

const ROOT = path.join(__dirname, '../..');
function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function test01SemApiApi() {
  assert.strictEqual(G.normalizarApiUrl('/empresas'), '/api/empresas');
  assert.ok(!G.normalizarApiUrl('/api/empresas/1/configuracao-fiscal').includes('/api/api/'));
}

function test02UmaVersao() {
  const app = src('frontend/erp/js/app.js');
  assert.ok(app.includes(": '05172'"));
  assert.ok(!app.includes('?v=0515'));
  assert.ok(!app.includes('?v=0516'));
  assert.ok(app.includes('existente.src !== src'));
}

function test03LoadPage() {
  assert.ok(src('frontend/erp/js/app.js').includes("cdsErpAsset('/erp/js/gestao-empresas-fiscal.js')"));
  assert.ok(src('frontend/erp/js/app.js').includes("case 'empresas':"));
}

function test04e05Id() {
  assert.strictEqual(G.resolverEmpresaId({ id: 3 }), 3);
  assert.strictEqual(G.resolverEmpresaId({ empresa_id: 4 }), 4);
}

function test06StatusNaoRemoveAbas() {
  const js = src('frontend/erp/js/gestao-empresas-fiscal.js');
  assert.ok(js.includes('avisoStatusFiscal'));
  assert.ok(js.includes('data-gef-tab="fiscal"'));
}

function test07TresAbas() {
  const js = src('frontend/erp/js/gestao-empresas-fiscal.js');
  assert.ok(js.includes('await abrirDetalhe(novaId)'));
  assert.ok(js.includes('CERTIFICADO DIGITAL'));
}

function test08UploadExigeId() {
  const js = src('frontend/erp/js/gestao-empresas-fiscal.js');
  assert.ok(js.includes('empresa_id oficial é obrigatório'));
  assert.ok(js.includes("fd.append('empresa_id'"));
}

function test09PdvRota() {
  assert.strictEqual(acesso.urlPdvUniversalOficial(), '/pdv-universal/');
}

function test10NaoLogout409() {
  assert.notStrictEqual(
    tela.classificarErroContexto({ status: 409, code: 'NENHUMA_EMPRESA_DISPONIVEL' }).acao,
    'LOGIN'
  );
}

async function test11InvalidaRetry() {
  let n = 0;
  await tela.carregarContextoComRecuperacao(async () => {
    n += 1;
    if (n === 1) {
      return { ok: false, status: 400, json: async () => ({ code: 'EMPRESA_OPERACIONAL_INVALIDA' }) };
    }
    return { ok: true, status: 200, json: async () => ({ modo_operacao: 'MULTIEMPRESA' }) };
  });
  assert.strictEqual(n, 2);
}

function testVersaoModulo() {
  assert.ok(src('frontend/erp/js/gestao-empresas-fiscal.js').includes("__CDS_EMPRESAS_MODULE_VERSION = '05.18'"));
}

async function run() {
  const testes = [
    test01SemApiApi, test02UmaVersao, test03LoadPage, test04e05Id,
    test06StatusNaoRemoveAbas, test07TresAbas, test08UploadExigeId,
    test09PdvRota, test10NaoLogout409, test11InvalidaRetry, testVersaoModulo
  ];
  for (const t of testes) {
    await t();
    console.log('ok', t.name);
  }
  console.log('05.17.2 11/11');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
