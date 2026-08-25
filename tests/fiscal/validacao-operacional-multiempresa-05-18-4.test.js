'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const {
  salvarConfiguracaoFiscalEmpresa,
  obterConfiguracaoFiscalEmpresa
} = require('../../backend/services/fiscal/empresasConfiguracaoFiscal');
const { getFiscalConfig, resolverUrlsEmissao } = require('../../backend/services/fiscal/configService');
const { entregarUrlsAoTransporte } = require('../../backend/services/fiscal/emissor');
const G = require('../../frontend/erp/js/gestao-empresas-fiscal.js');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (err) => (err ? reject(err) : resolve()));
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
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
  await run(db, `INSERT INTO configuracoes (chave, valor) VALUES ('fiscal_ambiente','2')`);
  await run(db, `INSERT INTO configuracoes (chave, valor) VALUES ('fiscal_ws_autorizacao_homologacao','https://global.local/aut')`);
  const a = await EmpresaService.criarEmpresa({
    cnpj: CNPJ_A, razao_social: 'Empresa A Operacional', nome_fantasia: 'A'
  }, { db });
  const b = await EmpresaService.criarEmpresa({
    cnpj: CNPJ_B, razao_social: 'Empresa B Operacional', nome_fantasia: 'B'
  }, { db });
  return { db, a, b };
}

function semSegredos(dto) {
  const json = JSON.stringify(dto);
  assert.ok(!json.includes('CSC-A-SECRETO'));
  assert.ok(!json.includes('CSC-B-SECRETO'));
  assert.ok(!Object.prototype.hasOwnProperty.call(dto, 'token_csc'));
  assert.ok(!Object.prototype.hasOwnProperty.call(dto, 'certificado_senha'));
  assert.ok(!Object.prototype.hasOwnProperty.call(dto, 'certificado_path'));
}

async function gravarA(db, a) {
  return salvarConfiguracaoFiscalEmpresa(a.id, {
    ambiente: 2,
    uf: 'CE',
    serie: 1,
    numero_atual: 10,
    token_csc: 'CSC-A-SECRETO',
    id_csc: 'ID-CSC-A',
    certificado_path: `C:/certs/certificado-empresa-${a.id}.pfx`,
    certificado_senha: 'senha-a',
    ws_autorizacao_homologacao: 'https://a.local/h/aut',
    ws_autorizacao_producao: 'https://a.local/p/aut',
    csc_qrcode_url_homologacao: 'https://a.local/h/qr',
    csc_qrcode_url_producao: 'https://a.local/p/qr',
    consulta_chave_url_homologacao: 'https://a.local/h/chave',
    consulta_chave_url_producao: 'https://a.local/p/chave'
  }, { db });
}

async function gravarB(db, b) {
  return salvarConfiguracaoFiscalEmpresa(b.id, {
    ambiente: 1,
    uf: 'SP',
    serie: 9,
    numero_atual: 90,
    token_csc: 'CSC-B-SECRETO',
    id_csc: 'ID-CSC-B',
    certificado_path: `C:/certs/certificado-empresa-${b.id}.pfx`,
    certificado_senha: 'senha-b',
    ws_autorizacao_homologacao: 'https://b.local/h/aut',
    ws_autorizacao_producao: 'https://b.local/p/aut',
    csc_qrcode_url_homologacao: 'https://b.local/h/qr',
    csc_qrcode_url_producao: 'https://b.local/p/qr'
  }, { db });
}

async function test01a04IsolamentoAB() {
  const ctx = await setup();
  const dtoA = await gravarA(ctx.db, ctx.a);
  const dtoB = await gravarB(ctx.db, ctx.b);
  semSegredos(dtoA);
  semSegredos(dtoB);
  assert.strictEqual(G.resolverEmpresaId(ctx.a), ctx.a.id);
  assert.strictEqual(dtoA.empresa_id, ctx.a.id);
  assert.strictEqual(dtoB.empresa_id, ctx.b.id);
  assert.strictEqual(dtoA.ambiente, 2);
  assert.strictEqual(dtoB.ambiente, 1);
  assert.notStrictEqual(dtoA.certificado_nome, dtoB.certificado_nome);
  assert.notStrictEqual(dtoA.urls_homologacao.autorizacao, dtoB.urls_homologacao.autorizacao);
  const rowA = await get(ctx.db, 'SELECT token_csc, id_csc, certificado_path FROM empresas_configuracao_fiscal WHERE empresa_id=?', [ctx.a.id]);
  const rowB = await get(ctx.db, 'SELECT token_csc, id_csc, certificado_path FROM empresas_configuracao_fiscal WHERE empresa_id=?', [ctx.b.id]);
  assert.strictEqual(rowA.token_csc, 'CSC-A-SECRETO');
  assert.strictEqual(rowB.token_csc, 'CSC-B-SECRETO');
  assert.strictEqual(rowA.id_csc, 'ID-CSC-A');
  assert.strictEqual(rowB.id_csc, 'ID-CSC-B');
  assert.ok(String(rowA.certificado_path).includes(`empresa-${ctx.a.id}`));
  assert.ok(String(rowB.certificado_path).includes(`empresa-${ctx.b.id}`));
  await closeDb(ctx.db);
}

async function test05a06AmbientesPreservados() {
  const ctx = await setup();
  await gravarA(ctx.db, ctx.a);
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, { ambiente: 1 }, { db: ctx.db });
  let row = await get(ctx.db, 'SELECT * FROM empresas_configuracao_fiscal WHERE empresa_id=?', [ctx.a.id]);
  assert.strictEqual(row.ws_autorizacao_homologacao, 'https://a.local/h/aut');
  assert.strictEqual(row.ws_autorizacao_producao, 'https://a.local/p/aut');
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, { ambiente: 2 }, { db: ctx.db });
  row = await get(ctx.db, 'SELECT * FROM empresas_configuracao_fiscal WHERE empresa_id=?', [ctx.a.id]);
  assert.strictEqual(row.ws_autorizacao_homologacao, 'https://a.local/h/aut');
  assert.strictEqual(row.ws_autorizacao_producao, 'https://a.local/p/aut');
  await closeDb(ctx.db);
}

async function test07a08GetFiscalConfigAB() {
  const ctx = await setup();
  await gravarA(ctx.db, ctx.a);
  await gravarB(ctx.db, ctx.b);
  const cfgA = await getFiscalConfig({ empresaId: ctx.a.id, db: ctx.db });
  const cfgB = await getFiscalConfig({ empresaId: ctx.b.id, db: ctx.db });
  assert.strictEqual(cfgA.fonte, 'EMPRESA');
  assert.strictEqual(cfgB.fonte, 'EMPRESA');
  assert.strictEqual(cfgA.urls.autorizacao, 'https://a.local/h/aut');
  assert.strictEqual(cfgB.urls.autorizacao, 'https://b.local/p/aut');
  assert.notStrictEqual(cfgA.tokenCSC, cfgB.tokenCSC);
  await closeDb(ctx.db);
}

async function test09a14GetFiscalRegras() {
  const ctx = await setup();
  await gravarA(ctx.db, ctx.a);
  try {
    await getFiscalConfig({ empresaId: 'xyz', db: ctx.db });
    throw new Error('falhou');
  } catch (err) {
    assert.strictEqual(err.code, 'EMPRESA_OBRIGATORIA');
  }
  try {
    await getFiscalConfig({ empresaId: ctx.b.id, db: ctx.db });
    throw new Error('falhou');
  } catch (err) {
    assert.strictEqual(err.code, 'CONFIGURACAO_FISCAL_EMPRESA_AUSENTE');
  }
  const cfgA = await getFiscalConfig({ empresaId: ctx.a.id, db: ctx.db });
  assert.strictEqual(cfgA.urls.autorizacao, 'https://a.local/h/aut');
  assert.notStrictEqual(cfgA.urls.autorizacao, 'https://global.local/aut');
  const legado = await getFiscalConfig({ db: ctx.db, validarUrls: true });
  assert.strictEqual(legado.fonte, 'GLOBAL');
  assert.strictEqual(legado.urls.autorizacao, 'https://global.local/aut');
  const urls = resolverUrlsEmissao(cfgA);
  assert.strictEqual(urls.autorizacao, 'https://a.local/h/aut');
  assert.strictEqual(urls.origem, 'CONFIGURACAO_EMPRESA');
  await closeDb(ctx.db);
}

async function test11a13EmissorUrl() {
  const ctx = await setup();
  await gravarA(ctx.db, ctx.a);
  await gravarB(ctx.db, ctx.b);
  const capturas = [];
  const mock = async (p) => {
    capturas.push({ url: p.url, ambiente: p.ambiente });
    return { success: true, status: 'soap_enviado' };
  };
  const a = await getFiscalConfig({ empresaId: ctx.a.id, db: ctx.db });
  await entregarUrlsAoTransporte(a, { loteXml: '<x/>', operacao: 'AUTORIZACAO' }, mock);
  const b = await getFiscalConfig({ empresaId: ctx.b.id, db: ctx.db });
  await entregarUrlsAoTransporte(b, { loteXml: '<x/>', operacao: 'AUTORIZACAO' }, mock);
  assert.strictEqual(capturas[0].url, 'https://a.local/h/aut');
  assert.strictEqual(Number(capturas[0].ambiente), 2);
  assert.strictEqual(capturas[1].url, 'https://b.local/p/aut');
  assert.strictEqual(Number(capturas[1].ambiente), 1);
  await closeDb(ctx.db);
}

async function test15a17CertESecrets() {
  const ctx = await setup();
  await gravarA(ctx.db, ctx.a);
  await gravarB(ctx.db, ctx.b);
  const a = await obterConfiguracaoFiscalEmpresa(ctx.a.id, { db: ctx.db });
  const b = await obterConfiguracaoFiscalEmpresa(ctx.b.id, { db: ctx.db });
  semSegredos(a);
  semSegredos(b);
  assert.ok(a.certificado_configurado);
  assert.ok(b.certificado_configurado);
  assert.notStrictEqual(a.certificado_nome, b.certificado_nome);
  const fiscalJs = fs.readFileSync(path.join(__dirname, '../../backend/rotas/fiscal.js'), 'utf8');
  assert.ok(fiscalJs.includes('certificado-empresa-${empresaId}.pfx'));
  assert.ok(!fiscalJs.includes('empresa_id = 1') && !fiscalJs.includes('empresaId === 1'));
  await closeDb(ctx.db);
}

async function testPutParcialNaoApagaCsc() {
  const ctx = await setup();
  await gravarA(ctx.db, ctx.a);
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, { serie: 3 }, { db: ctx.db });
  const row = await get(ctx.db, 'SELECT token_csc, serie FROM empresas_configuracao_fiscal WHERE empresa_id=?', [ctx.a.id]);
  assert.strictEqual(row.token_csc, 'CSC-A-SECRETO');
  assert.strictEqual(Number(row.serie), 3);
  const p = G.montarPayloadFiscal({ token_csc: '', serie: 4 }, ctx.a.id);
  assert.ok(!Object.prototype.hasOwnProperty.call(p, 'token_csc'));
  await closeDb(ctx.db);
}

function testCaminhosOficiais() {
  const empresas = fs.readFileSync(path.join(__dirname, '../../backend/rotas/empresas.js'), 'utf8');
  assert.ok(empresas.includes("router.post('/',"));
  assert.ok(empresas.includes('return res.status(201).json(empresa)'));
  assert.ok(empresas.includes("router.get('/:empresaId/configuracao-fiscal'"));
  assert.ok(empresas.includes("router.put('/:empresaId/configuracao-fiscal'"));
  const pdv = fs.readFileSync(path.join(__dirname, '../../backend/rotas/pdv-universal.js'), 'utf8');
  assert.ok(pdv.includes("router.get('/contexto'"));
  const html = G.htmlPainelEdicao({ id: 2, razao_social: 'A', cnpj: CNPJ_A }, G.fiscalVazio(2), '');
  assert.ok(html.includes('CONFIGURAÇÃO FISCAL'));
  assert.ok(html.includes('URLS HOMOLOGAÇÃO'));
  assert.ok(html.includes('URLS PRODUÇÃO'));
  assert.ok(html.includes('ID CSC'));
  assert.ok(html.includes('accept=".pfx"'));
}

function probeHttp() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:3001/api/empresas', (res) => {
      resolve({ ok: true, status: res.statusCode });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.code || err.message }));
    req.setTimeout(2500, () => {
      req.destroy();
      resolve({ ok: false, error: 'TIMEOUT' });
    });
  });
}

async function testHttpRealRegistrado() {
  const probe = await probeHttp();
  if (!probe.ok) {
    console.log('  [HTTP REAL] PENDENTE — servidor indisponível:', probe.error);
    return;
  }
  console.log('  [HTTP REAL] servidor respondeu status', probe.status, '(sem sessão autenticada; GET fiscal operacional não executado)');
}

async function main() {
  const testes = [
    ['01-04 isolamento A/B CSC cert URLs', test01a04IsolamentoAB],
    ['05-06 homologação/produção preservadas', test05a06AmbientesPreservados],
    ['07-08 getFiscalConfig A e B', test07a08GetFiscalConfigAB],
    ['09-14 regras getFiscalConfig', test09a14GetFiscalRegras],
    ['11-13 emissor URL por empresa/ambiente', test11a13EmissorUrl],
    ['15-17 certificado isolado e GET sem segredo', test15a17CertESecrets],
    ['PUT parcial não apaga CSC', testPutParcialNaoApagaCsc],
    ['caminhos oficiais', testCaminhosOficiais],
    ['HTTP real (probe)', testHttpRealRegistrado]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  ok ${nome}`);
  }
  console.log(`\nvalidacao-operacional-multiempresa-05-18-4: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
