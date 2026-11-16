/**
 * Dashboard KPIs — F12 ON conta só vendas com valor fiscal.
 *
 * Executar:
 *   node --test --test-concurrency=1 tests/dashboard/dashboard-kpi-vendas-f12.test.js
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  getFiltroVendaComValorNoModo,
  getExprContagemVendas,
  getExprTicketMedioVenda,
  isModoFiscalRelatorio
} = require('../../backend/services/reportFiscalHelpers');

describe('Dashboard KPI Vendas × F12', () => {
  it('F12 OFF não filtra vendas sem valor fiscal', () => {
    assert.equal(isModoFiscalRelatorio('0'), false);
    assert.equal(getFiltroVendaComValorNoModo('0'), '');
    assert.equal(getExprContagemVendas('0'), 'COUNT(v.id)');
  });

  it('F12 ON exige valor_fiscal > 0 na contagem', () => {
    assert.equal(isModoFiscalRelatorio('1'), true);
    assert.match(getFiltroVendaComValorNoModo('1'), /valor_fiscal/);
    assert.match(getFiltroVendaComValorNoModo(true), /> 0\.009/);
    assert.match(getExprContagemVendas('1'), /COUNT\(CASE WHEN/);
    assert.match(getExprTicketMedioVenda('1'), /AVG\(CASE WHEN/);
  });

  it('rota do dashboard aplica o filtro no resumo de vendas', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '../../backend/rotas/dashboard.js'),
      'utf8'
    );
    assert.match(src, /getFiltroVendaComValorNoModo/);
    assert.match(src, /filtroVendaComValor/);
    assert.match(src, /COUNT\(v\.id\) AS total_vendas/);
  });
});
