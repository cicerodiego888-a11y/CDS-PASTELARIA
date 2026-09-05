/**
 * Resultado da análise de matching de uma transação.
 * @module motores/bancario/matching/contracts/ResultadoMatching
 */
'use strict';

function montarResultado(input = {}) {
  return Object.freeze({
    transacao_bancaria_id: input.transacao_bancaria_id,
    empresa_id: input.empresa_id,
    resultado: input.resultado,
    candidatos: input.candidatos || [],
    sugestoes: input.sugestoes || [],
    criadas: Number(input.criadas) || 0
  });
}

module.exports = { montarResultado };
