'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { distribuirPagamentos } = require('../../backend/services/midp/MotorInteligenteDistribuicaoPagamentos');

const {
  avaliarCandidatoComComplementoDinheiro,
  avaliarComplementoFiscalIntegral
} = require('../../backend/services/vendas/RecomposicaoFiscalComposicaoMotorSimulacaoService');
const {
  integrarPagamentoRecomposicao
} = require('../../backend/services/vendas/PagamentoRecomposicaoDocumentoService');
const {
  carregarReferenciaRecomposicao,
  calcularReferenciasConfirmadas,
  gravarReferenciaRecomposicao,
  marcarParcelaEletronicaComprovada,
  validarReferenciaFiscalFinalComComplemento
} = require('../../backend/services/vendas/PagamentoSequencialComposicaoService');

const ENV_TESTE = Object.freeze({
  CDS_RECOMPOSICAO_REFERENCIA_TESTE: '1',
  CDS_RECOMPOSICAO_FECHAMENTO_OPERACIONAL: '0'
});
const CFG_FISCAL_TESTE = Object.freeze({
  codigoUf: '23',
  cnpj: '65957340000150',
  ie: '073252638',
  crt: 1,
  ambiente: 2,
  serie: 1,
  nomeEmpresa: 'EMPRESA TESTE',
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

function modelo(produtoId, preco, categoria, quantidadeMaxima = 1) {
  const centavos = Math.round(preco * 100);
  return {
    produtoId,
    nome: `Produto ${produtoId}`,
    categoriaFiscal: categoria,
    volumeMlPorUnidade: 1,
    quantidadeMaxima,
    cotador: {
      precoUnitarioMinimoInterno: preco,
      cotar(quantidade) {
        return {
          subtotalCentavos: centavos * quantidade,
          precoUnitarioInterno: preco,
          regrasAplicadas: [],
          fingerprint: `memory-${produtoId}-${quantidade}`
        };
      }
    }
  };
}

function pagamentosReferencia() {
  return [
    marcarParcelaEletronicaComprovada({
      forma_pagamento: 'pix',
      valor: 1.99,
      status_autorizacao: 'aprovada',
      nsu: 'NSU-MEMORY',
      autorizacao: 'AUT-MEMORY',
      tef_transacao_id: 1
    }),
    {
      forma_pagamento: 'dinheiro',
      valor: 20,
      status_autorizacao: 'informada',
      confirmacao_manual: 1
    }
  ];
}

function itensReferencia(valorFiscal = 8.99, valorNaoFiscal = 21.99 - valorFiscal) {
  return [
    {
      produto_id: 1,
      produto_nome: 'Pastel',
      categoria_nome: 'PASTEIS',
      quantidade: 1,
      preco_unitario: valorFiscal,
      subtotal: valorFiscal,
      unidade: 'UN',
      produto_ncm: '19059090',
      cfop: '5102',
      csosn: '102'
    },
    {
      produto_id: 2,
      produto_nome: 'Produto não fiscal',
      categoria_nome: 'DIVERSOS',
      quantidade: 1,
      preco_unitario: valorNaoFiscal,
      subtotal: valorNaoFiscal,
      unidade: 'UN',
      produto_ncm: '21069090',
      cfop: '5102',
      csosn: '102'
    }
  ];
}

function integrar({
  valorFiscal = 8.99,
  valorNaoFiscal = 21.99 - valorFiscal,
  pagamentos = pagamentosReferencia()
} = {}) {
  const pagamentosAntes = pagamentos.map((pagamento) => ({ ...pagamento }));
  const itens = itensReferencia(valorFiscal, valorNaoFiscal);
  const saldosPorProduto = {
    1: { saldoFiscal: 1, saldoNaoFiscal: 1 },
    2: { saldoFiscal: 1, saldoNaoFiscal: 1 }
  };
  return integrarPagamentoRecomposicao({
    total: 21.99,
    empresaId: 7,
    pagamentos,
    itens,
    saldosPorProduto,
    configFiscal: CFG_FISCAL_TESTE
  }, {
    env: ENV_TESTE,
    harnessDistribuicaoOficial: { ativa: true },
    pagamentosJaComprovados: true
  }).then((documento) => ({ documento, pagamentos, pagamentosAntes }));
}

function abrirBancoEmMemoria() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (erro) => {
      if (erro) reject(erro);
      else resolve(db);
    });
  });
}

function fecharBanco(db) {
  return new Promise((resolve, reject) => {
    db.close((erro) => (erro ? reject(erro) : resolve()));
  });
}

describe('Complemento fiscal integral com dados em memória', () => {
  it('reproduz a insuficiência da regra percentual antes do complemento excepcional', () => {
    const normal = avaliarCandidatoComComplementoDinheiro({
      valorFiscalCandidato: 1.99,
      margemMaxima: 4,
      dinheiroConfirmado: 20,
      modelos: [modelo(1, 8.99, 'PASTEIS')],
      capacidadePorCategoria: { PASTEIS: 1 }
    });

    assert.equal(normal.distribuicao_possivel, true);
    assert.equal(normal.complemento_dinheiro, 4);
    assert.equal(normal.desconto_ajuste, 3);
    assert.equal(normal.valor_fiscal_candidato_oficial, 5.99);
  });

  it('complementa somente o necessário e gera XML com o produto inteiro', async () => {
    const { documento, pagamentos, pagamentosAntes } = await integrar();

    assert.equal(documento.bloqueado, false, JSON.stringify(documento));
    assert.equal(documento.referencia.valor_fiscal_referencia_inicial, 1.99);
    assert.equal(documento.referencia.valor_nao_fiscal_referencia_inicial, 20);
    assert.equal(documento.referencia.margem_complemento_maxima, 4);
    assert.equal(documento.referencia.complemento_dinheiro_utilizado, 7);
    assert.equal(documento.referencia.desconto_ajuste, 0);
    assert.equal(documento.referencia.origem_recomposicao, 'complemento_integral_produto_excepcional');
    assert.equal(documento.referencia.valor_fiscal_referencia, 8.99);
    assert.equal(documento.referencia.valor_nao_fiscal_referencia, 13);
    assert.equal(documento.itens_fiscais[0].quantidade_fiscal, 1);
    assert.equal(documento.itens_fiscais[0].valor_fiscal, 8.99);
    assert.equal(documento.itens_nao_fiscais[0].valor_nao_fiscal, 13);
    assert.equal(documento.valores.vNF, 8.99);
    assert.match(documento.xml, /<vProd>8\.99<\/vProd>/);
    assert.match(documento.xml, /<vNF>8\.99<\/vNF>/);
    assert.match(documento.xml, /<vPag>1\.99<\/vPag>/);
    assert.match(documento.xml, /<vPag>7\.00<\/vPag>/);
    assert.equal((documento.xml.match(/<det nItem=/g) || []).length, 1);
    assert.doesNotMatch(documento.xml, /<cProd>2<\/cProd>/);
    assert.deepEqual(pagamentos, pagamentosAntes);
    assert.equal(Math.round((documento.referencia.valor_fiscal_referencia
      + documento.referencia.valor_nao_fiscal_referencia) * 100), 2199);

    const legs = distribuirPagamentos(pagamentos, 8.99, 13);
    assert.equal(legs.recebimentosFiscal.reduce((soma, item) => soma + item.valor, 0), 8.99);
    assert.equal(legs.recebimentosNaoFiscal.reduce((soma, item) => soma + item.valor, 0), 13);
    assert.equal(
      legs.recebimentosFiscal.filter((item) => item.forma_pagamento === 'dinheiro')
        .reduce((soma, item) => soma + item.valor, 0),
      7
    );
    assert.equal(
      legs.recebimentosNaoFiscal.filter((item) => item.forma_pagamento === 'dinheiro')
        .reduce((soma, item) => soma + item.valor, 0),
      13
    );
  });

  it('mantém a distribuição normal dos 20% quando ela cobre o produto integral', async () => {
    const { documento } = await integrar({ valorFiscal: 5.99, valorNaoFiscal: 16 });

    assert.equal(documento.bloqueado, false, JSON.stringify(documento));
    assert.equal(documento.referencia.complemento_dinheiro_utilizado, 4);
    assert.equal(documento.referencia.desconto_ajuste, 0);
    assert.notEqual(documento.referencia.origem_recomposicao, 'complemento_integral_produto_excepcional');
    assert.equal(documento.itens_fiscais[0].valor_fiscal, 5.99);
    assert.equal(documento.valores.vNF, 5.99);
  });

  it('usa centavos exatos quando o arredondamento de 5 centavos fracionaria o valor fiscal', async () => {
    const { documento } = await integrar({ valorFiscal: 5, valorNaoFiscal: 16.99 });

    assert.equal(documento.bloqueado, false, JSON.stringify(documento));
    assert.equal(documento.referencia.complemento_dinheiro_utilizado, 3.01);
    assert.equal(documento.referencia.desconto_ajuste, 0);
    assert.equal(documento.referencia.origem_recomposicao, 'complemento_integral_produto_excepcional');
    assert.equal(documento.itens_fiscais[0].valor_fiscal, 5);
    assert.equal(documento.valores.vNF, 5);
    assert.match(documento.xml, /<vPag>3\.01<\/vPag>/);
  });

  it('preserva PIX e cartão e usa somente o complemento necessário em dinheiro', async () => {
    const pagamentos = [
      marcarParcelaEletronicaComprovada({
        forma_pagamento: 'pix',
        valor: 0.99,
        status_autorizacao: 'aprovada',
        tef_transacao_id: 2
      }),
      marcarParcelaEletronicaComprovada({
        forma_pagamento: 'cartao_debito',
        valor: 1,
        status_autorizacao: 'aprovada',
        tef_transacao_id: 3
      }),
      {
        forma_pagamento: 'dinheiro',
        valor: 20,
        status_autorizacao: 'informada',
        confirmacao_manual: 1
      }
    ];
    const { documento, pagamentos: recebidos, pagamentosAntes } = await integrar({ pagamentos });

    assert.equal(documento.bloqueado, false, JSON.stringify(documento));
    assert.equal(documento.referencia.complemento_dinheiro_utilizado, 7);
    assert.deepEqual(recebidos, pagamentosAntes);
    assert.match(documento.xml, /<vPag>0\.99<\/vPag>/);
    assert.match(documento.xml, /<vPag>1\.00<\/vPag>/);
    assert.match(documento.xml, /<vPag>7\.00<\/vPag>/);
  });

  it('não excede dinheiro disponível ao buscar complemento integral', () => {
    const resultado = avaliarComplementoFiscalIntegral({
      valorFiscalCandidato: 1.99,
      dinheiroDisponivel: 6.99,
      modelos: [modelo(1, 8.99, 'PASTEIS')],
      capacidadePorCategoria: { PASTEIS: 1 }
    });

    assert.equal(resultado.distribuicao_possivel, false);
    assert.equal(resultado.codigo, 'DINHEIRO_INSUFICIENTE_COMPLEMENTO_INTEGRAL');
    assert.equal(resultado.complemento_dinheiro, 0);
  });

  it('mantém cada produto da composição múltipla em quantidade integral', () => {
    const resultado = avaliarComplementoFiscalIntegral({
      valorFiscalCandidato: 6.99,
      dinheiroDisponivel: 2,
      modelos: [
        modelo(1, 4.99, 'PASTEIS'),
        modelo(2, 4, 'REFRIGERANTES')
      ],
      capacidadePorCategoria: { PASTEIS: 1, REFRIGERANTES: 1 }
    });

    assert.equal(resultado.distribuicao_possivel, true);
    assert.equal(resultado.complemento_dinheiro, 2);
    assert.equal(resultado.composicao_encontrada, 8.99);
    assert.deepEqual(
      resultado.itens_compostos.map((item) => [item.produtoId, item.quantidade]),
      [[1, 1], [2, 1]]
    );
  });

  it('valida o snapshot excepcional persistido sem enfraquecer a validação padrão', () => {
    const pagamentos = pagamentosReferencia();
    const itens = [
      { quantidade_fiscal: 1, quantidade_nao_fiscal: 0, valor_fiscal: 8.99, valor_nao_fiscal: 0 },
      { quantidade_fiscal: 0, quantidade_nao_fiscal: 1, valor_fiscal: 0, valor_nao_fiscal: 13 }
    ];
    const venda = { id: 21, total: 21.99, valor_fiscal: 8.99, valor_nao_fiscal: 13 };
    const referenciaPersistida = {
      venda_id: 21,
      origem_recomposicao: 'complemento_integral_produto_excepcional',
      complemento_dinheiro_utilizado: 7,
      desconto_ajuste: 0,
      valor_fiscal_referencia_inicial: 1.99,
      valor_nao_fiscal_referencia_inicial: 20,
      valor_fiscal_referencia: 8.99,
      valor_nao_fiscal_referencia: 13
    };

    const validacao = validarReferenciaFiscalFinalComComplemento({
      pagamentos,
      itens,
      venda,
      referenciaPersistida
    });
    assert.equal(validacao.ok, true, JSON.stringify(validacao));

    const semMarcadorExcepcional = validarReferenciaFiscalFinalComComplemento({
      pagamentos,
      itens,
      venda,
      referenciaPersistida: {
        ...referenciaPersistida,
        origem_recomposicao: 'recomposicao_complemento_20'
      }
    });
    assert.equal(semMarcadorExcepcional.ok, false);
    assert.equal(semMarcadorExcepcional.codigo, 'COMPLEMENTO_ACIMA_DA_MARGEM');

    const quantidadeFracionada = validarReferenciaFiscalFinalComComplemento({
      pagamentos,
      itens: [
        { quantidade_fiscal: 0.5, quantidade_nao_fiscal: 0.5, valor_fiscal: 8.99, valor_nao_fiscal: 0 },
        { quantidade_fiscal: 0, quantidade_nao_fiscal: 1, valor_fiscal: 0, valor_nao_fiscal: 13 }
      ],
      venda,
      referenciaPersistida
    });
    assert.equal(quantidadeFracionada.ok, false);
    assert.equal(quantidadeFracionada.codigo, 'COMPLEMENTO_EXCEPCIONAL_QUANTIDADE_FRACIONADA');

    const complementoEmCentavos = validarReferenciaFiscalFinalComComplemento({
      pagamentos,
      itens: [
        { quantidade_fiscal: 1, quantidade_nao_fiscal: 0, valor_fiscal: 5, valor_nao_fiscal: 0 },
        { quantidade_fiscal: 0, quantidade_nao_fiscal: 1, valor_fiscal: 0, valor_nao_fiscal: 16.99 }
      ],
      venda: { id: 21, total: 21.99, valor_fiscal: 5, valor_nao_fiscal: 16.99 },
      referenciaPersistida: {
        ...referenciaPersistida,
        complemento_dinheiro_utilizado: 3.01,
        valor_fiscal_referencia: 5,
        valor_nao_fiscal_referencia: 16.99
      }
    });
    assert.equal(complementoEmCentavos.ok, true, JSON.stringify(complementoEmCentavos));

    const referencias = calcularReferenciasConfirmadas(pagamentos);
    assert.equal(referencias.valor_fiscal_referencia, 1.99);
    assert.equal(referencias.valor_nao_fiscal_referencia, 20);
  });

  it('recupera o complemento persistido e impede snapshot duplicado por venda', async () => {
    const db = await abrirBancoEmMemoria();
    const referencia = {
      recomposicao_executada: true,
      total_financeiro: 21.99,
      valor_fiscal_referencia: 8.99,
      valor_nao_fiscal_referencia: 13,
      valor_fiscal_referencia_inicial: 1.99,
      valor_nao_fiscal_referencia_inicial: 20,
      complemento_dinheiro_utilizado: 7,
      desconto_ajuste: 0,
      origem_recomposicao: 'complemento_integral_produto_excepcional',
      avaliacao_motor: { codigo: 'OK_COMPLEMENTO_EXCEPCIONAL_INTEGRAL', distribuicao_possivel: true }
    };
    try {
      await gravarReferenciaRecomposicao(db, 21, referencia);
      const persistida = await carregarReferenciaRecomposicao(db, 21);
      assert.equal(persistida.origem_recomposicao, 'complemento_integral_produto_excepcional');
      assert.equal(persistida.complemento_dinheiro_utilizado, 7);
      assert.equal(persistida.valor_fiscal_referencia, 8.99);
      await assert.rejects(
        gravarReferenciaRecomposicao(db, 21, referencia),
        /UNIQUE constraint failed/
      );
    } finally {
      await fecharBanco(db);
    }
  });
});
