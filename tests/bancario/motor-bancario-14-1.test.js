/**
 * Sprint MBC-14.1 — gateway local de callback OAuth Mercado Pago.
 * Sem chamada à API do Mercado Pago. Sem token real.
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const UsuarioEmpresaService = require('../../backend/services/empresas/UsuarioEmpresaService');
const { garantirSchemaBancarioAsync } = require('../../backend/motores/bancario/schema/bancarioSchema');
const { obterMotorBancario } = require('../../backend/motores/bancario/MotorBancarioService');
const { criarRegistryPadrao, BankProviderRegistry } = require('../../backend/motores/bancario/providers/BankProviderRegistry');
const { MemorySecretStore } = require('../../backend/motores/bancario/secrets/MemorySecretStore');
const { OpenFinanceRealBankProvider } = require('../../backend/motores/bancario/providers/openfinance-real/OpenFinanceRealBankProvider');
const { OpenFinanceRealClient } = require('../../backend/motores/bancario/providers/openfinance-real/OpenFinanceRealClient');
const { chaveSecretConsentimento } = require('../../backend/motores/bancario/services/ConsentimentoOpenFinanceService');
const { criarRouter } = require('../../backend/rotas/bancario');
const { resolverEmpresaIdParaBancario } = require('../../backend/motores/bancario/BancarioEmpresaContextoService');
const { ModoOperacionalGlobal } = require('../../backend/core/modo-operacional');
const {
  PORTA_PADRAO,
  HOST_LOCAL,
  ROTA_CALLBACK,
  criarAppCallbackMercadoPago,
  iniciarServidorCallback
} = require('../../backend/mercado-pago/oauth-callback-server');
const { gerarPkceS256, persistirVerifier, chaveVerifierConsentimento } = require('../../backend/mercado-pago/pkce');
const { statusRedirectUriOficial } = require('../../backend/mercado-pago/redirectUri');
const VERSAO = require('../../backend/motores/bancario/version');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

function src(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function stateDaUrl(url) {
  return new URL(url, 'http://127.0.0.1').searchParams.get('state');
}

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}
function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}
function closeDb(db) {
  return new Promise((resolve) => { try { db.close(() => resolve()); } catch (_) { resolve(); } });
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
  let registry = criarRegistryPadrao();
  if (opts.harness) {
    registry = criarRegistryPadrao();
    registry.registrar(new OpenFinanceRealBankProvider({
      client: new OpenFinanceRealClient({
        transport: {
          async request(p) {
            if (p.recurso === 'autorizacao') {
              return { authorization_url: '/h?state=' + encodeURIComponent(p.state || '') };
            }
            if (p.recurso === 'token') {
              return { access_token: 'AT-NAO-DEVERIA', refresh_token: 'RT-NAO', consentimento_externo_id: 'E1' };
            }
            return {};
          }
        }
      }),
      secretStore
    }));
  }
  const motor = obterMotorBancario({ db, secretStore, registry });
  return { db, empresaA, empresaB, motor, secretStore, logs, registry };
}

async function contaMock(ctx, empresaId) {
  const inst = await ctx.motor.criarInstituicao({ nome: 'I14' });
  const c = await ctx.motor.criarConta({
    empresaId, instituicao_financeira_id: inst.id, nome: 'C14', tipo: 'CORRENTE', numero: '1401'
  });
  await ctx.motor.criarConfiguracaoIntegracao({
    empresaId, conta_bancaria_id: c.id, provider: 'MOCK_OPEN_FINANCE', ambiente: 'TESTE'
  });
  return c;
}

function listenGateway(ctx) {
  const app = criarAppCallbackMercadoPago({
    obterMotorBancario: () => ctx.motor,
    logger: (e) => ctx.logs.push(e)
  });
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, HOST_LOCAL, () => {
      const { port, address } = server.address();
      resolve({
        port,
        address,
        async get(urlPath) {
          const res = await fetch('http://127.0.0.1:' + port + urlPath);
          const text = await res.text();
          return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch (_) { return null; } })() };
        },
        close() { return new Promise((r) => server.close(() => r())); }
      });
    });
  });
}

describe('MBC-14.1 gateway', () => {
  it('T01 — porta padrão 3010', () => {
    assert.equal(PORTA_PADRAO, 3010);
  });
  it('T02 — escuta somente 127.0.0.1', async () => {
    const server = await iniciarServidorCallback({ port: 0, obterMotorBancario: () => ({}) });
    const addr = server.address();
    assert.equal(addr.address, HOST_LOCAL);
    await new Promise((r) => server.close(() => r()));
  });
  it('T03 T04 T05 — health, callback e 404', async () => {
    const ctx = await setup();
    const gw = await listenGateway(ctx);
    const h = await gw.get('/health');
    assert.equal(h.status, 200);
    assert.equal(h.json.servico, 'callback-oauth-mercado-pago');
    const cb = await gw.get(ROTA_CALLBACK);
    assert.ok(cb.status === 400);
    const x = await gw.get('/qualquer');
    assert.equal(x.status, 404);
    await gw.close();
    await closeDb(ctx.db);
  });
  it('T06 — ERP continua na porta 3001', () => {
    assert.match(src('backend/server.js'), /PORT = process\.env\.PORT \|\| 3001/);
  });
  it('T07 T35 — /api/bancario protegido; servidor principal não alterado', () => {
    assert.match(src('backend/server.js'), /app\.use\('\/api\/bancario', verificarToken, bancarioRoutes\(\)\)/);
    assert.equal(src('backend/server.js').includes('mercado-pago/oauth-callback-server'), false);
  });
  it('T08 — callback do gateway não exige JWT', () => {
    const s = src('backend/mercado-pago/oauth-callback-server.js');
    assert.equal(s.includes('verificarToken'), false);
    assert.equal(s.includes('verificarPermissaoEspecifica'), false);
  });
});

describe('MBC-14.1 state e sanitização', () => {
  it('T09 — state ausente', async () => {
    const ctx = await setup();
    const gw = await listenGateway(ctx);
    const r = await gw.get(ROTA_CALLBACK + '?code=abc');
    assert.equal(r.status, 400);
    assert.match(r.text, /Autorização inválida/);
    assert.equal(r.text.includes('abc'), false);
    await gw.close();
    await closeDb(ctx.db);
  });
  it('T10 — state desconhecido', async () => {
    const ctx = await setup();
    const gw = await listenGateway(ctx);
    const r = await gw.get(ROTA_CALLBACK + '?state=naoexiste&code=abc');
    assert.equal(r.status, 400);
    assert.match(r.text, /Autorização inválida/);
    await gw.close();
    await closeDb(ctx.db);
  });
  it('T11 — state expirado', async () => {
    const ctx = await setup();
    const c = await contaMock(ctx, ctx.empresaA.id);
    const ini = await ctx.motor.iniciarConsentimento({
      empresaId: ctx.empresaA.id, conta_bancaria_id: c.id, provider: 'MOCK_OPEN_FINANCE'
    });
    const state = stateDaUrl(ini.authorization_url);
    await run(ctx.db, `UPDATE consentimento_of_state SET expira_em = ? WHERE state = ?`, [
      new Date(Date.now() - 1000).toISOString(), state
    ]);
    const gw = await listenGateway(ctx);
    const r = await gw.get(ROTA_CALLBACK + '?state=' + encodeURIComponent(state) + '&code=x');
    assert.equal(r.status, 400);
    assert.match(r.text, /Autorização inválida/);
    await gw.close();
    await closeDb(ctx.db);
  });
  it('T12 T13 — consumido e válido', async () => {
    const ctx = await setup();
    const c = await contaMock(ctx, ctx.empresaA.id);
    const ini = await ctx.motor.iniciarConsentimento({
      empresaId: ctx.empresaA.id, conta_bancaria_id: c.id, provider: 'MOCK_OPEN_FINANCE'
    });
    const state = stateDaUrl(ini.authorization_url);
    const gw = await listenGateway(ctx);
    const ok = await gw.get(ROTA_CALLBACK + '?state=' + encodeURIComponent(state) + '&code=AUTH-CODE-1');
    assert.equal(ok.status, 200);
    assert.match(ok.text, /Autorização recebida/);
    assert.equal(ok.text.includes('AUTH-CODE-1'), false);
    assert.equal(ok.text.includes(state), false);
    const replay = await gw.get(ROTA_CALLBACK + '?state=' + encodeURIComponent(state) + '&code=AUTH-CODE-1');
    assert.equal(replay.status, 400);
    await gw.close();
    await closeDb(ctx.db);
  });
  it('T14 T34 — empresa do state, não do query', async () => {
    const ctx = await setup();
    const c = await contaMock(ctx, ctx.empresaA.id);
    const ini = await ctx.motor.iniciarConsentimento({
      empresaId: ctx.empresaA.id, conta_bancaria_id: c.id, provider: 'MOCK_OPEN_FINANCE'
    });
    const state = stateDaUrl(ini.authorization_url);
    const gw = await listenGateway(ctx);
    const r = await gw.get(
      ROTA_CALLBACK + '?state=' + encodeURIComponent(state) + '&code=1&empresa_id=' + ctx.empresaB.id
    );
    assert.equal(r.status, 200);
    const lista = await ctx.motor.listarConsentimentos({ empresaId: ctx.empresaA.id, conta_bancaria_id: c.id });
    assert.equal(lista[0].status, 'AUTORIZADO');
    assert.equal(lista[0].empresa_id, ctx.empresaA.id);
    await gw.close();
    await closeDb(ctx.db);
  });
  it('T15 — PKCE S256 preparado', () => {
    const p = gerarPkceS256();
    assert.equal(p.code_challenge_method, 'S256');
    assert.ok(p.code_verifier.length >= 32);
    assert.ok(p.code_challenge);
    assert.notEqual(p.code_challenge, p.code_verifier);
  });
  it('T16 T17 T18 T19 — logs sanitizados', async () => {
    const ctx = await setup();
    const c = await contaMock(ctx, ctx.empresaA.id);
    const ini = await ctx.motor.iniciarConsentimento({
      empresaId: ctx.empresaA.id, conta_bancaria_id: c.id, provider: 'MOCK_OPEN_FINANCE'
    });
    const state = stateDaUrl(ini.authorization_url);
    const gw = await listenGateway(ctx);
    await gw.get(ROTA_CALLBACK + '?state=' + encodeURIComponent(state) + '&code=CODIGO-SECRETO');
    const dump = JSON.stringify(ctx.logs);
    assert.equal(dump.includes('CODIGO-SECRETO'), false);
    assert.equal(dump.includes(state), false);
    ctx.logs.forEach((l) => {
      if (l.code) assert.equal(l.code, '[REDACTED]');
      if (l.state) assert.equal(l.state, '[REDACTED]');
    });
    await gw.close();
    await closeDb(ctx.db);
  });
  it('T20 T21 — redirect URI não inventado; HTTPS', () => {
    assert.equal(statusRedirectUriOficial({}).status, 'NAO_CONFIGURADO');
    assert.equal(statusRedirectUriOficial({ MERCADO_PAGO_OAUTH_REDIRECT_URI: 'http://localhost/x' }).status, 'NAO_CONFIGURADO');
    assert.equal(statusRedirectUriOficial({ MERCADO_PAGO_OAUTH_REDIRECT_URI: 'https://exemplo.oficial/cb' }).status, 'CONFIGURADO');
    assert.equal(src('backend/mercado-pago/redirectUri.js').includes('https://mp.'), false);
  });
  it('T22 T23 T24 T25 T26 T27 — sem proxy; rotas bloqueadas', async () => {
    const gwSrc = src('backend/mercado-pago/oauth-callback-server.js');
    assert.equal(/http-proxy|createProxy/.test(gwSrc), false);
    const ctx = await setup();
    const gw = await listenGateway(ctx);
    for (const p of ['/api/vendas', '/api/financeiro', '/api/bancario', '/pdv', '/erp', '/storage']) {
      const r = await gw.get(p);
      assert.equal(r.status, 404);
    }
    await gw.close();
    await closeDb(ctx.db);
  });
  it('T28 — MOCK continua', async () => {
    const ctx = await setup();
    const c = await contaMock(ctx, ctx.empresaA.id);
    const ini = await ctx.motor.iniciarConsentimento({
      empresaId: ctx.empresaA.id, conta_bancaria_id: c.id, provider: 'MOCK_OPEN_FINANCE'
    });
    assert.ok(ini.authorization_url.includes('mock-autorizar'));
    await closeDb(ctx.db);
  });
  it('T29 — OF_MOCK_REF não aplicado ao provider real', async () => {
    const ctx = await setup({ harness: true });
    const inst = await ctx.motor.criarInstituicao({ nome: 'IR' });
    const c = await ctx.motor.criarConta({
      empresaId: ctx.empresaA.id, instituicao_financeira_id: inst.id, nome: 'CR', tipo: 'CORRENTE', numero: '99'
    });
    await ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id, conta_bancaria_id: c.id, provider: 'OPEN_FINANCE_REAL', ambiente: 'SANDBOX'
    });
    const ini = await ctx.motor.iniciarConsentimento({
      empresaId: ctx.empresaA.id, conta_bancaria_id: c.id, provider: 'OPEN_FINANCE_REAL'
    });
    const state = stateDaUrl(ini.authorization_url);
    await ctx.motor.processarCallbackConsentimento({
      state, query: { code: '1' }
    });
    const lista = await ctx.motor.listarConsentimentos({ empresaId: ctx.empresaA.id, conta_bancaria_id: c.id });
    const ref = await ctx.secretStore.get(chaveSecretConsentimento(lista[0].id));
    assert.notEqual(ref, 'OF_MOCK_REF');
    await closeDb(ctx.db);
  });
  it('T30 — gateway não grava token', () => {
    const s = src('backend/mercado-pago/oauth-callback-server.js');
    assert.equal(s.includes('secretStore'), false);
    assert.equal(s.includes('.set('), false);
  });
  it('T31 T32 — respostas sanitizadas', async () => {
    const ctx = await setup();
    const gw = await listenGateway(ctx);
    const fail = await gw.get(ROTA_CALLBACK + '?error=access_denied&error_description=x&code=ZZ');
    assert.match(fail.text, /Autorização inválida|Não foi possível/);
    assert.equal(fail.text.includes('ZZ'), false);
    assert.equal(fail.text.includes('access_denied'), false);
    await gw.close();
    await closeDb(ctx.db);
  });
  it('T33 — integração MBC-06', () => {
    assert.match(src('backend/mercado-pago/oauth-callback-server.js'), /processarCallbackConsentimento/);
  });
  it('T36 — PKCE verifier no SecretStore, não em texto aberto', async () => {
    const store = new MemorySecretStore();
    const pk = gerarPkceS256();
    await persistirVerifier(store, 7, pk.code_verifier);
    assert.equal(await store.get(chaveVerifierConsentimento(7)), pk.code_verifier);
    assert.equal(src('backend/mercado-pago/pkce.js').includes('INSERT INTO'), false);
  });
  it('T37 — sprint e docs', () => {
    assert.ok(String(VERSAO.SPRINT).startsWith('MBC-'));
    assert.ok(fs.existsSync(path.join(ROOT, 'docs/bancario/MBC-14.1-CALLBACK-MERCADO-PAGO.md')));
    assert.match(src('package.json'), /start:mercado-pago-oauth/);
  });
  it('T38 — ERP bancário ainda exige auth no router de callback interno', () => {
    assert.match(src('backend/rotas/bancario.js'), /open-finance\/callback', perm/);
  });
});
