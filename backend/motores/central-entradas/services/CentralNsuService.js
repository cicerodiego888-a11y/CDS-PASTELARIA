/**
 * CentralNsuService — Único ponto oficial de atualização de ultNSU/maxNSU (RC3.3.3).
 *
 * Regras:
 * - nunca persistir ultNSU/maxNSU inválidos ou zerados após já haver progresso;
 * - nunca regredir ultNSU;
 * - cStat 656: preserva NSU + cooldown; NÃO avança cursor (mesmo se o XML/parser
 *   informar ultNSU remoto maior). A avaliação RC3.7.5.1 permanece só como auditoria;
 * - somente atualiza NSU após resposta DistDFe válida (137/138) com par
 *   ultNSU/maxNSU consistente e persistência de documentos concluída pelo caller.
 *
 * @module motores/central-entradas/services/CentralNsuService
 */

const CentralNsuRepository = require('../repositories/CentralNsuRepository');
const NsuRecoveryService = require('./NsuRecoveryService');
const {
  NSU_ZERADO,
  normalizarNsu,
  normalizarNsuOuZero,
  extrairNsuTagDoXml
} = require('../../../services/fiscal/dfeRetornoParser');
const { logOperacaoCentral } = require('../utils/centralOperacaoLog');

const INTERVALO_COOLDOWN_MS = 60 * 60 * 1000;
const CSTAT_COM_NSU = new Set(['137', '138']);
/**
 * Evidência local de fila esgotada / topo do cursor (NT 2014.002 + CE):
 * - 137: nenhum documento localizado;
 * - 138: documento(s) localizado(s) e persistidos, com ultNSU=maxNSU (cursor no topo);
 * - 656: consumo indevido — NSU preservado; cooldown_ate explícito de 1 h tem prioridade.
 *
 * Bloqueio FILA_ESGOTADA dura INTERVALO_COOLDOWN_MS (1 h) a partir de data_sincronizacao.
 * Após essa janela, nova DistNSU é permitida: a SEFAZ pode ter recebido documentos novos
 * (maxNSU remoto > local). Liberação operacional (`FILA_LIBERADA_OP`) antecipa a janela.
 * Sticky permanente foi removido — causava deadlock (nunca reconsulta → cursor nunca avança).
 */
const CSTAT_FILA_ESGOTADA = new Set(['137', '138', '656']);
/** Marcador persistido em ultimo_cstat após liberação operacional autorizada (não é cStat SEFAZ). */
const CSTAT_FILA_LIBERADA_OPERACIONAL = 'FILA_LIBERADA_OP';

function nsuNumerico(valor) {
  const normalizado = normalizarNsuOuZero(valor);
  return BigInt(normalizado.replace(/^0+(?=\d)/, '') || '0');
}

function nsuPresenteNoXml(xml, tag) {
  return extrairNsuTagDoXml(xml, tag) != null;
}

/**
 * Mensagem de bloqueio: a consulta não foi enviada.
 * Inclui o horário de liberação quando o estado local o conhece.
 * @param {Object} [cooldown]
 * @returns {string}
 */
function formatarLiberacaoCooldown(iso) {
  if (!iso) return 'após a janela de 1 hora';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' });
  } catch {
    return String(iso);
  }
}

function montarMensagemCooldown(cooldown = {}) {
  const liberacao = cooldown.proximaConsultaEm
    ? formatarLiberacaoCooldown(cooldown.proximaConsultaEm)
    : 'após a janela de reavaliação';
  if (cooldown.motivo === 'ESTADO_NSU_INCONSISTENTE') {
    return 'Consulta DF-e não enviada à SEFAZ: estado NSU inconsistente ou incompleto '
      + '(fail-closed). Corrija o cursor/controle antes de nova transmissão.';
  }
  if (cooldown.motivo === 'FILA_ESGOTADA') {
    const liberacao = cooldown.proximaConsultaEm
      ? formatarLiberacaoCooldown(cooldown.proximaConsultaEm)
      : 'após a janela de 1 hora';
    return 'Consulta DF-e não enviada à SEFAZ: evidência local de fila esgotada '
      + '(ultNSU = maxNSU após cStat 137/138/656). '
      + `Nova DistNSU a partir de ${liberacao} (NT 2014.002). `
      + 'Liberação operacional autorizada antecipa a janela. '
      + 'Documentos já recebidos permanecem na lista.';
  }
  return 'Consulta DF-e não enviada à SEFAZ: cooldown por CNPJ (cStat 656 / NT 2014.002). '
    + `Nova consulta a partir de ${liberacao}.`;
}

class CentralNsuService {
  /**
   * @param {Object} [deps]
   */
  constructor(deps = {}) {
    this._repository = deps.nsuRepository
      ?? new CentralNsuRepository({ db: deps.db ?? null });
    this._agora = deps.agora || (() => new Date());
    this._emitirEventoObrigatorio = deps.emitirEventoObrigatorio || null;
    this._eventosRepository = deps.eventosRepository || null;
    this._recovery = deps.nsuRecovery
      ?? new NsuRecoveryService({
        nsuRepository: this._repository,
        agora: this._agora,
        emitirEvento: deps.emitirEvento
      });
  }

  /** Expõe o repositório para callers que só leem. */
  get repository() {
    return this._repository;
  }

  obterOuCriar(cnpj, ambiente) {
    return this._repository.obterOuCriar(cnpj, ambiente);
  }

  buscarPorCnpjAmbiente(cnpj, ambiente) {
    return this._repository.buscarPorCnpjAmbiente(cnpj, ambiente);
  }

  obterUltimaSincronizacao() {
    return this._repository.obterUltimaSincronizacao();
  }

  /**
   * Aplica retorno DistDFe com regras de hardening.
   *
   * @param {Object} params
   * @param {Object} params.controle Controle atual (id, ultNsu, maxNsu)
   * @param {string} params.cStat
   * @param {string} [params.xmlRetorno]
   * @param {string} [params.ultNsu]
   * @param {string} [params.maxNsu]
   * @param {string} [params.correlationId]
   * @returns {Promise<{ controle: Object, atualizouNsu: boolean, preservado: boolean, cooldownAtivo: boolean, proximaConsultaEm: string|null }>}
   */
  async aplicarRetornoDistDfe(params = {}) {
    const controle = params.controle;
    if (!controle?.id) {
      throw new Error('Controle NSU é obrigatório para aplicar retorno DistDFe.');
    }

    const cStat = String(params.cStat || '');
    const xml = params.xmlRetorno || '';
    const correlationId = params.correlationId || null;
    const agora = this._agora();

    if (cStat === '656') {
      const cooldownAte = new Date(agora.getTime() + INTERVALO_COOLDOWN_MS);
      const cooldownIso = cooldownAte.toISOString();

      // 656: avalia discrepância remota só para auditoria. Nunca avança o cursor.
      const recuperacao = await this._recovery.tentarRecuperar({
        controle,
        cStat: '656',
        xmlRetorno: xml,
        ultNsu: params.ultNsu,
        maxNsu: params.maxNsu,
        correlationId,
        empresa: params.empresa || controle.cnpj || null,
        cnpj: controle.cnpj
      });

      const controleBase = recuperacao.controle || controle;
      const atualizado = await this._repository.atualizarSincronizacaoSegura(controleBase.id, {
        preservarNsu: true,
        ultimoCstat: '656',
        cooldownAte: cooldownIso,
        dataSincronizacao: agora.toISOString()
      });

      this._recovery.logCooldown({
        correlationId,
        nsuLocal: recuperacao.nsuLocal || (atualizado || controleBase).ultNsu,
        nsuRemoto: recuperacao.nsuRemoto,
        atualizado: false,
        motivo: recuperacao.motivo || '656 Consumo Indevido — cursor preservado',
        origem: recuperacao.origemUltNsu,
        cooldownAte: cooldownIso
      });

      logOperacaoCentral({
        correlationId,
        operacao: 'NSU_PRESERVAR_656',
        nsu: (atualizado || controleBase).ultNsu,
        cStat: '656',
        resultado: 'PRESERVADO',
        origem: 'CentralNsuService',
        detalhe: {
          nsuLocal: recuperacao.nsuLocal,
          nsuRemoto: recuperacao.nsuRemoto,
          motivo: recuperacao.motivo,
          cooldownAte: cooldownIso,
          cnpj: controle.cnpj,
          ambiente: controle.ambiente
        }
      });

      return {
        controle: atualizado || controleBase,
        atualizouNsu: false,
        preservado: true,
        recuperacaoNsu: recuperacao,
        cooldownAtivo: true,
        proximaConsultaEm: cooldownIso,
        ultNsu: (atualizado || controleBase).ultNsu,
        maxNsu: (atualizado || controleBase).maxNsu
      };
    }

    const temUlt = nsuPresenteNoXml(xml, 'ultNSU') || Boolean(params.ultNsuRaw) || params.ultNsu != null;
    const temMax = nsuPresenteNoXml(xml, 'maxNSU') || Boolean(params.maxNsuRaw) || params.maxNsu != null;
    const candidataUlt = normalizarNsu(params.ultNsu) || extrairNsuTagDoXml(xml, 'ultNSU');
    const candidataMax = normalizarNsu(params.maxNsu) || extrairNsuTagDoXml(xml, 'maxNSU');
    const atualUlt = normalizarNsuOuZero(controle.ultNsu);
    const atualMax = normalizarNsuOuZero(controle.maxNsu);

    if (!CSTAT_COM_NSU.has(cStat) || !temUlt || !temMax || !candidataUlt || !candidataMax) {
      const atualizado = await this._repository.atualizarSincronizacaoSegura(controle.id, {
        preservarNsu: true,
        manterDataSincronizacao: true,
        ultimoCstat: cStat || null
      });
      return {
        controle: atualizado || controle,
        atualizouNsu: false,
        preservado: true,
        cooldownAtivo: false,
        proximaConsultaEm: null,
        ultNsu: atualUlt,
        maxNsu: atualMax
      };
    }

    // Nunca regredir: só avança se novo ult >= atual.
    if (nsuNumerico(candidataUlt) < nsuNumerico(atualUlt)) {
      const atualizado = await this._repository.atualizarSincronizacaoSegura(controle.id, {
        preservarNsu: true,
        manterDataSincronizacao: true,
        ultimoCstat: cStat
      });
      logOperacaoCentral({
        correlationId,
        operacao: 'NSU_REJEITAR_REGRESSAO',
        nsu: atualUlt,
        cStat,
        resultado: 'PRESERVADO',
        origem: 'CentralNsuService',
        detalhe: { candidataUlt, candidataMax }
      });
      return {
        controle: atualizado || controle,
        atualizouNsu: false,
        preservado: true,
        cooldownAtivo: false,
        proximaConsultaEm: null,
        ultNsu: atualUlt,
        maxNsu: atualMax
      };
    }

    // Evita gravar zeros ou par inconsistente (max < ult / max=0) após progresso real.
    if (
      (candidataUlt === NSU_ZERADO && atualUlt !== NSU_ZERADO)
      || (candidataMax === NSU_ZERADO && atualMax !== NSU_ZERADO)
      || nsuNumerico(candidataMax) < nsuNumerico(candidataUlt)
    ) {
      const atualizado = await this._repository.atualizarSincronizacaoSegura(controle.id, {
        preservarNsu: true,
        manterDataSincronizacao: true,
        ultimoCstat: cStat
      });
      logOperacaoCentral({
        correlationId,
        operacao: 'NSU_REJEITAR_PAR_INCONSISTENTE',
        nsu: atualUlt,
        cStat,
        resultado: 'PRESERVADO',
        origem: 'CentralNsuService',
        detalhe: { candidataUlt, candidataMax, atualUlt, atualMax }
      });
      return {
        controle: atualizado || controle,
        atualizouNsu: false,
        preservado: true,
        cooldownAtivo: false,
        proximaConsultaEm: null,
        ultNsu: atualUlt,
        maxNsu: atualMax
      };
    }

    const atualizado = await this._repository.atualizarSincronizacaoSegura(controle.id, {
      ultNsu: candidataUlt,
      maxNsu: candidataMax,
      ultimoCstat: cStat,
      cooldownAte: null,
      dataSincronizacao: agora.toISOString()
    });

    logOperacaoCentral({
      correlationId,
      operacao: 'NSU_ATUALIZAR',
      nsu: candidataUlt,
      cStat,
      resultado: 'OK',
      origem: 'CentralNsuService',
      detalhe: { maxNsu: candidataMax }
    });

    return {
      controle: atualizado,
      atualizouNsu: true,
      preservado: false,
      cooldownAtivo: false,
      proximaConsultaEm: null,
      ultNsu: candidataUlt,
      maxNsu: candidataMax
    };
  }

  /**
   * Avalia bloqueios locais pré-DistDFe (cooldown explícito vs fila esgotada).
   *
   * Distinção:
   * - COOLDOWN_EXPLICITO: `cooldown_ate` do cStat 656 (1 h) — intacto;
   * - FILA_ESGOTADA: ultNSU=maxNSU + último cStat ∈ {137,138,656} — janela de 1 h
   *   a partir de data_sincronizacao (NT 2014.002); depois libera DistNSU;
   *   FILA_LIBERADA_OP antecipa; ult≠max também libera;
   * - ESTADO_NSU_INCONSISTENTE: dados ausentes/contraditórios → fail-closed.
   *
   * @param {Object|null} controle
   * @returns {{ ativo: boolean, proximaConsultaEm?: string|null, motivo?: string, ultNsu?: string, maxNsu?: string }}
   */
  avaliarCooldown(controle) {
    if (!controle) return { ativo: false };

    const agora = this._agora().getTime();
    const ultNsu = normalizarNsuOuZero(controle.ultNsu);
    const maxNsu = normalizarNsuOuZero(controle.maxNsu);
    const ultimoCstat = String(controle.ultimoCstat || controle.ultimo_cstat || '');

    if (controle.cooldownAte) {
      const ate = new Date(controle.cooldownAte).getTime();
      if (!Number.isNaN(ate) && agora < ate) {
        return {
          ativo: true,
          motivo: 'COOLDOWN_EXPLICITO',
          proximaConsultaEm: new Date(ate).toISOString(),
          ultNsu,
          maxNsu
        };
      }
    }

    // Fail-closed: cursor incoerente (ult > max) nunca libera transmissão.
    try {
      if (nsuNumerico(ultNsu) > nsuNumerico(maxNsu)) {
        return {
          ativo: true,
          motivo: 'ESTADO_NSU_INCONSISTENTE',
          proximaConsultaEm: null,
          ultNsu,
          maxNsu,
          detalhe: { razao: 'ult_maior_que_max' }
        };
      }
    } catch {
      return {
        ativo: true,
        motivo: 'ESTADO_NSU_INCONSISTENTE',
        proximaConsultaEm: null,
        ultNsu: controle.ultNsu,
        maxNsu: controle.maxNsu,
        detalhe: { razao: 'nsu_nao_parseavel' }
      };
    }

    const cursorNoTopo = ultNsu === maxNsu;
    if (cursorNoTopo && CSTAT_FILA_ESGOTADA.has(ultimoCstat)) {
      if (!controle.dataSincronizacao) {
        return {
          ativo: true,
          motivo: 'ESTADO_NSU_INCONSISTENTE',
          proximaConsultaEm: null,
          ultNsu,
          maxNsu,
          detalhe: { razao: 'fila_sem_data_sincronizacao', ultimoCstat }
        };
      }
      const ultima = new Date(controle.dataSincronizacao).getTime();
      if (Number.isNaN(ultima)) {
        return {
          ativo: true,
          motivo: 'ESTADO_NSU_INCONSISTENTE',
          proximaConsultaEm: null,
          ultNsu,
          maxNsu,
          detalhe: { razao: 'data_sincronizacao_invalida', ultimoCstat }
        };
      }
      const proxima = ultima + INTERVALO_COOLDOWN_MS;
      if (agora < proxima) {
        return {
          ativo: true,
          motivo: 'FILA_ESGOTADA',
          proximaConsultaEm: new Date(proxima).toISOString(),
          ultNsu,
          maxNsu,
          detalhe: {
            ultimoCstat,
            sticky: false,
            janelaMs: INTERVALO_COOLDOWN_MS,
            reavaliacao: 'timer_1h_ou_liberacao_operacional'
          }
        };
      }
    }

    return { ativo: false, ultNsu, maxNsu };
  }

  /**
   * Liberação operacional explícita da FILA_ESGOTADA (não envia SOAP, não altera NSU).
   * Exige confirmação + autorização; não contorna cooldown_ate ativo.
   *
   * @param {Object} params
   * @returns {Promise<Object>}
   */
  async liberarFilaEsgotadaAutorizada(params = {}) {
    const controle = params.controle;
    if (!controle?.id) {
      throw new Error('Controle NSU é obrigatório para liberar fila esgotada.');
    }
    if (params.confirmacaoLiberacaoFila !== true) {
      const err = new Error(
        'Liberação de fila esgotada exige confirmacaoLiberacaoFila=true (procedimento auditado).'
      );
      err.code = 'CONFIRMACAO_LIBERACAO_FILA_OBRIGATORIA';
      throw err;
    }
    if (!params.autorizacao || !params.autorizacao.modo) {
      const err = new Error(
        'Liberação de fila esgotada exige autorização operacional explícita.'
      );
      err.code = 'AUTORIZACAO_AUSENTE';
      throw err;
    }

    const cooldown = this.avaliarCooldown(controle);
    if (cooldown.ativo && cooldown.motivo === 'COOLDOWN_EXPLICITO') {
      const err = new Error(
        'Cooldown explícito 656 ainda ativo — liberação de fila não contorna o cooldown de 1 h.'
      );
      err.code = 'COOLDOWN_EXPLICITO_ATIVO';
      err.proximaConsultaEm = cooldown.proximaConsultaEm;
      throw err;
    }

    const correlationId = params.correlationId
      || `fila-lib-${params.empresaId || 'x'}-${controle.cnpj}-${controle.ambiente}-${Date.now()}`;
    const cstatAnterior = controle.ultimoCstat || controle.ultimo_cstat || null;
    const { TIPOS_EVENTO } = require('../config/centralEventosTipos');

    // Idempotência: mesma correlação já registrada → não duplica evento nem regrava.
    const eventosRepo = this._obterEventosRepository();
    if (eventosRepo && typeof eventosRepo.buscarPorTipoECorrelationId === 'function') {
      const existente = await eventosRepo.buscarPorTipoECorrelationId(
        TIPOS_EVENTO.FILA_ESGOTADA_LIBERACAO_OP,
        correlationId
      );
      if (existente) {
        return {
          sucesso: true,
          jaLiberada: true,
          eventoDuplicadoEvitado: true,
          eventoId: existente.id,
          controle,
          ultNsu: controle.ultNsu,
          maxNsu: controle.maxNsu,
          ultimoCstat: controle.ultimoCstat || controle.ultimo_cstat || CSTAT_FILA_LIBERADA_OPERACIONAL,
          consultaExecutada: false,
          sefazConsultada: false,
          correlationId,
          mensagem: 'Liberação já registrada para esta correlação. Nenhuma consulta SEFAZ foi enviada.'
        };
      }
    }

    // Já liberada localmente: devolve sucesso sem segundo evento (anti-duplo clique).
    if (String(cstatAnterior) === CSTAT_FILA_LIBERADA_OPERACIONAL) {
      return {
        sucesso: true,
        jaLiberada: true,
        controle,
        ultNsu: controle.ultNsu,
        maxNsu: controle.maxNsu,
        ultimoCstat: CSTAT_FILA_LIBERADA_OPERACIONAL,
        consultaExecutada: false,
        sefazConsultada: false,
        correlationId,
        mensagem: 'Fila já estava liberada localmente. NSU preservado. Nenhuma consulta SEFAZ foi enviada.'
      };
    }

    const atualizado = await this._repository.atualizarSincronizacaoSegura(controle.id, {
      preservarNsu: true,
      manterDataSincronizacao: true,
      ultimoCstat: CSTAT_FILA_LIBERADA_OPERACIONAL,
      cooldownAte: controle.cooldownAte || null
    });

    const detalheEvento = {
      empresaId: params.empresaId || null,
      cnpj: controle.cnpj,
      ambiente: controle.ambiente,
      origem: params.origem || 'liberacao_admin_central',
      usuarioId: params.usuarioId || null,
      motivo: params.motivo || 'liberacao_operacional_autorizada',
      estadoAnterior: { ultimoCstat: cstatAnterior, ultNsu: controle.ultNsu, maxNsu: controle.maxNsu },
      estadoPosterior: {
        ultimoCstat: CSTAT_FILA_LIBERADA_OPERACIONAL,
        ultNsu: (atualizado || controle).ultNsu,
        maxNsu: (atualizado || controle).maxNsu
      },
      correlationId,
      resultado: 'LIBERADO_LOCAL',
      sefazConsultada: false,
      consultaExecutada: false
    };

    let evento = null;
    try {
      const emitir = this._obterEmitirEventoObrigatorio();
      evento = await emitir({
        tipo: TIPOS_EVENTO.FILA_ESGOTADA_LIBERACAO_OP,
        origem: params.origem || 'api',
        descricao: 'Fila esgotada liberada localmente (sem SOAP, NSU preservado)',
        resultado: 'LIBERADO_LOCAL',
        sucesso: true,
        usuarioId: params.usuarioId || null,
        empresaId: params.empresaId || null,
        ambiente: controle.ambiente,
        correlationId,
        detalhe: detalheEvento
      });
    } catch (errorEvento) {
      // Fail-closed: não declarar sucesso sem evento — reverte marcador local.
      try {
        await this._repository.atualizarSincronizacaoSegura(controle.id, {
          preservarNsu: true,
          manterDataSincronizacao: true,
          ultimoCstat: cstatAnterior,
          cooldownAte: controle.cooldownAte || null
        });
      } catch { /* best-effort rollback */ }
      const err = new Error(
        `Liberação não confirmada: falha ao registrar evento auditável (${errorEvento.message}).`
      );
      err.code = 'EVENTO_LIBERACAO_FALHOU';
      err.cause = errorEvento;
      throw err;
    }

    logOperacaoCentral({
      correlationId,
      operacao: 'FILA_ESGOTADA_LIBERACAO_OP',
      nsu: (atualizado || controle).ultNsu,
      cStat: CSTAT_FILA_LIBERADA_OPERACIONAL,
      resultado: 'LIBERADO_LOCAL',
      origem: 'CentralNsuService',
      detalhe: {
        ...detalheEvento,
        eventoId: evento?.id || null
      }
    });

    return {
      sucesso: true,
      controle: atualizado || controle,
      ultNsu: (atualizado || controle).ultNsu,
      maxNsu: (atualizado || controle).maxNsu,
      ultimoCstat: CSTAT_FILA_LIBERADA_OPERACIONAL,
      consultaExecutada: false,
      sefazConsultada: false,
      correlationId,
      eventoId: evento?.id || null,
      mensagem: 'Fila esgotada liberada localmente para reavaliação. NSU preservado. Nenhuma consulta SEFAZ foi enviada.'
    };
  }

  /** @private */
  _obterEventosRepository() {
    if (this._eventosRepository) return this._eventosRepository;
    // Lazy: só instancia com o mesmo db do NSU (evita abrir database.js default em testes).
    const dbNsu = this._repository && this._repository._db != null
      ? this._repository._db
      : null;
    if (!dbNsu) return null;
    try {
      const CentralEventosRepository = require('../repositories/CentralEventosRepository');
      this._eventosRepository = new CentralEventosRepository({ db: dbNsu });
      return this._eventosRepository;
    } catch {
      return null;
    }
  }

  /** @private */
  _obterEmitirEventoObrigatorio() {
    if (typeof this._emitirEventoObrigatorio === 'function') {
      return this._emitirEventoObrigatorio;
    }
    const { emitirEventoObrigatorio } = require('../utils/centralEventosEmitter');
    return emitirEventoObrigatorio;
  }
}

CentralNsuService.INTERVALO_COOLDOWN_MS = INTERVALO_COOLDOWN_MS;
CentralNsuService.CSTAT_FILA_ESGOTADA = CSTAT_FILA_ESGOTADA;
CentralNsuService.CSTAT_FILA_LIBERADA_OPERACIONAL = CSTAT_FILA_LIBERADA_OPERACIONAL;
CentralNsuService.montarMensagemCooldown = montarMensagemCooldown;
CentralNsuService.nsuPresenteNoXml = nsuPresenteNoXml;
CentralNsuService.nsuNumerico = nsuNumerico;

module.exports = CentralNsuService;
