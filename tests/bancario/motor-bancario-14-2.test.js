/**
 * Sprint MBC-14.2 — Cloudflare Tunnel preparado, sem ativação real.
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
const { chaveSecretConsentimento } = require('../../backend/motores/bancario/services/ConsentimentoOpenFinanceService');
const {
  HOST_LOCAL,
  criarAppCallbackMercadoPago
} = require('../../backend/mercado-pago/oauth-callback-server');
const { statusRedirectUriOficial } = require('../../backend/mercado-pago/redirectUri');
const { gerarPkceS256 } = require('../../backend/mercado-pago/pkce');
const {
  DESTINO_LOCAL,
  avaliarProntidaoTunnel,
  montarIngressTunnel,
  montarYamlTunnel,
  redirectUriProducaoConceitual,
  yamlContemProibicoes,
  MSG_TUNNEL_NAO_ATIVADO
} = require('../../backend/mercado-pago/cloudflareTunnel');
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
function closeDb(db) {
  return new Promise((resolve) => { try { db.close(() => resolve()); } catch (_) { resolve(); } });
}

async function setup() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaUsuarioEmpresasAsync(db);
  await garantirSchemaBancarioAsync(db);
  const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaA.id, { db });
  const secretStore = new MemorySecretStore();
  const motor = obterMotorBancario({ db, secretStore });
  return { db, empresaA, empresaB, motor, secretStore };
}

function listenGateway(ctx) {
  const app = criarAppCallbackMercadoPago({ obterMotorBancario: () => ctx.motor, logger: () => {} });
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, HOST_LOCAL, () => {
      const { port, address } = server.address();
      resolve({
        address,
        async get(p) {
          const res = await fetch('http://127.0.0.1:' + port + p);
          return { status: res.status, text: await res.text(), json: null };
        },
        close() { return new Promise((r) => server.close(() => r())); }
      });
    });
  });
}

describe('MBC-14.2 isolamento e prontidão', () => {
  it('T01 — gateway 127.0.0.1', () => {
    assert.equal(HOST_LOCAL, '127.0.0.1');
    assert.match(src('backend/mercado-pago/oauth-callback-server.js'), /listen\(port, HOST_LOCAL/);
  });
  it('T02 T29 — Tunnel não usa 3001', () => {
    assert.equal(DESTINO_LOCAL, 'http://127.0.0.1:3010');
    assert.equal(DESTINO_LOCAL.includes('3001'), false);
    const yaml = montarYamlTunnel({
      CLOUDFLARE_TUNNEL_ID: 'id-teste-local',
      CLOUDFLARE_TUNNEL_HOSTNAME: 'host-teste.invalid',
      CLOUDFLARE_CREDENTIALS_FILE: 'C:\\\\cred.json'
    });
    assert.equal(yamlContemProibicoes(yaml), false);
    assert.equal(yaml.includes('3001'), false);
  });
  it('T03 — gateway separado do ERP', () => {
    assert.equal(src('backend/server.js').includes('oauth-callback-server'), false);
    assert.match(src('package.json'), /start:mercado-pago-oauth/);
  });
  it('T04 T05 T06 T07 T26 — 404 e sem proxy ERP', async () => {
    const ctx = await setup();
    const gw = await listenGateway(ctx);
    for (const p of ['/x', '/api/vendas', '/api/financeiro', '/api/bancario', '/erp', '/pdv']) {
      assert.equal((await gw.get(p)).status, 404);
    }
    await gw.close();
    await closeDb(ctx.db);
  });
  it('T08 — SQLite não exposto', () => {
    const s = src('backend/mercado-pago/oauth-callback-server.js');
    assert.equal(/express\.static|mercadao\.db|\.sqlite/.test(s), false);
  });
  it('T09 — token não no log do tunnel', () => {
    assert.equal(src('backend/mercado-pago/iniciar-cloudflare-tunnel.js').includes('process.env.CLOUDFLARE_TOKEN'), false);
  });
  it('T10 T27 — health sem credencial', async () => {
    const app = criarAppCallbackMercadoPago({ obterMotorBancario: () => ({}) });
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, HOST_LOCAL, r));
    const port = server.address().port;
    const h = await fetch('http://127.0.0.1:' + port + '/health');
    const j = await h.json();
    const dump = JSON.stringify(j);
    assert.equal(j.servico, 'callback-oauth-mercado-pago');
    assert.equal(/token|secret|credential|sqlite|3001/i.test(dump), false);
    await new Promise((r) => server.close(() => r()));
  });
  it('T11 — frontend sem credencial Cloudflare', () => {
    assert.equal(src('frontend/erp/js/contas-bancarias.js').includes('CLOUDFLARE'), false);
  });
  it('T12 T28 — hostname fictício não ativado', () => {
    const js = src('backend/mercado-pago/cloudflareTunnel.js');
    assert.equal(js.includes('oauth.cdsistemas.com.br'), false);
    assert.equal(avaliarProntidaoTunnel({}).producao_ativada, false);
    assert.equal(avaliarProntidaoTunnel({}).hostname, 'NAO_CONFIGURADO');
  });
  it('T13 — sem hostname = não configurado', () => {
    const p = avaliarProntidaoTunnel({ CLOUDFLARE_TUNNEL_ID: 'x', CLOUDFLARE_CREDENTIALS_FILE: 'c' });
    assert.equal(p.status, 'NAO_CONFIGURADO');
    assert.ok(p.motivos.includes('HOSTNAME_AUSENTE'));
  });
  it('T14 — sem Tunnel ID = não configurado', () => {
    const p = avaliarProntidaoTunnel({ CLOUDFLARE_TUNNEL_HOSTNAME: 'a.b', CLOUDFLARE_CREDENTIALS_FILE: 'c' });
    assert.ok(p.motivos.includes('TUNNEL_ID_AUSENTE'));
  });
  it('T15 — sem credencial = não configurado', () => {
    const p = avaliarProntidaoTunnel({ CLOUDFLARE_TUNNEL_ID: 'x', CLOUDFLARE_TUNNEL_HOSTNAME: 'a.b' });
    assert.ok(p.motivos.includes('CREDENTIALS_FILE_AUSENTE'));
    assert.equal(montarYamlTunnel({}), null);
  });
  it('T16 T17 — HTTP não é redirect oficial; HTTPS obrigatório', () => {
    assert.equal(statusRedirectUriOficial({ MERCADO_PAGO_OAUTH_REDIRECT_URI: 'http://x.com/cb' }).status, 'NAO_CONFIGURADO');
    const conc = redirectUriProducaoConceitual({ CLOUDFLARE_TUNNEL_HOSTNAME: 'callback.invalid' });
    assert.ok(conc.uri.startsWith('https://'));
    assert.equal(avaliarProntidaoTunnel({}).https_obrigatorio, true);
  });
  it('T18 — MBC-14.1 íntegra', () => {
    assert.match(src('backend/mercado-pago/oauth-callback-server.js'), /127\.0\.0\.1/);
    assert.match(src('backend/mercado-pago/oauth-callback-server.js'), /processarCallbackConsentimento/);
  });
});

describe('MBC-14.2 MBC-14.1 e decisão', () => {
  it('T19 T20 T21 — state e empresa', async () => {
    const ctx = await setup();
    const inst = await ctx.motor.criarInstituicao({ nome: 'I142' });
    const c = await ctx.motor.criarConta({
      empresaId: ctx.empresaA.id, instituicao_financeira_id: inst.id, nome: 'C', tipo: 'CORRENTE', numero: '1'
    });
    await ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id, conta_bancaria_id: c.id, provider: 'MOCK_OPEN_FINANCE', ambiente: 'TESTE'
    });
    const ini = await ctx.motor.iniciarConsentimento({
      empresaId: ctx.empresaA.id, conta_bancaria_id: c.id, provider: 'MOCK_OPEN_FINANCE'
    });
    const state = stateDaUrl(ini.authorization_url);
    const gw = await listenGateway(ctx);
    const sem = await gw.get('/api/bancario/mercado-pago/oauth/callback');
    assert.equal(sem.status, 400);
    const ok = await gw.get('/api/bancario/mercado-pago/oauth/callback?state=' + encodeURIComponent(state) + '&code=1&empresa_id=' + ctx.empresaB.id);
    assert.equal(ok.status, 200);
    const replay = await gw.get('/api/bancario/mercado-pago/oauth/callback?state=' + encodeURIComponent(state) + '&code=1');
    assert.equal(replay.status, 400);
    const lista = await ctx.motor.listarConsentimentos({ empresaId: ctx.empresaA.id, conta_bancaria_id: c.id });
    assert.equal(lista[0].empresa_id, ctx.empresaA.id);
    await gw.close();
    await closeDb(ctx.db);
  });
  it('T22 — PKCE server-side', () => {
    const p = gerarPkceS256();
    assert.equal(p.code_challenge_method, 'S256');
  });
  it('T23 — SecretStore isolado', () => {
    assert.match(src('backend/mercado-pago/pkce.js'), /ISecretStore|secretStore/);
    assert.equal(src('backend/mercado-pago/oauth-callback-server.js').includes('secretStore'), false);
  });
  it('T24 — OF_MOCK_REF só MOCK', () => {
    const s = src('backend/motores/bancario/services/ConsentimentoOpenFinanceService.js');
    assert.match(s, /MOCK_OPEN_FINANCE/);
    assert.match(s, /OF_MOCK_REF/);
  });
  it('T25 — ERP JWT', () => {
    assert.match(src('backend/server.js'), /app\.use\('\/api\/bancario', verificarToken/);
  });
  it('T30 — 404 final no ingress', () => {
    const ingress = montarIngressTunnel({
      CLOUDFLARE_TUNNEL_ID: 'id-teste-local',
      CLOUDFLARE_TUNNEL_HOSTNAME: 'host-teste.invalid',
      CLOUDFLARE_CREDENTIALS_FILE: 'C:\\\\cred.json'
    });
    assert.equal(ingress[ingress.length - 1].service, 'http_status:404');
  });
  it('T31 — NO-GO e mensagem oficial', () => {
    const p = avaliarProntidaoTunnel({});
    assert.equal(p.decisao, 'NO-GO');
    assert.equal(p.quick_tunnel, false);
    assert.equal(p.mensagem, MSG_TUNNEL_NAO_ATIVADO);
    assert.equal(VERSAO.SPRINT, 'MBC-14.2');
  });
  it('T32 — trycloudflare recusado', () => {
    const p = avaliarProntidaoTunnel({
      CLOUDFLARE_TUNNEL_ID: 'x',
      CLOUDFLARE_TUNNEL_HOSTNAME: 'abc.trycloudflare.com',
      CLOUDFLARE_CREDENTIALS_FILE: 'c'
    });
    assert.equal(p.configurado, false);
  });
  it('T33 — docs e MERCADO_PAGO_OAUTH_REDIRECT_URI não preenchida', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'docs/bancario/MBC-14.2-CLOUDFLARE-TUNNEL-PRODUCAO.md')));
    assert.ok(fs.existsSync(path.join(ROOT, 'docs/bancario/MBC-14.2-RELATORIO.md')));
    assert.equal(statusRedirectUriOficial({}).status, 'NAO_CONFIGURADO');
  });
});
