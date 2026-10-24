/**
 * Classificações da preparação offline de consulta por chave (consChNFe futuro).
 * São resultados locais — não confirmam disponibilidade na SEFAZ.
 *
 * @module motores/central-entradas/config/preparacaoConsultaChaveClassificacoes
 */

'use strict';

const CLASSIFICACOES_PREPARACAO_CHAVE = Object.freeze({
  CHAVE_INVALIDA: 'CHAVE_INVALIDA',
  EMPRESA_OBRIGATORIA: 'EMPRESA_OBRIGATORIA',
  CNPJ_NAO_CONFIGURADO: 'CNPJ_NAO_CONFIGURADO',
  AMBIENTE_NAO_CONFIGURADO: 'AMBIENTE_NAO_CONFIGURADO',
  CHAVE_INCOMPATIVEL_COM_EMPRESA: 'CHAVE_INCOMPATIVEL_COM_EMPRESA',
  DOCUMENTO_JA_EXISTE: 'DOCUMENTO_JA_EXISTE',
  ELEGIVEL_PARA_CONSULTA: 'ELEGIVEL_PARA_CONSULTA',
  PENDENTE_DE_REVISAO: 'PENDENTE_DE_REVISAO'
});

const ACOES_FUTURAS = Object.freeze({
  CORRIGIR_CHAVE: 'corrigir_chave',
  INFORMAR_EMPRESA: 'informar_empresa_id',
  CONFIGURAR_CNPJ: 'configurar_cnpj_da_empresa',
  CONFIGURAR_AMBIENTE: 'configurar_ambiente_fiscal',
  CONFERIR_EMPRESA: 'conferir_empresa_cnpj_ambiente',
  NAO_TRATAR_COMO_NOVO: 'nao_consultar_como_documento_novo',
  CONSCHNFE_AUTORIZADO: 'consChNFe_futuro_autorizado_sem_alterar_nsu',
  COMPLETAR_EVIDENCIAS: 'completar_evidencias_locais',
  CONFIGURAR_CERTIFICADO: 'configurar_certificado_da_empresa'
});

module.exports = {
  CLASSIFICACOES_PREPARACAO_CHAVE,
  ACOES_FUTURAS
};
