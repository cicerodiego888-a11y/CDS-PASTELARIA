/**
 * CozinhaKdsPainelService — Sprint 07 · S07-0
 * Consulta somente leitura do painel de preparação (KDS).
 * Sem schema novo; sem impressão; sem dual-write; sem mutações.
 */
'use strict';

const {
  isCozinhaOperacional,
  getCozinhaSchemaStatus
} = require('../../utils/cozinhaSchema');
const { milessimosParaDecimalString } = require('./cozinhaQuantidade');
const { exigirUnidadeOperacional } = require('./cozinhaUnidadeOperacional');

const ESTADOS_ITEM = Object.freeze(['AGUARDANDO', 'EM_PREPARACAO', 'PRONTO', 'CANCELADO']);
const ESTADOS_RODADA = Object.freeze(['AGUARDANDO', 'EM_PREPARACAO', 'PRONTA', 'CANCELADA']);
const LIMITE_PADRAO = 50;
const LIMITE_MAX = 100;

const CAMPOS_PROIBIDOS_RESPOSTA = Object.freeze([
  'preco',
  'preco_unitario',
  'subtotal',
  'total',
  'pagamento',
  'valor',
  'fiscal',
  'nfe',
  'nfce',
  'cfop',
  'csosn',
  'imposto'
]);

function erro(mensagem, statusCode, codigo, extras = {}) {
  const err = new Error(mensagem);
  err.statusCode = statusCode;
  err.codigo = codigo;
  Object.assign(err, extras);
  return err;
}

function conn(opts) {
  return (opts && opts.db) || require('../../database');
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function exigirEmpresa(empresaId) {
  const n = Number(empresaId);
  if (!Number.isInteger(n) || n <= 0) {
    throw erro('Empresa do contexto é obrigatória.', 400, 'EMPRESA_CONTEXT_REQUIRED');
  }
  return n;
}

function garantirOperacional(opts) {
  if (!isCozinhaOperacional() && !(opts && opts.db)) {
    const st = getCozinhaSchemaStatus();
    throw erro(
      (st.erro && st.erro.mensagem) || 'Módulo Cozinha não operacional.',
      503,
      'COZINHA_NAO_OPERACIONAL',
      { detalhes: st }
    );
  }
}

async function exigirUnidadeDaEmpresa(db, empresaId, unidadeId) {
  const row = await get(db, `
    SELECT id, empresa_id, ativo
    FROM cozinha_unidades
    WHERE id = ? AND empresa_id = ?
  `, [unidadeId, empresaId]);
  if (!row) {
    throw erro(
      'Unidade de cozinha não autorizada para a empresa da sessão.',
      403,
      'UNIDADE_NAO_AUTORIZADA'
    );
  }
  if (Number(row.ativo) !== 1) {
    throw erro('Unidade de cozinha inativa.', 403, 'UNIDADE_INATIVA');
  }
  return row;
}

function parseListaEstados(raw, permitidos, codigo) {
  if (raw == null || raw === '') return null;
  const partes = Array.isArray(raw)
    ? raw
    : String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  if (!partes.length) return null;
  const out = [];
  for (const p of partes) {
    const u = String(p).toUpperCase();
    if (!permitidos.includes(u)) {
      throw erro(`Estado inválido: ${p}`, 400, codigo, { detalhes: { permitido: permitidos } });
    }
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

function parseLimite(raw) {
  if (raw == null || raw === '') return LIMITE_PADRAO;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw erro('limite inválido.', 400, 'LIMITE_INVALIDO');
  }
  return Math.min(n, LIMITE_MAX);
}

function parseOffset(raw) {
  if (raw == null || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw erro('offset inválido.', 400, 'OFFSET_INVALIDO');
  }
  return n;
}

function mapearItem(row, historico = {}) {
  return {
    id: row.item_id,
    empresa_id: row.empresa_id,
    unidade_id: row.unidade_id,
    rodada_id: row.rodada_id,
    comanda_id: row.comanda_id,
    numero_comanda: row.numero_comanda != null ? Number(row.numero_comanda) : null,
    pedido_id: row.pedido_id,
    pedido_item_id: row.pedido_item_id,
    tipo_item: row.tipo_item,
    estado_preparacao: row.item_estado,
    sequencia_global: row.item_sequencia_global,
    qty_solicitada: milessimosParaDecimalString(row.qty_solicitada_millis),
    qty_preparada: milessimosParaDecimalString(row.qty_preparada_millis || 0),
    qty_cancelada: milessimosParaDecimalString(row.qty_cancelada_millis || 0),
    produto_id: row.produto_id,
    produto_nome_snapshot: row.produto_nome_snapshot,
    observacoes_snapshot: row.observacoes_snapshot != null ? row.observacoes_snapshot : null,
    created_at: row.item_created_at,
    updated_at: row.item_updated_at,
    iniciado_em: historico.iniciado_em || null,
    operador_inicio_id: historico.operador_inicio_id || null,
    pronto_em: historico.pronto_em || null,
    operador_pronto_id: historico.operador_pronto_id || null
  };
}

function mapearRodadaBase(row, rodadaProntaEm = null) {
  return {
    id: row.rodada_id,
    empresa_id: row.empresa_id,
    unidade_id: row.unidade_id,
    mesa_id: row.mesa_id,
    mesa_numero: row.mesa_numero != null ? String(row.mesa_numero) : null,
    atendimento_id: row.atendimento_id,
    numero_rodada: row.numero_rodada,
    sequencia_global: row.rodada_sequencia_global,
    estado_preparacao: row.rodada_estado,
    operador_envio_id: row.operador_envio_id != null ? Number(row.operador_envio_id) : null,
    enviada_em: row.enviada_em,
    rodada_pronta_em: rodadaProntaEm,
    retirada_estado: row.retirada_estado,
    retirada_em: row.retirada_em || null,
    retirada_por: row.retirada_por != null ? Number(row.retirada_por) : null,
    cancelamento_motivo: row.cancelamento_motivo || null,
    cancelamento_justificativa: row.cancelamento_justificativa || null,
    cancelamento_por: row.cancelamento_por != null ? Number(row.cancelamento_por) : null,
    cancelamento_em: row.cancelamento_em || null,
    cancelamento_etapa: row.cancelamento_etapa || null,
    created_at: row.rodada_created_at,
    updated_at: row.rodada_updated_at,
    itens: []
  };
}

async function carregarHistoricoRodadas(db, empresaId, unidadeId, rodadaIds) {
  const historico = new Map();
  const tamanhoLote = 500;
  const ids = [...new Set((rodadaIds || []).map(Number).filter((id) => id > 0))];

  for (let inicio = 0; inicio < ids.length; inicio += tamanhoLote) {
    const lote = ids.slice(inicio, inicio + tamanhoLote);
    const eventos = await all(db, `
      SELECT
        CASE WHEN json_valid(payload_json)
          THEN CAST(json_extract(payload_json, '$.rodada_id') AS INTEGER)
          ELSE NULL
        END AS rodada_id,
        CASE WHEN json_valid(payload_json)
          THEN json_extract(payload_json, '$.em')
          ELSE NULL
        END AS em,
        created_at
      FROM cozinha_eventos_outbox
      WHERE empresa_id = ?
        AND unidade_id = ?
        AND tipo = 'RODADA_PRONTA'
        AND CAST(CASE WHEN json_valid(payload_json)
          THEN json_extract(payload_json, '$.rodada_id')
          ELSE NULL
        END AS INTEGER)
          IN (${lote.map(() => '?').join(',')})
      ORDER BY id ASC
    `, [empresaId, unidadeId, ...lote]);

    eventos.forEach((evento) => {
      const rodadaId = Number(evento.rodada_id);
      if (!Number.isInteger(rodadaId) || rodadaId <= 0) return;
      historico.set(rodadaId, evento.em || evento.created_at || null);
    });
  }

  return historico;
}

async function carregarHistoricoItens(db, empresaId, unidadeId, rows) {
  const ids = [...new Set((rows || []).map((row) => Number(row.item_id)).filter((id) => id > 0))];
  const historico = new Map();
  const tamanhoLote = 500;

  for (let inicio = 0; inicio < ids.length; inicio += tamanhoLote) {
    const lote = ids.slice(inicio, inicio + tamanhoLote);
    const eventos = await all(db, `
      SELECT tipo, payload_json, created_at
      FROM cozinha_eventos_outbox
      WHERE empresa_id = ?
        AND unidade_id = ?
        AND tipo IN ('PREPARACAO_INICIADA', 'ITEM_PRONTO')
        AND CAST(CASE WHEN json_valid(payload_json)
          THEN json_extract(payload_json, '$.item.id')
          END AS INTEGER)
          IN (${lote.map(() => '?').join(',')})
      ORDER BY id ASC
    `, [empresaId, unidadeId, ...lote]);

    eventos.forEach((evento) => {
      let payload;
      try {
        payload = JSON.parse(evento.payload_json);
      } catch (_err) {
        return;
      }
      const itemId = Number(payload && payload.item && payload.item.id);
      if (!Number.isInteger(itemId) || itemId <= 0) return;
      const atual = historico.get(itemId) || {};
      if (evento.tipo === 'PREPARACAO_INICIADA') {
        atual.iniciado_em = payload.iniciado_em || evento.created_at || null;
        atual.operador_inicio_id = payload.operador_id != null
          ? Number(payload.operador_id)
          : null;
      } else if (evento.tipo === 'ITEM_PRONTO') {
        atual.pronto_em = payload.pronto_em
          || (payload.item && payload.item.pronto_em)
          || evento.created_at
          || null;
        atual.operador_pronto_id = payload.operador_id != null
          ? Number(payload.operador_id)
          : null;
      }
      historico.set(itemId, atual);
    });
  }

  return historico;
}

/**
 * Lista rodadas/itens despachados para o painel KDS.
 * Empresa e unidade obrigatórias da sessão (nunca substituídas pelo cliente).
 */
async function listarPainelPreparacao(entrada = {}, opts = {}) {
  garantirOperacional(opts);
  const db = conn(opts);
  const empresaId = exigirEmpresa(entrada.empresaId != null ? entrada.empresaId : entrada.empresa_id);
  const unidadeId = exigirUnidadeOperacional(
    entrada.unidadeId != null ? entrada.unidadeId : entrada.unidade_id
  );
  await exigirUnidadeDaEmpresa(db, empresaId, unidadeId);

  const estadosItem = parseListaEstados(
    entrada.estado_item != null ? entrada.estado_item : entrada.estadoItem,
    ESTADOS_ITEM,
    'ESTADO_ITEM_INVALIDO'
  );
  const estadosRodada = parseListaEstados(
    entrada.estado_rodada != null ? entrada.estado_rodada : entrada.estadoRodada,
    ESTADOS_RODADA,
    'ESTADO_RODADA_INVALIDO'
  );
  const limite = parseLimite(entrada.limite != null ? entrada.limite : entrada.limit);
  const offset = parseOffset(entrada.offset);
  const incluirCancelados = entrada.incluir_cancelados === true
    || entrada.incluirCancelados === true
    || entrada.incluir_cancelados === '1'
    || entrada.incluir_cancelados === 'true';

  const params = [empresaId, unidadeId];
  let where = `
    WHERE r.empresa_id = ?
      AND r.unidade_id = ?
      AND i.empresa_id = r.empresa_id
      AND i.unidade_id = r.unidade_id
  `;

  if (estadosRodada && estadosRodada.length) {
    where += ` AND r.estado_preparacao IN (${estadosRodada.map(() => '?').join(',')})`;
    params.push(...estadosRodada);
  } else if (!incluirCancelados) {
    where += ` AND r.estado_preparacao <> 'CANCELADA'`;
  }

  if (estadosItem && estadosItem.length) {
    where += ` AND i.estado_preparacao IN (${estadosItem.map(() => '?').join(',')})`;
    params.push(...estadosItem);
  } else if (!incluirCancelados) {
    where += ` AND i.estado_preparacao <> 'CANCELADO'`;
  }

  const countRow = await get(db, `
    SELECT COUNT(DISTINCT r.id) AS total
    FROM cozinha_rodadas r
    INNER JOIN cozinha_itens i ON i.rodada_id = r.id AND i.empresa_id = r.empresa_id
    ${where}
  `, params);
  const total = Number(countRow && countRow.total) || 0;

  const rodadaIdsRows = await all(db, `
    SELECT r.id AS rodada_id, r.sequencia_global, r.enviada_em, r.created_at
    FROM cozinha_rodadas r
    INNER JOIN cozinha_itens i ON i.rodada_id = r.id AND i.empresa_id = r.empresa_id
    ${where}
    GROUP BY r.id
    ORDER BY r.sequencia_global ASC, r.enviada_em ASC, r.id ASC
    LIMIT ? OFFSET ?
  `, [...params, limite, offset]);

  if (!rodadaIdsRows.length) {
    return {
      success: true,
      empresa_id: empresaId,
      unidade_id: unidadeId,
      total,
      limite,
      offset,
      impressao_fisica: false,
      financeiro: false,
      fiscal: false,
      ordenacao: 'FIFO_SEQUENCIA_GLOBAL',
      rodadas: []
    };
  }

  const ids = rodadaIdsRows.map((r) => Number(r.rodada_id));
  const itemParams = [empresaId, unidadeId, ...ids];
  let itemWhere = `
    WHERE r.empresa_id = ?
      AND r.unidade_id = ?
      AND r.id IN (${ids.map(() => '?').join(',')})
      AND i.empresa_id = r.empresa_id
      AND i.unidade_id = r.unidade_id
  `;
  if (estadosItem && estadosItem.length) {
    itemWhere += ` AND i.estado_preparacao IN (${estadosItem.map(() => '?').join(',')})`;
    itemParams.push(...estadosItem);
  } else if (!incluirCancelados) {
    itemWhere += ` AND i.estado_preparacao <> 'CANCELADO'`;
  }

  const rows = await all(db, `
    SELECT
      r.id AS rodada_id,
      r.empresa_id,
      r.unidade_id,
      r.mesa_id,
      r.atendimento_id,
      r.numero_rodada,
      r.sequencia_global AS rodada_sequencia_global,
      r.estado_preparacao AS rodada_estado,
      r.operador_envio_id,
      r.enviada_em,
      r.retirada_estado,
      r.retirada_em,
      r.retirada_por,
      r.cancelamento_motivo,
      r.cancelamento_justificativa,
      r.cancelamento_por,
      r.cancelamento_em,
      r.cancelamento_etapa,
      r.created_at AS rodada_created_at,
      r.updated_at AS rodada_updated_at,
      m.numero AS mesa_numero,
      c.id AS comanda_id,
      c.numero_comanda,
      i.id AS item_id,
      i.pedido_id,
      i.pedido_item_id,
      i.tipo_item,
      i.estado_preparacao AS item_estado,
      i.sequencia_global AS item_sequencia_global,
      i.qty_solicitada_millis,
      i.qty_preparada_millis,
      i.qty_cancelada_millis,
      i.produto_id,
      i.produto_nome_snapshot,
      i.observacoes_snapshot,
      i.created_at AS item_created_at,
      i.updated_at AS item_updated_at
    FROM cozinha_rodadas r
    INNER JOIN cozinha_itens i
      ON i.rodada_id = r.id AND i.empresa_id = r.empresa_id
    INNER JOIN cozinha_comandas c
      ON c.id = i.comanda_id AND c.empresa_id = i.empresa_id
    LEFT JOIN mesas m
      ON m.id = r.mesa_id AND m.empresa_id = r.empresa_id
    ${itemWhere}
    ORDER BY r.sequencia_global ASC, r.enviada_em ASC, r.id ASC,
             i.sequencia_global ASC, i.id ASC
  `, itemParams);
  const historicoItens = await carregarHistoricoItens(db, empresaId, unidadeId, rows);
  const historicoRodadas = await carregarHistoricoRodadas(
    db,
    empresaId,
    unidadeId,
    ids
  );

  const mapa = new Map();
  for (const id of ids) {
    // placeholder order preserved
    mapa.set(id, null);
  }
  for (const row of rows) {
    const rid = Number(row.rodada_id);
    let rodada = mapa.get(rid);
    if (!rodada) {
      rodada = mapearRodadaBase(row, historicoRodadas.get(rid) || null);
      mapa.set(rid, rodada);
    }
    rodada.itens.push(mapearItem(row, historicoItens.get(Number(row.item_id)) || {}));
  }

  const rodadas = ids
    .map((id) => mapa.get(id))
    .filter((r) => r && Array.isArray(r.itens) && r.itens.length > 0);

  return {
    success: true,
    empresa_id: empresaId,
    unidade_id: unidadeId,
    total,
    limite,
    offset,
    impressao_fisica: false,
    financeiro: false,
    fiscal: false,
    ordenacao: 'FIFO_SEQUENCIA_GLOBAL',
    rodadas
  };
}

module.exports = {
  listarPainelPreparacao,
  ESTADOS_ITEM,
  ESTADOS_RODADA,
  LIMITE_PADRAO,
  LIMITE_MAX,
  CAMPOS_PROIBIDOS_RESPOSTA
};
