/**
 * AUD-MBC-05-FINAL — regressão das correções de integridade (A01/A02/A03).
 * Sem novas features; apenas garante fixes do núcleo.
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();

const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const UsuarioEmpresaService = require('../../backend/services/empresas/UsuarioEmpresaService');
const { garantirSchemaBancarioAsync } = require('../../backend/motores/bancario/schema/bancarioSchema');
const { obterMotorBancario } = require('../../backend/motores/bancario/MotorBancarioService');
const { STATUS_TRANSACAO_CONCILIACAO } = require('../../backend/motores/bancario/contracts/constantes');

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
    vencimento TEXT,
    empresa_id INTEGER
  )`);
  await run(db, `CREATE TABLE contas_receber (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER, numero_parcela INTEGER, total_parcelas INTEGER,
    valor_parcela REAL NOT NULL, valor_restante REAL NOT NULL,
    data_vencimento TEXT NOT NULL, status TEXT DEFAULT 'aberto'
  )`);
  await run(db, `CREATE TABLE contas_receber_pagamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conta_receber_id INTEGER NOT NULL, cliente_id INTEGER NOT NULL,
    valor_pago REAL NOT NULL, data_pagamento TEXT NOT NULL, observacao TEXT
  )`);
  const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaA.id, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaB.id, { db });
  return { db, empresaA, empresaB, motor: obterMotorBancario({ db }) };
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
    data_transacao: extra.data_transacao || '2026-09-07T10:00:00',
    valor: extra.valor != null ? extra.valor : 100,
    direcao: extra.direcao || 'ENTRADA',
    descricao: extra.descricao || 'TX',
    tipo: 'PIX'
  });
  return out.transacao;
}

async function criarFin(ctx, empresaId, extra = {}) {
  const r = await run(ctx.db, `INSERT INTO financeiro (
    tipo, descricao, valor, data_movimento, status, vencimento, empresa_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
    extra.tipo || 'receita',
    extra.descricao || 'fin',
    extra.valor,
    extra.data || '2026-09-07',
    extra.status || 'pendente',
    extra.vencimento || extra.data || '2026-09-07',
    empresaId
  ]);
  return getRow(ctx.db, 'SELECT * FROM financeiro WHERE id = ?', [r.lastID]);
}

describe('AUD-MBC-05-FINAL — correções de integridade', () => {
  it('A01 — receita totalmente conciliada não aparece no matching', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', 'a01');
    const rec = await criarFin(ctx, ctx.empresaA.id, { tipo: 'receita', valor: 100 });
    const tx1 = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 100, descricao: 't1' });
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx1.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: rec.id,
      valor_conciliado: 100
    });
    const tx2 = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 100, descricao: 't2' });
    const m = await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: tx2.id });
    assert.equal(
      m.candidatos.some((c) => c.tipo_alvo === 'FINANCEIRO' && c.alvo_id === rec.id),
      false
    );
    await closeDb(ctx.db);
  });

  it('A02 — aceitar sugestão AP parcial honra permite_parcial', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', 'a02');
    const ap = await criarFin(ctx, ctx.empresaA.id, { tipo: 'despesa', valor: 500 });
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, {
      valor: 200,
      direcao: 'SAIDA',
      descricao: 'parcial'
    });
    // Inserir sugestão pendente (análise por score pode não persistir se abaixo do limiar).
    const ins = await run(ctx.db, `INSERT INTO sugestao_conciliacao_bancaria (
      empresa_id, transacao_bancaria_id, tipo_registro, registro_id,
      score, nivel_confianca, motivos, status, valor_candidato, data_candidato
    ) VALUES (?, ?, 'FINANCEIRO', ?, 80, 'ALTA', '[]', 'PENDENTE', 500, '2026-09-07')`, [
      ctx.empresaA.id, tx.id, ap.id
    ]);
    const out = await ctx.motor.aceitarSugestaoConciliacao({
      empresaId: ctx.empresaA.id,
      id: ins.lastID
    });
    assert.ok(out.conciliacao);
    assert.equal(Number(out.conciliacao.valor_conciliado), 200);
    const st = await ctx.motor.obterStatusConciliacaoTransacao({
      empresaId: ctx.empresaA.id,
      id: tx.id
    });
    assert.equal(st.status_conciliacao, STATUS_TRANSACAO_CONCILIACAO.CONCILIADA);
    await closeDb(ctx.db);
  });

  it('A03 — receita cancelada não aparece no matching', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', 'a03');
    await criarFin(ctx, ctx.empresaA.id, {
      tipo: 'receita',
      valor: 50,
      status: 'cancelado',
      descricao: 'canc'
    });
    const ok = await criarFin(ctx, ctx.empresaA.id, { tipo: 'receita', valor: 50, descricao: 'ok' });
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 50 });
    const m = await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    assert.ok(m.candidatos.some((c) => c.alvo_id === ok.id));
    assert.equal(
      m.candidatos.some((c) => c.descricao === 'canc'),
      false
    );
    await closeDb(ctx.db);
  });

  it('núcleo — cancelamento libera disponível TX; relatório existe', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', 'a04');
    const rec = await criarFin(ctx, ctx.empresaA.id, { tipo: 'receita', valor: 600 });
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 1000 });
    const conc = await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: rec.id,
      valor_conciliado: 600
    });
    let st = await ctx.motor.obterStatusConciliacaoTransacao({
      empresaId: ctx.empresaA.id,
      id: tx.id
    });
    assert.equal(st.valor_disponivel, 400);
    assert.equal(st.status_conciliacao, STATUS_TRANSACAO_CONCILIACAO.PARCIALMENTE_CONCILIADA);
    await ctx.motor.desconciliarTransacao({ empresaId: ctx.empresaA.id, id: conc.id });
    st = await ctx.motor.obterStatusConciliacaoTransacao({
      empresaId: ctx.empresaA.id,
      id: tx.id
    });
    assert.equal(st.valor_disponivel, 1000);
    await closeDb(ctx.db);
  });
});
