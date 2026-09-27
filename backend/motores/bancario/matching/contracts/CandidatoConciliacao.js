/**
 * DTO de candidato a conciliação. Não é persistência.
 * MBC-05.3: campos ricos para CONTAS_RECEBER quando disponíveis.
 * @module motores/bancario/matching/contracts/CandidatoConciliacao
 */
'use strict';

function montarCandidato(input = {}) {
  const valor = Number(input.valor);
  const ja = input.valor_ja_conciliado != null ? Number(input.valor_ja_conciliado) : 0;
  const disponivel = input.valor_disponivel != null
    ? Number(input.valor_disponivel)
    : valor;
  const original = input.valor_original != null
    ? Number(input.valor_original)
    : (Number.isFinite(valor) ? valor : 0);
  return Object.freeze({
    tipo_registro: String(input.tipo_registro || input.origem_financeira || ''),
    registro_id: Number(input.registro_id || input.registro_financeiro_id),
    empresa_id: Number(input.empresa_id),
    valor: Number.isFinite(valor) ? valor : 0,
    valor_original: Number.isFinite(original) ? original : 0,
    valor_restante: input.valor_restante != null ? Number(input.valor_restante) : null,
    valor_pago: input.valor_pago != null ? Number(input.valor_pago) : null,
    valor_ja_conciliado: Number.isFinite(ja) ? ja : 0,
    valor_disponivel: Number.isFinite(disponivel) ? disponivel : 0,
    permite_parcial: input.permite_parcial === true,
    status: input.status != null ? String(input.status) : null,
    data: input.data || null,
    data_tipo: input.data_tipo || null,
    descricao: input.descricao != null ? String(input.descricao) : '',
    identificador: input.identificador != null ? String(input.identificador) : null,
    tipo: input.tipo || null,
    quantidade_pagamentos: input.quantidade_pagamentos != null
      ? Number(input.quantidade_pagamentos)
      : null,
    pagamentos: input.pagamentos && typeof input.pagamentos === 'object'
      ? Object.freeze({
        quantidade: Number(input.pagamentos.quantidade) || 0,
        valor_total: Number(input.pagamentos.valor_total) || 0
      })
      : null,
    rotulo_entidade: input.rotulo_entidade != null ? String(input.rotulo_entidade) : null
  });
}

module.exports = { montarCandidato };
