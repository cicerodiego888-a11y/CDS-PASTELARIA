/**
 * MUC-01 — Auditoria conceitual do Motor Universal de Conversão.
 * Não altera o MUC. Lacunas são assertivas do comportamento atual.
 * Executar: node tests/muc/auditoria-muc-01.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const MotorUM = require('../../backend/services/unidades/MotorUnidadesMedida');
const MotorConversao = require('../../backend/motores/muc/core/MotorConversao');
const { obterMuc } = require('../../backend/motores/muc/public');
const FichaTecnicaService = require('../../backend/services/produtos/FichaTecnicaService');

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function qtd(quantidade, unidadeOrigem, unidadeDestino) {
  return obterMuc({ run() {}, all() {}, get() {} }).converterQuantidade({
    quantidade,
    unidadeOrigem,
    unidadeDestino
  }).quantidade;
}

describe('MUC-01 auditoria conceitual', () => {
  it('T01 — unidade simples (mesma unidade, identidade)', () => {
    assert.equal(qtd(5, 'UN', 'UN'), 5);
    assert.equal(qtd(80, 'G', 'G'), 80);
  });

  it('T02 — kg → g (MUC / SI)', () => {
    assert.equal(qtd(1, 'KG', 'G'), 1000);
    assert.equal(qtd(0.08, 'KG', 'G'), 80);
  });

  it('T03 — L → ml (MUC / SI)', () => {
    assert.equal(qtd(2, 'L', 'ML'), 2000);
    assert.equal(qtd(0.35, 'L', 'ML'), 350);
  });

  it('T04 — embalagem → unidade (MUC simulador: 1 × 12 = 12)', () => {
    const r = MotorConversao.simularConversao({
      quantidadeCompra: 1,
      quantidadePorApresentacao: 12,
      valorTotal: 0
    });
    assert.equal(r.quantidadeEstoque, 12);
    assert.equal(r.fatorConversao, 12);
    assert.equal(r.tipoConversao, 'MULTIPLICADOR');
  });

  it('T05 — LACUNA: MUC não encadeia CAIXA → UN → ML numa única chamada', () => {
    const dozeCaixasDeDozeUn = MotorConversao.simularConversao({
      quantidadeCompra: 12,
      quantidadePorApresentacao: 12,
      valorTotal: 0
    });
    assert.equal(dozeCaixasDeDozeUn.quantidadeEstoque, 144);
    assert.notEqual(
      dozeCaixasDeDozeUn.quantidadeEstoque,
      24000,
      '12 CX × 12 UN não vira 24.000 ml sozinho — falta 2ª relação UN→ml'
    );
    const unParaMl = qtd(1, 'UN', 'UN');
    assert.equal(unParaMl, 1);
    assert.throws(
      () => qtd(1, 'UN', 'ML'),
      (e) => e.code === 'CONVERSAO_INVALIDA'
    );
  });

  it('T06 — precisão decimal MUC (contrato de saída)', () => {
    assert.equal(qtd(0.333, 'KG', 'G'), 333);
    assert.equal(qtd(1.5, 'L', 'ML'), 1500);
    assert.equal(qtd(125, 'ML', 'L'), 0.125);
    assert.equal(qtd(37.5, 'G', 'KG'), 0.0375);
  });

  it('T07 — ficha: cadastro valida MotorUM; conversão oficial via obterMuc', () => {
    const ficha = src('backend/services/produtos/FichaTecnicaService.js');
    assert.match(ficha, /validarUnidadeFicha/);
    assert.match(ficha, /MotorUM\.isUnidadeComercialConhecida/);
    assert.match(ficha, /obterMuc/);
    assert.match(ficha, /converterQuantidade/);
    assert.equal(typeof FichaTecnicaService.converterQuantidadeFicha, 'function');
    assert.doesNotMatch(ficha, /converterQuantidadeEntreUnidades/);
    const salvarBloco = ficha.slice(ficha.indexOf('async function salvar'));
    assert.doesNotMatch(salvarBloco.slice(0, 2500), /converterQuantidadeFicha\(/);
  });

  it('T08 — consumo da ficha usa MUC.converterQuantidade', () => {
    const cons = src('backend/services/produtos/FichaTecnicaConsumoService.js');
    assert.match(cons, /obterMuc\(db\)\.converterQuantidade/);
    assert.doesNotMatch(cons, /MotorUM\.converterQuantidadeEntreUnidades/);
    const qtdMl = qtd(300, 'ML', 'L');
    assert.equal(qtdMl, 0.3);
  });

  it('T09 — estorno usa snapshot (quantidade já convertida), não relê ficha/MUC', () => {
    const cons = src('backend/services/produtos/FichaTecnicaConsumoService.js');
    assert.match(cons, /venda_ficha_consumo_itens/);
    assert.match(cons, /estornarConsumoFichaTecnicaDaVenda/);
    assert.match(cons, /estornarConsumoFichaTecnicaDaDevolucao/);
    const trechoEstorno = cons.slice(cons.indexOf('estornarConsumoFichaTecnicaDaVenda'));
    assert.doesNotMatch(trechoEstorno.slice(0, 3500), /converterQuantidadeEntreUnidades/);
  });

  it('T10 — definição de conversão é do produto; estoque é por empresa (sem empresa no MUC)', () => {
    const mucIdx = src('backend/motores/muc/index.js');
    const um = src('backend/services/unidades/MotorUnidadesMedida.js');
    const cons = src('backend/services/produtos/FichaTecnicaConsumoService.js');
    assert.doesNotMatch(um, /empresa_id/);
    assert.match(cons, /exigirEmpresa: true/);
    assert.match(mucIdx, /processarItemCompra/);
    assert.doesNotMatch(mucIdx.slice(mucIdx.indexOf('converter(input'), mucIdx.indexOf('converter(input') + 400), /empresa_id/);
  });

  it('T11 — ausência de conversão SI: mesma unidade não inventa fator; UN permanece UN', () => {
    assert.equal(MotorUM.normalizarUnidadeComercial(''), 'UN');
    assert.equal(qtd(12, 'UN', 'UN'), 12);
  });

  it('T12 — conversão inválida é rejeitada', () => {
    assert.throws(
      () => qtd(1, 'KG', 'L'),
      (e) => e.code === 'CONVERSAO_INVALIDA'
    );
    assert.throws(
      () => qtd(0, 'KG', 'G'),
      (e) => e.code === 'CONVERSAO_INVALIDA'
    );
    assert.throws(
      () => qtd(1, 'XYZ', 'KG'),
      (e) => e.code === 'CONVERSAO_INVALIDA'
    );
  });

  it('T00 — MUC facade; quantidade oficial no MUC; legado só custo/F-NF', () => {
    const muc = obterMuc({ run() {}, all() {}, get() {} });
    assert.equal(typeof muc.converter, 'function');
    assert.equal(typeof muc.converterQuantidade, 'function');
    assert.equal(typeof muc.processarItemCompra, 'function');
    const calc = src('backend/motores/muc/core/MotorConversaoCalculo.js');
    assert.match(calc, /converterQuantidade/);
    assert.match(calc, /lib\/motorConversaoUnidades/);
  });
});
