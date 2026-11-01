/**
 * Sprint 21G — consulta e histórico dos pagamentos persistidos.
 * Banco temporário. Não fecha venda pelo orquestrador e não chama TEF nem SEFAZ.
 *
 * Executar: node --test --test-concurrency=1 tests/pdv/sprint-21-etapa-g-consulta-historico.test.js
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

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-sprint21g-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const { isolarBancoTeste } = require('../central-entradas/helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-sprint21g-');
const db = require('../../backend/database');
isolamento.comprobar(db);

const { getJwtSecret } = require('../../backend/config/secrets');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const { verificarToken } = require('../../backend/middleware/auth');
const vendasRouter = require('../../backend/rotas/vendas');

const CNPJ_A = '11222333000181';
const CNPJ_B = '11222333000262';

let empresaA;
let empresaB;
let produtoId;
let operador;
let token;
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

function httpJson(method, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path: urlPath,
      method,
      headers
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = raw ? JSON.parse(raw) : null; } catch (_) { body = { raw }; }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function headers(empresaId) {
  return {
    Authorization: `Bearer ${token}`,
    'X-Empresa-Id': String(empresaId)
  };
}

async function criarVendaGravada({
  codigo,
  forma,
  total,
  fiscal,
  naoFiscal,
  statusPagamento,
  pagamentos,
  recebimentos,
  tef
}) {
  let tefId = null;
  if (tef) {
    const tx = await run(`
      INSERT INTO tef_transacoes (
        venda_id, empresa_id, tipo, valor, parcelas, status, provedor, nsu, autorizacao,
        criado_em, atualizado_em
      ) VALUES (NULL, ?, ?, ?, 1, 'aprovado', 'MOCK', ?, ?, datetime('now'), datetime('now'))
    `, [empresaA.id, tef.tipo, tef.valor, tef.nsu, tef.autorizacao]);
    tefId = tx.lastID;
  }
  const venda = await run(`
    INSERT INTO vendas (
      codigo, data_venda, total, desconto, forma_pagamento, status, status_pagamento,
      valor_fiscal, valor_nao_fiscal, empresa_id, tef_transacao_id
    ) VALUES (?, date('now','localtime'), ?, 0, ?, 'concluida', ?, ?, ?, ?, ?)
  `, [codigo, total, forma, statusPagamento, fiscal, naoFiscal, empresaA.id, tefId]);
  await run(`
    INSERT INTO vendas_itens (venda_id, produto_id, quantidade, preco_unitario, subtotal)
    VALUES (?, ?, 1, ?, ?)
  `, [venda.lastID, produtoId, total, total]);
  for (const pagamento of pagamentos) {
    await run(`
      INSERT INTO venda_pagamentos (
        venda_id, forma_pagamento, valor, tef_transacao_id, tef_nsu, tef_autorizacao
      ) VALUES (?, ?, ?, ?, ?, ?)
    `, [
      venda.lastID,
      pagamento.forma,
      pagamento.valor,
      pagamento.tef ? tefId : null,
      pagamento.nsu || null,
      pagamento.autorizacao || null
    ]);
  }
  for (const recebimento of recebimentos) {
    await run(`
      INSERT INTO venda_recebimentos (
        venda_id, tipo_recebimento, forma_pagamento, valor, tef_transacao_id, nsu, autorizacao, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'aprovado')
    `, [
      venda.lastID,
      recebimento.tipo,
      recebimento.forma,
      recebimento.valor,
      recebimento.tef ? tefId : null,
      recebimento.nsu || null,
      recebimento.autorizacao || null
    ]);
  }
  if (tefId) {
    await run(`UPDATE tef_transacoes SET venda_id = ? WHERE id = ?`, [venda.lastID, tefId]);
  }
  return venda.lastID;
}

function somar(lista) {
  return Math.round(lista.reduce((acc, item) => acc + Number(item.valor || 0), 0) * 100) / 100;
}

describe('Sprint 21G — consulta e histórico de pagamentos', { concurrency: false }, () => {
  before(async () => {
    await whenReady();
    const cfgPath = path.join(dbDir, 'config', 'configuracoes.json');
    const cfgAtual = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfgAtual.modo_operacional_global = 'MULTIEMPRESA';
    cfgAtual.modo_operacao_venda = 'MULTIEMPRESA';
    cfgAtual.pdv_modelo_empresa = 'MULTIPLAS';
    fs.writeFileSync(cfgPath, JSON.stringify(cfgAtual, null, 2));
    await garantirSchemaUsuarioEmpresasAsync(db);
    empresaA = await EmpresaService.criarEmpresa(
      { cnpj: CNPJ_A, razao_social: 'Empresa A Sprint 21G' },
      { db }
    );
    empresaB = await EmpresaService.criarEmpresa(
      { cnpj: CNPJ_B, razao_social: 'Empresa B Sprint 21G' },
      { db }
    );
    const produto = await run(
      `INSERT INTO produtos (nome, unidade, preco_venda, ativo) VALUES ('Pastel', 'UN', 10, 1)`
    );
    produtoId = produto.lastID;
    operador = await run(
      `INSERT INTO usuarios (username, password_hash, role, nome, perfil, ativo)
       VALUES ('op21g', 'x', 'operador', 'Operador 21G', 'OPERADOR', 1)`
    );
    operador = { id: operador.lastID };
    for (const empresa of [empresaA, empresaB]) {
      await run(
        `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`,
        [operador.id, empresa.id]
      );
    }
    token = jwt.sign(
      { id: operador.id, usuario_id: operador.id, username: 'op21g', role: 'operador', perfil: 'OPERADOR' },
      getJwtSecret(),
      { expiresIn: '2h' }
    );
    const app = express();
    app.use('/api/vendas', verificarToken, vendasRouter);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    assert.equal(/ProgramData[\\/]MercantilFiscal/i.test(String(db.dbPath)), false);
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it('devolve pagamentos e recebimentos persistidos sem duplicar o total', async () => {
    const cartao = await criarVendaGravada({
      codigo: 'G-CARTAO',
      forma: 'cartao_credito',
      total: 10,
      fiscal: 10,
      naoFiscal: 0,
      statusPagamento: 'quitada',
      tef: { tipo: 'cartao_credito', valor: 10, nsu: 'NSU-CARTAO', autorizacao: 'AUT-CARTAO' },
      pagamentos: [{ forma: 'cartao_credito', valor: 10, tef: true, nsu: 'NSU-CARTAO', autorizacao: 'AUT-CARTAO' }],
      recebimentos: [{ tipo: 'fiscal', forma: 'cartao_credito', valor: 10, tef: true, nsu: 'NSU-CARTAO', autorizacao: 'AUT-CARTAO' }]
    });
    const dinheiro = await criarVendaGravada({
      codigo: 'G-DINHEIRO',
      forma: 'dinheiro',
      total: 8,
      fiscal: 0,
      naoFiscal: 8,
      statusPagamento: 'quitada',
      pagamentos: [{ forma: 'dinheiro', valor: 8 }],
      recebimentos: [{ tipo: 'nao_fiscal', forma: 'dinheiro', valor: 8 }]
    });
    const mistoMeios = await criarVendaGravada({
      codigo: 'G-MEIOS',
      forma: 'misto',
      total: 15,
      fiscal: 15,
      naoFiscal: 0,
      statusPagamento: 'quitada',
      pagamentos: [
        { forma: 'dinheiro', valor: 5 },
        { forma: 'cartao_debito', valor: 10 }
      ],
      recebimentos: [
        { tipo: 'fiscal', forma: 'dinheiro', valor: 5 },
        { tipo: 'fiscal', forma: 'cartao_debito', valor: 10 }
      ]
    });
    const mistoFiscal = await criarVendaGravada({
      codigo: 'G-FATIAS',
      forma: 'cartao_credito',
      total: 10,
      fiscal: 6,
      naoFiscal: 4,
      statusPagamento: 'quitada',
      pagamentos: [{ forma: 'cartao_credito', valor: 10 }],
      recebimentos: [
        { tipo: 'fiscal', forma: 'cartao_credito', valor: 6 },
        { tipo: 'nao_fiscal', forma: 'cartao_credito', valor: 4 }
      ]
    });

    const respCartao = await httpJson('GET', `/api/vendas/${cartao}`, headers(empresaA.id));
    assert.equal(respCartao.status, 200, JSON.stringify(respCartao.body));
    assert.equal(Number(respCartao.body.total), 10);
    assert.equal(respCartao.body.venda_pagamentos.length, 1);
    assert.equal(respCartao.body.venda_pagamentos[0].tef_nsu, 'NSU-CARTAO');
    assert.equal(respCartao.body.venda_pagamentos[0].tef_autorizacao, 'AUT-CARTAO');
    assert.equal(Number(respCartao.body.venda_pagamentos[0].tef_transacao_id) > 0, true);
    assert.equal(respCartao.body.venda_recebimentos[0].nsu, 'NSU-CARTAO');
    assert.equal(respCartao.body.venda_recebimentos[0].tipo_recebimento, 'fiscal');
    assert.equal(somar(respCartao.body.venda_pagamentos) + somar(respCartao.body.venda_recebimentos), 20);
    assert.equal(Number(respCartao.body.total), 10);

    const respDinheiro = await httpJson('GET', `/api/vendas/${dinheiro}`, headers(empresaA.id));
    assert.equal(respDinheiro.body.venda_pagamentos[0].forma_pagamento, 'dinheiro');
    assert.equal(respDinheiro.body.venda_pagamentos[0].tef_nsu, null);
    assert.equal(respDinheiro.body.venda_pagamentos[0].tef_transacao_id, null);
    assert.equal(respDinheiro.body.status_pagamento, 'quitada');

    const respMeios = await httpJson('GET', `/api/vendas/${mistoMeios}`, headers(empresaA.id));
    assert.equal(respMeios.body.venda_pagamentos.length, 2);
    assert.equal(somar(respMeios.body.venda_pagamentos), 15);
    assert.equal(Number(respMeios.body.total), 15);

    const respFatias = await httpJson('GET', `/api/vendas/${mistoFiscal}`, headers(empresaA.id));
    assert.equal(respFatias.body.venda_pagamentos.length, 1);
    assert.equal(Number(respFatias.body.venda_pagamentos[0].valor), 10);
    assert.equal(respFatias.body.venda_recebimentos.length, 2);
    assert.equal(somar(respFatias.body.venda_recebimentos), 10);
    assert.equal(Number(respFatias.body.total), 10);
    assert.equal(Number(respFatias.body.valor_fiscal), 6);
    assert.equal(Number(respFatias.body.valor_nao_fiscal), 4);

    const persistido = await get(
      `SELECT tef_nsu, tef_autorizacao FROM venda_pagamentos WHERE venda_id = ?`,
      [cartao]
    );
    assert.equal(respCartao.body.venda_pagamentos[0].tef_nsu, persistido.tef_nsu);
    assert.equal(respCartao.body.venda_pagamentos[0].tef_autorizacao, persistido.tef_autorizacao);

    const lista = await httpJson('GET', '/api/vendas?todas=1', headers(empresaA.id));
    assert.equal(lista.status, 200);
    const linha = lista.body.find((venda) => venda.id === cartao);
    assert.equal(linha.status, 'concluida');
    assert.equal(linha.status_pagamento, 'quitada');
    assert.match(linha.pagamentos_resumo, /cartao_credito\|10\.00/);

    const outra = await httpJson('GET', `/api/vendas/${cartao}`, headers(empresaB.id));
    assert.ok(outra.status >= 400, JSON.stringify(outra.body));
    assert.equal(JSON.stringify(outra.body).includes('NSU-CARTAO'), false);
    const listaB = await httpJson('GET', '/api/vendas?todas=1', headers(empresaB.id));
    assert.equal((listaB.body || []).some((venda) => venda.id === cartao), false);
  });

  it('o histórico separa os status e não soma os meios ao total', async () => {
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
      renderVendas([{
        id: 1,
        codigo: 'G-CARTAO',
        data_venda: '2026-10-31',
        cliente_nome: 'Balcao',
        total: 10,
        forma_pagamento: 'cartao_credito',
        status: 'concluida',
        status_pagamento: 'quitada',
        pagamentos_resumo: 'cartao_credito|10.00',
        valor_fiscal: 10,
        valor_nao_fiscal: 0
      }]);
      showVendaModal({
        id: 1,
        codigo: 'G-CARTAO',
        total: 10,
        desconto: 0,
        forma_pagamento: 'cartao_credito',
        status: 'concluida',
        status_pagamento: 'quitada',
        valor_fiscal: 10,
        valor_nao_fiscal: 0,
        itens: [{ produto_id: 1, produto_nome: 'Pastel', preco_unitario: 10, quantidade: 1, subtotal: 10 }],
        venda_pagamentos: [{ forma_pagamento: 'cartao_credito', valor: 10, tef_transacao_id: 4, tef_nsu: 'NSU-CARTAO', tef_autorizacao: 'AUT-CARTAO' }],
        venda_recebimentos: [{ tipo_recebimento: 'fiscal', forma_pagamento: 'cartao_credito', valor: 10, status: 'aprovado', nsu: 'NSU-CARTAO', autorizacao: 'AUT-CARTAO', tef_transacao_id: 4 }]
      });
    `, contexto);
    const lista = contexto.paginas[0];
    const modal = contexto.modal;
    assert.match(lista, /Status da venda/);
    assert.match(lista, /Status do pagamento/);
    assert.match(lista, /Concluída/);
    assert.match(lista, /Quitado/);
    assert.match(lista, /R\$ 10\.00/);
    assert.equal(lista.includes('R$ 20.00'), false);
    assert.match(modal, /Status da venda/);
    assert.match(modal, /Status do pagamento/);
    assert.match(modal, /NSU-CARTAO/);
    assert.match(modal, /AUT-CARTAO/);
    assert.match(modal, /não são somados de novo ao total/);
    assert.match(modal, />R\$ 10\.00</);

    const cupomCtx = { console, window: {} };
    cupomCtx.window = cupomCtx;
    vm.createContext(cupomCtx);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../frontend/shared/js/fiscalImpressao.js'), 'utf8'), cupomCtx);
    const cupom = vm.runInContext(`
      montarHtmlCupomNaoFiscal(1, {
        nome_empresa: 'Pastelaria',
        forma_pagamento: 'cartao_credito',
        valor_fiscal: 0,
        valor_nao_fiscal: 10,
        itens: [{ produto_nome: 'Pastel', quantidade: 1, preco_unitario: 10, subtotal: 10 }],
        venda_pagamentos: [{ forma_pagamento: 'cartao_credito', valor: 10, tef_nsu: 'NSU-CARTAO', tef_autorizacao: 'AUT-CARTAO' }]
      }, 10, 0)
    `, cupomCtx);
    assert.match(cupom, /Total: R\$ 10,00/);
    assert.equal(cupom.includes('NSU:'), false);
    assert.equal(cupom.includes('NSU-CARTAO'), false);
    assert.equal(cupom.includes('AUT-CARTAO'), false);
    assert.equal(cupom.includes('Total: R$ 20,00'), false);
  });
});
