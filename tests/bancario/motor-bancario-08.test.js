/**
 * Sprint MBC-08 — matching e sugestões. Matching sugere; MBC-04 concilia.
 * Executar: node --test tests/bancario/motor-bancario-08.test.js
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
const { ERROS, STATUS_CONCILIACAO } = require('../../backend/motores/bancario/contracts/constantes');
const { calcularScore } = require('../../backend/motores/bancario/matching/MatchingScoreService');
const { normalizarTexto } = require('../../backend/motores/bancario/matching/MatchingNormalizacaoService');
const { NIVEL_CONFIANCA, STATUS_SUGESTAO, RESULTADO_MATCHING } = require('../../backend/motores/bancario/matching/contracts/constantesMatching');

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
    id INTEGER PRIMARY KEY AUTOINCREMENT, tipo TEXT NOT NULL, descricao TEXT,
    valor REAL NOT NULL, data_movimento TEXT NOT NULL, status TEXT, empresa_id INTEGER
  )`);
  await run(db, `CREATE TABLE contas_receber (
    id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER, numero_parcela INTEGER,
    total_parcelas INTEGER, valor_parcela REAL NOT NULL, valor_restante REAL NOT NULL,
    data_vencimento TEXT NOT NULL, status TEXT DEFAULT 'aberto'
  )`);
  await run(db, `CREATE TABLE contas_receber_pagamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, conta_receber_id INTEGER NOT NULL,
    cliente_id INTEGER NOT NULL, valor_pago REAL NOT NULL, data_pagamento TEXT NOT NULL, observacao TEXT
  )`);
  await run(db, `CREATE TABLE vendas (id INTEGER PRIMARY KEY, empresa_id INTEGER)`);
  await run(db, `CREATE TABLE compras (id INTEGER PRIMARY KEY, empresa_id INTEGER)`);
  await run(db, `CREATE TABLE caixa_sessoes (id INTEGER PRIMARY KEY, empresa_id INTEGER)`);
  const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaA.id, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaB.id, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(2, empresaA.id, { db });
  const motor = obterMotorBancario({ db });
  return {
    db, empresaA, empresaB, motor,
    depsMulti: { db, obterModoOperacionalGlobal: () => ModoOperacionalGlobal.MULTIEMPRESA }
  };
}

async function criarConta(ctx, empresaId, nome, numero) {
  const inst = await ctx.motor.criarInstituicao({ nome: 'Inst ' + nome + ' ' + numero });
  return ctx.motor.criarConta({
    empresaId, instituicao_financeira_id: inst.id, nome, tipo: 'CORRENTE', numero
  });
}

async function criarTx(ctx, empresaId, contaId, extra = {}) {
  const out = await ctx.motor.registrarTransacaoBancaria({
    empresaId,
    conta_bancaria_id: contaId,
    valor: extra.valor != null ? extra.valor : 150,
    direcao: extra.direcao || 'entrada',
    data_transacao: extra.data || '2026-09-04',
    descricao: extra.descricao || 'PIX JOAO DA SILVA',
    tipo: extra.tipo || 'PIX',
    external_source: extra.external_source || 'MANUAL',
    external_id: extra.external_id || null,
    referencia_externa: extra.referencia_externa || null
  });
  return out.transacao;
}

async function criarFin(ctx, empresaId, extra = {}) {
  const r = await run(
    ctx.db,
    `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, empresa_id)
     VALUES (?, ?, ?, ?, 'aberto', ?)`,
    [
      extra.tipo || 'receita',
      extra.descricao || 'PIX JOAO DA SILVA',
      extra.valor != null ? extra.valor : 150,
      extra.data || '2026-09-04',
      empresaId
    ]
  );
  return r.lastID;
}

async function criarCr(ctx, empresaId, extra = {}) {
  const r = await run(
    ctx.db,
    `INSERT INTO contas_receber (empresa_id, numero_parcela, total_parcelas, valor_parcela, valor_restante, data_vencimento, status)
     VALUES (?, 1, 1, ?, ?, ?, 'aberto')`,
    [empresaId, extra.valor != null ? extra.valor : 150, extra.valor != null ? extra.valor : 150, extra.data || '2026-09-04']
  );
  return r.lastID;
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
    obterMotorBancario: (d) => obterMotorBancario({ db: d.db || ctx.db }),
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
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: body != null ? JSON.stringify(body) : undefined
          });
          const data = await res.json().catch(() => ({}));
          return { status: res.status, data };
        },
        close() { return new Promise((r) => server.close(() => r())); }
      });
    });
  });
}

const txBase = { valor: 150, data_transacao: '2026-09-04', descricao: 'PIX JOAO DA SILVA', external_id: 'E2E-001' };
const cand = (o = {}) => ({
  valor: o.valor != null ? o.valor : 150,
  data: o.data || '2026-09-04',
  descricao: o.descricao || 'PIX JOAO DA SILVA',
  identificador: o.identificador || null
});

describe('MBC-08 critérios e score', () => {
  it('T01 — valor exato', () => {
    assert.equal(calcularScore(txBase, cand()).motivos.includes('VALOR_EXATO'), true);
  });
  it('T02 — valor diferente', () => {
    assert.equal(calcularScore(txBase, cand({ valor: 149 })).motivos.includes('VALOR_EXATO'), false);
  });
  it('T03 — data exata', () => {
    assert.equal(calcularScore(txBase, cand()).motivos.includes('DATA_MESMO_DIA'), true);
  });
  it('T04 — data próxima', () => {
    assert.equal(calcularScore(txBase, cand({ data: '2026-09-05' })).motivos.includes('DATA_1_DIA'), true);
  });
  it('T05 — data fora da janela', () => {
    const s = calcularScore(txBase, cand({ data: '2026-09-10' }));
    assert.equal(s.motivos.some((m) => String(m).startsWith('DATA_')), false);
  });
  it('T06 — descrição idêntica', () => {
    assert.equal(calcularScore(txBase, cand()).motivos.includes('DESCRICAO_IDENTICA'), true);
  });
  it('T07 — descrição normalizada', () => {
    assert.equal(normalizarTexto('PIX - João da Silva'), normalizarTexto('PIX JOAO DA SILVA'));
    assert.equal(calcularScore(txBase, cand({ descricao: 'PIX - João da Silva' })).motivos.includes('DESCRICAO_IDENTICA'), true);
  });
  it('T08 — descrição diferente', () => {
    const s = calcularScore(txBase, cand({ descricao: 'TED FORNECEDOR XYZ' }));
    assert.equal(s.motivos.includes('DESCRICAO_IDENTICA'), false);
  });
  it('T09 — identificador exato', () => {
    assert.equal(calcularScore(txBase, cand({ identificador: 'E2E-001' })).motivos.includes('IDENTIFICADOR_EXATO'), true);
  });
  it('T10 — identificador diferente', () => {
    assert.equal(calcularScore(txBase, cand({ identificador: 'OUTRO' })).motivos.includes('IDENTIFICADOR_EXATO'), false);
  });
  it('T11 — score máximo', () => {
    const s = calcularScore(txBase, cand({ identificador: 'E2E-001' }));
    assert.equal(s.score, 100);
    assert.equal(s.nivel_confianca, NIVEL_CONFIANCA.ALTA);
  });
  it('T12 — score alto', () => {
    const s = calcularScore({ ...txBase, descricao: 'OUTRO TEXTO' }, cand({ identificador: 'E2E-001', descricao: 'E2E-001 PAGAMENTO' }));
    assert.ok(s.score >= 90);
    assert.equal(s.nivel_confianca, NIVEL_CONFIANCA.ALTA);
  });
  it('T13 — score médio', () => {
    const s = calcularScore({ ...txBase, external_id: null }, cand());
    assert.equal(s.score, 75);
    assert.equal(s.nivel_confianca, NIVEL_CONFIANCA.MEDIA);
  });
  it('T14 — score baixo', () => {
    const s = calcularScore({ ...txBase, external_id: null, descricao: 'X' }, cand({ descricao: 'Y' }));
    assert.equal(s.score, 65);
    assert.equal(s.nivel_confianca, NIVEL_CONFIANCA.BAIXA);
  });
  it('T15 — score abaixo do limite', () => {
    const s = calcularScore({ ...txBase, valor: 80, external_id: null, descricao: 'AAA' }, cand({ valor: 150, descricao: 'BBB', data: '2026-09-10' }));
    assert.equal(s.sugerir, false);
    assert.ok(s.score < 60);
  });
});

describe('MBC-08 análise e sugestões', () => {
  it('T16 T17 — múltiplos candidatos e empate', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '16');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta.id);
    await criarFin(ctx, ctx.empresaA.id, { descricao: 'PIX JOAO DA SILVA A' });
    await criarFin(ctx, ctx.empresaA.id, { descricao: 'PIX JOAO DA SILVA B' });
    const out = await ctx.motor.analisarConciliacaoTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    assert.equal(out.resultado, RESULTADO_MATCHING.MULTIPLOS);
    assert.ok(out.sugestoes.length >= 2);
    await closeDb(ctx.db);
  });

  it('T18 — candidato único', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '18');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta.id);
    await criarFin(ctx, ctx.empresaA.id);
    const out = await ctx.motor.analisarConciliacaoTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    assert.equal(out.resultado, RESULTADO_MATCHING.UNICO);
    await closeDb(ctx.db);
  });

  it('T19 — nenhum candidato', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '19');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta.id);
    await criarFin(ctx, ctx.empresaA.id, { valor: 999 });
    const out = await ctx.motor.analisarConciliacaoTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    assert.equal(out.resultado, RESULTADO_MATCHING.NENHUM);
    await closeDb(ctx.db);
  });

  it('T20 — transação já conciliada', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '20');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta.id);
    const fin = await criarFin(ctx, ctx.empresaA.id);
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: fin,
      valor_conciliado: 150
    });
    const out = await ctx.motor.analisarConciliacaoTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    assert.equal(out.resultado, RESULTADO_MATCHING.JA_CONCILIADA);
    await closeDb(ctx.db);
  });

  it('T21 T22 T23 — idempotência da segunda análise', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '21');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta.id);
    await criarFin(ctx, ctx.empresaA.id);
    const a = await ctx.motor.analisarConciliacaoTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    const b = await ctx.motor.analisarConciliacaoTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    assert.equal(a.criadas, 1);
    assert.equal(b.criadas, 0);
    const lista = await ctx.motor.listarSugestoesConciliacao({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id });
    assert.equal(lista.length, 1);
    await closeDb(ctx.db);
  });

  it('T24 T26 T27 T28 T29 T30 — aceite chama MBC-04 sem alterar módulos', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '24');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta.id);
    const fin = await criarFin(ctx, ctx.empresaA.id);
    const before = {
      fin: (await get(ctx.db, 'SELECT COUNT(*) AS n FROM financeiro')).n,
      vendas: (await get(ctx.db, 'SELECT COUNT(*) AS n FROM vendas')).n,
      compras: (await get(ctx.db, 'SELECT COUNT(*) AS n FROM compras')).n,
      caixa: (await get(ctx.db, 'SELECT COUNT(*) AS n FROM caixa_sessoes')).n,
      valor: tx.valor,
      desc: tx.descricao
    };
    const analise = await ctx.motor.analisarConciliacaoTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    const aceito = await ctx.motor.aceitarSugestaoConciliacao({ empresaId: ctx.empresaA.id, id: analise.sugestoes[0].id });
    assert.equal(aceito.sugestao.status, STATUS_SUGESTAO.ACEITA);
    assert.equal(aceito.conciliacao.status, STATUS_CONCILIACAO.CONCILIADA);
    assert.equal((await get(ctx.db, 'SELECT COUNT(*) AS n FROM financeiro')).n, before.fin);
    assert.equal((await get(ctx.db, 'SELECT COUNT(*) AS n FROM vendas')).n, before.vendas);
    assert.equal((await get(ctx.db, 'SELECT COUNT(*) AS n FROM compras')).n, before.compras);
    assert.equal((await get(ctx.db, 'SELECT COUNT(*) AS n FROM caixa_sessoes')).n, before.caixa);
    const tx2 = await ctx.motor.obterTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    assert.equal(tx2.valor, before.valor);
    assert.equal(tx2.descricao, before.desc);
    await closeDb(ctx.db);
  });

  it('T25 — recusa', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '25');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta.id);
    await criarFin(ctx, ctx.empresaA.id);
    const analise = await ctx.motor.analisarConciliacaoTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    const rec = await ctx.motor.recusarSugestaoConciliacao({ empresaId: ctx.empresaA.id, id: analise.sugestoes[0].id });
    assert.equal(rec.status, STATUS_SUGESTAO.RECUSADA);
    const st = await ctx.motor.obterStatusConciliacaoTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    assert.equal(st.status, STATUS_CONCILIACAO.PENDENTE);
    await closeDb(ctx.db);
  });
});

describe('MBC-08 multiempresa API e conflitos', () => {
  it('T31 T32 T33 — isolamento A/B', async () => {
    const ctx = await setup();
    const a = await criarConta(ctx, ctx.empresaA.id, 'A', '31');
    const b = await criarConta(ctx, ctx.empresaB.id, 'B', '32');
    const txA = await criarTx(ctx, ctx.empresaA.id, a.id);
    const txB = await criarTx(ctx, ctx.empresaB.id, b.id);
    await criarFin(ctx, ctx.empresaA.id);
    await criarFin(ctx, ctx.empresaB.id);
    await ctx.motor.analisarConciliacaoTransacao({ empresaId: ctx.empresaA.id, id: txA.id });
    const listaA = await ctx.motor.listarSugestoesConciliacao({ empresaId: ctx.empresaA.id });
    assert.equal(listaA.every((s) => s.empresa_id === ctx.empresaA.id), true);
    await assert.rejects(
      () => ctx.motor.obterSugestaoConciliacao({ empresaId: ctx.empresaB.id, id: listaA[0].id }),
      (err) => err.code === ERROS.SUGESTAO_NAO_ENCONTRADA
    );
    await ctx.motor.analisarConciliacaoTransacao({ empresaId: ctx.empresaB.id, id: txB.id });
    const listaB = await ctx.motor.listarSugestoesConciliacao({ empresaId: ctx.empresaB.id });
    assert.equal(listaB.every((s) => s.empresa_id === ctx.empresaB.id), true);
    await closeDb(ctx.db);
  });

  it('T34 — empresa_id body ignorado', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '34');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta.id);
    await criarFin(ctx, ctx.empresaA.id);
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json('POST', '/api/bancario/transacoes/' + tx.id + '/analisar-conciliacao', {
      empresa_id: ctx.empresaB.id
    });
    assert.equal(out.status, 200);
    assert.equal(out.data.empresa_id, ctx.empresaA.id);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T35 — empresa_id query ignorado', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '35');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta.id);
    await criarFin(ctx, ctx.empresaA.id);
    await ctx.motor.analisarConciliacaoTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json('GET', '/api/bancario/conciliacoes/sugestoes?empresa_id=' + ctx.empresaB.id);
    assert.equal(out.status, 200);
    assert.equal(out.data.empresa_id, ctx.empresaA.id);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T36 — conta inválida', async () => {
    const ctx = await setup();
    await assert.rejects(
      () => ctx.motor.analisarConciliacoesConta({ empresaId: ctx.empresaA.id, id: 99999 }),
      (err) => err.code === ERROS.CONTA_NAO_ENCONTRADA
    );
    await closeDb(ctx.db);
  });

  it('T37 — transação inexistente', async () => {
    const ctx = await setup();
    await assert.rejects(
      () => ctx.motor.analisarConciliacaoTransacao({ empresaId: ctx.empresaA.id, id: 99999 }),
      (err) => err.code === ERROS.TRANSACAO_NAO_ENCONTRADA
    );
    await closeDb(ctx.db);
  });

  it('T38 — sugestão inexistente', async () => {
    const ctx = await setup();
    await assert.rejects(
      () => ctx.motor.obterSugestaoConciliacao({ empresaId: ctx.empresaA.id, id: 99999 }),
      (err) => err.code === ERROS.SUGESTAO_NAO_ENCONTRADA
    );
    await closeDb(ctx.db);
  });

  it('T39 — sugestão já aceita', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '39');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta.id);
    await criarFin(ctx, ctx.empresaA.id);
    const a = await ctx.motor.analisarConciliacaoTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    await ctx.motor.aceitarSugestaoConciliacao({ empresaId: ctx.empresaA.id, id: a.sugestoes[0].id });
    await assert.rejects(
      () => ctx.motor.aceitarSugestaoConciliacao({ empresaId: ctx.empresaA.id, id: a.sugestoes[0].id }),
      (err) => err.code === ERROS.SUGESTAO_INVALIDA
    );
    await closeDb(ctx.db);
  });

  it('T40 — sugestão já recusada', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '40');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta.id);
    await criarFin(ctx, ctx.empresaA.id);
    const a = await ctx.motor.analisarConciliacaoTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    await ctx.motor.recusarSugestaoConciliacao({ empresaId: ctx.empresaA.id, id: a.sugestoes[0].id });
    await assert.rejects(
      () => ctx.motor.aceitarSugestaoConciliacao({ empresaId: ctx.empresaA.id, id: a.sugestoes[0].id }),
      (err) => err.code === ERROS.SUGESTAO_INVALIDA
    );
    await closeDb(ctx.db);
  });

  it('T41 — concorrência no aceite', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '41');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta.id);
    await criarFin(ctx, ctx.empresaA.id);
    const a = await ctx.motor.analisarConciliacaoTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    const results = await Promise.allSettled([
      ctx.motor.aceitarSugestaoConciliacao({ empresaId: ctx.empresaA.id, id: a.sugestoes[0].id }),
      ctx.motor.aceitarSugestaoConciliacao({ empresaId: ctx.empresaA.id, id: a.sugestoes[0].id })
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const fail = results.filter((r) => r.status === 'rejected');
    assert.equal(ok.length, 1);
    assert.equal(fail.length, 1);
    const concs = await ctx.motor.listarConciliacoes({ empresaId: ctx.empresaA.id, transacao_bancaria_id: tx.id });
    assert.equal(concs.filter((c) => c.ativo && c.status === 'conciliada').length, 1);
    await closeDb(ctx.db);
  });

  it('T42 — candidato alterado antes do aceite', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '42');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta.id);
    const fin = await criarFin(ctx, ctx.empresaA.id);
    const a = await ctx.motor.analisarConciliacaoTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    await run(ctx.db, `UPDATE financeiro SET valor = 80 WHERE id = ?`, [fin]);
    await assert.rejects(
      () => ctx.motor.aceitarSugestaoConciliacao({ empresaId: ctx.empresaA.id, id: a.sugestoes[0].id }),
      (err) => err.code === ERROS.MATCHING_CONFLITO
    );
    await closeDb(ctx.db);
  });

  it('T43 — transação conciliada antes do aceite', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '43');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta.id);
    const fin = await criarFin(ctx, ctx.empresaA.id);
    const a = await ctx.motor.analisarConciliacaoTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    await ctx.motor.conciliarTransacao({
      empresaId: ctx.empresaA.id,
      transacao_bancaria_id: tx.id,
      origem_financeira: 'FINANCEIRO',
      registro_financeiro_id: fin,
      valor_conciliado: 150
    });
    await assert.rejects(
      () => ctx.motor.aceitarSugestaoConciliacao({ empresaId: ctx.empresaA.id, id: a.sugestoes[0].id }),
      (err) => err.code === ERROS.JA_CONCILIADA
    );
    await closeDb(ctx.db);
  });

  it('T44 — permissão', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaB.id, 'B', '44');
    const api = await listenApp(ctx, { userId: 2, empresaId: ctx.empresaB.id });
    const out = await api.json('POST', '/api/bancario/contas/' + conta.id + '/analisar-conciliacoes');
    assert.equal(out.status, 403);
    await api.close();
    await closeDb(ctx.db);
  });

  it('T45 — contexto ausente', () => {
    const motor = obterMotorBancario({ db: null });
    assert.throws(
      () => motor.analisarConciliacaoTransacao({ id: 1 }),
      (err) => err.code === ERROS.EMPRESA_OBRIGATORIA
    );
  });

  it('T46 — filtros', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '46');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta.id);
    await criarFin(ctx, ctx.empresaA.id);
    await ctx.motor.analisarConciliacaoTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    const alta = await ctx.motor.listarSugestoesConciliacao({
      empresaId: ctx.empresaA.id, nivel_confianca: 'MEDIA', status: 'PENDENTE'
    });
    assert.ok(alta.length >= 1);
    await closeDb(ctx.db);
  });

  it('T47 — paginação', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '47');
    const tx1 = await criarTx(ctx, ctx.empresaA.id, conta.id, { external_id: 'P1' });
    const tx2 = await criarTx(ctx, ctx.empresaA.id, conta.id, { external_id: 'P2', data: '2026-09-03' });
    await criarFin(ctx, ctx.empresaA.id);
    await criarFin(ctx, ctx.empresaA.id, { data: '2026-09-03' });
    await ctx.motor.analisarConciliacoesConta({ empresaId: ctx.empresaA.id, id: conta.id });
    const p = await ctx.motor.listarSugestoesConciliacao({ empresaId: ctx.empresaA.id, conta_bancaria_id: conta.id, limite: 1 });
    assert.equal(p.length, 1);
    await closeDb(ctx.db);
  });

  it('T48 — análise de conta', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '48');
    await criarTx(ctx, ctx.empresaA.id, conta.id);
    await criarFin(ctx, ctx.empresaA.id);
    const out = await ctx.motor.analisarConciliacoesConta({ empresaId: ctx.empresaA.id, id: conta.id });
    assert.equal(out.transacoes_analisadas, 1);
    assert.ok(out.sugestoes_criadas >= 1);
    await closeDb(ctx.db);
  });

  it('T49 — análise individual', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '49');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta.id);
    await criarCr(ctx, ctx.empresaA.id);
    const out = await ctx.motor.analisarConciliacaoTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    assert.equal(out.transacao_bancaria_id, tx.id);
    assert.ok(out.sugestoes.length >= 1);
    await closeDb(ctx.db);
  });

  it('T50 — troca de empresa na UI', () => {
    const js = src('frontend/erp/js/contas-bancarias.js');
    assert.match(js, /cds-empresa-contexto-alterado/);
    assert.match(js, /sugestoesCache = \[\]/);
    assert.match(js, /mbcSugBody/);
    assert.match(src('frontend/erp/pages/contas-bancarias.html'), /Conciliações sugeridas/);
    assert.doesNotMatch(js, /access_token|client_secret/);
  });
});

describe('MBC-08 extras', () => {
  it('T51 — data com 2 dias pontua menos', () => {
    const s = calcularScore(txBase, cand({ data: '2026-09-06', identificador: null }));
    assert.equal(s.motivos.includes('DATA_2_DIAS'), true);
  });
  it('T52 — recusa não altera transação', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '52');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta.id);
    await criarFin(ctx, ctx.empresaA.id);
    const a = await ctx.motor.analisarConciliacaoTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    await ctx.motor.recusarSugestaoConciliacao({ empresaId: ctx.empresaA.id, id: a.sugestoes[0].id });
    const depois = await ctx.motor.obterTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    assert.equal(depois.valor, tx.valor);
    await closeDb(ctx.db);
  });
  it('T53 — GET sugestão HTTP', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '53');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta.id);
    await criarFin(ctx, ctx.empresaA.id);
    const a = await ctx.motor.analisarConciliacaoTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json('GET', '/api/bancario/conciliacoes/sugestoes/' + a.sugestoes[0].id);
    assert.equal(out.status, 200);
    assert.equal(out.data.id, a.sugestoes[0].id);
    await api.close();
    await closeDb(ctx.db);
  });
  it('T54 — análise de conta HTTP', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '54');
    await criarTx(ctx, ctx.empresaA.id, conta.id);
    await criarFin(ctx, ctx.empresaA.id);
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json('POST', '/api/bancario/contas/' + conta.id + '/analisar-conciliacoes');
    assert.equal(out.status, 200);
    assert.ok(out.data.transacoes_analisadas >= 1);
    await api.close();
    await closeDb(ctx.db);
  });
  it('T55 — schema de sugestão sem credenciais', () => {
    assert.match(src('backend/motores/bancario/schema/bancarioSchema.js'), /sugestao_conciliacao_bancaria/);
    assert.doesNotMatch(src('backend/motores/bancario/schema/bancarioSchema.js'), /access_token|client_secret/);
  });
  it('T56 — UI botões aceitar e recusar', () => {
    const js = src('frontend/erp/js/contas-bancarias.js');
    assert.match(js, /data-mbc-sug-aceitar/);
    assert.match(js, /data-mbc-sug-recusar/);
    assert.match(js, /Escolher correspondência/);
  });
  it('T57 — transferência não gera candidato', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '57');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta.id, { direcao: 'transferencia', descricao: 'TED INTERNA' });
    await criarFin(ctx, ctx.empresaA.id, { tipo: 'receita' });
    const out = await ctx.motor.analisarConciliacaoTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    assert.equal(out.resultado, RESULTADO_MATCHING.NENHUM);
    await closeDb(ctx.db);
  });
  it('T58 — pesos não estão na UI', () => {
    assert.doesNotMatch(src('frontend/erp/js/contas-bancarias.js'), /PESOS_MATCHING|VALOR_EXATO: 40/);
  });
  it('T59 — recusar HTTP', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '59');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta.id);
    await criarFin(ctx, ctx.empresaA.id);
    const a = await ctx.motor.analisarConciliacaoTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json('POST', '/api/bancario/conciliacoes/sugestoes/' + a.sugestoes[0].id + '/recusar');
    assert.equal(out.status, 200);
    assert.equal(out.data.status, STATUS_SUGESTAO.RECUSADA);
    await api.close();
    await closeDb(ctx.db);
  });
  it('T60 — aceitar HTTP cria conciliação oficial', async () => {
    const ctx = await setup();
    const conta = await criarConta(ctx, ctx.empresaA.id, 'A', '60');
    const tx = await criarTx(ctx, ctx.empresaA.id, conta.id);
    await criarFin(ctx, ctx.empresaA.id);
    const a = await ctx.motor.analisarConciliacaoTransacao({ empresaId: ctx.empresaA.id, id: tx.id });
    const api = await listenApp(ctx, { userId: 1, empresaId: ctx.empresaA.id });
    const out = await api.json('POST', '/api/bancario/conciliacoes/sugestoes/' + a.sugestoes[0].id + '/aceitar');
    assert.equal(out.status, 200);
    assert.equal(out.data.conciliacao.status, 'conciliada');
    await api.close();
    await closeDb(ctx.db);
  });
});

describe('MBC-08 invariantes', () => {
  it('matching não escreve financeiro e não concilia sozinho', () => {
    const motor = src('backend/motores/bancario/matching/MotorMatchingBancarioService.js');
    assert.doesNotMatch(motor, /INSERT INTO conciliacao_bancaria/i);
    assert.doesNotMatch(motor, /INSERT INTO financeiro|UPDATE financeiro|INSERT INTO vendas|INSERT INTO compras/i);
    assert.match(motor, /ConciliacaoBancariaService\.conciliar/);
    assert.doesNotMatch(src('backend/motores/bancario/services/SincronizacaoBancariaService.js'), /sugestao_conciliacao/);
  });
});
