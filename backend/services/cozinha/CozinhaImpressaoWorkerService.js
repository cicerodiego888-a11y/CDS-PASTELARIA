/**
 * Worker de impressão — Sprint 06 Bloco D + E.
 * Claim atômico, FAKE / ELECTRON, falhas / RESULTADO_INCERTO.
 *
 * E-01: simulação (dry-run) NÃO faz claim e NÃO consome tentativas.
 * E-02: processarJob valida job persistido no banco antes do driver.
 * Política: dúvida → RESULTADO_INCERTO; sem reenvio automático.
 */
'use strict';

const {
  erroImpressao,
  parsePositiveInteger,
  ESTADOS_FILA
} = require('./cozinhaImpressaoContratos');
const { exigirUnidadeOperacional } = require('./cozinhaUnidadeOperacional');
const { RESULTADOS_DRIVER, assertResultadoDriver, criarFakeDriver } = require('./cozinhaImpressaoDriver');
const FilaService = require('./CozinhaImpressaoFilaService');
const { comGateClaimLogout } = require('./cozinhaImpressaoClaimLogoutGate');

const ABANDONO_PADRAO_MS = 60 * 1000;

/**
 * Jobs cuja propriedade foi confirmada e o driver ainda está em execução.
 * Impede que recuperarJobsAbandonados invalide a propriedade no meio do print
 * (sem alteração de schema). Escopo: processo atual.
 */
const _jobsImpressaoAtivos = new Set();

function chaveJobImpressaoAtivo(empresaId, unidadeId, jobId) {
  return `${Number(empresaId)}:${Number(unidadeId)}:${Number(jobId)}`;
}

function marcarJobImpressaoAtivo(empresaId, unidadeId, jobId) {
  _jobsImpressaoAtivos.add(chaveJobImpressaoAtivo(empresaId, unidadeId, jobId));
}

function liberarJobImpressaoAtivo(empresaId, unidadeId, jobId) {
  _jobsImpressaoAtivos.delete(chaveJobImpressaoAtivo(empresaId, unidadeId, jobId));
}

function jobImpressaoEstaAtivo(empresaId, unidadeId, jobId) {
  return _jobsImpressaoAtivos.has(chaveJobImpressaoAtivo(empresaId, unidadeId, jobId));
}

/** Somente testes — não usar em produção. */
function _resetJobsImpressaoAtivosParaTeste() {
  _jobsImpressaoAtivos.clear();
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function cb(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function dbExec(db, sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => (err ? reject(err) : resolve()));
  });
}

function agoraIso() {
  return new Date().toISOString();
}

/**
 * Executa fn sob BEGIN IMMEDIATE obrigatório.
 * Não adere a transação externa desconhecida: se a conexão já estiver
 * em TX, propaga erro (COMMIT/ROLLBACK só da TX iniciada aqui).
 */
async function comTransacaoImediata(db, fn) {
  try {
    await dbExec(db, 'BEGIN IMMEDIATE');
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (/within a transaction/i.test(msg)) {
      throw erroImpressao(
        'Claim exige BEGIN IMMEDIATE próprio; conexão já está em transação externa.',
        409,
        'IMPRESSAO_CLAIM_TX_EXTERNA',
        { detalhes: { causa: msg } }
      );
    }
    throw err;
  }

  try {
    const out = await fn();
    await dbExec(db, 'COMMIT');
    return out;
  } catch (err) {
    try { await dbExec(db, 'ROLLBACK'); } catch (_e) { /* ignore */ }
    throw err;
  }
}

function exigirEmpresa(empresaId) {
  const id = parsePositiveInteger(empresaId);
  if (!id) {
    throw erroImpressao('empresa_id obrigatório.', 400, 'EMPRESA_OBRIGATORIA');
  }
  return id;
}

function normalizarWorkerId(raw) {
  const id = String(raw == null ? '' : raw).trim();
  if (!id) {
    throw erroImpressao('worker_id obrigatório.', 400, 'IMPRESSAO_WORKER_ID_OBRIGATORIO');
  }
  if (id.length > 128) {
    throw erroImpressao('worker_id excede o tamanho máximo.', 400, 'IMPRESSAO_WORKER_ID_INVALIDO');
  }
  return id;
}

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

/**
 * E-02: carrega job canônico do banco. Não confia no objeto recebido.
 */
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

/**
 * Claim atômico PENDENTE → PROCESSANDO.
 *
 * Fluxo inequívoco (por chamada):
 * 1) BEGIN IMMEDIATE
 * 2) SELECT candidato (id exato)
 * 3) Validar geração operacional (C9) — inválida → ROLLBACK
 * 4) UPDATE ... WHERE id=? AND estado='PENDENTE' (changes deve ser 1)
 * 5) C10: sob gate exclusivo com logout — validar geração + COMMIT (sem janela assíncrona externa)
 * 6) SELECT * WHERE id=? (após COMMIT confirmado)
 *
 * Não recupera o job por worker_id/timestamp/MAX(id).
 */
async function reivindicarProximoJob(entrada = {}, opts = {}) {
  const db = opts.db || entrada.db;
  if (!db) throw erroImpressao('Banco indisponível.', 500, 'DB_INDISPONIVEL');

  const empresaId = exigirEmpresa(entrada.empresaId != null ? entrada.empresaId : entrada.empresa_id);
  const unidadeId = exigirUnidadeOperacional(
    entrada.unidadeId != null ? entrada.unidadeId : entrada.unidade_id
  );
  const workerId = normalizarWorkerId(
    entrada.workerId != null ? entrada.workerId : entrada.worker_id
  );
  const estacaoId = parsePositiveInteger(
    entrada.estacaoImpressaoId != null
      ? entrada.estacaoImpressaoId
      : (entrada.estacao_impressao_id != null ? entrada.estacao_impressao_id : entrada.estacaoId)
  );

  let committed = false;
  try {
    await dbExec(db, 'BEGIN IMMEDIATE');
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (/within a transaction/i.test(msg)) {
      throw erroImpressao(
        'Claim exige BEGIN IMMEDIATE próprio; conexão já está em transação externa.',
        409,
        'IMPRESSAO_CLAIM_TX_EXTERNA',
        { detalhes: { causa: msg } }
      );
    }
    throw err;
  }

  try {
    let sqlCand = `
      SELECT id
      FROM cozinha_impressao_fila
      WHERE empresa_id = ?
        AND unidade_id = ?
        AND estado = ?
        AND tentativas < max_tentativas
    `;
    const paramsCand = [empresaId, unidadeId, ESTADOS_FILA.PENDENTE];
    if (estacaoId) {
      sqlCand += ' AND estacao_impressao_id = ?';
      paramsCand.push(estacaoId);
    }
    sqlCand += ' ORDER BY created_at ASC, id ASC LIMIT 1';

    const cand = await dbGet(db, sqlCand, paramsCand);
    if (!cand || !cand.id) {
      await dbExec(db, 'COMMIT');
      committed = true;
      return { success: true, reivindicado: false, job: null, impressao_fisica: false };
    }

    const jobId = Number(cand.id);

    // C9: após SELECT do candidato, antes do UPDATE.
    if (typeof opts.__antesUpdateClaim === 'function') {
      await opts.__antesUpdateClaim({
        fase: 'antes_update_claim',
        empresaId,
        unidadeId,
        workerId,
        jobId,
        dentro_transacao: true
      });
    }

    if (!geracaoOperacionalAindaValida(opts)) {
      throw erroImpressao(
        'Tick invalidado durante a transação de claim — UPDATE abortado (ROLLBACK).',
        409,
        'IMPRESSAO_TICK_INVALIDADO',
        {
          detalhes: {
            job_id: jobId,
            worker_id: workerId,
            claim_rollback: true,
            reenvio_automatico: false
          }
        }
      );
    }

    const agora = agoraIso();
    const upd = await dbRun(db, `
      UPDATE cozinha_impressao_fila
      SET estado = ?,
          worker_id = ?,
          processando_em = ?,
          tentativas = tentativas + 1,
          updated_at = ?,
          ultimo_erro = NULL
      WHERE id = ?
        AND empresa_id = ?
        AND unidade_id = ?
        AND estado = ?
    `, [
      ESTADOS_FILA.PROCESSANDO,
      workerId,
      agora,
      agora,
      jobId,
      empresaId,
      unidadeId,
      ESTADOS_FILA.PENDENTE
    ]);

    if (!upd || upd.changes !== 1) {
      await dbExec(db, 'COMMIT');
      committed = true;
      return { success: true, reivindicado: false, job: null, impressao_fisica: false };
    }

    // C10: pausa de teste após UPDATE / antes da confirmação sob gate.
    if (typeof opts.__antesCommitClaim === 'function') {
      await opts.__antesCommitClaim({
        fase: 'antes_commit_claim',
        empresaId,
        unidadeId,
        workerId,
        jobId,
        dentro_transacao: true,
        update_aplicado: true
      });
    }

    // Gate exclusivo com logout: validação final + COMMIT sem ceder a invalidação intercalada.
    await comGateClaimLogout('claim-commit', async () => {
      if (!geracaoOperacionalAindaValida(opts)) {
        throw erroImpressao(
          'Tick invalidado na confirmação do claim — COMMIT recusado (ROLLBACK).',
          409,
          'IMPRESSAO_TICK_INVALIDADO',
          {
            detalhes: {
              job_id: jobId,
              worker_id: workerId,
              claim_rollback: true,
              fase: 'commit_gate',
              reenvio_automatico: false
            }
          }
        );
      }
      // C10-D: hook exclusivo de teste DENTRO do gate, imediatamente antes do COMMIT.
      // Mantém o gate ocupado; logout aguarda. Sem revalidação após o hook —
      // a serialização garante que invalidação operacional ainda não rodou.
      if (typeof opts.__antesCommitDentroGate === 'function') {
        await opts.__antesCommitDentroGate({
          fase: 'dentro_gate_antes_commit',
          empresaId,
          unidadeId,
          workerId,
          jobId,
          dentro_transacao: true,
          update_aplicado: true,
          gate_dono: 'claim-commit'
        });
      }
      await dbExec(db, 'COMMIT');
      committed = true;
      if (typeof opts.__aposCommitDentroGate === 'function') {
        await opts.__aposCommitDentroGate({
          fase: 'dentro_gate_apos_commit',
          empresaId,
          unidadeId,
          workerId,
          jobId,
          commit_confirmado: true,
          gate_dono: 'claim-commit'
        });
      }
    });

    const row = await dbGet(db, `
      SELECT *
      FROM cozinha_impressao_fila
      WHERE id = ?
        AND empresa_id = ?
        AND unidade_id = ?
    `, [jobId, empresaId, unidadeId]);

    if (!row || row.estado !== ESTADOS_FILA.PROCESSANDO || Number(row.id) !== jobId) {
      throw erroImpressao(
        'Claim inconsistente: job reivindicado não encontrado pelo id.',
        500,
        'IMPRESSAO_CLAIM_INCONSISTENTE',
        { detalhes: { job_id: jobId } }
      );
    }

    return {
      success: true,
      reivindicado: true,
      job: FilaService.mapearJob(row, { incluirSnapshot: true }),
      impressao_fisica: false,
      commit_coordenado_logout: true
    };
  } catch (err) {
    if (!committed) {
      try { await dbExec(db, 'ROLLBACK'); } catch (_e) { /* ignore */ }
    }
    throw err;
  }
}

/**
 * Jobs PROCESSANDO abandonados → RESULTADO_INCERTO (nunca voltam a PENDENTE).
 */
async function recuperarJobsAbandonados(entrada = {}, opts = {}) {
  const db = opts.db || entrada.db;
  if (!db) throw erroImpressao('Banco indisponível.', 500, 'DB_INDISPONIVEL');

  const empresaId = exigirEmpresa(entrada.empresaId != null ? entrada.empresaId : entrada.empresa_id);
  const unidadeId = exigirUnidadeOperacional(
    entrada.unidadeId != null ? entrada.unidadeId : entrada.unidade_id
  );
  const rawLim = entrada.limiteMs != null ? entrada.limiteMs : entrada.abandono_ms;
  const limiteMs = Number(rawLim);
  // limiteMs === 0 → todos PROCESSANDO (ex.: reinício do worker); omitido → padrão.
  const lim = rawLim == null || rawLim === ''
    ? ABANDONO_PADRAO_MS
    : (Number.isFinite(limiteMs) && limiteMs >= 0 ? limiteMs : ABANDONO_PADRAO_MS);
  const agora = Date.now();
  const limiteIso = new Date(agora - lim).toISOString();

  const rows = await dbAll(db, `
    SELECT id, processando_em, worker_id
    FROM cozinha_impressao_fila
    WHERE empresa_id = ?
      AND unidade_id = ?
      AND estado = ?
      AND (
        processando_em IS NULL
        OR processando_em <= ?
      )
  `, [empresaId, unidadeId, ESTADOS_FILA.PROCESSANDO, limiteIso]);

  // Gancho somente de teste: permite renovar propriedade entre SELECT e UPDATE.
  if (typeof opts.__aposLeituraAbandonados === 'function') {
    await opts.__aposLeituraAbandonados({
      db,
      empresaId,
      unidadeId,
      rows: rows.map((r) => ({ ...r })),
      limiteMs: lim,
      limiteIso
    });
  }

  const marcados = [];
  const ignoradosVersao = [];
  for (const row of rows) {
    // Proteção complementar (mesmo processo): driver em curso.
    if (jobImpressaoEstaAtivo(empresaId, unidadeId, row.id)) {
      continue;
    }
    const agoraUpd = agoraIso();
    const msg = `Worker abandonado/timeout — resultado indeterminável (worker_id=${row.worker_id || '?'})`;
    // E-02: UPDATE condicional à versão observada (processando_em + worker_id).
    // Renovação concorrente → changes=0; job não é recuperado.
    const upd = await dbRun(db, `
      UPDATE cozinha_impressao_fila
      SET estado = ?,
          ultimo_erro = ?,
          updated_at = ?
      WHERE id = ?
        AND empresa_id = ?
        AND unidade_id = ?
        AND estado = ?
        AND processando_em IS ?
        AND worker_id IS ?
    `, [
      ESTADOS_FILA.RESULTADO_INCERTO,
      msg,
      agoraUpd,
      row.id,
      empresaId,
      unidadeId,
      ESTADOS_FILA.PROCESSANDO,
      row.processando_em == null ? null : row.processando_em,
      row.worker_id == null ? null : row.worker_id
    ]);
    if (upd && upd.changes === 1) {
      marcados.push(row.id);
    } else {
      ignoradosVersao.push(row.id);
    }
  }

  return {
    success: true,
    recuperados: marcados.length,
    job_ids: marcados,
    ignorados_versao: ignoradosVersao,
    novo_estado: ESTADOS_FILA.RESULTADO_INCERTO,
    impressao_fisica: false
  };
}

/**
 * Aplica resultado do driver apenas se o job ainda está PROCESSANDO pelo mesmo worker.
 */
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

/**
 * E-01: simulação sem claim — não consome tentativas, não altera estado,
 * não gera ACEITA_PELO_SPOOLER nem token de spooler.
 */
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

/**
 * E-02: confirma propriedade atomicamente imediatamente antes do driver.
 * - Se ownership já foi perdida → não chama imprimir.
 * - Renova processando_em e marca job ativo para a recuperação não invalidar
 *   a propriedade enquanto o driver executa.
 * @returns {Promise<{ liberar: function }>}
 */
async function confirmarPropriedadeAntesDeImprimir(db, {
  jobId,
  empresaId,
  unidadeId,
  workerId
}) {
  const id = parsePositiveInteger(jobId);
  if (!id) {
    throw erroImpressao('job id obrigatório.', 400, 'IMPRESSAO_JOB_ID_OBRIGATORIO');
  }
  const agora = agoraIso();
  const upd = await dbRun(db, `
    UPDATE cozinha_impressao_fila
    SET processando_em = ?,
        updated_at = ?
    WHERE id = ?
      AND empresa_id = ?
      AND unidade_id = ?
      AND estado = ?
      AND worker_id = ?
  `, [
    agora,
    agora,
    id,
    empresaId,
    unidadeId,
    ESTADOS_FILA.PROCESSANDO,
    workerId
  ]);

  if (!upd || upd.changes !== 1) {
    throw erroImpressao(
      'Propriedade do job perdida antes da impressão — driver não será chamado.',
      409,
      'IMPRESSAO_PROPRIEDADE_PERDIDA',
      { detalhes: { job_id: id, worker_id: workerId } }
    );
  }

  marcarJobImpressaoAtivo(empresaId, unidadeId, id);
  return {
    liberar() {
      liberarJobImpressaoAtivo(empresaId, unidadeId, id);
    }
  };
}

/**
 * Processa um job já reivindicado com o driver (FAKE por padrão).
 * E-02: valida e lê snapshot exclusivamente do banco antes do driver;
 * confirma propriedade imediatamente antes de imprimir.
 */
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

  // Gancho somente de teste: permite invalidar propriedade entre validação e confirmação.
  if (typeof opts.__aposValidacaoCanonico === 'function') {
    await opts.__aposValidacaoCanonico({
      db, jobId: row.id, empresaId, unidadeId, workerId, row
    });
  }

  // C8: invalidação (logout) antes de confirmar propriedade / driver.
  if (typeof opts.__antesDriver === 'function') {
    await opts.__antesDriver({
      fase: 'antes_confirmacao_propriedade',
      db,
      jobId: row.id,
      empresaId,
      unidadeId,
      workerId,
      row
    });
  }
  if (!geracaoOperacionalAindaValida(opts)) {
    throw erroImpressao(
      'Tick invalidado antes do driver — impressão não iniciada.',
      409,
      'IMPRESSAO_TICK_INVALIDADO',
      {
        detalhes: {
          job_id: row.id,
          worker_id: workerId,
          reenvio_automatico: false
        }
      }
    );
  }

  // E-02: fecha a janela validação → driver. Sem propriedade → sem imprimir.
  const posse = await confirmarPropriedadeAntesDeImprimir(db, {
    jobId: row.id,
    empresaId,
    unidadeId,
    workerId
  });

  let driverOut;
  try {
    if (!geracaoOperacionalAindaValida(opts)) {
      throw erroImpressao(
        'Tick invalidado imediatamente antes do driver.',
        409,
        'IMPRESSAO_TICK_INVALIDADO',
        {
          detalhes: {
            job_id: row.id,
            worker_id: workerId,
            reenvio_automatico: false
          }
        }
      );
    }
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

    return await registrarResultado({
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
  } finally {
    posse.liberar();
  }
}

function geracaoOperacionalAindaValida(opts = {}) {
  if (typeof opts.verificarGeracaoValida !== 'function') return true;
  try {
    return opts.verificarGeracaoValida() === true;
  } catch (_e) {
    return false;
  }
}

function resultadoTickInvalidado(extras = {}) {
  return {
    success: true,
    processado: false,
    cancelado: true,
    codigo: 'IMPRESSAO_TICK_INVALIDADO',
    reenvio_automatico: false,
    impressao_fisica: false,
    ...extras
  };
}

/**
 * Ciclo: (simulação sem claim, sem recuperação) OU (recuperação + claim + processar).
 * E-01: ELECTRON sem spooler autorizado → simularProximoSemClaim (sem recuperarJobsAbandonados).
 * E-03 C8: valida geração operacional antes do claim e antes do driver.
 */
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

  // E-01: simulação isolada — não recupera abandonados e não altera fila persistida.
  if (driverEmModoSimulacao(driver)) {
    if (typeof opts.__antesClaim === 'function') {
      await opts.__antesClaim({
        fase: 'antes_simulacao',
        empresaId,
        unidadeId,
        workerId
      });
    }
    if (!geracaoOperacionalAindaValida(opts)) {
      return resultadoTickInvalidado({
        simulado: false,
        recuperacao: { omitida: true, motivo: 'tick_invalidado' },
        job: null
      });
    }
    const sim = await simularProximoSemClaim({
      db, empresaId, unidadeId, workerId
    }, { db, driver });
    return {
      success: true,
      processado: false,
      simulado: true,
      recuperacao: {
        success: true,
        recuperados: 0,
        job_ids: [],
        omitida: true,
        motivo: 'simulacao'
      },
      job: sim.job,
      resultado_driver: RESULTADOS_DRIVER.SIMULADO,
      tentativas: sim.tentativas,
      impressao_fisica: false
    };
  }

  const recuperacao = await recuperarJobsAbandonados({
    db,
    empresaId,
    unidadeId,
    limiteMs: entrada.limiteMs != null ? entrada.limiteMs : entrada.abandono_ms
  }, { db });

  // C8: ponto de pausa/teste imediatamente antes do claim.
  if (typeof opts.__antesClaim === 'function') {
    await opts.__antesClaim({
      fase: 'antes_claim',
      empresaId,
      unidadeId,
      workerId,
      recuperacao
    });
  }
  if (!geracaoOperacionalAindaValida(opts)) {
    return resultadoTickInvalidado({
      simulado: false,
      recuperacao,
      job: null,
      reivindicado: false
    });
  }

  let claim;
  try {
    claim = await reivindicarProximoJob({
      db,
      empresaId,
      unidadeId,
      workerId,
      estacaoImpressaoId: entrada.estacaoImpressaoId != null
        ? entrada.estacaoImpressaoId
        : entrada.estacao_impressao_id
    }, {
      db,
      verificarGeracaoValida: opts.verificarGeracaoValida,
      __antesUpdateClaim: opts.__antesUpdateClaim,
      __antesCommitClaim: opts.__antesCommitClaim,
      __antesCommitDentroGate: opts.__antesCommitDentroGate,
      __aposCommitDentroGate: opts.__aposCommitDentroGate
    });
  } catch (err) {
    // C9/C10: ROLLBACK da TX de claim quando a geração foi invalidada (logout).
    if (err && err.codigo === 'IMPRESSAO_TICK_INVALIDADO') {
      return resultadoTickInvalidado({
        simulado: false,
        recuperacao,
        job: null,
        reivindicado: false,
        claim_rollback: true,
        detalhes: err.detalhes || null
      });
    }
    throw err;
  }

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

  // C8: após claim, antes do driver — logout aqui não inicia impressão.
  if (typeof opts.__antesDriver === 'function') {
    await opts.__antesDriver({
      fase: 'antes_driver',
      empresaId,
      unidadeId,
      workerId,
      jobId: claim.job.id,
      job: claim.job
    });
  }
  if (!geracaoOperacionalAindaValida(opts)) {
    // Política explícita: NÃO devolve PROCESSANDO → PENDENTE automaticamente.
    // Job permanece PROCESSANDO; recuperação versionada cuida do abandono real.
    return resultadoTickInvalidado({
      simulado: false,
      recuperacao,
      job: claim.job,
      reivindicado: true,
      claim_sem_driver: true,
      estado_job: ESTADOS_FILA.PROCESSANDO,
      commit_coordenado_logout: claim.commit_coordenado_logout === true
    });
  }

  const resultado = await processarJobReivindicado({
    db,
    empresaId,
    unidadeId,
    workerId,
    job: { id: claim.job.id }
  }, {
    db,
    driver,
    verificarGeracaoValida: opts.verificarGeracaoValida,
    __antesDriver: opts.__antesDriverPosClaim
  });

  return {
    success: true,
    processado: true,
    simulado: false,
    recuperacao,
    job: resultado.job,
    resultado_driver: resultado.resultado_driver,
    impressao_fisica: false,
    commit_coordenado_logout: claim.commit_coordenado_logout === true
  };
}

/**
 * Ao iniciar/reiniciar o worker: apenas marca abandonados como INCERTO.
 * Nunca devolve PROCESSANDO → PENDENTE.
 */
async function aoIniciarWorker(entrada = {}, opts = {}) {
  const out = await recuperarJobsAbandonados({
    ...entrada,
    limiteMs: entrada.limiteMs != null ? entrada.limiteMs : 0
  }, opts);
  // limiteMs=0 → processando_em <= agora (todos PROCESSANDO com timestamp)
  return {
    ...out,
    reinicio: true,
    reenvio_automatico: false,
    impressao_fisica: false
  };
}

module.exports = {
  ABANDONO_PADRAO_MS,
  reivindicarProximoJob,
  recuperarJobsAbandonados,
  registrarResultado,
  carregarJobCanonicoParaProcessamento,
  confirmarPropriedadeAntesDeImprimir,
  driverEmModoSimulacao,
  simularProximoSemClaim,
  processarJobReivindicado,
  processarProximo,
  aoIniciarWorker,
  estadoFinalDeResultadoDriver,
  normalizarWorkerId,
  jobImpressaoEstaAtivo,
  _resetJobsImpressaoAtivosParaTeste
};
