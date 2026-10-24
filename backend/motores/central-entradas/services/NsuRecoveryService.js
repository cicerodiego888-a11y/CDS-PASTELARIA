/**
 * RC3.7.5.1 / RC3.7.5.2 — NsuRecoveryService
 *
 * Avalia o cursor informado em cStat 656 (Consumo Indevido) para auditoria.
 * Não avança ult_nsu/max_nsu: 656 não é DistDFe 137/138 com lote persistido.
 *
 * RC3.7.5.1 histórico (AUTO_SYNC quando remoto > local) foi revogado como
 * avanço automático — ver microsprint correção segura do cursor 656.
 *
 * RC3.7.5.2:
 * - params.ultNsu/maxNsu null → fallback XML (namespace-tolerant);
 * - nunca tratar ausência como zero fabricado;
 * - logar origem: Parser | Fallback XML | Ausente.
 *
 * @module motores/central-entradas/services/NsuRecoveryService
 */

'use strict';

const CentralNsuRepository = require('../repositories/CentralNsuRepository');
const {
  NSU_ZERADO,
  normalizarNsu,
  normalizarNsuOuZero,
  extrairNsuTagDoXml
} = require('../../../services/fiscal/dfeRetornoParser');
const { logOperacaoCentral } = require('../utils/centralOperacaoLog');
const { TIPOS_EVENTO, ORIGENS } = require('../config/centralEventosTipos');

/** Eventos já avaliados nesta execução do processo (anti-duplicação de auditoria). */
const _eventosProcessados = new Set();

const ORIGEM_NSU = Object.freeze({
  PARSER: 'Parser',
  FALLBACK_XML: 'Fallback XML',
  AUSENTE: 'Ausente'
});

const MOTIVOS_656 = Object.freeze({
  CSTAT_DIFERENTE: 'CSTAT_DIFERENTE',
  CONTROLE_AUSENTE: 'CONTROLE_AUSENTE',
  SEM_ULT_NSU: 'SEM_ULT_NSU',
  SEFAZ_NAO_MAIOR: 'SEFAZ_NAO_MAIOR',
  NSU_REMOTO_INCONSISTENTE: 'NSU_REMOTO_INCONSISTENTE',
  AVANCO_656_BLOQUEADO: 'AVANCO_656_BLOQUEADO',
  JA_PROCESSADO: 'JA_PROCESSADO'
});

function nsuNumerico(valor) {
  const normalizado = normalizarNsuOuZero(valor);
  return BigInt(normalizado.replace(/^0+(?=\d)/, '') || '0');
}

function nsuInformado(valor) {
  return valor != null && String(valor).trim() !== '';
}

function nsuEhZero(valor) {
  return nsuNumerico(valor) === 0n;
}

/**
 * Par DistDFe só é candidato a avanço em 137/138: max informado, não zero, max >= ult.
 * 656 nunca usa este predicado para persistir cursor.
 */
function parNsuConsistente(ult, max) {
  if (!ult || !max) return false;
  if (nsuEhZero(max)) return false;
  return nsuNumerico(max) >= nsuNumerico(ult);
}

function chaveEvento(correlationId, cnpj, ambiente, local, remoto) {
  if (correlationId) return `cid:${correlationId}`;
  return `nsu:${cnpj || ''}:${ambiente || ''}:${local}:${remoto}`;
}

/**
 * Resolve NSU a partir de param do parser ou fallback XML.
 * @returns {{ valor: string|null, origem: string, recuperadoDoXml: boolean }}
 */
function resolverNsu(paramValor, xml, tag) {
  if (nsuInformado(paramValor)) {
    return {
      valor: normalizarNsu(paramValor),
      origem: ORIGEM_NSU.PARSER,
      recuperadoDoXml: false
    };
  }
  const doXml = extrairNsuTagDoXml(xml, tag);
  if (doXml) {
    return {
      valor: doXml,
      origem: ORIGEM_NSU.FALLBACK_XML,
      recuperadoDoXml: true
    };
  }
  return {
    valor: null,
    origem: ORIGEM_NSU.AUSENTE,
    recuperadoDoXml: false
  };
}

class NsuRecoveryService {
  /**
   * @param {Object} [deps]
   */
  constructor(deps = {}) {
    this._repository = deps.nsuRepository
      ?? new CentralNsuRepository({ db: deps.db ?? null });
    this._agora = deps.agora || (() => new Date());
    this._emitirEvento = deps.emitirEvento || null;
    this._processados = deps.processados || _eventosProcessados;
  }

  /**
   * Avalia 656 sem persistir avanço de cursor.
   * @param {Object} params
   */
  async tentarRecuperar(params = {}) {
    const cStat = String(params.cStat || '');
    const controle = params.controle || null;
    const correlationId = params.correlationId || null;
    const xml = params.xmlRetorno || '';

    const base = {
      atualizou: false,
      motivo: null,
      nsuLocal: controle ? normalizarNsuOuZero(controle.ultNsu) : null,
      nsuRemoto: null,
      nsuAtualizado: null,
      maxNsuAtualizado: null,
      origemUltNsu: ORIGEM_NSU.AUSENTE,
      origemMaxNsu: ORIGEM_NSU.AUSENTE,
      controle: controle || null
    };

    if (cStat !== '656') {
      return { ...base, motivo: MOTIVOS_656.CSTAT_DIFERENTE };
    }

    if (!controle?.id) {
      return { ...base, motivo: MOTIVOS_656.CONTROLE_AUSENTE };
    }

    const resolucaoUlt = resolverNsu(params.ultNsu, xml, 'ultNSU');
    const resolucaoMax = resolverNsu(params.maxNsu, xml, 'maxNSU');
    base.origemUltNsu = resolucaoUlt.origem;
    base.origemMaxNsu = resolucaoMax.origem;
    base.nsuRemoto = resolucaoUlt.valor;

    this._logNsu({
      correlationId,
      nsuLocal: base.nsuLocal,
      nsuRemoto: resolucaoUlt.valor,
      atualizado: false,
      motivo: 'avaliacao',
      origem: resolucaoUlt.origem
    });

    if (!resolucaoUlt.valor || !resolucaoMax.valor) {
      this._logNsu({
        correlationId,
        nsuLocal: base.nsuLocal,
        nsuRemoto: resolucaoUlt.valor,
        atualizado: false,
        motivo: '656 sem ultNSU/maxNSU válidos — cursor preservado',
        origem: ORIGEM_NSU.AUSENTE
      });
      return { ...base, motivo: MOTIVOS_656.SEM_ULT_NSU };
    }

    if (resolucaoUlt.recuperadoDoXml || resolucaoMax.recuperadoDoXml) {
      await this._auditarFallbackXml({
        empresa: params.empresa || controle.cnpj || null,
        cnpj: controle.cnpj,
        ambiente: controle.ambiente,
        nsuRemoto: resolucaoUlt.valor,
        maxNsu: resolucaoMax.valor,
        correlationId,
        origemUltNsu: resolucaoUlt.origem,
        origemMaxNsu: resolucaoMax.origem
      });
    }

    const nsuRemoto = resolucaoUlt.valor;
    const maxRemoto = resolucaoMax.valor;
    const nsuLocal = normalizarNsuOuZero(controle.ultNsu);
    const maxLocal = normalizarNsuOuZero(controle.maxNsu);

    if (nsuNumerico(nsuRemoto) <= nsuNumerico(nsuLocal)) {
      this._logNsu({
        correlationId,
        nsuLocal,
        nsuRemoto,
        atualizado: false,
        motivo: 'SEFAZ <= local (sem alteração)',
        origem: resolucaoUlt.origem
      });
      return { ...base, motivo: MOTIVOS_656.SEFAZ_NAO_MAIOR, nsuLocal, nsuRemoto };
    }

    const parOk = parNsuConsistente(nsuRemoto, maxRemoto);
    const motivo = parOk
      ? MOTIVOS_656.AVANCO_656_BLOQUEADO
      : MOTIVOS_656.NSU_REMOTO_INCONSISTENTE;

    const chave = chaveEvento(
      correlationId,
      controle.cnpj,
      controle.ambiente,
      nsuLocal,
      nsuRemoto
    );
    if (this._processados.has(chave)) {
      return {
        ...base,
        motivo: MOTIVOS_656.JA_PROCESSADO,
        nsuLocal,
        nsuRemoto
      };
    }
    this._processados.add(chave);

    this._logNsu({
      correlationId,
      nsuLocal,
      nsuRemoto,
      atualizado: false,
      motivo: parOk
        ? '656 remoto > local — avanço bloqueado (exige 137/138 persistido)'
        : '656 maxNSU zero ou inconsistente — cursor preservado',
      origem: resolucaoUlt.origem
    });

    await this._auditarPreservacao({
      empresa: params.empresa || controle.cnpj || null,
      cnpj: controle.cnpj,
      ambiente: controle.ambiente,
      nsuLocal,
      nsuRemoto,
      maxLocal,
      maxNsu: maxRemoto,
      correlationId,
      motivo,
      origemUltNsu: resolucaoUlt.origem,
      origemMaxNsu: resolucaoMax.origem
    });

    logOperacaoCentral({
      correlationId,
      operacao: 'NSU_PRESERVAR_656',
      nsu: nsuLocal,
      cStat: '656',
      resultado: 'PRESERVADO',
      origem: 'NsuRecoveryService',
      detalhe: {
        nsuLocal,
        nsuRemoto,
        maxLocal,
        maxNsu: maxRemoto,
        motivo,
        origemUltNsu: resolucaoUlt.origem,
        origemMaxNsu: resolucaoMax.origem
      }
    });

    return {
      atualizou: false,
      motivo,
      nsuLocal,
      nsuRemoto,
      nsuAtualizado: nsuLocal,
      maxNsuAtualizado: maxLocal,
      origemUltNsu: resolucaoUlt.origem,
      origemMaxNsu: resolucaoMax.origem,
      controle
    };
  }

  statusDiagnostico(controle, recuperacao = null) {
    const nsuLocal = controle ? normalizarNsuOuZero(controle.ultNsu) : null;
    const ultimoCstat = controle?.ultimoCstat || null;
    const cooldownAtivo = Boolean(
      controle?.cooldownAte && new Date(controle.cooldownAte).getTime() > this._agora().getTime()
    );

    let status = 'Sincronizado';
    if (recuperacao?.atualizou) {
      status = 'Atualizado automaticamente';
    } else if (
      recuperacao?.motivo === MOTIVOS_656.AVANCO_656_BLOQUEADO
      || recuperacao?.motivo === MOTIVOS_656.NSU_REMOTO_INCONSISTENTE
    ) {
      status = 'Cursor preservado (656)';
    } else if (cooldownAtivo && String(ultimoCstat) === '656') {
      status = 'Aguardando cooldown';
    } else if (String(ultimoCstat) === '656') {
      status = 'Consumo indevido (656)';
    }

    return {
      nsuLocal,
      nsuSefaz: recuperacao?.nsuRemoto || controle?.maxNsu || null,
      ultimoCstat,
      status,
      cooldownAte: controle?.cooldownAte || null,
      recuperadoAutomaticamente: false,
      origemNsu: recuperacao?.origemUltNsu || null
    };
  }

  /** @private */
  _logNsu({ correlationId, nsuLocal, nsuRemoto, atualizado, motivo, origem, cooldownAte }) {
    if (motivo === 'avaliacao') {
      console.log([
        '[NSU]',
        `Origem: ${origem || ORIGEM_NSU.AUSENTE}`,
        `Local: ${nsuLocal ?? '—'}`,
        `Remoto: ${nsuRemoto ?? '—'}`,
        correlationId ? `CorrelationId: ${correlationId}` : null
      ].filter(Boolean).join('\n'));
      return;
    }

    const linhas = [
      '[NSU]',
      `Origem: ${origem || ORIGEM_NSU.AUSENTE}`,
      `Local: ${nsuLocal ?? '—'}`,
      `Remoto: ${nsuRemoto ?? '—'}`,
      `Atualizado: ${atualizado ? 'Sim' : 'Não'}`,
      `Motivo: ${motivo || '—'}`,
      `Cooldown: ${cooldownAte || '—'}`,
      `Data: ${this._agora().toISOString()}`,
      correlationId ? `CorrelationId: ${correlationId}` : null
    ].filter(Boolean);
    console.log(linhas.join('\n'));
  }

  logCooldown(dados = {}) {
    this._logNsu({
      correlationId: dados.correlationId,
      nsuLocal: dados.nsuLocal,
      nsuRemoto: dados.nsuRemoto,
      atualizado: false,
      motivo: dados.motivo || '656 Consumo Indevido — cursor preservado',
      origem: dados.origem || ORIGEM_NSU.AUSENTE,
      cooldownAte: dados.cooldownAte || null
    });
  }

  /** @private */
  async _auditarFallbackXml(dados) {
    try {
      const emitir = this._emitirEvento || require('../utils/centralEventosEmitter').emitirEvento;
      await emitir({
        tipo: TIPOS_EVENTO.NSU_RECOVERED_FROM_XML,
        origem: ORIGENS.SISTEMA,
        descricao: 'NSU obtido via fallback XML (namespace) após parser sem tag.',
        resultado: 'FALLBACK_XML',
        sucesso: true,
        detalhe: {
          categoria: 'NSU_RECOVERED_FROM_XML',
          empresa: dados.empresa,
          cnpj: dados.cnpj,
          ambiente: dados.ambiente,
          nsuRemoto: dados.nsuRemoto,
          maxNsu: dados.maxNsu,
          origemUltNsu: dados.origemUltNsu,
          origemMaxNsu: dados.origemMaxNsu,
          correlationId: dados.correlationId
        }
      });
    } catch (err) {
      console.warn('[NsuRecoveryService] Falha ao registrar NSU_RECOVERED_FROM_XML:', err.message);
    }
  }

  /** @private */
  async _auditarPreservacao(dados) {
    try {
      const emitir = this._emitirEvento || require('../utils/centralEventosEmitter').emitirEvento;
      await emitir({
        tipo: TIPOS_EVENTO.NSU_PRESERVADO_656,
        origem: ORIGENS.SISTEMA,
        descricao: 'Cursor NSU preservado após cStat 656 — avanço automático bloqueado.',
        resultado: 'PRESERVADO',
        sucesso: true,
        detalhe: {
          categoria: 'NSU_PRESERVADO_656',
          empresa: dados.empresa,
          cnpj: dados.cnpj,
          ambiente: dados.ambiente,
          nsuLocal: dados.nsuLocal,
          nsuRemoto: dados.nsuRemoto,
          nsuAtualizado: dados.nsuLocal,
          maxLocal: dados.maxLocal,
          maxNsu: dados.maxNsu,
          motivo: dados.motivo,
          origemUltNsu: dados.origemUltNsu,
          origemMaxNsu: dados.origemMaxNsu,
          correlationId: dados.correlationId,
          data: this._agora().toISOString(),
          mensagem: 'cStat 656 não avança ult_nsu/max_nsu. Recuperação de documentos exige 137/138 persistido ou consChNFe autorizado.'
        }
      });
    } catch (err) {
      console.warn('[NsuRecoveryService] Falha ao registrar NSU_PRESERVADO_656:', err.message);
    }
  }

  static limparCacheEventos() {
    _eventosProcessados.clear();
  }
}

NsuRecoveryService.nsuNumerico = nsuNumerico;
NsuRecoveryService.parNsuConsistente = parNsuConsistente;
NsuRecoveryService.MOTIVOS_656 = MOTIVOS_656;
NsuRecoveryService.ORIGEM_NSU = ORIGEM_NSU;
NsuRecoveryService.extrairNsuTagDoXml = extrairNsuTagDoXml;
NsuRecoveryService.NSU_ZERADO = NSU_ZERADO;

module.exports = NsuRecoveryService;
