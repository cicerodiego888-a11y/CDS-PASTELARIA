/**
 * PDV-MULTIEMPRESA-12 — Mensagem de capacidade legível (sem deformar lista).
 * Executar: node --test tests/pdv/pdv-multiempresa-12-mensagem-capacidade-ui.test.js
 */
'use strict';

const { describe, it } = require('node:test');
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
  console: { warn() {}, log() {} },
  document: {
    getElementById() { return null; },
    querySelector() { return null; },
    createElement(tag) {
      return {
        tagName: String(tag).toUpperCase(),
        id: '',
        className: '',
        style: {},
        textContent: '',
        title: '',
        parentElement: null,
        parentNode: null,
        setAttribute() {},
        remove() {},
        insertAdjacentElement() {}
      };
    },
    body: { prepend() {}, tagName: 'BODY' }
  }
};
vm.runInNewContext(
  `${extrairFn('resumirMensagemSelecaoEmpresaPdv')}\n` +
  `${extrairFn('registrarDiagnosticoSelecaoEmpresaPdv')}\n` +
  `module = { exports: { resumirMensagemSelecaoEmpresaPdv, registrarDiagnosticoSelecaoEmpresaPdv } };`,
  Object.assign(sandbox, { module: { exports: {} } })
);
const {
  resumirMensagemSelecaoEmpresaPdv
} = sandbox.module.exports;

describe('PDV-MULTIEMPRESA-12 mensagem capacidade UI', () => {
  it('não ancora banner dentro da tabela (tbody)', () => {
    assert.match(pdvSrc, /pdv-itens-scroll/);
    assert.match(pdvSrc, /Corrige banner legado inserido dentro de <table>/);
    assert.doesNotMatch(
      pdvSrc,
      /getElementById\('tabelaItensVendaPdv'\)\s*\n\s*\|\|/
    );
  });

  it('409 com gargalos → mensagem curta sem lista técnica', () => {
    const bruto =
      'Nenhuma empresa consegue atender integralmente ao pedido. A venda não será dividida entre CNPJs. '
      + 'Gargalos: produto 748, necessário 4, disponível 0, ESTOQUE_INSUFICIENTE_NAO_FISCAL; '
      + 'produto 747, insumo 752, necessário 4, disponível 0, INSUMO_INSUFICIENTE.';
    const curta = resumirMensagemSelecaoEmpresaPdv({
      code: 'NENHUMA_EMPRESA_ATENDE',
      mensagem: bruto
    });
    assert.ok(curta.length < 120);
    assert.doesNotMatch(curta, /Gargalos:/i);
    assert.doesNotMatch(curta, /ESTOQUE_INSUFICIENTE/);
    assert.doesNotMatch(curta, /INSUMO_INSUFICIENTE/);
    assert.doesNotMatch(curta, /produto 748/);
    assert.match(curta, /Estoque insuficiente/i);
  });

  it('vários códigos mapeados sem texto técnico', () => {
    assert.match(
      resumirMensagemSelecaoEmpresaPdv({ code: 'CAIXA_INCOMPATIVEL', mensagem: 'x' }),
      /Caixa incompatível/i
    );
    assert.match(
      resumirMensagemSelecaoEmpresaPdv({ code: 'MATRIZ_AUSENTE', mensagem: 'x' }),
      /empresas/i
    );
  });

  it('sucesso limpa bloqueio: render usa estado sem bloqueio (contrato no fonte)', () => {
    assert.match(pdvSrc, /selecaoEmpresaPdvSnapshot = \{/);
    assert.match(pdvSrc, /Empresa da venda: #\$\{emp\}/);
    assert.match(pdvSrc, /registrarDiagnosticoSelecaoEmpresaPdv/);
  });

  it('notificação ao operador usa resumo, não gargalos', () => {
    assert.match(pdvSrc, /showNotification\(resumirMensagemSelecaoEmpresaPdv\(estadoBloqueio\)/);
  });

  it('lista de itens continua em atualizarCarrinho → renderCarrinhoItens', () => {
    assert.match(pdvSrc, /function atualizarCarrinho\(\)/);
    assert.match(pdvSrc, /tbody\.html\(renderCarrinhoItens\(\)\)/);
    assert.match(pdvSrc, /agendarAtualizacaoSelecaoEmpresaPdv\(\)/);
  });
});
