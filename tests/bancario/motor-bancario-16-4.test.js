/**
 * Sprint MBC-16.4 — UI operacional Mercado Pago + critérios de homologação.
 * Executar: node --test tests/bancario/motor-bancario-16-4.test.js
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

describe('MBC-16.4 UI operacional Mercado Pago', () => {
  const html = () => src('frontend/erp/pages/contas-bancarias.html');
  const js = () => src('frontend/erp/js/contas-bancarias.js');

  it('T01 T02 — operação e autorização', () => {
    const h = html();
    const j = js();
    assert.match(h, /data-mbc-tab="operacao"/);
    assert.match(h, /id="mbcOpBloqueio"/);
    assert.match(h, /id="mbcSyncAgora"/);
    assert.match(j, /Autorize novamente o Mercado Pago/);
    assert.match(j, /oauthEstaAutorizado/);
    assert.match(j, /selecionarAbaIntegracao\('auth'\)/);
  });

  it('T03 T04 — sincronizar chama endpoint e desabilita botão', () => {
    const j = js();
    assert.match(j, /POST',\s*'\/bancario\/contas\/'\s*\+\s*contaConfigId\s*\+\s*'\/sincronizar'/);
    assert.match(j, /sincronizandoAgora\s*=\s*true/);
    assert.match(j, /btn\.disabled\s*=\s*!ok/);
    assert.match(j, /Sincronizando…/);
  });

  it('T05 T06 T07 T08 — estados sucesso/erro/409/PROCESSANDO', () => {
    const j = js();
    assert.match(j, /Sincronização concluída/);
    assert.match(j, /Esta conta já está sendo sincronizada/);
    assert.match(j, /Relatório do Mercado Pago (em processamento|ainda em geração)/);
    assert.match(j, /rotuloSync/);
    assert.match(j, /Concluída/);
    assert.match(j, /Processando/);
  });

  it('T09 T10 T11 — extrato carrega e trata vazio/erro', () => {
    const h = html();
    const j = js();
    assert.match(h, /id="mbcExtratoBody"/);
    assert.match(h, /id="mbcExtFiltrar"/);
    assert.match(j, /carregarExtratoOperacao/);
    assert.match(j, /Nenhuma movimentação no extrato/);
    assert.match(j, /Erro ao carregar extrato/);
    assert.match(j, /\/bancario\/contas\/'\s*\+\s*contaConfigId\s*\+\s*'\/extrato/);
    assert.doesNotMatch(j, /raw_reference/);
  });

  it('T12 T13 — troca de empresa limpa estado', () => {
    const j = js();
    assert.match(j, /cds-empresa-contexto-alterado/);
    assert.match(j, /limparPainelTransacoes|ultimoResultadoSyncCache\s*=\s*null/);
    assert.match(j, /Nenhuma sincronização realizada/);
  });

  it('T14 T15 — sem token/secret/raw_reference na UI', () => {
    const j = js();
    assert.equal(/access_token|refresh_token|client_secret/.test(j), false);
    assert.doesNotMatch(j, /raw_reference/);
    assert.equal(j.includes('CLOUDFLARE'), false);
  });

  it('saldo real não inventado; API oficial reutilizada', () => {
    const h = html();
    const j = js();
    assert.match(h, /Saldo real indisponível neste fluxo|Saldo real do Mercado Pago/);
    assert.match(h, /Saldo conceitual/);
    assert.match(j, /Saldo real indisponível neste fluxo/);
    assert.match(j, /\/sincronizacao/);
    assert.doesNotMatch(j, /\/importar-extrato-mercado-pago/);
  });

  it('sprint, relatório e distinção de homologação', () => {
    assert.ok(String(VERSAO.SPRINT).startsWith('MBC-'));
    assert.equal(VERSAO.CODIGO, 'MBC-01');
    assert.ok(fs.existsSync(path.join(ROOT, 'docs/bancario/MBC-16.4-RELATORIO.md')));
    const rel = src('docs/bancario/MBC-16.4-RELATORIO.md');
    assert.match(rel, /UI OPERACIONAL IMPLEMENTADA/);
    assert.match(rel, /HOMOLOGAÇÃO E2E REAL PENDENTE/);
    assert.match(rel, /\*\*PENDENTE\*\*/);
    assert.doesNotMatch(rel, /^CLASSIFICAÇÃO:\s*INTEGRAÇÃO MERCADO PAGO HOMOLOGADA E2E/m);
  });
});
