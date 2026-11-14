/**
 * CDS-PDV-RECOMPOSICAO-MISTA-COMPLEMENTO-20-PORCENTO-01
 * Complemento ≤ 20% do dinheiro, múltiplos de R$ 0,05, busca acima + desconto de ajuste.
 * Banco temporário / harness. Sem TEF/PIX/SEFAZ reais. Sem ProgramData.
 *
 * Executar: node --test --test-concurrency=1 tests/pdv/pdv-recomposicao-mista-complemento-20-porcento-01.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-comp20-'));
process.env.DB_DIR = dbDir;
process.env.CDS_TEST_ISOLATION = '1';
process.env.CDS_BLOQUEAR_BANCO_OFICIAL = '1';
process.env.CDS_FORCAR_LOCAL = '1';
process.env.CDS_RECOMPOSICAO_FECHAMENTO_OPERACIONAL = '0';
delete process.env.CDS_ALLOW_OFFICIAL_DB;
delete process.env.CDS_RECOMPOSICAO_HOMOLOGACAO_DISTRIBUIR;
delete process.env.CDS_RECOMPOSICAO_APLICAR_DISTRIBUICAO;

const {
  pisoComplementoMoeda5Centavos,
  ceilComplementoMoeda5Centavos,
  ehComplementoMoeda5Centavos,
  complementoMaximoPermitidoCentavos,
  calcularMargemToleranciaDinheiro
} = require('../../backend/services/vendas/RecomposicaoFiscalToleranciaDinheiroSimulacaoService');
const {
  avaliarCandidatoComComplementoDinheiro
} = require('../../backend/services/vendas/RecomposicaoFiscalComposicaoMotorSimulacaoService');
const {
  integrarPagamentoRecomposicao,
  apresentacaoComposicaoFiscal,
  itensFiscaisInteirosParaReferencia
} = require('../../backend/services/vendas/PagamentoRecomposicaoDocumentoService');
const {
  marcarParcelaEletronicaComprovada,
  calcularReferenciasConfirmadas
} = require('../../backend/services/vendas/PagamentoSequencialComposicaoService');
const { formaPagamentoUsaTEF } = require('../../backend/services/tef/tefFluxoPagamento');
const {
  reescritaDeComposicaoNoEmissorAutorizada
} = require('../../backend/services/vendas/FechamentoComposicaoPedidoContrato');
const {
  selecionarItensFiscaisParaNfce
} = require('../../backend/services/fiscal/emissor');

const ENV_TESTE = Object.freeze({
  CDS_RECOMPOSICAO_REFERENCIA_TESTE: '1',
  CDS_RECOMPOSICAO_FECHAMENTO_OPERACIONAL: '0'
});
const HARNESS = Object.freeze({ ativa: true });
const CFG = Object.freeze({
  codigoUf: '23',
  cnpj: '65957340000150',
  ie: '073252638',
  crt: 1,
  ambiente: 2,
  serie: 1,
  nomeEmpresa: 'EMPRESA COMP20 LTDA',
  logradouro: 'RUA A',
  numero: '100',
  bairro: 'CENTRO',
  codigo_municipio: '2307304',
  municipio: 'JUAZEIRO DO NORTE',
  uf: 'CE',
  cep: '63000000',
  telefone: '8835110000',
  csosn_padrao: '102'
});

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function carimbar(pagamentos) {
  return (pagamentos || []).map((pagamento) => {
    if (!formaPagamentoUsaTEF(pagamento && pagamento.forma_pagamento)) return pagamento;
    const status = String(pagamento.status_autorizacao || pagamento.status || '').toLowerCase();
    if (status !== 'aprovada' && status !== 'aprovado') return pagamento;
    const temId = pagamento.tef_transacao_id != null && String(pagamento.tef_transacao_id).trim() !== '';
    const temNsu = String(pagamento.nsu || '').trim() && String(pagamento.autorizacao || '').trim();
    if (!temId && !temNsu) return pagamento;
    return marcarParcelaEletronicaComprovada(pagamento);
  });
}

function modeloPrecoFixo(produtoId, precoCentavos, quantidadeMaxima, categoria) {
  return {
    produtoId,
    nome: `Produto ${produtoId}`,
    categoriaFiscal: categoria,
    volumeMlPorUnidade: 1,
    quantidadeMaxima,
    cotador: {
      precoUnitarioMinimoInterno: precoCentavos / 100,
      cotar(quantidade) {
        return {
          subtotalCentavos: precoCentavos * quantidade,
          precoUnitarioInterno: precoCentavos / 100,
          regrasAplicadas: [],
          fingerprint: `fix-${produtoId}-${quantidade}`
        };
      }
    }
  };
}

function itemBase(dados) {
  return {
    produto_ncm: '19059090',
    cfop: '5102',
    csosn: '102',
    unidade: 'UN',
    origem: 0,
    ...dados
  };
}

const PASTEL = itemBase({
  produto_id: 1,
  produto_nome: 'Pastel',
  categoria_nome: 'PASTEIS',
  quantidade: 1,
  preco_unitario: 20,
  subtotal: 20,
  produto_ncm: '19059090'
});
const REF = itemBase({
  produto_id: 2,
  produto_nome: 'Refrigerante',
  categoria_nome: 'REFRIGERANTES',
  quantidade: 8,
  preco_unitario: 5,
  subtotal: 40,
  produto_ncm: '22021000'
});
const EXTRA = itemBase({
  produto_id: 3,
  produto_nome: 'Extra',
  categoria_nome: 'DIVERSOS',
  quantidade: 1,
  preco_unitario: 1.98,
  subtotal: 1.98,
  produto_ncm: '21069090'
});

const SALDOS = Object.freeze({
  1: Object.freeze({ saldoFiscal: 2, saldoNaoFiscal: 2 }),
  2: Object.freeze({ saldoFiscal: 10, saldoNaoFiscal: 10 }),
  3: Object.freeze({ saldoFiscal: 2, saldoNaoFiscal: 2 })
});

function pagamentosMisto6198(ordem = 'dinheiro_primeiro') {
  // Eletrônico 37,00 + dinheiro 24,98 = 61,98.
  // Residual após pastel R$ 20 = 17,00 → composição 20,00 → complemento ceil 3,00.
  const pix = {
    forma_pagamento: 'pix',
    valor: 37,
    status_autorizacao: 'aprovada',
    nsu: 'NSU-COMP20',
    autorizacao: 'AUT-COMP20',
    tef_transacao_id: 9001,
    tipo_recebimento: 'fiscal'
  };
  const dinheiro = {
    forma_pagamento: 'dinheiro',
    valor: 24.98,
    status_autorizacao: 'informada',
    confirmacao_manual: 1,
    tipo_recebimento: 'nao_fiscal'
  };
  return ordem === 'pix_primeiro' ? [pix, dinheiro] : [dinheiro, pix];
}

function integrarMisto(pagamentos, extra = {}) {
  return integrarPagamentoRecomposicao({
    total: 61.98,
    empresaId: 7,
    pagamentos: carimbar(pagamentos),
    itens: [PASTEL, REF, EXTRA],
    saldosPorProduto: SALDOS,
    configFiscal: CFG,
    ...extra
  }, {
    env: ENV_TESTE,
    harnessDistribuicaoOficial: HARNESS,
    modelos: [modeloPrecoFixo(2, 500, 8, 'REFRIGERANTE')],
    capacidade_por_categoria: { REFRIGERANTE: 200 },
    pagamentosJaComprovados: true
  });
}

describe('COMPLEMENTO-20-PORCENTO-01 — helpers e margem', { concurrency: false }, () => {
  it('C. complementos válidos (múltiplos de R$ 0,05)', () => {
    for (const reais of [2.55, 2.5, 1.8, 0.05, 0]) {
      const c = Math.round(reais * 100);
      assert.equal(ehComplementoMoeda5Centavos(c), true, String(reais));
      assert.equal(pisoComplementoMoeda5Centavos(c), c);
    }
  });

  it('D. complementos inválidos', () => {
    for (const reais of [2.36, 2.39, 1.48, 1.83, 0.03]) {
      const c = Math.round(reais * 100);
      assert.equal(ehComplementoMoeda5Centavos(c), false, String(reais));
      assert.ok(pisoComplementoMoeda5Centavos(c) <= c);
      assert.equal(pisoComplementoMoeda5Centavos(c) % 5, 0);
    }
  });

  it('E. margem máxima 20% e piso de 5 centavos', () => {
    const info = complementoMaximoPermitidoCentavos([
      { forma_pagamento: 'dinheiro', valor: 25.17 }
    ]);
    // 20% de 2517 = 503,4 → centavos inteiros via margem; piso 5¢
    const margem = calcularMargemToleranciaDinheiro([
      { forma_pagamento: 'dinheiro', valor: 25.17 }
    ]);
    assert.equal(margem.margem_maxima, 5.03);
    assert.equal(info.complemento_maximo, 5);
    assert.equal(info.complemento_maximo_centavos, 500);
    assert.ok(info.complemento_maximo <= margem.margem_maxima);
  });
});

describe('COMPLEMENTO-20-PORCENTO-01 — motor', { concurrency: false }, () => {
  const modelos5 = [modeloPrecoFixo(2, 500, 10, 'REFRIGERANTE')];

  it('H. composição exata — sem complemento nem desconto', () => {
    const r = avaliarCandidatoComComplementoDinheiro({
      valorFiscalCandidato: 15,
      margemMaxima: 5,
      dinheiroConfirmado: 25,
      modelos: modelos5,
      capacidadePorCategoria: { REFRIGERANTE: 200 }
    });
    assert.equal(r.distribuicao_possivel, true);
    assert.equal(r.complemento_dinheiro, 0);
    assert.equal(r.desconto_ajuste, 0);
    assert.equal(r.composicao_encontrada, 15);
    assert.equal(r.modo, 'exata');
  });

  it('G. composição acima — complemento ceil 0,05 atualiza candidato oficial', () => {
    // residual 17,00 → acima 20,00; excesso 3,00 → complemento ceil 3,00; desconto 0
    const r = avaliarCandidatoComComplementoDinheiro({
      valorFiscalCandidato: 17,
      margemMaxima: 5,
      dinheiroConfirmado: 25,
      modelos: modelos5,
      capacidadePorCategoria: { REFRIGERANTE: 200 }
    });
    assert.equal(r.distribuicao_possivel, true);
    assert.equal(r.modo, 'acima_com_complemento');
    assert.equal(r.composicao_encontrada, 20);
    assert.equal(r.complemento_dinheiro, 3);
    assert.equal(r.desconto_ajuste, 0);
    assert.equal(r.valor_fiscal_residual_final, 20);
    assert.equal(r.valor_fiscal_candidato_oficial, 20);
    assert.equal(r.candidato_oficial_atualizado, true);
    assert.equal(ehComplementoMoeda5Centavos(r.complemento_dinheiro_centavos), true);
    assert.equal(ceilComplementoMoeda5Centavos(300), 300);
  });

  it('F. quando existe exata, não consome complemento', () => {
    const r = avaliarCandidatoComComplementoDinheiro({
      valorFiscalCandidato: 20,
      margemMaxima: 5,
      dinheiroConfirmado: 25,
      modelos: modelos5,
      capacidadePorCategoria: { REFRIGERANTE: 200 }
    });
    assert.equal(r.distribuicao_possivel, true);
    assert.equal(r.complemento_dinheiro, 0);
    assert.equal(r.desconto_ajuste, 0);
  });

  it('I. só eletrônico — margem zero, sem complemento inventado', () => {
    const r = avaliarCandidatoComComplementoDinheiro({
      valorFiscalCandidato: 15,
      margemMaxima: 0,
      dinheiroConfirmado: 0,
      modelos: modelos5,
      capacidadePorCategoria: { REFRIGERANTE: 200 }
    });
    assert.equal(r.distribuicao_possivel, true);
    assert.equal(r.complemento_dinheiro, 0);
    assert.equal(r.margem_complemento_maxima, 0);
  });
});

describe('COMPLEMENTO-20-PORCENTO-01 — integração residual', { concurrency: false }, () => {
  it('A. misto 61,98 — complemento, fiscais/gerenciais e total preservado', async () => {
    const doc = await integrarMisto(pagamentosMisto6198('dinheiro_primeiro'));
    assert.equal(doc.bloqueado, false, JSON.stringify(doc));
    const ref = doc.referencia;
    assert.equal(ref.valor_fiscal_referencia_inicial, 37);
    assert.equal(ref.valor_nao_fiscal_referencia_inicial, 24.98);
    assert.equal(ref.margem_complemento_maxima, 5);
    assert.equal(ref.complemento_dinheiro_utilizado, 3);
    assert.equal(ref.desconto_ajuste, 0);
    assert.equal(ref.valor_fiscal_referencia, 40);
    assert.equal(ref.valor_nao_fiscal_referencia, 21.98);
    assert.equal(round2(ref.valor_fiscal_referencia + ref.valor_nao_fiscal_referencia), 61.98);

    const somaF = round2((doc.itens_fiscais || []).reduce((s, i) => s + Number(i.valor_fiscal || 0), 0));
    const somaNf = round2((doc.itens_nao_fiscais || []).reduce((s, i) => s + Number(i.valor_nao_fiscal || 0), 0));
    assert.equal(somaF, 40);
    assert.equal(somaNf, 21.98);
    assert.equal(round2(somaF + somaNf), 61.98);

    const apres = apresentacaoComposicaoFiscal(doc);
    assert.equal(apres.complemento_dinheiro_utilizado, 3);
    assert.equal(apres.desconto_ajuste, 0);
    assert.ok(doc.xml && String(doc.xml).includes('<vNF>40.00</vNF>'));
    assert.ok(String(doc.xml).includes('<vPag>37.00</vPag>') || String(doc.xml).includes('<vPag>37</vPag>'));
    assert.ok(String(doc.xml).includes('<vPag>3.00</vPag>') || String(doc.xml).includes('<vPag>3</vPag>'));
  });

  it('B. ordem inversa PIX→dinheiro — resultado equivalente', async () => {
    const a = await integrarMisto(pagamentosMisto6198('dinheiro_primeiro'));
    const b = await integrarMisto(pagamentosMisto6198('pix_primeiro'));
    assert.equal(a.bloqueado, false);
    assert.equal(b.bloqueado, false);
    assert.equal(a.referencia.valor_fiscal_referencia, b.referencia.valor_fiscal_referencia);
    assert.equal(a.referencia.valor_nao_fiscal_referencia, b.referencia.valor_nao_fiscal_referencia);
    assert.equal(a.referencia.complemento_dinheiro_utilizado, b.referencia.complemento_dinheiro_utilizado);
    assert.equal(a.referencia.desconto_ajuste, b.referencia.desconto_ajuste);
  });

  it('J. somente dinheiro — referência fiscal zero, sem complemento', async () => {
    const refs = calcularReferenciasConfirmadas([
      {
        forma_pagamento: 'dinheiro',
        valor: 61.98,
        status_autorizacao: 'informada',
        confirmacao_manual: 1
      }
    ]);
    assert.equal(refs.valor_fiscal_referencia, 0);
    assert.equal(refs.valor_nao_fiscal_referencia, 61.98);
    const doc = await integrarPagamentoRecomposicao({
      total: 61.98,
      empresaId: 7,
      pagamentos: [{
        forma_pagamento: 'dinheiro',
        valor: 61.98,
        status_autorizacao: 'informada',
        confirmacao_manual: 1
      }],
      itens: [PASTEL, REF, EXTRA],
      saldosPorProduto: SALDOS,
      configFiscal: CFG
    }, {
      env: ENV_TESTE,
      harnessDistribuicaoOficial: HARNESS,
      pagamentosJaComprovados: true
    });
    assert.equal(doc.bloqueado, true);
    assert.equal(doc.codigo, 'REFERENCIA_FISCAL_ZERO');
    assert.equal((doc.itens_fiscais || []).length, 0);
  });

  it('K. PIX pendente — não gera fiscal nem consome margem', async () => {
    const pagamentos = carimbar([
      {
        forma_pagamento: 'pix',
        valor: 36.98,
        status_autorizacao: 'pendente',
        nsu: 'NSU-PEND',
        autorizacao: 'AUT-PEND'
      },
      {
        forma_pagamento: 'dinheiro',
        valor: 25,
        status_autorizacao: 'informada',
        confirmacao_manual: 1
      }
    ]);
    const refs = calcularReferenciasConfirmadas(pagamentos);
    assert.equal(refs.valor_fiscal_referencia, 0);
    const doc = await integrarPagamentoRecomposicao({
      total: 61.98,
      empresaId: 7,
      pagamentos,
      itens: [PASTEL, REF, EXTRA],
      saldosPorProduto: SALDOS
    }, {
      env: ENV_TESTE,
      harnessDistribuicaoOficial: HARNESS,
      pagamentosJaComprovados: true
    });
    assert.equal(doc.bloqueado, true);
    assert.ok(
      doc.codigo === 'PAGAMENTO_INCOMPLETO'
      || doc.codigo === 'REFERENCIA_FISCAL_ZERO'
    );
  });

  it('M. emissor permanece sem reescrita; seleção só itens fiscais', () => {
    assert.equal(reescritaDeComposicaoNoEmissorAutorizada(), false);
    const pix = marcarParcelaEletronicaComprovada({
      forma_pagamento: 'pix',
      valor: 37,
      status_autorizacao: 'aprovada',
      nsu: 'NSU-M',
      autorizacao: 'AUT-M',
      tef_transacao_id: 9901
    });
    const dinheiro = {
      forma_pagamento: 'dinheiro',
      valor: 24.98,
      status_autorizacao: 'informada',
      confirmacao_manual: 1
    };
    const venda = {
      id: 1,
      total: 61.98,
      valor_fiscal: 40,
      valor_nao_fiscal: 21.98,
      pagamentos: [pix, dinheiro],
      __referencia_composicao_persistida: {
        venda_id: 1,
        complemento_dinheiro_utilizado: 3,
        desconto_ajuste: 0,
        valor_fiscal_referencia: 40,
        valor_nao_fiscal_referencia: 21.98,
        valor_fiscal_referencia_inicial: 37,
        valor_nao_fiscal_referencia_inicial: 24.98,
        dinheiro_recebido: 24.98
      }
    };
    const itens = [
      {
        produto_id: 1,
        quantidade: 1,
        quantidade_fiscal: 1,
        valor_fiscal: 20,
        valor_nao_fiscal: 0,
        item_fiscal: 1
      },
      {
        produto_id: 2,
        quantidade: 8,
        quantidade_fiscal: 4,
        valor_fiscal: 20,
        valor_nao_fiscal: 20,
        item_fiscal: 1
      },
      {
        produto_id: 3,
        quantidade: 1,
        quantidade_fiscal: 0,
        valor_fiscal: 0,
        valor_nao_fiscal: 1.98,
        item_fiscal: 0
      }
    ];
    const sel = selecionarItensFiscaisParaNfce(venda, itens);
    assert.equal(sel.bloqueado, false, JSON.stringify(sel));
    assert.equal(sel.complemento_dinheiro_utilizado, 3);
    assert.equal(sel.somaFiscal, 40);
    const src = fs.readFileSync(
      path.join(__dirname, '../../backend/services/fiscal/emissor.js'),
      'utf8'
    );
    assert.match(src, /selecionarItensFiscaisParaNfce/);
    assert.match(src, /reescritaDeComposicaoNoEmissorAutorizada/);
    assert.ok(!/reescritaDeComposicaoNoEmissorAutorizada\(\)\s*\?\s*true/.test(src));
  });
});

describe('COMPLEMENTO-20-PORCENTO-01 — carrinho vs catálogo', { concurrency: false }, () => {
  it('O. catálogo com produto fora do carrinho não entra na proposta fiscal', async () => {
    const pix = marcarParcelaEletronicaComprovada({
      forma_pagamento: 'pix',
      valor: 37,
      status_autorizacao: 'aprovada',
      nsu: 'NSU-CART-37',
      autorizacao: 'AUT-CART-37',
      tef_transacao_id: 9301
    });
    const dinheiro = {
      forma_pagamento: 'dinheiro',
      valor: 24.98,
      status_autorizacao: 'informada',
      confirmacao_manual: 1
    };
    const itens = [
      {
        produto_id: 101,
        produto_nome: 'Pastel',
        categoria_nome: 'PASTEIS',
        quantidade: 1,
        preco_unitario: 8.99,
        subtotal: 8.99,
        produto_ncm: '19059090',
        cfop: '5102',
        csosn: '102',
        unidade: 'UN',
        origem: 0
      },
      {
        produto_id: 201,
        produto_nome: 'R200',
        categoria_nome: 'REFRIGERANTES',
        quantidade: 3,
        preco_unitario: 12.99,
        subtotal: 38.97,
        produto_ncm: '22021000',
        cfop: '5102',
        csosn: '102',
        unidade: 'ML',
        origem: 0
      },
      {
        produto_id: 301,
        produto_nome: 'R300',
        categoria_nome: 'REFRIGERANTES',
        quantidade: 1,
        preco_unitario: 19.8,
        subtotal: 19.8,
        produto_ncm: '22021000',
        cfop: '5102',
        csosn: '102',
        unidade: 'ML',
        origem: 0
      }
    ];
    const doc = await integrarPagamentoRecomposicao({
      total: 61.98,
      desconto: 5.78,
      empresaId: 7,
      pagamentos: [pix, dinheiro],
      itens,
      saldosPorProduto: {
        101: { saldoFiscal: 10, saldoNaoFiscal: 10 },
        201: { saldoFiscal: 10, saldoNaoFiscal: 10 },
        301: { saldoFiscal: 10, saldoNaoFiscal: 10 },
        999: { saldoFiscal: 50, saldoNaoFiscal: 50 }
      },
      configFiscal: CFG
    }, {
      env: ENV_TESTE,
      harnessDistribuicaoOficial: HARNESS,
      // 999 simula refrigerante do catálogo fiscal que NÃO está no carrinho.
      modelos: [
        modeloPrecoFixo(999, 500, 50, 'REFRIGERANTE'),
        modeloPrecoFixo(201, 1299, 10, 'REFRIGERANTE'),
        modeloPrecoFixo(301, 1980, 10, 'REFRIGERANTE')
      ],
      capacidade_por_categoria: { REFRIGERANTE: 500 },
      pagamentosJaComprovados: true
    });
    assert.equal(doc.bloqueado, false, JSON.stringify({
      codigo: doc.codigo,
      motivo: doc.motivo
    }));
    assert.notEqual(doc.codigo, 'PRODUTO_INCOMPATIVEL');
    const idsFiscais = (doc.itens_fiscais || []).map((i) => Number(i.produto_id));
    assert.ok(idsFiscais.length > 0);
    assert.ok(idsFiscais.every((id) => [101, 201, 301].includes(id)));
    assert.ok(!idsFiscais.includes(999));
  });
});

describe('COMPLEMENTO-20-PORCENTO-01 — sem controle de estoque PDV', { concurrency: false }, () => {
  it('P. controla_estoque=0 com saldo NF 0 não bloqueia distribuição', async () => {
    const pix = marcarParcelaEletronicaComprovada({
      forma_pagamento: 'pix',
      valor: 37,
      status_autorizacao: 'aprovada',
      nsu: 'NSU-SEM-EST',
      autorizacao: 'AUT-SEM-EST',
      tef_transacao_id: 9401
    });
    const dinheiro = {
      forma_pagamento: 'dinheiro',
      valor: 24.98,
      status_autorizacao: 'informada',
      confirmacao_manual: 1
    };
    const itens = [
      {
        produto_id: 1,
        produto_nome: 'Pastel',
        categoria_nome: 'PASTEIS',
        quantidade: 2,
        preco_unitario: 8.99,
        subtotal: 17.98,
        produto_ncm: '19059090',
        cfop: '5102',
        csosn: '102',
        unidade: 'UN',
        origem: 0
      },
      {
        produto_id: 2,
        produto_nome: 'R200',
        categoria_nome: 'REFRIGERANTES',
        quantidade: 2,
        preco_unitario: 12.99,
        subtotal: 25.98,
        produto_ncm: '22021000',
        cfop: '5102',
        csosn: '102',
        unidade: 'ML',
        origem: 0
      },
      {
        produto_id: 3,
        produto_nome: 'R300',
        categoria_nome: 'REFRIGERANTES',
        quantidade: 1,
        preco_unitario: 19.8,
        subtotal: 19.8,
        produto_ncm: '22021000',
        cfop: '5102',
        csosn: '102',
        unidade: 'ML',
        origem: 0
      }
    ];
    const doc = await integrarPagamentoRecomposicao({
      total: 61.98,
      desconto: 1.78,
      empresaId: 7,
      pagamentos: [pix, dinheiro],
      itens,
      saldosPorProduto: {
        1: { saldoFiscal: 0, saldoNaoFiscal: 0, controla_estoque: 0 },
        2: { saldoFiscal: 0, saldoNaoFiscal: 0, controla_estoque: 0 },
        3: { saldoFiscal: 0, saldoNaoFiscal: 0, controla_estoque: 0 }
      },
      configFiscal: CFG
    }, {
      env: ENV_TESTE,
      harnessDistribuicaoOficial: HARNESS,
      modelos: [
        modeloPrecoFixo(2, 1299, 5, 'REFRIGERANTE'),
        modeloPrecoFixo(3, 1980, 5, 'REFRIGERANTE')
      ],
      capacidade_por_categoria: { REFRIGERANTE: 50 },
      pagamentosJaComprovados: true
    });
    assert.equal(doc.bloqueado, false, JSON.stringify({
      codigo: doc.codigo,
      motivo: doc.motivo
    }));
    assert.notEqual(doc.codigo, 'SALDO_INSUFICIENTE');
    assert.ok(!String(doc.motivo || '').includes('não fiscal insuficiente'));
  });
});

describe('COMPLEMENTO-20-PORCENTO-01 — débito+dinheiro com desconto comercial', { concurrency: false }, () => {
  it('N. débito 16,99 + dinheiro 20 + desconto 4,79 → fiscal 19,79 / ger 17,20', async () => {
    const debito = marcarParcelaEletronicaComprovada({
      forma_pagamento: 'cartao_debito',
      valor: 16.99,
      status_autorizacao: 'aprovada',
      nsu: 'NSU-DEB-1699',
      autorizacao: 'AUT-DEB-1699',
      tef_transacao_id: 9201
    });
    const dinheiro = {
      forma_pagamento: 'dinheiro',
      valor: 20,
      status_autorizacao: 'informada',
      confirmacao_manual: 1
    };
    const itens = [
      {
        produto_id: 1,
        produto_nome: 'Pastel',
        categoria_nome: 'PASTEIS',
        quantidade: 1,
        preco_unitario: 8.99,
        subtotal: 8.99,
        produto_ncm: '19059090',
        cfop: '5102',
        csosn: '102',
        unidade: 'UN',
        origem: 0
      },
      {
        produto_id: 2,
        produto_nome: 'R200',
        categoria_nome: 'REFRIGERANTES',
        quantidade: 1,
        preco_unitario: 12.99,
        subtotal: 12.99,
        produto_ncm: '22021000',
        cfop: '5102',
        csosn: '102',
        unidade: 'UN',
        origem: 0
      },
      {
        produto_id: 3,
        produto_nome: 'R300',
        categoria_nome: 'REFRIGERANTES',
        quantidade: 1,
        preco_unitario: 19.8,
        subtotal: 19.8,
        produto_ncm: '22021000',
        cfop: '5102',
        csosn: '102',
        unidade: 'UN',
        origem: 0
      }
    ];
    const doc = await integrarPagamentoRecomposicao({
      total: 36.99,
      desconto: 4.79,
      empresaId: 7,
      pagamentos: [debito, dinheiro],
      itens,
      saldosPorProduto: {
        1: { saldoFiscal: 5, saldoNaoFiscal: 5 },
        2: { saldoFiscal: 5, saldoNaoFiscal: 5 },
        3: { saldoFiscal: 5, saldoNaoFiscal: 5 }
      },
      configFiscal: CFG
    }, {
      env: ENV_TESTE,
      harnessDistribuicaoOficial: HARNESS,
      modelos: [
        modeloPrecoFixo(2, 1299, 3, 'REFRIGERANTE'),
        modeloPrecoFixo(3, 1980, 3, 'REFRIGERANTE')
      ],
      capacidade_por_categoria: { REFRIGERANTE: 50 },
      pagamentosJaComprovados: true
    });
    assert.equal(doc.bloqueado, false, JSON.stringify({
      codigo: doc.codigo,
      motivo: doc.motivo
    }));
    assert.equal(doc.codigo, 'DOCUMENTO_FISCAL_AUTORIZADO');
    assert.equal(doc.referencia.valor_fiscal_referencia, 19.79);
    assert.equal(doc.referencia.valor_nao_fiscal_referencia, 17.2);
    assert.equal(doc.referencia.complemento_dinheiro_utilizado, 2.8);
    assert.equal(doc.referencia.desconto_ajuste, 0.01);
    const somaF = round2((doc.itens_fiscais || []).reduce((s, i) => s + Number(i.valor_fiscal || 0), 0));
    const somaNf = round2((doc.itens_nao_fiscais || []).reduce((s, i) => s + Number(i.valor_nao_fiscal || 0), 0));
    assert.equal(somaF, 19.79);
    assert.equal(somaNf, 17.2);
    assert.ok(String(doc.xml).includes('<vPag>16.99</vPag>') || String(doc.xml).includes('<vPag>16.99'));
    assert.ok(String(doc.xml).includes('<vPag>2.80</vPag>') || String(doc.xml).includes('<vPag>2.8'));
  });
});

describe('COMPLEMENTO-20-PORCENTO-01 — contrato legado itensFiscaisInteiros', { concurrency: false }, () => {
  it('contrato histórico ainda expõe dinheiro_aplicado em múltiplos de 0,05', async () => {
    assert.equal(typeof itensFiscaisInteirosParaReferencia, 'function');
    assert.equal(pisoComplementoMoeda5Centavos(503), 500);
  });
});
