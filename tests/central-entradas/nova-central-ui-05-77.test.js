/**
 * Sprint 05.77 — Nova UI da Central Inteligente de Entradas (contrato visual).
 * Executar: node tests/central-entradas/nova-central-ui-05-77.test.js
 *
 * Não exercita DistDFe/MIIP. Valida preservação de IDs, endpoints e ownership no frontend.
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const mainSrc = fs.readFileSync(path.join(ROOT, 'frontend/erp/js/central-entradas.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(ROOT, 'frontend/css/central-entradas-05-77.css'), 'utf8');
const indexSrc = fs.readFileSync(path.join(ROOT, 'frontend/erp/index.html'), 'utf8');
const uxSrc = fs.readFileSync(path.join(ROOT, 'frontend/erp/js/central-entradas-ux.js'), 'utf8');

function trecho(fnName) {
  const re = new RegExp(`(?:async )?function ${fnName}\\([\\s\\S]*?\\n(?=(?:async )?function )`);
  const m = mainSrc.match(re);
  return m ? m[0] : '';
}

describe('05.77 — T01 Central abre', () => {
  it('T01 — loadCentralEntradas e IDs oficiais permanecem', () => {
    assert.match(mainSrc, /function loadCentralEntradas\(/);
    assert.match(mainSrc, /centralUx1Header/);
    assert.match(mainSrc, /centralBtnSincronizar/);
    assert.match(mainSrc, /centralEntradasListaDocs/);
    assert.match(mainSrc, /centralEntradasPainelLateral/);
    assert.match(indexSrc, /central-entradas-05-77\.css/);
    assert.match(mainSrc, /central-0577/);
  });
});

describe('05.77 — empresas 1 / 3 / 5+', () => {
  it('T02 — empresa única: chips e seletor sem quantidade fixa de cards', () => {
    assert.match(mainSrc, /renderAreaEmpresasCentral/);
    assert.match(mainSrc, /empresasPermitidas/);
    assert.doesNotMatch(mainSrc, /for\s*\(\s*let\s+i\s*=\s*0;\s*i\s*<\s*3/);
    assert.match(cssSrc, /central-0577-chip/);
  });

  it('T03 — 3 empresas: chips compactos (n < 6)', () => {
    assert.match(mainSrc, /compacto = n >= 6/);
    assert.match(mainSrc, /central-0577-chips/);
    assert.match(mainSrc, /data-central-empresa-id/);
  });

  it('T04 — 5+ / 10 empresas: modo compacto + overflow, sem grid fixo', () => {
    assert.match(mainSrc, /n >= 6/);
    assert.match(cssSrc, /overflow-x:\s*auto/);
    assert.doesNotMatch(cssSrc, /grid-template-columns:\s*repeat\(10/);
  });

  it('T05 — seletor pesquisa empresa', () => {
    assert.match(mainSrc, /centralBuscaEmpresa/);
    assert.match(mainSrc, /Pesquisar empresa/);
    assert.match(mainSrc, /empresasFiltradasBuscaUiCentral/);
  });

  it('T06 — Todas as empresas recarrega com escopo, sem N GETs no cliente', () => {
    const aplicar = trecho('aplicarVistaEmpresaCentral');
    assert.match(mainSrc, /Todas as empresas/);
    assert.match(aplicar, /vistaEmpresas = 'todas'/);
    assert.match(aplicar, /recarregarDadosCentralAposTrocaEmpresa/);
    assert.match(mainSrc, /escopo', 'todas'/);
    assert.doesNotMatch(aplicar, /forEach[\s\S]{0,200}carregarDashboard/);
    assert.doesNotMatch(aplicar, /empresasPermitidas\.forEach/);
  });

  it('T06s — EMPRESA_SIMPLES: uma empresa operacional, sem Todas e sem escopo=todas', () => {
    const render = trecho('renderAreaEmpresasCentral');
    const area = trecho('empresasParaAreaCentral');
    const aplicar = trecho('aplicarVistaEmpresaCentral');
    const qs = trecho('qsComEscopoEmpresaCentral');
    assert.match(mainSrc, /function centralModoEmpresaSimples\(/);
    assert.match(area, /empresaOperacionalIdCentralUi/);
    assert.match(render, /simples\s*\?\s*\[\]/);
    assert.match(render, /compacto \|\| simples/);
    assert.match(render, /Modo Empresa Simples/);
    assert.match(aplicar, /centralModoEmpresaSimples\(\)\) return/);
    assert.match(qs, /!centralModoEmpresaSimples\(\)/);
    assert.match(mainSrc, /dashboard\.modo/);
  });

  it('T07 — empresa específica usa CdsEmpresaContexto.selecionar', () => {
    const aplicar = trecho('aplicarVistaEmpresaCentral');
    assert.match(aplicar, /Ctx\.selecionar\(id\)/);
    assert.match(aplicar, /recarregarDadosCentralAposTrocaEmpresa|carregarDocumentosCentral/);
    assert.doesNotMatch(aplicar, /empresaId:\s*1|empresa_id:\s*1/);
  });
});

describe('05.77 — lista, painel, abas, ações', () => {
  it('T08 — lista em tabela com colunas conceituais e data-documento-id', () => {
    assert.match(mainSrc, /central-0577-tabela/);
    assert.match(mainSrc, /<th>Empresa<\/th>/);
    assert.match(mainSrc, /data-documento-id=/);
    assert.match(mainSrc, /centralEntradasPaginacao/);
  });

  it('T09 — clique abre painel via selecionarDocumentoCentral', () => {
    assert.match(mainSrc, /\.central-entradas-row/);
    assert.match(mainSrc, /selecionarDocumentoCentral/);
    assert.match(mainSrc, /central-0577-btn-ver/);
  });

  it('T10 — pré-visualização NF-e no painel lateral', () => {
    assert.match(mainSrc, /function renderPainelLateralCentral/);
    assert.match(mainSrc, /DETALHE DA NF-E/);
    assert.match(mainSrc, /centralEntradasPainelLateral/);
    assert.match(mainSrc, /NF \$\{escapeHtmlCentralEntradas\(numero\)\}/);
  });

  it('T11 — aba Resumo', () => {
    assert.match(mainSrc, /id: 'resumo'/);
    assert.match(mainSrc, /renderAbaResumoCentral/);
    assert.match(mainSrc, /O que aconteceu\?/);
  });

  it('T12 — aba Produtos', () => {
    assert.match(mainSrc, /id: 'produtos'/);
    assert.match(mainSrc, /renderAbaItensCentral/);
  });

  it('T13 — aba Timeline', () => {
    assert.match(mainSrc, /id: 'timeline'/);
    assert.match(mainSrc, /renderAbaTimelineCentral|renderTimelineCentral/);
  });

  it('T14 — aba XML', () => {
    assert.match(mainSrc, /id: 'xml'/);
    assert.match(mainSrc, /renderAbaXmlCentral/);
  });

  it('T15 — aba Histórico', () => {
    assert.match(mainSrc, /id: 'historico'/);
  });

  it('T16 — ações existentes', () => {
    assert.match(mainSrc, /centralBtnAbrirCompra/);
    assert.match(mainSrc, /renderAcoesPipelineCentral/);
  });

  it('T17 — Solicitar XML', () => {
    assert.match(mainSrc, /centralBtnSolicitarXmlCompleto/);
  });

  it('T18 — Revisar', () => {
    assert.match(mainSrc, /centralBtnRevisarMiip/);
    assert.match(mainSrc, /abrirRevisaoMiipCentral/);
  });

  it('T19 — paginação existente', () => {
    assert.match(mainSrc, /function renderPaginacaoCentral/);
    assert.match(mainSrc, /centralPaginaAnterior/);
    assert.match(mainSrc, /centralPaginaProxima/);
  });

  it('T20 — sincronizar chama mecanismo existente', () => {
    assert.match(mainSrc, /#centralBtnSincronizar/);
    assert.match(mainSrc, /sincronizarCentralEntradas/);
  });

  it('T21 — badges de status na grade', () => {
    assert.match(mainSrc, /badgeStatusUx1/);
    assert.match(uxSrc, /Em revisão|Aguardando XML|Pronto/);
  });
});

describe('05.77 — isolamento e proibições', () => {
  it('T22 — sem dependência PDV Universal', () => {
    assert.doesNotMatch(mainSrc, /pdv-universal|PDVUniversal|pdvUniversal/);
    assert.doesNotMatch(cssSrc, /pdv-universal/);
  });

  it('T23 — sem endpoints novos na camada 05.77', () => {
    const novas = [
      trecho('aplicarVistaEmpresaCentral'),
      trecho('carregarEmpresasPermitidasCentral'),
      trecho('renderAreaEmpresasCentral')
    ].join('\n');
    assert.doesNotMatch(novas, /central-entradas\/empresas-resumo/);
    assert.doesNotMatch(novas, /fetch\(`\$\{API_URL\}/);
    assert.match(mainSrc, /listarDisponiveis/);
  });

  it('T24 — sem empresa fixa no frontend da Central', () => {
    const aplicar = trecho('aplicarVistaEmpresaCentral');
    const area = trecho('renderAreaEmpresasCentral');
    assert.doesNotMatch(aplicar, /\bselecionar\(\s*1\s*\)/);
    assert.doesNotMatch(area, /empresa_id\s*=\s*1/);
    assert.doesNotMatch(mainSrc, /COALESCE/);
  });

  it('T25 — filtro empresa específica recarrega lista do contexto, sem merge', () => {
    const aplicar = trecho('aplicarVistaEmpresaCentral');
    assert.match(aplicar, /recarregarDadosCentralAposTrocaEmpresa|carregarDocumentosCentral/);
    assert.match(mainSrc, /function recarregarDadosCentralAposTrocaEmpresa[\s\S]*carregarDocumentosCentral/);
    assert.doesNotMatch(aplicar, /documentos\.concat|push\(\.\.\.resultado/);
    assert.match(mainSrc, /empresaDoDocumentoUiCentral/);
    assert.match(mainSrc, /doc\?\.empresaId \?\? doc\?\.empresa_id/);
  });

  it('não inventa cubas/açaí nem altera motor', () => {
    assert.doesNotMatch(mainSrc, /cuba|açaí|acai/i);
    assert.doesNotMatch(cssSrc, /MonitoringEngine|DistDFe/);
  });
});
