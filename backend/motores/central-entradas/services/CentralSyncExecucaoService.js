/**
 * CentralSyncExecucaoService — Execução de sincronização com mutex único (RC3.3.3).
 *
 * Proteção:
 * - nunca duas DistDFe simultâneas no processo;
 * - `forcar` ignora apenas cooldown/horário, NÃO o mutex;
 * - ciclo-dfe / diagnóstico devem usar `comLockDistDfe`.
 *
 * @class CentralSyncExecucaoService
 */

const CentralSincronizacaoService = require('./CentralSincronizacaoService');
const CentralConfiguracaoService = require('./CentralConfiguracaoService');
const CentralNotificacoesService = require('./CentralNotificacoesService');
const CentralNsuRepository = require('../repositories/CentralNsuRepository');
const CentralNsuService = require('./CentralNsuService');
const { TIPOS_EVENTO, ORIGENS } = require('../config/centralEventosTipos');
const { emitirEvento } = require('../utils/centralEventosEmitter');
const { logCentral, logCentralErro } = require('../utils/centralLog');
const { criarCorrelationId, logOperacaoCentral } = require('../utils/centralOperacaoLog');
const SincronizacaoResultadoDTO = require('../contracts/SincronizacaoResultadoDTO');
const { emitirSefazConsulta } = require('../observability/SefazConsultaTrace');
const { obterMutexTransmissaoSefaz } = require('../../../services/fiscal/SefazTransmissaoMutex');
const CentralConsultaDistDfeDecisaoService = require('./CentralConsultaDistDfeDecisaoService');

class CentralSyncExecucaoService {
  constructor(deps = {}) {
    this._nsuRepository = deps.nsuRepository ?? new CentralNsuRepository({ db: deps.db ?? null });
    this._nsuService = deps.nsuService
      ?? new CentralNsuService({ nsuRepository: this._nsuRepository });
    this._sincronizacao = deps.sincronizacaoService ?? new CentralSincronizacaoService({
      nsuRepository: this._nsuRepository,
      nsuService: this._nsuService,
      configuracaoService: deps.configuracaoService ?? deps.configService,
      db: deps.db ?? null,
      mutexTransmissaoSefaz: deps.mutexTransmissaoSefaz,
      gate: deps.gate,
      decisaoDistDfe: deps.decisaoDistDfe
    });
    this._config = deps.configuracaoService
      ?? deps.configService
      ?? new CentralConfiguracaoService({ db: deps.db ?? null });
    this._notificacoes = deps.notificacoesService ?? new CentralNotificacoesService();
    this._emitirEvento = deps.emitirEvento || emitirEvento;
    this._emitirSefazConsulta = deps.emitirSefazConsulta || emitirSefazConsulta;
    this._executando = false;
    this._lockDono = null;
    this._mutexTransmissao = deps.mutexTransmissaoSefaz || obterMutexTransmissaoSefaz();
    this._ultimaExecucao = null;
    this._proximaExecucao = null;
    this._ultimoResultado = null;
    this._decisaoDistDfe = deps.decisaoDistDfe
      ?? new CentralConsultaDistDfeDecisaoService({
        nsuService: this._nsuService,
        nsuRepository: this._nsuRepository,
        mutexTransmissaoSefaz: this._mutexTransmissao,
        syncExecucao: this,
        gate: deps.gate
      });
    this._listarAlvos = deps.listarAlvosSincronizacaoCentral || null;
  }

  estaExecutando() {
    return this._executando;
  }

  definirProximaExecucao(data) {
    this._proximaExecucao = data;
  }

  obterEstado() {
    return {
      executando: this._executando,
      lockDono: this._lockDono,
      ultimaExecucao: this._ultimaExecucao,
      proximaExecucao: this._proximaExecucao,
      ultimoResultado: this._ultimoResultado
    };
  }

  /**
   * Mutex único para qualquer DistDFe (sync, ciclo-dfe, diagnóstico).
   * @param {string} dono
   * @param {Function} fn
   * @returns {Promise<*>}
   */
  async comLockDistDfe(dono, fn) {
    if (this._executando) {
      return {
        sucesso: false,
        consultaExecutada: false,
        ignorado: true,
        codigo: 'SYNC_EM_ANDAMENTO',
        motivoIgnorado: 'SYNC_EM_ANDAMENTO',
        mensagem: `Sincronização já em andamento (${this._lockDono || 'desconhecido'})`,
        erros: ['Sincronização já em andamento']
      };
    }

    const mutex = this._mutexTransmissao;
    if (mutex && typeof mutex.comLock === 'function') {
      const locked = await mutex.comLock(dono || 'dist-dfe', async () => {
        this._executando = true;
        this._lockDono = dono || 'dist-dfe';
        try {
          return await fn();
        } finally {
          this._executando = false;
          this._lockDono = null;
        }
      });
      if (!locked.ok) {
        return {
          sucesso: false,
          consultaExecutada: false,
          ignorado: true,
          codigo: 'SYNC_EM_ANDAMENTO',
          motivoIgnorado: 'SYNC_EM_ANDAMENTO',
          mensagem: `Sincronização já em andamento (${locked.lockDono || this._lockDono || 'desconhecido'})`,
          erros: ['Sincronização já em andamento']
        };
      }
      return locked.valor;
    }

    this._executando = true;
    this._lockDono = dono || 'dist-dfe';
    try {
      return await fn();
    } finally {
      this._executando = false;
      this._lockDono = null;
    }
  }

  /**
   * @param {Object} [opcoes]
   * @returns {Promise<Object>}
   */
  async executar(opcoes = {}) {
    const origem = opcoes.origem || ORIGENS.MANUAL;
    const ignorarHorario = Boolean(opcoes.ignorarHorario);
    const forcar = Boolean(opcoes.forcar);
    const usuarioId = opcoes.usuarioId ?? null;
    const correlationId = opcoes.correlationId || criarCorrelationId();

    this._emitirSefazConsulta('CONSULTA_SOLICITADA', {
      origem,
      correlationId,
      tipoConsulta: 'distNSU',
      motivo: 'sync_executar',
      detalhe: forcar
        ? { forcarSolicitado: true, forcarIgnoradoParaCooldown: true }
        : undefined
    });

    // RC7.4.2 / P0.11 — Gate operacional. forcar/ignorarBloqueio656 NÃO bypassam.
    // Falha do Gate = fail-closed (não engolir exceção).
    if (opcoes.ignorarBloqueio656 !== true) {
      try {
        const gate = require('./CentralSefazOperationalGate');
        const auth = await gate.autorizarConsultaDistDfe({
          correlationId,
          origem,
          empresaId: opcoes.empresaId || null,
          forcar: false,
          forcarAdminConfirmado: opcoes.forcarAdminConfirmado === true,
          confirmacaoAdmin: opcoes.confirmacaoAdmin === true,
          motivo: 'Aguardando liberação da SEFAZ'
        });
        if (!auth.permitido) {
          this._emitirSefazConsulta('BLOQUEADA_GATE', {
            origem,
            correlationId,
            empresaId: auth.empresaId || opcoes.empresaId || null,
            codigo: auth.codigo,
            cStat: auth.cStat,
            estadoGate: auth.estadoOperacional || auth.codigo,
            motivo: auth.mensagem,
            resultado: 'bloqueada'
          });
          return {
            ...auth,
            sucesso: false,
            consultaExecutada: false,
            ignorado: true,
            origem,
            correlationId
          };
        }
      } catch (errorGate) {
        logCentralErro('SYNC', errorGate, {
          Motivo: 'gate_falha_pre_sync_fail_closed',
          Origem: origem,
          CorrelationId: correlationId,
          EmpresaId: opcoes.empresaId || null
        });
        this._emitirSefazConsulta('BLOQUEADA_GATE', {
          origem,
          correlationId,
          empresaId: opcoes.empresaId || null,
          codigo: 'GATE_INDISPONIVEL',
          motivo: errorGate.message,
          resultado: 'bloqueada'
        });
        return {
          sucesso: false,
          consultaExecutada: false,
          ignorado: true,
          codigo: 'GATE_INDISPONIVEL',
          motivoIgnorado: 'GATE_INDISPONIVEL',
          mensagem: `Gate SEFAZ indisponível — sincronização bloqueada: ${errorGate.message}`,
          mensagemAmigavel: 'Falha ao verificar bloqueio operacional. Consulta DistDFe não enviada.',
          origem,
          correlationId
        };
      }
    }

    // P0.11 — cooldown NSU: `forcar` / `ignorarCooldown` NÃO liberam DistDFe.
    // MULTIEMPRESA: cooldown é por empresa em sincronizarEmpresa (decisão unificada).
    {
      const cooldown = await this._verificarCooldownDfe();
      if (cooldown.indisponivel) {
        this._emitirSefazConsulta('BLOQUEADA_COOLDOWN', {
          origem,
          correlationId,
          codigo: 'NSU_INDISPONIVEL',
          motivo: cooldown.motivo || 'nsu_indisponivel',
          resultado: 'bloqueada'
        });
        return {
          sucesso: false,
          consultaExecutada: false,
          ignorado: true,
          codigo: 'NSU_INDISPONIVEL',
          motivoIgnorado: 'NSU_INDISPONIVEL',
          mensagem: 'Estado do NSU/cooldown indisponível — sincronização bloqueada (fail-closed).',
          mensagemAmigavel: 'Não foi possível verificar o cooldown. Consulta não enviada.',
          correlationId,
          origem
        };
      }
      if (cooldown.ativo) {
        const motivo = cooldown.motivo || 'COOLDOWN_EXPLICITO';
        const mensagemCooldown = CentralNsuService.montarMensagemCooldown(cooldown);
        const codigoDecisao = motivo === 'FILA_ESGOTADA'
          ? 'FILA_ESGOTADA'
          : (motivo === 'ESTADO_NSU_INCONSISTENTE'
            ? 'ESTADO_NSU_INCONSISTENTE'
            : 'COOLDOWN_ATIVO');
        this._emitirSefazConsulta('BLOQUEADA_COOLDOWN', {
          origem,
          correlationId,
          codigo: 'AGUARDAR_JANELA_DFE',
          motivo,
          nsuAnterior: cooldown.ultNsu,
          maxNsu: cooldown.maxNsu,
          resultado: 'bloqueada'
        });
        return {
          sucesso: false,
          consultaExecutada: false,
          ignorado: true,
          codigo: 'AGUARDAR_JANELA_DFE',
          codigoDecisao,
          motivoIgnorado: motivo,
          mensagem: mensagemCooldown,
          mensagemAmigavel: mensagemCooldown,
          proximaConsultaEm: cooldown.proximaConsultaEm,
          ultNsu: cooldown.ultNsu,
          maxNsu: cooldown.maxNsu,
          correlationId,
          origem
        };
      }
    }

    if (!ignorarHorario && origem === ORIGENS.BACKGROUND) {
      const horario = await this._config.verificarHorarioPermitido();
      if (!horario.permitido) {
        return {
          sucesso: false,
          consultaExecutada: false,
          ignorado: true,
          mensagem: horario.motivo,
          erros: [horario.motivo],
          correlationId,
          origem
        };
      }
    }

    const resultadoLock = await this.comLockDistDfe(`sync:${origem}`, async () => {
      const inicio = Date.now();
      this._ultimaExecucao = new Date().toISOString();

      logOperacaoCentral({
        correlationId,
        operacao: 'SYNC_DFE',
        origem,
        resultado: 'INICIO',
        area: 'SYNC'
      });

      await this._emitirEvento({
        tipo: TIPOS_EVENTO.SYNC_INICIADA,
        origem,
        descricao: 'Sincronização SEFAZ iniciada',
        resultado: 'em_andamento',
        sucesso: null,
        usuarioId,
        empresaId: opcoes.empresaId || null,
        correlationId,
        detalhe: { correlationId, empresaId: opcoes.empresaId || null }
      });

      try {
        const cfg = await this._config.obterResumo();
        const maxIteracoes = Math.max(1, Math.min(200, opcoes.maxIteracoes ?? cfg.syncMaxDocumentos ?? 50));

        const resultado = await this._sincronizacao.sincronizar({
          maxIteracoes,
          correlationId,
          origem,
          autorizacaoTransmissaoSefaz: opcoes.autorizacaoTransmissaoSefaz || null,
          empresaIdFiltro: opcoes.empresaId || null,
          operacaoFiscalRealService: opcoes.operacaoFiscalRealService || null
        });

        const duracaoMs = Date.now() - inicio;
        this._ultimoResultado = resultado;

        // Sincronização por empresa já entrega cada cStat ao Gate da respectiva empresa.
        const gateJaProcessado = resultado.gateProcessado === true;
        if (!gateJaProcessado && (String(resultado.cStat) === '656' || String(resultado.cStat) === '593')) {
          try {
            await require('./CentralSefazOperationalGate').processarRespostaSefaz(resultado, {
              correlationId,
              nsu: resultado.ultNsu || null
            });
            resultado.gateProcessado = true;
          } catch { /* ignore */ }
        } else if (!gateJaProcessado && resultado.cStat) {
          try {
            await require('./CentralSefazOperationalGate').processarRespostaSefaz(resultado, {
              correlationId,
              nsu: resultado.ultNsu || null
            });
            resultado.gateProcessado = true;
          } catch { /* ignore */ }
        }

        const syncIgnorada = resultado.consultaExecutada === false || resultado.ignorado === true;
        await this._emitirEvento({
          tipo: resultado.sucesso
            ? TIPOS_EVENTO.SYNC_CONCLUIDA
            : (syncIgnorada ? TIPOS_EVENTO.SYNC_CONCLUIDA : TIPOS_EVENTO.SYNC_ERRO),
          origem,
          descricao: resultado.mensagem || (resultado.sucesso
            ? 'Sincronização concluída'
            : (syncIgnorada ? 'Consulta DF-e não executada' : 'Falha na sincronização')),
          resultado: resultado.sucesso ? 'sucesso' : (syncIgnorada ? 'ignorado' : 'erro'),
          sucesso: resultado.sucesso,
          notasNovas: resultado.notasNovas || 0,
          notasDuplicadas: resultado.notasDuplicadas || 0,
          duracaoMs,
          usuarioId,
          detalhe: {
            correlationId,
            notasNovas: resultado.notasNovas || 0,
            notasDuplicadas: resultado.notasDuplicadas || 0,
            cStat: resultado.cStat || null,
            ultNsu: resultado.ultNsu || null,
            maxNsu: resultado.maxNsu || null
          }
        });

        const cfgNotif = await this._config.obterResumo();
        await this._notificacoes.notificarSyncConcluida({
          notasNovas: resultado.notasNovas || 0,
          sucesso: resultado.sucesso,
          mensagem: resultado.mensagem,
          origem,
          notificarNovas: cfgNotif.notificarNovasNotas,
          ignorado: resultado.ignorado === true,
          consultaExecutada: resultado.consultaExecutada
        });

        logOperacaoCentral({
          correlationId,
          operacao: 'SYNC_DFE',
          nsu: resultado.ultNsu,
          cStat: resultado.cStat,
          tempoMs: duracaoMs,
          resultado: resultado.sucesso ? 'OK' : 'ERRO',
          origem,
          area: 'SYNC'
        });

        return { ...resultado, duracaoMs, origem, correlationId };
      } catch (error) {
        const duracaoMs = Date.now() - inicio;
        const falha = SincronizacaoResultadoDTO.create({
          sucesso: false,
          erros: [error.message]
        }).toJSON();

        this._ultimoResultado = falha;
        logCentralErro('SYNC', error, { origem, duracaoMs, correlationId });

        await this._emitirEvento({
          tipo: TIPOS_EVENTO.SYNC_ERRO,
          origem,
          descricao: error.message,
          resultado: 'erro',
          sucesso: false,
          duracaoMs,
          usuarioId,
          detalhe: { erro: error.message, correlationId }
        });

        await this._notificacoes.notificarSyncConcluida({
          sucesso: false,
          mensagem: error.message,
          origem,
          notasNovas: 0
        });

        return { ...falha, duracaoMs, origem, correlationId };
      }
    });

    if (resultadoLock && resultadoLock.codigo === 'SYNC_EM_ANDAMENTO') {
      this._emitirSefazConsulta('ENFILEIRADA', {
        origem,
        correlationId,
        codigo: 'SYNC_EM_ANDAMENTO',
        motivo: resultadoLock.mensagem,
        resultado: 'rejeitada_mutex',
        detalhe: { lockDono: this._lockDono, enfileiradaEfetiva: false }
      });
    }

    return resultadoLock;
  }

  /** @private */
  async _verificarCooldownDfe() {
    try {
      const { ModoOperacionalGlobal } = require('../../../core/modo-operacional');
      const listarAlvos = this._listarAlvos
        || require('../../../services/central-entradas/CentralEntradasEmpresaContextoService')
          .listarAlvosSincronizacaoCentral;
      const plano = await listarAlvos();

      // MULTIEMPRESA: cooldown é por CNPJ dentro de sincronizarEmpresa — não bloqueia o lote global.
      if (plano.modo === ModoOperacionalGlobal.MULTIEMPRESA) {
        return { ativo: false };
      }

      const alvo = plano.alvos[0];
      const contexto = await this._config.obterContextoOperacional({
        empresaId: alvo && alvo.empresaId,
        permitirFallbackGlobal: true
      });
      if (!contexto.ok) {
        return {
          ativo: true,
          indisponivel: true,
          motivo: contexto.codigoErro || 'CONTEXTO_INVALIDO'
        };
      }

      const ambiente = Number(contexto.contexto.ambiente) === 1 ? 1 : 2;
      const controle = await this._nsuService.buscarPorCnpjAmbiente(
        contexto.contexto.cnpj,
        ambiente
      );
      return this._nsuService.avaliarCooldown(controle);
    } catch (error) {
      logCentralErro('SYNC', error, { Motivo: 'cooldown_nsu_indisponivel_fail_closed' });
      return { ativo: true, indisponivel: true, motivo: 'NSU_INDISPONIVEL' };
    }
  }
}

module.exports = new CentralSyncExecucaoService();
module.exports.CentralSyncExecucaoService = CentralSyncExecucaoService;
