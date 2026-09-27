/**
 * Sprint MBC-05.3 — matching CR + valor disponível rico.
 * Executar: node --test tests/bancario/motor-bancario-05-3.test.js
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
    data_transacao: extra.data_transacao || '2026-09-07T10:00:00',
    valor: extra.valor != null ? extra.valor : 1000,
    direcao: extra.direcao || 'ENTRADA',
    descricao: extra.descricao || 'TX CR',
    tipo: extra.tipo || 'PIX',
    external_source: extra.external_source,
    external_id: extra.external_id
  });
  return out.transacao;
}

async function criarCr(ctx, empresaId, extra = {}) {
  const r = await run(
    ctx.db,
    `INSERT INTO contas_receber (
      empresa_id, numero_parcela, total_parcelas, valor_parcela, valor_restante, data_vencimento, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      empresaId,
      extra.numero_parcela != null ? extra.numero_parcela : 1,
      extra.total_parcelas != null ? extra.total_parcelas : 1,
      extra.valor_parcela != null ? extra.valor_parcela : 1000,
      extra.valor_restante != null ? extra.valor_restante : (extra.valor_parcela != null ? extra.valor_parcela : 1000),
      extra.data_vencimento || '2026-09-07',
      extra.status || 'aberto'
    ]
  );
  return getRow(ctx.db, 'SELECT * FROM contas_receber WHERE id = ?', [r.lastID]);
}

async function criarPagamento(ctx, crId, valor, extra = {}) {
  const r = await run(
    ctx.db,
    `INSERT INTO contas_receber_pagamentos (
      conta_receber_id, cliente_id, valor_pago, data_pagamento, observacao
    ) VALUES (?, ?, ?, ?, ?)`,
    [crId, extra.cliente_id || 1, valor, extra.data || '2026-09-07', extra.observacao || null]
  );
  return getRow(ctx.db, 'SELECT * FROM contas_receber_pagamentos WHERE id = ?', [r.lastID]);
}

describe('MBC-05.3 — matching Contas a Receber rico', () => {
  it('T01 — CR integral disponível', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '01');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 1000 });
    const cr = await criarCr(ctx, ctx.empresaA.id, { valor_parcela: 1000, valor_restante: 1000 });
    const m = await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    const cand = m.candidatos.find((c) => c.tipo_alvo === 'CONTAS_RECEBER' && c.alvo_id === cr.id);
    assert.ok(cand);
    assert.equal(cand.valor_original, 1000);
    assert.equal(cand.valor_ja_conciliado, 0);
    assert.equal(cand.valor_disponivel, 1000);
    assert.equal(cand.valor_sugerido, 1000);
    assert.equal(cand.compatibilidade, COMPATIBILIDADE_MATCHING.EXATA);
    assert.equal(cand.data_tipo, 'vencimento');
    await closeDb(ctx.db);
  });

  it('T02 — CR parcialmente conciliado no banco', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '02');
    const tx1 = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 400, descricao: 't1' });
    const cr = await criarCr(ctx, ctx.empresaA.id, { valor_parcela: 1000, valor_restante: 1000 });
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx1.id,
      origem_financeira: 'CONTAS_RECEBER',
      registro_financeiro_id: cr.id,
      valor_conciliado: 400
    });
    const tx2 = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 600, descricao: 't2' });
    const m = await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: tx2.id });
    const cand = m.candidatos.find((c) => c.tipo_alvo === 'CONTAS_RECEBER' && c.alvo_id === cr.id);
    assert.ok(cand);
    assert.equal(cand.valor_ja_conciliado, 400);
    assert.equal(cand.valor_disponivel, 600);
    assert.equal(cand.valor_sugerido, 600);
    await closeDb(ctx.db);
  });

  it('T03 — CR totalmente conciliado não aparece', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '03');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 500 });
    const cr = await criarCr(ctx, ctx.empresaA.id, { valor_parcela: 500, valor_restante: 500 });
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'CONTAS_RECEBER',
      registro_financeiro_id: cr.id,
      valor_conciliado: 500
    });
    const tx2 = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 100, descricao: 'nova' });
    const m = await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: tx2.id });
    assert.equal(
      m.candidatos.some((c) => c.tipo_alvo === 'CONTAS_RECEBER' && c.alvo_id === cr.id),
      false
    );
    await closeDb(ctx.db);
  });

  it('T04/T05 — pagamento parcial + múltiplos pagamentos (sem dupla contagem)', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '04');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 700 });
    // Parcela 1000; pagou 300 → restante 700. Pagamentos NÃO se subtraem de novo.
    const cr = await criarCr(ctx, ctx.empresaA.id, { valor_parcela: 1000, valor_restante: 700 });
    await criarPagamento(ctx, cr.id, 100);
    await criarPagamento(ctx, cr.id, 200);
    const m = await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    const cand = m.candidatos.find((c) => c.tipo_alvo === 'CONTAS_RECEBER' && c.alvo_id === cr.id);
    assert.ok(cand);
    assert.equal(cand.valor_original, 1000);
    assert.equal(cand.valor_pago, 300);
    assert.equal(cand.valor_restante, 700);
    assert.equal(cand.valor_ja_conciliado, 0);
    assert.equal(cand.valor_disponivel, 700);
    assert.equal(cand.quantidade_pagamentos, 2);
    assert.equal(cand.pagamentos.quantidade, 2);
    await closeDb(ctx.db);
  });

  it('T06 — integridade: pagamento + conciliação bancária sem dupla contagem', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '06');
    // Fórmula documentada:
    // valor_disponivel = valor_restante - SUM(conciliações ativas CONTAS_RECEBER)
    // valor_restante já reflete baixas/pagamentos; NÃO subtrair SUM(pagamentos) novamente.
    const cr = await criarCr(ctx, ctx.empresaA.id, { valor_parcela: 1000, valor_restante: 700 });
    await criarPagamento(ctx, cr.id, 300);
    const txPrev = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 200, descricao: 'prev' });
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: txPrev.id,
      origem_financeira: 'CONTAS_RECEBER',
      registro_financeiro_id: cr.id,
      valor_conciliado: 200
    });
    // disponível = 700 - 200 = 500 (NÃO 1000-300-200)
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 400, descricao: 'nova' });
    const m = await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    // alvo_id de PAGAMENTO pode coincidir numericamente com id do CR (tabelas distintas).
    const cand = m.candidatos.find((c) => c.tipo_alvo === 'CONTAS_RECEBER' && c.alvo_id === cr.id);
    assert.ok(cand);
    assert.equal(cand.valor_pago, 300);
    assert.equal(cand.valor_ja_conciliado, 200);
    assert.equal(cand.valor_disponivel, 500);
    assert.equal(cand.valor_sugerido, 400);
    await closeDb(ctx.db);
  });

  it('T07 — sugerido limitado pelo disponível do CR (800 TX × 600 CR)', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '07');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 800 });
    const cr = await criarCr(ctx, ctx.empresaA.id, { valor_parcela: 1000, valor_restante: 1000 });
    const txPrev = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 400, descricao: 'p' });
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: txPrev.id,
      origem_financeira: 'CONTAS_RECEBER',
      registro_financeiro_id: cr.id,
      valor_conciliado: 400
    });
    // disponivel CR = 600
    const m = await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    const cand = m.candidatos.find((c) => c.tipo_alvo === 'CONTAS_RECEBER' && c.alvo_id === cr.id);
    assert.equal(cand.valor_disponivel, 600);
    assert.equal(cand.valor_sugerido, 600);
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'CONTAS_RECEBER',
      registro_financeiro_id: cr.id,
      valor_conciliado: 600
    });
    // TX 800 com conciliação 600 → parcialmente_conciliada (resto 200 na TX).
    // CR ficou sem disponível (1000 − 400 − 600).
    const st = await ctx.motor.obterStatusConciliacaoTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    assert.equal(st.status_conciliacao, STATUS_TRANSACAO_CONCILIACAO.PARCIALMENTE_CONCILIADA);
    assert.equal(st.valor_disponivel, 200);
    const m2 = await ctx.motor.obterMatchingTransacao({
      empresaId: ctx.empresaA.id,
      id: (await criarTx(ctx, ctx.empresaA.id, conta, { valor: 50, descricao: 'x' })).id
    });
    assert.equal(
      m2.candidatos.some((c) => c.tipo_alvo === 'CONTAS_RECEBER' && c.alvo_id === cr.id),
      false
    );
    await closeDb(ctx.db);
  });

  it('T08 — múltiplas conciliações A/B no mesmo CR; C bloqueada', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '08');
    const cr = await criarCr(ctx, ctx.empresaA.id, { valor_parcela: 1000, valor_restante: 1000 });
    const txA = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 400, descricao: 'A' });
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: txA.id,
      origem_financeira: 'CONTAS_RECEBER',
      registro_financeiro_id: cr.id,
      valor_conciliado: 400
    });
    const txB = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 600, descricao: 'B' });
    const mB = await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: txB.id });
    assert.equal(
      mB.candidatos.find((c) => c.tipo_alvo === 'CONTAS_RECEBER' && c.alvo_id === cr.id)
        .valor_disponivel,
      600
    );
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: txB.id,
      origem_financeira: 'CONTAS_RECEBER',
      registro_financeiro_id: cr.id,
      valor_conciliado: 600
    });
    const txC = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 100, descricao: 'C' });
    await assert.rejects(
      () => ctx.motor.conciliarTransacao({
        empresaId: ctx.empresaA.id,
        transacao_bancaria_id: txC.id,
        origem_financeira: 'CONTAS_RECEBER',
        registro_financeiro_id: cr.id,
        valor_conciliado: 100
      }),
      (err) => err.code === ERROS.VALORES_INCOMPATIVEIS || err.code === ERROS.JA_CONCILIADA
    );
    await closeDb(ctx.db);
  });

  it('T09 — crédito encontra CR; débito não', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '09');
    const cr = await criarCr(ctx, ctx.empresaA.id, { valor_parcela: 80, valor_restante: 80 });
    const txIn = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 80, direcao: 'ENTRADA' });
    const txOut = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 80, direcao: 'SAIDA', descricao: 'out' });
    const mIn = await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: txIn.id });
    const mOut = await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: txOut.id });
    assert.ok(mIn.candidatos.some((c) => c.tipo_alvo === 'CONTAS_RECEBER' && c.alvo_id === cr.id));
    assert.equal(
      mOut.candidatos.some((c) => c.tipo_alvo === 'CONTAS_RECEBER' && c.alvo_id === cr.id),
      false
    );
    await closeDb(ctx.db);
  });

  it('T10 — multiempresa + data fora da janela', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '10');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 50 });
    const crA = await criarCr(ctx, ctx.empresaA.id, { valor_parcela: 50, valor_restante: 50 });
    const crB = await criarCr(ctx, ctx.empresaB.id, { valor_parcela: 50, valor_restante: 50 });
    const crLonge = await criarCr(ctx, ctx.empresaA.id, {
      valor_parcela: 50,
      valor_restante: 50,
      data_vencimento: '2026-01-01'
    });
    const m = await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    assert.ok(m.candidatos.some((c) => c.tipo_alvo === 'CONTAS_RECEBER' && c.alvo_id === crA.id));
    assert.equal(
      m.candidatos.some((c) => c.tipo_alvo === 'CONTAS_RECEBER' && c.alvo_id === crB.id),
      false
    );
    assert.equal(
      m.candidatos.some((c) => c.tipo_alvo === 'CONTAS_RECEBER' && c.alvo_id === crLonge.id),
      false
    );
    await closeDb(ctx.db);
  });

  it('T11 — matching não grava; concorrência revalida; cancelamento libera', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '11');
    const cr = await criarCr(ctx, ctx.empresaA.id, { valor_parcela: 100, valor_restante: 100 });
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 100 });
    await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    const antes = await ctx.motor.listarConciliacoes({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id
    });
    assert.equal(antes.length, 0);
    const conc = await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'CONTAS_RECEBER',
      registro_financeiro_id: cr.id,
      valor_conciliado: 100
    });
    const tx2 = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 100, descricao: 'late' });
    await assert.rejects(
      () => ctx.motor.conciliarTransacao({
        empresaId: ctx.empresaA.id,
        transacao_bancaria_id: tx2.id,
        origem_financeira: 'CONTAS_RECEBER',
        registro_financeiro_id: cr.id,
        valor_conciliado: 100
      })
    );
    await ctx.motor.desconciliarTransacao({ empresaId: ctx.empresaA.id, id: conc.id });
    const m = await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: tx2.id });
    assert.ok(
      m.candidatos.some(
        (c) => c.tipo_alvo === 'CONTAS_RECEBER' && c.alvo_id === cr.id && c.valor_disponivel === 100
      )
    );
    await closeDb(ctx.db);
  });

  it('T12 — MP + Itaú mock + relatório', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'P', '12');
    const cr = await criarCr(ctx, ctx.empresaA.id, { valor_parcela: 22, valor_restante: 22 });
    const txMp = await criarTx(ctx, ctx.empresaA.id, conta, {
      valor: 22,
      external_source: 'mercadopago',
      external_id: 'mp-053'
    });
    const txIt = await criarTx(ctx, ctx.empresaA.id, conta, {
      valor: 22,
      external_source: CODIGO_PROVIDER.ITAU,
      external_id: 'itau-053',
      descricao: 'it'
    });
    assert.ok((await ctx.motor.obterMatchingTransacao({
      empresaId: ctx.empresaA.id, id: txMp.id
    })).candidatos.some((c) => c.tipo_alvo === 'CONTAS_RECEBER' && c.alvo_id === cr.id));
    assert.ok((await ctx.motor.obterMatchingTransacao({
      empresaId: ctx.empresaA.id, id: txIt.id
    })).candidatos.some((c) => c.tipo_alvo === 'CONTAS_RECEBER' && c.alvo_id === cr.id));
    assert.ok(fs.existsSync(path.join(ROOT, 'docs/bancario/MBC-05.3-RELATORIO.md')));
    await closeDb(ctx.db);
  });
});
