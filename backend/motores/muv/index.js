/**
 * Motor Universal de Vendas — 04.01–04.12 (impressão do comprovante).
 */
'use strict';

const contratos = require('./contratos');
const modoOperacaoVenda = require('./modoOperacaoVenda');
const atendimentoSchema = require('./atendimentoSchema');

module.exports = {
  ...contratos,
  ...modoOperacaoVenda,
  ...atendimentoSchema,
  get AtendimentoMultiempresaService() {
    return require('./AtendimentoMultiempresaService');
  },
  get FiscalizarAtendimentoService() {
    return require('./FiscalizarAtendimentoService');
  },
  get ComprovanteUnificadoAtendimentoService() {
    return require('./ComprovanteUnificadoAtendimentoService');
  },
  get ComprovanteRenderer() {
    return require('./comprovante/ComprovanteRenderer');
  },
  get ComprovantePrintService() {
    return require('./impressao/ComprovantePrintService');
  },
  /** MUV-CAP-01 — capacidade/seleção pura (somente leitura; sem integração PDV). */
  get ServicoCapacidadeCarrinhoEmpresa() {
    return require('./capacidade/ServicoCapacidadeCarrinhoEmpresa');
  },
  get selecionarEmpresaCapacidade() {
    return require('./capacidade/selecionarEmpresaCapacidade').selecionarEmpresaCapacidade;
  }
};
