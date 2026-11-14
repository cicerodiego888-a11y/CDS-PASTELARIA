/**
 * CDS-PDV-NFCE-HANDOFF-COMPLEMENTO-FISCAL-01
 * Handoff fechamento → persistência → emissor com complemento fiscal.
 * Banco temporário. Sem TEF/PIX/SEFAZ reais. Sem ProgramData.
 *
 * Executar: node --test --test-concurrency=1 tests/pdv/pdv-nfce-handoff-complemento-fiscal-01.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-handoff-comp-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
process.env.CDS_RECOMPOSICAO_FECHAMENTO_OPERACIONAL = '0';
delete process.env.CDS_ALLOW_OFFICIAL_DB;

const { isolarBancoTeste } = require('../central-entradas/helpers/isolarBancoTeste');
const isolamento = isolarBancoTeste('cds-handoff-comp-');
const db = require('../../backend/database');
isolamento.comprobar(db);

const {
  marcarParcelaEletronicaComprovada,
  gravarReferenciaRecomposicao,
  carregarReferenciaRecomposicao,
  validarReferenciaFiscalFinalComComplemento,
  calcularReferenciasConfirmadas
} = require('../../backend/services/vendas/PagamentoSequencialComposicaoService');
const {
  pagamentosParaDocumentoFiscal
} = require('../../backend/services/vendas/PagamentoRecomposicaoDocumentoService');
const {
  selecionarItensFiscaisParaNfce
} = require('../../backend/services/fiscal/emissor');
const {
  reescritaDeComposicaoNoEmissorAutorizada
} = require('../../backend/services/vendas/FechamentoComposicaoPedidoContrato');
const EmpresaService = require('../../backend/services/empresas/EmpresaService');
const { garantirSchemaUsuarioEmpresasAsync } = require('../../backend/services/empresas/usuarioEmpresasSchema');

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

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
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

let tefSeq = 8800;
const PIX = () => {
  tefSeq += 1;
  return marcarParcelaEletronicaComprovada({
    forma_pagamento: 'pix',
    valor: 36.98,
    status_autorizacao: 'aprovada',
    nsu: `NSU-HO-${tefSeq}`,
    autorizacao: `AUT-HO-${tefSeq}`,
    tef_transacao_id: tefSeq
  });
};
const DINHEIRO = () => ({
  forma_pagamento: 'dinheiro',
  valor: 25,
  status_autorizacao: 'informada',
  confirmacao_manual: 1
});

function itensComComplemento() {
  return [
    {
      produto_id: 1,
      quantidade: 1,
      quantidade_fiscal: 1,
      quantidade_nao_fiscal: 0,
      valor_fiscal: 20,
      valor_nao_fiscal: 0,
      preco_unitario: 20,
      subtotal: 20
    },
    {
      produto_id: 2,
      quantidade: 8,
      quantidade_fiscal: 4,
      quantidade_nao_fiscal: 4,
      valor_fiscal: 19.98,
      valor_nao_fiscal: 20.02,
      preco_unitario: 5,
      subtotal: 40
    },
    {
      produto_id: 3,
      quantidade: 1,
      quantidade_fiscal: 0,
      quantidade_nao_fiscal: 1,
      valor_fiscal: 0,
      valor_nao_fiscal: 1.98,
      preco_unitario: 1.98,
      subtotal: 1.98
    }
  ];
}

function referenciaFinal(extra = {}) {
  return {
    recomposicao_executada: true,
    total_financeiro: 61.98,
    valor_fiscal_referencia: 39.98,
    valor_nao_fiscal_referencia: 22,
    valor_fiscal_referencia_inicial: 36.98,
    valor_nao_fiscal_referencia_inicial: 25,
    complemento_dinheiro_utilizado: 3,
    desconto_ajuste: 0.02,
    origem_recomposicao: 'recomposicao_complemento_20',
    avaliacao_motor: { codigo: 'OK_COMPOSICAO_ACIMA_COM_COMPLEMENTO_E_DESCONTO', distribuicao_possivel: true },
    ...extra
  };
}

let empresaId;
let produtoIds = {};

async function criarVendaCompleta({
  codigo,
  itens,
  pagamentos,
  valorFiscal,
  valorNaoFiscal,
  gravarRef,
  referencia
}) {
  const venda = await run(
    `INSERT INTO vendas (
      codigo, data_venda, total, desconto, acrescimo, forma_pagamento, status,
      valor_fiscal, valor_nao_fiscal, status_pagamento, empresa_id
    ) VALUES (?, datetime('now'), ?, 0, 0, 'misto', 'concluida', ?, ?, 'quitada', ?)`,
    [codigo, 61.98, valorFiscal, valorNaoFiscal, empresaId]
  );
  const vendaId = venda.lastID;
  for (const item of itens) {
    await run(
      `INSERT INTO vendas_itens (
        venda_id, produto_id, quantidade, preco_unitario, subtotal,
        quantidade_fiscal, quantidade_nao_fiscal, valor_fiscal, valor_nao_fiscal, item_fiscal
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        vendaId,
        item.produto_id,
        item.quantidade,
        item.preco_unitario,
        item.subtotal,
        item.quantidade_fiscal,
        item.quantidade_nao_fiscal,
        item.valor_fiscal,
        item.valor_nao_fiscal,
        item.valor_fiscal > 0 ? 1 : 0
      ]
    );
  }
  for (const pag of pagamentos) {
    await run(
      `INSERT INTO venda_pagamentos (
        venda_id, forma_pagamento, valor, tef_transacao_id, tef_nsu, tef_autorizacao,
        confirmacao_manual, confirmacao_modalidade
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        vendaId,
        pag.forma_pagamento,
        pag.valor,
        pag.tef_transacao_id || null,
        pag.nsu || null,
        pag.autorizacao || null,
        pag.confirmacao_manual ? 1 : 0,
        pag.forma_pagamento === 'dinheiro' ? 'manual' : 'tef'
      ]
    );
    await run(
      `INSERT INTO venda_recebimentos (
        venda_id, forma_pagamento, valor, tipo_recebimento, status,
        tef_transacao_id, nsu, autorizacao
      ) VALUES (?, ?, ?, ?, 'aprovado', ?, ?, ?)`,
      [
        vendaId,
        pag.forma_pagamento,
        pag.valor,
        pag.forma_pagamento === 'dinheiro' ? 'nao_fiscal' : 'fiscal',
        pag.tef_transacao_id || null,
        pag.nsu || null,
        pag.autorizacao || null
      ]
    );
  }
  if (gravarRef !== false) {
    await gravarReferenciaRecomposicao(db, vendaId, referencia || referenciaFinal());
  }
  return vendaId;
}

before(async () => {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Banco temporário não ficou pronto')), 90000);
    db.whenReady((err) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    });
  });
  await garantirSchemaUsuarioEmpresasAsync(db);
  const emp = await EmpresaService.criarEmpresa(
    { cnpj: '11222333000181', razao_social: 'HANDOFF COMP LTDA' },
    { db }
  );
  empresaId = emp.id;
  for (const [nome, preco] of [['Pastel H', 20], ['Refri H', 5], ['Extra H', 1.98]]) {
    const r = await run(
      `INSERT INTO produtos (
         nome, unidade, tipo_operacional, controla_estoque, ncm, cfop, csosn,
         saldo_fiscal, saldo_nao_fiscal, estoque_atual, preco_venda, ativo
       ) VALUES (?, 'UN', 'COMERCIAL', 1, '21069090', '5102', '102', 100, 100, 200, ?, 1)`,
      [nome, preco]
    );
    produtoIds[nome] = r.lastID;
  }
  global.__mapProd = {
    1: produtoIds['Pastel H'],
    2: produtoIds['Refri H'],
    3: produtoIds['Extra H']
  };
});

function remapItens(itens) {
  const map = global.__mapProd;
  return itens.map((item) => ({ ...item, produto_id: map[item.produto_id] || item.produto_id }));
}

function pagamentosParaSelecao(rows) {
  return (rows || []).map((p) => {
    if (String(p.forma_pagamento).toLowerCase() === 'pix'
      || String(p.forma_pagamento).toLowerCase().includes('cartao')) {
      return marcarParcelaEletronicaComprovada({
        ...p,
        status_autorizacao: 'aprovada'
      });
    }
    return {
      ...p,
      status_autorizacao: 'informada',
      confirmacao_manual: 1
    };
  });
}

after(() => {
  try { isolamento.cleanup(); } catch (_) { /* ignore */ }
});

describe('NFCE-HANDOFF-COMPLEMENTO-FISCAL-01', { concurrency: false }, () => {
  it('A. caminho completo: persistência → seleção → XML sintético 39,98/22,00', async () => {
    assert.equal(reescritaDeComposicaoNoEmissorAutorizada(), false);
    const itens = remapItens(itensComComplemento());
    const vendaId = await criarVendaCompleta({
      codigo: 'HO-A',
      itens,
      pagamentos: [PIX(), DINHEIRO()],
      valorFiscal: 39.98,
      valorNaoFiscal: 22
    });

    const ref = await carregarReferenciaRecomposicao(db, vendaId);
    assert.ok(ref);
    assert.equal(Number(ref.complemento_dinheiro_utilizado), 3);
    assert.equal(Number(ref.valor_fiscal_referencia), 39.98);
    assert.equal(Number(ref.valor_nao_fiscal_referencia), 22);
    assert.equal(Number(ref.dinheiro_recebido), 25);
    assert.equal(Number(ref.valor_fiscal_referencia_inicial), 36.98);

    const vendaRow = await get('SELECT * FROM vendas WHERE id = ?', [vendaId]);
    const pags = await all('SELECT * FROM venda_recebimentos WHERE venda_id = ?', [vendaId]);
    const itensDb = await all('SELECT * FROM vendas_itens WHERE venda_id = ?', [vendaId]);
    assert.equal(pags.length, 2);
    assert.equal(round2(pags.reduce((s, p) => s + Number(p.valor), 0)), 61.98);

    const venda = {
      ...vendaRow,
      id: vendaId,
      pagamentos: pagamentosParaSelecao(pags),
      __referencia_composicao_persistida: ref
    };
    const sel = selecionarItensFiscaisParaNfce(venda, itensDb);
    assert.equal(sel.bloqueado, false, JSON.stringify(sel));
    assert.equal(sel.complemento_dinheiro_utilizado, 3);
    assert.equal(Number(sel.referencia.valor_fiscal_referencia), 39.98);
    assert.equal(Number(sel.referencia.valor_nao_fiscal_referencia), 22);
    assert.equal(sel.somaFiscal, 39.98);

    const docs = pagamentosParaDocumentoFiscal(venda.pagamentos, 3);
    assert.equal(docs.length, 2);
    assert.equal(round2(docs.reduce((s, p) => s + Number(p.valor), 0)), 39.98);
    assert.ok(docs.some((p) => p.forma_pagamento === 'pix' && Number(p.valor) === 36.98));
    assert.ok(docs.some((p) => p.forma_pagamento === 'dinheiro'
      && Number(p.valor) === 3
      && p.dinheiro_moeda_fechamento === true));
    assert.equal(reescritaDeComposicaoNoEmissorAutorizada(), false);
  });

  it('B. complemento recuperável após “reinício” (novo load do DB)', async () => {
    const itens = remapItens(itensComComplemento());
    const vendaId = await criarVendaCompleta({
      codigo: 'HO-B',
      itens,
      pagamentos: [PIX(), DINHEIRO()],
      valorFiscal: 39.98,
      valorNaoFiscal: 22
    });
    // Simula novo processo: só carrega do banco, sem variáveis de memória da gravação.
    const ref = await carregarReferenciaRecomposicao(db, vendaId);
    assert.equal(Number(ref.complemento_dinheiro_utilizado), 3);
    assert.equal(ref.origem_recomposicao, 'recomposicao_complemento_20');
  });

  it('C. complemento ausente → bloqueio', async () => {
    const itens = remapItens(itensComComplemento());
    const vendaId = await criarVendaCompleta({
      codigo: 'HO-C',
      itens,
      pagamentos: [PIX(), DINHEIRO()],
      valorFiscal: 39.98,
      valorNaoFiscal: 22,
      gravarRef: false
    });
    const vendaRow = await get('SELECT * FROM vendas WHERE id = ?', [vendaId]);
    const pags = await all('SELECT * FROM venda_recebimentos WHERE venda_id = ?', [vendaId]);
    const itensDb = await all('SELECT * FROM vendas_itens WHERE venda_id = ?', [vendaId]);
    const sel = selecionarItensFiscaisParaNfce({
      ...vendaRow,
      id: vendaId,
      pagamentos: pagamentosParaSelecao(pags)
    }, itensDb);
    assert.equal(sel.bloqueado, true);
    assert.equal(sel.codigo, 'COMPLEMENTO_NAO_PERSISTIDO');
  });

  it('D. complemento no payload é ignorado — só persistido conta', async () => {
    const itens = remapItens(itensComComplemento());
    const vendaId = await criarVendaCompleta({
      codigo: 'HO-D',
      itens,
      pagamentos: [PIX(), DINHEIRO()],
      valorFiscal: 39.98,
      valorNaoFiscal: 22,
      gravarRef: false
    });
    const vendaRow = await get('SELECT * FROM vendas WHERE id = ?', [vendaId]);
    const pags = await all('SELECT * FROM venda_recebimentos WHERE venda_id = ?', [vendaId]);
    const itensDb = await all('SELECT * FROM vendas_itens WHERE venda_id = ?', [vendaId]);
    const sel = selecionarItensFiscaisParaNfce({
      ...vendaRow,
      id: vendaId,
      pagamentos: pagamentosParaSelecao(pags),
      complemento_dinheiro_utilizado: 3,
      __complemento_payload: 3
    }, itensDb);
    assert.equal(sel.bloqueado, true);
    assert.equal(sel.codigo, 'COMPLEMENTO_NAO_PERSISTIDO');
  });

  it('E. documento fiscal não duplica o dinheiro recebido', () => {
    const pags = [PIX(), DINHEIRO()];
    const docs = pagamentosParaDocumentoFiscal(pags, 3);
    const somaRecebido = round2(pags.reduce((s, p) => s + Number(p.valor), 0));
    const somaDoc = round2(docs.reduce((s, p) => s + Number(p.valor), 0));
    assert.equal(somaRecebido, 61.98);
    assert.equal(somaDoc, 39.98);
    assert.equal(docs.filter((p) => p.forma_pagamento === 'dinheiro').length, 1);
    assert.equal(docs.filter((p) => p.forma_pagamento === 'pix').length, 1);
  });

  it('F. venda só PIX — sem complemento artificial', async () => {
    const map = global.__mapProd;
    const itens = [{
      produto_id: map[1],
      quantidade: 1,
      quantidade_fiscal: 1,
      quantidade_nao_fiscal: 0,
      valor_fiscal: 36.98,
      valor_nao_fiscal: 0,
      preco_unitario: 36.98,
      subtotal: 36.98
    }];
    const pix = marcarParcelaEletronicaComprovada({
      forma_pagamento: 'pix',
      valor: 36.98,
      status_autorizacao: 'aprovada',
      nsu: 'NSU-F',
      autorizacao: 'AUT-F',
      tef_transacao_id: 7702
    });
    const venda = await run(
      `INSERT INTO vendas (
        codigo, data_venda, total, desconto, acrescimo, forma_pagamento, status,
        valor_fiscal, valor_nao_fiscal, status_pagamento, empresa_id
      ) VALUES ('HO-F', datetime('now'), 36.98, 0, 0, 'pix', 'concluida', 36.98, 0, 'quitada', ?)`,
      [empresaId]
    );
    const vendaId = venda.lastID;
    await run(
      `INSERT INTO vendas_itens (
        venda_id, produto_id, quantidade, preco_unitario, subtotal,
        quantidade_fiscal, quantidade_nao_fiscal, valor_fiscal, valor_nao_fiscal, item_fiscal
      ) VALUES (?, ?, 1, 36.98, 36.98, 1, 0, 36.98, 0, 1)`,
      [vendaId, map[1]]
    );
    await run(
      `INSERT INTO venda_pagamentos (
        venda_id, forma_pagamento, valor, tef_transacao_id, tef_nsu, tef_autorizacao
      ) VALUES (?, 'pix', 36.98, 7702, 'NSU-F', 'AUT-F')`,
      [vendaId]
    );
    await run(
      `INSERT INTO venda_recebimentos (
        venda_id, forma_pagamento, valor, tipo_recebimento, status, tef_transacao_id, nsu, autorizacao
      ) VALUES (?, 'pix', 36.98, 'fiscal', 'aprovado', 7702, 'NSU-F', 'AUT-F')`,
      [vendaId]
    );
    await gravarReferenciaRecomposicao(db, vendaId, {
      recomposicao_executada: true,
      total_financeiro: 36.98,
      valor_fiscal_referencia: 36.98,
      valor_nao_fiscal_referencia: 0,
      complemento_dinheiro_utilizado: 0,
      desconto_ajuste: 0,
      avaliacao_motor: { codigo: 'OK', distribuicao_possivel: true }
    });
    const ref = await carregarReferenciaRecomposicao(db, vendaId);
    const vendaRow = await get('SELECT * FROM vendas WHERE id = ?', [vendaId]);
    const pags = await all('SELECT * FROM venda_recebimentos WHERE venda_id = ?', [vendaId]);
    const itensDb = await all('SELECT * FROM vendas_itens WHERE venda_id = ?', [vendaId]);
    const sel = selecionarItensFiscaisParaNfce({
      ...vendaRow,
      id: vendaId,
      pagamentos: pagamentosParaSelecao(pags),
      __referencia_composicao_persistida: ref
    }, itensDb);
    assert.equal(sel.bloqueado, false, JSON.stringify(sel));
    assert.equal(sel.complemento_dinheiro_utilizado, 0);
    assert.equal(calcularReferenciasConfirmadas([pix]).valor_nao_fiscal_referencia, 0);
  });

  it('F2. PIX integral com desconto no cabeçalho e itens no bruto — não bloqueia TOTAL_VENDA', () => {
    const pix = marcarParcelaEletronicaComprovada({
      forma_pagamento: 'pix',
      valor: 61.98,
      status_autorizacao: 'aprovada',
      nsu: 'NSU-F2',
      autorizacao: 'AUT-F2',
      tef_transacao_id: 7703
    });
    const validacao = validarReferenciaFiscalFinalComComplemento({
      pagamentos: [pix],
      itens: [
        { valor_fiscal: 26.97, valor_nao_fiscal: 0 },
        { valor_fiscal: 38.97, valor_nao_fiscal: 0 }
      ],
      venda: {
        id: 99,
        total: 61.98,
        desconto: 3.96,
        valor_fiscal: 61.98,
        valor_nao_fiscal: 0
      },
      referenciaPersistida: null
    });
    assert.equal(validacao.ok, true, JSON.stringify(validacao));
    assert.equal(validacao.codigo, null);
    const sel = selecionarItensFiscaisParaNfce({
      id: 99,
      total: 61.98,
      desconto: 3.96,
      valor_fiscal: 61.98,
      valor_nao_fiscal: 0,
      pagamentos: [pix]
    }, [
      { valor_fiscal: 26.97, valor_nao_fiscal: 0, quantidade_fiscal: 3 },
      { valor_fiscal: 38.97, valor_nao_fiscal: 0, quantidade_fiscal: 3 }
    ]);
    assert.equal(sel.bloqueado, false, JSON.stringify(sel));
  });

  it('G. só dinheiro — sem referência fiscal artificial', () => {
    const refs = calcularReferenciasConfirmadas([DINHEIRO()]);
    assert.equal(refs.valor_fiscal_referencia, 0);
    assert.equal(refs.valor_nao_fiscal_referencia, 25);
    const validacao = validarReferenciaFiscalFinalComComplemento({
      pagamentos: [DINHEIRO()],
      itens: [{ valor_fiscal: 0, valor_nao_fiscal: 25 }],
      venda: { id: 1, total: 25, valor_fiscal: 0, valor_nao_fiscal: 25 },
      referenciaPersistida: null
    });
    assert.equal(validacao.ok, true);
    assert.equal(validacao.complemento_dinheiro_utilizado, 0);
  });

  it('H. ordens PIX/dinheiro — mesma referência final', async () => {
    for (const [codigo, pags] of [
      ['HO-H1', [DINHEIRO(), PIX()]],
      ['HO-H2', [PIX(), DINHEIRO()]]
    ]) {
      const vendaId = await criarVendaCompleta({
        codigo,
        itens: remapItens(itensComComplemento()),
        pagamentos: pags,
        valorFiscal: 39.98,
        valorNaoFiscal: 22
      });
      const ref = await carregarReferenciaRecomposicao(db, vendaId);
      assert.equal(Number(ref.valor_fiscal_referencia), 39.98);
      assert.equal(Number(ref.complemento_dinheiro_utilizado), 3);
    }
  });

  it('H2b. <pag> NFC-e: eletrônico do snapshot + complemento — nunca 100% dinheiro', () => {
    const { resolverPagamentosNfce } = require('../../backend/services/fiscal/xmlBuilder');
    const pixSemCarimbo = {
      forma_pagamento: 'pix',
      valor: 36.98,
      status: 'aprovado',
      nsu: 'NSU-H2B',
      autorizacao: 'AUT-H2B',
      tef_transacao_id: 99002
    };
    const docs = pagamentosParaDocumentoFiscal([pixSemCarimbo, DINHEIRO()], 3, {
      valor_fiscal_referencia_inicial: 36.98,
      forma_pagamento_eletronica: 'pix'
    });
    assert.equal(docs.length, 2);
    assert.ok(docs.some((p) => p.forma_pagamento === 'pix' && Number(p.valor) === 36.98));
    assert.ok(docs.some((p) => p.forma_pagamento === 'dinheiro'
      && Number(p.valor) === 3
      && p.dinheiro_moeda_fechamento === true));
    assert.equal(round2(docs.reduce((s, p) => s + Number(p.valor), 0)), 39.98);

    const conf = resolverPagamentosNfce({
      valor_fiscal: 39.98,
      valor_nao_fiscal: 22,
      pagamentos: docs,
      __referencia_composicao_persistida: {
        valor_fiscal_referencia_inicial: 36.98,
        complemento_dinheiro_utilizado: 3
      }
    }, 39.98);
    assert.equal(conf.divergente, false, JSON.stringify(conf));
    assert.equal(conf.pagamentos.length, 2);
    assert.ok(conf.pagamentos.some((p) => String(p.forma_pagamento).includes('pix')));
    assert.ok(!conf.pagamentos.every((p) => String(p.forma_pagamento).toLowerCase() === 'dinheiro'));
    assert.equal(round2(conf.somaPagamentos), 39.98);

    // Regressão: só complemento dinheiro NÃO pode ser esticado ao vNF.
    const soComplemento = resolverPagamentosNfce({
      valor_fiscal: 39.98,
      valor_nao_fiscal: 22,
      pagamentos: [{
        forma_pagamento: 'dinheiro',
        valor: 3,
        tipo_recebimento: 'fiscal',
        dinheiro_moeda_fechamento: true,
        complemento_dinheiro_recomposicao: true
      }],
      __referencia_composicao_persistida: {
        valor_fiscal_referencia_inicial: 36.98,
        complemento_dinheiro_utilizado: 3
      }
    }, 39.98);
    assert.equal(soComplemento.divergente, true);
    assert.notEqual(round2(soComplemento.somaPagamentos), 39.98);
  });

  it('H2. sem carimbo TEF na releitura — usa snapshot persistido (não mata gerencial)', () => {
    const pixSemCarimbo = {
      forma_pagamento: 'pix',
      valor: 36.98,
      status: 'aprovado',
      nsu: 'NSU-H2',
      autorizacao: 'AUT-H2',
      tef_transacao_id: 99001
    };
    const dinheiro = DINHEIRO();
    const refsLive = calcularReferenciasConfirmadas([pixSemCarimbo, dinheiro]);
    assert.equal(refsLive.valor_fiscal_referencia, 0);
    assert.equal(refsLive.valor_nao_fiscal_referencia, 25);
    const validacao = validarReferenciaFiscalFinalComComplemento({
      pagamentos: [pixSemCarimbo, dinheiro],
      itens: [
        { valor_fiscal: 20, valor_nao_fiscal: 0, quantidade_fiscal: 1 },
        { valor_fiscal: 19.98, valor_nao_fiscal: 22, quantidade_fiscal: 1, quantidade_nao_fiscal: 1 }
      ],
      venda: {
        id: 101,
        total: 61.98,
        valor_fiscal: 39.98,
        valor_nao_fiscal: 22
      },
      referenciaPersistida: {
        venda_id: 101,
        valor_fiscal_referencia: 39.98,
        valor_nao_fiscal_referencia: 22,
        valor_fiscal_referencia_inicial: 36.98,
        valor_nao_fiscal_referencia_inicial: 25,
        complemento_dinheiro_utilizado: 3,
        desconto_ajuste: 0
      }
    });
    assert.equal(validacao.ok, true, JSON.stringify(validacao));
    assert.notEqual(validacao.codigo, 'COMPLEMENTO_INCOERENTE_COM_ELETRONICO');
    assert.equal(validacao.referencia_final.valor_fiscal_referencia, 39.98);
    assert.equal(validacao.referencia_final.valor_nao_fiscal_referencia, 22);
    assert.equal(validacao.complemento_dinheiro_utilizado, 3);
  });

  it('I. divergência real nos itens → bloqueio', async () => {
    const itens = remapItens(itensComComplemento());
    const vendaId = await criarVendaCompleta({
      codigo: 'HO-I',
      itens,
      pagamentos: [PIX(), DINHEIRO()],
      valorFiscal: 39.98,
      valorNaoFiscal: 22
    });
    const alvo = await get(
      `SELECT id FROM vendas_itens WHERE venda_id = ? AND valor_fiscal > 0 ORDER BY id LIMIT 1`,
      [vendaId]
    );
    await run(`UPDATE vendas_itens SET valor_fiscal = valor_fiscal + 5 WHERE id = ?`, [alvo.id]);
    const ref = await carregarReferenciaRecomposicao(db, vendaId);
    const vendaRow = await get('SELECT * FROM vendas WHERE id = ?', [vendaId]);
    const pags = await all('SELECT * FROM venda_recebimentos WHERE venda_id = ?', [vendaId]);
    const itensDb = await all('SELECT * FROM vendas_itens WHERE venda_id = ?', [vendaId]);
    const sel = selecionarItensFiscaisParaNfce({
      ...vendaRow,
      id: vendaId,
      pagamentos: pagamentosParaSelecao(pags),
      __referencia_composicao_persistida: ref
    }, itensDb);
    assert.equal(sel.bloqueado, true);
    assert.equal(sel.codigo, 'DISTRIBUICAO_NAO_AUTORIZADA');
  });

  it('J. integridade financeira — recebimentos intactos', async () => {
    const itens = remapItens(itensComComplemento());
    const vendaId = await criarVendaCompleta({
      codigo: 'HO-J',
      itens,
      pagamentos: [PIX(), DINHEIRO()],
      valorFiscal: 39.98,
      valorNaoFiscal: 22
    });
    const pags = await all('SELECT forma_pagamento, valor FROM venda_recebimentos WHERE venda_id = ?', [vendaId]);
    const pix = pags.find((p) => p.forma_pagamento === 'pix');
    const din = pags.find((p) => p.forma_pagamento === 'dinheiro');
    assert.equal(Number(pix.valor), 36.98);
    assert.equal(Number(din.valor), 25);
    assert.equal(round2(Number(pix.valor) + Number(din.valor)), 61.98);
    const ref = await carregarReferenciaRecomposicao(db, vendaId);
    assert.equal(Number(ref.complemento_dinheiro_utilizado), 3);
    assert.equal(Number(ref.desconto_ajuste), 0.02);
    // Desconto não cria segundo recebimento nem altera pagamentos.
    assert.equal(pags.length, 2);
  });

  it('K. idempotência de carga — sem duplicar complemento', async () => {
    const itens = remapItens(itensComComplemento());
    const vendaId = await criarVendaCompleta({
      codigo: 'HO-K',
      itens,
      pagamentos: [PIX(), DINHEIRO()],
      valorFiscal: 39.98,
      valorNaoFiscal: 22
    });
    const a = await carregarReferenciaRecomposicao(db, vendaId);
    const b = await carregarReferenciaRecomposicao(db, vendaId);
    assert.equal(Number(a.complemento_dinheiro_utilizado), Number(b.complemento_dinheiro_utilizado));
    const contagem = await get(
      'SELECT COUNT(*) AS n FROM venda_composicao_referencia WHERE venda_id = ?',
      [vendaId]
    );
    assert.equal(Number(contagem.n), 1);
    const vendaRow = await get('SELECT * FROM vendas WHERE id = ?', [vendaId]);
    const pags = await all('SELECT * FROM venda_recebimentos WHERE venda_id = ?', [vendaId]);
    const itensDb = await all('SELECT * FROM vendas_itens WHERE venda_id = ?', [vendaId]);
    const venda = {
      ...vendaRow,
      id: vendaId,
      pagamentos: pagamentosParaSelecao(pags),
      __referencia_composicao_persistida: a
    };
    const s1 = selecionarItensFiscaisParaNfce(venda, itensDb);
    const s2 = selecionarItensFiscaisParaNfce(venda, itensDb);
    assert.equal(s1.bloqueado, false);
    assert.equal(s2.bloqueado, false);
    assert.equal(s1.complemento_dinheiro_utilizado, 3);
    assert.equal(s2.complemento_dinheiro_utilizado, 3);
  });
});
