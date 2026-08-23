'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const {
  URL_CAMPOS_AMBIENTE,
  salvarConfiguracaoFiscalEmpresa,
  obterConfiguracaoFiscalEmpresa,
  resolverUrlsEmpresa
} = require('../../backend/services/fiscal/empresasConfiguracaoFiscal');
const { getFiscalConfig } = require('../../backend/services/fiscal/configService');
const G = require('../../frontend/erp/js/gestao-empresas-fiscal.js');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

const MOTOR_JS = [
  'backend/services/fiscal/emissor.js',
  'backend/services/fiscal/configService.js',
  'backend/services/fiscal/empresasConfiguracaoFiscal.js',
  'backend/services/fiscal/autorizacaoRuntime.js',
  'backend/services/fiscal/autorizacaoLegado.js',
  'backend/services/fiscal/core/RegistryBuilder.js',
  'backend/services/fiscal/core/UrlResolver.js',
  'backend/services/fiscal/distribuicaoDFe.js',
  'backend/services/fiscal/cancelarNfce.js',
  'backend/services/fiscal/cancelarNfe.js',
  'backend/services/fiscal/consultaProtocoloLegado.js',
  'backend/services/fiscal/nfeEmissorVenda.js'
];

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
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
  await run(db, `INSERT INTO configuracoes (chave, valor) VALUES ('fiscal_ws_autorizacao_homologacao', 'https://global-oculto/aut')`);
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A URLs' }, { db });
  const b = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B URLs' }, { db });
  return { db, a, b };
}

function test01OrigemIdentificavel() {
  const fontes = {
    autorizacao_config: false,
    consultaQr_config: false,
    consultaChave_config: false,
    retorno_config: false,
    status_config: false,
    catalogo_plataforma: false
  };
  MOTOR_JS.forEach((rel) => {
    const src = fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8');
    if (src.includes('urls.autorizacao') || src.includes('fiscal_ws_autorizacao')) fontes.autorizacao_config = true;
    if (src.includes('consultaQr') || src.includes('fiscal_csc_qrcode_url')) fontes.consultaQr_config = true;
    if (src.includes('consultaChave') || src.includes('fiscal_consulta_chave_url')) fontes.consultaChave_config = true;
    if (src.includes('fiscal_ws_retorno') || src.includes('ws_retorno')) fontes.retorno_config = true;
    if (src.includes('fiscal_ws_status') || src.includes('ws_status')) fontes.status_config = true;
    if (src.includes('ENDPOINTS') || src.includes('RegistryBuilder')) fontes.catalogo_plataforma = true;
  });
  assert.ok(fontes.autorizacao_config);
  assert.ok(fontes.consultaQr_config);
  assert.ok(fontes.consultaChave_config);
  assert.ok(fontes.retorno_config);
  assert.ok(fontes.status_config);
  assert.ok(fontes.catalogo_plataforma);
  assert.strictEqual(URL_CAMPOS_AMBIENTE.length, 10);
}

async function test02HomoNaoApagaProd() {
  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, {
    ambiente: 2,
    serie: 1,
    token_csc: 'CSC-A',
    id_csc: '1',
    ws_autorizacao_homologacao: 'https://h.local/aut',
    ws_autorizacao_producao: 'https://p.local/aut',
    csc_qrcode_url_homologacao: 'https://h.local/qr',
    csc_qrcode_url_producao: 'https://p.local/qr'
  }, { db: ctx.db });
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, { ambiente: 1 }, { db: ctx.db });
  const row = await get(ctx.db, 'SELECT * FROM empresas_configuracao_fiscal WHERE empresa_id=?', [ctx.a.id]);
  assert.strictEqual(row.ws_autorizacao_homologacao, 'https://h.local/aut');
  assert.strictEqual(row.ws_autorizacao_producao, 'https://p.local/aut');
  assert.strictEqual(row.csc_qrcode_url_homologacao, 'https://h.local/qr');
  assert.strictEqual(row.csc_qrcode_url_producao, 'https://p.local/qr');
  const resolved = resolverUrlsEmpresa(row);
  assert.strictEqual(resolved.urls.autorizacao, 'https://p.local/aut');
  assert.strictEqual(resolved.urlsHomologacao.autorizacao, 'https://h.local/aut');
  await closeDb(ctx.db);
}

async function test03IsolamentoAB() {
  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, {
    ambiente: 2, serie: 1, token_csc: 'A', id_csc: '1',
    ws_autorizacao_homologacao: 'https://a/h',
    ws_autorizacao_producao: 'https://a/p'
  }, { db: ctx.db });
  await salvarConfiguracaoFiscalEmpresa(ctx.b.id, {
    ambiente: 2, serie: 1, token_csc: 'B', id_csc: '1',
    ws_autorizacao_homologacao: 'https://b/h',
    ws_autorizacao_producao: 'https://b/p'
  }, { db: ctx.db });
  const dtoA = await obterConfiguracaoFiscalEmpresa(ctx.a.id, { db: ctx.db });
  const dtoB = await obterConfiguracaoFiscalEmpresa(ctx.b.id, { db: ctx.db });
  assert.strictEqual(dtoA.urls_homologacao.autorizacao, 'https://a/h');
  assert.strictEqual(dtoB.urls_homologacao.autorizacao, 'https://b/h');
  assert.notStrictEqual(dtoA.urls_producao.autorizacao, dtoB.urls_producao.autorizacao);
  await closeDb(ctx.db);
}

async function test04GetEmpresa() {
  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, {
    ambiente: 2, serie: 1, token_csc: 'A', id_csc: '1',
    consulta_chave_url_homologacao: 'https://a/chave-h',
    consulta_chave_url_producao: 'https://a/chave-p'
  }, { db: ctx.db });
  const dto = await obterConfiguracaoFiscalEmpresa(ctx.a.id, { db: ctx.db });
  assert.strictEqual(dto.empresa_id, ctx.a.id);
  assert.strictEqual(dto.urls_homologacao.consultaChave, 'https://a/chave-h');
  assert.strictEqual(dto.urls_producao.consultaChave, 'https://a/chave-p');
  assert.ok(!Object.prototype.hasOwnProperty.call(dto, 'token_csc'));
  await closeDb(ctx.db);
}

async function test05PutSoAlvo() {
  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, {
    ambiente: 2, serie: 1, token_csc: 'A', id_csc: '1',
    ws_retorno_homologacao: 'https://a/ret'
  }, { db: ctx.db });
  await salvarConfiguracaoFiscalEmpresa(ctx.b.id, {
    ambiente: 2, serie: 1, token_csc: 'B', id_csc: '1',
    ws_retorno_homologacao: 'https://b/ret'
  }, { db: ctx.db });
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, {
    ws_retorno_homologacao: 'https://a/ret-novo'
  }, { db: ctx.db });
  const a = await obterConfiguracaoFiscalEmpresa(ctx.a.id, { db: ctx.db });
  const b = await obterConfiguracaoFiscalEmpresa(ctx.b.id, { db: ctx.db });
  assert.strictEqual(a.urls_homologacao.retorno, 'https://a/ret-novo');
  assert.strictEqual(b.urls_homologacao.retorno, 'https://b/ret');
  await closeDb(ctx.db);
}

async function test06SemUrlGlobalOcultaNaEmpresa() {
  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, {
    ambiente: 2, serie: 1, token_csc: 'A', id_csc: '1',
    certificado_path: 'C:/a.pfx', certificado_senha: 'x',
    ws_autorizacao_homologacao: 'https://empresa-a/aut'
  }, { db: ctx.db });
  const cfg = await getFiscalConfig({ empresaId: ctx.a.id, db: ctx.db, validarUrls: true });
  assert.strictEqual(cfg.fonte, 'EMPRESA');
  assert.strictEqual(cfg.empresaId, ctx.a.id);
  assert.strictEqual(cfg.urls.autorizacao, 'https://empresa-a/aut');
  assert.notStrictEqual(cfg.urls.autorizacao, 'https://global-oculto/aut');
  await closeDb(ctx.db);
}

function test07TelaExibeContrato() {
  const html = G.htmlPainelEdicao(
    { id: 4, razao_social: 'X', cnpj: '1' },
    {
      ...G.fiscalVazio(4),
      urls_homologacao: { autorizacao: 'https://h/a', retorno: '', status: '', consultaQr: '', consultaChave: '' },
      urls_producao: { autorizacao: 'https://p/a', retorno: '', status: '', consultaQr: '', consultaChave: '' }
    },
    ''
  );
  assert.ok(html.includes('URLS HOMOLOGAÇÃO'));
  assert.ok(html.includes('URLS PRODUÇÃO'));
  assert.ok(html.includes('URL Consulta QRCode'));
  assert.ok(html.includes('URL Consulta Chave'));
  assert.ok(html.includes('WS Autorização'));
  assert.ok(html.includes('WS Retorno'));
  assert.ok(html.includes('WS Status'));
  assert.ok(html.includes('gef-h-aut'));
  assert.ok(html.includes('gef-p-aut'));
  assert.ok(html.includes('https://h/a'));
  assert.ok(html.includes('https://p/a'));
  assert.ok(!html.includes('WS Cancelamento'));
  assert.ok(!html.includes('WS Inutilização'));
  assert.ok(!html.includes('WS Consulta Cadastro'));
  assert.ok(!html.includes('WS Distribuição DF-e'));
}

async function test08PutVazioNaoApagaUrl() {
  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, {
    ambiente: 2, serie: 1, token_csc: 'A', id_csc: '1',
    ws_status_producao: 'https://a/st-p'
  }, { db: ctx.db });
  const p = G.montarPayloadFiscal({ ws_status_producao: '', serie: 2 }, ctx.a.id);
  assert.ok(!Object.prototype.hasOwnProperty.call(p, 'ws_status_producao'));
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, p, { db: ctx.db });
  const dto = await obterConfiguracaoFiscalEmpresa(ctx.a.id, { db: ctx.db });
  assert.strictEqual(dto.urls_producao.status, 'https://a/st-p');
  await closeDb(ctx.db);
}

async function main() {
  const testes = [
    ['01 origem identificável no motor', test01OrigemIdentificavel],
    ['02 homologação não apaga produção', test02HomoNaoApagaProd],
    ['03 isolamento A≠B', test03IsolamentoAB],
    ['04 GET da empresa', test04GetEmpresa],
    ['05 PUT só no alvo', test05PutSoAlvo],
    ['06 emissão empresa não usa URL global', test06SemUrlGlobalOcultaNaEmpresa],
    ['07 tela com campos do contrato', test07TelaExibeContrato],
    ['08 PUT vazio não apaga URL', test08PutVazioNaoApagaUrl]
  ];
  let ok = 0;
  for (const [nome, fn] of testes) {
    await fn();
    ok += 1;
    console.log(`  ok ${nome}`);
  }
  console.log(`\nurls-fiscais-05-18-2: ${ok}/${testes.length} OK`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
