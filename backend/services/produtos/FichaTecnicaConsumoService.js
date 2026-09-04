/**
 * Consumo de ficha técnica na venda (Sprint 03.04).
 * empresaId = vendas.empresa_id. Sem fallback. Sem HTTP.
 *
 * @module services/produtos/FichaTecnicaConsumoService
 */
'use strict';

const { obterMuc } = require('../../motores/muc/public');
const { normalizarUnidade, isUnidadeConhecida } = require('../../motores/muc/core/unidadesSi');
const ProdutoConversaoConfigService = require('./ProdutoConversaoConfigService');
const { garantirSchemaProdutoConversaoAsync } = require('./produtoConversaoSchema');
const { debitarEstoqueItemVenda } = require('../vendas/debitoEstoqueVendaViaPorta');
const { creditarEstoqueItemVenda } = require('../vendas/creditoEstoqueVendaViaPorta');
const estoqueSaldosPublico = require('../fiscalNaoFiscal/estoqueSaldosPublico');
const { exigirEmpresaDaOperacao } = require('../vendas/VendaEmpresaContextoService');
const FichaTecnicaService = require('./FichaTecnicaService');
const { TipoOperacionalProduto, normalizarTipoOperacional } = require('./tipoOperacionalProduto');
const { garantirSchemaVendaFichaConsumoAsync } = require('./vendaFichaConsumoSchema');

function erroConsumo(code, message, statusCode = 400, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  Object.assign(err, extra);
  return err;
}

function round3(n) {
  return Math.round(Number(n || 0) * 1000) / 1000;
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function creditoAsync(db, dados, creditarFn) {
  const creditar = creditarFn || creditarEstoqueItemVenda;
  return new Promise((resolve, reject) => {
    creditar(db, dados, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

function debitoAsync(db, dados) {
  return new Promise((resolve, reject) => {
    debitarEstoqueItemVenda(db, dados, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

function resolverEmpresaDoConsumo(empresaId) {
  return exigirEmpresaDaOperacao({ empresaId });
}

function mapearErroConversao(e, origem, dest) {
  const code = e && e.code ? e.code : 'CONVERSAO_INVALIDA';
  if (code === 'PRODUTO_SEM_UNIDADE_ESTOQUE' || code === 'UNIDADE_INVALIDA') {
    return erroConsumo(code, e.message, e.statusCode || 400);
  }
  if (code === 'CONVERSAO_NAO_DISPONIVEL') {
    return erroConsumo(
      'CONVERSAO_NAO_DISPONIVEL',
      `Não existe uma relação cadastrada para converter ${origem} em ${dest}.`,
      400
    );
  }
  return erroConsumo(
    code === 'CONVERSAO_CICLO' || code === 'CONVERSAO_INVALIDA' || code === 'RELACAO_CONVERSAO_INVALIDA'
      ? code
      : 'CONVERSAO_INVALIDA',
    e.message || `Conversão inválida: ${origem} → ${dest}.`,
    400
  );
}

async function listarApresentacoesInsumo(db, produtoId) {
  try {
    return await dbAll(
      db,
      `SELECT tipo, quantidade, unidade, ativa, compra
       FROM produto_embalagens
       WHERE produto_id = ? AND COALESCE(ativa, 1) = 1`,
      [Number(produtoId)]
    );
  } catch (e) {
    if (/no such table/i.test(String(e.message || ''))) return [];
    throw e;
  }
}

async function obterContextoConversaoInsumo(db, insumo, cache) {
  const id = Number(insumo.id);
  if (cache.has(id)) return cache.get(id);
  const cfg = await ProdutoConversaoConfigService.obterConfiguracao(db, id);
  const apresentacoes = Number(cfg.utiliza_conversao) === 1
    ? await listarApresentacoesInsumo(db, id)
    : [];
  const relacoes = Number(cfg.utiliza_conversao) === 1
    ? ProdutoConversaoConfigService.montarRelacoesMuc(apresentacoes, cfg.relacoes || [])
    : [];
  let unidadeEstoque;
  if (Number(cfg.utiliza_conversao) === 1) {
    unidadeEstoque = normalizarUnidade(cfg.unidade_estoque || insumo.unidade);
    if (!unidadeEstoque) {
      throw erroConsumo(
        'PRODUTO_SEM_UNIDADE_ESTOQUE',
        `Insumo ${insumo.nome || insumo.id} utiliza conversão e não possui unidade de estoque.`
      );
    }
  } else {
    unidadeEstoque = normalizarUnidade(insumo.unidade || 'UN') || 'UN';
  }
  const ctx = { cfg, relacoes, unidadeEstoque };
  cache.set(id, ctx);
  return ctx;
}

function converterQuantidadeFichaParaEstoque(db, { quantidade, unidadeOrigem, unidadeDestino, relacoes }) {
  // MUC-04: conversão exclusiva via obterMuc().converterQuantidade (MotorUM não converte a ficha).
  return obterMuc(db).converterQuantidade({
    quantidade,
    unidadeOrigem,
    unidadeDestino,
    relacoes: relacoes || []
  });
}

async function montarLinhasConsumo(itens, db) {
  await garantirSchemaProdutoConversaoAsync(db);
  const cacheInsumo = new Map();
  const linhas = [];
  for (const item of itens || []) {
    const produtoId = Number(item.produto_id != null ? item.produto_id : item.produtoId);
    const qtdVenda = Number(item.quantidade);
    if (!Number.isInteger(produtoId) || produtoId <= 0) continue;
    if (!(qtdVenda > 0)) continue;

    const ficha = await FichaTecnicaService.obterPorProdutoId(produtoId, { db });
    if (!ficha || Number(ficha.ativo) !== 1 || !Array.isArray(ficha.itens) || ficha.itens.length === 0) {
      continue;
    }

    for (const componente of ficha.itens) {
      const qtdFicha = Number(componente.quantidade);
      if (!(qtdFicha > 0)) {
        throw erroConsumo(
          'FICHA_QUANTIDADE_INVALIDA',
          'Quantidade da ficha técnica deve ser positiva. Consumo não realizado.'
        );
      }
      const insumoId = Number(componente.insumo_id);
      const insumo = await dbGet(
        db,
        `SELECT id, nome, ativo, unidade,
                COALESCE(tipo_operacional, 'COMERCIAL') AS tipo_operacional,
                COALESCE(utiliza_conversao, 0) AS utiliza_conversao,
                unidade_estoque
         FROM produtos WHERE id = ?`,
        [insumoId]
      );
      if (!insumo) {
        throw erroConsumo('FICHA_INSUMO_INEXISTENTE', 'Insumo da ficha técnica inexistente.', 404);
      }
      if (Number(insumo.ativo) === 0) {
        throw erroConsumo(
          'FICHA_INSUMO_INATIVO',
          `Insumo inativo na ficha técnica (${insumo.nome || insumo.id}). Consumo não realizado.`
        );
      }
      if (normalizarTipoOperacional(insumo.tipo_operacional) !== TipoOperacionalProduto.INSUMO) {
        throw erroConsumo(
          'FICHA_COMPONENTE_NAO_INSUMO',
          'Componente da ficha não é insumo. Consumo não realizado.'
        );
      }

      const unidadeFichaRaw = String(componente.unidade || '').trim();
      if (!unidadeFichaRaw) {
        throw erroConsumo('UNIDADE_INVALIDA', 'Unidade da ficha é obrigatória.');
      }
      const unidadeFicha = normalizarUnidade(unidadeFichaRaw);
      if (!unidadeFicha || !isUnidadeConhecida(unidadeFicha)) {
        throw erroConsumo('UNIDADE_INVALIDA', `Unidade inválida: ${unidadeFichaRaw}.`);
      }
      const qtdBruta = qtdVenda * qtdFicha;
      const ctxConv = await obterContextoConversaoInsumo(db, insumo, cacheInsumo);
      const unidadeEstoque = ctxConv.unidadeEstoque;
      let conv;
      try {
        conv = converterQuantidadeFichaParaEstoque(db, {
          quantidade: qtdBruta,
          unidadeOrigem: unidadeFicha,
          unidadeDestino: unidadeEstoque,
          relacoes: ctxConv.relacoes
        });
      } catch (e) {
        throw mapearErroConversao(e, unidadeFicha, unidadeEstoque);
      }

      linhas.push({
        produto_id: produtoId,
        insumo_id: insumo.id,
        insumo_nome: insumo.nome,
        quantidade: round3(conv.quantidade),
        unidade: conv.unidade || unidadeEstoque,
        quantidade_ficha: qtdBruta,
        unidade_ficha: unidadeFicha,
        caminho: conv.caminho || []
      });
    }
  }
  return linhas;
}

function agregarPorInsumo(linhas) {
  const mapa = new Map();
  for (const linha of linhas) {
    const atual = mapa.get(linha.insumo_id);
    if (!atual) {
      mapa.set(linha.insumo_id, { ...linha });
    } else {
      atual.quantidade = round3(atual.quantidade + linha.quantidade);
      atual.quantidade_ficha = round3(Number(atual.quantidade_ficha) + Number(linha.quantidade_ficha));
    }
  }
  return [...mapa.values()];
}

function agregarPorProdutoInsumo(linhas) {
  const mapa = new Map();
  for (const linha of linhas) {
    const key = `${Number(linha.produto_id)}:${Number(linha.insumo_id)}`;
    const atual = mapa.get(key);
    if (!atual) {
      mapa.set(key, { ...linha });
    } else {
      atual.quantidade = round3(atual.quantidade + Number(linha.quantidade));
      atual.quantidade_ficha = round3(Number(atual.quantidade_ficha || 0) + Number(linha.quantidade_ficha || 0));
    }
  }
  return [...mapa.values()];
}

async function carregarEstornadoPorChave(db, vendaId) {
  const rows = await dbAll(
    db,
    `SELECT produto_id, insumo_id, COALESCE(SUM(quantidade), 0) AS qtd
     FROM venda_ficha_consumo_estornos
     WHERE venda_id = ?
     GROUP BY produto_id, insumo_id`,
    [vendaId]
  );
  const mapa = new Map();
  for (const r of rows) {
    mapa.set(`${Number(r.produto_id)}:${Number(r.insumo_id)}`, round3(r.qtd));
  }
  return mapa;
}

function restanteSnapshot(linha, jaMap) {
  const key = `${Number(linha.produto_id)}:${Number(linha.insumo_id)}`;
  const ja = jaMap.get(key) || 0;
  return round3(Math.max(0, round3(linha.quantidade) - ja));
}

async function registrarLinhasEstorno(db, { vendaId, empresaId, vendaDevolucaoId, origem, itens }) {
  for (const item of itens) {
    if (!(Number(item.quantidade) > 0)) continue;
    await dbRun(
      db,
      `INSERT INTO venda_ficha_consumo_estornos
        (venda_id, empresa_id, venda_devolucao_id, origem, produto_id, insumo_id, quantidade, unidade)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        vendaId,
        empresaId,
        vendaDevolucaoId != null ? vendaDevolucaoId : null,
        origem,
        item.produto_id != null ? item.produto_id : null,
        item.insumo_id,
        item.quantidade,
        item.unidade || 'UN'
      ]
    );
  }
}

async function creditarInsumosEstorno(db, empresaId, usuarioId, origem, itens, creditarFn) {
  const creditados = [];
  for (const item of itens) {
    const qtd = round3(item.quantidade);
    if (!(qtd > 0)) continue;
    await creditoAsync(db, {
      produtoId: item.insumo_id,
      quantidadeFiscal: qtd,
      quantidadeNaoFiscal: 0,
      empresaId,
      usuarioId,
      exigirEmpresa: true,
      origem
    }, creditarFn);
    creditados.push({
      produto_id: item.produto_id,
      insumo_id: item.insumo_id,
      quantidade: qtd,
      unidade: item.unidade
    });
  }
  return creditados;
}

async function validarEstoqueAgregado(db, empresaId, agregados) {
  for (const item of agregados) {
    const saldo = await estoqueSaldosPublico.consultarSaldo(item.insumo_id, {
      db,
      empresaId,
      legado: false
    });
    const disponivel = round3(Number(saldo.saldo_fiscal || 0) + Number(saldo.saldo_nao_fiscal || 0));
    if (disponivel + 1e-9 < item.quantidade) {
      throw erroConsumo(
        'SALDO_INSUFICIENTE',
        `Estoque insuficiente do insumo ${item.insumo_nome || item.insumo_id}.`,
        400,
        { insumo_id: item.insumo_id, disponivel }
      );
    }
    item._saldo_fiscal = Number(saldo.saldo_fiscal || 0);
    item._saldo_nao_fiscal = Number(saldo.saldo_nao_fiscal || 0);
  }
}

/**
 * @param {{ vendaId: number, empresaId: number, itens: Array, db: object, usuarioId?: number }} params
 */
async function consumirFichaTecnicaDaVenda(params = {}) {
  const db = params.db;
  if (!db) {
    throw erroConsumo('DB_OBRIGATORIO', 'db é obrigatório para consumo de ficha técnica.');
  }

  const vendaId = Number(params.vendaId != null ? params.vendaId : params.venda_id);
  if (!Number.isInteger(vendaId) || vendaId <= 0) {
    throw erroConsumo('VENDA_INVALIDA', 'vendaId é obrigatório para consumo de ficha técnica.');
  }

  const empresaId = resolverEmpresaDoConsumo(params.empresaId != null ? params.empresaId : params.empresa_id);
  await garantirSchemaVendaFichaConsumoAsync(db);

  const jaConsumiu = await dbGet(db, 'SELECT id FROM venda_ficha_consumo WHERE venda_id = ?', [vendaId]);
  if (jaConsumiu) {
    return { venda_id: vendaId, empresa_id: empresaId, duplicado: false, ja_consumido: true, itens: [] };
  }

  const linhas = await montarLinhasConsumo(params.itens || [], db);
  if (linhas.length === 0) {
    return { venda_id: vendaId, empresa_id: empresaId, consumido: false, itens: [] };
  }

  const agregados = agregarPorInsumo(linhas);
  await validarEstoqueAgregado(db, empresaId, agregados);

  for (const item of agregados) {
    const qtd = item.quantidade;
    const qFiscal = Math.min(item._saldo_fiscal, qtd);
    const qNao = round3(qtd - qFiscal);
    await debitoAsync(db, {
      produtoId: item.insumo_id,
      quantidadeFiscal: qFiscal > 0 ? qFiscal : 0,
      quantidadeNaoFiscal: qNao > 0 ? qNao : 0,
      empresaId,
      usuarioId: params.usuarioId,
      exigirEmpresa: true,
      origem: 'consumo_ficha_tecnica'
    });
  }

  await dbRun(
    db,
    `INSERT INTO venda_ficha_consumo (venda_id, empresa_id) VALUES (?, ?)`,
    [vendaId, empresaId]
  );
  for (const linha of linhas) {
    await dbRun(
      db,
      `INSERT INTO venda_ficha_consumo_itens
        (venda_id, empresa_id, produto_id, insumo_id, quantidade, unidade, quantidade_ficha, unidade_ficha)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        vendaId,
        empresaId,
        linha.produto_id,
        linha.insumo_id,
        linha.quantidade,
        linha.unidade,
        linha.quantidade_ficha,
        linha.unidade_ficha
      ]
    );
  }

  return {
    venda_id: vendaId,
    empresa_id: empresaId,
    consumido: true,
    itens: agregados.map((i) => ({
      insumo_id: i.insumo_id,
      quantidade: i.quantidade,
      unidade: i.unidade
    }))
  };
}

/**
 * Estorno total do snapshot de consumo (Sprint 03.07).
 * Fonte: venda_ficha_consumo_itens.quantidade / unidade / insumo_id.
 * Empresa: cabeçalho (= vendas.empresa_id). Não relê a ficha vigente.
 * Idempotente: venda_ficha_consumo.estornado_em.
 */
async function estornarConsumoFichaTecnicaDaVenda(params = {}, deps = {}) {
  const db = params.db;
  if (!db) {
    throw erroConsumo('DB_OBRIGATORIO', 'db é obrigatório para estorno de ficha técnica.');
  }

  const vendaId = Number(params.vendaId != null ? params.vendaId : params.venda_id);
  if (!Number.isInteger(vendaId) || vendaId <= 0) {
    throw erroConsumo('VENDA_INVALIDA', 'vendaId é obrigatório para estorno de ficha técnica.');
  }

  const empresaId = resolverEmpresaDoConsumo(params.empresaId != null ? params.empresaId : params.empresa_id);
  await garantirSchemaVendaFichaConsumoAsync(db);

  const cab = await dbGet(db, 'SELECT * FROM venda_ficha_consumo WHERE venda_id = ?', [vendaId]);
  if (!cab) {
    return {
      venda_id: vendaId,
      empresa_id: empresaId,
      estornado: false,
      sem_consumo: true,
      itens: []
    };
  }

  if (Number(cab.empresa_id) !== Number(empresaId)) {
    throw erroConsumo(
      'FICHA_CONSUMO_EMPRESA_DIVERGENTE',
      'Consumo da ficha não pertence à empresa da venda.',
      409,
      { venda_id: vendaId, empresa_id_consumo: cab.empresa_id, empresa_id: empresaId }
    );
  }

  if (cab.estornado_em) {
    return {
      venda_id: vendaId,
      empresa_id: empresaId,
      estornado: false,
      ja_estornado: true,
      itens: []
    };
  }

  const linhas = await dbAll(
    db,
    `SELECT produto_id, insumo_id, quantidade, unidade, empresa_id
     FROM venda_ficha_consumo_itens
     WHERE venda_id = ?`,
    [vendaId]
  );

  for (const linha of linhas) {
    if (Number(linha.empresa_id) !== Number(empresaId)) {
      throw erroConsumo(
        'FICHA_CONSUMO_EMPRESA_DIVERGENTE',
        'Item de consumo da ficha com empresa divergente da venda.',
        409,
        { venda_id: vendaId, insumo_id: linha.insumo_id }
      );
    }
  }

  const agregados = agregarPorProdutoInsumo(
    (linhas || []).map((l) => ({
      produto_id: Number(l.produto_id),
      insumo_id: Number(l.insumo_id),
      quantidade: Number(l.quantidade),
      unidade: l.unidade,
      quantidade_ficha: 0
    }))
  );
  const jaMap = await carregarEstornadoPorChave(db, vendaId);
  const aCreditar = agregados
    .map((item) => ({ ...item, quantidade: restanteSnapshot(item, jaMap) }))
    .filter((item) => Number(item.quantidade) > 0);

  const creditarFn = deps.creditarEstoqueItemVenda || null;
  const creditados = await creditarInsumosEstorno(
    db,
    empresaId,
    params.usuarioId,
    'estorno_ficha_tecnica_cancelamento',
    aCreditar,
    creditarFn
  );
  await registrarLinhasEstorno(db, {
    vendaId,
    empresaId,
    vendaDevolucaoId: null,
    origem: 'cancelamento',
    itens: creditados
  });

  const marca = await dbRun(
    db,
    `UPDATE venda_ficha_consumo
     SET estornado_em = CURRENT_TIMESTAMP
     WHERE venda_id = ?
       AND estornado_em IS NULL`,
    [vendaId]
  );
  if (!marca.changes) {
    throw erroConsumo(
      'FICHA_ESTORNO_CONCORRENTE',
      'Estorno da ficha já registrado por outra execução.',
      409
    );
  }

  return {
    venda_id: vendaId,
    empresa_id: empresaId,
    estornado: creditados.length > 0,
    sem_consumo: false,
    itens: creditados
  };
}

/**
 * Estorno proporcional na devolução (Sprint 03.08).
 * frac = quantidadeDevolvida / quantidadeVendida (produto comercial da venda).
 * Teto: soma dos estornos <= snapshot. Idempotente por venda_devolucao_id.
 */
async function estornarConsumoFichaTecnicaDaDevolucao(params = {}, deps = {}) {
  const db = params.db;
  if (!db) {
    throw erroConsumo('DB_OBRIGATORIO', 'db é obrigatório para estorno proporcional da ficha.');
  }

  const vendaId = Number(params.vendaId != null ? params.vendaId : params.venda_id);
  if (!Number.isInteger(vendaId) || vendaId <= 0) {
    throw erroConsumo('VENDA_INVALIDA', 'vendaId é obrigatório para estorno proporcional da ficha.');
  }

  const empresaId = resolverEmpresaDoConsumo(params.empresaId != null ? params.empresaId : params.empresa_id);
  const produtoId = Number(params.produtoId != null ? params.produtoId : params.produto_id);
  const qtdDev = Number(params.quantidadeDevolvida != null ? params.quantidadeDevolvida : params.quantidade);
  const vendaDevolucaoId = Number(
    params.vendaDevolucaoId != null ? params.vendaDevolucaoId : params.venda_devolucao_id
  );

  await garantirSchemaVendaFichaConsumoAsync(db);

  const cab = await dbGet(db, 'SELECT * FROM venda_ficha_consumo WHERE venda_id = ?', [vendaId]);
  if (!cab) {
    return {
      venda_id: vendaId,
      empresa_id: empresaId,
      estornado: false,
      sem_consumo: true,
      itens: []
    };
  }

  if (Number(cab.empresa_id) !== Number(empresaId)) {
    throw erroConsumo(
      'FICHA_CONSUMO_EMPRESA_DIVERGENTE',
      'Consumo da ficha não pertence à empresa da venda.',
      409,
      { venda_id: vendaId, empresa_id_consumo: cab.empresa_id, empresa_id: empresaId }
    );
  }

  if (cab.estornado_em) {
    return {
      venda_id: vendaId,
      empresa_id: empresaId,
      estornado: false,
      ja_estornado: true,
      itens: []
    };
  }

  if (Number.isInteger(vendaDevolucaoId) && vendaDevolucaoId > 0) {
    const jaDev = await dbGet(
      db,
      `SELECT id FROM venda_ficha_consumo_estornos
       WHERE venda_devolucao_id = ? LIMIT 1`,
      [vendaDevolucaoId]
    );
    if (jaDev) {
      return {
        venda_id: vendaId,
        empresa_id: empresaId,
        estornado: false,
        ja_estornado: true,
        itens: []
      };
    }
  }

  if (!Number.isInteger(produtoId) || produtoId <= 0 || !(qtdDev > 0)) {
    return {
      venda_id: vendaId,
      empresa_id: empresaId,
      estornado: false,
      sem_consumo: false,
      itens: []
    };
  }

  let qtdVendida = Number(params.quantidadeVendida != null ? params.quantidadeVendida : params.quantidade_vendida);
  if (!(qtdVendida > 0)) {
    const rowVend = await dbGet(
      db,
      `SELECT COALESCE(SUM(quantidade), 0) AS qtd
       FROM vendas_itens
       WHERE venda_id = ? AND produto_id = ?`,
      [vendaId, produtoId]
    );
    qtdVendida = Number(rowVend && rowVend.qtd) || 0;
  }
  if (!(qtdVendida > 0)) {
    throw erroConsumo(
      'FICHA_DEVOLUCAO_SEM_QTD_VENDIDA',
      'Quantidade vendida do produto é obrigatória para estorno proporcional da ficha.'
    );
  }

  const linhas = await dbAll(
    db,
    `SELECT produto_id, insumo_id, quantidade, unidade, empresa_id
     FROM venda_ficha_consumo_itens
     WHERE venda_id = ? AND produto_id = ?`,
    [vendaId, produtoId]
  );

  if (!linhas.length) {
    return {
      venda_id: vendaId,
      empresa_id: empresaId,
      estornado: false,
      sem_consumo_produto: true,
      itens: []
    };
  }

  for (const linha of linhas) {
    if (Number(linha.empresa_id) !== Number(empresaId)) {
      throw erroConsumo(
        'FICHA_CONSUMO_EMPRESA_DIVERGENTE',
        'Item de consumo da ficha com empresa divergente da venda.',
        409,
        { venda_id: vendaId, insumo_id: linha.insumo_id }
      );
    }
  }

  const frac = Math.min(1, qtdDev / qtdVendida);
  const agregados = agregarPorProdutoInsumo(
    linhas.map((l) => ({
      produto_id: Number(l.produto_id),
      insumo_id: Number(l.insumo_id),
      quantidade: Number(l.quantidade),
      unidade: l.unidade,
      quantidade_ficha: 0
    }))
  );
  const jaMap = await carregarEstornadoPorChave(db, vendaId);
  const aCreditar = [];
  for (const item of agregados) {
    const resto = restanteSnapshot(item, jaMap);
    const bruto = round3(round3(item.quantidade) * frac);
    const qtd = round3(Math.min(bruto, resto));
    if (qtd > 0) {
      aCreditar.push({ ...item, quantidade: qtd });
    }
  }

  const creditarFn = deps.creditarEstoqueItemVenda || null;
  const creditados = await creditarInsumosEstorno(
    db,
    empresaId,
    params.usuarioId,
    'estorno_ficha_tecnica_devolucao',
    aCreditar,
    creditarFn
  );
  await registrarLinhasEstorno(db, {
    vendaId,
    empresaId,
    vendaDevolucaoId: Number.isInteger(vendaDevolucaoId) && vendaDevolucaoId > 0 ? vendaDevolucaoId : null,
    origem: 'devolucao',
    itens: creditados
  });

  return {
    venda_id: vendaId,
    empresa_id: empresaId,
    estornado: creditados.length > 0,
    fracao: frac,
    itens: creditados
  };
}

function consumirFichaTecnicaDaVendaCb(params, callback) {
  if (typeof callback !== 'function') {
    throw new Error('consumirFichaTecnicaDaVendaCb: callback obrigatório');
  }
  consumirFichaTecnicaDaVenda(params).then(
    (result) => callback(null, result),
    (err) => callback(err)
  );
}

function estornarConsumoFichaTecnicaDaVendaCb(params, callback, deps) {
  if (typeof callback !== 'function') {
    throw new Error('estornarConsumoFichaTecnicaDaVendaCb: callback obrigatório');
  }
  estornarConsumoFichaTecnicaDaVenda(params, deps).then(
    (result) => callback(null, result),
    (err) => callback(err)
  );
}

function estornarConsumoFichaTecnicaDaDevolucaoCb(params, callback, deps) {
  if (typeof callback !== 'function') {
    throw new Error('estornarConsumoFichaTecnicaDaDevolucaoCb: callback obrigatório');
  }
  estornarConsumoFichaTecnicaDaDevolucao(params, deps).then(
    (result) => callback(null, result),
    (err) => callback(err)
  );
}

module.exports = {
  consumirFichaTecnicaDaVenda,
  consumirFichaTecnicaDaVendaCb,
  estornarConsumoFichaTecnicaDaVenda,
  estornarConsumoFichaTecnicaDaVendaCb,
  estornarConsumoFichaTecnicaDaDevolucao,
  estornarConsumoFichaTecnicaDaDevolucaoCb,
  montarLinhasConsumo,
  agregarPorInsumo,
  converterQuantidadeFichaParaEstoque
};
