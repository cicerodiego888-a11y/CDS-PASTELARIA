/**
 * Adaptador EMPRESA_UNICA — reusa VendaApplicationService. Sem atendimento oculto.
 */
'use strict';

const { ModoOperacaoVenda } = require('../../muv/contratos');
const { resolverModoOperacaoVendaAtivo } = require('../../muv/modoOperacaoVenda');

const PORTA = 'VendaApplicationService.criarVenda';

function exigirModoEmpresaUnica(deps = {}) {
  const modo = resolverModoOperacaoVendaAtivo(deps);
  if (modo !== ModoOperacaoVenda.EMPRESA_UNICA) {
    const err = new Error(
      'Adaptador EMPRESA_UNICA recusado: o modo ativo não é EMPRESA_UNICA.'
    );
    err.code = 'MODO_OPERACAO_VENDA_INVALIDO';
    err.statusCode = 400;
    throw err;
  }
  return modo;
}

function criarVenda(req, res, deps = {}) {
  exigirModoEmpresaUnica(deps);
  const VendaApplicationService = deps.VendaApplicationService
    || require('../../../services/vendas/VendaApplicationService');
  return VendaApplicationService.criarVenda(req, res, deps);
}

module.exports = {
  PORTA,
  modo: ModoOperacaoVenda.EMPRESA_UNICA,
  criaAtendimento: false,
  criarVenda,
  exigirModoEmpresaUnica
};
