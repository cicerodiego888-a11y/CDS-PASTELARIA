/**
 * Sprint 21F — integridade e uso único das transações TEF.
 * Banco SQLite temporário. Não chama adquirente: autorizar sem
 * idempotency_key é bloqueado. A duplicidade usa o TefManager real,
 * que retorna antes do adapter quando a idempotency_key já existe.
 *
 * Executar: node --test --test-concurrency=1 tests/pdv/sprint-21-verificacao-vinculo-tef.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { before, after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-sprint21v-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const emissoesFiscais = [];
const emissorPath = require.resolve('../../backend/services/fiscal/emissor');
require.cache[emissorPath] = {
  id: emissorPath,
  filename: emissorPath,
  loaded: true,
  exports: {
    async emitirPorVendaId() {
      emissoesFiscais.push(Date.now());
      const err = new Error('SEFAZ bloqueada na auditoria de vínculo TEF.');
      err.code = 'SEFAZ_BLOQUEADA';
      throw err;
    }
  }
};

const { isolarBancoTeste } = require('../central-entradas/helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-sprint21v-');
const db = require('../../backend/database');
isolamento.comprobar(db);

const tefManager = require('../../backend/services/tef/TefManager');
const { getJwtSecret } = require('../../backend/config/secrets');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const { verificarToken } = require('../../backend/middleware/auth');
const { validarCaixaSeOrigemPdv } = require('../../backend/middleware/validarCaixaAberto');
const { criarMiddlewareContextoEmpresa } = require('../../backend/services/fiscalNaoFiscal/empresaContexto');
const { middlewareAplicarPdvModeloEmpresa } = require('../../backend/services/pdv/PdvModeloEmpresaService');
const VendaApplicationService = require('../../backend/services/vendas/VendaApplicationService');
const tefRouter = require('../../backend/rotas/tef');

const CNPJ_A = '11222333000181';
const CNPJ_B = '11222333000262';
const autorizacoesBloqueadas = [];
const autorizarOriginal = tefManager.autorizar.bind(tefManager);

tefManager.autorizar = async function autorizarAuditoria(dados) {
  if (dados && dados.idempotency_key) {
    return autorizarOriginal(dados);
  }
  autorizacoesBloqueadas.push({ tipo: dados && dados.tipo, valor: dados && dados.valor });
  const err = new Error('TEF_REAL_BLOQUEADO');
  err.code = 'TEF_REAL_BLOQUEADO';
  throw err;
};
tefManager.cancelar = async function cancelarBloqueado() {
  return { sucesso: true, simulado: true };
};

let empresaA;
let empresaB;
let produtoId;
let terminalId;
let operador;
let token;
let server;
const resultados = {};

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function whenReady() {
  return new Promise((resolve, reject) => {
    if (typeof db.whenReady !== 'function') {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error('timeout whenReady')), 120000);
    db.whenReady((err) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    });
  });
}

function httpJson(method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path: urlPath,
      method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (_) { json = { raw }; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function inserirTef({
  tipo,
  valor,
  status = 'aprovado',
  nsu,
  autorizacao,
  idempotencyKey,
  vendaId = null,
  empresaId = undefined
}) {
  const empresa = empresaId === undefined ? empresaA.id : empresaId;
  const ins = await run(`
    INSERT INTO tef_transacoes (
      venda_id, empresa_id, tipo, valor, parcelas, status, provedor, adquirente, bandeira,
      nsu, autorizacao, codigo_transacao, idempotency_key, criado_em, atualizado_em
    ) VALUES (?, ?, ?, ?, 1, ?, 'AUDITORIA', 'AUDITORIA', 'AUDITORIA', ?, ?, 'AUDITORIA', ?, datetime('now'), datetime('now'))
  `, [vendaId, empresa, tipo, valor, status, nsu, autorizacao, idempotencyKey || null]);
  return { id: ins.lastID, nsu, autorizacao, tipo, valor, status, empresaId: empresa };
}

function headers(empresaId) {
  return {
    Authorization: `Bearer ${token}`,
    'X-Empresa-Id': String(empresaId)
  };
}

function corpo({ empresaId, pagamentos, forma, total = 10, extra = {} }) {
  return {
    total,
    desconto: 0,
    acrescimo: 0,
    forma_pagamento: forma,
    emitir_fiscal: false,
    venda_fiscal: true,
    empresa_id: empresaId,
    itens: [{
      produto_id: produtoId,
      quantidade: 1,
      preco_unitario: total,
      subtotal: total
    }],
    pagamentos,
    terminal_id: terminalId,
    ...extra
  };
}

async function postVenda(empresaId, pagamentos, forma, total = 10, extra = {}) {
  const antes = autorizacoesBloqueadas.length;
  const resp = await httpJson(
    'POST',
    '/api/vendas',
    corpo({ empresaId, pagamentos, forma, total, extra }),
    headers(empresaId)
  );
  return { resp, autorizou: autorizacoesBloqueadas.length - antes };
}

describe('Sprint 21 — verificação do vínculo TEF', { concurrency: false }, () => {
  before(async () => {
    await whenReady();
    const cfgPath = path.join(dbDir, 'config', 'configuracoes.json');
    const cfgAtual = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfgAtual.modo_operacional_global = 'MULTIEMPRESA';
    cfgAtual.modo_operacao_venda = 'MULTIEMPRESA';
    cfgAtual.pdv_modelo_empresa = 'MULTIPLAS';
    cfgAtual.pdv_empresa_id = null;
    cfgAtual.modo_confirmacao_fiscal = 'TEF';
    fs.writeFileSync(cfgPath, JSON.stringify(cfgAtual, null, 2));
    await garantirSchemaEstoqueEmpresaAsync(db);
    await garantirSchemaUsuarioEmpresasAsync(db);

    empresaA = await EmpresaService.criarEmpresa(
      { cnpj: CNPJ_A, razao_social: 'Empresa A vinculo TEF' },
      { db }
    );
    empresaB = await EmpresaService.criarEmpresa(
      { cnpj: CNPJ_B, razao_social: 'Empresa B vinculo TEF' },
      { db }
    );
    const produto = await run(
      `INSERT INTO produtos (
         nome, unidade, tipo_operacional, controla_estoque,
         saldo_fiscal, saldo_nao_fiscal, estoque_atual, preco_venda, ativo
       ) VALUES ('Pastel vinculo', 'UN', 'COMERCIAL', 1, 0, 0, 0, 10, 1)`
    );
    produtoId = produto.lastID;
    for (const emp of [empresaA, empresaB]) {
      await EstoqueEmpresaService.criarRegistro({
        produtoId,
        empresaId: emp.id,
        saldo_fiscal: 0,
        saldo_nao_fiscal: 0,
        estoque_atual: 0
      }, { db });
      await run(
        `UPDATE estoque_empresa
         SET saldo_fiscal = 500, saldo_nao_fiscal = 500, estoque_atual = 1000,
             reservado_fiscal = 0, reservado_nao_fiscal = 0
         WHERE produto_id = ? AND empresa_id = ?`,
        [produtoId, emp.id]
      );
    }
    await run(
      `UPDATE produtos SET saldo_fiscal = 500, saldo_nao_fiscal = 500, estoque_atual = 1000 WHERE id = ?`,
      [produtoId]
    );

    operador = await run(
      `INSERT INTO usuarios (username, password_hash, role, nome, perfil, ativo)
       VALUES ('op21v', 'x', 'operador', 'Operador vinculo', 'OPERADOR', 1)`
    );
    operador = { id: operador.lastID };
    await run(
      `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`,
      [operador.id, empresaA.id]
    );
    await run(
      `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`,
      [operador.id, empresaB.id]
    );
    token = jwt.sign(
      { id: operador.id, usuario_id: operador.id, username: 'op21v', role: 'operador', perfil: 'OPERADOR' },
      getJwtSecret(),
      { expiresIn: '2h' }
    );

    const terminal = await run(`INSERT INTO terminais (nome, hostname) VALUES ('PDV-21V', 'sprint21v')`);
    terminalId = terminal.lastID;
    for (const emp of [empresaA, empresaB]) {
      const turno = await run(
        `INSERT INTO caixa (data, valor_inicial, status, terminal_id, aberto_em, aberto_por)
         VALUES (date('now','localtime'), 0, 'aberto', ?, DATETIME('now','localtime'), ?)`,
        [terminalId, operador.id]
      );
      await run(
        `INSERT INTO caixa_sessoes (
           caixa_turno_id, terminal_id, operador_id, empresa_id, status, valor_abertura, aberto_em
         ) VALUES (?, ?, ?, ?, 'aberto', 0, DATETIME('now','localtime'))`,
        [turno.lastID, terminalId, operador.id, emp.id]
      );
    }

    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/api/tef', tefRouter);
    const contextoEmpresa = criarMiddlewareContextoEmpresa(db);
    const aplicarModelo = middlewareAplicarPdvModeloEmpresa({ db, canalHttpVendas: true });
    app.post(
      '/api/vendas',
      verificarToken,
      contextoEmpresa,
      aplicarModelo,
      validarCaixaSeOrigemPdv,
      (req, res) => {
        if (req.body && req.body.emitir_fiscal === true) req.body.emitir_fiscal = false;
        const ret = VendaApplicationService.criarVenda(req, res);
        if (ret && typeof ret.then === 'function') {
          ret.catch((err) => {
            if (!res.headersSent) {
              res.status(err.statusCode || 500).json({ error: err.message, code: err.code });
            }
          });
        }
      }
    );
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    const colunas = await all(`PRAGMA table_info(tef_transacoes)`);
    const indices = await all(
      `SELECT name, sql FROM sqlite_master
       WHERE type = 'index' AND tbl_name IN ('tef_transacoes', 'venda_pagamentos', 'venda_recebimentos')`
    );
    resultados.schema = {
      colunasTef: colunas.map((c) => c.name),
      temEmpresaId: colunas.some((c) => c.name === 'empresa_id'),
      indices: indices.map((i) => i.name)
    };
    assert.equal(/ProgramData[\\/]MercantilFiscal/i.test(String(db.dbPath)), false);
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    console.log(`SPRINT21V_RESULTADOS ${JSON.stringify({
      dbPath: db.dbPath,
      autorizacoesBloqueadas: autorizacoesBloqueadas.length,
      emissoesFiscais: emissoesFiscais.length,
      resultados
    })}`);
  });

  it('duplicidade aprovada e não aprovada pela rota real', async () => {
    const aprovada = await inserirTef({
      tipo: 'cartao_credito',
      valor: 10,
      status: 'aprovado',
      nsu: 'NSU-DUP-OK',
      autorizacao: 'AUT-DUP-OK',
      idempotencyKey: 'sprint21v-dup-ok'
    });
    const pendente = await inserirTef({
      tipo: 'cartao_credito',
      valor: 10,
      status: 'pendente',
      nsu: 'NSU-DUP-NO',
      autorizacao: 'AUT-DUP-NO',
      idempotencyKey: 'sprint21v-dup-no'
    });
    const antes = await get(`SELECT COUNT(*) AS n FROM tef_transacoes`);
    const ok = await httpJson('POST', '/api/tef/pagar', {
      tipo: 'cartao_credito',
      valor: 10,
      parcelas: 1,
      idempotency_key: 'sprint21v-dup-ok'
    }, headers(empresaA.id));
    const nao = await httpJson('POST', '/api/tef/pagar', {
      tipo: 'cartao_credito',
      valor: 10,
      parcelas: 1,
      idempotency_key: 'sprint21v-dup-no'
    }, headers(empresaA.id));
    const depois = await get(`SELECT COUNT(*) AS n FROM tef_transacoes`);
    resultados.duplicidade = {
      aprovada: { status: ok.status, codigo: ok.body && ok.body.codigo, id: ok.body && ok.body.transacao_id, aprovado: ok.body && ok.body.aprovado },
      naoAprovada: { status: nao.status, codigo: nao.body && nao.body.codigo, id: nao.body && nao.body.transacao_id, aprovado: nao.body && nao.body.aprovado },
      linhasAntes: Number(antes.n),
      linhasDepois: Number(depois.n)
    };
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.codigo, 'TRANSACAO_DUPLICADA');
    assert.equal(ok.body.aprovado, true);
    assert.equal(Number(ok.body.transacao_id), Number(aprovada.id));
    assert.equal(nao.status, 409, JSON.stringify(nao.body));
    assert.equal(nao.body.codigo, 'TRANSACAO_DUPLICADA');
    assert.equal(nao.body.aprovado, false);
    assert.equal(Number(nao.body.transacao_id), Number(pendente.id));
    assert.equal(Number(depois.n), Number(antes.n));
    assert.equal(autorizacoesBloqueadas.length, 0);
  });

  it('status não aprovado é rejeitado', async () => {
    const tx = await inserirTef({
      tipo: 'cartao_credito',
      valor: 10,
      status: 'negado',
      nsu: 'NSU-NEG',
      autorizacao: 'AUT-NEG'
    });
    const antes = await get(`SELECT COUNT(*) AS n FROM vendas`);
    const { resp, autorizou } = await postVenda(empresaA.id, [{
      forma_pagamento: 'cartao_credito',
      valor: 10,
      tipo_recebimento: 'fiscal',
      tef_transacao_id: tx.id,
      nsu: tx.nsu,
      autorizacao: tx.autorizacao
    }], 'cartao_credito');
    const depois = await get(`SELECT COUNT(*) AS n FROM vendas`);
    resultados.statusNegado = {
      http: resp.status,
      erro: resp.body && resp.body.error,
      vendasNovas: Number(depois.n) - Number(antes.n),
      autorizou
    };
    assert.ok(resp.status >= 400, JSON.stringify(resp.body));
    assert.equal(Number(depois.n), Number(antes.n));
    assert.equal(autorizou, 0);
  });

  it('transação compatível é aceita', async () => {
    const tx = await inserirTef({
      tipo: 'cartao_credito',
      valor: 10,
      status: 'aprovado',
      nsu: 'NSU-OK',
      autorizacao: 'AUT-OK'
    });
    const { resp, autorizou } = await postVenda(empresaA.id, [{
      forma_pagamento: 'cartao_credito',
      valor: 10,
      tipo_recebimento: 'fiscal',
      tef_transacao_id: tx.id,
      nsu: tx.nsu,
      autorizacao: tx.autorizacao
    }], 'cartao_credito');
    assert.ok(resp.status < 400, JSON.stringify(resp.body));
    const vendaId = resp.body.venda_id || resp.body.id;
    const venda = await get(
      `SELECT id, empresa_id, status_pagamento, tef_transacao_id, total FROM vendas WHERE id = ?`,
      [vendaId]
    );
    const tef = await get(`SELECT venda_id, valor, tipo, status, nsu FROM tef_transacoes WHERE id = ?`, [tx.id]);
    const receb = vendaId
      ? await get(
        `SELECT tef_nsu, tef_autorizacao FROM venda_pagamentos WHERE venda_id = ?`,
        [vendaId]
      )
      : null;
    resultados.legitima = {
      http: resp.status,
      vendaId,
      empresaId: venda.empresa_id,
      statusPagamento: venda.status_pagamento,
      tefNaVenda: venda.tef_transacao_id,
      vendaIdNaTransacao: tef.venda_id,
      nsuGravado: receb && receb.tef_nsu,
      autorizou
    };
    assert.equal(venda.status_pagamento, 'quitada');
    assert.equal(Number(venda.empresa_id), Number(empresaA.id));
    assert.equal(Number(venda.tef_transacao_id), Number(tx.id));
    assert.equal(Number(tef.venda_id), Number(vendaId));
    assert.equal(receb.tef_nsu, 'NSU-OK');
    assert.equal(autorizou, 0);
  });

  it('transação da venda A é aceita na empresa B', async () => {
    const tx = await inserirTef({
      tipo: 'cartao_credito',
      valor: 10,
      status: 'aprovado',
      nsu: 'NSU-EMP',
      autorizacao: 'AUT-EMP'
    });
    const pagamentoEmpresa = [{
      forma_pagamento: 'cartao_credito',
      valor: 10,
      tipo_recebimento: 'fiscal',
      tef_transacao_id: tx.id,
      nsu: tx.nsu,
      autorizacao: tx.autorizacao
    }];
    const primeira = await postVenda(empresaA.id, pagamentoEmpresa, 'cartao_credito');
    const vendaA = primeira.resp.status < 400
      ? (primeira.resp.body.venda_id || primeira.resp.body.id)
      : null;
    await run(
      `UPDATE estoque_empresa SET saldo_fiscal = 0, estoque_atual = saldo_nao_fiscal
       WHERE produto_id = ? AND empresa_id = ?`,
      [produtoId, empresaA.id]
    );
    let segunda;
    try {
      segunda = await postVenda(empresaB.id, pagamentoEmpresa, 'cartao_credito');
    } finally {
      await run(
        `UPDATE estoque_empresa SET saldo_fiscal = 500, estoque_atual = saldo_nao_fiscal + 500
         WHERE produto_id = ? AND empresa_id = ?`,
        [produtoId, empresaA.id]
      );
    }
    const vendaB = segunda.resp.status < 400
      ? (segunda.resp.body.venda_id || segunda.resp.body.id)
      : null;
    const tef = await get(`SELECT venda_id FROM tef_transacoes WHERE id = ?`, [tx.id]);
    const vendas = await all(
      `SELECT id, empresa_id, status_pagamento, tef_transacao_id FROM vendas WHERE id IN (?, ?)`,
      [vendaA, vendaB || 0]
    );
    resultados.empresa = {
      httpA: primeira.resp.status,
      httpB: segunda.resp.status,
      erroB: segunda.resp.body && segunda.resp.body.error,
      vendaA,
      vendaB,
      vendaIdNaTransacao: tef.venda_id,
      vendas,
      autorizou: segunda.autorizou
    };
    assert.ok(segunda.resp.status >= 400, JSON.stringify(segunda.resp.body));
    assert.equal(vendaB, null);
    assert.equal(Number(tef.venda_id), Number(vendaA));
    assert.equal(vendas.filter((venda) => venda.status_pagamento === 'quitada').length, 1);
    assert.equal(segunda.autorizou, 0);
  });

  it('valor aprovado diferente do pagamento é confrontado', async () => {
    const tx = await inserirTef({
      tipo: 'cartao_credito',
      valor: 100,
      status: 'aprovado',
      nsu: 'NSU-VAL',
      autorizacao: 'AUT-VAL'
    });
    const antes = await get(`SELECT COUNT(*) AS n FROM vendas`);
    const { resp, autorizou } = await postVenda(empresaA.id, [{
      forma_pagamento: 'cartao_credito',
      valor: 10,
      tipo_recebimento: 'fiscal',
      tef_transacao_id: tx.id,
      nsu: tx.nsu,
      autorizacao: tx.autorizacao
    }], 'cartao_credito');
    const depois = await get(`SELECT COUNT(*) AS n FROM vendas`);
    resultados.valor = {
      valorTransacao: 100,
      valorPagamento: 10,
      http: resp.status,
      erro: resp.body && resp.body.error,
      vendasNovas: Number(depois.n) - Number(antes.n),
      autorizou
    };
    assert.ok(resp.status >= 400, JSON.stringify(resp.body));
    assert.equal(Number(depois.n), Number(antes.n));
    assert.equal(autorizou, 0);
  });

  it('forma incompatível é confrontada', async () => {
    const tx = await inserirTef({
      tipo: 'cartao_debito',
      valor: 10,
      status: 'aprovado',
      nsu: 'NSU-FORMA',
      autorizacao: 'AUT-FORMA'
    });
    const antes = await get(`SELECT COUNT(*) AS n FROM vendas`);
    const { resp, autorizou } = await postVenda(empresaA.id, [{
      forma_pagamento: 'cartao_credito',
      valor: 10,
      tipo_recebimento: 'fiscal',
      tef_transacao_id: tx.id,
      nsu: tx.nsu,
      autorizacao: tx.autorizacao
    }], 'cartao_credito');
    const depois = await get(`SELECT COUNT(*) AS n FROM vendas`);
    resultados.forma = {
      tipoTransacao: 'cartao_debito',
      formaPagamento: 'cartao_credito',
      http: resp.status,
      erro: resp.body && resp.body.error,
      vendasNovas: Number(depois.n) - Number(antes.n),
      autorizou
    };
    assert.ok(resp.status >= 400, JSON.stringify(resp.body));
    assert.equal(Number(depois.n), Number(antes.n));
    assert.equal(autorizou, 0);
  });

  it('NSU e autorização divergentes são confrontados', async () => {
    const tx = await inserirTef({
      tipo: 'cartao_credito',
      valor: 10,
      status: 'aprovado',
      nsu: 'NSU-REAL',
      autorizacao: 'AUT-REAL'
    });
    const { resp, autorizou } = await postVenda(empresaA.id, [{
      forma_pagamento: 'cartao_credito',
      valor: 10,
      tipo_recebimento: 'fiscal',
      tef_transacao_id: tx.id,
      nsu: 'NSU-FALSO',
      autorizacao: 'AUT-FALSA'
    }], 'cartao_credito');
    const vendaId = resp.body && (resp.body.venda_id || resp.body.id);
    const receb = vendaId
      ? await get(`SELECT tef_nsu, tef_autorizacao FROM venda_pagamentos WHERE venda_id = ?`, [vendaId])
      : null;
    resultados.identificadores = {
      http: resp.status,
      erro: resp.body && resp.body.error,
      nsuEnviado: 'NSU-FALSO',
      nsuTransacao: 'NSU-REAL',
      nsuGravado: receb && receb.tef_nsu,
      autorizacaoGravada: receb && receb.tef_autorizacao,
      autorizou
    };
    assert.ok(resp.status >= 400, JSON.stringify(resp.body));
    assert.equal(vendaId ?? null, null);
    assert.equal(receb, null);
    assert.equal(autorizou, 0);
  });

  it('a mesma transação em duas vendas é confrontada', async () => {
    const tx = await inserirTef({
      tipo: 'cartao_credito',
      valor: 10,
      status: 'aprovado',
      nsu: 'NSU-2V',
      autorizacao: 'AUT-2V'
    });
    const pagamento = [{
      forma_pagamento: 'cartao_credito',
      valor: 10,
      tipo_recebimento: 'fiscal',
      tef_transacao_id: tx.id,
      nsu: tx.nsu,
      autorizacao: tx.autorizacao
    }];
    const primeira = await postVenda(empresaA.id, pagamento, 'cartao_credito');
    const segunda = await postVenda(empresaA.id, pagamento, 'cartao_credito');
    const venda1 = primeira.resp.body && (primeira.resp.body.venda_id || primeira.resp.body.id);
    const venda2 = segunda.resp.body && (segunda.resp.body.venda_id || segunda.resp.body.id);
    const tef = await get(`SELECT venda_id FROM tef_transacoes WHERE id = ?`, [tx.id]);
    const usos = await get(
      `SELECT COUNT(*) AS n FROM venda_pagamentos WHERE tef_transacao_id = ?`,
      [tx.id]
    );
    resultados.duasVendas = {
      http1: primeira.resp.status,
      http2: segunda.resp.status,
      erro2: segunda.resp.body && segunda.resp.body.error,
      venda1,
      venda2,
      vendaIdNaTransacao: tef.venda_id,
      pagamentosComOId: Number(usos.n),
      autorizou: segunda.autorizou
    };
    assert.equal(primeira.resp.status < 400, true, JSON.stringify(primeira.resp.body));
    assert.ok(segunda.resp.status >= 400, JSON.stringify(segunda.resp.body));
    assert.equal(venda2 ?? null, null);
    assert.equal(Number(tef.venda_id), Number(venda1));
    assert.equal(Number(usos.n), 1);
    assert.equal(segunda.autorizou, 0);
  });

  it('a mesma transação em dois pagamentos da mesma venda é confrontada', async () => {
    const tx = await inserirTef({
      tipo: 'cartao_credito',
      valor: 10,
      status: 'aprovado',
      nsu: 'NSU-2P',
      autorizacao: 'AUT-2P'
    });
    const linha = {
      forma_pagamento: 'cartao_credito',
      valor: 5,
      tipo_recebimento: 'fiscal',
      tef_transacao_id: tx.id,
      nsu: tx.nsu,
      autorizacao: tx.autorizacao
    };
    const { resp, autorizou } = await postVenda(
      empresaA.id,
      [linha, { ...linha }],
      'misto'
    );
    const vendaId = resp.body && (resp.body.venda_id || resp.body.id);
    const usos = await get(
      `SELECT COUNT(*) AS n FROM venda_pagamentos WHERE tef_transacao_id = ?`,
      [tx.id]
    );
    resultados.doisPagamentos = {
      http: resp.status,
      erro: resp.body && resp.body.error,
      vendaId,
      pagamentosComOId: Number(usos.n),
      autorizou
    };
    assert.ok(resp.status >= 400, JSON.stringify(resp.body));
    assert.equal(vendaId ?? null, null);
    assert.equal(Number(usos.n), 0);
    assert.equal(autorizou, 0);
  });

  it('F3 — transação sem empresa é rejeitada', async () => {
    const tx = await inserirTef({
      tipo: 'cartao_credito',
      valor: 10,
      status: 'aprovado',
      nsu: 'NSU-SEM',
      autorizacao: 'AUT-SEM',
      empresaId: null
    });
    const antes = await get(`SELECT COUNT(*) AS n FROM vendas`);
    const { resp, autorizou } = await postVenda(empresaA.id, [{
      forma_pagamento: 'cartao_credito',
      valor: 10,
      tipo_recebimento: 'fiscal',
      tef_transacao_id: tx.id,
      nsu: tx.nsu,
      autorizacao: tx.autorizacao
    }], 'cartao_credito');
    const depois = await get(`SELECT COUNT(*) AS n FROM vendas`);
    resultados.empresaAusente = {
      http: resp.status,
      erro: resp.body && resp.body.error,
      vendasNovas: Number(depois.n) - Number(antes.n),
      autorizou
    };
    assert.ok(resp.status >= 400, JSON.stringify(resp.body));
    assert.equal(Number(depois.n), Number(antes.n));
    assert.equal(autorizou, 0);
  });

  it('F9 — duas requisições simultâneas não quitam a mesma transação', async () => {
    const tx = await inserirTef({
      tipo: 'cartao_credito',
      valor: 10,
      status: 'aprovado',
      nsu: 'NSU-RACE',
      autorizacao: 'AUT-RACE'
    });
    const pagamento = [{
      forma_pagamento: 'cartao_credito',
      valor: 10,
      tipo_recebimento: 'fiscal',
      tef_transacao_id: tx.id,
      nsu: tx.nsu,
      autorizacao: tx.autorizacao
    }];
    const [a, b] = await Promise.all([
      postVenda(empresaA.id, pagamento, 'cartao_credito'),
      postVenda(empresaA.id, pagamento, 'cartao_credito')
    ]);
    const quitadas = await get(
      `SELECT COUNT(*) AS n FROM vendas WHERE tef_transacao_id = ? AND status_pagamento = 'quitada'`,
      [tx.id]
    );
    const tef = await get(`SELECT venda_id, empresa_id FROM tef_transacoes WHERE id = ?`, [tx.id]);
    resultados.concorrencia = {
      http: [a.resp.status, b.resp.status],
      quitadas: Number(quitadas.n),
      vendaIdNaTransacao: tef.venda_id,
      autorizou: a.autorizou + b.autorizou
    };
    assert.equal(Number(quitadas.n), 1, JSON.stringify(resultados.concorrencia));
    assert.equal(Number(tef.empresa_id), Number(empresaA.id));
    assert.ok(tef.venda_id, JSON.stringify(resultados.concorrencia));
    assert.equal(a.autorizou + b.autorizou, 0);
  });

  it('F10 — falha na vinculação reverte a venda', async () => {
    const tx = await inserirTef({
      tipo: 'cartao_credito',
      valor: 10,
      status: 'aprovado',
      nsu: 'NSU-ROLLBACK',
      autorizacao: 'AUT-ROLLBACK'
    });
    const antes = await get(`SELECT COUNT(*) AS n FROM vendas`);
    process.env.CDS_TEF_VINCULO_FALHA = '1';
    let resp;
    let autorizou;
    try {
      ({ resp, autorizou } = await postVenda(empresaA.id, [{
        forma_pagamento: 'cartao_credito',
        valor: 10,
        tipo_recebimento: 'fiscal',
        tef_transacao_id: tx.id,
        nsu: tx.nsu,
        autorizacao: tx.autorizacao
      }], 'cartao_credito'));
    } finally {
      delete process.env.CDS_TEF_VINCULO_FALHA;
    }
    const depois = await get(`SELECT COUNT(*) AS n FROM vendas`);
    const pagamentos = await get(
      `SELECT COUNT(*) AS n FROM venda_pagamentos WHERE tef_transacao_id = ?`,
      [tx.id]
    );
    const tef = await get(`SELECT venda_id FROM tef_transacoes WHERE id = ?`, [tx.id]);
    resultados.rollback = {
      http: resp.status,
      erro: resp.body && resp.body.error,
      vendasNovas: Number(depois.n) - Number(antes.n),
      pagamentos: Number(pagamentos.n),
      vendaIdNaTransacao: tef.venda_id,
      autorizou
    };
    assert.ok(resp.status >= 400, JSON.stringify(resp.body));
    assert.equal(Number(depois.n), Number(antes.n));
    assert.equal(Number(pagamentos.n), 0);
    assert.equal(tef.venda_id, null);
    assert.equal(autorizou, 0);
  });

  it('F13 — cartão sem autorização continua rejeitado e o manual explícito segue', async () => {
    const tefConfigService = require('../../backend/services/tef/tefConfigService');
    const obterOriginal = tefConfigService.obterConfiguracao.bind(tefConfigService);
    tefConfigService.obterConfiguracao = async () => ({ tefHabilitado: false, pix: false });
    const antes = await get(`SELECT COUNT(*) AS n FROM vendas`);
    const semAutorizacao = await postVenda(empresaA.id, [{
      forma_pagamento: 'cartao_credito',
      valor: 10,
      tipo_recebimento: 'fiscal'
    }], 'cartao_credito');
    const cfgPath = path.join(dbDir, 'config', 'configuracoes.json');
    const cfgAtual = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfgAtual.modo_confirmacao_fiscal = 'MANUAL';
    fs.writeFileSync(cfgPath, JSON.stringify(cfgAtual, null, 2));
    const manual = await postVenda(empresaA.id, [{
      forma_pagamento: 'cartao_credito',
      valor: 10,
      tipo_recebimento: 'fiscal'
    }], 'cartao_credito', 10, { confirmacao_fiscal_manual: true });
    cfgAtual.modo_confirmacao_fiscal = 'TEF';
    fs.writeFileSync(cfgPath, JSON.stringify(cfgAtual, null, 2));
    tefConfigService.obterConfiguracao = obterOriginal;
    const vendasDepois = await get(`SELECT COUNT(*) AS n FROM vendas`);
    resultados.etapaE = {
      semAutorizacao: semAutorizacao.resp.status,
      erro: semAutorizacao.resp.body && semAutorizacao.resp.body.error,
      manual: manual.resp.status,
      vendasNovas: Number(vendasDepois.n) - Number(antes.n)
    };
    assert.ok(semAutorizacao.resp.status >= 400, JSON.stringify(semAutorizacao.resp.body));
    assert.ok(manual.resp.status < 400, JSON.stringify(manual.resp.body));
    assert.equal(Number(vendasDepois.n), Number(antes.n) + 1);
  });

  it('F14 — rateio do motor ignora o valor fiscal do corpo', async () => {
    const tx = await inserirTef({
      tipo: 'cartao_credito',
      valor: 9.5,
      status: 'aprovado',
      nsu: 'NSU-RATEIO',
      autorizacao: 'AUT-RATEIO'
    });
    const tokenSupervisor = jwt.sign(
      { id: operador.id, usuario_id: operador.id, username: 'op21v', role: 'operador', perfil: 'SUPERVISOR' },
      getJwtSecret(),
      { expiresIn: '2h' }
    );
    const corpoRateio = corpo({
      empresaId: empresaA.id,
      forma: 'cartao_credito',
      total: 9.5,
      pagamentos: [{
        forma_pagamento: 'cartao_credito',
        valor: 9.5,
        tipo_recebimento: 'fiscal',
        tef_transacao_id: tx.id,
        nsu: tx.nsu,
        autorizacao: tx.autorizacao
      }],
      extra: { desconto: 1, acrescimo: 0.5, valor_fiscal: 999, valor_nao_fiscal: 999 }
    });
    corpoRateio.itens[0].preco_unitario = 10;
    corpoRateio.itens[0].subtotal = 10;
    const resp = await httpJson('POST', '/api/vendas', corpoRateio, {
      Authorization: `Bearer ${tokenSupervisor}`,
      'X-Empresa-Id': String(empresaA.id)
    });
    assert.ok(resp.status < 400, JSON.stringify(resp.body));
    const venda = await get(
      `SELECT total, desconto, valor_fiscal, valor_nao_fiscal, tef_transacao_id
       FROM vendas WHERE id = ?`,
      [resp.body.venda_id || resp.body.id]
    );
    resultados.rateio = {
      total: Number(venda.total),
      desconto: Number(venda.desconto),
      valor_fiscal: Number(venda.valor_fiscal),
      valor_nao_fiscal: Number(venda.valor_nao_fiscal),
      tef: venda.tef_transacao_id
    };
    assert.equal(Number(venda.total), 9.5);
    assert.equal(Number(venda.desconto), 1);
    assert.equal(Number(venda.valor_fiscal), 9.5);
    assert.notEqual(Number(venda.valor_fiscal), 999);
    assert.equal(Number(venda.tef_transacao_id), Number(tx.id));
    assert.equal(emissoesFiscais.length, 0);
  });
});
