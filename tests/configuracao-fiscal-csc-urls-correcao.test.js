/**
 * Correção CSC + URLs fiscais — persistência e resolução oficial.
 */
'use strict';

const assert = require('assert');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const EmpresaService = require('../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../backend/services/empresas/empresasSchema');
const {
  salvarConfiguracaoFiscalEmpresa,
  obterConfiguracaoFiscalEmpresa
} = require('../backend/services/fiscal/empresasConfiguracaoFiscal');
const {
  resolverUrlsOficiaisNfce,
  ehPlaceholderCsc,
  sanitizarPatchCsc,
  PLACEHOLDER_CSC_UI
} = require('../backend/services/fiscal/FiscalConfigUrlsResolver');
const {
  dtoPublicoFiscalParaUi,
  filtrarPayloadConfigFiscalUi,
  setConfiguracao,
  getFiscalConfig
} = require('../backend/services/fiscal/configService');
const G = require('../frontend/erp/js/gestao-empresas-fiscal.js');
const { ENDPOINTS } = require('../backend/services/fiscal/core/RegistryBuilder');
const { EnvironmentType } = require('../backend/services/fiscal/core/EnvironmentType');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

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
  await run(db, `CREATE TABLE configuracoes (
    chave TEXT PRIMARY KEY, valor TEXT, tipo TEXT, descricao TEXT, updated_at TEXT
  )`);
  const a = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A CSC' }, { db });
  const b = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B CSC' }, { db });
  return { db, a, b };
}

async function test01SalvarIdCsc() {
  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, { id_csc: '000001', ambiente: 2, serie: 1 }, { db: ctx.db });
  const row = await get(ctx.db, 'SELECT id_csc FROM empresas_configuracao_fiscal WHERE empresa_id=?', [ctx.a.id]);
  assert.strictEqual(row.id_csc, '000001');
  const dto = await obterConfiguracaoFiscalEmpresa(ctx.a.id, { db: ctx.db });
  assert.strictEqual(dto.id_csc, '000001');
  assert.strictEqual(dto.id_csc_configurado, true);
  await closeDb(ctx.db);
}

async function test02SalvarTokenCsc() {
  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, {
    id_csc: '000001',
    token_csc: 'TOKEN_SECRETO_A',
    ambiente: 2,
    serie: 1
  }, { db: ctx.db });
  const row = await get(ctx.db, 'SELECT token_csc FROM empresas_configuracao_fiscal WHERE empresa_id=?', [ctx.a.id]);
  assert.strictEqual(row.token_csc, 'TOKEN_SECRETO_A');
  await closeDb(ctx.db);
}

async function test03GetMascaraToken() {
  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, {
    id_csc: '000001',
    token_csc: 'TOKEN_SECRETO_A',
    ambiente: 2,
    serie: 1
  }, { db: ctx.db });
  const dto = await obterConfiguracaoFiscalEmpresa(ctx.a.id, { db: ctx.db });
  assert.strictEqual(dto.csc_configurado, true);
  assert.ok(!Object.prototype.hasOwnProperty.call(dto, 'token_csc'));
  assert.ok(!JSON.stringify(dto).includes('TOKEN_SECRETO_A'));
  assert.strictEqual(dto.id_csc, '000001');
  await closeDb(ctx.db);
}

async function test04EditarOutroCampoPreservaCsc() {
  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, {
    id_csc: '000001',
    token_csc: 'TOKEN_SECRETO_A',
    ambiente: 2,
    serie: 1
  }, { db: ctx.db });
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, { serie: 9, token_csc: '', id_csc: '' }, { db: ctx.db });
  const row = await get(ctx.db, 'SELECT token_csc, id_csc, serie FROM empresas_configuracao_fiscal WHERE empresa_id=?', [ctx.a.id]);
  assert.strictEqual(row.token_csc, 'TOKEN_SECRETO_A');
  assert.strictEqual(row.id_csc, '000001');
  assert.strictEqual(Number(row.serie), 9);
  await closeDb(ctx.db);
}

async function test05SubstituirCsc() {
  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, {
    id_csc: '000001',
    token_csc: 'TOKEN_SECRETO_A',
    ambiente: 2,
    serie: 1
  }, { db: ctx.db });
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, { token_csc: 'TOKEN_NOVO' }, { db: ctx.db });
  const row = await get(ctx.db, 'SELECT token_csc, id_csc FROM empresas_configuracao_fiscal WHERE empresa_id=?', [ctx.a.id]);
  assert.strictEqual(row.token_csc, 'TOKEN_NOVO');
  assert.strictEqual(row.id_csc, '000001');
  await closeDb(ctx.db);
}

async function test06PlaceholderNuncaPersiste() {
  assert.ok(ehPlaceholderCsc(PLACEHOLDER_CSC_UI));
  assert.ok(ehPlaceholderCsc(''));
  const patch = sanitizarPatchCsc({
    token_csc: PLACEHOLDER_CSC_UI,
    id_csc: '000002',
    serie: 1
  });
  assert.ok(!Object.prototype.hasOwnProperty.call(patch, 'token_csc'));
  assert.strictEqual(patch.id_csc, '000002');

  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, {
    id_csc: '000001',
    token_csc: 'TOKEN_SECRETO_A',
    ambiente: 2,
    serie: 1
  }, { db: ctx.db });
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, {
    token_csc: PLACEHOLDER_CSC_UI,
    serie: 3
  }, { db: ctx.db });
  const row = await get(ctx.db, 'SELECT token_csc FROM empresas_configuracao_fiscal WHERE empresa_id=?', [ctx.a.id]);
  assert.strictEqual(row.token_csc, 'TOKEN_SECRETO_A');
  assert.notStrictEqual(row.token_csc, PLACEHOLDER_CSC_UI);

  const pFront = G.montarPayloadFiscal({
    token_csc: PLACEHOLDER_CSC_UI,
    id_csc: '000009',
    serie: 1
  }, ctx.a.id);
  assert.ok(!Object.prototype.hasOwnProperty.call(pFront, 'token_csc'));
  assert.strictEqual(pFront.id_csc, '000009');
  await closeDb(ctx.db);
}

async function test07AlterarSoIdPreservaToken() {
  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, {
    id_csc: '000001',
    token_csc: 'TOKEN_SECRETO_A',
    ambiente: 2,
    serie: 1
  }, { db: ctx.db });
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, { id_csc: '000002' }, { db: ctx.db });
  const row = await get(ctx.db, 'SELECT token_csc, id_csc FROM empresas_configuracao_fiscal WHERE empresa_id=?', [ctx.a.id]);
  assert.strictEqual(row.id_csc, '000002');
  assert.strictEqual(row.token_csc, 'TOKEN_SECRETO_A');
  await closeDb(ctx.db);
}

async function test08MultiempresaIsolaCsc() {
  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, {
    id_csc: '000001', token_csc: 'TOKEN_A', ambiente: 2, serie: 1
  }, { db: ctx.db });
  await salvarConfiguracaoFiscalEmpresa(ctx.b.id, {
    id_csc: '000002', token_csc: 'TOKEN_B', ambiente: 2, serie: 1
  }, { db: ctx.db });
  const a = await get(ctx.db, 'SELECT token_csc, id_csc FROM empresas_configuracao_fiscal WHERE empresa_id=?', [ctx.a.id]);
  const b = await get(ctx.db, 'SELECT token_csc, id_csc FROM empresas_configuracao_fiscal WHERE empresa_id=?', [ctx.b.id]);
  assert.strictEqual(a.id_csc, '000001');
  assert.strictEqual(b.id_csc, '000002');
  assert.strictEqual(a.token_csc, 'TOKEN_A');
  assert.strictEqual(b.token_csc, 'TOKEN_B');
  const dtoA = await obterConfiguracaoFiscalEmpresa(ctx.a.id, { db: ctx.db });
  const dtoB = await obterConfiguracaoFiscalEmpresa(ctx.b.id, { db: ctx.db });
  assert.strictEqual(dtoA.id_csc, '000001');
  assert.strictEqual(dtoB.id_csc, '000002');
  await closeDb(ctx.db);
}

function test09UrlProducaoOficial() {
  const u = resolverUrlsOficiaisNfce({ uf: 'CE', ambiente: 1 });
  assert.strictEqual(u.autorizacao, ENDPOINTS.NFCE_AUTORIZACAO[EnvironmentType.PRODUCAO]);
  assert.strictEqual(u.retorno, ENDPOINTS.NFCE_RETORNO[EnvironmentType.PRODUCAO]);
  assert.strictEqual(u.status, ENDPOINTS.NFCE_STATUS[EnvironmentType.PRODUCAO]);
  assert.ok(u.consultaQr.includes('nfce.sefaz.ce.gov.br'));
}

function test10UrlHomologacaoOficial() {
  const u = resolverUrlsOficiaisNfce({ uf: 'CE', ambiente: 2 });
  assert.strictEqual(u.autorizacao, ENDPOINTS.NFCE_AUTORIZACAO[EnvironmentType.HOMOLOGACAO]);
  assert.strictEqual(u.retorno, ENDPOINTS.NFCE_RETORNO[EnvironmentType.HOMOLOGACAO]);
  assert.ok(u.consultaQr.includes('nfceh.sefaz.ce.gov.br'));
}

async function test11UrlManualNaoSobrescrita() {
  const ctx = await setup();
  const manual = 'https://manual.exemplo/autorizacao';
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, {
    ambiente: 2,
    serie: 1,
    id_csc: '1',
    token_csc: 'X',
    ws_autorizacao_homologacao: manual
  }, { db: ctx.db });
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, { serie: 2 }, { db: ctx.db });
  const row = await get(ctx.db, 'SELECT ws_autorizacao_homologacao FROM empresas_configuracao_fiscal WHERE empresa_id=?', [ctx.a.id]);
  assert.strictEqual(row.ws_autorizacao_homologacao, manual);
  await closeDb(ctx.db);
}

async function test12UrlsVaziasPreenchidasEAmbiente() {
  const ctx = await setup();
  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, {
    ambiente: 2,
    uf: 'CE',
    serie: 1,
    id_csc: '1',
    token_csc: 'X'
  }, { db: ctx.db });
  const row = await get(ctx.db, 'SELECT * FROM empresas_configuracao_fiscal WHERE empresa_id=?', [ctx.a.id]);
  assert.strictEqual(
    row.ws_autorizacao_homologacao,
    ENDPOINTS.NFCE_AUTORIZACAO[EnvironmentType.HOMOLOGACAO]
  );
  assert.strictEqual(
    row.ws_autorizacao_producao,
    ENDPOINTS.NFCE_AUTORIZACAO[EnvironmentType.PRODUCAO]
  );
  const dto = await obterConfiguracaoFiscalEmpresa(ctx.a.id, { db: ctx.db });
  assert.ok(dto.urls_homologacao.autorizacao);
  assert.ok(dto.urls_producao.autorizacao);

  await salvarConfiguracaoFiscalEmpresa(ctx.a.id, { ambiente: 1 }, { db: ctx.db });
  const row2 = await get(ctx.db, 'SELECT ambiente, ws_autorizacao_homologacao, ws_autorizacao_producao FROM empresas_configuracao_fiscal WHERE empresa_id=?', [ctx.a.id]);
  assert.strictEqual(Number(row2.ambiente), 1);
  assert.strictEqual(row2.ws_autorizacao_homologacao, ENDPOINTS.NFCE_AUTORIZACAO[EnvironmentType.HOMOLOGACAO]);
  assert.strictEqual(row2.ws_autorizacao_producao, ENDPOINTS.NFCE_AUTORIZACAO[EnvironmentType.PRODUCAO]);
  await closeDb(ctx.db);
}

async function test13GlobalPutNaoApagaToken() {
  const ctx = await setup();
  await setConfiguracao('fiscal_id_csc', '000001', 'string', 'id', ctx.db);
  await setConfiguracao('fiscal_token_csc', 'TOKEN_GLOBAL', 'string', 'tok', ctx.db);
  await setConfiguracao('fiscal_ambiente', '2', 'number', 'amb', ctx.db);
  await setConfiguracao('fiscal_serie', '1', 'number', 'serie', ctx.db);
  await setConfiguracao('fiscal_uf_sigla', 'CE', 'string', 'uf', ctx.db);

  const filtrado = filtrarPayloadConfigFiscalUi({
    fiscal_serie: '2',
    fiscal_token_csc: '',
    fiscal_id_csc: PLACEHOLDER_CSC_UI
  });
  assert.ok(!Object.prototype.hasOwnProperty.call(filtrado, 'fiscal_token_csc'));
  assert.ok(!Object.prototype.hasOwnProperty.call(filtrado, 'fiscal_id_csc'));
  assert.strictEqual(filtrado.fiscal_serie, '2');

  for (const [k, v] of Object.entries(filtrado)) {
    await setConfiguracao(k, String(v), 'string', 't', ctx.db);
  }
  const cfg = await getFiscalConfig({ db: ctx.db, validarUrls: false });
  assert.strictEqual(cfg.tokenCSC, 'TOKEN_GLOBAL');
  assert.strictEqual(cfg.idCSC, '000001');

  const publico = dtoPublicoFiscalParaUi(cfg);
  assert.ok(!Object.prototype.hasOwnProperty.call(publico, 'tokenCSC'));
  assert.strictEqual(publico.cscConfigurado, true);
  assert.strictEqual(publico.idCSC, '000001');
  await closeDb(ctx.db);
}

async function main() {
  const tests = [
    ['01 salvar id CSC', test01SalvarIdCsc],
    ['02 salvar token CSC', test02SalvarTokenCsc],
    ['03 GET mascara token', test03GetMascaraToken],
    ['04 editar outro campo preserva CSC', test04EditarOutroCampoPreservaCsc],
    ['05 substituir CSC', test05SubstituirCsc],
    ['06 placeholder nunca persiste', test06PlaceholderNuncaPersiste],
    ['07 alterar só ID preserva token', test07AlterarSoIdPreservaToken],
    ['08 multiempresa isola CSC', test08MultiempresaIsolaCsc],
    ['09 URL produção oficial', test09UrlProducaoOficial],
    ['10 URL homologação oficial', test10UrlHomologacaoOficial],
    ['11 URL manual não sobrescrita', test11UrlManualNaoSobrescrita],
    ['12 URLs vazias + mudança ambiente', test12UrlsVaziasPreenchidasEAmbiente],
    ['13 PUT global não apaga token', test13GlobalPutNaoApagaToken]
  ];
  let ok = 0;
  for (const [nome, fn] of tests) {
    await fn();
    ok += 1;
    console.log(`OK ${nome}`);
  }
  console.log(`\n${ok}/${tests.length} PASS`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
