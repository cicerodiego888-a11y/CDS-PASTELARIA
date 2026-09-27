/**
 * Sprint MBC-ITAU-01 — multi-provider + provider Itaú (auth preparada).
 * node --test tests/bancario/motor-bancario-itau-01.test.js
 */
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const { garantirSchemaBancarioAsync } = require('../../backend/motores/bancario/schema/bancarioSchema');
const { obterMotorBancario } = require('../../backend/motores/bancario/MotorBancarioService');
const { criarRegistryPadrao } = require('../../backend/motores/bancario/providers/BankProviderRegistry');
const { MemorySecretStore } = require('../../backend/motores/bancario/secrets/MemorySecretStore');
const { CODIGO_PROVIDER, ERROS } = require('../../backend/motores/bancario/contracts/constantes');
const { sanitizarObjetoMbc } = require('../../backend/motores/bancario/contracts/sanitizarMbc');
const { limparCacheToken } = require('../../backend/motores/bancario/providers/itau/ItauOAuthClient');
const { gerarParCertificadoTeste } = require('./helpers/itauCertTeste');
const VERSAO = require('../../backend/motores/bancario/version');

const CNPJ = '38204469000387';

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}
function closeDb(db) {
  return new Promise((resolve) => { try { db.close(() => resolve()); } catch (_) { resolve(); } });
}

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

async function setup() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaUsuarioEmpresasAsync(db);
  await garantirSchemaBancarioAsync(db);
  const emp = await EmpresaService.criarEmpresa({
    razao_social: 'PASTELARIA DO CHEFF — FILIAL 2',
    nome_fantasia: 'Filial 2',
    cnpj: CNPJ,
    ativa: 1
  }, { db });
  const secretStore = new MemorySecretStore();
  const motor = obterMotorBancario({ db, secretStore, env: process.env });
  const inst = await motor.criarInstituicao({ nome: 'Itaú', codigo: '341' });
  const conta = await motor.criarConta({
    empresaId: emp.id,
    instituicao_financeira_id: inst.id,
    nome: 'Conta Itaú Filial 2',
    tipo: 'CORRENTE',
    agencia: '7751',
    numero: '27628',
    digito: '8',
    ativa: true
  });
  return { db, emp, motor, secretStore, inst, conta };
}

describe('MBC-ITAU-01 multi-provider + Itaú', () => {
  after(() => { limparCacheToken(); });

  it('T01 T02 — Mercado Pago e Itaú registrados no registry', () => {
    const reg = criarRegistryPadrao();
    assert.equal(reg.existe(CODIGO_PROVIDER.OPEN_FINANCE_REAL), true);
    assert.equal(reg.existe(CODIGO_PROVIDER.ITAU), true);
    assert.equal(reg.obter('ITAU').codigo, 'ITAU');
    assert.equal(reg.obter('OPEN_FINANCE_REAL').codigo, 'OPEN_FINANCE_REAL');
    assert.throws(() => reg.obter('ITAU_REAL'), (e) => e.code === ERROS.PROVIDER_DESCONHECIDO);
  });

  it('T03 T04 — factory resolve providers', () => {
    const reg = criarRegistryPadrao();
    assert.equal(reg.obter('itau').nome, 'Itaú');
    assert.equal(reg.obter('open_finance_real').codigo, 'OPEN_FINANCE_REAL');
  });

  it('T05 T06 T07 — conta Itaú existente recebe config vinculada', async () => {
    const ctx = await setup();
    try {
      const cfg = await ctx.motor.criarConfiguracaoIntegracao({
        empresaId: ctx.emp.id,
        conta_bancaria_id: ctx.conta.id,
        provider: 'ITAU',
        ambiente: 'SANDBOX'
      });
      assert.equal(cfg.provider, 'ITAU');
      assert.equal(cfg.empresa_id, ctx.emp.id);
      assert.equal(cfg.conta_bancaria_id, ctx.conta.id);
      assert.equal(cfg.homologacao_status, 'OPERACIONAL_PREPARADO');
      const contas = await ctx.motor.listarContas({ empresaId: ctx.emp.id });
      assert.equal(contas.filter((c) => c.agencia === '7751').length, 1);
    } finally {
      await closeDb(ctx.db);
    }
  });

  it('T08 T11 T12 — credenciais Itaú no SecretStore; sem secret no status público', async () => {
    const ctx = await setup();
    try {
      const cfg = await ctx.motor.criarConfiguracaoIntegracao({
        empresaId: ctx.emp.id,
        conta_bancaria_id: ctx.conta.id,
        provider: 'ITAU',
        ambiente: 'SANDBOX'
      });
      const par = gerarParCertificadoTeste();
      const st = await ctx.motor.configurarCredenciaisItau({
        empresaId: ctx.emp.id,
        id: cfg.id,
        client_id: 'itau-client-id',
        client_secret: 'itau-super-secret',
        certificate: par.certificate,
        private_key: par.private_key,
        ambiente: 'SANDBOX'
      });
      assert.equal(st.client_id_configurado, true);
      assert.equal(st.secret_configurado, true);
      assert.equal(st.certificado_configurado, true);
      assert.equal(st.private_key_configurado, true);
      assert.equal(st.client_id, 'itau-client-id');
      assert.equal(st.client_secret, undefined);
      assert.equal(st.private_key, undefined);
      assert.equal(st.certificate, undefined);
      assert.equal(st.status_integracao, 'CREDENCIAIS_CONFIGURADAS');

      const pub = JSON.stringify(st);
      assert.equal(pub.includes('itau-super-secret'), false);
      assert.equal(pub.includes('PRIVATE KEY'), false);
    } finally {
      await closeDb(ctx.db);
    }
  });

  it('T09 T10 — sanitizer redige private key / certificate / secret', () => {
    const limpo = sanitizarObjetoMbc({
      private_key: '-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----',
      certificate: 'CERT-BLOB',
      client_secret: 'sec-123',
      message: 'Credenciais Itaú configuradas'
    });
    assert.equal(limpo.private_key, '[REDACTED]');
    assert.equal(limpo.certificate, '[REDACTED]');
    assert.equal(limpo.client_secret, '[REDACTED]');
    assert.match(limpo.message, /Credenciais/);
  });

  it('T13 T14 — autenticação Itaú mockada + erro normalizado', async () => {
    limparCacheToken();
    const ctx = await setup();
    try {
      const cfg = await ctx.motor.criarConfiguracaoIntegracao({
        empresaId: ctx.emp.id,
        conta_bancaria_id: ctx.conta.id,
        provider: 'ITAU',
        ambiente: 'SANDBOX'
      });
      await ctx.motor.configurarCredenciaisItau({
        empresaId: ctx.emp.id,
        id: cfg.id,
        client_id: 'cid',
        client_secret: 'csec',
        ambiente: 'SANDBOX'
      });

      const fetchOk = async () => ({
        ok: true,
        status: 200,
        async json() {
          return { access_token: 'tok-itau-mock', expires_in: 300, token_type: 'Bearer' };
        }
      });
      const ok = await ctx.motor.testarConexaoItau({
        empresaId: ctx.emp.id,
        id: cfg.id,
        fetchImpl: fetchOk,
        forcarRefresh: true
      });
      assert.equal(ok.success, true);
      assert.equal(ok.provider, 'ITAU');
      assert.equal(ok.authenticated, true);
      assert.equal(ok.environment, 'SANDBOX');
      assert.equal(JSON.stringify(ok).includes('tok-itau-mock'), false);

      const fetchFail = async () => ({
        ok: false,
        status: 401,
        async json() { return { error: 'invalid_client' }; }
      });
      limparCacheToken();
      const falha = await ctx.motor.testarConexaoItau({
        empresaId: ctx.emp.id,
        id: cfg.id,
        fetchImpl: fetchFail,
        forcarRefresh: true
      });
      assert.equal(falha.success, false);
      assert.equal(falha.authenticated, false);
      assert.ok(falha.errorCode);
      assert.ok(falha.message);
    } finally {
      await closeDb(ctx.db);
    }
  });

  it('T08b — Itaú não interfere em credenciais Mercado Pago', async () => {
    const ctx = await setup();
    try {
      const contaMp = await ctx.motor.criarConta({
        empresaId: ctx.emp.id,
        instituicao_financeira_id: ctx.inst.id,
        nome: 'Conta MP',
        tipo: 'PAGAMENTO',
        agencia: '0001',
        numero: '9999',
        digito: '0',
        ativa: true
      });
      const cfgMp = await ctx.motor.criarConfiguracaoIntegracao({
        empresaId: ctx.emp.id,
        conta_bancaria_id: contaMp.id,
        provider: 'OPEN_FINANCE_REAL',
        ambiente: 'SANDBOX'
      });
      const stMp = await ctx.motor.configurarCredenciaisMercadoPago({
        empresaId: ctx.emp.id,
        id: cfgMp.id,
        client_id: 'mp-app',
        client_secret: 'mp-secret',
        ambiente: 'SANDBOX'
      });
      assert.equal(stMp.provider, 'OPEN_FINANCE_REAL');
      assert.equal(stMp.secret_configurado, true);

      await assert.rejects(
        () => ctx.motor.configurarCredenciaisItau({
          empresaId: ctx.emp.id,
          id: cfgMp.id,
          client_id: 'x',
          client_secret: 'y'
        }),
        (e) => e.code === ERROS.PROVIDER_CREDENCIAL_INCOMPATIVEL
      );
    } finally {
      await closeDb(ctx.db);
    }
  });

  it('T12b — sandbox vs produção (mTLS exigido em produção)', async () => {
    limparCacheToken();
    const ctx = await setup();
    try {
      const cfg = await ctx.motor.criarConfiguracaoIntegracao({
        empresaId: ctx.emp.id,
        conta_bancaria_id: ctx.conta.id,
        provider: 'ITAU',
        ambiente: 'PRODUCAO'
      });
      await ctx.motor.configurarCredenciaisItau({
        empresaId: ctx.emp.id,
        id: cfg.id,
        client_id: 'cid',
        client_secret: 'csec',
        ambiente: 'PRODUCAO'
      });
      const out = await ctx.motor.testarConexaoItau({
        empresaId: ctx.emp.id,
        id: cfg.id,
        fetchImpl: async () => ({ ok: true, status: 200, async json() { return { access_token: 'x', expires_in: 300 }; } }),
        forcarRefresh: true
      });
      assert.equal(out.success, false);
      assert.equal(out.environment, 'PRODUCAO');
      assert.equal(out.mtls_requerido, true);
      assert.match(String(out.message), /certificado|private key|mTLS/i);
    } finally {
      await closeDb(ctx.db);
    }
  });

  it('contrato / sprint', () => {
    assert.ok(String(VERSAO.SPRINT).startsWith('MBC-'));
    assert.match(src('backend/motores/bancario/providers/BankProviderRegistry.js'), /ItauBankProvider/);
    assert.match(src('frontend/erp/pages/contas-bancarias.html'), /mbcCredPanelItau/);
    assert.doesNotMatch(src('backend/motores/bancario/providers/itau/ItauBankProvider.js'), /MercadoPago/);
  });
});
