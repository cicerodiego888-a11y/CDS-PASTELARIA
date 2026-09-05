/**
 * Sprint MBC-04 — conciliação bancária manual.
 * Executar: node --test tests/bancario/motor-bancario-04.test.js
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
const { ERROS, STATUS_CONCILIACAO, ORIGEM_FINANCEIRA } = require('../../backend/motores/bancario/contracts/constantes');

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
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL,
    descricao TEXT,
    valor REAL NOT NULL,
    data_movimento TEXT NOT NULL,
    status TEXT,
    empresa_id INTEGER
  )`);
  await run(db, `CREATE TABLE contas_receber (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER,
    numero_parcela INTEGER,
    total_parcelas INTEGER,
    valor_parcela REAL NOT NULL,
    valor_restante REAL NOT NULL,
    data_vencimento TEXT NOT NULL,
    status TEXT DEFAULT 'aberto'
  )`);
  await run(db, `CREATE TABLE contas_receber_pagamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conta_receber_id INTEGER NOT NULL,
    cliente_id INTEGER NOT NULL,
    valor_pago REAL NOT NULL,
    data_pagamento TEXT NOT NULL,
    observacao TEXT
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

async function criarTx(ctx, empresaId, conta, extra = {}) {
  const out = await ctx.motor.registrarTransacaoBancaria({
    empresaId,
    conta_bancaria_id: conta.id,
    data_transacao: extra.data_transacao || '2026-09-04T10:00:00',
    valor: extra.valor != null ? extra.valor : 150,
    direcao: extra.direcao || 'ENTRADA',
    descricao: extra.descricao || 'Crédito de teste',
    tipo: extra.tipo || 'OUTROS'
  });
  return out.transacao;
}

async function criarFin(ctx, empresaId, extra = {}) {
  const r = await run(
    ctx.db,
    `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, empresa_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      extra.tipo || 'receita',
      extra.descricao || 'Receita teste',
      extra.valor != null ? extra.valor : 150,
      extra.data || '2026-09-04',
      extra.status || 'recebido',
      empresaId
    ]
  );
  return get(ctx.db, 'SELECT * FROM financeiro WHERE id = ?', [r.lastID]);
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

describe('MBC-04 conciliação manual', () => {
  it('T01 — listar conciliações', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '1');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta);
    const fin = await criarFin(ctx, ctx.empresaA.id);
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: ORIGEM_FINANCEIRA.FINANCEIRO,
      registro_financeiro_id: fin.id,
      valor_conciliado: 150
    });
    const lista = await ctx.motor.listarConciliacoes({ empresaId: ctx.empresaA.id });
    assert.equal(lista.length, 1);
    assert.equal(lista[0].status, STATUS_CONCILIACAO.CONCILIADA);
    await closeDb(ctx.db);
  });

  it('T02 — listar pendentes', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '2');
    await criarTx(ctx, ctx.empresaA.id, conta);
    const pend = await ctx.motor.listarConciliacoes({ empresaId: ctx.empresaA.id, status: 'PENDENTE' });
    assert.equal(pend.length, 1);
    assert.equal(pend[0].status, STATUS_CONCILIACAO.PENDENTE);
    await closeDb(ctx.db);
  });

  it('T03 T19 — criar conciliação válida e persistir', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '3');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta);
    const fin = await criarFin(ctx, ctx.empresaA.id);
    const conc = await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: fin.id,
      valor_conciliado: 150,
      observacao: 'Pagamento identificado'
    });
    assert.equal(conc.status, STATUS_CONCILIACAO.CONCILIADA);
    assert.equal(conc.ativo, true);
    const row = await get(ctx.db, 'SELECT * FROM conciliacao_bancaria WHERE id = ?', [conc.id]);
    assert.equal(row.transacao_bancaria_id, tx.id);
    await closeDb(ctx.db);
  });

  it('T04 — consultar conciliação', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '4');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta);
    const fin = await criarFin(ctx, ctx.empresaA.id);
    const criada = await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: fin.id,
      valor_conciliado: 150
    });
    const obt = await ctx.motor.obterConciliacao({ empresaId: ctx.empresaA.id, id: criada.id });
    assert.equal(obt.id, criada.id);
    await closeDb(ctx.db);
  });

  it('T05 — transação inexistente', async () => {
    const ctx = await setup();
    const fin = await criarFin(ctx, ctx.empresaA.id);
    await assert.rejects(
      () => ctx.motor.conciliarTransacao({
        empresaId: ctx.empresaA.id,
        transacao_bancaria_id: 99999,
        origem_financeira: 'FINANCEIRO',
        registro_financeiro_id: fin.id,
        valor_conciliado: 150
      }),
      (err) => err.code === ERROS.TRANSACAO_NAO_ENCONTRADA
    );
    await closeDb(ctx.db);
  });

  it('T06 — registro financeiro inexistente', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '6');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta);
    await assert.rejects(
      () => ctx.motor.conciliarTransacao({
        empresaId: ctx.empresaA.id,
        transacao_bancaria_id: tx.id,
        origem_financeira: 'FINANCEIRO',
        registro_financeiro_id: 99999,
        valor_conciliado: 150
      }),
      (err) => err.code === ERROS.REGISTRO_FINANCEIRO_NAO_ENCONTRADO
    );
    await closeDb(ctx.db);
  });

  it('T07 — transação de outra empresa', async () => {
    const ctx = await setup();
    const contaB = await criarConta(ctx, ctx.empresaB.id, 'B', '7');
    const txB = await criarTx(ctx, ctx.empresaB.id, contaB);
    const finA = await criarFin(ctx, ctx.empresaA.id);
    await assert.rejects(
      () => ctx.motor.conciliarTransacao({
        empresaId: ctx.empresaA.id,
        transacao_bancaria_id: txB.id,
        origem_financeira: 'FINANCEIRO',
        registro_financeiro_id: finA.id,
        valor_conciliado: 150
      }),
      (err) => err.statusCode === 404
    );
    await closeDb(ctx.db);
  });

  it('T08 — registro financeiro de outra empresa', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '8');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta);
    const finB = await criarFin(ctx, ctx.empresaB.id);
    await assert.rejects(
      () => ctx.motor.conciliarTransacao({
        empresaId: ctx.empresaA.id,
        transacao_bancaria_id: tx.id,
        origem_financeira: 'FINANCEIRO',
        registro_financeiro_id: finB.id,
        valor_conciliado: 150
      }),
      (err) => err.statusCode === 404
    );
    await closeDb(ctx.db);
  });

  it('T09 — usuário sem autorização', async () => {
    const ctx = await setup();
    const api = await listenApp(ctx, { userId: 2, empresaId: ctx.empresaB.id });
    const out = await api.json('GET', '/api/bancario/conciliacoes');
    assert.equal(out.status, 403);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T10 — empresa do body não altera contexto', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '10');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta);
    const fin = await criarFin(ctx, ctx.empresaA.id);
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json('POST', '/api/bancario/conciliacoes', {
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: fin.id,
      valor_conciliado: 150,
      empresa_id: ctx.empresaB.id
    });
    assert.equal(out.status, 201);
    assert.equal(out.data.empresa_id, ctx.empresaA.id);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T11 — empresa da query não altera contexto', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '11');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta);
    const fin = await criarFin(ctx, ctx.empresaA.id);
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: fin.id,
      valor_conciliado: 150
    });
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json('GET', '/api/bancario/conciliacoes?empresa_id=' + ctx.empresaB.id);
    assert.equal(out.status, 200);
    assert.equal(out.data.empresa_id, ctx.empresaA.id);
    assert.equal(out.data.conciliacoes.length, 1);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T12 — impedir segunda conciliação ativa', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '12');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta);
    const fin1 = await criarFin(ctx, ctx.empresaA.id);
    const fin2 = await criarFin(ctx, ctx.empresaA.id, { descricao: 'Outra' });
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: fin1.id,
      valor_conciliado: 150
    });
    await assert.rejects(
      () => ctx.motor.conciliarTransacao({
        empresaId: ctx.empresaA.id,
        transacao_bancaria_id: tx.id,
        origem_financeira: 'FINANCEIRO',
        registro_financeiro_id: fin2.id,
        valor_conciliado: 150
      }),
      (err) => err.code === ERROS.JA_CONCILIADA && err.statusCode === 409
        && err.message === 'Esta transação bancária já está conciliada.'
    );
    await closeDb(ctx.db);
  });

  it('T13 — valor zero rejeitado', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '13');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta);
    const fin = await criarFin(ctx, ctx.empresaA.id);
    await assert.rejects(
      () => ctx.motor.conciliarTransacao({
        empresaId: ctx.empresaA.id,
        transacao_bancaria_id: tx.id,
        origem_financeira: 'FINANCEIRO',
        registro_financeiro_id: fin.id,
        valor_conciliado: 0
      }),
      (err) => err.code === ERROS.VALOR_INVALIDO
    );
    await closeDb(ctx.db);
  });

  it('T14 — valor negativo rejeitado', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '14');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta);
    const fin = await criarFin(ctx, ctx.empresaA.id);
    await assert.rejects(
      () => ctx.motor.conciliarTransacao({
        empresaId: ctx.empresaA.id,
        transacao_bancaria_id: tx.id,
        origem_financeira: 'FINANCEIRO',
        registro_financeiro_id: fin.id,
        valor_conciliado: -10
      }),
      (err) => err.code === ERROS.VALOR_INVALIDO
    );
    await closeDb(ctx.db);
  });

  it('T15 — valor incompatível rejeitado', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '15');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 200 });
    const fin = await criarFin(ctx, ctx.empresaA.id, { valor: 100 });
    await assert.rejects(
      () => ctx.motor.conciliarTransacao({
        empresaId: ctx.empresaA.id,
        transacao_bancaria_id: tx.id,
        origem_financeira: 'FINANCEIRO',
        registro_financeiro_id: fin.id,
        valor_conciliado: 200
      }),
      (err) => err.statusCode === 409 && err.message === 'Os valores não são compatíveis para conciliação.'
    );
    await closeDb(ctx.db);
  });

  it('T16 — entrada com registro incompatível rejeitada', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '16');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { direcao: 'ENTRADA' });
    const fin = await criarFin(ctx, ctx.empresaA.id, { tipo: 'despesa' });
    await assert.rejects(
      () => ctx.motor.conciliarTransacao({
        empresaId: ctx.empresaA.id,
        transacao_bancaria_id: tx.id,
        origem_financeira: 'FINANCEIRO',
        registro_financeiro_id: fin.id,
        valor_conciliado: 150
      }),
      (err) => err.message === 'Não foi possível validar a compatibilidade financeira da transação.'
    );
    await closeDb(ctx.db);
  });

  it('T17 — saída com registro incompatível rejeitada', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '17');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { direcao: 'SAIDA' });
    const fin = await criarFin(ctx, ctx.empresaA.id, { tipo: 'receita' });
    await assert.rejects(
      () => ctx.motor.conciliarTransacao({
        empresaId: ctx.empresaA.id,
        transacao_bancaria_id: tx.id,
        origem_financeira: 'FINANCEIRO',
        registro_financeiro_id: fin.id,
        valor_conciliado: 150
      }),
      (err) => err.message === 'Não foi possível validar a compatibilidade financeira da transação.'
    );
    await closeDb(ctx.db);
  });

  it('T18 — transferência não concilia como receita/despesa', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '18');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { direcao: 'TRANSFERENCIA' });
    const fin = await criarFin(ctx, ctx.empresaA.id);
    await assert.rejects(
      () => ctx.motor.conciliarTransacao({
        empresaId: ctx.empresaA.id,
        transacao_bancaria_id: tx.id,
        origem_financeira: 'FINANCEIRO',
        registro_financeiro_id: fin.id,
        valor_conciliado: 150
      }),
      (err) => err.message === 'Não foi possível validar a compatibilidade financeira da transação.'
    );
    await closeDb(ctx.db);
  });

  it('T20 T21 — desconciliação preserva histórico e volta a pendente', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '20');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta);
    const fin = await criarFin(ctx, ctx.empresaA.id);
    const conc = await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: fin.id,
      valor_conciliado: 150
    });
    const des = await ctx.motor.desconciliarTransacao({ empresaId: ctx.empresaA.id, id: conc.id });
    assert.equal(des.ativo, false);
    assert.ok(des.desconciliado_em);
    const hist = await ctx.motor.obterConciliacao({ empresaId: ctx.empresaA.id, id: conc.id });
    assert.equal(hist.registro_financeiro_id, fin.id);
    const pend = await ctx.motor.listarConciliacoes({ empresaId: ctx.empresaA.id, status: 'pendente' });
    assert.equal(pend.some((p) => p.transacao_bancaria_id === tx.id), true);
    await closeDb(ctx.db);
  });

  it('T22 — marcar ignorada', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '22');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta);
    const out = await ctx.motor.marcarTransacaoIgnorada({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id
    });
    assert.equal(out.status, STATUS_CONCILIACAO.IGNORADA);
    assert.equal(out.registro_financeiro_id, null);
    await closeDb(ctx.db);
  });

  it('T23 T24 — marcar divergente exige observação', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '23');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta);
    await assert.rejects(
      () => ctx.motor.marcarTransacaoDivergente({
        empresaId: ctx.empresaA.id,
        transacao_bancaria_id: tx.id
      }),
      (err) => err.code === ERROS.OBSERVACAO_OBRIGATORIA
    );
    const out = await ctx.motor.marcarTransacaoDivergente({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      observacao: 'Valor diferente do título.'
    });
    assert.equal(out.status, STATUS_CONCILIACAO.DIVERGENTE);
    await closeDb(ctx.db);
  });

  it('T25 — conciliação de empresa A não aparece em B', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '25');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta);
    const fin = await criarFin(ctx, ctx.empresaA.id);
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: fin.id,
      valor_conciliado: 150
    });
    const listaB = await ctx.motor.listarConciliacoes({ empresaId: ctx.empresaB.id });
    assert.equal(listaB.length, 0);
    await closeDb(ctx.db);
  });

  it('T26 — filtro por conta', async () => {
    const ctx = await setup();
    const c1 = await criarConta(ctx, ctx.empresaA.id, 'A1', '26a');
    const c2 = await criarConta(ctx, ctx.empresaA.id, 'A2', '26b');
    const tx1 = await criarTx(ctx, ctx.empresaA.id, c1);
    const tx2 = await criarTx(ctx, ctx.empresaA.id, c2, { data_transacao: '2026-09-04T11:00:00' });
    const fin1 = await criarFin(ctx, ctx.empresaA.id);
    const fin2 = await criarFin(ctx, ctx.empresaA.id, { descricao: 'B' });
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx1.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: fin1.id,
      valor_conciliado: 150
    });
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx2.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: fin2.id,
      valor_conciliado: 150
    });
    const so1 = await ctx.motor.listarConciliacoes({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: c1.id
    });
    assert.equal(so1.length, 1);
    assert.equal(so1[0].transacao_bancaria_id, tx1.id);
    await closeDb(ctx.db);
  });

  it('T27 — filtro por período', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '27');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta);
    const fin = await criarFin(ctx, ctx.empresaA.id);
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: fin.id,
      valor_conciliado: 150
    });
    const ok = await ctx.motor.listarConciliacoes({
      empresaId: ctx.empresaA.id,
      data_inicio: '2000-01-01',
      data_fim: '2099-12-31'
    });
    assert.equal(ok.length, 1);
    const vazio = await ctx.motor.listarConciliacoes({
      empresaId: ctx.empresaA.id,
      data_inicio: '2020-01-01',
      data_fim: '2020-01-02'
    });
    assert.equal(vazio.length, 0);
    await closeDb(ctx.db);
  });

  it('T28 — filtro por status', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '28');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta);
    const fin = await criarFin(ctx, ctx.empresaA.id);
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: fin.id,
      valor_conciliado: 150
    });
    const lista = await ctx.motor.listarConciliacoes({
      empresaId: ctx.empresaA.id,
      status: 'conciliada'
    });
    assert.equal(lista.length, 1);
    await closeDb(ctx.db);
  });

  it('T29 — repetição concorrente não duplica', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '29');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta);
    const fin = await criarFin(ctx, ctx.empresaA.id);
    const payload = {
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: fin.id,
      valor_conciliado: 150
    };
    const results = await Promise.allSettled([
      ctx.motor.conciliarTransacao(payload),
      ctx.motor.conciliarTransacao(payload)
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const fail = results.filter((r) => r.status === 'rejected');
    assert.equal(ok.length, 1);
    assert.equal(fail.length, 1);
    assert.equal(fail[0].reason.statusCode, 409);
    const n = await get(ctx.db, 'SELECT COUNT(*) AS n FROM conciliacao_bancaria WHERE ativo = 1');
    assert.equal(n.n, 1);
    await closeDb(ctx.db);
  });

  it('T30 — conciliação não altera financeiro', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '30');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta);
    const fin = await criarFin(ctx, ctx.empresaA.id, { valor: 150, status: 'recebido' });
    const antes = await get(ctx.db, 'SELECT * FROM financeiro WHERE id = ?', [fin.id]);
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: fin.id,
      valor_conciliado: 150
    });
    const depois = await get(ctx.db, 'SELECT * FROM financeiro WHERE id = ?', [fin.id]);
    assert.equal(depois.valor, antes.valor);
    assert.equal(depois.status, antes.status);
    assert.equal(depois.tipo, antes.tipo);
    assert.doesNotMatch(src('backend/motores/bancario/services/ConciliacaoBancariaService.js'), /UPDATE financeiro|INSERT INTO financeiro/i);
    await closeDb(ctx.db);
  });

  it('T31 — contas a receber com valor_restante permite parcial', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '31');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 80 });
    const cr = await run(
      ctx.db,
      `INSERT INTO contas_receber (empresa_id, numero_parcela, total_parcelas, valor_parcela, valor_restante, data_vencimento, status)
       VALUES (?, 1, 1, 200, 200, '2026-09-10', 'aberto')`,
      [ctx.empresaA.id]
    );
    const conc = await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: ORIGEM_FINANCEIRA.CONTAS_RECEBER,
      registro_financeiro_id: cr.lastID,
      valor_conciliado: 80
    });
    assert.equal(conc.status, STATUS_CONCILIACAO.CONCILIADA);
    const ainda = await get(ctx.db, 'SELECT valor_restante FROM contas_receber WHERE id = ?', [cr.lastID]);
    assert.equal(ainda.valor_restante, 200);
    await closeDb(ctx.db);
  });

  it('T32 — pagamento de contas a receber herda empresa da parcela', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '32');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 40 });
    const cr = await run(
      ctx.db,
      `INSERT INTO contas_receber (empresa_id, numero_parcela, total_parcelas, valor_parcela, valor_restante, data_vencimento, status)
       VALUES (?, 1, 1, 40, 0, '2026-09-10', 'pago')`,
      [ctx.empresaA.id]
    );
    const pag = await run(
      ctx.db,
      `INSERT INTO contas_receber_pagamentos (conta_receber_id, cliente_id, valor_pago, data_pagamento)
       VALUES (?, 1, 40, '2026-09-04')`,
      [cr.lastID]
    );
    const conc = await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: ORIGEM_FINANCEIRA.CONTAS_RECEBER_PAGAMENTO,
      registro_financeiro_id: pag.lastID,
      valor_conciliado: 40
    });
    assert.equal(conc.origem_financeira, ORIGEM_FINANCEIRA.CONTAS_RECEBER_PAGAMENTO);
    await closeDb(ctx.db);
  });

  it('T33 — índice de unicidade: uma conciliação ativa por transação', async () => {
    const ctx = await setup();
    const schema = src('backend/motores/bancario/schema/bancarioSchema.js');
    assert.match(schema, /idx_conciliacao_bancaria_ativa_por_transacao/);
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '33');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta);
    await run(
      ctx.db,
      `INSERT INTO conciliacao_bancaria (empresa_id, transacao_bancaria_id, status, ativo)
       VALUES (?, ?, 'conciliada', 1)`,
      [ctx.empresaA.id, tx.id]
    );
    await assert.rejects(
      () => run(
        ctx.db,
        `INSERT INTO conciliacao_bancaria (empresa_id, transacao_bancaria_id, status, ativo)
         VALUES (?, ?, 'conciliada', 1)`,
        [ctx.empresaA.id, tx.id]
      ),
      (err) => /UNIQUE/i.test(String(err.message))
    );
    await closeDb(ctx.db);
  });

  it('T34 — transação de conta inativa pode ser conciliada (histórico)', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '34');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta);
    await ctx.motor.desativarConta({ empresaId: ctx.empresaA.id, id: conta.id });
    const fin = await criarFin(ctx, ctx.empresaA.id);
    const conc = await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: fin.id,
      valor_conciliado: 150
    });
    assert.equal(conc.status, STATUS_CONCILIACAO.CONCILIADA);
    await closeDb(ctx.db);
  });

  it('T35 — após desconciliação pode conciliar outro título', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '35');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta);
    const fin50 = await criarFin(ctx, ctx.empresaA.id, { descricao: 't50' });
    const fin51 = await criarFin(ctx, ctx.empresaA.id, { descricao: 't51' });
    const c1 = await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: fin50.id,
      valor_conciliado: 150
    });
    await ctx.motor.desconciliarTransacao({ empresaId: ctx.empresaA.id, id: c1.id });
    const c2 = await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: fin51.id,
      valor_conciliado: 150
    });
    assert.equal(c2.registro_financeiro_id, fin51.id);
    const hist = await ctx.motor.obterConciliacao({ empresaId: ctx.empresaA.id, id: c1.id });
    assert.equal(hist.registro_financeiro_id, fin50.id);
    assert.equal(hist.ativo, false);
    await closeDb(ctx.db);
  });
});

describe('MBC-04 invariantes', () => {
  it('sem matching automático, sem escrita financeira, sem Open Finance', () => {
    const svc = src('backend/motores/bancario/services/ConciliacaoBancariaService.js');
    assert.doesNotMatch(svc, /INSERT INTO financeiro|UPDATE financeiro|UPDATE contas_receber/i);
    assert.doesNotMatch(svc, /fuzzy|openai|sugerir automaticamente/i);
    assert.doesNotMatch(src('backend/rotas/bancario.js'), /oauth/i);
    assert.doesNotMatch(src('frontend/erp/js/contas-bancarias.js'), /sincronizar banco|importar OFX/i);
  });
});
