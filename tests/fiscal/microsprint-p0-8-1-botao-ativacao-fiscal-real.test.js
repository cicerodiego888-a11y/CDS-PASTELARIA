/**
 * P0.8.1 — Visibilidade e navegação do botão de ativação fiscal real.
 * Isolado: leitura estática de fontes. Sem SEFAZ, sem banco oficial.
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

describe('P0.8.1 botão ativação operação fiscal real', () => {
  it('1. painel e botão existem no markup gerado (topo da aba SEFAZ)', () => {
    const ui = src('frontend/erp/js/central-entradas.js');
    assert.match(ui, /function renderCardOperacaoFiscalRealCfg/);
    assert.match(ui, /id="centralCfgCardOperacaoReal"/);
    assert.match(ui, /id="centralCfgOpRealHabilitar"/);
    assert.match(ui, /Habilitar operação real/);
    assert.match(ui, /Consultar DF-e \(produção\)/);
    // Card no topo da aba SEFAZ (antes da Manifestação)
    const idxCard = ui.indexOf('function renderAbaSefazCfg');
    const slice = ui.slice(idxCard, idxCard + 2500);
    assert.match(slice, /renderCardOperacaoFiscalRealCfg\(\)/);
    assert.ok(
      slice.indexOf('renderCardOperacaoFiscalRealCfg')
        < slice.indexOf('Manifestação do Destinatário')
    );
  });

  it('2. atalho no menu e deep-link para aba SEFAZ', () => {
    const ui = src('frontend/erp/js/central-entradas.js');
    assert.match(ui, /id="centralBtnOperacaoFiscalReal"/);
    assert.match(ui, /Operação fiscal real \(DistDFe\)/);
    assert.match(ui, /function abrirPainelOperacaoFiscalRealCentral/);
    assert.match(ui, /configAbaAtiva = 'sefaz'/);
    assert.match(ui, /ativarAbaConfigCentral\('sefaz'\)/);
    assert.match(ui, /#centralBtnOperacaoFiscalReal/);
  });

  it('3. sync bloqueado abre o painel correto (não Configuração Fiscal)', () => {
    const ui = src('frontend/erp/js/central-entradas.js');
    assert.match(ui, /abrirPainelOperacaoFiscalRealCentral/);
    assert.match(ui, /Não use .Abrir Configuração Fiscal./);
    assert.match(ui, /Não confunda com/);
  });

  it('4. perfil admin: lê localStorage.user (não usuario) e helpers oficiais', () => {
    const ui = src('frontend/erp/js/central-entradas.js');
    assert.match(ui, /function usuarioPodeAdminOperacaoFiscalReal/);
    assert.match(ui, /function obterUsuarioLogadoCentral/);
    assert.match(ui, /localStorage\.getItem\('user'\)/);
    assert.match(ui, /isSuperAdminUser/);
    assert.match(ui, /podeAjustarEstoque/);
    assert.match(ui, /Requer perfil ADMIN ou SUPER_ADMIN/);
    assert.match(ui, /apenas ADMIN ou SUPER_ADMIN podem habilitar/);
  });

  it('5. rotas HTTP corretas na UI', () => {
    const ui = src('frontend/erp/js/central-entradas.js');
    assert.match(ui, /\/operacao-fiscal-real\/status/);
    assert.match(ui, /\/operacao-fiscal-real\/habilitar/);
    assert.match(ui, /\/operacao-fiscal-real\/desabilitar/);
    assert.match(ui, /\/operacao-fiscal-real\/consultar-dfe/);
    const rotas = src('backend/rotas/central-entradas.js');
    assert.match(rotas, /\/operacao-fiscal-real\/status/);
    assert.match(rotas, /\/operacao-fiscal-real\/habilitar/);
    assert.match(rotas, /\/operacao-fiscal-real\/consultar-dfe/);
  });

  it('6. cache-bust do ERP atualizado para incluir o painel', () => {
    const app = src('frontend/erp/js/app.js');
    assert.match(app, /p093-http422-dfe|p081-op-real-perfil|p081-ver-revisoes/);
    assert.equal(/: '0519'/.test(app), false);
  });

  it('7. não há ativação automática no frontend', () => {
    const ui = src('frontend/erp/js/central-entradas.js');
    // Habilitar só via clique do botão (delegação jQuery), nunca no loadCentralEntradas.
    const loadSlice = ui.slice(
      ui.indexOf('function loadCentralEntradas'),
      ui.indexOf('function loadCentralEntradas') + 8000
    );
    assert.equal(/habilitarOperacaoFiscalRealCentral/.test(loadSlice), false);
    assert.match(ui, /#centralCfgOpRealHabilitar[\s\S]{0,120}habilitarOperacaoFiscalRealCentral/);
    assert.match(ui, /confirmarAmbienteProducao: true/);
  });
});
