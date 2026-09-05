/**
 * DTO de candidato a conciliação. Não é persistência.
 * @module motores/bancario/matching/contracts/CandidatoConciliacao
 */
'use strict';

function montarCandidato(input = {}) {
  return Object.freeze({
    tipo_registro: String(input.tipo_registro || input.origem_financeira || ''),
    registro_id: Number(input.registro_id || input.registro_financeiro_id),
    empresa_id: Number(input.empresa_id),
    valor: Number(input.valor),
    data: input.data || null,
    descricao: input.descricao != null ? String(input.descricao) : '',
    identificador: input.identificador != null ? String(input.identificador) : null,
    tipo: input.tipo || null
  });
}

module.exports = { montarCandidato };
