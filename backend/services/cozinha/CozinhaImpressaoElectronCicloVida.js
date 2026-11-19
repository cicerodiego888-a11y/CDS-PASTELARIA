/**
 * Ciclo de vida Electron ↔ Worker de impressão de cozinha — Sprint 06 E-03.
 *
 * - instalação única + agendador único
 * - contexto só após DB + sessão autenticada
 * - troca de contexto segura (aguarda tick em curso; não cria outro timer/Worker)
 * - encerramento no will-quit
 */
'use strict';

const {
  instalarWorkerImpressaoCozinhaNoElectron,
  encerrarWorkerImpressaoCozinhaNoElectron,
  obterWorkerImpressaoCozinhaInstalado,
  contarInstalacoesWorkerImpressao
} = require('./CozinhaImpressaoWorkerBootstrap');
const {
  obterSessaoAutenticadaCozinha,
  validarContextoContraSessaoAutenticada,
  limparSessaoAutenticadaCozinha
} = require('./cozinhaImpressaoSessaoElectron');

const INTERVALO_TICK_PADRAO_MS = 5000;
const POLL_CONTEXTO_MS = 500;

/** Singleton por processo Electron. */
let _integracao = null;

function parsePositiveInteger(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * @param {object} deps
 * @param {function(): object|null} deps.obterMainWindow
 * @param {function(): object|null} deps.obterDb
 * @param {function(): object|null} [deps.obterSessaoAutenticada]
 * @param {boolean} [deps.exigirSessaoAutenticada] — default true
 * @param {object} [deps.adapter]
 * @param {boolean} [deps.permitirAdapterCompat]
 * @param {number} [deps.intervaloTickMs]
 */
function criarIntegracaoCicloVidaCozinhaImpressao(deps = {}) {
  if (typeof deps.obterMainWindow !== 'function') {
    throw new Error('obterMainWindow obrigatório');
  }
  if (typeof deps.obterDb !== 'function') {
    throw new Error('obterDb obrigatório');
  }

  const exigirSessao = deps.exigirSessaoAutenticada !== false;
  const obterSessao = typeof deps.obterSessaoAutenticada === 'function'
    ? deps.obterSessaoAutenticada
    : obterSessaoAutenticadaCozinha;

  let _contextoAplicado = null; // { empresaId, unidadeId, geracao }
  let _geracaoContexto = 0;
  let _timerTick = null;
  let _timerPollContexto = null;
  let _tickEmCurso = false;
  let _tickGeracao = null;
  let _encerrado = false;
  let _agendadorAtivo = false;
  let _instaladoViaReady = false;
  let _ultimoErroTick = null;
  let _ticksExecutados = 0;
  let _ticksDescartadosObsoletos = 0;
  let _esperaFimTick = null;

  function sinalizarFimTick() {
    if (_esperaFimTick) {
      const r = _esperaFimTick;
      _esperaFimTick = null;
      r();
    }
  }

  function aguardarTickEmCurso() {
    if (!_tickEmCurso) return Promise.resolve();
    if (!_esperaFimTick) {
      let resolve;
      const p = new Promise((r) => { resolve = r; });
      _esperaFimTick = resolve;
      return p;
    }
    return new Promise((resolve) => {
      const prev = _esperaFimTick;
      _esperaFimTick = () => {
        prev();
        resolve();
      };
    });
  }

  function lerContextoAplicado() {
    return _contextoAplicado
      ? { empresaId: _contextoAplicado.empresaId, unidadeId: _contextoAplicado.unidadeId }
      : { empresaId: null, unidadeId: null };
  }

  function contextoPronto() {
    const db = deps.obterDb();
    const { empresaId, unidadeId } = lerContextoAplicado();
    return !!(db && empresaId && unidadeId);
  }

  function aplicarContextoNoWorker(empresaId, unidadeId) {
    const db = deps.obterDb();
    const worker = obterWorkerImpressaoCozinhaInstalado();
    if (!worker || !db) return false;
    worker.atualizarContexto({ db, empresaId, unidadeId });
    return true;
  }

  function aoReadyToShow() {
    if (_encerrado) return { ok: false, motivo: 'encerrado' };
    const worker = instalarWorkerImpressaoCozinhaNoElectron({
      modo: 'ELECTRON',
      autorizarSpoolerReal: false,
      obterWebContents: () => {
        const w = deps.obterMainWindow();
        return w && !w.isDestroyed && !w.isDestroyed() ? w.webContents : null;
      },
      adapter: deps.adapter,
      permitirAdapterCompat: deps.permitirAdapterCompat === true,
      workerId: deps.workerId || 'electron-cozinha-worker'
    });
    _instaladoViaReady = true;
    iniciarPollContexto();
    tentarAtivarAgendador();
    return {
      ok: true,
      instalado: true,
      instalacoes: contarInstalacoesWorkerImpressao(),
      worker: worker && worker.descrever ? worker.descrever() : null,
      agendador_ativo: _agendadorAtivo
    };
  }

  /**
   * Notifica/troca contexto. Valida contra sessão autenticada no main.
   * Se houver tick em curso, aguarda o fim antes de aplicar o novo contexto.
   * Não cria segundo Worker nem segundo timer.
   */
  async function notificarContextoOperacional(raw = {}) {
    if (_encerrado) {
      return { ok: false, codigo: 'IMPRESSAO_WORKER_ENCERRADO' };
    }

    let canonico;
    try {
      if (exigirSessao) {
        const sessao = obterSessao();
        canonico = validarContextoContraSessaoAutenticada(raw || {}, sessao);
      } else {
        // Apenas testes unitários explícitos com exigirSessaoAutenticada:false
        const empresaId = parsePositiveInteger(raw.empresaId != null ? raw.empresaId : raw.empresa_id);
        const unidadeId = parsePositiveInteger(
          raw.unidadeId != null ? raw.unidadeId
            : (raw.unidade_id != null ? raw.unidade_id : raw.unidade_cozinha_id)
        );
        if (!empresaId || !unidadeId) {
          return { ok: false, codigo: 'IMPRESSAO_CONTEXTO_INVALIDO' };
        }
        canonico = { empresaId, unidadeId };
      }
    } catch (err) {
      return {
        ok: false,
        codigo: err.codigo || 'IMPRESSAO_CONTEXTO_REJEITADO',
        erro: err.message,
        detalhes: err.detalhes || null
      };
    }

    const anterior = lerContextoAplicado();
    const mudou = !anterior.empresaId
      || Number(anterior.empresaId) !== Number(canonico.empresaId)
      || Number(anterior.unidadeId) !== Number(canonico.unidadeId);

    // Aguarda tick em andamento — não aplica troca no meio do processamento.
    if (_tickEmCurso) {
      await aguardarTickEmCurso();
    }

    // Se o Worker encerrou enquanto aguardava, não aplicar contexto pendente.
    if (_encerrado) {
      return { ok: false, codigo: 'IMPRESSAO_WORKER_ENCERRADO' };
    }

    _geracaoContexto += 1;
    const geracao = _geracaoContexto;
    _contextoAplicado = {
      empresaId: canonico.empresaId,
      unidadeId: canonico.unidadeId,
      geracao
    };

    if (_instaladoViaReady || obterWorkerImpressaoCozinhaInstalado()) {
      try {
        aplicarContextoNoWorker(canonico.empresaId, canonico.unidadeId);
        const workerSync = obterWorkerImpressaoCozinhaInstalado();
        if (workerSync && typeof workerSync.definirGeracaoOperacional === 'function') {
          workerSync.definirGeracaoOperacional(geracao);
        }
      } catch (err) {
        return {
          ok: false,
          codigo: err.codigo || 'IMPRESSAO_CONTEXTO_APLICAR_FALHA',
          erro: err.message
        };
      }
    }

    // Agendador: ativa se necessário; NÃO cria segundo timer se já ativo.
    if (!_agendadorAtivo) {
      tentarAtivarAgendador();
    }

    return {
      ok: true,
      trocou: mudou,
      empresaId: canonico.empresaId,
      unidadeId: canonico.unidadeId,
      geracao,
      agendador_ativo: _agendadorAtivo,
      instalacoes: contarInstalacoesWorkerImpressao(),
      tem_timer_unico: !!_timerTick && _agendadorAtivo
    };
  }

  function iniciarPollContexto() {
    if (_timerPollContexto || _encerrado || _agendadorAtivo) return;
    _timerPollContexto = setInterval(() => {
      if (_encerrado) {
        pararPollContexto();
        return;
      }
      if (tentarAtivarAgendador()) {
        pararPollContexto();
      }
    }, POLL_CONTEXTO_MS);
  }

  function pararPollContexto() {
    if (_timerPollContexto) {
      clearInterval(_timerPollContexto);
      _timerPollContexto = null;
    }
  }

  function tentarAtivarAgendador() {
    if (_encerrado) return false;
    if (exigirSessao) {
      const sessao = obterSessao();
      if (!sessao || !sessao.empresaId || !sessao.unidadeId) return false;
    }
    if (_agendadorAtivo) {
      // Já ativo: apenas garante contexto no worker (troca já aplicada em notificar).
      if (_contextoAplicado) {
        try {
          aplicarContextoNoWorker(_contextoAplicado.empresaId, _contextoAplicado.unidadeId);
        } catch (_e) { /* ignore */ }
      }
      return true;
    }
    if (!_instaladoViaReady && !obterWorkerImpressaoCozinhaInstalado()) {
      return false;
    }
    const db = deps.obterDb();
    if (!db || !_contextoAplicado) return false;

    const worker = obterWorkerImpressaoCozinhaInstalado();
    if (!worker) return false;

    try {
      aplicarContextoNoWorker(_contextoAplicado.empresaId, _contextoAplicado.unidadeId);
    } catch (err) {
      console.warn('[COZINHA] atualizarContexto:', err && err.message ? err.message : err);
      return false;
    }

    const intervalo = Number(deps.intervaloTickMs) > 0
      ? Number(deps.intervaloTickMs)
      : (Number(process.env.CDS_COZINHA_WORKER_TICK_MS) > 0
        ? Number(process.env.CDS_COZINHA_WORKER_TICK_MS)
        : INTERVALO_TICK_PADRAO_MS);

    _timerTick = setInterval(() => {
      void executarTickSeguro();
    }, intervalo);
    _agendadorAtivo = true;
    pararPollContexto();
    setImmediate(() => { void executarTickSeguro(); });
    return true;
  }

  async function executarTickSeguro() {
    if (_encerrado || _tickEmCurso) return { skipped: true };
    const worker = obterWorkerImpressaoCozinhaInstalado();
    if (!worker || !worker.estaAtivo()) return { skipped: true };
    if (!_contextoAplicado) return { skipped: true, motivo: 'sem_contexto' };
    // Logout invalida sessão: não inicia novo claim/processamento com contexto antigo.
    if (exigirSessao) {
      const sessao = obterSessao();
      if (!sessao || !sessao.empresaId || !sessao.unidadeId) {
        return { skipped: true, motivo: 'sem_sessao' };
      }
      if (Number(sessao.empresaId) !== Number(_contextoAplicado.empresaId)
        || Number(sessao.unidadeId) !== Number(_contextoAplicado.unidadeId)) {
        return { skipped: true, motivo: 'contexto_divergente_sessao' };
      }
    }

    const geracaoInicio = _geracaoContexto;
    const ctxSnap = {
      empresaId: _contextoAplicado.empresaId,
      unidadeId: _contextoAplicado.unidadeId
    };

    _tickEmCurso = true;
    _tickGeracao = geracaoInicio;
    try {
      if (typeof worker.definirGeracaoOperacional === 'function') {
        worker.definirGeracaoOperacional(geracaoInicio);
      }

      // Tick com contexto explícito do snapshot (não usa IDs inventados).
      const out = await worker.tick({
        db: deps.obterDb(),
        empresaId: ctxSnap.empresaId,
        unidadeId: ctxSnap.unidadeId,
        geracaoOperacional: geracaoInicio,
        verificarGeracaoValida: () => {
          if (geracaoInicio !== _geracaoContexto) return false;
          if (!_contextoAplicado) return false;
          if (exigirSessao) {
            const sessao = obterSessao();
            if (!sessao || !sessao.empresaId || !sessao.unidadeId) return false;
          }
          return true;
        },
        driver: deps.driverTickOverride || undefined,
        __antesClaim: deps.__antesClaimTick || undefined,
        __antesUpdateClaim: deps.__antesUpdateClaimTick || undefined,
        __antesCommitClaim: deps.__antesCommitClaimTick || undefined,
        __antesCommitDentroGate: deps.__antesCommitDentroGateTick || undefined,
        __aposCommitDentroGate: deps.__aposCommitDentroGateTick || undefined,
        __antesDriver: deps.__antesDriverTick || undefined
      });

      if (geracaoInicio !== _geracaoContexto || (out && out.cancelado === true)) {
        // Contexto trocou / logout após o tick ter começado — não reutiliza como ciclo válido.
        _ticksDescartadosObsoletos += 1;
        return {
          ok: true,
          out,
          contexto_obsoleto: true,
          cancelado: !!(out && out.cancelado),
          geracao_inicio: geracaoInicio,
          geracao_atual: _geracaoContexto
        };
      }

      _ticksExecutados += 1;
      _ultimoErroTick = null;
      return {
        ok: true,
        out,
        contexto: ctxSnap,
        geracao: geracaoInicio
      };
    } catch (err) {
      _ultimoErroTick = err && err.message ? err.message : String(err);
      console.warn('[COZINHA] tick erro (processo Electron segue):', _ultimoErroTick);
      return { ok: false, erro: _ultimoErroTick };
    } finally {
      _tickEmCurso = false;
      _tickGeracao = null;
      sinalizarFimTick();
    }
  }

  /**
   * Logout operacional (renderer → main): invalida sessão/contexto e para o agendador.
   * Não encerra o Worker singleton — permite retomada segura após nova autenticação.
   */
  async function aoLogoutOperacional() {
    if (_encerrado) {
      return { ok: false, codigo: 'IMPRESSAO_WORKER_ENCERRADO' };
    }

    limparSessaoAutenticadaCozinha();
    _geracaoContexto += 1;
    const geracaoInvalidacao = _geracaoContexto;
    _contextoAplicado = null;

    const workerLogout = obterWorkerImpressaoCozinhaInstalado();
    if (workerLogout && typeof workerLogout.invalidarGeracaoOperacional === 'function') {
      // C10: await — serializa com COMMIT do claim sob o mesmo gate.
      await workerLogout.invalidarGeracaoOperacional(geracaoInvalidacao);
    }

    if (_timerTick) {
      clearInterval(_timerTick);
      _timerTick = null;
    }
    _agendadorAtivo = false;
    pararPollContexto();

    if (_tickEmCurso) {
      await aguardarTickEmCurso();
    }

    // Reafirma após tick em curso: nenhum contexto anterior permanece aplicável.
    limparSessaoAutenticadaCozinha();
    _contextoAplicado = null;

    const worker = obterWorkerImpressaoCozinhaInstalado();
    return {
      ok: true,
      logout: true,
      agendador_ativo: false,
      contexto: null,
      sessao: null,
      geracao_invalidacao: geracaoInvalidacao,
      instalacoes: contarInstalacoesWorkerImpressao(),
      worker_instalado: !!worker,
      worker_ativo: !!(worker && worker.estaAtivo && worker.estaAtivo()),
      tem_timer_unico: false
    };
  }

  function aoWillQuit() {
    _encerrado = true;
    pararPollContexto();
    if (_timerTick) {
      clearInterval(_timerTick);
      _timerTick = null;
    }
    _agendadorAtivo = false;
    _contextoAplicado = null;
    _geracaoContexto += 1;
    encerrarWorkerImpressaoCozinhaNoElectron();
    limparSessaoAutenticadaCozinha();
    sinalizarFimTick();
    return {
      encerrado: true,
      ticks_executados: _ticksExecutados,
      instalacoes: contarInstalacoesWorkerImpressao()
    };
  }

  function descrever() {
    const worker = obterWorkerImpressaoCozinhaInstalado();
    const sessao = obterSessao();
    return {
      instalado_via_ready: _instaladoViaReady,
      agendador_ativo: _agendadorAtivo,
      tick_em_curso: _tickEmCurso,
      tick_geracao: _tickGeracao,
      encerrado: _encerrado,
      ticks_executados: _ticksExecutados,
      ticks_descartados_obsoletos: _ticksDescartadosObsoletos,
      geracao_contexto: _geracaoContexto,
      ultimo_erro_tick: _ultimoErroTick,
      contexto: {
        empresaId: _contextoAplicado ? _contextoAplicado.empresaId : null,
        unidadeId: _contextoAplicado ? _contextoAplicado.unidadeId : null,
        tem_db: !!deps.obterDb()
      },
      sessao_autenticada: sessao
        ? { empresaId: sessao.empresaId, unidadeId: sessao.unidadeId }
        : null,
      instalacoes: contarInstalacoesWorkerImpressao(),
      worker: worker && worker.descrever ? worker.descrever() : null
    };
  }

  return {
    aoReadyToShow,
    aoWillQuit,
    aoLogoutOperacional,
    notificarContextoOperacional,
    tentarAtivarAgendador,
    executarTickSeguro,
    contextoPronto,
    descrever,
    aguardarTickEmCurso,
    _estadoInterno() {
      return {
        agendadorAtivo: _agendadorAtivo,
        tickEmCurso: _tickEmCurso,
        temTimerTick: !!_timerTick,
        temPoll: !!_timerPollContexto,
        ticksExecutados: _ticksExecutados,
        ticksDescartadosObsoletos: _ticksDescartadosObsoletos,
        geracaoContexto: _geracaoContexto,
        encerrado: _encerrado,
        contextoAplicado: _contextoAplicado
      };
    }
  };
}

function anexarAoReadyToShowMainWindow(mainWindow, integracao, opts = {}) {
  if (!mainWindow || typeof mainWindow.once !== 'function') {
    throw new Error('mainWindow inválida para anexar ready-to-show');
  }
  if (!integracao || typeof integracao.aoReadyToShow !== 'function') {
    throw new Error('integracao.aoReadyToShow obrigatório');
  }
  mainWindow.once('ready-to-show', () => {
    try {
      if (opts.show !== false && mainWindow && typeof mainWindow.isDestroyed === 'function'
        && !mainWindow.isDestroyed()) {
        if (typeof mainWindow.show === 'function') mainWindow.show();
        if (typeof mainWindow.focus === 'function') mainWindow.focus();
      }
    } catch (_e) { /* ignore */ }
    try {
      integracao.aoReadyToShow();
    } catch (err) {
      console.warn(
        '[COZINHA] Falha aoReadyToShow:',
        err && err.message ? err.message : err
      );
    }
  });
  return mainWindow;
}

function obterOuCriarIntegracaoPadrao(deps) {
  if (_integracao && !_integracao.descrever().encerrado) {
    return _integracao;
  }
  _integracao = criarIntegracaoCicloVidaCozinhaImpressao(deps);
  return _integracao;
}

function obterIntegracaoAtiva() {
  return _integracao;
}

function _resetIntegracaoCicloVidaParaTeste() {
  if (_integracao && typeof _integracao.aoWillQuit === 'function') {
    try { _integracao.aoWillQuit(); } catch (_e) { /* ignore */ }
  }
  _integracao = null;
  limparSessaoAutenticadaCozinha();
}

module.exports = {
  INTERVALO_TICK_PADRAO_MS,
  criarIntegracaoCicloVidaCozinhaImpressao,
  anexarAoReadyToShowMainWindow,
  obterOuCriarIntegracaoPadrao,
  obterIntegracaoAtiva,
  _resetIntegracaoCicloVidaParaTeste
};
