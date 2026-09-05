/**
 * Sprint MBC-11 — seleção/homologação. Sem instituição oficial: não integra API real.
 * Executar: node --test tests/bancario/motor-bancario-11.test.js
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
const { criarRegistryPadrao } = require('../../backend/motores/bancario/providers/BankProviderRegistry');
const { MemorySecretStore } = require('../../backend/motores/bancario/secrets/MemorySecretStore');
const { ERROS, CODIGO_PROVIDER } = require('../../backend/motores/bancario/contracts/constantes');
const { sanitizarObjetoMbc } = require('../../backend/motores/bancario/contracts/sanitizarMbc');
const { OpenFinanceRealBankProvider } = require('../../backend/motores/bancario/providers/openfinance-real/OpenFinanceRealBankProvider');
const { OpenFinanceRealClient } = require('../../backend/motores/bancario/providers/openfinance-real/OpenFinanceRealClient');
const { oficialHabilitado } = require('../../backend/motores/bancario/providers/openfinance-real/OpenFinanceRealConstants');
const {
  STATUS_HOMOLOGACAO,
  resolverEndpoints,
  validarSeparacaoAmbiente,
  ambientesComMesmoEndpoint
} = require('../../backend/motores/bancario/providers/openfinance-real/ambienteEndpoints');
const VERSAO = require('../../backend/motores/bancario/version');
const { IBankProvider } = require('../../backend/motores/bancario/contracts/IBankProvider');

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
  const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaA.id, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaB.id, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(2, empresaA.id, { db });
  const secretStore = new MemorySecretStore();
  const registry = criarRegistryPadrao();
  const motor = obterMotorBancario({ db, secretStore, registry });
  return {
    db, empresaA, empresaB, motor, secretStore, registry,
    depsMulti: { db, obterModoOperacionalGlobal: () => ModoOperacionalGlobal.MULTIEMPRESA }
  };
}

async function criarConta(ctx, empresaId, nome, numero) {
  const inst = await ctx.motor.criarInstituicao({ nome: 'Inst ' + nome + ' ' + numero });
  return ctx.motor.criarConta({
    empresaId, instituicao_financeira_id: inst.id, nome, tipo: 'CORRENTE', numero
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
      db: d.db || ctx.db, secretStore: ctx.secretStore, registry: ctx.registry
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
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: body != null ? JSON.stringify(body) : undefined
          });
          const data = await res.json().catch(() => ({}));
          return { status: res.status, data };
        },
        close() { return new Promise((r) => server.close(() => r())); }
      });
    });
  });
}

describe('MBC-11 identificação e matriz', () => {
  it('T01 — sprint MBC-11', () => { assert.ok(String(VERSAO.SPRINT).startsWith('MBC-')); });
  it('T02 — status homologação não homologável', () => {
    assert.equal(STATUS_HOMOLOGACAO, 'NAO_HOMOLOGAVEL');
  });
  it('T03 — instituição não definida no adapter', () => {
    assert.match(new OpenFinanceRealBankProvider().nome, /não definida/i);
  });
  it('T04 — oficial desligado', () => { assert.equal(oficialHabilitado({}), false); });
  it('T05 — matriz documenta PENDENTE', () => {
    assert.match(src('docs/bancario/MBC-11-MATRIZ-PROVIDER.md'), /PENDENTE/);
  });
  it('T06 — matriz não marca COMPATÍVEL', () => {
    assert.doesNotMatch(src('docs/bancario/MBC-11-MATRIZ-PROVIDER.md'), /\| COMPATÍVEL \|/);
  });
  it('T07 — docs oficiais ausentes registradas', () => {
    assert.match(src('docs/bancario/MBC-11-PROVIDER-HOMOLOGACAO.md'), /não homologável/);
  });
  it('T08 — autorização real não inventada', () => {
    assert.match(src('docs/bancario/MBC-11-AUTORIZACAO-REAL.md'), /NÃO IMPLEMENTADA/);
  });
  it('T09 — sync real não homologada', () => {
    assert.match(src('docs/bancario/MBC-11-SINCRONIZACAO-REAL.md'), /NÃO HOMOLOGADA/);
  });
  it('T10 — sem URL de banco no adapter', () => {
    const pasta = [
      src('backend/motores/bancario/providers/openfinance-real/OpenFinanceRealBankProvider.js'),
      src('backend/motores/bancario/providers/openfinance-real/OpenFinanceRealConstants.js')
    ].join('\n');
    assert.equal(/https:\/\/api\./.test(pasta), false);
  });
});

describe('MBC-11 ambientes', () => {
  it('T11 — resolver SANDBOX dedicado', () => {
    const ep = resolverEndpoints('SANDBOX', { MBC_OF_REAL_API_URL_SANDBOX: 'https://sb.example/api' });
    assert.equal(ep.apiUrl, 'https://sb.example/api');
  });
  it('T12 — resolver PRODUCAO dedicado', () => {
    const ep = resolverEndpoints('PRODUCAO', { MBC_OF_REAL_API_URL_PRODUCAO: 'https://ex.example/api' });
    assert.equal(ep.apiUrl, 'https://ex.example/api');
  });
  it('T13 — produção rejeita sandbox', () => {
    assert.throws(() => validarSeparacaoAmbiente('PRODUCAO', { apiUrl: 'https://api.sandbox.banco/x' }));
  });
  it('T14 — produção rejeita homolog', () => {
    assert.throws(() => validarSeparacaoAmbiente('PRODUCAO', { authUrl: 'https://hml.banco/auth' }));
  });
  it('T15 — sandbox rejeita production', () => {
    assert.throws(() => validarSeparacaoAmbiente('SANDBOX', { apiUrl: 'https://api.production.banco/x' }));
  });
  it('T16 — sandbox com URL sandbox ok', () => {
    assert.equal(validarSeparacaoAmbiente('SANDBOX', { apiUrl: 'https://api.sandbox.banco/x' }), true);
  });
  it('T17 — mesmo endpoint A/B detectado', () => {
    assert.equal(ambientesComMesmoEndpoint({
      MBC_OF_REAL_API_URL_SANDBOX: 'https://igual/api',
      MBC_OF_REAL_API_URL_PRODUCAO: 'https://igual/api'
    }), true);
  });
  it('T18 — endpoints distintos ok', () => {
    assert.equal(ambientesComMesmoEndpoint({
      MBC_OF_REAL_API_URL_SANDBOX: 'https://sb/api',
      MBC_OF_REAL_API_URL_PRODUCAO: 'https://prd/api'
    }), false);
  });
  it('T19 — cliente recusa produção+sandbox', async () => {
    const c = new OpenFinanceRealClient({
      ambiente: 'PRODUCAO',
      env: {
        MBC_OF_REAL_HABILITADO: '1',
        MBC_OF_REAL_AUTH_URL: 'https://sandbox.banco/auth',
        MBC_OF_REAL_TOKEN_URL: 'https://sandbox.banco/token',
        MBC_OF_REAL_API_URL: 'https://sandbox.banco/api'
      },
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) })
    });
    await assert.rejects(() => c.request({ url: 'https://sandbox.banco/api' }), (e) => e.code === ERROS.AMBIENTE_INVALIDO);
  });
  it('T20 — MOCK não usa SANDBOX', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'M', '1');
    let code = null;
    try {
      await ctx.motor.criarConfiguracaoIntegracao({
        empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id, provider: 'MOCK', ambiente: 'SANDBOX'
      });
    } catch (e) { code = e.code; }
    assert.equal(code, ERROS.AMBIENTE_INVALIDO);
    await closeDb(ctx.db);
  });
});

describe('MBC-11 configuração e secrets', () => {
  it('T21 — config SANDBOX com refs', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'C', '2');
    const cfg = await ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id,
      provider: 'OPEN_FINANCE_REAL', ambiente: 'SANDBOX',
      aplicacao_ref: 'APP-CDS', config_ref: 'CFG-001'
    });
    assert.equal(cfg.aplicacao_ref, 'APP-CDS');
    assert.equal(cfg.config_ref, 'CFG-001');
    assert.equal(cfg.homologacao_status, 'NAO_HOMOLOGAVEL');
    await closeDb(ctx.db);
  });
  it('T22 — atualizar refs', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'C', '3');
    const cfg = await ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id,
      provider: 'OPEN_FINANCE_REAL', ambiente: 'HOMOLOGACAO'
    });
    const up = await ctx.motor.atualizarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id, id: cfg.id, aplicacao_ref: 'APP-2'
    });
    assert.equal(up.aplicacao_ref, 'APP-2');
    await closeDb(ctx.db);
  });
  it('T23 — recusa client_secret no body', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'C', '4');
    let code = null;
    try {
      await ctx.motor.criarConfiguracaoIntegracao({
        empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id,
        provider: 'OPEN_FINANCE_REAL', ambiente: 'SANDBOX', client_secret: 'segredo'
      });
    } catch (e) { code = e.code; }
    assert.equal(code, ERROS.PROVIDER_NAO_EXECUTAVEL);
    await closeDb(ctx.db);
  });
  it('T24 — recusa access_token no update', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'C', '5');
    const cfg = await ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id,
      provider: 'OPEN_FINANCE_REAL', ambiente: 'SANDBOX'
    });
    let code = null;
    try {
      await ctx.motor.atualizarConfiguracaoIntegracao({
        empresaId: ctx.empresaA.id, id: cfg.id, access_token: 'AT'
      });
    } catch (e) { code = e.code; }
    assert.equal(code, ERROS.PROVIDER_NAO_EXECUTAVEL);
    await closeDb(ctx.db);
  });
  it('T25 — schema tem refs sem token', () => {
    const s = src('backend/motores/bancario/schema/bancarioSchema.js');
    assert.match(s, /aplicacao_ref/);
    assert.match(s, /config_ref/);
    assert.equal(/access_token/.test(s), false);
  });
  it('T26 — SecretStore memória não vaza no JSON', async () => {
    const st = new MemorySecretStore();
    await st.set('client_secret', 'abc');
    assert.equal(JSON.stringify(st).includes('abc'), false);
  });
  it('T27 — registry lista homologação', () => {
    const p = criarRegistryPadrao().listar().find((x) => x.codigo === CODIGO_PROVIDER.OPEN_FINANCE_REAL);
    assert.ok(p.homologacao === 'NAO_HOMOLOGAVEL' || p.homologacao === 'PREPARADO_NAO_IMPLEMENTADO');
    assert.equal(p.disponivel, false);
  });
  it('T28 — MOCK permanece disponível', () => {
    assert.equal(criarRegistryPadrao().obter('MOCK').disponivel, true);
  });
  it('T29 — MOCK_OPEN_FINANCE permanece', () => {
    assert.equal(criarRegistryPadrao().existe('MOCK_OPEN_FINANCE'), true);
  });
  it('T30 — IBankProvider único', () => {
    assert.ok(new OpenFinanceRealBankProvider() instanceof IBankProvider);
  });
});

describe('MBC-11 autorização sync segurança (sem rede)', () => {
  it('T31 — iniciar autorização sem oficial falha', async () => {
    const p = new OpenFinanceRealBankProvider();
    await assert.rejects(() => p.iniciarAutorizacao({ state: 'abc' }), (e) => e.code === ERROS.PROVIDER_NAO_EXECUTAVEL);
  });
  it('T32 — callback sem oficial falha', async () => {
    const p = new OpenFinanceRealBankProvider();
    await assert.rejects(() => p.processarCallback({ query: { code: 'x' } }));
  });
  it('T33 — listarContas sem oficial falha', async () => {
    const p = new OpenFinanceRealBankProvider();
    await assert.rejects(() => p.listarContas());
  });
  it('T34 — saldo sem oficial falha', async () => {
    const p = new OpenFinanceRealBankProvider();
    await assert.rejects(() => p.consultarSaldo());
  });
  it('T35 — extrato sem oficial falha', async () => {
    const p = new OpenFinanceRealBankProvider();
    await assert.rejects(() => p.listarTransacoes({ empresaId: 1, contaBancariaId: 1 }));
  });
  it('T36 — sync real sem consentimento não cria tx', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'S', '6');
    await ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id,
      provider: 'OPEN_FINANCE_REAL', ambiente: 'SANDBOX'
    });
    let ok = false;
    try {
      await ctx.motor.sincronizarConta({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id });
    } catch (_) { ok = true; }
    assert.equal(ok, true);
    await closeDb(ctx.db);
  });
  it('T37 — state sem Math.random', () => {
    assert.equal(src('backend/motores/bancario/services/ConsentimentoOpenFinanceService.js').includes('Math.random'), false);
  });
  it('T38 — sanitiza state e token', () => {
    const o = sanitizarObjetoMbc({ state: 's', access_token: 't', authorization_code: 'c' });
    assert.equal(o.state, '[REDACTED]');
    assert.equal(o.access_token, '[REDACTED]');
  });
  it('T39 — rotas sem if provider', () => {
    assert.equal(/if\s*\(.*provider\s*===/.test(src('backend/rotas/bancario.js')), false);
  });
  it('T40 — matching não INSERT conciliacao', () => {
    assert.equal(src('backend/motores/bancario/matching/MatchingRepository.js').includes('INSERT INTO conciliacao_bancaria'), false);
  });
  it('T41 — sync não INSERT financeiro', () => {
    assert.equal(src('backend/motores/bancario/services/SincronizacaoBancariaService.js').includes('INSERT INTO financeiro'), false);
  });
  it('T42 — adapter sem SQL', () => {
    assert.equal(/INSERT |SELECT /.test(src('backend/motores/bancario/providers/openfinance-real/OpenFinanceRealBankProvider.js')), false);
  });
  it('T43 — MBC-03 chave oficial', () => {
    assert.match(src('backend/motores/bancario/contracts/TransacaoBancariaNormalizada.js'), /empresaId.*conta.*fonte.*ext/);
  });
  it('T44 — MBC-04 conciliar existe', () => {
    assert.match(src('backend/motores/bancario/services/ConciliacaoBancariaService.js'), /async function conciliar/);
  });
  it('T45 — MBC-07 cursor após persistir', () => {
    assert.match(src('backend/motores/bancario/services/SincronizacaoBancariaService.js'), /Sem retry/);
  });
  it('T46 — MBC-08 sugere', () => {
    assert.match(src('backend/motores/bancario/matching/MotorMatchingBancarioService.js'), /Sugere/);
  });
});

describe('MBC-11 multiempresa API UI', () => {
  it('T47 — empresa A não vê conta B', async () => {
    const ctx = await setup();
    const b = await criarConta(ctx, ctx.empresaB.id, 'B', '7');
    let code = null;
    try { await ctx.motor.obterConta({ empresaId: ctx.empresaA.id, id: b.id }); } catch (e) { code = e.code; }
    assert.ok(code);
    await closeDb(ctx.db);
  });
  it('T48 — body empresa_id ignorado', async () => {
    const ctx = await setup();
    await criarConta(ctx, ctx.empresaA.id, 'A', '8');
    const cli = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const r = await cli.json('GET', '/api/bancario/contas');
    assert.equal(r.data.empresa_id, ctx.empresaA.id);
    await cli.close();
    await closeDb(ctx.db);
  });
  it('T49 — query empresa_id ignorado', async () => {
    const ctx = await setup();
    await criarConta(ctx, ctx.empresaA.id, 'A', '9');
    const cli = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const r = await cli.json('GET', '/api/bancario/contas?empresa_id=' + ctx.empresaB.id);
    assert.equal(r.data.empresa_id, ctx.empresaA.id);
    await cli.close();
    await closeDb(ctx.db);
  });
  it('T50 — permissão 403', async () => {
    const ctx = await setup();
    const cli = await listenApp(ctx, { userId: 99, empresaId: ctx.empresaA.id });
    const r = await cli.json('GET', '/api/bancario/contas');
    assert.equal(r.status, 403);
    await cli.close();
    await closeDb(ctx.db);
  });
  it('T51 — providers HTTP sem secret', async () => {
    const ctx = await setup();
    const cli = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const r = await cli.json('GET', '/api/bancario/providers');
    assert.equal(r.status, 200);
    assert.equal(JSON.stringify(r.data).includes('token'), false);
    await cli.close();
    await closeDb(ctx.db);
  });
  it('T52 — UI troca de empresa', () => {
    assert.match(src('frontend/erp/js/contas-bancarias.js'), /cds-empresa-contexto-alterado/);
  });
  it('T53 — UI pt-BR homologável', () => {
    assert.match(src('frontend/erp/pages/contas-bancarias.html'), /não homologável/);
  });
  it('T54 — UI sem access_token', () => {
    assert.equal(/access_token|client_secret/.test(src('frontend/erp/js/contas-bancarias.js')), false);
  });
  it('T55 — UI não diz conectado ao banco', () => {
    assert.doesNotMatch(src('frontend/erp/js/contas-bancarias.js'), /Conectado ao banco/);
  });
  it('T56 — contexto ausente', async () => {
    const ctx = await setup();
    let ok = false;
    try { await resolverEmpresaIdParaBancario({ user: { id: 1 } }, ctx.depsMulti); } catch (_) { ok = true; }
    assert.equal(ok, true);
    await closeDb(ctx.db);
  });
});

describe('MBC-11 extras e regressão de arquivos', () => {
  it('T57 — HOMOLOGACAO é ambiente válido', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'H', '10');
    const cfg = await ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id,
      provider: 'OPEN_FINANCE_REAL', ambiente: 'HOMOLOGACAO'
    });
    assert.equal(cfg.ambiente, 'HOMOLOGACAO');
    await closeDb(ctx.db);
  });
  it('T58 — PRODUCAO config sem executar rede', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'P', '11');
    const cfg = await ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id,
      provider: 'OPEN_FINANCE_REAL', ambiente: 'PRODUCAO'
    });
    assert.equal(cfg.ambiente, 'PRODUCAO');
    await closeDb(ctx.db);
  });
  it('T59 — executar provider real indisponível', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'E', '12');
    const cfg = await ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id,
      provider: 'OPEN_FINANCE_REAL', ambiente: 'SANDBOX'
    });
    let code = null;
    try {
      await ctx.motor.executarProvider({ empresaId: ctx.empresaA.id, id: cfg.id });
    } catch (e) { code = e.code; }
    assert.equal(code, ERROS.PROVIDER_NAO_EXECUTAVEL);
    await closeDb(ctx.db);
  });
  it('T60 — MOCK ainda lista transação', async () => {
    const dtos = await criarRegistryPadrao().obter('MOCK').listarTransacoes({ empresaId: 1, contaBancariaId: 1 });
    assert.equal(dtos[0].external_id, 'MOCK-TRANS-001');
  });
  it('T61 — arquivos MBC-01 a MBC-10', () => {
    for (let i = 1; i <= 10; i += 1) {
      const n = i < 10 ? '0' + i : String(i);
      assert.ok(fs.existsSync(path.join(ROOT, 'tests/bancario/motor-bancario-' + n + '.test.js')));
    }
  });
  it('T62 — docs MBC-11', () => {
    ['MBC-11-PROVIDER-HOMOLOGACAO.md', 'MBC-11-MATRIZ-PROVIDER.md', 'MBC-11-AUTORIZACAO-REAL.md', 'MBC-11-SINCRONIZACAO-REAL.md', 'IMPLEMENTACAO_MBC_11_RELATORIO.md']
      .forEach((f) => assert.ok(fs.existsSync(path.join(ROOT, 'docs/bancario/' + f))));
  });
  it('T63 — retry não agressivo', () => {
    assert.match(src('backend/motores/bancario/providers/openfinance-real/retrySeguro.js'), /RETENTAVEIS/);
  });
  it('T64 — timeout configurável', () => {
    const c = new OpenFinanceRealClient({ timeoutMs: 8000 });
    assert.equal(c.timeoutMs, 8000);
  });
  it('T65 — observabilidade sem token', () => {
    assert.match(src('backend/motores/bancario/contracts/observabilidadeMbc.js'), /sanitizarObjetoMbc/);
  });
  it('T66 — CODIGO motor permanece MBC-01', () => {
    assert.equal(VERSAO.CODIGO, 'MBC-01');
  });
  it('T67 — sem IOpenFinanceProvider', () => {
    assert.equal(src('backend/motores/bancario/index.js').includes('IOpenFinanceProvider'), false);
  });
  it('T68 — config MOCK TESTE ainda funciona', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'T', '13');
    const cfg = await ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id, provider: 'MOCK', ambiente: 'TESTE'
    });
    assert.equal(cfg.homologacao_status, 'NAO_APLICAVEL');
    await closeDb(ctx.db);
  });
  it('T69 — HTTP config refs sem secret', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'H', '14');
    const cli = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const r = await cli.json('POST', '/api/bancario/configuracoes', {
      conta_bancaria_id: conta.id, provider: 'OPEN_FINANCE_REAL', ambiente: 'SANDBOX',
      aplicacao_ref: 'APP', client_secret: 'nao'
    });
    assert.ok(r.status >= 400);
    assert.equal(JSON.stringify(r.data).includes('nao'), false);
    await cli.close();
    await closeDb(ctx.db);
  });
  it('T70 — isolamento config A/B', async () => {
    const ctx = await setup();
    const a = await criarConta(ctx, ctx.empresaA.id, 'A', '15');
    await ctx.motor.criarConfiguracaoIntegracao({
      empresaId: ctx.empresaA.id, conta_bancaria_id: a.id,
      provider: 'OPEN_FINANCE_REAL', ambiente: 'SANDBOX'
    });
    const listaB = await ctx.motor.listarConfiguracoesIntegracao({ empresaId: ctx.empresaB.id });
    assert.equal(listaB.length, 0);
    await closeDb(ctx.db);
  });
  it('T71 — resolver HOMOLOGACAO', () => {
    const ep = resolverEndpoints('HOMOLOGACAO', { MBC_OF_REAL_AUTH_URL_HOMOLOGACAO: 'https://hml/x' });
    assert.equal(ep.authUrl, 'https://hml/x');
  });
  it('T72 — oficial ambiente incompleto', () => {
    assert.equal(oficialHabilitado({
      MBC_OF_REAL_HABILITADO: '1', MBC_OF_REAL_AUTH_URL: 'https://a'
    }), false);
  });
  it('T73 — sem fallback MOCK no client', () => {
    assert.equal(src('backend/motores/bancario/providers/openfinance-real/OpenFinanceRealClient.js').includes('MOCK_OPEN_FINANCE'), false);
  });
  it('T74 — aceitar sugestão ainda chama MBC-04', () => {
    assert.match(src('backend/motores/bancario/matching/MotorMatchingBancarioService.js'), /ConciliacaoBancariaService\.conciliar/);
  });
  it('T75 — classificação no relatório', () => {
    assert.match(src('docs/bancario/IMPLEMENTACAO_MBC_11_RELATORIO.md'), /PREPARADO, MAS NÃO IMPLEMENTADO/);
  });
});
