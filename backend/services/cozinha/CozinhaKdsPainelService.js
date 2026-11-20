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
    operador_pronto_id: historico.operador_pronto_id || null,
    eventos_preparacao: historico.eventos_preparacao || [],
    cancelamento_motivo: row.item_cancelamento_motivo || historico.cancelamento_motivo || null,
    cancelamento_por: row.item_cancelamento_por != null ? Number(row.item_cancelamento_por) : (historico.cancelamento_por || null),
    cancelamento_em: row.item_cancelado_em || historico.cancelamento_em || null,
    cancelamento_justificativa: historico.cancelamento_justificativa || null,
    cancelamento_etapa: historico.cancelamento_etapa || null,
    rodada_pronta_em_cancelamento: historico.rodada_pronta_em || null,
    estado_anterior: historico.estado_anterior || null,
    cancelamento_evento_id: historico.cancelamento_evento_id || null
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
    rodada_pronta_em: row.rodada_estado === 'PRONTA'
      || (row.rodada_estado === 'CANCELADA' && row.cancelamento_etapa === 'PRONTA')
      ? rodadaProntaEm : null,
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

async function carregarHistoricoRodadas(db, empresaId, unidadeId, rodadaIds, somenteEvidencia = false) {
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
      historico.set(rodadaId, evento.em || (somenteEvidencia ? null : evento.created_at) || null);
    });
  }

  return historico;
}

async function carregarHistoricoItens(db, empresaId, unidadeId, rows, snapshot = null, somenteEvidencia = false) {
  const ids = [...new Set((rows || []).map((row) => Number(row.item_id)).filter((id) => id > 0))];
  const rodadasPorItem = somenteEvidencia
    ? new Map(rows.map((row) => [Number(row.item_id), Number(row.rodada_id)])) : null;
  const historico = new Map();
  const tamanhoLote = 500;

  for (let inicio = 0; inicio < ids.length; inicio += tamanhoLote) {
    const lote = ids.slice(inicio, inicio + tamanhoLote);
    const eventos = await all(db, `
      SELECT id, tipo, payload_json, created_at
      FROM cozinha_eventos_outbox
      WHERE empresa_id = ?
        AND unidade_id = ?
        AND (? IS NULL OR id <= ?)
        AND tipo IN ('PREPARACAO_INICIADA', 'PREPARACAO_REVERTIDA', 'ITEM_PRONTO', 'ITEM_CANCELADO')
        AND CAST(CASE WHEN json_valid(payload_json)
          THEN COALESCE(json_extract(payload_json, '$.item.id'), json_extract(payload_json, '$.item_id'))
          END AS INTEGER)
          IN (${lote.map(() => '?').join(',')})
      ORDER BY id ASC
    `, [empresaId, unidadeId, snapshot, snapshot, ...lote]);

    eventos.forEach((evento) => {
      let payload;
      try {
        payload = JSON.parse(evento.payload_json);
      } catch (_err) {
        return;
      }
      const itemId = Number(payload && ((payload.item && payload.item.id) || payload.item_id));
      if (!Number.isInteger(itemId) || itemId <= 0) return;
      if (somenteEvidencia && Number(payload.rodada_id || (payload.rodada && payload.rodada.id))
        !== rodadasPorItem.get(itemId)) return;
      const atual = historico.get(itemId) || {};
      if (!atual.eventos_preparacao) atual.eventos_preparacao = [];
      if (evento.tipo === 'PREPARACAO_INICIADA') {
        atual.iniciado_em = payload.iniciado_em || (somenteEvidencia ? null : evento.created_at) || null;
        atual.eventos_preparacao.push({ tipo: evento.tipo, em: atual.iniciado_em });
        atual.operador_inicio_id = payload.operador_id != null
          ? Number(payload.operador_id)
          : null;
      } else if (evento.tipo === 'PREPARACAO_REVERTIDA') {
        atual.eventos_preparacao.push({ tipo: evento.tipo,
          em: payload.revertido_em || (somenteEvidencia ? null : evento.created_at) || null });
        atual.iniciado_em = null;
        atual.operador_inicio_id = null;
      } else if (evento.tipo === 'ITEM_PRONTO') {
        atual.pronto_em = payload.pronto_em
          || (payload.item && payload.item.pronto_em)
          || (somenteEvidencia ? null : evento.created_at)
          || null;
        atual.eventos_preparacao.push({ tipo: evento.tipo, em: atual.pronto_em });
        atual.operador_pronto_id = payload.operador_id != null
          ? Number(payload.operador_id)
          : null;
      } else if (evento.tipo === 'ITEM_CANCELADO') {
        atual.eventos_preparacao.push({
          tipo: evento.tipo, em: payload.cancelamento_em || (somenteEvidencia ? null : evento.created_at) || null,
          estado_anterior: payload.estado_anterior || null
        });
        atual.cancelamento_evento_id = evento.id;
        if (somenteEvidencia) atual.cancelamento_em = payload.cancelamento_em || null;
        atual.estado_anterior = payload.estado_anterior;
        atual.cancelamento_justificativa = payload.cancelamento_justificativa;
        atual.cancelamento_etapa = payload.cancelamento_etapa;
        atual.rodada_pronta_em = payload.rodada_pronta_em;
      }
      historico.set(itemId, atual);
    });
  }

  const rodadaIds = [...new Set((rows || []).map((row) => Number(row.rodada_id)).filter((id) => id > 0))];
  for (let inicio = 0; inicio < rodadaIds.length; inicio += tamanhoLote) {
    const lote = rodadaIds.slice(inicio, inicio + tamanhoLote);
    const eventos = await all(db, `
      SELECT id, payload_json, created_at FROM cozinha_eventos_outbox
      WHERE empresa_id=? AND unidade_id=? AND tipo='RODADA_CANCELADA'
        AND (? IS NULL OR id <= ?)
        AND json_valid(payload_json)
        AND CAST(json_extract(payload_json, '$.rodada_id') AS INTEGER)
          IN (${lote.map(() => '?').join(',')})
      ORDER BY id ASC
    `, [empresaId, unidadeId, snapshot, snapshot, ...lote]);
    for (const evento of eventos) {
      const payload = JSON.parse(evento.payload_json);
      const itensEvento = Array.isArray(payload.itens) ? payload.itens
        : somenteEvidencia ? [] : rows.filter((row) => Number(row.rodada_id) === Number(payload.rodada_id)
          && row.item_estado === 'CANCELADO' && !row.item_cancelado_em)
          .map((row) => ({ item_id: row.item_id }));
      for (const item of itensEvento) {
        const id = Number(item.item_id);
        if (somenteEvidencia && rodadasPorItem.get(id) !== Number(payload.rodada_id)) continue;
        const atual = historico.get(id) || {};
        if (atual.cancelamento_evento_id) continue;
        if (!atual.eventos_preparacao) atual.eventos_preparacao = [];
        atual.eventos_preparacao.push({
          tipo: 'ITEM_CANCELADO', em: payload.cancelamento_em || (somenteEvidencia ? null : evento.created_at) || null,
          estado_anterior: item.estado_anterior || null
        });
        atual.cancelamento_evento_id = evento.id;
        atual.cancelamento_motivo = payload.cancelamento_motivo;
        atual.cancelamento_por = payload.cancelamento_por;
        atual.cancelamento_em = payload.cancelamento_em || (somenteEvidencia ? null : evento.created_at);
        atual.estado_anterior = item.estado_anterior;
        atual.cancelamento_justificativa = payload.cancelamento_justificativa;
        atual.cancelamento_etapa = payload.cancelamento_etapa;
        atual.rodada_pronta_em = payload.rodada_pronta_em;
        historico.set(id, atual);
      }
    }
  }
  return historico;
}

function codificarCursor(cursor) {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function lerCursor(raw, empresaId, unidadeId, historico) {
  if (!raw) return null;
  try {
    const cursor = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    if (cursor.empresa !== empresaId || cursor.unidade !== unidadeId || cursor.historico !== historico
      || !Number.isSafeInteger(cursor.snapshot) || cursor.snapshot < 0
      || (cursor.id != null && (!Number.isSafeInteger(cursor.id) || cursor.id <= 0
        || !Number.isFinite(cursor.instante)))) throw new Error('cursor');
    return cursor;
  } catch (_err) {
    throw erro('Cursor de histórico inválido para este contexto.', 400, 'CURSOR_INVALIDO');
  }
}

async function selecionarHistoricoCursor(db, empresaId, unidadeId, historico, limite, rawCursor) {
  let cursor = lerCursor(rawCursor, empresaId, unidadeId, historico);
  if (!cursor) {
    const max = await get(db, 'SELECT COALESCE(MAX(id), 0) AS id FROM cozinha_eventos_outbox WHERE empresa_id=? AND unidade_id=?', [empresaId, unidadeId]);
    cursor = { empresa: empresaId, unidade: unidadeId, historico, snapshot: Number(max.id), id: null, instante: null };
  }
  const tipos = historico === 'retirados' ? ['RETIRADA_CONFIRMADA'] : ['ITEM_CANCELADO', 'RODADA_CANCELADA'];
  const cte = `
    WITH eventos AS (
      SELECT e.id, COALESCE(julianday(json_extract(e.payload_json, '$.cancelamento_em')),
        julianday(json_extract(e.payload_json, '$.rodada.retirada_em')),
        julianday(e.created_at), 0) AS instante,
        CAST(COALESCE(json_extract(e.payload_json, '$.rodada_id'),
          json_extract(e.payload_json, '$.rodada.id')) AS INTEGER) AS rodada_id
      FROM cozinha_eventos_outbox e
      WHERE e.empresa_id=? AND e.unidade_id=? AND e.id<=?
        AND e.tipo IN (${tipos.map(() => '?').join(',')}) AND json_valid(e.payload_json)
    ), classificados AS (
      SELECT e.*, ROW_NUMBER() OVER (PARTITION BY e.rodada_id ORDER BY e.instante DESC, e.id DESC) AS pos
      FROM eventos e JOIN cozinha_rodadas r
        ON r.id=e.rodada_id AND r.empresa_id=? AND r.unidade_id=?
    ), historico AS (SELECT * FROM classificados WHERE pos=1)
  `;
  const params = [empresaId, unidadeId, cursor.snapshot, ...tipos, empresaId, unidadeId];
  const count = await get(db, `${cte} SELECT COUNT(*) AS total FROM historico`, params);
  const semEvento = await get(db, `
    WITH rodadas_evento AS (
      SELECT DISTINCT CAST(CASE WHEN json_valid(payload_json) THEN
        COALESCE(json_extract(payload_json, '$.rodada_id'), json_extract(payload_json, '$.rodada.id'))
      END AS INTEGER) AS rodada_id
      FROM cozinha_eventos_outbox
      WHERE empresa_id=? AND unidade_id=? AND tipo IN (${tipos.map(() => '?').join(',')})
    )
    SELECT COUNT(*) AS total FROM cozinha_rodadas r
    LEFT JOIN rodadas_evento e ON e.rodada_id=r.id
    WHERE r.empresa_id=? AND r.unidade_id=?
      AND ${historico === 'retirados' ? "r.retirada_estado='RETIRADA'" : `EXISTS (
        SELECT 1 FROM cozinha_itens i WHERE i.rodada_id=r.id AND i.empresa_id=r.empresa_id
          AND i.unidade_id=r.unidade_id AND i.estado_preparacao='CANCELADO'
      )`}
      AND e.rodada_id IS NULL
  `, [empresaId, unidadeId, ...tipos, empresaId, unidadeId]);
  const rows = await all(db, `${cte}
    SELECT rodada_id, id, instante FROM historico
    WHERE (? IS NULL OR instante < ? OR (instante = ? AND id < ?))
    ORDER BY instante DESC, id DESC LIMIT ?`,
  [...params, cursor.id, cursor.instante, cursor.instante, cursor.id, limite + 1]);
  const temProxima = rows.length > limite;
  const pagina = rows.slice(0, limite);
  const ultimo = pagina[pagina.length - 1];
  return {
    rows: pagina,
    total: Number(count.total),
    semEvento: Number(semEvento.total),
    snapshot: cursor.snapshot,
    atual: codificarCursor(cursor),
    proximo: temProxima ? codificarCursor({ ...cursor, id: ultimo.id, instante: ultimo.instante }) : null
  };
}

async function listarHistoricoLegado(entrada = {}, opts = {}) {
  garantirOperacional(opts);
  const db = conn(opts);
  const empresaId = exigirEmpresa(entrada.empresaId);
  const unidadeId = exigirUnidadeOperacional(entrada.unidadeId);
  await exigirUnidadeDaEmpresa(db, empresaId, unidadeId);
  const limite = parseLimite(entrada.limite);
  let cursor;
  if (entrada.cursor) {
    try {
      cursor = JSON.parse(Buffer.from(String(entrada.cursor), 'base64url').toString('utf8'));
      if (cursor.empresa !== empresaId || cursor.unidade !== unidadeId || cursor.historico !== 'legado'
        || !Number.isSafeInteger(cursor.maxRodada) || cursor.maxRodada < 0
        || !Number.isSafeInteger(cursor.maxItem) || cursor.maxItem < 0
        || (cursor.id != null && (!Number.isSafeInteger(cursor.id) || cursor.id <= 0
          || cursor.id > cursor.maxRodada))) throw new Error('cursor');
    } catch (_err) {
      throw erro('Cursor de histórico inválido para este contexto.', 400, 'CURSOR_INVALIDO');
    }
  } else {
    const limites = await get(db, `
      SELECT
        (SELECT COALESCE(MAX(id), 0) FROM cozinha_rodadas WHERE empresa_id=? AND unidade_id=?) AS rodada,
        (SELECT COALESCE(MAX(id), 0) FROM cozinha_itens WHERE empresa_id=? AND unidade_id=?) AS item
    `, [empresaId, unidadeId, empresaId, unidadeId]);
    cursor = { empresa: empresaId, unidade: unidadeId, historico: 'legado',
      maxRodada: Number(limites.rodada), maxItem: Number(limites.item), id: null };
  }

  const eventos = `
    WITH eventos AS (
      SELECT tipo, CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END AS payload
      FROM cozinha_eventos_outbox
      WHERE empresa_id=? AND unidade_id=?
        AND tipo IN ('RETIRADA_CONFIRMADA', 'RODADA_CANCELADA', 'ITEM_CANCELADO')
    ), eventos_rodada AS (
      SELECT tipo, payload, CAST(COALESCE(json_extract(payload, '$.rodada_id'),
        json_extract(payload, '$.rodada.id')) AS INTEGER) AS rodada_id
      FROM eventos
    ), eventos_item AS (
      SELECT rodada_id, CAST(COALESCE(json_extract(payload, '$.item_id'),
        json_extract(payload, '$.item.id')) AS INTEGER) AS item_id
      FROM eventos_rodada WHERE tipo='ITEM_CANCELADO'
      UNION
      SELECT e.rodada_id, CAST(json_extract(j.value, '$.item_id') AS INTEGER)
      FROM eventos_rodada e, json_each(e.payload, '$.itens') j
      WHERE e.tipo='RODADA_CANCELADA' AND j.type='object'
    )
  `;
  const paramsEventos = [empresaId, unidadeId];
  const rodadas = await all(db, `${eventos}
    SELECT r.id, r.mesa_id, m.numero AS mesa_numero, r.numero_rodada, r.sequencia_global,
      r.estado_preparacao, r.enviada_em, r.operador_envio_id, r.retirada_estado,
      r.retirada_em, r.retirada_por, r.cancelamento_motivo, r.cancelamento_justificativa,
      r.cancelamento_por, r.cancelamento_em, r.cancelamento_etapa,
      CASE WHEN r.retirada_estado='RETIRADA' AND NOT EXISTS (
        SELECT 1 FROM eventos_rodada e WHERE e.tipo='RETIRADA_CONFIRMADA' AND e.rodada_id=r.id
      ) THEN 1 ELSE 0 END AS retirada_sem_evento,
      CASE WHEN r.estado_preparacao='CANCELADA' AND NOT EXISTS (
        SELECT 1 FROM eventos_rodada e WHERE e.tipo='RODADA_CANCELADA' AND e.rodada_id=r.id
      ) THEN 1 ELSE 0 END AS cancelamento_sem_evento
    FROM cozinha_rodadas r
    LEFT JOIN mesas m ON m.id=r.mesa_id AND m.empresa_id=r.empresa_id
    WHERE r.empresa_id=? AND r.unidade_id=? AND r.id<=? AND (? IS NULL OR r.id<?)
      AND (
        (r.retirada_estado='RETIRADA' AND NOT EXISTS (
          SELECT 1 FROM eventos_rodada e WHERE e.tipo='RETIRADA_CONFIRMADA' AND e.rodada_id=r.id
        ))
        OR (r.estado_preparacao='CANCELADA' AND NOT EXISTS (
          SELECT 1 FROM eventos_rodada e WHERE e.tipo='RODADA_CANCELADA' AND e.rodada_id=r.id
        ))
        OR EXISTS (
          SELECT 1 FROM cozinha_itens i
          WHERE i.empresa_id=r.empresa_id AND i.unidade_id=r.unidade_id AND i.rodada_id=r.id
            AND i.id<=? AND i.estado_preparacao='CANCELADO'
            AND NOT EXISTS (SELECT 1 FROM eventos_item e WHERE e.rodada_id=r.id AND e.item_id=i.id)
        )
      )
    ORDER BY r.id DESC LIMIT ?
  `, [...paramsEventos, empresaId, unidadeId, cursor.maxRodada, cursor.id, cursor.id, cursor.maxItem, limite + 1]);
  const pagina = rodadas.slice(0, limite);
  if (pagina.length) {
    const ids = pagina.map((r) => Number(r.id));
    const itens = await all(db, `${eventos}
      SELECT i.id, i.id AS item_id, i.rodada_id, i.estado_preparacao AS item_estado,
        i.cancelado_em AS item_cancelado_em, i.pedido_id, c.numero_comanda, i.produto_nome_snapshot,
        i.tipo_item, i.estado_preparacao, i.qty_solicitada_millis, i.qty_preparada_millis,
        i.qty_cancelada_millis, i.motivo_cancelamento, i.operador_cancelamento_id, i.cancelado_em,
        CASE WHEN i.estado_preparacao='CANCELADO' AND NOT EXISTS (
          SELECT 1 FROM eventos_item e WHERE e.rodada_id=i.rodada_id AND e.item_id=i.id
        ) THEN 1 ELSE 0 END AS cancelamento_sem_evento
      FROM cozinha_itens i
      LEFT JOIN cozinha_comandas c ON c.id=i.comanda_id AND c.empresa_id=i.empresa_id
      WHERE i.empresa_id=? AND i.unidade_id=? AND i.id<=?
        AND i.rodada_id IN (${ids.map(() => '?').join(',')})
      ORDER BY i.rodada_id DESC, i.sequencia_global, i.id
    `, [...paramsEventos, empresaId, unidadeId, cursor.maxItem, ...ids]);
    const historico = await carregarHistoricoItens(db, empresaId, unidadeId, itens, null, true);
    const prontas = await carregarHistoricoRodadas(db, empresaId, unidadeId, ids, true);
    const porRodada = new Map(pagina.map((r) => [Number(r.id),
      { ...r, rodada_pronta_em: prontas.get(Number(r.id)) || null, itens: [] }]));
    for (const item of itens) {
      const eventosItem = historico.get(Number(item.id)) || {};
      porRodada.get(Number(item.rodada_id)).itens.push({
        ...item,
        qty_solicitada: milessimosParaDecimalString(item.qty_solicitada_millis),
        qty_preparada: milessimosParaDecimalString(item.qty_preparada_millis),
        qty_cancelada: milessimosParaDecimalString(item.qty_cancelada_millis),
        eventos_preparacao: eventosItem.eventos_preparacao || [],
        cancelamento_justificativa: eventosItem.cancelamento_justificativa || null,
        cancelamento_em: item.cancelado_em || eventosItem.cancelamento_em || null,
        rodada_pronta_em_cancelamento: eventosItem.rodada_pronta_em || null
      });
    }
    pagina.splice(0, pagina.length, ...ids.map((id) => porRodada.get(id)));
  }
  return {
    success: true, empresa_id: empresaId, unidade_id: unidadeId, limite,
    ordenacao: 'RODADA_ID_DESC', cursor_atual: codificarCursor(cursor),
    cursor_proximo: rodadas.length > limite
      ? codificarCursor({ ...cursor, id: Number(pagina[pagina.length - 1].id) }) : null,
    registros: pagina
  };
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
  const historico = entrada.historico || null;
  if (historico && !['retirados', 'cancelados'].includes(historico)) {
    throw erro('Histórico inválido.', 400, 'HISTORICO_INVALIDO');
  }
  if (entrada.fila && entrada.fila !== 'ativa') {
    throw erro('Fila inválida.', 400, 'FILA_INVALIDA');
  }
  const paginacaoCursor = entrada.paginacao === 'cursor' && historico;
  const selecaoCursor = paginacaoCursor
    ? await selecionarHistoricoCursor(db, empresaId, unidadeId, historico, limite, entrada.cursor)
    : null;

  const params = [empresaId, unidadeId];
  let where = `
    WHERE r.empresa_id = ?
      AND r.unidade_id = ?
      AND i.empresa_id = r.empresa_id
      AND i.unidade_id = r.unidade_id
  `;

  if (historico === 'retirados') where += ` AND r.retirada_estado = 'RETIRADA'`;
  if (historico === 'cancelados') where += ` AND i.estado_preparacao = 'CANCELADO'`;
  if (entrada.fila === 'ativa') where += ` AND r.retirada_estado <> 'RETIRADA'`;

  if (estadosRodada && estadosRodada.length) {
    where += ` AND r.estado_preparacao IN (${estadosRodada.map(() => '?').join(',')})`;
    params.push(...estadosRodada);
  } else if (!incluirCancelados && historico !== 'cancelados') {
    where += ` AND r.estado_preparacao <> 'CANCELADA'`;
  }

  if (estadosItem && estadosItem.length) {
    where += ` AND i.estado_preparacao IN (${estadosItem.map(() => '?').join(',')})`;
    params.push(...estadosItem);
  } else if (!incluirCancelados && historico !== 'cancelados') {
    where += ` AND i.estado_preparacao <> 'CANCELADO'`;
  }

  const countRow = await get(db, `
    SELECT COUNT(DISTINCT r.id) AS total
    FROM cozinha_rodadas r
    INNER JOIN cozinha_itens i ON i.rodada_id = r.id AND i.empresa_id = r.empresa_id
    ${where}
  `, params);
  const total = selecaoCursor ? selecaoCursor.total : Number(countRow && countRow.total) || 0;

  const rodadaIdsRows = selecaoCursor ? selecaoCursor.rows : await all(db, `
    SELECT r.id AS rodada_id, r.sequencia_global, r.enviada_em, r.created_at
    FROM cozinha_rodadas r
    INNER JOIN cozinha_itens i ON i.rodada_id = r.id AND i.empresa_id = r.empresa_id
    ${where}
    GROUP BY r.id
    ORDER BY ${historico ? (historico === 'retirados' ? 'r.retirada_em DESC' : 'MAX(i.cancelado_em) DESC') : 'r.sequencia_global ASC, r.enviada_em ASC'}, r.id ${historico ? 'DESC' : 'ASC'}
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
      ...(selecaoCursor ? { cursor_atual: selecaoCursor.atual, cursor_proximo: selecaoCursor.proximo, registros_sem_evento: selecaoCursor.semEvento } : {}),
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
  } else if (historico === 'cancelados') {
    itemWhere += ` AND i.estado_preparacao = 'CANCELADO'`;
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
      i.motivo_cancelamento AS item_cancelamento_motivo,
      i.operador_cancelamento_id AS item_cancelamento_por,
      i.cancelado_em AS item_cancelado_em,
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
  const historicoItens = await carregarHistoricoItens(db, empresaId, unidadeId, rows,
    selecaoCursor ? selecaoCursor.snapshot : null);
  const historicoRodadas = await carregarHistoricoRodadas(
    db,
    empresaId,
    unidadeId,
    ids
  );
  const cancelamentosRodada = new Map();
  if (historico === 'cancelados') {
    const eventos = await all(db, `
      SELECT id, payload_json, created_at FROM cozinha_eventos_outbox
      WHERE empresa_id=? AND unidade_id=? AND tipo='RODADA_CANCELADA'
        AND (? IS NULL OR id<=?) AND json_valid(payload_json)
        AND CAST(json_extract(payload_json, '$.rodada_id') AS INTEGER)
          IN (${ids.map(() => '?').join(',')})
      ORDER BY id ASC
    `, [empresaId, unidadeId, selecaoCursor ? selecaoCursor.snapshot : null,
      selecaoCursor ? selecaoCursor.snapshot : null, ...ids]);
    for (const evento of eventos) {
      const payload = JSON.parse(evento.payload_json);
      cancelamentosRodada.set(Number(payload.rodada_id), {
        id: evento.id,
        motivo: payload.cancelamento_motivo || null,
        justificativa: payload.cancelamento_justificativa || null,
        operador_id: payload.cancelamento_por || null,
        em: payload.cancelamento_em || evento.created_at,
        etapa: payload.cancelamento_etapa || null,
        item_ids: Array.isArray(payload.itens) ? payload.itens.map((item) => Number(item.item_id)) : null
      });
    }
  }

  const mapa = new Map();
  for (const id of ids) {
    // placeholder order preserved
    mapa.set(id, null);
  }
  for (const row of rows) {
    if (selecaoCursor && historico === 'cancelados'
      && !(historicoItens.get(Number(row.item_id)) || {}).cancelamento_evento_id) continue;
    const rid = Number(row.rodada_id);
    let rodada = mapa.get(rid);
    if (!rodada) {
      rodada = mapearRodadaBase(row, historicoRodadas.get(rid) || null);
      if (historico === 'cancelados') rodada.cancelamento_evento = cancelamentosRodada.get(rid) || null;
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
    ordenacao: selecaoCursor ? 'EVENTO_DESC' : 'FIFO_SEQUENCIA_GLOBAL',
    ...(selecaoCursor ? { cursor_atual: selecaoCursor.atual, cursor_proximo: selecaoCursor.proximo, registros_sem_evento: selecaoCursor.semEvento } : {}),
    rodadas
  };
}

module.exports = {
  listarPainelPreparacao,
  listarHistoricoLegado,
  ESTADOS_ITEM,
  ESTADOS_RODADA,
  LIMITE_PADRAO,
  LIMITE_MAX,
  CAMPOS_PROIBIDOS_RESPOSTA
};
