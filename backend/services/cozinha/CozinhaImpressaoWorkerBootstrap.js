/**
 * Bootstrap do Worker de impressão de cozinha — Sprint 06 Bloco E (E-03).
 *
 * Ponto de integração real no Electron:
 * 1) cria driver via criarDriverParaWorker('ELECTRON')
 * 2) injeta no WorkerService.processarProximo (mesmo objeto no tick)
 * 3) instalação idempotente (uma instância ativa)
 * 4) encerramento bloqueia novos ticks e limpa singleton
 * 5) impressão física permanece desabilitada por padrão
 *
 * FAKE permanece disponível para testes (modo 'FAKE') — isolado do ELECTRON.
 */
'use strict';

const WorkerService = require('./CozinhaImpressaoWorkerService');
const {
  criarDriverParaWorker,
  descreverIntegracaoProducao
} = require('./CozinhaImpressaoElectronProducao');
const { comGateClaimLogout } = require('./cozinhaImpressaoClaimLogoutGate');

/** Instância singleton instalada pelo Electron main. */
let _instancia = null;
/** Contador de instalações bem-sucedidas (evidência de unicidade). */
let _instalacoes = 0;
/** Após encerrar, novos ticks são recusados até nova instalação. */
let _encerrado = false;

/**
 * Cria o worker com driver injetado (caminho completo de produção).
 * @param {object} opts
 * @param {'ELECTRON'|'FAKE'} [opts.modo]
 * @param {function(): object|null} [opts.obterWebContents]
 * @param {boolean} [opts.autorizarSpoolerReal] — default false
 * @param {object} [opts.adapter] — override (ex.: teste com adapter producao tipado)
 * @param {object} [opts.db] — conexão default opcional
 * @param {number} [opts.empresaId]
 * @param {number} [opts.unidadeId]
 * @param {string} [opts.workerId]
 */
function criarWorkerImpressaoCozinha(opts = {}) {
  const modo = String(opts.modo || process.env.CDS_COZINHA_WORKER_MODO || 'ELECTRON').toUpperCase();
  const autorizarSpoolerReal = opts.autorizarSpoolerReal === true;
  const driver = criarDriverParaWorker(modo, {
    obterWebContents: opts.obterWebContents,
    criarJanelaImpressao: opts.criarJanelaImpressao,
    adapter: opts.adapter,
    autorizarSpoolerReal,
    timeoutMs: opts.timeoutMs,
    permitirAdapterCompat: opts.permitirAdapterCompat === true,
    fake: opts.fake
  });

  const meta = modo === 'ELECTRON'
    ? descreverIntegracaoProducao(driver)
    : {
      ok: driver.nome === 'FAKE',
      driver: driver.nome,
      producao: false,
      adapter_tipo: null,
      spooler_real_habilitado: false,
      impressao_fisica: false
    };

  const contextoPadrao = {
    empresaId: opts.empresaId != null ? opts.empresaId : null,
    unidadeId: opts.unidadeId != null ? opts.unidadeId : null,
    workerId: opts.workerId || 'electron-cozinha-worker',
    db: opts.db || null
  };

  let ativo = true;
  /** Geração operacional (sessão/contexto). Logout incrementa → invalida tick em curso. */
  let _geracaoOperacional = 0;

  function obterGeracaoOperacional() {
    return _geracaoOperacional;
  }

  function definirGeracaoOperacional(geracao) {
    const g = Number(geracao);
    _geracaoOperacional = Number.isFinite(g) && g >= 0 ? g : 0;
    return _geracaoOperacional;
  }

  /**
   * C10: invalidação sob o mesmo gate do COMMIT do claim.
   * Garante ordem inequívoca — não invalida no meio da confirmação.
   */
  async function invalidarGeracaoOperacional(novaGeracao) {
    return comGateClaimLogout('logout-invalidacao', () => {
      const g = Number(novaGeracao);
      if (Number.isFinite(g) && g > _geracaoOperacional) {
        _geracaoOperacional = g;
      } else {
        _geracaoOperacional += 1;
      }
      return _geracaoOperacional;
    });
  }

  async function tick(entrada = {}) {
    if (!ativo || _encerrado) {
      const err = new Error('Worker de impressão encerrado — novos ticks bloqueados.');
      err.codigo = 'IMPRESSAO_WORKER_ENCERRADO';
      throw err;
    }
    const db = entrada.db || contextoPadrao.db;
    const empresaId = entrada.empresaId != null ? entrada.empresaId : contextoPadrao.empresaId;
    const unidadeId = entrada.unidadeId != null ? entrada.unidadeId : contextoPadrao.unidadeId;
    const workerId = entrada.workerId != null ? entrada.workerId : contextoPadrao.workerId;
    if (!db) {
      const err = new Error('Worker tick exige db.');
      err.codigo = 'IMPRESSAO_WORKER_DB_OBRIGATORIO';
      throw err;
    }
    if (!empresaId || !unidadeId) {
      const err = new Error('Worker tick exige empresaId e unidadeId.');
      err.codigo = 'IMPRESSAO_WORKER_CONTEXTO_OBRIGATORIO';
      throw err;
    }

    const geracaoTick = entrada.geracaoOperacional != null
      ? Number(entrada.geracaoOperacional)
      : _geracaoOperacional;

    const verificarGeracaoValida = () => {
      if (!ativo || _encerrado) return false;
      if (Number(geracaoTick) !== Number(_geracaoOperacional)) return false;
      if (typeof entrada.verificarGeracaoValida === 'function') {
        return entrada.verificarGeracaoValida() === true;
      }
      return true;
    };

    // Mesmo objeto driver criado na fábrica — evidência E-03.
    // entrada.driver: override só para testes C8 (FAKE operacional, físico off).
    return WorkerService.processarProximo({
      db,
      empresaId,
      unidadeId,
      workerId,
      estacaoImpressaoId: entrada.estacaoImpressaoId,
      limiteMs: entrada.limiteMs,
      geracaoOperacional: geracaoTick
    }, {
      db,
      driver: entrada.driver || driver,
      verificarGeracaoValida,
      __antesClaim: entrada.__antesClaim,
      __antesUpdateClaim: entrada.__antesUpdateClaim,
      __antesCommitClaim: entrada.__antesCommitClaim,
      __antesCommitDentroGate: entrada.__antesCommitDentroGate,
      __aposCommitDentroGate: entrada.__aposCommitDentroGate,
      __antesDriver: entrada.__antesDriver
    });
  }

  return {
    modo,
    driver,
    meta,
    tick,
    obterGeracaoOperacional,
    definirGeracaoOperacional,
    invalidarGeracaoOperacional,
    /** Evidência E-03: driver realmente injetado neste worker. */
    obterDriverInjetado() {
      return driver;
    },
    obterContexto() {
      return {
        empresaId: contextoPadrao.empresaId,
        unidadeId: contextoPadrao.unidadeId,
        workerId: contextoPadrao.workerId,
        tem_db: !!contextoPadrao.db,
        geracao_operacional: _geracaoOperacional
      };
    },
    atualizarContexto(parcial = {}) {
      if (!ativo || _encerrado) {
        const err = new Error('Worker encerrado — contexto não pode ser atualizado.');
        err.codigo = 'IMPRESSAO_WORKER_ENCERRADO';
        throw err;
      }
      if (parcial.db !== undefined) contextoPadrao.db = parcial.db;
      if (parcial.empresaId != null) contextoPadrao.empresaId = parcial.empresaId;
      if (parcial.unidadeId != null) contextoPadrao.unidadeId = parcial.unidadeId;
      if (parcial.workerId != null) contextoPadrao.workerId = String(parcial.workerId);
      if (parcial.geracaoOperacional != null) {
        definirGeracaoOperacional(parcial.geracaoOperacional);
      }
      return this.obterContexto();
    },
    encerrar() {
      ativo = false;
      _geracaoOperacional += 1;
    },
    estaAtivo() {
      return ativo === true && _encerrado !== true;
    },
    descrever() {
      return {
        ...meta,
        modo,
        worker_id_padrao: contextoPadrao.workerId,
        ativo: this.estaAtivo(),
        geracao_operacional: _geracaoOperacional,
        impressao_fisica_autorizada: autorizarSpoolerReal === true
          && String(process.env.CDS_COZINHA_IMPRESSAO_FISICA_AUTORIZADA || '') === '1'
      };
    }
  };
}

/**
 * Instala no processo Electron (main). Idempotente: segunda chamada devolve a mesma instância.
 * Não inicia loop automático — ticks são explícitos.
 * Força autorizarSpoolerReal=false (físico off).
 */
function instalarWorkerImpressaoCozinhaNoElectron(opts = {}) {
  if (_instancia && !_encerrado && _instancia.estaAtivo()) {
    // Unicidade: não cria segundo worker.
    if (opts.db != null || opts.empresaId != null || opts.unidadeId != null) {
      _instancia.atualizarContexto({
        db: opts.db,
        empresaId: opts.empresaId,
        unidadeId: opts.unidadeId,
        workerId: opts.workerId
      });
    }
    return _instancia;
  }

  _encerrado = false;
  _instancia = criarWorkerImpressaoCozinha({
    modo: opts.modo || 'ELECTRON',
    obterWebContents: opts.obterWebContents,
    criarJanelaImpressao: opts.criarJanelaImpressao,
    adapter: opts.adapter,
    permitirAdapterCompat: opts.permitirAdapterCompat === true,
    autorizarSpoolerReal: false,
    workerId: opts.workerId || 'electron-cozinha-worker',
    db: opts.db || null,
    empresaId: opts.empresaId,
    unidadeId: opts.unidadeId,
    timeoutMs: opts.timeoutMs,
    fake: opts.fake
  });
  _instalacoes += 1;
  return _instancia;
}

/**
 * Encerramento do app: bloqueia novos ticks e limpa singleton.
 */
function encerrarWorkerImpressaoCozinhaNoElectron() {
  _encerrado = true;
  if (_instancia && typeof _instancia.encerrar === 'function') {
    _instancia.encerrar();
  }
  const anterior = _instancia;
  _instancia = null;
  return {
    encerrado: true,
    havia_instancia: !!anterior,
    instalacoes: _instalacoes
  };
}

function obterWorkerImpressaoCozinhaInstalado() {
  return _instancia;
}

function contarInstalacoesWorkerImpressao() {
  return _instalacoes;
}

/** Somente testes. */
function _resetBootstrapWorkerImpressaoParaTeste() {
  if (_instancia && typeof _instancia.encerrar === 'function') {
    _instancia.encerrar();
  }
  _instancia = null;
  _instalacoes = 0;
  _encerrado = false;
}

/**
 * Simula o momento Electron `ready-to-show` chamando o instalador real.
 * Usado pelo teste E-03 — não bypassa `instalarWorkerImpressaoCozinhaNoElectron`.
 */
function simularReadyToShowElectronInstalarWorker(opts = {}) {
  return instalarWorkerImpressaoCozinhaNoElectron(opts);
}

module.exports = {
  criarWorkerImpressaoCozinha,
  instalarWorkerImpressaoCozinhaNoElectron,
  encerrarWorkerImpressaoCozinhaNoElectron,
  obterWorkerImpressaoCozinhaInstalado,
  contarInstalacoesWorkerImpressao,
  simularReadyToShowElectronInstalarWorker,
  _resetBootstrapWorkerImpressaoParaTeste
};
