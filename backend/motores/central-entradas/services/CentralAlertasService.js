/**
 * CentralAlertasService — Geração de alertas inteligentes (somente leitura).
 *
 * @class CentralAlertasService
 */

const { obterMetaAlerta, pesoGravidade } = require('../config/centralAlertasTipos');
const { DocumentoFiscalStatus } = require('../core/DocumentoFiscalStatus');

/**
 * Escopo já autorizado pela sessão. Sem lista e sem id, a consulta fecha (não há fallback global).
 * @param {Object} [opcoes]
 * @returns {{ empresaIds?: number[], empresaId?: number }}
 */
function escopoEmpresaConsulta(opcoes = {}) {
  if (Array.isArray(opcoes.empresaIds)) return { empresaIds: opcoes.empresaIds };
  if (Array.isArray(opcoes.empresa_ids)) return { empresaIds: opcoes.empresa_ids };
  if (opcoes.empresaId != null && opcoes.empresaId !== '') return { empresaId: opcoes.empresaId };
  if (opcoes.empresa_id != null && opcoes.empresa_id !== '') return { empresaId: opcoes.empresa_id };
  return { empresaIds: [] };
}

class CentralAlertasService {
  /**
   * @param {Object} [deps]
   * @param {import('../repositories/CentralDocumentosRepository')} [deps.documentosRepository]
   * @param {import('../repositories/CentralNsuRepository')} [deps.nsuRepository]
   */
  constructor(deps = {}) {
    /** @private */
    this._documentosRepository = deps.documentosRepository
      ?? new (require('../repositories/CentralDocumentosRepository'))();
    /** @private */
    this._nsuRepository = deps.nsuRepository
      ?? new (require('../repositories/CentralNsuRepository'))();
  }

  /**
   * @param {Object} [opcoes] empresaId ou empresaIds já autorizados
   * @returns {Promise<{ total: number, alertas: Object[] }>}
   */
  async listarAlertas(opcoes = {}) {
    const escopo = escopoEmpresaConsulta(opcoes);
    const [
      fornecedoresNovos,
      duplicadas,
      valorAcimaMedia,
      revisaoParada,
      sincronizadasNaoProcessadas,
      comprasAbertas,
      erros,
      xmlInvalido
    ] = await Promise.all([
      this._documentosRepository.listarFornecedoresNovos(escopo),
      this._documentosRepository.listarPorStatus(DocumentoFiscalStatus.DUPLICADA, 50, escopo),
      this._documentosRepository.listarValorAcimaMediaFornecedor(2.0, 20, escopo),
      this._documentosRepository.listarRevisaoParada(3, 50, escopo),
      this._documentosRepository.listarSincronizadasNaoProcessadas(1, 50, escopo),
      this._documentosRepository.listarComprasAbertas(50, escopo),
      this._documentosRepository.listarPorStatus(DocumentoFiscalStatus.ERRO, 50, escopo),
      this._documentosRepository.listarXmlInvalido(50, escopo)
    ]);

    const alertas = [];

    if (fornecedoresNovos.length) {
      alertas.push(this._montarAlerta('FORNECEDOR_NOVO', fornecedoresNovos, (docs) => ({
        descricao: `${docs.length} fornecedor(es) com primeira nota na Central.`,
        documentoIds: docs.map((d) => d.id),
        fornecedores: docs.map((d) => ({
          cnpj: d.cnpjFornecedor,
          fornecedor: d.fornecedor,
          documentoId: d.id
        }))
      })));
    }

    if (duplicadas.length) {
      alertas.push(this._montarAlerta('NOTA_DUPLICADA', duplicadas, (docs) => ({
        descricao: `${docs.length} nota(s) duplicada(s) detectada(s).`,
        documentoIds: docs.map((d) => d.id)
      })));
    }

    if (valorAcimaMedia.length) {
      alertas.push(this._montarAlerta('VALOR_ACIMA_MEDIA', valorAcimaMedia, (docs) => ({
        descricao: `${docs.length} nota(s) com valor muito acima da média do fornecedor.`,
        documentoIds: docs.map((d) => d.id)
      })));
    }

    if (revisaoParada.length) {
      alertas.push(this._montarAlerta('REVISAO_PARADA', revisaoParada, (docs) => ({
        descricao: `${docs.length} documento(s) aguardando revisão há muitos dias.`,
        documentoIds: docs.map((d) => d.id)
      })));
    }

    if (sincronizadasNaoProcessadas.length) {
      alertas.push(this._montarAlerta('SINCRONIZADA_NAO_PROCESSADA', sincronizadasNaoProcessadas, (docs) => ({
        descricao: `${docs.length} nota(s) sincronizada(s) mas nunca processada(s).`,
        documentoIds: docs.map((d) => d.id)
      })));
    }

    if (comprasAbertas.length) {
      alertas.push(this._montarAlerta('COMPRA_ABERTA', comprasAbertas, (docs) => ({
        descricao: `${docs.length} compra(s) aberta(s) e não concluída(s).`,
        documentoIds: docs.map((d) => d.id)
      })));
    }

    if (erros.length) {
      alertas.push(this._montarAlerta('ERRO_PROCESSAMENTO', erros, (docs) => ({
        descricao: `${docs.length} documento(s) com erro de processamento.`,
        documentoIds: docs.map((d) => d.id)
      })));
    }

    if (xmlInvalido.length) {
      alertas.push(this._montarAlerta('XML_INVALIDO', xmlInvalido, (docs) => ({
        descricao: `${docs.length} documento(s) com XML inválido ou ilegível.`,
        documentoIds: docs.map((d) => d.id)
      })));
    }

    // O carimbo de NSU (obterUltimaSincronizacao) não tem empresa_id.
    // Não entra neste recorte: reutilizá-lo mostraria o sinal de sincronização de outra empresa.

    alertas.sort((a, b) => pesoGravidade(a.gravidade) - pesoGravidade(b.gravidade));

    return {
      total: alertas.reduce((acc, a) => acc + (a.quantidade || 0), 0),
      alertas
    };
  }

  /**
   * @private
   * @param {string} tipo
   * @param {Object[]} documentos
   * @param {Function} montarExtras
   * @returns {Object}
   */
  _montarAlerta(tipo, documentos, montarExtras) {
    const meta = obterMetaAlerta(tipo);
    const extras = montarExtras(documentos);

    return {
      ...meta,
      quantidade: documentos.length,
      ...extras,
      acaoSugerida: meta.acaoSugerida
    };
  }

}

module.exports = CentralAlertasService;
module.exports.escopoEmpresaConsulta = escopoEmpresaConsulta;
