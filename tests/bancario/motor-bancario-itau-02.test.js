/**
 * Sprint MBC-ITAU-02 — saldo real + extrato + sync (MOCK / integração simulada).
 * NÃO é conexão real Itaú. E2E real = BLOQUEADO por credenciais do portal.
 * node --test tests/bancario/motor-bancario-itau-02.test.js
 */
'use strict';

const { describe, it, after } = require('node:test');
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
const { MemorySecretStore } = require('../../backend/motores/bancario/secrets/MemorySecretStore');
const { STATUS_REGISTRO } = require('../../backend/motores/bancario/contracts/constantes');
const { normalizarSaldoBancario } = require('../../backend/motores/bancario/contracts/SaldoBancarioNormalizado');
const { parseDirecao, chaveIdempotencia } = require('../../backend/motores/bancario/contracts/TransacaoBancariaNormalizada');
const {
  mapearSaldo,
  mapearTransacao,
  mapearDirecaoItau
} = require('../../backend/motores/bancario/providers/itau/ItauMapper');
const { montarUrlRecurso, endpointsParaAmbiente } = require('../../backend/motores/bancario/providers/itau/ItauConstants');
const { limparCacheToken } = require('../../backend/motores/bancario/providers/itau/ItauOAuthClient');
const { criarRegistryPadrao } = require('../../backend/motores/bancario/providers/BankProviderRegistry');
const VERSAO = require('../../backend/motores/bancario/version');

const URL_TOKEN = 'https://sandbox.devportal.itau.com.br/api/oauth/jwt';
const URL_SALDO = 'https://mock.itau.test/accounts/ACC1/balances';
const URL_EXTRATO = 'https://mock.itau.test/accounts/ACC1/transactions';

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

function mockFetchFactory(opts = {}) {
  let oauthCalls = 0;
  let saldoCalls = 0;
  let extratoCalls = 0;
  const txs = opts.transacoes || [
    {
      transactionId: 'ITAU-TX-001',
      amount: 100.5,
      creditDebitType: 'CREDIT',
      transactionDateTime: '2026-09-01T10:00:00',
      description: 'Credito mock',
      reference: 'REF-1',
      balanceAfter: 1100.5
    },
    {
      id: 'ITAU-TX-002',
      valor: 40,
      direction: 'DEBIT',
      date: '2026-09-02',
      historico: 'Debito mock'
    }
  ];
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('/oauth') || u.includes('/token') || u === URL_TOKEN) {
      oauthCalls += 1;
      if (opts.oauthFail) {
        return { ok: false, status: 401, async json() { return { error: 'invalid_client' }; } };
      }
      return {
        ok: true,
        status: 200,
        async json() { return { access_token: 'tok-mock-itau', expires_in: 300 }; }
      };
    }
    if (u.includes('/balances') || u === URL_SALDO || u.includes('saldo')) {
      saldoCalls += 1;
      if (opts.tlsFail) {
        const e = new Error('unable to verify the first certificate');
        e.code = 'UNABLE_TO_VERIFY_LEAF_SIGNATURE';
        throw e;
      }
      if (opts.timeout) {
        const e = new Error('Timeout na chamada Itaú');
        e.name = 'AbortError';
        throw e;
      }
      if (opts.saldoInvalido) {
        return { ok: true, status: 200, async json() { return null; } };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            available_balance: 1500.55,
            current_balance: 1600.1,
            currency: 'BRL',
            as_of: '2026-09-07T12:00:00.000Z'
          };
        }
      };
    }
    if (u.includes('/transactions') || u === URL_EXTRATO || u.includes('extrato')) {
      extratoCalls += 1;
      return {
        ok: true,
        status: 200,
        async json() { return { data: txs, has_more: false }; }
      };
    }
    return { ok: false, status: 404, async json() { return { error: 'not_found' }; } };
  };
  fetchImpl._stats = () => ({ oauthCalls, saldoCalls, extratoCalls });
  return fetchImpl;
}

async function setup() {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaUsuarioEmpresasAsync(db);
  await garantirSchemaBancarioAsync(db);
  const emp = await EmpresaService.criarEmpresa({
    cnpj: '38204469000387',
    razao_social: 'Filial 2'
  }, { db });
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
  const cfg = await motor.criarConfiguracaoIntegracao({
    empresaId: emp.id,
    conta_bancaria_id: conta.id,
    provider: 'ITAU',
    ambiente: 'SANDBOX'
  });
  await motor.configurarCredenciaisItau({
    empresaId: emp.id,
    id: cfg.id,
    client_id: 'cid-itau',
    client_secret: 'csec-itau',
    ambiente: 'SANDBOX'
  });
  return { db, emp, motor, secretStore, conta, cfg };
}

describe('MBC-ITAU-02 saldo + extrato (MOCK)', () => {
  after(() => limparCacheToken());

  it('T01 — DTO saldo normalizado + CREDIT/DEBIT', () => {
    const saldo = normalizarSaldoBancario({
      empresa_id: 1,
      conta_bancaria_id: 2,
      provider: 'ITAU',
      available_balance: 10.1,
      current_balance: 12.2,
      currency: 'brl',
      as_of: '2026-09-07T00:00:00Z'
    });
    assert.equal(saldo.available_balance, 10.1);
    assert.equal(saldo.current_balance, 12.2);
    assert.equal(saldo.currency, 'BRL');
    assert.equal(saldo.natureza, 'informado_banco');
    assert.equal(saldo.valor, 10.1);
    assert.equal(parseDirecao('CREDIT'), 'entrada');
    assert.equal(parseDirecao('DEBIT'), 'saida');
    assert.equal(mapearDirecaoItau({ creditDebitType: 'CREDIT' }), 'CREDIT');
    assert.equal(mapearDirecaoItau({ direction: 'DEBIT' }), 'DEBIT');
  });

  it('T02 — mapper movimentação + external_id + datas + valores', () => {
    const dto = mapearTransacao({
      transactionId: 'X1',
      amount: -55.4,
      creditDebitType: 'DEBIT',
      transactionDateTime: '2026-09-03T08:00:00',
      postingDate: '2026-09-03',
      description: 'Pagamento',
      reference: 'E2E'
    }, { empresaId: 1, contaBancariaId: 2 });
    assert.equal(dto.external_id, 'X1');
    assert.equal(dto.external_source, 'ITAU');
    assert.equal(dto.direcao, 'saida');
    assert.equal(dto.valor, 55.4);
    assert.equal(dto.data_transacao, '2026-09-03T08:00:00');
    assert.equal(dto.referencia_externa, 'E2E');
    const chave = chaveIdempotencia(dto);
    assert.equal(chave, '1|2|ITAU|X1');
  });

  it('T03 — endpoint saldo/extrato exige configuração (não inventa path)', () => {
    const ep = endpointsParaAmbiente('SANDBOX', {});
    assert.throws(
      () => montarUrlRecurso(ep, 'saldo', {}),
      (e) => e.errorCode === 'ENDPOINT_NAO_CONFIGURADO'
    );
    const url = montarUrlRecurso(ep, 'saldo', { url: URL_SALDO, account_id: 'ACC1' });
    assert.equal(url, URL_SALDO);
  });

  it('T04 — provider ITAU com sincronização; MP preservado', () => {
    const reg = criarRegistryPadrao();
    assert.equal(reg.obter('ITAU').suportaSincronizacao, true);
    assert.equal(reg.obter('OPEN_FINANCE_REAL').codigo, 'OPEN_FINANCE_REAL');
    assert.ok(String(VERSAO.SPRINT).startsWith('MBC-'));
    assert.doesNotMatch(src('backend/motores/bancario/providers/itau/ItauApiClient.js'), /rejectUnauthorized:\s*false/);
  });

  it('T05 T06 — consultar saldo real + extrato live (MOCK)', async () => {
    limparCacheToken();
    const ctx = await setup();
    try {
      const fetchImpl = mockFetchFactory();
      const saldo = await ctx.motor.consultarSaldoRealItau({
        empresaId: ctx.emp.id,
        id: ctx.conta.id,
        saldo_url: URL_SALDO,
        fetchImpl
      });
      assert.equal(saldo.ok, true);
      assert.equal(saldo.disponivel, true);
      assert.equal(saldo.rotulo, 'Saldo real do banco');
      assert.equal(saldo.available_balance, 1500.55);
      assert.equal(saldo.current_balance, 1600.1);
      assert.equal(JSON.stringify(saldo).includes('tok-mock-itau'), false);
      assert.equal(JSON.stringify(saldo).includes('csec-itau'), false);

      const extrato = await ctx.motor.consultarExtratoProviderItau({
        empresaId: ctx.emp.id,
        id: ctx.conta.id,
        extrato_url: URL_EXTRATO,
        data_inicio: '2026-09-01',
        data_fim: '2026-09-30',
        fetchImpl
      });
      assert.equal(extrato.persistido, false);
      assert.equal(extrato.transacoes.length, 2);
      assert.equal(extrato.transacoes[0].direcao, 'entrada');
      assert.equal(extrato.transacoes[1].direcao, 'saida');
      assert.equal(extrato.transacoes[0].external_id, 'ITAU-TX-001');
    } finally {
      await closeDb(ctx.db);
    }
  });

  it('T07 T08 — sync + idempotência CRIADA / JÁ EXISTENTE', async () => {
    limparCacheToken();
    const ctx = await setup();
    try {
      const fetchImpl = mockFetchFactory();
      const a = await ctx.motor.sincronizarConta({
        empresaId: ctx.emp.id,
        id: ctx.conta.id,
        saldo_url: URL_SALDO,
        extrato_url: URL_EXTRATO,
        fetchImpl
      });
      assert.equal(a.status, 'SUCESSO');
      assert.equal(a.origem, 'ITAU');
      assert.equal(a.saldo_bancario, 1500.55);
      assert.equal(a.rotulo_saldo_bancario, 'Saldo real do banco');
      assert.equal(a.rotulo_saldo_conceitual, 'Saldo conceitual MBC');
      assert.equal(a.novas_transacoes, 2);
      assert.equal(a.duplicadas, 0);

      limparCacheToken();
      const b = await ctx.motor.sincronizarConta({
        empresaId: ctx.emp.id,
        id: ctx.conta.id,
        saldo_url: URL_SALDO,
        extrato_url: URL_EXTRATO,
        fetchImpl,
        reprocessarCatalogo: true
      });
      assert.equal(b.novas_transacoes, 0);
      assert.equal(b.duplicadas, 2);

      const saldo = await ctx.motor.obterSaldoBancario({
        empresaId: ctx.emp.id,
        id: ctx.conta.id
      });
      assert.equal(saldo.saldo_bancario, 1500.55);
      assert.equal(saldo.natureza_bancario, 'informado_banco');
      assert.equal(saldo.natureza_conceitual, 'conceitual');
      assert.notEqual(saldo.saldo_bancario, saldo.saldo_conceitual);

      const lista = await ctx.motor.listarTransacoes({
        empresaId: ctx.emp.id,
        conta_bancaria_id: ctx.conta.id
      });
      assert.equal(lista.length, 2);
      assert.equal(lista[0].external_source, 'ITAU');
    } finally {
      await closeDb(ctx.db);
    }
  });

  it('T09 — ausência de credencial / auth / TLS / timeout', async () => {
    limparCacheToken();
    const ctx = await setup();
    try {
      await ctx.motor.removerCredenciaisItau({ empresaId: ctx.emp.id, id: ctx.cfg.id });
      await assert.rejects(
        () => ctx.motor.consultarSaldoRealItau({
          empresaId: ctx.emp.id,
          id: ctx.conta.id,
          saldo_url: URL_SALDO,
          fetchImpl: mockFetchFactory()
        }),
        (e) => e.errorCode === 'CREDENCIAIS_AUSENTES' || /credenciais/i.test(e.message)
      );

      await ctx.motor.configurarCredenciaisItau({
        empresaId: ctx.emp.id,
        id: ctx.cfg.id,
        client_id: 'cid',
        client_secret: 'csec'
      });

      await assert.rejects(
        () => ctx.motor.consultarSaldoRealItau({
          empresaId: ctx.emp.id,
          id: ctx.conta.id,
          saldo_url: URL_SALDO,
          fetchImpl: mockFetchFactory({ oauthFail: true }),
          forcarRefresh: true
        }),
        (e) => !!e
      );

      await assert.rejects(
        () => ctx.motor.consultarSaldoRealItau({
          empresaId: ctx.emp.id,
          id: ctx.conta.id,
          saldo_url: URL_SALDO,
          fetchImpl: mockFetchFactory({ tlsFail: true }),
          forcarRefresh: true
        }),
        (e) => e.errorCode === 'TLS_MTLS_FALHA' || /TLS|mTLS|certificado/i.test(e.message)
      );

      await assert.rejects(
        () => ctx.motor.consultarSaldoRealItau({
          empresaId: ctx.emp.id,
          id: ctx.conta.id,
          saldo_url: URL_SALDO,
          fetchImpl: mockFetchFactory({ timeout: true }),
          forcarRefresh: true
        }),
        (e) => e.errorCode === 'TIMEOUT' || /timeout/i.test(e.message)
      );
    } finally {
      await closeDb(ctx.db);
    }
  });

  it('T10 — Mercado Pago sem regressão de contrato', async () => {
    const ctx = await setup();
    try {
      const contaMp = await ctx.motor.criarConta({
        empresaId: ctx.emp.id,
        instituicao_financeira_id: (await ctx.motor.criarInstituicao({ nome: 'MP' })).id,
        nome: 'MP',
        tipo: 'PAGAMENTO',
        numero: '9'
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
        client_id: 'mp-app',
        client_secret: 'mp-sec'
      });
      assert.equal(st.provider, 'OPEN_FINANCE_REAL');
      assert.equal(st.secret_configurado, true);
      assert.match(src('frontend/erp/js/contas-bancarias.js'), /Saldo real do banco|Credenciais Itaú não configuradas/);
      assert.match(src('backend/rotas/bancario.js'), /saldo-real/);
    } finally {
      await closeDb(ctx.db);
    }
  });

  it('T11 — mapearSaldo e registrar idempotente via serviço', async () => {
    limparCacheToken();
    const ctx = await setup();
    try {
      const s = mapearSaldo({
        availableAmount: 99,
        date: '2026-09-07'
      }, { empresaId: ctx.emp.id, contaBancariaId: ctx.conta.id });
      assert.equal(s.valor, 99);
      assert.equal(s.provider, 'ITAU');

      const dto = mapearTransacao({
        transactionId: 'IDEMP-1',
        amount: 10,
        creditDebitType: 'CREDIT',
        date: '2026-09-07',
        description: 'x'
      }, { empresaId: ctx.emp.id, contaBancariaId: ctx.conta.id });
      const r1 = await ctx.motor.registrarTransacaoBancaria({
        empresaId: ctx.emp.id,
        ...dto
      });
      const r2 = await ctx.motor.registrarTransacaoBancaria({
        empresaId: ctx.emp.id,
        ...dto
      });
      assert.equal(r1.status, STATUS_REGISTRO.CRIADA);
      assert.equal(r2.status, STATUS_REGISTRO.JA_EXISTENTE);
    } finally {
      await closeDb(ctx.db);
    }
  });
});
