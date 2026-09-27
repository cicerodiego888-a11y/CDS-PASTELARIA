/**
 * Sprint MBC-04 — hardening sync (lock TTL/reclaim + sync parcial) + contrato público.
 * node --test tests/bancario/motor-bancario-04-hardening.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const { garantirSchemaBancarioAsync } = require('../../backend/motores/bancario/schema/bancarioSchema');
const { obterMotorBancario, CONTRATO } = require('../../backend/motores/bancario/MotorBancarioService');
const { MemorySecretStore } = require('../../backend/motores/bancario/secrets/MemorySecretStore');
const { BankProviderRegistry } = require('../../backend/motores/bancario/providers/BankProviderRegistry');
const { MockOpenFinanceProvider } = require('../../backend/motores/bancario/providers/MockOpenFinanceProvider');
const { MockBankProvider } = require('../../backend/motores/bancario/providers/MockBankProvider');
const { ERROS, STATUS_SINCRONIZACAO } = require('../../backend/motores/bancario/contracts/constantes');
const {
  resolverSyncLockTtlMs,
  resolverSyncMaxPaginas,
  lockExpirado
} = require('../../backend/motores/bancario/services/syncConfig');
const { montarUrlRecurso, endpointsParaAmbiente } = require('../../backend/motores/bancario/providers/itau/ItauConstants');
const VERSAO = require('../../backend/motores/bancario/version');
const { dbRun } = require('../../backend/motores/bancario/services/dbPromessas');

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}
function closeDb(db) {
  return new Promise((resolve) => { try { db.close(() => resolve()); } catch (_) { resolve(); } });
}

/** Provider com N páginas infinitas até cursor >= totalPages */
class ProviderPaginado extends MockOpenFinanceProvider {
  constructor(totalPages = 5) {
    super();
    this.totalPages = totalPages;
  }

  async listarTransacoes(params = {}) {
    const empresaId = params.empresaId != null ? params.empresaId : params.empresa_id;
    const contaId = params.contaBancariaId != null ? params.contaBancariaId : params.conta_bancaria_id;
    const page = params.cursor == null || params.cursor === '' ? 0 : Number(params.cursor);
    const n = page + 1;
    const item = {
      empresa_id: empresaId,
      conta_bancaria_id: contaId,
      valor: 10,
      direcao: 'entrada',
      data_transacao: '2026-09-0' + Math.min(9, n) + 'T10:00:00',
      descricao: 'Pag ' + n,
      tipo: 'DEPOSITO',
      external_source: 'MOCK_OPEN_FINANCE',
      external_id: 'PAGE-TX-' + String(n).padStart(3, '0')
    };
    const hasMore = page + 1 < this.totalPages;
    return {
      transacoes: [item],
      has_more: hasMore,
      next_cursor: hasMore ? String(page + 1) : null
    };
  }
}

async function setup(opts = {}) {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaUsuarioEmpresasAsync(db);
  await garantirSchemaBancarioAsync(db);
  const empA = await EmpresaService.criarEmpresa({ cnpj: '11222333000181', razao_social: 'A' }, { db });
  const empB = await EmpresaService.criarEmpresa({ cnpj: '04252011000110', razao_social: 'B' }, { db });
  const secretStore = new MemorySecretStore();
  const registry = new BankProviderRegistry();
  const mockOf = opts.provider || new MockOpenFinanceProvider();
  registry.registrar(new MockBankProvider());
  registry.registrar(mockOf);
  const motor = obterMotorBancario({ db, secretStore, registry, env: opts.env || process.env });
  const inst = await motor.criarInstituicao({ nome: 'Banco Teste', codigo: '001' });
  return { db, empA, empB, motor, secretStore, registry, mockOf, inst };
}

async function contaAutorizada(ctx, empresaId, numero) {
  const conta = await ctx.motor.criarConta({
    empresaId,
    instituicao_financeira_id: ctx.inst.id,
    nome: 'Conta ' + numero,
    tipo: 'CORRENTE',
    numero: String(numero)
  });
  await ctx.motor.criarConfiguracaoIntegracao({
    empresaId,
    conta_bancaria_id: conta.id,
    provider: 'MOCK_OPEN_FINANCE',
    ambiente: 'TESTE'
  });
  const ini = await ctx.motor.iniciarConsentimento({
    empresaId,
    conta_bancaria_id: conta.id,
    provider: 'MOCK_OPEN_FINANCE'
  });
  const state = new URL(ini.authorization_url, 'http://127.0.0.1').searchParams.get('state');
  await ctx.motor.processarCallbackConsentimento({
    state,
    query: { resultado: 'aprovado' },
    empresaIdContexto: empresaId
  });
  return conta;
}

describe('MBC-04 hardening sync', () => {
  it('T00 — config central TTL/max páginas + sprint', () => {
    assert.equal(resolverSyncLockTtlMs({}, 1000), 1000);
    assert.equal(resolverSyncLockTtlMs({ SYNC_LOCK_TTL_MS: '120000' }), 120000);
    assert.ok(resolverSyncLockTtlMs({}) >= 60000);
    assert.equal(resolverSyncMaxPaginas({}, 3), 3);
    assert.equal(resolverSyncMaxPaginas({}), 50);
    assert.equal(VERSAO.SPRINT, 'MBC-05.4');
    assert.equal(CONTRATO.includes('obterCredenciaisProvider'), false);
    assert.equal(STATUS_SINCRONIZACAO.PARCIAL, 'PARCIAL');
  });

  it('T01 T02 T03 — sync normal; lock ativo → 409; lock liberado após sucesso', async () => {
    const ctx = await setup();
    try {
      const conta = await contaAutorizada(ctx, ctx.empA.id, '10');
      const out = await ctx.motor.sincronizarConta({ empresaId: ctx.empA.id, id: conta.id });
      assert.equal(out.status, STATUS_SINCRONIZACAO.SUCESSO);
      assert.equal(out.truncated, false);
      const sync = await ctx.motor.obterSincronizacao({ empresaId: ctx.empA.id, id: conta.id });
      assert.equal(sync.status, STATUS_SINCRONIZACAO.SUCESSO);
      assert.equal(sync.lock_iniciado_em, null);

      await dbRun(
        ctx.db,
        `UPDATE sincronizacao_bancaria SET status = ?, lock_iniciado_em = ? WHERE conta_bancaria_id = ?`,
        [STATUS_SINCRONIZACAO.SINCRONIZANDO, new Date().toISOString(), conta.id]
      );
      await assert.rejects(
        () => ctx.motor.sincronizarConta({ empresaId: ctx.empA.id, id: conta.id, lockTtlMs: 60 * 60 * 1000 }),
        (e) => e.code === ERROS.SINCRONIZACAO_EM_ANDAMENTO && e.statusCode === 409
      );
    } finally {
      await closeDb(ctx.db);
    }
  });

  it('T04 T05 — lock expirado → reclaim; lock fresco → bloqueado', async () => {
    const ctx = await setup();
    try {
      const conta = await contaAutorizada(ctx, ctx.empA.id, '11');
      await ctx.motor.sincronizarConta({ empresaId: ctx.empA.id, id: conta.id });
      const antigo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      await dbRun(
        ctx.db,
        `UPDATE sincronizacao_bancaria SET status = ?, lock_iniciado_em = ? WHERE conta_bancaria_id = ?`,
        [STATUS_SINCRONIZACAO.SINCRONIZANDO, antigo, conta.id]
      );
      assert.equal(lockExpirado({
        status: 'SINCRONIZANDO',
        lock_iniciado_em: antigo
      }, 15 * 60 * 1000), true);

      const out = await ctx.motor.sincronizarConta({
        empresaId: ctx.empA.id,
        id: conta.id,
        lockTtlMs: 15 * 60 * 1000
      });
      assert.equal(out.status, STATUS_SINCRONIZACAO.SUCESSO);
      assert.equal(out.lock_reclaimed, true);

      await dbRun(
        ctx.db,
        `UPDATE sincronizacao_bancaria SET status = ?, lock_iniciado_em = ? WHERE conta_bancaria_id = ?`,
        [STATUS_SINCRONIZACAO.SINCRONIZANDO, new Date().toISOString(), conta.id]
      );
      await assert.rejects(
        () => ctx.motor.sincronizarConta({
          empresaId: ctx.empA.id,
          id: conta.id,
          lockTtlMs: 15 * 60 * 1000
        }),
        (e) => e.code === ERROS.SINCRONIZACAO_EM_ANDAMENTO
      );
    } finally {
      await closeDb(ctx.db);
    }
  });

  it('T06 — duas contas em paralelo OK', async () => {
    const ctx = await setup();
    try {
      const c1 = await contaAutorizada(ctx, ctx.empA.id, '21');
      const c2 = await contaAutorizada(ctx, ctx.empA.id, '22');
      const [a, b] = await Promise.all([
        ctx.motor.sincronizarConta({ empresaId: ctx.empA.id, id: c1.id }),
        ctx.motor.sincronizarConta({ empresaId: ctx.empA.id, id: c2.id })
      ]);
      assert.equal(a.status, STATUS_SINCRONIZACAO.SUCESSO);
      assert.equal(b.status, STATUS_SINCRONIZACAO.SUCESSO);
    } finally {
      await closeDb(ctx.db);
    }
  });

  it('T07 — erro libera lock', async () => {
    const ctx = await setup();
    try {
      const conta = await contaAutorizada(ctx, ctx.empA.id, '30');
      ctx.mockOf.falharSaldo = true;
      await assert.rejects(
        () => ctx.motor.sincronizarConta({ empresaId: ctx.empA.id, id: conta.id }),
        () => true
      );
      const sync = await ctx.motor.obterSincronizacao({ empresaId: ctx.empA.id, id: conta.id });
      assert.equal(sync.status, STATUS_SINCRONIZACAO.ERRO);
      assert.equal(sync.lock_iniciado_em, null);
      ctx.mockOf.falharSaldo = false;
      const ok = await ctx.motor.sincronizarConta({ empresaId: ctx.empA.id, id: conta.id });
      assert.equal(ok.status, STATUS_SINCRONIZACAO.SUCESSO);
    } finally {
      await closeDb(ctx.db);
    }
  });

  it('T08 — empresa B não interfere na conta da empresa A', async () => {
    const ctx = await setup();
    try {
      const contaA = await contaAutorizada(ctx, ctx.empA.id, '40');
      await ctx.motor.sincronizarConta({ empresaId: ctx.empA.id, id: contaA.id });
      await dbRun(
        ctx.db,
        `UPDATE sincronizacao_bancaria SET status = ?, lock_iniciado_em = ? WHERE conta_bancaria_id = ? AND empresa_id = ?`,
        [STATUS_SINCRONIZACAO.SINCRONIZANDO, new Date().toISOString(), contaA.id, ctx.empA.id]
      );
      await assert.rejects(
        () => ctx.motor.sincronizarConta({ empresaId: ctx.empB.id, id: contaA.id }),
        (e) => e.code === ERROS.CONTA_NAO_ENCONTRADA || e.statusCode === 404
      );
      await assert.rejects(
        () => ctx.motor.sincronizarConta({ empresaId: ctx.empA.id, id: contaA.id, lockTtlMs: 3600000 }),
        (e) => e.code === ERROS.SINCRONIZACAO_EM_ANDAMENTO
      );
    } finally {
      await closeDb(ctx.db);
    }
  });

  it('T09 T10 T11 — MAX_PAGINAS: SUCESSO vs PARCIAL + checkpoint + retomada idempotente', async () => {
    const prov = new ProviderPaginado(5);
    const ctx = await setup({ provider: prov });
    try {
      const conta = await contaAutorizada(ctx, ctx.empA.id, '50');

      const full = await ctx.motor.sincronizarConta({
        empresaId: ctx.empA.id,
        id: conta.id,
        maxPaginas: 10
      });
      assert.equal(full.status, STATUS_SINCRONIZACAO.SUCESSO);
      assert.equal(full.truncated, false);

      // reset sync row cursor for parcial scenario — new conta
      const conta2 = await contaAutorizada(ctx, ctx.empA.id, '51');
      const parcial = await ctx.motor.sincronizarConta({
        empresaId: ctx.empA.id,
        id: conta2.id,
        maxPaginas: 2
      });
      assert.equal(parcial.status, STATUS_SINCRONIZACAO.PARCIAL);
      assert.equal(parcial.truncated, true);
      assert.equal(parcial.has_more, true);
      assert.ok(parcial.cursor != null);
      assert.equal(parcial.novas_transacoes, 2);

      const sync = await ctx.motor.obterSincronizacao({ empresaId: ctx.empA.id, id: conta2.id });
      assert.equal(sync.status, STATUS_SINCRONIZACAO.PARCIAL);
      assert.equal(sync.cursor_atual, parcial.cursor);
      assert.equal(sync.lock_iniciado_em, null);

      const retomada = await ctx.motor.sincronizarConta({
        empresaId: ctx.empA.id,
        id: conta2.id,
        maxPaginas: 10
      });
      assert.equal(retomada.status, STATUS_SINCRONIZACAO.SUCESSO);
      assert.equal(retomada.truncated, false);
      // páginas restantes (3,4,5) — 3 novas; sem duplicar as 2 primeiras
      assert.equal(retomada.novas_transacoes, 3);
      assert.equal(retomada.duplicadas, 0);

      const lista = await ctx.motor.listarTransacoes({
        empresaId: ctx.empA.id,
        conta_bancaria_id: conta2.id,
        limite: 200
      });
      assert.equal(lista.length, 5);
      const ids = lista.map((t) => t.external_id).sort();
      assert.deepEqual(ids, ['PAGE-TX-001', 'PAGE-TX-002', 'PAGE-TX-003', 'PAGE-TX-004', 'PAGE-TX-005']);
    } finally {
      await closeDb(ctx.db);
    }
  });

  it('T12 — exatamente MAX_PAGINAS sem has_more → SUCESSO', async () => {
    const prov = new ProviderPaginado(3);
    const ctx = await setup({ provider: prov });
    try {
      const conta = await contaAutorizada(ctx, ctx.empA.id, '60');
      const out = await ctx.motor.sincronizarConta({
        empresaId: ctx.empA.id,
        id: conta.id,
        maxPaginas: 3
      });
      assert.equal(out.status, STATUS_SINCRONIZACAO.SUCESSO);
      assert.equal(out.truncated, false);
      assert.equal(out.paginas_processadas, 3);
    } finally {
      await closeDb(ctx.db);
    }
  });

  it('T13 — A03 ENDPOINT_NAO_CONFIGURADO tipado SALDO/EXTRATO; A08 fora do contrato', () => {
    const ep = endpointsParaAmbiente('SANDBOX', {});
    try {
      montarUrlRecurso(ep, 'saldo', {});
      assert.fail('deveria lançar');
    } catch (e) {
      assert.equal(e.errorCode, 'ENDPOINT_NAO_CONFIGURADO');
      assert.equal(e.operacao, 'SALDO');
      assert.match(e.message, /SALDO/);
      assert.doesNotMatch(e.message, /secret|private|Bearer/i);
    }
    try {
      montarUrlRecurso(ep, 'extrato', {});
      assert.fail('deveria lançar');
    } catch (e) {
      assert.equal(e.errorCode, 'ENDPOINT_NAO_CONFIGURADO');
      assert.equal(e.operacao, 'EXTRATO');
    }
    assert.doesNotMatch(src('backend/motores/bancario/MotorBancarioService.js'), /'obterCredenciaisProvider'/);
    assert.match(src('backend/motores/bancario/services/ConfiguracaoIntegracaoBancariaService.js'), /obterCredenciaisProvider/);
    assert.match(src('backend/motores/bancario/services/syncConfig.js'), /SYNC_LOCK_TTL_MS/);
  });

  it('T14 — empresas diferentes sincronizam independente', async () => {
    const ctx = await setup();
    try {
      const cA = await contaAutorizada(ctx, ctx.empA.id, '70');
      const cB = await contaAutorizada(ctx, ctx.empB.id, '71');
      const [a, b] = await Promise.all([
        ctx.motor.sincronizarConta({ empresaId: ctx.empA.id, id: cA.id }),
        ctx.motor.sincronizarConta({ empresaId: ctx.empB.id, id: cB.id })
      ]);
      assert.equal(a.empresa_id, ctx.empA.id);
      assert.equal(b.empresa_id, ctx.empB.id);
      assert.equal(a.status, STATUS_SINCRONIZACAO.SUCESSO);
      assert.equal(b.status, STATUS_SINCRONIZACAO.SUCESSO);
    } finally {
      await closeDb(ctx.db);
    }
  });
});
