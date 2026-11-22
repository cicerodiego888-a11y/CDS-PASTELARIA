'use strict';

const { decimalParaMilessimos } = require('./cozinhaQuantidade');
const { classificarItemCozinha } = require('./cozinhaClassificacaoItem');

function erroLiberacao(pendencias) {
  const err = new Error(
    'Não é possível encaminhar ou finalizar este pedido: existem itens comerciais ou de cozinha sem retirada individual confirmada pelo garçom.'
  );
  err.statusCode = 409;
  err.codigo = 'COZINHA_RETIRADA_PENDENTE';
  err.pendencias = pendencias;
  return err;
}

function sqliteGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function sqliteAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function inteiroPositivo(valor) {
  const numero = Number(valor);
  return Number.isInteger(numero) && numero > 0 ? numero : null;
}

function conn(opts) {
  return (opts && opts.db) || require('../../database');
}

async function tabelaExiste(db, nome) {
  const row = await sqliteGet(
    db,
    "SELECT 1 AS existe FROM sqlite_master WHERE type='table' AND name=?",
    [nome]
  );
  return !!row;
}

async function classificarExigibilidadeCozinha(db, itemPedido) {
  const snapshot = String(
    itemPedido.classificacao_operacional_snapshot
    || itemPedido.tipo_operacional_snapshot
    || ''
  ).trim().toUpperCase();
  if (['NAO_COZINHA', 'SEM_COZINHA', 'NAO_EXIGE_COZINHA'].includes(snapshot)) {
    return { exigeCozinha: false, confiavel: true, motivo: 'snapshot_sem_cozinha' };
  }
  if (['EXIGE_COZINHA', 'PASTEL', 'BEBIDA', 'OUTRO'].includes(snapshot)) {
    return {
      exigeCozinha: true,
      confiavel: true,
      tipo: ['PASTEL', 'BEBIDA', 'OUTRO'].includes(snapshot) ? snapshot : null,
      motivo: 'snapshot_exige_cozinha'
    };
  }

  const temProdutos = await tabelaExiste(db, 'produtos');
  if (!temProdutos) {
    return { exigeCozinha: null, confiavel: false, motivo: 'catalogo_indisponivel' };
  }
  const colunasProduto = new Set(
    (await sqliteAll(db, 'PRAGMA table_info(produtos)')).map((coluna) => String(coluna.name))
  );
  const temCategorias = await tabelaExiste(db, 'categorias');
  const colunasCategoria = temCategorias
    ? new Set((await sqliteAll(db, 'PRAGMA table_info(categorias)')).map((coluna) => String(coluna.name)))
    : new Set();
  const categoriaJoin = colunasProduto.has('categoria_id') && colunasCategoria.has('id')
    ? 'LEFT JOIN categorias c ON c.id = p.categoria_id'
    : '';
  const categoriaSelect = categoriaJoin && colunasCategoria.has('nome')
    ? 'c.nome AS categoria_nome'
    : 'NULL AS categoria_nome';
  const produto = await sqliteGet(db, `
    SELECT
      ${colunasProduto.has('tipo_operacional') ? "COALESCE(p.tipo_operacional, 'COMERCIAL')" : "'COMERCIAL'"} AS tipo_operacional,
      ${colunasProduto.has('comercializavel') ? 'COALESCE(p.comercializavel, 0)' : '0'} AS comercializavel,
      ${colunasProduto.has('utiliza_ficha_tecnica') ? 'p.utiliza_ficha_tecnica' : 'NULL'} AS utiliza_ficha_tecnica,
      ${categoriaSelect}
    FROM produtos p
    ${categoriaJoin}
    WHERE p.id = ?
  `, [itemPedido.produto_id]);
  const classificacao = classificarItemCozinha({
    ...(produto || {}),
    classificacao_operacional_snapshot: snapshot
  });
  return {
    exigeCozinha: classificacao.confiavel ? true : null,
    confiavel: classificacao.confiavel,
    tipo: classificacao.tipo,
    motivo: classificacao.motivo
  };
}

async function colunaExiste(db, tabela, coluna) {
  const colunas = await sqliteAll(
    db,
    `PRAGMA table_info("${String(tabela).replace(/"/g, '""')}")`
  );
  return colunas.some((entrada) => String(entrada.name) === coluna);
}

async function cancelamentosLiquidos(db, empresaId, pedidoId, pedidoItemId) {
  const row = await sqliteGet(db, `
    SELECT
      COALESCE(SUM(CASE WHEN tipo_evento='CANCELAMENTO_CONFIRMADO'
        THEN qty_millis ELSE 0 END), 0)
      - COALESCE(SUM(CASE WHEN tipo_evento='CANCELAMENTO_ESTORNADO'
        THEN qty_millis ELSE 0 END), 0) AS liquida
    FROM cozinha_cancelamento_itens
    WHERE empresa_id = ? AND pedido_id = ? AND pedido_item_id = ?
  `, [empresaId, pedidoId, pedidoItemId]);
  return Number(row?.liquida || 0);
}

async function retiradasLiquidas(db, empresaId, pedidoId, pedidoItemId) {
  const row = await sqliteGet(db, `
    SELECT
      COALESCE(SUM(CASE WHEN tipo_evento IN (
        'RETIRADA_CONFIRMADA','AJUSTE_CREDITO'
      ) THEN qty_millis ELSE 0 END), 0)
      - COALESCE(SUM(CASE WHEN tipo_evento IN (
        'RETIRADA_ESTORNADA','AJUSTE_DEBITO'
      ) THEN qty_millis ELSE 0 END), 0) AS liquida
    FROM cozinha_retirada_itens
    WHERE empresa_id = ? AND pedido_id = ? AND pedido_item_id = ?
  `, [empresaId, pedidoId, pedidoItemId]);
  return Number(row?.liquida || 0);
}

async function retiradasLiquidasKdsItem(db, empresaId, pedidoId, pedidoItemId, cozinhaItem) {
  const row = await sqliteGet(db, `
    SELECT
      COALESCE(SUM(CASE WHEN tipo_evento IN (
        'RETIRADA_CONFIRMADA','AJUSTE_CREDITO'
      ) THEN qty_millis ELSE 0 END), 0)
      - COALESCE(SUM(CASE WHEN tipo_evento IN (
        'RETIRADA_ESTORNADA','AJUSTE_DEBITO'
      ) THEN qty_millis ELSE 0 END), 0) AS liquida
    FROM cozinha_retirada_itens
    WHERE empresa_id = ? AND pedido_id = ? AND pedido_item_id = ?
      AND cozinha_item_id = ? AND rodada_id = ? AND unidade_id = ?
  `, [
    empresaId,
    pedidoId,
    pedidoItemId,
    cozinhaItem.id,
    cozinhaItem.rodada_id,
    cozinhaItem.unidade_id
  ]);
  return Number(row?.liquida || 0);
}

async function cancelamentosLiquidosKdsItem(db, empresaId, pedidoId, pedidoItemId, cozinhaItem) {
  const row = await sqliteGet(db, `
    SELECT
      COALESCE(SUM(CASE WHEN tipo_evento='CANCELAMENTO_CONFIRMADO'
        THEN qty_millis ELSE 0 END), 0)
      - COALESCE(SUM(CASE WHEN tipo_evento='CANCELAMENTO_ESTORNADO'
        THEN qty_millis ELSE 0 END), 0) AS liquida
    FROM cozinha_cancelamento_itens
    WHERE empresa_id = ? AND pedido_id = ? AND pedido_item_id = ?
      AND cozinha_item_id = ? AND rodada_id = ? AND unidade_id = ?
  `, [
    empresaId,
    pedidoId,
    pedidoItemId,
    cozinhaItem.id,
    cozinhaItem.rodada_id,
    cozinhaItem.unidade_id
  ]);
  return Number(row?.liquida || 0);
}

async function ledgerPedidoItemInconsistente(db, tabela, empresaId, pedidoId, pedidoItemId) {
  const row = await sqliteGet(db, `
    SELECT 1 AS existe
    FROM ${tabela}
    WHERE pedido_item_id = ?
      AND (empresa_id <> ? OR pedido_id <> ?)
    LIMIT 1
  `, [pedidoItemId, empresaId, pedidoId]);
  return !!row;
}

async function ledgerItemKdsInconsistente(db, tabela, empresaId, pedidoId, pedidoItemId, itemKds) {
  const row = await sqliteGet(db, `
    SELECT 1 AS existe
    FROM ${tabela}
    WHERE cozinha_item_id = ?
      AND (
        empresa_id <> ?
        OR pedido_id <> ?
        OR pedido_item_id <> ?
        OR rodada_id <> ?
        OR unidade_id <> ?
      )
    LIMIT 1
  `, [
    itemKds.id,
    empresaId,
    pedidoId,
    pedidoItemId,
    itemKds.rodada_id,
    itemKds.unidade_id
  ]);
  return !!row;
}

async function validarLiberacaoPdv({ pedidoId, empresaId } = {}, opts = {}) {
  const pedido = inteiroPositivo(pedidoId);
  const empresa = inteiroPositivo(empresaId);
  if (!pedido || !empresa) {
    const err = new Error('Pedido e empresa são obrigatórios para validar a liberação da cozinha.');
    err.statusCode = 400;
    err.codigo = 'COZINHA_LIBERACAO_CONTEXTO_INVALIDO';
    throw err;
  }

  const db = conn(opts);

  if (!await tabelaExiste(db, 'pedidos')) {
    const err = new Error('Não foi possível comprovar o pedido comercial.');
    err.statusCode = 503;
    err.codigo = 'PEDIDOS_INDISPONIVEIS';
    throw err;
  }
  const pedidoRow = await sqliteGet(db, `
    SELECT id, empresa_id, status
    FROM pedidos
    WHERE id = ?
  `, [pedido]);
  if (!pedidoRow || Number(pedidoRow.empresa_id) !== empresa) {
    const err = new Error('Pedido não encontrado na empresa informada.');
    err.statusCode = 404;
    err.codigo = 'PEDIDO_NAO_ENCONTRADO';
    throw err;
  }
  if (String(pedidoRow.status || '').trim().toUpperCase() === 'CANCELADO') {
    const err = new Error('Pedido comercial cancelado não pode ser liberado para venda.');
    err.statusCode = 409;
    err.codigo = 'PEDIDO_CANCELADO';
    throw err;
  }

  if (!await tabelaExiste(db, 'pedidos_itens')) {
    const err = new Error('Não foi possível comprovar os itens comerciais do pedido.');
    err.statusCode = 503;
    err.codigo = 'PEDIDO_ITENS_INDISPONIVEIS';
    throw err;
  }

  const pedidoItensTemEmpresa = await colunaExiste(db, 'pedidos_itens', 'empresa_id');
  const pedidoItensRows = await sqliteAll(
    db,
    'SELECT * FROM pedidos_itens WHERE pedido_id = ?',
    [pedido]
  );

  if (!pedidoItensRows.length) {
    throw erroLiberacao([{
      pedido_id: pedido,
      motivo: 'PEDIDO_SEM_ITENS_COMERCIAIS',
      descricao: 'Pedido sem itens comerciais não pode ser liberado para venda.',
      qty_exigivel: null,
      qty_retirada_liquida: null,
      qty_pendente: null
    }]);
  }

  const cozinhaItensExiste = await tabelaExiste(db, 'cozinha_itens');
  const cozinhaRodadasExiste = await tabelaExiste(db, 'cozinha_rodadas');
  const retiradaExiste = await tabelaExiste(db, 'cozinha_retirada_itens');
  const cancelamentoExiste = await tabelaExiste(db, 'cozinha_cancelamento_itens');
  let itensKds = [];

  if (cozinhaItensExiste && cozinhaRodadasExiste) {
    const itensTemUnidade = await colunaExiste(db, 'cozinha_itens', 'unidade_id');
    const rodadasTemUnidade = await colunaExiste(db, 'cozinha_rodadas', 'unidade_id');
    const seletorUnidadeItem = itensTemUnidade ? 'ci.unidade_id,' : 'NULL AS unidade_id,';
    const seletorUnidadeRodada = rodadasTemUnidade
      ? 'r.unidade_id AS rodada_unidade_id,'
      : 'NULL AS rodada_unidade_id,';
    itensKds = await sqliteAll(db, `
      SELECT ci.id, ci.empresa_id,
             ${seletorUnidadeItem}
             ci.rodada_id,
             ci.pedido_id, ci.pedido_item_id, ci.tipo_item,
             ci.estado_preparacao, ci.qty_solicitada_millis,
             ci.qty_cancelada_millis,
             r.id AS rodada_id_real,
             r.empresa_id AS rodada_empresa_id,
             ${seletorUnidadeRodada}
             r.estado_preparacao AS rodada_estado
      FROM cozinha_itens ci
      LEFT JOIN cozinha_rodadas r
        ON r.id = ci.rodada_id
      WHERE ci.pedido_id = ?
    `, [pedido]);
  }

  const pendencias = [];
  const pedidoItensValidos = new Set(
    pedidoItensRows
      .filter((item) => !pedidoItensTemEmpresa || Number(item.empresa_id) === empresa)
      .map((item) => Number(item.id))
  );
  for (const itemKds of itensKds) {
    if (
      Number(itemKds.empresa_id) !== empresa
      || Number(itemKds.pedido_id) !== pedido
      || !pedidoItensValidos.has(Number(itemKds.pedido_item_id))
    ) {
      pendencias.push({
        pedido_id: pedido,
        pedido_item_id: itemKds.pedido_item_id == null ? null : Number(itemKds.pedido_item_id),
        cozinha_item_id: Number(itemKds.id),
        rodada_id: itemKds.rodada_id == null ? null : Number(itemKds.rodada_id),
        motivo: 'ITEM_KDS_ORFAO_OU_EMPRESA_DIVERGENTE',
        descricao: 'O item KDS não corresponde a um item comercial deste pedido e empresa.',
        qty_exigivel: null,
        qty_retirada_liquida: null,
        qty_pendente: null
      });
    }
  }

  for (const pi of pedidoItensRows) {
    const pedidoItemId = Number(pi.id);

    if (pedidoItensTemEmpresa && pi.empresa_id == null) {
      pendencias.push({
        pedido_id: pedido,
        pedido_item_id: pedidoItemId,
        motivo: 'EMPRESA_PEDIDO_ITEM_AUSENTE',
        descricao: 'O item comercial não possui empresa confirmada.',
        qty_exigivel: null,
        qty_retirada_liquida: null,
        qty_pendente: null
      });
      continue;
    }
    if (pedidoItensTemEmpresa && Number(pi.empresa_id) !== empresa) {
      pendencias.push({
        pedido_id: pedido,
        pedido_item_id: pedidoItemId,
        motivo: 'EMPRESA_PEDIDO_ITEM_DIVERGENTE',
        descricao: 'O item comercial pertence a outra empresa.',
        qty_exigivel: null,
        qty_retirada_liquida: null,
        qty_pendente: null
      });
      continue;
    }

    let exigivelComercial;
    try {
      exigivelComercial = decimalParaMilessimos(pi.quantidade);
      if (exigivelComercial <= 0) throw new Error('Quantidade deve ser maior que zero.');
    } catch (_err) {
      pendencias.push({
        pedido_id: pedido,
        pedido_item_id: pedidoItemId,
        motivo: 'QUANTIDADE_COMERCIAL_INVALIDA',
        descricao: 'Não foi possível converter a quantidade comercial.',
        qty_exigivel: null,
        qty_retirada_liquida: null,
        qty_pendente: null
      });
      continue;
    }

    const itensLinha = itensKds.filter((item) => Number(item.pedido_item_id) === pedidoItemId);

    if (!itensLinha.length) {
      const classificacao = await classificarExigibilidadeCozinha(db, pi);
      if (classificacao.exigeCozinha === false) continue;
      const itemExigivel = classificacao.exigeCozinha === true;
      pendencias.push({
        pedido_id: pedido,
        pedido_item_id: pedidoItemId,
        motivo: itemExigivel
          ? 'ITEM_COZINHA_SEM_ENCAMINHAMENTO'
          : 'CLASSIFICACAO_COZINHA_AMBIGUA',
        descricao: itemExigivel
          ? 'O produto exige atendimento da cozinha, mas não possui encaminhamento correspondente ao KDS.'
          : 'Não há evidência suficiente para comprovar se o produto exige atendimento da cozinha.',
        tipo_cozinha: classificacao.tipo || null,
        classificacao_motivo: classificacao.motivo,
        qty_exigivel: exigivelComercial,
        qty_retirada_liquida: 0,
        qty_pendente: exigivelComercial
      });
      continue;
    }

    if (!retiradaExiste || !cancelamentoExiste) {
      pendencias.push({
        pedido_id: pedido,
        pedido_item_id: pedidoItemId,
        motivo: 'LEDGER_INDISPONIVEL',
        descricao: 'O ledger individual de retirada ou cancelamento não está disponível.',
        qty_exigivel: exigivelComercial,
        qty_retirada_liquida: null,
        qty_pendente: exigivelComercial
      });
      continue;
    }

    if (
      await ledgerPedidoItemInconsistente(db, 'cozinha_cancelamento_itens', empresa, pedido, pedidoItemId)
      || await ledgerPedidoItemInconsistente(db, 'cozinha_retirada_itens', empresa, pedido, pedidoItemId)
    ) {
      pendencias.push({
        pedido_id: pedido,
        pedido_item_id: pedidoItemId,
        motivo: 'LEDGER_VINCULO_PEDIDO_DIVERGENTE',
        descricao: 'Há eventos de ledger vinculados a outra empresa ou pedido.',
        qty_exigivel: exigivelComercial,
        qty_retirada_liquida: null,
        qty_pendente: null
      });
      continue;
    }

    const cancelamentos = await cancelamentosLiquidos(db, empresa, pedido, pedidoItemId);
    const retiradas = await retiradasLiquidas(db, empresa, pedido, pedidoItemId);
    const exigivel = Math.max(0, exigivelComercial - cancelamentos);

    if (cancelamentos > exigivelComercial) {
      pendencias.push({
        pedido_id: pedido,
        pedido_item_id: pedidoItemId,
        motivo: 'CANCELAMENTO_SUPERIOR_A_EXIGIVEL',
        descricao: 'Cancelamentos líquidos excedem a quantidade solicitada.',
        qty_exigivel: exigivelComercial,
        qty_cancelada: cancelamentos,
        qty_retirada_liquida: retiradas,
        qty_pendente: null
      });
      continue;
    }
    if (retiradas > exigivel) {
      pendencias.push({
        pedido_id: pedido,
        pedido_item_id: pedidoItemId,
        motivo: 'RETIRADA_SUPERIOR_A_EXIGIVEL',
        descricao: 'Retiradas líquidas excedem a quantidade exigível.',
        qty_exigivel: exigivel,
        qty_cancelada: cancelamentos,
        qty_retirada_liquida: retiradas,
        qty_pendente: null
      });
      continue;
    }

    let kdsExigivelTotal = 0;
    let kdsRetiradaTotal = 0;
    let pendentePorItem = 0;

    for (const itemKds of itensLinha) {
      if (
        Number(itemKds.empresa_id) !== empresa
        || Number(itemKds.pedido_id) !== pedido
        || !itemKds.rodada_id_real
        || Number(itemKds.rodada_empresa_id) !== empresa
        || itemKds.unidade_id == null
        || itemKds.rodada_unidade_id == null
        || Number(itemKds.unidade_id) !== Number(itemKds.rodada_unidade_id)
      ) {
        pendencias.push({
          pedido_id: pedido,
          pedido_item_id: pedidoItemId,
          cozinha_item_id: Number(itemKds.id),
          rodada_id: Number(itemKds.rodada_id),
          motivo: 'RODADA_OU_ITEM_ORFAO',
          descricao: 'O item KDS não possui vínculo operacional consistente.',
          qty_exigivel: null,
          qty_retirada_liquida: null,
          qty_pendente: null
        });
        continue;
      }

      if (
        await ledgerItemKdsInconsistente(db, 'cozinha_cancelamento_itens', empresa, pedido, pedidoItemId, itemKds)
        || await ledgerItemKdsInconsistente(db, 'cozinha_retirada_itens', empresa, pedido, pedidoItemId, itemKds)
      ) {
        pendencias.push({
          pedido_id: pedido,
          pedido_item_id: pedidoItemId,
          cozinha_item_id: Number(itemKds.id),
          rodada_id: Number(itemKds.rodada_id),
          motivo: 'LEDGER_VINCULO_ITEM_DIVERGENTE',
          descricao: 'Há eventos de ledger com vínculos divergentes do item KDS.',
          qty_exigivel: null,
          qty_retirada_liquida: null,
          qty_pendente: null
        });
        continue;
      }

      if (
        String(itemKds.estado_preparacao || '').toUpperCase() === 'CANCELADO'
        || String(itemKds.rodada_estado || '').toUpperCase() === 'CANCELADA'
      ) {
        const cancelamentoItem = await cancelamentosLiquidosKdsItem(
          db, empresa, pedido, pedidoItemId, itemKds
        );
        if (cancelamentoItem <= 0) {
          pendencias.push({
            pedido_id: pedido,
            pedido_item_id: pedidoItemId,
            cozinha_item_id: Number(itemKds.id),
            rodada_id: Number(itemKds.rodada_id),
            motivo: 'HISTORICO_CANCELAMENTO_AMBIGUO',
            descricao: 'O estado legado indica cancelamento sem evento líquido confiável.',
            qty_exigivel: null,
            qty_retirada_liquida: null,
            qty_pendente: null
          });
        }
        continue;
      }

      const cancelamentoItem = await cancelamentosLiquidosKdsItem(
        db, empresa, pedido, pedidoItemId, itemKds
      );
      const retiradaItem = await retiradasLiquidasKdsItem(
        db, empresa, pedido, pedidoItemId, itemKds
      );
      const exigivelItem = Math.max(0, Number(itemKds.qty_solicitada_millis || 0) - cancelamentoItem);

      kdsExigivelTotal += exigivelItem;
      kdsRetiradaTotal += retiradaItem;

      if (retiradaItem > exigivelItem) {
        pendencias.push({
          pedido_id: pedido,
          pedido_item_id: pedidoItemId,
          cozinha_item_id: Number(itemKds.id),
          rodada_id: Number(itemKds.rodada_id),
          motivo: 'RETIRADA_ITEM_SUPERIOR_A_EXIGIVEL',
          descricao: 'Retirada líquida do item excede a quantidade exigível.',
          qty_exigivel: exigivelItem,
          qty_retirada_liquida: retiradaItem,
          qty_pendente: null
        });
        continue;
      }

      pendentePorItem = Math.max(pendentePorItem, Math.max(0, exigivelItem - retiradaItem));

      if (String(itemKds.tipo_item || '').toUpperCase() === 'BEBIDA') {
        if (!await tabelaExiste(db, 'cozinha_bebida_entregas')) {
          pendencias.push({
            pedido_id: pedido,
            pedido_item_id: pedidoItemId,
            cozinha_item_id: Number(itemKds.id),
            rodada_id: Number(itemKds.rodada_id),
            motivo: 'LEDGER_BEBIDA_INDISPONIVEL',
            descricao: 'A entrega de bebida não pode ser comprovada.',
            qty_exigivel: exigivelItem,
            qty_retirada_liquida: retiradaItem,
            qty_pendente: Math.max(0, exigivelItem - retiradaItem)
          });
          continue;
        }

        const bebidasTemRodada = await colunaExiste(db, 'cozinha_bebida_entregas', 'rodada_id');
        const entrega = bebidasTemRodada
          ? await sqliteGet(db, `
              SELECT COALESCE(SUM(qty_entregue_millis), 0) AS entregue
              FROM cozinha_bebida_entregas
              WHERE empresa_id = ? AND cozinha_item_id = ? AND rodada_id = ?
            `, [empresa, itemKds.id, itemKds.rodada_id])
          : await sqliteGet(db, `
              SELECT COALESCE(SUM(qty_entregue_millis), 0) AS entregue
              FROM cozinha_bebida_entregas
              WHERE empresa_id = ? AND cozinha_item_id = ?
            `, [empresa, itemKds.id]);

        const entregue = Number(entrega?.entregue || 0);
        if (entregue < exigivelItem) {
          pendencias.push({
            pedido_id: pedido,
            pedido_item_id: pedidoItemId,
            cozinha_item_id: Number(itemKds.id),
            rodada_id: Number(itemKds.rodada_id),
            motivo: 'ENTREGA_BEBIDA_INCOMPLETA',
            descricao: 'A quantidade entregue não cobre esta bebida individual.',
            qty_exigivel: exigivelItem,
            qty_entregue: entregue,
            qty_retirada_liquida: retiradaItem,
            qty_pendente: Math.max(0, exigivelItem - retiradaItem)
          });
        } else if (entregue > exigivelItem) {
          pendencias.push({
            pedido_id: pedido,
            pedido_item_id: pedidoItemId,
            cozinha_item_id: Number(itemKds.id),
            rodada_id: Number(itemKds.rodada_id),
            motivo: 'ENTREGA_BEBIDA_ACIMA_DO_EXIGIVEL',
            descricao: 'A quantidade entregue excede esta bebida individual.',
            qty_exigivel: exigivelItem,
            qty_entregue: entregue,
            qty_retirada_liquida: retiradaItem,
            qty_pendente: Math.max(0, exigivelItem - retiradaItem)
          });
        } else if (retiradaItem < exigivelItem) {
          pendencias.push({
            pedido_id: pedido,
            pedido_item_id: pedidoItemId,
            cozinha_item_id: Number(itemKds.id),
            rodada_id: Number(itemKds.rodada_id),
            motivo: 'BEBIDA_ENTREGUE_SEM_RETIRADA_COMPLETA',
            descricao: 'A bebida foi entregue, mas não retirada integralmente.',
            qty_exigivel: exigivelItem,
            qty_entregue: entregue,
            qty_retirada_liquida: retiradaItem,
            qty_pendente: exigivelItem - retiradaItem
          });
        }
      }
    }

    if (kdsExigivelTotal < exigivel) {
      pendencias.push({
        pedido_id: pedido,
        pedido_item_id: pedidoItemId,
        motivo: 'KDS_QUANTIDADE_INSUFICIENTE',
        descricao: 'As linhas KDS não cobrem integralmente o item comercial.',
        qty_exigivel: exigivel,
        qty_kds_exigivel: kdsExigivelTotal,
        qty_retirada_liquida: kdsRetiradaTotal,
        qty_pendente: exigivel - kdsRetiradaTotal
      });
    } else if (kdsExigivelTotal > exigivel) {
      pendencias.push({
        pedido_id: pedido,
        pedido_item_id: pedidoItemId,
        motivo: 'KDS_QUANTIDADE_ACIMA_DO_COMERCIAL',
        descricao: 'As linhas KDS excedem a quantidade do item comercial.',
        qty_exigivel: exigivel,
        qty_kds_exigivel: kdsExigivelTotal,
        qty_retirada_liquida: kdsRetiradaTotal,
        qty_pendente: null
      });
    }

    const pendenteComercial = Math.max(0, exigivel - kdsRetiradaTotal);
    const pendente = Math.max(pendenteComercial, pendentePorItem);
    if (pendente > 0) {
      pendencias.push({
        pedido_id: pedido,
        pedido_item_id: pedidoItemId,
        motivo: 'RETIRADA_INDIVIDUAL_PENDENTE',
        descricao: 'Quantidade efetivamente retirada ainda não cobre a exigível.',
        cozinha_itens: itensLinha.map((item) => Number(item.id)),
        rodadas: [...new Set(itensLinha.map((item) => Number(item.rodada_id)))],
        qty_exigivel: exigivel,
        qty_cancelada: cancelamentos,
        qty_retirada_liquida: kdsRetiradaTotal,
        qty_pendente: pendente
      });
    }
  }

  if (pendencias.length) throw erroLiberacao(pendencias);
  return { liberado: true, pendencias: [] };
}

module.exports = {
  validarLiberacaoPdv,
  erroLiberacao
};
