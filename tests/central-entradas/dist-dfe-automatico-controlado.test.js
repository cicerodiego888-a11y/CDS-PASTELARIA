'use strict';

const { isolarBancoTeste } = require('./helpers/isolarBancoTeste');
isolarBancoTeste('cds-distdfe-auto-');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');

function src(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('DistDFe automatico controlado + consulta chave real', () => {
  it('emite auth sync so para background/abrir_central', () => {
    const s = src('backend/motores/central-entradas/services/CentralOperacaoFiscalRealService.js');
    assert.match(s, /emitirAutorizacaoSyncControlado/);
    assert.match(s, /distDfeAutomatico/);
    assert.match(s, /origensAuto/);
    assert.match(s, /background/);
    assert.match(s, /abrir_central/);
    assert.match(s, /emitirAutorizacaoConsultaChaveReal/);
    assert.match(s, /CONS_CH_NFE/);
    assert.match(s, /COOLDOWN_EXPLICITO/);
  });

  it('sync empresa emite auth controlada quando origem background', () => {
    const s = src('backend/motores/central-entradas/services/CentralSincronizacaoService.js');
    assert.match(s, /emitirAutorizacaoSyncControlado/);
    assert.match(s, /_escolherAlvoRoundRobin/);
    assert.match(s, /roundRobinEmpresas/);
    assert.match(s, /sync_rr_ultima_empresa_id/);
  });

  it('intervalo minimo de sync e 60 minutos', () => {
    const s = src('backend/motores/central-entradas/services/CentralConfigService.js');
    assert.match(s, /Math\.max\(60,/);
  });

  it('rota e orquestrador expoe consultar-chave real', () => {
    const rotas = src('backend/rotas/central-entradas.js');
    const orch = src('backend/motores/central-entradas/CentralEntradasOrchestrator.js');
    const ui = src('frontend/erp/js/central-entradas.js');
    assert.match(rotas, /operacao-fiscal-real\/consultar-chave/);
    assert.match(orch, /consultarChaveReal/);
    assert.match(ui, /operacao-fiscal-real\/consultar-chave/);
    assert.match(ui, /confirmacaoConsultaReal: true/);
  });

  it('habilitar OPERACAO_REAL grava distDfeAutomatico true', () => {
    const s = src('backend/motores/central-entradas/services/CentralOperacaoFiscalRealService.js');
    assert.match(s, /distDfeAutomatico:\s*true/);
  });
});
