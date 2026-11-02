/**
 * Contrato de Smart POS independente de fabricante.
 * Os estados novos conversam com o status já gravado pelo TEF.
 * Simulação não é recebimento real.
 */
'use strict';

const tefFluxoPagamento = require('./tefFluxoPagamento');

const ESTADO = Object.freeze({
  SOLICITADA: 'solicitada',
  AGUARDANDO_TERMINAL: 'aguardando_terminal',
  PROCESSANDO: 'processando',
  APROVADA: 'aprovada',
  RECUSADA: 'recusada',
  CANCELADA: 'cancelada',
  TIMEOUT: 'timeout',
  FALHA: 'falha'
});

const STATUS_TEF = Object.freeze({
  solicitada: 'pendente',
  aguardando_terminal: 'pendente',
  processando: 'pendente',
  aprovada: 'aprovado',
  recusada: 'negado',
  cancelada: 'cancelado',
  timeout: 'timeout',
  falha: 'erro'
});

function paraStatusTef(estado) {
  return STATUS_TEF[estado] || 'erro';
}

function normalizarModalidade(valor) {
  const tipo = tefFluxoPagamento.normalizarTipoTef(valor);
  if (tipo === 'pix_tef') return 'pix';
  if (tipo === 'debito' || tipo === 'cartao_debito') return 'debito';
  if (tipo === 'credito' || tipo === 'cartao_credito') return 'credito';
  return '';
}

function criarSolicitacao(dados = {}) {
  const modalidade = normalizarModalidade(dados.modalidade || dados.tipo || dados.forma);
  const valor = Number(dados.valor);
  const empresaId = Number(dados.empresa_id);
  const operadorId = Number(dados.operador_id);
  if (!modalidade) {
    return { ok: false, codigo: 'MODALIDADE_INVALIDA', mensagem: 'A modalidade precisa ser PIX, débito ou crédito.' };
  }
  if (!(valor > 0) || !Number.isFinite(valor)) {
    return { ok: false, codigo: 'VALOR_INVALIDO', mensagem: 'O valor do pagamento é inválido.' };
  }
  if (!empresaId) {
    return { ok: false, codigo: 'EMPRESA_AUSENTE', mensagem: 'A solicitação não tem empresa autorizada.' };
  }
  if (!operadorId) {
    return { ok: false, codigo: 'OPERADOR_AUSENTE', mensagem: 'A solicitação não tem operador autenticado.' };
  }
  return {
    ok: true,
    modalidade,
    valor,
    empresa_id: empresaId,
    operador_id: operadorId,
    idempotency_key: dados.idempotency_key ? String(dados.idempotency_key) : null,
    terminal_id: dados.terminal_id ? String(dados.terminal_id) : null
  };
}

function estadoDoPedido(pedido) {
  const nome = String(pedido || '').toLowerCase().trim();
  if (nome === 'aprovado' || nome === 'aprovada') return ESTADO.APROVADA;
  if (nome === 'recusado' || nome === 'recusada' || nome === 'negado' || nome === 'negada') return ESTADO.RECUSADA;
  if (nome === 'pendente' || nome === 'processando') return ESTADO.PROCESSANDO;
  if (nome === 'aguardando' || nome === 'aguardando_terminal') return ESTADO.AGUARDANDO_TERMINAL;
  if (nome === 'solicitada') return ESTADO.SOLICITADA;
  if (nome === 'cancelado' || nome === 'cancelada') return ESTADO.CANCELADA;
  if (nome === 'timeout') return ESTADO.TIMEOUT;
  if (nome === 'falha' || nome === 'erro' || nome === 'falha_comunicacao') return ESTADO.FALHA;
  return '';
}

function identificarTerminal(config = {}) {
  const id = config.terminal_id || config.terminalId || 'simulador-local';
  return {
    terminal_id: String(id),
    simulado: true,
    fabricante: null,
    modelo: null,
    protocolo: null
  };
}

function podeContabilizarComoRecebimentoReal(retorno) {
  if (!retorno) return false;
  if (retorno.simulado === true || retorno.modo === 'simulacao') return false;
  return retorno.aprovado === true && String(retorno.status || '') === 'aprovado' && !!retorno.transacao_id;
}

module.exports = {
  ESTADO,
  STATUS_TEF,
  paraStatusTef,
  normalizarModalidade,
  criarSolicitacao,
  estadoDoPedido,
  identificarTerminal,
  podeContabilizarComoRecebimentoReal
};
