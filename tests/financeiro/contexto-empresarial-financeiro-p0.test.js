/**
 * P0 — Contexto empresarial do Financeiro (MULTIEMPRESA).
 * Valida headers no frontend e isolamento HTTP no backend (SQLite isolado).
 * Executar: node --test tests/financeiro/contexto-empresarial-financeiro-p0.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const Module = require('module');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();

const ROOT = path.join(__dirname, '../..');
const { garantirSchemaEmpresasAsync } = require('../../backend/services/empresas/empresasSchema');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const { garantirSchemaMcfAsync } = require('../../backend/motores/mcf/schema/mcfSchema');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const ContasPagarService = require('../../backend/motores/mcf/services/ContasPagarService');

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function openMem() {
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
function closeDb(db) {
  return new Promise((resolve) => {
    try { db.close(() => resolve()); } catch (_) { resolve(); }
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

function carregarRouter(relRota, db) {
  const caminhoDatabase = path.resolve(ROOT, 'backend/database.js');
  const caminhoAuditoria = path.resolve(ROOT, 'backend/services/auditoria.js');
  const caminhoRota = path.resolve(ROOT, relRota);
  const restoreConfig = stubConfigMultiempresa();
  const carregarOriginal = Module._load;
  delete require.cache[caminhoRota];
  delete require.cache[path.resolve(ROOT, 'backend/services/financeiro/FinanceiroEmpresaContextoService.js')];
  delete require.cache[path.resolve(ROOT, 'backend/core/modo-operacional/modoOperacionalGlobal.js')];
  delete require.cache[path.resolve(ROOT, 'backend/core/modo-operacional/ContratoOperacionalService.js')];
  let router;
  try {
    Module._load = function (request, parent, isMain) {
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

function request(base, method, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, base);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(raw); } catch (_) { body = raw; }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function setupDb() {
  const db = await openMem();
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
  await run(db, `CREATE TABLE IF NOT EXISTS categorias (
    id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT, tipo TEXT
  )`);
  await garantirSchemaMcfAsync(db);

  const empA = await EmpresaService.criarEmpresa(
    { cnpj: '11222333000181', razao_social: 'Empresa A Fin' },
    { db }
  );
  const empB = await EmpresaService.criarEmpresa(
    { cnpj: '04252011000110', razao_social: 'Empresa B Fin' },
    { db }
  );

  await run(db,
    `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (10, ?, 1)`,
    [empA.id]
  );
  await run(db,
    `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (10, ?, 1)`,
    [empB.id]
  );
  await run(db,
    `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (11, ?, 1)`,
    [empA.id]
  );

  await ContasPagarService.criar({
    db, empresaId: empA.id, valor_original: 111, data_vencimento: '2026-11-10',
    descricao: 'Titulo A', idempotency_key: 'p0-a'
  });
  await ContasPagarService.criar({
    db, empresaId: empB.id, valor_original: 222, data_vencimento: '2026-11-12',
    descricao: 'Titulo B', idempotency_key: 'p0-b'
  });

  await run(db,
    `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, empresa_id, vencimento)
     VALUES ('receita','Rec A',50,'2026-10-01','pendente','manual',?,'2026-11-01')`,
    [empA.id]
  );
  await run(db,
    `INSERT INTO financeiro (tipo, descricao, valor, data_movimento, status, origem, empresa_id, vencimento)
     VALUES ('receita','Rec B',80,'2026-10-02','pendente','manual',?,'2026-11-02')`,
    [empB.id]
  );

  return { db, empA, empB };
}

describe('P0 — Contexto empresarial Financeiro', () => {
  it('frontend: mecanismo central expõe headersAuth com X-Empresa-Id', () => {
    const ctx = src('frontend/shared/js/cds-empresa-contexto.js');
    assert.match(ctx, /function headersAuth/);
    assert.match(ctx, /X-Empresa-Id/);
    assert.match(ctx, /temEmpresaSelecionada/);
    assert.match(ctx, /mensagemEmpresaObrigatoria/);
  });

  it('frontend: core aguarda inicializar e jQuery anexa X-Empresa-Id', () => {
    const core = src('frontend/shared/js/core.js');
    assert.match(core, /await CdsEmpresaContexto\.inicializar\(\)/);
    const ajaxSetups = core.match(/\$\.ajaxSetup\([\s\S]*?anexarHeaderXhr[\s\S]*?\}\);/g) || [];
    assert.ok(ajaxSetups.length >= 1, 'ajaxSetup deve anexar header empresarial');
  });

  it('frontend: telas financeiras usam helper central (sem Authorization isolado nas 4 rotas)', () => {
    const shell = src('frontend/erp/js/financeiro.js');
    assert.match(shell, /function headersFinanceiro/);
    assert.match(shell, /CdsEmpresaContexto\.headersAuth/);
    assert.match(shell, /financeiroTemEmpresaSelecionada|temEmpresaSelecionada/);
    assert.match(shell, /cds-empresa-contexto-alterado/);

    const clients = [
      ['frontend/erp/js/financeiro-dashboard.js', /\/api\/financeiro\/dashboard/, /__headersFin\(/],
      ['frontend/erp/js/financeiro-receber.js', /\/api\/financeiro\/receber/, /headersReceberDaEmpresa\(|__headersFin\(/],
      ['frontend/erp/js/financeiro-pagar.js', /\/api\/contas-pagar/, /headersAuthPagar\(/],
      ['frontend/erp/js/financeiro-historico.js', /\/api\/financeiro\/historico|\/api\/financeiro\/multiempresa\/historico/, /__headersFin\(/],
      ['frontend/erp/js/financeiro-relatorios.js', /\/api\/financeiro\/relatorios|\/api\/contas-pagar/, /__headersFin\(/]
    ];

    for (const [rel, rotaRe, helperRe] of clients) {
      const code = src(rel);
      assert.match(code, rotaRe, rel);
      assert.match(code, helperRe, rel);
      assert.match(code, /CdsEmpresaContexto|headersFinanceiro|__headersFin|headersAuthPagar/, rel);
      if (rel.endsWith('financeiro-receber.js')) {
        assert.match(code, /function headersReceberDaEmpresa[\s\S]*?(?:headersFinanceiroDaEmpresa|__headersFin)/);
      }
      if (rel.endsWith('financeiro-pagar.js')) {
        assert.match(code, /function headersAuthPagarDaEmpresa[\s\S]*?headersAuthPagar/);
      }

      // Após remover o fallback do helper, não deve restar Authorization puro em fetch das rotas
      const semFallback = code
        .replace(/function __headersFin\([\s\S]*?\n\}/, '')
        .replace(/function headersAuthPagar\([\s\S]*?\n\}/, '');
      const fetchesCriticos = semFallback.match(
        /fetch\(\s*[`'"][^`'"]*(?:\/api\/financeiro(?:\/receber(?:\/agrupado)?)?|\/api\/contas-pagar)[^`'"]*[`'"][\s\S]{0,220}\)/g
      ) || [];
      for (const trecho of fetchesCriticos) {
        assert.match(
          trecho,
          /__headersFin\(|headersAuthPagar\(|headersReceberDaEmpresa\(|headersAuthPagarDaEmpresa\(/,
          `${rel} fetch sem helper: ${trecho.slice(0, 120)}`
        );
        assert.doesNotMatch(
          trecho,
          /['"]Authorization['"]:\s*['"]Bearer /,
          `${rel} ainda usa Authorization isolado`
        );
      }
    }
  });

  it('backend: MULTIEMPRESA sem X-Empresa-Id → 400 nas rotas financeiras', async () => {
    const { db, empA } = await setupDb();
    const fin = carregarRouter('backend/rotas/financeiro.js', db);
    const pagar = carregarRouter('backend/rotas/contas_pagar.js', db);
    const app = express();
    app.use((req, _res, next) => {
      req.user = { id: 10, role: 'admin' };
      next();
    });
    app.use('/api/financeiro', fin.router);
    app.use('/api/contas-pagar', pagar.router);
    const srv = await listen(app);
    try {
      const rotas = [
        '/api/financeiro',
        '/api/financeiro/receber',
        '/api/financeiro/receber/agrupado',
        '/api/contas-pagar',
        '/api/financeiro/dashboard?dataInicio=2026-10-01&dataFim=2026-11-30'
      ];
      for (const rota of rotas) {
        const r = await request(srv.base, 'GET', rota, {
          Accept: 'application/json',
          Authorization: 'Bearer teste'
        });
        assert.equal(r.status, 400, rota);
        assert.equal(r.body.code || r.body.codigo, 'FINANCEIRO_EMPRESA_OBRIGATORIA');
      }
      // Com header da empresa A, contas-pagar responde
      const ok = await request(srv.base, 'GET', '/api/contas-pagar', {
        Accept: 'application/json',
        Authorization: 'Bearer teste',
        'X-Empresa-Id': String(empA.id)
      });
      assert.ok([200, 304].includes(ok.status), `status ${ok.status}`);
      const lista = ok.body.contas || ok.body.data || ok.body.items || ok.body;
      const arr = Array.isArray(lista) ? lista : (lista.contas || []);
      assert.ok(Array.isArray(arr));
      assert.ok(arr.every((c) => Number(c.empresa_id) === Number(empA.id)));
      assert.ok(arr.some((c) => String(c.descricao).includes('Titulo A')));
      assert.ok(!arr.some((c) => String(c.descricao || '').includes('Titulo B')));
    } finally {
      await srv.close();
      fin.restore();
      pagar.restore();
      await closeDb(db);
    }
  });

  it('backend: Contas a Pagar consolidado usa apenas empresas autorizadas, sem ID enviado pelo cliente', async () => {
    const { db, empA, empB } = await setupDb();
    const pagar = carregarRouter('backend/rotas/contas_pagar.js', db);
    let usuarioId = 10;
    const app = express();
    app.use((req, _res, next) => {
      req.user = { id: usuarioId, role: 'operador' };
      next();
    });
    app.use('/api/contas-pagar', pagar.router);
    const srv = await listen(app);
    try {
      const consolidado = await request(srv.base, 'GET', '/api/contas-pagar/multiempresa?empresa_ids=999', {
        Accept: 'application/json',
        Authorization: 'Bearer teste'
      });
      assert.equal(consolidado.status, 200);
      assert.equal(consolidado.body.escopo, 'todas');
      assert.deepEqual(
        consolidado.body.contas.map((conta) => Number(conta.empresa_id)).sort((a, b) => a - b),
        [Number(empA.id), Number(empB.id)]
      );
      assert.equal(consolidado.body.contas.some((conta) => conta.descricao === 'Titulo A'), true);
      assert.equal(consolidado.body.contas.some((conta) => conta.descricao === 'Titulo B'), true);

      usuarioId = 11;
      const restrita = await request(srv.base, 'GET', '/api/contas-pagar/multiempresa?empresaId=' + empB.id, {
        Accept: 'application/json',
        Authorization: 'Bearer teste'
      });
      assert.equal(restrita.status, 200);
      assert.equal(restrita.body.contas.length, 1);
      assert.equal(Number(restrita.body.contas[0].empresa_id), Number(empA.id));
      assert.equal(restrita.body.contas[0].empresa_nome, 'Empresa A Fin');
    } finally {
      await srv.close();
      pagar.restore();
      await closeDb(db);
    }
  });

  it('backend: troca A→B e rejeita empresa não autorizada', async () => {
    const { db, empA, empB } = await setupDb();
    const pagar = carregarRouter('backend/rotas/contas_pagar.js', db);
    const app = express();
    app.use((req, _res, next) => {
      req.user = { id: 11, role: 'operador' }; // só autorizado em A
      next();
    });
    app.use('/api/contas-pagar', pagar.router);
    const srv = await listen(app);
    try {
      const a = await request(srv.base, 'GET', '/api/contas-pagar', {
        Accept: 'application/json',
        'X-Empresa-Id': String(empA.id)
      });
      assert.equal(a.status, 200);
      const contasA = a.body.contas || a.body.data || a.body.items || a.body;
      const arrA = Array.isArray(contasA) ? contasA : (contasA.contas || []);
      assert.ok(arrA.every((c) => Number(c.empresa_id) === Number(empA.id)));

      const bNegado = await request(srv.base, 'GET', '/api/contas-pagar', {
        Accept: 'application/json',
        'X-Empresa-Id': String(empB.id)
      });
      assert.ok([403, 400].includes(bNegado.status), `esperado 403, veio ${bNegado.status}`);

      const inexistente = await request(srv.base, 'GET', '/api/contas-pagar', {
        Accept: 'application/json',
        'X-Empresa-Id': '99999'
      });
      assert.ok([400, 403, 404].includes(inexistente.status));
    } finally {
      await srv.close();
      pagar.restore();
      await closeDb(db);
    }
  });

  it('backend: usuário admin troca contexto A→B e isola dados', async () => {
    const { db, empA, empB } = await setupDb();
    const pagar = carregarRouter('backend/rotas/contas_pagar.js', db);
    const app = express();
    app.use((req, _res, next) => {
      req.user = { id: 10, role: 'admin' };
      next();
    });
    app.use('/api/contas-pagar', pagar.router);
    const srv = await listen(app);
    try {
      const a = await request(srv.base, 'GET', '/api/contas-pagar', {
        Accept: 'application/json',
        'X-Empresa-Id': String(empA.id)
      });
      const b = await request(srv.base, 'GET', '/api/contas-pagar', {
        Accept: 'application/json',
        'X-Empresa-Id': String(empB.id)
      });
      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
      const arrA = a.body.contas || a.body.data || a.body || [];
      const arrB = b.body.contas || b.body.data || b.body || [];
      const listA = Array.isArray(arrA) ? arrA : (arrA.contas || []);
      const listB = Array.isArray(arrB) ? arrB : (arrB.contas || []);
      assert.ok(listA.some((c) => /Titulo A/.test(String(c.descricao))));
      assert.ok(!listA.some((c) => /Titulo B/.test(String(c.descricao || ''))));
      assert.ok(listB.some((c) => /Titulo B/.test(String(c.descricao))));
      assert.ok(!listB.some((c) => /Titulo A/.test(String(c.descricao || ''))));
    } finally {
      await srv.close();
      pagar.restore();
      await closeDb(db);
    }
  });
});
