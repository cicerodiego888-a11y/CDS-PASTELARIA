'use strict';

const crypto = require('crypto');
const CozinhaTurno = require('./CozinhaTurnoService');
const { milessimosParaDecimalString } = require('./cozinhaQuantidade');

const EVENTOS_RETIRADA = Object.freeze([
  'RETIRADA_CONFIRMADA',
  'RETIRADA_ESTORNADA',
  'AJUSTE_CREDITO',
  'AJUSTE_DEBITO'
]);

function erro(mensagem, statusCode, codigo) {
  const err = new Error(mensagem);
  err.statusCode = statusCode;
  err.codigo = codigo;
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

async function allPorLotes(valores, consultar) {
  const resultado = [];
  for (let inicio = 0; inicio < valores.length; inicio += 400) {
    resultado.push(...await consultar(valores.slice(inicio, inicio + 400)));
  }
  return resultado;
}

async function tabelaExiste(db, nome) {
  return !!(await get(db,
    "SELECT 1 AS existe FROM sqlite_master WHERE type='table' AND name=?",
    [nome]));
}

function validarData(raw) {
  const data = String(raw || '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data);
  if (!match) throw erro('Informe uma data válida no formato AAAA-MM-DD.', 400, 'DATA_HISTORICO_INVALIDA');
  const ano = Number(match[1]);
  const mes = Number(match[2]);
  const dia = Number(match[3]);
  const valida = new Date(Date.UTC(ano, mes - 1, dia));
  if (valida.getUTCFullYear() !== ano || valida.getUTCMonth() !== mes - 1 || valida.getUTCDate() !== dia) {
    throw erro('Informe uma data válida no formato AAAA-MM-DD.', 400, 'DATA_HISTORICO_INVALIDA');
  }
  return data;
}

function validarTurnoId(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const turnoId = Number(raw);
  if (!Number.isSafeInteger(turnoId) || turnoId <= 0) {
    throw erro('Turno inválido.', 400, 'TURNO_INVALIDO');
  }
  return turnoId;
}

function validarTextoFiltro(raw, nome) {
  const valor = String(raw == null ? '' : raw).trim();
  if (valor.length > 100) {
    throw erro(`O filtro ${nome} excede 100 caracteres.`, 400, 'FILTRO_HISTORICO_INVALIDO');
  }
  return valor;
}

function limitarNumero(raw, padrao, maximo) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? Math.min(n, maximo) : padrao;
}

function milessimos(valor) {
  return milessimosParaDecimalString(Number(valor) || 0);
}

function criarFiltroEventos({ empresaId, unidadeId, data, turnoId, filtros }) {
  const params = [empresaId, unidadeId, data];
  const where = [
    'e.empresa_id=?',
    'e.unidade_id=?',
    "date(datetime(e.registrado_em, '-3 hours'))=?",
    `e.tipo_evento IN (${EVENTOS_RETIRADA.map(() => '?').join(',')})`
  ];
  params.push(...EVENTOS_RETIRADA);
  if (turnoId != null) {
    where.push('COALESCE(e.turno_id, i.turno_id, r.turno_id)=?');
    params.push(turnoId);
  }
  if (filtros.pedido) {
    where.push("(CAST(p.id AS TEXT) LIKE ? OR COALESCE(p.codigo,'') LIKE ?)");
    params.push(`%${filtros.pedido}%`, `%${filtros.pedido}%`);
  }
  if (filtros.mesa) {
    where.push('CAST(m.numero AS TEXT) LIKE ?');
    params.push(`%${filtros.mesa}%`);
  }
  if (filtros.garcom) {
    where.push(`(
      CAST(COALESCE(c.operador_lancamento_id,r.operador_envio_id) AS TEXT) LIKE ?
      OR COALESCE(g.nome,'') LIKE ?
      OR COALESCE(g.username,'') LIKE ?
    )`);
    params.push(`%${filtros.garcom}%`, `%${filtros.garcom}%`, `%${filtros.garcom}%`);
  }
  if (filtros.produto) {
    where.push("(COALESCE(i.produto_nome_snapshot,pr.nome,'') LIKE ? OR CAST(i.produto_id AS TEXT) LIKE ?)");
    params.push(`%${filtros.produto}%`, `%${filtros.produto}%`);
  }
  if (filtros.categoria) {
    where.push("(COALESCE(cat.nome,'') LIKE ? OR CAST(cat.id AS TEXT) LIKE ?)");
    params.push(`%${filtros.categoria}%`, `%${filtros.categoria}%`);
  }
  return { where: where.join('\n AND '), params };
}

const FROM_EVENTOS = `
  FROM cozinha_retirada_itens e
  JOIN cozinha_itens i
    ON i.id=e.cozinha_item_id AND i.empresa_id=e.empresa_id AND i.unidade_id=e.unidade_id
  JOIN cozinha_rodadas r
    ON r.id=i.rodada_id AND r.empresa_id=i.empresa_id AND r.unidade_id=i.unidade_id
  JOIN cozinha_comandas c
    ON c.id=i.comanda_id AND c.empresa_id=i.empresa_id
  JOIN pedidos p
    ON p.id=i.pedido_id AND p.empresa_id=i.empresa_id
  LEFT JOIN mesas m
    ON m.id=r.mesa_id AND m.empresa_id=r.empresa_id
  LEFT JOIN produtos pr ON pr.id=i.produto_id
  LEFT JOIN categorias cat ON cat.id=pr.categoria_id
  LEFT JOIN usuarios g ON g.id=COALESCE(c.operador_lancamento_id,r.operador_envio_id)
`;

async function listarHistoricoPedidosRetirados(entrada = {}, opts = {}) {
  const db = conn(opts);
  const contexto = await CozinhaTurno.exigirAcessoGerencial({
    operadorId: entrada.operadorId,
    unidadeId: entrada.unidadeId
  }, { db });
  const data = validarData(entrada.data);
  const turnoId = validarTurnoId(entrada.turnoId != null ? entrada.turnoId : entrada.turno_id);
  const filtros = {
    pedido: validarTextoFiltro(entrada.pedido, 'pedido'),
    mesa: validarTextoFiltro(entrada.mesa, 'mesa'),
    garcom: validarTextoFiltro(entrada.garcom, 'garçom'),
    produto: validarTextoFiltro(entrada.produto, 'produto'),
    categoria: validarTextoFiltro(entrada.categoria, 'categoria')
  };
  const limite = limitarNumero(entrada.limite, 25, 100);
  const offset = limitarNumero(entrada.offset, 0, 1000000);

  if (!await tabelaExiste(db, 'cozinha_retirada_itens')) {
    throw erro('Ledger oficial de retirada indisponível.', 503, 'HISTORICO_LEDGER_INDISPONIVEL');
  }
  if (turnoId != null) {
    const turno = await get(db, `
      SELECT id FROM cozinha_turnos
      WHERE id=? AND empresa_id=? AND unidade_id=?
    `, [turnoId, contexto.empresaId, contexto.unidadeId]);
    if (!turno) throw erro('Turno não encontrado nesta unidade.', 404, 'TURNO_NAO_ENCONTRADO');
  }

  const filtroEventos = criarFiltroEventos({ ...contexto, data, turnoId, filtros });
  const count = await get(db, `
    SELECT COUNT(*) AS total FROM (
      SELECT e.pedido_id, COALESCE(e.turno_id,i.turno_id,r.turno_id) AS turno_id
      ${FROM_EVENTOS}
      WHERE ${filtroEventos.where}
      GROUP BY e.pedido_id, COALESCE(e.turno_id,i.turno_id,r.turno_id)
    )
  `, filtroEventos.params);
  const grupos = await all(db, `
    SELECT e.pedido_id, COALESCE(e.turno_id,i.turno_id,r.turno_id) AS turno_id,
      MAX(e.registrado_em) AS ultima_retirada_em
    ${FROM_EVENTOS}
    WHERE ${filtroEventos.where}
    GROUP BY e.pedido_id, COALESCE(e.turno_id,i.turno_id,r.turno_id)
    ORDER BY ultima_retirada_em DESC, e.pedido_id DESC
    LIMIT ? OFFSET ?
  `, [...filtroEventos.params, limite, offset]);

  const turnos = await all(db, `
    SELECT t.id, t.abertura_em, t.fechamento_em, t.fechamento_tipo,
      t.fechamento_justificativa,
      EXISTS (
        SELECT 1 FROM cozinha_turno_relatorios rel
        WHERE rel.turno_id=t.id AND rel.empresa_id=t.empresa_id AND rel.unidade_id=t.unidade_id
      ) AS snapshot_persistido
    FROM cozinha_turnos t
    WHERE t.empresa_id=? AND t.unidade_id=?
      AND (? IS NOT NULL AND t.id=? OR ? IS NULL AND (
        date(datetime(t.abertura_em, '-3 hours'))=?
        OR date(datetime(t.fechamento_em, '-3 hours'))=?
        OR EXISTS (
          SELECT 1 FROM cozinha_retirada_itens e
          JOIN cozinha_itens i
            ON i.id=e.cozinha_item_id AND i.empresa_id=e.empresa_id AND i.unidade_id=e.unidade_id
          JOIN cozinha_rodadas r
            ON r.id=i.rodada_id AND r.empresa_id=i.empresa_id AND r.unidade_id=i.unidade_id
          WHERE e.empresa_id=t.empresa_id AND e.unidade_id=t.unidade_id
            AND COALESCE(e.turno_id,i.turno_id,r.turno_id)=t.id
            AND date(datetime(e.registrado_em, '-3 hours'))=?
        )
      ))
    ORDER BY t.id DESC
    LIMIT 200
  `, [contexto.empresaId, contexto.unidadeId, turnoId, turnoId, turnoId, data, data, data]);

  const excepcionais = await all(db, `
    SELECT t.id AS turno_id, t.abertura_em, t.fechamento_em,
      t.fechamento_tipo, t.fechamento_justificativa, t.fechamento_operador_id,
      rel.snapshot_json, rel.snapshot_sha256
    FROM cozinha_turnos t
    LEFT JOIN cozinha_turno_relatorios rel
      ON rel.turno_id=t.id AND rel.empresa_id=t.empresa_id AND rel.unidade_id=t.unidade_id
    WHERE t.empresa_id=? AND t.unidade_id=? AND t.fechamento_tipo='EXCEPCIONAL'
      AND ((? IS NOT NULL AND t.id=?) OR (? IS NULL
        AND date(datetime(t.fechamento_em, '-3 hours'))=?))
    ORDER BY t.fechamento_em DESC, t.id DESC
  `, [contexto.empresaId, contexto.unidadeId, turnoId, turnoId, turnoId, data]);

  const pedidos = await montarPedidos(db, contexto, grupos, data, turnoId);
  const pendenciasExcepcionais = excepcionais.map((turno) => {
    if (!turno.snapshot_json) {
      return {
        turno_id: Number(turno.turno_id),
        fechamento_em: turno.fechamento_em,
        fechamento_operador_id: turno.fechamento_operador_id,
        fechamento_justificativa: turno.fechamento_justificativa,
        snapshot_persistido: false,
        situacao: 'SNAPSHOT_INDISPONIVEL',
        pendencias: null
      };
    }
    let snapshot;
    try { snapshot = JSON.parse(turno.snapshot_json); }
    catch (_err) {
      throw erro('Snapshot imutável do fechamento excepcional inválido.', 500, 'RELATORIO_SNAPSHOT_INVALIDO');
    }
    const hashCalculado = crypto.createHash('sha256').update(turno.snapshot_json).digest('hex');
    if (hashCalculado !== turno.snapshot_sha256) {
      throw erro('Snapshot imutável do fechamento excepcional inconsistente.', 500, 'RELATORIO_SNAPSHOT_INTEGRIDADE');
    }
    return {
      turno_id: Number(turno.turno_id),
      fechamento_em: turno.fechamento_em,
      fechamento_operador_id: turno.fechamento_operador_id,
      fechamento_justificativa: turno.fechamento_justificativa,
      snapshot_sha256: turno.snapshot_sha256,
      snapshot_persistido: true,
      situacao: 'PENDENCIAS_PRESERVADAS_NO_FECHAMENTO_EXCEPCIONAL',
      pendencias: Array.isArray(snapshot.indicadores && snapshot.indicadores.pendencias)
        ? snapshot.indicadores.pendencias
        : []
    };
  });

  return {
    success: true,
    empresa_id: contexto.empresaId,
    unidade_id: contexto.unidadeId,
    data,
    filtros: { turno_id: turnoId, ...filtros },
    total: Number(count && count.total) || 0,
    limite,
    offset,
    turnos: turnos.map((turno) => ({
      id: Number(turno.id),
      abertura_em: turno.abertura_em,
      fechamento_em: turno.fechamento_em,
      fechamento_tipo: turno.fechamento_tipo,
      fechamento_justificativa: turno.fechamento_justificativa,
      snapshot_persistido: Number(turno.snapshot_persistido) === 1
    })),
    pedidos,
    pendencias_excepcionais: pendenciasExcepcionais
  };
}

async function montarPedidos(db, contexto, grupos, data, turnoId) {
  if (!grupos.length) return [];
  const pares = [];
  const valores = grupos.map(() => '(?, ?)').join(', ');
  const ultimaRetiradaPorGrupo = new Map();
  for (const grupo of grupos) {
    const turnoId = grupo.turno_id == null ? null : Number(grupo.turno_id);
    pares.push(Number(grupo.pedido_id), turnoId);
    ultimaRetiradaPorGrupo.set(
      `${Number(grupo.pedido_id)}:${turnoId == null ? 'sem-turno' : turnoId}`,
      grupo.ultima_retirada_em
    );
  }
  const cancelamentosDisponiveis = await tabelaExiste(db, 'cozinha_cancelamento_itens');
  const canceladoSql = cancelamentosDisponiveis
    ? `COALESCE((SELECT SUM(CASE
        WHEN e.tipo_evento='CANCELAMENTO_CONFIRMADO' THEN e.qty_millis
        WHEN e.tipo_evento='CANCELAMENTO_ESTORNADO' THEN -e.qty_millis
        ELSE 0 END)
      FROM cozinha_cancelamento_itens e
      WHERE e.empresa_id=i.empresa_id AND e.unidade_id=i.unidade_id
        AND e.cozinha_item_id=i.id
        AND COALESCE(e.turno_id,i.turno_id,r.turno_id) IS a.turno_id
        AND date(datetime(e.registrado_em,'-3 hours'))<=date(?)),0)`
    : 'COALESCE(i.qty_cancelada_millis,0)';
  const params = [...pares, data];
  if (cancelamentosDisponiveis) params.push(data);
  params.push(contexto.empresaId, contexto.unidadeId);
  const itens = await all(db, `
    WITH alvos(pedido_id, turno_id) AS (VALUES ${valores})
    SELECT
      a.turno_id,
      p.id AS pedido_id, p.codigo AS pedido_codigo, p.status AS pedido_status,
      p.created_at AS pedido_criado_em,
      t.abertura_em AS turno_abertura_em, t.fechamento_em AS turno_fechamento_em,
      t.fechamento_tipo, t.fechamento_justificativa,
      r.id AS rodada_id, r.numero_rodada, r.enviada_em, r.mesa_id,
      m.numero AS mesa_numero,
      c.numero_comanda,
      COALESCE(c.operador_lancamento_id,r.operador_envio_id) AS garcom_id,
      COALESCE(g.nome,g.username,CAST(COALESCE(c.operador_lancamento_id,r.operador_envio_id) AS TEXT)) AS garcom_nome,
      i.id AS item_id, i.pedido_item_id, i.produto_id, i.tipo_item,
      COALESCE(i.produto_nome_snapshot,pr.nome,'Sem nome') AS produto_nome,
      pr.categoria_id, cat.nome AS categoria_nome,
      i.qty_solicitada_millis, i.qty_preparada_millis, i.qty_cancelada_millis,
      i.estado_preparacao, i.preparo_iniciado_em, i.pronto_em,
      (SELECT COALESCE(SUM(CASE
        WHEN e.tipo_evento IN ('RETIRADA_CONFIRMADA','AJUSTE_CREDITO') THEN e.qty_millis
        WHEN e.tipo_evento IN ('RETIRADA_ESTORNADA','AJUSTE_DEBITO') THEN -e.qty_millis
        ELSE 0 END),0)
       FROM cozinha_retirada_itens e
       WHERE e.empresa_id=i.empresa_id AND e.unidade_id=i.unidade_id
         AND e.cozinha_item_id=i.id
         AND COALESCE(e.turno_id,i.turno_id,r.turno_id) IS a.turno_id
         AND date(datetime(e.registrado_em,'-3 hours'))<=date(?)) AS retirado_liquido_millis,
      ${canceladoSql} AS cancelado_liquido_millis
    FROM alvos a
    JOIN cozinha_itens i
      ON i.pedido_id=a.pedido_id AND i.empresa_id=? AND i.unidade_id=?
    JOIN cozinha_rodadas r
      ON r.id=i.rodada_id AND r.empresa_id=i.empresa_id AND r.unidade_id=i.unidade_id
      AND a.turno_id IS COALESCE(i.turno_id,r.turno_id)
    JOIN pedidos p ON p.id=i.pedido_id AND p.empresa_id=i.empresa_id
    LEFT JOIN cozinha_turnos t
      ON t.id=a.turno_id AND t.empresa_id=i.empresa_id AND t.unidade_id=i.unidade_id
    LEFT JOIN cozinha_comandas c ON c.id=i.comanda_id AND c.empresa_id=i.empresa_id
    LEFT JOIN mesas m ON m.id=r.mesa_id AND m.empresa_id=r.empresa_id
    LEFT JOIN produtos pr ON pr.id=i.produto_id
    LEFT JOIN categorias cat ON cat.id=pr.categoria_id
    LEFT JOIN usuarios g ON g.id=COALESCE(c.operador_lancamento_id,r.operador_envio_id)
    ORDER BY p.id DESC, i.id
  `, params);

  const itemIds = [...new Set(itens.map((item) => Number(item.item_id)))];
  if (!itemIds.length) return [];
  const turnoWhere = turnoId == null ? '' : ' AND COALESCE(i.turno_id,r.turno_id)=?';
  const turnoParams = turnoId == null ? [] : [turnoId];
  const [retiradas, cancelamentos, bebidas, preparacao] = await Promise.all([
    allPorLotes(itemIds, (lote) => all(db, `
      SELECT e.id, e.cozinha_item_id, e.tipo_evento, e.qty_millis,
        e.operador_id, COALESCE(u.nome,u.username,CAST(e.operador_id AS TEXT)) AS operador_nome,
        e.autorizado_por_operador_id, e.registrado_em, e.justificativa,
        e.evento_origem_id
      FROM cozinha_retirada_itens e
      JOIN cozinha_itens i ON i.id=e.cozinha_item_id AND i.empresa_id=e.empresa_id AND i.unidade_id=e.unidade_id
      JOIN cozinha_rodadas r ON r.id=i.rodada_id AND r.empresa_id=i.empresa_id AND r.unidade_id=i.unidade_id
      LEFT JOIN usuarios u ON u.id=e.operador_id
      WHERE e.empresa_id=? AND e.unidade_id=? AND date(datetime(e.registrado_em,'-3 hours'))=?
        AND e.cozinha_item_id IN (${lote.map(() => '?').join(',')})${turnoWhere}
      ORDER BY e.id
    `, [contexto.empresaId, contexto.unidadeId, data, ...lote, ...turnoParams])),
    tabelaExiste(db, 'cozinha_cancelamento_itens').then(existe => existe
      ? allPorLotes(itemIds, (lote) => all(db, `
        SELECT e.id, e.cozinha_item_id, e.tipo_evento, e.qty_millis,
          e.operador_id, COALESCE(u.nome,u.username,CAST(e.operador_id AS TEXT)) AS operador_nome,
          e.autorizado_por_operador_id, e.registrado_em, e.justificativa,
          e.evento_origem_id
        FROM cozinha_cancelamento_itens e
        JOIN cozinha_itens i ON i.id=e.cozinha_item_id AND i.empresa_id=e.empresa_id AND i.unidade_id=e.unidade_id
        JOIN cozinha_rodadas r ON r.id=i.rodada_id AND r.empresa_id=i.empresa_id AND r.unidade_id=i.unidade_id
        LEFT JOIN usuarios u ON u.id=e.operador_id
        WHERE e.empresa_id=? AND e.unidade_id=? AND date(datetime(e.registrado_em,'-3 hours'))=?
          AND e.cozinha_item_id IN (${lote.map(() => '?').join(',')})${turnoWhere}
        ORDER BY e.id
      `, [contexto.empresaId, contexto.unidadeId, data, ...lote, ...turnoParams])) : []),
    tabelaExiste(db, 'cozinha_bebida_entregas').then(existe => existe
      ? allPorLotes(itemIds, (lote) => all(db, `
        SELECT e.id, e.cozinha_item_id, e.qty_entregue_millis, e.operador_id,
          COALESCE(u.nome,u.username,CAST(e.operador_id AS TEXT)) AS operador_nome,
          e.entregue_em
        FROM cozinha_bebida_entregas e
        JOIN cozinha_itens i ON i.id=e.cozinha_item_id AND i.empresa_id=e.empresa_id
        JOIN cozinha_rodadas r ON r.id=i.rodada_id AND r.empresa_id=i.empresa_id AND r.unidade_id=i.unidade_id
        LEFT JOIN usuarios u ON u.id=e.operador_id
        WHERE e.empresa_id=? AND i.unidade_id=? AND date(datetime(e.entregue_em,'-3 hours'))=?
          AND e.cozinha_item_id IN (${lote.map(() => '?').join(',')})${turnoWhere}
        ORDER BY e.id
      `, [contexto.empresaId, contexto.unidadeId, data, ...lote, ...turnoParams])) : []),
    tabelaExiste(db, 'cozinha_eventos_outbox').then(existe => existe
      ? allPorLotes(itemIds, (lote) => all(db, `
        SELECT e.id, e.tipo, e.payload_json, e.created_at,
          CAST(CASE WHEN json_valid(e.payload_json) THEN json_extract(e.payload_json,'$.operador_id') END AS INTEGER) AS operador_id,
          COALESCE(u.nome,u.username,CAST(CASE WHEN json_valid(e.payload_json)
            THEN json_extract(e.payload_json,'$.operador_id') END AS TEXT)) AS operador_nome
        FROM cozinha_eventos_outbox e
        LEFT JOIN usuarios u ON u.id=CAST(CASE WHEN json_valid(e.payload_json)
          THEN json_extract(e.payload_json,'$.operador_id') END AS INTEGER)
        JOIN cozinha_itens i ON i.id=CAST(COALESCE(json_extract(e.payload_json,'$.item.id'),
          json_extract(e.payload_json,'$.item_id')) AS INTEGER)
          AND i.empresa_id=e.empresa_id AND i.unidade_id=e.unidade_id
        JOIN cozinha_rodadas r ON r.id=i.rodada_id AND r.empresa_id=i.empresa_id AND r.unidade_id=i.unidade_id
        WHERE e.empresa_id=? AND e.unidade_id=?
          AND e.tipo IN ('PREPARACAO_INICIADA','PREPARACAO_REVERTIDA','ITEM_PRONTO')
          AND json_valid(e.payload_json)
          AND date(datetime(COALESCE(json_extract(e.payload_json,'$.iniciado_em'),
            json_extract(e.payload_json,'$.pronto_em'),json_extract(e.payload_json,'$.revertido_em'),
            e.created_at),'-3 hours'))=?
          AND CAST(COALESCE(json_extract(e.payload_json,'$.item.id'),
            json_extract(e.payload_json,'$.item_id')) AS INTEGER) IN (${lote.map(() => '?').join(',')})${turnoWhere}
        ORDER BY e.id
      `, [contexto.empresaId, contexto.unidadeId, data, ...lote, ...turnoParams])) : [])
  ]);

  const porItem = new Map(itemIds.map((id) => [id, {
    retiradas: [], cancelamentos: [], entregas_bebida: [], eventos_preparacao: []
  }]));
  for (const evento of retiradas) {
    porItem.get(Number(evento.cozinha_item_id)).retiradas.push({
      ...evento,
      quantidade: milessimos(evento.qty_millis)
    });
  }
  for (const evento of cancelamentos) {
    porItem.get(Number(evento.cozinha_item_id)).cancelamentos.push({
      ...evento,
      quantidade: milessimos(evento.qty_millis)
    });
  }
  for (const evento of bebidas) {
    porItem.get(Number(evento.cozinha_item_id)).entregas_bebida.push({
      ...evento,
      quantidade: milessimos(evento.qty_entregue_millis)
    });
  }
  for (const evento of preparacao) {
    const payload = JSON.parse(evento.payload_json);
    const itemId = Number((payload.item && payload.item.id) || payload.item_id);
    const destino = porItem.get(itemId);
    if (!destino) continue;
    destino.eventos_preparacao.push({
      id: Number(evento.id),
      tipo: evento.tipo,
      em: payload.iniciado_em || payload.pronto_em || payload.revertido_em || evento.created_at,
      operador_id: evento.operador_id == null ? null : Number(evento.operador_id),
      operador_nome: evento.operador_nome || null
    });
  }

  const porPedido = new Map();
  for (const row of itens) {
    const chave = `${row.pedido_id}:${row.turno_id == null ? 'sem-turno' : row.turno_id}`;
    let pedido = porPedido.get(chave);
    if (!pedido) {
      pedido = {
        pedido_id: Number(row.pedido_id),
        pedido_codigo: row.pedido_codigo || null,
        pedido_status: row.pedido_status || null,
        pedido_criado_em: row.pedido_criado_em || null,
        turno_id: row.turno_id == null ? null : Number(row.turno_id),
        turno_abertura_em: row.turno_abertura_em || null,
        turno_fechamento_em: row.turno_fechamento_em || null,
        fechamento_tipo: row.fechamento_tipo || null,
        fechamento_justificativa: row.fechamento_justificativa || null,
        mesa_id: row.mesa_id == null ? null : Number(row.mesa_id),
        mesa_numero: row.mesa_numero == null ? null : String(row.mesa_numero),
        numero_comanda: row.numero_comanda == null ? null : Number(row.numero_comanda),
        garcom_id: row.garcom_id == null ? null : Number(row.garcom_id),
        garcom_nome: row.garcom_nome || null,
        ultima_retirada_em: ultimaRetiradaPorGrupo.get(chave) || null,
        status_retirada: null,
        itens: []
      };
      porPedido.set(chave, pedido);
    }
    const historico = porItem.get(Number(row.item_id));
    const solicitado = Number(row.qty_solicitada_millis) || 0;
    const cancelado = Math.max(0, Number(row.cancelado_liquido_millis) || 0);
    const exigivel = Math.max(0, solicitado - cancelado);
    const retirado = Number(row.retirado_liquido_millis) || 0;
    const quantidadeRetirada = Math.max(0, retirado);
    const estadoRetirada = quantidadeRetirada >= exigivel && exigivel > 0
      ? 'INTEGRALMENTE_RETIRADO'
      : quantidadeRetirada > 0 ? 'RETIRADA_PARCIAL'
        : cancelado > 0 ? 'CANCELADO' : 'PENDENTE';
    pedido.itens.push({
      item_id: Number(row.item_id),
      pedido_item_id: Number(row.pedido_item_id),
      rodada_id: Number(row.rodada_id),
      numero_rodada: Number(row.numero_rodada),
      produto_id: row.produto_id == null ? null : Number(row.produto_id),
      produto_nome: row.produto_nome,
      categoria_id: row.categoria_id == null ? null : Number(row.categoria_id),
      categoria_nome: row.categoria_nome || null,
      tipo_item: row.tipo_item,
      quantidade_solicitada: milessimos(solicitado),
      quantidade_preparada: milessimos(row.qty_preparada_millis),
      quantidade_cancelada: milessimos(cancelado),
      quantidade_retirada_liquida: milessimos(quantidadeRetirada),
      quantidade_exigivel: milessimos(exigivel),
      status_retirada: estadoRetirada,
      preparo_iniciado_em: row.preparo_iniciado_em
        || (historico.eventos_preparacao.find(evento => evento.tipo === 'PREPARACAO_INICIADA') || {}).em
        || null,
      pronto_em: row.pronto_em
        || historico.eventos_preparacao.filter(evento => evento.tipo === 'ITEM_PRONTO').slice(-1)[0]?.em
        || null,
      eventos_preparacao: historico.eventos_preparacao,
      entregas_bebida: historico.entregas_bebida,
      eventos_retirada: historico.retiradas,
      eventos_cancelamento: historico.cancelamentos
    });
  }

  for (const pedido of porPedido.values()) {
    const exigiveis = pedido.itens.filter(item => Number(item.quantidade_exigivel) > 0);
    const completo = exigiveis.length > 0
      && exigiveis.every(item => Number(item.quantidade_retirada_liquida) >= Number(item.quantidade_exigivel));
    const houveRetirada = pedido.itens.some(item => Number(item.quantidade_retirada_liquida) > 0);
    pedido.status_retirada = String(pedido.pedido_status).toUpperCase() === 'CANCELADO' && houveRetirada
      ? 'CANCELADO_COM_HISTORICO_DE_RETIRADA'
      : completo ? 'INTEGRALMENTE_RETIRADO' : 'RETIRADA_PARCIAL';
  }
  return [...porPedido.values()];
}

module.exports = { listarHistoricoPedidosRetirados };
