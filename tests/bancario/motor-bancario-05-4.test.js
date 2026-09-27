/**
 * Sprint MBC-05.4 — matching determinístico de saídas / Contas a Pagar (domínio).
 * AP dedicada = financeiro.tipo=despesa (não existe tabela contas_pagar).
 * Executar: node --test tests/bancario/motor-bancario-05-4.test.js
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
const UsuarioEmpresaService = require('../../backend/services/empresas/UsuarioEmpresaService');
const { garantirSchemaBancarioAsync } = require('../../backend/motores/bancario/schema/bancarioSchema');
const { obterMotorBancario } = require('../../backend/motores/bancario/MotorBancarioService');
const {
  STATUS_TRANSACAO_CONCILIACAO,
  ERROS,
  CODIGO_PROVIDER
} = require('../../backend/motores/bancario/contracts/constantes');
const { COMPATIBILIDADE_MATCHING } = require('../../backend/motores/bancario/matching/contracts/constantesMatching');

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
    pessoa_nome TEXT,
    documento TEXT,
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
  return { db, empresaA, empresaB, motor };
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
    data_transacao: extra.data_transacao || extra.data || '2026-09-07T10:00:00',
    valor: extra.valor != null ? extra.valor : 1000,
    direcao: extra.direcao || 'SAIDA',
    descricao: extra.descricao || 'TX AP',
    tipo: extra.tipo || 'PIX',
    external_source: extra.external_source,
    external_id: extra.external_id
  });
  return out.transacao;
}

async function criarAp(ctx, empresaId, opts = {}) {
  const r = await run(ctx.db, `INSERT INTO financeiro (
    tipo, descricao, valor, data_movimento, status, vencimento, pessoa_nome, documento, empresa_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    'despesa',
    opts.descricao || 'AP',
    opts.valor,
    opts.data_movimento || opts.data || '2026-09-07',
    opts.status || 'pendente',
    opts.vencimento || opts.data || '2026-09-07',
    opts.pessoa_nome || null,
    opts.documento || null,
    empresaId
  ]);
  return getRow(ctx.db, 'SELECT * FROM financeiro WHERE id = ?', [r.lastID]);
}

function findAp(m, apId) {
  return (m.candidatos || []).find(
    (c) => c.tipo_alvo === 'FINANCEIRO' && c.alvo_id === apId
      && (c.tipo === 'despesa' || c.rotulo_entidade === 'CONTAS_A_PAGAR')
  );
}

describe('MBC-05.4 — matching Contas a Pagar (financeiro despesa)', () => {
  it('T01 — AP disponível integralmente', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '01');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 1000 });
    const ap = await criarAp(ctx, ctx.empresaA.id, { valor: 1000 });
    const m = await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    const cand = findAp(m, ap.id);
    assert.ok(cand);
    assert.equal(cand.rotulo_entidade, 'CONTAS_A_PAGAR');
    assert.equal(cand.valor_original, 1000);
    assert.equal(cand.valor_ja_conciliado, 0);
    assert.equal(cand.valor_disponivel, 1000);
    assert.equal(cand.valor_sugerido, 1000);
    assert.equal(cand.compatibilidade, COMPATIBILIDADE_MATCHING.EXATA);
    assert.equal(cand.data_tipo, 'vencimento');
    await closeDb(ctx.db);
  });

  it('T02 — AP parcialmente utilizada + sugerido limitado', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '02');
    const ap = await criarAp(ctx, ctx.empresaA.id, { valor: 1000 });
    const txPrev = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 400, descricao: 'prev' });
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: txPrev.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: ap.id,
      valor_conciliado: 400
    });
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 800, descricao: 'nova' });
    const m = await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    const cand = findAp(m, ap.id);
    assert.equal(cand.valor_ja_conciliado, 400);
    assert.equal(cand.valor_disponivel, 600);
    assert.equal(cand.valor_sugerido, 600);
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: ap.id,
      valor_conciliado: 600
    });
    const st = await ctx.motor.obterStatusConciliacaoTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    assert.equal(st.status_conciliacao, STATUS_TRANSACAO_CONCILIACAO.PARCIALMENTE_CONCILIADA);
    assert.equal(st.valor_disponivel, 200);
    const m2 = await ctx.motor.obterMatchingTransacao({
      empresaId: ctx.empresaA.id,
      id: (await criarTx(ctx, ctx.empresaA.id, conta, { valor: 50, descricao: 'x' })).id
    });
    assert.equal(!!findAp(m2, ap.id), false);
    await closeDb(ctx.db);
  });

  it('T03 — AP totalmente utilizada não aparece', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '03');
    const ap = await criarAp(ctx, ctx.empresaA.id, { valor: 500 });
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 500 });
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: ap.id,
      valor_conciliado: 500
    });
    const tx2 = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 100, descricao: 'nova' });
    const m = await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: tx2.id });
    assert.equal(!!findAp(m, ap.id), false);
    await closeDb(ctx.db);
  });

  it('T04 — status pago: valor_pago inferido; ainda conciliável se disponível bancário', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '04');
    const ap = await criarAp(ctx, ctx.empresaA.id, { valor: 200, status: 'pago' });
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 200 });
    const m = await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    const cand = findAp(m, ap.id);
    assert.ok(cand);
    assert.equal(cand.valor_pago, 200);
    assert.equal(cand.valor_disponivel, 200);
    await closeDb(ctx.db);
  });

  it('T05 — status parcial sem valor pago persistido → valor_pago null', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '05');
    const ap = await criarAp(ctx, ctx.empresaA.id, { valor: 300, status: 'parcial' });
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 300 });
    const cand = findAp(
      await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: tx.id }),
      ap.id
    );
    assert.ok(cand);
    assert.equal(cand.valor_pago, null);
    assert.equal(cand.quantidade_pagamentos, null);
    await closeDb(ctx.db);
  });

  it('T06 — cancelado não aparece; crédito não retorna AP', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '06');
    const apOk = await criarAp(ctx, ctx.empresaA.id, { valor: 80 });
    const apCancel = await criarAp(ctx, ctx.empresaA.id, {
      valor: 80,
      status: 'cancelado',
      descricao: 'canc'
    });
    const txOut = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 80, direcao: 'SAIDA' });
    const txIn = await criarTx(ctx, ctx.empresaA.id, conta, {
      valor: 80,
      direcao: 'ENTRADA',
      descricao: 'in'
    });
    const mOut = await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: txOut.id });
    const mIn = await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: txIn.id });
    assert.ok(findAp(mOut, apOk.id));
    assert.equal(!!findAp(mOut, apCancel.id), false);
    assert.equal(!!findAp(mIn, apOk.id), false);
    await closeDb(ctx.db);
  });

  it('T07 — multiempresa + data fora da janela', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '07');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 50 });
    const apA = await criarAp(ctx, ctx.empresaA.id, { valor: 50 });
    const apB = await criarAp(ctx, ctx.empresaB.id, { valor: 50 });
    const apLonge = await criarAp(ctx, ctx.empresaA.id, {
      valor: 50,
      vencimento: '2026-01-01',
      data_movimento: '2026-01-01'
    });
    const m = await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    assert.ok(findAp(m, apA.id));
    assert.equal(!!findAp(m, apB.id), false);
    assert.equal(!!findAp(m, apLonge.id), false);
    await closeDb(ctx.db);
  });

  it('T08 — múltiplas conciliações A/B; C bloqueada', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '08');
    const ap = await criarAp(ctx, ctx.empresaA.id, { valor: 1000 });
    const txA = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 400, descricao: 'A' });
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: txA.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: ap.id,
      valor_conciliado: 400
    });
    const txB = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 600, descricao: 'B' });
    assert.equal(findAp(
      await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: txB.id }),
      ap.id
    ).valor_disponivel, 600);
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: txB.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: ap.id,
      valor_conciliado: 600
    });
    const txC = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 100, descricao: 'C' });
    await assert.rejects(
      () => ctx.motor.conciliarTransacao({
        empresaId: ctx.empresaA.id,
        transacao_bancaria_id: txC.id,
        origem_financeira: 'FINANCEIRO',
        registro_financeiro_id: ap.id,
        valor_conciliado: 100
      }),
      (err) => err.code === ERROS.VALORES_INCOMPATIVEIS || err.code === ERROS.JA_CONCILIADA
    );
    await closeDb(ctx.db);
  });

  it('T09 — matching não grava; concorrência; cancelamento libera', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '09');
    const ap = await criarAp(ctx, ctx.empresaA.id, { valor: 100 });
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 100 });
    await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    assert.equal((await ctx.motor.listarConciliacoes({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id
    })).length, 0);
    const conc = await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: ap.id,
      valor_conciliado: 100
    });
    const tx2 = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 100, descricao: 'late' });
    await assert.rejects(() => ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx2.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: ap.id,
      valor_conciliado: 100
    }));
    await ctx.motor.desconciliarTransacao({ empresaId: ctx.empresaA.id, id: conc.id });
    assert.ok(findAp(
      await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: tx2.id }),
      ap.id
    ));
    await closeDb(ctx.db);
  });

  it('T10 — MP + Itaú mock + relatório; sem tabela contas_pagar', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'P', '10');
    const ap = await criarAp(ctx, ctx.empresaA.id, { valor: 22 });
    const txMp = await criarTx(ctx, ctx.empresaA.id, conta, {
      valor: 22,
      external_source: 'mercadopago',
      external_id: 'mp-054'
    });
    const txIt = await criarTx(ctx, ctx.empresaA.id, conta, {
      valor: 22,
      external_source: CODIGO_PROVIDER.ITAU,
      external_id: 'itau-054',
      descricao: 'it'
    });
    assert.ok(findAp(await ctx.motor.obterMatchingTransacao({
      empresaId: ctx.empresaA.id, id: txMp.id
    }), ap.id));
    assert.ok(findAp(await ctx.motor.obterMatchingTransacao({
      empresaId: ctx.empresaA.id, id: txIt.id
    }), ap.id));
    const tabs = await new Promise((resolve, reject) => {
      ctx.db.all(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='contas_pagar'`,
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      );
    });
    assert.equal(tabs.length, 0);
    assert.ok(fs.existsSync(path.join(ROOT, 'docs/bancario/MBC-05.4-RELATORIO.md')));
    await closeDb(ctx.db);
  });
});
