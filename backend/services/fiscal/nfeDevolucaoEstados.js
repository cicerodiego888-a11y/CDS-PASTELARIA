/**
 * RC4 — Estados oficiais do ciclo de vida da NF-e de Devolução de Compra.
 */

'use strict';

const ESTADOS = Object.freeze({
  RASCUNHO: 'rascunho',
  ASSINANDO: 'assinando',
  VALIDANDO: 'validando',
  ENVIANDO: 'enviando',
  LOTE_ENVIADO: 'lote_enviado',
  PROCESSANDO: 'aguardando_retorno',
  AUTORIZADA: 'autorizada',
  CANCELADA: 'cancelada',
  REJEITADA: 'rejeitada',
  DENEGADA: 'denegada',
  ERRO_COMUNICACAO: 'erro_comunicacao',
  ERRO_ASSINATURA: 'erro_assinatura',
  ERRO_VALIDACAO: 'erro_validacao',
  CANCELAMENTO_REJEITADO: 'cancelamento_rejeitado',
  PENDENTE_REENVIO: 'pendente_reenvio'
});

const ESTADOS_UI = Object.freeze({
  [ESTADOS.RASCUNHO]: { label: 'Rascunho', cor: 'cinza', emoji: '⚪' },
  [ESTADOS.ASSINANDO]: { label: 'Assinando', cor: 'azul', emoji: '🔵' },
  [ESTADOS.VALIDANDO]: { label: 'Validando', cor: 'azul', emoji: '🔵' },
  [ESTADOS.ENVIANDO]: { label: 'Enviando', cor: 'azul', emoji: '🔵' },
  [ESTADOS.LOTE_ENVIADO]: { label: 'Lote enviado', cor: 'amarelo', emoji: '🟡' },
  [ESTADOS.PROCESSANDO]: { label: 'Processando', cor: 'amarelo', emoji: '🟡' },
  [ESTADOS.AUTORIZADA]: { label: 'Autorizada', cor: 'verde', emoji: '🟢' },
  [ESTADOS.CANCELADA]: { label: 'Cancelada', cor: 'vermelho', emoji: '🔴' },
  [ESTADOS.REJEITADA]: { label: 'Rejeitada', cor: 'vermelho', emoji: '🔴' },
  [ESTADOS.DENEGADA]: { label: 'Denegada', cor: 'vermelho', emoji: '🔴' },
  [ESTADOS.ERRO_COMUNICACAO]: { label: 'Erro comunicação', cor: 'vermelho', emoji: '🔴' },
  [ESTADOS.ERRO_ASSINATURA]: { label: 'Erro assinatura', cor: 'vermelho', emoji: '🔴' },
  [ESTADOS.ERRO_VALIDACAO]: { label: 'Erro validação', cor: 'vermelho', emoji: '🔴' },
  [ESTADOS.CANCELAMENTO_REJEITADO]: { label: 'Cancelamento rejeitado', cor: 'vermelho', emoji: '🔴' },
  [ESTADOS.PENDENTE_REENVIO]: { label: 'Pendente reenvio', cor: 'amarelo', emoji: '🟡' }
});

const REENVIAVEL = new Set([
  ESTADOS.REJEITADA,
  ESTADOS.ERRO_COMUNICACAO,
  ESTADOS.ERRO_VALIDACAO,
  ESTADOS.ERRO_ASSINATURA,
  ESTADOS.PENDENTE_REENVIO,
  'erro_transmissao',
  'timeout',
  'servico_indisponivel'
]);

const BLOQUEIO_REENVIO = new Set([
  ESTADOS.AUTORIZADA,
  ESTADOS.CANCELADA,
  ESTADOS.DENEGADA,
  ESTADOS.PROCESSANDO,
  ESTADOS.LOTE_ENVIADO,
  ESTADOS.ENVIANDO
]);

const EVENTOS = Object.freeze({
  XML_GERADO: 'xml_gerado',
  ASSINADO: 'assinado',
  VALIDADO: 'validado',
  ENVIADO: 'enviado',
  LOTE_RECEBIDO: 'lote_recebido',
  CONSULTA: 'consulta',
  CONSULTA_AUTOMATICA: 'consulta_automatica',
  AUTORIZADO: 'autorizado',
  REJEITADO: 'rejeitado',
  DENEGADO: 'denegado',
  DANFE_GERADO: 'danfe_gerado',
  CANCELADO: 'cancelado',
  CANCELAMENTO_REJEITADO: 'cancelamento_rejeitado',
  REENVIO: 'reenvio',
  ERRO: 'erro'
});

function uiDoEstado(status) {
  const st = String(status || '').toLowerCase();
  return ESTADOS_UI[st] || { label: status || 'Desconhecido', cor: 'cinza', emoji: '⚪' };
}

function podeReenviarDevolucao({ status } = {}) {
  const st = String(status || '').toLowerCase();
  if (BLOQUEIO_REENVIO.has(st)) return false;
  if (REENVIAVEL.has(st)) return true;
  return false;
}

function podeCancelarDevolucao({ status } = {}) {
  const st = String(status || '').toLowerCase();
  return st === ESTADOS.AUTORIZADA || st === ESTADOS.CANCELAMENTO_REJEITADO;
}

function mensagemRejeicaoDetalhada(cStat, xMotivo) {
  const codigo = String(cStat || '').trim();
  const motivo = String(xMotivo || '').trim() || 'Motivo não informado pela SEFAZ';
  if (!codigo) return motivo;
  return `Rejeição ${codigo}\n${motivo}`;
}

module.exports = {
  ESTADOS,
  ESTADOS_UI,
  EVENTOS,
  REENVIAVEL,
  BLOQUEIO_REENVIO,
  uiDoEstado,
  podeReenviarDevolucao,
  podeCancelarDevolucao,
  mensagemRejeicaoDetalhada
};
