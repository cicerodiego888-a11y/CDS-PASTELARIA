/**
 * Auditoria GO/NO-GO. Sem instituição oficial = NO-GO.
 * @module motores/bancario/providers/openfinance-real/auditoriaProntidao
 */
'use strict';

const {
  INSTITUICAO_OFICIAL,
  DOCUMENTACAO_OFICIAL_URL,
  providerRealPodeOperar,
  MSG_BLOQUEIO_OPERACAO_REAL
} = require('./prontidaoOperacaoReal');
const { RATE_LIMIT_PROVIDER } = require('./rateLimitProvider');
const { secretStoreProducaoDisponivel } = require('./prontidaoOperacaoReal');

const CLASSIFICACAO_ATUAL = 'PROVIDER REAL PREPARADO, MAS NÃO IMPLEMENTADO';
const DECISAO_ATUAL = 'NO-GO';

function decisaoGoNogo(params = {}) {
  const prontidao = providerRealPodeOperar(params);
  const bloqueios = [
    !INSTITUICAO_OFICIAL && 'Provider real não identificado.',
    !DOCUMENTACAO_OFICIAL_URL && 'Documentação oficial indisponível.',
    !prontidao.ok && 'Ambiente oficial indisponível ou pré-condições incompletas.',
    !secretStoreProducaoDisponivel() && 'SecretStore de produção inexistente.',
    RATE_LIMIT_PROVIDER.status === 'PENDENTE' && 'Rate limit oficial desconhecido.'
  ].filter(Boolean);

  return {
    decisao: DECISAO_ATUAL,
    classificacao: CLASSIFICACAO_ATUAL,
    producao: 'BLOQUEADA',
    mensagem: MSG_BLOQUEIO_OPERACAO_REAL,
    pode_operar: false,
    bloqueios,
    prontidao
  };
}

module.exports = {
  CLASSIFICACAO_ATUAL,
  DECISAO_ATUAL,
  decisaoGoNogo
};
