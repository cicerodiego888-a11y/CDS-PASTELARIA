/**
 * MUC-08 — Fechamento RC3.0: oráculos oficiais, compra, importação, pós-limpeza.
 * Executar: node --test tests/muc/muc-08-fechamento.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const { obterMuc, VERSAO } = require('../../backend/motores/muc/public');
const MotorUM = require('../../backend/services/unidades/MotorUnidadesMedida');
const { simularConversaoCompraPreview } = require('../../backend/services/compras/simularConversaoCompraPreview');
const {
  resolverEstoqueInicialImportacao,
  ORIGEM_CALCULO
} = require('../../backend/services/importacao-inicial-produtos/resolverEstoqueInicialImportacao');

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function muc() {
  return obterMuc({ run() {}, all() {}, get() {} });
}

function conv(quantidade, unidadeOrigem, unidadeDestino, relacoes) {
  return muc().converterQuantidade({ quantidade, unidadeOrigem, unidadeDestino, relacoes });
}

describe('MUC-08 fechamento RC3.0', () => {
  it('versão consolidada RC3.0 (contrato DTO 1.0.0)', () => {
    assert.equal(VERSAO.VERSAO, 'RC3.0');
    assert.equal(VERSAO.STATUS, 'CONSOLIDADO');
    assert.equal(VERSAO.CONTRATO, '1.0.0');
    assert.equal(VERSAO.VERSAO_RC2_1, 'RC2.1');
    assert.equal(muc().obterVersao().VERSAO, 'RC3.0');
  });

  it('T01 — 300 ML → 0,3 L (oráculo MUC)', () => {
    assert.equal(conv(300, 'ML', 'L').quantidade, 0.3);
  });

  it('T02 — 80 G → 0,08 KG', () => {
    assert.equal(conv(80, 'G', 'KG').quantidade, 0.08);
  });

  it('T03 — 1 CAIXA → 12 UN', () => {
    const r = conv(1, 'CAIXA', 'UN', [{ de: 'CAIXA', para: 'UN', fator: 12 }]);
    assert.equal(r.quantidade, 12);
  });

  it('T04 — 1 CAIXA → 12 UN → 24 L', () => {
    const r = conv(1, 'CAIXA', 'L', [
      { de: 'CAIXA', para: 'UN', fator: 12 },
      { de: 'UN', para: 'L', fator: 2 }
    ]);
    assert.equal(r.quantidade, 24);
  });

  it('T05 — 12 CAIXAS → 288 L → 288.000 ML', () => {
    const r = conv(12, 'CAIXA', 'ML', [
      { de: 'CAIXA', para: 'UN', fator: 12 },
      { de: 'UN', para: 'L', fator: 2 }
    ]);
    assert.equal(r.quantidade, 288000);
  });

  it('T06 — 10 FARDO → 42.000 ML', () => {
    const r = conv(10, 'FARDO', 'ML', [
      { de: 'FARDO', para: 'UN', fator: 12 },
      { de: 'UN', para: 'ML', fator: 350 }
    ]);
    assert.equal(r.quantidade, 42000);
  });

  it('T07 — 20 UN laranja → 3 KG', () => {
    const r = conv(20, 'UN', 'KG', [{ de: 'UN', para: 'G', fator: 150 }]);
    assert.equal(r.quantidade, 3);
  });

  it('compra: preview === persistência (converterQuantidade / processarItemCompra)', async () => {
    const preview = await simularConversaoCompraPreview(null, {
      quantidade: 1,
      unidadeOrigem: 'CAIXA',
      unidadeDestino: 'UN',
      quantidadePorApresentacao: 12
    });
    const persist = conv(1, 'CAIXA', 'UN', [{ de: 'CAIXA', para: 'UN', fator: 12 }]);
    const pipeline = muc().converter({
      produtoId: 1,
      item: {
        quantidade_embalagens: 1,
        quantidade_por_embalagem: 12,
        valor_total_embalagem: 0,
        unidade_comercial: 'CAIXA',
        compra_em: 'CX'
      },
      origem: 'MANUAL'
    });
    assert.equal(preview.quantidadeConvertida, persist.quantidade);
    assert.equal(preview.quantidadeConvertida, pipeline.quantidadeEstoque);
    assert.equal(preview.quantidadeConvertida, 12);
  });

  it('importação A — unidades → MUC', () => {
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

  it('importação B — legado com fator', () => {
    const r = resolverEstoqueInicialImportacao({
      quantidadeDocumento: 10,
      fatorConversao: 12
    });
    assert.equal(r.estoque_inicial, 120);
    assert.equal(r.origemCalculo, ORIGEM_CALCULO.FATOR_CONVERSAO);
  });

  it('importação C — MUC + fator: uma conversão só', () => {
    const r = resolverEstoqueInicialImportacao({
      quantidadeDocumento: 10,
      unidadeOrigem: 'CAIXA',
      unidadeDestino: 'UN',
      apresentacoes: [{ tipo: 'CX', quantidade: 12, unidade: 'UN', ativa: 1 }],
      fatorConversao: 12
    });
    assert.equal(r.estoque_inicial, 120);
    assert.notEqual(r.estoque_inicial, 1440);
  });

  it('importação D — sem quantidade: erro explícito', () => {
    assert.throws(
      () => resolverEstoqueInicialImportacao({}),
      (e) => e.code === 'QUANTIDADE_INVALIDA'
    );
  });

  it('importação E — família incompatível não mascara com fator', () => {
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

  it('pós-limpeza: símbolos mortos ausentes de MotorUM', () => {
    const um = src('backend/services/unidades/MotorUnidadesMedida.js');
    assert.doesNotMatch(um, /FATOR_UNIDADE_BASE/);
    assert.doesNotMatch(um, /listarUnidadesComerciais/);
    assert.doesNotMatch(um, /converterQuantidadeEntreUnidades/);
    assert.equal(typeof MotorUM.listarUnidadesComerciais, 'undefined');
    assert.equal(typeof MotorUM.converterQuantidadeEntreUnidades, 'undefined');
    assert.equal(typeof MotorUM.exigeQuantidadePorEmbalagem, 'undefined');
    assert.equal(typeof MotorUM.calcularFormacaoPrecoCadastro, 'function');
    assert.equal(typeof MotorUM.normalizarUnidadeComercial, 'function');
  });

  it('frontend sem conversor operacional paralelo', () => {
    const front = src('frontend/shared/js/motor-quantidade-compra.js');
    assert.match(front, /quantidade_convertida/);
    assert.doesNotMatch(front, /baseEmb \* qtdPorEmb/);
    assert.doesNotMatch(front, /\*\s*1000/);
    assert.doesNotMatch(front, /if \(unidade ===/);
  });

  it('compras.js não importa obterQuantidadeConvertida', () => {
    const compras = src('backend/rotas/compras.js');
    assert.doesNotMatch(compras, /obterQuantidadeConvertida,/);
    assert.match(compras, /obterMuc/);
  });
});
