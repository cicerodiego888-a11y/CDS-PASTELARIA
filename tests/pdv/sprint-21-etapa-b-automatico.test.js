/**
 * Sprint 21 — Etapa B. Fechamento automático do PDV.
 * Banco temporário (DB_DIR) antes de database.js. TEF real bloqueado.
 * emitir_fiscal permanece false na gravação. Sem SEFAZ, sem adquirente.
 *
 * Executar: node --test --test-concurrency=1 tests/pdv/sprint-21-etapa-b-automatico.test.js
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

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-sprint21b-'));
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
      const err = new Error('SEFAZ bloqueada na homologação da Etapa B.');
      err.code = 'SEFAZ_BLOQUEADA';
      throw err;
    }
  }
};

const { isolarBancoTeste } = require('../central-entradas/helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-sprint21b-');
const db = require('../../backend/database');
isolamento.comprobar(db);

const tefManager = require('../../backend/services/tef/TefManager');
const tefService = require('../../backend/services/tef');
const tefConfigService = require('../../backend/services/tef/tefConfigService');
const tefContrato = require('../../backend/services/tef/tefContrato');
const configService = require('../../backend/services/configuracaoService');
const { getJwtSecret } = require('../../backend/config/secrets');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const { verificarToken } = require('../../backend/middleware/auth');
const { validarCaixaAberto, validarCaixaSeOrigemPdv } = require('../../backend/middleware/validarCaixaAberto');
const { criarMiddlewareContextoEmpresa } = require('../../backend/services/fiscalNaoFiscal/empresaContexto');
const { middlewareAplicarPdvModeloEmpresa } = require('../../backend/services/pdv/PdvModeloEmpresaService');
const VendaApplicationService = require('../../backend/services/vendas/VendaApplicationService');
const { preCalcularDistribuicao } = require('../../backend/services/vendas/VendaPagamentoService');
const tefRouter = require('../../backend/rotas/tef');
const configRouter = require('../../backend/rotas/configuracoes_avancadas');

const CNPJ_A = '11222333000181';
const CNPJ_B = '11222333000262';
const PDV_JS = path.join(__dirname, '../../frontend/pdv/js/pdv.js');
const TEF_JS = path.join(__dirname, '../../frontend/shared/js/tefFluxoPagamento.js');

const autorizacoesReais = [];
const pagamentosMock = [];
const controle = {
  tefModo: 'aprovar',
  backendTef: 'on',
  falhaFluxo: false,
  falhaConfirmacao: false,
  atrasoTefMs: 0,
  ultimaAprovada: null,
  modoConfirmacaoFiscal: 'TEF'
};

tefManager.autorizar = async function autorizarBloqueada(dados) {
  autorizacoesReais.push({
    tipo: dados && dados.tipo,
    valor: dados && dados.valor,
    idempotency_key: dados && dados.idempotency_key
  });
  const err = new Error('TEF_REAL_BLOQUEADO');
  err.code = 'TEF_REAL_BLOQUEADO';
  throw err;
};
tefManager.cancelar = async function cancelarBloqueado() {
  return { sucesso: true, simulado: true };
};

const readConfigOriginal = configService.readConfig.bind(configService);
configService.readConfig = function readConfigHomologacao() {
  const cfg = readConfigOriginal();
  return {
    ...cfg,
    modo_operacional_global: 'MULTIEMPRESA',
    pdv_modelo_empresa: 'MULTIPLAS',
    pdv_empresa_id: null,
    modo_confirmacao_fiscal: controle.modoConfirmacaoFiscal || 'TEF'
  };
};

const obterConfigOriginal = tefConfigService.obterConfiguracao.bind(tefConfigService);
tefConfigService.obterConfiguracao = async function obterConfiguracaoHomologacao() {
  if (controle.backendTef === 'real') return obterConfigOriginal();
  if (controle.backendTef === 'off') return { tefHabilitado: false, pix: false };
  return { tefHabilitado: true, pix: false };
};

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

function httpJson(server, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
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
        resolve({ status: res.statusCode, body: json, raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function extrairFuncao(src, nome) {
  const inicio = src.search(new RegExp(`^(?:async )?function ${nome}\\(`, 'm'));
  if (inicio < 0) throw new Error(`função ${nome} não encontrada em pdv.js`);
  const resto = src.slice(inicio);
  const fim = resto.search(/^\}\r?$/m);
  if (fim < 0) throw new Error(`fim da função ${nome} não encontrado`);
  return resto.slice(0, fim + 1);
}

function respostaAprovada(id, extra = {}) {
  return {
    sucesso: true,
    aprovado: true,
    status: 'aprovado',
    transacao_id: id,
    transacaoId: String(id),
    nsu: `NSU-MOCK-${id}`,
    autorizacao: `AUT-MOCK-${id}`,
    bandeira: 'MOCK',
    adquirente: 'MOCK',
    mensagem: 'Pagamento aprovado pelo mock',
    modo: 'mock',
    ...extra
  };
}

async function inserirTransacaoMock(dados, status = 'aprovado') {
  const nsu = `NSU-MOCK-${Date.now()}`;
  const autorizacao = `AUT-MOCK-${Date.now()}`;
  const ins = await run(`
    INSERT INTO tef_transacoes (
      venda_id, empresa_id, tipo, valor, parcelas, status, provedor, adquirente, bandeira,
      nsu, autorizacao, codigo_transacao, idempotency_key,
      criado_em, atualizado_em
    ) VALUES (?, ?, ?, ?, ?, ?, 'MOCK', 'MOCK', 'MOCK', ?, ?, ?, ?, datetime('now'), datetime('now'))
  `, [
    dados.venda_id || null,
    dados.empresa_id || (empresaA && empresaA.id) || null,
    dados.tipo,
    Number(dados.valor),
    Number(dados.parcelas || 1),
    status,
    nsu,
    autorizacao,
    'MOCK',
    dados.idempotency_key || null
  ]);
  return { id: ins.lastID, nsu, autorizacao };
}

async function corpoComTefNovo(corpo) {
  const clone = JSON.parse(JSON.stringify(corpo));
  const pagamentos = Array.isArray(clone.pagamentos) ? clone.pagamentos : [];
  for (const pagamento of pagamentos) {
    if (!pagamento.tef_transacao_id && !pagamento.tef?.transacao_id) continue;
    const tx = await inserirTransacaoMock({
      tipo: pagamento.forma_pagamento || 'cartao_credito',
      valor: pagamento.valor,
      empresa_id: empresaA.id
    });
    pagamento.tef_transacao_id = tx.id;
    pagamento.nsu = tx.nsu;
    pagamento.autorizacao = tx.autorizacao;
    if (pagamento.tef) {
      pagamento.tef.transacao_id = tx.id;
      pagamento.tef.nsu = tx.nsu;
      pagamento.tef.autorizacao = tx.autorizacao;
    }
  }
  if (clone.tef && clone.tef.transacao_id) {
    const tx = await inserirTransacaoMock({
      tipo: clone.forma_pagamento || 'cartao_credito',
      valor: clone.total,
      empresa_id: empresaA.id
    });
    clone.tef.transacao_id = tx.id;
    clone.tef.nsu = tx.nsu;
    clone.tef.autorizacao = tx.autorizacao;
  }
  return clone;
}

tefService.iniciarPagamento = async function iniciarPagamentoMock(dados) {
  pagamentosMock.push({
    tipo: dados.tipo,
    valor: dados.valor,
    idempotency_key: dados.idempotency_key
  });
  if (controle.atrasoTefMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, controle.atrasoTefMs));
  }
  if (controle.tefModo === 'rede') {
    const err = new Error('Falha de rede com o mock TEF');
    err.code = 'REDE';
    throw err;
  }
  if (controle.tefModo === 'timeout') {
    return {
      sucesso: false,
      aprovado: false,
      status: 'erro',
      codigo: 'TIMEOUT',
      mensagem: 'Timeout de 30000ms excedido na operação TEF'
    };
  }
  if (controle.tefModo === 'recusa') {
    return {
      sucesso: false,
      aprovado: false,
      status: 'negado',
      codigo: 'NEGADO',
      mensagem: 'Pagamento recusado pelo mock'
    };
  }
  if (controle.tefModo === 'duplicada-negada') {
    return {
      sucesso: false,
      aprovado: false,
      status: 'pendente',
      codigo: 'TRANSACAO_DUPLICADA',
      mensagem: 'Transação duplicada sem aprovação',
      transacao_id: controle.ultimaAprovada ? controle.ultimaAprovada.id : 1
    };
  }
  if (dados.idempotency_key) {
    const existente = await get(
      `SELECT id, status, nsu, autorizacao FROM tef_transacoes WHERE idempotency_key = ?`,
      [dados.idempotency_key]
    );
    if (existente) {
      const aprovada = String(existente.status) === 'aprovado';
      return {
        sucesso: aprovada,
        aprovado: aprovada,
        status: existente.status,
        codigo: 'TRANSACAO_DUPLICADA',
        mensagem: 'Transação duplicada detectada — retornando existente',
        transacao_id: existente.id,
        nsu: existente.nsu,
        autorizacao: existente.autorizacao,
        transacao_existente: true
      };
    }
  }
  const criada = await inserirTransacaoMock(dados, 'aprovado');
  controle.ultimaAprovada = criada;
  return respostaAprovada(criada.id, { nsu: criada.nsu, autorizacao: criada.autorizacao });
};

const FUNCOES_PDV = [
  'motorPrecoAtacadoDisponivel',
  'operadorPodeAplicarDescontoSemSenha',
  'vendaTemDescontoManualPdv',
  'obterPrecoBaseItemPdv',
  'itemVendaPorUnidade',
  'obterDescontoValorItemPdv',
  'normalizarTipoVendaItem',
  'tipoVendaEhUnidade',
  'obterQuantidadeEstoqueParaVenda',
  'unidadeEhKg',
  'produtoUsaConversaoUnidadesPdv',
  'quantidadeUsaDecimaisPdv',
  'normalizarQuantidadePdv',
  'obterTerminalIdPdv',
  'getTerminalRequestData',
  'distribuirQuantidadeVendaLocal',
  'produtoControlaEstoquePdv',
  'pdvResolverSaldosProduto',
  'calcularDistribuicaoFiscalLocal',
  'precalcularDistribuicaoFiscalVenda',
  'aplicarDescontoProporcionalDistribuicao',
  'processarPagamentoTEF',
  'processarVendaFiscalNaoFiscal',
  'normalizarFormaPagamentoTEF',
  'formaPagamentoUsaTEF',
  'formaPagamentoGravacaoFiscalPDV',
  'deveEnviarPagamentosProcessadosPdv',
  'obterFormaPagamentoFiscal',
  'montarObjetoTEF',
  'obterModoConfirmacaoFiscal',
  'obterTefHabilitadoConfig',
  'calcularSubtotal',
  'executarFinalizacaoVenda',
  'finalizarPosVenda'
];

let empresaA;
let empresaB;
let produtoId;
let terminalId;
let operador;
let supervisor;
let tokenOperador;
let tokenSupervisor;
let server;
let sandbox;
let pdv;
const chamadas = [];
const resultados = {};
const emitidosNoFio = [];

function criarPdv(baseUrl) {
  const src = fs.readFileSync(PDV_JS, 'utf8');
  const codigo = FUNCOES_PDV.map((nome) => extrairFuncao(src, nome)).join('\n\n');
  const campos = {
    descontoPdv: '0',
    acrescimoPdv: '0',
    formaPagamentoPdv: 'cartao_credito',
    valorRecebidoPDV: '',
    clientePrazoId: '',
    parcelasPrazo: '1',
    dataVencimentoPrazo: '',
    parcelasCartao: '1'
  };
  const notificacoes = [];
  const ajaxPendentes = [];
  const contexto = {
    console,
    campos,
    notificacoes,
    ajaxPendentes,
    chamadas,
    empresaId: null,
    token: '',
    userJson: '{}',
    localStorage: {
      getItem(chave) {
        if (chave === 'token') return contexto.token;
        if (chave === 'user') return contexto.userJson;
        return '';
      },
      setItem() {},
      removeItem() {}
    },
    sessionStorage: {
      getItem() { return null; },
      setItem() {},
      removeItem() {}
    },
    window: {},
    document: { getElementById() { return null; }, activeElement: null },
    API_URL: baseUrl,
    fetch: async (url, opts = {}) => {
      const alvo = String(url);
      chamadas.push({ tipo: 'fetch', method: opts.method || 'GET', url: alvo, body: opts.body || null });
      if (alvo.includes('/tef/pagar') && controle.tefModo === 'rede-cliente') {
        throw new TypeError('Failed to fetch');
      }
      const headers = { ...(opts.headers || {}) };
      const resposta = await fetch(alvo, { ...opts, headers });
      return resposta;
    }
  };
  contexto.window = contexto;
  contexto.globalThis = contexto;
  function $(sel) {
    const id = String(sel).replace('#', '').split(',')[0].trim();
    return {
      val(v) {
        if (v === undefined) return campos[id] ?? '';
        campos[id] = v;
        return this;
      },
      text() { return this; },
      prop() { return this; },
      trigger() { return this; },
      off() { return this; },
      on() { return this; },
      html() { return this; },
      removeClass() { return this; }
    };
  }
  $.ajax = function ajaxPdv(opts) {
    const pendente = (async () => {
      const headers = {};
      const xhr = { setRequestHeader(nome, valor) { headers[nome] = valor; } };
      if (typeof opts.beforeSend === 'function') opts.beforeSend(xhr);
      const method = opts.method || 'POST';
      const url = String(opts.url);
      let corpo = opts.data;
      if (method === 'POST' && /\/vendas\/?$/.test(url.split('?')[0])) {
        const json = JSON.parse(corpo);
        emitidosNoFio.push({
          emitir_fiscal_original: json.emitir_fiscal,
          valor_fiscal_tela: json.valor_fiscal,
          valor_nao_fiscal_tela: json.valor_nao_fiscal
        });
        if (json.emitir_fiscal === true) json.venda_fiscal = true;
        json.emitir_fiscal = false;
        corpo = JSON.stringify(json);
      }
      chamadas.push({ tipo: 'ajax', method, url, body: corpo, headers });
      if (!/\/vendas\/?$/.test(url.split('?')[0])) {
        if (typeof opts.success === 'function') opts.success([]);
        return;
      }
      const resp = await httpJson(server, method, url.replace(/^https?:\/\/[^/]+/, ''), corpo, headers);
      if (resp.status >= 400) {
        opts.error({ status: resp.status, responseJSON: resp.body }, 'error');
        return;
      }
      const ret = opts.success(resp.body);
      if (ret && typeof ret.then === 'function') await ret;
    })();
    ajaxPendentes.push(pendente);
    return pendente;
  };
  contexto.$ = $;
  contexto.showNotification = (msg, tipo) => notificacoes.push({ msg, tipo });
  contexto.processarFiscalPosPagamentoPosVenda = () => {
    notificacoes.push({ msg: 'NFC-e interceptada na homologação', tipo: 'info' });
  };
  contexto.imprimirCupomNaoFiscal = () => notificacoes.push({ msg: 'cupom', tipo: 'info' });
  contexto.imprimirDANFEFiscal = () => notificacoes.push({ msg: 'danfe', tipo: 'info' });
  contexto.emitirNFCeVenda = () => notificacoes.push({ msg: 'emitir nfce', tipo: 'info' });
  contexto.renderBannerSelecaoEmpresaPdv = () => {};
  contexto.resumirMensagemSelecaoEmpresaPdv = (estado) => estado && estado.mensagem;
  contexto.aoAlterarFormaPagamento = () => {};
  contexto.removerClienteSelecionado = () => {};
  contexto.atualizarCarrinho = () => {};
  contexto.focarCampoCodigo = () => {};
  contexto.urlProdutosPdv = () => `${baseUrl}/produtos`;
  contexto.normalizarProdutoPdvLista = (lista) => lista || [];
  vm.createContext(contexto);
  vm.runInContext(fs.readFileSync(TEF_JS, 'utf8'), contexto);
  const prelude = `
    const TIPO_VENDA_PESO = 'PESO';
    const TIPO_VENDA_UNIDADE = 'UNIDADE';
    var carrinho = [];
    var produtosDisponiveis = [];
    var formaPagamentoSelecionada = null;
    var formaPagamentoSelecionadaPDV = 'cartao_credito';
    var clienteSelecionado = null;
    var vendaPrazoInfo = null;
    var vendaEmProcessamento = false;
    var pagamentoFiscalAtual = null;
    var pagamentosMistos = [];
    var supervisorAuthToken = null;
    var terminalId = null;
    var pdvPedidoHandoff = null;
    var pdvPedidoHandoffFinalizado = false;
    var pdvEmitirFiscalNaVenda = null;
    var selecaoEmpresaPdvSnapshot = null;
    window.CdsEmpresaContexto = {
      headersJson() {
        return empresaId ? { 'X-Empresa-Id': String(empresaId) } : {};
      },
      anexarHeaderXhr(xhr) {
        if (empresaId) xhr.setRequestHeader('X-Empresa-Id', String(empresaId));
      }
    };
  `;
  const exporta = `({
    executarFinalizacaoVenda,
    processarPagamentoTEF,
    obterModoConfirmacaoFiscal,
    obterTefHabilitadoConfig,
    precalcularDistribuicaoFiscalVenda,
    get carrinho() { return carrinho.slice(); },
    set carrinho(v) { carrinho = v; },
    get vendaEmProcessamento() { return vendaEmProcessamento; },
    set vendaEmProcessamento(v) { vendaEmProcessamento = v; },
    get tefEmAndamento() { return window.__tefPagamentoEmAndamento === true; },
    set terminalId(v) { terminalId = v; },
    set produtosDisponiveis(v) { produtosDisponiveis = v; },
    set empresaId(v) { empresaId = v; },
    set forma(v) { formaPagamentoSelecionadaPDV = v; }
  })`;
  const api = vm.runInContext(`${prelude}\n${codigo}\n${exporta}`, contexto);
  return { api, contexto, notificacoes, ajaxPendentes, campos };
}

async function drenarAjax() {
  while (sandbox.ajaxPendentes.length) {
    const lote = sandbox.ajaxPendentes.splice(0, sandbox.ajaxPendentes.length);
    await Promise.all(lote);
  }
}

function armarCarrinho() {
  sandbox.api.carrinho = [{
    id: produtoId,
    quantidade: 1,
    preco_unitario: 10,
    subtotal: 10,
    tipo_venda: 'PESO',
    desconto_percentual: 0,
    desconto_valor: 0,
    desconto_manual: 0
  }];
  sandbox.api.produtosDisponiveis = [{
    id: produtoId,
    nome: 'Pastel homologacao',
    unidade: 'UN',
    preco_venda: 10
  }];
  sandbox.api.terminalId = terminalId;
  sandbox.api.empresaId = empresaA.id;
  sandbox.api.vendaEmProcessamento = false;
  sandbox.contexto.window.__tefPagamentoEmAndamento = false;
  sandbox.contexto.campos.descontoPdv = '0';
  sandbox.contexto.campos.acrescimoPdv = '0';
  sandbox.contexto.campos.formaPagamentoPdv = 'cartao_credito';
  sandbox.notificacoes.length = 0;
}

function usarOperador() {
  sandbox.contexto.token = tokenOperador;
  sandbox.contexto.userJson = JSON.stringify({ id: operador.id, role: 'operador', perfil: 'OPERADOR' });
}

function usarSupervisor() {
  sandbox.contexto.token = tokenSupervisor;
  sandbox.contexto.userJson = JSON.stringify({ id: supervisor.id, role: 'operador', perfil: 'SUPERVISOR' });
}

function urlsVenda() {
  return chamadas.filter((c) => c.tipo === 'ajax' && /\/vendas\/?$/.test(String(c.url).split('?')[0]));
}

function urlsTef() {
  return chamadas.filter((c) => c.tipo === 'fetch' && String(c.url).includes('/tef/pagar'));
}

function headersEmpresaA(token) {
  return {
    Authorization: `Bearer ${token || tokenOperador}`,
    'X-Empresa-Id': String(empresaA.id)
  };
}

function gravarModoConfirmacaoFiscal(modo) {
  const cfgPath = path.join(dbDir, 'config', 'configuracoes.json');
  const cfgAtual = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfgAtual.modo_confirmacao_fiscal = modo;
  fs.writeFileSync(cfgPath, JSON.stringify(cfgAtual, null, 2));
  controle.modoConfirmacaoFiscal = modo;
}

function corpoVendaDireta({ forma, vendaFiscal, pagamentos, extra = {} }) {
  return {
    total: 10,
    desconto: 0,
    acrescimo: 0,
    forma_pagamento: forma,
    emitir_fiscal: false,
    venda_fiscal: vendaFiscal,
    itens: [{ produto_id: produtoId, quantidade: 1, preco_unitario: 10, subtotal: 10 }],
    pagamentos,
    terminal_id: terminalId,
    ...extra
  };
}

describe('Sprint 21 Etapa B — fluxo automático', { concurrency: false }, () => {
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
      { cnpj: CNPJ_A, razao_social: 'Empresa A Sprint 21B' },
      { db }
    );
    empresaB = await EmpresaService.criarEmpresa(
      { cnpj: CNPJ_B, razao_social: 'Empresa B Sprint 21B' },
      { db }
    );

    const produto = await run(
      `INSERT INTO produtos (
         nome, unidade, tipo_operacional, controla_estoque,
         saldo_fiscal, saldo_nao_fiscal, estoque_atual, preco_venda, ativo
       ) VALUES ('Pastel homologacao', 'UN', 'COMERCIAL', 1, 0, 0, 0, 10, 1)`
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
    }
    await run(
      `UPDATE estoque_empresa
       SET saldo_fiscal = 50, saldo_nao_fiscal = 50, estoque_atual = 100,
           reservado_fiscal = 0, reservado_nao_fiscal = 0
       WHERE produto_id = ? AND empresa_id = ?`,
      [produtoId, empresaA.id]
    );
    await run(
      `UPDATE produtos SET saldo_fiscal = 50, saldo_nao_fiscal = 50, estoque_atual = 100 WHERE id = ?`,
      [produtoId]
    );

    operador = await run(
      `INSERT INTO usuarios (username, password_hash, role, nome, perfil, ativo)
       VALUES ('op21b', 'x', 'operador', 'Operador 21B', 'OPERADOR', 1)`
    );
    supervisor = await run(
      `INSERT INTO usuarios (username, password_hash, role, nome, perfil, ativo)
       VALUES ('sup21b', 'x', 'operador', 'Supervisor 21B', 'SUPERVISOR', 1)`
    );
    operador = { id: operador.lastID };
    supervisor = { id: supervisor.lastID };
    await run(
      `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`,
      [operador.id, empresaA.id]
    );
    await run(
      `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`,
      [supervisor.id, empresaA.id]
    );

    const segredo = getJwtSecret();
    tokenOperador = jwt.sign(
      { id: operador.id, usuario_id: operador.id, username: 'op21b', role: 'operador', perfil: 'OPERADOR' },
      segredo,
      { expiresIn: '2h' }
    );
    tokenSupervisor = jwt.sign(
      { id: supervisor.id, usuario_id: supervisor.id, username: 'sup21b', role: 'operador', perfil: 'SUPERVISOR' },
      segredo,
      { expiresIn: '2h' }
    );

    const terminal = await run(`INSERT INTO terminais (nome, hostname) VALUES ('PDV-21B', 'sprint21b')`);
    terminalId = terminal.lastID;
    const turno = await run(
      `INSERT INTO caixa (data, valor_inicial, status, terminal_id, aberto_em, aberto_por)
       VALUES (date('now','localtime'), 0, 'aberto', ?, DATETIME('now','localtime'), ?)`,
      [terminalId, operador.id]
    );
    await run(
      `INSERT INTO caixa_sessoes (
         caixa_turno_id, terminal_id, operador_id, empresa_id, status, valor_abertura, aberto_em
       ) VALUES (?, ?, ?, ?, 'aberto', 0, DATETIME('now','localtime'))`,
      [turno.lastID, terminalId, operador.id, empresaA.id]
    );
    const terminalSupervisor = await run(
      `INSERT INTO terminais (nome, hostname) VALUES ('PDV-21B-SUP', 'sprint21b-sup')`
    );
    const turnoSupervisor = await run(
      `INSERT INTO caixa (data, valor_inicial, status, terminal_id, aberto_em, aberto_por)
       VALUES (date('now','localtime'), 0, 'aberto', ?, DATETIME('now','localtime'), ?)`,
      [terminalSupervisor.lastID, supervisor.id]
    );
    await run(
      `INSERT INTO caixa_sessoes (
         caixa_turno_id, terminal_id, operador_id, empresa_id, status, valor_abertura, aberto_em
       ) VALUES (?, ?, ?, ?, 'aberto', 0, DATETIME('now','localtime'))`,
      [turnoSupervisor.lastID, terminalSupervisor.lastID, supervisor.id, empresaA.id]
    );

    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.post('/api/impressao/tef', (_req, res) => res.json({ ok: true, simulado: true }));
    app.use('/api/tef', (req, res, next) => {
      if (req.method === 'GET' && String(req.url).startsWith('/fluxo-pdv') && controle.falhaFluxo) {
        return res.status(503).json({ error: 'fluxo indisponivel' });
      }
      if (req.method === 'POST' && String(req.url).startsWith('/pagar') && controle.tefModo === '409-aprovado') {
        const previa = controle.ultimaAprovada;
        return res.status(409).json({
          codigo: 'TRANSACAO_DUPLICADA',
          aprovado: true,
          sucesso: true,
          status: 'aprovado',
          transacao_id: previa.id,
          nsu: previa.nsu,
          autorizacao: previa.autorizacao,
          mensagem: 'Transação duplicada detectada — retornando existente'
        });
      }
      return tefRouter(req, res, next);
    });
    app.use('/api/configuracoes-avancadas', (req, res, next) => {
      if (controle.falhaConfirmacao && String(req.url).includes('confirmacao-fiscal')) {
        return res.status(503).json({ error: 'confirmacao indisponivel' });
      }
      return configRouter(req, res, next);
    });
    const contextoEmpresa = criarMiddlewareContextoEmpresa(db);
    const aplicarModelo = middlewareAplicarPdvModeloEmpresa({ db, canalHttpVendas: true });
    app.post(
      '/api/vendas/pre-calcular-distribuicao',
      verificarToken,
      contextoEmpresa,
      validarCaixaAberto,
      preCalcularDistribuicao
    );
    app.post(
      '/api/vendas',
      verificarToken,
      contextoEmpresa,
      aplicarModelo,
      validarCaixaSeOrigemPdv,
      (req, res) => {
        if (req.body && req.body.emitir_fiscal === true) {
          emitidosNoFio.push({ bloqueioServidor: true });
          req.body.venda_fiscal = req.body.venda_fiscal == null ? true : req.body.venda_fiscal;
          req.body.emitir_fiscal = false;
        }
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
    const base = `http://127.0.0.1:${server.address().port}/api`;
    sandbox = criarPdv(base);
    pdv = sandbox.api;
    usarOperador();

    assert.ok(String(db.dbPath).startsWith(dbDir), db.dbPath);
    assert.equal(/ProgramData[\\/]MercantilFiscal/i.test(String(db.dbPath)), false);
    assert.equal(tefContrato.estaAprovado({ status: 'aprovado' }), true);
    assert.equal(tefContrato.estaAprovado({ status: 'erro', sucesso: false, codigo: 'TIMEOUT' }), false);
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    console.log(`SPRINT21B_RESULTADOS ${JSON.stringify({
      dbDir,
      dbPath: db.dbPath,
      autorizacoesReais: autorizacoesReais.length,
      emissoesFiscais: emissoesFiscais.length,
      resultados
    })}`);
  });

  it('B1 — aprovação TEF antes da gravação e persistência', async () => {
    controle.tefModo = 'aprovar';
    controle.backendTef = 'on';
    controle.falhaFluxo = false;
    controle.falhaConfirmacao = false;
    controle.atrasoTefMs = 0;
    chamadas.length = 0;
    const mockAntes = pagamentosMock.length;
    const realAntes = autorizacoesReais.length;
    const vendasAntes = await get(`SELECT COUNT(*) AS n FROM vendas`);
    armarCarrinho();
    usarOperador();

    await pdv.executarFinalizacaoVenda(true);
    await drenarAjax();

    const tef = urlsTef();
    const vendasHttp = urlsVenda();
    assert.equal(tef.length, 1, 'uma autorização TEF');
    assert.equal(vendasHttp.length, 1, 'uma gravação');
    assert.ok(chamadas.indexOf(tef[0]) < chamadas.indexOf(vendasHttp[0]), 'TEF antes de POST /vendas');
    assert.equal(pagamentosMock.length - mockAntes, 1);
    assert.equal(autorizacoesReais.length, realAntes, 'sem segunda autorização no adquirente');

    const corpo = JSON.parse(vendasHttp[0].body);
    assert.equal(corpo.emitir_fiscal, false);
    assert.equal(corpo.venda_fiscal, true);
    assert.equal(emitidosNoFio.at(-1).emitir_fiscal_original, true);
    assert.ok(corpo.pagamentos[0].tef_transacao_id);
    assert.ok(corpo.pagamentos[0].nsu);
    assert.equal(corpo.pagamentos_processados_pdv, true);

    const vendaId = (await get(`SELECT id FROM vendas ORDER BY id DESC LIMIT 1`)).id;
    const venda = await get(
      `SELECT id, empresa_id, total, valor_fiscal, valor_nao_fiscal, status_pagamento, tef_transacao_id
       FROM vendas WHERE id = ?`,
      [vendaId]
    );
    assert.equal(Number(venda.empresa_id), Number(empresaA.id));
    assert.equal(Number(venda.total), 10);
    assert.equal(Number(venda.valor_fiscal), Number(emitidosNoFio.at(-1).valor_fiscal_tela));
    assert.equal(Number(venda.valor_nao_fiscal), Number(emitidosNoFio.at(-1).valor_nao_fiscal_tela));
    assert.ok(Number(venda.valor_fiscal) > 0);
    assert.equal(venda.status_pagamento, 'quitada');
    assert.equal(pdv.carrinho.length, 0);
    assert.equal(pdv.vendaEmProcessamento, false);
    assert.ok(sandbox.notificacoes.some((n) => n.msg === 'Venda finalizada com sucesso.'));
    const receb = await get(
      `SELECT nsu, autorizacao, tef_transacao_id FROM venda_recebimentos WHERE venda_id = ?`,
      [vendaId]
    );
    assert.equal(receb.nsu, corpo.pagamentos[0].nsu);
    assert.equal(String(receb.tef_transacao_id), String(corpo.pagamentos[0].tef_transacao_id));
    const depois = await get(`SELECT COUNT(*) AS n FROM vendas`);
    assert.equal(Number(depois.n), Number(vendasAntes.n) + 1);
    assert.equal(emissoesFiscais.length, 0);
    resultados.B1 = {
      aprovado: true,
      vendaId,
      valor_fiscal: venda.valor_fiscal,
      valor_nao_fiscal: venda.valor_nao_fiscal,
      ordem: ['POST /api/tef/pagar', 'POST /api/vendas']
    };
  });

  it('B2 — recusa não grava venda e preserva o carrinho', async () => {
    controle.tefModo = 'recusa';
    chamadas.length = 0;
    const antes = await get(`SELECT COUNT(*) AS n FROM vendas`);
    armarCarrinho();
    await pdv.executarFinalizacaoVenda(true);
    await drenarAjax();
    const depois = await get(`SELECT COUNT(*) AS n FROM vendas`);
    assert.equal(urlsTef().length, 1);
    assert.equal(urlsVenda().length, 0);
    assert.equal(Number(depois.n), Number(antes.n));
    assert.equal(pdv.carrinho.length, 1);
    assert.equal(pdv.vendaEmProcessamento, false);
    assert.ok(sandbox.notificacoes.some((n) => /recusad|não aprovado|negad/i.test(n.msg)));
    resultados.B2 = { aprovado: true, notificacoes: sandbox.notificacoes.map((n) => n.msg) };
  });

  it('B3 — HTTP 409 aprovado reaproveita e não autoriza de novo', async () => {
    controle.tefModo = 'aprovar';
    controle.atrasoTefMs = 0;
    const previa = await inserirTransacaoMock({
      tipo: 'cartao_credito',
      valor: 10,
      parcelas: 1,
      idempotency_key: 'sprint21b-previa'
    }, 'aprovado');
    controle.ultimaAprovada = previa;
    controle.tefModo = '409-aprovado';
    chamadas.length = 0;
    const mockAntes = pagamentosMock.length;
    const realAntes = autorizacoesReais.length;
    armarCarrinho();
    await pdv.executarFinalizacaoVenda(true);
    await drenarAjax();

    assert.equal(urlsTef().length, 1);
    assert.equal(pagamentosMock.length, mockAntes, 'o 409 não dispara outra autorização');
    assert.equal(autorizacoesReais.length, realAntes);
    const corpo = JSON.parse(urlsVenda()[0].body);
    assert.equal(Number(corpo.pagamentos[0].tef_transacao_id), Number(previa.id));
    assert.equal(corpo.pagamentos[0].nsu, previa.nsu);
    const venda = await get(`SELECT tef_transacao_id FROM vendas ORDER BY id DESC LIMIT 1`);
    assert.equal(Number(venda.tef_transacao_id), Number(previa.id));

    controle.tefModo = 'aprovar';
    const dup = await httpJson(server, 'POST', '/api/tef/pagar', {
      tipo: 'cartao_credito',
      valor: 10,
      parcelas: 1,
      idempotency_key: 'sprint21b-previa'
    }, { Authorization: `Bearer ${tokenOperador}` });
    assert.equal(dup.status, 200, JSON.stringify(dup.body));
    assert.equal(dup.body.codigo, 'TRANSACAO_DUPLICADA');
    assert.equal(dup.body.aprovado, true);
    assert.equal(Number(dup.body.transacao_id), Number(previa.id));

    controle.tefModo = 'duplicada-negada';
    const negada = await httpJson(server, 'POST', '/api/tef/pagar', {
      tipo: 'cartao_credito',
      valor: 10,
      parcelas: 1,
      idempotency_key: `sprint21b-negada-${Date.now()}`
    }, { Authorization: `Bearer ${tokenOperador}` });
    assert.equal(negada.status, 409);
    assert.equal(negada.body.codigo, 'TRANSACAO_DUPLICADA');
    resultados.B3 = {
      aprovado: true,
      reaproveitada: previa.id,
      rotaAprovadaDuplicada: dup.status,
      rotaNegadaDuplicada: negada.status
    };
  });

  it('B4 — duas finalizações simultâneas geram uma venda', async () => {
    controle.tefModo = 'aprovar';
    controle.atrasoTefMs = 250;
    chamadas.length = 0;
    const antes = await get(`SELECT COUNT(*) AS n FROM vendas`);
    const mockAntes = pagamentosMock.length;
    armarCarrinho();
    const p1 = pdv.executarFinalizacaoVenda(true);
    const p2 = pdv.executarFinalizacaoVenda(true);
    await Promise.all([p1, p2]);
    await drenarAjax();
    const depois = await get(`SELECT COUNT(*) AS n FROM vendas`);
    const delta = Number(depois.n) - Number(antes.n);
    const tefDelta = pagamentosMock.length - mockAntes;
    resultados.B4 = {
      vendas: delta,
      autorizacoesMock: tefDelta,
      fetchesTef: urlsTef().length,
      postsVenda: urlsVenda().length,
      notificacoes: sandbox.notificacoes.map((n) => n.msg)
    };
    controle.atrasoTefMs = 0;
    assert.equal(delta, 1, JSON.stringify(resultados.B4));
    assert.equal(tefDelta, 1, JSON.stringify(resultados.B4));
  });

  it('B5 — timeout e falha de rede não aprovam', async () => {
    controle.tefModo = 'timeout';
    controle.atrasoTefMs = 0;
    chamadas.length = 0;
    const antes = await get(`SELECT COUNT(*) AS n FROM vendas`);
    armarCarrinho();
    await pdv.executarFinalizacaoVenda(true);
    await drenarAjax();
    let depois = await get(`SELECT COUNT(*) AS n FROM vendas`);
    assert.equal(urlsVenda().length, 0);
    assert.equal(Number(depois.n), Number(antes.n));
    assert.equal(pdv.carrinho.length, 1);
    assert.ok(sandbox.notificacoes.some((n) => /Timeout|não aprovado|TEF/i.test(n.msg)));

    controle.tefModo = 'rede';
    chamadas.length = 0;
    armarCarrinho();
    await pdv.executarFinalizacaoVenda(true);
    await drenarAjax();
    depois = await get(`SELECT COUNT(*) AS n FROM vendas`);
    assert.equal(urlsVenda().length, 0);
    assert.equal(Number(depois.n), Number(antes.n));

    controle.tefModo = 'rede-cliente';
    chamadas.length = 0;
    armarCarrinho();
    await pdv.executarFinalizacaoVenda(true);
    await drenarAjax();
    depois = await get(`SELECT COUNT(*) AS n FROM vendas`);
    assert.equal(urlsVenda().length, 0);
    assert.equal(pdv.carrinho.length, 1);
    assert.equal(pdv.tefEmAndamento, false);
    const trecho = extrairFuncao(fs.readFileSync(PDV_JS, 'utf8'), 'processarPagamentoTEF');
    assert.equal(/timeout\s*:/.test(trecho), false);
    resultados.B5 = { aprovado: true, semTimeoutNoFetchTef: true };
  });

  it('B6 — rateio da tela coincide com o recálculo e ignora o valor do corpo', async () => {
    controle.tefModo = 'aprovar';
    controle.backendTef = 'on';
    chamadas.length = 0;
    armarCarrinho();
    usarSupervisor();
    sandbox.contexto.campos.descontoPdv = '1';
    sandbox.contexto.campos.acrescimoPdv = '0.50';
    await pdv.executarFinalizacaoVenda(true);
    await drenarAjax();
    const corpo = JSON.parse(urlsVenda()[0].body);
    assert.equal(corpo.desconto, 1);
    assert.equal(corpo.acrescimo, 0.5);
    assert.equal(corpo.emitir_fiscal, false);
    const venda = await get(
      `SELECT id, total, desconto, valor_fiscal, valor_nao_fiscal FROM vendas ORDER BY id DESC LIMIT 1`
    );
    assert.equal(Number(venda.total), 9.5);
    assert.equal(Number(venda.desconto), 1);
    assert.equal(Number(venda.valor_fiscal), Number(corpo.valor_fiscal));
    assert.equal(Number(venda.valor_nao_fiscal), Number(corpo.valor_nao_fiscal));
    assert.notEqual(Number(venda.valor_fiscal), 999);

    const sabotagem = await corpoComTefNovo({
      ...corpo,
      valor_fiscal: 999,
      valor_nao_fiscal: 999
    });
    const resp = await httpJson(server, 'POST', '/api/vendas', sabotagem, {
      Authorization: `Bearer ${tokenSupervisor}`,
      'X-Empresa-Id': String(empresaA.id)
    });
    assert.ok(resp.status < 400, JSON.stringify(resp.body));
    const segunda = await get(
      `SELECT valor_fiscal, valor_nao_fiscal, total FROM vendas WHERE id = ?`,
      [resp.body.venda_id || resp.body.id]
    );
    assert.equal(Number(segunda.valor_fiscal), Number(venda.valor_fiscal));
    assert.equal(Number(segunda.valor_nao_fiscal), Number(venda.valor_nao_fiscal));
    assert.notEqual(Number(segunda.valor_fiscal), 999);
    assert.equal(emissoesFiscais.length, 0);
    resultados.B6 = {
      aprovado: true,
      valor_fiscal: Number(venda.valor_fiscal),
      valor_nao_fiscal: Number(venda.valor_nao_fiscal),
      total: Number(venda.total),
      sabotagemIgnorada: true
    };
  });

  it('B7 — empresa não autorizada não grava; a autorizada prevalece sobre o body', async () => {
    controle.tefModo = 'aprovar';
    usarOperador();
    const antes = await get(`SELECT COUNT(*) AS n FROM vendas`);
    const headerB = await httpJson(server, 'POST', '/api/vendas', {
      total: 10,
      desconto: 0,
      acrescimo: 0,
      forma_pagamento: 'cartao_credito',
      emitir_fiscal: false,
      venda_fiscal: true,
      itens: [{ produto_id: produtoId, quantidade: 1, preco_unitario: 10, subtotal: 10 }],
      pagamentos: [{
        forma_pagamento: 'cartao_credito',
        valor: 10,
        tipo_recebimento: 'fiscal',
        tef_transacao_id: controle.ultimaAprovada.id,
        nsu: controle.ultimaAprovada.nsu,
        autorizacao: controle.ultimaAprovada.autorizacao
      }],
      terminal_id: terminalId
    }, {
      Authorization: `Bearer ${tokenOperador}`,
      'X-Empresa-Id': String(empresaB.id)
    });
    assert.equal(headerB.status, 403, JSON.stringify(headerB.body));
    assert.equal(headerB.body.code, 'EMPRESA_NAO_AUTORIZADA');

    const soBody = await httpJson(server, 'POST', '/api/vendas', {
      empresa_id: empresaB.id,
      total: 10,
      desconto: 0,
      acrescimo: 0,
      forma_pagamento: 'cartao_credito',
      emitir_fiscal: false,
      venda_fiscal: true,
      itens: [{ produto_id: produtoId, quantidade: 1, preco_unitario: 10, subtotal: 10 }],
      pagamentos: [{
        forma_pagamento: 'cartao_credito',
        valor: 10,
        tipo_recebimento: 'fiscal',
        tef_transacao_id: controle.ultimaAprovada.id,
        nsu: controle.ultimaAprovada.nsu,
        autorizacao: controle.ultimaAprovada.autorizacao
      }],
      terminal_id: terminalId
    }, { Authorization: `Bearer ${tokenOperador}` });
    assert.equal(soBody.status, 403, JSON.stringify(soBody.body));

    chamadas.length = 0;
    armarCarrinho();
    await pdv.executarFinalizacaoVenda(true);
    await drenarAjax();
    const corpo = JSON.parse(urlsVenda()[0].body);
    const corpoMisturado = await corpoComTefNovo(corpo);
    corpoMisturado.empresa_id = empresaB.id;
    const misturado = await httpJson(server, 'POST', '/api/vendas', corpoMisturado, {
      Authorization: `Bearer ${tokenOperador}`,
      'X-Empresa-Id': String(empresaA.id)
    });
    assert.ok(misturado.status < 400, JSON.stringify(misturado.body));
    const gravada = await get(
      `SELECT empresa_id FROM vendas WHERE id = ?`,
      [misturado.body.venda_id || misturado.body.id]
    );
    assert.equal(Number(gravada.empresa_id), Number(empresaA.id));
    const depois = await get(`SELECT COUNT(*) AS n FROM vendas`);
    assert.ok(Number(depois.n) > Number(antes.n));
    const indevidas = await get(
      `SELECT COUNT(*) AS n FROM vendas WHERE empresa_id = ?`,
      [empresaB.id]
    );
    assert.equal(Number(indevidas.n), 0);
    resultados.B7 = { aprovado: true, empresaPersistida: empresaA.id, empresaRecusada: empresaB.id };
  });

  it('E1 — falha simultânea das configurações bloqueia o cartão', async () => {
    controle.falhaConfirmacao = true;
    controle.falhaFluxo = true;
    controle.backendTef = 'off';
    controle.tefModo = 'aprovar';
    controle.modoConfirmacaoFiscal = 'TEF';
    chamadas.length = 0;
    const antes = await get(`SELECT COUNT(*) AS n FROM vendas`);
    const realAntes = autorizacoesReais.length;
    armarCarrinho();
    usarOperador();
    await pdv.executarFinalizacaoVenda(false);
    await drenarAjax();
    const depois = await get(`SELECT COUNT(*) AS n FROM vendas`);
    const posts = urlsVenda().length;
    const tef = urlsTef().length;
    const delta = Number(depois.n) - Number(antes.n);
    resultados.falhaConfig = {
      postsVenda: posts,
      fetchesTef: tef,
      vendasNovas: delta,
      autorizacoesReais: autorizacoesReais.length - realAntes,
      tinhaTef: false,
      confirmacaoManual: false,
      notificacoes: sandbox.notificacoes.map((n) => n.msg),
      carrinho: pdv.carrinho.length,
      vendaEmProcessamento: pdv.vendaEmProcessamento
    };
    controle.falhaConfirmacao = false;
    controle.falhaFluxo = false;
    controle.backendTef = 'on';
    resultados.falhaConfig.criterio = 'BLOQUEADO';
    assert.equal(tef, 0, JSON.stringify(resultados.falhaConfig));
    assert.equal(posts, 0, JSON.stringify(resultados.falhaConfig));
    assert.equal(delta, 0, JSON.stringify(resultados.falhaConfig));
    assert.equal(pdv.carrinho.length, 1);
    assert.equal(pdv.vendaEmProcessamento, false);
    assert.equal(autorizacoesReais.length, realAntes);
    assert.ok(sandbox.notificacoes.some((n) => /não foi possível confirmar/i.test(n.msg)));
    assert.equal(sandbox.notificacoes.some((n) => n.msg === 'Venda finalizada com sucesso.'), false);
  });

  it('E2 — backend rejeita cartão sem TEF aprovado e sem confirmação manual', async () => {
    controle.backendTef = 'off';
    controle.modoConfirmacaoFiscal = 'TEF';
    const realAntes = autorizacoesReais.length;
    const antes = await get(`SELECT COUNT(*) AS n FROM vendas`);
    const quitadasAntes = await get(
      `SELECT COUNT(*) AS n FROM vendas WHERE status_pagamento = 'quitada'`
    );
    const fiscal = await httpJson(server, 'POST', '/api/vendas', corpoVendaDireta({
      forma: 'cartao_credito',
      vendaFiscal: true,
      pagamentos: [{ forma_pagamento: 'cartao_credito', valor: 10, tipo_recebimento: 'fiscal' }]
    }), headersEmpresaA());
    const naoFiscal = await httpJson(server, 'POST', '/api/vendas', corpoVendaDireta({
      forma: 'cartao_credito',
      vendaFiscal: false,
      pagamentos: [{ forma_pagamento: 'cartao_credito', valor: 10, tipo_recebimento: 'nao_fiscal' }]
    }), headersEmpresaA());
    const depois = await get(`SELECT COUNT(*) AS n FROM vendas`);
    const quitadasDepois = await get(
      `SELECT COUNT(*) AS n FROM vendas WHERE status_pagamento = 'quitada'`
    );
    controle.backendTef = 'on';
    resultados.E2 = {
      fiscal: fiscal.status,
      naoFiscal: naoFiscal.status,
      erroFiscal: fiscal.body && fiscal.body.error,
      erroNaoFiscal: naoFiscal.body && naoFiscal.body.error,
      vendasNovas: Number(depois.n) - Number(antes.n),
      quitadasNovas: Number(quitadasDepois.n) - Number(quitadasAntes.n),
      autorizacoesReais: autorizacoesReais.length - realAntes
    };
    assert.ok(fiscal.status >= 400, JSON.stringify(fiscal.body));
    assert.ok(naoFiscal.status >= 400, JSON.stringify(naoFiscal.body));
    assert.equal(Number(depois.n), Number(antes.n));
    assert.equal(Number(quitadasDepois.n), Number(quitadasAntes.n));
    assert.equal(autorizacoesReais.length, realAntes);
  });

  it('E3 — TEF aprovado no contrato do mock continua vinculado', async () => {
    controle.backendTef = 'on';
    controle.modoConfirmacaoFiscal = 'TEF';
    controle.tefModo = 'aprovar';
    const previa = await inserirTransacaoMock({
      tipo: 'cartao_credito',
      valor: 10,
      parcelas: 1,
      idempotency_key: `sprint21e-aprovada-${Date.now()}`
    }, 'aprovado');
    const realAntes = autorizacoesReais.length;
    const resp = await httpJson(server, 'POST', '/api/vendas', corpoVendaDireta({
      forma: 'cartao_credito',
      vendaFiscal: true,
      pagamentos: [{
        forma_pagamento: 'cartao_credito',
        valor: 10,
        tipo_recebimento: 'fiscal',
        tef_transacao_id: previa.id,
        nsu: previa.nsu,
        autorizacao: previa.autorizacao
      }]
    }), headersEmpresaA());
    assert.ok(resp.status < 400, JSON.stringify(resp.body));
    const venda = await get(
      `SELECT id, status_pagamento, tef_transacao_id FROM vendas WHERE id = ?`,
      [resp.body.venda_id || resp.body.id]
    );
    assert.equal(venda.status_pagamento, 'quitada');
    assert.equal(Number(venda.tef_transacao_id), Number(previa.id));
    assert.equal(autorizacoesReais.length, realAntes);
    resultados.E3 = { aprovado: true, vendaId: venda.id, transacaoId: previa.id };
  });

  it('E4 — confirmação manual explícita com modo MANUAL permanece permitida', async () => {
    controle.backendTef = 'off';
    gravarModoConfirmacaoFiscal('MANUAL');
    const realAntes = autorizacoesReais.length;
    const resp = await httpJson(server, 'POST', '/api/vendas', corpoVendaDireta({
      forma: 'cartao_credito',
      vendaFiscal: true,
      pagamentos: [{ forma_pagamento: 'cartao_credito', valor: 10, tipo_recebimento: 'fiscal' }],
      extra: { confirmacao_fiscal_manual: true }
    }), headersEmpresaA());
    controle.backendTef = 'on';
    gravarModoConfirmacaoFiscal('TEF');
    assert.ok(resp.status < 400, JSON.stringify(resp.body));
    const venda = await get(
      `SELECT id, status_pagamento, tef_transacao_id FROM vendas WHERE id = ?`,
      [resp.body.venda_id || resp.body.id]
    );
    assert.equal(venda.status_pagamento, 'quitada');
    assert.equal(venda.tef_transacao_id, null);
    assert.equal(autorizacoesReais.length, realAntes);
    resultados.E4 = { aprovado: true, vendaId: venda.id };
  });

  it('E5 — dinheiro não exige TEF e continua gravando', async () => {
    controle.backendTef = 'off';
    controle.modoConfirmacaoFiscal = 'TEF';
    const realAntes = autorizacoesReais.length;
    const resp = await httpJson(server, 'POST', '/api/vendas', corpoVendaDireta({
      forma: 'dinheiro',
      vendaFiscal: false,
      pagamentos: [{ forma_pagamento: 'dinheiro', valor: 10, tipo_recebimento: 'nao_fiscal' }]
    }), headersEmpresaA());
    controle.backendTef = 'on';
    assert.ok(resp.status < 400, JSON.stringify(resp.body));
    const venda = await get(
      `SELECT id, status_pagamento, valor_nao_fiscal FROM vendas WHERE id = ?`,
      [resp.body.venda_id || resp.body.id]
    );
    assert.equal(venda.status_pagamento, 'quitada');
    assert.ok(Number(venda.valor_nao_fiscal) > 0);
    assert.equal(autorizacoesReais.length, realAntes);
    resultados.E5 = { aprovado: true, vendaId: venda.id };
  });

  it('E6 — transação já aprovada é reaproveitada sem nova autorização', async () => {
    const chave = `sprint21e-dup-${Date.now()}`;
    const previa = await inserirTransacaoMock({
      tipo: 'cartao_credito',
      valor: 10,
      parcelas: 1,
      idempotency_key: chave
    }, 'aprovado');
    const realAntes = autorizacoesReais.length;
    const mockAntes = pagamentosMock.length;
    const dup = await httpJson(server, 'POST', '/api/tef/pagar', {
      tipo: 'cartao_credito',
      valor: 10,
      parcelas: 1,
      idempotency_key: chave
    }, { Authorization: `Bearer ${tokenOperador}` });
    assert.equal(dup.status, 200, JSON.stringify(dup.body));
    assert.equal(dup.body.codigo, 'TRANSACAO_DUPLICADA');
    assert.equal(dup.body.aprovado, true);
    assert.equal(Number(dup.body.transacao_id), Number(previa.id));
    const repetidas = await get(
      `SELECT COUNT(*) AS n FROM tef_transacoes WHERE idempotency_key = ?`,
      [chave]
    );
    assert.equal(Number(repetidas.n), 1);
    assert.equal(autorizacoesReais.length, realAntes);
    assert.equal(pagamentosMock.length, mockAntes + 1);
    resultados.E6 = { aprovado: true, reaproveitada: previa.id, status: dup.status };
  });

  it('E7 — rateio do motor permanece no cenário B6', async () => {
    controle.tefModo = 'aprovar';
    controle.backendTef = 'on';
    controle.modoConfirmacaoFiscal = 'TEF';
    chamadas.length = 0;
    armarCarrinho();
    usarSupervisor();
    sandbox.contexto.campos.descontoPdv = '1';
    sandbox.contexto.campos.acrescimoPdv = '0.50';
    await pdv.executarFinalizacaoVenda(true);
    await drenarAjax();
    const corpo = JSON.parse(urlsVenda()[0].body);
    assert.equal(corpo.desconto, 1);
    assert.equal(corpo.acrescimo, 0.5);
    const venda = await get(
      `SELECT id, total, desconto, valor_fiscal, valor_nao_fiscal FROM vendas ORDER BY id DESC LIMIT 1`
    );
    assert.equal(Number(venda.total), 9.5);
    assert.equal(Number(venda.desconto), 1);
    assert.equal(Number(venda.valor_fiscal), Number(corpo.valor_fiscal));
    assert.notEqual(Number(venda.valor_fiscal), 999);
    const sabotagem = await corpoComTefNovo({ ...corpo, valor_fiscal: 999, valor_nao_fiscal: 999 });
    const resp = await httpJson(server, 'POST', '/api/vendas', sabotagem, headersEmpresaA(tokenSupervisor));
    assert.ok(resp.status < 400, JSON.stringify(resp.body));
    const segunda = await get(
      `SELECT valor_fiscal, valor_nao_fiscal, total FROM vendas WHERE id = ?`,
      [resp.body.venda_id || resp.body.id]
    );
    assert.equal(Number(segunda.valor_fiscal), Number(venda.valor_fiscal));
    assert.equal(Number(segunda.valor_nao_fiscal), Number(venda.valor_nao_fiscal));
    assert.notEqual(Number(segunda.valor_fiscal), 999);
    assert.equal(emissoesFiscais.length, 0);
    resultados.E7 = {
      aprovado: true,
      valor_fiscal: Number(venda.valor_fiscal),
      valor_nao_fiscal: Number(venda.valor_nao_fiscal),
      total: Number(venda.total),
      sabotagemIgnorada: true
    };
  });
});
