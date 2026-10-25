/**
 * Sprint MCF-01 — Fundação Contas a Pagar.
 * Executar: node --test tests/financeiro/mcf-01.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
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

function carregarHandlerPostContasPagar(db, contasPagarService, routePath = '/') {
  const caminhoDatabase = path.resolve(ROOT, 'backend/database.js');
  const caminhoAuditoria = path.resolve(ROOT, 'backend/services/auditoria.js');
  const caminhoService = path.resolve(
    ROOT,
    'backend/motores/mcf/services/ContasPagarService.js'
  );
  const caminhoRota = path.resolve(ROOT, 'backend/rotas/contas_pagar.js');
  const carregarOriginal = Module._load;
  delete require.cache[caminhoRota];
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
      if (caminhoResolvido === caminhoService) return contasPagarService;
      return carregarOriginal.apply(this, arguments);
    };
    router = require(caminhoRota);
  } finally {
    Module._load = carregarOriginal;
    delete require.cache[caminhoRota];
  }
  const layer = router.stack.find((item) =>
    item.route && item.route.path === routePath && item.route.methods.post
  );
  assert.ok(layer, `POST ${routePath} registrado na rota de contas a pagar`);
  return layer.route.stack[0].handle;
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
  await run(db, `CREATE TABLE contas_receber (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER, valor_parcela REAL, valor_restante REAL,
    data_vencimento TEXT, status TEXT DEFAULT 'aberto'
  )`);
  await run(db, `CREATE TABLE compras (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL
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
      valor_pago: 300,
      idempotency_key: 'mcf-01-t07-1'
    });
    assert.equal(t.valor_original, 1000);
    assert.equal(t.valor_restante, 700);
    assert.equal(t.status, STATUS_CONTA_PAGAR.PARCIAL);
    t = await ContasPagarService.baixar({
      db: ctx.db,
      empresaId: ctx.empresaA.id,
      id: ap.id,
      valor_pago: 700,
      idempotency_key: 'mcf-01-t07-2'
    });
    assert.equal(t.valor_restante, 0);
    assert.equal(t.status, STATUS_CONTA_PAGAR.QUITADA);
    await assert.rejects(
      () => ContasPagarService.baixar({
        db: ctx.db, empresaId: ctx.empresaA.id, id: ap.id, valor_pago: 100,
        idempotency_key: 'mcf-01-t07-3'
      }),
      (e) => e.code === ERROS_MCF.TITULO_QUITADO || e.code === ERROS_MCF.BAIXA_EXCEDE_RESTANTE
    );
    const pags = await ContasPagarService.listarPagamentos({
      db: ctx.db, empresaId: ctx.empresaA.id, id: ap.id
    });
    assert.equal(pags.pagamentos.length, 2);
    await closeDb(ctx.db);
  });

  it('T08 — excesso rejeitado; projeção MCF vinculada uma vez', async () => {
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
        db: ctx.db, empresaId: ctx.empresaA.id, id: ap.id, valor_pago: 150,
        idempotency_key: 'mcf-01-t08-excesso'
      }),
      (e) => e.code === ERROS_MCF.BAIXA_EXCEDE_RESTANTE
    );
    const finDepois = Number((await getRow(ctx.db, 'SELECT COUNT(*) AS n FROM financeiro')).n);
    assert.equal(finDepois, finAntes + 1);
    const vinculo = await getRow(
      ctx.db,
      'SELECT * FROM contas_pagar_financeiro_compat WHERE conta_pagar_id = ?',
      [ap.id]
    );
    assert.ok(vinculo);
    const projecao = await getRow(
      ctx.db,
      'SELECT origem, referencia_tipo, referencia_id, status FROM financeiro WHERE id = ?',
      [vinculo.financeiro_id]
    );
    assert.equal(projecao.origem, 'mcf_compatibilidade');
    assert.equal(projecao.referencia_tipo, 'contas_pagar_mcf');
    assert.equal(projecao.referencia_id, ap.id);
    assert.equal(projecao.status, 'pendente');
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

  it('T11 — schema antigo recebe colunas e índice único de parcela', async () => {
    const db = await openDb();
    await run(db, `CREATE TABLE contas_pagar (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL,
      fornecedor_id INTEGER,
      descricao TEXT,
      valor_original DECIMAL(10,2) NOT NULL,
      valor_restante DECIMAL(10,2) NOT NULL,
      data_emissao DATE,
      data_vencimento DATE NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'aberto',
      documento TEXT,
      origem TEXT DEFAULT 'manual',
      referencia_tipo VARCHAR(50),
      referencia_id INTEGER,
      observacao TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    await garantirSchemaMcfAsync(db);

    const colunas = await new Promise((resolve, reject) => {
      db.all('PRAGMA table_info(contas_pagar)', (err, rows) => (err ? reject(err) : resolve(rows)));
    });
    assert.ok(colunas.some((coluna) => coluna.name === 'numero_parcela'));
    assert.ok(colunas.some((coluna) => coluna.name === 'total_parcelas'));
    const indice = await getRow(
      db,
      `SELECT name FROM sqlite_master
       WHERE type = 'index' AND name = 'idx_contas_pagar_origem_parcela'`
    );
    assert.ok(indice);
    await closeDb(db);
  });

  it('T12 — parcela de compra é única por empresa/origem/número e idempotente', async () => {
    const ctx = await setup();
    await run(ctx.db, 'INSERT INTO compras (id, empresa_id) VALUES (50, ?)', [ctx.empresaA.id]);
    const parcelaUm = {
      db: ctx.db,
      empresaId: ctx.empresaA.id,
      descricao: 'Compra 50 - Parcela 1/2',
      valor_original: 40,
      data_emissao: '2026-10-01',
      data_vencimento: '2026-10-15',
      origem: 'compra',
      referencia_tipo: 'compra',
      referencia_id: 50,
      numero_parcela: 1,
      total_parcelas: 2
    };

    const primeiraCriacao = await ContasPagarService.criar(parcelaUm);
    const repeticao = await ContasPagarService.criar(parcelaUm);
    assert.equal(primeiraCriacao.numero_parcela, 1);
    assert.equal(primeiraCriacao.total_parcelas, 2);
    assert.equal(repeticao.id, primeiraCriacao.id);
    assert.equal(repeticao.idempotente, true);

    const parcelaDois = await ContasPagarService.criar({
      ...parcelaUm,
      descricao: 'Compra 50 - Parcela 2/2',
      valor_original: 60,
      data_vencimento: '2026-11-15',
      numero_parcela: 2
    });
    assert.notEqual(parcelaDois.id, primeiraCriacao.id);
    assert.equal(parcelaDois.numero_parcela, 2);

    await assert.rejects(
      () => ContasPagarService.criar({ ...parcelaUm, valor_original: 41 }),
      (err) => err.code === ERROS_MCF.ORIGEM_CONFLITANTE && err.statusCode === 409
    );
    await assert.rejects(
      () => ContasPagarService.criar({
        ...parcelaUm,
        empresaId: ctx.empresaB.id
      }),
      (err) => err.code === ERROS_MCF.ORIGEM_NAO_ENCONTRADA && err.statusCode === 404
    );
    await assert.rejects(
      () => ContasPagarService.criar({
        ...parcelaUm,
        numero_parcela: 3,
        total_parcelas: 2
      }),
      (err) => err.code === ERROS_MCF.PARCELA_INVALIDA && err.statusCode === 400
    );

    const titulos = await ContasPagarService.listar({
      db: ctx.db,
      empresaId: ctx.empresaA.id
    });
    assert.equal(titulos.length, 2);
    assert.equal(
      Number((await getRow(ctx.db, 'SELECT COUNT(*) AS n FROM financeiro')).n),
      2
    );
    await closeDb(ctx.db);
  });

  it('T13 — API MCF encaminha a identidade e responde replay sem duplicar', async () => {
    const ctx = await setup();
    const chamadas = [];
    let repeticao = false;
    const serviceStub = {
      criar: async (params) => {
        chamadas.push(params);
        if (params.valor_original === 26) {
          const err = new Error('Conflito de identidade');
          err.statusCode = 409;
          err.code = ERROS_MCF.ORIGEM_CONFLITANTE;
          throw err;
        }
        return { id: 501, idempotente: repeticao };
      }
    };
    const post = carregarHandlerPostContasPagar(ctx.db, serviceStub);
    const body = {
      descricao: 'Compra 51 - Parcela 1/1',
      valor_original: 25,
      data_emissao: '2026-10-02',
      data_vencimento: '2026-10-20',
      origem: 'compra',
      referencia_tipo: 'compra',
      referencia_id: 51,
      numero_parcela: 1,
      total_parcelas: 1
    };
    const requisitar = async (payload) => {
      const req = { empresaId: ctx.empresaA.id, body: payload };
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(json) { this.body = json; return this; }
      };
      await post(req, res);
      return res;
    };

    const primeira = await requisitar(body);
    assert.equal(primeira.statusCode, 201, JSON.stringify(primeira.body));
    assert.equal(chamadas[0].db, ctx.db);
    assert.equal(chamadas[0].empresaId, ctx.empresaA.id);
    assert.equal(chamadas[0].referencia_tipo, 'compra');
    assert.equal(chamadas[0].referencia_id, 51);
    assert.equal(chamadas[0].numero_parcela, 1);
    assert.equal(chamadas[0].total_parcelas, 1);

    repeticao = true;
    const repetida = await requisitar(body);
    assert.equal(repetida.statusCode, 200);
    assert.equal(repetida.body.idempotente, true);
    assert.equal(repetida.body.conta.id, primeira.body.conta.id);
    const divergente = await requisitar({ ...body, valor_original: 26 });
    assert.equal(divergente.statusCode, 409);
    await closeDb(ctx.db);
  });

  it('T14 — pagamento idempotente e concorrência não excede o saldo', async () => {
    const ctx = await setup();
    const ap = await ContasPagarService.criar({
      db: ctx.db,
      empresaId: ctx.empresaA.id,
      valor_original: 100,
      data_vencimento: '2026-10-30'
    });
    const pagamento = {
      db: ctx.db,
      empresaId: ctx.empresaA.id,
      id: ap.id,
      valor_pago: 30,
      data_pagamento: '2026-10-25',
      forma_pagamento: 'pix',
      idempotency_key: 'mcf-02-t14-replay',
      usuario_id: 12,
      origem_operacao: 'teste'
    };
    const primeiro = await ContasPagarService.baixar(pagamento);
    const replay = await ContasPagarService.baixar(pagamento);
    assert.equal(replay.idempotente, true);
    assert.equal(replay.pagamento_id, primeiro.pagamento_id);
    assert.equal(replay.valor_restante, 70);

    const concorrentes = await Promise.allSettled([
      ContasPagarService.baixar({
        ...pagamento,
        valor_pago: 50,
        idempotency_key: 'mcf-02-t14-concorrente-a'
      }),
      ContasPagarService.baixar({
        ...pagamento,
        valor_pago: 50,
        idempotency_key: 'mcf-02-t14-concorrente-b'
      })
    ]);
    assert.equal(concorrentes.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(concorrentes.filter((r) => r.status === 'rejected').length, 1);
    const final = await ContasPagarService.obter({
      db: ctx.db,
      empresaId: ctx.empresaA.id,
      id: ap.id
    });
    assert.equal(final.valor_restante, 20);
    const pagamentos = await ContasPagarService.listarPagamentos({
      db: ctx.db,
      empresaId: ctx.empresaA.id,
      id: ap.id
    });
    assert.equal(pagamentos.pagamentos.length, 2);
    assert.equal(pagamentos.pagamentos[0].usuario_id, 12);
    const projecao = await getRow(ctx.db, `
      SELECT f.status FROM financeiro f
      JOIN contas_pagar_financeiro_compat v ON v.financeiro_id = f.id
      WHERE v.conta_pagar_id = ?
    `, [ap.id]);
    assert.equal(projecao.status, 'parcial');
    await closeDb(ctx.db);
  });

  it('T15 — cancelamento parcial preserva pagamentos e saldo residual', async () => {
    const ctx = await setup();
    const ap = await ContasPagarService.criar({
      db: ctx.db,
      empresaId: ctx.empresaA.id,
      valor_original: 100,
      data_vencimento: '2026-10-30'
    });
    await ContasPagarService.baixar({
      db: ctx.db,
      empresaId: ctx.empresaA.id,
      id: ap.id,
      valor_pago: 30,
      data_pagamento: '2026-10-25',
      forma_pagamento: 'transferencia',
      idempotency_key: 'mcf-02-t15-pagamento',
      usuario_id: 12
    });
    const cancelamento = {
      db: ctx.db,
      empresaId: ctx.empresaA.id,
      id: ap.id,
      motivo: 'Compra cancelada; saldo remanescente encerrado.',
      idempotency_key: 'mcf-02-t15-cancelamento',
      usuario_id: 7
    };
    const cancelada = await ContasPagarService.cancelar(cancelamento);
    assert.equal(cancelada.status, STATUS_CONTA_PAGAR.CANCELADA);
    assert.equal(cancelada.valor_restante, 0);
    assert.equal(cancelada.saldo_cancelado, 70);
    assert.equal(cancelada.cancelado_por, 7);
    const replay = await ContasPagarService.cancelar(cancelamento);
    assert.equal(replay.idempotente, true);
    assert.equal(replay.saldo_cancelado, 70);
    await assert.rejects(
      () => ContasPagarService.cancelar({
        ...cancelamento,
        idempotency_key: 'mcf-02-t15-outro-cancelamento'
      }),
      (err) => err.code === ERROS_MCF.TITULO_JA_CANCELADO
    );
    await assert.rejects(
      () => ContasPagarService.baixar({
        db: ctx.db,
        empresaId: ctx.empresaA.id,
        id: ap.id,
        valor_pago: 1,
        idempotency_key: 'mcf-02-t15-pagamento-depois-cancelamento'
      }),
      (err) => err.code === ERROS_MCF.TITULO_CANCELADO
    );
    const pagamentos = await ContasPagarService.listarPagamentos({
      db: ctx.db,
      empresaId: ctx.empresaA.id,
      id: ap.id
    });
    assert.equal(pagamentos.pagamentos.length, 1);
    assert.equal(pagamentos.pagamentos[0].valor_pago, 30);
    const projecao = await getRow(ctx.db, `
      SELECT f.status FROM financeiro f
      JOIN contas_pagar_financeiro_compat v ON v.financeiro_id = f.id
      WHERE v.conta_pagar_id = ?
    `, [ap.id]);
    assert.equal(projecao.status, 'cancelado');
    await closeDb(ctx.db);
  });

  it('T16 — lote manual cria parcelas atomicamente e aceita replay idempotente', async () => {
    const ctx = await setup();
    const parametros = {
      db: ctx.db,
      empresaId: ctx.empresaA.id,
      data_emissao: '2026-10-01',
      categoria: 'Operacional',
      pessoa_nome: 'Fornecedor manual',
      forma_pagamento: 'boleto',
      observacao: 'Lote de teste',
      criado_por: 5,
      idempotency_key: 'mcf-02-lote-manual',
      parcelas: [
        { descricao: 'Serviço (Parcela 1/2)', valor_original: 33.33, data_vencimento: '2026-11-01' },
        { descricao: 'Serviço (Parcela 2/2)', valor_original: 33.34, data_vencimento: '2026-12-01' }
      ]
    };

    const criadas = await ContasPagarService.criarLote(parametros);
    const repetidas = await ContasPagarService.criarLote(parametros);
    assert.equal(criadas.length, 2);
    assert.ok(repetidas.every((conta) => conta.idempotente));
    assert.deepEqual(repetidas.map((conta) => conta.id), criadas.map((conta) => conta.id));
    assert.equal(criadas[0].pessoa_nome, 'Fornecedor manual');
    assert.equal(criadas[0].forma_pagamento, 'boleto');
    assert.equal(criadas[0].numero_parcela, 1);
    assert.equal(criadas[0].total_parcelas, 2);
    assert.equal(Number((await getRow(
      ctx.db,
      'SELECT COUNT(*) AS total FROM contas_pagar_financeiro_compat'
    )).total), 2);

    await assert.rejects(
      () => ContasPagarService.criarLote({
        ...parametros,
        idempotency_key: 'mcf-02-lote-invalido',
        parcelas: [
          { descricao: 'Válida', valor_original: 10, data_vencimento: '2026-11-01' },
          { descricao: 'Inválida', valor_original: 10, data_vencimento: 'data-invalida' }
        ]
      }),
      (err) => err.code === ERROS_MCF.DATA_INVALIDA
    );
    assert.equal(Number((await getRow(
      ctx.db,
      'SELECT COUNT(*) AS total FROM contas_pagar'
    )).total), 2);
    assert.equal(Number((await getRow(
      ctx.db,
      `SELECT COUNT(*) AS total FROM financeiro WHERE origem = 'mcf_compatibilidade'`
    )).total), 2);
    await closeDb(ctx.db);
  });

  it('T17 — endpoint de lote mapeia a empresa e responde criação/replay', async () => {
    const ctx = await setup();
    const postLote = carregarHandlerPostContasPagar(ctx.db, ContasPagarService, '/lote');
    const body = {
      categoria: 'Operacional',
      pessoa_nome: 'Fornecedor endpoint',
      forma_pagamento: 'pix',
      data_emissao: '2026-10-01',
      parcelas: [
        { descricao: 'Material 1/2', valor_original: 20.01, data_vencimento: '2026-11-01' },
        { descricao: 'Material 2/2', valor_original: 20.02, data_vencimento: '2026-12-01' }
      ]
    };
    const req = {
      body,
      empresaId: ctx.empresaA.id,
      user: { id: 8, nome: 'Operador' },
      headers: { 'idempotency-key': 'mcf-02-endpoint-lote' },
      get: (name) => name === 'Idempotency-Key' ? 'mcf-02-endpoint-lote' : null,
      ip: '127.0.0.1'
    };
    const executar = () => {
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; }
      };
      return Promise.resolve(postLote(req, res)).then(() => res);
    };
    const criada = await executar();
    assert.equal(criada.statusCode, 201);
    assert.equal(criada.body.contas.length, 2);
    assert.equal(criada.body.contas[0].empresa_id, ctx.empresaA.id);
    const repetida = await executar();
    assert.equal(repetida.statusCode, 200);
    assert.equal(repetida.body.idempotente, true);
    assert.deepEqual(
      repetida.body.contas.map((conta) => conta.id),
      criada.body.contas.map((conta) => conta.id)
    );
    await closeDb(ctx.db);
  });
});
