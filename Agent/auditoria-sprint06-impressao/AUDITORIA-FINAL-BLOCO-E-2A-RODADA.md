# Auditoria final — Sprint 06 · Bloco E · 2ª rodada

**Data:** 2026-11-17  
**Escopo:** evidências para o Tech Lead — sem novas funcionalidades  
**Impressão física:** NÃO EXECUTADA  
**Spooler real:** NÃO HABILITADO  
**Homologação física:** NÃO INICIADA

---

## Artefatos

| Artefato | Conteúdo |
|---|---|
| `DIFF-BLOCO-E-CORRECAO-2A-RODADA.patch` | Diff integral (93 578 bytes / 2 680 linhas) |
| `LOG-BLOCO-E-CORRECAO-2A-RODADA.txt` | Logs integrais A–E + S01–S05 |
| `RELATORIO-BLOCO-E-CORRECAO-2A-RODADA.md` | Relatório de entrega |
| Este arquivo | Código completo + análise pedida |

---

## 1. Diff completo

Arquivo `DIFF-BLOCO-E-CORRECAO-2A-RODADA.patch` regenerado e validado:

- Contém `simularProximoSemClaim`, `carregarJobCanonicoParaProcessamento`, Bootstrap e wiring Electron
- Não é cópia do relatório (incidente anterior corrigido nesta entrega de auditoria)
- Untracked: new file completo; `electron.js` / `electron-common.js` / `preload.js`: git diff vs HEAD

Arquivos no patch: WorkerBootstrap, WorkerService, driver/bridge/Electron/Producao, electron-cozinha-impressao, suite E, electron.js, electron-common.js, preload.js.

---

## 2. E-01 — Simulação

### 2.1 Tratamento de SIMULADO + detecção de modo simulação

```js
function estadoFinalDeResultadoDriver(resultado) {
  if (resultado === RESULTADOS_DRIVER.ACEITA) return ESTADOS_FILA.ACEITA_PELO_SPOOLER;
  if (resultado === RESULTADOS_DRIVER.FALHA) return ESTADOS_FILA.FALHA;
  // SIMULADO não é estado de fila operacional — não deve passar por registrarResultado.
  if (resultado === RESULTADOS_DRIVER.SIMULADO) {
    throw erroImpressao(
      'SIMULADO não mapeia estado operacional da fila (use simularProximoSemClaim).',
      409,
      'IMPRESSAO_SIMULADO_NAO_OPERACIONAL'
    );
  }
  return ESTADOS_FILA.RESULTADO_INCERTO;
}

function driverEmModoSimulacao(driver) {
  if (!driver) return false;
  if (driver.nome === 'ELECTRON') {
    return driver.spoolerRealHabilitado !== true;
  }
  return false;
}
```

Em `registrarResultado`, SIMULADO também é rejeitado (`IMPRESSAO_SIMULADO_NAO_OPERACIONAL`) antes de qualquer UPDATE.

### 2.2 simularProximoSemClaim (completo)

```js
async function simularProximoSemClaim(entrada = {}, opts = {}) {
  const db = opts.db || entrada.db;
  if (!db) throw erroImpressao('Banco indisponível.', 500, 'DB_INDISPONIVEL');

  const empresaId = exigirEmpresa(entrada.empresaId != null ? entrada.empresaId : entrada.empresa_id);
  const unidadeId = exigirUnidadeOperacional(
    entrada.unidadeId != null ? entrada.unidadeId : entrada.unidade_id
  );
  const workerId = normalizarWorkerId(
    entrada.workerId != null ? entrada.workerId : (entrada.worker_id != null ? entrada.worker_id : 'sim-worker')
  );
  const driver = opts.driver || entrada.driver;
  if (!driver) {
    throw erroImpressao('Driver obrigatório para simulação.', 400, 'IMPRESSAO_DRIVER_OBRIGATORIO');
  }

  let sql = `
    SELECT *
    FROM cozinha_impressao_fila
    WHERE empresa_id = ?
      AND unidade_id = ?
      AND estado = ?
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  `;
  const params = [empresaId, unidadeId, ESTADOS_FILA.PENDENTE];
  const row = await dbGet(db, sql, params);
  if (!row) {
    return {
      success: true,
      processado: false,
      simulado: true,
      resultado_driver: RESULTADOS_DRIVER.SIMULADO,
      job: null,
      tentativas: null,
      impressao_fisica: false
    };
  }

  const tentativasAntes = Number(row.tentativas) || 0;
  const estacao = row.estacao_impressao_id
    ? await dbGet(db, `
        SELECT id, device_name, largura_mm, vias, codigo_estacao
        FROM cozinha_estacoes_impressao
        WHERE id = ? AND empresa_id = ? AND unidade_id = ?
      `, [row.estacao_impressao_id, empresaId, unidadeId])
    : null;

  const jobCanonico = FilaService.mapearJob(row, { incluirSnapshot: true });
  // Snapshot exclusivamente do banco (já em row.payload_snapshot).
  jobCanonico.payload_snapshot = row.payload_snapshot;

  let driverOut;
  try {
    const raw = await driver.imprimir({
      job: jobCanonico,
      empresaId,
      unidadeId,
      workerId,
      estacao,
      device_name: estacao && estacao.device_name,
      impressao_fisica: false,
      modo_simulacao: true
    });
    driverOut = assertResultadoDriver({
      ...raw,
      resultado: raw.resultado === RESULTADOS_DRIVER.ACEITA
        ? RESULTADOS_DRIVER.SIMULADO
        : raw.resultado,
      spooler_job_token: null,
      impressao_fisica: false,
      dry_run: true,
      driver: raw.driver || driver.nome || 'ELECTRON'
    });
  } catch (err) {
    driverOut = assertResultadoDriver({
      resultado: RESULTADOS_DRIVER.SIMULADO,
      spooler_job_token: null,
      erro: `Simulação: ${err && err.message ? err.message : String(err)}`,
      impressao_fisica: false,
      dry_run: true,
      driver: (driver && driver.nome) || 'ELECTRON'
    });
  }

  // Força contrato E-01: nunca ACEITA / nunca token.
  if (driverOut.resultado === RESULTADOS_DRIVER.ACEITA) {
    driverOut.resultado = RESULTADOS_DRIVER.SIMULADO;
  }
  driverOut.spooler_job_token = null;
  driverOut.dry_run = true;

  const depois = await dbGet(db, `
    SELECT id, estado, tentativas, spooler_job_token, payload_snapshot
    FROM cozinha_impressao_fila WHERE id = ?
  `, [row.id]);

  return {
    success: true,
    processado: false,
    simulado: true,
    resultado_driver: RESULTADOS_DRIVER.SIMULADO,
    job: FilaService.mapearJob(depois || row, { incluirSnapshot: true }),
    tentativas: Number(depois && depois.tentativas != null ? depois.tentativas : tentativasAntes),
    tentativas_antes: tentativasAntes,
    estado: (depois && depois.estado) || ESTADOS_FILA.PENDENTE,
    spooler_job_token: null,
    impressao_fisica: false
  };
}
```

| Garantia | Mecanismo |
|---|---|
| Não reivindica | apenas SELECT PENDENTE; sem UPDATE de claim |
| Não altera tentativas | nenhum UPDATE na fila; re-leitura confirma |
| Não modifica estado | permanece PENDENTE |
| Não cria token | `spooler_job_token: null` forçado |

### 2.3 processarProximo (completo)

```js
async function processarProximo(entrada = {}, opts = {}) {
  const db = opts.db || entrada.db;
  if (!db) throw erroImpressao('Banco indisponível.', 500, 'DB_INDISPONIVEL');

  const empresaId = exigirEmpresa(entrada.empresaId != null ? entrada.empresaId : entrada.empresa_id);
  const unidadeId = exigirUnidadeOperacional(
    entrada.unidadeId != null ? entrada.unidadeId : entrada.unidade_id
  );
  const workerId = normalizarWorkerId(
    entrada.workerId != null ? entrada.workerId : entrada.worker_id
  );
  const driver = opts.driver || entrada.driver || criarFakeDriver({ modo: 'sucesso' });

  const recuperacao = await recuperarJobsAbandonados({
    db,
    empresaId,
    unidadeId,
    limiteMs: entrada.limiteMs != null ? entrada.limiteMs : entrada.abandono_ms
  }, { db });

  if (driverEmModoSimulacao(driver)) {
    const sim = await simularProximoSemClaim({
      db, empresaId, unidadeId, workerId
    }, { db, driver });
    return {
      success: true,
      processado: false,
      simulado: true,
      recuperacao,
      job: sim.job,
      resultado_driver: RESULTADOS_DRIVER.SIMULADO,
      tentativas: sim.tentativas,
      impressao_fisica: false
    };
  }

  const claim = await reivindicarProximoJob({
    db,
    empresaId,
    unidadeId,
    workerId,
    estacaoImpressaoId: entrada.estacaoImpressaoId != null
      ? entrada.estacaoImpressaoId
      : entrada.estacao_impressao_id
  }, { db });

  if (!claim.reivindicado || !claim.job) {
    return {
      success: true,
      processado: false,
      simulado: false,
      recuperacao,
      job: null,
      impressao_fisica: false
    };
  }

  const resultado = await processarJobReivindicado({
    db,
    empresaId,
    unidadeId,
    workerId,
    job: { id: claim.job.id }
  }, { db, driver });

  return {
    success: true,
    processado: true,
    simulado: false,
    recuperacao,
    job: resultado.job,
    resultado_driver: resultado.resultado_driver,
    impressao_fisica: false
  };
}
```

### 2.4 Tick — criação e execução

Ver §4 (Bootstrap). Com `autorizarSpoolerReal:false`, `driverEmModoSimulacao` é true e todo tick cai em `simularProximoSemClaim`.

**Evidência:** teste E-01 — 5 ciclos, tentativas=0, estado PENDENTE, token nulo, prints=0.

---

## 3. E-02 — Job canônico

### 3.1 carregarJobCanonicoParaProcessamento (completo)

```js
async function carregarJobCanonicoParaProcessamento(db, {
  jobId,
  empresaId,
  unidadeId,
  workerId
}) {
  const id = parsePositiveInteger(jobId);
  if (!id) {
    throw erroImpressao('job id obrigatório.', 400, 'IMPRESSAO_JOB_ID_OBRIGATORIO');
  }
  const row = await dbGet(db, `
    SELECT *
    FROM cozinha_impressao_fila
    WHERE id = ?
  `, [id]);

  if (!row) {
    throw erroImpressao(
      'Trabalho de impressão não encontrado.',
      404,
      'IMPRESSAO_JOB_NAO_ENCONTRADO',
      { detalhes: { job_id: id } }
    );
  }
  if (Number(row.empresa_id) !== Number(empresaId)) {
    throw erroImpressao(
      'Job não pertence à empresa autenticada.',
      403,
      'IMPRESSAO_JOB_EMPRESA_DIVERGENTE',
      { detalhes: { job_id: id, empresa_id: row.empresa_id } }
    );
  }
  if (Number(row.unidade_id) !== Number(unidadeId)) {
    throw erroImpressao(
      'Job não pertence à unidade autenticada.',
      403,
      'IMPRESSAO_JOB_UNIDADE_DIVERGENTE',
      { detalhes: { job_id: id, unidade_id: row.unidade_id } }
    );
  }
  if (String(row.estado) !== ESTADOS_FILA.PROCESSANDO) {
    throw erroImpressao(
      'Job não está PROCESSANDO.',
      409,
      'IMPRESSAO_JOB_ESTADO_INVALIDO',
      { detalhes: { job_id: id, estado: row.estado } }
    );
  }
  if (String(row.worker_id || '') !== String(workerId)) {
    throw erroImpressao(
      'Job reivindicado por outro worker.',
      409,
      'IMPRESSAO_WORKER_DIVERGENTE',
      { detalhes: { job_id: id, worker_id: row.worker_id } }
    );
  }
  if (row.payload_snapshot == null || String(row.payload_snapshot).trim() === '') {
    throw erroImpressao(
      'Snapshot canônico ausente no job persistido.',
      409,
      'IMPRESSAO_SNAPSHOT_AUSENTE',
      { detalhes: { job_id: id } }
    );
  }
  return row;
}
```

### 3.2 processarJobReivindicado (completo)

```js
async function processarJobReivindicado(entrada = {}, opts = {}) {
  const db = opts.db || entrada.db;
  if (!db) throw erroImpressao('Banco indisponível.', 500, 'DB_INDISPONIVEL');

  const empresaId = exigirEmpresa(entrada.empresaId != null ? entrada.empresaId : entrada.empresa_id);
  const unidadeId = exigirUnidadeOperacional(
    entrada.unidadeId != null ? entrada.unidadeId : entrada.unidade_id
  );
  const workerId = normalizarWorkerId(
    entrada.workerId != null ? entrada.workerId : entrada.worker_id
  );
  const jobIdHint = parsePositiveInteger(
    (entrada.job && entrada.job.id) != null ? entrada.job.id : (entrada.jobId != null ? entrada.jobId : entrada.id)
  );
  if (!jobIdHint) {
    throw erroImpressao('job reivindicado obrigatório.', 400, 'IMPRESSAO_JOB_OBRIGATORIO');
  }

  // E-02: nunca confiar no objeto job recebido — recarrega do banco.
  const row = await carregarJobCanonicoParaProcessamento(db, {
    jobId: jobIdHint,
    empresaId,
    unidadeId,
    workerId
  });

  const driver = opts.driver || entrada.driver || criarFakeDriver({ modo: 'sucesso' });
  if (driver.impressaoFisica === true) {
    throw erroImpressao(
      'Driver não pode declarar impressaoFisica=true (ACEITA ≠ papel impresso).',
      500,
      'IMPRESSAO_FISICA_PROIBIDA'
    );
  }
  if (driverEmModoSimulacao(driver)) {
    throw erroImpressao(
      'Driver em modo simulação não pode processar claim operacional.',
      409,
      'IMPRESSAO_SIMULADO_NAO_OPERACIONAL'
    );
  }

  const estacao = row.estacao_impressao_id
    ? await dbGet(db, `
        SELECT id, device_name, largura_mm, vias, codigo_estacao
        FROM cozinha_estacoes_impressao
        WHERE id = ? AND empresa_id = ? AND unidade_id = ?
      `, [row.estacao_impressao_id, empresaId, unidadeId])
    : null;

  const jobCanonico = FilaService.mapearJob(row, { incluirSnapshot: true });
  jobCanonico.payload_snapshot = row.payload_snapshot;

  let driverOut;
  try {
    const raw = await driver.imprimir({
      job: jobCanonico,
      empresaId,
      unidadeId,
      workerId,
      estacao,
      device_name: estacao && estacao.device_name,
      impressao_fisica: false
    });
    driverOut = assertResultadoDriver({
      ...raw,
      impressao_fisica: false,
      driver: raw.driver || driver.nome || 'FAKE'
    });
  } catch (err) {
    if (err && err.codigo && String(err.codigo).startsWith('IMPRESSAO_')) {
      throw err;
    }
    driverOut = assertResultadoDriver({
      resultado: RESULTADOS_DRIVER.INCERTO,
      spooler_job_token: null,
      erro: `Exceção no driver: ${err && err.message ? err.message : String(err)}`,
      impressao_fisica: false,
      driver: (driver && driver.nome) || 'FAKE'
    });
  }

  if (driverOut.resultado === RESULTADOS_DRIVER.SIMULADO) {
    throw erroImpressao(
      'Driver retornou SIMULADO em caminho operacional.',
      409,
      'IMPRESSAO_SIMULADO_NAO_OPERACIONAL'
    );
  }

  return registrarResultado({
    db,
    empresaId,
    unidadeId,
    jobId: row.id,
    workerId,
    resultado: driverOut.resultado,
    spooler_job_token: driverOut.spooler_job_token,
    erro: driverOut.erro,
    driver: driverOut.driver
  }, { db });
}
```

### 3.3 registrarResultado (completo)

```js
async function registrarResultado(entrada = {}, opts = {}) {
  const db = opts.db || entrada.db;
  if (!db) throw erroImpressao('Banco indisponível.', 500, 'DB_INDISPONIVEL');

  const empresaId = exigirEmpresa(entrada.empresaId != null ? entrada.empresaId : entrada.empresa_id);
  const unidadeId = exigirUnidadeOperacional(
    entrada.unidadeId != null ? entrada.unidadeId : entrada.unidade_id
  );
  const jobId = parsePositiveInteger(entrada.jobId != null ? entrada.jobId : entrada.id);
  const workerId = normalizarWorkerId(
    entrada.workerId != null ? entrada.workerId : entrada.worker_id
  );
  if (!jobId) {
    throw erroImpressao('job id obrigatório.', 400, 'IMPRESSAO_JOB_ID_OBRIGATORIO');
  }

  const driverOut = assertResultadoDriver({
    resultado: entrada.resultado,
    spooler_job_token: entrada.spooler_job_token != null
      ? entrada.spooler_job_token
      : entrada.spoolerJobToken,
    erro: entrada.erro != null ? entrada.erro : entrada.ultimo_erro,
    impressao_fisica: false,
    driver: entrada.driver || 'FAKE'
  });

  if (driverOut.resultado === RESULTADOS_DRIVER.SIMULADO) {
    throw erroImpressao(
      'SIMULADO não pode ser registrado na fila operacional.',
      409,
      'IMPRESSAO_SIMULADO_NAO_OPERACIONAL'
    );
  }

  const estadoFinal = estadoFinalDeResultadoDriver(driverOut.resultado);
  const agora = agoraIso();

  const upd = await dbRun(db, `
    UPDATE cozinha_impressao_fila
    SET estado = ?,
        spooler_job_token = CASE
          WHEN ? IS NOT NULL THEN ?
          ELSE spooler_job_token
        END,
        ultimo_erro = ?,
        updated_at = ?
    WHERE id = ?
      AND empresa_id = ?
      AND unidade_id = ?
      AND estado = ?
      AND worker_id = ?
  `, [
    estadoFinal,
    driverOut.spooler_job_token,
    driverOut.spooler_job_token,
    driverOut.erro,
    agora,
    jobId,
    empresaId,
    unidadeId,
    ESTADOS_FILA.PROCESSANDO,
    workerId
  ]);

  if (!upd || upd.changes !== 1) {
    throw erroImpressao(
      'Job não está PROCESSANDO por este worker (claim perdido ou já finalizado).',
      409,
      'IMPRESSAO_RESULTADO_RECUSADO',
      { detalhes: { job_id: jobId, worker_id: workerId } }
    );
  }

  const out = await FilaService.obterJob({
    db, empresaId, unidadeId, id: jobId
  }, { db, incluirSnapshot: true });

  return {
    success: true,
    job: out.job,
    resultado_driver: driverOut.resultado,
    impressao_fisica: false
  };
}
```

### 3.4 Sequência claim → validação → render → driver

```
processarProximo (driver operacional)
  → reivindicarProximoJob          // claim atômico
  → processarJobReivindicado({ job:{id} })
       → carregarJobCanonico…      // revalida banco
       → mapearJob + payload_snapshot do SELECT
       → driver.imprimir(jobCanonico) // render a partir do snapshot DB
       → registrarResultado         // UPDATE condicional PROCESSANDO+worker
```

O argumento `job` só fornece o id. Snapshot adulterado no objeto recebido é ignorado (teste 4).

### 3.5 Janela validação → driver → registro

| Momento | Proteção | Lacuna residual |
|---|---|---|
| Claim | BEGIN IMMEDIATE + UPDATE condicional (Bloco D) | — |
| Validação canônica | re-SELECT + empresa/unidade/PROCESSANDO/worker/snapshot | snapshot fica em memória após o SELECT |
| Validação → `driver.imprimir` | job continua PROCESSANDO pelo worker; outro claim não pega o mesmo | recuperação por abandono pode marcar INCERTO se `processando_em` expirar |
| `imprimir` → `registrarResultado` | UPDATE WHERE estado=PROCESSANDO AND worker_id=? | se propriedade/estado mudou: `IMPRESSAO_RESULTADO_RECUSADO`; o driver **já pode ter sido chamado** |
| Nesta rodada (físico off) | dry-run / spooler não autorizado | sem envio a spooler real na janela |

**Conclusão:** driver só recebe job/snapshot canônicos do banco no instante da validação; a finalização da fila é condicional ao claim ainda válido. A janela TOCTOU existe e é mitigada no **registro**, não no pré-print.

---

## 4. E-03 — Bootstrap real

### 4.1 CozinhaImpressaoWorkerBootstrap.js (completo)

```js
/**
 * Bootstrap do Worker de impressão de cozinha — Sprint 06 Bloco E (E-03).
 *
 * Ponto de integração real no Electron:
 * 1) cria driver via criarDriverParaWorker('ELECTRON')
 * 2) injeta no WorkerService.processarProximo
 * 3) impressão física permanece desabilitada por padrão
 *
 * FAKE permanece disponível para testes (modo 'FAKE').
 */
'use strict';

const WorkerService = require('./CozinhaImpressaoWorkerService');
const {
  criarDriverParaWorker,
  descreverIntegracaoProducao
} = require('./CozinhaImpressaoElectronProducao');

/** Instância singleton instalada pelo Electron main. */
let _instancia = null;

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

  async function tick(entrada = {}) {
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
    descrever() {
      return {
        ...meta,
        modo,
        worker_id_padrao: contextoPadrao.workerId,
        impressao_fisica_autorizada: autorizarSpoolerReal === true
          && String(process.env.CDS_COZINHA_IMPRESSAO_FISICA_AUTORIZADA || '') === '1'
      };
    }
  };
}

/**
 * Instala no processo Electron (main). Não inicia loop automático por padrão.
 */
function instalarWorkerImpressaoCozinhaNoElectron(opts = {}) {
  _instancia = criarWorkerImpressaoCozinha({
    modo: opts.modo || 'ELECTRON',
    obterWebContents: opts.obterWebContents,
    criarJanelaImpressao: opts.criarJanelaImpressao,
    autorizarSpoolerReal: false,
    workerId: opts.workerId || 'electron-cozinha-worker'
  });
  return _instancia;
}

function obterWorkerImpressaoCozinhaInstalado() {
  return _instancia;
}

module.exports = {
  criarWorkerImpressaoCozinha,
  instalarWorkerImpressaoCozinhaNoElectron,
  obterWorkerImpressaoCozinhaInstalado
};
```

### 4.2 Integração electron.js

Require:

```js
// Sprint 06 Bloco E — IPC cozinha (isolado de cupom/DANFE; print real off por padrão)
const { registrarCozinhaImpressaoHandlers } = require('./electron-cozinha-impressao');
registrarCozinhaImpressaoHandlers(ipcMain);

// Sprint 06 Bloco E (E-03) — bootstrap Worker + driver ELECTRON injetado
const {
  instalarWorkerImpressaoCozinhaNoElectron,
  obterWorkerImpressaoCozinhaInstalado
} = require('./backend/services/cozinha/CozinhaImpressaoWorkerBootstrap');
let workerImpressaoCozinha = null;
```

Instalação (ready-to-show):

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

Exposição global (sem loop):

```js
  // Exposto para diagnóstico / ticks manuais (sem loop automático).
  global.obterWorkerImpressaoCozinha = obterWorkerImpressaoCozinhaInstalado;

  return mainWindow;
```

### 4.3 Integração electron-common.js

Require:

```js
// Sprint 06 Bloco E — IPC cozinha (isolado; print real off por padrão)
const { registrarCozinhaImpressaoHandlers } = require('./electron-cozinha-impressao');
registrarCozinhaImpressaoHandlers(ipcMain);

const {
  instalarWorkerImpressaoCozinhaNoElectron,
  obterWorkerImpressaoCozinhaInstalado
} = require('./backend/services/cozinha/CozinhaImpressaoWorkerBootstrap');
```

Instalação (ready-to-show):

```js
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    }
  }));

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

### 4.4 Criação / execução / encerramento

| Fase | Comportamento |
|---|---|
| Criação | `instalarWorkerImpressaoCozinhaNoElectron` atribui singleton `_instancia` (substitui anterior) |
| Execução | `tick()` → `WorkerService.processarProximo(..., { driver })` com o mesmo objeto injetado |
| Encerramento | sem `stop()`/`dispose()` dedicado; sem loop automático; fim = término do processo Electron ou GC ao reinstalar |

| Requisito | Evidência |
|---|---|
| Uma instância ativa | `_instancia` singleton; `instalar` sobrescreve |
| Sem workers duplicados em loop | nenhum setInterval no bootstrap |
| ELECTRON injetado | `obterDriverInjetado().nome === 'ELECTRON'`, `isProducao === true` (testes 5 e 10) |
| Físico desabilitado | `autorizarSpoolerReal: false` + env física ausente |
| FAKE isolado | `modo: 'FAKE'` → `criarFakeDriver` |
| Entry points | `electron.js` e `electron-common.js` são alternativos — um processo usa um |

---

## 5. Regressão e segurança

### 5.1 Comandos

```bat
set CDS_BLOQUEAR_BANCO_OFICIAL=1
set CDS_TEST_ISOLATION=1

node --test --test-concurrency=1 tests/cozinha/sprint06-bloco-e-electron-integracao.test.js
node --test --test-concurrency=1 tests/cozinha/sprint06-bloco-d-worker-falhas.test.js
node --test --test-concurrency=1 tests/cozinha/sprint06-bloco-c-roteamento-estacoes.test.js
node --test --test-concurrency=1 tests/cozinha/sprint06-bloco-b1-fila-persistencia.test.js
node --test --test-concurrency=1 tests/cozinha/sprint06-bloco-b2-idempotencia-despacho.test.js
node --test --test-concurrency=1 tests/cozinha/sprint06-bloco-a-fundacao-contratos.test.js

node --test --test-concurrency=1 tests/cozinha/sprint01-fundacao-persistencia.test.js tests/cozinha/sprint01-correcao-isolamento-empresa.test.js tests/cozinha/sprint02-despacho-fifo.test.js tests/cozinha/sprint02-correcoes-auditoria.test.js tests/cozinha/sprint02-http-seguranca.test.js tests/cozinha/sprint03-preparacao.test.js tests/cozinha/sprint03-correcoes-auditoria.test.js tests/cozinha/sprint04a-upgrade-schema-v2-v3.test.js tests/cozinha/sprint05-login-unidade-auth.test.js tests/cozinha/sprint05-operacoes-itens.test.js
```

Regenerador do log integral: `node Agent/auditoria-sprint06-impressao/_run-log-bloco-e-2a.js`

### 5.2 Resultados

| Suite | Pass | Fail |
|---|---:|---:|
| Bloco E | 10 | 0 |
| Bloco D | 21 | 0 |
| Bloco C | 34 | 0 |
| Bloco B1 | 10 | 0 |
| Bloco B2 | 14 | 0 |
| Bloco A | 14 | 0 |
| S01–S05 | 138 | 0 |
| **Total** | **241** | **0** |

Log: `LOG-BLOCO-E-CORRECAO-2A-RODADA.txt` — `TOTAL_FAIL: 0`.

### 5.3 Confirmações

| Item | Status |
|---|---|
| Schema v3 inalterado | `COZINHA_SCHEMA_VERSION = 3`; sem V4 |
| Banco oficial bloqueado | `CDS_BLOQUEAR_BANCO_OFICIAL=1` |
| Banco temporário | `:memory:` + `DB_DIR` tmp |
| Sem impressão física | dry-run; spooler não autorizado |
| Sem impressora comercial/fiscal | caminho Worker isolado do cupom/DANFE |
| Sem efeito preparação/despacho/PDV/estoque/financeiro | restrição respeitada; S01–S05 verdes |

---

**Artefatos entregues — aguardando nova auditoria do Tech Lead.**

Sem homologação física. Sem spooler real. Sem novas funcionalidades nesta entrega.
