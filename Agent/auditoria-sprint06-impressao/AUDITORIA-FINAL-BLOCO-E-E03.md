# AUDITORIA FINAL E-03 — Integração real Worker Electron

**Data:** 2026-11-17  
**Escopo:** somente E-03 (E-01/E-02 aprovados)  
**Impressão física / spooler:** NÃO  
**Schema:** v3  

---

## 1. Bootstrap completo

```js
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
    // Mesmo objeto driver criado na fábrica — evidência E-03.
    return WorkerService.processarProximo({
      db,
      empresaId,
      unidadeId,
      workerId,
      estacaoImpressaoId: entrada.estacaoImpressaoId,
      limiteMs: entrada.limiteMs
    }, { db, driver });
  }

  return {
    modo,
    driver,
    meta,
    tick,
    /** Evidência E-03: driver realmente injetado neste worker. */
    obterDriverInjetado() {
      return driver;
    },
    obterContexto() {
      return {
        empresaId: contextoPadrao.empresaId,
        unidadeId: contextoPadrao.unidadeId,
        workerId: contextoPadrao.workerId,
        tem_db: !!contextoPadrao.db
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
      return this.obterContexto();
    },
    encerrar() {
      ativo = false;
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
```

## 2. Wiring electron.js

Require:

```js
// Sprint 06 Bloco E — IPC cozinha (isolado de cupom/DANFE; print real off por padrão)
const { registrarCozinhaImpressaoHandlers } = require('./electron-cozinha-impressao');
registrarCozinhaImpressaoHandlers(ipcMain);

// Sprint 06 Bloco E (E-03) — bootstrap Worker + driver ELECTRON injetado
const {
  instalarWorkerImpressaoCozinhaNoElectron,
  encerrarWorkerImpressaoCozinhaNoElectron,
  obterWorkerImpressaoCozinhaInstalado
} = require('./backend/services/cozinha/CozinhaImpressaoWorkerBootstrap');
let workerImpressaoCozinha = null;

ipcMain.removeHandler('selecionar-pasta-backup');
```

Instalação em `ready-to-show`:

```js

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
    // E-03: instancia driver ELECTRON e injeta no Worker (print físico off).
    try {
      workerImpressaoCozinha = instalarWorkerImpressaoCozinhaNoElectron({
        obterWebContents: () => (mainWindow && !mainWindow.isDestroyed()
          ? mainWindow.webContents
          : null),
        modo: 'ELECTRON',
        autorizarSpoolerReal: false
      });
      console.log(
        '[COZINHA] Worker impressão instalado:',
        JSON.stringify(workerImpressaoCozinha.descrever())
      );
    } catch (err) {
      console.warn(
        '[COZINHA] Falha ao instalar Worker de impressão:',
        err && err.message ? err.message : err
      );
    }
  });

```

Exposição global:

```js

  // Exposto para diagnóstico / ticks manuais (sem loop automático).
  global.obterWorkerImpressaoCozinha = obterWorkerImpressaoCozinhaInstalado;

```

Encerramento em `will-quit`:

```js

app.on('will-quit', () => {
  // E-03: encerra Worker de impressão (bloqueia ticks / limpa singleton).
  try {
    workerImpressaoCozinha = null;
    encerrarWorkerImpressaoCozinhaNoElectron();
  } catch (_) { /* ignore */ }
  try {
    const cm = require('./backend/motores/equipamentos/connection/ConnectionManager');
    if (cm && typeof cm.closeAll === 'function') {
      // sync fire — will-quit não aguarda promise longamente
      cm.closeAll().catch(() => {});
    }
  } catch (_) { /* ignore */ }
});

```

## 3. Wiring electron-common.js

```js
// Sprint 06 Bloco E — IPC cozinha (isolado; print real off por padrão)
const { registrarCozinhaImpressaoHandlers } = require('./electron-cozinha-impressao');
registrarCozinhaImpressaoHandlers(ipcMain);

const {
  instalarWorkerImpressaoCozinhaNoElectron,
  encerrarWorkerImpressaoCozinhaNoElectron,
  obterWorkerImpressaoCozinhaInstalado
} = require('./backend/services/cozinha/CozinhaImpressaoWorkerBootstrap');

```

```js

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
    try {
      const worker = instalarWorkerImpressaoCozinhaNoElectron({
        obterWebContents: () => (mainWindow && !mainWindow.isDestroyed()
          ? mainWindow.webContents
          : null),
        modo: 'ELECTRON',
        autorizarSpoolerReal: false
      });
      global.obterWorkerImpressaoCozinha = obterWorkerImpressaoCozinhaInstalado;
      console.log('[COZINHA] Worker impressão instalado:', JSON.stringify(worker.descrever()));
    } catch (err) {
      console.warn('[COZINHA] Falha ao instalar Worker de impressão:', err && err.message ? err.message : err);
    }
  });

```

```js

  app.on('will-quit', () => {
    // E-03: encerra Worker de impressão (bloqueia ticks / limpa singleton).
    try {
      encerrarWorkerImpressaoCozinhaNoElectron();
    } catch (_) { /* ignore */ }
    try {
      const cm = require('./backend/motores/equipamentos/connection/ConnectionManager');
      if (cm && typeof cm.closeAll === 'function') {
        cm.closeAll().catch(() => {});
      }
    } catch (_) { /* ignore */ }
  });
```

## 4. IPC cozinha (registro completo)

```js
/**
 * IPC Electron — impressão de COZINHA (Sprint 06 Bloco E · correção auditoria).
 *
 * E-02: renderer NÃO pode disparar print genérico (texto/device arbitrários).
 * Print físico só via Worker + adapter de produção (in-process) ou
 * referência canônica a job (imprimir-job), com remetente validado.
 */
'use strict';

const { BrowserWindow } = require('electron');
const {
  IPC_CANAIS,
  validarRemetenteIpc,
  rejeitarImpressaoGenericaPorIpc,
  sanitizarReferenciaJobImpressao,
  isImpressaoFisicaAutorizada
} = require('./backend/services/cozinha/cozinhaImpressaoElectronBridge');

/** Tokens de Worker confiáveis registrados pelo main (E-02/E-03). */
const _tokensWorkerConfiaveis = new Set();

function registrarTokenWorkerConfiavel(token) {
  if (token) _tokensWorkerConfiaveis.add(String(token));
}

function limparTokensWorkerConfiaveis() {
  _tokensWorkerConfiaveis.clear();
}

function criarAdapterListagem(event) {
  return {
    async getPrinters() {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || !win.webContents) return [];
      const lista = await win.webContents.getPrintersAsync();
      return (lista || []).map((imp) => ({
        name: imp.name,
        displayName: imp.displayName || imp.name,
        description: imp.description,
        status: imp.status,
        isDefault: imp.isDefault === true
      }));
    }
  };
}

/**
 * @param {import('electron').IpcMain} ipcMain
 */
function registrarCozinhaImpressaoHandlers(ipcMain) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') return;

  try { ipcMain.removeHandler(IPC_CANAIS.LISTAR); } catch (_e) { /* ignore */ }
  try { ipcMain.removeHandler(IPC_CANAIS.IMPRIMIR); } catch (_e) { /* ignore */ }
  try { ipcMain.removeHandler(IPC_CANAIS.IMPRIMIR_JOB); } catch (_e) { /* ignore */ }

  ipcMain.handle(IPC_CANAIS.LISTAR, async (event) => {
    validarRemetenteIpc(event, {
      resolveWindow: (sender) => BrowserWindow.fromWebContents(sender)
    });
    const adapter = criarAdapterListagem(event);
    const lista = await adapter.getPrinters();
    return {
      success: true,
      total: lista.length,
      impressoras: lista,
      impressao_fisica: false,
      canal: IPC_CANAIS.LISTAR
    };
  });

  // E-02: canal genérico sempre bloqueado (renderer não imprime).
  ipcMain.handle(IPC_CANAIS.IMPRIMIR, async (_event, rawPayload = {}) => {
    try {
      rejeitarImpressaoGenericaPorIpc(rawPayload || {});
    } catch (err) {
      return {
        success: false,
        resultado: 'FALHA',
        codigo: err.codigo || 'IMPRESSAO_IPC_PRINT_BLOQUEADO',
        erro: err.message,
        impressao_fisica: false,
        dry_run: true
      };
    }
    return {
      success: false,
      codigo: 'IMPRESSAO_IPC_PRINT_BLOQUEADO',
      impressao_fisica: false
    };
  });

  // Referência a job — ainda exige Worker token + autorização; não aceita texto arbitrário.
  ipcMain.handle(IPC_CANAIS.IMPRIMIR_JOB, async (event, rawPayload = {}) => {
    try {
      validarRemetenteIpc(event, {
        resolveWindow: (sender) => BrowserWindow.fromWebContents(sender),
        tokenWorker: rawPayload && rawPayload.worker_token,
        tokensConfiaveis: [..._tokensWorkerConfiaveis]
      });
      const ref = sanitizarReferenciaJobImpressao(rawPayload || {});
      if (!isImpressaoFisicaAutorizada({
        autorizarSpoolerReal: ref.autorizar_spooler_real
      })) {
        return {
          success: false,
          resultado: 'SIMULADO',
          codigo: 'IMPRESSAO_FISICA_NAO_AUTORIZADA',
          erro: 'Impressão física desabilitada. Dry-run não declara ACEITA.',
          impressao_fisica: false,
          dry_run: true,
          job_id: ref.job_id
        };
      }
      // Print real via IPC ainda não executa daqui: o caminho físico é o adapter
      // in-process do Worker (E-03). Este canal só valida autorização/canonicidade.
      return {
        success: false,
        resultado: 'FALHA',
        codigo: 'IMPRESSAO_USE_WORKER_ADAPTER',
        erro: 'Use o adapter ELECTRON de produção injetado no Worker (in-process).',
        impressao_fisica: false,
        job_id: ref.job_id
      };
    } catch (err) {
      return {
        success: false,
        resultado: 'FALHA',
        codigo: err.codigo || 'IMPRESSAO_IPC_ERRO',
        erro: err.message,
        impressao_fisica: false
      };
    }
  });
}

module.exports = {
  registrarCozinhaImpressaoHandlers,
  registrarTokenWorkerConfiavel,
  limparTokensWorkerConfiaveis,
  IPC_CANAIS
};
```

## 5. Comprovações

| # | Requisito | Evidência |
|---|---|---|
| 1 | Bootstrap chamado pelo Electron | `ready-to-show` → `instalarWorkerImpressaoCozinhaNoElectron` |
| 2 | `criarDriverParaWorker('ELECTRON')` | Bootstrap + teste 14 (`nome=ELECTRON`, `isProducao`) |
| 3 | Mesmo driver no tick | closure + `obterDriverInjetado() === worker.driver` |
| 4 | db/empresa/unidade | instalador + `obterContexto()` |
| 5 | Momento correto | instalação em `ready-to-show`; sem loop automático |
| 6 | Sem duas inicializações | instalador idempotente; contador permanece 1 |
| 7 | Encerramento | `will-quit` → `encerrar…`; tick → `IMPRESSAO_WORKER_ENCERRADO` |
| 8 | FAKE isolado | fábrica FAKE ≠ driver ELECTRON instalado |

## 6. Teste 14 (instalador real)

Fluxo obrigatório: evento Electron mock → `simularReadyToShowElectronInstalarWorker` (= `instalarWorkerImpressaoCozinhaNoElectron`) → worker → tick → ELECTRON.

- Instalador chamado; worker único; driver ELECTRON injetado; tick executa.
- Segunda init não cria outro worker.
- Encerramento impede novos ticks.
- `adapter.prints.length === 0` (sem impressão física).

## 7. Segurança

- `CDS_BLOQUEAR_BANCO_OFICIAL=1`, banco temp/`memory`, schema v3
- Spooler real off; `CDS_COZINHA_IMPRESSAO_FISICA_AUTORIZADA` ausente
- Sem alteração em PDV/fiscal/preparação/despacho/estoque/financeiro

## 8. Resultados

Ver `LOG-BLOCO-E-AUDITORIA-FINAL-E03.txt` (TOTAL_FAIL: 0).

## Veredito

# BLOCO E — PRONTO PARA HOMOLOGAÇÃO CONTROLADA

Homologação física e habilitação de spooler real **não** foram executadas.
Autorização para isso é decisão separada do Product Owner.
