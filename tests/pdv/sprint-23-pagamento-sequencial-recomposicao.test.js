/**
 * Sprint 23 — pagamento sequencial e recomposição dinâmica.
 * Banco temporário. Sem TEF real, PIX, adquirente, NFC-e, NF-e ou SEFAZ.
 *
 * Executar: node --test --test-concurrency=1 tests/pdv/sprint-23-pagamento-sequencial-recomposicao.test.js
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

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-sprint23-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;
delete process.env.CDS_TEF_VINCULO_FALHA;
delete process.env.CDS_RECOMPOSICAO_HOMOLOGACAO_DISTRIBUIR;
delete process.env.CDS_RECOMPOSICAO_APLICAR_DISTRIBUICAO;

const { isolarBancoTeste } = require('../central-entradas/helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-sprint23-');
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
const { avaliarPagamentosSequenciais } = require('../../backend/services/vendas/PagamentoSequencialComposicaoService');
const {
  RECOMPOSICAO_HABILITADA_EM_PRODUCAO
} = require('../../backend/services/vendas/RecomposicaoFiscalContratoService');
const {
  encaminharPropostaValidadaAoDistribuidorOficial
} = require('../../backend/services/vendas/RecomposicaoFiscalFechamentoAdaptadorService');
const {
  distribuirItensVendaComValorFiscalEfetivo
} = require('../../backend/services/distribuidorEstoqueVenda');
const PagamentoSequencial = require('../../frontend/pdv/js/pagamentoSequencial');

const CNPJ_A = '11222333000181';
const autorizacoesReais = [];
const emissoesFiscais = [];

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

function aprovar(id, forma) {
  return {
    aprovado: true,
    status: 'aprovado',
    transacao_id: id,
    nsu: `NSU-${forma}-${id}`,
    autorizacao: `AUT-${forma}-${id}`
  };
}

describe('Sprint 23 — pagamento sequencial e recomposição', { concurrency: false }, () => {
  before(async () => {
    await whenReady();
    await garantirSchemaEstoqueEmpresaAsync(db);
    await garantirSchemaUsuarioEmpresasAsync(db);
    empresaA = await EmpresaService.criarEmpresa(
      { cnpj: CNPJ_A, razao_social: 'Pastelaria A Sprint 23' },
      { db }
    );
    const produto = await run(
      `INSERT INTO produtos (
         nome, unidade, tipo_operacional, controla_estoque,
         saldo_fiscal, saldo_nao_fiscal, estoque_atual, preco_venda, ativo
       ) VALUES ('Pastel sprint 23', 'UN', 'COMERCIAL', 1, 0, 100, 100, 50, 1)`
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
    await run(
      `UPDATE produtos SET saldo_fiscal = 0, saldo_nao_fiscal = 100, estoque_atual = 100 WHERE id = ?`,
      [produtoId]
    );
    const operador = await run(
      `INSERT INTO usuarios (username, password_hash, role, nome, perfil, ativo)
       VALUES ('op23', 'x', 'operador', 'Operador 23', 'CAIXA', 1)`
    );
    await run(
      `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`,
      [operador.lastID, empresaA.id]
    );
    tokenOperador = jwt.sign(
      { id: operador.lastID, usuario_id: operador.lastID, username: 'op23', role: 'operador', perfil: 'CAIXA' },
      getJwtSecret(),
      { expiresIn: '2h' }
    );
    const terminal = await run(`INSERT INTO terminais (nome, hostname) VALUES ('PDV-23', 'sprint23')`);
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
    const contextoEmpresa = criarMiddlewareContextoEmpresa(db);
    const aplicarModelo = middlewareAplicarPdvModeloEmpresa({ db, canalHttpVendas: true });
    app.post('/api/vendas', verificarToken, contextoEmpresa, aplicarModelo, validarCaixaSeOrigemPdv, (req, res) => {
      if (req.body && req.body.emitir_fiscal === true) emissoesFiscais.push(req.body.emitir_fiscal);
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
    assert.equal(RECOMPOSICAO_HABILITADA_EM_PRODUCAO, false);
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    console.log(`SPRINT23_RESULTADOS ${JSON.stringify({
      dbDir,
      dbPath: db.dbPath,
      autorizacoesReais: autorizacoesReais.length,
      emissoesFiscais: emissoesFiscais.length
    })}`);
  });

  it('1 a 10 — parcelas sequenciais, falha TEF, duplo clique e invalidação', async () => {
    PagamentoSequencial.reset();
    const chamadas = [];
    const debito = await PagamentoSequencial.adicionar({
      forma: 'cartao_debito',
      valor: 20,
      totalVenda: 50,
      formaUsaTef: () => true,
      autorizarTef: async (forma, valor) => {
        chamadas.push({ forma, valor });
        return aprovar(11, 'DEBITO');
      }
    });
    assert.equal(debito.ok, true);
    assert.equal(debito.parcela.status_autorizacao, 'aprovada');
    assert.equal(debito.parcela.tef_transacao_id, 11);

    const credito = await PagamentoSequencial.adicionar({
      forma: 'cartao_credito',
      valor: 20,
      totalVenda: 50,
      formaUsaTef: () => true,
      autorizarTef: async (forma, valor) => {
        chamadas.push({ forma, valor });
        return aprovar(12, 'CREDITO');
      }
    });
    assert.equal(credito.ok, true);
    assert.equal(credito.parcelas.length, 2);
    assert.equal(credito.parcelas[0].tef_transacao_id, 11);
    assert.equal(credito.parcelas[1].tef_transacao_id, 12);

    const dinheiro = await PagamentoSequencial.adicionar({
      forma: 'dinheiro',
      valor: 10,
      totalVenda: 50,
      formaUsaTef: (forma) => forma !== 'dinheiro',
      autorizarTef: async () => {
        chamadas.push({ forma: 'inesperado' });
        return aprovar(99, 'DINHEIRO');
      }
    });
    assert.equal(dinheiro.ok, true);
    assert.equal(dinheiro.parcelas.length, 3);
    assert.equal(chamadas.length, 2);
    assert.equal(PagamentoSequencial.soma(), 50);

    const fechamento = await PagamentoSequencial.autorizarParcelasPendentes(
      PagamentoSequencial.exportar(),
      {
        tefHabilitado: true,
        formaUsaTef: (forma) => forma !== 'dinheiro',
        autorizarTef: async () => {
          chamadas.push({ forma: 'reautorizacao' });
          return aprovar(77, 'RE');
        }
      }
    );
    assert.equal(chamadas.some((chamada) => chamada.forma === 'reautorizacao'), false);
    assert.equal(fechamento.length, 3);
    assert.equal(fechamento[0].tef_transacao_id, 11);
    assert.equal(fechamento[1].tef_transacao_id, 12);

    const editada = PagamentoSequencial.alterar(debito.parcela.local_id, 15);
    assert.equal(editada.ok, false);
    assert.equal(editada.codigo, 'PARCELA_TEF_APROVADA');
    const cancelada = PagamentoSequencial.cancelar(debito.parcela.local_id);
    assert.equal(cancelada.ok, false);
    assert.equal(cancelada.codigo, 'PARCELA_TEF_APROVADA');

    PagamentoSequencial.registrarComposicao({ sucesso: true, total_comercial: 50 });
    assert.equal(PagamentoSequencial.composicaoValida(), true);
    const dinheiroId = dinheiro.parcela.local_id;
    const alteracao = PagamentoSequencial.alterar(dinheiroId, 8);
    assert.equal(alteracao.ok, true);
    assert.equal(PagamentoSequencial.composicaoValida(), false);

    PagamentoSequencial.reset();
    await PagamentoSequencial.adicionar({
      forma: 'cartao_debito',
      valor: 20,
      totalVenda: 50,
      formaUsaTef: () => true,
      autorizarTef: async () => aprovar(21, 'DEBITO')
    });
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

    const timeout = await PagamentoSequencial.adicionar({
      forma: 'cartao_credito',
      valor: 20,
      totalVenda: 50,
      formaUsaTef: () => true,
      autorizarTef: async () => {
        throw new Error('timeout de comunicação');
      }
    });
    assert.equal(timeout.ok, false);
    assert.equal(timeout.codigo, 'TEF_FALHA');
    assert.equal(PagamentoSequencial.snapshot().length, 1);

    PagamentoSequencial.reset();
    let liberar;
    const pendente = new Promise((resolve) => { liberar = resolve; });
    let disparos = 0;
    const primeira = PagamentoSequencial.adicionar({
      forma: 'cartao_debito',
      valor: 20,
      totalVenda: 50,
      formaUsaTef: () => true,
      autorizarTef: () => {
        disparos += 1;
        return pendente;
      }
    });
    const segunda = await PagamentoSequencial.adicionar({
      forma: 'cartao_credito',
      valor: 20,
      totalVenda: 50,
      formaUsaTef: () => true,
      autorizarTef: () => {
        disparos += 1;
        return Promise.resolve(aprovar(33, 'CREDITO'));
      }
    });
    assert.equal(segunda.ok, false);
    assert.equal(segunda.codigo, 'AUTORIZACAO_EM_CURSO');
    assert.equal(disparos, 1);
    liberar(aprovar(31, 'DEBITO'));
    const concluida = await primeira;
    assert.equal(concluida.ok, true);
    assert.equal(PagamentoSequencial.snapshot().length, 1);
  });

  it('4 a 6 — motor de composição recebe os três pagamentos e preserva R$ 50,00', () => {
    const pagamentos = [
      { forma_pagamento: 'cartao_debito', valor: 20, tef_transacao_id: 11 },
      { forma_pagamento: 'cartao_credito', valor: 20, tef_transacao_id: 12 },
      { forma_pagamento: 'dinheiro', valor: 10 }
    ];
    const composicao = avaliarPagamentosSequenciais({
      total: 50,
      pagamentos,
      itens: [{ produto_id: 1, quantidade: 1, subtotal: 50 }]
    });
    assert.equal(composicao.sucesso, true);
    assert.equal(composicao.total_comercial, 50);
    assert.equal(composicao.total_financeiro, 50);
    assert.equal(composicao.quantidade_parcelas, 3);
    assert.equal(composicao.inclui_dinheiro, true);
    assert.equal(composicao.margem_dinheiro.dinheiro_recebido, 10);
    assert.equal(composicao.margem_dinheiro.margem_maxima, 2);
    assert.equal(composicao.margem_dinheiro.nao_e_desconto, true);
    assert.equal(composicao.margem_convertida_em_desconto, false);
    assert.equal(composicao.valor_fiscal_candidato, null);
    assert.equal(composicao.valor_fiscal_presumido, false);
    assert.equal(composicao.recomposicao_habilitada_em_producao, false);
    assert.deepEqual(
      composicao.pagamentos.map((pagamento) => pagamento.valor),
      [20, 20, 10]
    );
  });

  it('11 — falha da recomposição impede a finalização', async () => {
    const antes = await get(`SELECT COUNT(*) AS total FROM vendas`);
    const resposta = await httpJson('POST', '/api/vendas', {
      headers: headers(),
      body: {
        origem: 'PDV',
        terminal_id: terminalId,
        venda_fiscal: false,
        emitir_fiscal: false,
        pagamento_sequencial: true,
        forma_pagamento: 'misto',
        desconto: 0,
        acrescimo: 0,
        total: 50,
        itens: [{
          produto_id: produtoId,
          quantidade: 1,
          preco_unitario: 50,
          subtotal: 50,
          tipo_venda: 'UNIDADE'
        }],
        pagamentos: [
          { forma_pagamento: 'cartao_debito', valor: 20 },
          { forma_pagamento: 'dinheiro', valor: 10 }
        ]
      }
    });
    const depois = await get(`SELECT COUNT(*) AS total FROM vendas`);
    assert.equal(resposta.status, 400);
    assert.equal(resposta.body.codigo, 'SOMA_PAGAMENTOS_DIVERGENTE');
    assert.equal(Number(depois.total), Number(antes.total));
  });

  it('12 e 13 — persiste as três parcelas, vincula o TEF e usa o distribuidor oficial', async () => {
    const debito = await run(`
      INSERT INTO tef_transacoes (
        venda_id, empresa_id, tipo, valor, parcelas, status, provedor, adquirente, bandeira,
        nsu, autorizacao, codigo_transacao, idempotency_key, criado_em, atualizado_em
      ) VALUES (NULL, ?, 'cartao_debito', 20, 1, 'aprovado', 'MOCK', 'MOCK', 'MOCK',
        'NSU-DEB-23', 'AUT-DEB-23', 'MOCK', 'seq-deb-23', datetime('now'), datetime('now'))
    `, [empresaA.id]);
    const credito = await run(`
      INSERT INTO tef_transacoes (
        venda_id, empresa_id, tipo, valor, parcelas, status, provedor, adquirente, bandeira,
        nsu, autorizacao, codigo_transacao, idempotency_key, criado_em, atualizado_em
      ) VALUES (NULL, ?, 'cartao_credito', 20, 1, 'aprovado', 'MOCK', 'MOCK', 'MOCK',
        'NSU-CRED-23', 'AUT-CRED-23', 'MOCK', 'seq-cred-23', datetime('now'), datetime('now'))
    `, [empresaA.id]);

    const corpo = {
      origem: 'PDV',
      terminal_id: terminalId,
      venda_fiscal: false,
      emitir_fiscal: false,
      pagamento_sequencial: true,
      forma_pagamento: 'misto',
      desconto: 0,
      acrescimo: 0,
      total: 50,
      valor_recebido: 50,
      itens: [{
        produto_id: produtoId,
        quantidade: 1,
        preco_unitario: 50,
        subtotal: 50,
        tipo_venda: 'UNIDADE'
      }],
      pagamentos: [
        {
          forma_pagamento: 'cartao_debito',
          valor: 20,
          tef_transacao_id: debito.lastID,
          nsu: 'NSU-DEB-23',
          autorizacao: 'AUT-DEB-23'
        },
        {
          forma_pagamento: 'cartao_credito',
          valor: 20,
          tef_transacao_id: credito.lastID,
          nsu: 'NSU-CRED-23',
          autorizacao: 'AUT-CRED-23'
        },
        { forma_pagamento: 'dinheiro', valor: 10 }
      ]
    };
    const resposta = await httpJson('POST', '/api/vendas', { headers: headers(), body: corpo });
    assert.equal(resposta.status, 200, JSON.stringify(resposta.body));
    const vendaId = resposta.body.id || resposta.body.venda_id || (resposta.body.venda && resposta.body.venda.id);
    assert.ok(vendaId, JSON.stringify(resposta.body));

    const venda = await get(`SELECT total, desconto, acrescimo, valor_fiscal, valor_nao_fiscal FROM vendas WHERE id = ?`, [vendaId]);
    assert.equal(Number(venda.total), 50);
    assert.equal(Number(venda.desconto), 0);
    assert.equal(Number(venda.acrescimo), 0);
    assert.notEqual(Number(venda.valor_fiscal), 40);

    const pagamentos = await all(
      `SELECT forma_pagamento, valor, tef_transacao_id, tef_nsu, tef_autorizacao
       FROM venda_pagamentos WHERE venda_id = ? ORDER BY id`,
      [vendaId]
    );
    assert.equal(pagamentos.length, 3);
    assert.equal(Number(pagamentos[0].tef_transacao_id), debito.lastID);
    assert.equal(pagamentos[0].tef_nsu, 'NSU-DEB-23');
    assert.equal(pagamentos[0].tef_autorizacao, 'AUT-DEB-23');
    assert.equal(Number(pagamentos[1].tef_transacao_id), credito.lastID);
    assert.equal(Number(pagamentos[2].valor), 10);

    const vinculos = await all(
      `SELECT id, venda_id FROM tef_transacoes WHERE id IN (?, ?)`,
      [debito.lastID, credito.lastID]
    );
    assert.equal(vinculos.every((linha) => Number(linha.venda_id) === Number(vendaId)), true);

    const reutilizada = await httpJson('POST', '/api/vendas', { headers: headers(), body: corpo });
    assert.notEqual(reutilizada.status, 200, JSON.stringify(reutilizada.body));
    const vendasComTotal = await get(`SELECT COUNT(*) AS total FROM vendas WHERE total = 50`);
    assert.equal(Number(vendasComTotal.total), 1);

    const distribuicao = distribuirItensVendaComValorFiscalEfetivo(
      [{
        item: { produto_id: produtoId, quantidade: 1, preco_unitario: 50, subtotal: 50 },
        saldoFiscal: 0,
        saldoNaoFiscal: 100
      }],
      false,
      {
        pagamentos: corpo.pagamentos,
        desconto: 0,
        acrescimo: 0
      }
    );
    assert.equal(distribuicao.sucesso, true);
    const fiscalOficial = Number(distribuicao.itens[0].valor_fiscal);
    const naoFiscalOficial = Number(distribuicao.itens[0].valor_nao_fiscal);
    assert.equal(Math.round((fiscalOficial + naoFiscalOficial) * 100) / 100, 50);
    assert.notEqual(fiscalOficial, 40);
    assert.equal(Number(venda.valor_fiscal), fiscalOficial);
    assert.equal(Number(venda.valor_nao_fiscal), naoFiscalOficial);

    const bloqueio = await encaminharPropostaValidadaAoDistribuidorOficial({
      totalComercial: 50,
      pagamentos: corpo.pagamentos,
      env: {}
    });
    assert.equal(bloqueio.distribuicao_aplicada, false);
    assert.equal(bloqueio.codigo, 'AUTORIZACAO_AUSENTE');
    assert.equal(bloqueio.producao_habilitada, false);
    assert.equal(bloqueio.margem_nao_convertida_em_desconto, true);
    assert.equal(bloqueio.desconto_enviado_ao_distribuidor, 0);
  });

  it('15 — comprovante não exibe pagamento, NSU nem autorização', () => {
    const cupomCtx = { console, window: {} };
    cupomCtx.window = cupomCtx;
    vm.createContext(cupomCtx);
    vm.runInContext(
      fs.readFileSync(path.join(__dirname, '../../frontend/shared/js/fiscalImpressao.js'), 'utf8'),
      cupomCtx
    );
    const cupom = vm.runInContext(`
      montarHtmlCupomNaoFiscal(1, {
        nome_empresa: 'Pastelaria',
        forma_pagamento: 'misto',
        acrescimo: 0,
        desconto: 0,
        valor_nao_fiscal: 50,
        valor_fiscal_candidato: 40,
        itens: [{ produto_nome: 'Pastel', quantidade: 1, preco_unitario: 50, subtotal: 50 }],
        venda_pagamentos: [
          { forma_pagamento: 'cartao_debito', valor: 20, tef_nsu: 'NSU-DEB-23', tef_autorizacao: 'AUT-DEB-23' },
          { forma_pagamento: 'cartao_credito', valor: 20, tef_nsu: 'NSU-CRED-23', tef_autorizacao: 'AUT-CRED-23' },
          { forma_pagamento: 'dinheiro', valor: 10 }
        ]
      }, 50, 0)
    `, cupomCtx);
    assert.match(cupom, /Total: R\$ 50,00/);
    assert.equal(cupom.includes('NSU'), false);
    assert.equal(cupom.includes('AUT-'), false);
    assert.equal(cupom.includes('Cartão'), false);
    assert.equal(cupom.includes('Dinheiro'), false);
    assert.equal(cupom.includes('valor_fiscal_candidato'), false);
  });
});
