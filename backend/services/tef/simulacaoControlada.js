/**
 * Resultado controlado dos adapters em modo simulação.
 * Ausente o campo, o simulador mantém o comportamento anterior.
 * Não é lido por adapter real.
 */
'use strict';

const tefContrato = require('./tefContrato');

function pedidoSimulado(dados) {
  return String(dados && dados.resultado_simulado || '').toLowerCase().trim();
}

function respostaSimulada(dados, extra = {}) {
  const pedido = pedidoSimulado(dados);
  if (!pedido) return null;

  if (pedido === 'timeout') {
    const erro = new Error('Timeout de operação TEF excedido na simulação');
    erro.codigo = 'TIMEOUT';
    throw erro;
  }

  const agora = Date.now();
  if (pedido === 'aprovado') {
    return tefContrato.criarRespostaAutorizacao({
      sucesso: true,
      status: tefContrato.STATUS.APROVADO,
      nsu: `NSU${agora}`,
      autorizacao: `AUT${String(agora).slice(-6)}`,
      transacaoId: `SIM${agora}`,
      adquirente: extra.adquirente || 'SIMULADOR',
      bandeira: extra.bandeira || 'VISA',
      mensagem: 'Pagamento aprovado (simulação controlada)',
      modo: 'simulacao'
    });
  }

  if (pedido === 'recusado' || pedido === 'negado') {
    return tefContrato.criarRespostaAutorizacao({
      sucesso: false,
      status: tefContrato.STATUS.NEGADO,
      adquirente: extra.adquirente || 'SIMULADOR',
      mensagem: 'Pagamento recusado (simulação controlada)',
      modo: 'simulacao'
    });
  }

  if (pedido === 'pendente') {
    return tefContrato.criarRespostaAutorizacao({
      sucesso: false,
      status: tefContrato.STATUS.PENDENTE,
      mensagem: 'Pagamento pendente (simulação controlada)',
      modo: 'simulacao'
    });
  }

  return tefContrato.criarRespostaAutorizacao({
    sucesso: false,
    status: tefContrato.STATUS.ERRO,
    codigo: 'ERRO',
    mensagem: 'Erro na autorização (simulação controlada)',
    modo: 'simulacao'
  });
}

module.exports = {
  pedidoSimulado,
  respostaSimulada
};
