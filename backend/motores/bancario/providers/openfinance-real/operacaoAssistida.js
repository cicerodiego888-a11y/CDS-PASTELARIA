/**
 * Rastreio de OPERACAO_ASSISTIDA. Sem token, secret, state ou payload sensível.
 * @module motores/bancario/providers/openfinance-real/operacaoAssistida
 */
'use strict';

const { sanitizarObjetoMbc } = require('../../contracts/sanitizarMbc');
const { montarEventoOperacaoMbc } = require('../../contracts/observabilidadeMbc');

function montarRegistroOperacaoAssistida(dados = {}) {
  return sanitizarObjetoMbc({
    modo: 'OPERACAO_ASSISTIDA',
    empresa_id: dados.empresa_id != null ? dados.empresa_id : null,
    conta_bancaria_id: dados.conta_bancaria_id != null ? dados.conta_bancaria_id : null,
    provider: dados.provider || 'OPEN_FINANCE_REAL',
    ambiente: dados.ambiente || null,
    inicio: dados.inicio || null,
    fim: dados.fim || null,
    quantidade_recebida: dados.quantidade_recebida != null ? dados.quantidade_recebida : null,
    quantidade_criada: dados.quantidade_criada != null ? dados.quantidade_criada : null,
    quantidade_ja_existente: dados.quantidade_ja_existente != null ? dados.quantidade_ja_existente : null,
    erros: dados.erros != null ? dados.erros : 0,
    duracao_ms: dados.duracao_ms != null ? dados.duracao_ms : null,
    cursor_final: dados.cursor_final != null ? String(dados.cursor_final) : null,
    status: dados.status || 'BLOQUEADO',
    token: dados.token,
    access_token: dados.access_token,
    state: dados.state
  });
}

function iniciarOperacaoAssistida(dados) {
  return montarRegistroOperacaoAssistida({
    ...dados,
    inicio: dados.inicio || new Date().toISOString(),
    status: 'BLOQUEADO'
  });
}

module.exports = {
  montarRegistroOperacaoAssistida,
  iniciarOperacaoAssistida,
  montarEventoOperacaoMbc
};
