/**
 * Fila persistente de impressão — Sprint 06 Bloco B1 + B2 + C.
 * B1: inclusão/listagem/isolamento.
 * B2: enfileirarDaRodada + idempotência A/B + gancho no despacho (mesma TX).
 * C: roteamento INDIVIDUAL|AGRUPADO; ambos habilitados → AMBIGUO (0 jobs).
 * Sem worker, sem print físico, sem Bloco D.
 */
'use strict';

const {
  erroImpressao,
  parsePositiveInteger,
  normalizarVias,
  MODELOS_IMPRESSAO,
  CODIGOS_ESTACAO_TIPO,
  ESTADOS_FILA,
  montarPayloadSnapshot,
  serializarSnapshot,
  parseSnapshotJson,
  snapshotContemCamposProibidos,
  montarIdempotencyKeyFila,
  montarIdempotencyKeyReenvio
} = require('./cozinhaImpressaoContratos');
const { exigirUnidadeOperacional } = require('./cozinhaUnidadeOperacional');

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
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function exigirEmpresa(empresaId) {
  const id = parsePositiveInteger(empresaId);
  if (!id) {
    throw erroImpressao('empresa_id obrigatório.', 400, 'EMPRESA_CONTEXT_REQUIRED');
  }
  return id;
}

function normalizarModelo(raw) {
  const modelo = String(raw == null ? MODELOS_IMPRESSAO.AGRUPADO : raw).trim().toUpperCase();
  if (!MODELOS_IMPRESSAO[modelo]) {
    throw erroImpressao(
      'modelo deve ser INDIVIDUAL ou AGRUPADO.',
      400,
      'IMPRESSAO_MODELO_INVALIDO'
    );
  }
  return modelo;
}

function normalizarIdempotencyKey(raw) {
  const key = String(raw == null ? '' : raw).trim();
  if (!key) {
    throw erroImpressao(
      'idempotency_key obrigatória para enfileirar.',
      400,
      'IMPRESSAO_IDEMPOTENCY_OBRIGATORIA'
    );
  }
  if (key.length > 255) {
    throw erroImpressao(
      'idempotency_key excede o tamanho máximo.',
      400,
      'IMPRESSAO_IDEMPOTENCY_INVALIDA'
    );
  }
  return key;
}

function normalizarEstadoFiltro(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const estado = String(raw).trim().toUpperCase();
  if (!ESTADOS_FILA[estado]) {
    throw erroImpressao(
      'estado de fila inválido.',
      400,
      'IMPRESSAO_ESTADO_INVALIDO'
    );
  }
  return estado;
}

async function exigirUnidadeDaEmpresa(db, empresaId, unidadeId) {
  const unidade = await dbGet(db, `
    SELECT id, empresa_id, codigo, ativo
    FROM cozinha_unidades
    WHERE id = ? AND empresa_id = ?
  `, [unidadeId, empresaId]);
  if (!unidade) {
    throw erroImpressao(
      'Unidade não pertence à empresa autenticada.',
      403,
      'UNIDADE_EMPRESA_ISOLAMENTO'
    );
  }
  return unidade;
}

async function exigirRodadaDaEmpresaUnidade(db, empresaId, unidadeId, rodadaId) {
  const rodada = await dbGet(db, `
    SELECT id, empresa_id, unidade_id, mesa_id, atendimento_id,
           numero_rodada, sequencia_global, enviada_em
    FROM cozinha_rodadas
    WHERE id = ? AND empresa_id = ?
  `, [rodadaId, empresaId]);
  if (!rodada) {
    throw erroImpressao(
      'Rodada não encontrada na empresa autenticada.',
      404,
      'IMPRESSAO_RODADA_NAO_ENCONTRADA'
    );
  }
  if (Number(rodada.unidade_id) !== Number(unidadeId)) {
    throw erroImpressao(
      'Rodada não pertence à unidade autenticada.',
      403,
      'UNIDADE_ISOLAMENTO'
    );
  }
  return rodada;
}

async function exigirEstacaoDaUnidade(db, empresaId, unidadeId, estacaoId) {
  const estacao = await dbGet(db, `
    SELECT id, empresa_id, unidade_id, codigo_estacao, device_name,
           largura_mm, vias, modelo_individual, modelo_agrupado, ativo
    FROM cozinha_estacoes_impressao
    WHERE id = ? AND empresa_id = ?
  `, [estacaoId, empresaId]);
  if (!estacao) {
    throw erroImpressao(
      'Estação de impressão não encontrada.',
      404,
      'ESTACAO_NAO_ENCONTRADA'
    );
  }
  if (Number(estacao.unidade_id) !== Number(unidadeId)) {
    throw erroImpressao(
      'Estação não pertence à unidade autenticada.',
      403,
      'UNIDADE_ISOLAMENTO'
    );
  }
  return estacao;
}

function mapearJob(row, { incluirSnapshot = false } = {}) {
  if (!row) return null;
  const base = {
    id: row.id,
    empresa_id: row.empresa_id,
    unidade_id: row.unidade_id,
    estacao_impressao_id: row.estacao_impressao_id,
    rodada_id: row.rodada_id,
    modelo: row.modelo,
    vias: row.vias,
    estado: row.estado,
    tentativas: row.tentativas,
    max_tentativas: row.max_tentativas,
    ultimo_erro: row.ultimo_erro,
    job_origem_id: row.job_origem_id,
    spooler_job_token: row.spooler_job_token,
    processando_em: row.processando_em,
    worker_id: row.worker_id,
    idempotency_key: row.idempotency_key,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
  if (incluirSnapshot) {
    base.payload_snapshot = row.payload_snapshot;
    try {
      base.snapshot = parseSnapshotJson(row.payload_snapshot);
    } catch (_e) {
      base.snapshot = null;
    }
  }
  return base;
}

/**
 * Inclui um trabalho na fila (estado PENDENTE).
 * Não inicia/commita TX — o chamador pode envolver em BEGIN/COMMIT (ex.: despacho).
 * Sem worker / sem impressão física.
 */
async function enfileirarJob(entrada = {}, opts = {}) {
  const db = opts.db || entrada.db;
  if (!db) throw erroImpressao('Banco indisponível.', 500, 'DB_INDISPONIVEL');

  const empresaId = exigirEmpresa(entrada.empresaId != null ? entrada.empresaId : entrada.empresa_id);
  const unidadeId = exigirUnidadeOperacional(
    entrada.unidadeId != null ? entrada.unidadeId : entrada.unidade_id
  );
  const rodadaId = parsePositiveInteger(
    entrada.rodadaId != null ? entrada.rodadaId : entrada.rodada_id
  );
  const estacaoId = parsePositiveInteger(
    entrada.estacaoImpressaoId != null
      ? entrada.estacaoImpressaoId
      : (entrada.estacao_impressao_id != null ? entrada.estacao_impressao_id : entrada.estacaoId)
  );
  const idempotencyKey = normalizarIdempotencyKey(
    entrada.idempotencyKey != null ? entrada.idempotencyKey : entrada.idempotency_key
  );

  if (!rodadaId) {
    throw erroImpressao('rodada_id obrigatório.', 400, 'IMPRESSAO_RODADA_OBRIGATORIA');
  }
  if (!estacaoId) {
    throw erroImpressao(
      'estacao_impressao_id obrigatório.',
      400,
      'IMPRESSAO_ESTACAO_OBRIGATORIA'
    );
  }

  await exigirUnidadeDaEmpresa(db, empresaId, unidadeId);
  const rodada = await exigirRodadaDaEmpresaUnidade(db, empresaId, unidadeId, rodadaId);
  const estacao = await exigirEstacaoDaUnidade(db, empresaId, unidadeId, estacaoId);

  const modelo = normalizarModelo(entrada.modelo);
  const vias = entrada.vias != null ? normalizarVias(entrada.vias) : normalizarVias(estacao.vias);

  const snapEntrada = Object.assign({}, entrada.snapshot || entrada.payload || {}, {
    empresa_id: empresaId,
    unidade_id: unidadeId,
    rodada_id: rodadaId,
    modelo,
    largura_mm: entrada.largura_mm != null
      ? entrada.largura_mm
      : (entrada.larguraMm != null ? entrada.larguraMm : estacao.largura_mm),
    sequencia_global: entrada.sequencia_global != null
      ? entrada.sequencia_global
      : (entrada.sequenciaGlobal != null ? entrada.sequenciaGlobal : rodada.sequencia_global),
    numero_rodada: entrada.numero_rodada != null
      ? entrada.numero_rodada
      : (entrada.numeroRodada != null ? entrada.numeroRodada : rodada.numero_rodada),
    atendimento_id: entrada.atendimento_id != null
      ? entrada.atendimento_id
      : (entrada.atendimentoId != null ? entrada.atendimentoId : rodada.atendimento_id),
    enviada_em: entrada.enviada_em != null
      ? entrada.enviada_em
      : (entrada.enviadaEm != null ? entrada.enviadaEm : rodada.enviada_em),
    mesa_numero: entrada.mesa_numero != null
      ? entrada.mesa_numero
      : entrada.mesaNumero
  });

  const snapshot = montarPayloadSnapshot(snapEntrada);
  const proibidos = snapshotContemCamposProibidos(snapshot);
  if (proibidos.length) {
    throw erroImpressao(
      'Snapshot contém campos comerciais/fiscais proibidos.',
      400,
      'SNAPSHOT_CAMPO_PROIBIDO',
      { detalhes: { campos: proibidos } }
    );
  }
  const payloadSnapshot = serializarSnapshot(snapshot);

  // B2 — Cenário A/B: chave existente → replay ou conflito (não sobrescreve).
  const existente = await dbGet(db, `
    SELECT * FROM cozinha_impressao_fila WHERE idempotency_key = ?
  `, [idempotencyKey]);
  if (existente) {
    if (String(existente.payload_snapshot) === String(payloadSnapshot)) {
      return {
        success: true,
        repetida: true,
        job: mapearJob(existente, { incluirSnapshot: true }),
        impressao_fisica: false
      };
    }
    throw erroImpressao(
      'Idempotency-Key de impressão reutilizada com snapshot diferente.',
      409,
      'IMPRESSAO_IDEMPOTENCY_DIVERGENTE',
      {
        idempotency_key: idempotencyKey,
        job_id: existente.id
      }
    );
  }

  let result;
  try {
    result = await dbRun(db, `
      INSERT INTO cozinha_impressao_fila (
        empresa_id, unidade_id, estacao_impressao_id, rodada_id,
        payload_snapshot, modelo, vias, estado,
        tentativas, max_tentativas, idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `, [
      empresaId,
      unidadeId,
      estacaoId,
      rodadaId,
      payloadSnapshot,
      modelo,
      vias,
      ESTADOS_FILA.PENDENTE,
      parsePositiveInteger(entrada.max_tentativas != null ? entrada.max_tentativas : entrada.maxTentativas) || 5,
      idempotencyKey
    ]);
  } catch (err) {
    if (/UNIQUE|unique/i.test(String(err && err.message))) {
      // Corrida: reavalia A/B
      const again = await dbGet(db, `
        SELECT * FROM cozinha_impressao_fila WHERE idempotency_key = ?
      `, [idempotencyKey]);
      if (again && String(again.payload_snapshot) === String(payloadSnapshot)) {
        return {
          success: true,
          repetida: true,
          job: mapearJob(again, { incluirSnapshot: true }),
          impressao_fisica: false
        };
      }
      throw erroImpressao(
        'Idempotency-Key de impressão reutilizada com snapshot diferente.',
        409,
        'IMPRESSAO_IDEMPOTENCY_DIVERGENTE',
        { idempotency_key: idempotencyKey }
      );
    }
    throw err;
  }

  const job = await obterJob({
    db,
    empresaId,
    unidadeId,
    id: result.lastID
  }, { db, incluirSnapshot: true });

  return {
    success: true,
    repetida: false,
    job: job.job,
    impressao_fisica: false
  };
}

function millisParaQtyString(millis) {
  const n = Number(millis);
  if (!Number.isFinite(n)) return null;
  return (n / 1000).toFixed(3);
}

async function registrarEventoFila(db, {
  empresaId,
  unidadeId,
  tipo,
  key,
  payload
}) {
  try {
    await dbRun(db, `
      INSERT INTO cozinha_eventos_outbox (
        empresa_id, unidade_id, tipo, payload_json, idempotency_key
      ) VALUES (?, ?, ?, ?, ?)
    `, [empresaId, unidadeId, tipo, JSON.stringify(payload), key]);
  } catch (err) {
    if (!/UNIQUE|unique/i.test(String(err && err.message))) throw err;
  }
  console.warn(
    `[COZINHA][${tipo}] empresa=${empresaId} unidade=${unidadeId} ` +
    `${JSON.stringify(payload)}`
  );
  return payload;
}

async function registrarSemEstacao(db, {
  empresaId,
  unidadeId,
  rodadaId,
  tipoItem
}) {
  return registrarEventoFila(db, {
    empresaId,
    unidadeId,
    tipo: 'IMPRESSAO_SEM_ESTACAO',
    key: `imp:sem-estacao:${empresaId}:${unidadeId}:${rodadaId}:${tipoItem}`,
    payload: {
      evento: 'IMPRESSAO_SEM_ESTACAO',
      empresa_id: empresaId,
      unidade_id: unidadeId,
      rodada_id: rodadaId,
      tipo_item: tipoItem,
      codigo_estacao_esperado: tipoItem
    }
  });
}

async function registrarSemModeloElegivel(db, {
  empresaId,
  unidadeId,
  rodadaId,
  tipoItem,
  estacaoId
}) {
  return registrarEventoFila(db, {
    empresaId,
    unidadeId,
    tipo: 'IMPRESSAO_SEM_MODELO_ELEGIVEL',
    key: `imp:sem-modelo:${empresaId}:${unidadeId}:${rodadaId}:${estacaoId}:${tipoItem}`,
    payload: {
      evento: 'IMPRESSAO_SEM_MODELO_ELEGIVEL',
      empresa_id: empresaId,
      unidade_id: unidadeId,
      rodada_id: rodadaId,
      tipo_item: tipoItem,
      estacao_impressao_id: estacaoId
    }
  });
}

async function registrarConfigModeloAmbiguo(db, {
  empresaId,
  unidadeId,
  rodadaId,
  tipoItem,
  estacaoId
}) {
  return registrarEventoFila(db, {
    empresaId,
    unidadeId,
    tipo: 'IMPRESSAO_CONFIG_MODELO_AMBIGUO',
    key: `imp:modelo-ambiguo:${empresaId}:${unidadeId}:${rodadaId}:${estacaoId}:${tipoItem}`,
    payload: {
      evento: 'IMPRESSAO_CONFIG_MODELO_AMBIGUO',
      empresa_id: empresaId,
      unidade_id: unidadeId,
      rodada_id: rodadaId,
      tipo_item: tipoItem,
      estacao_impressao_id: estacaoId,
      motivo: 'modelo_individual e modelo_agrupado habilitados simultaneamente'
    }
  });
}

async function montarItensSnapshot(db, itensLinha, tipoItem) {
  const snapItens = [];
  for (const it of itensLinha) {
    const ings = await dbAll(db, `
      SELECT insumo_nome_snapshot, quantidade_snapshot_millis, selecionado
      FROM cozinha_item_ingredientes
      WHERE cozinha_item_id = ?
      ORDER BY id ASC
    `, [it.id]);
    snapItens.push({
      cozinha_item_id: it.id,
      comanda_id: it.comanda_id,
      tipo_item: tipoItem,
      descricao: it.produto_nome_snapshot || '',
      qty: millisParaQtyString(it.qty_solicitada_millis),
      observacao: it.observacoes_snapshot || null,
      ingredientes: ings.map((ing) => ({
        nome: ing.insumo_nome_snapshot || '',
        qty: millisParaQtyString(ing.quantidade_snapshot_millis),
        selecionado: Number(ing.selecionado) === 1
      }))
    });
  }
  return snapItens;
}

/**
 * Enfileira jobs da rodada (Bloco C).
 * D3: codigo_estacao = tipo_item.
 * INDIVIDUAL → 1 job/comanda; AGRUPADO → 1 job/estação+rodada.
 * Exatamente um modelo habilitado; ambos → IMPRESSAO_CONFIG_MODELO_AMBIGUO (0 jobs).
 * Vias no campo do job (não multiplica jobs). Anti-duplicidade via idempotency_key.
 * Usa a conexão/transação do chamador — não abre BEGIN/COMMIT próprio.
 */
async function enfileirarDaRodada(entrada = {}, opts = {}) {
  const db = opts.db || entrada.db;
  if (!db) throw erroImpressao('Banco indisponível.', 500, 'DB_INDISPONIVEL');

  const empresaId = exigirEmpresa(entrada.empresaId != null ? entrada.empresaId : entrada.empresa_id);
  const unidadeId = exigirUnidadeOperacional(
    entrada.unidadeId != null ? entrada.unidadeId : entrada.unidade_id
  );
  const rodadaId = parsePositiveInteger(
    entrada.rodadaId != null ? entrada.rodadaId : entrada.rodada_id
  );
  if (!rodadaId) {
    throw erroImpressao('rodada_id obrigatório.', 400, 'IMPRESSAO_RODADA_OBRIGATORIA');
  }

  await exigirUnidadeDaEmpresa(db, empresaId, unidadeId);
  const rodada = await exigirRodadaDaEmpresaUnidade(db, empresaId, unidadeId, rodadaId);

  let mesaNumero = entrada.mesa_numero != null
    ? entrada.mesa_numero
    : entrada.mesaNumero;
  if (mesaNumero == null || String(mesaNumero).trim() === '') {
    const mesaRow = await dbGet(db, `
      SELECT numero FROM mesas
      WHERE id = ? AND empresa_id = ?
    `, [rodada.mesa_id, empresaId]);
    if (!mesaRow || mesaRow.numero == null) {
      throw erroImpressao(
        'Número da mesa não encontrado para o snapshot de impressão.',
        404,
        'MESA_NAO_ENCONTRADA'
      );
    }
    mesaNumero = mesaRow.numero;
  }
  mesaNumero = String(mesaNumero);

  const itens = await dbAll(db, `
    SELECT id, comanda_id, tipo_item, qty_solicitada_millis,
           produto_nome_snapshot, observacoes_snapshot
    FROM cozinha_itens
    WHERE rodada_id = ? AND empresa_id = ? AND unidade_id = ?
    ORDER BY id ASC
  `, [rodadaId, empresaId, unidadeId]);

  const grupos = new Map();
  for (const it of itens) {
    const tipo = String(it.tipo_item || 'OUTRO').trim().toUpperCase();
    if (!CODIGOS_ESTACAO_TIPO[tipo]) continue;
    if (!grupos.has(tipo)) grupos.set(tipo, []);
    grupos.get(tipo).push(it);
  }

  const jobs = [];
  const avisos = [];
  const resultados = [];

  async function criarJobModelo({ estacao, modelo, escopo, itensLinha, tipoItem }) {
    const snapItens = await montarItensSnapshot(db, itensLinha, tipoItem);
    const idempotencyKey = montarIdempotencyKeyFila({
      empresaId,
      unidadeId,
      rodadaId,
      estacaoId: estacao.id,
      modelo,
      escopo
    });
    const out = await enfileirarJob({
      db,
      empresaId,
      unidadeId,
      rodadaId,
      estacaoImpressaoId: estacao.id,
      modelo,
      vias: estacao.vias,
      largura_mm: estacao.largura_mm,
      idempotency_key: idempotencyKey,
      mesa_numero: mesaNumero,
      snapshot: {
        itens: snapItens,
        sequencia_global: rodada.sequencia_global,
        numero_rodada: rodada.numero_rodada,
        atendimento_id: rodada.atendimento_id,
        enviada_em: rodada.enviada_em
      }
    }, { db });
    resultados.push(out);
    jobs.push(out.job);
    return out;
  }

  for (const [tipoItem, itensGrupo] of grupos.entries()) {
    const estacao = await dbGet(db, `
      SELECT *
      FROM cozinha_estacoes_impressao
      WHERE empresa_id = ?
        AND unidade_id = ?
        AND codigo_estacao = ?
        AND ativo = 1
      ORDER BY id ASC
      LIMIT 1
    `, [empresaId, unidadeId, tipoItem]);

    if (!estacao) {
      avisos.push(await registrarSemEstacao(db, {
        empresaId, unidadeId, rodadaId, tipoItem
      }));
      continue;
    }

    if (Number(estacao.empresa_id) !== empresaId || Number(estacao.unidade_id) !== unidadeId) {
      throw erroImpressao(
        'Estação fora do contexto empresa/unidade.',
        403,
        'UNIDADE_ISOLAMENTO'
      );
    }

    const aceitaIndividual = Number(estacao.modelo_individual) === 1;
    const aceitaAgrupado = Number(estacao.modelo_agrupado) === 1;

    // Configuração ambígua: ambos habilitados → zero jobs (anti-duplicidade inegociável).
    if (aceitaIndividual && aceitaAgrupado) {
      avisos.push(await registrarConfigModeloAmbiguo(db, {
        empresaId,
        unidadeId,
        rodadaId,
        tipoItem,
        estacaoId: estacao.id
      }));
      continue;
    }

    if (!aceitaIndividual && !aceitaAgrupado) {
      avisos.push(await registrarSemModeloElegivel(db, {
        empresaId,
        unidadeId,
        rodadaId,
        tipoItem,
        estacaoId: estacao.id
      }));
      continue;
    }

    if (aceitaAgrupado) {
      await criarJobModelo({
        estacao,
        modelo: MODELOS_IMPRESSAO.AGRUPADO,
        escopo: 'all',
        itensLinha: itensGrupo,
        tipoItem
      });
      continue;
    }

    // Somente INDIVIDUAL
    const porComanda = new Map();
    for (const it of itensGrupo) {
      const cid = Number(it.comanda_id);
      if (!Number.isInteger(cid) || cid <= 0) continue;
      if (!porComanda.has(cid)) porComanda.set(cid, []);
      porComanda.get(cid).push(it);
    }
    const comandasOrdenadas = [...porComanda.keys()].sort((a, b) => a - b);
    for (const comandaId of comandasOrdenadas) {
      await criarJobModelo({
        estacao,
        modelo: MODELOS_IMPRESSAO.INDIVIDUAL,
        escopo: `comanda:${comandaId}`,
        itensLinha: porComanda.get(comandaId),
        tipoItem
      });
    }
  }

  return {
    success: true,
    repetida: resultados.length > 0 && resultados.every((r) => r.repetida === true),
    empresa_id: empresaId,
    unidade_id: unidadeId,
    rodada_id: rodadaId,
    jobs,
    avisos_sem_estacao: avisos.filter((a) => a && a.evento === 'IMPRESSAO_SEM_ESTACAO'),
    avisos_sem_modelo: avisos.filter((a) => a && a.evento === 'IMPRESSAO_SEM_MODELO_ELEGIVEL'),
    avisos_modelo_ambiguo: avisos.filter((a) => a && a.evento === 'IMPRESSAO_CONFIG_MODELO_AMBIGUO'),
    avisos,
    impressao_fisica: false
  };
}

async function listarFila(entrada = {}, opts = {}) {
  const db = opts.db || entrada.db;
  if (!db) throw erroImpressao('Banco indisponível.', 500, 'DB_INDISPONIVEL');

  const empresaId = exigirEmpresa(entrada.empresaId != null ? entrada.empresaId : entrada.empresa_id);
  const unidadeId = exigirUnidadeOperacional(
    entrada.unidadeId != null ? entrada.unidadeId : entrada.unidade_id
  );
  await exigirUnidadeDaEmpresa(db, empresaId, unidadeId);

  const estado = normalizarEstadoFiltro(entrada.estado);
  const rodadaId = parsePositiveInteger(
    entrada.rodadaId != null ? entrada.rodadaId : entrada.rodada_id
  );
  const estacaoId = parsePositiveInteger(
    entrada.estacaoImpressaoId != null
      ? entrada.estacaoImpressaoId
      : (entrada.estacao_impressao_id != null ? entrada.estacao_impressao_id : entrada.estacaoId)
  );

  const params = [empresaId, unidadeId];
  let sql = `
    SELECT id, empresa_id, unidade_id, estacao_impressao_id, rodada_id,
           modelo, vias, estado, tentativas, max_tentativas, ultimo_erro,
           job_origem_id, spooler_job_token, processando_em, worker_id,
           idempotency_key, created_at, updated_at, payload_snapshot
    FROM cozinha_impressao_fila
    WHERE empresa_id = ? AND unidade_id = ?
  `;
  if (estado) {
    sql += ' AND estado = ?';
    params.push(estado);
  }
  if (rodadaId) {
    sql += ' AND rodada_id = ?';
    params.push(rodadaId);
  }
  if (estacaoId) {
    sql += ' AND estacao_impressao_id = ?';
    params.push(estacaoId);
  }
  sql += ' ORDER BY created_at ASC, id ASC';

  const rows = await dbAll(db, sql, params);
  const incluirSnapshot = entrada.incluir_snapshot === true || entrada.incluirSnapshot === true;

  return {
    success: true,
    empresa_id: empresaId,
    unidade_id: unidadeId,
    total: rows.length,
    jobs: rows.map((row) => mapearJob(row, { incluirSnapshot }))
  };
}

async function obterJob(entrada = {}, opts = {}) {
  const db = opts.db || entrada.db;
  if (!db) throw erroImpressao('Banco indisponível.', 500, 'DB_INDISPONIVEL');

  const empresaId = exigirEmpresa(entrada.empresaId != null ? entrada.empresaId : entrada.empresa_id);
  const unidadeId = exigirUnidadeOperacional(
    entrada.unidadeId != null ? entrada.unidadeId : entrada.unidade_id
  );
  const id = parsePositiveInteger(entrada.id != null ? entrada.id : entrada.jobId);
  if (!id) {
    throw erroImpressao('id do job obrigatório.', 400, 'IMPRESSAO_JOB_ID_OBRIGATORIO');
  }

  await exigirUnidadeDaEmpresa(db, empresaId, unidadeId);

  const row = await dbGet(db, `
    SELECT *
    FROM cozinha_impressao_fila
    WHERE id = ? AND empresa_id = ? AND unidade_id = ?
  `, [id, empresaId, unidadeId]);

  if (!row) {
    throw erroImpressao(
      'Trabalho de impressão não encontrado.',
      404,
      'IMPRESSAO_JOB_NAO_ENCONTRADO'
    );
  }

  const incluirSnapshot = opts.incluirSnapshot !== false
    && entrada.incluir_snapshot !== false
    && entrada.incluirSnapshot !== false;

  return {
    success: true,
    job: mapearJob(row, { incluirSnapshot })
  };
}

/**
 * Reenvio controlado (Bloco D).
 * - FALHA: permitido (cria job filho).
 * - RESULTADO_INCERTO: exige confirmacao_humana explícita.
 * - ACEITA_PELO_SPOOLER / CANCELADA / PENDENTE / PROCESSANDO: bloqueado.
 * Nunca altera rodada, itens ou preparação. Preserva snapshot e histórico.
 */
async function reenviarJob(entrada = {}, opts = {}) {
  const db = opts.db || entrada.db;
  if (!db) throw erroImpressao('Banco indisponível.', 500, 'DB_INDISPONIVEL');

  const empresaId = exigirEmpresa(entrada.empresaId != null ? entrada.empresaId : entrada.empresa_id);
  const unidadeId = exigirUnidadeOperacional(
    entrada.unidadeId != null ? entrada.unidadeId : entrada.unidade_id
  );
  const id = parsePositiveInteger(entrada.id != null ? entrada.id : entrada.jobId);
  if (!id) {
    throw erroImpressao('id do job obrigatório.', 400, 'IMPRESSAO_JOB_ID_OBRIGATORIO');
  }

  const confirmacaoHumana = entrada.confirmacao_humana === true
    || entrada.confirmacaoHumana === true
    || entrada.confirmacao_humana_explicita === true;

  await exigirUnidadeDaEmpresa(db, empresaId, unidadeId);

  const origem = await dbGet(db, `
    SELECT * FROM cozinha_impressao_fila
    WHERE id = ? AND empresa_id = ? AND unidade_id = ?
  `, [id, empresaId, unidadeId]);

  if (!origem) {
    throw erroImpressao(
      'Trabalho de impressão não encontrado.',
      404,
      'IMPRESSAO_JOB_NAO_ENCONTRADO'
    );
  }

  const estado = String(origem.estado || '');

  if (estado === ESTADOS_FILA.ACEITA_PELO_SPOOLER) {
    throw erroImpressao(
      'Reenvio bloqueado: job já aceito pelo spooler.',
      409,
      'IMPRESSAO_REENVIO_BLOQUEADO_ACEITA'
    );
  }
  if (estado === ESTADOS_FILA.CANCELADA) {
    throw erroImpressao(
      'Reenvio bloqueado: job cancelado.',
      409,
      'IMPRESSAO_REENVIO_BLOQUEADO_CANCELADA'
    );
  }
  if (estado === ESTADOS_FILA.PENDENTE || estado === ESTADOS_FILA.PROCESSANDO) {
    throw erroImpressao(
      'Reenvio bloqueado: job ainda não finalizou.',
      409,
      'IMPRESSAO_REENVIO_BLOQUEADO_EM_CURSO'
    );
  }
  if (estado === ESTADOS_FILA.RESULTADO_INCERTO && !confirmacaoHumana) {
    throw erroImpressao(
      'Reenvio de RESULTADO_INCERTO exige confirmação humana explícita.',
      409,
      'IMPRESSAO_REENVIO_EXIGE_CONFIRMACAO_HUMANA',
      {
        detalhes: {
          job_id: id,
          estado,
          instrucao: 'Confirmar que não houve impressão antes de autorizar nova tentativa.'
        }
      }
    );
  }
  if (estado !== ESTADOS_FILA.FALHA && estado !== ESTADOS_FILA.RESULTADO_INCERTO) {
    throw erroImpressao(
      'Reenvio não permitido para este estado.',
      409,
      'IMPRESSAO_REENVIO_ESTADO_INVALIDO',
      { detalhes: { estado } }
    );
  }

  const contagem = await dbGet(db, `
    SELECT COUNT(*) AS n FROM cozinha_impressao_fila
    WHERE job_origem_id = ? AND empresa_id = ?
  `, [id, empresaId]);
  const sequencia = Number(contagem && contagem.n ? contagem.n : 0) + 1;
  const novaChave = montarIdempotencyKeyReenvio(id, sequencia);

  const existente = await dbGet(db, `
    SELECT * FROM cozinha_impressao_fila WHERE idempotency_key = ?
  `, [novaChave]);
  if (existente) {
    if (String(existente.payload_snapshot) === String(origem.payload_snapshot)) {
      return {
        success: true,
        repetida: true,
        job_origem: mapearJob(origem, { incluirSnapshot: true }),
        job: mapearJob(existente, { incluirSnapshot: true }),
        impressao_fisica: false
      };
    }
    throw erroImpressao(
      'Chave de reenvio já usada com snapshot diferente.',
      409,
      'IMPRESSAO_IDEMPOTENCY_DIVERGENTE'
    );
  }

  const agora = new Date().toISOString();
  let result;
  try {
    result = await dbRun(db, `
      INSERT INTO cozinha_impressao_fila (
        empresa_id, unidade_id, estacao_impressao_id, rodada_id,
        payload_snapshot, modelo, vias, estado,
        tentativas, max_tentativas, ultimo_erro,
        job_origem_id, idempotency_key, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?, ?)
    `, [
      empresaId,
      unidadeId,
      origem.estacao_impressao_id,
      origem.rodada_id,
      origem.payload_snapshot,
      origem.modelo,
      origem.vias,
      ESTADOS_FILA.PENDENTE,
      origem.max_tentativas != null ? origem.max_tentativas : 5,
      id,
      novaChave,
      agora
    ]);
  } catch (err) {
    if (/UNIQUE|unique/i.test(String(err && err.message))) {
      const again = await dbGet(db, `
        SELECT * FROM cozinha_impressao_fila WHERE idempotency_key = ?
      `, [novaChave]);
      if (again && String(again.payload_snapshot) === String(origem.payload_snapshot)) {
        return {
          success: true,
          repetida: true,
          job_origem: mapearJob(origem, { incluirSnapshot: true }),
          job: mapearJob(again, { incluirSnapshot: true }),
          impressao_fisica: false
        };
      }
      throw erroImpressao(
        'Chave de reenvio já usada com snapshot diferente.',
        409,
        'IMPRESSAO_IDEMPOTENCY_DIVERGENTE'
      );
    }
    throw err;
  }

  const filho = await dbGet(db, `
    SELECT * FROM cozinha_impressao_fila WHERE id = ?
  `, [result.lastID]);

  return {
    success: true,
    repetida: false,
    job_origem: mapearJob(origem, { incluirSnapshot: true }),
    job: mapearJob(filho, { incluirSnapshot: true }),
    impressao_fisica: false
  };
}

module.exports = {
  enfileirarJob,
  enfileirarDaRodada,
  listarFila,
  obterJob,
  reenviarJob,
  mapearJob,
  normalizarIdempotencyKey,
  montarIdempotencyKeyFila,
  montarIdempotencyKeyReenvio
};
