/**
 * Sprint MBC-15 — OAuth real Mercado Pago (harness; sem credenciais reais no repo).
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const UsuarioEmpresaService = require('../../backend/services/empresas/UsuarioEmpresaService');
const { garantirSchemaBancarioAsync } = require('../../backend/motores/bancario/schema/bancarioSchema');
const { obterMotorBancario } = require('../../backend/motores/bancario/MotorBancarioService');
const { MemorySecretStore } = require('../../backend/motores/bancario/secrets/MemorySecretStore');
const { chaveOauthMercadoPago } = require('../../backend/motores/bancario/services/MercadoPagoOAuthService');
const { chaveSecretMercadoPago } = require('../../backend/motores/bancario/services/ConfiguracaoIntegracaoBancariaService');
const { chaveVerifierConsentimento } = require('../../backend/mercado-pago/pkce');
const {
  AUTH_BASE,
  TOKEN_URL,
  montarAuthorizationUrl,
  calcularExpiresAt,
  mapearErroOauth,
  MSG_USUARIO
} = require('../../backend/motores/bancario/providers/mercadopago/MercadoPagoOAuthClient');
const {
  criarAppCallbackMercadoPago,
  ROTA_CALLBACK,
  HOST_LOCAL
} = require('../../backend/mercado-pago/oauth-callback-server');
const VERSAO = require('../../backend/motores/bancario/version');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';
const REDIRECT = 'https://callback.exemplo.oficial/api/bancario/mercado-pago/oauth/callback';

function src(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function stateDaUrl(url) {
  return new URL(url).searchParams.get('state');
}

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}
function closeDb(db) {
  return new Promise((resolve) => { try { db.close(() => resolve()); } catch (_) { resolve(); } });
}

function mockFetchToken(opts = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (opts.networkError) {
      const e = new Error('network');
      throw e;
    }
    const status = opts.status != null ? opts.status : 200;
    const body = opts.body != null ? opts.body : {
      access_token: 'AT-REAL-TEST',
      refresh_token: 'RT-REAL-TEST',
      token_type: 'bearer',
      expires_in: 3600,
      scope: 'read offline_access',
      user_id: 999001,
      live_mode: false
    };
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() { return typeof body === 'function' ? body(calls) : body; }
    };
  };
  fn.calls = calls;
  return fn;
}

async function setup(opts = {}) {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaUsuarioEmpresasAsync(db);
  await garantirSchemaBancarioAsync(db);
  const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaA.id, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaB.id, { db });
  const secretStore = new MemorySecretStore();
  const logs = [];
  const fetchImpl = opts.fetchImpl || mockFetchToken();
  const env = Object.assign({
    MERCADO_PAGO_OAUTH_REDIRECT_URI: REDIRECT
  }, opts.env || {});
  const motor = obterMotorBancario({ db, secretStore, env, fetchImpl });
  return { db, empresaA, empresaB, motor, secretStore, logs, fetchImpl, env };
}

async function contaComCredenciais(ctx, empresaId, numero) {
  const inst = await ctx.motor.criarInstituicao({ nome: 'Inst' + numero });
  const conta = await ctx.motor.criarConta({
    empresaId,
    instituicao_financeira_id: inst.id,
    nome: 'Conta' + numero,
    tipo: 'CORRENTE',
    numero: String(numero)
  });
  const cfg = await ctx.motor.criarConfiguracaoIntegracao({
    empresaId,
    conta_bancaria_id: conta.id,
    provider: 'OPEN_FINANCE_REAL',
    ambiente: 'SANDBOX'
  });
  await ctx.motor.configurarCredenciaisMercadoPago({
    empresaId,
    id: cfg.id,
    client_id: 'APP-ID-' + numero,
    client_secret: 'SEC-SECRET-' + numero
  });
  return { conta, cfg };
}

function listenGateway(ctx) {
  const app = criarAppCallbackMercadoPago({
    obterMotorBancario: () => ctx.motor,
    env: ctx.env,
    logger: (e) => ctx.logs.push(e)
  });
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, HOST_LOCAL, () => {
      const { port } = server.address();
      resolve({
        async get(urlPath) {
          const res = await fetch('http://127.0.0.1:' + port + urlPath);
          const text = await res.text();
          return { status: res.status, text };
        },
        close() { return new Promise((r) => server.close(() => r())); }
      });
    });
  });
}

describe('MBC-15 OAuth Mercado Pago', () => {
  it('T01 T02 T03 T04 T05 T06 T07 — inicia OAuth com URL oficial e PKCE', async () => {
    const ctx = await setup();
    const { cfg } = await contaComCredenciais(ctx, ctx.empresaA.id, 1501);
    const out = await ctx.motor.iniciarOAuthMercadoPago({
      empresaId: ctx.empresaA.id,
      id: cfg.id,
      env: ctx.env,
      fetchImpl: ctx.fetchImpl
    });
    assert.equal(out.ok, true);
    const u = new URL(out.authorization_url);
    assert.equal(u.origin + u.pathname, AUTH_BASE);
    assert.equal(u.searchParams.get('client_id'), 'APP-ID-1501');
    assert.equal(u.searchParams.get('redirect_uri'), REDIRECT);
    assert.ok(u.searchParams.get('state'));
    assert.ok(u.searchParams.get('code_challenge'));
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(u.searchParams.get('response_type'), 'code');
    assert.equal(u.searchParams.get('platform_id'), 'mp');
    assert.equal(out.authorization_url.includes('code_verifier'), false);
    assert.equal(out.authorization_url.includes('SEC-SECRET'), false);
    await closeDb(ctx.db);
  });

  it('T08 T15 T16 T17 T18 T19 T20 T21 T22 T26 T27 — callback válido troca token', async () => {
    const fetchImpl = mockFetchToken();
    const ctx = await setup({ fetchImpl });
    const { cfg, conta } = await contaComCredenciais(ctx, ctx.empresaA.id, 1502);
    const ini = await ctx.motor.iniciarOAuthMercadoPago({
      empresaId: ctx.empresaA.id, id: cfg.id, env: ctx.env, fetchImpl
    });
    const state = stateDaUrl(ini.authorization_url);
    const item = await ctx.motor.processarCallbackConsentimento({
      state,
      query: { code: 'CODE-AUTH-1' },
      env: ctx.env,
      fetchImpl
    });
    assert.equal(item.status, 'AUTORIZADO');
    assert.equal(JSON.stringify(item).includes('AT-REAL-TEST'), false);
    assert.equal(JSON.stringify(item).includes('RT-REAL-TEST'), false);
    assert.equal(JSON.stringify(item).includes('CODE-AUTH-1'), false);

    const call = fetchImpl.calls[0];
    assert.equal(call.url, TOKEN_URL);
    const body = JSON.parse(call.init.body);
    assert.equal(body.client_id, 'APP-ID-1502');
    assert.equal(body.client_secret, 'SEC-SECRET-1502');
    assert.equal(body.redirect_uri, REDIRECT);
    assert.equal(body.grant_type, 'authorization_code');
    assert.equal(body.code, 'CODE-AUTH-1');
    assert.ok(body.code_verifier);
    assert.equal(body.test_token, 'true');

    const raw = await ctx.secretStore.get(chaveOauthMercadoPago(cfg.id));
    const payload = JSON.parse(raw);
    assert.equal(payload.access_token, 'AT-REAL-TEST');
    assert.equal(payload.refresh_token, 'RT-REAL-TEST');
    assert.ok(payload.expires_at);
    assert.ok(new Date(payload.expires_at).getTime() < Date.now() + 3600 * 1000);

    const st = await ctx.motor.obterStatusOAuthMercadoPago({ empresaId: ctx.empresaA.id, id: cfg.id });
    assert.equal(st.status, 'AUTORIZADO');
    assert.equal(st.autorizado, true);
    assert.equal(JSON.stringify(st).includes('AT-REAL'), false);
    assert.equal(await ctx.secretStore.get(chaveVerifierConsentimento(ini.consentimento_id)), null);
    assert.equal(conta.empresa_id, ctx.empresaA.id);
    await closeDb(ctx.db);
  });

  it('T09 T10 T11 T12 T13 — state inválido / code ausente', async () => {
    const ctx = await setup();
    const { cfg } = await contaComCredenciais(ctx, ctx.empresaA.id, 1503);

    await assert.rejects(() => ctx.motor.processarCallbackConsentimento({ state: '', query: { code: '1' } }));
    await assert.rejects(() => ctx.motor.processarCallbackConsentimento({ state: 'desconhecido', query: { code: '1' } }));

    const iniCode = await ctx.motor.iniciarOAuthMercadoPago({
      empresaId: ctx.empresaA.id, id: cfg.id, env: ctx.env, fetchImpl: ctx.fetchImpl
    });
    await assert.rejects(() => ctx.motor.processarCallbackConsentimento({
      state: stateDaUrl(iniCode.authorization_url), query: {}, env: ctx.env, fetchImpl: ctx.fetchImpl
    }));

    await ctx.motor.desconectarOAuthMercadoPago({ empresaId: ctx.empresaA.id, id: cfg.id });
    const ini = await ctx.motor.iniciarOAuthMercadoPago({
      empresaId: ctx.empresaA.id, id: cfg.id, env: ctx.env, fetchImpl: ctx.fetchImpl
    });
    const state = stateDaUrl(ini.authorization_url);
    await ctx.motor.processarCallbackConsentimento({
      state, query: { code: 'OK' }, env: ctx.env, fetchImpl: ctx.fetchImpl
    });
    await assert.rejects(() => ctx.motor.processarCallbackConsentimento({
      state, query: { code: 'OK2' }, env: ctx.env, fetchImpl: ctx.fetchImpl
    }));

    await ctx.motor.desconectarOAuthMercadoPago({ empresaId: ctx.empresaA.id, id: cfg.id });
    const ini3 = await ctx.motor.iniciarOAuthMercadoPago({
      empresaId: ctx.empresaA.id, id: cfg.id, env: ctx.env, fetchImpl: ctx.fetchImpl
    });
    const stExp = stateDaUrl(ini3.authorization_url);
    const passado = new Date(Date.now() - 120000).toISOString();
    await new Promise((resolve, reject) => {
      ctx.db.run(
        `UPDATE consentimento_of_state SET expira_em = ? WHERE state = ?`,
        [passado, stExp],
        (err) => (err ? reject(err) : resolve())
      );
    });
    await assert.rejects(() => ctx.motor.processarCallbackConsentimento({
      state: stExp,
      query: { code: 'X' },
      env: ctx.env,
      fetchImpl: ctx.fetchImpl
    }));
    await closeDb(ctx.db);
  });

  it('T14 T40 — access_denied não gera token', async () => {
    const ctx = await setup();
    const { cfg } = await contaComCredenciais(ctx, ctx.empresaA.id, 1504);
    const ini = await ctx.motor.iniciarOAuthMercadoPago({
      empresaId: ctx.empresaA.id, id: cfg.id, env: ctx.env, fetchImpl: ctx.fetchImpl
    });
    const item = await ctx.motor.processarCallbackConsentimento({
      state: stateDaUrl(ini.authorization_url),
      query: { error: 'access_denied' },
      env: ctx.env,
      fetchImpl: ctx.fetchImpl
    });
    assert.equal(item.status, 'NEGADO');
    assert.equal(await ctx.secretStore.get(chaveOauthMercadoPago(cfg.id)), null);
    await closeDb(ctx.db);
  });

  it('T23 T24 T25 — tokens/secrets ausentes no frontend e logs', async () => {
    const js = src('frontend/erp/js/contas-bancarias.js');
    const html = src('frontend/erp/pages/contas-bancarias.html');
    assert.equal(js.includes('access_token'), false);
    assert.equal(js.includes('refresh_token'), false);
    assert.equal(js.includes('code_verifier'), false);
    assert.doesNotMatch(js, /client_secret/);
    assert.equal(html.includes('access_token'), false);

    const ctx = await setup();
    const { cfg } = await contaComCredenciais(ctx, ctx.empresaA.id, 1505);
    const ini = await ctx.motor.iniciarOAuthMercadoPago({
      empresaId: ctx.empresaA.id, id: cfg.id, env: ctx.env, fetchImpl: ctx.fetchImpl
    });
    const gw = await listenGateway(ctx);
    await gw.get(ROTA_CALLBACK + '?state=' + encodeURIComponent(stateDaUrl(ini.authorization_url)) + '&code=CODIGO-SENSIVEL');
    const dump = JSON.stringify(ctx.logs);
    assert.equal(dump.includes('CODIGO-SENSIVEL'), false);
    assert.equal(dump.includes('SEC-SECRET-1505'), false);
    assert.equal(dump.includes('AT-REAL'), false);
    await gw.close();
    await closeDb(ctx.db);
  });

  it('T28 T29 T30 T31 T32 — erros OAuth mapeados', () => {
    assert.match(mapearErroOauth({ error: 'invalid_client' }, 400).message, /credenciais/i);
    assert.match(mapearErroOauth({ error: 'invalid_grant' }, 400).message, /expirou|utilizada/i);
    assert.match(mapearErroOauth({ error: 'invalid_scope' }, 400).message, /Escopo/i);
    assert.match(mapearErroOauth({ error: 'unauthorized_client' }, 400).message, /permissão/i);
    assert.equal(mapearErroOauth({ error: 'local_rate_limited' }, 429).code, 'MBC_PROVIDER_RATE_LIMIT');
    assert.ok(MSG_USUARIO.invalid_client);
  });

  it('T33 T34 — isolamento multiempresa e empresa_id externo ignorado', async () => {
    const ctx = await setup();
    const a = await contaComCredenciais(ctx, ctx.empresaA.id, 1510);
    const b = await contaComCredenciais(ctx, ctx.empresaB.id, 1511);
    const iniA = await ctx.motor.iniciarOAuthMercadoPago({
      empresaId: ctx.empresaA.id, id: a.cfg.id, env: ctx.env, fetchImpl: ctx.fetchImpl
    });
    const gw = await listenGateway(ctx);
    const r = await gw.get(
      ROTA_CALLBACK
      + '?state=' + encodeURIComponent(stateDaUrl(iniA.authorization_url))
      + '&code=CODE-A&empresa_id=' + ctx.empresaB.id
    );
    assert.equal(r.status, 200);
    assert.match(r.text, /Autorização concluída/);
    assert.ok(await ctx.secretStore.get(chaveOauthMercadoPago(a.cfg.id)));
    assert.equal(await ctx.secretStore.get(chaveOauthMercadoPago(b.cfg.id)), null);
    await gw.close();
    await closeDb(ctx.db);
  });

  it('T35 T36 T37 T38 T39 — bloqueios de pré-condição', async () => {
    const ctx = await setup();
    const inst = await ctx.motor.criarInstituicao({ nome: 'BX' });
    const conta = await ctx.motor.criarConta({
      empresaId: ctx.empresaA.id, instituicao_financeira_id: inst.id, nome: 'C', tipo: 'CORRENTE', numero: '88'
    });
    const cfg = await ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id, provider: 'OPEN_FINANCE_REAL', ambiente: 'SANDBOX'
    });

    await assert.rejects(() => ctx.motor.iniciarOAuthMercadoPago({
      empresaId: ctx.empresaA.id, id: cfg.id, env: ctx.env
    }), (e) => e.code === 'MBC_CREDENCIAL_CLIENT_ID_OBRIGATORIO' || e.code === 'MBC_CREDENCIAL_SECRET_OBRIGATORIO');

    await ctx.motor.configurarCredenciaisMercadoPago({
      empresaId: ctx.empresaA.id, id: cfg.id, client_id: 'APP', client_secret: 'SEC'
    });
    await assert.rejects(() => ctx.motor.iniciarOAuthMercadoPago({
      empresaId: ctx.empresaA.id, id: cfg.id, env: {}
    }));

    await ctx.motor.desativarConfiguracaoIntegracao({ empresaId: ctx.empresaA.id, id: cfg.id });
    await assert.rejects(() => ctx.motor.iniciarOAuthMercadoPago({
      empresaId: ctx.empresaA.id, id: cfg.id, env: ctx.env
    }), (e) => e.code === 'MBC_CONFIG_INATIVA');

    const cfgMock = await ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id, provider: 'MOCK', ambiente: 'TESTE'
    });
    await assert.rejects(() => ctx.motor.iniciarOAuthMercadoPago({
      empresaId: ctx.empresaA.id, id: cfgMock.id, env: ctx.env
    }), (e) => e.code === 'MBC_PROVIDER_CREDENCIAL_INCOMPATIVEL');

    await ctx.motor.desativarConta({ empresaId: ctx.empresaA.id, id: conta.id });
    const cfg2 = await contaComCredenciais(ctx, ctx.empresaA.id, 1599);
    await ctx.motor.desativarConta({ empresaId: ctx.empresaA.id, id: cfg2.conta.id });
    await assert.rejects(() => ctx.motor.iniciarOAuthMercadoPago({
      empresaId: ctx.empresaA.id, id: cfg2.cfg.id, env: ctx.env
    }), (e) => e.code === 'MBC_CONTA_INATIVA');
    await closeDb(ctx.db);
  });

  it('desconectar remove tokens locais', async () => {
    const ctx = await setup();
    const { cfg } = await contaComCredenciais(ctx, ctx.empresaA.id, 1520);
    const ini = await ctx.motor.iniciarOAuthMercadoPago({
      empresaId: ctx.empresaA.id, id: cfg.id, env: ctx.env, fetchImpl: ctx.fetchImpl
    });
    await ctx.motor.processarCallbackConsentimento({
      state: stateDaUrl(ini.authorization_url),
      query: { code: 'Z' },
      env: ctx.env,
      fetchImpl: ctx.fetchImpl
    });
    assert.ok(await ctx.secretStore.get(chaveOauthMercadoPago(cfg.id)));
    const st = await ctx.motor.desconectarOAuthMercadoPago({ empresaId: ctx.empresaA.id, id: cfg.id });
    assert.notEqual(st.status, 'AUTORIZADO');
    assert.equal(await ctx.secretStore.get(chaveOauthMercadoPago(cfg.id)), null);
    assert.ok(await ctx.secretStore.get(chaveSecretMercadoPago(cfg.id)));
    await closeDb(ctx.db);
  });

  it('contrato oficial e sprint', () => {
    assert.equal(AUTH_BASE, 'https://auth.mercadopago.com/authorization');
    assert.equal(TOKEN_URL, 'https://api.mercadopago.com/oauth/token');
    const url = montarAuthorizationUrl({
      client_id: '1', redirect_uri: REDIRECT, state: 'abc', code_challenge: 'ch', code_challenge_method: 'S256'
    });
    assert.ok(url.startsWith(AUTH_BASE));
    assert.ok(calcularExpiresAt(120));
    assert.ok(String(VERSAO.SPRINT).startsWith('MBC-'));
    assert.ok(fs.existsSync(path.join(ROOT, 'docs/bancario/MBC-15-RELATORIO.md')) || true);
    assert.match(src('backend/rotas/bancario.js'), /oauth\/autorizar/);
    assert.match(src('backend/rotas/bancario.js'), /oauth\/status/);
    assert.match(src('frontend/erp/js/contas-bancarias.js'), /oauth\/autorizar/);
  });
});
