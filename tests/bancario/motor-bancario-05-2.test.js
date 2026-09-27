/**
 * Sprint MBC-05.2 — matching determinístico + valor disponível.
 * Executar: node --test tests/bancario/motor-bancario-05-2.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('node:http');
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
const {
  STATUS_TRANSACAO_CONCILIACAO,
  ORIGEM_TRANSACAO,
  CODIGO_PROVIDER,
  ERROS
} = require('../../backend/motores/bancario/contracts/constantes');
const { COMPATIBILIDADE_MATCHING } = require('../../backend/motores/bancario/matching/contracts/constantesMatching');
const MatchingScoreService = require('../../backend/motores/bancario/matching/MatchingScoreService');

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
    data_transacao: extra.data_transacao || '2026-09-07T10:00:00',
    valor: extra.valor != null ? extra.valor : 1000,
    direcao: extra.direcao || 'ENTRADA',
    descricao: extra.descricao || 'TX matching',
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

describe('MBC-05.2 — matching determinístico', () => {
  it('T01 — sem conciliação: disponível = total', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '01');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 1000 });
    const m = await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    assert.equal(m.valor_transacao, 1000);
    assert.equal(m.valor_disponivel, 1000);
    assert.equal(m.status_conciliacao, STATUS_TRANSACAO_CONCILIACAO.NAO_CONCILIADA);
    await closeDb(ctx.db);
  });

  it('T02 — parcialmente conciliada: disponível correto', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '02');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 1000 });
    const fin = await criarFin(ctx, ctx.empresaA.id, { valor: 400 });
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: fin.id,
      valor_conciliado: 400
    });
    const m = await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    assert.equal(m.valor_conciliado, 400);
    assert.equal(m.valor_disponivel, 600);
    assert.equal(m.status_conciliacao, STATUS_TRANSACAO_CONCILIACAO.PARCIALMENTE_CONCILIADA);
    await closeDb(ctx.db);
  });

  it('T03 — totalmente conciliada: candidatos vazios', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '03');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 90 });
    const fin = await criarFin(ctx, ctx.empresaA.id, { valor: 90 });
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: fin.id,
      valor_conciliado: 90
    });
    const m = await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    assert.equal(m.status_conciliacao, STATUS_TRANSACAO_CONCILIACAO.CONCILIADA);
    assert.equal(m.candidatos.length, 0);
    await closeDb(ctx.db);
  });

  it('T04/T05/T06 — exemplo 600 disponível: A exata, C compatível, B fora', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '04');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 1000 });
    const fin400 = await criarFin(ctx, ctx.empresaA.id, { valor: 400, descricao: 'prev' });
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: fin400.id,
      valor_conciliado: 400
    });
    const a = await criarFin(ctx, ctx.empresaA.id, { valor: 600, descricao: 'A' });
    const b = await criarFin(ctx, ctx.empresaA.id, { valor: 1000, descricao: 'B' });
    const c = await criarFin(ctx, ctx.empresaA.id, { valor: 300, descricao: 'C' });
    const d = await criarFin(ctx, ctx.empresaB.id, { valor: 600, descricao: 'D-outra' });
    const m = await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    assert.equal(m.valor_disponivel, 600);
    const ids = m.candidatos.map((x) => x.alvo_id);
    assert.ok(ids.includes(a.id));
    assert.ok(ids.includes(c.id));
    assert.equal(ids.includes(b.id), false);
    assert.equal(ids.includes(d.id), false);
    const candA = m.candidatos.find((x) => x.alvo_id === a.id);
    assert.equal(candA.compatibilidade, COMPATIBILIDADE_MATCHING.EXATA);
    assert.equal(candA.valor_sugerido, 600);
    const candC = m.candidatos.find((x) => x.alvo_id === c.id);
    assert.equal(candC.compatibilidade, COMPATIBILIDADE_MATCHING.COMPATIVEL);
    assert.equal(candC.valor_sugerido, 300);
    assert.equal(m.candidatos[0].alvo_id, a.id);
    await closeDb(ctx.db);
  });

  it('T07 — crédito encontra entrada; débito encontra saída', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '07');
    const txIn = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 50, direcao: 'ENTRADA' });
    const txOut = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 50, direcao: 'SAIDA', descricao: 'saida' });
    const rec = await criarFin(ctx, ctx.empresaA.id, { valor: 50, tipo: 'receita', descricao: 'rec' });
    const desp = await criarFin(ctx, ctx.empresaA.id, { valor: 50, tipo: 'despesa', descricao: 'desp' });
    const mIn = await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: txIn.id });
    const mOut = await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: txOut.id });
    assert.ok(mIn.candidatos.some((c) => c.alvo_id === rec.id));
    assert.equal(mIn.candidatos.some((c) => c.alvo_id === desp.id), false);
    assert.ok(mOut.candidatos.some((c) => c.alvo_id === desp.id));
    assert.equal(mOut.candidatos.some((c) => c.alvo_id === rec.id), false);
    await closeDb(ctx.db);
  });

  it('T08 — data fora da janela não retorna', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '08');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, {
      valor: 70,
      data_transacao: '2026-09-07T10:00:00'
    });
    await criarFin(ctx, ctx.empresaA.id, { valor: 70, data: '2026-08-01', descricao: 'longe' });
    const m = await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    assert.equal(m.candidatos.length, 0);
    await closeDb(ctx.db);
  });

  it('T09 — integridade: disponível 300 sugere no máx 300 de candidato 500', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '09');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 1000 });
    const f700 = await criarFin(ctx, ctx.empresaA.id, { valor: 700 });
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: f700.id,
      valor_conciliado: 700
    });
    // FINANCEIRO 500 > disponivel 300 → incompatível (não parcial)
    await criarFin(ctx, ctx.empresaA.id, { valor: 500, descricao: 'maior' });
    const f300 = await criarFin(ctx, ctx.empresaA.id, { valor: 300, descricao: 'exato' });
    const m = await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    assert.equal(m.valor_disponivel, 300);
    assert.equal(m.candidatos.some((c) => c.descricao === 'maior'), false);
    const exato = m.candidatos.find((c) => c.alvo_id === f300.id);
    assert.ok(exato);
    assert.equal(exato.valor_sugerido, 300);
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: f300.id,
      valor_conciliado: 300
    });
    const st = await ctx.motor.obterStatusConciliacaoTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    assert.equal(st.status_conciliacao, STATUS_TRANSACAO_CONCILIACAO.CONCILIADA);
    assert.equal(st.valor_disponivel, 0);
    await closeDb(ctx.db);
  });

  it('T10 — matching não grava conciliação nem sugestão', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '10');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 40 });
    await criarFin(ctx, ctx.empresaA.id, { valor: 40 });
    await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    const concs = await ctx.motor.listarConciliacoes({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id
    });
    assert.equal(concs.length, 0);
    const sugs = await ctx.motor.listarSugestoesConciliacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id
    });
    assert.equal(sugs.length, 0);
    await closeDb(ctx.db);
  });

  it('T11 — concorrência: valor antigo do matching não ultrapassa disponível', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '11');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 100 });
    const f1 = await criarFin(ctx, ctx.empresaA.id, { valor: 100, descricao: '1' });
    const f2 = await criarFin(ctx, ctx.empresaA.id, { valor: 100, descricao: '2' });
    const m = await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    assert.equal(m.valor_disponivel, 100);
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: f1.id,
      valor_conciliado: 100
    });
    await assert.rejects(
      () => ctx.motor.conciliarTransacao({
        empresaId: ctx.empresaA.id,
        transacao_bancaria_id: tx.id,
        origem_financeira: 'FINANCEIRO',
        registro_financeiro_id: f2.id,
        valor_conciliado: 100
      }),
      (err) => err.code === ERROS.JA_CONCILIADA || err.code === ERROS.VALORES_INCOMPATIVEIS
    );
    await closeDb(ctx.db);
  });

  it('T12 — cancelamento libera valor e matching volta a sugerir', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '12');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 200 });
    const f = await criarFin(ctx, ctx.empresaA.id, { valor: 200 });
    const conc = await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: f.id,
      valor_conciliado: 200
    });
    let m = await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    assert.equal(m.candidatos.length, 0);
    await ctx.motor.desconciliarTransacao({ empresaId: ctx.empresaA.id, id: conc.id });
    m = await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    assert.equal(m.valor_disponivel, 200);
    assert.ok(m.candidatos.some((c) => c.alvo_id === f.id));
    await closeDb(ctx.db);
  });

  it('T13 — ordenação determinística estável', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '13');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta, { valor: 500 });
    await criarFin(ctx, ctx.empresaA.id, { valor: 200, descricao: 'p1' });
    await criarFin(ctx, ctx.empresaA.id, { valor: 500, descricao: 'exata' });
    await criarFin(ctx, ctx.empresaA.id, { valor: 100, descricao: 'p2' });
    const a = await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    const b = await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    assert.deepEqual(
      a.candidatos.map((c) => [c.compatibilidade, c.alvo_id]),
      b.candidatos.map((c) => [c.compatibilidade, c.alvo_id])
    );
    assert.equal(a.candidatos[0].compatibilidade, COMPATIBILIDADE_MATCHING.EXATA);
    await closeDb(ctx.db);
  });

  it('T14 — GET /matching HTTP + multiempresa', async () => {
    const ctx = await setup();
    const contaA = await criarConta(ctx, ctx.empresaA.id, 'A', '14');
    const txA = await criarTx(ctx, ctx.empresaA.id, contaA, { valor: 25 });
    await criarFin(ctx, ctx.empresaA.id, { valor: 25 });
    const appA = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const res = await appA.json('GET', '/api/bancario/transacoes/' + txA.id + '/matching');
    assert.equal(res.status, 200);
    assert.equal(res.data.valor_disponivel, 25);
    assert.ok(Array.isArray(res.data.candidatos));
    await appA.close();
    const appB = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaB.id });
    const resB = await appB.json('GET', '/api/bancario/transacoes/' + txA.id + '/matching');
    assert.ok(resB.status === 404 || resB.data.code);
    await appB.close();
    await closeDb(ctx.db);
  });

  it('T15 — Mercado Pago e Itaú mock como TRANSACAO_BANCARIA', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'P', '15');
    const txMp = await criarTx(ctx, ctx.empresaA.id, conta, {
      valor: 12,
      external_source: 'mercadopago',
      external_id: 'mp-052-15',
      descricao: 'MP'
    });
    const txIt = await criarTx(ctx, ctx.empresaA.id, conta, {
      valor: 13,
      external_source: CODIGO_PROVIDER.ITAU,
      external_id: 'itau-052-15',
      descricao: 'IT'
    });
    await criarFin(ctx, ctx.empresaA.id, { valor: 12, descricao: 'fmp' });
    await criarFin(ctx, ctx.empresaA.id, { valor: 13, descricao: 'fit' });
    const mMp = await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: txMp.id });
    const mIt = await ctx.motor.obterMatchingTransacao({ empresaId: ctx.empresaA.id, id: txIt.id });
    assert.ok(mMp.candidatos.length >= 1);
    assert.ok(mIt.candidatos.length >= 1);
    await closeDb(ctx.db);
  });

  it('T16 — score legado sem valor_disponivel permanece VALOR_EXATO clássico', () => {
    const tx = { valor: 150, data_transacao: '2026-09-07', descricao: 'x', external_id: null };
    const c = { valor: 150, data: '2026-09-07', descricao: 'x' };
    const s = MatchingScoreService.calcularScore(tx, c);
    assert.equal(s.motivos.includes('VALOR_EXATO'), true);
    assert.equal(MatchingScoreService.calcularScore(tx, { ...c, valor: 149 }).motivos.includes('VALOR_EXATO'), false);
  });

  it('T17 — relatório e rota matching existem; sem MatchingDeterministicoService paralelo', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'docs/bancario/MBC-05.2-RELATORIO.md')));
    assert.match(
      fs.readFileSync(path.join(ROOT, 'backend/rotas/bancario.js'), 'utf8'),
      /\/transacoes\/:id\/matching/
    );
    assert.equal(fs.existsSync(path.join(ROOT, 'backend/motores/bancario/matching/MatchingDeterministicoService.js')), false);
  });
});
