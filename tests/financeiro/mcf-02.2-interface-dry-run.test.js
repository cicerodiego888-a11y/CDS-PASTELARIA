/**
 * MCF-02.2 — Interface canônica + dry-run histórico (somente leitura).
 * Executar: node --test tests/financeiro/mcf-02.2-interface-dry-run.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
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
const DryRun = require('../../backend/motores/mcf/services/ContasPagarReconciliacaoHistoricaDryRunService');
const { sqlExcluirProjecaoMcf } = require('../../backend/motores/mcf/services/ContasPagarFinanceiroCompatGuard');
const { VERSAO_MCF } = require('../../backend/motores/mcf/contracts/constantesMcf');

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
function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_) { resolve(); }
  });
}

async function setup({ vincularEmpresaB = true } = {}) {
  const db = await openDb();
  await garantirSchemaEmpresasAsync(db);
  await garantirSchemaUsuarioEmpresasAsync(db);
  await run(db, `CREATE TABLE fornecedores (
    id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL, cpf_cnpj TEXT
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
    id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER NOT NULL
  )`);
  await garantirSchemaMcfAsync(db);
  const empresaA = await EmpresaService.criarEmpresa({ cnpj: CNPJ_A, razao_social: 'A' }, { db });
  const empresaB = await EmpresaService.criarEmpresa({ cnpj: CNPJ_B, razao_social: 'B' }, { db });
  await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaA.id, { db });
  if (vincularEmpresaB) {
    await UsuarioEmpresaService.vincularUsuarioEmpresa(1, empresaB.id, { db });
  }
  return { db, empresaA, empresaB };
}

function instrumentarSomenteLeitura(db) {
  const escritas = [];
  const originalRun = db.run.bind(db);
  const originalExec = db.exec ? db.exec.bind(db) : null;
  db.run = function(sql, ...args) {
    const s = String(sql || '').trim().toUpperCase();
    if (/^(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE\s+TRIGGER)/.test(s)) {
      escritas.push(sql);
    }
    return originalRun(sql, ...args);
  };
  if (originalExec) {
    db.exec = function(sql, ...args) {
      const s = String(sql || '').trim().toUpperCase();
      if (/^(INSERT|UPDATE|DELETE|REPLACE)/.test(s)) escritas.push(sql);
      return originalExec(sql, ...args);
    };
  }
  return {
    escritas,
    restaurar() {
      db.run = originalRun;
      if (originalExec) db.exec = originalExec;
    }
  };
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
      readConfig: () => ({
        ...(typeof real.readConfig === 'function' ? real.readConfig() : {}),
        modo_operacional_global: 'MULTIEMPRESA'
      })
    }
  };
  return () => {
    if (original) require.cache[caminhoConfig] = original;
    else delete require.cache[caminhoConfig];
  };
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
      let resolved;
      try { resolved = Module._resolveFilename(request, parent, isMain); } catch (_) { resolved = null; }
      if (resolved === caminhoDatabase) return db;
      if (resolved === caminhoAuditoria) return { gravarAuditoria: async () => {} };
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

async function iniciarApiContasPagar(db) {
  const { router, restore } = carregarRouterContasPagar(db);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const role = req.headers['x-role'] || 'admin';
    const id = Number(req.headers['x-user-id'] || 1);
    req.user = { id, role, nome: 'U' };
    next();
  });
  app.use('/api/contas-pagar', router);
  return {
    ...(await listen(app)),
    restore
  };
}

function instrumentarConsultasDryRun(db) {
  const originalAll = db.all;
  const empresasProcessadas = [];
  db.all = function(sql, params, ...args) {
    if (/\bFROM\s+(?:financeiro|contas_pagar)(?:\s|$)/i.test(String(sql || ''))) {
      const empresaId = Number(Array.isArray(params) ? params[0] : NaN);
      if (Number.isInteger(empresaId) && empresaId > 0) {
        empresasProcessadas.push(empresaId);
      }
    }
    return originalAll.call(this, sql, params, ...args);
  };
  return {
    empresasProcessadas,
    restaurar() {
      db.all = originalAll;
    }
  };
}

describe('MCF-02.2 — Interface + dry-run histórico', () => {
  it('versão MCF-02.x e UI aponta para /api/contas-pagar', () => {
    assert.match(String(VERSAO_MCF.SPRINT), /^MCF-02/);
    const pagarJs = fs.readFileSync(
      path.join(ROOT, 'frontend/erp/js/financeiro-pagar.js'),
      'utf8'
    );
    assert.match(pagarJs, /\/api\/contas-pagar/);
    assert.match(pagarJs, /exportarPagar/);
    assert.match(pagarJs, /reconciliacao-historica\/dry-run/);
    assert.doesNotMatch(pagarJs, /\/api\/financeiro\/contas-pagar/);
    assert.doesNotMatch(pagarJs, /POST['"`].*\/api\/financeiro['"`]/);
    const relJs = fs.readFileSync(
      path.join(ROOT, 'frontend/erp/js/financeiro-relatorios.js'),
      'utf8'
    );
    assert.match(relJs, /\/api\/contas-pagar\?/);
    assert.match(relJs, /dry_run_historico/);
  });

  it('dry-run: match exato compra+parcela → vincular', async () => {
    const ctx = await setup();
    const compra = await run(ctx.db, 'INSERT INTO compras (empresa_id) VALUES (?)', [ctx.empresaA.id]);
    const titulo = await ContasPagarService.criar({
      db: ctx.db,
      empresaId: ctx.empresaA.id,
      valor_original: 100,
      data_vencimento: '2026-11-10',
      origem: 'compra',
      referencia_tipo: 'compra',
      referencia_id: compra.lastID,
      numero_parcela: 1,
      total_parcelas: 1,
      descricao: 'Compra match'
    });
    // remove projeção para permitir vincular o legado
    await run(ctx.db, 'DELETE FROM contas_pagar_financeiro_compat WHERE conta_pagar_id = ?', [titulo.id]);
    await run(ctx.db, 'DELETE FROM financeiro WHERE referencia_tipo = ?', ['contas_pagar_mcf']);
    await run(
      ctx.db,
      `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, compra_id,
        numero_parcela, vencimento, empresa_id)
       VALUES ('despesa', 'Legado compra', 100, '2026-10-01', 'pendente', 'compra', ?, 1, '2026-11-10', ?)`,
      [compra.lastID, ctx.empresaA.id]
    );
    const rel = await DryRun.executarDryRun({ db: ctx.db, empresaId: ctx.empresaA.id });
    assert.equal(rel.somente_leitura, true);
    assert.equal(rel.itens.length, 1);
    assert.equal(rel.itens[0].acao_sugerida, DryRun.ACOES.VINCULAR);
    assert.equal(rel.itens[0].candidato_mcf.conta_pagar_id, titulo.id);
    assert.equal(rel.itens[0].confianca, 'alta');
    await closeDb(ctx.db);
  });

  it('dry-run: ambiguidade e divergência → revisao_manual', async () => {
    const ctx = await setup();
    const compra = await run(ctx.db, 'INSERT INTO compras (empresa_id) VALUES (?)', [ctx.empresaA.id]);
    const t1 = await ContasPagarService.criar({
      db: ctx.db, empresaId: ctx.empresaA.id, valor_original: 50,
      data_vencimento: '2026-11-01', origem: 'compra', referencia_tipo: 'compra',
      referencia_id: compra.lastID, numero_parcela: 1, total_parcelas: 1
    });
    const t2 = await ContasPagarService.criar({
      db: ctx.db, empresaId: ctx.empresaA.id, valor_original: 50,
      data_vencimento: '2026-12-01', origem: 'compra', referencia_tipo: 'compra',
      referencia_id: compra.lastID, numero_parcela: 1, total_parcelas: 1,
      idempotency_key: 'outro-titulo-mesmo-numero'
    }).catch(async () => {
      // se unique impedir, cria com parcela 1 via segundo financeiro ambíguo
      return null;
    });
    await run(ctx.db, 'DELETE FROM contas_pagar_financeiro_compat');
    await run(ctx.db, `DELETE FROM financeiro WHERE origem = 'mcf_compatibilidade'`);

    // Dois legados apontando para mesma compra/parcela → ambiguidade no uso do título
    await run(
      ctx.db,
      `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, compra_id,
        numero_parcela, vencimento, empresa_id)
       VALUES ('despesa', 'A', 50, '2026-10-01', 'pendente', 'compra', ?, 1, '2026-11-01', ?)`,
      [compra.lastID, ctx.empresaA.id]
    );
    await run(
      ctx.db,
      `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, compra_id,
        numero_parcela, vencimento, empresa_id)
       VALUES ('despesa', 'B', 50, '2026-10-02', 'pendente', 'compra', ?, 1, '2026-11-01', ?)`,
      [compra.lastID, ctx.empresaA.id]
    );

    // Divergência de valor
    const compra2 = await run(ctx.db, 'INSERT INTO compras (empresa_id) VALUES (?)', [ctx.empresaA.id]);
    const td = await ContasPagarService.criar({
      db: ctx.db, empresaId: ctx.empresaA.id, valor_original: 80,
      data_vencimento: '2026-11-15', origem: 'compra', referencia_tipo: 'compra',
      referencia_id: compra2.lastID, numero_parcela: 1, total_parcelas: 1
    });
    await run(ctx.db, 'DELETE FROM contas_pagar_financeiro_compat WHERE conta_pagar_id = ?', [td.id]);
    await run(ctx.db, 'DELETE FROM financeiro WHERE referencia_id = ? AND origem = ?', [td.id, 'mcf_compatibilidade']);
    await run(
      ctx.db,
      `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, compra_id,
        numero_parcela, vencimento, empresa_id)
       VALUES ('despesa', 'Div', 99, '2026-10-03', 'pendente', 'compra', ?, 1, '2026-12-01', ?)`,
      [compra2.lastID, ctx.empresaA.id]
    );

    const rel = await DryRun.executarDryRun({ db: ctx.db, empresaId: ctx.empresaA.id });
    const acoes = rel.itens.map((i) => i.acao_sugerida);
    assert.ok(acoes.every((a) => a === DryRun.ACOES.REVISAO_MANUAL || a === DryRun.ACOES.VINCULAR));
    assert.ok(rel.itens.some((i) => i.acao_sugerida === DryRun.ACOES.REVISAO_MANUAL));
    assert.ok(rel.itens.some((i) => /divergência|ambíg|mais de um/i.test(i.justificativa || '')));
    void t1;
    void t2;
    await closeDb(ctx.db);
  });

  it('dry-run: pago/parcial/cancelado sem inferir saldo; projeções excluídas', async () => {
    const ctx = await setup();
    await ContasPagarService.criar({
      db: ctx.db, empresaId: ctx.empresaA.id, valor_original: 10, data_vencimento: '2026-11-01'
    });
    await run(
      ctx.db,
      `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, referencia_tipo, empresa_id)
       VALUES
       ('despesa', 'Pago legado', 40, '2026-09-01', 'pago', 'manual', 'manual', ?),
       ('despesa', 'Parcial legado', 60, '2026-09-02', 'parcial', 'manual', 'manual', ?),
       ('despesa', 'Cancel legado', 20, '2026-09-03', 'cancelado', 'manual', 'manual', ?)`,
      [ctx.empresaA.id, ctx.empresaA.id, ctx.empresaA.id]
    );
    const monitor = instrumentarSomenteLeitura(ctx.db);
    const rel = await DryRun.executarDryRun({ db: ctx.db, empresaId: ctx.empresaA.id });
    monitor.restaurar();
    assert.equal(monitor.escritas.length, 0, 'dry-run não pode escrever: ' + monitor.escritas.join('|'));
    assert.equal(rel.meta.projecoes_excluidas_do_universo >= 1, true);
    const pago = rel.itens.find((i) => i.descricao === 'Pago legado');
    const parcial = rel.itens.find((i) => i.descricao === 'Parcial legado');
    const cancel = rel.itens.find((i) => i.descricao === 'Cancel legado');
    assert.equal(pago.acao_sugerida, DryRun.ACOES.REVISAO_MANUAL);
    assert.equal(pago.saldo_verificavel, false);
    assert.equal(pago.saldo_conhecido, null);
    assert.equal(parcial.acao_sugerida, DryRun.ACOES.REVISAO_MANUAL);
    assert.equal(cancel.acao_sugerida, DryRun.ACOES.IGNORAR);
    await closeDb(ctx.db);
  });

  it('dry-run: sem empresa / sem identidade → revisao_manual; título com projeção → revisao', async () => {
    const ctx = await setup();
    const compra = await run(ctx.db, 'INSERT INTO compras (empresa_id) VALUES (?)', [ctx.empresaA.id]);
    const titulo = await ContasPagarService.criar({
      db: ctx.db, empresaId: ctx.empresaA.id, valor_original: 70,
      data_vencimento: '2026-11-20', origem: 'compra', referencia_tipo: 'compra',
      referencia_id: compra.lastID, numero_parcela: 1, total_parcelas: 1
    });
    // mantém projeção; legado paralelo
    await run(
      ctx.db,
      `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, compra_id,
        numero_parcela, vencimento, empresa_id)
       VALUES ('despesa', 'Paralelo com projeção', 70, '2026-10-01', 'pendente', 'compra', ?, 1, '2026-11-20', ?)`,
      [compra.lastID, ctx.empresaA.id]
    );
    await run(
      ctx.db,
      `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, empresa_id)
       VALUES ('despesa', 'Sem identidade', 15, '2026-10-01', 'pendente', 'manual', ?)`,
      [ctx.empresaA.id]
    );
    const rel = await DryRun.executarDryRun({ db: ctx.db, empresaId: ctx.empresaA.id });
    const paralelo = rel.itens.find((i) => i.descricao === 'Paralelo com projeção');
    const semId = rel.itens.find((i) => i.descricao === 'Sem identidade');
    assert.equal(paralelo.acao_sugerida, DryRun.ACOES.REVISAO_MANUAL);
    assert.match(paralelo.justificativa, /projeção/i);
    assert.equal(semId.acao_sugerida, DryRun.ACOES.REVISAO_MANUAL);
    assert.ok(titulo.id);
    await closeDb(ctx.db);
  });

  it('totais por ação e prevenção de dupla contagem (projeção excluída)', async () => {
    const ctx = await setup();
    await ContasPagarService.criar({
      db: ctx.db, empresaId: ctx.empresaA.id, valor_original: 1000, data_vencimento: '2026-11-01'
    });
    await run(
      ctx.db,
      `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, empresa_id)
       VALUES ('despesa', 'Hist', 200, '2026-09-01', 'pendente', 'manual', ?)`,
      [ctx.empresaA.id]
    );
    const somaSemProj = await getRow(
      ctx.db,
      `SELECT COALESCE(SUM(valor),0) AS t FROM financeiro
       WHERE empresa_id = ? AND tipo='despesa' AND status NOT IN ('pago','recebido','cancelado')
       ${sqlExcluirProjecaoMcf('')}`,
      [ctx.empresaA.id]
    );
    const somaComProj = await getRow(
      ctx.db,
      `SELECT COALESCE(SUM(valor),0) AS t FROM financeiro
       WHERE empresa_id = ? AND tipo='despesa' AND status NOT IN ('pago','recebido','cancelado')`,
      [ctx.empresaA.id]
    );
    assert.equal(Number(somaSemProj.t), 200);
    assert.equal(Number(somaComProj.t), 1200);
    const rel = await DryRun.executarDryRun({ db: ctx.db, empresaId: ctx.empresaA.id });
    assert.equal(rel.totais_empresa.gerais.quantidade, 1);
    assert.equal(rel.totais_empresa.gerais.valor_conhecido, 200);
    assert.ok(rel.totais_empresa.por_acao.revisao_manual.quantidade >= 1
      || rel.totais_empresa.por_acao.criar_titulo.quantidade >= 1);
    await closeDb(ctx.db);
  });

  it('API dry-run multiempresa processa somente vínculos ativos nas duas flags', async () => {
    const ctx = await setup({ vincularEmpresaB: false });
    await run(
      ctx.db,
      `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, empresa_id)
       VALUES ('despesa', 'Só A', 33, '2026-09-01', 'pendente', 'manual', ?)`,
      [ctx.empresaA.id]
    );
    await run(
      ctx.db,
      `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, empresa_id)
       VALUES ('despesa', 'Só B', 44, '2026-09-01', 'pendente', 'manual', ?)`,
      [ctx.empresaB.id]
    );
    const srv = await iniciarApiContasPagar(ctx.db);
    const instrumentacao = instrumentarConsultasDryRun(ctx.db);
    try {
      for (const flag of ['multiempresa=1', 'todas_empresas=1']) {
        instrumentacao.empresasProcessadas.length = 0;
        const resultado = await request(
          srv.base,
          'GET',
          `/api/contas-pagar/reconciliacao-historica/dry-run?${flag}`,
          null,
          { 'x-empresa-id': String(ctx.empresaA.id), 'x-role': 'admin' }
        );
        assert.equal(resultado.status, 200, JSON.stringify(resultado.body));
        assert.deepEqual(
          (resultado.body.empresas || []).map((rel) => rel.empresa_id),
          [ctx.empresaA.id]
        );
        assert.ok((resultado.body.empresas[0].itens || []).some((i) => i.descricao === 'Só A'));
        assert.equal(
          resultado.body.empresas.some((rel) => (rel.itens || []).some((i) => i.descricao === 'Só B')),
          false
        );
        assert.equal(resultado.body.totais_gerais.quantidade, 1);
        assert.equal(resultado.body.totais_gerais.valor_conhecido, 33);
        assert.deepEqual([...new Set(instrumentacao.empresasProcessadas)], [ctx.empresaA.id]);
      }
    } finally {
      await srv.close();
      srv.restore();
      instrumentacao.restaurar();
      delete require.cache[path.resolve(ROOT, 'backend/rotas/contas_pagar.js')];
      await closeDb(ctx.db);
    }
  });

  it('API dry-run admin vinculado a A e B processa ambas as empresas', async () => {
    const ctx = await setup();
    await run(
      ctx.db,
      `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, empresa_id)
       VALUES ('despesa', 'Só A', 33, '2026-09-01', 'pendente', 'manual', ?)`,
      [ctx.empresaA.id]
    );
    await run(
      ctx.db,
      `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, empresa_id)
       VALUES ('despesa', 'Só B', 44, '2026-09-01', 'pendente', 'manual', ?)`,
      [ctx.empresaB.id]
    );
    const srv = await iniciarApiContasPagar(ctx.db);
    const instrumentacao = instrumentarConsultasDryRun(ctx.db);
    try {
      const resultado = await request(
        srv.base,
        'GET',
        '/api/contas-pagar/reconciliacao-historica/dry-run?multiempresa=1',
        null,
        { 'x-empresa-id': String(ctx.empresaA.id), 'x-role': 'admin' }
      );
      assert.equal(resultado.status, 200, JSON.stringify(resultado.body));
      assert.deepEqual(
        (resultado.body.empresas || []).map((rel) => rel.empresa_id),
        [ctx.empresaA.id, ctx.empresaB.id]
      );
      assert.deepEqual(
        [...new Set(instrumentacao.empresasProcessadas)],
        [ctx.empresaA.id, ctx.empresaB.id]
      );
      assert.equal(resultado.body.totais_gerais.quantidade, 2);
      assert.equal(resultado.body.totais_gerais.valor_conhecido, 77);
    } finally {
      await srv.close();
      srv.restore();
      instrumentacao.restaurar();
      delete require.cache[path.resolve(ROOT, 'backend/rotas/contas_pagar.js')];
      await closeDb(ctx.db);
    }
  });

  it('API dry-run exige admin, contexto e vínculo autorizado para consulta individual', async () => {
    const ctx = await setup({ vincularEmpresaB: false });
    await run(
      ctx.db,
      `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, empresa_id)
       VALUES ('despesa', 'Só A', 33, '2026-09-01', 'pendente', 'manual', ?)`,
      [ctx.empresaA.id]
    );
    await run(
      ctx.db,
      `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, empresa_id)
       VALUES ('despesa', 'Só B', 44, '2026-09-01', 'pendente', 'manual', ?)`,
      [ctx.empresaB.id]
    );
    const srv = await iniciarApiContasPagar(ctx.db);
    const instrumentacao = instrumentarConsultasDryRun(ctx.db);
    try {
      const negadoNaoAdmin = await request(
        srv.base,
        'GET',
        '/api/contas-pagar/reconciliacao-historica/dry-run?multiempresa=1',
        null,
        { 'x-empresa-id': String(ctx.empresaA.id), 'x-role': 'operador' }
      );
      assert.equal(negadoNaoAdmin.status, 403);
      assert.equal(instrumentacao.empresasProcessadas.length, 0);

      const semContexto = await request(
        srv.base,
        'GET',
        '/api/contas-pagar/reconciliacao-historica/dry-run',
        null,
        { 'x-role': 'admin' }
      );
      assert.equal(semContexto.status, 400);
      assert.equal(instrumentacao.empresasProcessadas.length, 0);

      const autorizado = await request(
        srv.base,
        'GET',
        '/api/contas-pagar/reconciliacao-historica/dry-run',
        null,
        { 'x-empresa-id': String(ctx.empresaA.id), 'x-role': 'admin' }
      );
      assert.equal(autorizado.status, 200, JSON.stringify(autorizado.body));
      assert.equal(autorizado.body.empresa_id, ctx.empresaA.id);
      assert.ok((autorizado.body.itens || []).every((i) => i.empresa_id === ctx.empresaA.id));
      assert.ok((autorizado.body.itens || []).some((i) => i.descricao === 'Só A'));
      assert.deepEqual([...new Set(instrumentacao.empresasProcessadas)], [ctx.empresaA.id]);

      instrumentacao.empresasProcessadas.length = 0;
      const naoAutorizado = await request(
        srv.base,
        'GET',
        '/api/contas-pagar/reconciliacao-historica/dry-run',
        null,
        { 'x-empresa-id': String(ctx.empresaB.id), 'x-role': 'admin' }
      );
      assert.equal(naoAutorizado.status, 403);
      assert.equal(instrumentacao.empresasProcessadas.length, 0);

      const semVinculos = await request(
        srv.base,
        'GET',
        '/api/contas-pagar/reconciliacao-historica/dry-run?multiempresa=1',
        null,
        {
          'x-empresa-id': String(ctx.empresaA.id),
          'x-role': 'admin',
          'x-user-id': '2'
        }
      );
      assert.equal(semVinculos.status, 403);
      assert.equal(instrumentacao.empresasProcessadas.length, 0);
    } finally {
      await srv.close();
      srv.restore();
      instrumentacao.restaurar();
      delete require.cache[path.resolve(ROOT, 'backend/rotas/contas_pagar.js')];
      await closeDb(ctx.db);
    }
  });

  it('serviço dry-run não contém SQL de escrita', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'backend/motores/mcf/services/ContasPagarReconciliacaoHistoricaDryRunService.js'),
      'utf8'
    );
    // Remove comentários de bloco/linha para validar apenas código executável
    const codigo = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(codigo, /\bINSERT\s+INTO\b/i);
    assert.doesNotMatch(codigo, /\bUPDATE\s+\w+/i);
    assert.doesNotMatch(codigo, /\bDELETE\s+FROM\b/i);
    assert.match(src, /somente_leitura/);
  });
});
