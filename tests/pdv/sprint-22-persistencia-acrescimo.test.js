/**
 * Sprint 22 — persistência individual do acréscimo da venda.
 * Banco temporário. Sem TEF, PIX, adquirente, NFC-e, NF-e ou SEFAZ.
 *
 * Executar: node --test --test-concurrency=1 tests/pdv/sprint-22-persistencia-acrescimo.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { before, after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-sprint22a-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;
delete process.env.CDS_TEF_VINCULO_FALHA;

const { isolarBancoTeste } = require('../central-entradas/helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-sprint22a-');
const db = require('../../backend/database');
isolamento.comprobar(db);

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
const tefConfigService = require('../../backend/services/tef/tefConfigService');
const tefManager = require('../../backend/services/tef/TefManager');
const vendasRouter = require('../../backend/rotas/vendas');

const CNPJ_A = '11222333000181';
const autorizacoesReais = [];

tefConfigService.obterConfiguracao = async function obterConfiguracaoIsolada() {
  return { tefHabilitado: false, pix: false };
};
tefManager.autorizar = async function autorizarBloqueada() {
  autorizacoesReais.push(Date.now());
  const err = new Error('TEF_REAL_BLOQUEADO');
  err.code = 'TEF_REAL_BLOQUEADO';
  throw err;
};

let empresaA;
let produtoId;
let tokenOperador;
let tokenSupervisor;
let terminalId;
let server;

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
    const timer = setTimeout(() => reject(new Error('Banco temporário não ficou pronto')), 90000);
    db.whenReady((err) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    });
  });
}

function httpJson(method, urlPath, { headers = {}, body = null } = {}) {
  const payload = body == null ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path: urlPath,
      method,
      headers: {
        ...headers,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const texto = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = texto ? JSON.parse(texto) : null; } catch (_) { parsed = { bruto: texto }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    'X-Empresa-Id': String(empresaA.id)
  };
}

function payloadVenda({ subtotal, desconto = 0, acrescimo = 0, total = null }) {
  const totalFinal = total == null
    ? Math.round((subtotal - desconto + acrescimo) * 100) / 100
    : total;
  return {
    origem: 'PDV',
    terminal_id: terminalId,
    venda_fiscal: false,
    emitir_fiscal: false,
    forma_pagamento: 'dinheiro',
    desconto,
    acrescimo,
    total: totalFinal,
    valor_recebido: totalFinal,
    itens: [{
      produto_id: produtoId,
      quantidade: 1,
      preco_unitario: subtotal,
      subtotal,
      tipo_venda: 'UNIDADE'
    }],
    pagamentos: [{ forma_pagamento: 'dinheiro', valor: totalFinal }]
  };
}

describe('Sprint 22 — persistência do acréscimo', { concurrency: false }, () => {
  before(async () => {
    await whenReady();
    await garantirSchemaEstoqueEmpresaAsync(db);
    await garantirSchemaUsuarioEmpresasAsync(db);
    empresaA = await EmpresaService.criarEmpresa(
      { cnpj: CNPJ_A, razao_social: 'Pastelaria A Sprint 22' },
      { db }
    );
    const produto = await run(
      `INSERT INTO produtos (
         nome, unidade, tipo_operacional, controla_estoque,
         saldo_fiscal, saldo_nao_fiscal, estoque_atual, preco_venda, ativo
       ) VALUES ('Pastel sprint 22', 'UN', 'COMERCIAL', 1, 0, 100, 100, 10, 1)`
    );
    produtoId = produto.lastID;
    await EstoqueEmpresaService.criarRegistro({
      produtoId,
      empresaId: empresaA.id,
      saldo_fiscal: 0,
      saldo_nao_fiscal: 0,
      estoque_atual: 0
    }, { db });
    await run(
      `UPDATE estoque_empresa
       SET saldo_fiscal = 0, saldo_nao_fiscal = 100, estoque_atual = 100
       WHERE produto_id = ? AND empresa_id = ?`,
      [produtoId, empresaA.id]
    );
    const operador = await run(
      `INSERT INTO usuarios (username, password_hash, role, nome, perfil, ativo)
       VALUES ('op22', 'x', 'operador', 'Operador 22', 'CAIXA', 1)`
    );
    const supervisor = await run(
      `INSERT INTO usuarios (username, password_hash, role, nome, perfil, ativo)
       VALUES ('sup22', 'x', 'operador', 'Supervisor 22', 'SUPERVISOR', 1)`
    );
    await run(
      `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`,
      [operador.lastID, empresaA.id]
    );
    await run(
      `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`,
      [supervisor.lastID, empresaA.id]
    );
    const segredo = getJwtSecret();
    tokenOperador = jwt.sign(
      { id: operador.lastID, usuario_id: operador.lastID, username: 'op22', role: 'operador', perfil: 'CAIXA' },
      segredo,
      { expiresIn: '2h' }
    );
    tokenSupervisor = jwt.sign(
      { id: supervisor.lastID, usuario_id: supervisor.lastID, username: 'sup22', role: 'operador', perfil: 'SUPERVISOR' },
      segredo,
      { expiresIn: '2h' }
    );
    const terminal = await run(`INSERT INTO terminais (nome, hostname) VALUES ('PDV-22', 'sprint22')`);
    terminalId = terminal.lastID;
    const turnoOp = await run(
      `INSERT INTO caixa (data, valor_inicial, status, terminal_id, aberto_em, aberto_por)
       VALUES (date('now','localtime'), 0, 'aberto', ?, DATETIME('now','localtime'), ?)`,
      [terminalId, operador.lastID]
    );
    await run(
      `INSERT INTO caixa_sessoes (
         caixa_turno_id, terminal_id, operador_id, empresa_id, status, valor_abertura, aberto_em
       ) VALUES (?, ?, ?, ?, 'aberto', 0, DATETIME('now','localtime'))`,
      [turnoOp.lastID, terminalId, operador.lastID, empresaA.id]
    );
    const terminalSup = await run(`INSERT INTO terminais (nome, hostname) VALUES ('PDV-22-SUP', 'sprint22-sup')`);
    const turnoSup = await run(
      `INSERT INTO caixa (data, valor_inicial, status, terminal_id, aberto_em, aberto_por)
       VALUES (date('now','localtime'), 0, 'aberto', ?, DATETIME('now','localtime'), ?)`,
      [terminalSup.lastID, supervisor.lastID]
    );
    await run(
      `INSERT INTO caixa_sessoes (
         caixa_turno_id, terminal_id, operador_id, empresa_id, status, valor_abertura, aberto_em
       ) VALUES (?, ?, ?, ?, 'aberto', 0, DATETIME('now','localtime'))`,
      [turnoSup.lastID, terminalSup.lastID, supervisor.lastID, empresaA.id]
    );

    const app = express();
    app.use(express.json());
    const contextoEmpresa = criarMiddlewareContextoEmpresa(db);
    const aplicarModelo = middlewareAplicarPdvModeloEmpresa({ db, canalHttpVendas: true });
    app.post('/api/vendas', verificarToken, contextoEmpresa, aplicarModelo, validarCaixaSeOrigemPdv, (req, res) => {
      const ret = VendaApplicationService.criarVenda(req, res);
      if (ret && typeof ret.then === 'function') {
        ret.catch((err) => {
          if (!res.headersSent) res.status(err.statusCode || 500).json({ error: err.message, code: err.code });
        });
      }
    });
    app.use('/api/vendas', verificarToken, vendasRouter);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    assert.equal(/ProgramData[\\/]MercantilFiscal/i.test(String(db.dbPath)), false);
  });

  after(async () => {
    delete process.env.CDS_TEF_VINCULO_FALHA;
    if (server) await new Promise((resolve) => server.close(resolve));
    console.log(`SPRINT22_RESULTADOS ${JSON.stringify({
      dbDir,
      dbPath: db.dbPath,
      autorizacoesReais: autorizacoesReais.length
    })}`);
  });

  it('1 e 8 — coluna com padrão 0 e venda histórica sem acréscimo', async () => {
    const colunas = await all(`PRAGMA table_info(vendas)`);
    const coluna = colunas.find((item) => item.name === 'acrescimo');
    assert.ok(coluna, 'coluna acrescimo ausente');
    assert.equal(Number(coluna.dflt_value), 0);
    await run(
      `INSERT INTO vendas (codigo, data_venda, total, desconto, forma_pagamento, status, empresa_id)
       VALUES ('H-ANTIGA-22', date('now','localtime'), 15, 0, 'dinheiro', 'concluida', ?)`,
      [empresaA.id]
    );
    const antiga = await get(`SELECT total, acrescimo FROM vendas WHERE codigo = 'H-ANTIGA-22'`);
    assert.equal(Number(antiga.total), 15);
    assert.equal(Number(antiga.acrescimo), 0);
  });

  it('2 — venda com acréscimo grava o valor e mantém o total comercial', async () => {
    const resp = await httpJson('POST', '/api/vendas', {
      headers: headers(tokenOperador),
      body: payloadVenda({ subtotal: 10, acrescimo: 2 })
    });
    assert.equal(resp.status, 200, JSON.stringify(resp.body));
    const venda = await get(
      `SELECT total, desconto, acrescimo, valor_fiscal, valor_nao_fiscal
       FROM vendas ORDER BY id DESC LIMIT 1`
    );
    assert.equal(Number(venda.acrescimo), 2);
    assert.equal(Number(venda.total), 12);
    assert.equal(Number(venda.valor_fiscal) + Number(venda.valor_nao_fiscal), 12);
    assert.notEqual(Number(venda.total), 14);
  });

  it('acréscimo arbitrário é recusado e não grava venda', async () => {
    const antes = await get(`SELECT COUNT(*) AS n FROM vendas`);
    const resp = await httpJson('POST', '/api/vendas', {
      headers: headers(tokenOperador),
      body: payloadVenda({ subtotal: 10, acrescimo: 50, total: 10 })
    });
    const depois = await get(`SELECT COUNT(*) AS n FROM vendas`);
    assert.equal(resp.status, 400);
    assert.equal(resp.body.codigo, 'ACRESCIMO_DIVERGENTE');
    assert.equal(Number(depois.n), Number(antes.n));
  });

  it('1 — venda sem acréscimo persiste 0', async () => {
    const resp = await httpJson('POST', '/api/vendas', {
      headers: headers(tokenOperador),
      body: payloadVenda({ subtotal: 8 })
    });
    assert.equal(resp.status, 200, JSON.stringify(resp.body));
    const venda = await get(`SELECT total, acrescimo FROM vendas ORDER BY id DESC LIMIT 1`);
    assert.equal(Number(venda.total), 8);
    assert.equal(Number(venda.acrescimo), 0);
  });

  it('3 — desconto e acréscimo juntos', async () => {
    const corpo = payloadVenda({ subtotal: 10, desconto: 1, acrescimo: 2 });
    corpo.terminal_id = (await get(
      `SELECT terminal_id FROM caixa_sessoes WHERE operador_id = (
         SELECT id FROM usuarios WHERE username = 'sup22'
       )`
    )).terminal_id;
    const resp = await httpJson('POST', '/api/vendas', {
      headers: headers(tokenSupervisor),
      body: corpo
    });
    assert.equal(resp.status, 200, JSON.stringify(resp.body));
    const venda = await get(`SELECT total, desconto, acrescimo FROM vendas ORDER BY id DESC LIMIT 1`);
    assert.equal(Number(venda.desconto), 1);
    assert.equal(Number(venda.acrescimo), 2);
    assert.equal(Number(venda.total), 11);
  });

  it('4, 5, 6 e 7 — mista, consulta, histórico e reimpressão sem duplicar', async () => {
    await run(
      `INSERT INTO vendas (
         codigo, data_venda, total, desconto, acrescimo, forma_pagamento, status,
         valor_fiscal, valor_nao_fiscal, status_pagamento, empresa_id
       ) VALUES (
         'H-MISTA-22', date('now','localtime'), 10, 0, 2, 'dinheiro', 'concluida',
         6, 4, 'quitada', ?
       )`,
      [empresaA.id]
    );
    const mista = await get(`SELECT id, total, acrescimo FROM vendas WHERE codigo = 'H-MISTA-22'`);
    const detalhe = await httpJson('GET', `/api/vendas/${mista.id}`, { headers: headers(tokenOperador) });
    assert.equal(detalhe.status, 200, JSON.stringify(detalhe.body));
    assert.equal(Number(detalhe.body.total), 10);
    assert.equal(Number(detalhe.body.acrescimo), 2);
    assert.equal(Number(detalhe.body.valor_fiscal), 6);
    assert.equal(Number(detalhe.body.valor_nao_fiscal), 4);

    const lista = await httpJson('GET', '/api/vendas?todas=1', { headers: headers(tokenOperador) });
    const linha = lista.body.find((venda) => venda.codigo === 'H-MISTA-22');
    assert.equal(Number(linha.total), 10);
    assert.equal(Number(linha.acrescimo), 2);

    const contexto = {
      console,
      API_URL: '/api',
      window: {},
      document: { getElementById() { return { id: 'vendaModal' }; } },
      bootstrap: { Modal: class { show() {} } },
      localStorage: { getItem() { return ''; } },
      formatCurrency(valor) { return `R$ ${Number(valor || 0).toFixed(2)}`; },
      formatDate() { return '31/10/2026'; },
      paginas: []
    };
    contexto.window = contexto;
    contexto.$ = function $(sel) {
      return {
        html(valor) {
          if (valor !== undefined && String(sel) === '#page-content') contexto.paginas.push(String(valor));
          if (valor !== undefined && String(sel) === '#modal-container') contexto.modal = String(valor);
          return this;
        },
        val() { return ''; }
      };
    };
    vm.createContext(contexto);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../frontend/shared/js/vendasHistoricoUi.js'), 'utf8'), contexto);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../frontend/pdv/js/vendas.js'), 'utf8'), contexto);
    vm.runInContext(`
      renderVendas([{ id: ${mista.id}, codigo: 'H-MISTA-22', total: 10, acrescimo: 2, desconto: 0, forma_pagamento: 'dinheiro', status: 'concluida', status_pagamento: 'quitada', pagamentos_resumo: 'dinheiro|10.00' }]);
      showVendaModal({
        id: ${mista.id},
        codigo: 'H-MISTA-22',
        total: 10,
        desconto: 0,
        acrescimo: 2,
        forma_pagamento: 'dinheiro',
        status: 'concluida',
        status_pagamento: 'quitada',
        valor_fiscal: 6,
        valor_nao_fiscal: 4,
        itens: [{ produto_id: 1, produto_nome: 'Pastel', preco_unitario: 10, quantidade: 1, subtotal: 10, valor_fiscal: 6, valor_nao_fiscal: 4, quantidade_nao_fiscal: 1 }],
        venda_pagamentos: [{ forma_pagamento: 'dinheiro', valor: 10 }],
        venda_recebimentos: [
          { tipo_recebimento: 'fiscal', forma_pagamento: 'dinheiro', valor: 6, status: 'aprovado' },
          { tipo_recebimento: 'nao_fiscal', forma_pagamento: 'dinheiro', valor: 4, status: 'aprovado' }
        ]
      });
    `, contexto);
    assert.match(contexto.paginas[0], /Acréscimo/);
    assert.match(contexto.paginas[0], /R\$ 10\.00/);
    assert.match(contexto.paginas[0], /R\$ 2\.00/);
    assert.equal(contexto.paginas[0].includes('R$ 12.00'), false);
    assert.match(contexto.modal, /Acréscimo:/);
    assert.match(contexto.modal, /R\$ 2\.00/);
    assert.match(contexto.modal, />R\$ 10\.00</);

    const cupomCtx = { console, window: {} };
    cupomCtx.window = cupomCtx;
    vm.createContext(cupomCtx);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../frontend/shared/js/fiscalImpressao.js'), 'utf8'), cupomCtx);
    const cupom = vm.runInContext(`
      const venda = ${JSON.stringify(detalhe.body)};
      montarHtmlCupomNaoFiscal(venda.id, venda, obterTotalCupomNaoFiscal(venda), Number(venda.desconto || 0))
    `, cupomCtx);
    assert.match(cupom, /Total: R\$ 4,00/);
    assert.match(cupom, /Acréscimo: R\$ 2,00/);
    assert.equal(cupom.includes('Total: R$ 6,00'), false);
    assert.equal(cupom.includes('Total: R$ 12,00'), false);
    assert.equal(cupom.includes('Total: R$ 14,00'), false);
  });

  it('9 — falha na gravação desfaz o acréscimo junto com a venda', async () => {
    const antes = await get(`SELECT COUNT(*) AS n FROM vendas`);
    process.env.CDS_TEF_VINCULO_FALHA = '1';
    try {
      const resp = await httpJson('POST', '/api/vendas', {
        headers: headers(tokenOperador),
        body: payloadVenda({ subtotal: 9, acrescimo: 1 })
      });
      assert.equal(resp.status, 409);
    } finally {
      delete process.env.CDS_TEF_VINCULO_FALHA;
    }
    const depois = await get(`SELECT COUNT(*) AS n FROM vendas`);
    const fantasma = await get(`SELECT id FROM vendas WHERE acrescimo = 1 AND total = 10`);
    assert.equal(Number(depois.n), Number(antes.n));
    assert.equal(fantasma, null);
  });

  it('10 — nenhum TEF real foi chamado', () => {
    assert.equal(autorizacoesReais.length, 0);
  });
});
