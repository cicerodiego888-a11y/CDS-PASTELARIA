/**
 * Orquestra DTO 04.10 + renderer 04.11 + adaptador de impressão.
 */
'use strict';

const { renderizar } = require('../comprovante/ComprovanteRenderer');
const {
  DESTINOS_IMPRESSAO,
  normalizarDestino,
  formatoPadraoDoDestino,
  validarFormatoParaDestino,
  validarLarguraImpressao,
  montarPayloadImpressao,
  erroImpressao
} = require('./printContracts');
const { PreviewPrintAdapter } = require('./PreviewPrintAdapter');
const { BrowserPrintAdapter } = require('./BrowserPrintAdapter');
const { ThermalPrintAdapter } = require('./ThermalPrintAdapter');

function resolverPrintAdapter(destino, deps = {}) {
  const d = normalizarDestino(destino);
  if (deps.adapters && deps.adapters[d]) return deps.adapters[d];
  if (d === DESTINOS_IMPRESSAO.PREVIEW) return new PreviewPrintAdapter();
  if (d === DESTINOS_IMPRESSAO.BROWSER) return new BrowserPrintAdapter();
  if (d === DESTINOS_IMPRESSAO.THERMAL) return new ThermalPrintAdapter();
  throw erroImpressao('DESTINO_IMPRESSAO_INVALIDO', `Destino de impressão inválido: ${destino}.`);
}

async function imprimirComprovante(entrada = {}, deps = {}) {
  const atendimentoId = entrada.atendimentoId != null ? entrada.atendimentoId : entrada.atendimento_id;
  const destino = normalizarDestino(entrada.destino);
  const largura = validarLarguraImpressao(entrada.largura);
  const formatoBruto = entrada.formato || entrada.format || formatoPadraoDoDestino(destino);
  const formato = String(formatoBruto).trim().toUpperCase();
  validarFormatoParaDestino(destino, formato);

  const obter = typeof deps.obterComprovanteUnificado === 'function'
    ? deps.obterComprovanteUnificado
    : (id, opts) => require('../ComprovanteUnificadoAtendimentoService').obterComprovanteUnificado(id, opts);

  const dto = await obter(atendimentoId, { db: deps.db });
  const render = typeof deps.renderizar === 'function' ? deps.renderizar : renderizar;
  const saida = render(dto, { format: formato, largura });
  const payload = montarPayloadImpressao({
    dto,
    formato: saida.format,
    conteudo: saida.conteudo
  });

  const adapter = resolverPrintAdapter(destino, deps);
  const resultado = await adapter.imprimir(payload);
  return Object.freeze({
    ...resultado,
    atendimento_id: payload.atendimento_id,
    payload_formato: payload.formato
  });
}

module.exports = {
  imprimirComprovante,
  resolverPrintAdapter
};
