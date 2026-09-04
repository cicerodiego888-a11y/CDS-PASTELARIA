/**
 * MUC-07 — Estoque inicial da importação via MUC (com compatibilidade de fator).
 * Executar: node --test tests/muc/muc-07-importacao-inicial.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolverEstoqueInicialImportacao,
  ORIGEM_CALCULO
} = require('../../backend/services/importacao-inicial-produtos/resolverEstoqueInicialImportacao');
const { calcularEstoqueInicial } = require('../../backend/services/importacao-inicial-produtos/helpers');
const { montarEstoquePreview } = require('../../backend/services/importacao-inicial-produtos/validator');

describe('MUC-07 importação inicial', () => {
  it('T01 — legado simples: 10 × 12 = 120 (FATOR_CONVERSAO)', () => {
    const r = resolverEstoqueInicialImportacao({
      quantidadeDocumento: 10,
      fatorConversao: 12
    });
    assert.equal(r.estoque_inicial, 120);
    assert.equal(r.origemCalculo, ORIGEM_CALCULO.FATOR_CONVERSAO);
  });

  it('T02 — MUC simples: 10 CAIXA → 120 UN', () => {
    const r = resolverEstoqueInicialImportacao({
      quantidadeDocumento: 10,
      unidadeOrigem: 'CAIXA',
      unidadeDestino: 'UN',
      apresentacoes: [{ tipo: 'CX', quantidade: 12, unidade: 'UN', ativa: 1 }],
      fatorConversao: 99
    });
    assert.equal(r.estoque_inicial, 120);
    assert.equal(r.origemCalculo, ORIGEM_CALCULO.MUC);
  });

  it('T03 — MUC encadeado: 10 CAIXA → 240 L', () => {
    const r = resolverEstoqueInicialImportacao({
      quantidadeDocumento: 10,
      unidadeOrigem: 'CAIXA',
      unidadeDestino: 'L',
      apresentacoes: [{ tipo: 'CX', quantidade: 12, unidade: 'UN', ativa: 1 }],
      relacoes: [{ de: 'UN', para: 'L', fator: 2 }]
    });
    assert.equal(r.estoque_inicial, 240);
    assert.equal(r.origemCalculo, ORIGEM_CALCULO.MUC);
  });

  it('T04 — MUC SI: 300 ML → 0,3 L', () => {
    const r = resolverEstoqueInicialImportacao({
      quantidadeDocumento: 300,
      unidadeOrigem: 'ML',
      unidadeDestino: 'L',
      fatorConversao: 1000
    });
    assert.equal(r.estoque_inicial, 0.3);
    assert.equal(r.origemCalculo, ORIGEM_CALCULO.MUC);
  });

  it('T05 — MUC embalagem + SI: 10 FARDO → 42.000 ML', () => {
    const r = resolverEstoqueInicialImportacao({
      quantidadeDocumento: 10,
      unidadeOrigem: 'FARDO',
      unidadeDestino: 'ML',
      apresentacoes: [{ tipo: 'FD', quantidade: 12, unidade: 'UN', ativa: 1 }],
      relacoes: [{ de: 'UN', para: 'ML', fator: 350 }]
    });
    assert.equal(r.estoque_inicial, 42000);
    assert.equal(r.origemCalculo, ORIGEM_CALCULO.MUC);
  });

  it('T06 — sem unidade, com fator: compatibilidade', () => {
    const r = resolverEstoqueInicialImportacao({
      quantidadeDocumento: 10,
      fatorConversao: 12
    });
    assert.equal(r.estoque_inicial, 120);
    assert.equal(r.modo, 'COMPATIBILIDADE');
  });

  it('T07 — sem unidade e sem quantidade: erro explícito', () => {
    assert.throws(
      () => resolverEstoqueInicialImportacao({}),
      (e) => e.code === 'QUANTIDADE_INVALIDA'
    );
  });

  it('T08 — caminho MUC inexistente: não inventa relação; fator se houver', () => {
    const comFator = resolverEstoqueInicialImportacao({
      quantidadeDocumento: 10,
      unidadeOrigem: 'CAIXA',
      unidadeDestino: 'ML',
      fatorConversao: 12
    });
    assert.equal(comFator.estoque_inicial, 120);
    assert.equal(comFator.origemCalculo, ORIGEM_CALCULO.FATOR_CONVERSAO);
    assert.equal(comFator.motivo, 'CAMINHO_MUC_NAO_ENCONTRADO');

    assert.throws(
      () => resolverEstoqueInicialImportacao({
        quantidadeDocumento: 10,
        unidadeOrigem: 'CAIXA',
        unidadeDestino: 'ML'
      }),
      (e) => e.code === 'CONVERSAO_NAO_DISPONIVEL'
    );
  });

  it('T09 — não duplica conversão: MUC ignora fator', () => {
    const r = resolverEstoqueInicialImportacao({
      quantidadeDocumento: 10,
      unidadeOrigem: 'CAIXA',
      unidadeDestino: 'UN',
      apresentacoes: [{ tipo: 'CX', quantidade: 12, unidade: 'UN', ativa: 1 }],
      fatorConversao: 12
    });
    assert.equal(r.estoque_inicial, 120);
    assert.notEqual(r.estoque_inicial, 1440);
    assert.equal(r.origemCalculo, ORIGEM_CALCULO.MUC);
  });

  it('T10 — preview == resolução (simulação)', () => {
    const produto = {
      unidade_base: 'UN',
      unidade_origem: 'CX',
      quantidade_documento: 1
    };
    const pricing = {
      apresentacoes: [{ tipo: 'CX', quantidade: 12, unidade: 'UN', custo: 10, principal: 1 }],
      apresentacao_principal: { tipo: 'CX', quantidade: 12, unidade: 'UN', custo: 10 },
      custo_unitario: 1
    };
    const preview = montarEstoquePreview(produto, pricing);
    const direto = calcularEstoqueInicial({
      quantidadeDocumento: 1,
      unidadeOrigem: 'CX',
      unidadeDestino: 'UN',
      apresentacoes: pricing.apresentacoes,
      fatorConversao: 12
    });
    assert.equal(preview.estoque_inicial, direto.estoque_inicial);
    assert.equal(preview.estoque_inicial, 12);
    assert.equal(preview.origem_calculo, ORIGEM_CALCULO.MUC);
  });

  it('calcularEstoqueInicial permanece orquestrador (contrato legado)', () => {
    assert.equal(calcularEstoqueInicial({ quantidadeDocumento: 12, fatorConversao: 1 }).estoque_inicial, 12);
    assert.equal(calcularEstoqueInicial({ quantidadeDocumento: 3, fatorConversao: 12 }).estoque_inicial, 36);
  });

  it('família incompatível não cai em fator', () => {
    assert.throws(
      () => resolverEstoqueInicialImportacao({
        quantidadeDocumento: 1,
        unidadeOrigem: 'KG',
        unidadeDestino: 'L',
        fatorConversao: 1000
      }),
      (e) => e.code === 'CONVERSAO_INVALIDA'
    );
  });
});
