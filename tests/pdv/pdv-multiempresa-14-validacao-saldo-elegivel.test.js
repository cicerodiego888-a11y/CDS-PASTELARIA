/**
 * PDV-MULTIEMPRESA-14 — Alinhamento validarEstoqueVenda ao saldo elegível.
 * Executar: node --test tests/pdv/pdv-multiempresa-14-validacao-saldo-elegivel.test.js
 */
'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pdvPath = path.join(__dirname, '../../frontend/pdv/js/pdv.js');
const pdvSrc = fs.readFileSync(pdvPath, 'utf8');

function extrairFn(nome) {
  const re = new RegExp(`function ${nome}\\([\\s\\S]*?\\n\\}`);
  const m = pdvSrc.match(re);
  assert.ok(m, `função ${nome} deve existir`);
  return m[0];
}

const sandbox = {
  console,
  localStorage: {
    _d: Object.create(null),
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; }
  },
  produtosDisponiveis: [],
  pdvEmitirFiscalNaVenda: null,
  showNotification() {}
};

const bundle = [
  'let pdvEmitirFiscalNaVenda = null;',
  'let produtosDisponiveis = [];',
  extrairFn('pdvModoFiscalAtivo'),
  extrairFn('pdvOperacaoVendaFiscal'),
  extrairFn('pdvProdutoUsaFichaTecnica'),
  extrairFn('pdvResolverSaldosProduto'),
  extrairFn('pdvSaldoElegivelOperacao'),
  extrairFn('produtoControlaEstoquePdv'),
  extrairFn('validarEstoqueVenda'),
  extrairFn('pdvValidarEstoqueVenda'),
  extrairFn('pdvEstoqueDisponivel'),
  extrairFn('pdvRotuloEstoque'),
  `module.exports = {
    setEmitir(v) { pdvEmitirFiscalNaVenda = v; },
    setModoFiscal(on) { localStorage.setItem('pdv_modo_fiscal_ativo', on ? '1' : '0'); },
    pdvOperacaoVendaFiscal,
    pdvProdutoUsaFichaTecnica,
    pdvSaldoElegivelOperacao,
    validarEstoqueVenda,
    pdvValidarEstoqueVenda,
    pdvEstoqueDisponivel,
    pdvRotuloEstoque
  };`
].join('\n');

vm.runInNewContext(bundle, Object.assign(sandbox, { module: { exports: {} }, localStorage: sandbox.localStorage }));
const api = sandbox.module.exports;

describe('PDV-MULTIEMPRESA-14 validação saldo elegível', () => {
  beforeEach(() => {
    api.setEmitir(null);
    api.setModoFiscal(false);
  });

  it('venda não fiscal + saldo só fiscal → bloqueia e não mostra total como elegível', () => {
    api.setModoFiscal(false);
    const produto = {
      id: 748,
      nome: 'Refrigerante Copo 300 ml',
      controla_estoque: 1,
      saldo_fiscal: 20,
      saldo_nao_fiscal: 0,
      estoque_atual: 20
    };
    const r = api.pdvValidarEstoqueVenda(produto, 1);
    assert.equal(r.sucesso, false);
    assert.equal(r.disponivelElegivel, 0);
    assert.equal(r.bucket, 'NAO_FISCAL');
    assert.match(r.mensagem, /Disponível \(não fiscal\): 0/);
    assert.match(r.mensagem, /não elegível nesta operação/);
    assert.doesNotMatch(r.mensagem, /Disponível: 20/);
    assert.equal(api.pdvEstoqueDisponivel(produto), 0);
    assert.match(api.pdvRotuloEstoque(produto), /não fiscal/);
  });

  it('venda não fiscal + saldo NF suficiente → permite', () => {
    api.setModoFiscal(false);
    const produto = {
      id: 1,
      controla_estoque: 1,
      saldo_fiscal: 0,
      saldo_nao_fiscal: 5,
      estoque_atual: 5
    };
    const r = api.pdvValidarEstoqueVenda(produto, 2);
    assert.equal(r.sucesso, true);
    assert.equal(r.disponivelElegivel, 5);
    assert.equal(api.pdvEstoqueDisponivel(produto), 5);
  });

  it('venda fiscal + saldo só não fiscal → bloqueia com elegível fiscal 0', () => {
    api.setModoFiscal(true);
    const produto = {
      id: 2,
      controla_estoque: 1,
      saldo_fiscal: 0,
      saldo_nao_fiscal: 15,
      estoque_atual: 15
    };
    const r = api.pdvValidarEstoqueVenda(produto, 1);
    assert.equal(r.sucesso, false);
    assert.equal(r.disponivelElegivel, 0);
    assert.equal(r.bucket, 'FISCAL');
    assert.match(r.mensagem, /Disponível \(fiscal\): 0/);
    assert.match(r.mensagem, /Saldo não fiscal: 15/);
    assert.equal(api.pdvEstoqueDisponivel(produto), 0);
  });

  it('produto com ficha → não bloqueia no acabado; rótulo não usa total como elegível', () => {
    api.setModoFiscal(false);
    const produto = {
      id: 747,
      controla_estoque: 1,
      utiliza_ficha_tecnica: 1,
      saldo_fiscal: 100,
      saldo_nao_fiscal: 100,
      estoque_atual: 200
    };
    const r = api.pdvValidarEstoqueVenda(produto, 50);
    assert.equal(r.sucesso, true);
    assert.equal(r.diferidoSeletor, true);
    assert.equal(api.pdvEstoqueDisponivel(produto), null);
    assert.match(api.pdvRotuloEstoque(produto), /ficha técnica/i);
    assert.doesNotMatch(api.pdvRotuloEstoque(produto), /Total: 200/);
  });

  it('pdvOperacaoVendaFiscal alinha emitir explícito e modo F12', () => {
    api.setEmitir(null);
    api.setModoFiscal(true);
    assert.equal(api.pdvOperacaoVendaFiscal(), true);
    api.setEmitir(false);
    assert.equal(api.pdvOperacaoVendaFiscal(), false);
    api.setEmitir(true);
    api.setModoFiscal(false);
    assert.equal(api.pdvOperacaoVendaFiscal(), true);
  });

  it('preview selecao-empresa usa pdvOperacaoVendaFiscal (fonte)', () => {
    assert.match(pdvSrc, /const emitir = pdvOperacaoVendaFiscal\(\)/);
    assert.match(pdvSrc, /emitir_fiscal: emitir/);
    assert.match(pdvSrc, /venda_fiscal: emitir/);
  });

  it('não apresenta estoque_atual/total como disponível elegível na validação', () => {
    assert.match(pdvSrc, /Disponível \(\$\{rotuloBucket\}\)/);
    assert.match(pdvSrc, /não elegível nesta operação/);
    assert.doesNotMatch(
      pdvSrc,
      /if \(quantidade > saldoTotal\)[\s\S]{0,80}Disponível: \$\{saldoTotal\}/
    );
  });
});
