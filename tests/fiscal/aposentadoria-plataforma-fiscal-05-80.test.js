/**
 * Sprint 05.80 — Aposentadoria da aba Plataforma Fiscal (somente UI).
 * Executar: node tests/fiscal/aposentadoria-plataforma-fiscal-05-80.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const centro = src('frontend/erp/js/cds-centro-configuracoes.js');
const empresasUi = src('frontend/erp/js/gestao-empresas-fiscal.js');
const fiscalJs = src('frontend/erp/js/fiscal.js');
const fiscalRotas = src('backend/rotas/fiscal.js');
const empresasRotas = src('backend/rotas/empresas.js');
const centralJs = src('frontend/erp/js/central-entradas.js');
const pdvJs = src('frontend/pdv/js/pdv.js');
const indexHtml = src('frontend/erp/index.html');
const coreJs = src('frontend/shared/js/core.js');
const congelado = src('docs/arquitetura/PDV_UNIVERSAL_CONGELADO.md');

describe('05.80 — aposentadoria Plataforma Fiscal', () => {
  it('T01 — aba Plataforma Fiscal não aparece no Centro', () => {
    assert.doesNotMatch(centro, /id:\s*'plataformaFiscal'/);
    assert.doesNotMatch(centro, /label:\s*'Plataforma Fiscal'/);
    assert.doesNotMatch(centro, /data-cfg-pane="plataformaFiscal"/);
    assert.doesNotMatch(centro, /Abrir Plataforma Fiscal/);
  });

  it('T02 — aba Empresas continua no Centro', () => {
    assert.match(centro, /id:\s*'empresa'/);
    assert.match(centro, /label:\s*'Empresa'/);
    assert.match(centro, /btnAbrirGestaoEmpresas/);
    assert.match(centro, /loadPage\('empresas'\)/);
  });

  it('T02b — configuracoes.js não declara $form duas vezes', () => {
    const cfg = src('frontend/erp/js/configuracoes.js');
    const fn = cfg.slice(cfg.indexOf('function carregarConfigFiscalAvancadas'), cfg.indexOf('function configurarFormConfigAvancadas'));
    const decls = fn.match(/const \$form/g) || [];
    assert.equal(decls.length, 1);
  });

  it('T03 — tela Empresas continua abrindo', () => {
    assert.match(src('frontend/erp/js/app.js'), /empresas:\s*\[/);
    assert.match(empresasUi, /function loadGestaoEmpresasFiscal/);
  });

  it('T04 — Configuração Fiscal por empresa continua disponível', () => {
    assert.match(empresasUi, /CONFIGURAÇÃO FISCAL/);
    assert.match(empresasUi, /data-gef-tab="fiscal"/);
    assert.match(empresasRotas, /\/:empresaId\/configuracao-fiscal/);
  });

  it('T05 — Certificado Digital por empresa continua disponível', () => {
    assert.match(empresasUi, /CERTIFICADO DIGITAL/);
    assert.match(empresasUi, /data-gef-tab="cert"/);
    assert.match(fiscalRotas, /\/certificado\/upload/);
  });

  it('T06 — rotas globais /api/fiscal/config preservadas', () => {
    assert.match(fiscalRotas, /router\.get\('\/config'/);
    assert.match(fiscalRotas, /router\.put\('\/config'/);
  });

  it('T07 — NFC-e continua disponível', () => {
    assert.match(fiscalJs, /function loadFiscal\s*\(/);
    assert.match(fiscalJs, /Emitir NFC-e/);
    assert.match(fiscalJs, /cancelarNfce/);
    assert.match(indexHtml, /data-page="fiscal"/);
    assert.match(coreJs, /titulo:\s*'NFC-e Emitidas'/);
  });

  it('T08 — Nova Central não foi quebrada nesta sprint', () => {
    assert.match(centralJs, /headers\['X-Empresa-Id'\]/);
    assert.match(centralJs, /vistaEmpresas/);
    assert.match(centralJs, /escopo', 'todas'|escopo=todas/);
    assert.match(centralJs, /loadPage\('configuracoes-avancadas'\)/);
  });

  it('T09 — PDV Normal não foi alvo desta sprint', () => {
    assert.match(pdvJs, /configuracoes-avancadas\/confirmacao-fiscal/);
    assert.doesNotMatch(centro, /frontend\/pdv/);
  });

  it('T10 — PDV Universal continua congelado', () => {
    assert.match(congelado, /STATUS:/);
    assert.match(congelado, /CONGELADO/);
  });

  it('T11 — endpoints empresariais de configuração fiscal preservados', () => {
    assert.match(empresasRotas, /router\.get\('\/configuracao-fiscal\/status'/);
    assert.match(empresasRotas, /router\.get\('\/:empresaId\/configuracao-fiscal'/);
    assert.match(empresasRotas, /router\.put\('\/:empresaId\/configuracao-fiscal'/);
    assert.match(empresasRotas, /router\.delete\('\/:empresaId\/configuracao-fiscal'/);
  });

  it('T12 — nenhum menu de produção expõe a antiga Plataforma Fiscal', () => {
    assert.doesNotMatch(indexHtml, /Plataforma Fiscal/);
    assert.doesNotMatch(coreJs, /Plataforma Fiscal/);
    assert.doesNotMatch(centro, /renderNav[\s\S]{0,200}Plataforma Fiscal/);
    const navBlock = centro.slice(centro.indexOf('const CATEGORIAS'), centro.indexOf('function configPermiteFiscalUi'));
    assert.doesNotMatch(navBlock, /Plataforma Fiscal/);
  });
});
