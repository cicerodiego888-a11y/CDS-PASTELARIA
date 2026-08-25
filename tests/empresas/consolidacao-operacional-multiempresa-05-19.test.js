'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const G = require('../../frontend/erp/js/gestao-empresas-fiscal.js');
const tela = require('../../frontend/pdv-universal/pdv-universal.js');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const {
  salvarConfiguracaoFiscalEmpresa,
  obterConfiguracaoFiscalEmpresa
} = require('../../backend/services/fiscal/empresasConfiguracaoFiscal');

const ROOT = path.join(__dirname, '../..');
function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function test01ModuloOficial() {
  const files = fs.readdirSync(path.join(ROOT, 'frontend/erp/js')).filter((f) => /gestao-empresas/.test(f));
  assert.deepStrictEqual(files, ['gestao-empresas-fiscal.js']);
  const app = src('frontend/erp/js/app.js');
  assert.ok(app.includes("cdsErpAsset('/erp/js/gestao-empresas-fiscal.js')"));
  assert.ok(app.includes("case 'empresas':"));
  assert.ok(app.includes("CDS_ERP_ASSET_VERSION"));
  assert.ok(app.includes(": '0519'"));
  assert.ok(!app.includes('05172'));
  assert.ok(!app.includes('?v=0515'));
  assert.ok(!app.includes('?v=0516'));
  assert.strictEqual(globalThis.__CDS_EMPRESAS_MODULE_VERSION, '05.19');
}

function test02SemApiApi() {
  assert.ok(!G.normalizarApiUrl('/empresas').includes('/api/api/'));
  assert.ok(!G.normalizarApiUrl('/api/empresas/2/configuracao-fiscal').includes('/api/api/'));
  assert.strictEqual(G.normalizarApiUrl('/empresas/configuracao-fiscal/status'), '/api/empresas/configuracao-fiscal/status');
  assert.strictEqual(G.urlAbsoluta(G.urlCertificadoUpload()), '/api/fiscal/certificado/upload');
}

function test03a04CriarAbreEdicao() {
  assert.strictEqual(G.resolverEmpresaId({ id: 11 }), 11);
  assert.strictEqual(G.resolverEmpresaId({ empresa_id: 12 }), 12);
  assert.strictEqual(G.resolverEmpresaId({ data: { id: 13 } }), 13);
  const js = src('frontend/erp/js/gestao-empresas-fiscal.js');
  assert.ok(js.includes('await abrirDetalhe(novaId)'));
  assert.ok(js.includes("logEmpresas('id_resolvido'"));
}

function test05a08Abas() {
  const html = G.htmlPainelEdicao(
    { id: 7, razao_social: 'A', cnpj: '11222333000181' },
    G.fiscalVazio(7),
    'Não foi possível atualizar o status fiscal.'
  );
  assert.ok(html.includes('DADOS GERAIS'));
  assert.ok(html.includes('CONFIGURAÇÃO FISCAL'));
  assert.ok(html.includes('CERTIFICADO DIGITAL'));
  assert.ok(html.includes('URLS HOMOLOGAÇÃO'));
  assert.ok(html.includes('URLS PRODUÇÃO'));
  assert.ok(html.includes('TENTAR NOVAMENTE'));
  assert.ok(html.includes('accept=".pfx"'));
}

async function test09a13Isolamento() {
  const db = await new Promise((resolve, reject) => {
    const x = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(x)));
  });
  await garantirSchemaEmpresasAsync(db);
  const a = await EmpresaService.criarEmpresa({ cnpj: '11222333000181', razao_social: 'A19' }, { db });
  const b = await EmpresaService.criarEmpresa({ cnpj: '04252011000110', razao_social: 'B19' }, { db });
  await salvarConfiguracaoFiscalEmpresa(a.id, {
    ambiente: 2, serie: 1, token_csc: 'CSC-A-SECRETO', id_csc: '1',
    certificado_path: `C:/certs/certificado-empresa-${a.id}.pfx`,
    certificado_senha: 'x',
    ws_autorizacao_homologacao: 'https://a/h',
    ws_autorizacao_producao: 'https://a/p'
  }, { db });
  await salvarConfiguracaoFiscalEmpresa(b.id, {
    ambiente: 1, serie: 2, token_csc: 'CSC-B-SECRETO', id_csc: '2',
    certificado_path: `C:/certs/certificado-empresa-${b.id}.pfx`,
    certificado_senha: 'y',
    ws_autorizacao_homologacao: 'https://b/h',
    ws_autorizacao_producao: 'https://b/p'
  }, { db });
  const dtoA = await obterConfiguracaoFiscalEmpresa(a.id, { db });
  const dtoB = await obterConfiguracaoFiscalEmpresa(b.id, { db });
  assert.ok(G.dtoNaoExpoeSegredos(dtoA));
  assert.ok(G.dtoNaoExpoeSegredos(dtoB));
  assert.notStrictEqual(dtoA.urls_homologacao.autorizacao, dtoB.urls_homologacao.autorizacao);
  assert.notStrictEqual(dtoA.urls_producao.autorizacao, dtoB.urls_producao.autorizacao);
  assert.notStrictEqual(dtoA.certificado_nome, dtoB.certificado_nome);
  assert.strictEqual(G.empresaIdDaEdicao(a.id, 1), a.id);
  await new Promise((resolve) => db.close(() => resolve()));
}

function test14a15Pdv() {
  const acesso = src('frontend/shared/js/pdv-acesso-oficial.js');
  assert.ok(acesso.includes('/pdv-universal/'));
  const pdv = src('frontend/pdv-universal/pdv-universal.js');
  assert.ok(pdv.includes("code === 'NENHUMA_EMPRESA_DISPONIVEL'"));
  assert.ok(pdv.includes("acao: 'CADASTRAR'"));
  const err = tela.classificarErroContexto({ status: 409, code: 'NENHUMA_EMPRESA_DISPONIVEL' });
  assert.notStrictEqual(err.acao, 'LOGIN');
}

const testes = [
  ['01 módulo oficial e versão 0519', test01ModuloOficial],
  ['02 sem /api/api', test02SemApiApi],
  ['03-04 criar resolve ID e abre edição', test03a04CriarAbreEdicao],
  ['05-08 três áreas e status não esconde', test05a08Abas],
  ['14-15 PDV rota e 409 sem logout', test14a15Pdv]
];

(async () => {
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log('  ok', nome);
  }
  await test09a13Isolamento();
  ok += 1;
  console.log('  ok 09-13 isolamento A≠B URLs cert GET sem segredo');
  console.log(`\nconsolidacao-operacional-multiempresa-05-19: ${ok}/${ok} OK`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
