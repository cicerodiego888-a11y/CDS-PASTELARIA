/**
 * Rollback operacional: parar novas operações. Não apaga histórico.
 * @module motores/bancario/providers/openfinance-real/rollbackOperacaoReal
 */
'use strict';

const { MSG_BLOQUEIO_OPERACAO_REAL } = require('./prontidaoOperacaoReal');

function aplicarRollbackOperacaoReal(params = {}) {
  return {
    modo: 'PARAR_NOVAS_OPERACOES',
    novas_operacoes: 'BLOQUEADAS',
    mensagem: MSG_BLOQUEIO_OPERACAO_REAL,
    provider: params.provider || 'OPEN_FINANCE_REAL',
    transacoes_preservadas: true,
    consentimentos_preservados: true,
    conciliacoes_preservadas: true,
    historico_apagado: false,
    financeiro_revertido: false,
    vendas_alteradas: false,
    compras_alteradas: false,
    caixa_alterado: false
  };
}

module.exports = { aplicarRollbackOperacaoReal };
