/**
 * Autorização explícita de teste isolado — impossível de confundir com produção.
 * Não lê env, não persiste, não autoriza SOAP real.
 */
'use strict';

const {
  criarAutorizacaoTesteIsolado,
  anexarAutorizacaoTesteSefaz,
  anexarAutorizacaoTesteManifestacao,
  anexarAutorizacaoTesteCancelamento,
  TOKEN_TESTE_ISOLADO,
  MODO_TESTE_ISOLADO,
  TIPOS_MANIFESTACAO_SEFAZ,
  TIPOS_CANCELAMENTO_SEFAZ
} = require('../../../backend/services/fiscal/autorizacaoTransmissaoSefaz');

module.exports = {
  criarAutorizacaoTesteIsolado,
  anexarAutorizacaoTesteSefaz,
  anexarAutorizacaoTesteManifestacao,
  anexarAutorizacaoTesteCancelamento,
  TOKEN_TESTE_ISOLADO,
  MODO_TESTE_ISOLADO,
  TIPOS_MANIFESTACAO_SEFAZ,
  TIPOS_CANCELAMENTO_SEFAZ
};
