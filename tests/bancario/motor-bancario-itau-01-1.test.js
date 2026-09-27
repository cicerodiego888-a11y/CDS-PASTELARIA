/**
 * Sprint MBC-ITAU-01.1 — credenciais reais + certificado + mTLS + OAuth.
 * Sem credenciais reais do cliente. Sem saldo/extrato.
 * node --test tests/bancario/motor-bancario-itau-01-1.test.js
 */
'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const https = require('https');
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
const {
  limparCacheToken,
  criarAgentMtls,
  tokenValido,
  cacheKey
} = require('../../backend/motores/bancario/providers/itau/ItauOAuthClient');
const { validarMaterialTls } = require('../../backend/motores/bancario/providers/itau/ItauCertificadoUtil');
const {
  gerarParCertificadoTeste,
  gerarParNaoCorrespondente
} = require('./helpers/itauCertTeste');
const VERSAO = require('../../backend/motores/bancario/version');

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}
function closeDb(db) {
  return new Promise((resolve) => { try { db.close(() => resolve()); } catch (_) { resolve(); } });
}
function src(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

async function setup() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaUsuarioEmpresasAsync(db);
  await garantirSchemaBancarioAsync(db);
  const emp = await EmpresaService.criarEmpresa({ cnpj: '38204469000387', razao_social: 'Filial 2' }, { db });
  const secretStore = new MemorySecretStore();
  const motor = obterMotorBancario({ db, secretStore, env: process.env });
  const inst = await motor.criarInstituicao({ nome: 'Itaú', codigo: '341' });
  const conta = await motor.criarConta({
    empresaId: emp.id,
    instituicao_financeira_id: inst.id,
    nome: 'Conta Itaú',
    tipo: 'CORRENTE',
    agencia: '7751',
    numero: '27628',
    digito: '8'
  });
  return { db, emp, motor, secretStore, conta };
}

describe('MBC-ITAU-01.1 credenciais + certificado + mTLS', () => {
  after(() => limparCacheToken());

  it('T01 — provider ITAU registrado; MP preservado', () => {
    const reg = criarRegistryPadrao();
    assert.equal(reg.existe('ITAU'), true);
    assert.equal(reg.existe('OPEN_FINANCE_REAL'), true);
  });

  it('T02 T03 — credenciais / certificado / key ausentes', async () => {
    const ctx = await setup();
    try {
      const cfg = await ctx.motor.criarConfiguracaoIntegracao({
        empresaId: ctx.emp.id,
        conta_bancaria_id: ctx.conta.id,
        provider: 'ITAU',
        ambiente: 'SANDBOX'
      });
      const ausente = await ctx.motor.testarConexaoItau({ empresaId: ctx.emp.id, id: cfg.id });
      assert.equal(ausente.success, false);
      assert.equal(ausente.errorCode, 'CREDENCIAIS_AUSENTES');

      await ctx.motor.configurarCredenciaisItau({
        empresaId: ctx.emp.id,
        id: cfg.id,
        client_id: 'cid',
        client_secret: 'csec',
        ambiente: 'PRODUCAO'
      });
      const semCert = await ctx.motor.testarConexaoItau({
        empresaId: ctx.emp.id,
        id: cfg.id,
        forcarRefresh: true
      });
      assert.equal(semCert.success, false);
      assert.equal(semCert.errorCode, 'CERTIFICADO_AUSENTE');
      assert.equal(semCert.mtls, true);
      assert.equal(semCert.authentication, 'OAUTH2_CLIENT_CREDENTIALS');

      const par = gerarParCertificadoTeste();
      await ctx.motor.configurarCredenciaisItau({
        empresaId: ctx.emp.id,
        id: cfg.id,
        client_id: 'cid',
        certificate: par.certificate,
        private_key: par.private_key,
        ambiente: 'PRODUCAO'
      });
      await ctx.secretStore.delete('mbc.itau.key.' + cfg.id);
      const semKey = await ctx.motor.testarConexaoItau({
        empresaId: ctx.emp.id,
        id: cfg.id,
        forcarRefresh: true
      });
      assert.equal(semKey.success, false);
      assert.equal(semKey.errorCode, 'PRIVATE_KEY_AUSENTE');
    } finally {
      await closeDb(ctx.db);
    }
  });

  it('T04 T05 — certificado/chave inválidos e par não correspondente', () => {
    const inv = validarMaterialTls({
      certificate: '-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----',
      private_key: '-----BEGIN PRIVATE KEY-----\nXYZ\n-----END PRIVATE KEY-----',
      exigir: true
    });
    assert.equal(inv.ok, false);
    assert.equal(inv.errorCode, 'CERTIFICADO_CHAVE_INVALIDOS');

    const mismatch = gerarParNaoCorrespondente();
    const m = validarMaterialTls({
      certificate: mismatch.certificate,
      private_key: mismatch.private_key,
      exigir: true
    });
    assert.equal(m.ok, false);
    assert.equal(m.errorCode, 'CERTIFICADO_CHAVE_INVALIDOS');
  });

  it('T06 — mTLS agent sempre com rejectUnauthorized true', () => {
    const par = gerarParCertificadoTeste();
    const agent = criarAgentMtls({
      certificate: par.certificate,
      private_key: par.private_key
    });
    assert.ok(agent instanceof https.Agent);
    assert.equal(agent.options.rejectUnauthorized, true);
    assert.equal(criarAgentMtls({ rejectUnauthorized: false, certificate: par.certificate, private_key: par.private_key }).options.rejectUnauthorized, true);
  });

  it('T07 T08 T09 — OAuth mock, cache e renovação', async () => {
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
      let calls = 0;
      const fetchOk = async () => {
        calls += 1;
        return {
          ok: true,
          status: 200,
          async json() { return { access_token: 'tok-cache-test', expires_in: 300 }; }
        };
      };
      const a = await ctx.motor.testarConexaoItau({
        empresaId: ctx.emp.id, id: cfg.id, fetchImpl: fetchOk, forcarRefresh: true
      });
      assert.equal(a.success, true);
      assert.equal(a.authenticated, true);
      assert.equal(a.token_from_cache, false);
      assert.equal(JSON.stringify(a).includes('tok-cache-test'), false);

      const b = await ctx.motor.testarConexaoItau({
        empresaId: ctx.emp.id, id: cfg.id, fetchImpl: fetchOk, forcarRefresh: false
      });
      assert.equal(b.success, true);
      assert.equal(b.token_from_cache, true);
      assert.equal(calls, 1);

      const c = await ctx.motor.testarConexaoItau({
        empresaId: ctx.emp.id, id: cfg.id, fetchImpl: fetchOk, forcarRefresh: true
      });
      assert.equal(c.token_from_cache, false);
      assert.equal(calls, 2);
      assert.equal(tokenValido({ access_token: 'x', expires_at_ms: Date.now() + 120000 }), true);
      assert.equal(tokenValido({ access_token: 'x', expires_at_ms: Date.now() + 1000 }), false);
      assert.ok(cacheKey('SANDBOX', 'cid').includes('SANDBOX'));
    } finally {
      await closeDb(ctx.db);
    }
  });

  it('T10 T11 — erro OAuth e TLS classificados; sem secrets na resposta', async () => {
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
        client_secret: 'SEGREDO-NUNCA-VAZAR',
        ambiente: 'SANDBOX'
      });
      const oauthFail = await ctx.motor.testarConexaoItau({
        empresaId: ctx.emp.id,
        id: cfg.id,
        forcarRefresh: true,
        fetchImpl: async () => ({
          ok: false,
          status: 401,
          async json() { return { error: 'invalid_client' }; }
        })
      });
      assert.equal(oauthFail.success, false);
      assert.ok(oauthFail.errorCode);
      assert.equal(JSON.stringify(oauthFail).includes('SEGREDO-NUNCA-VAZAR'), false);

      const tlsFail = await ctx.motor.testarConexaoItau({
        empresaId: ctx.emp.id,
        id: cfg.id,
        forcarRefresh: true,
        fetchImpl: async () => {
          const e = new Error('unable to verify the first certificate');
          e.code = 'UNABLE_TO_VERIFY_LEAF_SIGNATURE';
          throw e;
        }
      });
      assert.equal(tlsFail.success, false);
      assert.equal(tlsFail.errorCode, 'TLS_MTLS_FALHA');
    } finally {
      await closeDb(ctx.db);
    }
  });

  it('T12 — produção com cert válido + OAuth mock → autenticado', async () => {
    limparCacheToken();
    const ctx = await setup();
    try {
      const par = gerarParCertificadoTeste();
      const cfg = await ctx.motor.criarConfiguracaoIntegracao({
        empresaId: ctx.emp.id,
        conta_bancaria_id: ctx.conta.id,
        provider: 'ITAU',
        ambiente: 'PRODUCAO'
      });
      const st = await ctx.motor.configurarCredenciaisItau({
        empresaId: ctx.emp.id,
        id: cfg.id,
        client_id: 'cid-prod',
        client_secret: 'csec-prod',
        certificate: par.certificate,
        private_key: par.private_key,
        ambiente: 'PRODUCAO'
      });
      assert.equal(st.certificado_configurado, true);
      assert.equal(st.private_key_configurado, true);
      assert.ok(st.certificado_valido_ate);
      assert.equal(st.certificado_expirado, false);
      assert.equal(st.status_integracao, 'CREDENCIAIS_CONFIGURADAS');

      const out = await ctx.motor.testarConexaoItau({
        empresaId: ctx.emp.id,
        id: cfg.id,
        forcarRefresh: true,
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          async json() { return { access_token: 'tok-prod', expires_in: 300 }; }
        })
      });
      assert.equal(out.success, true);
      assert.equal(out.authenticated, true);
      assert.equal(out.environment, 'PRODUCAO');
      assert.equal(out.authentication, 'OAUTH2_CLIENT_CREDENTIALS');
      assert.equal(out.mtls, true);
    } finally {
      await closeDb(ctx.db);
    }
  });

  it('T13 — sanitizer e ausência de secrets em status', async () => {
    const limpo = sanitizarObjetoMbc({
      Authorization: 'Bearer abc',
      private_key: '-----BEGIN PRIVATE KEY-----\nX\n-----END PRIVATE KEY-----',
      certificate: 'CERT',
      client_secret: 'sec'
    });
    assert.equal(limpo.Authorization, '[REDACTED]');
    assert.equal(limpo.private_key, '[REDACTED]');
    assert.equal(limpo.certificate, '[REDACTED]');
    assert.equal(limpo.client_secret, '[REDACTED]');

    const ctx = await setup();
    try {
      const par = gerarParCertificadoTeste();
      const cfg = await ctx.motor.criarConfiguracaoIntegracao({
        empresaId: ctx.emp.id,
        conta_bancaria_id: ctx.conta.id,
        provider: 'ITAU',
        ambiente: 'SANDBOX'
      });
      const st = await ctx.motor.configurarCredenciaisItau({
        empresaId: ctx.emp.id,
        id: cfg.id,
        client_id: 'cid',
        client_secret: 'secret-xyz',
        certificate: par.certificate,
        private_key: par.private_key
      });
      const json = JSON.stringify(st);
      assert.equal(json.includes('secret-xyz'), false);
      assert.equal(json.includes('BEGIN PRIVATE KEY'), false);
      assert.equal(json.includes('BEGIN CERTIFICATE'), false);
    } finally {
      await closeDb(ctx.db);
    }
  });

  it('T14 — Mercado Pago preservado + sprint', async () => {
    const ctx = await setup();
    try {
      const contaMp = await ctx.motor.criarConta({
        empresaId: ctx.emp.id,
        instituicao_financeira_id: (await ctx.motor.criarInstituicao({ nome: 'MP' })).id,
        nome: 'MP',
        tipo: 'PAGAMENTO',
        numero: '1'
      });
      const cfg = await ctx.motor.criarConfiguracaoIntegracao({
        empresaId: ctx.emp.id,
        conta_bancaria_id: contaMp.id,
        provider: 'OPEN_FINANCE_REAL',
        ambiente: 'SANDBOX'
      });
      const st = await ctx.motor.configurarCredenciaisMercadoPago({
        empresaId: ctx.emp.id,
        id: cfg.id,
        client_id: 'mp',
        client_secret: 'mps'
      });
      assert.equal(st.provider, 'OPEN_FINANCE_REAL');
      assert.ok(String(VERSAO.SPRINT).startsWith('MBC-'));
      assert.match(src('backend/motores/bancario/providers/itau/ItauOAuthClient.js'), /rejectUnauthorized:\s*true/);
      assert.doesNotMatch(src('backend/motores/bancario/providers/itau/ItauOAuthClient.js'), /rejectUnauthorized:\s*false/);
    } finally {
      await closeDb(ctx.db);
    }
  });

  it('T15 — certificado expirado rejeitado', () => {
    const par = gerarParCertificadoTeste({ expired: true });
    const v = validarMaterialTls({
      certificate: par.certificate,
      private_key: par.private_key,
      exigir: true
    });
    assert.equal(v.ok, false);
    assert.equal(v.errorCode, 'CERTIFICADO_EXPIRADO');
  });
});
