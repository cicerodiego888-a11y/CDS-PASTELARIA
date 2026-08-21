/**
 * RC4.0.0 — Redesign UX Central (workflow first) — testes de contrato UI.
 * Não altera regras de negócio; valida linguagem operacional e helpers.
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '../..');
const UX = require(path.join(root, 'frontend/erp/js/central-entradas-ux.js'));
const mainSrc = fs.readFileSync(path.join(root, 'frontend/erp/js/central-entradas.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(root, 'frontend/css/central-entradas-ux1.css'), 'utf8');

describe('RC4.0.0 — linguagem operacional', () => {
  it('badges usam vocabulário operacional (sem jargão técnico)', () => {
    const html = UX.badgeStatusUx1('AGUARDANDO_REVISAO', 'AGUARDANDO_REVISAO_MIIP_TECH');
    assert.match(html, /Em revisão/);
    assert.doesNotMatch(html, /MIIP|MIRX|Gate|SOAP/i);

    assert.match(UX.badgeStatusUx1('AGUARDANDO_XML_COMPLETO'), /Aguardando XML/);
    assert.match(UX.badgeStatusUx1('PRONTA_PARA_COMPRA'), /Pronto para importar/);
    assert.match(UX.badgeStatusUx1('GRAVADA'), /Importado/);
    assert.match(UX.badgeStatusUx1('ERRO'), /Atenção/);
  });

  it('próxima ação cobre fluxos oficiais', () => {
    assert.equal(UX.resolverProximaAcaoOperacional({ status: 'AGUARDANDO_REVISAO' }).label, 'Revisar Produtos');
    assert.equal(UX.resolverProximaAcaoOperacional({ status: 'PRONTA_PARA_COMPRA' }).label, 'Importar Compra');
    assert.equal(UX.resolverProximaAcaoOperacional({ status: 'AGUARDANDO_XML_COMPLETO' }).label, 'Aguardando XML');
    assert.equal(UX.resolverProximaAcaoOperacional({ status: 'ERRO' }).label, 'Ver Diagnóstico');
    assert.equal(UX.resolverProximaAcaoOperacional({ status: 'GRAVADA' }).label, 'Encerrado');
  });

  it('labels operacionais padronizados', () => {
    assert.equal(UX.labelStatusOperacionalCentral('SINCRONIZADA'), 'Recebido');
    assert.equal(UX.labelStatusOperacionalCentral('AGUARDANDO_REVISAO'), 'Em revisão');
    assert.equal(UX.labelStatusOperacionalCentral('REVISADA'), 'Pronto para importar');
  });
});

describe('RC4.0.0 — estrutura workflow first', () => {
  it('header limpo e menu Mais opções presentes', () => {
    assert.match(mainSrc, /central-rc40-header/);
    assert.match(mainSrc, /Mais opções|fa-ellipsis-h/);
    assert.match(mainSrc, /central-rc40-mais/);
  });

  it('quatro KPIs operacionais', () => {
    assert.match(mainSrc, /Recebidos Hoje/);
    assert.match(mainSrc, /Aguardando Revisão/);
    assert.match(mainSrc, /Prontos para Importar/);
    assert.match(mainSrc, /Precisam de Atenção/);
    assert.match(mainSrc, /central-rc40-kpis/);
  });

  it('fila de trabalho com filtros oficiais', () => {
    assert.match(mainSrc, /Fila de Trabalho/);
    assert.match(mainSrc, /Aguardando XML/);
    assert.match(mainSrc, /data-fila-filtro/);
  });

  it('modo técnico e monitoramento recolhíveis', () => {
    assert.match(mainSrc, /Modo Técnico/);
    assert.match(mainSrc, /Monitoramento — SEFAZ/);
    assert.match(mainSrc, /Monitoramento — Saúde/);
    assert.match(mainSrc, /Indicadores Avançados/);
    assert.match(cssSrc, /central-rc40-modo-tecnico/);
  });

  it('resumo responde as 4 perguntas operacionais', () => {
    assert.match(mainSrc, /O que aconteceu\?/);
    assert.match(mainSrc, /Em que etapa está\?/);
    assert.match(mainSrc, /O sistema fará algo sozinho\?/);
    assert.match(mainSrc, /Preciso fazer alguma ação\?/);
  });

  it('lista renderiza próxima ação (sem jargão técnico na linha)', () => {
    assert.match(mainSrc, /central-rc40-doc-row/);
    assert.match(mainSrc, /resolverProximaAcaoOperacional/);
    assert.doesNotMatch(mainSrc.match(/central-rc40-doc-row[\s\S]{0,800}/)?.[0] || '', /\bMIRX\b|\bSOAP\b|\bGate\b/);
  });
});

describe('RC4.0.0 — compatibilidade (sem remoção de fluxos)', () => {
  it('mantém handlers de sync / revisão / compra / XML', () => {
    assert.match(mainSrc, /sincronizarCentralEntradas/);
    assert.match(mainSrc, /abrirRevisaoMiipCentral|centralBtnRevisarMiip/);
    assert.match(mainSrc, /abrirCompraDesdeCentral|centralBtnAbrirCompra/);
    assert.match(mainSrc, /solicitarXmlCompletoCentral/);
    assert.match(mainSrc, /renderAbaMiipCentral/);
  });

  it('null-safe saúde (RC3.4.6.1) permanece', () => {
    assert.match(mainSrc, /renderCardSaudeDocumentoCentral/);
    const ux = fs.readFileSync(path.join(root, 'frontend/erp/js/central-entradas-ux.js'), 'utf8');
    assert.match(ux, /Saúde ainda não calculada|Documento sem diagnóstico/);
  });
});
