'use strict';

const FichaTecnicaService = require('../produtos/FichaTecnicaService');
const {
  garantirSchemaFichaPersonalizacaoAsync,
  garantirSchemaPedidoPersonalizacaoAsync
} = require('../produtos/personalizacaoIngredientesSchema');
const { garantirSchemaFichaTecnicaAsync } = require('../produtos/fichaTecnicaSchema');

const CLASSIFICACOES_OPCIONAIS = new Set(['OPCIONAL', 'OPCIONAL_COM_ADICIONAL']);

function erro(code, message, statusCode = 400) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function arredondarDinheiro(valor) {
  return Number(Number(valor).toFixed(2));
}

function idsSelecionados(raw, anterior) {
  const informados = raw.ingredientes_selecionados;
  if (informados === undefined && anterior) {
    return anterior
      .filter((item) => Number(item.selecionado) === 1
        && CLASSIFICACOES_OPCIONAIS.has(item.classificacao_comercial_snapshot))
      .map((item) => Number(item.insumo_id));
  }
  if (informados == null) return [];
  if (!Array.isArray(informados)) {
    throw erro('SELECAO_INGREDIENTES_INVALIDA', 'A seleção de ingredientes deve ser uma lista.');
  }
  const ids = informados.map(Number);
  if (ids.some((id) => !Number.isInteger(id) || id <= 0) || new Set(ids).size !== ids.length) {
    throw erro('SELECAO_INGREDIENTES_INVALIDA', 'A seleção contém IDs de ingredientes inválidos ou duplicados.');
  }
  return ids;
}

function normalizarPrecoCatalogo(valor, campo) {
  if (valor == null || (typeof valor === 'string' && valor.trim() === '')) {
    if (campo === 'preco_venda') return 0;
    return null;
  }
  const preco = Number(valor);
  if (!Number.isFinite(preco) || preco < 0) {
    throw erro('PRECO_BASE_INVALIDO', `O preço oficial ${campo} do produto é inválido.`);
  }
  return arredondarDinheiro(preco);
}

async function obterPrecoBaseCatalogo(db, produto) {
  const precoVenda = normalizarPrecoCatalogo(produto.preco_venda, 'preco_venda');
  const precoPedido = normalizarPrecoCatalogo(produto.preco_pedido, 'preco_pedido');
  if (precoPedido != null) {
    return {
      precoBase: precoPedido,
      precoVenda,
      precoPedido,
      origem: 'PRECO_PEDIDO'
    };
  }

  const promocao = await dbGet(
    db,
    `SELECT preco_promocional
       FROM promocoes
      WHERE produto_id = ?
        AND status = 'ativa'
        AND date(data_inicio) <= date('now')
        AND date(data_fim) >= date('now')
      ORDER BY id ASC
      LIMIT 1`,
    [Number(produto.id)]
  );
  const precoPromocional = promocao
    ? normalizarPrecoCatalogo(promocao.preco_promocional, 'preco_promocional')
    : null;
  return {
    precoBase: precoPromocional != null ? precoPromocional : precoVenda,
    precoVenda,
    precoPedido: null,
    origem: precoPromocional != null ? 'PROMOCAO' : 'PRECO_VENDA'
  };
}

function obterPrecoBase(raw, anterior, precoCatalogo) {
  const snapshotAnterior = anterior?.preco_base_unitario_snapshot;
  const base = snapshotAnterior != null
    ? normalizarPrecoCatalogo(snapshotAnterior, 'snapshot')
    : precoCatalogo?.precoBase;
  if (base == null || !Number.isFinite(base)) {
    throw erro('PRECO_BASE_INVALIDO', 'O preço-base oficial do item personalizável é inválido.');
  }

  if (Object.prototype.hasOwnProperty.call(raw, 'preco_base_unitario')) {
    const bruto = raw.preco_base_unitario;
    if (bruto == null || (typeof bruto === 'string' && bruto.trim() === '')) {
      throw erro('PRECO_BASE_INVALIDO', 'Informe um preço-base unitário válido para o item personalizável.');
    }
    const informado = normalizarPrecoCatalogo(bruto, 'informado');
    if (informado !== base) {
      throw erro(
        'PRECO_BASE_DIVERGENTE',
        'O preço-base do item mudou ou não corresponde ao preço oficial. Atualize o Pedido e tente novamente.',
        409
      );
    }
  }
  return base;
}

function validarSelecaoContraFicha(ids, ficha, produtoId) {
  const opcionais = new Map(
    ficha.itens
      .filter((item) => CLASSIFICACOES_OPCIONAIS.has(item.classificacao_comercial))
      .map((item) => [Number(item.insumo_id), item])
  );
  for (const id of ids) {
    if (!opcionais.has(id)) {
      throw erro(
        'INGREDIENTE_NAO_PERSONALIZAVEL',
        `O ingrediente ${id} não é uma opção válida para o produto ${produtoId}.`
      );
    }
  }
}

function montarSnapshot(ficha, ids) {
  const selecionados = new Set(ids);
  return ficha.itens.map((item) => {
    const classificacao = String(item.classificacao_comercial || 'OBRIGATORIO_OCULTO');
    const obrigatorio = classificacao === 'OBRIGATORIO_OCULTO';
    return {
      insumo_id: Number(item.insumo_id),
      insumo_nome_snapshot: String(item.insumo_nome || `#${item.insumo_id}`),
      quantidade_snapshot: Number(item.quantidade),
      unidade_snapshot: String(item.unidade),
      classificacao_comercial_snapshot: classificacao,
      selecionado: obrigatorio || selecionados.has(Number(item.insumo_id)) ? 1 : 0,
      preco_adicional_snapshot: Number(item.preco_adicional || 0)
    };
  });
}

function aplicarPrecoPersonalizado(item, raw, rows, anterior, precoCatalogo) {
  const precoBase = obterPrecoBase(raw, anterior, precoCatalogo);
  const adicionais = arredondarDinheiro(rows.reduce((total, row) => (
    total + (Number(row.selecionado) === 1
      && row.classificacao_comercial_snapshot === 'OPCIONAL_COM_ADICIONAL'
      ? Number(row.preco_adicional_snapshot)
      : 0)
  ), 0));
  item.personalizacao_ingredientes_snapshot = 1;
  item.preco_base_unitario_snapshot = precoBase;
  item.preco_adicionais_unitario_snapshot = adicionais;
  item.ingredientes_personalizados = rows;
  item.preco_unitario = arredondarDinheiro(precoBase + adicionais);
  item.subtotal = arredondarDinheiro(
    Number(item.quantidade) * item.preco_unitario * (1 - Number(item.desconto_percentual || 0) / 100)
  );
  if (anterior) {
    item.preco_venda_snapshot = anterior.preco_venda_snapshot ?? null;
    item.preco_pedido_snapshot = anterior.preco_pedido_snapshot ?? null;
    item.preco_sugerido_snapshot = anterior.preco_sugerido_snapshot ?? null;
    item.origem_preco_sugerido = anterior.origem_preco_sugerido ?? null;
  } else if (precoCatalogo) {
    item.preco_venda_snapshot = precoCatalogo.precoVenda;
    item.preco_pedido_snapshot = precoCatalogo.precoPedido;
    item.preco_sugerido_snapshot = precoCatalogo.precoBase;
    item.origem_preco_sugerido = precoCatalogo.origem;
  }
}

async function prepararItens(itens, itensBrutos, opcoes = {}) {
  const db = opcoes.db;
  if (!db) throw erro('DB_OBRIGATORIO', 'Conexão SQLite obrigatória.', 500);
  await garantirSchemaFichaTecnicaAsync(db);
  await garantirSchemaFichaPersonalizacaoAsync(db);
  await garantirSchemaPedidoPersonalizacaoAsync(db);

  const existentesPorId = new Map(
    (opcoes.itensExistentes || [])
      .filter((item) => Number.isInteger(Number(item.id)))
      .map((item) => [Number(item.id), item])
  );

  for (let index = 0; index < itens.length; index += 1) {
    const item = itens[index];
    const raw = itensBrutos[index] || {};
    const anterior = item.id != null ? existentesPorId.get(Number(item.id)) : null;
    if (anterior && Number(anterior.produto_id) !== Number(item.produto_id)) {
      throw erro('ITEM_PEDIDO_INVALIDO', 'O item informado não pertence ao produto original do Pedido.');
    }

    const produto = await dbGet(
      db,
      `SELECT id, nome, preco_venda, preco_pedido,
              COALESCE(permite_personalizacao_ingredientes, 0) AS permite_personalizacao_ingredientes,
              utiliza_ficha_tecnica
       FROM produtos WHERE id = ?`,
      [Number(item.produto_id)]
    );
    if (!produto) throw erro('PRODUTO_INEXISTENTE', `Produto ${item.produto_id} não encontrado.`, 404);

    const eraPersonalizado = anterior
      && Number(anterior.personalizacao_ingredientes_snapshot) === 1;
    const eraNaoPersonalizado = anterior && !eraPersonalizado;
    if (eraNaoPersonalizado) {
      const ids = idsSelecionados(raw, null);
      if (ids.length) {
        throw erro('INGREDIENTE_NAO_PERSONALIZAVEL', 'Este item histórico não possui personalização de ingredientes.');
      }
      item.personalizacao_ingredientes_snapshot = 0;
      item.preco_base_unitario_snapshot = null;
      item.preco_adicionais_unitario_snapshot = null;
      item.ingredientes_personalizados = [];
      continue;
    }

    const rowsAnteriores = anterior?.ingredientes_personalizados || [];
    const ids = idsSelecionados(raw, eraPersonalizado ? rowsAnteriores : null);
    if (eraPersonalizado) {
      const idsAnteriores = rowsAnteriores
        .filter((row) => Number(row.selecionado) === 1
          && CLASSIFICACOES_OPCIONAIS.has(row.classificacao_comercial_snapshot))
        .map((row) => Number(row.insumo_id))
        .sort((a, b) => a - b);
      const idsAtuais = [...ids].sort((a, b) => a - b);
      if (idsAnteriores.length === idsAtuais.length
        && idsAnteriores.every((id, i) => id === idsAtuais[i])) {
        aplicarPrecoPersonalizado(item, raw, rowsAnteriores, anterior, null);
        continue;
      }
    }

    if (produto.utiliza_ficha_tecnica != null
      && Number(produto.utiliza_ficha_tecnica) === 0
      && Number(produto.permite_personalizacao_ingredientes) === 1) {
      throw erro(
        'PERSONALIZACAO_EXIGE_FICHA_TECNICA',
        'A personalização de ingredientes exige que o produto utilize ficha técnica.'
      );
    }

    if (Number(produto.permite_personalizacao_ingredientes) !== 1) {
      if (ids.length) {
        throw erro('INGREDIENTE_NAO_PERSONALIZAVEL', 'O produto não permite personalização de ingredientes.');
      }
      if (eraPersonalizado) {
        throw erro(
          'PERSONALIZACAO_CONFIGURACAO_ALTERADA',
          'A configuração do produto mudou. Preserve as escolhas atuais ou reative a personalização antes de alterá-las.'
        );
      }
      item.personalizacao_ingredientes_snapshot = 0;
      item.preco_base_unitario_snapshot = null;
      item.preco_adicionais_unitario_snapshot = null;
      item.ingredientes_personalizados = [];
      continue;
    }

    const ficha = await FichaTecnicaService.obterPorProdutoId(item.produto_id, { db });
    if (!ficha || ficha.existe !== true) {
      throw erro(
        'FICHA_TECNICA_NAO_ENCONTRADA',
        `O produto ${produto.nome || produto.id} permite personalização, mas não possui ficha técnica.`
      );
    }
    if (Number(ficha.ativo) !== 1) {
      throw erro(
        'FICHA_TECNICA_INATIVA',
        `A ficha técnica do produto ${produto.nome || produto.id} está inativa.`
      );
    }
    if (!Array.isArray(ficha.itens) || ficha.itens.length === 0) {
      throw erro(
        'FICHA_TECNICA_VAZIA',
        `A ficha técnica ativa do produto ${produto.nome || produto.id} não possui ingredientes.`
      );
    }
    if (!ficha.itens.some((componente) => CLASSIFICACOES_OPCIONAIS.has(componente.classificacao_comercial))) {
      throw erro(
        'PERSONALIZACAO_SEM_OPCOES',
        `A ficha técnica do produto ${produto.nome || produto.id} não possui ingredientes opcionais.`
      );
    }
    validarSelecaoContraFicha(ids, ficha, produto.id);
    const rows = montarSnapshot(ficha, ids);
    const precoCatalogo = anterior?.preco_base_unitario_snapshot != null
      ? null
      : await obterPrecoBaseCatalogo(db, produto);
    aplicarPrecoPersonalizado(item, raw, rows, anterior, precoCatalogo);
  }
}

module.exports = {
  prepararItens
};
