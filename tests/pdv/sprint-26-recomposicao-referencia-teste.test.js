/**
 * Sprint 26 — referência de recomposição somente no ambiente de teste.
 * Banco temporário. Sem TEF real, PIX, NFC-e, NF-e ou SEFAZ.
 *
 * Executar: node --test --test-concurrency=1 tests/pdv/sprint-26-recomposicao-referencia-teste.test.js
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

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-sprint26-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
process.env.CDS_RECOMPOSICAO_REFERENCIA_TESTE = '1';
// Regressão Sprint 26: isola a porta de teste original (sem fechamento operacional ATIVACAO-01).
process.env.CDS_RECOMPOSICAO_FECHAMENTO_OPERACIONAL = '0';
delete process.env.CDS_ALLOW_OFFICIAL_DB;
delete process.env.CDS_TEF_VINCULO_FALHA;
delete process.env.CDS_RECOMPOSICAO_HOMOLOGACAO_DISTRIBUIR;
delete process.env.CDS_RECOMPOSICAO_APLICAR_DISTRIBUICAO;
delete process.env.CDS_RECOMPOSICAO_HOMOLOGACAO;
delete process.env.CDS_RECOMPOSICAO_DIAGNOSTICO;

const { isolarBancoTeste } = require('../central-entradas/helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-sprint26-');
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
const {
  RECOMPOSICAO_HABILITADA_EM_PRODUCAO
} = require('../../backend/services/vendas/RecomposicaoFiscalContratoService');
const {
  avaliarReferenciaRecomposicao,
  marcarParcelaEletronicaComprovada
} = require('../../backend/services/vendas/PagamentoSequencialComposicaoService');
const { formaPagamentoUsaTEF } = require('../../backend/services/tef/tefFluxoPagamento');
const PagamentoSequencial = require('../../frontend/pdv/js/pagamentoSequencial');

const autorizacoesReais = [];
const emissoesFiscais = [];
configService.getModoConfirmacaoFiscal = function modoTef() { return 'TEF'; };
tefConfigService.obterConfiguracao = async function cfg() { return { tefHabilitado: false, pix: false }; };
tefManager.autorizar = async function bloqueada() {
  autorizacoesReais.push(1);
  const err = new Error('TEF_REAL_BLOQUEADO');
  err.code = 'TEF_REAL_BLOQUEADO';
  throw err;
};

let empresaA;
let produtoId;
let tokenOperador;
let operadorId;
let terminalId;
let server;

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
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
function httpJson(urlPath, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path: urlPath,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenOperador}`,
        'X-Empresa-Id': String(empresaA.id),
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const texto = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = texto ? JSON.parse(texto) : null; } catch (_) { parsed = { bruto: texto }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}
function enriquecerPagamentoReferencia(pagamento, indice) {
  const forma = String(pagamento.forma_pagamento || '').toLowerCase();
  const dinheiro = forma === 'dinheiro' || forma === 'especie' || forma === 'cash';
  if (dinheiro) {
    return {
      ...pagamento,
      status_autorizacao: pagamento.status_autorizacao || 'informada',
      confirmacao_manual: pagamento.confirmacao_manual != null ? pagamento.confirmacao_manual : 1,
      tipo_recebimento: 'nao_fiscal'
    };
  }
  return {
    ...pagamento,
    status_autorizacao: pagamento.status_autorizacao || 'aprovada',
    nsu: pagamento.nsu || `NSU-26-${indice}`,
    autorizacao: pagamento.autorizacao || `AUT-26-${indice}`,
    tipo_recebimento: pagamento.tipo_recebimento || 'fiscal'
  };
}

function corpo(pagamentos, total, extra = {}) {
  const lista = (pagamentos || []).map((pagamento, indice) => enriquecerPagamentoReferencia(pagamento, indice));
  return {
    origem: 'PDV',
    terminal_id: terminalId,
    venda_fiscal: false,
    emitir_fiscal: false,
    pagamento_sequencial: extra.sequencial !== false,
    confirmacao_fiscal_manual: true,
    forma_pagamento: extra.forma || (lista.length > 1 ? 'misto' : lista[0].forma_pagamento),
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
    pagamentos: lista
  };
}
async function garantirTefParaPagamentos(lista) {
  const saida = [];
  for (const pagamento of lista || []) {
    if (!formaPagamentoUsaTEF(pagamento.forma_pagamento)) {
      saida.push(pagamento);
      continue;
    }
    const status = String(pagamento.status_autorizacao || pagamento.status || '').toLowerCase();
    if (status !== 'aprovada' && status !== 'aprovado') {
      saida.push(pagamento);
      continue;
    }
    const tipo = String(pagamento.forma_pagamento).includes('credito')
      ? 'cartao_credito'
      : (String(pagamento.forma_pagamento).includes('debito') ? 'cartao_debito' : 'pix_tef');
    const nsu = pagamento.nsu || `NSU-26-${Date.now()}-${saida.length}`;
    const aut = pagamento.autorizacao || `AUT-26-${Date.now()}-${saida.length}`;
    const row = await run(
      `INSERT INTO tef_transacoes (
         venda_id, empresa_id, operador_id, tipo, valor, status, provedor, nsu, autorizacao
       ) VALUES (NULL, ?, ?, ?, ?, 'aprovado', 'SITEF', ?, ?)`,
      [empresaA.id, operadorId, tipo, Number(pagamento.valor), nsu, aut]
    );
    saida.push({
      ...pagamento,
      tef_transacao_id: row.lastID,
      nsu,
      autorizacao: aut
    });
  }
  return saida;
}

async function vender(pagamentos, total, extra) {
  const enriquecidos = (pagamentos || []).map((pagamento, indice) => enriquecerPagamentoReferencia(pagamento, indice));
  const comTef = await garantirTefParaPagamentos(enriquecidos);
  const corpoReq = corpo(comTef, total, { ...(extra || {}), _jaEnriquecido: true });
  // corpo() re-enriquece; passar já com tef ids via override
  corpoReq.pagamentos = comTef;
  const resposta = await httpJson('/api/vendas', corpoReq);
  assert.equal(resposta.status, 200, JSON.stringify(resposta.body));
  const vendaId = resposta.body.id || resposta.body.venda_id;
  const venda = await get(
    `SELECT total, valor_fiscal, valor_nao_fiscal FROM vendas WHERE id = ?`,
    [vendaId]
  );
  const referencia = await get(
    `SELECT total_financeiro, dinheiro_recebido, valor_fiscal_referencia,
            valor_nao_fiscal_referencia, motor_codigo, aplica_ao_fluxo_oficial,
            distribuicao_oficial_alterada
     FROM venda_composicao_referencia WHERE venda_id = ?`,
    [vendaId]
  ).catch(() => null);
  const parcelas = await get(
    `SELECT COUNT(*) AS n, SUM(valor) AS soma FROM venda_pagamentos WHERE venda_id = ?`,
    [vendaId]
  );
  return { vendaId, venda, referencia, parcelas };
}

describe('Sprint 26 — recomposição de referência em teste', { concurrency: false }, () => {
  before(async () => {
    await whenReady();
    await garantirSchemaEstoqueEmpresaAsync(db);
    await garantirSchemaUsuarioEmpresasAsync(db);
    empresaA = await EmpresaService.criarEmpresa(
      { cnpj: '11222333000181', razao_social: 'Pastelaria Sprint 26' },
      { db }
    );
    const produto = await run(
      `INSERT INTO produtos (
         nome, unidade, tipo_operacional, controla_estoque,
         saldo_fiscal, saldo_nao_fiscal, estoque_atual, preco_venda, ativo
       ) VALUES ('Pastel sprint 26', 'UN', 'COMERCIAL', 1, 0, 100, 100, 10, 1)`
    );
    produtoId = produto.lastID;
    await EstoqueEmpresaService.criarRegistro({
      produtoId, empresaId: empresaA.id, saldo_fiscal: 0, saldo_nao_fiscal: 100, estoque_atual: 100
    }, { db });
    const operador = await run(
      `INSERT INTO usuarios (username, password_hash, role, nome, perfil, ativo)
       VALUES ('op26', 'x', 'operador', 'Operador 26', 'CAIXA', 1)`
    );
    operadorId = operador.lastID;
    await run(
      `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`,
      [operadorId, empresaA.id]
    );
    tokenOperador = jwt.sign(
      { id: operadorId, usuario_id: operadorId, username: 'op26', role: 'operador', perfil: 'CAIXA' },
      getJwtSecret(),
      { expiresIn: '2h' }
    );
    const terminal = await run(`INSERT INTO terminais (nome, hostname) VALUES ('PDV-26', 'sprint26')`);
    terminalId = terminal.lastID;
    const turno = await run(
      `INSERT INTO caixa (data, valor_inicial, status, terminal_id, aberto_em, aberto_por)
       VALUES (date('now','localtime'), 0, 'aberto', ?, DATETIME('now','localtime'), ?)`,
      [terminalId, operador.lastID]
    );
    await run(
      `INSERT INTO caixa_sessoes (
         caixa_turno_id, terminal_id, operador_id, empresa_id, status, valor_abertura, aberto_em
       ) VALUES (?, ?, ?, ?, 'aberto', 0, DATETIME('now','localtime'))`,
      [turno.lastID, terminalId, operador.lastID, empresaA.id]
    );
    const app = express();
    app.use(express.json());
    const contexto = criarMiddlewareContextoEmpresa(db);
    const modelo = middlewareAplicarPdvModeloEmpresa({ db, canalHttpVendas: true });
    app.post('/api/vendas', verificarToken, contexto, modelo, validarCaixaSeOrigemPdv, (req, res) => {
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
    assert.equal(RECOMPOSICAO_HABILITADA_EM_PRODUCAO, false);
    assert.equal(/ProgramData[\\/]MercantilFiscal/i.test(String(db.dbPath)), false);
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    console.log(`SPRINT26_RESULTADOS ${JSON.stringify({
      dbDir,
      dbPath: db.dbPath,
      autorizacoesReais: autorizacoesReais.length,
      emissoesFiscais: emissoesFiscais.length,
      producao: RECOMPOSICAO_HABILITADA_EM_PRODUCAO
    })}`);
  });

  it('A B C D — eletrônico confirmado fica na referência fiscal', async () => {
    const casos = [
      [[{ forma_pagamento: 'cartao_debito', valor: 10 }], 10],
      [[{ forma_pagamento: 'cartao_credito', valor: 10 }], 10],
      [[{ forma_pagamento: 'pix', valor: 10 }], 10],
      [[
        { forma_pagamento: 'cartao_debito', valor: 4 },
        { forma_pagamento: 'cartao_credito', valor: 3 },
        { forma_pagamento: 'pix', valor: 3 }
      ], 10]
    ];
    for (const [pagamentos, total] of casos) {
      const r = await vender(pagamentos, total);
      assert.equal(Number(r.venda.total), total);
      assert.equal(Number(r.referencia.valor_fiscal_referencia), total);
      assert.equal(Number(r.referencia.valor_nao_fiscal_referencia), 0);
      assert.equal(Number(r.parcelas.n), pagamentos.length);
      assert.equal(Number(r.venda.valor_fiscal), 0);
    }
  });

  it('seis exemplos da referência por forma confirmada', async () => {
    const exemplos = [
      {
        pagamentos: [
          { forma_pagamento: 'cartao_debito', valor: 10 },
          { forma_pagamento: 'cartao_credito', valor: 10 }
        ],
        total: 20,
        fiscal: 20,
        naoFiscal: 0
      },
      {
        pagamentos: [
          { forma_pagamento: 'cartao_debito', valor: 30 },
          { forma_pagamento: 'dinheiro', valor: 20 }
        ],
        total: 50,
        fiscal: 30,
        naoFiscal: 20
      },
      {
        pagamentos: [
          { forma_pagamento: 'dinheiro', valor: 15 },
          { forma_pagamento: 'pix', valor: 25 }
        ],
        total: 40,
        fiscal: 25,
        naoFiscal: 15
      },
      {
        pagamentos: [
          { forma_pagamento: 'pix', valor: 30 },
          { forma_pagamento: 'cartao_credito', valor: 20 }
        ],
        total: 50,
        fiscal: 50,
        naoFiscal: 0
      },
      {
        pagamentos: [{ forma_pagamento: 'dinheiro', valor: 15 }],
        total: 15,
        fiscal: 0,
        naoFiscal: 15,
        extra: { sequencial: false, forma: 'dinheiro' }
      },
      {
        pagamentos: [{ forma_pagamento: 'pix', valor: 50 }],
        total: 50,
        fiscal: 50,
        naoFiscal: 0
      }
    ];
    for (const exemplo of exemplos) {
      const r = await vender(exemplo.pagamentos, exemplo.total, exemplo.extra);
      assert.equal(Number(r.referencia.valor_fiscal_referencia), exemplo.fiscal);
      assert.equal(Number(r.referencia.valor_nao_fiscal_referencia), exemplo.naoFiscal);
      assert.equal(
        Number(r.referencia.valor_fiscal_referencia) + Number(r.referencia.valor_nao_fiscal_referencia),
        exemplo.total
      );
      assert.equal(Number(r.venda.total), exemplo.total);
      assert.equal(Number(r.venda.valor_fiscal), 0);
      assert.equal(Number(r.parcelas.n), exemplo.pagamentos.length);
    }
  });

  it('parcela rejeitada ou pendente não entra na referência', () => {
    const resultado = avaliarReferenciaRecomposicao({
      total: 40,
      pagamentos: [
        marcarParcelaEletronicaComprovada({
          forma_pagamento: 'cartao_debito',
          valor: 20,
          status_autorizacao: 'aprovada',
          nsu: 'NSU-OK',
          autorizacao: 'AUT-OK'
        }),
        { forma_pagamento: 'cartao_credito', valor: 10, status_autorizacao: 'rejeitada' },
        { forma_pagamento: 'pix', valor: 10, status_autorizacao: 'pendente' }
      ]
    });
    assert.equal(resultado.valor_fiscal_referencia, 20);
    assert.equal(resultado.valor_nao_fiscal_referencia, 0);
    assert.equal(resultado.recomposicao_habilitada_em_producao, false);
    assert.equal(resultado.aplica_ao_fluxo_oficial, false);
  });

  it('E F G H — dinheiro gera a referência e preserva as parcelas', async () => {
    const casos = [
      {
        pagamentos: [{ forma_pagamento: 'dinheiro', valor: 10 }],
        total: 10,
        fiscal: 0,
        naoFiscal: 10,
        extra: { sequencial: false, forma: 'dinheiro' }
      },
      {
        pagamentos: [
          { forma_pagamento: 'cartao_debito', valor: 6 },
          { forma_pagamento: 'dinheiro', valor: 4 }
        ],
        total: 10,
        fiscal: 6,
        naoFiscal: 4
      },
      {
        pagamentos: [
          { forma_pagamento: 'pix', valor: 7 },
          { forma_pagamento: 'dinheiro', valor: 3 }
        ],
        total: 10,
        fiscal: 7,
        naoFiscal: 3
      },
      {
        pagamentos: [
          { forma_pagamento: 'cartao_debito', valor: 2 },
          { forma_pagamento: 'cartao_credito', valor: 3 },
          { forma_pagamento: 'pix', valor: 1 },
          { forma_pagamento: 'dinheiro', valor: 4 }
        ],
        total: 10,
        fiscal: 6,
        naoFiscal: 4
      }
    ];
    for (const caso of casos) {
      const r = await vender(caso.pagamentos, caso.total, caso.extra);
      assert.equal(Number(r.venda.total), caso.total);
      assert.equal(Number(r.venda.valor_fiscal), 0);
      assert.equal(Number(r.referencia.valor_fiscal_referencia), caso.fiscal);
      assert.equal(Number(r.referencia.valor_nao_fiscal_referencia), caso.naoFiscal);
      assert.equal(Number(r.referencia.aplica_ao_fluxo_oficial), 0);
      assert.equal(Number(r.referencia.distribuicao_oficial_alterada), 0);
      assert.equal(r.referencia.motor_codigo, 'COMPOSICAO_AUSENTE_NO_MOTOR');
      assert.equal(Number(r.parcelas.n), caso.pagamentos.length);
      assert.equal(Number(r.parcelas.soma), caso.total);
    }
  });

  it('I — R$ 50 com débito, crédito e dinheiro gera referência 40 e 10', async () => {
    const r = await vender([
      { forma_pagamento: 'cartao_debito', valor: 20 },
      { forma_pagamento: 'cartao_credito', valor: 20 },
      { forma_pagamento: 'dinheiro', valor: 10 }
    ], 50);
    assert.equal(Number(r.venda.total), 50);
    assert.equal(Number(r.venda.valor_fiscal), 0);
    assert.equal(Number(r.venda.valor_nao_fiscal), 50);
    assert.equal(Number(r.referencia.total_financeiro), 50);
    assert.equal(Number(r.referencia.valor_fiscal_referencia), 40);
    assert.equal(Number(r.referencia.valor_nao_fiscal_referencia), 10);
    assert.equal(Number(r.referencia.distribuicao_oficial_alterada), 0);
    assert.equal(Number(r.parcelas.n), 3);
    assert.equal(autorizacoesReais.length, 0);
  });

  it('J — soma divergente bloqueia o fechamento e não grava referência', async () => {
    const antes = await get(`SELECT COUNT(*) AS n FROM vendas`);
    const resposta = await httpJson('/api/vendas', corpo([
      { forma_pagamento: 'cartao_debito', valor: 20 },
      { forma_pagamento: 'dinheiro', valor: 10 }
    ], 50));
    assert.equal(resposta.status, 400);
    assert.equal(resposta.body.codigo, 'SOMA_PAGAMENTOS_DIVERGENTE');
    const depois = await get(`SELECT COUNT(*) AS n FROM vendas`);
    assert.equal(Number(depois.n), Number(antes.n));
  });

  it('K e L — rejeição, timeout e parcela já aprovada', async () => {
    PagamentoSequencial.reset();
    const aprovada = await PagamentoSequencial.adicionar({
      forma: 'cartao_debito',
      valor: 20,
      totalVenda: 50,
      formaUsaTef: () => true,
      autorizarTef: async () => ({ aprovado: true, status: 'aprovado', transacao_id: 26, nsu: 'NSU-26', autorizacao: 'AUT-26' })
    });
    assert.equal(aprovada.ok, true);
    const rejeitada = await PagamentoSequencial.adicionar({
      forma: 'cartao_credito',
      valor: 20,
      totalVenda: 50,
      formaUsaTef: () => true,
      autorizarTef: async () => ({ aprovado: false, status: 'negado' })
    });
    assert.equal(rejeitada.codigo, 'TEF_REJEITADO');
    assert.notEqual(rejeitada.parcela.status_autorizacao, 'aprovada');
    const timeout = await PagamentoSequencial.adicionar({
      forma: 'cartao_credito',
      valor: 20,
      totalVenda: 50,
      formaUsaTef: () => true,
      autorizarTef: async () => { throw new Error('timeout de comunicação'); }
    });
    assert.equal(timeout.codigo, 'TEF_FALHA');
    assert.equal(timeout.parcela.status_autorizacao, 'falha');
    assert.equal(PagamentoSequencial.snapshot().length, 1);
    const repetidas = [];
    await PagamentoSequencial.autorizarParcelasPendentes(PagamentoSequencial.exportar(), {
      tefHabilitado: true,
      formaUsaTef: () => true,
      autorizarTef: async () => {
        repetidas.push(1);
        return { aprovado: true, transacao_id: 99 };
      }
    });
    assert.equal(repetidas.length, 0);
    assert.equal(PagamentoSequencial.snapshot()[0].tef_transacao_id, 26);
  });

  it('produção continua desligada mesmo com dinheiro na venda', async () => {
    delete process.env.CDS_RECOMPOSICAO_REFERENCIA_TESTE;
    const semAmbiente = await avaliarReferenciaRecomposicao({
      total: 50,
      pagamentos: [
        { forma_pagamento: 'cartao_debito', valor: 20 },
        { forma_pagamento: 'cartao_credito', valor: 20 },
        { forma_pagamento: 'dinheiro', valor: 10 }
      ]
    });
    assert.equal(semAmbiente.recomposicao_executada, false);
    assert.equal(semAmbiente.valor_fiscal_referencia, null);
    assert.equal(RECOMPOSICAO_HABILITADA_EM_PRODUCAO, false);
    const antes = await get(`SELECT COUNT(*) AS n FROM venda_composicao_referencia`);
    const resposta = await httpJson('/api/vendas', corpo([
      { forma_pagamento: 'dinheiro', valor: 8 }
    ], 8, { sequencial: false, forma: 'dinheiro' }));
    process.env.CDS_RECOMPOSICAO_REFERENCIA_TESTE = '1';
    assert.equal(resposta.status, 200, JSON.stringify(resposta.body));
    const depois = await get(`SELECT COUNT(*) AS n FROM venda_composicao_referencia`);
    assert.equal(Number(depois.n), Number(antes.n));
    const vendaId = resposta.body.id || resposta.body.venda_id;
    const venda = await get(`SELECT total, valor_fiscal FROM vendas WHERE id = ?`, [vendaId]);
    assert.equal(Number(venda.total), 8);
    assert.equal(Number(venda.valor_fiscal), 0);
    assert.equal(emissoesFiscais.length, 0);
  });
});
