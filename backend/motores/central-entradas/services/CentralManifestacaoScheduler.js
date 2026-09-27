/**
 * CentralManifestacaoScheduler — Motor de Manifestação independente (CENTRAL-XML-02 P2/P3).
 *
 * Scheduler → processarCandidatos (seleção por urgência real, prazo, Gate por empresa, claim)
 * → 210210 → retorno. Não depende da sincronização DF-e nem da Central aberta no navegador:
 * é iniciado com o backend (CentralSyncBackgroundService.iniciar) e roda até o processo parar.
 *
 * Frequência conservadora e configurável por ambiente:
 *   CENTRAL_MANIFESTACAO_SCHEDULER=0         desliga o scheduler (a pós-sincronização continua)
 *   CENTRAL_MANIFESTACAO_INTERVALO_MIN=30     intervalo entre ciclos (mín. 10, máx. 240)
 *   CENTRAL_MANIFESTACAO_LIMITE_CICLO=10      documentos por ciclo (mín. 1, máx. 50)
 *
 * @module motores/central-entradas/services/CentralManifestacaoScheduler
 */

'use strict';

const centralEntradasFlags = require('../config/centralEntradasFlags');
const { logCentral, logCentralErro } = require('../utils/centralLog');
const { criarCorrelationId } = require('../utils/centralOperacaoLog');

const INTERVALO_PADRAO_MIN = 30;
const INTERVALO_MINIMO_MIN = 10;
const INTERVALO_MAXIMO_MIN = 240;
const LIMITE_PADRAO = 10;
const LIMITE_MAXIMO = 50;
const ATRASO_INICIAL_MS = 60 * 1000;

function inteiroEntre(valor, padrao, min, max) {
  const n = Number.parseInt(valor, 10);
  if (!Number.isFinite(n)) return padrao;
  return Math.min(max, Math.max(min, n));
}

function lerConfigAmbiente(env = process.env) {
  const flag = String(env.CENTRAL_MANIFESTACAO_SCHEDULER ?? '').trim().toLowerCase();
  return {
    habilitado: !['0', 'false', 'off', 'nao', 'não'].includes(flag),
    intervaloMs: inteiroEntre(
      env.CENTRAL_MANIFESTACAO_INTERVALO_MIN,
      INTERVALO_PADRAO_MIN,
      INTERVALO_MINIMO_MIN,
      INTERVALO_MAXIMO_MIN
    ) * 60 * 1000,
    limitePorCiclo: inteiroEntre(env.CENTRAL_MANIFESTACAO_LIMITE_CICLO, LIMITE_PADRAO, 1, LIMITE_MAXIMO),
    atrasoInicialMs: ATRASO_INICIAL_MS
  };
}

class CentralManifestacaoScheduler {
  constructor(deps = {}) {
    this._criarServico = deps.criarServico || (() => {
      const CentralManifestacaoDfeService = require('./CentralManifestacaoDfeService');
      return new CentralManifestacaoDfeService();
    });
    this._lerConfig = deps.lerConfig || (() => lerConfigAmbiente());
    this._flags = deps.flags ?? centralEntradasFlags;
    this._setTimeout = deps.setTimeout || setTimeout;
    this._clearTimeout = deps.clearTimeout || clearTimeout;
    this._agora = deps.agora || (() => new Date());
    this._timer = null;
    this._ativo = false;
    this._executando = false;
    this._ultimaExecucao = null;
    this._proximaExecucao = null;
    this._ultimoResultado = null;
    this._ciclos = 0;
  }

  estaAtivo() {
    return this._ativo;
  }

  /** @returns {boolean} true se o scheduler ficou ativo */
  iniciar(opcoes = {}) {
    const cfg = this._lerConfig();
    this.parar({ silencioso: true });
    if (!cfg.habilitado) {
      logCentral('MANIFESTACAO', {
        mensagem: 'Scheduler de manifestação desabilitado por configuração',
        Etapa: 'scheduler_desabilitado'
      });
      return false;
    }
    this._ativo = true;
    const atraso = opcoes.delayMs != null ? Math.max(0, Number(opcoes.delayMs) || 0) : cfg.atrasoInicialMs;
    this._agendar(atraso, cfg);
    logCentral('MANIFESTACAO', {
      mensagem: 'Scheduler de manifestação iniciado',
      Etapa: 'scheduler_start',
      intervaloMs: cfg.intervaloMs,
      limitePorCiclo: cfg.limitePorCiclo,
      primeiraExecucaoEmMs: atraso
    });
    return true;
  }

  parar(opcoes = {}) {
    const estavaAtivo = this._ativo;
    if (this._timer) {
      this._clearTimeout(this._timer);
      this._timer = null;
    }
    this._ativo = false;
    this._proximaExecucao = null;
    if (estavaAtivo && !opcoes.silencioso) {
      logCentral('MANIFESTACAO', { mensagem: 'Scheduler de manifestação parado', Etapa: 'scheduler_stop' });
    }
  }

  _agendar(delayMs, cfg = this._lerConfig()) {
    if (this._timer) this._clearTimeout(this._timer);
    this._proximaExecucao = new Date(this._agora().getTime() + delayMs).toISOString();
    this._timer = this._setTimeout(() => {
      this._timer = null;
      this.executarCiclo({ origem: 'scheduler' })
        .catch((error) => logCentralErro('MANIFESTACAO', error, { Etapa: 'scheduler_ciclo_nao_tratado' }))
        .finally(() => {
          if (this._ativo) this._agendar(cfg.intervaloMs, cfg);
        });
    }, delayMs);
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
  }

  /**
   * Um ciclo: nunca sobrepõe outro ciclo deste scheduler; a exclusão entre scheduler e
   * pós-sincronização fica no CentralManifestacaoDfeService (ciclo por processo + claim).
   */
  async executarCiclo(opcoes = {}) {
    if (this._executando) {
      return { executado: false, motivo: 'CICLO_EM_EXECUCAO' };
    }
    if (typeof this._flags?.estaHabilitado === 'function' && !this._flags.estaHabilitado()) {
      return { executado: false, motivo: 'MODULO_CENTRAL_DESABILITADO' };
    }
    const cfg = this._lerConfig();
    const correlationId = criarCorrelationId();
    const inicio = Date.now();
    this._executando = true;
    try {
      const resultado = await this._criarServico().processarCandidatos({
        limite: cfg.limitePorCiclo,
        apenasManifestacao: true,
        origemCiclo: opcoes.origem || 'scheduler',
        correlationId
      });
      this._ciclos += 1;
      this._ultimaExecucao = this._agora().toISOString();
      this._ultimoResultado = {
        executado: resultado?.executado === true,
        candidatos: resultado?.candidatos ?? 0,
        politica: resultado?.politica || null,
        porUrgencia: resultado?.selecao?.porUrgencia || null,
        excluidosPorMotivo: resultado?.selecao?.excluidosPorMotivo || null,
        duracaoMs: Date.now() - inicio
      };
      logCentral('MANIFESTACAO', {
        mensagem: 'Ciclo do scheduler de manifestação concluído',
        Etapa: 'scheduler_ciclo',
        correlationId,
        ...this._ultimoResultado,
        porUrgencia: JSON.stringify(this._ultimoResultado.porUrgencia),
        excluidosPorMotivo: JSON.stringify(this._ultimoResultado.excluidosPorMotivo)
      });
      return resultado;
    } catch (error) {
      logCentralErro('MANIFESTACAO', error, { Etapa: 'scheduler_ciclo', correlationId });
      this._ultimoResultado = { executado: false, erro: error.message, duracaoMs: Date.now() - inicio };
      return { executado: false, motivo: 'ERRO', mensagem: error.message };
    } finally {
      this._executando = false;
    }
  }

  obterStatus() {
    const cfg = this._lerConfig();
    return {
      ativo: this._ativo,
      executando: this._executando,
      habilitado: cfg.habilitado,
      intervaloMs: cfg.intervaloMs,
      limitePorCiclo: cfg.limitePorCiclo,
      ciclos: this._ciclos,
      ultimaExecucao: this._ultimaExecucao,
      proximaExecucao: this._proximaExecucao,
      ultimoResultado: this._ultimoResultado
    };
  }
}

module.exports = new CentralManifestacaoScheduler();
module.exports.CentralManifestacaoScheduler = CentralManifestacaoScheduler;
module.exports.lerConfigAmbiente = lerConfigAmbiente;
