/**
 * Sprint MBC-03 — transações, idempotência e saldo conceitual.
 * Executar: node --test tests/bancario/motor-bancario-03.test.js
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
const { ERROS, STATUS_REGISTRO, DIRECAO } = require('../../backend/motores/bancario/contracts/constantes');

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
  const motor = obterMotorBancario({ db });
  const depsMulti = {
    db,
    obterModoOperacionalGlobal: () => ModoOperacionalGlobal.MULTIEMPRESA
  };
  return { db, empresaA, empresaB, motor, depsMulti };
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

function payload(conta, extra = {}) {
  return {
    conta_bancaria_id: conta.id,
    data_transacao: extra.data_transacao || '2026-09-04T10:00:00',
    valor: extra.valor != null ? extra.valor : 150,
    direcao: extra.direcao || 'ENTRADA',
    descricao: extra.descricao || 'Crédito de teste',
    tipo: extra.tipo || 'OUTROS',
    ...extra
  };
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
    resolverEmpresaIdParaBancario: (req, d) => resolverEmpresaIdParaBancario(req, { ...ctx.depsMulti, ...d })
  }));
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        port,
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

describe('MBC-03 transações', () => {
  it('T01 — criar transação de entrada', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '1');
    const out = await ctx.motor.registrarTransacaoBancaria({
      empresaId: ctx.empresaA.id,
      ...payload(conta)
    });
    assert.equal(out.status, STATUS_REGISTRO.CRIADA);
    assert.equal(out.transacao.direcao, DIRECAO.ENTRADA);
    assert.equal(out.transacao.empresa_id, ctx.empresaA.id);
    assert.equal(out.transacao.conta_bancaria_id, conta.id);
    await closeDb(ctx.db);
  });

  it('T02 — criar transação de saída', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '2');
    const out = await ctx.motor.registrarTransacaoBancaria({
      empresaId: ctx.empresaA.id,
      ...payload(conta, { direcao: 'SAIDA', valor: 300 })
    });
    assert.equal(out.status, STATUS_REGISTRO.CRIADA);
    assert.equal(out.transacao.direcao, DIRECAO.SAIDA);
    assert.equal(out.transacao.valor, 300);
    await closeDb(ctx.db);
  });

  it('T03 — rejeitar valor zero', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '3');
    await assert.rejects(
      () => ctx.motor.registrarTransacaoBancaria({
        empresaId: ctx.empresaA.id,
        ...payload(conta, { valor: 0 })
      }),
      (err) => err.code === ERROS.VALOR_INVALIDO && err.statusCode === 400
    );
    await closeDb(ctx.db);
  });

  it('T04 — rejeitar valor negativo', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '4');
    await assert.rejects(
      () => ctx.motor.registrarTransacaoBancaria({
        empresaId: ctx.empresaA.id,
        ...payload(conta, { valor: -10 })
      }),
      (err) => err.code === ERROS.VALOR_INVALIDO
    );
    await closeDb(ctx.db);
  });

  it('T05 — rejeitar direção inválida', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '5');
    await assert.rejects(
      () => ctx.motor.registrarTransacaoBancaria({
        empresaId: ctx.empresaA.id,
        ...payload(conta, { direcao: 'CREDITO' })
      }),
      (err) => err.code === ERROS.DIRECAO_INVALIDA
    );
    await closeDb(ctx.db);
  });

  it('T06 — rejeitar conta inexistente', async () => {
    const ctx = await setup();
    await assert.rejects(
      () => ctx.motor.registrarTransacaoBancaria({
        empresaId: ctx.empresaA.id,
        conta_bancaria_id: 99999,
        data_transacao: '2026-09-04T10:00:00',
        valor: 10,
        direcao: 'ENTRADA'
      }),
      (err) => err.code === ERROS.CONTA_NAO_ENCONTRADA
    );
    await closeDb(ctx.db);
  });

  it('T07 — rejeitar conta de outra empresa', async () => {
    const ctx = await setup();
    const contaB = await criarConta(ctx, ctx.empresaB.id, 'B', '7');
    await assert.rejects(
      () => ctx.motor.registrarTransacaoBancaria({
        empresaId: ctx.empresaA.id,
        ...payload(contaB)
      }),
      (err) => err.code === ERROS.CONTA_NAO_ENCONTRADA || err.statusCode === 404
    );
    await closeDb(ctx.db);
  });

  it('T08 — rejeitar conta inativa', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '8');
    await ctx.motor.desativarConta({ empresaId: ctx.empresaA.id, id: conta.id });
    await assert.rejects(
      () => ctx.motor.registrarTransacaoBancaria({
        empresaId: ctx.empresaA.id,
        ...payload(conta)
      }),
      (err) => err.code === ERROS.CONTA_INATIVA && err.statusCode === 409
        && /Conta bancária está inativa/.test(err.message)
    );
    await closeDb(ctx.db);
  });

  it('T09 — listar transações da empresa', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '9');
    await ctx.motor.registrarTransacaoBancaria({
      empresaId: ctx.empresaA.id,
      ...payload(conta, { descricao: 'Lista A' })
    });
    const lista = await ctx.motor.listarTransacoes({ empresaId: ctx.empresaA.id });
    assert.equal(lista.length, 1);
    assert.equal(lista[0].descricao, 'Lista A');
    await closeDb(ctx.db);
  });

  it('T10 — outra empresa não enxerga transações', async () => {
    const ctx = await setup();
    const contaA = await criarConta(ctx, ctx.empresaA.id, 'A', '10');
    await ctx.motor.registrarTransacaoBancaria({
      empresaId: ctx.empresaA.id,
      ...payload(contaA, { descricao: 'Só A' })
    });
    const listaB = await ctx.motor.listarTransacoes({ empresaId: ctx.empresaB.id });
    assert.equal(listaB.length, 0);
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaB.id });
    const httpList = await api.json('GET', '/api/bancario/transacoes');
    assert.equal(httpList.status, 200);
    assert.equal(httpList.data.transacoes.length, 0);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T11 — consultar transação por ID', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '11');
    const criada = await ctx.motor.registrarTransacaoBancaria({
      empresaId: ctx.empresaA.id,
      ...payload(conta)
    });
    const obtida = await ctx.motor.obterTransacao({
      empresaId: ctx.empresaA.id,
      id: criada.transacao.id
    });
    assert.equal(obtida.id, criada.transacao.id);
    await closeDb(ctx.db);
  });

  it('T12 — outra empresa recebe 404', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '12');
    const criada = await ctx.motor.registrarTransacaoBancaria({
      empresaId: ctx.empresaA.id,
      ...payload(conta)
    });
    await assert.rejects(
      () => ctx.motor.obterTransacao({ empresaId: ctx.empresaB.id, id: criada.transacao.id }),
      (err) => err.code === ERROS.TRANSACAO_NAO_ENCONTRADA && err.statusCode === 404
    );
    await closeDb(ctx.db);
  });

  it('T13 — external_id + source cria transação', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '13');
    const out = await ctx.motor.registrarTransacaoBancaria({
      empresaId: ctx.empresaA.id,
      ...payload(conta, { external_source: 'MANUAL', external_id: 'MANUAL-0001' })
    });
    assert.equal(out.status, STATUS_REGISTRO.CRIADA);
    assert.equal(out.transacao.external_id, 'MANUAL-0001');
    assert.equal(out.transacao.external_source, 'MANUAL');
    assert.equal(out.idempotencia, true);
    await closeDb(ctx.db);
  });

  it('T14 — mesma chave externa não duplica', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '14');
    const body = payload(conta, { external_source: 'MANUAL', external_id: 'DUP-1', valor: 80 });
    const a = await ctx.motor.registrarTransacaoBancaria({ empresaId: ctx.empresaA.id, ...body });
    const b = await ctx.motor.registrarTransacaoBancaria({
      empresaId: ctx.empresaA.id,
      ...body,
      descricao: 'Tentativa duplicada',
      valor: 999
    });
    assert.equal(a.status, STATUS_REGISTRO.CRIADA);
    assert.equal(b.status, STATUS_REGISTRO.JA_EXISTENTE);
    assert.equal(b.transacao.id, a.transacao.id);
    assert.equal(b.transacao.valor, 80);
    assert.equal(b.transacao.descricao, 'Crédito de teste');
    const lista = await ctx.motor.listarTransacoes({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id });
    assert.equal(lista.length, 1);
    await closeDb(ctx.db);
  });

  it('T15 — mesma external_id em source diferente pode existir', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '15');
    const a = await ctx.motor.registrarTransacaoBancaria({
      empresaId: ctx.empresaA.id,
      ...payload(conta, { external_source: 'MANUAL', external_id: 'MESMO', data_transacao: '2026-09-04T11:00:00' })
    });
    const b = await ctx.motor.registrarTransacaoBancaria({
      empresaId: ctx.empresaA.id,
      ...payload(conta, { external_source: 'OFX', external_id: 'MESMO', data_transacao: '2026-09-04T12:00:00' })
    });
    assert.notEqual(a.transacao.id, b.transacao.id);
    await closeDb(ctx.db);
  });

  it('T16 — mesma external_id em conta diferente pode existir', async () => {
    const ctx = await setup();
    const c1 = await criarConta(ctx, ctx.empresaA.id, 'A1', '16a');
    const c2 = await criarConta(ctx, ctx.empresaA.id, 'A2', '16b');
    const a = await ctx.motor.registrarTransacaoBancaria({
      empresaId: ctx.empresaA.id,
      ...payload(c1, { external_source: 'MANUAL', external_id: 'X1' })
    });
    const b = await ctx.motor.registrarTransacaoBancaria({
      empresaId: ctx.empresaA.id,
      ...payload(c2, { external_source: 'MANUAL', external_id: 'X1' })
    });
    assert.notEqual(a.transacao.id, b.transacao.id);
    await closeDb(ctx.db);
  });

  it('T17 — external_id NULL permite registro', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '17');
    const a = await ctx.motor.registrarTransacaoBancaria({
      empresaId: ctx.empresaA.id,
      ...payload(conta, { descricao: 'sem id 1' })
    });
    const b = await ctx.motor.registrarTransacaoBancaria({
      empresaId: ctx.empresaA.id,
      ...payload(conta, { descricao: 'sem id 2', data_transacao: '2026-09-04T11:00:00' })
    });
    assert.equal(a.status, STATUS_REGISTRO.CRIADA);
    assert.equal(b.status, STATUS_REGISTRO.CRIADA);
    assert.equal(a.transacao.external_id, null);
    assert.notEqual(a.transacao.id, b.transacao.id);
    await closeDb(ctx.db);
  });

  it('T18 — transação sem external_id não declara idempotência', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '18');
    const out = await ctx.motor.registrarTransacaoBancaria({
      empresaId: ctx.empresaA.id,
      ...payload(conta)
    });
    assert.equal(out.idempotencia, false);
    await closeDb(ctx.db);
  });

  it('T19 — valor permanece positivo', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '19');
    const saida = await ctx.motor.registrarTransacaoBancaria({
      empresaId: ctx.empresaA.id,
      ...payload(conta, { direcao: 'SAIDA', valor: 300 })
    });
    assert.equal(saida.transacao.valor > 0, true);
    const row = await get(ctx.db, 'SELECT valor FROM transacao_bancaria WHERE id = ?', [saida.transacao.id]);
    assert.equal(row.valor > 0, true);
    await closeDb(ctx.db);
  });

  it('T20 — entrada soma no saldo conceitual', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '20');
    await ctx.motor.registrarTransacaoBancaria({
      empresaId: ctx.empresaA.id,
      ...payload(conta, { valor: 1000 })
    });
    const saldo = await ctx.motor.calcularSaldoConceitual({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: conta.id
    });
    assert.equal(saldo.saldo_conceitual, 1000);
    assert.equal(saldo.entradas, 1000);
    assert.equal(saldo.natureza, 'conceitual');
    await closeDb(ctx.db);
  });

  it('T21 — saída subtrai no saldo conceitual', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '21');
    await ctx.motor.registrarTransacaoBancaria({
      empresaId: ctx.empresaA.id,
      ...payload(conta, { valor: 1000 })
    });
    await ctx.motor.registrarTransacaoBancaria({
      empresaId: ctx.empresaA.id,
      ...payload(conta, { valor: 300, direcao: 'SAIDA', data_transacao: '2026-09-04T11:00:00' })
    });
    const saldo = await ctx.motor.calcularSaldoConceitual({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: conta.id
    });
    assert.equal(saldo.saldo_conceitual, 700);
    assert.equal(saldo.saidas, 300);
    await closeDb(ctx.db);
  });

  it('T22 — transferência não vira receita/despesa automaticamente', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '22');
    await ctx.motor.registrarTransacaoBancaria({
      empresaId: ctx.empresaA.id,
      ...payload(conta, { direcao: 'TRANSFERENCIA', valor: 50, tipo: 'TRANSFERENCIA' })
    });
    const fin = await get(ctx.db, 'SELECT COUNT(*) AS n FROM financeiro');
    assert.equal(fin.n, 0);
    const saldo = await ctx.motor.calcularSaldoConceitual({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: conta.id
    });
    assert.equal(saldo.saldo_conceitual, 0);
    assert.doesNotMatch(src('backend/motores/bancario/services/TransacaoBancariaService.js'), /INSERT INTO financeiro/i);
    await closeDb(ctx.db);
  });

  it('T23 — saldo após transação da origem não altera saldo conceitual', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '23');
    const out = await ctx.motor.registrarTransacaoBancaria({
      empresaId: ctx.empresaA.id,
      ...payload(conta, { valor: 100, saldo_apos_transacao: 5000 })
    });
    assert.equal(out.transacao.saldo_apos_transacao, 5000);
    const saldo = await ctx.motor.calcularSaldoConceitual({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: conta.id
    });
    assert.equal(saldo.saldo_conceitual, 100);
    assert.notEqual(saldo.saldo_conceitual, out.transacao.saldo_apos_transacao);
    await closeDb(ctx.db);
  });

  it('T24 — conta com transação não pode ser excluída', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '24');
    await ctx.motor.registrarTransacaoBancaria({
      empresaId: ctx.empresaA.id,
      ...payload(conta)
    });
    await assert.rejects(
      () => ctx.motor.excluirConta({ empresaId: ctx.empresaA.id, id: conta.id }),
      (err) => err.code === ERROS.CONFLITO_EXCLUSAO && err.statusCode === 409
        && /Conta bancária possui transações e não pode ser excluída/.test(err.message)
    );
    await closeDb(ctx.db);
  });

  it('T25 — filtro por período funciona', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '25');
    await ctx.motor.registrarTransacaoBancaria({
      empresaId: ctx.empresaA.id,
      ...payload(conta, { data_transacao: '2026-08-01T10:00:00', descricao: 'ago' })
    });
    await ctx.motor.registrarTransacaoBancaria({
      empresaId: ctx.empresaA.id,
      ...payload(conta, { data_transacao: '2026-09-04T10:00:00', descricao: 'set' })
    });
    const set = await ctx.motor.listarTransacoes({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: conta.id,
      data_inicio: '2026-09-01',
      data_fim: '2026-09-30'
    });
    assert.equal(set.length, 1);
    assert.equal(set[0].descricao, 'set');
    await closeDb(ctx.db);
  });

  it('T26 — body empresa_id não consegue alterar empresa', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '26');
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json('POST', '/api/bancario/transacoes', {
      ...payload(conta, { external_source: 'MANUAL', external_id: 'BODY-EMP' }),
      empresa_id: ctx.empresaB.id
    });
    assert.equal(out.status, 201);
    assert.equal(out.data.transacao.empresa_id, ctx.empresaA.id);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T27 — usuário sem autorização recebe 403', async () => {
    const ctx = await setup();
    const api = await listenApp(ctx, { userId: 2, empresaId: ctx.empresaB.id });
    const out = await api.json('GET', '/api/bancario/transacoes');
    assert.equal(out.status, 403);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T28 — período inválido retorna 400', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '28');
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json(
      'GET',
      '/api/bancario/contas/' + conta.id + '/transacoes?data_inicio=2026-09-30&data_fim=2026-09-01'
    );
    assert.equal(out.status, 400);
    assert.equal(out.data.error, 'Período inválido.');
    await api.close();
    await closeDb(ctx.db);
  });

  it('T29 — data inválida retorna 400', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '29');
    await assert.rejects(
      () => ctx.motor.registrarTransacaoBancaria({
        empresaId: ctx.empresaA.id,
        ...payload(conta, { data_transacao: 'não-é-data' })
      }),
      (err) => err.code === ERROS.DATA_INVALIDA && err.statusCode === 400
    );
    let api;
    try {
      api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
      const out = await api.json('GET', '/api/bancario/transacoes?data_inicio=2026-13-99');
      assert.equal(out.status, 400);
    } finally {
      if (api) await api.close();
      await closeDb(ctx.db);
    }
  });

  it('T30 — repetição idempotente não altera saldo duas vezes', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '30');
    const body = payload(conta, { valor: 200, external_source: 'MANUAL', external_id: 'SALDO-1' });
    await ctx.motor.registrarTransacaoBancaria({ empresaId: ctx.empresaA.id, ...body });
    await ctx.motor.registrarTransacaoBancaria({ empresaId: ctx.empresaA.id, ...body });
    const saldo = await ctx.motor.calcularSaldoConceitual({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: conta.id
    });
    assert.equal(saldo.saldo_conceitual, 200);
    await closeDb(ctx.db);
  });
});

describe('MBC-03 invariantes', () => {
  it('schema sem conciliação/Open Finance; financeiro não escrito pelo motor', () => {
    const svc = src('backend/motores/bancario/services/TransacaoBancariaService.js');
    assert.match(src('backend/motores/bancario/schema/bancarioSchema.js'), /transacao_bancaria/);
    assert.doesNotMatch(svc, /INSERT INTO financeiro/i);
    assert.doesNotMatch(src('backend/rotas/bancario.js'), /oauth/i);
    assert.doesNotMatch(src('frontend/erp/js/contas-bancarias.js'), /sincronizar banco|importar OFX/i);
  });
});
