/**
 * Sprint 21C — homologação do fluxo manual pela interface do PDV.
 * O modal e os cliques são os do pdv.js (#confirmar-recebimento-fiscal-manual).
 * Banco temporário. TEF real bloqueado. emitir_fiscal permanece false na gravação.
 *
 * Executar: node --test --test-concurrency=1 tests/pdv/sprint-21-etapa-c-manual-interface.test.js
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

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-sprint21c-'));
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
      const err = new Error('SEFAZ bloqueada na homologação da Etapa C.');
      err.code = 'SEFAZ_BLOQUEADA';
      throw err;
    }
  }
};

const { isolarBancoTeste } = require('../central-entradas/helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-sprint21c-');
const db = require('../../backend/database');
isolamento.comprobar(db);

const tefManager = require('../../backend/services/tef/TefManager');
const tefService = require('../../backend/services/tef');
const tefConfigService = require('../../backend/services/tef/tefConfigService');
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
const controle = { backendTef: 'off' };

tefManager.autorizar = async function autorizarBloqueada(dados) {
  autorizacoesReais.push({ tipo: dados && dados.tipo, valor: dados && dados.valor });
  const err = new Error('TEF_REAL_BLOQUEADO');
  err.code = 'TEF_REAL_BLOQUEADO';
  throw err;
};
tefManager.cancelar = async function cancelarBloqueado() {
  return { sucesso: true, simulado: true };
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
        resolve({ status: res.statusCode, body: json });
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

async function inserirTransacaoMock(dados) {
  const nsu = `NSU-MOCK-${Date.now()}`;
  const autorizacao = `AUT-MOCK-${Date.now()}`;
  const ins = await run(`
    INSERT INTO tef_transacoes (
      venda_id, empresa_id, tipo, valor, parcelas, status, provedor, adquirente, bandeira,
      nsu, autorizacao, codigo_transacao, idempotency_key, criado_em, atualizado_em
    ) VALUES (?, ?, ?, ?, 1, 'aprovado', 'MOCK', 'MOCK', 'MOCK', ?, ?, 'MOCK', ?, datetime('now'), datetime('now'))
  `, [
    null,
    dados.empresa_id || empresaA.id,
    dados.tipo,
    Number(dados.valor),
    nsu,
    autorizacao,
    dados.idempotency_key || null
  ]);
  return { id: ins.lastID, nsu, autorizacao };
}

tefService.iniciarPagamento = async function iniciarPagamentoMock(dados) {
  pagamentosMock.push({ tipo: dados.tipo, valor: dados.valor, empresa_id: dados.empresa_id || null });
  const criada = await inserirTransacaoMock(dados);
  return {
    sucesso: true,
    aprovado: true,
    status: 'aprovado',
    transacao_id: criada.id,
    nsu: criada.nsu,
    autorizacao: criada.autorizacao,
    bandeira: 'MOCK',
    adquirente: 'MOCK',
    mensagem: 'Pagamento aprovado pelo mock',
    modo: 'mock'
  };
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
  'abrirModalConfirmacaoFiscalManual',
  'confirmarRecebimentoFiscalManual',
  'processarVendaFiscalManual',
  'calcularSubtotal',
  'executarFinalizacaoVenda',
  'finalizarPosVenda'
];

let empresaA;
let produtoId;
let terminalId;
let operador;
let tokenOperador;
let server;
let sandbox;
let pdv;
const chamadas = [];
const resultados = {};

function criarPdv(baseUrl) {
  const src = fs.readFileSync(PDV_JS, 'utf8');
  const codigo = FUNCOES_PDV.map((nome) => extrairFuncao(src, nome)).join('\n\n');
  const campos = {
    descontoPdv: '0',
    acrescimoPdv: '0',
    formaPagamentoPdv: 'cartao_credito',
    valorRecebidoPDV: '10',
    clientePrazoId: '',
    parcelasPrazo: '1',
    dataVencimentoPrazo: '',
    parcelasCartao: '1'
  };
  const notificacoes = [];
  const ajaxPendentes = [];
  const elementos = new Map();
  const modalEstado = {
    aberto: false,
    exibicoes: 0,
    html: '',
    instancia: null,
    id: null
  };

  function garantirElemento(id) {
    if (!elementos.has(id)) {
      const el = {
        id,
        listeners: {},
        clickHandlers: [],
        addEventListener(tipo, fn) {
          this.listeners[tipo] = this.listeners[tipo] || [];
          this.listeners[tipo].push(fn);
        },
        removeEventListener(tipo, fn) {
          this.listeners[tipo] = (this.listeners[tipo] || []).filter((ouvinte) => ouvinte !== fn);
        }
      };
      elementos.set(id, el);
    }
    return elementos.get(id);
  }

  const contexto = {
    console,
    campos,
    notificacoes,
    ajaxPendentes,
    chamadas,
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
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    window: {},
    document: {
      getElementById(id) {
        return elementos.get(id) || null;
      }
    },
    API_URL: baseUrl,
    fetch: async (url, opts = {}) => {
      chamadas.push({
        tipo: 'fetch',
        method: opts.method || 'GET',
        url: String(url),
        body: opts.body || null
      });
      return fetch(String(url), opts);
    },
    bootstrap: {
      Modal: class ModalManual {
        constructor(el) {
          this.el = el;
          modalEstado.instancia = this;
          modalEstado.id = el && el.id;
        }

        show() {
          modalEstado.aberto = true;
          modalEstado.exibicoes += 1;
        }

        hide() {
          modalEstado.aberto = false;
          const lista = (this.el && this.el.listeners['hidden.bs.modal']) || [];
          lista.slice().forEach((fn) => fn());
        }
      }
    }
  };
  contexto.window = contexto;
  contexto.globalThis = contexto;

  function $(sel) {
    const id = String(sel).replace('#', '').split(',')[0].trim();
    const el = garantirElemento(id);
    const api = {
      val(v) {
        if (v === undefined) return campos[id] ?? '';
        campos[id] = v;
        return api;
      },
      text() { return api; },
      prop() { return api; },
      trigger() { return api; },
      off() {
        el.clickHandlers = [];
        return api;
      },
      on(evento, fn) {
        if (evento === 'click') el.clickHandlers.push(fn);
        return api;
      },
      html(conteudo) {
        if (conteudo === undefined) return el.html || '';
        el.html = String(conteudo);
        modalEstado.html = el.html;
        const ids = [...el.html.matchAll(/\sid="([^"]+)"/g)].map((achado) => achado[1]);
        ids.forEach((idElemento) => garantirElemento(idElemento));
        return api;
      },
      removeClass() { return api; }
    };
    return api;
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
  contexto.formatCurrency = (valor) => `R$ ${Number(valor || 0).toFixed(2)}`;
  contexto.processarFiscalPosPagamentoPosVenda = () => {
    notificacoes.push({ msg: 'NFC-e interceptada na homologação', tipo: 'info' });
  };
  contexto.imprimirCupomNaoFiscal = () => notificacoes.push({ msg: 'cupom', tipo: 'info' });
  contexto.imprimirDANFEFiscal = () => {};
  contexto.emitirNFCeVenda = () => {};
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
    obterModoConfirmacaoFiscal,
    get carrinho() { return carrinho.slice(); },
    set carrinho(v) { carrinho = v; },
    get vendaEmProcessamento() { return vendaEmProcessamento; },
    set vendaEmProcessamento(v) { vendaEmProcessamento = v; },
    set terminalId(v) { terminalId = v; },
    set produtosDisponiveis(v) { produtosDisponiveis = v; },
    set empresaId(v) { empresaId = v; },
    set forma(v) { formaPagamentoSelecionadaPDV = v; }
  })`;
  const api = vm.runInContext(`${prelude}\n${codigo}\n${exporta}`, contexto);
  return {
    api,
    contexto,
    notificacoes,
    ajaxPendentes,
    campos,
    modalEstado,
    clicar(id) {
      const el = elementos.get(id);
      if (!el || el.clickHandlers.length === 0) {
        throw new Error(`Botão #${id} sem o clique registrado pela interface.`);
      }
      el.clickHandlers.forEach((fn) => fn());
    },
    cancelarModal() {
      if (!modalEstado.instancia) throw new Error('Modal manual não está aberto.');
      modalEstado.instancia.hide();
    }
  };
}

async function drenarAjax() {
  while (sandbox.ajaxPendentes.length) {
    const lote = sandbox.ajaxPendentes.splice(0, sandbox.ajaxPendentes.length);
    await Promise.all(lote);
  }
}

function armarCarrinho(forma) {
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
  sandbox.api.forma = forma;
  sandbox.contexto.campos.formaPagamentoPdv = forma;
  sandbox.contexto.campos.descontoPdv = '0';
  sandbox.contexto.campos.acrescimoPdv = '0';
  sandbox.contexto.campos.valorRecebidoPDV = '10';
  sandbox.notificacoes.length = 0;
  sandbox.modalEstado.aberto = false;
  sandbox.modalEstado.exibicoes = 0;
  sandbox.modalEstado.html = '';
  sandbox.modalEstado.instancia = null;
}

function usarOperador() {
  sandbox.contexto.token = tokenOperador;
  sandbox.contexto.userJson = JSON.stringify({ id: operador.id, role: 'operador', perfil: 'OPERADOR' });
}

function gravarModoConfirmacaoFiscal(modo) {
  const cfgPath = path.join(dbDir, 'config', 'configuracoes.json');
  const cfgAtual = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfgAtual.modo_confirmacao_fiscal = modo;
  fs.writeFileSync(cfgPath, JSON.stringify(cfgAtual, null, 2));
}

function urlsVenda() {
  return chamadas.filter((c) => c.tipo === 'ajax' && /\/vendas\/?$/.test(String(c.url).split('?')[0]));
}

async function esperarModal(ms = 5000) {
  const inicio = Date.now();
  while (!sandbox.modalEstado.aberto) {
    if (Date.now() - inicio > ms) {
      throw new Error(`Modal manual não abriu. Notificações: ${JSON.stringify(sandbox.notificacoes)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function corpoCartao(extra = {}) {
  return {
    total: 10,
    desconto: 0,
    acrescimo: 0,
    forma_pagamento: 'cartao_credito',
    emitir_fiscal: false,
    venda_fiscal: true,
    itens: [{ produto_id: produtoId, quantidade: 1, preco_unitario: 10, subtotal: 10 }],
    pagamentos: [{ forma_pagamento: 'cartao_credito', valor: 10, tipo_recebimento: 'fiscal' }],
    terminal_id: terminalId,
    ...extra
  };
}

describe('Sprint 21C — fluxo manual pela interface', { concurrency: false }, () => {
  before(async () => {
    await whenReady();
    const cfgPath = path.join(dbDir, 'config', 'configuracoes.json');
    const cfgAtual = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfgAtual.modo_operacional_global = 'MULTIEMPRESA';
    cfgAtual.modo_operacao_venda = 'MULTIEMPRESA';
    cfgAtual.pdv_modelo_empresa = 'MULTIPLAS';
    cfgAtual.pdv_empresa_id = null;
    cfgAtual.modo_confirmacao_fiscal = 'MANUAL';
    fs.writeFileSync(cfgPath, JSON.stringify(cfgAtual, null, 2));
    await garantirSchemaEstoqueEmpresaAsync(db);
    await garantirSchemaUsuarioEmpresasAsync(db);

    empresaA = await EmpresaService.criarEmpresa(
      { cnpj: CNPJ_A, razao_social: 'Empresa A Sprint 21C' },
      { db }
    );
    const empresaB = await EmpresaService.criarEmpresa(
      { cnpj: CNPJ_B, razao_social: 'Empresa B Sprint 21C' },
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
      await run(
        `UPDATE estoque_empresa
         SET saldo_fiscal = 50, saldo_nao_fiscal = 50, estoque_atual = 100
         WHERE produto_id = ? AND empresa_id = ?`,
        [produtoId, emp.id]
      );
    }
    await run(
      `UPDATE produtos SET saldo_fiscal = 50, saldo_nao_fiscal = 50, estoque_atual = 100 WHERE id = ?`,
      [produtoId]
    );
    operador = await run(
      `INSERT INTO usuarios (username, password_hash, role, nome, perfil, ativo)
       VALUES ('op21c', 'x', 'operador', 'Operador 21C', 'OPERADOR', 1)`
    );
    operador = { id: operador.lastID };
    await run(
      `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`,
      [operador.id, empresaA.id]
    );
    tokenOperador = jwt.sign(
      { id: operador.id, usuario_id: operador.id, username: 'op21c', role: 'operador', perfil: 'OPERADOR' },
      getJwtSecret(),
      { expiresIn: '2h' }
    );
    const terminal = await run(`INSERT INTO terminais (nome, hostname) VALUES ('PDV-21C', 'sprint21c')`);
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

    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/api/tef', tefRouter);
    app.use('/api/configuracoes-avancadas', configRouter);
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
          req.body.venda_fiscal = req.body.venda_fiscal == null ? true : req.body.venda_fiscal;
          req.body.emitir_fiscal = false;
        }
        const ret = VendaApplicationService.criarVenda(req, res);
        if (ret && typeof ret.then === 'function') {
          ret.catch((err) => {
            if (!res.headersSent) res.status(err.statusCode || 500).json({ error: err.message, code: err.code });
          });
        }
      }
    );
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    sandbox = criarPdv(`http://127.0.0.1:${server.address().port}/api`);
    pdv = sandbox.api;
    usarOperador();
    assert.equal(/ProgramData[\\/]MercantilFiscal/i.test(String(db.dbPath)), false);
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    console.log(`SPRINT21C_RESULTADOS ${JSON.stringify({
      dbDir,
      dbPath: db.dbPath,
      autorizacoesReais: autorizacoesReais.length,
      emissoesFiscais: emissoesFiscais.length,
      pagamentosMock: pagamentosMock.length,
      resultados
    })}`);
  });

  it('C1 — o modal manual abre e nenhuma venda é gravada antes da confirmação', async () => {
    gravarModoConfirmacaoFiscal('MANUAL');
    controle.backendTef = 'off';
    chamadas.length = 0;
    const antes = await get(`SELECT COUNT(*) AS n FROM vendas`);
    armarCarrinho('cartao_credito');
    const modo = await pdv.obterModoConfirmacaoFiscal();
    const fechamento = pdv.executarFinalizacaoVenda(true);
    await esperarModal();
    const durante = await get(`SELECT COUNT(*) AS n FROM vendas`);
    resultados.C1 = {
      modo,
      modalAberto: sandbox.modalEstado.aberto,
      modalId: sandbox.modalEstado.id,
      botao: sandbox.modalEstado.html.includes('id="confirmar-recebimento-fiscal-manual"'),
      posts: urlsVenda().length,
      vendas: Number(durante.n) - Number(antes.n)
    };
    assert.equal(modo, 'MANUAL');
    assert.equal(sandbox.modalEstado.aberto, true);
    assert.equal(sandbox.modalEstado.id, 'confirmacaoFiscalManualModal');
    assert.equal(resultados.C1.botao, true);
    assert.equal(urlsVenda().length, 0);
    assert.equal(Number(durante.n), Number(antes.n));
    sandbox.cancelarModal();
    await fechamento;
    await drenarAjax();
  });

  it('C2 — a confirmação explícita envia o indicador e grava uma venda', async () => {
    gravarModoConfirmacaoFiscal('MANUAL');
    controle.backendTef = 'off';
    chamadas.length = 0;
    const antes = await get(`SELECT COUNT(*) AS n FROM vendas`);
    armarCarrinho('cartao_credito');
    const fechamento = pdv.executarFinalizacaoVenda(true);
    await esperarModal();
    sandbox.clicar('confirmar-recebimento-fiscal-manual');
    await fechamento;
    await drenarAjax();
    const posts = urlsVenda();
    assert.equal(posts.length, 1);
    const corpo = JSON.parse(posts[0].body);
    const vendaId = (await get(`SELECT id FROM vendas ORDER BY id DESC LIMIT 1`)).id;
    const venda = await get(
      `SELECT id, empresa_id, total, valor_fiscal, valor_nao_fiscal, status_pagamento, tef_transacao_id
       FROM vendas WHERE id = ?`,
      [vendaId]
    );
    const pagamento = await get(
      `SELECT forma_pagamento, valor, tef_transacao_id FROM venda_pagamentos WHERE venda_id = ?`,
      [vendaId]
    );
    const recebimentos = await get(
      `SELECT COUNT(*) AS n FROM venda_recebimentos WHERE venda_id = ?`,
      [vendaId]
    );
    const depois = await get(`SELECT COUNT(*) AS n FROM vendas`);
    resultados.C2 = {
      confirmacao: corpo.confirmacao_fiscal_manual,
      empresaHeader: posts[0].headers['X-Empresa-Id'],
      httpEmpresa: Number(venda.empresa_id),
      total: Number(venda.total),
      valor_fiscal: Number(venda.valor_fiscal),
      valor_nao_fiscal: Number(venda.valor_nao_fiscal),
      status: venda.status_pagamento,
      vendasNovas: Number(depois.n) - Number(antes.n),
      sucesso: sandbox.notificacoes.filter((n) => n.msg === 'Venda finalizada com sucesso.').length
    };
    assert.equal(corpo.confirmacao_fiscal_manual, true);
    assert.equal(posts[0].headers['X-Empresa-Id'], String(empresaA.id));
    assert.equal(Number(venda.empresa_id), Number(empresaA.id));
    assert.equal(venda.status_pagamento, 'quitada');
    assert.equal(Number(venda.total), 10);
    assert.equal(Number(venda.valor_fiscal), 10);
    assert.equal(Number(venda.valor_nao_fiscal), 0);
    assert.equal(venda.tef_transacao_id, null);
    assert.equal(pagamento.tef_transacao_id, null);
    assert.equal(Number(pagamento.valor), 10);
    assert.ok(Number(recebimentos.n) >= 1);
    assert.equal(Number(depois.n), Number(antes.n) + 1);
    assert.equal(resultados.C2.sucesso, 1);
    assert.equal(pdv.carrinho.length, 0);
  });

  it('C3 — cancelar o modal não grava e permite tentar de novo', async () => {
    gravarModoConfirmacaoFiscal('MANUAL');
    controle.backendTef = 'off';
    chamadas.length = 0;
    const antes = await get(`SELECT COUNT(*) AS n FROM vendas`);
    const recebAntes = await get(`SELECT COUNT(*) AS n FROM venda_recebimentos`);
    armarCarrinho('cartao_credito');
    const primeira = pdv.executarFinalizacaoVenda(true);
    await esperarModal();
    sandbox.cancelarModal();
    await primeira;
    await drenarAjax();
    const meio = await get(`SELECT COUNT(*) AS n FROM vendas`);
    const recebMeio = await get(`SELECT COUNT(*) AS n FROM venda_recebimentos`);
    assert.equal(Number(meio.n), Number(antes.n));
    assert.equal(Number(recebMeio.n), Number(recebAntes.n));
    assert.equal(urlsVenda().length, 0);
    assert.equal(pdv.carrinho.length, 1);
    assert.equal(pdv.vendaEmProcessamento, false);

    const segunda = pdv.executarFinalizacaoVenda(true);
    await esperarModal();
    assert.equal(sandbox.modalEstado.exibicoes, 2);
    sandbox.cancelarModal();
    await segunda;
    await drenarAjax();
    const depois = await get(`SELECT COUNT(*) AS n FROM vendas`);
    resultados.C3 = {
      vendasNovas: Number(depois.n) - Number(antes.n),
      posts: urlsVenda().length,
      carrinho: pdv.carrinho.length,
      vendaEmProcessamento: pdv.vendaEmProcessamento,
      modalReaberto: sandbox.modalEstado.exibicoes
    };
    assert.equal(Number(depois.n), Number(antes.n));
    assert.equal(pdv.carrinho.length, 1);
    assert.equal(pdv.vendaEmProcessamento, false);
  });

  it('C4 — abrir o modal não envia confirmação implícita', async () => {
    gravarModoConfirmacaoFiscal('MANUAL');
    controle.backendTef = 'off';
    chamadas.length = 0;
    const antes = await get(`SELECT COUNT(*) AS n FROM vendas`);
    armarCarrinho('cartao_credito');
    const fechamento = pdv.executarFinalizacaoVenda(true);
    await esperarModal();
    assert.equal(urlsVenda().length, 0);
    assert.equal(chamadas.some((c) => String(c.body || '').includes('"confirmacao_fiscal_manual":true')), false);
    const direto = await httpJson(server, 'POST', '/api/vendas', corpoCartao(), {
      Authorization: `Bearer ${tokenOperador}`,
      'X-Empresa-Id': String(empresaA.id)
    });
    const durante = await get(`SELECT COUNT(*) AS n FROM vendas`);
    sandbox.cancelarModal();
    await fechamento;
    await drenarAjax();
    const depois = await get(`SELECT COUNT(*) AS n FROM vendas`);
    resultados.C4 = {
      postsAntesDoClique: 0,
      direto: direto.status,
      erro: direto.body && direto.body.error,
      vendasNovas: Number(depois.n) - Number(antes.n)
    };
    assert.ok(direto.status >= 400, JSON.stringify(direto.body));
    assert.match(String(direto.body && direto.body.error), /autorização do pagamento/i);
    assert.equal(Number(durante.n), Number(antes.n));
    assert.equal(Number(depois.n), Number(antes.n));
  });

  it('C5 — fora do modo MANUAL a confirmação manual não conclui a venda', async () => {
    gravarModoConfirmacaoFiscal('TEF');
    controle.backendTef = 'off';
    chamadas.length = 0;
    const antes = await get(`SELECT COUNT(*) AS n FROM vendas`);
    armarCarrinho('cartao_credito');
    await pdv.executarFinalizacaoVenda(true);
    await drenarAjax();
    const direto = await httpJson(server, 'POST', '/api/vendas', corpoCartao({
      confirmacao_fiscal_manual: true
    }), {
      Authorization: `Bearer ${tokenOperador}`,
      'X-Empresa-Id': String(empresaA.id)
    });
    const depois = await get(`SELECT COUNT(*) AS n FROM vendas`);
    resultados.C5 = {
      modal: sandbox.modalEstado.exibicoes,
      postsInterface: urlsVenda().length,
      direto: direto.status,
      erro: direto.body && direto.body.error,
      vendasNovas: Number(depois.n) - Number(antes.n),
      notificacao: sandbox.notificacoes.map((n) => n.msg)
    };
    assert.equal(sandbox.modalEstado.exibicoes, 0);
    assert.equal(urlsVenda().length, 0);
    assert.equal(chamadas.some((c) => String(c.body || '').includes('confirmacao_fiscal_manual')), false);
    assert.ok(direto.status >= 400, JSON.stringify(direto.body));
    assert.equal(Number(depois.n), Number(antes.n));
    assert.equal(pdv.carrinho.length, 1);
    assert.equal(pdv.vendaEmProcessamento, false);
  });

  it('C6 — dinheiro segue sem o modal manual', async () => {
    gravarModoConfirmacaoFiscal('TEF');
    controle.backendTef = 'on';
    chamadas.length = 0;
    const antes = await get(`SELECT COUNT(*) AS n FROM vendas`);
    armarCarrinho('dinheiro');
    await pdv.executarFinalizacaoVenda(true);
    await drenarAjax();
    const posts = urlsVenda();
    const depois = await get(`SELECT COUNT(*) AS n FROM vendas`);
    const venda = await get(
      `SELECT forma_pagamento, status_pagamento, valor_fiscal FROM vendas ORDER BY id DESC LIMIT 1`
    );
    resultados.C6 = {
      modal: sandbox.modalEstado.exibicoes,
      posts: posts.length,
      forma: venda && venda.forma_pagamento,
      status: venda && venda.status_pagamento,
      vendasNovas: Number(depois.n) - Number(antes.n)
    };
    assert.equal(sandbox.modalEstado.exibicoes, 0);
    assert.equal(posts.length, 1);
    assert.equal(JSON.parse(posts[0].body).confirmacao_fiscal_manual, undefined);
    assert.equal(venda.forma_pagamento, 'dinheiro');
    assert.equal(venda.status_pagamento, 'quitada');
    assert.equal(Number(depois.n), Number(antes.n) + 1);
    assert.equal(sandbox.notificacoes.filter((n) => n.msg === 'Venda finalizada com sucesso.').length, 1);
  });

  it('C7 — o fluxo automático com mock continua fechando sem o modal', async () => {
    gravarModoConfirmacaoFiscal('TEF');
    controle.backendTef = 'on';
    chamadas.length = 0;
    const mockAntes = pagamentosMock.length;
    const reaisAntes = autorizacoesReais.length;
    armarCarrinho('cartao_credito');
    await pdv.executarFinalizacaoVenda(true);
    await drenarAjax();
    const tef = chamadas.filter((c) => c.tipo === 'fetch' && String(c.url).includes('/tef/pagar'));
    const posts = urlsVenda();
    const corpo = JSON.parse(posts[0].body);
    const venda = await get(
      `SELECT status_pagamento, tef_transacao_id FROM vendas ORDER BY id DESC LIMIT 1`
    );
    resultados.C7 = {
      modal: sandbox.modalEstado.exibicoes,
      fetchesTef: tef.length,
      posts: posts.length,
      ordem: chamadas.indexOf(tef[0]) < chamadas.indexOf(posts[0]),
      status: venda.status_pagamento,
      tef: venda.tef_transacao_id,
      mock: pagamentosMock.length - mockAntes,
      autorizacoesReais: autorizacoesReais.length - reaisAntes
    };
    assert.equal(sandbox.modalEstado.exibicoes, 0);
    assert.equal(tef.length, 1);
    assert.equal(posts.length, 1);
    assert.equal(resultados.C7.ordem, true);
    assert.equal(corpo.confirmacao_fiscal_manual, undefined);
    assert.ok(corpo.pagamentos[0].tef_transacao_id);
    assert.equal(venda.status_pagamento, 'quitada');
    assert.equal(Number(venda.tef_transacao_id), Number(corpo.pagamentos[0].tef_transacao_id));
    assert.equal(pagamentosMock.length, mockAntes + 1);
    assert.equal(autorizacoesReais.length, reaisAntes);
    assert.equal(emissoesFiscais.length, 0);
  });
});
