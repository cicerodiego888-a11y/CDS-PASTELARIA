/**
 * Fachada de renderização do comprovante unificado (Sprint 04.11).
 * Entrada: DTO 04.10. Sem banco. Sem fiscal.
 */
'use strict';

const { TIPO_COMPROVANTE } = require('../ComprovanteUnificadoAtendimentoService');
const texto = require('./ComprovanteTextoRenderer');
const html = require('./ComprovanteHtmlRenderer');

const FORMATOS = Object.freeze({
  TEXT: 'TEXT',
  HTML: 'HTML'
});

function erroRender(code, message, statusCode = 400) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

function normalizarFormato(valor) {
  if (valor == null || valor === '') return null;
  const f = String(valor).trim().toUpperCase();
  if (f === 'TEXT' || f === 'TXT' || f === 'PLAIN') return FORMATOS.TEXT;
  if (f === 'HTML') return FORMATOS.HTML;
  throw erroRender('COMPROVANTE_FORMATO_INVALIDO', `Formato de comprovante inválido: ${valor}.`);
}

function validarDto(dto) {
  if (!dto || typeof dto !== 'object') {
    throw erroRender('COMPROVANTE_DTO_INVALIDO', 'DTO do comprovante é obrigatório.');
  }
  if (dto.tipo !== TIPO_COMPROVANTE) {
    throw erroRender('COMPROVANTE_DTO_INVALIDO', 'tipo deve ser COMPROVANTE_UNIFICADO_ATENDIMENTO.');
  }
  if (!dto.atendimento || typeof dto.atendimento !== 'object') {
    throw erroRender('COMPROVANTE_DTO_INVALIDO', 'DTO sem atendimento.');
  }
  if (!Array.isArray(dto.itens)) {
    throw erroRender('COMPROVANTE_DTO_INVALIDO', 'DTO sem itens.');
  }
  if (!dto.totais || typeof dto.totais !== 'object') {
    throw erroRender('COMPROVANTE_DTO_INVALIDO', 'DTO sem totais.');
  }
  if (!dto.pagamento || typeof dto.pagamento !== 'object') {
    throw erroRender('COMPROVANTE_DTO_INVALIDO', 'DTO sem pagamento.');
  }
  for (const it of dto.itens) {
    if (!it || it.quantidade == null || it.valorTotal == null) {
      throw erroRender('COMPROVANTE_DTO_INVALIDO', 'Item sem quantidade/valorTotal.');
    }
  }
  return dto;
}

function normalizarOpcoes(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const format = normalizarFormato(opts.format || opts.formato);
  if (!format) {
    throw erroRender('COMPROVANTE_FORMATO_INVALIDO', 'format é obrigatório (TEXT ou HTML).');
  }
  return {
    format,
    largura: opts.largura == null ? 40 : Number(opts.largura),
    incluirDocumentosFiscais: opts.incluirDocumentosFiscais !== false,
    incluirMensagemFinal: opts.incluirMensagemFinal !== false
  };
}

function renderizar(dto, options) {
  const valido = validarDto(dto);
  const opts = normalizarOpcoes(options);
  const conteudo = opts.format === FORMATOS.HTML
    ? html.renderizarHtml(valido, opts)
    : texto.renderizarTexto(valido, opts);
  return Object.freeze({
    format: opts.format,
    conteudo,
    contentType: opts.format === FORMATOS.HTML ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8'
  });
}

function resolverSaidaHttp(dto, query = {}) {
  const raw = query.formato != null ? query.formato : query.format;
  if (raw == null || String(raw).trim() === '') {
    return Object.freeze({ kind: 'json', body: dto, contentType: 'application/json' });
  }
  const saida = renderizar(dto, { format: raw, largura: query.largura });
  return Object.freeze({
    kind: saida.format.toLowerCase(),
    body: saida.conteudo,
    contentType: saida.contentType
  });
}

module.exports = {
  FORMATOS,
  renderizar,
  validarDto,
  resolverSaidaHttp
};
