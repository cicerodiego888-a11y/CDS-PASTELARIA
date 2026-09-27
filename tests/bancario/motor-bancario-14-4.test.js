/**
 * Sprint MBC-14.4 — credenciais Mercado Pago no SecretStore.
 * Executar: node --test tests/bancario/motor-bancario-14-4.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const UsuarioEmpresaService = require('../../backend/services/empresas/UsuarioEmpresaService');
const { ModoOperacionalGlobal } = require('../../backend/core/modo-operacional');
const { garantirSchemaBancarioAsync } = require('../../backend/motores/bancario/schema/bancarioSchema');
const { obterMotorBancario } = require('../../backend/motores/bancario/MotorBancarioService');
const { resolverEmpresaIdParaBancario } = require('../../backend/motores/bancario/BancarioEmpresaContextoService');
const { criarRouter } = require('../../backend/rotas/bancario');
const { ERROS } = require('../../backend/motores/bancario/contracts/constantes');
const { MemorySecretStore } = require('../../backend/motores/bancario/secrets/MemorySecretStore');
const { chaveSecretMercadoPago } = require('../../backend/motores/bancario/services/ConfiguracaoIntegracaoBancariaService');
const { OpenFinanceRealBankProvider } = require('../../backend/motores/bancario/providers/openfinance-real/OpenFinanceRealBankProvider');
const VERSAO = require('../../backend/motores/bancario/version');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';
const CLIENT_ID = 'APP-ID-PUBLICO-144';
const SECRET = 's3cr3t!@# com espaço';

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_) { resolve(); }
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

async function setup() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaUsuarioEmpresasAsync(db);
  await garantirSchemaBancarioAsync(db);
  const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaA.id, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaB.id, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(2, empresaA.id, { db });
  const secretStore = new MemorySecretStore();
  const motor = obterMotorBancario({ db, secretStore });
  const inst = await motor.criarInstituicao({ nome: 'MP', codigo: '323' });
  const contaA = await motor.criarConta({
    empresaId: empresaA.id, instituicao_financeira_id: inst.id, nome: 'CA', tipo: 'CORRENTE', numero: '1'
  });
  const contaB = await motor.criarConta({
    empresaId: empresaB.id, instituicao_financeira_id: inst.id, nome: 'CB', tipo: 'CORRENTE', numero: '2'
  });
  const cfgA = await motor.criarConfiguracaoIntegracao({
    empresaId: empresaA.id, conta_bancaria_id: contaA.id, provider: 'OPEN_FINANCE_REAL', ambiente: 'SANDBOX'
  });
  const cfgB = await motor.criarConfiguracaoIntegracao({
    empresaId: empresaB.id, conta_bancaria_id: contaB.id, provider: 'OPEN_FINANCE_REAL', ambiente: 'HOMOLOGACAO'
  });
  const depsMulti = {
    db,
    obterModoOperacionalGlobal: () => ModoOperacionalGlobal.MULTIEMPRESA
  };
  return { db, empresaA, empresaB, motor, secretStore, inst, contaA, contaB, cfgA, cfgB, depsMulti };
}

function listenApp(ctx, { userId, empresaId }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: userId };
    if (empresaId != null) req.empresaId = empresaId;
    next();
  });
  app.use('/api/bancario', criarRouter({
    db: ctx.db,
    auth: (_req, _res, next) => next(),
    obterMotorBancario: () => ctx.motor,
    resolverEmpresaIdParaBancario: (req, d) => resolverEmpresaIdParaBancario(req, { ...ctx.depsMulti, ...d })
  }));
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        async json(method, urlPath, body) {
          const res = await fetch('http://127.0.0.1:' + port + urlPath, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: body != null ? JSON.stringify(body) : undefined
          });
          const data = await res.json().catch(() => ({}));
          return { status: res.status, data, text: JSON.stringify(data) };
        },
        close() {
          return new Promise((r) => server.close(() => r()));
        }
      });
    });
  });
}

describe('MBC-14.4 credenciais', () => {
  it('T01 T02 T03 T06 — configura Client ID/Secret no SecretStore', async () => {
    const ctx = await setup();
    const out = await ctx.motor.configurarCredenciaisMercadoPago({
      empresaId: ctx.empresaA.id,
      id: ctx.cfgA.id,
      client_id: '  ' + CLIENT_ID + '  ',
      client_secret: SECRET
    });
    assert.equal(out.client_id, CLIENT_ID);
    assert.equal(out.client_id_configurado, true);
    assert.equal(out.secret_configurado, true);
    assert.equal(out.client_secret, undefined);
    const chave = chaveSecretMercadoPago(ctx.cfgA.id);
    assert.equal(await ctx.secretStore.has(chave), true);
    assert.equal(await ctx.secretStore.get(chave), SECRET);
    await closeDb(ctx.db);
  });

  it('T04 — secret não vai para SQLite', async () => {
    const ctx = await setup();
    await ctx.motor.configurarCredenciaisMercadoPago({
      empresaId: ctx.empresaA.id, id: ctx.cfgA.id, client_id: CLIENT_ID, client_secret: SECRET
    });
    const rows = await all(ctx.db, 'SELECT * FROM config_integracao_bancaria');
    const dump = JSON.stringify(rows);
    assert.equal(dump.includes(SECRET), false);
    assert.equal(rows.find((r) => r.id === ctx.cfgA.id).aplicacao_ref, CLIENT_ID);
    const storeRows = await all(ctx.db, 'SELECT * FROM mbc_secret_store');
    assert.equal(JSON.stringify(storeRows).includes(SECRET), false);
    await closeDb(ctx.db);
  });

  it('T05 T21 — GET retorna status sem secret', async () => {
    const ctx = await setup();
    await ctx.motor.configurarCredenciaisMercadoPago({
      empresaId: ctx.empresaA.id, id: ctx.cfgA.id, client_id: CLIENT_ID, client_secret: SECRET
    });
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json('GET', '/api/bancario/configuracoes/' + ctx.cfgA.id + '/credenciais');
    assert.equal(out.status, 200);
    assert.equal(out.data.secret_configurado, true);
    assert.equal(out.data.client_id_configurado, true);
    assert.equal(out.data.client_id, CLIENT_ID);
    assert.equal(out.data.client_secret, undefined);
    assert.equal(out.text.includes(SECRET), false);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T07 — atualização do secret', async () => {
    const ctx = await setup();
    await ctx.motor.configurarCredenciaisMercadoPago({
      empresaId: ctx.empresaA.id, id: ctx.cfgA.id, client_id: CLIENT_ID, client_secret: SECRET
    });
    await ctx.motor.configurarCredenciaisMercadoPago({
      empresaId: ctx.empresaA.id, id: ctx.cfgA.id, client_id: CLIENT_ID, client_secret: 'novo-secret-#1'
    });
    assert.equal(await ctx.secretStore.get(chaveSecretMercadoPago(ctx.cfgA.id)), 'novo-secret-#1');
    await closeDb(ctx.db);
  });

  it('T08 — atualização sem secret preserva secret', async () => {
    const ctx = await setup();
    await ctx.motor.configurarCredenciaisMercadoPago({
      empresaId: ctx.empresaA.id, id: ctx.cfgA.id, client_id: CLIENT_ID, client_secret: SECRET
    });
    await ctx.motor.configurarCredenciaisMercadoPago({
      empresaId: ctx.empresaA.id, id: ctx.cfgA.id, client_id: 'APP-NOVO'
    });
    assert.equal(await ctx.secretStore.get(chaveSecretMercadoPago(ctx.cfgA.id)), SECRET);
    const st = await ctx.motor.obterStatusCredenciaisIntegracao({ empresaId: ctx.empresaA.id, id: ctx.cfgA.id });
    assert.equal(st.client_id, 'APP-NOVO');
    assert.equal(st.secret_configurado, true);
    await closeDb(ctx.db);
  });

  it('T09 T24 — remoção explícita elimina secret', async () => {
    const ctx = await setup();
    await ctx.motor.configurarCredenciaisMercadoPago({
      empresaId: ctx.empresaA.id, id: ctx.cfgA.id, client_id: CLIENT_ID, client_secret: SECRET
    });
    const out = await ctx.motor.removerCredenciaisMercadoPago({ empresaId: ctx.empresaA.id, id: ctx.cfgA.id });
    assert.equal(out.secret_configurado, false);
    assert.equal(out.client_id_configurado, false);
    assert.equal(await ctx.secretStore.has(chaveSecretMercadoPago(ctx.cfgA.id)), false);
    await closeDb(ctx.db);
  });

  it('T10 — configuração inexistente', async () => {
    const ctx = await setup();
    await assert.rejects(
      () => ctx.motor.configurarCredenciaisMercadoPago({
        empresaId: ctx.empresaA.id, id: 99999, client_id: CLIENT_ID, client_secret: SECRET
      }),
      (err) => err.code === ERROS.CONFIG_NAO_ENCONTRADA && err.statusCode === 404
    );
    await closeDb(ctx.db);
  });

  it('T11 — usuário sem permissão', async () => {
    const ctx = await setup();
    const api = await listenApp(ctx, { userId: 2, empresaId: ctx.empresaB.id });
    const out = await api.json('POST', '/api/bancario/configuracoes/' + ctx.cfgB.id + '/credenciais', {
      client_id: CLIENT_ID, client_secret: SECRET
    });
    assert.equal(out.status, 403);
    assert.equal(out.text.includes(SECRET), false);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T12 — empresa A isolada de empresa B', async () => {
    const ctx = await setup();
    await ctx.motor.configurarCredenciaisMercadoPago({
      empresaId: ctx.empresaA.id, id: ctx.cfgA.id, client_id: CLIENT_ID, client_secret: SECRET
    });
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaB.id });
    const out = await api.json('GET', '/api/bancario/configuracoes/' + ctx.cfgA.id + '/credenciais');
    assert.equal(out.status, 404);
    assert.equal(out.text.includes(SECRET), false);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T13 — empresa_id do body não altera ownership', async () => {
    const ctx = await setup();
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json('POST', '/api/bancario/configuracoes/' + ctx.cfgA.id + '/credenciais', {
      client_id: CLIENT_ID,
      client_secret: SECRET,
      empresa_id: ctx.empresaB.id
    });
    assert.equal(out.status, 200);
    const cfg = await ctx.motor.obterConfiguracaoIntegracao({ empresaId: ctx.empresaA.id, id: ctx.cfgA.id });
    assert.equal(cfg.empresa_id, ctx.empresaA.id);
    const daB = await ctx.motor.obterStatusCredenciaisIntegracao({ empresaId: ctx.empresaB.id, id: ctx.cfgB.id });
    assert.equal(daB.secret_configurado, false);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T14 — provider inválido', async () => {
    const ctx = await setup();
    const mock = await ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id, conta_bancaria_id: ctx.contaA.id, provider: 'MOCK', ambiente: 'TESTE'
    });
    await assert.rejects(
      () => ctx.motor.configurarCredenciaisMercadoPago({
        empresaId: ctx.empresaA.id, id: mock.id, client_id: CLIENT_ID, client_secret: SECRET
      }),
      (err) => err.code === ERROS.PROVIDER_CREDENCIAL_INCOMPATIVEL && err.statusCode === 409
    );
    await closeDb(ctx.db);
  });

  it('T15 — ambiente inválido', async () => {
    const ctx = await setup();
    await assert.rejects(
      () => ctx.motor.configurarCredenciaisMercadoPago({
        empresaId: ctx.empresaA.id,
        id: ctx.cfgA.id,
        client_id: CLIENT_ID,
        client_secret: SECRET,
        ambiente: 'TESTE'
      }),
      (err) => err.code === ERROS.AMBIENTE_INVALIDO && err.statusCode === 400
    );
    await closeDb(ctx.db);
  });

  it('T16 — Client ID obrigatório', async () => {
    const ctx = await setup();
    await assert.rejects(
      () => ctx.motor.configurarCredenciaisMercadoPago({
        empresaId: ctx.empresaA.id, id: ctx.cfgA.id, client_id: '   ', client_secret: SECRET
      }),
      (err) => err.code === ERROS.CREDENCIAL_CLIENT_ID_OBRIGATORIO && err.statusCode === 400
    );
    await closeDb(ctx.db);
  });

  it('T17 — Client Secret obrigatório na primeira configuração', async () => {
    const ctx = await setup();
    await assert.rejects(
      () => ctx.motor.configurarCredenciaisMercadoPago({
        empresaId: ctx.empresaA.id, id: ctx.cfgA.id, client_id: CLIENT_ID
      }),
      (err) => err.code === ERROS.CREDENCIAL_SECRET_OBRIGATORIO && err.statusCode === 400
    );
    await closeDb(ctx.db);
  });

  it('T18 — caracteres especiais e espaços internos no secret', async () => {
    const ctx = await setup();
    const especial = '  a!@#$%  b\tc  ';
    await ctx.motor.configurarCredenciaisMercadoPago({
      empresaId: ctx.empresaA.id, id: ctx.cfgA.id, client_id: CLIENT_ID, client_secret: especial
    });
    assert.equal(await ctx.secretStore.get(chaveSecretMercadoPago(ctx.cfgA.id)), especial.trim());
    await closeDb(ctx.db);
  });
});

describe('MBC-14.4 segurança e frontend', () => {
  it('T19 T20 — secret não aparece em logs nem erro', async () => {
    const ctx = await setup();
    const logs = [];
    const orig = console.log;
    console.log = function () { logs.push(Array.from(arguments).join(' ')); };
    try {
      await ctx.motor.configurarCredenciaisMercadoPago({
        empresaId: ctx.empresaA.id, id: ctx.cfgA.id, client_id: CLIENT_ID, client_secret: SECRET
      });
      try {
        await ctx.motor.configurarCredenciaisMercadoPago({
          empresaId: ctx.empresaA.id, id: 99999, client_id: CLIENT_ID, client_secret: SECRET
        });
      } catch (err) {
        assert.equal(String(err.message).includes(SECRET), false);
        assert.equal(JSON.stringify(err).includes(SECRET), false);
      }
    } finally {
      console.log = orig;
    }
    assert.equal(logs.join('\n').includes(SECRET), false);
    assert.equal(JSON.stringify(ctx.secretStore).includes(SECRET), false);
    await closeDb(ctx.db);
  });

  it('T22 — provider recupera credenciais internamente (service, não contrato Motor)', async () => {
    const ConfiguracaoIntegracaoBancariaService = require('../../backend/motores/bancario/services/ConfiguracaoIntegracaoBancariaService');
    const ctx = await setup();
    await ctx.motor.configurarCredenciaisMercadoPago({
      empresaId: ctx.empresaA.id, id: ctx.cfgA.id, client_id: CLIENT_ID, client_secret: SECRET
    });
    assert.equal(typeof ctx.motor.obterCredenciaisProvider, 'undefined');
    const cred = await ConfiguracaoIntegracaoBancariaService.obterCredenciaisProvider({
      db: ctx.db, secretStore: ctx.secretStore, empresaId: ctx.empresaA.id, id: ctx.cfgA.id
    });
    assert.equal(cred.client_id, CLIENT_ID);
    assert.equal(cred.client_secret, SECRET);
    const provider = new OpenFinanceRealBankProvider({ secretStore: ctx.secretStore });
    const via = await provider.obterCredenciaisOperacao({
      empresaId: ctx.empresaA.id,
      configuracaoId: ctx.cfgA.id,
      obterCredenciaisProvider: (p) => ConfiguracaoIntegracaoBancariaService.obterCredenciaisProvider({
        db: ctx.db, secretStore: ctx.secretStore, ...p
      })
    });
    assert.equal(via.client_secret, SECRET);
    await closeDb(ctx.db);
  });

  it('T23 T25 — frontend só status; troca de empresa limpa', () => {
    const js = src('frontend/erp/js/contas-bancarias.js');
    const html = src('frontend/erp/pages/contas-bancarias.html');
    assert.match(html, /Mercado Pago/);
    assert.match(html, /id="mbcMpSecret"[^>]*type="password"/);
    assert.match(js, /\/credenciais/);
    assert.match(js, /client_id_configurado/);
    assert.match(js, /secret_configurado/);
    assert.match(js, /Credenciais configuradas/);
    assert.match(js, /limparCampoMpSecret|mbcMpSecret/);
    assert.match(js, /cds-empresa-contexto-alterado/);
    assert.doesNotMatch(js, /localStorage\.setItem\([^)]*mbcMpSecret/);
    assert.doesNotMatch(js, /7468149648957279/);
    assert.equal(/access_token|client_secret/.test(js), false);
    assert.doesNotMatch(src('backend/motores/bancario/schema/bancarioSchema.js'), /client_secret/);
  });

  it('sprint, chave SecretStore e docs', () => {
    assert.ok(String(VERSAO.SPRINT).startsWith('MBC-'));
    assert.match(src('backend/motores/bancario/services/ConfiguracaoIntegracaoBancariaService.js'), /mbc\.config\./);
    assert.ok(fs.existsSync(path.join(ROOT, 'docs/bancario/MBC-14.4-RELATORIO.md')));
    assert.doesNotMatch(src('backend/mercado-pago/pkce.js'), /alterado MBC-14\.4/);
  });
});
