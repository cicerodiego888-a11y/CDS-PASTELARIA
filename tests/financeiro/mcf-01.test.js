/**
 * Sprint MCF-01 — Fundação Contas a Pagar.
 * Executar: node --test tests/financeiro/mcf-01.test.js
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
const { garantirSchemaMcfAsync } = require('../../backend/motores/mcf/schema/mcfSchema');
const ContasPagarService = require('../../backend/motores/mcf/services/ContasPagarService');
const {
  STATUS_CONTA_PAGAR,
  ERROS_MCF,
  VERSAO_MCF
} = require('../../backend/motores/mcf/contracts/constantesMcf');
const { garantirSchemaBancarioAsync } = require('../../backend/motores/bancario/schema/bancarioSchema');
const { obterMotorBancario } = require('../../backend/motores/bancario/MotorBancarioService');

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
  await run(db, `CREATE TABLE fornecedores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    cpf_cnpj TEXT
  )`);
  await run(db, `CREATE TABLE financeiro (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT, descricao TEXT, valor REAL, data_movimento TEXT,
    status TEXT, empresa_id INTEGER
  )`);
  await run(db, `CREATE TABLE contas_receber (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER, valor_parcela REAL, valor_restante REAL,
    data_vencimento TEXT, status TEXT DEFAULT 'aberto'
  )`);
  await garantirSchemaMcfAsync(db);
  await garantirSchemaBancarioAsync(db);
  const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaA.id, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaB.id, { db });
  return { db, empresaA, empresaB };
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        base: 'http://127.0.0.1:' + port,
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
}

function request(base, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, base);
    const data = body != null ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: Object.assign({
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }, headers)
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (_) { json = { raw }; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('MCF-01 — Fundação Contas a Pagar', () => {
  it('T01 — versão e schema', async () => {
    const ctx = await setup();
    assert.equal(VERSAO_MCF.SPRINT, 'MCF-01');
    const tabs = await new Promise((resolve, reject) => {
      ctx.db.all(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('contas_pagar','contas_pagar_pagamentos')`,
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      );
    });
    assert.equal(tabs.length, 2);
    await closeDb(ctx.db);
  });

  it('T02 — criar AP: restante = original; status aberto', async () => {
    const ctx = await setup();
    const ap = await ContasPagarService.criar({
      db: ctx.db,
      empresaId: ctx.empresaA.id,
      descricao: 'Energia',
      valor_original: 1000,
      data_vencimento: '2026-09-20'
    });
    assert.equal(ap.valor_original, 1000);
    assert.equal(ap.valor_restante, 1000);
    assert.equal(ap.status, STATUS_CONTA_PAGAR.ABERTA);
    assert.equal(ap.empresa_id, ctx.empresaA.id);
    await closeDb(ctx.db);
  });

  it('T03 — rejeita valor_original <= 0 e data inválida', async () => {
    const ctx = await setup();
    await assert.rejects(
      () => ContasPagarService.criar({
        db: ctx.db, empresaId: ctx.empresaA.id, valor_original: 0, data_vencimento: '2026-09-20'
      }),
      (e) => e.code === ERROS_MCF.VALOR_INVALIDO
    );
    await assert.rejects(
      () => ContasPagarService.criar({
        db: ctx.db, empresaId: ctx.empresaA.id, valor_original: 10, data_vencimento: '20/09/2026'
      }),
      (e) => e.code === ERROS_MCF.DATA_INVALIDA
    );
    await closeDb(ctx.db);
  });

  it('T04 — frontend não define valor_restante arbitrário', async () => {
    const ctx = await setup();
    const ap = await ContasPagarService.criar({
      db: ctx.db,
      empresaId: ctx.empresaA.id,
      valor_original: 500,
      valor_restante: 1,
      data_vencimento: '2026-09-15'
    });
    assert.equal(ap.valor_restante, 500);
    await closeDb(ctx.db);
  });

  it('T05 — multiempresa: A não acessa B', async () => {
    const ctx = await setup();
    const apB = await ContasPagarService.criar({
      db: ctx.db,
      empresaId: ctx.empresaB.id,
      valor_original: 80,
      data_vencimento: '2026-09-10'
    });
    await assert.rejects(
      () => ContasPagarService.obter({ db: ctx.db, empresaId: ctx.empresaA.id, id: apB.id }),
      (e) => e.code === ERROS_MCF.CONTA_NAO_ENCONTRADA
    );
    const listaA = await ContasPagarService.listar({ db: ctx.db, empresaId: ctx.empresaA.id });
    assert.equal(listaA.some((c) => c.id === apB.id), false);
    await closeDb(ctx.db);
  });

  it('T06 — fornecedor existente reutilizado; inexistente rejeitado', async () => {
    const ctx = await setup();
    const forn = await run(ctx.db, `INSERT INTO fornecedores (nome, cpf_cnpj) VALUES ('Forn X', '123')`);
    const ap = await ContasPagarService.criar({
      db: ctx.db,
      empresaId: ctx.empresaA.id,
      fornecedor_id: forn.lastID,
      valor_original: 40,
      data_vencimento: '2026-09-12'
    });
    assert.equal(ap.fornecedor_id, forn.lastID);
    await assert.rejects(
      () => ContasPagarService.criar({
        db: ctx.db,
        empresaId: ctx.empresaA.id,
        fornecedor_id: 99999,
        valor_original: 10,
        data_vencimento: '2026-09-12'
      }),
      (e) => e.code === ERROS_MCF.FORNECEDOR_NAO_ENCONTRADO
    );
    await closeDb(ctx.db);
  });

  it('T07 — baixa parcial + quitação + rejeita excesso', async () => {
    const ctx = await setup();
    const ap = await ContasPagarService.criar({
      db: ctx.db,
      empresaId: ctx.empresaA.id,
      valor_original: 1000,
      data_vencimento: '2026-09-30'
    });
    let t = await ContasPagarService.baixar({
      db: ctx.db,
      empresaId: ctx.empresaA.id,
      id: ap.id,
      valor_pago: 300
    });
    assert.equal(t.valor_original, 1000);
    assert.equal(t.valor_restante, 700);
    assert.equal(t.status, STATUS_CONTA_PAGAR.PARCIAL);
    t = await ContasPagarService.baixar({
      db: ctx.db,
      empresaId: ctx.empresaA.id,
      id: ap.id,
      valor_pago: 700
    });
    assert.equal(t.valor_restante, 0);
    assert.equal(t.status, STATUS_CONTA_PAGAR.QUITADA);
    await assert.rejects(
      () => ContasPagarService.baixar({
        db: ctx.db, empresaId: ctx.empresaA.id, id: ap.id, valor_pago: 100
      }),
      (e) => e.code === ERROS_MCF.TITULO_QUITADO || e.code === ERROS_MCF.BAIXA_EXCEDE_RESTANTE
    );
    const pags = await ContasPagarService.listarPagamentos({
      db: ctx.db, empresaId: ctx.empresaA.id, id: ap.id
    });
    assert.equal(pags.pagamentos.length, 2);
    await closeDb(ctx.db);
  });

  it('T08 — baixa > restante rejeitada; criação não altera financeiro', async () => {
    const ctx = await setup();
    const finAntes = Number((await getRow(ctx.db, 'SELECT COUNT(*) AS n FROM financeiro')).n);
    const ap = await ContasPagarService.criar({
      db: ctx.db,
      empresaId: ctx.empresaA.id,
      valor_original: 100,
      data_vencimento: '2026-09-18'
    });
    await assert.rejects(
      () => ContasPagarService.baixar({
        db: ctx.db, empresaId: ctx.empresaA.id, id: ap.id, valor_pago: 150
      }),
      (e) => e.code === ERROS_MCF.BAIXA_EXCEDE_RESTANTE
    );
    const finDepois = Number((await getRow(ctx.db, 'SELECT COUNT(*) AS n FROM financeiro')).n);
    assert.equal(finDepois, finAntes);
    await closeDb(ctx.db);
  });

  it('T09 — CR existente intacto; múltiplos títulos', async () => {
    const ctx = await setup();
    await run(ctx.db, `INSERT INTO contas_receber (
      empresa_id, valor_parcela, valor_restante, data_vencimento, status
    ) VALUES (?, 200, 200, '2026-09-07', 'aberto')`, [ctx.empresaA.id]);
    await ContasPagarService.criar({
      db: ctx.db, empresaId: ctx.empresaA.id, valor_original: 10, data_vencimento: '2026-09-08'
    });
    await ContasPagarService.criar({
      db: ctx.db, empresaId: ctx.empresaA.id, valor_original: 20, data_vencimento: '2026-09-09'
    });
    const cr = await getRow(ctx.db, 'SELECT * FROM contas_receber WHERE empresa_id = ?', [ctx.empresaA.id]);
    assert.equal(Number(cr.valor_restante), 200);
    const lista = await ContasPagarService.listar({ db: ctx.db, empresaId: ctx.empresaA.id });
    assert.equal(lista.length, 2);
    await closeDb(ctx.db);
  });

  it('T10 — API HTTP mínima + MBC regressão pontual', async () => {
    const ctx = await setup();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.empresaId = Number(req.headers['x-empresa-id']);
      next();
    });
    const ContasPagarRouter = express.Router();
    ContasPagarRouter.get('/', async (req, res) => {
      const contas = await ContasPagarService.listar({ db: ctx.db, empresaId: req.empresaId });
      res.json({ success: true, contas });
    });
    ContasPagarRouter.post('/', async (req, res) => {
      try {
        const conta = await ContasPagarService.criar({
          db: ctx.db,
          empresaId: req.empresaId,
          ...req.body
        });
        res.status(201).json({ success: true, conta });
      } catch (err) {
        res.status(err.statusCode || 400).json({ success: false, code: err.code, error: err.message });
      }
    });
    ContasPagarRouter.get('/:id', async (req, res) => {
      try {
        const conta = await ContasPagarService.obter({
          db: ctx.db, empresaId: req.empresaId, id: req.params.id
        });
        res.json({ success: true, conta });
      } catch (err) {
        res.status(err.statusCode || 404).json({ success: false, code: err.code });
      }
    });
    app.use('/api/contas-pagar', ContasPagarRouter);
    const srv = await listen(app);
    const post = await request(srv.base, 'POST', '/api/contas-pagar', {
      valor_original: 55,
      data_vencimento: '2026-09-21',
      descricao: 'API'
    }, { 'x-empresa-id': String(ctx.empresaA.id) });
    assert.equal(post.status, 201);
    assert.equal(post.body.conta.valor_restante, 55);
    const getOne = await request(
      srv.base, 'GET', '/api/contas-pagar/' + post.body.conta.id, null,
      { 'x-empresa-id': String(ctx.empresaA.id) }
    );
    assert.equal(getOne.status, 200);
    const list = await request(
      srv.base, 'GET', '/api/contas-pagar', null,
      { 'x-empresa-id': String(ctx.empresaA.id) }
    );
    assert.equal(list.body.contas.length, 1);
    const cross = await request(
      srv.base, 'GET', '/api/contas-pagar/' + post.body.conta.id, null,
      { 'x-empresa-id': String(ctx.empresaB.id) }
    );
    assert.equal(cross.status, 404);

    const motor = obterMotorBancario({ db: ctx.db });
    const inst = await motor.criarInstituicao({ nome: 'Inst MCF' });
    const conta = await motor.criarConta({
      empresaId: ctx.empresaA.id,
      instituicao_financeira_id: inst.id,
      nome: 'C',
      tipo: 'CORRENTE',
      numero: 'mcf1'
    });
    const tx = await motor.registrarTransacaoBancaria({
      empresaId: ctx.empresaA.id,
      conta_bancaria_id: conta.id,
      data_transacao: '2026-09-07T10:00:00',
      valor: 10,
      direcao: 'SAIDA',
      descricao: 'mbc',
      tipo: 'PIX'
    });
    assert.ok(tx.transacao.id);
    assert.ok(fs.existsSync(path.join(ROOT, 'docs/financeiro/MCF-01-RELATORIO.md')));
    await srv.close();
    await closeDb(ctx.db);
  });
});
