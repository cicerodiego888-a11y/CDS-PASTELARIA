/**
 * MCF-02.4/02.5 — Executor de migração histórica CONTIDO a cópia isolada de ensaio.
 *
 * Segurança:
 * - Exige ambiente_id com prefixo MCF-02.4-ENSAIO- ou MCF-02.5-ENSAIO-
 * - Exige permitirEscritaIsolada === true
 * - Exige empresaId e loteId explícitos na execução
 * - Recusa caminhos/ambiente operacionais
 * - Não cria pagamentos sintéticos
 * - Só remove projeções com marcador [MCF_PROJECAO_SINTETICA] (nunca histórico)
 * - Aborta se a origem do item pendente mudar
 *
 * @module motores/mcf/services/ContasPagarMigracaoHistoricaExecutor
 */
'use strict';

const crypto = require('crypto');
const { round2, erroMcf, ERROS_MCF } = require('../contracts/constantesMcf');
const ContasPagarService = require('./ContasPagarService');
const DryRun = require('./ContasPagarReconciliacaoHistoricaDryRunService');
const Simulacao = require('./ContasPagarReconciliacaoHistoricaSimulacaoService');
const {
  ORIGEM_PROJECAO,
  REFERENCIA_TIPO_PROJECAO,
  buscarVinculoPorFinanceiroId,
  buscarVinculoPorContaPagarId
} = require('./ContasPagarFinanceiroCompatGuard');
const { garantirSchemaMcfMigracaoHistoricaAsync } = require('../schema/mcfMigracaoHistoricaSchema');

const PREFIXO_AMBIENTE_ENSAIO = 'MCF-02.4-ENSAIO-';
const PREFIXOS_AMBIENTE_ENSAIO = Object.freeze([
  'MCF-02.4-ENSAIO-',
  'MCF-02.5-ENSAIO-'
]);
const MARCADOR_PROJECAO_SINTETICA = ContasPagarService.MARCADOR_PROJECAO_SINTETICA
  || '[MCF_PROJECAO_SINTETICA]';
const MARCADOR_HISTORICO_VINCULADO = '[MCF_HISTORICO_VINCULADO]';
const ACOES_AUTOMATICAS = new Set([
  DryRun.ACOES.VINCULAR,
  DryRun.ACOES.CRIAR_TITULO,
  DryRun.ACOES.IGNORAR
]);

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

async function withTx(db, fn) {
  await dbRun(db, 'BEGIN IMMEDIATE');
  try {
    const out = await fn();
    await dbRun(db, 'COMMIT');
    return out;
  } catch (err) {
    try { await dbRun(db, 'ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  }
}

function hashPayload(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 40);
}

function chaveIdempotencia(acao, empresaId, financeiroId, contaPagarId) {
  if (acao === DryRun.ACOES.VINCULAR) {
    return `hist:vincular:emp:${empresaId}:fin:${financeiroId}:cp:${contaPagarId}`;
  }
  if (acao === DryRun.ACOES.CRIAR_TITULO) {
    return `hist:criar:emp:${empresaId}:fin:${financeiroId}`;
  }
  if (acao === DryRun.ACOES.IGNORAR) {
    return `hist:ignorar:emp:${empresaId}:fin:${financeiroId}`;
  }
  return `hist:revisao:emp:${empresaId}:fin:${financeiroId}`;
}

function validarAmbienteEnsaio(opts = {}) {
  if (opts.permitirEscritaIsolada !== true) {
    throw erroMcf(
      ERROS_MCF.OPERACAO_CONFLITANTE || 'MCF_OPERACAO_CONFLITANTE',
      'Escrita de migração histórica bloqueada: exigir permitirEscritaIsolada=true (ensaio isolado).',
      403
    );
  }
  const ambienteId = String(opts.ambienteId || '');
  if (!PREFIXOS_AMBIENTE_ENSAIO.some((p) => ambienteId.startsWith(p))) {
    throw erroMcf(
      ERROS_MCF.OPERACAO_CONFLITANTE || 'MCF_OPERACAO_CONFLITANTE',
      `ambienteId inválido para ensaio. Use prefixo ${PREFIXOS_AMBIENTE_ENSAIO.join(' ou ')}.`,
      403
    );
  }
  const caminho = String(opts.caminhoDb || opts.dbPath || '');
  if (/operacional|producao|production|cliente|mercadao\.db/i.test(caminho)) {
    throw erroMcf(
      ERROS_MCF.OPERACAO_CONFLITANTE || 'MCF_OPERACAO_CONFLITANTE',
      'Caminho de banco parece operacional/cliente — migração recusada.',
      403
    );
  }
  return ambienteId;
}

async function setAmbienteMeta(db, chave, valor) {
  await dbRun(
    db,
    `INSERT INTO mcf_ensaio_ambiente (chave, valor, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, updated_at = CURRENT_TIMESTAMP`,
    [chave, String(valor)]
  );
}

async function getAmbienteMeta(db, chave) {
  const row = await dbGet(db, 'SELECT valor FROM mcf_ensaio_ambiente WHERE chave = ?', [chave]);
  return row ? row.valor : null;
}

async function auditar(db, { loteId, empresaId, acao, financeiroId, contaPagarId, idempotencyKey, detalhes }) {
  await dbRun(
    db,
    `INSERT INTO contas_pagar_migracao_auditoria (
      lote_id, empresa_id, acao, financeiro_id, conta_pagar_id, idempotency_key, detalhes_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      loteId,
      empresaId,
      acao,
      financeiroId != null ? financeiroId : null,
      contaPagarId != null ? contaPagarId : null,
      idempotencyKey || null,
      JSON.stringify(detalhes || {})
    ]
  );
}

/**
 * Projeção sintética = criada pelo MCF (marcador + origem/ref), nunca o financeiro histórico.
 */
function ehProjecaoSinteticaRemovivel(row, { contaPagarId, financeiroLegadoId } = {}) {
  if (!row) return false;
  if (financeiroLegadoId != null && Number(row.id) === Number(financeiroLegadoId)) return false;
  const obs = String(row.observacao || '');
  if (obs.includes(MARCADOR_HISTORICO_VINCULADO)) return false;
  if (!obs.includes(MARCADOR_PROJECAO_SINTETICA)) return false;
  if (String(row.origem || '') !== ORIGEM_PROJECAO) return false;
  if (String(row.referencia_tipo || '') !== REFERENCIA_TIPO_PROJECAO) return false;
  if (contaPagarId != null && Number(row.referencia_id) !== Number(contaPagarId)) return false;
  return true;
}

function ehRegistroHistoricoProtegido(row) {
  if (!row) return false;
  const obs = String(row.observacao || '');
  if (obs.includes(MARCADOR_HISTORICO_VINCULADO)) return true;
  // Histórico elegível à migração: não é projeção sintética MCF
  if (String(row.origem || '') === ORIGEM_PROJECAO && obs.includes(MARCADOR_PROJECAO_SINTETICA)) {
    return false;
  }
  if (String(row.origem || '') === ORIGEM_PROJECAO
    && String(row.referencia_tipo || '') === REFERENCIA_TIPO_PROJECAO
    && obs.includes(MARCADOR_PROJECAO_SINTETICA)) {
    return false;
  }
  return String(row.origem || '') !== ORIGEM_PROJECAO
    || String(row.referencia_tipo || '') !== REFERENCIA_TIPO_PROJECAO
    || !obs.includes(MARCADOR_PROJECAO_SINTETICA);
}

/**
 * DELETE somente de projeção sintética comprovada. Nunca histórico.
 */
async function removerProjecaoSinteticaComprovada(db, empresaId, contaPagarId, financeiroLegadoId) {
  const vinculo = await buscarVinculoPorContaPagarId(db, empresaId, contaPagarId);
  if (!vinculo || Number(vinculo.financeiro_id) === Number(financeiroLegadoId)) {
    return { removido: false };
  }
  const proj = await dbGet(
    db,
    'SELECT * FROM financeiro WHERE id = ? AND empresa_id = ?',
    [vinculo.financeiro_id, empresaId]
  );
  if (!ehProjecaoSinteticaRemovivel(proj, { contaPagarId, financeiroLegadoId })) {
    throw erroMcf(
      ERROS_MCF.OPERACAO_CONFLITANTE,
      'Recusa remover financeiro: não é projeção sintética comprovada (possível histórico).',
      409,
      { financeiro_id: vinculo.financeiro_id, conta_pagar_id: contaPagarId }
    );
  }
  await dbRun(
    db,
    'DELETE FROM contas_pagar_financeiro_compat WHERE empresa_id = ? AND conta_pagar_id = ? AND financeiro_id = ?',
    [empresaId, contaPagarId, proj.id]
  );
  const del = await dbRun(
    db,
    `DELETE FROM financeiro
     WHERE id = ? AND empresa_id = ?
       AND origem = ?
       AND referencia_tipo = ?
       AND referencia_id = ?
       AND observacao LIKE ?`,
    [
      proj.id,
      empresaId,
      ORIGEM_PROJECAO,
      REFERENCIA_TIPO_PROJECAO,
      contaPagarId,
      `%${MARCADOR_PROJECAO_SINTETICA}%`
    ]
  );
  if (del.changes !== 1) {
    throw erroMcf(ERROS_MCF.INCONSISTENCIA, 'Falha ao remover projeção sintética comprovada.', 409);
  }
  return { removido: true, financeiro_id: Number(proj.id) };
}

/**
 * Marca o financeiro legado como projeção do título e grava vínculo 1:1.
 * Preserva descricao/valor/status do histórico; só ajusta identidade de vínculo.
 * Não altera valor_restante do título MCF.
 */
async function vincularLegadoComoProjecao(db, empresaId, financeiroId, contaPagarId, passos = {}) {
  const fin = await dbGet(
    db,
    'SELECT * FROM financeiro WHERE id = ?',
    [financeiroId]
  );
  if (!fin || Number(fin.empresa_id) !== Number(empresaId)) {
    throw erroMcf(ERROS_MCF.INCONSISTENCIA, 'Financeiro legado não encontrado na empresa.', 409);
  }
  if (ehProjecaoSinteticaRemovivel(fin, { contaPagarId, financeiroLegadoId: -1 })) {
    throw erroMcf(
      ERROS_MCF.OPERACAO_CONFLITANTE,
      'Tentativa de tratar projeção sintética como histórico — abortar.',
      409
    );
  }
  const vinculoFin = await buscarVinculoPorFinanceiroId(db, empresaId, financeiroId);
  if (vinculoFin && Number(vinculoFin.conta_pagar_id) !== Number(contaPagarId)) {
    throw erroMcf(ERROS_MCF.OPERACAO_CONFLITANTE, 'Financeiro já vinculado a outro título.', 409);
  }
  const vinculoCp = await buscarVinculoPorContaPagarId(db, empresaId, contaPagarId);
  if (vinculoCp && Number(vinculoCp.financeiro_id) !== Number(financeiroId)) {
    throw erroMcf(
      ERROS_MCF.OPERACAO_CONFLITANTE,
      'Título MCF já possui outra projeção; requer revisão manual.',
      409
    );
  }

  if (typeof passos.aposCompat === 'function') await passos.aposCompat();

  if (!vinculoCp) {
    await dbRun(
      db,
      `INSERT INTO contas_pagar_financeiro_compat (empresa_id, conta_pagar_id, financeiro_id)
       VALUES (?, ?, ?)`,
      [empresaId, contaPagarId, financeiroId]
    );
  }

  if (typeof passos.aposCompatInserido === 'function') await passos.aposCompatInserido();

  const obs = String(fin.observacao || '');
  const novaObs = obs.includes(MARCADOR_HISTORICO_VINCULADO)
    ? obs
    : `${obs ? `${obs} ` : ''}${MARCADOR_HISTORICO_VINCULADO}`.trim();

  await dbRun(
    db,
    `UPDATE financeiro
     SET origem = ?,
         referencia_tipo = ?,
         referencia_id = ?,
         observacao = ?
     WHERE id = ? AND empresa_id = ?`,
    [ORIGEM_PROJECAO, REFERENCIA_TIPO_PROJECAO, contaPagarId, novaObs, financeiroId, empresaId]
  );

  if (typeof passos.aposLegadoAtualizado === 'function') await passos.aposLegadoAtualizado();
}

/**
 * Caminho legado (se houver projeção sintética residual): remove só sintético e religa histórico.
 */
async function substituirProjecaoSinteticaPeloLegado(db, empresaId, contaPagarId, financeiroLegadoId, passos = {}) {
  await removerProjecaoSinteticaComprovada(db, empresaId, contaPagarId, financeiroLegadoId);
  await vincularLegadoComoProjecao(db, empresaId, financeiroLegadoId, contaPagarId, passos);
}

function ganchoFalha(falhaAposPasso, passo) {
  if (falhaAposPasso && falhaAposPasso === passo) {
    const err = new Error(`FALHA_SIMULADA_APOS_${passo}`);
    err.code = 'MCF_FALHA_SIMULADA';
    err.statusCode = 500;
    throw err;
  }
}

async function carregarFinanceiro(db, empresaId, financeiroId) {
  return dbGet(
    db,
    `SELECT * FROM financeiro WHERE id = ? AND empresa_id = ?`,
    [financeiroId, empresaId]
  );
}

/**
 * Captura pré-validação e abre lote (ainda sem mutar obrigações além do registro do lote).
 */
async function prepararLote({ db, empresaId, ambienteId, permitirEscritaIsolada, caminhoDb } = {}) {
  if (!Number.isInteger(Number(empresaId)) || Number(empresaId) <= 0) {
    throw erroMcf(ERROS_MCF.EMPRESA_OBRIGATORIA, 'empresaId explícito obrigatório para preparar lote.', 400);
  }
  const ambiente = validarAmbienteEnsaio({ ambienteId, permitirEscritaIsolada, caminhoDb });
  await garantirSchemaMcfMigracaoHistoricaAsync(db);

  const dryA = await DryRun.executarDryRun({ db, empresaId });
  const dryB = await DryRun.executarDryRun({ db, empresaId });
  if (dryA.fingerprint !== dryB.fingerprint) {
    throw erroMcf(ERROS_MCF.INCONSISTENCIA, 'Fingerprint instável — abortar ensaio.', 409);
  }
  const sim = await Simulacao.executarSimulacao({ db, empresaId });
  if (!sim.reconciliacao_totais.batimento_quantidade) {
    throw erroMcf(ERROS_MCF.INCONSISTENCIA, 'Batimento de totais da simulação falhou.', 409);
  }

  const loteId = `lote-${ambiente}-${empresaId}-${Date.now()}`;
  const automaticos = (dryA.itens || []).filter((i) => ACOES_AUTOMATICAS.has(i.acao_sugerida));
  const revisao = (dryA.itens || []).filter((i) => i.acao_sugerida === DryRun.ACOES.REVISAO_MANUAL);

  await setAmbienteMeta(db, 'ambiente_id', ambiente);
  await setAmbienteMeta(db, 'fingerprint_capturado', dryA.fingerprint);
  await setAmbienteMeta(db, 'lote_id_atual', loteId);
  if (caminhoDb) await setAmbienteMeta(db, 'caminho_db', caminhoDb);

  await dbRun(
    db,
    `INSERT INTO contas_pagar_migracao_lotes (
      lote_id, empresa_id, ambiente_id, fingerprint_capturado, status, itens_planejados
    ) VALUES (?, ?, ?, ?, 'aberto', ?)`,
    [loteId, empresaId, ambiente, dryA.fingerprint, automaticos.length]
  );

  for (const item of dryA.itens) {
    const cpId = item.candidato_mcf ? item.candidato_mcf.conta_pagar_id : null;
    const key = chaveIdempotencia(item.acao_sugerida, empresaId, item.financeiro_id, cpId);
    const payload = {
      acao: item.acao_sugerida,
      financeiro_id: item.financeiro_id,
      conta_pagar_id: cpId,
      valor_lancamento: item.valor_lancamento,
      criterio: item.criterio,
      confianca: item.confianca
    };
    const statusInicial = item.acao_sugerida === DryRun.ACOES.REVISAO_MANUAL ? 'pulado' : 'pendente';
    await dbRun(
      db,
      `INSERT INTO contas_pagar_migracao_historica (
        lote_id, empresa_id, financeiro_id, conta_pagar_id, acao, idempotency_key,
        payload_hash, status, mensagem, dry_run_fingerprint
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        loteId,
        empresaId,
        item.financeiro_id,
        cpId,
        item.acao_sugerida,
        key,
        hashPayload(payload),
        statusInicial,
        statusInicial === 'pulado' ? 'Excluído do lote automático (revisão manual).' : null,
        dryA.fingerprint
      ]
    );
  }

  await auditar(db, {
    loteId,
    empresaId,
    acao: 'preparar_lote',
    detalhes: {
      fingerprint: dryA.fingerprint,
      automaticos: automaticos.length,
      revisao_manual: revisao.length,
      cobertura: dryA.cobertura,
      totais: dryA.totais_empresa
    }
  });

  return {
    lote_id: loteId,
    ambiente_id: ambiente,
    fingerprint: dryA.fingerprint,
    automaticos: automaticos.length,
    revisao_manual: revisao.length,
    dry_run: dryA,
    simulacao_resumo: sim.simulacao.resumo_simulacao,
    indicadores_antes: sim.indicadores_antes
  };
}

async function assertFingerprintInalterado(db, empresaId, fingerprintEsperado) {
  const atual = await DryRun.executarDryRun({ db, empresaId });
  // Para itens já migrados (vincular/criar), o universo muda — fingerprint muda de propósito.
  // A verificação de origem usa meta + revalidação por item ainda pendente.
  // Aqui comparamos apenas se NÃO houve início: se lote ainda aberto e fingerprint bate.
  return atual;
}

async function processarItem(db, lote, itemRow, dryItem, hooks = {}) {
  const empresaId = Number(lote.empresa_id);
  const financeiroId = Number(itemRow.financeiro_id);
  const acao = itemRow.acao;
  const key = itemRow.idempotency_key;
  const falhaAposPasso = hooks.falhaAposPasso || null;

  const existenteOk = await dbGet(
    db,
    `SELECT * FROM contas_pagar_migracao_historica WHERE idempotency_key = ? AND status = 'ok'`,
    [key]
  );
  if (existenteOk) {
    if (existenteOk.payload_hash !== itemRow.payload_hash) {
      throw erroMcf(ERROS_MCF.OPERACAO_CONFLITANTE, 'Idempotência conflitante (payload divergente).', 409);
    }
    return { status: 'ok', idempotente: true, conta_pagar_id: existenteOk.conta_pagar_id };
  }

  if (acao === DryRun.ACOES.REVISAO_MANUAL) {
    await dbRun(
      db,
      `UPDATE contas_pagar_migracao_historica
       SET status = 'pulado', mensagem = ?, executed_at = CURRENT_TIMESTAMP
       WHERE idempotency_key = ?`,
      ['Revisão manual — não processado automaticamente.', key]
    );
    return { status: 'pulado' };
  }

  if (acao === DryRun.ACOES.IGNORAR) {
    await dbRun(
      db,
      `UPDATE contas_pagar_migracao_historica
       SET status = 'ok', mensagem = ?, executed_at = CURRENT_TIMESTAMP
       WHERE idempotency_key = ?`,
      ['Ignorado conforme dry-run; sem mutação de obrigação.', key]
    );
    await auditar(db, {
      loteId: lote.lote_id,
      empresaId,
      acao: 'migracao_historica_ignorar',
      financeiroId,
      idempotencyKey: key,
      detalhes: { dry_run_fingerprint: lote.fingerprint_capturado }
    });
    return { status: 'ok' };
  }

  // Revalidar item no dry-run atual (ainda elegível / mesma ação)
  if (!dryItem) {
    throw erroMcf(ERROS_MCF.INCONSISTENCIA, 'Item não encontrado no dry-run atual (origem mudou).', 409);
  }
  if (dryItem.acao_sugerida !== acao) {
    throw erroMcf(
      ERROS_MCF.OPERACAO_CONFLITANTE,
      `Ação dry-run mudou de ${acao} para ${dryItem.acao_sugerida} — abortar.`,
      409
    );
  }
  if (dryItem.acao_sugerida === DryRun.ACOES.REVISAO_MANUAL
    || (dryItem.candidatos_ambiguidade && dryItem.candidatos_ambiguidade.length > 1)) {
    throw erroMcf(ERROS_MCF.OPERACAO_CONFLITANTE, 'Ambiguidade detectada na revalidação.', 409);
  }

  const fin = await carregarFinanceiro(db, empresaId, financeiroId);
  if (!fin) {
    throw erroMcf(ERROS_MCF.INCONSISTENCIA, 'Financeiro ausente na revalidação.', 409);
  }

  let contaPagarId = itemRow.conta_pagar_id != null ? Number(itemRow.conta_pagar_id) : null;

  if (acao === DryRun.ACOES.VINCULAR) {
    if (!contaPagarId || !dryItem.candidato_mcf) {
      throw erroMcf(ERROS_MCF.INCONSISTENCIA, 'Vincular sem candidato MCF.', 409);
    }
    contaPagarId = Number(dryItem.candidato_mcf.conta_pagar_id);
    const titulo = await ContasPagarService.obter({ db, empresaId, id: contaPagarId });
    const pagsAntes = await ContasPagarService.listarPagamentos({ db, empresaId, id: contaPagarId });
    await vincularLegadoComoProjecao(db, empresaId, financeiroId, contaPagarId, {
      aposCompatInserido: async () => ganchoFalha(falhaAposPasso, 'compat_inserido'),
      aposLegadoAtualizado: async () => ganchoFalha(falhaAposPasso, 'legado_atualizado')
    });
    const tituloDepois = await ContasPagarService.obter({ db, empresaId, id: contaPagarId });
    if (round2(titulo.valor_restante) !== round2(tituloDepois.valor_restante)) {
      throw erroMcf(ERROS_MCF.INCONSISTENCIA, 'Saldo MCF alterado indevidamente no vincular.', 409);
    }
    const pagsDepois = await ContasPagarService.listarPagamentos({ db, empresaId, id: contaPagarId });
    if (pagsAntes.pagamentos.length !== pagsDepois.pagamentos.length) {
      throw erroMcf(ERROS_MCF.INCONSISTENCIA, 'Pagamentos MCF alterados no vincular.', 409);
    }
    await auditar(db, {
      loteId: lote.lote_id,
      empresaId,
      acao: 'migracao_historica_vincular',
      financeiroId,
      contaPagarId,
      idempotencyKey: key,
      detalhes: {
        criterio: dryItem.criterio,
        confianca: dryItem.confianca,
        valor_restante_preservado: tituloDepois.valor_restante
      }
    });
  } else if (acao === DryRun.ACOES.CRIAR_TITULO) {
    if (fin.valor == null || !(Number(fin.valor) > 0)) {
      throw erroMcf(ERROS_MCF.VALOR_INVALIDO, 'Valor legado inválido para criar título.', 400);
    }
    if (!ehRegistroHistoricoProtegido(fin)) {
      throw erroMcf(
        ERROS_MCF.OPERACAO_CONFLITANTE,
        'Registro não classificado como histórico protegido para criar_titulo.',
        409
      );
    }
    // omitirProjecao: evita projeção sintética intermediária; vínculo usa o legado na mesma TX
    const criado = await ContasPagarService.criarNaTransacaoAtual({
      db,
      empresaId,
      descricao: fin.descricao || `Migração histórica fin#${financeiroId}`,
      valor_original: fin.valor,
      data_emissao: fin.data_movimento || fin.vencimento,
      data_vencimento: fin.vencimento || fin.data_movimento,
      documento: fin.documento,
      pessoa_nome: fin.pessoa_nome,
      categoria: fin.categoria,
      forma_pagamento: fin.forma_pagamento,
      origem: 'migracao_historica',
      observacao: `MCF migração — origem financeiro_id=${financeiroId}`,
      idempotency_key: key,
      omitirProjecao: true
    });
    contaPagarId = criado.id;
    ganchoFalha(falhaAposPasso, 'titulo_criado');

    // Se por qualquer motivo já existir projeção sintética, remove só se comprovada
    await removerProjecaoSinteticaComprovada(db, empresaId, contaPagarId, financeiroId);
    await vincularLegadoComoProjecao(db, empresaId, financeiroId, contaPagarId, {
      aposCompatInserido: async () => ganchoFalha(falhaAposPasso, 'compat_inserido'),
      aposLegadoAtualizado: async () => ganchoFalha(falhaAposPasso, 'legado_atualizado')
    });

    const pags = await ContasPagarService.listarPagamentos({ db, empresaId, id: contaPagarId });
    if (pags.pagamentos.length > 0) {
      throw erroMcf(ERROS_MCF.INCONSISTENCIA, 'Pagamento sintético detectado — abortar.', 409);
    }
    const titulo = await ContasPagarService.obter({ db, empresaId, id: contaPagarId });
    if (round2(titulo.valor_restante) !== round2(titulo.valor_original)) {
      throw erroMcf(ERROS_MCF.INCONSISTENCIA, 'Título criado com saldo diferente do original.', 409);
    }
    await auditar(db, {
      loteId: lote.lote_id,
      empresaId,
      acao: 'migracao_historica_criar',
      financeiroId,
      contaPagarId,
      idempotencyKey: key,
      detalhes: {
        valor_original: titulo.valor_original,
        valor_restante: titulo.valor_restante,
        pagamentos_sinteticos: 0,
        omitir_projecao: true
      }
    });
  }

  await dbRun(
    db,
    `UPDATE contas_pagar_migracao_historica
     SET status = 'ok', conta_pagar_id = ?, mensagem = NULL, executed_at = CURRENT_TIMESTAMP
     WHERE idempotency_key = ?`,
    [contaPagarId, key]
  );
  return { status: 'ok', conta_pagar_id: contaPagarId };
}

/**
 * Executa (ou retoma) o lote automático na cópia isolada.
 * @param {object} opts
 * @param {number} [opts.interromperAposN] — para ensaio de interrupção
 */
async function executarLote(opts = {}) {
  const {
    db,
    empresaId,
    loteId,
    ambienteId,
    permitirEscritaIsolada,
    caminhoDb,
    interromperAposN = null,
    falhaAposPasso = null
  } = opts;
  if (empresaId == null || !Number.isInteger(Number(empresaId)) || Number(empresaId) <= 0) {
    throw erroMcf(ERROS_MCF.EMPRESA_OBRIGATORIA, 'empresaId explícito obrigatório para executar lote.', 400);
  }
  if (!loteId || !String(loteId).trim()) {
    throw erroMcf(ERROS_MCF.OPERACAO_CONFLITANTE, 'loteId explícito obrigatório para executar lote.', 400);
  }
  const ambiente = validarAmbienteEnsaio({ ambienteId, permitirEscritaIsolada, caminhoDb });
  await garantirSchemaMcfMigracaoHistoricaAsync(db);

  const lote = await dbGet(db, 'SELECT * FROM contas_pagar_migracao_lotes WHERE lote_id = ?', [loteId]);
  if (!lote) throw erroMcf(ERROS_MCF.INCONSISTENCIA, 'Lote não encontrado.', 404);
  if (Number(lote.empresa_id) !== Number(empresaId)) {
    throw erroMcf(ERROS_MCF.OPERACAO_CONFLITANTE, 'Lote não pertence à empresa.', 403);
  }
  if (String(lote.ambiente_id) !== ambiente) {
    throw erroMcf(ERROS_MCF.OPERACAO_CONFLITANTE, 'ambiente_id do lote diverge.', 403);
  }
  if (lote.status === 'abortado') {
    throw erroMcf(ERROS_MCF.OPERACAO_CONFLITANTE, 'Lote abortado — prepare novo lote.', 409);
  }

  await dbRun(
    db,
    `UPDATE contas_pagar_migracao_lotes SET status = 'em_andamento', atualizado_em = CURRENT_TIMESTAMP WHERE lote_id = ?`,
    [loteId]
  );

  const pendentes = await dbAll(
    db,
    `SELECT * FROM contas_pagar_migracao_historica
     WHERE lote_id = ? AND status = 'pendente'
     ORDER BY id ASC`,
    [loteId]
  );

  let processadosNestaExecucao = 0;
  let interrompido = false;
  const resultados = [];

  for (const itemRow of pendentes) {
    if (interromperAposN != null && processadosNestaExecucao >= Number(interromperAposN)) {
      interrompido = true;
      break;
    }

    try {
      // Dry-run fresco para revalidação do item (detecta mudança de origem)
      const dryAtual = await DryRun.executarDryRun({ db, empresaId });
      const dryItem = (dryAtual.itens || []).find((i) => Number(i.financeiro_id) === Number(itemRow.financeiro_id));

      // Se fingerprint do lote diverge E o item ainda aparece com outra classificação → abort
      // (itens já ok não estão em pendentes)
      if (!dryItem && itemRow.acao !== DryRun.ACOES.IGNORAR) {
        // Pode ter sido consumido por execução paralela; tratar como inconsistência
        throw erroMcf(
          ERROS_MCF.OPERACAO_CONFLITANTE,
          'Origem mudou: item pendente sumiu do dry-run. Abortar lote.',
          409
        );
      }

      await withTx(db, async () => {
        const r = await processarItem(db, lote, itemRow, dryItem, { falhaAposPasso });
        resultados.push({ financeiro_id: itemRow.financeiro_id, ...r });
      });
      processadosNestaExecucao += 1;
      await dbRun(
        db,
        `UPDATE contas_pagar_migracao_lotes
         SET itens_ok = itens_ok + 1, atualizado_em = CURRENT_TIMESTAMP
         WHERE lote_id = ?`,
        [loteId]
      );
    } catch (err) {
      await dbRun(
        db,
        `UPDATE contas_pagar_migracao_historica
         SET status = 'erro', mensagem = ?, executed_at = CURRENT_TIMESTAMP
         WHERE idempotency_key = ?`,
        [String(err.message || err).slice(0, 1000), itemRow.idempotency_key]
      );
      await dbRun(
        db,
        `UPDATE contas_pagar_migracao_lotes
         SET itens_erro = itens_erro + 1, status = 'abortado', atualizado_em = CURRENT_TIMESTAMP
         WHERE lote_id = ?`,
        [loteId]
      );
      await auditar(db, {
        loteId,
        empresaId,
        acao: 'migracao_historica_erro',
        financeiroId: itemRow.financeiro_id,
        idempotencyKey: itemRow.idempotency_key,
        detalhes: { error: String(err.message || err), code: err.code || null }
      });
      return {
        lote_id: loteId,
        status: 'abortado',
        erro: err.message,
        code: err.code || null,
        resultados,
        processados_nesta_execucao: processadosNestaExecucao
      };
    }
  }

  const restante = await dbGet(
    db,
    `SELECT COUNT(*) AS n FROM contas_pagar_migracao_historica WHERE lote_id = ? AND status = 'pendente'`,
    [loteId]
  );
  const statusFinal = interrompido
    ? 'interrupido'
    : (Number(restante.n) === 0 ? 'concluido' : 'em_andamento');

  await dbRun(
    db,
    `UPDATE contas_pagar_migracao_lotes SET status = ?, atualizado_em = CURRENT_TIMESTAMP WHERE lote_id = ?`,
    [statusFinal, loteId]
  );

  await auditar(db, {
    loteId,
    empresaId,
    acao: interrompido ? 'migracao_historica_interrupcao' : 'migracao_historica_execucao',
    detalhes: {
      processados_nesta_execucao: processadosNestaExecucao,
      pendentes_restantes: Number(restante.n),
      status: statusFinal
    }
  });

  return {
    lote_id: loteId,
    status: statusFinal,
    processados_nesta_execucao: processadosNestaExecucao,
    pendentes_restantes: Number(restante.n),
    resultados
  };
}

async function capturarSnapshotVerificacao(db, empresaId) {
  const ind = await Simulacao.capturarIndicadoresAtuais(db, empresaId);
  const titulos = await dbGet(db, 'SELECT COUNT(*) AS n FROM contas_pagar WHERE empresa_id = ?', [empresaId]);
  const pags = await dbGet(db, 'SELECT COUNT(*) AS n, COALESCE(SUM(valor_pago),0) AS v FROM contas_pagar_pagamentos WHERE empresa_id = ?', [empresaId]);
  const compat = await dbGet(db, 'SELECT COUNT(*) AS n FROM contas_pagar_financeiro_compat WHERE empresa_id = ?', [empresaId]);
  const legado = await dbGet(db, 'SELECT COUNT(*) AS n FROM financeiro WHERE empresa_id = ?', [empresaId]);
  const dry = await DryRun.executarDryRun({ db, empresaId });
  return {
    indicadores: ind,
    contas_pagar: Number(titulos.n),
    pagamentos_qtd: Number(pags.n),
    pagamentos_valor: round2(pags.v),
    vinculos_compat: Number(compat.n),
    financeiro_qtd: Number(legado.n),
    dry_run_pos: {
      fingerprint: dry.fingerprint,
      candidatos: dry.itens.length,
      por_acao: dry.totais_empresa.por_acao
    }
  };
}

function compararSnapshots(antes, depois) {
  const divergencias = [];
  if (depois.pagamentos_valor !== antes.pagamentos_valor) {
    divergencias.push(`pagamentos_valor ${antes.pagamentos_valor} → ${depois.pagamentos_valor}`);
  }
  if (depois.pagamentos_qtd !== antes.pagamentos_qtd) {
    divergencias.push(`pagamentos_qtd ${antes.pagamentos_qtd} → ${depois.pagamentos_qtd}`);
  }
  // financeiro_qtd: criar_titulo remove projeção sintética (-1) e mantém legado (0 net) ou só relabel
  // contas_pagar pode aumentar com criar_titulo
  // vinculos pode aumentar
  if (depois.indicadores.mcf_pagamentos.valor !== antes.indicadores.mcf_pagamentos.valor) {
    divergencias.push('valor de pagamentos MCF mudou indevidamente');
  }
  return {
    aprovado: divergencias.length === 0,
    divergencias,
    delta: {
      contas_pagar: depois.contas_pagar - antes.contas_pagar,
      vinculos_compat: depois.vinculos_compat - antes.vinculos_compat,
      financeiro_qtd: depois.financeiro_qtd - antes.financeiro_qtd,
      saldo_mcf: round2(
        depois.indicadores.mcf_abertos.saldo_confirmado - antes.indicadores.mcf_abertos.saldo_confirmado
      )
    }
  };
}

/**
 * Relatório de pré-migração por empresa (somente leitura).
 * Parâmetros explícitos: empresaId obrigatório; loteId opcional se já preparado.
 */
async function gerarRelatorioPreMigracao({ db, empresaId, loteId = null } = {}) {
  if (!db) throw new Error('db obrigatório');
  if (!Number.isInteger(Number(empresaId)) || Number(empresaId) <= 0) {
    throw erroMcf(ERROS_MCF.EMPRESA_OBRIGATORIA, 'empresaId explícito obrigatório no relatório pré-migração.', 400);
  }
  const emp = Number(empresaId);
  const dry = await DryRun.executarDryRun({ db, empresaId: emp });
  const ind = await Simulacao.capturarIndicadoresAtuais(db, emp);
  const porAcao = dry.totais_empresa.por_acao;
  const revisao = (dry.itens || []).filter((i) => i.acao_sugerida === DryRun.ACOES.REVISAO_MANUAL);
  const semSaldo = (dry.itens || []).filter((i) => i.saldo_verificavel !== true);
  const possiveisDuplicidades = (dry.itens || []).filter((i) =>
    (i.candidatos_ambiguidade && i.candidatos_ambiguidade.length > 1)
    || (i.candidato_mcf && i.candidato_mcf.tem_projecao)
  );

  let lote = null;
  if (loteId) {
    lote = await dbGet(db, 'SELECT * FROM contas_pagar_migracao_lotes WHERE lote_id = ? AND empresa_id = ?', [
      loteId, emp
    ]);
  }

  return {
    gerado_em: new Date().toISOString(),
    somente_leitura: true,
    empresa_id: emp,
    lote_id: lote ? lote.lote_id : null,
    fingerprint_origem: dry.fingerprint,
    fingerprint_lote: lote ? lote.fingerprint_capturado : null,
    fingerprint_compativel_com_lote: lote
      ? lote.fingerprint_capturado === dry.fingerprint
      : null,
    por_acao: {
      vincular: {
        quantidade: porAcao.vincular.quantidade,
        valor_conhecido: porAcao.vincular.valor_conhecido
      },
      criar_titulo: {
        quantidade: porAcao.criar_titulo.quantidade,
        valor_conhecido: porAcao.criar_titulo.valor_conhecido
      },
      ignorar: {
        quantidade: porAcao.ignorar.quantidade,
        valor_conhecido: porAcao.ignorar.valor_conhecido
      },
      revisao_manual: {
        quantidade: porAcao.revisao_manual.quantidade,
        valor_conhecido: porAcao.revisao_manual.valor_conhecido,
        itens: revisao.map((i) => ({
          financeiro_id: i.financeiro_id,
          justificativa: i.justificativa,
          valor_lancamento: i.valor_lancamento
        }))
      }
    },
    saldos_nao_verificaveis: {
      quantidade: semSaldo.length,
      nota: 'Saldo residual não inferido só pelo status legado'
    },
    possiveis_duplicidades: {
      quantidade: possiveisDuplicidades.length,
      itens: possiveisDuplicidades.map((i) => ({
        financeiro_id: i.financeiro_id,
        justificativa: i.justificativa
      }))
    },
    titulos_pagamentos_existentes: {
      mcf_abertos: ind.mcf_abertos,
      mcf_quitados: ind.mcf_quitados,
      mcf_cancelados: ind.mcf_cancelados,
      mcf_pagamentos: ind.mcf_pagamentos,
      projecoes_compat: ind.projecoes_compat
    },
    criterios_abortar: [
      'ambienteId sem prefixo MCF-02.4-ENSAIO- / MCF-02.5-ENSAIO-',
      'permitirEscritaIsolada !== true',
      'empresaId ou loteId ausentes/divergentes',
      'caminho de banco operacional/cliente',
      'fingerprint instável na preparação',
      'item pendente sumiu ou mudou de ação no dry-run',
      'ambiguidade na revalidação',
      'tentativa de remover financeiro histórico (sem marcador sintético)',
      'alteração de saldo/pagamentos MCF no vincular',
      'falha de UNIQUE/compat'
    ],
    cobertura: dry.cobertura,
    aviso: 'Backfill operacional NÃO AUTORIZADO sem aprovação expressa e específica do Tech Lead.'
  };
}

module.exports = {
  PREFIXO_AMBIENTE_ENSAIO,
  PREFIXOS_AMBIENTE_ENSAIO,
  MARCADOR_PROJECAO_SINTETICA,
  MARCADOR_HISTORICO_VINCULADO,
  validarAmbienteEnsaio,
  prepararLote,
  executarLote,
  capturarSnapshotVerificacao,
  compararSnapshots,
  gerarRelatorioPreMigracao,
  ehProjecaoSinteticaRemovivel,
  ehRegistroHistoricoProtegido,
  removerProjecaoSinteticaComprovada,
  chaveIdempotencia,
  hashPayload
};
