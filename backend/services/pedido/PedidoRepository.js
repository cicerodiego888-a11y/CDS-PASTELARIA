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

function criarErroPedidoImutavel(pedido, estado = {}) {
  const status = String(pedido?.status || '').toUpperCase();
  const mensagem = status === 'CANCELADO'
    ? 'Pedido cancelado não pode ser editado.'
    : estado.cozinha_despachada
      ? 'Pedido enviado à cozinha não pode ter sua composição comercial alterada.'
    : estado.venda_vinculada
      ? 'Pedido com venda vinculada não pode ser editado.'
      : 'Este pedido já foi finalizado e faturado. A edição está bloqueada.';
  const err = new Error(mensagem);
  err.statusCode = 409;
  err.codigo = 'PEDIDO_IMUTAVEL';
  err.detalhes = {
    pedido_id: Number(pedido?.id),
    status: pedido?.status || null,
    venda_id: pedido?.venda_id ?? null,
    cozinha_despachada: Boolean(estado.cozinha_despachada)
  };
  return err;
}

async function obterEstadoEdicao(pedido, opts = {}) {
  const db = opts.db;
  const status = String(pedido?.status || '').toUpperCase();
  let vendaVinculada = pedido?.venda_id != null;
  let finalizacaoConfirmada = status === 'FATURADO';
  let cozinhaDespachada = false;
  const pedidoId = Number(pedido?.id);
  const empresaId = Number(pedido?.empresa_id);

  if (Number.isInteger(pedidoId) && pedidoId > 0) {
    const colunasFinalizacoes = await obterColunasTabela(
      'pedido_estoque_consumo_finalizacoes',
      db
    );
    if (colunasFinalizacoes.has('pedido_id')) {
      const filtroEmpresa = colunasFinalizacoes.has('empresa_id')
        && Number.isInteger(empresaId) && empresaId > 0
        ? ' AND empresa_id = ?'
        : '';
      const params = [pedidoId];
      if (filtroEmpresa) params.push(empresaId);
      finalizacaoConfirmada = finalizacaoConfirmada || Boolean(await get(
        `SELECT 1 AS existe
           FROM pedido_estoque_consumo_finalizacoes
          WHERE pedido_id = ?${filtroEmpresa}
          LIMIT 1`,
        params,
        db
      ));
    }

    const colunasOperacoes = await obterColunasTabela('pedido_faturamento_operacoes', db);
    if (colunasOperacoes.has('pedido_id')) {
      const filtroEmpresa = colunasOperacoes.has('empresa_id')
        && Number.isInteger(empresaId) && empresaId > 0
        ? ' AND empresa_id = ?'
        : '';
      const camposOperacao = [
        colunasOperacoes.has('status') ? 'status' : null,
        colunasOperacoes.has('venda_id') ? 'venda_id' : null
      ].filter(Boolean);
      if (camposOperacao.length) {
        const params = [pedidoId];
        if (filtroEmpresa) params.push(empresaId);
        const operacao = await get(
          `SELECT ${camposOperacao.join(', ')}
             FROM pedido_faturamento_operacoes
            WHERE pedido_id = ?${filtroEmpresa}
            LIMIT 1`,
          params,
          db
        );
        if (operacao) {
          finalizacaoConfirmada = finalizacaoConfirmada
            || String(operacao.status || '').toUpperCase() === 'FINALIZADA';
          vendaVinculada = vendaVinculada || operacao.venda_id != null;
        }
      }
    }

    const colunasVendas = await obterColunasTabela('vendas', db);
    if (colunasVendas.has('pedido_id')) {
      const filtroEmpresa = colunasVendas.has('empresa_id')
        && Number.isInteger(empresaId) && empresaId > 0
        ? ' AND empresa_id = ?'
        : '';
      const params = [pedidoId];
      if (filtroEmpresa) params.push(empresaId);
      vendaVinculada = vendaVinculada || Boolean(await get(
        `SELECT 1 AS existe
           FROM vendas
          WHERE pedido_id = ?${filtroEmpresa}
          LIMIT 1`,
        params,
        db
      ));
    }

    const colunasCozinhaItens = await obterColunasTabela('cozinha_itens', db);
    if (colunasCozinhaItens.has('pedido_id')) {
      const params = [pedidoId];
      let filtroEmpresa = '';
      if (colunasCozinhaItens.has('empresa_id') && Number.isInteger(empresaId) && empresaId > 0) {
        filtroEmpresa = ' AND empresa_id = ?';
        params.push(empresaId);
      }
      cozinhaDespachada = Boolean(await get(
        `SELECT 1 AS existe
           FROM cozinha_itens
          WHERE pedido_id = ?${filtroEmpresa}
          LIMIT 1`,
        params,
        db
      ));
    }
  }

  const statusEncerrado = ['FATURADO', 'CANCELADO'].includes(status);
  return {
    edicao_bloqueada: statusEncerrado || finalizacaoConfirmada || vendaVinculada || cozinhaDespachada,
    finalizacao_confirmada: finalizacaoConfirmada,
    somente_consulta: statusEncerrado || finalizacaoConfirmada || vendaVinculada || cozinhaDespachada,
    venda_vinculada: vendaVinculada,
    cozinha_despachada: cozinhaDespachada
  };
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

function montarInsertPedidoItem({ pedidoId, empresaId, item, snapshot, colunasPedidoItens }) {
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

  if (colunasPedidoItens.has('empresa_id')) {
    const empresa = Number(empresaId);
    if (!Number.isInteger(empresa) || empresa <= 0) {
      const err = new Error('Empresa do pedido é obrigatória para gravar seus itens.');
      err.statusCode = 400;
      err.codigo = 'EMPRESA_CONTEXT_REQUIRED';
      throw err;
    }
    colunas.push('empresa_id');
    valores.push(empresa);
  }

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
    colunas,
    valores
  };
}

function montarUpdatePedidoItem({ pedidoId, empresaId, item, snapshot, colunasPedidoItens }) {
  const dados = montarInsertPedidoItem({ pedidoId, empresaId, item, snapshot, colunasPedidoItens });
  const atualizaveis = dados.colunas.filter((coluna) => coluna !== 'pedido_id');
  const indices = atualizaveis.map((coluna) => dados.colunas.indexOf(coluna));
  return {
    sql: `UPDATE pedidos_itens
             SET ${atualizaveis.map((coluna) => `${coluna} = ?`).join(', ')}
           WHERE id = ? AND pedido_id = ?`,
    valores: [
      ...indices.map((index) => dados.valores[index]),
      Number(item.id),
      Number(pedidoId)
    ]
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
  const colunasPedidos = await obterColunasTabela('pedidos', db);
  const temClienteNomeLivre = colunasPedidos.has('cliente_nome');
  const clienteNomeSelect = temClienteNomeLivre
    ? "COALESCE(NULLIF(TRIM(p.cliente_nome), ''), c.nome)"
    : 'c.nome';
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
      ${clienteNomeSelect} AS cliente_nome,
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
  const temClienteNomeLivre = colunasPedidos.has('cliente_nome');
  const clienteNomeSelect = temClienteNomeLivre
    ? "COALESCE(NULLIF(TRIM(p.cliente_nome), ''), c.nome)"
    : 'c.nome';
  const colunasOperacaoPdv = await obterColunasTabela('pedido_faturamento_operacoes', db);
  const temOperacaoPdv = [
    'pedido_id',
    'status',
    'tipo_operacao',
    'venda_id'
  ].every((coluna) => colunasOperacaoPdv.has(coluna));
  const operacaoPdvSelect = temOperacaoPdv
    ? 'op.id AS venda_pdv_operacao_id, op.status AS venda_pdv_status, op.venda_id AS venda_pdv_id'
    : 'NULL AS venda_pdv_operacao_id, NULL AS venda_pdv_status, NULL AS venda_pdv_id';
  const operacaoPdvJoin = temOperacaoPdv
    ? "LEFT JOIN pedido_faturamento_operacoes op ON op.pedido_id = p.id AND op.tipo_operacao = 'PDV_COMPOSICAO'"
    : '';
  const colunasFinalizacoes = await obterColunasTabela('pedido_estoque_consumo_finalizacoes', db);
  const finalizacaoConsumoSql = colunasFinalizacoes.has('pedido_id')
    ? `EXISTS (
        SELECT 1 FROM pedido_estoque_consumo_finalizacoes f
         WHERE f.pedido_id = p.id
         ${colunasFinalizacoes.has('empresa_id') ? 'AND f.empresa_id = p.empresa_id' : ''}
      )`
    : null;
  const colunasOperacoes = await obterColunasTabela('pedido_faturamento_operacoes', db);
  const predicadoEmpresaOperacao = colunasOperacoes.has('empresa_id')
    ? 'AND opf.empresa_id = p.empresa_id'
    : '';
  const operacaoFinalizadaSql = colunasOperacoes.has('pedido_id') && colunasOperacoes.has('status')
    ? `EXISTS (
        SELECT 1 FROM pedido_faturamento_operacoes opf
         WHERE opf.pedido_id = p.id ${predicadoEmpresaOperacao}
           AND UPPER(opf.status) = 'FINALIZADA'
      )`
    : null;
  const operacaoComVendaSql = colunasOperacoes.has('pedido_id') && colunasOperacoes.has('venda_id')
    ? `EXISTS (
        SELECT 1 FROM pedido_faturamento_operacoes opv
         WHERE opv.pedido_id = p.id
           ${colunasOperacoes.has('empresa_id') ? 'AND opv.empresa_id = p.empresa_id' : ''}
           AND opv.venda_id IS NOT NULL
      )`
    : null;
  const colunasVendas = await obterColunasTabela('vendas', db);
  const vendaPedidoSql = colunasVendas.has('pedido_id')
    ? `EXISTS (
        SELECT 1 FROM vendas vped
         WHERE vped.pedido_id = p.id
           ${colunasVendas.has('empresa_id') ? 'AND vped.empresa_id = p.empresa_id' : ''}
      )`
    : null;
  const finalizacoesConfirmadas = [
    "UPPER(COALESCE(p.status, '')) = 'FATURADO'",
    finalizacaoConsumoSql,
    operacaoFinalizadaSql
  ].filter(Boolean);
  const vendasVinculadas = [
    'p.venda_id IS NOT NULL',
    operacaoComVendaSql,
    vendaPedidoSql
  ].filter(Boolean);
  const statusEncerradoSql = "UPPER(COALESCE(p.status, '')) IN ('FATURADO', 'CANCELADO')";
  const edicaoBloqueadaSql = [
    statusEncerradoSql,
    ...finalizacoesConfirmadas,
    ...vendasVinculadas
  ].join(' OR ');
  const somenteConsultaSql = [
    statusEncerradoSql,
    ...finalizacoesConfirmadas
  ].join(' OR ');
  const where = ['1=1'];
  const params = [];
  const empresaId = filtros.empresaId != null ? Number(filtros.empresaId) : null;
  if (Number.isInteger(empresaId) && empresaId > 0) {
    where.push('p.empresa_id = ?');
    params.push(empresaId);
  } else {
    where.push('1 = 0');
  }
  const filtroMesaInformado = filtros.mesaId != null || filtros.mesaAtendimentoId != null;
  if (filtroMesaInformado) {
    const mesaId = Number(filtros.mesaId);
    const atendimentoId = Number(filtros.mesaAtendimentoId);
    if (
      !Number.isInteger(mesaId) || mesaId <= 0
      || !Number.isInteger(atendimentoId) || atendimentoId <= 0
      || !temMesa
      || !colunasPedidos.has('mesa_atendimento_id')
    ) {
      const err = new Error('Filtro de mesa e atendimento inválido para consultar pedidos.');
      err.statusCode = 400;
      err.codigo = 'FILTRO_MESA_INVALIDO';
      throw err;
    }
    where.push('p.mesa_id = ?');
    params.push(mesaId);
    where.push('p.mesa_atendimento_id = ?');
    params.push(atendimentoId);
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
    if (temClienteNomeLivre) {
      where.push('(IFNULL(c.nome, "") LIKE ? OR IFNULL(p.cliente_nome, "") LIKE ? OR CAST(IFNULL(p.cliente_id, 0) AS TEXT) = ?)');
      const q = `%${String(filtros.cliente).trim()}%`;
      params.push(q, q, String(filtros.cliente).trim());
    } else {
      where.push('(IFNULL(c.nome, "") LIKE ? OR CAST(IFNULL(p.cliente_id, 0) AS TEXT) = ?)');
      const q = `%${String(filtros.cliente).trim()}%`;
      params.push(q, String(filtros.cliente).trim());
    }
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
  const limiteSql = filtroMesaInformado ? '' : 'LIMIT ?';

  return all(`
    SELECT
      p.id,
      p.codigo,
      p.data_pedido,
      p.cliente_id,
      ${clienteNomeSelect} AS cliente_nome,
      p.total,
      p.desconto,
      p.frete,
      p.status,
      p.representante_id,
      p.representante_nome,
      p.venda_id,
      CASE WHEN (${edicaoBloqueadaSql}) THEN 1 ELSE 0 END AS edicao_bloqueada,
      CASE WHEN (${somenteConsultaSql}) THEN 1 ELSE 0 END AS somente_consulta,
      CASE WHEN (${finalizacoesConfirmadas.join(' OR ')}) THEN 1 ELSE 0 END AS finalizacao_confirmada,
      ${operacaoPdvSelect},
      p.observacao,
      p.created_at,
      p.updated_at,
      p.operador_id,
      p.empresa_id,
      ${temMesa ? 'p.mesa_id' : 'NULL'} AS mesa_id,
      ${temMesa && colunasPedidos.has('mesa_atendimento_id') ? 'p.mesa_atendimento_id' : 'NULL'} AS mesa_atendimento_id,
      ${temMesa ? 'm.numero' : 'NULL'} AS mesa_numero,
      ${temOrigem ? 'p.origem_canal' : 'NULL'} AS origem_canal,
      COALESCE(u.username, u.nome) AS usuario_nome
    FROM pedidos p
    LEFT JOIN clientes c ON c.id = p.cliente_id
    ${temMesa ? 'LEFT JOIN mesas m ON m.id = p.mesa_id AND m.empresa_id = p.empresa_id' : ''}
    LEFT JOIN usuarios u ON u.id = p.operador_id
    ${operacaoPdvJoin}
    WHERE ${where.join(' AND ')}
    ORDER BY p.id DESC
    ${limiteSql}
  `, filtroMesaInformado ? params : [...params, limite], db);
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
  const temClienteNomeLivre = colunasPedidos.has('cliente_nome');
  const pedido = await get(`
    SELECT
      p.*,
      COALESCE(${temClienteNomeLivre ? "NULLIF(TRIM(p.cliente_nome), ''), " : ''}c.nome) AS cliente_nome,
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
  clienteNome,
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
    if (colunasPedidosCriar.has('cliente_nome')) {
      const nomeLivre = clienteNome != null ? String(clienteNome).trim() : '';
      await run(
        'UPDATE pedidos SET cliente_nome = ? WHERE id = ? AND empresa_id = ?',
        [nomeLivre || null, pedidoId, Number(empresaId)],
        db
      );
    }
    for (const item of itens) {
      const snapshot = combinarSnapshotProdutoComItem(
        snapshots.get(Number(item.produto_id)),
        item
      );
      const insert = montarInsertPedidoItem({
        pedidoId,
        empresaId,
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
  clienteNome,
  total,
  desconto,
  frete,
  representanteId,
  representanteNome,
  observacao,
  itens,
  empresaId,
  mesaId,
  db,
  jaEmTransacao = false
}) {
  await garantirSchemaPedidoPersonalizacaoAsync(conn(db));
  const snapshots = await carregarSnapshotsProdutos(itens, db);
  const colunasPedidoItens = await obterColunasTabela('pedidos_itens', db);
  const colunasPedidos = await obterColunasTabela('pedidos', db);
  if (mesaId !== undefined && !colunasPedidos.has('mesa_id')) {
    throw new Error('Schema de pedidos sem mesa_id: migração de mesas pendente.');
  }
  if (!jaEmTransacao) await run('BEGIN IMMEDIATE', [], db);
  try {
    const pedidoAtual = await get(
      `SELECT id, status,
              ${colunasPedidos.has('venda_id') ? 'venda_id' : 'NULL AS venda_id'},
              ${colunasPedidos.has('empresa_id') ? 'empresa_id' : 'NULL AS empresa_id'}
         FROM pedidos WHERE id = ?`,
      [pedidoId],
      db
    );
    if (!pedidoAtual) {
      const err = new Error('Pedido não encontrado.');
      err.statusCode = 404;
      err.codigo = 'PEDIDO_NAO_ENCONTRADO';
      throw err;
    }
    const empresaSolicitada = Number(empresaId);
    const empresaDoPedido = Number(pedidoAtual.empresa_id);
    const empresaPedidoValida = colunasPedidos.has('empresa_id')
      && Number.isInteger(empresaDoPedido) && empresaDoPedido > 0;
    if (colunasPedidos.has('empresa_id') && !empresaPedidoValida) {
      const err = new Error('Pedido sem empresa válida; edição bloqueada para preservar o isolamento.');
      err.statusCode = 409;
      err.codigo = 'EMPRESA_PEDIDO_INVALIDA';
      throw err;
    }
    if (Number.isInteger(empresaSolicitada) && empresaSolicitada > 0
      && empresaPedidoValida && empresaDoPedido !== empresaSolicitada) {
      const err = new Error('Pedido não encontrado.');
      err.statusCode = 404;
      err.codigo = 'PEDIDO_NAO_ENCONTRADO';
      throw err;
    }
    const emp = empresaPedidoValida
      ? empresaDoPedido
      : (Number.isInteger(empresaSolicitada) && empresaSolicitada > 0 ? empresaSolicitada : null);
    const estadoEdicao = await obterEstadoEdicao(pedidoAtual, { db });
    if (estadoEdicao.edicao_bloqueada) {
      throw criarErroPedidoImutavel(pedidoAtual, estadoEdicao);
    }
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
    const idsAnterioresUsados = new Set();
    const associacoes = itens.map((item) => {
      const produtoId = Number(item.produto_id);
      let anterior = null;
      if (item.id != null) {
        const id = Number(item.id);
        anterior = anterioresPorId.get(id) || null;
        if (!Number.isInteger(id) || id <= 0 || !anterior
          || Number(anterior.produto_id) !== produtoId || idsAnterioresUsados.has(id)) {
          const err = new Error('A identidade de uma linha do Pedido é inválida ou não pertence a este Pedido.');
          err.statusCode = 400;
          err.code = 'ITEM_PEDIDO_INVALIDO';
          throw err;
        }
      } else {
        const candidatos = anterioresPorProduto.get(produtoId) || [];
        if (candidatos.length === 1 && !idsAnterioresUsados.has(Number(candidatos[0].id))) {
          anterior = candidatos[0];
          item.id = Number(anterior.id);
        }
      }
      if (anterior) idsAnterioresUsados.add(Number(anterior.id));
      return anterior;
    });
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
    if (colunasPedidos.has('venda_id')) sql += ' AND venda_id IS NULL';
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
    if (mesaId !== undefined) {
      await run(
        'UPDATE pedidos SET mesa_id = ? WHERE id = ? AND empresa_id = ?',
        [mesaId == null ? null : Number(mesaId), pedidoId, emp],
        db
      );
    }
    if (colunasPedidos.has('cliente_nome') && clienteNome !== undefined) {
      const nomeLivre = clienteNome == null ? null : String(clienteNome).trim();
      await run(
        'UPDATE pedidos SET cliente_nome = ? WHERE id = ? AND empresa_id = ?',
        [nomeLivre || null, pedidoId, emp],
        db
      );
    }
    for (const anterior of itensAnteriores) {
      if (idsAnterioresUsados.has(Number(anterior.id))) continue;
      await run('DELETE FROM pedido_item_ingredientes WHERE pedido_item_id = ?', [anterior.id], db);
      await run(
        'DELETE FROM pedidos_itens WHERE id = ? AND pedido_id = ?',
        [anterior.id, pedidoId],
        db
      );
    }
    for (let index = 0; index < itens.length; index += 1) {
      const item = itens[index];
      const produtoId = Number(item.produto_id);
      const anterior = associacoes[index];
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
      if (anterior) {
        const update = montarUpdatePedidoItem({
          pedidoId,
          empresaId: emp,
          item,
          snapshot,
          colunasPedidoItens
        });
        const atualizado = await run(update.sql, update.valores, db);
        if (!atualizado.changes) {
        const err = new Error('A linha do Pedido não pôde ser atualizada.');
        err.statusCode = 409;
        err.code = 'ITEM_PEDIDO_CONCORRENTE';
        throw err;
        }
        await run('DELETE FROM pedido_item_ingredientes WHERE pedido_item_id = ?', [item.id], db);
      } else {
        const insert = montarInsertPedidoItem({
        pedidoId,
        empresaId: emp,
        item,
        snapshot,
        colunasPedidoItens
        });
        const itemInserido = await run(insert.sql, insert.valores, db);
        item.id = itemInserido.lastID;
      }
      await persistirIngredientesPersonalizados(db, pedidoId, item.id, emp, item);
    }
    if (!jaEmTransacao) await run('COMMIT', [], db);
    return true;
  } catch (err) {
    if (!jaEmTransacao) {
      try { await run('ROLLBACK', [], db); } catch (_) { /* ignore */ }
    }
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
    const colunasPedidos = await obterColunasTabela('pedidos', db);
    const row = await get(
      `SELECT id, status,
              ${colunasPedidos.has('empresa_id') ? 'empresa_id' : 'NULL AS empresa_id'},
              ${colunasPedidos.has('venda_id') ? 'venda_id' : 'NULL AS venda_id'}
         FROM pedidos WHERE id = ?`,
      [pedidoId],
      db
    );
    if (!row) {
      const err = new Error('Pedido não encontrado.');
      err.statusCode = 404;
      throw err;
    }
    if (Number.isInteger(emp) && emp > 0 && Number(row.empresa_id) !== emp) {
      const err = new Error('Pedido não encontrado.');
      err.statusCode = 404;
      err.code = 'PEDIDO_NAO_ENCONTRADO';
      throw err;
    }
    const estadoEdicao = await obterEstadoEdicao(row, { db });
    if (estadoEdicao.edicao_bloqueada) {
      throw criarErroPedidoImutavel(row, estadoEdicao);
    }
    if (row.status !== 'ORCAMENTO') {
      const err = new Error('Somente orçamentos podem ser excluídos. Use cancelar para pedidos.');
      err.statusCode = 400;
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
  const statusPermitidos = opts.permitirPedido
    ? "'PEDIDO', 'ABERTO', 'AGUARDANDO_FATURAMENTO', 'FATURADO'"
    : "'ABERTO', 'AGUARDANDO_FATURAMENTO', 'FATURADO'";
  let sql = `
    UPDATE pedidos
    SET status = 'FATURADO',
        venda_id = ?,
        faturado_em = DATETIME('now', 'localtime'),
        faturado_por = ?,
        updated_at = DATETIME('now', 'localtime')
    WHERE id = ?
      AND status IN (${statusPermitidos})
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

async function vincularAtendimentoDaMesa(pedidoId, empresaId, atendimentoId, opts = {}) {
  const db = conn(opts.db);
  const colunas = await obterColunasTabela('pedidos', db);
  if (!colunas.has('mesa_atendimento_id')) {
    throw new Error('Schema de pedidos sem mesa_atendimento_id: migração de mesas pendente.');
  }
  const atualizado = await run(
    `UPDATE pedidos
     SET mesa_atendimento_id = ?
     WHERE id = ? AND empresa_id = ? AND mesa_atendimento_id IS NULL`,
    [Number(atendimentoId), Number(pedidoId), Number(empresaId)],
    db
  );
  if (atualizado.changes !== 1) {
    const err = new Error('Não foi possível vincular o pedido ao atendimento da mesa.');
    err.statusCode = 409;
    err.codigo = 'ATENDIMENTO_VINCULO_CONCORRENTE';
    throw err;
  }
}

/** Troca o atendimento já vinculado (ex.: pedido mudou de mesa na edição). */
async function reatribuirAtendimentoDaMesa(pedidoId, empresaId, atendimentoId, opts = {}) {
  const db = conn(opts.db);
  const colunas = await obterColunasTabela('pedidos', db);
  if (!colunas.has('mesa_atendimento_id')) {
    throw new Error('Schema de pedidos sem mesa_atendimento_id: migração de mesas pendente.');
  }
  const atualizado = await run(
    `UPDATE pedidos
     SET mesa_atendimento_id = ?
     WHERE id = ? AND empresa_id = ?`,
    [Number(atendimentoId), Number(pedidoId), Number(empresaId)],
    db
  );
  if (atualizado.changes !== 1) {
    const err = new Error('Não foi possível reatribuir o pedido ao atendimento da mesa.');
    err.statusCode = 409;
    err.codigo = 'ATENDIMENTO_VINCULO_CONCORRENTE';
    throw err;
  }
}

async function desvincularAtendimentoDaMesa(pedidoId, empresaId, opts = {}) {
  const db = conn(opts.db);
  const colunas = await obterColunasTabela('pedidos', db);
  if (!colunas.has('mesa_atendimento_id')) return;
  await run(
    `UPDATE pedidos
     SET mesa_atendimento_id = NULL
     WHERE id = ? AND empresa_id = ?`,
    [Number(pedidoId), Number(empresaId)],
    db
  );
}

/**
 * S07-3D — grava snapshot da resolução de destino (sem despacho).
 * No-op se as colunas ainda não existirem (migration pendente).
 * Não sobrescreve destino já RESOLVIDO (estabilidade após alteração de roteamento).
 */
async function persistirResolucaoDestinoCozinha(pedidoId, empresaId, resolucao, opts = {}) {
  const db = conn(opts.db);
  const colunas = await obterColunasTabela('pedidos', db);
  const temCanal = colunas.has('cozinha_canal_codigo');
  const temUnidade = colunas.has('unidade_cozinha_destino_id');
  const temStatus = colunas.has('cozinha_resolucao_status');
  if (!temCanal && !temUnidade && !temStatus) {
    return { skipped: true, motivo: 'SCHEMA_DESTINO_AUSENTE' };
  }

  const id = Number(pedidoId);
  const emp = Number(empresaId);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(emp) || emp <= 0) {
    return { skipped: true, motivo: 'IDENTIFICADORES_INVALIDOS' };
  }

  const atual = await get(
    `SELECT ${temStatus ? 'cozinha_resolucao_status' : 'NULL AS cozinha_resolucao_status'},
            ${temUnidade ? 'unidade_cozinha_destino_id' : 'NULL AS unidade_cozinha_destino_id'}
       FROM pedidos WHERE id = ? AND empresa_id = ?`,
    [id, emp],
    db
  );
  if (!atual) return { skipped: true, motivo: 'PEDIDO_NAO_ENCONTRADO' };

  if (
    String(atual.cozinha_resolucao_status || '') === 'RESOLVIDO'
    && atual.unidade_cozinha_destino_id != null
  ) {
    return { skipped: true, motivo: 'DESTINO_JA_RESOLVIDO' };
  }

  const canalCodigo = resolucao && resolucao.canal_codigo != null
    ? String(resolucao.canal_codigo)
    : null;
  const unidadeId = resolucao
    && resolucao.destino
    && resolucao.destino.unidade_id != null
    ? Number(resolucao.destino.unidade_id)
    : null;
  const status = resolucao && resolucao.status != null ? String(resolucao.status) : null;

  const sets = [];
  const params = [];
  if (temCanal) {
    sets.push('cozinha_canal_codigo = ?');
    params.push(canalCodigo);
  }
  if (temUnidade) {
    sets.push('unidade_cozinha_destino_id = ?');
    params.push(Number.isInteger(unidadeId) && unidadeId > 0 ? unidadeId : null);
  }
  if (temStatus) {
    sets.push('cozinha_resolucao_status = ?');
    params.push(status);
  }
  if (!sets.length) return { skipped: true, motivo: 'SCHEMA_DESTINO_AUSENTE' };

  params.push(id, emp);
  await run(
    `UPDATE pedidos SET ${sets.join(', ')} WHERE id = ? AND empresa_id = ?`,
    params,
    db
  );
  return { skipped: false, status, unidade_cozinha_destino_id: unidadeId, canal_codigo: canalCodigo };
}

module.exports = {
  listarAguardandoFaturamento,
  listarPedidos,
  obterPorId,
  obterEstadoEdicao,
  criarErroPedidoImutavel,
  criarPedido,
  persistirResolucaoDestinoCozinha,
  vincularAtendimentoDaMesa,
  reatribuirAtendimentoDaMesa,
  desvincularAtendimentoDaMesa,
  substituirPedido,
  atualizarStatus,
  excluirOrcamento,
  marcarFaturado,
  atualizarDadosFiscais,
  _montarInsertPedidoItem: montarInsertPedidoItem,
  _montarUpdatePedidoItem: montarUpdatePedidoItem
};
