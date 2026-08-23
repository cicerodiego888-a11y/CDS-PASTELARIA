/**
 * Adaptador MULTIEMPRESA — ponto de integração com o MUV. Sem motor paralelo.
 */
'use strict';

const { ModoOperacaoVenda, STATUS_ATENDIMENTO } = require('../../muv/contratos');
const { resolverModoOperacaoVendaAtivo, executarNoModoOperacaoVenda } = require('../../muv/modoOperacaoVenda');
const { CICLO_MULTIEMPRESA } = require('../contratos');

const PORTA = 'AtendimentoMultiempresaService';

const ETAPAS = Object.freeze({
  criar: 'criarAtendimento',
  reservar: 'reservarAtendimento',
  pagar: 'confirmarPagamentoAtendimento',
  materializar: 'materializarAtendimento',
  fiscalizar: 'fiscalizarAtendimento',
  comprovante: 'obterComprovanteUnificado',
  obter: 'obterAtendimento'
});

function obterServico(deps = {}) {
  return deps.AtendimentoMultiempresaService
    || require('../../muv/AtendimentoMultiempresaService');
}

function exigirModoMultiempresa(deps = {}) {
  const modo = resolverModoOperacaoVendaAtivo(deps);
  if (modo !== ModoOperacaoVenda.MULTIEMPRESA) {
    const err = new Error(
      'Adaptador MULTIEMPRESA recusado: o modo ativo não é MULTIEMPRESA.'
    );
    err.code = 'MODO_OPERACAO_VENDA_INVALIDO';
    err.statusCode = 400;
    throw err;
  }
  return modo;
}

function reconhecer(deps = {}) {
  exigirModoMultiempresa(deps);
  return executarNoModoOperacaoVenda(ModoOperacaoVenda.MULTIEMPRESA, {
    EMPRESA_UNICA() {
      const err = new Error('MULTIEMPRESA não pode cair no fluxo legado.');
      err.code = 'MODO_OPERACAO_VENDA_INVALIDO';
      throw err;
    },
    MULTIEMPRESA() {
      return Object.freeze({
        porta: PORTA,
        fonte: 'MUV',
        criaVendaLegada: false,
        ciclo: CICLO_MULTIEMPRESA,
        etapas: ETAPAS,
        status: STATUS_ATENDIMENTO
      });
    }
  });
}

module.exports = {
  PORTA,
  ETAPAS,
  modo: ModoOperacaoVenda.MULTIEMPRESA,
  obterServico,
  exigirModoMultiempresa,
  reconhecer
};
