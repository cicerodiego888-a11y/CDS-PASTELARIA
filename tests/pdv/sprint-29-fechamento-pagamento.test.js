/**
 * Sprint PDV-UX-29 — fechamento do pagamento.
 * Banco temporário. Sem TEF, PIX ou documento fiscal reais.
 *
 * Executar: node --test --test-concurrency=1 tests/pdv/sprint-29-fechamento-pagamento.test.js
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

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-sprint29-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
process.env.CDS_RECOMPOSICAO_REFERENCIA_TESTE = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;
delete process.env.CDS_TEF_VINCULO_FALHA;
delete process.env.CDS_RECOMPOSICAO_HOMOLOGACAO_DISTRIBUIR;
delete process.env.CDS_RECOMPOSICAO_APLICAR_DISTRIBUICAO;
delete process.env.RECOMPOSICAO_HABILITADA_EM_PRODUCAO;

const { isolarBancoTeste } = require('../central-entradas/helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-sprint29-');
const db = require('../../backend/database');
isolamento.comprobar(db);

const { getJwtSecret } = require('../../backend/config/secrets');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const EstoqueEmpresaService = require('../../backend/services/estoque/EstoqueEmpresaService');
const { garantirSchemaEstoqueEmpresaAsync } = require('../../backend/services/estoque/estoqueEmpresaSchema');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');
const { verificarToken } = require('../../backend/middleware/auth');
const { criarMiddlewareContextoEmpresa } = require('../../backend/services/fiscalNaoFiscal/empresaContexto');
const tefConfigService = require('../../backend/services/tef/tefConfigService');
const tefManager = require('../../backend/services/tef/TefManager');
const configService = require('../../backend/services/configuracaoService');
const {
  RECOMPOSICAO_HABILITADA_EM_PRODUCAO
} = require('../../backend/services/vendas/RecomposicaoFiscalContratoService');
const {
  integrarPagamentoRecomposicao
} = require('../../backend/services/vendas/PagamentoRecomposicaoDocumentoService');
const PagamentoSequencial = require('../../frontend/pdv/js/pagamentoSequencial');
const InteracaoPagamentoMisto = require('../../frontend/pdv/js/interacaoPagamentoMisto');
const vendasRouter = require('../../backend/rotas/vendas');

const pdvFonte = fs.readFileSync(
  path.join(__dirname, '../../frontend/pdv/js/pdv.js'),
  'utf8'
);
const fluxoFonte = fs.readFileSync(
  path.join(__dirname, '../../frontend/shared/js/tefFluxoPagamento.js'),
  'utf8'
);
const fluxo = vm.runInNewContext(`${fluxoFonte}; TefFluxoPagamento;`, { console });

configService.getModoConfirmacaoFiscal = function modoTef() { return 'TEF'; };
tefConfigService.obterConfiguracao = async function cfg() { return { tefHabilitado: false, pix: false }; };
const autorizacoesReais = [];
tefManager.autorizar = async function bloqueada() {
  autorizacoesReais.push(1);
  const err = new Error('TEF_REAL_BLOQUEADO');
  err.code = 'TEF_REAL_BLOQUEADO';
  throw err;
};

function aprovar(forma, valor, id) {
  return {
    aprovado: true,
    status: 'aprovado',
    transacao_id: id,
    nsu: `NSU-${id}`,
    autorizacao: `AUT-${id}`
  };
}

async function pagar(interacao, forma, valor, retorno) {
  interacao.escolherForma(forma);
  return interacao.confirmarValor(valor, {
    formaUsaTef: (formaParcela) => PagamentoSequencial.formaExigeAutorizador(formaParcela),
    autorizarTef: async () => retorno
  });
}

describe('Sprint 29 — decisão de pagamento e modal', { concurrency: false }, () => {
  it('1. PIX aprovado e integral dispensa a confirmação fiscal extra', async () => {
    PagamentoSequencial.reset();
    const interacao = InteracaoPagamentoMisto.criar({ totalVenda: 50, sequencial: PagamentoSequencial });
    const resultado = await pagar(interacao, 'pix', 50, aprovar('pix', 50, 11));
    assert.equal(resultado.ok, true);
    assert.equal(interacao.visao().podeFinalizar, true);
    assert.equal(interacao.visao().restante, 0);
    const lista = PagamentoSequencial.exportar();
    assert.equal(lista.length, 1);
    assert.equal(lista[0].tef_transacao_id, 11);
    assert.equal(fluxo.listaSequencialJaConfirmada(lista).dispensaModalExtra, true);
  });

  it('2 e 3. PIX parcial com dinheiro, e dinheiro parcial com PIX', async () => {
    PagamentoSequencial.reset();
    const pixDepois = InteracaoPagamentoMisto.criar({ totalVenda: 50, sequencial: PagamentoSequencial });
    await pagar(pixDepois, 'pix', 20, aprovar('pix', 20, 21));
    assert.equal(pixDepois.visao().podeFinalizar, false);
    assert.equal(pixDepois.visao().restante, 30);
    await pagar(pixDepois, 'dinheiro', 30, null);
    assert.equal(pixDepois.visao().podeFinalizar, true);
    assert.equal(fluxo.listaSequencialJaConfirmada(PagamentoSequencial.exportar()).dispensaModalExtra, true);

    PagamentoSequencial.reset();
    const dinheiroAntes = InteracaoPagamentoMisto.criar({ totalVenda: 50, sequencial: PagamentoSequencial });
    await pagar(dinheiroAntes, 'dinheiro', 10, null);
    await pagar(dinheiroAntes, 'pix', 40, aprovar('pix', 40, 22));
    assert.equal(dinheiroAntes.visao().podeFinalizar, true);
    assert.equal(fluxo.listaSequencialJaConfirmada(PagamentoSequencial.exportar()).dispensaModalExtra, true);
  });

  it('4. débito, crédito e dinheiro confirmados seguem sem modal extra', async () => {
    PagamentoSequencial.reset();
    const interacao = InteracaoPagamentoMisto.criar({ totalVenda: 50, sequencial: PagamentoSequencial });
    await pagar(interacao, 'cartao_debito', 20, aprovar('cartao_debito', 20, 31));
    await pagar(interacao, 'cartao_credito', 20, aprovar('cartao_credito', 20, 32));
    await pagar(interacao, 'dinheiro', 10, null);
    const lista = PagamentoSequencial.exportar();
    assert.equal(lista.length, 3);
    assert.equal(fluxo.listaSequencialJaConfirmada(lista).dispensaModalExtra, true);
    assert.equal(interacao.visao().podeFinalizar, true);
  });

  it('5, 6 e 7. recusa, timeout e pendência não entram como recebidos', async () => {
    for (const retorno of [
      { aprovado: false, status: 'negado', codigo: 'TEF_REJEITADO' },
      { aprovado: false, status: 'timeout', codigo: 'TIMEOUT' },
      { aprovado: false, status: 'pendente', codigo: 'PENDENTE', transacao_id: 99 }
    ]) {
      PagamentoSequencial.reset();
      const interacao = InteracaoPagamentoMisto.criar({ totalVenda: 50, sequencial: PagamentoSequencial });
      const resultado = await pagar(interacao, 'pix', 50, retorno);
      assert.equal(resultado.ok, false);
      assert.equal(PagamentoSequencial.exportar().length, 0);
      assert.equal(PagamentoSequencial.soma(), 0);
      assert.equal(interacao.visao().podeFinalizar, false);
    }
    const pendente = fluxo.listaSequencialJaConfirmada([
      { forma_pagamento: 'pix', valor: 50, status_autorizacao: 'pendente', tef_transacao_id: 99 }
    ]);
    assert.equal(pendente.dispensaModalExtra, false);
    assert.equal(pendente.codigo, 'PARCELA_NAO_CONFIRMADA');
  });

  it('8 e 9. saldo restante bloqueia; pagamento integral libera o fechamento', () => {
    const incompleta = [
      { forma_pagamento: 'pix', valor: 20, status_autorizacao: 'aprovada', tef_transacao_id: 41 }
    ];
    assert.equal(fluxo.listaSequencialJaConfirmada(incompleta).dispensaModalExtra, true);
    const trecho = pdvFonte.slice(
      pdvFonte.indexOf('function iniciarFechamentoDireto'),
      pdvFonte.indexOf('function desenharPagamentoDireto')
    );
    assert.match(trecho, /!interacao\.visao\(\)\.podeFinalizar/);
    assert.match(trecho, /Ainda há saldo restante/);
    const semAutorizacao = fluxo.listaSequencialJaConfirmada([
      { forma_pagamento: 'pix', valor: 50, status_autorizacao: 'aprovada' }
    ]);
    assert.equal(semAutorizacao.codigo, 'PARCELA_ELETRONICA_SEM_AUTORIZACAO');
  });

  it('a lista sequencial não reabre a confirmação fiscal e o modal PIX é encerrado', () => {
    const ramo = pdvFonte.slice(
      pdvFonte.indexOf("if (ramoFechamento === 'lista_sequencial')"),
      pdvFonte.indexOf("} else if (ramoFechamento === 'pagamento_unico_fiscal')")
    );
    assert.equal(ramo.includes('processarVendaFiscalManual'), false);
    assert.match(ramo, /listaSequencialJaConfirmada/);
    assert.match(pdvFonte, /function fecharModalValorDireto/);
    assert.match(pdvFonte, /encerrarModalPix: true/);
    assert.match(pdvFonte, /\$\('body'\)\.append\(`\s*<div class="modal fade" id="modalPixTefPDV"/);
    assert.equal(pdvFonte.includes("$('#modal-container').html(`\n            <div class=\"modal fade\" id=\"modalPixTefPDV\""), false);
    assert.match(pdvFonte, /if \(interacao\.visao\(\)\.podeFinalizar\) iniciarFechamentoDireto\(\)/);
    assert.equal(RECOMPOSICAO_HABILITADA_EM_PRODUCAO, false);
    assert.match(fluxoFonte, /function listaSequencialJaConfirmada/);
  });
});

function somaProdutos(xml) {
  const itens = String(xml || '').split('<total>')[0];
  const encontrados = itens.match(/<vProd>([0-9.]+)<\/vProd>/g) || [];
  return encontrados.reduce((total, trecho) => total + Number(trecho.replace(/[^\d.]/g, '')), 0);
}

describe('Sprint 29 — recomposição preservada', { concurrency: false }, () => {
  it('10 e 11. referência 40/10 compõe; sem composição o bloqueio é identificado', async () => {
    assert.equal(RECOMPOSICAO_HABILITADA_EM_PRODUCAO, false);
    const documento = await integrarPagamentoRecomposicao({
      total: 50,
      empresaId: 7,
      pagamentos: [
        { forma_pagamento: 'cartao_debito', valor: 20, status_autorizacao: 'aprovada' },
        { forma_pagamento: 'cartao_credito', valor: 20, status_autorizacao: 'aprovada' },
        { forma_pagamento: 'dinheiro', valor: 10, status_autorizacao: 'informada' }
      ],
      itens: [
        {
          produto_id: 1, produto_nome: 'Pastel', categoria_nome: 'PASTEIS',
          quantidade: 1, preco_unitario: 20, subtotal: 20, produto_ncm: '19059090',
          cfop: '5102', csosn: '102', unidade: 'UN', origem: 0
        },
        {
          produto_id: 2, produto_nome: 'Refrigerante', categoria_nome: 'REFRIGERANTES',
          quantidade: 6, preco_unitario: 5, subtotal: 30, produto_ncm: '22021000',
          cfop: '5102', csosn: '102', unidade: 'UN', origem: 0
        }
      ],
      saldosPorProduto: {
        1: { saldoFiscal: 1, saldoNaoFiscal: 0 },
        2: { saldoFiscal: 4, saldoNaoFiscal: 2 }
      },
      configFiscal: {
        codigoUf: '23', cnpj: '65957340000150', ie: '073252638', crt: 1, ambiente: 2,
        serie: 1, nomeEmpresa: 'EMPRESA TESTE LTDA', logradouro: 'RUA A', numero: '100',
        bairro: 'CENTRO', codigo_municipio: '2307304', municipio: 'JUAZEIRO DO NORTE',
        uf: 'CE', cep: '63000000', telefone: '8835110000', csosn_padrao: '102'
      }
    }, {
      env: { CDS_RECOMPOSICAO_REFERENCIA_TESTE: '1' },
      harnessDistribuicaoOficial: { ativa: true },
      modelos: [{
        produtoId: 2,
        nome: 'Refrigerante',
        categoriaFiscal: 'REFRIGERANTE',
        volumeMlPorUnidade: 1,
        quantidadeMaxima: 6,
        cotador: {
          precoUnitarioMinimoInterno: 5,
          cotar(quantidade) {
            return { subtotalCentavos: 500 * quantidade, precoUnitarioInterno: 5, regrasAplicadas: [], fingerprint: 'r' };
          }
        }
      }],
      capacidade_por_categoria: { REFRIGERANTE: 100 }
    });
    assert.equal(documento.referencia.valor_fiscal_referencia, 40);
    assert.equal(documento.referencia.valor_nao_fiscal_referencia, 10);
    assert.equal(documento.bloqueado, false);
    assert.equal(somaProdutos(documento.xml), 40);

    const ausente = await integrarPagamentoRecomposicao({
      total: 50,
      empresaId: 7,
      pagamentos: [
        { forma_pagamento: 'pix', valor: 40, status_autorizacao: 'aprovada' },
        { forma_pagamento: 'dinheiro', valor: 10, status_autorizacao: 'informada' }
      ],
      itens: [{
        produto_id: 1, produto_nome: 'Pastel', categoria_nome: 'PASTEIS',
        quantidade: 1, preco_unitario: 20, subtotal: 20, produto_ncm: '19059090',
        cfop: '5102', csosn: '102', unidade: 'UN', origem: 0
      }, {
        produto_id: 2, produto_nome: 'Refrigerante', categoria_nome: 'REFRIGERANTES',
        quantidade: 6, preco_unitario: 5, subtotal: 30, produto_ncm: '22021000',
        cfop: '5102', csosn: '102', unidade: 'UN', origem: 0
      }]
    }, {
      env: { CDS_RECOMPOSICAO_REFERENCIA_TESTE: '1' },
      modelos: []
    });
    assert.equal(ausente.bloqueado, true);
    assert.equal(ausente.xml, null);
    assert.ok(ausente.codigo);
  });
});

let empresaA;
let produtoId;
let tokenOperador;
let terminalId;
let server;
const emissoes = [];

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
function reconhecerVenda(resposta) {
  const corpo = resposta && resposta.body;
  const vendaId = corpo && (corpo.venda_id || corpo.id || corpo.vendaId);
  if (resposta.status !== 200 || !vendaId) {
    return { concluida: false, vendaId: null };
  }
  return { concluida: true, vendaId: Number(vendaId), repetida: corpo.venda_ja_persistida === true };
}
function pedido(chave, pagamentos, total) {
  return {
    origem: 'PDV',
    terminal_id: terminalId,
    chave_fechamento_pdv: chave,
    venda_fiscal: false,
    emitir_fiscal: false,
    pagamento_sequencial: true,
    confirmacao_fiscal_manual: pagamentos.some((pagamento) => !pagamento.tef_transacao_id),
    forma_pagamento: pagamentos.length > 1 ? 'misto' : pagamentos[0].forma_pagamento,
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

describe('Sprint 29 — persistência em banco temporário', { concurrency: false }, () => {
  before(async () => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Banco temporário não ficou pronto')), 90000);
      db.whenReady((err) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      });
    });
    await garantirSchemaEstoqueEmpresaAsync(db);
    await garantirSchemaUsuarioEmpresasAsync(db);
    empresaA = await EmpresaService.criarEmpresa(
      { cnpj: '11222333000181', razao_social: 'Pastelaria Sprint 29' },
      { db }
    );
    const produto = await run(
      `INSERT INTO produtos (
         nome, unidade, tipo_operacional, controla_estoque,
         saldo_fiscal, saldo_nao_fiscal, estoque_atual, preco_venda, ativo
       ) VALUES ('Pastel sprint 29', 'UN', 'COMERCIAL', 1, 0, 100, 100, 10, 1)`
    );
    produtoId = produto.lastID;
    await EstoqueEmpresaService.criarRegistro({
      produtoId, empresaId: empresaA.id, saldo_fiscal: 0, saldo_nao_fiscal: 100, estoque_atual: 100
    }, { db });
    const operador = await run(
      `INSERT INTO usuarios (username, password_hash, role, nome, perfil, ativo)
       VALUES ('op29', 'x', 'operador', 'Operador 29', 'CAIXA', 1)`
    );
    await run(
      `INSERT INTO usuario_empresas (usuario_id, empresa_id, ativo) VALUES (?, ?, 1)`,
      [operador.lastID, empresaA.id]
    );
    tokenOperador = jwt.sign(
      { id: operador.lastID, usuario_id: operador.lastID, username: 'op29', role: 'operador', perfil: 'CAIXA' },
      getJwtSecret(),
      { expiresIn: '2h' }
    );
    const terminal = await run(`INSERT INTO terminais (nome, hostname) VALUES ('PDV-29', 'sprint29')`);
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
    app.use('/api/vendas', verificarToken, criarMiddlewareContextoEmpresa(db), (req, res, next) => {
      if (req.body && req.body.emitir_fiscal === true) emissoes.push(1);
      next();
    }, vendasRouter);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    assert.equal(/ProgramData[\\/]MercantilFiscal/i.test(String(db.dbPath)), false);
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    console.log(`SPRINT29_RESULTADOS ${JSON.stringify({
      dbDir,
      dbPath: db.dbPath,
      autorizacoesReais: autorizacoesReais.length,
      emissoes: emissoes.length,
      producao: RECOMPOSICAO_HABILITADA_EM_PRODUCAO
    })}`);
  });

  async function tefSimulado(valor) {
    const row = await run(
      `INSERT INTO tef_transacoes (
         venda_id, empresa_id, tipo, valor, parcelas, status, provedor, nsu, autorizacao, criado_em, atualizado_em
       ) VALUES (NULL, ?, 'pix_tef', ?, 1, 'aprovado', 'SIMULADO', 'NSU-SIM', 'AUT-SIM', datetime('now'), datetime('now'))`,
      [empresaA.id, valor]
    );
    return row.lastID;
  }

  it('9 e 12. pagamento integral persiste; falha de persistência não conclui a venda', async () => {
    const antes = await get('SELECT COUNT(*) AS n FROM vendas');
    const tefId = await tefSimulado(10);
    const sucesso = await httpJson('/api/vendas', pedido('pdv-sprint29-integral', [
      {
        forma_pagamento: 'pix',
        valor: 10,
        status_autorizacao: 'aprovada',
        tef_transacao_id: tefId,
        confirmacao_modalidade: 'tef',
        confirmacao_manual: 0
      }
    ], 10));
    const reconhecida = reconhecerVenda(sucesso);
    assert.equal(reconhecida.concluida, true, JSON.stringify(sucesso.body));
    const venda = await get('SELECT id, total, status_pagamento FROM vendas WHERE id = ?', [reconhecida.vendaId]);
    assert.equal(Number(venda.total), 10);
    const falha = await httpJson('/api/vendas', pedido('pdv-sprint29-falha', [
      { forma_pagamento: 'dinheiro', valor: 4, status_autorizacao: 'informada', confirmacao_manual: 1 }
    ], 10));
    assert.notEqual(falha.status, 200);
    assert.equal(reconhecerVenda(falha).concluida, false);
    const depois = await get('SELECT COUNT(*) AS n FROM vendas');
    assert.equal(Number(depois.n), Number(antes.n) + 1);
    assert.match(pdvFonte, /A venda não foi concluída: a resposta não trouxe o identificador/);
  });

  it('13 e 14. falha de interface não duplica; uma chave nova abre outra venda', async () => {
    const tefId = await tefSimulado(10);
    const chave = 'pdv-sprint29-recuperar';
    const primeira = await httpJson('/api/vendas', pedido(chave, [
      {
        forma_pagamento: 'pix',
        valor: 10,
        status_autorizacao: 'aprovada',
        tef_transacao_id: tefId,
        confirmacao_modalidade: 'tef'
      }
    ], 10));
    const original = reconhecerVenda(primeira);
    assert.equal(original.concluida, true, JSON.stringify(primeira.body));
    const repetida = await httpJson('/api/vendas', pedido(chave, [
      {
        forma_pagamento: 'pix',
        valor: 10,
        status_autorizacao: 'aprovada',
        tef_transacao_id: tefId,
        confirmacao_modalidade: 'tef'
      }
    ], 10));
    const recuperada = reconhecerVenda(repetida);
    assert.equal(recuperada.concluida, true, JSON.stringify(repetida.body));
    assert.equal(recuperada.vendaId, original.vendaId);
    assert.equal(recuperada.repetida, true);
    const iguais = await get(
      'SELECT COUNT(*) AS n FROM pdv_fechamento_idempotencia WHERE chave = ?',
      [chave]
    );
    assert.equal(Number(iguais.n), 1);

    const outraTef = await tefSimulado(10);
    const nova = await httpJson('/api/vendas', pedido('pdv-sprint29-nova', [
      {
        forma_pagamento: 'pix',
        valor: 10,
        status_autorizacao: 'aprovada',
        tef_transacao_id: outraTef,
        confirmacao_modalidade: 'tef'
      }
    ], 10));
    const seguinte = reconhecerVenda(nova);
    assert.equal(seguinte.concluida, true, JSON.stringify(nova.body));
    assert.notEqual(seguinte.vendaId, original.vendaId);
    assert.match(pdvFonte, /Nenhuma segunda venda foi criada/);
    assert.equal(emissoes.length, 0);
    assert.equal(autorizacoesReais.length, 0);
    assert.equal(RECOMPOSICAO_HABILITADA_EM_PRODUCAO, false);
  });
});
