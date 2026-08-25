'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const G = require('../../frontend/erp/js/gestao-empresas-fiscal.js');
const appJs = fs.readFileSync(path.join(__dirname, '../../frontend/erp/js/app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(__dirname, '../../frontend/erp/index.html'), 'utf8');
const centro = fs.readFileSync(path.join(__dirname, '../../frontend/erp/js/cds-centro-configuracoes.js'), 'utf8');
const empresasRota = fs.readFileSync(path.join(__dirname, '../../backend/rotas/empresas.js'), 'utf8');
const fiscalRota = fs.readFileSync(path.join(__dirname, '../../backend/rotas/fiscal.js'), 'utf8');

function test01CaminhoMenu() {
  assert.ok(indexHtml.includes('data-page="configuracoes-avancadas"'));
  assert.ok(!indexHtml.includes('data-page="empresas"'));
  assert.ok(centro.includes("loadPage('empresas')") || centro.includes('loadPage("empresas")'));
  assert.ok(centro.includes('btnAbrirGestaoEmpresas'));
}

function test02ModuloUnico() {
  assert.ok(appJs.includes("empresas: [cdsErpAsset('/erp/js/gestao-empresas-fiscal.js')]"));
  assert.ok(appJs.includes("case 'empresas':"));
  assert.ok(appJs.includes('loadGestaoEmpresasFiscal()'));
  const glob = fs.readdirSync(path.join(__dirname, '../../frontend/erp/js'))
    .filter((f) => /gestao-empresas/.test(f));
  assert.deepStrictEqual(glob, ['gestao-empresas-fiscal.js']);
}

function test03VersaoModulo() {
  assert.strictEqual(globalThis.__CDS_EMPRESAS_MODULE_VERSION, '05.19');
}

function test04NovaEmpresaSoGerais() {
  const html = G.htmlFormNovaEmpresa();
  assert.ok(G.empresaNovaNaoMostraFiscal(html));
  assert.ok(html.includes('SALVAR EMPRESA'));
  assert.ok(!html.includes('gef-id-csc'));
}

function test05ResolverEmpresaIdOficial() {
  assert.strictEqual(G.resolverEmpresaId({ id: 44 }), 44);
  assert.strictEqual(G.resolverEmpresaId({ empresa_id: 45 }), 45);
  assert.strictEqual(G.resolverEmpresaId({ empresaId: 46 }), 46);
  assert.strictEqual(G.resolverEmpresaId({ data: { id: 47 } }), 47);
  assert.strictEqual(G.resolverEmpresaId({ data: { empresa_id: 48 } }), 48);
  assert.strictEqual(G.resolverEmpresaId({}), null);
  assert.strictEqual(G.resolverEmpresaId(1), 1);
}

function test06EdicaoTresAbas() {
  const html = G.htmlPainelEdicao(
    { id: 9, razao_social: 'Loja A', cnpj: '11222333000181' },
    G.fiscalVazio(9),
    ''
  );
  assert.ok(html.includes('data-gef-tab="gerais">DADOS GERAIS'));
  assert.ok(html.includes('data-gef-tab="fiscal">CONFIGURAÇÃO FISCAL'));
  assert.ok(html.includes('data-gef-tab="cert">CERTIFICADO DIGITAL'));
  assert.ok(html.includes('data-gef-edicao="1"'));
}

function test07StatusFalhaNaoRemoveAbas() {
  const html = G.htmlPainelEdicao(
    { id: 9, razao_social: 'Loja A', cnpj: '11222333000181' },
    G.fiscalVazio(9),
    'Não foi possível atualizar o status fiscal.'
  );
  assert.ok(html.includes('Não foi possível atualizar o status fiscal.'));
  assert.ok(html.includes('TENTAR NOVAMENTE'));
  assert.ok(html.includes('DADOS GERAIS'));
  assert.ok(html.includes('CONFIGURAÇÃO FISCAL'));
  assert.ok(html.includes('CERTIFICADO DIGITAL'));
}

function test08CscVisivelNoHtml() {
  const html = G.htmlPainelEdicao({ id: 3, razao_social: 'X', cnpj: '1' }, {
    ...G.fiscalVazio(3),
    csc_configurado: true,
    id_csc_configurado: true
  }, '');
  assert.ok(html.includes('ID CSC'));
  assert.ok(html.includes('CSC / TOKEN CSC'));
  assert.ok(html.includes('id="gef-id-csc"'));
  assert.ok(html.includes('id="gef-csc"'));
  assert.ok(html.includes('CONFIGURADO'));
}

function test09CertificadoPfx() {
  const html = G.htmlPainelEdicao({ id: 3, razao_social: 'X', cnpj: '1' }, G.fiscalVazio(3), '');
  assert.ok(html.includes('type="file"'));
  assert.ok(html.includes('accept=".pfx"'));
  assert.ok(html.includes('id="gef-pfx-senha"'));
  assert.ok(html.includes('CERTIFICADO DIGITAL DA EMPRESA'));
  assert.ok(html.includes('ENVIAR CERTIFICADO'));
}

function test10UploadUsaEmpresaDaTela() {
  assert.strictEqual(G.empresaIdDaEdicao(12, 1), 12);
  assert.strictEqual(G.empresaIdDaEdicao(12, 99), 12);
  assert.strictEqual(G.empresaIdDaEdicao(null, 1), null);
  assert.strictEqual(G.urlCertificadoUpload(), '/api/fiscal/certificado/upload');
}

function test11RotasOficiais() {
  assert.ok(empresasRota.includes("router.get('/:empresaId/configuracao-fiscal'"));
  assert.ok(empresasRota.includes("router.put('/:empresaId/configuracao-fiscal'"));
  assert.ok(empresasRota.includes("router.post('/',"));
  assert.ok(fiscalRota.includes("router.post('/certificado/upload'"));
  assert.strictEqual(G.urlGetFiscal(8), '/api/empresas/8/configuracao-fiscal');
  assert.strictEqual(G.urlPutFiscal(8), '/api/empresas/8/configuracao-fiscal');
}

function test12CacheBustUnico() {
  assert.ok(appJs.includes("CDS_ERP_ASSET_VERSION"));
  assert.ok(!appJs.includes('0518'));
  assert.ok(!appJs.includes('05171'));
}

const testes = [
  ['01 menu Configurações Avançadas → Empresas', test01CaminhoMenu],
  ['02 um módulo oficial', test02ModuloUnico],
  ['03 versão 05.18', test03VersaoModulo],
  ['04 nova empresa só dados gerais', test04NovaEmpresaSoGerais],
  ['05 resolverEmpresaId', test05ResolverEmpresaIdOficial],
  ['06 três abas na edição', test06EdicaoTresAbas],
  ['07 status falha mantém abas', test07StatusFalhaNaoRemoveAbas],
  ['08 ID CSC e TOKEN no HTML', test08CscVisivelNoHtml],
  ['09 PFX e senha no HTML', test09CertificadoPfx],
  ['10 upload usa empresa da tela', test10UploadUsaEmpresaDaTela],
  ['11 rotas oficiais', test11RotasOficiais],
  ['12 versão de cache única', test12CacheBustUnico]
];

let ok = 0;
for (const [nome, fn] of testes) {
  fn();
  ok += 1;
  console.log(`  ok ${nome}`);
}
console.log(`\ngestao-empresas-fluxo-visual-05-18: ${ok}/${testes.length} OK`);
