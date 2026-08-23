/**
 * Contratos da camada de impressão do comprovante (Sprint 04.12).
 */
'use strict';

const DESTINOS_IMPRESSAO = Object.freeze({
  PREVIEW: 'PREVIEW',
  BROWSER: 'BROWSER',
  THERMAL: 'THERMAL'
});

const LARGURAS_IMPRESSAO = Object.freeze([32, 40, 48]);

function erroImpressao(code, message, statusCode = 400) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

function normalizarDestino(valor) {
  const d = String(valor || '').trim().toUpperCase();
  if (!DESTINOS_IMPRESSAO[d]) {
    throw erroImpressao('DESTINO_IMPRESSAO_INVALIDO', `Destino de impressão inválido: ${valor}.`);
  }
  return d;
}

function formatoPadraoDoDestino(destino) {
  if (destino === DESTINOS_IMPRESSAO.BROWSER) return 'HTML';
  return 'TEXT';
}

function validarFormatoParaDestino(destino, formato) {
  if (destino === DESTINOS_IMPRESSAO.THERMAL && formato !== 'TEXT') {
    throw erroImpressao(
      'FORMATO_NAO_SUPORTADO_PARA_DESTINO',
      'THERMAL aceita somente TEXT nesta sprint.'
    );
  }
  return formato;
}

function validarLarguraImpressao(largura) {
  const n = largura == null ? 40 : Number(largura);
  if (!LARGURAS_IMPRESSAO.includes(n)) {
    throw erroImpressao('LARGURA_IMPRESSAO_INVALIDA', 'Largura deve ser 32, 40 ou 48.');
  }
  return n;
}

function metadataSegura(dto) {
  return {
    tipo: dto && dto.tipo ? dto.tipo : 'COMPROVANTE_UNIFICADO_ATENDIMENTO',
    codigo: dto && dto.atendimento ? dto.atendimento.codigo : null,
    status: dto && dto.atendimento ? dto.atendimento.status : null
  };
}

function montarPayloadImpressao({ dto, formato, conteudo }) {
  return Object.freeze({
    atendimento_id: dto.atendimento && dto.atendimento.id,
    formato,
    conteudo,
    titulo: 'COMPROVANTE DE ATENDIMENTO',
    metadata: metadataSegura(dto)
  });
}

module.exports = {
  DESTINOS_IMPRESSAO,
  LARGURAS_IMPRESSAO,
  erroImpressao,
  normalizarDestino,
  formatoPadraoDoDestino,
  validarFormatoParaDestino,
  validarLarguraImpressao,
  metadataSegura,
  montarPayloadImpressao
};
