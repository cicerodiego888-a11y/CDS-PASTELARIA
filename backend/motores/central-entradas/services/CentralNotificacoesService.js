/**
 * CentralNotificacoesService — Notificações internas do ERP.
 *
 * RC1: uma notificação consolidada por sincronização.
 *
 * @class CentralNotificacoesService
 */

const CentralNotificacoesRepository = require('../repositories/CentralNotificacoesRepository');

const TIPOS_NOTIFICACAO = Object.freeze({
  NOVAS_NOTAS: 'NOVAS_NOTAS',
  SYNC_CONCLUIDA: 'SYNC_CONCLUIDA',
  SYNC_ERRO: 'SYNC_ERRO',
  SYNC_CONSULTA_NAO_ENVIADA: 'SYNC_CONSULTA_NAO_ENVIADA',
  PRONTA_COMPRA: 'PRONTA_COMPRA',
  COMPRA_GRAVADA: 'COMPRA_GRAVADA',
  ERRO: 'ERRO'
});

/** DistDFe de produção off — estado normal; não deve alarmar o operador. */
function ehAvisoOperacaoFiscalRealDesabilitada(opcoes = {}) {
  const codigo = String(opcoes.codigo || opcoes.code || '').toUpperCase();
  if (
    codigo === 'OPERACAO_REAL_DESABILITADA'
    || codigo === 'DISTDFE_AUTOMATICO_DESABILITADO'
  ) {
    return true;
  }
  const texto = `${opcoes.mensagem || ''} ${opcoes.mensagemAmigavel || ''} ${opcoes.titulo || ''}`;
  return /opera[cç][aã]o fiscal real desabilitada/i.test(texto)
    || /DistDFe autom[aá]tico bloqueado/i.test(texto);
}

class CentralNotificacoesService {
  /**
   * @param {Object} [deps]
   */
  constructor(deps = {}) {
    /** @private */
    this._repository = deps.notificacoesRepository ?? new CentralNotificacoesRepository();
  }

  async criar(dados) {
    return this.criarPadrao(dados);
  }

  /**
   * Padrão visual único de notificação (RC3).
   * @param {Object} dados
   * @returns {Promise<Object>}
   */
  async criarPadrao(dados = {}) {
    return this._repository.inserir({
      tipo: dados.tipo || TIPOS_NOTIFICACAO.ERRO,
      titulo: dados.titulo || 'Central de Entradas',
      mensagem: dados.mensagem || '',
      documentoId: dados.documentoId ?? dados.documento_id ?? null,
      lida: Boolean(dados.lida)
    });
  }

  async listar(filtros = {}) {
    return this._repository.listar(filtros);
  }

  async contarNaoLidas() {
    return this._repository.contarNaoLidas();
  }

  async marcarLida(id) {
    return this._repository.marcarLida(id);
  }

  async marcarTodasLidas() {
    return this._repository.marcarTodasLidas();
  }

  /**
   * Notificação única consolidada por sincronização.
   *
   * @param {Object} opcoes
   * @returns {Promise<Object|null>}
   */
  async notificarSyncConcluida(opcoes = {}) {
    const { notasNovas = 0, sucesso = true, mensagem, origem } = opcoes;
    const consultaNaoEnviada = opcoes.consultaExecutada === false || opcoes.ignorado === true;
    // Estado esperado (sem DistDFe de produção): não gera toast/alarme ao abrir a Central.
    if (ehAvisoOperacaoFiscalRealDesabilitada(opcoes)) {
      return null;
    }

    // Cooldown / fila esgotada / Gate: estado operacional esperado — não gera toast.
    // O operador confundia com erro do sistema (avisos amarelos na Central).
    if (!sucesso && consultaNaoEnviada) {
      return null;
    }

    if (!sucesso) {
      return this.criar({
        tipo: TIPOS_NOTIFICACAO.SYNC_ERRO,
        titulo: 'Erro na sincronização',
        mensagem: mensagem || 'Falha na sincronização SEFAZ.'
      });
    }

    if (notasNovas > 0 && opcoes.notificarNovas !== false) {
      const texto = notasNovas === 1
        ? '1 nova nota fiscal foi recebida.'
        : `${notasNovas} novas notas fiscais foram recebidas.`;

      return this.criar({
        tipo: TIPOS_NOTIFICACAO.NOVAS_NOTAS,
        titulo: 'Novas notas na Central',
        mensagem: texto
      });
    }

    return this.criar({
      tipo: TIPOS_NOTIFICACAO.SYNC_CONCLUIDA,
      titulo: 'Sincronização concluída',
      mensagem: mensagem || `Sincronização ${origem || ''} finalizada — nenhuma nota nova.`.trim()
    });
  }
}

CentralNotificacoesService.TIPOS = TIPOS_NOTIFICACAO;

module.exports = CentralNotificacoesService;
