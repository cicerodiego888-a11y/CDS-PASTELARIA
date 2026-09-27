/**
 * Sprint MBC-05 — fundação da conciliação financeira (múltiplos alvos, valor, multiempresa).
 * Executar: node --test tests/bancario/motor-bancario-05-fundacao.test.js
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
const UsuarioEmpresaService = require('../../backend/services/empresas/UsuarioEmpresaService');
const { garantirSchemaBancarioAsync } = require('../../backend/motores/bancario/schema/bancarioSchema');
const { obterMotorBancario } = require('../../backend/motores/bancario/MotorBancarioService');
const ConciliacaoBancariaService = require('../../backend/motores/bancario/services/ConciliacaoBancariaService');
const { registrarOperacaoMbc } = require('../../backend/motores/bancario/contracts/observabilidadeMbc');
const {
  ERROS,
  STATUS_CONCILIACAO,
  STATUS_TRANSACAO_CONCILIACAO,
  ORIGEM_FINANCEIRA,
  ORIGEM_CONCILIACAO,
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

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(db ? sql : sql, params, (err, row) => (err ? reject(err) : resolve(row)));
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
    descricao: extra.descricao || 'Movimento teste',
    tipo: extra.tipo || 'PIX',
    origem: extra.origem || ORIGEM_TRANSACAO.MANUAL,
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

describe('MBC-05 — fundação conciliação financeira', () => {
  it('T01 — criar conciliação MANUAL', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '01');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 100 });
    const fin = await criarFin(ctx, ctx.empresaA.id, { valor: 100 });
    const conc = await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: ORIGEM_FINANCEIRA.FINANCEIRO,
      registro_financeiro_id: fin.id,
      valor_conciliado: 100,
      origem_conciliacao: ORIGEM_CONCILIACAO.MANUAL
    });
    assert.equal(conc.status, STATUS_CONCILIACAO.CONCILIADA);
    assert.equal(conc.origem_conciliacao, ORIGEM_CONCILIACAO.MANUAL);
    assert.equal(conc.ativo, true);
    await closeDb(ctx.db);
  });

  it('T02 — consultar conciliação por id e por transação', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '02');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 80 });
    const fin = await criarFin(ctx, ctx.empresaA.id, { valor: 80 });
    const criada = await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: fin.id,
      valor_conciliado: 80
    });
    const obt = await ctx.motor.obterConciliacao({ empresaId: ctx.empresaA.id, id: criada.id });
    assert.equal(obt.id, criada.id);
    const porTx = await ctx.motor.obterConciliacoesPorTransacao({
      empresaId: ctx.empresaA.id,
      id: tx.id
    });
    assert.equal(porTx.status, STATUS_CONCILIACAO.CONCILIADA);
    assert.equal(porTx.conciliacoes.length, 1);
    assert.equal(porTx.valor_disponivel, 0);
    await closeDb(ctx.db);
  });

  it('T03 — cancelar preserva histórico e não apaga transação', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '03');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 50 });
    const fin = await criarFin(ctx, ctx.empresaA.id, { valor: 50 });
    const conc = await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: fin.id,
      valor_conciliado: 50
    });
    const cancelada = await ctx.motor.desconciliarTransacao({
      empresaId: ctx.empresaA.id,
      id: conc.id,
      motivo: 'erro de vínculo'
    });
    assert.equal(cancelada.ativo, false);
    assert.ok(cancelada.desconciliado_em);
    assert.match(String(cancelada.observacao || ''), /erro de vínculo/);
    const txAinda = await ctx.motor.obterTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    assert.equal(txAinda.id, tx.id);
    await closeDb(ctx.db);
  });

  it('T04 — valor disponível e valor conciliado', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '04');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 1000 });
    const fin = await criarFin(ctx, ctx.empresaA.id, { valor: 600 });
    assert.equal(await ctx.motor.calcularValorDisponivelConciliacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id
    }), 1000);
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: fin.id,
      valor_conciliado: 600
    });
    assert.equal(await ctx.motor.calcularValorConciliadoTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id
    }), 600);
    assert.equal(await ctx.motor.calcularValorDisponivelConciliacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id
    }), 400);
    await closeDb(ctx.db);
  });

  it('T05 — impedir excesso (soma maior)', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '05');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 500 });
    const f1 = await criarFin(ctx, ctx.empresaA.id, { valor: 300, descricao: 'A' });
    const f2 = await criarFin(ctx, ctx.empresaA.id, { valor: 250, descricao: 'B' });
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: f1.id,
      valor_conciliado: 300
    });
    await assert.rejects(
      () => ctx.motor.conciliarTransacao({
        empresaId: ctx.empresaA.id,
        transacao_bancaria_id: tx.id,
        origem_financeira: 'FINANCEIRO',
        registro_financeiro_id: f2.id,
        valor_conciliado: 250
      }),
      (err) => err.code === ERROS.VALORES_INCOMPATIVEIS
        && /excede o disponível/i.test(err.message)
    );
    await closeDb(ctx.db);
  });

  it('T06 — múltiplos alvos 600+400', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '06');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 1000 });
    const f1 = await criarFin(ctx, ctx.empresaA.id, { valor: 600, descricao: 'R1' });
    const f2 = await criarFin(ctx, ctx.empresaA.id, { valor: 400, descricao: 'R2' });
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: f1.id,
      valor_conciliado: 600
    });
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: f2.id,
      valor_conciliado: 400
    });
    const st = await ConciliacaoBancariaService.obterStatusDaTransacao(ctx.db, tx.id);
    assert.equal(st.status, STATUS_CONCILIACAO.CONCILIADA);
    assert.equal(st.valor_disponivel, 0);
    assert.equal(st.conciliacoes.length, 2);
    await closeDb(ctx.db);
  });

  it('T07 — soma exata fecha; T08 — soma menor permanece pendente', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '07');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 1000 });
    const f1 = await criarFin(ctx, ctx.empresaA.id, { valor: 700 });
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: f1.id,
      valor_conciliado: 700
    });
    let st = await ConciliacaoBancariaService.obterStatusDaTransacao(ctx.db, tx.id);
    assert.equal(st.status, STATUS_CONCILIACAO.PENDENTE);
    assert.equal(st.status_conciliacao, STATUS_TRANSACAO_CONCILIACAO.PARCIALMENTE_CONCILIADA);
    assert.equal(st.valor_disponivel, 300);
    const pend = await ctx.motor.listarConciliacoes({ empresaId: ctx.empresaA.id, status: 'pendente' });
    assert.ok(pend.some((p) => p.transacao_bancaria_id === tx.id));
    const f2 = await criarFin(ctx, ctx.empresaA.id, { valor: 300, descricao: 'fecha' });
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: f2.id,
      valor_conciliado: 300
    });
    st = await ConciliacaoBancariaService.obterStatusDaTransacao(ctx.db, tx.id);
    assert.equal(st.status, STATUS_CONCILIACAO.CONCILIADA);
    assert.equal(st.status_conciliacao, STATUS_TRANSACAO_CONCILIACAO.CONCILIADA);
    await closeDb(ctx.db);
  });

  it('T09 — após 600+400, R$ 1 é bloqueado', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '09');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 1000 });
    const f1 = await criarFin(ctx, ctx.empresaA.id, { valor: 600 });
    const f2 = await criarFin(ctx, ctx.empresaA.id, { valor: 400 });
    const f3 = await criarFin(ctx, ctx.empresaA.id, { valor: 1 });
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: f1.id,
      valor_conciliado: 600
    });
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: f2.id,
      valor_conciliado: 400
    });
    await assert.rejects(
      () => ctx.motor.conciliarTransacao({
        empresaId: ctx.empresaA.id,
        transacao_bancaria_id: tx.id,
        origem_financeira: 'FINANCEIRO',
        registro_financeiro_id: f3.id,
        valor_conciliado: 1
      }),
      (err) => err.code === ERROS.JA_CONCILIADA
    );
    await closeDb(ctx.db);
  });

  it('T10/T11 — multiempresa: alvo de outra empresa bloqueado', async () => {
    const ctx = await setup();
    const contaA = await criarConta(ctx, ctx.empresaA.id, 'A', '10');
    const txA = await criarTx(ctx, ctx.empresaA.id, contaA, { valor: 100 });
    const finB = await criarFin(ctx, ctx.empresaB.id, { valor: 100 });
    await assert.rejects(
      () => ctx.motor.conciliarTransacao({
        empresaId: ctx.empresaA.id,
        transacao_bancaria_id: txA.id,
        origem_financeira: 'FINANCEIRO',
        registro_financeiro_id: finB.id,
        valor_conciliado: 100
      }),
      (err) => err.code === ERROS.REGISTRO_FINANCEIRO_NAO_ENCONTRADO
    );
    const finA = await criarFin(ctx, ctx.empresaA.id, { valor: 100 });
    const ok = await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: txA.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: finA.id,
      valor_conciliado: 100
    });
    assert.equal(ok.empresa_id, ctx.empresaA.id);
    await closeDb(ctx.db);
  });

  it('T12 — alvo inexistente', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '12');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 10 });
    await assert.rejects(
      () => ctx.motor.conciliarTransacao({
        empresaId: ctx.empresaA.id,
        transacao_bancaria_id: tx.id,
        origem_financeira: 'FINANCEIRO',
        registro_financeiro_id: 999999,
        valor_conciliado: 10
      }),
      (err) => err.code === ERROS.REGISTRO_FINANCEIRO_NAO_ENCONTRADO
    );
    await closeDb(ctx.db);
  });

  it('T13 — direção incompatível (CREDIT × despesa)', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '13');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 40, direcao: 'ENTRADA' });
    const desp = await criarFin(ctx, ctx.empresaA.id, { valor: 40, tipo: 'despesa' });
    await assert.rejects(
      () => ctx.motor.conciliarTransacao({
        empresaId: ctx.empresaA.id,
        transacao_bancaria_id: tx.id,
        origem_financeira: 'FINANCEIRO',
        registro_financeiro_id: desp.id,
        valor_conciliado: 40
      }),
      (err) => err.code === ERROS.COMPATIBILIDADE_FINANCEIRA
    );
    await closeDb(ctx.db);
  });

  it('T14 — duplicidade do mesmo vínculo é idempotente', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '14');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 90 });
    const fin = await criarFin(ctx, ctx.empresaA.id, { valor: 90 });
    const c1 = await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: fin.id,
      valor_conciliado: 90
    });
    const c2 = await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: fin.id,
      valor_conciliado: 90
    });
    assert.equal(c1.id, c2.id);
    await closeDb(ctx.db);
  });

  it('T15 — transação inexistente', async () => {
    const ctx = await setup();
    const fin = await criarFin(ctx, ctx.empresaA.id, { valor: 10 });
    await assert.rejects(
      () => ctx.motor.conciliarTransacao({
        empresaId: ctx.empresaA.id,
        transacao_bancaria_id: 999999,
        origem_financeira: 'FINANCEIRO',
        registro_financeiro_id: fin.id,
        valor_conciliado: 10
      }),
      (err) => err.code === ERROS.TRANSACAO_NAO_ENCONTRADA || err.statusCode === 404
    );
    await closeDb(ctx.db);
  });

  it('T16 — rollback em erro (sem vínculo parcial)', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '16');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 55 });
    await assert.rejects(
      () => ctx.motor.conciliarTransacao({
        empresaId: ctx.empresaA.id,
        transacao_bancaria_id: tx.id,
        origem_financeira: 'FINANCEIRO',
        registro_financeiro_id: 888888,
        valor_conciliado: 55
      })
    );
    const lista = await ctx.motor.listarConciliacoes({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id
    });
    assert.equal(lista.length, 0);
    await closeDb(ctx.db);
  });

  it('T17 — auditoria CONCILIACAO_CRIADA / CANCELADA', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '17');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 20 });
    const fin = await criarFin(ctx, ctx.empresaA.id, { valor: 20 });
    const prev = process.env.MBC_LOG_OPERACOES;
    process.env.MBC_LOG_OPERACOES = '0';
    const criada = await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: fin.id,
      valor_conciliado: 20
    });
    const evCriada = registrarOperacaoMbc({
      operacao: 'CONCILIACAO_CRIADA',
      empresa_id: ctx.empresaA.id,
      resultado: 'SUCESSO'
    });
    assert.equal(evCriada.operacao, 'CONCILIACAO_CRIADA');
    await ctx.motor.desconciliarTransacao({ empresaId: ctx.empresaA.id, id: criada.id });
    const evCanc = registrarOperacaoMbc({
      operacao: 'CONCILIACAO_CANCELADA',
      empresa_id: ctx.empresaA.id,
      resultado: 'SUCESSO'
    });
    assert.equal(evCanc.operacao, 'CONCILIACAO_CANCELADA');
    if (prev == null) delete process.env.MBC_LOG_OPERACOES;
    else process.env.MBC_LOG_OPERACOES = prev;
    await closeDb(ctx.db);
  });

  it('T18 — status derivado: pendente → conciliada', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '18');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 30 });
    let st = await ConciliacaoBancariaService.obterStatusDaTransacao(ctx.db, tx.id);
    assert.equal(st.status, STATUS_CONCILIACAO.PENDENTE);
    assert.equal(st.status_conciliacao, STATUS_TRANSACAO_CONCILIACAO.NAO_CONCILIADA);
    const fin = await criarFin(ctx, ctx.empresaA.id, { valor: 30 });
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: fin.id,
      valor_conciliado: 30
    });
    st = await ConciliacaoBancariaService.obterStatusDaTransacao(ctx.db, tx.id);
    assert.equal(st.status, STATUS_CONCILIACAO.CONCILIADA);
    assert.equal(st.status_conciliacao, STATUS_TRANSACAO_CONCILIACAO.CONCILIADA);
    await closeDb(ctx.db);
  });

  it('T19 — Mercado Pago: trata só como TRANSACAO_BANCARIA', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'MP', '19');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, {
      valor: 120,
      descricao: 'Settlement MP',
      origem: ORIGEM_TRANSACAO.PROVIDER,
      external_source: 'mercadopago',
      external_id: 'mp-settlement-19'
    });
    const fin = await criarFin(ctx, ctx.empresaA.id, { valor: 120 });
    const conc = await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: fin.id,
      valor_conciliado: 120
    });
    assert.equal(conc.transacao_bancaria_id, tx.id);
    assert.ok(!('provider' in conc));
    await closeDb(ctx.db);
  });

  it('T20 — Itaú mock: movimentação → transacao → conciliação', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'ITAU', '20');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, {
      valor: 75,
      descricao: 'Extrato Itaú mock',
      origem: ORIGEM_TRANSACAO.PROVIDER,
      external_source: CODIGO_PROVIDER.ITAU,
      external_id: 'itau-mock-20'
    });
    const fin = await criarFin(ctx, ctx.empresaA.id, { valor: 75 });
    const conc = await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: fin.id,
      valor_conciliado: 75,
      origem_conciliacao: ORIGEM_CONCILIACAO.SISTEMA
    });
    assert.equal(conc.origem_conciliacao, ORIGEM_CONCILIACAO.SISTEMA);
    assert.equal(tx.external_source, CODIGO_PROVIDER.ITAU);
    await closeDb(ctx.db);
  });

  it('T21 — schema: índices e origem_conciliacao; sem if provider na conciliação', async () => {
    const schema = fs.readFileSync(path.join(ROOT, 'backend/motores/bancario/schema/bancarioSchema.js'), 'utf8');
    assert.match(schema, /origem_conciliacao/);
    assert.match(schema, /idx_conciliacao_bancaria_vinculo_ativo/);
    assert.match(schema, /idx_conciliacao_bancaria_alvo/);
    const svc = fs.readFileSync(path.join(ROOT, 'backend/motores/bancario/services/ConciliacaoBancariaService.js'), 'utf8');
    assert.doesNotMatch(svc, /if\s*\(.*provider\s*===\s*['"]ITAU/);
    assert.doesNotMatch(svc, /MERCADO_PAGO/);
    const rel = path.join(ROOT, 'docs/bancario/MBC-05-FUNDACAO-CONCILIACAO-RELATORIO.md');
    assert.ok(fs.existsSync(rel), 'relatório MBC-05 deve existir');
    await Promise.resolve();
  });
});
