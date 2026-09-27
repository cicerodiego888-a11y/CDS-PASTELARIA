/**
 * Sprint MBC-15.1 — bootstrap Gateway OAuth alinhado ao ERP (DB_DIR + SecretStore + Redirect).
 * Executar: node --test tests/bancario/motor-bancario-15-1.test.js
 * Nunca imprime Client Secret, tokens, code, verifier ou MBC_SECRET_STORE_KEY.
 */
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const UsuarioEmpresaService = require('../../backend/services/empresas/UsuarioEmpresaService');
const { garantirSchemaBancarioAsync } = require('../../backend/motores/bancario/schema/bancarioSchema');
const { obterMotorBancario } = require('../../backend/motores/bancario/MotorBancarioService');
const { EncryptedLocalSecretStore } = require('../../backend/motores/bancario/secrets/EncryptedLocalSecretStore');
const {
  bootstrapAmbienteOperacionalMbc,
  resolverDbDirOficial
} = require('../../backend/motores/bancario/secrets/bootstrapAmbienteOperacionalMbc');
const { chaveSecretMercadoPago } = require('../../backend/motores/bancario/services/ConfiguracaoIntegracaoBancariaService');
const { chaveOauthMercadoPago } = require('../../backend/motores/bancario/services/MercadoPagoOAuthService');
const {
  criarAppCallbackMercadoPago,
  iniciarServidorCallback,
  ROTA_CALLBACK,
  HOST_LOCAL,
  MSG_FALHA
} = require('../../backend/mercado-pago/oauth-callback-server');
const { TOKEN_URL } = require('../../backend/motores/bancario/providers/mercadopago/MercadoPagoOAuthClient');
const { ERROS } = require('../../backend/motores/bancario/contracts/constantes');
const VERSAO = require('../../backend/motores/bancario/version');

const CNPJ = '11222333000181';
const REDIRECT_A = 'https://callback.homolog.oficial/api/bancario/mercado-pago/oauth/callback';
const TEST_KEY = crypto.createHash('sha256').update('mbc-15-1-fixture').digest('hex');

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function stateDaUrl(url) {
  return new URL(url).searchParams.get('state');
}

function openDbFile(filePath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filePath, (err) => (err ? reject(err) : resolve(db)));
  });
}

function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_) { resolve(); }
  });
}

function mockFetchToken() {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          access_token: 'AT-CROSS-PROC',
          refresh_token: 'RT-CROSS-PROC',
          token_type: 'bearer',
          expires_in: 3600,
          scope: 'read',
          user_id: 42,
          live_mode: false
        };
      }
    };
  };
  fn.calls = calls;
  return fn;
}

describe('MBC-15.1 bootstrap Gateway OAuth', () => {
  let prevDbDir;
  let prevKey;
  let prevRedirect;

  before(() => {
    prevDbDir = process.env.DB_DIR;
    prevKey = process.env.MBC_SECRET_STORE_KEY;
    prevRedirect = process.env.MERCADO_PAGO_OAUTH_REDIRECT_URI;
  });

  after(() => {
    if (prevDbDir === undefined) delete process.env.DB_DIR;
    else process.env.DB_DIR = prevDbDir;
    if (prevKey === undefined) delete process.env.MBC_SECRET_STORE_KEY;
    else process.env.MBC_SECRET_STORE_KEY = prevKey;
    if (prevRedirect === undefined) delete process.env.MERCADO_PAGO_OAUTH_REDIRECT_URI;
    else process.env.MERCADO_PAGO_OAUTH_REDIRECT_URI = prevRedirect;
  });

  it('T01 — ERP DB_DIR == Gateway DB_DIR (bootstrap oficial)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbc151-db-'));
    delete process.env.MBC_SECRET_STORE_KEY;
    process.env.MERCADO_PAGO_OAUTH_REDIRECT_URI = REDIRECT_A;
    const erp = bootstrapAmbienteOperacionalMbc({ dbDir: dir, env: process.env });
    const gw = bootstrapAmbienteOperacionalMbc({ dbDir: dir, env: process.env });
    assert.equal(erp.db_dir, gw.db_dir);
    assert.equal(erp.db_path, gw.db_path);
    assert.equal(erp.db_path, path.join(dir, 'mercadao.db'));
    assert.equal(erp.secret_store_disponivel, true);
    assert.equal(gw.secret_store_disponivel, true);
    assert.equal(erp.redirect_uri_configurado, true);
    assert.equal(resolverDbDirOficial({ DB_DIR: dir }), dir);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('T02 — fallback oficial MercantilFiscal (não CDS Sistemas)', () => {
    const js = src('backend/motores/bancario/secrets/garantirMbcSecretStoreKey.js');
    assert.match(js, /MercantilFiscal/);
    assert.doesNotMatch(js, /CDS Sistemas/);
    const bootJs = src('backend/motores/bancario/secrets/bootstrapAmbienteOperacionalMbc.js');
    assert.match(bootJs, /MercantilFiscal/);
    assert.match(bootJs, /garantirMbcSecretStoreKey/);
  });

  it('T03 — Gateway /health indicadores sem segredos', async () => {
    process.env.MBC_SECRET_STORE_KEY = TEST_KEY;
    process.env.MERCADO_PAGO_OAUTH_REDIRECT_URI = REDIRECT_A;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbc151-h-'));
    const boot = bootstrapAmbienteOperacionalMbc({ dbDir: dir, env: process.env });
    const app = criarAppCallbackMercadoPago({
      bootstrapStatus: boot,
      obterMotorBancario: () => { throw new Error('não deve chamar'); }
    });
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, HOST_LOCAL, r));
    const port = server.address().port;
    const res = await fetch('http://127.0.0.1:' + port + '/health');
    const data = await res.json();
    assert.equal(data.servico, 'callback-oauth-mercado-pago');
    assert.equal(data.db_configurado, true);
    assert.equal(data.cofre_disponivel, true);
    assert.equal(data.redirect_uri_configurado, true);
    const dump = JSON.stringify(data);
    assert.equal(dump.includes(TEST_KEY), false);
    assert.equal(dump.includes('client_secret'), false);
    assert.equal(dump.includes('access_token'), false);
    await new Promise((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('T04 — Redirect URI A na autorização e na troca de token (exato)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbc151-r-'));
    const dbFile = path.join(dir, 'mercadao.db');
    process.env.DB_DIR = dir;
    process.env.MBC_SECRET_STORE_KEY = TEST_KEY;
    process.env.MERCADO_PAGO_OAUTH_REDIRECT_URI = REDIRECT_A;
    const db = await openDbFile(dbFile);
    await garantirSchemaEmpresasAsync(db);
    await garantirSchemaUsuarioEmpresasAsync(db);
    await garantirSchemaBancarioAsync(db);
    const empresa = await EmpresaService.criarEmpresa({ cnpj: CNPJ, razao_social: 'A' }, { db });
    await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresa.id, { db });
    const store = new EncryptedLocalSecretStore({ db });
    const fetchImpl = mockFetchToken();
    const motor = obterMotorBancario({
      db,
      secretStore: store,
      env: process.env,
      fetchImpl
    });
    const inst = await motor.criarInstituicao({ nome: 'MP' });
    const conta = await motor.criarConta({
      empresaId: empresa.id, instituicao_financeira_id: inst.id, nome: 'C', tipo: 'CORRENTE', numero: '1'
    });
    const cfg = await motor.criarConfiguracaoIntegracao({
      empresaId: empresa.id, conta_bancaria_id: conta.id, provider: 'OPEN_FINANCE_REAL', ambiente: 'SANDBOX'
    });
    await motor.configurarCredenciaisMercadoPago({
      empresaId: empresa.id, id: cfg.id, client_id: 'APP-151', client_secret: 'SEC-151'
    });
    const ini = await motor.iniciarOAuthMercadoPago({ empresaId: empresa.id, id: cfg.id });
    const u = new URL(ini.authorization_url);
    assert.equal(u.searchParams.get('redirect_uri'), REDIRECT_A);
    assert.ok(u.searchParams.get('code_challenge'));
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(ini.authorization_url.includes('code_verifier'), false);
    const state = stateDaUrl(ini.authorization_url);
    const item = await motor.processarCallbackConsentimento({ state, query: { code: 'CODE-1' } });
    assert.equal(item.status, 'AUTORIZADO');
    const body = JSON.parse(fetchImpl.calls[0].init.body);
    assert.equal(body.redirect_uri, REDIRECT_A);
    assert.ok(body.code_verifier);
    assert.equal(body.redirect_uri.endsWith('/'), false);
    assert.equal(await store.has(chaveOauthMercadoPago(cfg.id)), true);
    await closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('T05 — PROCESSO A inicia OAuth; PROCESSO B (motor novo) conclui AUTORIZADO', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbc151-2p-'));
    const dbFile = path.join(dir, 'mercadao.db');
    process.env.DB_DIR = dir;
    process.env.MBC_SECRET_STORE_KEY = TEST_KEY;
    process.env.MERCADO_PAGO_OAUTH_REDIRECT_URI = REDIRECT_A;

    const dbA = await openDbFile(dbFile);
    await garantirSchemaEmpresasAsync(dbA);
    await garantirSchemaUsuarioEmpresasAsync(dbA);
    await garantirSchemaBancarioAsync(dbA);
    const empresa = await EmpresaService.criarEmpresa({ cnpj: CNPJ, razao_social: 'A' }, { db: dbA });
    await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresa.id, { db: dbA });
    const storeA = new EncryptedLocalSecretStore({ db: dbA });
    const fetchImpl = mockFetchToken();
    const motorA = obterMotorBancario({ db: dbA, secretStore: storeA, env: process.env, fetchImpl });
    const inst = await motorA.criarInstituicao({ nome: 'MP' });
    const conta = await motorA.criarConta({
      empresaId: empresa.id, instituicao_financeira_id: inst.id, nome: 'C', tipo: 'CORRENTE', numero: '9'
    });
    const cfg = await motorA.criarConfiguracaoIntegracao({
      empresaId: empresa.id, conta_bancaria_id: conta.id, provider: 'OPEN_FINANCE_REAL', ambiente: 'SANDBOX'
    });
    await motorA.configurarCredenciaisMercadoPago({
      empresaId: empresa.id, id: cfg.id, client_id: 'APP-2P', client_secret: 'SEC-2P-VALUE'
    });
    assert.equal((await motorA.obterStatusCredenciaisIntegracao({
      empresaId: empresa.id, id: cfg.id
    })).secret_configurado, true);
    const ini = await motorA.iniciarOAuthMercadoPago({ empresaId: empresa.id, id: cfg.id });
    const state = stateDaUrl(ini.authorization_url);
    await closeDb(dbA);

    // PROCESSO B — nova conexão, novo store, mesma chave e mesmo arquivo
    const dbB = await openDbFile(dbFile);
    const storeB = new EncryptedLocalSecretStore({ db: dbB });
    assert.notEqual(storeA, storeB);
    assert.equal(await storeB.has(chaveSecretMercadoPago(cfg.id)), true);
    const motorB = obterMotorBancario({ db: dbB, secretStore: storeB, env: process.env, fetchImpl });
    const logs = [];
    const app = criarAppCallbackMercadoPago({
      obterMotorBancario: () => motorB,
      env: process.env,
      logger: (e) => logs.push(e)
    });
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, HOST_LOCAL, r));
    const port = server.address().port;
    const res = await fetch(
      'http://127.0.0.1:' + port + ROTA_CALLBACK
      + '?state=' + encodeURIComponent(state)
      + '&code=CODE-CROSS'
    );
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.match(text, /Autorização concluída/);
    assert.equal(await storeB.has(chaveOauthMercadoPago(cfg.id)), true);
    const dump = JSON.stringify(logs);
    assert.equal(dump.includes('SEC-2P-VALUE'), false);
    assert.equal(dump.includes('CODE-CROSS'), false);
    assert.equal(dump.includes('AT-CROSS'), false);
    assert.equal(dump.includes(TEST_KEY), false);
    await new Promise((r) => server.close(() => r()));
    await closeDb(dbB);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('T06 — sem MBC_SECRET_STORE_KEY o callback não finge sucesso', async () => {
    delete process.env.MBC_SECRET_STORE_KEY;
    process.env.MERCADO_PAGO_OAUTH_REDIRECT_URI = REDIRECT_A;
    const app = criarAppCallbackMercadoPago({
      bootstrapStatus: {
        ok: false,
        db_configurado: true,
        secret_store_disponivel: false,
        redirect_uri_configurado: true
      },
      obterMotorBancario: () => { throw new Error('não deve processar'); },
      logger: () => {}
    });
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, HOST_LOCAL, r));
    const port = server.address().port;
    const res = await fetch(
      'http://127.0.0.1:' + port + ROTA_CALLBACK + '?state=abc&code=x'
    );
    const text = await res.text();
    assert.equal(res.status, 503);
    assert.match(text, new RegExp(MSG_FALHA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await new Promise((r) => server.close(() => r()));
  });

  it('T07 — sem Redirect URI o OAuth não inicia', async () => {
    const db = await new Promise((resolve, reject) => {
      const d = new sqlite3.Database(':memory:', (e) => (e ? reject(e) : resolve(d)));
    });
    await garantirSchemaEmpresasAsync(db);
    await garantirSchemaUsuarioEmpresasAsync(db);
    await garantirSchemaBancarioAsync(db);
    const empresa = await EmpresaService.criarEmpresa({ cnpj: CNPJ, razao_social: 'A' }, { db });
    const { MemorySecretStore } = require('../../backend/motores/bancario/secrets/MemorySecretStore');
    const store = new MemorySecretStore();
    const motor = obterMotorBancario({
      db,
      secretStore: store,
      env: {},
      fetchImpl: mockFetchToken()
    });
    const inst = await motor.criarInstituicao({ nome: 'MP' });
    const conta = await motor.criarConta({
      empresaId: empresa.id, instituicao_financeira_id: inst.id, nome: 'C', tipo: 'CORRENTE', numero: '2'
    });
    const cfg = await motor.criarConfiguracaoIntegracao({
      empresaId: empresa.id, conta_bancaria_id: conta.id, provider: 'OPEN_FINANCE_REAL', ambiente: 'SANDBOX'
    });
    await motor.configurarCredenciaisMercadoPago({
      empresaId: empresa.id, id: cfg.id, client_id: 'APP', client_secret: 'SEC'
    });
    await assert.rejects(
      () => motor.iniciarOAuthMercadoPago({ empresaId: empresa.id, id: cfg.id, env: {} }),
      (e) => e.code === ERROS.AUTORIZACAO_INVALIDA || /Redirect URI/i.test(e.message)
    );
    await closeDb(db);
  });

  it('T08 — iniciarServidorCallback rejeita sem Redirect URI', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbc151-fail-'));
    process.env.MBC_SECRET_STORE_KEY = TEST_KEY;
    delete process.env.MERCADO_PAGO_OAUTH_REDIRECT_URI;
    await assert.rejects(
      () => iniciarServidorCallback({
        port: 0,
        env: {
          DB_DIR: dir,
          MBC_SECRET_STORE_KEY: TEST_KEY
        },
        dbDir: dir,
        exigirRedirectUri: true
      }),
      (e) => /MERCADO_PAGO_OAUTH_REDIRECT_URI/i.test(e.message)
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('T09 — callback registra codigo_erro sanitizado (sem segredos)', async () => {
    const logs = [];
    const app = criarAppCallbackMercadoPago({
      bootstrapStatus: {
        ok: true,
        db_configurado: true,
        secret_store_disponivel: true,
        redirect_uri_configurado: true
      },
      obterMotorBancario: () => ({
        processarCallbackConsentimento: async () => {
          const err = new Error('falha controlada');
          err.code = 'MBC_AUTORIZACAO_INVALIDA';
          err.statusCode = 400;
          err.categoria = 'AUTENTICACAO';
          throw err;
        }
      }),
      env: { MERCADO_PAGO_OAUTH_REDIRECT_URI: REDIRECT_A },
      logger: (e) => logs.push(e)
    });
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, HOST_LOCAL, r));
    const port = server.address().port;
    const res = await fetch(
      'http://127.0.0.1:' + port + ROTA_CALLBACK + '?state=st-teste&code=CODE-LOG'
    );
    assert.equal(res.status, 400);
    assert.match(await res.text(), /Autorização inválida/);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].codigo_erro, 'MBC_AUTORIZACAO_INVALIDA');
    assert.equal(JSON.stringify(logs).includes('CODE-LOG'), false);
    assert.equal(JSON.stringify(logs).includes('st-teste'), false);
    await new Promise((r) => server.close(() => r()));
  });

  it('T10 — docs e gateway usa bootstrap compartilhado', () => {
    assert.ok(String(VERSAO.SPRINT).startsWith('MBC-'));
    assert.ok(fs.existsSync(path.join(ROOT, 'docs/bancario/MBC-15.1-RELATORIO.md')));
    const gw = src('backend/mercado-pago/oauth-callback-server.js');
    assert.match(gw, /bootstrapAmbienteOperacionalMbc/);
    assert.match(gw, /cofre_disponivel|secret_store_disponivel/);
    assert.match(gw, /codigo_erro/);
    const rel = src('docs/bancario/MBC-15.1-RELATORIO.md');
    assert.match(rel, /DB_DIR/);
    assert.match(rel, /MBC_SECRET_STORE_KEY/);
  });
});
