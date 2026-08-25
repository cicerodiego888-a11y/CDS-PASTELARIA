'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { salvarConfiguracaoFiscalEmpresa } = require('../../backend/services/fiscal/empresasConfiguracaoFiscal');
const { getFiscalConfig, resolverUrlsEmissao } = require('../../backend/services/fiscal/configService');
const { entregarUrlsAoTransporte } = require('../../backend/services/fiscal/emissor');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

const URL = {
  aH: 'https://empresa-a-homologacao.local/autorizacao',
  aP: 'https://empresa-a-producao.local/autorizacao',
  bH: 'https://empresa-b-homologacao.local/autorizacao',
  bP: 'https://empresa-b-producao.local/autorizacao',
  aQrH: 'https://empresa-a-homologacao.local/qr',
  aQrP: 'https://empresa-a-producao.local/qr',
  bQrH: 'https://empresa-b-homologacao.local/qr',
  bQrP: 'https://empresa-b-producao.local/qr',
  aChH: 'https://empresa-a-homologacao.local/chave',
  aChP: 'https://empresa-a-producao.local/chave',
  bChH: 'https://empresa-b-homologacao.local/chave',
  bChP: 'https://empresa-b-producao.local/chave',
  globalAut: 'https://global-oculto.local/autorizacao'
};

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve();
    });
  });
}

function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_e) { resolve(); }
  });
}

async function setup() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await run(db, `CREATE TABLE configuracoes (chave TEXT PRIMARY KEY, valor TEXT)`);
  await run(db, `INSERT INTO configuracoes (chave, valor) VALUES ('fiscal_ambiente', '2')`);
  await run(db, `INSERT INTO configuracoes (chave, valor) VALUES ('fiscal_ws_autorizacao_homologacao', ?)`, [URL.globalAut]);
  await run(db, `INSERT INTO configuracoes (chave, valor) VALUES ('fiscal_csc_qrcode_url_homologacao', 'https://global/qr')`);
  await run(db, `INSERT INTO configuracoes (chave, valor) VALUES ('fiscal_consulta_chave_url_homologacao', 'https://global/chave')`);
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'Empresa A' }, { db });
  const b = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'Empresa B' }, { db });
  await salvarConfiguracaoFiscalEmpresa(a.id, {
    ambiente: 2,
    serie: 1,
    token_csc: 'CSC-A',
    id_csc: '1',
    certificado_path: 'C:/certs/a.pfx',
    certificado_senha: 'x',
    ws_autorizacao_homologacao: URL.aH,
    ws_autorizacao_producao: URL.aP,
    csc_qrcode_url_homologacao: URL.aQrH,
    csc_qrcode_url_producao: URL.aQrP,
    consulta_chave_url_homologacao: URL.aChH,
    consulta_chave_url_producao: URL.aChP,
    ws_retorno_homologacao: 'https://empresa-a-homologacao.local/retorno',
    ws_status_homologacao: 'https://empresa-a-homologacao.local/status'
  }, { db });
  await salvarConfiguracaoFiscalEmpresa(b.id, {
    ambiente: 2,
    serie: 1,
    token_csc: 'CSC-B',
    id_csc: '1',
    certificado_path: 'C:/certs/b.pfx',
    certificado_senha: 'x',
    ws_autorizacao_homologacao: URL.bH,
    ws_autorizacao_producao: URL.bP,
    csc_qrcode_url_homologacao: URL.bQrH,
    csc_qrcode_url_producao: URL.bQrP,
    consulta_chave_url_homologacao: URL.bChH,
    consulta_chave_url_producao: URL.bChP
  }, { db });
  return { db, a, b };
}

async function configAmbiente(db, empresaId, ambiente) {
  await salvarConfiguracaoFiscalEmpresa(empresaId, { ambiente }, { db });
  return getFiscalConfig({ empresaId, db, validarUrls: true });
}

async function test01a02AxBHomoProd() {
  const ctx = await setup();
  const aH = await configAmbiente(ctx.db, ctx.a.id, 2);
  assert.strictEqual(aH.urls.autorizacao, URL.aH);
  const aP = await configAmbiente(ctx.db, ctx.a.id, 1);
  assert.strictEqual(aP.urls.autorizacao, URL.aP);
  const bH = await configAmbiente(ctx.db, ctx.b.id, 2);
  assert.strictEqual(bH.urls.autorizacao, URL.bH);
  const bP = await configAmbiente(ctx.db, ctx.b.id, 1);
  assert.strictEqual(bP.urls.autorizacao, URL.bP);
  assert.notStrictEqual(aH.urls.autorizacao, bH.urls.autorizacao);
  assert.notStrictEqual(aP.urls.autorizacao, URL.globalAut);
  await closeDb(ctx.db);
}

async function test03SemMisturaAmbiente() {
  const ctx = await setup();
  const aH = await configAmbiente(ctx.db, ctx.a.id, 2);
  assert.strictEqual(aH.urls.consultaQr, URL.aQrH);
  assert.strictEqual(aH.urls.consultaChave, URL.aChH);
  assert.notStrictEqual(aH.urls.autorizacao, URL.aP);
  assert.notStrictEqual(aH.urls.consultaQr, URL.aQrP);
  const aP = await configAmbiente(ctx.db, ctx.a.id, 1);
  assert.strictEqual(aP.urls.consultaQr, URL.aQrP);
  assert.notStrictEqual(aP.urls.consultaQr, URL.aQrH);
  resolverUrlsEmissao(aP);
  await closeDb(ctx.db);
}

async function test04QrChaveIsolados() {
  const ctx = await setup();
  const a = await getFiscalConfig({ empresaId: ctx.a.id, db: ctx.db });
  const b = await getFiscalConfig({ empresaId: ctx.b.id, db: ctx.db });
  assert.strictEqual(a.urls.consultaQr, URL.aQrH);
  assert.strictEqual(b.urls.consultaQr, URL.bQrH);
  assert.strictEqual(a.urls.consultaChave, URL.aChH);
  assert.strictEqual(b.urls.consultaChave, URL.bChH);
  await closeDb(ctx.db);
}

async function test05FallbackGlobalDocumentado() {
  const ctx = await setup();
  const global = await getFiscalConfig({ db: ctx.db, validarUrls: true });
  assert.strictEqual(global.fonte, 'GLOBAL');
  assert.strictEqual(global.empresaId, null);
  assert.strictEqual(global.urls.autorizacao, URL.globalAut);
  await closeDb(ctx.db);
}

async function test06ConfiguradaNaoUsaGlobal() {
  const ctx = await setup();
  const a = await getFiscalConfig({ empresaId: ctx.a.id, db: ctx.db });
  assert.strictEqual(a.fonte, 'EMPRESA');
  assert.strictEqual(a.urls.autorizacao, URL.aH);
  assert.notStrictEqual(a.urls.autorizacao, URL.globalAut);
  await closeDb(ctx.db);
}

async function test07EmpresaSemConfigNaoEsconde() {
  const ctx = await setup();
  const c = await EmpresaService.criarEmpresa({
    cnpj: '65957340000150',
    razao_social: 'Sem config'
  }, { db: ctx.db });
  try {
    await getFiscalConfig({ empresaId: c.id, db: ctx.db, validarUrls: false });
    throw new Error('deveria falhar');
  } catch (err) {
    assert.strictEqual(err.code, 'CONFIGURACAO_FISCAL_EMPRESA_AUSENTE');
  }
  try {
    await getFiscalConfig({ empresaId: 'xyz', db: ctx.db });
    throw new Error('deveria falhar');
  } catch (err) {
    assert.strictEqual(err.code, 'EMPRESA_OBRIGATORIA');
  }
  await closeDb(ctx.db);
}

async function test08EmissorRecebeUrl() {
  const ctx = await setup();
  const capturas = [];
  const mockEnviar = async (pedido) => {
    capturas.push(pedido.url);
    return { success: true, status: 'soap_enviado', body: '<ok/>' };
  };
  const aH = await configAmbiente(ctx.db, ctx.a.id, 2);
  await entregarUrlsAoTransporte(aH, { loteXml: '<enviNFe/>', operacao: 'AUTORIZACAO' }, mockEnviar);
  const aP = await configAmbiente(ctx.db, ctx.a.id, 1);
  await entregarUrlsAoTransporte(aP, { loteXml: '<enviNFe/>', operacao: 'AUTORIZACAO' }, mockEnviar);
  const bH = await configAmbiente(ctx.db, ctx.b.id, 2);
  await entregarUrlsAoTransporte(bH, { loteXml: '<enviNFe/>', operacao: 'AUTORIZACAO' }, mockEnviar);
  const bP = await configAmbiente(ctx.db, ctx.b.id, 1);
  await entregarUrlsAoTransporte(bP, { loteXml: '<enviNFe/>', operacao: 'AUTORIZACAO' }, mockEnviar);
  assert.deepStrictEqual(capturas, [URL.aH, URL.aP, URL.bH, URL.bP]);
  await closeDb(ctx.db);
}

function test09ClassificacaoRetornoStatus() {
  const emissor = fs.readFileSync(path.join(__dirname, '../../backend/services/fiscal/emissor.js'), 'utf8');
  assert.ok(!emissor.includes('urls.retorno') && !emissor.includes('urlsEmissao.retorno'));
  assert.ok(!emissor.includes('urls.status') && !emissor.includes('urlsEmissao.status'));
  const status = fs.readFileSync(path.join(__dirname, '../../backend/services/fiscal/statusServico.js'), 'utf8');
  assert.ok(status.includes('obterUrlLegadoPadrao') || status.includes('RegistryBuilder'));
  assert.ok(!status.includes('config.urls.status'));
  const runtime = fs.readFileSync(path.join(__dirname, '../../backend/services/fiscal/autorizacaoRuntime.js'), 'utf8');
  assert.ok(runtime.includes('indSinc') || fs.readFileSync(path.join(__dirname, '../../backend/services/fiscal/soapClient.js'), 'utf8').includes('indSinc'));
}

function test10CaminhoRealNoCodigo() {
  const empresas = fs.readFileSync(path.join(__dirname, '../../backend/rotas/empresas.js'), 'utf8');
  assert.ok(empresas.includes("router.put('/:empresaId/configuracao-fiscal'"));
  const emissor = fs.readFileSync(path.join(__dirname, '../../backend/services/fiscal/emissor.js'), 'utf8');
  assert.ok(emissor.includes('getFiscalConfig(fiscalOpts)'));
  assert.ok(emissor.includes('entregarUrlsAoTransporte'));
  const muv = fs.readFileSync(path.join(__dirname, '../../backend/motores/muv/FiscalizarAtendimentoService.js'), 'utf8');
  assert.ok(muv.includes('emitirPorVendaId(vendaId, opts'));
}

async function main() {
  const testes = [
    ['01/02 A×B homologação e produção', test01a02AxBHomoProd],
    ['03 sem mistura de ambiente', test03SemMisturaAmbiente],
    ['04 QR e chave isolados', test04QrChaveIsolados],
    ['05 fallback global só sem empresaId', test05FallbackGlobalDocumentado],
    ['06 empresa configurada não usa global', test06ConfiguradaNaoUsaGlobal],
    ['07 ausência não escondida', test07EmpresaSemConfigNaoEsconde],
    ['08 emissor entrega URL ao transporte', test08EmissorRecebeUrl],
    ['09 WS retorno/status classificados', test09ClassificacaoRetornoStatus],
    ['10 caminho real no código', test10CaminhoRealNoCodigo]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  ok ${nome}`);
  }
  console.log(`\nconfiguracao-fiscal-empresa-real-05-18-3: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
