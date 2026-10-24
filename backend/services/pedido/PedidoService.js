/**
 * PedidoService — criação e consulta de pedidos (base do Faturamento).
 * Sprint 3.1: não conclui venda.
 * RC3.16.1: confirmação fiscal via Motor Comercial antes de entrar na fila.
 */

'use strict';

const configService = require('../configuracaoService');
const { PedidoStatus } = require('./enums');
const repo = require('./PedidoRepository');
const PedidoOperacionalService = require('./PedidoOperacionalService');
const { empresaIdDoReqPedido } = require('./empresaIdDoReqPedido');
const {
  exigirEmpresaDaCriacao,
  exigirPedidoDaEmpresa
} = require('../pedidos/PedidoEmpresaContextoService');

function assertModuloHabilitado() {
  if (!configService.recursoHabilitado('faturamento')) {
    const err = new Error('Módulo Faturamento desabilitado.');
    err.statusCode = 404;
    err.codigo = 'MODULO_FATURAMENTO_DESABILITADO';
    throw err;
  }
}

async function listarFilaFaturamento(opcoes = {}) {
  assertModuloHabilitado();
  const empresaId = exigirEmpresaDaCriacao({
    empresaId: empresaIdDoReqPedido({ empresaId: opcoes.empresaId })
  });
  const itens = await repo.listarAguardandoFaturamento({ empresaId });
  return { success: true, itens };
}

async function obterPedido(pedidoId, opcoes = {}) {
  assertModuloHabilitado();
  const empresaId = exigirEmpresaDaCriacao({
    empresaId: empresaIdDoReqPedido({ empresaId: opcoes.empresaId })
  });
  const id = Number(pedidoId);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('Pedido inválido.');
    err.statusCode = 400;
    throw err;
  }
  const pedido = await repo.obterPorId(id);
  if (!pedido) {
    const err = new Error('Pedido não encontrado.');
    err.statusCode = 404;
    err.codigo = 'PEDIDO_NAO_ENCONTRADO';
    throw err;
  }
  exigirPedidoDaEmpresa(pedido, empresaId);
  return { success: true, pedido };
}

async function criarPedido(body = {}, operadorId = null, opcoes = {}) {
  assertModuloHabilitado();
  return PedidoOperacionalService.criar({
    ...body,
    status: PedidoStatus.AGUARDANDO_FATURAMENTO
  }, operadorId, opcoes);
}

module.exports = {
  listarFilaFaturamento,
  obterPedido,
  criarPedido,
  assertModuloHabilitado,
  empresaIdDoReqPedido
};
