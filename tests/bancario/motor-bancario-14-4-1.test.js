/**
 * Sprint MBC-14.4.1 — redesign UX/UI da integração bancária.
 * Executar: node --test tests/bancario/motor-bancario-14-4-1.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const VERSAO = require('../../backend/motores/bancario/version');

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('MBC-14.4.1 UX integração', () => {
  it('T01 — Integração bancária é o conceito principal', () => {
    const html = src('frontend/erp/pages/contas-bancarias.html');
    assert.match(html, /Integração bancária/);
    assert.match(html, /data-mbc-tab="config"/);
    assert.match(html, /data-mbc-tab="auth"/);
    assert.match(html, /data-mbc-tab="operacao"/);
    assert.doesNotMatch(html, /<h3>\s*Mercado Pago\s*<\/h3>/);
  });

  it('T02 — provider genérico e MOCK em avançado', () => {
    const html = src('frontend/erp/pages/contas-bancarias.html');
    assert.match(html, /id="mbcIntProvider"/);
    assert.match(html, /Mercado Pago/);
    assert.match(html, /Avançado \/ Homologação interna/);
    assert.match(html, /id="mbcCfgCriar"/);
    assert.match(html, /id="mbcOfCfgCriar"/);
  });

  it('T03 — credenciais, voltar e status', () => {
    const html = src('frontend/erp/pages/contas-bancarias.html');
    const js = src('frontend/erp/js/contas-bancarias.js');
    assert.match(html, /id="mbcMpSecret"[^>]*type="password"/);
    assert.match(html, /id="mbcIntVoltar"/);
    assert.match(html, /id="mbcCfgEmpresaMeta"/);
    assert.match(js, /fecharPainelIntegracao/);
    assert.match(js, /selecionarAbaIntegracao/);
    assert.match(js, /btn-primary"[^>]*data-mbc-integracao|data-mbc-integracao[^>]*>Integração/);
    assert.match(js, /Credenciais configuradas/);
    assert.doesNotMatch(js, /Conectado ao banco/);
  });

  it('T04 — operação e autorização preservadas', () => {
    const html = src('frontend/erp/pages/contas-bancarias.html');
    assert.match(html, /Sincronizar agora/);
    assert.match(html, /Extrato bancário/);
    assert.match(html, /Saldo conceitual|Saldo real/);
    assert.match(html, /Autorizar acesso/);
    assert.match(html, /Open Finance/);
  });

  it('T05 — sprint e relatório', () => {
    assert.ok(String(VERSAO.SPRINT).startsWith('MBC-'));
    assert.ok(fs.existsSync(path.join(ROOT, 'docs/bancario/MBC-14.4.1-RELATORIO.md')));
  });

  it('T06 — sem secret no frontend JS', () => {
    const js = src('frontend/erp/js/contas-bancarias.js');
    assert.equal(/access_token|client_secret/.test(js), false);
    assert.equal(js.includes('CLOUDFLARE'), false);
  });
});
