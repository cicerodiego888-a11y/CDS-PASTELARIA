/**
 * Sprint 24 — pagamento manual quando o TEF está desligado.
 * Banco temporário. Sem TEF real, PIX, adquirente, NFC-e, NF-e ou SEFAZ.
 *
 * Executar: node --test --test-concurrency=1 tests/pdv/sprint-24-pagamento-manual-sem-tef.test.js
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

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-sprint24-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;
delete process.env.CDS_TEF_VINCULO_FALHA;
delete process.env.CDS_RECOMPOSICAO_HOMOLOGACAO_DISTRIBUIR;
delete process.env.CDS_RECOMPOSICAO_APLICAR_DISTRIBUICAO;

const { isolarBancoTeste } = require('../central-entradas/helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-sprint24-');
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
const configService = require('../../backend/services/configuracaoService');
const fluxo = require('../../backend/services/tef/tefFluxoPagamento');
const {
  distribuirItensVendaComValorFiscalEfetivo
} = require('../../backend/services/distribuidorEstoqueVenda');

const CNPJ_A = '11222333000181';
const autorizacoesReais = [];
const emissoesFiscais = [];
let tefLigado = false;

configService.getModoConfirmacaoFiscal = function modoTefDoTeste() {
  return 'TEF';
};
tefConfigService.obterConfiguracao = async function obterConfiguracaoIsolada() {
  return { tefHabilitado: tefLigado, pix: false };
};
tefManager.autorizar = async function autorizarBloqueada() {
  autorizacoesReais.push(Date.now());
  const err = new Error('TEF_REAL_BLOQUEADO');
  err.code = 'TEF_REAL_BLOQUEADO';
  throw err;
};

let empresaA;
let produtoId;
let operadorId;
let tokenOperador;
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

function headers() {
  return {
    Authorization: `Bearer ${tokenOperador}`,
    'X-Empresa-Id': String(empresaA.id)
  };
}

function item(preco) {
  return {
    produto_id: produtoId,
    quantidade: 1,
    preco_unitario: preco,
    subtotal: preco,
    tipo_venda: 'UNIDADE'
  };
}

function corpoVenda({ total, vendaFiscal, pagamentos, forma }) {
  return {
    origem: 'PDV',
    terminal_id: terminalId,
    venda_fiscal: vendaFiscal === true,
    emitir_fiscal: false,
    confirmacao_fiscal_manual: true,
    forma_pagamento: forma || (pagamentos.length > 1 ? 'misto' : pagamentos[0].forma_pagamento),
    desconto: 0,
    acrescimo: 0,
    total,
    valor_recebido: total,
    itens: [item(total)],
    pagamentos
  };
}

async function definirEstoque(fiscal, naoFiscal) {
  await run(
    `UPDATE estoque_empresa
     SET saldo_fiscal = ?, saldo_nao_fiscal = ?, estoque_atual = ?
     WHERE produto_id = ? AND empresa_id = ?`,
    [fiscal, naoFiscal, fiscal + naoFiscal, produtoId, empresaA.id]
  );
  await run(
    `UPDATE produtos SET saldo_fiscal = ?, saldo_nao_fiscal = ?, estoque_atual = ? WHERE id = ?`,
    [fiscal, naoFiscal, fiscal + naoFiscal, produtoId]
  );
}

async function contarVendas() {
  const row = await get(`SELECT COUNT(*) AS total FROM vendas`);
  return Number(row.total);
}

async function contarNotas() {
  const row = await get(`SELECT COUNT(*) AS total FROM nfce_notas`);
  return Number(row.total);
}

function assertParcelaManual(parcela, forma, valor) {
  assert.equal(parcela.forma_pagamento, forma);
  assert.equal(Number(parcela.valor), valor);
  assert.equal(parcela.confirmacao_modalidade, 'manual');
  assert.equal(Number(parcela.confirmacao_manual), 1);
  assert.equal(Number(parcela.operador_id), operadorId);
  assert.ok(parcela.confirmado_em);
  assert.equal(parcela.tef_transacao_id, null);
  assert.equal(parcela.tef_nsu, null);
  assert.equal(parcela.tef_autorizacao, null);
  assert.equal(parcela.tef_adquirente, null);
}

describe('Sprint 24 — pagamento manual sem TEF', { concurrency: false }, () => {
  before(async () => {
    await whenReady();
    await garantirSchemaEstoqueEmpresaAsync(db);
    await garantirSchemaUsuarioEmpresasAsync(db);
    empresaA = await EmpresaService.criarEmpresa(
      { cnpj: CNPJ_A, razao_social: 'Pastelaria A Sprint 24' },
      { db }
    );
    const produto = await run(
      `INSERT INTO produtos (
         nome, unidade, tipo_operacional, controla_estoque,
         saldo_fiscal, saldo_nao_fiscal, estoque_atual, preco_venda, ativo
       ) VALUES ('Pastel sprint 24', 'UN', 'COMERCIAL', 1, 0, 100, 100, 10, 1)`
    );
    produtoId = produto.lastID;
    await EstoqueEmpresaService.criarRegistro({
      produtoId,
      empresaId: empresaA.id,
      saldo_fiscal: 0,
      saldo_nao_fiscal: 0,
      estoque_atual: 0
    }, { db });
    await definirEstoque(0, 100);
    const operador = await run(
      `INSERT INTO usuarios (username, password_hash, role, nome, perfil, ativo)
       VALUES ('op24', 'x', 'operador', 'Operador 24', 'CAIXA', 1)`
    );
    operadorId = operador.lastID;
    await run(
      `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`,
      [operadorId, empresaA.id]
    );
    tokenOperador = jwt.sign(
      { id: operadorId, usuario_id: operadorId, username: 'op24', role: 'operador', perfil: 'CAIXA' },
      getJwtSecret(),
      { expiresIn: '2h' }
    );
    const terminal = await run(`INSERT INTO terminais (nome, hostname) VALUES ('PDV-24', 'sprint24')`);
    terminalId = terminal.lastID;
    const turno = await run(
      `INSERT INTO caixa (data, valor_inicial, status, terminal_id, aberto_em, aberto_por)
       VALUES (date('now','localtime'), 0, 'aberto', ?, DATETIME('now','localtime'), ?)`,
      [terminalId, operadorId]
    );
    await run(
      `INSERT INTO caixa_sessoes (
         caixa_turno_id, terminal_id, operador_id, empresa_id, status, valor_abertura, aberto_em
       ) VALUES (?, ?, ?, ?, 'aberto', 0, DATETIME('now','localtime'))`,
      [turno.lastID, terminalId, operadorId, empresaA.id]
    );

    const app = express();
    app.use(express.json());
    const contextoEmpresa = criarMiddlewareContextoEmpresa(db);
    const aplicarModelo = middlewareAplicarPdvModeloEmpresa({ db, canalHttpVendas: true });
    app.post('/api/vendas', verificarToken, contextoEmpresa, aplicarModelo, validarCaixaSeOrigemPdv, (req, res) => {
      if (req.body && req.body.emitir_fiscal === true) emissoesFiscais.push(1);
      const ret = VendaApplicationService.criarVenda(req, res);
      if (ret && typeof ret.then === 'function') {
        ret.catch((err) => {
          if (!res.headersSent) res.status(err.statusCode || 500).json({ error: err.message, code: err.code });
        });
      }
    });
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    assert.equal(/ProgramData[\\/]MercantilFiscal/i.test(String(db.dbPath)), false);
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    console.log(`SPRINT24_RESULTADOS ${JSON.stringify({
      dbDir,
      dbPath: db.dbPath,
      autorizacoesReais: autorizacoesReais.length,
      emissoesFiscais: emissoesFiscais.length
    })}`);
  });

  it('resolver abre confirmação manual com TEF desligado, inclusive sem valor fiscal', () => {
    const cartao = fluxo.resolverFluxoPagamentoFiscal({
      modoConfirmacaoFiscal: 'TEF',
      tefHabilitado: false,
      formaPagamento: 'cartao_debito',
      ehPagamentoMisto: false,
      pagamentosMistos: [],
      totalFiscal: 0
    });
    assert.equal(cartao.deveUsarTefAutomatico, false);
    assert.equal(cartao.usarConfirmacaoManual, true);

    const dinheiro = fluxo.resolverFluxoPagamentoFiscal({
      modoConfirmacaoFiscal: 'TEF',
      tefHabilitado: false,
      formaPagamento: 'dinheiro',
      ehPagamentoMisto: false,
      pagamentosMistos: [],
      totalFiscal: 0
    });
    assert.equal(dinheiro.usarConfirmacaoManual, true);

    const tefLigadoCartao = fluxo.resolverFluxoPagamentoFiscal({
      modoConfirmacaoFiscal: 'TEF',
      tefHabilitado: true,
      formaPagamento: 'cartao_credito',
      ehPagamentoMisto: false,
      pagamentosMistos: [],
      totalFiscal: 10
    });
    assert.equal(tefLigadoCartao.deveUsarTefAutomatico, true);
    assert.equal(tefLigadoCartao.usarConfirmacaoManual, false);

    const primeiro = fluxo.consumirCliqueConfirmacao({ consumido: false });
    const segundo = fluxo.consumirCliqueConfirmacao(primeiro.estado);
    assert.equal(primeiro.aceito, true);
    assert.equal(segundo.aceito, false);
  });

  it('cartão e PIX manuais em venda não fiscal não geram NSU nem transação', async () => {
    await definirEstoque(0, 100);
    const antesNotas = await contarNotas();
    const cartao = await httpJson('POST', '/api/vendas', {
      headers: headers(),
      body: corpoVenda({
        total: 10,
        vendaFiscal: false,
        forma: 'cartao_debito',
        pagamentos: [{ forma_pagamento: 'cartao_debito', valor: 10, nsu: 'FALSO', autorizacao: 'FALSA' }]
      })
    });
    assert.equal(cartao.status, 200, JSON.stringify(cartao.body));
    const idCartao = cartao.body.id || cartao.body.venda_id;
    const vendaCartao = await get(
      `SELECT valor_fiscal, valor_nao_fiscal, empresa_id FROM vendas WHERE id = ?`,
      [idCartao]
    );
    assert.equal(Number(vendaCartao.valor_fiscal), 0);
    assert.equal(Number(vendaCartao.valor_nao_fiscal), 10);
    assert.equal(Number(vendaCartao.empresa_id), empresaA.id);
    const pagCartao = await get(
      `SELECT * FROM venda_pagamentos WHERE venda_id = ?`,
      [idCartao]
    );
    assertParcelaManual(pagCartao, 'cartao_debito', 10);

    const pix = await httpJson('POST', '/api/vendas', {
      headers: headers(),
      body: corpoVenda({
        total: 10,
        vendaFiscal: false,
        forma: 'pix',
        pagamentos: [{ forma_pagamento: 'pix', valor: 10 }]
      })
    });
    assert.equal(pix.status, 200, JSON.stringify(pix.body));
    const idPix = pix.body.id || pix.body.venda_id;
    const pagPix = await get(`SELECT * FROM venda_pagamentos WHERE venda_id = ?`, [idPix]);
    assertParcelaManual(pagPix, 'pix', 10);
    assert.equal(autorizacoesReais.length, 0);
    assert.equal(await contarNotas(), antesNotas);
  });

  it('venda fiscal manual permanece no bucket fiscal e não emite nota', async () => {
    await definirEstoque(100, 0);
    const antesNotas = await contarNotas();
    const resposta = await httpJson('POST', '/api/vendas', {
      headers: headers(),
      body: corpoVenda({
        total: 10,
        vendaFiscal: true,
        forma: 'cartao_credito',
        pagamentos: [{ forma_pagamento: 'cartao_credito', valor: 10 }]
      })
    });
    assert.equal(resposta.status, 200, JSON.stringify(resposta.body));
    const vendaId = resposta.body.id || resposta.body.venda_id;
    const venda = await get(
      `SELECT valor_fiscal, valor_nao_fiscal FROM vendas WHERE id = ?`,
      [vendaId]
    );
    assert.equal(Number(venda.valor_fiscal), 10);
    assert.equal(Number(venda.valor_nao_fiscal), 0);
    const pagamento = await get(`SELECT * FROM venda_pagamentos WHERE venda_id = ?`, [vendaId]);
    assertParcelaManual(pagamento, 'cartao_credito', 10);
    assert.equal(await contarNotas(), antesNotas);
    assert.equal(emissoesFiscais.length, 0);
    await definirEstoque(0, 100);
  });

  it('distribuidor oficial segue exclusivo e o pagamento manual não cruza os buckets', () => {
    const naoFiscal = distribuirItensVendaComValorFiscalEfetivo(
      [{
        item: item(10),
        saldoFiscal: 100,
        saldoNaoFiscal: 100
      }],
      false,
      { pagamentos: [{ forma_pagamento: 'cartao_debito', valor: 10 }], desconto: 0, acrescimo: 0 }
    );
    assert.equal(naoFiscal.sucesso, true);
    assert.equal(Number(naoFiscal.itens[0].valor_fiscal), 0);
    assert.equal(Number(naoFiscal.itens[0].valor_nao_fiscal), 10);

    const fiscal = distribuirItensVendaComValorFiscalEfetivo(
      [{
        item: item(10),
        saldoFiscal: 100,
        saldoNaoFiscal: 100
      }],
      true,
      { pagamentos: [{ forma_pagamento: 'dinheiro', valor: 10 }], desconto: 0, acrescimo: 0 }
    );
    assert.equal(fiscal.sucesso, true);
    assert.equal(Number(fiscal.itens[0].valor_fiscal), 10);
    assert.equal(Number(fiscal.itens[0].valor_nao_fiscal), 0);
  });

  it('três parcelas manuais fecham a venda e a soma divergente é recusada', async () => {
    await definirEstoque(0, 100);
    const antes = await contarVendas();
    const divergente = await httpJson('POST', '/api/vendas', {
      headers: headers(),
      body: corpoVenda({
        total: 10,
        vendaFiscal: false,
        pagamentos: [
          { forma_pagamento: 'cartao_debito', valor: 4 },
          { forma_pagamento: 'dinheiro', valor: 3 }
        ]
      })
    });
    assert.equal(divergente.status, 400, JSON.stringify(divergente.body));
    assert.match(String(divergente.body.error || ''), /soma dos pagamentos/i);
    assert.equal(await contarVendas(), antes);

    const resposta = await httpJson('POST', '/api/vendas', {
      headers: headers(),
      body: corpoVenda({
        total: 10,
        vendaFiscal: false,
        pagamentos: [
          { forma_pagamento: 'cartao_debito', valor: 4 },
          { forma_pagamento: 'cartao_credito', valor: 3 },
          { forma_pagamento: 'dinheiro', valor: 3 }
        ]
      })
    });
    assert.equal(resposta.status, 200, JSON.stringify(resposta.body));
    const vendaId = resposta.body.id || resposta.body.venda_id;
    const venda = await get(
      `SELECT total, desconto, acrescimo, valor_fiscal, valor_nao_fiscal FROM vendas WHERE id = ?`,
      [vendaId]
    );
    assert.equal(Number(venda.total), 10);
    assert.equal(Number(venda.desconto), 0);
    assert.equal(Number(venda.acrescimo), 0);
    assert.equal(Number(venda.valor_fiscal), 0);
    assert.equal(Number(venda.valor_nao_fiscal), 10);
    const parcelas = await all(
      `SELECT * FROM venda_pagamentos WHERE venda_id = ? ORDER BY id`,
      [vendaId]
    );
    assert.equal(parcelas.length, 3);
    assertParcelaManual(parcelas[0], 'cartao_debito', 4);
    assertParcelaManual(parcelas[1], 'cartao_credito', 3);
    assertParcelaManual(parcelas[2], 'dinheiro', 3);
  });

  it('sem confirmação explícita o cartão não é gravado', async () => {
    const antes = await contarVendas();
    const corpo = corpoVenda({
      total: 10,
      vendaFiscal: false,
      forma: 'cartao_debito',
      pagamentos: [{ forma_pagamento: 'cartao_debito', valor: 10 }]
    });
    delete corpo.confirmacao_fiscal_manual;
    const resposta = await httpJson('POST', '/api/vendas', { headers: headers(), body: corpo });
    assert.equal(resposta.status, 400, JSON.stringify(resposta.body));
    assert.match(String(resposta.body.error || ''), /autorização do pagamento/i);
    assert.equal(await contarVendas(), antes);
  });

  it('TEF habilitado não vira manual e parcela já aprovada não é reautorizada', async () => {
    await definirEstoque(100, 0);
    const antesAuth = autorizacoesReais.length;
    const antes = await contarVendas();
    tefLigado = true;
    const semId = await httpJson('POST', '/api/vendas', {
      headers: headers(),
      body: corpoVenda({
        total: 10,
        vendaFiscal: true,
        forma: 'cartao_credito',
        pagamentos: [{ forma_pagamento: 'cartao_credito', valor: 10 }]
      })
    });
    assert.notEqual(semId.status, 200, JSON.stringify(semId.body));
    assert.equal(autorizacoesReais.length, antesAuth + 1);
    assert.equal(await contarVendas(), antes);
    await definirEstoque(0, 100);

    const transacao = await run(`
      INSERT INTO tef_transacoes (
        venda_id, empresa_id, tipo, valor, parcelas, status, provedor, adquirente, bandeira,
        nsu, autorizacao, codigo_transacao, idempotency_key, criado_em, atualizado_em
      ) VALUES (NULL, ?, 'cartao_debito', 6, 1, 'aprovado', 'MOCK', 'MOCK', 'MOCK',
        'NSU-24', 'AUT-24', 'MOCK', 'sprint24-ja-aprovada', datetime('now'), datetime('now'))
    `, [empresaA.id]);
    const marcador = autorizacoesReais.length;
    const resposta = await httpJson('POST', '/api/vendas', {
      headers: headers(),
      body: corpoVenda({
        total: 10,
        vendaFiscal: false,
        pagamentos: [
          {
            forma_pagamento: 'cartao_debito',
            valor: 6,
            tef_transacao_id: transacao.lastID,
            nsu: 'NSU-24',
            autorizacao: 'AUT-24'
          },
          { forma_pagamento: 'dinheiro', valor: 4, confirmacao_manual: 1 }
        ]
      })
    });
    tefLigado = false;
    assert.equal(resposta.status, 200, JSON.stringify(resposta.body));
    assert.equal(autorizacoesReais.length, marcador);
    const vendaId = resposta.body.id || resposta.body.venda_id;
    const parcelas = await all(
      `SELECT * FROM venda_pagamentos WHERE venda_id = ? ORDER BY id`,
      [vendaId]
    );
    assert.equal(parcelas.length, 2);
    assert.equal(Number(parcelas[0].tef_transacao_id), transacao.lastID);
    assert.equal(parcelas[0].tef_nsu, 'NSU-24');
    assert.equal(parcelas[0].confirmacao_modalidade, 'tef');
    assert.equal(Number(parcelas[0].confirmacao_manual), 0);
    assertParcelaManual(parcelas[1], 'dinheiro', 4);
    const vinculo = await get(`SELECT venda_id FROM tef_transacoes WHERE id = ?`, [transacao.lastID]);
    assert.equal(Number(vinculo.venda_id), Number(vendaId));
  });
});
