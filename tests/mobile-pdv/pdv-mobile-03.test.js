/**
 * PDV-MOBILE-03 — mesmo preço do Desktop e acompanhamento TEF sem cobrança.
 * Sem TEF real, adquirente, Smart POS, NFC-e ou banco oficial.
 *
 * Executar: node --test --test-concurrency=1 tests/mobile-pdv/pdv-mobile-03.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-mobpdv03-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const ROOT = path.join(__dirname, '..', '..');
const { criarPdvReal } = require('../vendas/helpers/pdv-real-adaptador');
const contrato = require('../../backend/services/tef/tefContrato');
const { calcularMargemToleranciaDinheiro } = require('../../backend/services/vendas/RecomposicaoFiscalToleranciaDinheiroSimulacaoService');
const {
  centavosMoedaReal,
  itensFiscaisInteirosParaReferencia
} = require('../../backend/services/vendas/PagamentoRecomposicaoDocumentoService');

function ler(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function carregarPdv() {
  const contexto = {
    console,
    setTimeout,
    clearTimeout,
    API_URL: 'http://cds.test/api',
    localStorage: { getItem: () => 'tok', setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { origin: 'http://cds.test', href: '/mobile-pdv', replace() {}, assign() {} },
    document: {
      readyState: 'complete',
      getElementById() { return null; },
      addEventListener() {},
      querySelectorAll() { return []; }
    },
    fetch: async () => { throw new Error('fetch da página não usado'); },
    MotorPrecoAtacado: require('../../frontend/shared/js/motor-preco-atacado.js')
  };
  contexto.window = contexto;
  contexto.globalThis = contexto;
  vm.createContext(contexto);
  vm.runInContext(ler('frontend/shared/js/motor-preco-atacado.js'), contexto);
  vm.runInContext(ler('frontend/pdv/js/pdv-preco-comercial.js'), contexto);
  vm.runInContext(ler('frontend/shared/js/tefFluxoPagamento.js'), contexto);
  vm.runInContext(ler('frontend/pdv/js/pagamentoSequencial.js'), contexto);
  vm.runInContext(ler('frontend/pdv/js/interacaoPagamentoMisto.js'), contexto);
  vm.runInContext(ler('frontend/pdv/js/pdv-fechamento-oficial.js'), contexto);
  vm.runInContext(ler('frontend/mobile-pdv/mobile-pdv.js'), contexto);
  return contexto;
}

function linhaDesktop(produto, quantidade, promocao, faixas) {
  const pdv = criarPdvReal({
    produtos: [produto],
    faixasPorProduto: { [produto.id]: faixas || [] }
  });
  pdv.api.adicionarItemNoCarrinho(
    pdv.sandbox.produtosDisponiveis[0],
    quantidade,
    Number(produto.preco_venda),
    '',
    promocao || null,
    { tipo_venda: 'PESO' }
  );
  return pdv.api.carrinho[0];
}

function comparar(produto, quantidade, promocao, faixas) {
  const desktop = linhaDesktop(produto, quantidade, promocao, faixas);
  const mobile = carregarPdv().PdvPrecoComercial.montarLinha({
    produto,
    quantidade,
    precoInformado: produto.preco_venda,
    promocao,
    faixas
  });
  assert.equal(mobile.preco_unitario, desktop.preco_unitario);
  assert.equal(mobile.subtotal, desktop.subtotal);
  assert.equal(mobile.desconto_valor, desktop.desconto_valor);
  assert.equal(mobile.desconto_atacado, desktop.desconto_atacado);
  assert.equal(mobile.tipo_preco, desktop.tipo_preco);
  return { desktop, mobile };
}

describe('preço da venda avulsa', () => {
  const comum = { id: 10, nome: 'Pastel de carne', preco_venda: 10, venda_atacado: 0, estoque_atual: 20 };

  it('usa o preço de venda', () => {
    const { mobile } = comparar(comum, 2, null, []);
    assert.equal(mobile.preco_unitario, 10);
    assert.equal(mobile.subtotal, 20);
  });

  it('aplica o preço promocional', () => {
    const { mobile } = comparar(comum, 2, { id: 3, preco_promocional: 8, desconto_percentual: 20 }, []);
    assert.equal(mobile.preco_unitario, 8);
    assert.equal(mobile.subtotal, 16);
    assert.equal(mobile.promocao_id, 3);
  });

  it('aplica a faixa de atacado quando a quantidade alcança o mínimo', () => {
    const produto = { ...comum, venda_atacado: 1 };
    const faixas = [{ quantidade_minima: 5, preco_atacado: 7 }];
    const { mobile } = comparar(produto, 6, null, faixas);
    assert.equal(mobile.preco_unitario, 7);
    assert.equal(mobile.tipo_preco, 'atacado');
    assert.equal(mobile.subtotal, 42);
  });

  it('mantém o varejo quando a quantidade não alcança a faixa', () => {
    const produto = { ...comum, venda_atacado: 1 };
    comparar(produto, 2, null, [{ quantidade_minima: 5, preco_atacado: 7 }]);
  });
});

describe('pagamento e acompanhamento', () => {
  it('fecha só em dinheiro e repete o fechamento sem outra venda', async () => {
    const ctx = carregarPdv();
    await ctx.PagamentoSequencial.adicionar({ forma: 'dinheiro', valor: 20, totalVenda: 20 });
    ctx.PagamentoSequencial.registrarComposicao({ sucesso: true });
    const primeiro = await ctx.MobilePdv.fechar({
      fetch: async (url) => {
        if (String(url).endsWith('/pre-calcular-distribuicao')) {
          return { ok: true, json: async () => ({ sucesso: true, valor_fiscal: 0, valor_nao_fiscal: 20 }) };
        }
        if (String(url).endsWith('/vendas')) {
          return { ok: true, status: 201, json: async () => ({ id: 15, venda_id: 15 }) };
        }
        return { ok: true, json: async () => ({}) };
      },
      itens: [{ produto_id: 10, quantidade: 2, preco_unitario: 10, subtotal: 20 }],
      total: 20,
      desconto: 0,
      handoff: null,
      modoConfirmacaoFiscal: 'TEF',
      tefHabilitado: false
    });
    assert.equal(primeiro.ok, true);
    assert.equal(primeiro.vendaId, 15);
    const repetido = await ctx.MobilePdv.fechar({
      fetch: async () => { throw new Error('não deveria gravar de novo'); },
      vendaPersistida: { id: 15 },
      total: 20
    });
    assert.equal(repetido.bloqueado, true);
  });

  it('não altera o total quando o dinheiro vem antes ou depois do eletrônico', async () => {
    async function montar(ordem) {
      const ctx = carregarPdv();
      for (const parcela of ordem) {
        const retorno = await ctx.PagamentoSequencial.adicionar({
          forma: parcela.forma,
          valor: parcela.valor,
          totalVenda: 20,
          autorizarTef: async () => ({ aprovado: true, status: 'aprovado', transacao_id: parcela.id })
        });
        assert.equal(retorno.ok, true);
      }
      return ctx.PagamentoSequencial.soma();
    }
    const antes = await montar([
      { forma: 'dinheiro', valor: 8 },
      { forma: 'pix', valor: 12, id: 41 }
    ]);
    const depois = await montar([
      { forma: 'pix', valor: 12, id: 41 },
      { forma: 'dinheiro', valor: 8 }
    ]);
    assert.equal(antes, 20);
    assert.equal(depois, 20);
  });

  it('só vincula cobrança aprovada e não duplica a transação', async () => {
    const ctx = carregarPdv();
    const aprovada = contrato.classificarAcompanhamento({ id: 9, status: 'aprovado', nsu: '1', autorizacao: 'A' });
    const primeira = await ctx.MobilePdv.vincularCobrancaConfirmada({
      retorno: { aprovado: true, status: 'aprovado', transacao_id: aprovada.transacao_id, nsu: aprovada.nsu, autorizacao: aprovada.autorizacao },
      forma: 'pix',
      valor: 10,
      totalVenda: 10
    });
    assert.equal(primeira.ok, true);
    const repetida = await ctx.MobilePdv.vincularCobrancaConfirmada({
      retorno: { aprovado: true, status: 'aprovado', transacao_id: 9 },
      forma: 'pix',
      valor: 10,
      totalVenda: 20
    });
    assert.equal(repetida.codigo, 'TRANSACAO_JA_VINCULADA');
    assert.equal(ctx.PagamentoSequencial.snapshot().length, 1);
  });

  it('não converte pendente, recusa, timeout ou falha em pagamento recebido', async () => {
    const ctx = carregarPdv();
    const casos = [
      { status: 'pendente' },
      { status: 'negado' },
      { status: 'timeout' },
      { status: 'falha_comunicacao' }
    ];
    for (const caso of casos) {
      const leitura = contrato.classificarAcompanhamento({ id: 3, status: caso.status });
      assert.equal(leitura.aprovado, false);
      assert.equal(leitura.executou_cobranca, false);
      const vinculo = await ctx.MobilePdv.vincularCobrancaConfirmada({
        retorno: leitura,
        forma: 'debito',
        valor: 5,
        totalVenda: 5
      });
      assert.equal(vinculo.ok, false);
    }
    assert.equal(ctx.PagamentoSequencial.snapshot().length, 0);
  });

  it('não solicita emissão nem transmissão nesta etapa', async () => {
    const ctx = carregarPdv();
    let chamadas = 0;
    const bloqueada = await ctx.MobilePdv.solicitarEmissao({
      vendaId: 15,
      distribuicaoAutorizada: false,
      transmitir: true,
      fetch: async () => { chamadas += 1; return { ok: true, json: async () => ({}) }; }
    });
    assert.equal(bloqueada.codigo, 'DISTRIBUICAO_NAO_AUTORIZADA');
    const semTransmissao = await ctx.MobilePdv.solicitarEmissao({
      vendaId: 15,
      distribuicaoAutorizada: true,
      transmitir: false,
      fetch: async () => { chamadas += 1; return { ok: true, json: async () => ({}) }; }
    });
    assert.equal(semTransmissao.codigo, 'EMISSAO_NAO_LIBERADA');
    assert.equal(chamadas, 0);
  });

  it('bloqueia o fechamento quando a composição em dinheiro não foi autorizada', async () => {
    const ctx = carregarPdv();
    await ctx.PagamentoSequencial.adicionar({ forma: 'dinheiro', valor: 10, totalVenda: 10 });
    const resultado = await ctx.MobilePdv.fechar({
      fetch: async () => { throw new Error('não deveria gravar'); },
      itens: [{ produto_id: 10, quantidade: 1, preco_unitario: 10, subtotal: 10 }],
      total: 10,
      desconto: 0,
      handoff: null
    });
    assert.equal(resultado.codigo, 'COMPOSICAO_INVALIDA');
  });
});

describe('recomposição já existente', () => {
  it('limita a margem a 20% do dinheiro e não a trata como desconto', () => {
    const margem = calcularMargemToleranciaDinheiro([
      { forma_pagamento: 'dinheiro', valor: 10 }
    ]);
    assert.equal(margem.percentual, 0.2);
    assert.equal(margem.margem_maxima, 2);
    assert.equal(margem.nao_e_desconto, true);
  });

  it('arredonda o dinheiro da nota em R$ 0,05 e mantém quantidade inteira', async () => {
    assert.equal(centavosMoedaReal(153), 150);
    const fechamento = await itensFiscaisInteirosParaReferencia({
      pagamentos: [
        { forma_pagamento: 'pix', valor: 8, status: 'aprovado' },
        { forma_pagamento: 'dinheiro', valor: 2, status: 'aprovado' }
      ],
      itens: [
        { produto_id: 10, categoria_nome: 'PASTEIS', quantidade: 1, preco_unitario: 8, preco_venda: 8, subtotal: 8 }
      ]
    });
    assert.ok(fechamento);
    assert.equal(Number.isInteger(fechamento.itens[0].quantidade), true);
    assert.equal(Math.round(fechamento.dinheiro_aplicado * 100) % 5, 0);
  });
});

describe('leitura TEF sem executar cobrança', () => {
  it('consulta a mesma chave duas vezes e não cria outra transação', async () => {
    const db = require('../../backend/database');
    await db.whenReady;
    const limite = Date.now() + 20000;
    let tabela = false;
    while (Date.now() < limite) {
      tabela = await new Promise((resolve) => {
        db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tef_transacoes'`, (err, row) => {
          resolve(!err && !!row);
        });
      });
      if (tabela) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(tabela, true);
    const tef = require('../../backend/services/tef');
    await new Promise((resolve, reject) => {
      db.run(`
        INSERT INTO tef_transacoes (empresa_id, operador_id, tipo, valor, status, nsu, autorizacao, idempotency_key)
        VALUES (4, 7, 'pix', 10, 'aprovado', 'NSU-TESTE', 'AUT-TESTE', 'corr-pdv-03')
      `, (err) => (err ? reject(err) : resolve()));
    });
    const primeira = await tef.acompanharCobranca('corr-pdv-03', 4, 7);
    const segunda = await tef.acompanharCobranca('corr-pdv-03', 4, 7);
    assert.equal(primeira.aprovado, true);
    assert.equal(primeira.executou_cobranca, false);
    assert.equal(segunda.transacao_id, primeira.transacao_id);
    const total = await new Promise((resolve, reject) => {
      db.get(`SELECT COUNT(*) AS total FROM tef_transacoes WHERE idempotency_key = 'corr-pdv-03'`, (err, row) => {
        if (err) reject(err);
        else resolve(row.total);
      });
    });
    assert.equal(total, 1);
    const outraEmpresa = await tef.acompanharCobranca('corr-pdv-03', 9, 7);
    assert.equal(outraEmpresa.encontrado, false);
    assert.equal(outraEmpresa.aprovado, false);
  });
});
