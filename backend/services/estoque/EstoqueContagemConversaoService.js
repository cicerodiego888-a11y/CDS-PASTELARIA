/**
 * Conversão comercial → unidade-base para Contagem Física — Sprint 05.2.
 *
 * Reutiliza exclusivamente o MUC oficial:
 *   obterMuc(db).converterQuantidade + ProdutoConversaoConfigService.montarRelacoesMuc
 *
 * Não inventa fatores. Não duplica o motor de conversão.
 *
 * @module services/estoque/EstoqueContagemConversaoService
 */
'use strict';

const { roundStockQuantity } = require('./quantityPrecision');
const { obterMuc } = require('../../motores/muc/public');
const { normalizarUnidade } = require('../../motores/muc/core/unidadesSi');
const { tipoParaUnidadeComercial } = require('../../motores/muc/constants/tiposApresentacao');
const ProdutoConversaoConfigService = require('../produtos/ProdutoConversaoConfigService');
const {
  garantirSchemaProdutoConversaoAsync
} = require('../produtos/produtoConversaoSchema');

function erroConvContagem(code, message, status = 400, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  Object.assign(err, extra);
  return err;
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

async function carregarProdutoParaConversao(db, pid) {
  // Schemas de teste legados podem não ter unidade / conversão — degradar com fallback.
  const tentativas = [
    `SELECT id, nome, unidade, unidade_comercial, unidade_estoque,
            COALESCE(utiliza_conversao, 0) AS utiliza_conversao,
            COALESCE(utiliza_volume, 0) AS utiliza_volume,
            volume_valor, volume_unidade
       FROM produtos WHERE id = ?`,
    `SELECT id, nome, unidade, unidade_estoque,
            COALESCE(utiliza_conversao, 0) AS utiliza_conversao
       FROM produtos WHERE id = ?`,
    `SELECT id, nome, unidade,
            COALESCE(utiliza_conversao, 0) AS utiliza_conversao
       FROM produtos WHERE id = ?`,
    `SELECT id, nome, unidade FROM produtos WHERE id = ?`,
    `SELECT id, nome FROM produtos WHERE id = ?`
  ];
  let ultimoErroColuna = null;
  for (const sql of tentativas) {
    try {
      const row = await dbGet(db, sql, [pid]);
      if (!row) return null;
      if (row.utiliza_conversao == null) row.utiliza_conversao = 0;
      if (row.utiliza_volume == null) row.utiliza_volume = 0;
      if (row.unidade == null) row.unidade = 'UN';
      if (row.unidade_comercial == null) row.unidade_comercial = row.unidade || 'UN';
      if (row.unidade_estoque == null) row.unidade_estoque = row.unidade || null;
      return row;
    } catch (err) {
      if (!/no such column/i.test(String(err && err.message || ''))) throw err;
      ultimoErroColuna = err;
    }
  }
  if (ultimoErroColuna) throw ultimoErroColuna;
  return null;
}

async function listarApresentacoes(db, produtoId) {
  try {
    return await dbAll(
      db,
      `SELECT id, tipo, quantidade, unidade, ativa, compra, venda, principal, estoque
         FROM produto_embalagens
        WHERE produto_id = ? AND COALESCE(ativa, 1) = 1`,
      [Number(produtoId)]
    );
  } catch (err) {
    if (/no such table/i.test(String(err && err.message || ''))) return [];
    throw err;
  }
}

function resolverApresentacao(apresentacoes, opts = {}) {
  const lista = Array.isArray(apresentacoes) ? apresentacoes : [];
  if (opts.apresentacaoId != null) {
    const id = Number(opts.apresentacaoId);
    const hit = lista.find((a) => Number(a.id) === id);
    if (!hit) {
      throw erroConvContagem(
        'APRESENTACAO_NAO_ENCONTRADA',
        'A apresentação comercial informada não foi encontrada para este produto.'
      );
    }
    return hit;
  }
  const principaisVenda = lista.filter(
    (a) => Number(a.venda) === 1 && Number(a.principal) === 1
  );
  if (principaisVenda.length > 1) {
    throw erroConvContagem(
      'UNIDADE_COMERCIAL_AMBIGUA',
      'O produto possui mais de uma apresentação principal de venda. Selecione a apresentação correta.'
    );
  }
  if (principaisVenda.length === 1) return principaisVenda[0];
  const estoquePrincipal = lista.filter(
    (a) => Number(a.estoque) === 1 && Number(a.principal) === 1
  );
  if (estoquePrincipal.length === 1) return estoquePrincipal[0];
  if (lista.length === 1) return lista[0];
  return null;
}

/**
 * Converte quantidade informada na unidade comercial para a unidade-base de estoque.
 *
 * @param {object} db
 * @param {number} produtoId
 * @param {number|string} quantidadeInformada
 * @param {{ apresentacaoId?: number, unidadeOrigem?: string }} [opts]
 * @returns {Promise<object>}
 */
async function converterQuantidadeContagem(db, produtoId, quantidadeInformada, opts = {}) {
  if (!db) throw erroConvContagem('DB_OBRIGATORIO', 'db é obrigatório.', 500);
  const pid = Number(produtoId);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw erroConvContagem('PRODUTO_INVALIDO', 'produto_id inválido.');
  }

  const qtd = Number(quantidadeInformada);
  if (!Number.isFinite(qtd) || qtd < 0) {
    throw erroConvContagem(
      'QUANTIDADE_CONTAGEM_INVALIDA',
      'Quantidade informada deve ser um número maior ou igual a zero.'
    );
  }

  await garantirSchemaProdutoConversaoAsync(db).catch(() => {});

  // Zero físico: não chama MUC (motor exige quantidade positiva).
  if (qtd === 0) {
    const metaZero = await obterMetadadosConversaoProduto(db, pid).catch(() => null);
    const unBase = (metaZero && metaZero.unidade_base)
      || (metaZero && metaZero.unidade_comercial)
      || 'UN';
    const unInf = (metaZero && metaZero.unidade_comercial) || 'UN';
    return {
      produto_id: pid,
      quantidade_informada: 0,
      unidade_informada: unInf,
      quantidade_convertida: 0,
      unidade_base: unBase,
      fator_total: metaZero && metaZero.fator_conversao != null ? Number(metaZero.fator_conversao) : 1,
      caminho: [],
      utiliza_conversao: !!(metaZero && metaZero.utiliza_conversao),
      apresentacao_id: metaZero && metaZero.apresentacao_id != null ? metaZero.apresentacao_id : null,
      mensagem_conversao: `0 ${unInf} = 0 ${unBase}`
    };
  }

  let produto = await carregarProdutoParaConversao(db, pid);
  if (!produto) {
    throw erroConvContagem('PRODUTO_NAO_ENCONTRADO', `Produto ${pid} não encontrado.`, 404);
  }

  const utilizaFlagProduto = Number(produto.utiliza_conversao) === 1;
  const usaVolume = Number(produto.utiliza_volume) === 1;

  // Identidade sem MUC: produto sem conversão/volume (schemas legados sem coluna unidade).
  if (!utilizaFlagProduto && !usaVolume) {
    const un = normalizarUnidade(
      opts.unidadeOrigem
        || produto.unidade_comercial
        || produto.unidade
        || produto.unidade_estoque
        || 'UN'
    );
    const qBase = roundStockQuantity(qtd);
    return {
      produto_id: pid,
      quantidade_informada: roundStockQuantity(qtd),
      unidade_informada: un,
      quantidade_convertida: qBase,
      unidade_base: un,
      fator_total: 1,
      caminho: [],
      utiliza_conversao: false,
      apresentacao_id: null,
      mensagem_conversao: `${qBase} ${un}`
    };
  }

  let config;
  try {
    config = await ProdutoConversaoConfigService.obterConfiguracao(db, pid);
  } catch (err) {
    if (err && err.code === 'PRODUTO_INEXISTENTE') {
      throw erroConvContagem('PRODUTO_NAO_ENCONTRADO', err.message, 404);
    }
    throw err;
  }

  const utilizaConversao = Number(config.utiliza_conversao) === 1;
  const unidadeDestino = normalizarUnidade(
    config.unidade_estoque || config.unidade || produto.unidade || produto.unidade_comercial || 'UN'
  );

  let unidadeOrigem = normalizarUnidade(
    opts.unidadeOrigem
      || produto.unidade_comercial
      || produto.unidade
      || 'UN'
  );
  let quantidadeOrigem = qtd;
  let apresentacao = null;
  let fatorApresentacao = null;

  const apresentacoes = (utilizaConversao || usaVolume)
    ? await listarApresentacoes(db, pid)
    : [];

  if (usaVolume) {
    const volume = Number(produto.volume_valor);
    unidadeOrigem = normalizarUnidade(produto.volume_unidade);
    if (!(volume > 0) || !unidadeOrigem) {
      throw erroConvContagem(
        'CONVERSAO_PRODUTO_INCOMPLETA',
        `A conversão do produto "${produto.nome || pid}" precisa ser revisada no cadastro (volume comercial incompleto).`
      );
    }
    quantidadeOrigem = roundStockQuantity(qtd * volume);
    fatorApresentacao = volume;
  } else if (utilizaConversao) {
    apresentacao = resolverApresentacao(apresentacoes, opts);
    if (apresentacao) {
      unidadeOrigem = normalizarUnidade(tipoParaUnidadeComercial(apresentacao.tipo));
      fatorApresentacao = Number(apresentacao.quantidade);
      const unidadeConteudo = normalizarUnidade(apresentacao.unidade);
      // Apresentação direta (ex.: 1 UN = 1.500 ML): aplica o fator da apresentação selecionada.
      if (
        unidadeConteudo
        && unidadeConteudo === unidadeDestino
        && Number.isFinite(fatorApresentacao)
        && fatorApresentacao > 0
      ) {
        const qConvertida = roundStockQuantity(qtd * fatorApresentacao);
        return {
          produto_id: pid,
          quantidade_informada: roundStockQuantity(qtd),
          unidade_informada: unidadeOrigem,
          quantidade_convertida: qConvertida,
          unidade_base: unidadeDestino,
          fator_total: fatorApresentacao,
          caminho: [{ de: unidadeOrigem, para: unidadeDestino, fator: fatorApresentacao, origem: 'APRESENTACAO' }],
          utiliza_conversao: true,
          apresentacao_id: apresentacao.id != null ? Number(apresentacao.id) : null,
          mensagem_conversao: `${roundStockQuantity(qtd)} ${unidadeOrigem} × ${formatarFator(fatorApresentacao)} ${unidadeDestino} = ${qConvertida} ${unidadeDestino}`
        };
      }
    } else if (opts.unidadeOrigem) {
      unidadeOrigem = normalizarUnidade(opts.unidadeOrigem);
    } else {
      unidadeOrigem = normalizarUnidade(produto.unidade_comercial || 'UN');
    }
  }

  if (!unidadeOrigem || !unidadeDestino) {
    throw erroConvContagem(
      'CONVERSAO_PRODUTO_INCOMPLETA',
      `A conversão do produto "${produto.nome || pid}" precisa ser revisada no cadastro (unidades indefinidas).`
    );
  }

  // Sem conversão cadastrada e mesma unidade → identidade.
  if (!utilizaConversao && !usaVolume) {
    const qBase = roundStockQuantity(qtd);
    return {
      produto_id: pid,
      quantidade_informada: roundStockQuantity(qtd),
      unidade_informada: unidadeOrigem,
      quantidade_convertida: qBase,
      unidade_base: unidadeDestino || unidadeOrigem,
      fator_total: 1,
      caminho: [],
      utiliza_conversao: false,
      apresentacao_id: null,
      mensagem_conversao: `${qBase} ${unidadeDestino || unidadeOrigem}`
    };
  }

  if (unidadeOrigem === unidadeDestino) {
    const qBase = roundStockQuantity(quantidadeOrigem);
    return {
      produto_id: pid,
      quantidade_informada: roundStockQuantity(qtd),
      unidade_informada: unidadeOrigem,
      quantidade_convertida: qBase,
      unidade_base: unidadeDestino,
      fator_total: usaVolume ? Number(fatorApresentacao) : 1,
      caminho: [],
      utiliza_conversao: utilizaConversao || usaVolume,
      apresentacao_id: apresentacao && apresentacao.id != null ? Number(apresentacao.id) : null,
      mensagem_conversao: usaVolume
        ? `${roundStockQuantity(qtd)} × ${fatorApresentacao} ${unidadeDestino} = ${qBase} ${unidadeDestino}`
        : `${qBase} ${unidadeDestino}`
    };
  }

  const relacoes = ProdutoConversaoConfigService.montarRelacoesMuc(
    apresentacoes,
    utilizaConversao ? (config.relacoes || []) : []
  );

  if (!relacoes.length) {
    throw erroConvContagem(
      'CONVERSAO_PRODUTO_INCOMPLETA',
      `A conversão do produto "${produto.nome || pid}" precisa ser revisada no cadastro (fator/relação ausente).`
    );
  }

  let convertido;
  try {
    convertido = obterMuc(db).converterQuantidade({
      quantidade: quantidadeOrigem,
      unidadeOrigem,
      unidadeDestino,
      relacoes
    });
  } catch (err) {
    throw erroConvContagem(
      err && err.code === 'CONVERSAO_INVALIDA'
        ? 'CONVERSAO_PRODUTO_INCOMPLETA'
        : (err && err.code ? err.code : 'CONVERSAO_PRODUTO_INCOMPLETA'),
      `A conversão do produto "${produto.nome || pid}" precisa ser revisada no cadastro: ${err && err.message ? err.message : 'relação indisponível'}.`
    );
  }

  const qConvertida = roundStockQuantity(convertido.quantidade);
  const fatorTotal = Number(convertido.fatorTotal != null ? convertido.fatorTotal : (qtd > 0 ? qConvertida / qtd : 1));
  const mensagem = `${roundStockQuantity(qtd)} ${unidadeOrigem} × ${formatarFator(fatorTotal)} ${unidadeDestino}/${unidadeOrigem} = ${qConvertida} ${unidadeDestino}`;

  return {
    produto_id: pid,
    quantidade_informada: roundStockQuantity(qtd),
    unidade_informada: unidadeOrigem,
    quantidade_convertida: qConvertida,
    unidade_base: convertido.unidade || unidadeDestino,
    fator_total: fatorTotal,
    caminho: Array.isArray(convertido.caminho) ? convertido.caminho : [],
    utiliza_conversao: true,
    apresentacao_id: apresentacao && apresentacao.id != null ? Number(apresentacao.id) : null,
    mensagem_conversao: mensagem
  };
}

function formatarFator(fator) {
  const n = Number(fator);
  if (!Number.isFinite(n)) return String(fator);
  if (Number.isInteger(n)) return String(n);
  return String(roundStockQuantity(n));
}

/**
 * Metadados de unidade/conversão para a busca da Contagem (somente leitura).
 */
async function obterMetadadosConversaoProduto(db, produtoId) {
  const pid = Number(produtoId);
  await garantirSchemaProdutoConversaoAsync(db).catch(() => {});
  const produto = await carregarProdutoParaConversao(db, pid);
  if (!produto) return null;

  let config = {
    utiliza_conversao: Number(produto.utiliza_conversao) === 1 ? 1 : 0,
    unidade_estoque: produto.unidade_estoque || null,
    unidade: produto.unidade,
    relacoes: []
  };
  try {
    config = await ProdutoConversaoConfigService.obterConfiguracao(db, pid);
  } catch (_) { /* mantém fallback */ }

  const apresentacoes = Number(config.utiliza_conversao) === 1
    ? await listarApresentacoes(db, pid)
    : [];
  const apresentacao = resolverApresentacao(apresentacoes, {}) || null;
  const unidadeComercial = apresentacao
    ? tipoParaUnidadeComercial(apresentacao.tipo)
    : normalizarUnidade(produto.unidade_comercial || produto.unidade || 'UN');
  const unidadeBase = normalizarUnidade(
    config.unidade_estoque || config.unidade || produto.unidade || unidadeComercial
  );

  let fator = null;
  if (apresentacao && Number(apresentacao.quantidade) > 0) {
    fator = Number(apresentacao.quantidade);
  } else if (Number(produto.utiliza_volume) === 1 && Number(produto.volume_valor) > 0) {
    fator = Number(produto.volume_valor);
  } else if (Number(config.utiliza_conversao) === 1 && Array.isArray(config.relacoes)) {
    const rel = config.relacoes.find(
      (r) => normalizarUnidade(r.de || r.unidade_origem) === unidadeComercial
        && normalizarUnidade(r.para || r.unidade_destino) === unidadeBase
    );
    if (rel) fator = Number(rel.fator);
  }

  return {
    produto_id: pid,
    unidade_comercial: unidadeComercial,
    unidade_base: unidadeBase,
    utiliza_conversao: Number(config.utiliza_conversao) === 1,
    fator_conversao: fator,
    apresentacao_id: apresentacao && apresentacao.id != null ? Number(apresentacao.id) : null
  };
}

module.exports = {
  converterQuantidadeContagem,
  obterMetadadosConversaoProduto,
  listarApresentacoes,
  resolverApresentacao
};
