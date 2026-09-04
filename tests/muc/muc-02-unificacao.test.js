/**
 * MUC-02 — Unificação SI + encadeamento.
 * Executar: node tests/muc/muc-02-unificacao.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const { obterMuc } = require('../../backend/motores/muc/public');
const { converterQuantidade, CODIGOS } = require('../../backend/motores/muc/core/MotorConversaoQuantidade');

const mockDb = {
  run(sql, params, cb) { if (typeof params === 'function') params(null); else if (cb) cb(null); },
  get(sql, params, cb) { if (typeof params === 'function') params(null, null); else if (cb) cb(null, null); },
  all(sql, params, cb) { if (typeof params === 'function') params(null, []); else if (cb) cb(null, []); }
};

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const REL_COCA = Object.freeze([
  { de: 'CAIXA', para: 'UN', fator: 12 },
  { de: 'UN', para: 'ML', fator: 2000 }
]);

const REL_AGUA = Object.freeze([
  { de: 'FARDO', para: 'UN', fator: 12 },
  { de: 'UN', para: 'ML', fator: 350 }
]);

describe('MUC-02 unificação', () => {
  it('T01 — UN → UN', () => {
    assert.equal(converterQuantidade({ quantidade: 7, unidadeOrigem: 'UN', unidadeDestino: 'UN' }).quantidade, 7);
  });

  it('T02 — KG → G', () => {
    assert.equal(converterQuantidade({ quantidade: 1, unidadeOrigem: 'KG', unidadeDestino: 'G' }).quantidade, 1000);
  });

  it('T03 — G → KG', () => {
    assert.equal(converterQuantidade({ quantidade: 5000, unidadeOrigem: 'G', unidadeDestino: 'KG' }).quantidade, 5);
  });

  it('T04 — L → ML', () => {
    assert.equal(converterQuantidade({ quantidade: 1.5, unidadeOrigem: 'L', unidadeDestino: 'ML' }).quantidade, 1500);
  });

  it('T05 — ML → L', () => {
    assert.equal(converterQuantidade({ quantidade: 300, unidadeOrigem: 'ML', unidadeDestino: 'L' }).quantidade, 0.3);
  });

  it('T06 — CAIXA → UN', () => {
    const r = converterQuantidade({
      quantidade: 1,
      unidadeOrigem: 'CAIXA',
      unidadeDestino: 'UN',
      relacoes: [{ de: 'CAIXA', para: 'UN', fator: 12 }]
    });
    assert.equal(r.quantidade, 12);
  });

  it('T07 — CAIXA → UN → ML', () => {
    const r = converterQuantidade({
      quantidade: 1,
      unidadeOrigem: 'CAIXA',
      unidadeDestino: 'ML',
      relacoes: REL_COCA
    });
    assert.equal(r.quantidade, 24000);
  });

  it('T08 — FARDO → UN → ML', () => {
    const r = converterQuantidade({
      quantidade: 1,
      unidadeOrigem: 'FARDO',
      unidadeDestino: 'ML',
      relacoes: REL_AGUA
    });
    assert.equal(r.quantidade, 4200);
  });

  it('T09 — Coca-Cola 12 CX → 288.000 ML', () => {
    const r = converterQuantidade({
      quantidade: 12,
      unidadeOrigem: 'CX',
      unidadeDestino: 'ML',
      relacoes: REL_COCA
    });
    assert.equal(r.quantidade, 288000);
    const muc = obterMuc(mockDb);
    const pipe = muc.converter({
      quantidadeCompra: 12,
      unidadeCompra: 'CAIXA',
      quantidadePorApresentacao: 12,
      produto: { unidade: 'ML' },
      relacoes: [{ de: 'UN', para: 'ML', fator: 2000 }],
      item: {
        quantidade_embalagens: 12,
        quantidade_por_embalagem: 12,
        valor_total_embalagem: 0,
        unidade_comercial: 'CAIXA',
        compra_em: 'CX'
      }
    });
    assert.equal(pipe.quantidadeEstoque, 288000);
    assert.notEqual(pipe.quantidadeEstoque, 144);
    assert.notEqual(pipe.quantidadeEstoque, 24000);
    assert.notEqual(pipe.quantidadeEstoque, 12);
  });

  it('T10 — Água 10 FARDO → 42.000 ML', () => {
    const r = converterQuantidade({
      quantidade: 10,
      unidadeOrigem: 'FARDO',
      unidadeDestino: 'ML',
      relacoes: REL_AGUA
    });
    assert.equal(r.quantidade, 42000);
  });

  it('T11 — conversão inversa', () => {
    assert.equal(converterQuantidade({ quantidade: 2000, unidadeOrigem: 'ML', unidadeDestino: 'L' }).quantidade, 2);
    assert.equal(converterQuantidade({ quantidade: 1, unidadeOrigem: 'KG', unidadeDestino: 'G' }).quantidade, 1000);
    const ida = converterQuantidade({
      quantidade: 1,
      unidadeOrigem: 'CAIXA',
      unidadeDestino: 'ML',
      relacoes: REL_COCA
    });
    const volta = converterQuantidade({
      quantidade: ida.quantidade,
      unidadeOrigem: 'ML',
      unidadeDestino: 'CAIXA',
      relacoes: REL_COCA
    });
    assert.equal(volta.quantidade, 1);
  });

  it('T12 — família incompatível', () => {
    assert.throws(
      () => converterQuantidade({ quantidade: 1, unidadeOrigem: 'KG', unidadeDestino: 'L' }),
      (e) => e.code === CODIGOS.CONVERSAO_INVALIDA
    );
  });

  it('T13 — caminho inexistente', () => {
    assert.throws(
      () => converterQuantidade({ quantidade: 1, unidadeOrigem: 'CAIXA', unidadeDestino: 'KG' }),
      (e) => e.code === CODIGOS.CONVERSAO_NAO_DISPONIVEL
    );
  });

  it('T14 — ciclo', () => {
    assert.throws(
      () => converterQuantidade({
        quantidade: 1,
        unidadeOrigem: 'CAIXA',
        unidadeDestino: 'UN',
        relacoes: [
          { de: 'CAIXA', para: 'UN', fator: 12 },
          { de: 'UN', para: 'CAIXA', fator: 12 }
        ]
      }),
      (e) => e.code === CODIGOS.CONVERSAO_CICLO
    );
  });

  it('T15 — precisão decimal', () => {
    assert.equal(converterQuantidade({ quantidade: 0.333, unidadeOrigem: 'KG', unidadeDestino: 'G' }).quantidade, 333);
    assert.equal(converterQuantidade({ quantidade: 37.5, unidadeOrigem: 'G', unidadeDestino: 'KG' }).quantidade, 0.0375);
  });

  it('T16 — sem arredondamento intermediário indevido', () => {
    const g = converterQuantidade({ quantidade: 1 / 3, unidadeOrigem: 'KG', unidadeDestino: 'G' });
    const kg = converterQuantidade({ quantidade: g.quantidade * 3, unidadeOrigem: 'G', unidadeDestino: 'KG' });
    assert.ok(Math.abs(kg.quantidade - 1) < 1e-9);
  });

  it('T17 — MUC não altera estoque', () => {
    const core = src('backend/motores/muc/core/MotorConversaoQuantidade.js');
    assert.doesNotMatch(core, /INSERT INTO|estoque_empresa|creditarEstoque|empresa_id/);
  });

  it('T18 — MUC não recebe empresa_id', () => {
    const r = converterQuantidade({
      quantidade: 2,
      unidadeOrigem: 'UN',
      unidadeDestino: 'UN',
      empresa_id: 99
    });
    assert.equal(r.quantidade, 2);
    assert.equal(typeof converterQuantidade, 'function');
    assert.doesNotMatch(src('backend/motores/muc/core/MotorConversaoQuantidade.js'), /empresa_id/);
  });

  it('T19 — Compra utiliza resultado do MUC', () => {
    const compras = src('backend/rotas/compras.js');
    assert.match(compras, /resultadoMuc\.quantidadeEstoque/);
    assert.match(compras, /obterMuc/);
    assert.doesNotMatch(compras, /motores\/muc\/core\//);
  });

  it('T20 — Ficha utiliza resultado do MUC', () => {
    const cons = src('backend/services/produtos/FichaTecnicaConsumoService.js');
    assert.match(cons, /obterMuc\(db\)\.converterQuantidade/);
    const r = converterQuantidade({ quantidade: 300, unidadeOrigem: 'ML', unidadeDestino: 'L' });
    assert.equal(r.quantidade, 0.3);
  });

  it('T21 — snapshot continua íntegro', () => {
    const schema = src('backend/services/produtos/vendaFichaConsumoSchema.js');
    assert.match(schema, /quantidade REAL NOT NULL/);
    assert.match(schema, /unidade TEXT NOT NULL/);
    assert.match(schema, /quantidade_ficha REAL NOT NULL/);
    assert.match(schema, /unidade_ficha TEXT NOT NULL/);
  });

  it('T22 — cancelamento não reconverte', () => {
    const cons = src('backend/services/produtos/FichaTecnicaConsumoService.js');
    const trecho = cons.slice(cons.indexOf('estornarConsumoFichaTecnicaDaVenda'));
    assert.doesNotMatch(trecho.slice(0, 4000), /converterQuantidade\(/);
  });

  it('T23 — devolução não reconverte', () => {
    const cons = src('backend/services/produtos/FichaTecnicaConsumoService.js');
    const trecho = cons.slice(cons.indexOf('estornarConsumoFichaTecnicaDaDevolucao'));
    assert.doesNotMatch(trecho.slice(0, 4500), /converterQuantidade\(/);
  });

  it('T24 — Empresa A e B não misturam (mesma definição, quantidades distintas)', () => {
    const a = converterQuantidade({
      quantidade: 12,
      unidadeOrigem: 'CAIXA',
      unidadeDestino: 'ML',
      relacoes: REL_COCA
    });
    const b = converterQuantidade({
      quantidade: 6,
      unidadeOrigem: 'CAIXA',
      unidadeDestino: 'ML',
      relacoes: REL_COCA
    });
    assert.equal(a.quantidade, 288000);
    assert.equal(b.quantidade, 144000);
    assert.notEqual(a.quantidade + b.quantidade, a.quantidade);
  });

  it('T25 — contrato RC2.1 permanece funcional', () => {
    const muc = obterMuc(mockDb);
    const r = muc.converter({
      produtoId: 1,
      item: {
        quantidade_embalagens: 10,
        quantidade_por_embalagem: 12,
        valor_total_embalagem: 400,
        unidade_comercial: 'CAIXA',
        compra_em: 'CX'
      },
      origem: 'MANUAL'
    });
    assert.equal(r.quantidadeEstoque, 120);
    assert.equal(r.fatorConversao, 12);
    assert.equal(typeof muc.simular, 'function');
    assert.equal(typeof muc.processarItemCompra, 'function');
    assert.equal(muc.obterVersao().VERSAO, 'RC3.0');
  });
});
