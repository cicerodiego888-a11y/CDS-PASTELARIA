/**
 * Sprint 25 — fechamento universal do pagamento misto.
 * Banco temporário. Autorizador simulado. Sem TEF real, PIX, NFC-e, NF-e ou SEFAZ.
 *
 * Executar: node --test --test-concurrency=1 tests/pdv/sprint-25-fechamento-universal-misto.test.js
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

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-sprint25-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;
delete process.env.CDS_TEF_VINCULO_FALHA;
delete process.env.CDS_RECOMPOSICAO_HOMOLOGACAO_DISTRIBUIR;
delete process.env.CDS_RECOMPOSICAO_APLICAR_DISTRIBUICAO;

const { isolarBancoTeste } = require('../central-entradas/helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-sprint25-');
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
const PagamentoSequencial = require('../../frontend/pdv/js/pagamentoSequencial');
const {
  RECOMPOSICAO_HABILITADA_EM_PRODUCAO
} = require('../../backend/services/vendas/RecomposicaoFiscalContratoService');

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

function parcelasReferencia(extras = {}) {
  return [
    { forma_pagamento: 'cartao_debito', valor: 20, ...extras.debito },
    { forma_pagamento: 'cartao_credito', valor: 20, ...extras.credito },
    { forma_pagamento: 'dinheiro', valor: 10, confirmacao_manual: 1, ...extras.dinheiro }
  ];
}

function corpo({ vendaFiscal, pagamentos, total = 50 }) {
  return {
    origem: 'PDV',
    terminal_id: terminalId,
    venda_fiscal: vendaFiscal === true,
    emitir_fiscal: false,
    pagamento_sequencial: true,
    confirmacao_fiscal_manual: true,
    forma_pagamento: 'misto',
    desconto: 0,
    acrescimo: 0,
    total,
    valor_recebido: total,
    itens: [{
      produto_id: produtoId,
      quantidade: 1,
      preco_unitario: total,
      subtotal: total,
      tipo_venda: 'UNIDADE'
    }],
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

async function inserirTef(tipo, valor, nsu, autorizacao) {
  return run(`
    INSERT INTO tef_transacoes (
      venda_id, empresa_id, tipo, valor, parcelas, status, provedor, adquirente, bandeira,
      nsu, autorizacao, codigo_transacao, idempotency_key, criado_em, atualizado_em
    ) VALUES (NULL, ?, ?, ?, 1, 'aprovado', 'MOCK', 'MOCK', 'MOCK',
      ?, ?, 'MOCK', ?, datetime('now'), datetime('now'))
  `, [empresaA.id, tipo, valor, nsu, autorizacao, `sprint25-${nsu}`]);
}

describe('Sprint 25 — fechamento universal do pagamento misto', { concurrency: false }, () => {
  before(async () => {
    await whenReady();
    await garantirSchemaEstoqueEmpresaAsync(db);
    await garantirSchemaUsuarioEmpresasAsync(db);
    empresaA = await EmpresaService.criarEmpresa(
      { cnpj: CNPJ_A, razao_social: 'Pastelaria A Sprint 25' },
      { db }
    );
    const produto = await run(
      `INSERT INTO produtos (
         nome, unidade, tipo_operacional, controla_estoque,
         saldo_fiscal, saldo_nao_fiscal, estoque_atual, preco_venda, ativo
       ) VALUES ('Pastel sprint 25', 'UN', 'COMERCIAL', 1, 0, 100, 100, 50, 1)`
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
       VALUES ('op25', 'x', 'operador', 'Operador 25', 'CAIXA', 1)`
    );
    operadorId = operador.lastID;
    await run(
      `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`,
      [operadorId, empresaA.id]
    );
    tokenOperador = jwt.sign(
      { id: operadorId, usuario_id: operadorId, username: 'op25', role: 'operador', perfil: 'CAIXA' },
      getJwtSecret(),
      { expiresIn: '2h' }
    );
    const terminal = await run(`INSERT INTO terminais (nome, hostname) VALUES ('PDV-25', 'sprint25')`);
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
    assert.equal(RECOMPOSICAO_HABILITADA_EM_PRODUCAO, false);
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    console.log(`SPRINT25_RESULTADOS ${JSON.stringify({
      dbDir,
      dbPath: db.dbPath,
      autorizacoesReais: autorizacoesReais.length,
      emissoesFiscais: emissoesFiscais.length
    })}`);
  });

  it('A — TEF desligado grava as três parcelas manuais e mantém R$ 50', async () => {
    tefLigado = false;
    await definirEstoque(0, 100);
    const antesAuth = autorizacoesReais.length;
    const resposta = await httpJson('POST', '/api/vendas', {
      headers: headers(),
      body: corpo({
        vendaFiscal: false,
        pagamentos: parcelasReferencia({
          debito: { nsu: 'FALSO', autorizacao: 'FALSA', adquirente: 'FALSO' },
          credito: { nsu: 'FALSO', autorizacao: 'FALSA' }
        })
      })
    });
    assert.equal(resposta.status, 200, JSON.stringify(resposta.body));
    const vendaId = resposta.body.id || resposta.body.venda_id;
    const venda = await get(
      `SELECT total, valor_fiscal, valor_nao_fiscal FROM vendas WHERE id = ?`,
      [vendaId]
    );
    assert.equal(Number(venda.total), 50);
    assert.notEqual(Number(venda.valor_fiscal), 40);
    const parcelas = await all(
      `SELECT forma_pagamento, valor, tef_transacao_id, tef_nsu, tef_autorizacao, tef_adquirente,
              confirmacao_modalidade, confirmacao_manual
       FROM venda_pagamentos WHERE venda_id = ? ORDER BY id`,
      [vendaId]
    );
    assert.equal(parcelas.length, 3);
    assert.deepEqual(parcelas.map((p) => Number(p.valor)), [20, 20, 10]);
    parcelas.forEach((parcela) => {
      assert.equal(parcela.confirmacao_modalidade, 'manual');
      assert.equal(Number(parcela.confirmacao_manual), 1);
      assert.equal(parcela.tef_transacao_id, null);
      assert.equal(parcela.tef_nsu, null);
      assert.equal(parcela.tef_autorizacao, null);
      assert.equal(parcela.tef_adquirente, null);
    });
    assert.equal(autorizacoesReais.length, antesAuth);
  });

  it('B e D — TEF ligado preserva as autorizações e não reautoriza no fechamento', async () => {
    tefLigado = true;
    await definirEstoque(0, 100);
    const debito = await inserirTef('cartao_debito', 20, 'NSU-DEB-25', 'AUT-DEB-25');
    const credito = await inserirTef('cartao_credito', 20, 'NSU-CRED-25', 'AUT-CRED-25');
    const antesAuth = autorizacoesReais.length;
    const lista = parcelasReferencia({
      debito: { tef_transacao_id: debito.lastID, nsu: 'NSU-DEB-25', autorizacao: 'AUT-DEB-25', status_autorizacao: 'aprovada', aprovado: true },
      credito: { tef_transacao_id: credito.lastID, nsu: 'NSU-CRED-25', autorizacao: 'AUT-CRED-25', status_autorizacao: 'aprovada', aprovado: true }
    });
    const chamadas = [];
    const fechadas = await PagamentoSequencial.autorizarParcelasPendentes(lista, {
      tefHabilitado: true,
      formaUsaTef: (forma) => forma !== 'dinheiro',
      autorizarTef: async () => {
        chamadas.push('reautorizacao');
        return { aprovado: true, transacao_id: 999, nsu: 'NOVO', autorizacao: 'NOVO' };
      }
    });
    assert.equal(chamadas.length, 0);
    assert.equal(fechadas[0].tef_transacao_id, debito.lastID);
    assert.equal(fechadas[1].tef_transacao_id, credito.lastID);
    assert.equal(fechadas.length, 3);

    const resposta = await httpJson('POST', '/api/vendas', {
      headers: headers(),
      body: corpo({ vendaFiscal: false, pagamentos: lista })
    });
    tefLigado = false;
    assert.equal(resposta.status, 200, JSON.stringify(resposta.body));
    assert.equal(autorizacoesReais.length, antesAuth);
    const vendaId = resposta.body.id || resposta.body.venda_id;
    const parcelas = await all(
      `SELECT forma_pagamento, valor, tef_transacao_id, tef_nsu, tef_autorizacao, confirmacao_modalidade
       FROM venda_pagamentos WHERE venda_id = ? ORDER BY id`,
      [vendaId]
    );
    assert.equal(parcelas.length, 3);
    assert.equal(Number(parcelas[0].tef_transacao_id), debito.lastID);
    assert.equal(parcelas[0].tef_nsu, 'NSU-DEB-25');
    assert.equal(parcelas[0].confirmacao_modalidade, 'tef');
    assert.equal(Number(parcelas[1].tef_transacao_id), credito.lastID);
    assert.equal(parcelas[1].confirmacao_modalidade, 'tef');
    assert.equal(parcelas[2].forma_pagamento, 'dinheiro');
    assert.equal(parcelas[2].confirmacao_modalidade, 'manual');
    assert.equal(parcelas[2].tef_nsu, null);
    const venda = await get(`SELECT total, valor_fiscal FROM vendas WHERE id = ?`, [vendaId]);
    assert.equal(Number(venda.total), 50);
    assert.notEqual(Number(venda.valor_fiscal), 40);
  });

  it('C — valor fiscal positivo não substitui a lista sequencial', async () => {
    tefLigado = true;
    await definirEstoque(100, 0);
    const debito = await inserirTef('cartao_debito', 20, 'NSU-DEB-25F', 'AUT-DEB-25F');
    const credito = await inserirTef('cartao_credito', 20, 'NSU-CRED-25F', 'AUT-CRED-25F');
    const antesAuth = autorizacoesReais.length;
    const lista = parcelasReferencia({
      debito: { tef_transacao_id: debito.lastID, nsu: 'NSU-DEB-25F', autorizacao: 'AUT-DEB-25F', status_autorizacao: 'aprovada', aprovado: true },
      credito: { tef_transacao_id: credito.lastID, nsu: 'NSU-CRED-25F', autorizacao: 'AUT-CRED-25F', status_autorizacao: 'aprovada', aprovado: true }
    });
    const resolvido = fluxo.resolverFluxoPagamentoFiscal({
      modoConfirmacaoFiscal: 'TEF',
      tefHabilitado: true,
      formaPagamento: 'misto',
      ehPagamentoMisto: true,
      pagamentosMistos: lista,
      totalFiscal: 50
    });
    const ramo = fluxo.ramoFechamentoPagamento({
      ...resolvido,
      totalFiscal: 50,
      ehPagamentoMisto: true
    });
    assert.equal(ramo, 'lista_sequencial');

    const resposta = await httpJson('POST', '/api/vendas', {
      headers: headers(),
      body: corpo({ vendaFiscal: true, pagamentos: lista })
    });
    tefLigado = false;
    assert.equal(resposta.status, 200, JSON.stringify(resposta.body));
    assert.equal(autorizacoesReais.length, antesAuth);
    const vendaId = resposta.body.id || resposta.body.venda_id;
    const venda = await get(
      `SELECT total, valor_fiscal, valor_nao_fiscal FROM vendas WHERE id = ?`,
      [vendaId]
    );
    assert.equal(Number(venda.total), 50);
    assert.equal(Number(venda.valor_fiscal), 0);
    assert.equal(Number(venda.valor_nao_fiscal), 50);
    assert.notEqual(Number(venda.valor_fiscal), 40);
    assert.equal(resposta.body.documento_fiscal && resposta.body.documento_fiscal.bloqueado, true);
    const recebimentos = await all(
      `SELECT forma_pagamento, tipo_recebimento FROM venda_recebimentos WHERE venda_id = ?`,
      [vendaId]
    );
    const tipoPorForma = Object.fromEntries(recebimentos.map((linha) => [linha.forma_pagamento, linha.tipo_recebimento]));
    assert.equal(tipoPorForma.cartao_debito, 'fiscal');
    assert.equal(tipoPorForma.cartao_credito, 'fiscal');
    assert.equal(tipoPorForma.dinheiro, 'nao_fiscal');
    const parcelas = await all(
      `SELECT forma_pagamento, valor, tef_transacao_id, confirmacao_modalidade
       FROM venda_pagamentos WHERE venda_id = ? ORDER BY id`,
      [vendaId]
    );
    assert.equal(parcelas.length, 3);
    assert.deepEqual(parcelas.map((p) => p.forma_pagamento), ['cartao_debito', 'cartao_credito', 'dinheiro']);
    assert.equal(parcelas[0].confirmacao_modalidade, 'tef');
    assert.equal(parcelas[2].confirmacao_modalidade, 'manual');
    await definirEstoque(0, 100);
  });

  it('E e F — rejeição e timeout não apagam nem aprovam a parcela nova', async () => {
    PagamentoSequencial.reset();
    const debito = await PagamentoSequencial.adicionar({
      forma: 'cartao_debito',
      valor: 20,
      totalVenda: 50,
      formaUsaTef: () => true,
      autorizarTef: async () => ({ aprovado: true, status: 'aprovado', transacao_id: 21, nsu: 'NSU-21', autorizacao: 'AUT-21' })
    });
    assert.equal(debito.ok, true);
    const rejeitada = await PagamentoSequencial.adicionar({
      forma: 'cartao_credito',
      valor: 20,
      totalVenda: 50,
      formaUsaTef: () => true,
      autorizarTef: async () => ({ aprovado: false, status: 'negado' })
    });
    assert.equal(rejeitada.ok, false);
    assert.equal(rejeitada.codigo, 'TEF_REJEITADO');
    assert.equal(PagamentoSequencial.snapshot().length, 1);
    assert.equal(PagamentoSequencial.snapshot()[0].tef_transacao_id, 21);
    assert.notEqual(rejeitada.parcela.status_autorizacao, 'aprovada');

    const timeout = await PagamentoSequencial.adicionar({
      forma: 'cartao_credito',
      valor: 20,
      totalVenda: 50,
      formaUsaTef: () => true,
      autorizarTef: async () => { throw new Error('timeout de comunicação'); }
    });
    assert.equal(timeout.ok, false);
    assert.equal(timeout.codigo, 'TEF_FALHA');
    assert.equal(timeout.parcela.status_autorizacao, 'falha');
    assert.notEqual(timeout.parcela.status_autorizacao, 'aprovada');
    assert.equal(PagamentoSequencial.snapshot().length, 1);
  });

  it('G — soma divergente responde 400 e não grava', async () => {
    tefLigado = false;
    const antes = await contarVendas();
    const resposta = await httpJson('POST', '/api/vendas', {
      headers: headers(),
      body: corpo({
        vendaFiscal: false,
        total: 50,
        pagamentos: [
          { forma_pagamento: 'cartao_debito', valor: 20 },
          { forma_pagamento: 'dinheiro', valor: 10 }
        ]
      })
    });
    assert.equal(resposta.status, 400, JSON.stringify(resposta.body));
    assert.equal(resposta.body.codigo, 'SOMA_PAGAMENTOS_DIVERGENTE');
    assert.equal(await contarVendas(), antes);
  });

  it('H e I — a consulta lê as três parcelas e o segundo uso da transação não duplica a venda', async () => {
    const venda = await get(
      `SELECT id FROM vendas WHERE total = 50 ORDER BY id DESC LIMIT 1`
    );
    const parcelas = await all(
      `SELECT forma_pagamento, valor, tef_transacao_id, confirmacao_modalidade
       FROM venda_pagamentos WHERE venda_id = ? ORDER BY id`,
      [venda.id]
    );
    assert.equal(parcelas.length, 3);
    assert.equal(parcelas.filter((p) => p.confirmacao_modalidade === 'tef').length >= 1, true);

    const primeiro = fluxo.consumirCliqueConfirmacao({ consumido: false });
    const segundo = fluxo.consumirCliqueConfirmacao(primeiro.estado);
    assert.equal(primeiro.aceito, true);
    assert.equal(segundo.aceito, false);

    tefLigado = true;
    const antes = await contarVendas();
    const debito = await get(
      `SELECT tef_transacao_id FROM venda_pagamentos
       WHERE forma_pagamento = 'cartao_debito' AND tef_transacao_id IS NOT NULL
       ORDER BY id DESC LIMIT 1`
    );
    const credito = await get(
      `SELECT tef_transacao_id FROM venda_pagamentos
       WHERE forma_pagamento = 'cartao_credito' AND tef_transacao_id IS NOT NULL
       ORDER BY id DESC LIMIT 1`
    );
    const repetida = await httpJson('POST', '/api/vendas', {
      headers: headers(),
      body: corpo({
        vendaFiscal: false,
        pagamentos: parcelasReferencia({
          debito: { tef_transacao_id: debito.tef_transacao_id, status_autorizacao: 'aprovada', aprovado: true },
          credito: { tef_transacao_id: credito.tef_transacao_id, status_autorizacao: 'aprovada', aprovado: true }
        })
      })
    });
    tefLigado = false;
    assert.notEqual(repetida.status, 200, JSON.stringify(repetida.body));
    assert.equal(await contarVendas(), antes);
    assert.equal(emissoesFiscais.length, 0);
  });
});
