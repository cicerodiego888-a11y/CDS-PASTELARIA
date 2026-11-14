/**
 * CDS-PDV-VALOR-PASTEIS-02 — integração UI no PDV Express.
 * Sem banco oficial / SEFAZ / vendas reais.
 * Executar: node --test tests/pdv/cds-pdv-valor-pasteis-02.test.js
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, it } = require('node:test');

const ROOT = path.join(__dirname, '../..');
const htmlPath = path.join(ROOT, 'frontend/pdv/pages/pdv.html');
const indexPath = path.join(ROOT, 'frontend/pdv/index.html');
const jsPath = path.join(ROOT, 'frontend/pdv/js/pdv-venda-por-valor.js');
const pdvJsPath = path.join(ROOT, 'frontend/pdv/js/pdv.js');
const erpPedidosPath = path.join(ROOT, 'frontend/erp/js/pedidos.js');
const servicePath = path.join(ROOT, 'backend/services/vendas/VendaPorValorPasteisService.js');
const rotaPath = path.join(ROOT, 'backend/rotas/pedidos.js');

function carregarModuloUi() {
  const code = fs.readFileSync(jsPath, 'utf8');
  const sandbox = {
    window: {},
    globalThis: {},
    console,
    setTimeout,
    clearTimeout
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.document = {
    getElementById: () => null,
    createElement: () => ({ appendChild() {} }),
    body: { appendChild() {} }
  };
  sandbox.localStorage = { getItem: () => '' };
  sandbox.sessionStorage = {
    _d: {},
    setItem(k, v) { this._d[k] = String(v); },
    getItem(k) { return this._d[k] || null; },
    removeItem(k) { delete this._d[k]; }
  };
  sandbox.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  vm.runInNewContext(code, sandbox, { filename: 'pdv-venda-por-valor.js' });
  return sandbox.PdvVendaPorValor;
}

describe('CDS-PDV-VALOR-PASTEIS-02', { concurrency: false }, () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const indexHtml = fs.readFileSync(indexPath, 'utf8');
  const jsSrc = fs.readFileSync(jsPath, 'utf8');
  const pdvSrc = fs.readFileSync(pdvJsPath, 'utf8');
  const ui = carregarModuloUi();

  it('1) botão VENDA POR VALOR existe na tela principal do PDV Express', () => {
    assert.match(html, /id="btnVendaPorValorPdv"/);
    assert.match(html, /id="btnVendaPorValorPdvTopo"/);
    assert.match(html, /VENDA POR VALOR/);
    assert.match(html, /atalhoVendaPorValorPdv/);
    assert.match(indexHtml, /pdv-venda-por-valor\.js/);
    assert.match(pdvSrc, /PdvVendaPorValor\.initUi/);
    // Destaque: acima de Finalizar no resumo
    const iValor = html.indexOf('btnVendaPorValorPdv');
    const iFin = html.indexOf('btnFinalizarVendaPdv');
    assert.ok(iValor > 0 && iFin > iValor, 'VENDA POR VALOR deve aparecer antes de FINALIZAR no HTML');
  });

  it('2) valores válidos são montados para o endpoint existente', () => {
    assert.equal(ui.ENDPOINT, '/pedidos/venda-por-valor-pasteis');
    assert.match(jsSrc, /\/pedidos\/venda-por-valor-pasteis/);
    assert.match(jsSrc, /valor_total/);
    assert.match(jsSrc, /quantidade_pasteis/);
    const v = ui.validarEntrada('50,00', '3');
    assert.equal(v.ok, true);
    assert.equal(v.valor, 50);
    assert.equal(v.quantidade, 3);
  });

  it('3) valores inválidos são rejeitados (vírgula BR / qtd)', () => {
    assert.equal(ui.validarEntrada('', '1').ok, false);
    assert.equal(ui.validarEntrada('0', '1').ok, false);
    assert.equal(ui.validarEntrada('-10', '1').ok, false);
    assert.equal(ui.validarEntrada('10,00', '0').ok, false);
    assert.equal(ui.validarEntrada('10,00', '1.5').ok, false);
    assert.equal(ui.validarEntrada('10,00', 'abc').ok, false);
    assert.equal(ui.parseValorMonetarioBr('1.234,56'), 1234.56);
    assert.equal(ui.parseValorMonetarioBr('10,5'), 10.5);
  });

  it('4) duplo envio bloqueado enquanto processa', () => {
    assert.match(jsSrc, /emProcessamento/);
    assert.match(jsSrc, /if \(emProcessamento\) return/);
    assert.match(jsSrc, /Processando/);
    assert.match(jsSrc, /btn\.disabled = emProcessamento/);
  });

  it('5) composição é apresentada para conferência', () => {
    assert.match(jsSrc, /MODAL_CONF_ID|pdvVendaPorValorConfModal/);
    assert.match(jsSrc, /abrirModalConferencia/);
    assert.match(jsSrc, /Conferência/);
    assert.match(jsSrc, /formatarMoeda\(data\.total\)/);
  });

  it('6) cancelamento não finaliza a venda', () => {
    assert.match(jsSrc, /onCancelarConferencia/);
    assert.match(jsSrc, /não foi carregado no caixa|não finaliza/i);
    assert.ok(!/finalizar-venda-pdv/.test(jsSrc));
    assert.ok(!/POST.*\/vendas/.test(jsSrc));
  });

  it('7) confirmação encaminha pelo handoff oficial do PDV', () => {
    assert.match(jsSrc, /sessionStorage\.setItem\('pdvPedidoHandoff'/);
    assert.match(jsSrc, /aplicarHandoffPedidoPdv/);
    assert.match(pdvSrc, /window\.aplicarHandoffPedidoPdv\s*=\s*aplicarHandoffPedidoPdv/);
  });

  it('8) erros recuperáveis não apagam campos no fluxo (preservação)', () => {
    // Em erro, não há limpeza de #pdvVvValor / #pdvVvQtd
    assert.ok(!/pdvVvValor\)\.value\s*=\s*''/.test(jsSrc));
    assert.ok(!/getElementById\('pdvVvValor'\)[\s\S]{0,40}\.value\s*=\s*['"]{2}/.test(jsSrc));
    assert.match(jsSrc, /exibirErroEntrada/);
  });

  it('9) interface não altera empresa proprietária do pedido', () => {
    assert.match(jsSrc, /Não altera empresa_id/);
    assert.ok(!/['"]X-Empresa-Id['"]/.test(jsSrc));
    const corpoMatch = jsSrc.match(/const corpo = \{[\s\S]*?\};/);
    assert.ok(corpoMatch);
    assert.ok(!/empresa_id/.test(corpoMatch[0]));
    assert.ok(!/empresaId\s*:/.test(corpoMatch[0]));
  });

  it('10) fluxos normais do PDV e serviço 01 preservados (contrato)', () => {
    assert.match(pdvSrc, /btnFinalizarVendaPdv/);
    assert.match(pdvSrc, /abrirTelaPagamento/);
    assert.match(pdvSrc, /aplicarHandoffPedidoPdv/);
    const svc = fs.readFileSync(servicePath, 'utf8');
    const rota = fs.readFileSync(rotaPath, 'utf8');
    const erp = fs.readFileSync(erpPedidosPath, 'utf8');
    assert.match(svc, /iniciarVendaPorValorPasteis/);
    assert.match(rota, /venda-por-valor-pasteis/);
    assert.doesNotMatch(erp, /btnPedVendaValor|Venda por valor/);
    // Motor de composição não redesenhado nesta sprint
    assert.ok(!jsSrc.includes('PedidoPdvComposicaoService'));
    assert.ok(!jsSrc.includes('VendaApplicationService'));
  });
});
