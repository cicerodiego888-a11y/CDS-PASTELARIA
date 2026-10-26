/**
 * MCF-02.1 — Fechamento operacional Contas a Pagar.
 * Banco SQLite isolado (:memory:).
 * Executar: node --test tests/financeiro/mcf-02.1-fechamento-operacional.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
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
const CompraContasPagarMcfService = require('../../backend/services/compras/CompraContasPagarMcfService');
const {
  STATUS_CONTA_PAGAR,
  ERROS_MCF,
  VERSAO_MCF
} = require('../../backend/motores/mcf/contracts/constantesMcf');
const {
  ehProjecaoMcfRow,
  sqlExcluirProjecaoMcf,
  buscarVinculoPorFinanceiroId,
  buscarVinculoPorContaPagarId
} = require('../../backend/motores/mcf/services/ContasPagarFinanceiroCompatGuard');

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
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}
function allRows(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
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
    categoria TEXT, forma_pagamento TEXT, referencia_id INTEGER,
    referencia_tipo TEXT, status TEXT, origem TEXT, documento TEXT,
    vencimento TEXT, numero_parcela INTEGER, total_parcelas INTEGER,
    compra_id INTEGER, venda_id INTEGER, pessoa_nome TEXT, observacao TEXT,
    baixado_em TEXT, empresa_id INTEGER
  )`);
  await run(db, `CREATE TABLE compras (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL,
    status TEXT DEFAULT 'finalizada'
  )`);
  await garantirSchemaMcfAsync(db);
  const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaA.id, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaB.id, { db });
  return { db, empresaA, empresaB };
}

function dentroDeTransacao(db, fn) {
  return new Promise((resolve, reject) => {
    db.run('BEGIN IMMEDIATE', async (beginErr) => {
      if (beginErr) return reject(beginErr);
      try {
        const result = await fn();
        db.run('COMMIT', (commitErr) => (commitErr ? reject(commitErr) : resolve(result)));
      } catch (err) {
        db.run('ROLLBACK', () => reject(err));
      }
    });
  });
}

function stubConfigMultiempresa() {
  const caminhoConfig = path.resolve(ROOT, 'backend/services/configuracaoService.js');
  const original = require.cache[caminhoConfig];
  const real = require(caminhoConfig);
  require.cache[caminhoConfig] = {
    id: caminhoConfig,
    filename: caminhoConfig,
    loaded: true,
    exports: {
      ...real,
      obterModoOperacionalGlobal: () => 'MULTIEMPRESA',
      readConfig: () => ({ ...(typeof real.readConfig === 'function' ? real.readConfig() : {}), modo_operacional_global: 'MULTIEMPRESA' })
    }
  };
  return () => {
    if (original) require.cache[caminhoConfig] = original;
    else delete require.cache[caminhoConfig];
  };
}

function carregarRouterFinanceiro(db) {
  const caminhoDatabase = path.resolve(ROOT, 'backend/database.js');
  const caminhoAuditoria = path.resolve(ROOT, 'backend/services/auditoria.js');
  const caminhoCaixa = path.resolve(ROOT, 'backend/middleware/validarCaixaAberto.js');
  const caminhoRota = path.resolve(ROOT, 'backend/rotas/financeiro.js');
  const restoreConfig = stubConfigMultiempresa();
  const carregarOriginal = Module._load;
  delete require.cache[caminhoRota];
  delete require.cache[path.resolve(ROOT, 'backend/services/financeiro/FinanceiroEmpresaContextoService.js')];
  delete require.cache[path.resolve(ROOT, 'backend/core/modo-operacional/modoOperacionalGlobal.js')];
  delete require.cache[path.resolve(ROOT, 'backend/core/modo-operacional/ContratoOperacionalService.js')];
  let router;
  try {
    Module._load = function(request, parent, isMain) {
      let caminhoResolvido;
      try {
        caminhoResolvido = Module._resolveFilename(request, parent, isMain);
      } catch (_) {
        caminhoResolvido = null;
      }
      if (caminhoResolvido === caminhoDatabase) return db;
      if (caminhoResolvido === caminhoAuditoria) {
        return { gravarAuditoria: async () => {} };
      }
      if (caminhoResolvido === caminhoCaixa) {
        return { validarCaixaAberto: (req, res, next) => next() };
      }
      return carregarOriginal.apply(this, arguments);
    };
    router = require(caminhoRota);
  } finally {
    Module._load = carregarOriginal;
  }
  return { router, restore: restoreConfig };
}

function carregarRouterContasPagar(db) {
  const caminhoDatabase = path.resolve(ROOT, 'backend/database.js');
  const caminhoAuditoria = path.resolve(ROOT, 'backend/services/auditoria.js');
  const caminhoRota = path.resolve(ROOT, 'backend/rotas/contas_pagar.js');
  const restoreConfig = stubConfigMultiempresa();
  const carregarOriginal = Module._load;
  delete require.cache[caminhoRota];
  delete require.cache[path.resolve(ROOT, 'backend/services/financeiro/FinanceiroEmpresaContextoService.js')];
  delete require.cache[path.resolve(ROOT, 'backend/core/modo-operacional/modoOperacionalGlobal.js')];
  delete require.cache[path.resolve(ROOT, 'backend/core/modo-operacional/ContratoOperacionalService.js')];
  let router;
  try {
    Module._load = function(request, parent, isMain) {
      let caminhoResolvido;
      try {
        caminhoResolvido = Module._resolveFilename(request, parent, isMain);
      } catch (_) {
        caminhoResolvido = null;
      }
      if (caminhoResolvido === caminhoDatabase) return db;
      if (caminhoResolvido === caminhoAuditoria) {
        return { gravarAuditoria: async () => {} };
      }
      return carregarOriginal.apply(this, arguments);
    };
    router = require(caminhoRota);
  } finally {
    Module._load = carregarOriginal;
  }
  return { router, restore: restoreConfig };
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

describe('MCF-02.1 — Fechamento operacional Contas a Pagar', () => {
  it('versão sprint MCF e guard de projeção', () => {
    assert.equal(VERSAO_MCF.MOTOR, 'MCF');
    assert.match(String(VERSAO_MCF.SPRINT), /^MCF-02/);
    assert.equal(ERROS_MCF.PROJECAO_IMUTAVEL, 'MCF_PROJECAO_IMUTAVEL');
    assert.equal(ehProjecaoMcfRow({ origem: 'mcf_compatibilidade' }), true);
    assert.equal(ehProjecaoMcfRow({ origem: 'manual', referencia_tipo: 'manual' }), false);
    assert.match(sqlExcluirProjecaoMcf('f'), /mcf_compatibilidade/);
  });

  it('título MCF tem no máximo uma projeção; UNIQUE impede duplicidade', async () => {
    const ctx = await setup();
    const ap = await ContasPagarService.criar({
      db: ctx.db,
      empresaId: ctx.empresaA.id,
      descricao: 'Aluguel',
      valor_original: 500,
      data_vencimento: '2026-11-01'
    });
    const vinculos = await allRows(
      ctx.db,
      'SELECT * FROM contas_pagar_financeiro_compat WHERE conta_pagar_id = ?',
      [ap.id]
    );
    assert.equal(vinculos.length, 1);
    await assert.rejects(
      () => run(
        ctx.db,
        `INSERT INTO contas_pagar_financeiro_compat (empresa_id, conta_pagar_id, financeiro_id)
         VALUES (?, ?, ?)`,
        [ctx.empresaA.id, ap.id, 99999]
      ),
      (e) => /UNIQUE|unique/i.test(String(e.message))
    );
    const fin = await getRow(ctx.db, 'SELECT * FROM financeiro WHERE id = ?', [vinculos[0].financeiro_id]);
    assert.equal(fin.origem, 'mcf_compatibilidade');
    assert.equal(ehProjecaoMcfRow(fin), true);
    await closeDb(ctx.db);
  });

  it('pagamento parcial/total e cancelamento sincronizam projeção; excesso rejeitado', async () => {
    const ctx = await setup();
    const ap = await ContasPagarService.criar({
      db: ctx.db,
      empresaId: ctx.empresaA.id,
      valor_original: 200,
      data_vencimento: '2026-11-05',
      descricao: 'Insumos'
    });
    const vinculo = await buscarVinculoPorContaPagarId(ctx.db, ctx.empresaA.id, ap.id);
    assert.ok(vinculo);

    await ContasPagarService.baixar({
      db: ctx.db,
      empresaId: ctx.empresaA.id,
      id: ap.id,
      valor_pago: 50,
      idempotency_key: 'mcf21-parcial'
    });
    let proj = await getRow(ctx.db, 'SELECT status FROM financeiro WHERE id = ?', [vinculo.financeiro_id]);
    assert.equal(proj.status, 'parcial');

    await ContasPagarService.baixar({
      db: ctx.db,
      empresaId: ctx.empresaA.id,
      id: ap.id,
      valor_pago: 150,
      idempotency_key: 'mcf21-total'
    });
    proj = await getRow(ctx.db, 'SELECT status FROM financeiro WHERE id = ?', [vinculo.financeiro_id]);
    assert.equal(proj.status, 'pago');

    await assert.rejects(
      () => ContasPagarService.baixar({
        db: ctx.db,
        empresaId: ctx.empresaA.id,
        id: ap.id,
        valor_pago: 1,
        idempotency_key: 'mcf21-excesso'
      }),
      (e) => e.code === ERROS_MCF.TITULO_QUITADO || e.code === ERROS_MCF.BAIXA_EXCEDE_RESTANTE
    );

    const ap2 = await ContasPagarService.criar({
      db: ctx.db,
      empresaId: ctx.empresaA.id,
      valor_original: 80,
      data_vencimento: '2026-11-06',
      descricao: 'Parcial cancel'
    });
    await ContasPagarService.baixar({
      db: ctx.db,
      empresaId: ctx.empresaA.id,
      id: ap2.id,
      valor_pago: 30,
      idempotency_key: 'mcf21-parcial-cancel'
    });
    await ContasPagarService.cancelar({
      db: ctx.db,
      empresaId: ctx.empresaA.id,
      id: ap2.id,
      motivo: 'teste',
      usuario_id: 1,
      idempotency_key: 'mcf21-cancel'
    });
    const v2 = await buscarVinculoPorContaPagarId(ctx.db, ctx.empresaA.id, ap2.id);
    const proj2 = await getRow(ctx.db, 'SELECT status FROM financeiro WHERE id = ?', [v2.financeiro_id]);
    assert.equal(proj2.status, 'cancelado');
    const titulo = await ContasPagarService.obter({ db: ctx.db, empresaId: ctx.empresaA.id, id: ap2.id });
    assert.equal(titulo.status, STATUS_CONTA_PAGAR.CANCELADA);
    await closeDb(ctx.db);
  });

  it('compra 1 e N parcelas + idempotência; rollback não deixa título órfão', async () => {
    const ctx = await setup();
    const compra = await run(ctx.db, 'INSERT INTO compras (empresa_id) VALUES (?)', [ctx.empresaA.id]);
    const parcelas = [
      { numero_parcela: 1, valor: 100, data_vencimento: '2026-11-10', documento: 'NF-21', pagar_agora: false },
      { numero_parcela: 2, valor: 150, data_vencimento: '2026-12-10', documento: 'NF-21', pagar_agora: false }
    ];
    const params = {
      db: ctx.db,
      compra_id: compra.lastID,
      empresa_id: ctx.empresaA.id,
      data_emissao: '2026-10-25',
      documento: 'NF-21',
      forma_pagamento: 'boleto',
      usuario_id: 1,
      parcelas
    };
    const r1 = await dentroDeTransacao(ctx.db, () => CompraContasPagarMcfService.criarTitulosMcfCompra(params));
    assert.equal(r1.length, 2);
    const r2 = await dentroDeTransacao(ctx.db, () => CompraContasPagarMcfService.criarTitulosMcfCompra(params));
    assert.equal(r2.length, 2);
    const titulos = await allRows(
      ctx.db,
      `SELECT id FROM contas_pagar WHERE empresa_id = ? AND referencia_tipo = 'compra' AND referencia_id = ?`,
      [ctx.empresaA.id, compra.lastID]
    );
    assert.equal(titulos.length, 2);
    for (const t of titulos) {
      const v = await buscarVinculoPorContaPagarId(ctx.db, ctx.empresaA.id, t.id);
      assert.ok(v, 'cada título deve ter projeção');
    }

    const compraFail = await run(ctx.db, 'INSERT INTO compras (empresa_id) VALUES (?)', [ctx.empresaA.id]);
    let falhou = false;
    try {
      await dentroDeTransacao(ctx.db, async () => {
        await CompraContasPagarMcfService.criarTitulosMcfCompra({
          ...params,
          compra_id: compraFail.lastID,
          documento: 'NF-FAIL',
          parcelas: [{ numero_parcela: 1, valor: 10, data_vencimento: '2026-11-01', documento: 'NF-FAIL' }]
        });
        throw new Error('forcar-rollback');
      });
    } catch (e) {
      falhou = e.message === 'forcar-rollback';
    }
    assert.equal(falhou, true);
    const orfaos = await allRows(
      ctx.db,
      `SELECT id FROM contas_pagar WHERE referencia_id = ? AND referencia_tipo = 'compra'`,
      [compraFail.lastID]
    );
    assert.equal(orfaos.length, 0);
    await closeDb(ctx.db);
  });

  it('listagens/relatórios legado não somam título + projeção', async () => {
    const ctx = await setup();
    await ContasPagarService.criar({
      db: ctx.db,
      empresaId: ctx.empresaA.id,
      valor_original: 1000,
      data_vencimento: '2026-11-20',
      descricao: 'MCF only'
    });
    // despesa histórica (não projeção) permanece no legado
    await run(
      ctx.db,
      `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, referencia_tipo, vencimento, empresa_id)
       VALUES ('despesa', 'Histórica', 200, '2026-10-01', 'pendente', 'manual', 'manual', '2026-10-15', ?)`,
      [ctx.empresaA.id]
    );
    const somaLegado = await getRow(
      ctx.db,
      `SELECT COALESCE(SUM(valor),0) AS total FROM financeiro
       WHERE empresa_id = ? AND tipo = 'despesa' AND status NOT IN ('pago','recebido','cancelado')
       ${sqlExcluirProjecaoMcf('')}`,
      [ctx.empresaA.id]
    );
    assert.equal(Number(somaLegado.total), 200);
    const somaMcf = await getRow(
      ctx.db,
      `SELECT COALESCE(SUM(valor_restante),0) AS total FROM contas_pagar
       WHERE empresa_id = ? AND status IN ('aberto','parcial')`,
      [ctx.empresaA.id]
    );
    assert.equal(Number(somaMcf.total), 1000);
    // sem exclusão haveria 1200 no legado
    const semExclusao = await getRow(
      ctx.db,
      `SELECT COALESCE(SUM(valor),0) AS total FROM financeiro
       WHERE empresa_id = ? AND tipo = 'despesa' AND status NOT IN ('pago','recebido','cancelado')`,
      [ctx.empresaA.id]
    );
    assert.equal(Number(semExclusao.total), 1200);
    await closeDb(ctx.db);
  });

  it('POST /api/financeiro despesa cria via MCF; receita permanece legado; mutação de projeção bloqueada', async () => {
    const ctx = await setup();
    const { router: routerFin, restore } = carregarRouterFinanceiro(ctx.db);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: 1, role: 'admin', nome: 'Admin' };
      next();
    });
    app.use('/api/financeiro', routerFin);
    const srv = await listen(app);
    const hdr = { 'x-empresa-id': String(ctx.empresaA.id) };

    try {
      const despesa = await request(srv.base, 'POST', '/api/financeiro', {
        tipo: 'despesa',
        descricao: 'Água',
        valor: 75.5,
        data_movimento: '2026-10-25',
        vencimento: '2026-11-10',
        categoria: 'utilidades'
      }, hdr);
      assert.equal(despesa.status, 200, JSON.stringify(despesa.body));
      assert.equal(despesa.body.code, 'MCF_DESPESA_CRIADA');
      assert.ok(despesa.body.conta_pagar_id);
      const conta = await ContasPagarService.obter({
        db: ctx.db, empresaId: ctx.empresaA.id, id: despesa.body.conta_pagar_id
      });
      assert.equal(conta.valor_original, 75.5);

      const receita = await request(srv.base, 'POST', '/api/financeiro', {
        tipo: 'receita',
        descricao: 'Receita avulsa',
        valor: 30,
        data_movimento: '2026-10-25',
        status: 'recebido'
      }, hdr);
      assert.equal(receita.status, 200, JSON.stringify(receita.body));
      assert.ok(receita.body.id);
      const finReceita = await getRow(ctx.db, 'SELECT * FROM financeiro WHERE id = ?', [receita.body.id]);
      assert.equal(finReceita.tipo, 'receita');
      assert.notEqual(finReceita.origem, 'mcf_compatibilidade');

      const finId = despesa.body.financeiro_id;
      assert.ok(finId);
      const put = await request(srv.base, 'PUT', `/api/financeiro/${finId}`, { descricao: 'hack' }, hdr);
      assert.equal(put.status, 409);
      assert.equal(put.body.code, ERROS_MCF.PROJECAO_IMUTAVEL);

      const baixar = await request(srv.base, 'POST', `/api/financeiro/pagar/${finId}/baixar`, { valor: 10 }, hdr);
      assert.equal(baixar.status, 409);
      assert.equal(baixar.body.code, ERROS_MCF.PROJECAO_IMUTAVEL);

      const del = await request(srv.base, 'DELETE', `/api/financeiro/${finId}`, null, hdr);
      assert.equal(del.status, 409);
      assert.equal(del.body.code, ERROS_MCF.PROJECAO_IMUTAVEL);

      const lista = await request(srv.base, 'GET', '/api/financeiro?tipo=despesa', null, hdr);
      assert.equal(lista.status, 200);
      assert.equal((lista.body || []).some((r) => r.id === finId), false);
    } finally {
      await srv.close();
      restore();
      delete require.cache[path.resolve(ROOT, 'backend/rotas/financeiro.js')];
      await closeDb(ctx.db);
    }
  });

  it('API contas-pagar: multiempresa e autorização cruzada', async () => {
    const ctx = await setup();
    const apB = await ContasPagarService.criar({
      db: ctx.db,
      empresaId: ctx.empresaB.id,
      valor_original: 99,
      data_vencimento: '2026-11-01',
      descricao: 'Só B'
    });
    const { router: routerCp, restore } = carregarRouterContasPagar(ctx.db);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: 1, role: 'admin', nome: 'Admin' };
      next();
    });
    app.use('/api/contas-pagar', routerCp);
    const srv = await listen(app);

    try {
      const getCruzado = await request(
        srv.base, 'GET', `/api/contas-pagar/${apB.id}`,
        null,
        { 'x-empresa-id': String(ctx.empresaA.id) }
      );
      assert.ok(getCruzado.status === 404 || getCruzado.status === 403, JSON.stringify(getCruzado.body));
      assert.notEqual(getCruzado.body?.conta?.id, apB.id);

      const pagarCruzado = await request(
        srv.base, 'POST', `/api/contas-pagar/${apB.id}/baixar`,
        { valor_pago: 10, idempotency_key: 'cross-pay' },
        { 'x-empresa-id': String(ctx.empresaA.id) }
      );
      assert.ok(pagarCruzado.status >= 400);

      const cancelCruzado = await request(
        srv.base, 'POST', `/api/contas-pagar/${apB.id}/cancelar`,
        { motivo: 'x', idempotency_key: 'cross-cancel' },
        { 'x-empresa-id': String(ctx.empresaA.id) }
      );
      assert.ok(cancelCruzado.status >= 400);

      const listaA = await request(
        srv.base, 'GET', '/api/contas-pagar',
        null,
        { 'x-empresa-id': String(ctx.empresaA.id) }
      );
      assert.equal(listaA.status, 200, JSON.stringify(listaA.body));
      assert.equal((listaA.body.contas || []).some((c) => c.id === apB.id), false);

      const okB = await request(
        srv.base, 'GET', `/api/contas-pagar/${apB.id}`,
        null,
        { 'x-empresa-id': String(ctx.empresaB.id) }
      );
      assert.equal(okB.status, 200, JSON.stringify(okB.body));
      assert.equal(okB.body.conta.id, apB.id);
    } finally {
      await srv.close();
      restore();
      delete require.cache[path.resolve(ROOT, 'backend/rotas/contas_pagar.js')];
      await closeDb(ctx.db);
    }
  });

  it('concorrência: baixas paralelas não excedem restante; idempotência segura', async () => {
    const ctx = await setup();
    const ap = await ContasPagarService.criar({
      db: ctx.db,
      empresaId: ctx.empresaA.id,
      valor_original: 100,
      data_vencimento: '2026-11-15'
    });
    const resultados = await Promise.allSettled([
      ContasPagarService.baixar({
        db: ctx.db, empresaId: ctx.empresaA.id, id: ap.id, valor_pago: 60, idempotency_key: 'conc-a'
      }),
      ContasPagarService.baixar({
        db: ctx.db, empresaId: ctx.empresaA.id, id: ap.id, valor_pago: 60, idempotency_key: 'conc-b'
      })
    ]);
    const ok = resultados.filter((r) => r.status === 'fulfilled');
    const fail = resultados.filter((r) => r.status === 'rejected');
    assert.equal(ok.length, 1);
    assert.equal(fail.length, 1);
    const final = await ContasPagarService.obter({ db: ctx.db, empresaId: ctx.empresaA.id, id: ap.id });
    assert.equal(final.valor_restante, 40);

    const r1 = await ContasPagarService.baixar({
      db: ctx.db, empresaId: ctx.empresaA.id, id: ap.id, valor_pago: 40, idempotency_key: 'conc-idemp'
    });
    const r2 = await ContasPagarService.baixar({
      db: ctx.db, empresaId: ctx.empresaA.id, id: ap.id, valor_pago: 40, idempotency_key: 'conc-idemp'
    });
    assert.equal(r1.valor_restante, 0);
    assert.equal(r2.valor_restante, 0);
    assert.equal(r2.idempotente === true || r2.status === STATUS_CONTA_PAGAR.QUITADA, true);
    await closeDb(ctx.db);
  });

  it('falha transacional não deixa título e projeção divergentes', async () => {
    const ctx = await setup();
    let contaId = null;
    try {
      await dentroDeTransacao(ctx.db, async () => {
        const ap = await ContasPagarService.criarNaTransacaoAtual({
          db: ctx.db,
          empresaId: ctx.empresaA.id,
          valor_original: 55,
          data_vencimento: '2026-11-12',
          descricao: 'tx-fail'
        });
        contaId = ap.id;
        const v = await buscarVinculoPorContaPagarId(ctx.db, ctx.empresaA.id, contaId);
        assert.ok(v);
        throw new Error('abort-tx');
      });
    } catch (e) {
      assert.equal(e.message, 'abort-tx');
    }
    const titulo = await getRow(ctx.db, 'SELECT id FROM contas_pagar WHERE id = ?', [contaId]);
    assert.equal(titulo, null);
    const vinculo = await getRow(
      ctx.db,
      'SELECT * FROM contas_pagar_financeiro_compat WHERE conta_pagar_id = ?',
      [contaId]
    );
    assert.equal(vinculo, null);
    const proj = await allRows(
      ctx.db,
      `SELECT id FROM financeiro WHERE origem = 'mcf_compatibilidade' AND descricao = 'tx-fail'`
    );
    assert.equal(proj.length, 0);
    await closeDb(ctx.db);
  });
});
