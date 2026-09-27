/**
 * Sprint MBC-05.1 — pendências, valor disponível, status parcial.
 * Executar: node --test tests/bancario/motor-bancario-05-1.test.js
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
const ConciliacaoBancariaService = require('../../backend/motores/bancario/services/ConciliacaoBancariaService');
const {
  ERROS,
  STATUS_CONCILIACAO,
  STATUS_TRANSACAO_CONCILIACAO,
  ORIGEM_TRANSACAO,
  CODIGO_PROVIDER
} = require('../../backend/motores/bancario/contracts/constantes');

const CNPJ_A = '11222333000181';
const CNPJ_B = '04252011000110';

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

function getRow(db, sql, params = []) {
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
    data_transacao: extra.data_transacao || '2026-09-07T12:00:00',
    valor: extra.valor != null ? extra.valor : 1000,
    direcao: extra.direcao || 'ENTRADA',
    descricao: extra.descricao || 'Movimento 05.1',
    tipo: extra.tipo || 'PIX',
    external_source: extra.external_source,
    external_id: extra.external_id
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
      extra.descricao || 'Receita',
      extra.valor != null ? extra.valor : 1000,
      extra.data || '2026-09-07',
      extra.status || 'recebido',
      empresaId
    ]
  );
  return getRow(ctx.db, 'SELECT * FROM financeiro WHERE id = ?', [r.lastID]);
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

describe('MBC-05.1 — pendências e valor disponível', () => {
  it('T01 — não conciliada', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '01');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 250 });
    const st = await ctx.motor.obterStatusConciliacaoTransacao({
      empresaId: ctx.empresaA.id,
      id: tx.id
    });
    assert.equal(st.status_conciliacao, STATUS_TRANSACAO_CONCILIACAO.NAO_CONCILIADA);
    assert.equal(st.valor_total, 250);
    assert.equal(st.valor_conciliado, 0);
    assert.equal(st.valor_disponivel, 250);
    await closeDb(ctx.db);
  });

  it('T02 — parcialmente conciliada', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '02');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 1000 });
    const fin = await criarFin(ctx, ctx.empresaA.id, { valor: 600 });
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: fin.id,
      valor_conciliado: 600
    });
    const st = await ConciliacaoBancariaService.obterStatusDaTransacao(ctx.db, tx.id);
    assert.equal(st.status_conciliacao, STATUS_TRANSACAO_CONCILIACAO.PARCIALMENTE_CONCILIADA);
    assert.equal(st.status, STATUS_CONCILIACAO.PENDENTE);
    assert.equal(st.valor_conciliado, 600);
    assert.equal(st.valor_disponivel, 400);
    await closeDb(ctx.db);
  });

  it('T03 — totalmente conciliada', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '03');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 80 });
    const fin = await criarFin(ctx, ctx.empresaA.id, { valor: 80 });
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: fin.id,
      valor_conciliado: 80
    });
    const st = await ConciliacaoBancariaService.obterStatusDaTransacao(ctx.db, tx.id);
    assert.equal(st.status_conciliacao, STATUS_TRANSACAO_CONCILIACAO.CONCILIADA);
    assert.equal(st.valor_disponivel, 0);
    await closeDb(ctx.db);
  });

  it('T04 — cancelamento devolve valor disponível', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '04');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 1000 });
    const fin = await criarFin(ctx, ctx.empresaA.id, { valor: 600 });
    const conc = await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: fin.id,
      valor_conciliado: 600
    });
    assert.equal(await ctx.motor.calcularValorDisponivelConciliacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id
    }), 400);
    await ctx.motor.desconciliarTransacao({ empresaId: ctx.empresaA.id, id: conc.id });
    assert.equal(await ctx.motor.calcularValorConciliadoTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id
    }), 0);
    assert.equal(await ctx.motor.calcularValorDisponivelConciliacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id
    }), 1000);
    const hist = await ctx.motor.obterConciliacao({ empresaId: ctx.empresaA.id, id: conc.id });
    assert.equal(hist.ativo, false);
    await closeDb(ctx.db);
  });

  it('T05 — múltiplos alvos 600+300+100; 101 bloqueado', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '05');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 1000 });
    const a = await criarFin(ctx, ctx.empresaA.id, { valor: 600, descricao: 'A' });
    const b = await criarFin(ctx, ctx.empresaA.id, { valor: 300, descricao: 'B' });
    const c = await criarFin(ctx, ctx.empresaA.id, { valor: 100, descricao: 'C' });
    const d = await criarFin(ctx, ctx.empresaA.id, { valor: 101, descricao: 'D' });
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: a.id,
      valor_conciliado: 600
    });
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: b.id,
      valor_conciliado: 300
    });
    assert.equal(await ctx.motor.calcularValorDisponivelConciliacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id
    }), 100);
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: c.id,
      valor_conciliado: 100
    });
    await assert.rejects(
      () => ctx.motor.conciliarTransacao({
        empresaId: ctx.empresaA.id,
        transacao_bancaria_id: tx.id,
        origem_financeira: 'FINANCEIRO',
        registro_financeiro_id: d.id,
        valor_conciliado: 101
      }),
      (err) => err.code === ERROS.JA_CONCILIADA || err.code === ERROS.VALORES_INCOMPATIVEIS
    );
    await closeDb(ctx.db);
  });

  it('T06 — excesso bloqueado', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '06');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 200 });
    const f1 = await criarFin(ctx, ctx.empresaA.id, { valor: 150 });
    const f2 = await criarFin(ctx, ctx.empresaA.id, { valor: 100 });
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: f1.id,
      valor_conciliado: 150
    });
    await assert.rejects(
      () => ctx.motor.conciliarTransacao({
        empresaId: ctx.empresaA.id,
        transacao_bancaria_id: tx.id,
        origem_financeira: 'FINANCEIRO',
        registro_financeiro_id: f2.id,
        valor_conciliado: 100
      }),
      (err) => err.code === ERROS.VALORES_INCOMPATIVEIS
    );
    await closeDb(ctx.db);
  });

  it('T07 — concorrência não ultrapassa valor_total', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '07');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 100 });
    const f1 = await criarFin(ctx, ctx.empresaA.id, { valor: 100, descricao: 'c1' });
    const f2 = await criarFin(ctx, ctx.empresaA.id, { valor: 100, descricao: 'c2' });
    const results = await Promise.allSettled([
      ctx.motor.conciliarTransacao({
        empresaId: ctx.empresaA.id,
        transacao_bancaria_id: tx.id,
        origem_financeira: 'FINANCEIRO',
        registro_financeiro_id: f1.id,
        valor_conciliado: 100
      }),
      ctx.motor.conciliarTransacao({
        empresaId: ctx.empresaA.id,
        transacao_bancaria_id: tx.id,
        origem_financeira: 'FINANCEIRO',
        registro_financeiro_id: f2.id,
        valor_conciliado: 100
      })
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const fail = results.filter((r) => r.status === 'rejected');
    assert.equal(ok.length, 1);
    assert.equal(fail.length, 1);
    const soma = await ctx.motor.calcularValorConciliadoTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id
    });
    assert.equal(soma, 100);
    await closeDb(ctx.db);
  });

  it('T08 — multiempresa: A não vê pendências de B', async () => {
    const ctx = await setup();
    const contaA = await criarConta(ctx, ctx.empresaA.id, 'A', '08');
    const contaB = await criarConta(ctx, ctx.empresaB.id, 'B', '08');
    await criarTx(ctx, ctx.empresaA.id, contaA, { valor: 10, descricao: 'A-only' });
    await criarTx(ctx, ctx.empresaB.id, contaB, { valor: 99, descricao: 'B-only' });
    const pendA = await ctx.motor.listarPendentesConciliacao({ empresaId: ctx.empresaA.id });
    const pendB = await ctx.motor.listarPendentesConciliacao({ empresaId: ctx.empresaB.id });
    assert.ok(pendA.every((p) => p.empresa_id === ctx.empresaA.id));
    assert.ok(!pendA.some((p) => (p.descricao || '').includes('B-only')));
    assert.ok(pendB.some((p) => (p.descricao || '').includes('B-only')));
    await closeDb(ctx.db);
  });

  it('T09 — filtro pendentes por conta e direção', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '09');
    await criarTx(ctx, ctx.empresaA.id, conta, { valor: 15, direcao: 'ENTRADA' });
    await criarTx(ctx, ctx.empresaA.id, conta, { valor: 15, direcao: 'SAIDA', descricao: 'saida' });
    const soEntrada = await ctx.motor.listarPendentesConciliacao({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: conta.id,
      direcao: 'entrada'
    });
    assert.ok(soEntrada.length >= 1);
    assert.ok(soEntrada.every((p) => p.direcao === 'entrada'));
    assert.ok(soEntrada.every((p) => p.valor_total != null && p.valor_disponivel != null));
    await closeDb(ctx.db);
  });

  it('T10 — Mercado Pago como TRANSACAO_BANCARIA em pendentes', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'MP', '10');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, {
      valor: 44,
      external_source: 'mercadopago',
      external_id: 'mp-05-1-10',
      descricao: 'Settlement MP 05.1'
    });
    const pend = await ctx.motor.listarPendentesConciliacao({
      empresaId: ctx.empresaA.id,
      provider: 'MERCADOPAGO'
    });
    assert.ok(pend.some((p) => p.transacao_bancaria_id === tx.id));
    const fin = await criarFin(ctx, ctx.empresaA.id, { valor: 44 });
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: fin.id,
      valor_conciliado: 44
    });
    await closeDb(ctx.db);
  });

  it('T11 — Itaú mock → pendência → conciliação', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'ITAU', '11');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, {
      valor: 55,
      external_source: CODIGO_PROVIDER.ITAU,
      external_id: 'itau-05-1-11',
      descricao: 'Itaú mock 05.1'
    });
    const pend = await ctx.motor.listarPendentesConciliacao({
      empresaId: ctx.empresaA.id,
      provider: CODIGO_PROVIDER.ITAU
    });
    assert.ok(pend.some((p) => p.transacao_bancaria_id === tx.id));
    const fin = await criarFin(ctx, ctx.empresaA.id, { valor: 55 });
    const conc = await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: fin.id,
      valor_conciliado: 55
    });
    assert.equal(conc.ativo, true);
    await closeDb(ctx.db);
  });

  it('T12 — rota GET /conciliacoes/pendentes', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '12');
    await criarTx(ctx, ctx.empresaA.id, conta, { valor: 33 });
    const app = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const res = await app.json(
      'GET',
      '/api/bancario/conciliacoes/pendentes?conta_bancaria_id=' + conta.id
    );
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data.pendentes));
    assert.ok(res.data.pendentes.some((p) => p.valor_disponivel === 33));
    await app.close();
    await closeDb(ctx.db);
  });

  it('T13 — auditoria 757→746: MOCK-05 restaurado; fundação dedicada', async () => {
    const mock05 = fs.readFileSync(path.join(ROOT, 'tests/bancario/motor-bancario-05.test.js'), 'utf8');
    assert.match(mock05, /provider MOCK/);
    assert.equal((mock05.match(/^\s*it\(/gm) || []).length, 30);
    assert.ok(fs.existsSync(path.join(ROOT, 'tests/bancario/motor-bancario-05-fundacao.test.js')));
    assert.ok(fs.existsSync(path.join(ROOT, 'docs/bancario/MBC-05.1-RELATORIO.md')));
  });
});
