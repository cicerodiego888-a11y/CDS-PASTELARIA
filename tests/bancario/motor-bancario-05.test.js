/**
 * Sprint MBC-05 — provider MOCK + SecretStore.
 * Executar: node --test tests/bancario/motor-bancario-05.test.js
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
const { IBankProvider } = require('../../backend/motores/bancario/contracts/IBankProvider');
const { MockBankProvider } = require('../../backend/motores/bancario/providers/MockBankProvider');
const { criarRegistryPadrao } = require('../../backend/motores/bancario/providers/BankProviderRegistry');
const { MemorySecretStore } = require('../../backend/motores/bancario/secrets/MemorySecretStore');
const { ERROS, STATUS_REGISTRO } = require('../../backend/motores/bancario/contracts/constantes');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
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

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_) { resolve(); }
  });
}

async function setup() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaUsuarioEmpresasAsync(db);
  await garantirSchemaBancarioAsync(db);
  await run(db, `CREATE TABLE financeiro (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tipo TEXT, valor REAL, empresa_id INTEGER
  )`);
  const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaA.id, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaB.id, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(2, empresaA.id, { db });
  const secretStore = new MemorySecretStore();
  const registry = criarRegistryPadrao();
  const motor = obterMotorBancario({ db, secretStore, registry });
  const depsMulti = {
    db,
    obterModoOperacionalGlobal: () => ModoOperacionalGlobal.MULTIEMPRESA
  };
  return { db, empresaA, empresaB, motor, secretStore, registry, depsMulti };
}

async function criarConta(ctx, empresaId, nome, numero) {
  const inst = await ctx.motor.criarInstituicao({ nome: 'Inst ' + nome + ' ' + numero });
  return ctx.motor.criarConta({
    empresaId,
    instituicao_financeira_id: inst.id,
    nome,
    tipo: 'CORRENTE',
    numero
  });
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
    obterMotorBancario: (d) => obterMotorBancario({
      db: d.db || ctx.db,
      secretStore: ctx.secretStore,
      registry: ctx.registry
    }),
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
          return { status: res.status, data };
        },
        close() {
          return new Promise((r) => server.close(() => r()));
        }
      });
    });
  });
}

describe('MBC-05 provider e secrets', () => {
  it('T01 — registry encontra MOCK', () => {
    const r = criarRegistryPadrao();
    assert.equal(r.existe('MOCK'), true);
    assert.equal(r.obter('MOCK').codigo, 'MOCK');
  });

  it('T02 — provider desconhecido rejeitado', () => {
    const r = criarRegistryPadrao();
    assert.throws(() => r.obter('SICREDI'), (err) => err.code === ERROS.PROVIDER_DESCONHECIDO);
  });

  it('T03 — Mock implementa IBankProvider', () => {
    const mock = new MockBankProvider();
    assert.ok(mock instanceof IBankProvider);
  });

  it('T04 — Mock retorna DTO normalizado', async () => {
    const mock = new MockBankProvider();
    const dtos = await mock.listarTransacoes({ empresaId: 7, contaBancariaId: 3 });
    assert.equal(dtos.length, 1);
    assert.equal(dtos[0].empresa_id, 7);
    assert.equal(dtos[0].conta_bancaria_id, 3);
    assert.equal(dtos[0].external_source, 'MOCK');
    assert.equal(dtos[0].external_id, 'MOCK-TRANS-001');
  });

  it('T05 T06 — configuração criada e vinculada à conta', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '5');
    const cfg = await ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: conta.id,
      provider: 'MOCK',
      ambiente: 'TESTE'
    });
    assert.equal(cfg.conta_bancaria_id, conta.id);
    assert.equal(cfg.empresa_id, ctx.empresaA.id);
    assert.equal(cfg.provider, 'MOCK');
    await closeDb(ctx.db);
  });

  it('T07 — conta inexistente rejeitada', async () => {
    const ctx = await setup();
    await assert.rejects(
      () => ctx.motor.criarConfiguracaoIntegracao({
        empresaId: ctx.empresaA.id,
        conta_bancaria_id: 99999,
        provider: 'MOCK',
        ambiente: 'TESTE'
      }),
      (err) => err.code === ERROS.CONTA_NAO_ENCONTRADA
    );
    await closeDb(ctx.db);
  });

  it('T08 — conta de outra empresa rejeitada', async () => {
    const ctx = await setup();
    const contaB = await criarConta(ctx, ctx.empresaB.id, 'B', '8');
    await assert.rejects(
      () => ctx.motor.criarConfiguracaoIntegracao({
        empresaId: ctx.empresaA.id,
        conta_bancaria_id: contaB.id,
        provider: 'MOCK',
        ambiente: 'TESTE'
      }),
      (err) => err.statusCode === 404
    );
    await closeDb(ctx.db);
  });

  it('T09 — conta inativa rejeitada', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '9');
    await ctx.motor.desativarConta({ empresaId: ctx.empresaA.id, id: conta.id });
    await assert.rejects(
      () => ctx.motor.criarConfiguracaoIntegracao({
        empresaId: ctx.empresaA.id,
        conta_bancaria_id: conta.id,
        provider: 'MOCK',
        ambiente: 'TESTE'
      }),
      (err) => err.code === ERROS.CONTA_INATIVA
    );
    await closeDb(ctx.db);
  });

  it('T10 — empresa não autorizada recebe 403', async () => {
    const ctx = await setup();
    const api = await listenApp(ctx, { userId: 2, empresaId: ctx.empresaB.id });
    const out = await api.json('GET', '/api/bancario/configuracoes');
    assert.equal(out.status, 403);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T11 — empresa do body não altera contexto', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '11');
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json('POST', '/api/bancario/configuracoes', {
      conta_bancaria_id: conta.id,
      provider: 'MOCK',
      ambiente: 'TESTE',
      empresa_id: ctx.empresaB.id
    });
    assert.equal(out.status, 201);
    assert.equal(out.data.empresa_id, ctx.empresaA.id);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T12 — query empresa_id não altera contexto', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '12');
    await ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: conta.id,
      provider: 'MOCK',
      ambiente: 'TESTE'
    });
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json('GET', '/api/bancario/configuracoes?empresa_id=' + ctx.empresaB.id);
    assert.equal(out.status, 200);
    assert.equal(out.data.empresa_id, ctx.empresaA.id);
    assert.equal(out.data.configuracoes.length, 1);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T13 — provider inexistente rejeitado', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '13');
    await assert.rejects(
      () => ctx.motor.criarConfiguracaoIntegracao({
        empresaId: ctx.empresaA.id,
        conta_bancaria_id: conta.id,
        provider: 'OPEN_FINANCE',
        ambiente: 'TESTE'
      }),
      (err) => err.code === ERROS.PROVIDER_DESCONHECIDO
    );
    await closeDb(ctx.db);
  });

  it('T14 — MOCK + TESTE permitido', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '14');
    const cfg = await ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: conta.id,
      provider: 'MOCK',
      ambiente: 'TESTE'
    });
    assert.equal(cfg.ambiente, 'TESTE');
    await closeDb(ctx.db);
  });

  it('T15 — MOCK + PRODUCAO rejeitado', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '15');
    await assert.rejects(
      () => ctx.motor.criarConfiguracaoIntegracao({
        empresaId: ctx.empresaA.id,
        conta_bancaria_id: conta.id,
        provider: 'MOCK',
        ambiente: 'PRODUCAO'
      }),
      (err) => err.code === ERROS.AMBIENTE_INVALIDO
    );
    await closeDb(ctx.db);
  });

  it('T16 T17 T18 — uma ativa; desativar e ativar', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '16');
    const a = await ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: conta.id,
      provider: 'MOCK',
      ambiente: 'TESTE'
    });
    const b = await ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: conta.id,
      provider: 'MOCK',
      ambiente: 'TESTE'
    });
    const a2 = await ctx.motor.obterConfiguracaoIntegracao({ empresaId: ctx.empresaA.id, id: a.id });
    assert.equal(a2.ativo, false);
    assert.equal(b.ativo, true);
    const off = await ctx.motor.desativarConfiguracaoIntegracao({ empresaId: ctx.empresaA.id, id: b.id });
    assert.equal(off.ativo, false);
    const on = await ctx.motor.ativarConfiguracaoIntegracao({ empresaId: ctx.empresaA.id, id: a.id });
    assert.equal(on.ativo, true);
    await closeDb(ctx.db);
  });

  it('T19 — provider listado pela API', async () => {
    const ctx = await setup();
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json('GET', '/api/bancario/providers');
    assert.equal(out.status, 200);
    assert.equal(out.data.providers.some((p) => p.codigo === 'MOCK'), true);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T20 T25 — configuração não retorna secret; informa secret_configurado', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '20');
    const cfg = await ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: conta.id,
      provider: 'MOCK',
      ambiente: 'TESTE'
    });
    assert.equal(cfg.secret_configurado, false);
    assert.equal(cfg.access_token, undefined);
    assert.equal(cfg.client_secret, undefined);
    assert.equal(cfg.senha, undefined);
    const json = JSON.stringify(cfg);
    assert.equal(json.includes('secret_configurado'), true);
    assert.doesNotMatch(json, /access_token|refresh_token|client_secret/);
    await closeDb(ctx.db);
  });

  it('T21 — secret não aparece em logs do MBC', () => {
    const motor = src('backend/motores/bancario/MotorBancarioService.js');
    const cfg = src('backend/motores/bancario/services/ConfiguracaoIntegracaoBancariaService.js');
    assert.doesNotMatch(motor, /console\.log\(.*token|console\.log\(.*secret|console\.log\(config\)/i);
    assert.doesNotMatch(cfg, /console\.log\(/);
  });

  it('T22 T23 — SecretStore salva, recupera e remove', async () => {
    const store = new MemorySecretStore();
    await store.set('k1', 'valor-teste');
    assert.equal(await store.has('k1'), true);
    assert.equal(await store.get('k1'), 'valor-teste');
    await store.delete('k1');
    assert.equal(await store.has('k1'), false);
    assert.equal(await store.get('k1'), null);
  });

  it('T24 — SecretStore não retorna secret por endpoint', () => {
    const rotas = src('backend/rotas/bancario.js');
    assert.doesNotMatch(rotas, /\/secrets/);
    assert.doesNotMatch(rotas, /secretStore\.get/);
  });

  it('T26 — Mock gera external_id determinístico', async () => {
    const mock = new MockBankProvider();
    const a = await mock.listarTransacoes({ empresaId: 1, contaBancariaId: 1 });
    const b = await mock.listarTransacoes({ empresaId: 1, contaBancariaId: 1 });
    assert.equal(a[0].external_id, 'MOCK-TRANS-001');
    assert.equal(b[0].external_id, 'MOCK-TRANS-001');
  });

  it('T27 T28 T34 — persistência MOCK CRIADA e depois JA_EXISTENTE', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '27');
    const cfg = await ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: conta.id,
      provider: 'MOCK',
      ambiente: 'TESTE'
    });
    const p1 = await ctx.motor.executarProvider({
      empresaId: ctx.empresaA.id,
      id: cfg.id,
      persistir: true
    });
    assert.equal(p1.persistidas[0].status, STATUS_REGISTRO.CRIADA);
    const p2 = await ctx.motor.executarProvider({
      empresaId: ctx.empresaA.id,
      id: cfg.id,
      persistir: true
    });
    assert.equal(p2.persistidas[0].status, STATUS_REGISTRO.JA_EXISTENTE);
    const lista = await ctx.motor.listarTransacoes({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id });
    assert.equal(lista.length, 1);
    await closeDb(ctx.db);
  });

  it('T29 T30 — provider não altera financeiro nem cria conciliação', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '29');
    const cfg = await ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: conta.id,
      provider: 'MOCK',
      ambiente: 'TESTE'
    });
    await ctx.motor.executarProvider({ empresaId: ctx.empresaA.id, id: cfg.id, persistir: true });
    const fin = await get(ctx.db, 'SELECT COUNT(*) AS n FROM financeiro');
    const conc = await get(ctx.db, 'SELECT COUNT(*) AS n FROM conciliacao_bancaria');
    assert.equal(fin.n, 0);
    assert.equal(conc.n, 0);
    await closeDb(ctx.db);
  });

  it('T31 — troca de empresa não mistura configurações', async () => {
    const ctx = await setup();
    const cA = await criarConta(ctx, ctx.empresaA.id, 'A', '31a');
    const cB = await criarConta(ctx, ctx.empresaB.id, 'B', '31b');
    await ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: cA.id,
      provider: 'MOCK',
      ambiente: 'TESTE'
    });
    await ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaB.id,
      conta_bancaria_id: cB.id,
      provider: 'MOCK',
      ambiente: 'TESTE'
    });
    const apiA = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const la = await apiA.json('GET', '/api/bancario/configuracoes');
    assert.equal(la.data.configuracoes.length, 1);
    assert.equal(la.data.configuracoes[0].conta_bancaria_id, cA.id);
    await apiA.close();
    const apiB = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaB.id });
    const lb = await apiB.json('GET', '/api/bancario/configuracoes');
    assert.equal(lb.data.configuracoes.length, 1);
    assert.equal(lb.data.configuracoes[0].conta_bancaria_id, cB.id);
    await apiB.close();
    await closeDb(ctx.db);
  });

  it('T32 — configuração da conta A não executa no contexto B', async () => {
    const ctx = await setup();
    const cA = await criarConta(ctx, ctx.empresaA.id, 'A', '32');
    const cfg = await ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: cA.id,
      provider: 'MOCK',
      ambiente: 'TESTE'
    });
    await assert.rejects(
      () => ctx.motor.testarProvider({ empresaId: ctx.empresaB.id, id: cfg.id }),
      (err) => err.statusCode === 404
    );
    await closeDb(ctx.db);
  });

  it('T33 — segredo não aparece em objeto serializado', async () => {
    const store = new MemorySecretStore();
    await store.set('k', 'super-secreto-xyz');
    const s = JSON.stringify(store);
    assert.equal(s.includes('super-secreto-xyz'), false);
    assert.equal(s.includes('[REDACTED]'), true);
  });

  it('T36 — store cifrado recusa gravar sem MBC_SECRET_STORE_KEY', async () => {
    const prev = process.env.MBC_SECRET_STORE_KEY;
    delete process.env.MBC_SECRET_STORE_KEY;
    const { EncryptedLocalSecretStore } = require('../../backend/motores/bancario/secrets/EncryptedLocalSecretStore');
    const store = new EncryptedLocalSecretStore({ db: null });
    await assert.rejects(() => store.set('x', 'y'), (err) => err.code === ERROS.SECRET_KEY_AUSENTE);
    if (prev !== undefined) process.env.MBC_SECRET_STORE_KEY = prev;
  });

  it('T37 — testar HTTP não persiste transação', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '37');
    const cfg = await ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: conta.id,
      provider: 'MOCK',
      ambiente: 'TESTE'
    });
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json('POST', '/api/bancario/configuracoes/' + cfg.id + '/testar');
    assert.equal(out.status, 200);
    assert.equal(out.data.persistiu, false);
    const lista = await ctx.motor.listarTransacoes({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id });
    assert.equal(lista.length, 0);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T35 — provider não persiste diretamente em transacao_bancaria', () => {
    assert.doesNotMatch(src('backend/motores/bancario/providers/MockBankProvider.js'), /INSERT INTO transacao_bancaria/i);
    assert.doesNotMatch(src('backend/motores/bancario/providers/MockBankProvider.js'), /require\(['"]https?['"]\)|fetch\(/i);
  });
});

describe('MBC-05 invariantes', () => {
  it('sem OAuth/Open Finance; UI sem secret; teste HTTP não persiste', () => {
    assert.doesNotMatch(src('backend/rotas/bancario.js'), /oauth/i);
    assert.doesNotMatch(src('frontend/erp/js/contas-bancarias.js'), /client_secret|Conectar Banco|Sincronizar Banco/i);
    assert.match(src('frontend/erp/pages/contas-bancarias.html'), /Provider de teste/);
    assert.match(src('backend/rotas/bancario.js'), /persistiu: false/);
  });
});
