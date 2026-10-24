/**
 * PedidoRepository — persistência do agregado Pedido (Sprint 3.1).
 */

'use strict';

const dbPadrao = require('../../database');
const { garantirSchemaPedidoPersonalizacaoAsync } = require('../produtos/personalizacaoIngredientesSchema');

function conn(dbInjected) {
  return dbInjected || dbPadrao;
}

function run(sql, params = [], dbInjected) {
  const db = conn(dbInjected);
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = [], dbInjected) {
  const db = conn(dbInjected);
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function all(sql, params = [], dbInjected) {
  const db = conn(dbInjected);
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function normalizarClassificacaoOperacional(valor) {
  const tipo = String(valor || '').trim().toUpperCase();
  if (tipo === 'INSUMO') return 'INSUMO';
  return 'COMERCIAL';
}

const CAMPOS_SNAPSHOT_PRECO = [
  'preco_venda_snapshot',
  'preco_pedido_snapshot',
  'preco_sugerido_snapshot',
  'origem_preco_sugerido',
  'preco_base_unitario_snapshot',
  'preco_adicionais_unitario_snapshot'
];

function combinarSnapshotProdutoComItem(snapshotProduto, item) {
  const snapshot = { ...(snapshotProduto || {}) };
  for (const campo of CAMPOS_SNAPSHOT_PRECO) {
    if (Object.prototype.hasOwnProperty.call(item || {}, campo)) {
      snapshot[campo] = item[campo];
    }
  }
  return snapshot;
}

async function obterColunasTabela(tabela, dbInjected) {
  const rows = await all(`PRAGMA table_info(${tabela})`, [], dbInjected);
  return new Set((rows || []).map((r) => String(r.name || '').toLowerCase()));
}

async function carregarSnapshotsProdutos(itens = [], dbInjected) {
  const ids = Array.from(
    new Set((itens || []).map((item) => Number(item.produto_id)).filter((id) => Number.isInteger(id) && id > 0))
  );
  if (!ids.length) return new Map();
  const nomesColunas = await obterColunasTabela('produtos', dbInjected);
  const temCodigo = nomesColunas.has('codigo');
  const temNome = nomesColunas.has('nome');
  const temNomeComercial = nomesColunas.has('nome_comercial');
  const temUnidade = nomesColunas.has('unidade');
  const temTipoOperacional = nomesColunas.has('tipo_operacional');
  const temPrecoVenda = nomesColunas.has('preco_venda');
  const temPrecoPedido = nomesColunas.has('preco_pedido');
  const rows = await all(
    `
      SELECT
        id,
        ${temCodigo ? 'codigo' : 'NULL'} AS codigo,
        ${temNome ? 'nome' : 'NULL'} AS nome,
        ${temNomeComercial ? 'nome_comercial' : 'NULL'} AS nome_comercial,
        ${temUnidade ? 'unidade' : 'NULL'} AS unidade,
        ${temTipoOperacional ? "COALESCE(tipo_operacional, 'COMERCIAL')" : "'COMERCIAL'"} AS tipo_operacional,
        ${temPrecoVenda ? 'preco_venda' : 'NULL'} AS preco_venda,
        ${temPrecoPedido ? 'preco_pedido' : 'NULL'} AS preco_pedido
      FROM produtos
      WHERE id IN (${ids.map(() => '?').join(',')})
    `,
    ids,
    dbInjected
  );
  const porId = new Map();
  for (const row of rows) {
    porId.set(Number(row.id), {
      produto_codigo_snapshot: row.codigo || null,
      produto_nome_snapshot: row.nome || null,
      produto_nome_pedido_snapshot: String(row.nome_comercial || '').trim() || row.nome || null,
      produto_unidade_snapshot: row.unidade || null,
      preco_venda_snapshot: row.preco_venda == null ? null : Number(row.preco_venda),
      preco_pedido_snapshot: row.preco_pedido == null ? null : Number(row.preco_pedido),
      preco_sugerido_snapshot: null,
      origem_preco_sugerido: null,
      classificacao_operacional_snapshot: normalizarClassificacaoOperacional(row.tipo_operacional)
    });
  }
  return porId;
}

function montarInsertPedidoItem({ pedidoId, item, snapshot, colunasPedidoItens }) {
  const colunas = [
    'pedido_id',
    'produto_id',
    'quantidade',
    'preco_unitario',
    'desconto_percentual',
    'subtotal',
    'tipo_venda'
  ];
  const valores = [
    pedidoId,
    item.produto_id,
    item.quantidade,
    item.preco_unitario,
    item.desconto_percentual || 0,
    item.subtotal,
    item.tipo_venda || 'PESO'
  ];

  if (colunasPedidoItens.has('classificacao_operacional_snapshot')) {
    colunas.push('classificacao_operacional_snapshot');
    valores.push(snapshot ? snapshot.classificacao_operacional_snapshot : null);
  }
  if (colunasPedidoItens.has('produto_codigo_snapshot')) {
    colunas.push('produto_codigo_snapshot');
    valores.push(snapshot ? snapshot.produto_codigo_snapshot : null);
  }
  if (colunasPedidoItens.has('produto_nome_snapshot')) {
    colunas.push('produto_nome_snapshot');
    valores.push(snapshot ? snapshot.produto_nome_snapshot : null);
  }
  if (colunasPedidoItens.has('produto_nome_pedido_snapshot')) {
    colunas.push('produto_nome_pedido_snapshot');
    valores.push(snapshot ? snapshot.produto_nome_pedido_snapshot : null);
  }
  if (colunasPedidoItens.has('produto_unidade_snapshot')) {
    colunas.push('produto_unidade_snapshot');
    valores.push(snapshot ? snapshot.produto_unidade_snapshot : null);
  }
  if (colunasPedidoItens.has('personalizacao_ingredientes_snapshot')) {
    colunas.push('personalizacao_ingredientes_snapshot');
    valores.push(Number(item.personalizacao_ingredientes_snapshot) === 1 ? 1 : 0);
  }
  for (const campo of CAMPOS_SNAPSHOT_PRECO) {
    if (colunasPedidoItens.has(campo)) {
      colunas.push(campo);
      valores.push(snapshot && snapshot[campo] != null ? snapshot[campo] : null);
    }
  }

  return {
    sql: `
      INSERT INTO pedidos_itens (${colunas.join(', ')})
      VALUES (${colunas.map(() => '?').join(', ')})
    `,
    valores
  };
}

async function persistirIngredientesPersonalizados(db, pedidoId, pedidoItemId, empresaId, item) {
  for (const componente of item.ingredientes_personalizados || []) {
    await run(
      `INSERT INTO pedido_item_ingredientes (
        pedido_id, pedido_item_id, empresa_id, insumo_id, insumo_nome_snapshot,
        quantidade_snapshot, unidade_snapshot, classificacao_comercial_snapshot,
        selecionado, preco_adicional_snapshot
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        Number(pedidoId),
        Number(pedidoItemId),
        Number(empresaId),
        Number(componente.insumo_id),
        String(componente.insumo_nome_snapshot),
        Number(componente.quantidade_snapshot),
        String(componente.unidade_snapshot),
        String(componente.classificacao_comercial_snapshot),
        Number(componente.selecionado) === 1 ? 1 : 0,
        Number(componente.preco_adicional_snapshot || 0)
      ],
      db
    );
  }
}

async function listarAguardandoFaturamento(filtros = {}) {
  const db = filtros.db;
  const empresaId = filtros.empresaId != null ? Number(filtros.empresaId) : null;
  const where = [`p.status IN ('AGUARDANDO_FATURAMENTO')`];
  const params = [];
  if (Number.isInteger(empresaId) && empresaId > 0) {
    where.push('p.empresa_id = ?');
    params.push(empresaId);
  } else {
    where.push('1 = 0');
  }
  return all(`
    SELECT
      p.id,
      p.codigo,
      p.data_pedido,
      p.cliente_id,
      c.nome AS cliente_nome,
      p.total,
      p.desconto,
      p.status,
      p.representante_id,
      p.representante_nome,
      p.venda_id,
      p.observacao,
      p.created_at,
      p.operador_id,
      p.empresa_id,
      u.username AS usuario_nome
    FROM pedidos p
    LEFT JOIN clientes c ON c.id = p.cliente_id
    LEFT JOIN usuarios u ON u.id = p.operador_id
    WHERE ${where.join(' AND ')}
    ORDER BY p.data_pedido DESC, p.id DESC
  `, params, db);
}

async function listarPedidos(filtros = {}) {
  const db = filtros.db;
  const colunasPedidos = await obterColunasTabela('pedidos', db);
  const temMesa = colunasPedidos.has('mesa_id') && (await obterColunasTabela('mesas', db)).size > 0;
  const temOrigem = colunasPedidos.has('origem_canal');
  const where = ['1=1'];
  const params = [];
  const empresaId = filtros.empresaId != null ? Number(filtros.empresaId) : null;
  if (Number.isInteger(empresaId) && empresaId > 0) {
    where.push('p.empresa_id = ?');
    params.push(empresaId);
  } else {
    where.push('1 = 0');
  }

  const statusLista = [];
  if (Array.isArray(filtros.statusIn) && filtros.statusIn.length) {
    statusLista.push(...filtros.statusIn.map((s) => String(s).toUpperCase()));
  } else if (filtros.status) {
    String(filtros.status)
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
      .forEach((s) => statusLista.push(s));
  }
  if (statusLista.length === 1) {
    where.push('p.status = ?');
    params.push(statusLista[0]);
  } else if (statusLista.length > 1) {
    where.push(`p.status IN (${statusLista.map(() => '?').join(',')})`);
    params.push(...statusLista);
  }
  if (filtros.cliente) {
    where.push('(IFNULL(c.nome, "") LIKE ? OR CAST(IFNULL(p.cliente_id, 0) AS TEXT) = ?)');
    const q = `%${String(filtros.cliente).trim()}%`;
    params.push(q, String(filtros.cliente).trim());
  }
  if (filtros.representante) {
    where.push('IFNULL(p.representante_nome, "") LIKE ?');
    params.push(`%${String(filtros.representante).trim()}%`);
  }
  if (filtros.dataInicio) {
    where.push('date(p.data_pedido) >= date(?)');
    params.push(filtros.dataInicio);
  }
  if (filtros.dataFim) {
    where.push('date(p.data_pedido) <= date(?)');
    params.push(filtros.dataFim);
  }
  if (filtros.busca) {
    const q = `%${String(filtros.busca).trim()}%`;
    where.push('(IFNULL(p.codigo, "") LIKE ? OR IFNULL(c.nome, "") LIKE ? OR CAST(p.id AS TEXT) LIKE ?)');
    params.push(q, q, q);
  }

  const limite = Math.min(Math.max(Number(filtros.limite) || 200, 1), 500);

  return all(`
    SELECT
      p.id,
      p.codigo,
      p.data_pedido,
      p.cliente_id,
      c.nome AS cliente_nome,
      p.total,
      p.desconto,
      p.frete,
      p.status,
      p.representante_id,
      p.representante_nome,
      p.venda_id,
      p.observacao,
      p.created_at,
      p.updated_at,
      p.operador_id,
      p.empresa_id,
      ${temMesa ? 'p.mesa_id' : 'NULL'} AS mesa_id,
      ${temMesa ? 'm.numero' : 'NULL'} AS mesa_numero,
      ${temOrigem ? 'p.origem_canal' : 'NULL'} AS origem_canal,
      COALESCE(u.username, u.nome) AS usuario_nome
    FROM pedidos p
    LEFT JOIN clientes c ON c.id = p.cliente_id
    ${temMesa ? 'LEFT JOIN mesas m ON m.id = p.mesa_id AND m.empresa_id = p.empresa_id' : ''}
    LEFT JOIN usuarios u ON u.id = p.operador_id
    WHERE ${where.join(' AND ')}
    ORDER BY p.id DESC
    LIMIT ?
  `, [...params, limite], db);
}

async function obterPorId(pedidoId, opts = {}) {
  const db = opts.db;
  await garantirSchemaPedidoPersonalizacaoAsync(conn(db));
  const colunasPedidoItens = await obterColunasTabela('pedidos_itens', db);
  const temClassificacaoSnapshot = colunasPedidoItens.has('classificacao_operacional_snapshot');
  const temCodigoSnapshot = colunasPedidoItens.has('produto_codigo_snapshot');
  const temNomeSnapshot = colunasPedidoItens.has('produto_nome_snapshot');
  const temNomePedidoSnapshot = colunasPedidoItens.has('produto_nome_pedido_snapshot');
  const temUnidadeSnapshot = colunasPedidoItens.has('produto_unidade_snapshot');
  const nomesPedido = [];
  if (temNomePedidoSnapshot) nomesPedido.push("NULLIF(i.produto_nome_pedido_snapshot, '')");
  if (temNomeSnapshot) nomesPedido.push("NULLIF(i.produto_nome_snapshot, '')");
  nomesPedido.push('pr.nome');
  const nomePedidoSql = nomesPedido.length > 1
    ? `COALESCE(${nomesPedido.join(', ')})`
    : nomesPedido[0];
  const nomeFiscalSql = temNomeSnapshot
    ? "COALESCE(NULLIF(i.produto_nome_snapshot, ''), pr.nome)"
    : 'pr.nome';
  const colunasPedidos = await obterColunasTabela('pedidos', db);
  const temMesa = colunasPedidos.has('mesa_id') && (await obterColunasTabela('mesas', db)).size > 0;
  const pedido = await get(`
    SELECT
      p.*,
      c.nome AS cliente_nome,
      ${temMesa ? 'm.numero' : 'NULL'} AS mesa_numero,
      COALESCE(u.username, u.nome) AS usuario_nome
    FROM pedidos p
    LEFT JOIN clientes c ON c.id = p.cliente_id
    ${temMesa ? 'LEFT JOIN mesas m ON m.id = p.mesa_id AND m.empresa_id = p.empresa_id' : ''}
    LEFT JOIN usuarios u ON u.id = p.operador_id
    WHERE p.id = ?
  `, [pedidoId], db);
  if (!pedido) return null;
  const itens = await all(`
    SELECT
      i.*,
      ${nomePedidoSql} AS produto_nome,
      ${nomeFiscalSql} AS produto_nome_fiscal,
      pr.codigo AS produto_codigo,
      pr.unidade AS produto_unidade,
      ${temClassificacaoSnapshot ? 'i.classificacao_operacional_snapshot' : 'NULL'} AS classificacao_operacional_snapshot,
      ${temCodigoSnapshot ? 'i.produto_codigo_snapshot' : 'NULL'} AS produto_codigo_snapshot,
      ${temNomeSnapshot ? 'i.produto_nome_snapshot' : 'NULL'} AS produto_nome_snapshot,
      ${temUnidadeSnapshot ? 'i.produto_unidade_snapshot' : 'NULL'} AS produto_unidade_snapshot,
      COALESCE(
        ${temClassificacaoSnapshot ? 'i.classificacao_operacional_snapshot' : 'NULL'},
        UPPER(COALESCE(pr.tipo_operacional, 'COMERCIAL')),
        'COMERCIAL'
      ) AS classificacao_operacional,
      CASE
        WHEN ${temClassificacaoSnapshot ? 'i.classificacao_operacional_snapshot IS NOT NULL' : '0'} THEN 'SNAPSHOT_PEDIDO'
        ELSE 'CATALOGO_ATUAL_LEGADO'
      END AS classificacao_operacional_origem
    FROM pedidos_itens i
    LEFT JOIN produtos pr ON pr.id = i.produto_id
    WHERE i.pedido_id = ?
    ORDER BY i.id ASC
  `, [pedidoId], db);
  if (itens.length) {
    const ids = itens.map((item) => Number(item.id));
    const componentes = await all(
      `SELECT pedido_item_id, insumo_id, insumo_nome_snapshot, quantidade_snapshot,
              unidade_snapshot, classificacao_comercial_snapshot, selecionado,
              preco_adicional_snapshot
         FROM pedido_item_ingredientes
        WHERE pedido_item_id IN (${ids.map(() => '?').join(',')})
        ORDER BY id`,
      ids,
      db
    );
    const porItem = new Map();
    for (const componente of componentes) {
      const chave = Number(componente.pedido_item_id);
      const lista = porItem.get(chave) || [];
      lista.push(componente);
      porItem.set(chave, lista);
    }
    for (const item of itens) {
      item.ingredientes_personalizados = porItem.get(Number(item.id)) || [];
    }
  }
  return { ...pedido, itens };
}

async function criarPedido({
  codigo,
  dataPedido,
  clienteId,
  total,
  desconto,
  frete,
  status,
  representanteId,
  representanteNome,
  observacao,
  operadorId,
  empresaId,
  itens,
  mesaId,
  origemCanal,
  db,
  jaEmTransacao = false
}) {
  await garantirSchemaPedidoPersonalizacaoAsync(conn(db));
  const snapshots = await carregarSnapshotsProdutos(itens, db);
  const colunasPedidoItens = await obterColunasTabela('pedidos_itens', db);
  const colunasPedidosCriar = await obterColunasTabela('pedidos', db);
  if (mesaId != null && !colunasPedidosCriar.has('mesa_id')) {
    throw new Error('Schema de pedidos sem mesa_id: migração de mesas pendente.');
  }
  if (origemCanal != null && !colunasPedidosCriar.has('origem_canal')) {
    throw new Error('Schema de pedidos sem origem_canal: migração de origem pendente.');
  }
  if (!jaEmTransacao) await run('BEGIN IMMEDIATE', [], db);
  try {
    const ins = await run(`
      INSERT INTO pedidos (
        codigo, data_pedido, cliente_id, total, desconto, frete, status,
        representante_id, representante_nome, observacao, operador_id, empresa_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      codigo,
      dataPedido,
      clienteId || null,
      Number(total || 0),
      Number(desconto || 0),
      Number(frete || 0),
      status,
      representanteId || null,
      representanteNome || null,
      observacao || null,
      operadorId || null,
      empresaId != null ? Number(empresaId) : null
    ], db);
    const pedidoId = ins.lastID;
    if (mesaId != null) {
      await run('UPDATE pedidos SET mesa_id = ? WHERE id = ? AND empresa_id = ?', [Number(mesaId), pedidoId, Number(empresaId)], db);
    }
    if (origemCanal != null) {
      await run('UPDATE pedidos SET origem_canal = ? WHERE id = ?', [String(origemCanal), pedidoId], db);
    }
    for (const item of itens) {
      const snapshot = combinarSnapshotProdutoComItem(
        snapshots.get(Number(item.produto_id)),
        item
      );
      const insert = montarInsertPedidoItem({
        pedidoId,
        item,
        snapshot,
        colunasPedidoItens
      });
      const itemInserido = await run(insert.sql, insert.valores, db);
      await persistirIngredientesPersonalizados(db, pedidoId, itemInserido.lastID, empresaId, item);
    }
    if (!jaEmTransacao) await run('COMMIT', [], db);
    return pedidoId;
  } catch (err) {
    if (!jaEmTransacao) {
      try { await run('ROLLBACK', [], db); } catch (_) { /* ignore */ }
    }
    throw err;
  }
}

async function substituirPedido({
  pedidoId,
  clienteId,
  total,
  desconto,
  frete,
  representanteId,
  representanteNome,
  observacao,
  itens,
  empresaId,
  mesaId,
  db
}) {
  await garantirSchemaPedidoPersonalizacaoAsync(conn(db));
  const snapshots = await carregarSnapshotsProdutos(itens, db);
  const colunasPedidoItens = await obterColunasTabela('pedidos_itens', db);
  if (mesaId !== undefined && !(await obterColunasTabela('pedidos', db)).has('mesa_id')) {
    throw new Error('Schema de pedidos sem mesa_id: migração de mesas pendente.');
  }
  await run('BEGIN IMMEDIATE', [], db);
  try {
    const colunasSnapshot = [
      'id',
      'produto_id',
      ...[
        'classificacao_operacional_snapshot',
        'produto_codigo_snapshot',
        'produto_nome_snapshot',
        'produto_nome_pedido_snapshot',
        'produto_unidade_snapshot',
        'personalizacao_ingredientes_snapshot',
        ...CAMPOS_SNAPSHOT_PRECO
      ].filter((coluna) => colunasPedidoItens.has(coluna))
    ];
    const itensAnteriores = await all(
      `SELECT ${colunasSnapshot.join(', ')} FROM pedidos_itens WHERE pedido_id = ? ORDER BY id`,
      [pedidoId],
      db
    );
    const anterioresPorId = new Map(itensAnteriores.map((item) => [Number(item.id), item]));
    const anterioresPorProduto = new Map();
    for (const item of itensAnteriores) {
      const produtoId = Number(item.produto_id);
      const lista = anterioresPorProduto.get(produtoId) || [];
      lista.push(item);
      anterioresPorProduto.set(produtoId, lista);
    }
    const params = [
      clienteId || null,
      Number(total || 0),
      Number(desconto || 0),
      Number(frete || 0),
      representanteId || null,
      representanteNome || null,
      observacao || null,
      pedidoId
    ];
    let sql = `
      UPDATE pedidos SET
        cliente_id = ?,
        total = ?,
        desconto = ?,
        frete = ?,
        representante_id = ?,
        representante_nome = ?,
        observacao = ?,
        updated_at = DATETIME('now', 'localtime')
      WHERE id = ?
        AND status IN ('ORCAMENTO', 'PEDIDO', 'ABERTO', 'EM_SEPARACAO', 'AGUARDANDO_FATURAMENTO')
    `;
    const emp = empresaId != null ? Number(empresaId) : null;
    if (Number.isInteger(emp) && emp > 0) {
      sql += ' AND empresa_id = ?';
      params.push(emp);
    }
    const upd = await run(sql, params, db);
    if (!upd.changes) {
      const err = new Error('Pedido não pode ser editado neste status.');
      err.statusCode = 400;
      throw err;
    }
    await run('DELETE FROM pedido_item_ingredientes WHERE pedido_id = ?', [pedidoId], db);
    await run('DELETE FROM pedidos_itens WHERE pedido_id = ?', [pedidoId], db);
    if (mesaId !== undefined) {
      await run(
        'UPDATE pedidos SET mesa_id = ? WHERE id = ? AND empresa_id = ?',
        [mesaId == null ? null : Number(mesaId), pedidoId, emp],
        db
      );
    }
    for (const item of itens) {
      const produtoId = Number(item.produto_id);
      const anteriorPorId = item.id != null ? anterioresPorId.get(Number(item.id)) : null;
      const anterior = anteriorPorId && Number(anteriorPorId.produto_id) === produtoId
        ? anteriorPorId
        : (!item.id && anterioresPorProduto.get(produtoId)?.length === 1
          ? anterioresPorProduto.get(produtoId)[0]
          : null);
      const snapshotAtual = snapshots.get(produtoId) || null;
      const snapshot = anterior
        ? {
          classificacao_operacional_snapshot: anterior.classificacao_operacional_snapshot
            || snapshotAtual?.classificacao_operacional_snapshot
            || null,
          produto_codigo_snapshot: anterior.produto_codigo_snapshot
            || snapshotAtual?.produto_codigo_snapshot
            || null,
          produto_nome_snapshot: anterior.produto_nome_snapshot
            || snapshotAtual?.produto_nome_snapshot
            || null,
          produto_nome_pedido_snapshot: anterior.produto_nome_pedido_snapshot
            || anterior.produto_nome_snapshot
            || snapshotAtual?.produto_nome_pedido_snapshot
            || null,
          produto_unidade_snapshot: anterior.produto_unidade_snapshot
            || snapshotAtual?.produto_unidade_snapshot
            || null,
          preco_venda_snapshot: anterior.preco_venda_snapshot ?? null,
          preco_pedido_snapshot: anterior.preco_pedido_snapshot ?? null,
          preco_sugerido_snapshot: anterior.preco_sugerido_snapshot ?? null,
          origem_preco_sugerido: anterior.origem_preco_sugerido ?? null,
          personalizacao_ingredientes_snapshot: Number(item.personalizacao_ingredientes_snapshot) === 1 ? 1 : 0,
          preco_base_unitario_snapshot: item.preco_base_unitario_snapshot ?? null,
          preco_adicionais_unitario_snapshot: item.preco_adicionais_unitario_snapshot ?? null
        }
        : combinarSnapshotProdutoComItem(snapshotAtual, item);
      const insert = montarInsertPedidoItem({
        pedidoId,
        item,
        snapshot,
        colunasPedidoItens
      });
      const itemInserido = await run(insert.sql, insert.valores, db);
      await persistirIngredientesPersonalizados(db, pedidoId, itemInserido.lastID, emp, item);
    }
    await run('COMMIT', [], db);
    return true;
  } catch (err) {
    try { await run('ROLLBACK', [], db); } catch (_) { /* ignore */ }
    throw err;
  }
}

async function atualizarStatus(pedidoId, status, statusPermitidos = null, opts = {}) {
  const db = opts.db;
  const params = [status, pedidoId];
  let sql = `
    UPDATE pedidos
    SET status = ?,
        updated_at = DATETIME('now', 'localtime')
    WHERE id = ?
  `;
  if (Array.isArray(statusPermitidos) && statusPermitidos.length) {
    sql += ` AND status IN (${statusPermitidos.map(() => '?').join(',')})`;
    params.push(...statusPermitidos);
  }
  const emp = opts.empresaId != null ? Number(opts.empresaId) : null;
  if (Number.isInteger(emp) && emp > 0) {
    sql += ' AND empresa_id = ?';
    params.push(emp);
  }
  const result = await run(sql, params, db);
  return result.changes > 0;
}

/** Exclusão física — somente Orçamento (Sprint 3.14). */
async function excluirOrcamento(pedidoId, opts = {}) {
  const db = opts.db;
  const emp = opts.empresaId != null ? Number(opts.empresaId) : null;
  await run('BEGIN IMMEDIATE', [], db);
  try {
    const row = await get('SELECT id, status, empresa_id FROM pedidos WHERE id = ?', [pedidoId], db);
    if (!row) {
      const err = new Error('Pedido não encontrado.');
      err.statusCode = 404;
      throw err;
    }
    if (row.status !== 'ORCAMENTO') {
      const err = new Error('Somente orçamentos podem ser excluídos. Use cancelar para pedidos.');
      err.statusCode = 400;
      throw err;
    }
    if (Number.isInteger(emp) && emp > 0 && Number(row.empresa_id) !== emp) {
      const err = new Error('Pedido não encontrado.');
      err.statusCode = 404;
      err.code = 'PEDIDO_NAO_ENCONTRADO';
      throw err;
    }
    await run('DELETE FROM pedidos_itens WHERE pedido_id = ?', [pedidoId], db);
    const delParams = [pedidoId];
    let delSql = `DELETE FROM pedidos WHERE id = ? AND status = 'ORCAMENTO'`;
    if (Number.isInteger(emp) && emp > 0) {
      delSql += ' AND empresa_id = ?';
      delParams.push(emp);
    }
    const del = await run(delSql, delParams, db);
    if (!del.changes) {
      const err = new Error('Não foi possível excluir o orçamento.');
      err.statusCode = 400;
      throw err;
    }
    await run('COMMIT', [], db);
    return true;
  } catch (err) {
    try { await run('ROLLBACK', [], db); } catch (_) { /* ignore */ }
    throw err;
  }
}

async function marcarFaturado(pedidoId, vendaId, operadorId, opts = {}) {
  const db = opts.db;
  const params = [vendaId, operadorId || null, pedidoId];
  let sql = `
    UPDATE pedidos
    SET status = 'FATURADO',
        venda_id = ?,
        faturado_em = DATETIME('now', 'localtime'),
        faturado_por = ?,
        updated_at = DATETIME('now', 'localtime')
    WHERE id = ?
      AND status IN ('ABERTO', 'AGUARDANDO_FATURAMENTO', 'FATURADO')
      AND (venda_id IS NULL OR venda_id = ?)
  `;
  params.push(vendaId);
  const emp = opts.empresaId != null ? Number(opts.empresaId) : null;
  if (Number.isInteger(emp) && emp > 0) {
    sql += ' AND empresa_id = ?';
    params.push(emp);
  }
  const result = await run(sql, params, db);
  return result.changes > 0;
}

async function atualizarDadosFiscais(pedidoId, dados = {}) {
  return run(`
    UPDATE pedidos SET
      natureza_operacao = ?,
      cfop = ?,
      frete = ?,
      acrescimo = ?,
      transportadora = ?,
      volumes = ?,
      peso = ?,
      dados_adicionais = ?,
      observacao = COALESCE(?, observacao),
      updated_at = DATETIME('now', 'localtime')
    WHERE id = ?
  `, [
    dados.natureza_operacao || 'VENDA DE MERCADORIA',
    dados.cfop || '5102',
    Number(dados.frete || 0),
    Number(dados.acrescimo || 0),
    dados.transportadora || null,
    Number(dados.volumes || 0),
    Number(dados.peso || 0),
    dados.dados_adicionais || null,
    dados.observacoes || null,
    pedidoId
  ]);
}

module.exports = {
  listarAguardandoFaturamento,
  listarPedidos,
  obterPorId,
  criarPedido,
  substituirPedido,
  atualizarStatus,
  excluirOrcamento,
  marcarFaturado,
  atualizarDadosFiscais
};
