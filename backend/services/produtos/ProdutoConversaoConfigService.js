/**
 * MUC-03 — Configuração de conversão no cadastro de produto.
 * Valida e persiste regras; o cálculo permanece no MUC.
 * @module services/produtos/ProdutoConversaoConfigService
 */
'use strict';

const { converterQuantidade, CODIGOS } = require('../../motores/muc/core/MotorConversaoQuantidade');
const {
  isUnidadeConhecida,
  normalizarUnidade,
  EMBALAGEM,
  familiasFisicasIncompativeis
} = require('../../motores/muc/core/unidadesSi');
const { tipoParaUnidadeComercial } = require('../../motores/muc/constants/tiposApresentacao');
const { garantirSchemaProdutoConversaoAsync } = require('./produtoConversaoSchema');

function erroConv(code, message, statusCode = 400) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

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
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function flagUtiliza(valor) {
  return valor === true || valor === 'SIM' || valor === 'sim' || Number(valor) === 1;
}

function normalizarRelacaoInput(raw = {}) {
  const origem = normalizarUnidade(raw.unidade_origem || raw.de || raw.origem);
  const destino = normalizarUnidade(raw.unidade_destino || raw.para || raw.destino);
  const fator = Number(raw.fator ?? raw.quantidade);
  return { unidade_origem: origem, unidade_destino: destino, fator };
}

function relacoesDeApresentacoes(apresentacoes) {
  const rel = [];
  for (const ap of apresentacoes || []) {
    if (Number(ap.ativa ?? 1) === 0) continue;
    const de = tipoParaUnidadeComercial(ap.tipo || ap.unidadeComercial);
    const para = normalizarUnidade(ap.unidade);
    const fator = Number(ap.quantidade);
    if (de && para && fator > 0 && de !== para) {
      rel.push({ de, para, fator });
    }
  }
  return rel;
}

function montarRelacoesMuc(apresentacoes, relacoesSi) {
  const rel = relacoesDeApresentacoes(apresentacoes);
  for (const r of relacoesSi || []) {
    const n = r.de ? r : { de: r.unidade_origem, para: r.unidade_destino, fator: r.fator };
    if (n.de && n.para && Number(n.fator) > 0 && n.de !== n.para) {
      rel.push({ de: n.de, para: n.para, fator: Number(n.fator) });
    }
  }
  return rel;
}

function validarRelacaoSi(rel) {
  const n = normalizarRelacaoInput(rel);
  if (!n.unidade_origem || !n.unidade_destino) {
    throw erroConv('UNIDADE_INVALIDA', 'Unidade da relação inválida ou vazia.');
  }
  if (!isUnidadeConhecida(n.unidade_origem) || !isUnidadeConhecida(n.unidade_destino)) {
    throw erroConv('UNIDADE_INVALIDA', `Unidade inválida: ${rel.unidade_origem} → ${rel.unidade_destino}.`);
  }
  if (!(n.fator > 0) || !Number.isFinite(n.fator)) {
    if (n.fator === 0) {
      throw erroConv('FATOR_INVALIDO', 'Fator de conversão deve ser maior que zero.');
    }
    throw erroConv('FATOR_INVALIDO', 'Fator de conversão não pode ser negativo nem nulo.');
  }
  if (n.unidade_origem === n.unidade_destino) {
    throw erroConv('RELACAO_INVALIDA', 'Origem e destino da relação devem ser diferentes.');
  }
  if (EMBALAGEM.includes(n.unidade_origem)) {
    throw erroConv(
      'RELACAO_INVALIDA',
      `A apresentação comercial (${n.unidade_origem}) não deve ser gravada como relação SI. Use apresentações (ex.: 1 CAIXA = 12 UN) e uma relação de conteúdo (ex.: 1 UN = 2.000 ML).`
    );
  }
  if (familiasFisicasIncompativeis(n.unidade_origem, n.unidade_destino)) {
    throw erroConv('CONVERSAO_INVALIDA', `Conversão inválida: ${n.unidade_origem} → ${n.unidade_destino}.`);
  }
  try {
    converterQuantidade({
      quantidade: 1,
      unidadeOrigem: n.unidade_origem,
      unidadeDestino: n.unidade_destino,
      relacoes: [{ de: n.unidade_origem, para: n.unidade_destino, fator: n.fator }]
    });
  } catch (e) {
    throw erroConv(e.code || 'CONVERSAO_INVALIDA', e.message);
  }
  return n;
}

function validarConfiguracao({ utilizaConversao, unidadeEstoque, apresentacoes, relacoes }) {
  if (!utilizaConversao) {
    return { utiliza_conversao: 0, unidade_estoque: null, relacoes: [] };
  }
  const dest = normalizarUnidade(unidadeEstoque);
  if (!dest || !isUnidadeConhecida(dest)) {
    throw erroConv('UNIDADE_ESTOQUE_OBRIGATORIA', 'Informe uma unidade de estoque válida.');
  }

  const relacoesOk = (relacoes || []).map(validarRelacaoSi);
  const apresentacoesAtivas = (apresentacoes || []).filter((ap) => Number(ap.ativa ?? 1) === 1);
  for (const ap of apresentacoesAtivas) {
    const fator = Number(ap.quantidade);
    if (!(fator > 0)) {
      throw erroConv('FATOR_INVALIDO', 'Quantidade da apresentação deve ser maior que zero.');
    }
    if (!isUnidadeConhecida(ap.unidade) && !ap.unidade) {
      throw erroConv('UNIDADE_INVALIDA', 'Unidade da apresentação inválida.');
    }
  }

  const relMuc = montarRelacoesMuc(apresentacoesAtivas, relacoesOk);
  const origensCompra = apresentacoesAtivas
    .filter((ap) => Number(ap.compra ?? 1) === 1)
    .map((ap) => tipoParaUnidadeComercial(ap.tipo));

  const aValidar = origensCompra.length
    ? origensCompra
    : relacoesOk.map((r) => r.unidade_origem);
  for (const origem of aValidar) {
    if (!origem || origem === dest) continue;
    try {
      converterQuantidade({
        quantidade: 1,
        unidadeOrigem: origem,
        unidadeDestino: dest,
        relacoes: relMuc
      });
    } catch (e) {
      if (e.code === CODIGOS.CONVERSAO_NAO_DISPONIVEL) {
        throw erroConv(
          'CONVERSAO_NAO_DISPONIVEL',
          `Não existe uma relação cadastrada para converter ${origem} em ${dest}.`
        );
      }
      throw erroConv(e.code || 'CONVERSAO_INVALIDA', e.message);
    }
  }

  return {
    utiliza_conversao: 1,
    unidade_estoque: dest,
    relacoes: relacoesOk
  };
}

async function listarRelacoes(db, produtoId) {
  await garantirSchemaProdutoConversaoAsync(db);
  const rows = await dbAll(
    db,
    `SELECT id, produto_id, unidade_origem, unidade_destino, fator
     FROM muc_produto_relacoes WHERE produto_id = ? ORDER BY id ASC`,
    [Number(produtoId)]
  );
  return rows.map((r) => ({
    id: r.id,
    de: r.unidade_origem,
    para: r.unidade_destino,
    fator: Number(r.fator),
    unidade_origem: r.unidade_origem,
    unidade_destino: r.unidade_destino
  }));
}

function listarRelacoesCb(db, produtoId, callback) {
  listarRelacoes(db, produtoId).then(
    (rows) => callback(null, rows),
    (err) => callback(err)
  );
}

async function obterConfiguracao(db, produtoId) {
  await garantirSchemaProdutoConversaoAsync(db);
  const produto = await dbGet(
    db,
    `SELECT id, unidade, COALESCE(utiliza_conversao, 0) AS utiliza_conversao, unidade_estoque
     FROM produtos WHERE id = ?`,
    [Number(produtoId)]
  );
  if (!produto) throw erroConv('PRODUTO_INEXISTENTE', 'Produto não encontrado.', 404);
  const relacoes = await listarRelacoes(db, produtoId);
  return {
    produto_id: produto.id,
    utiliza_conversao: Number(produto.utiliza_conversao) === 1 ? 1 : 0,
    unidade_estoque: produto.unidade_estoque || (Number(produto.utiliza_conversao) === 1 ? produto.unidade : null),
    unidade: produto.unidade,
    relacoes
  };
}

async function salvarConfiguracao(db, produtoId, payload = {}, opcoes = {}) {
  await garantirSchemaProdutoConversaoAsync(db);
  const produto = await dbGet(db, 'SELECT id, unidade FROM produtos WHERE id = ?', [Number(produtoId)]);
  if (!produto) throw erroConv('PRODUTO_INEXISTENTE', 'Produto não encontrado.', 404);

  const utiliza = flagUtiliza(payload.utiliza_conversao ?? payload.utilizaConversao);
  const apresentacoes = payload.apresentacoes || payload.embalagens || [];
  const relacoesIn = payload.relacoes || [];

  const validado = validarConfiguracao({
    utilizaConversao: utiliza,
    unidadeEstoque: payload.unidade_estoque || payload.unidadeEstoque || produto.unidade,
    apresentacoes,
    relacoes: relacoesIn
  });

  const unidadeEstoqueGravar = validado.utiliza_conversao === 1 ? validado.unidade_estoque : null;
  const unidadeProduto = validado.utiliza_conversao === 1
    ? validado.unidade_estoque
    : (payload.preservarUnidadeProduto ? produto.unidade : (payload.unidade || produto.unidade));

  await dbRun(
    db,
    `UPDATE produtos SET
       utiliza_conversao = ?,
       unidade_estoque = ?,
       unidade = COALESCE(?, unidade),
       updated_at = datetime('now', 'localtime')
     WHERE id = ?`,
    [validado.utiliza_conversao, unidadeEstoqueGravar, unidadeProduto, Number(produtoId)]
  );

  await dbRun(db, 'DELETE FROM muc_produto_relacoes WHERE produto_id = ?', [Number(produtoId)]);
  for (const r of validado.relacoes) {
    await dbRun(
      db,
      `INSERT INTO muc_produto_relacoes (produto_id, unidade_origem, unidade_destino, fator)
       VALUES (?, ?, ?, ?)`,
      [Number(produtoId), r.unidade_origem, r.unidade_destino, r.fator]
    );
  }

  const depois = await obterConfiguracao(db, produtoId);
  return {
    ...depois,
    auditoria: {
      acao: 'configurar_conversao_produto',
      produto_id: Number(produtoId),
      utiliza_conversao: validado.utiliza_conversao,
      usuario_id: opcoes.usuario?.id || null
    }
  };
}

async function excluirRelacao(db, produtoId, relacaoId, apresentacoes = []) {
  const cfg = await obterConfiguracao(db, produtoId);
  const restantes = (cfg.relacoes || []).filter((r) => Number(r.id) !== Number(relacaoId));
  if (restantes.length === cfg.relacoes.length) {
    throw erroConv('RELACAO_INEXISTENTE', 'Relação não encontrada.', 404);
  }
  if (Number(cfg.utiliza_conversao) === 1) {
    try {
      validarConfiguracao({
        utilizaConversao: true,
        unidadeEstoque: cfg.unidade_estoque,
        apresentacoes,
        relacoes: restantes
      });
    } catch (e) {
      throw erroConv(
        'RELACAO_NECESSARIA',
        e.message || 'Não é possível excluir esta relação: a configuração de conversão ficaria inconsistente.'
      );
    }
  }
  await dbRun(
    db,
    'DELETE FROM muc_produto_relacoes WHERE id = ? AND produto_id = ?',
    [Number(relacaoId), Number(produtoId)]
  );
  return obterConfiguracao(db, produtoId);
}

function simularConversaoProduto(config, entrada = {}) {
  const quantidade = Number(entrada.quantidade);
  if (!(quantidade > 0)) {
    throw erroConv('CONVERSAO_INVALIDA', 'Informe uma quantidade positiva para simular.');
  }
  const origem = normalizarUnidade(entrada.unidadeOrigem || entrada.unidade);
  const destino = normalizarUnidade(
    entrada.unidadeDestino || config.unidade_estoque || config.unidade
  );
  if (!origem || !destino) {
    throw erroConv('UNIDADE_INVALIDA', 'Informe unidades de origem e destino válidas.');
  }
  if (Number(config.utiliza_conversao) !== 1) {
    if (origem === destino) {
      return {
        quantidade,
        unidade: destino,
        caminho: [],
        mensagem: 'Produto sem conversão: a quantidade permanece na unidade do produto.'
      };
    }
    throw erroConv(
      'CONVERSAO_NAO_DISPONIVEL',
      'Este produto não utiliza conversão. Não há relação cadastrada para converter unidades.'
    );
  }
  const relacoes = montarRelacoesMuc(entrada.apresentacoes || [], config.relacoes || []);
  try {
    const r = converterQuantidade({
      quantidade,
      unidadeOrigem: origem,
      unidadeDestino: destino,
      relacoes
    });
    const unidadesCaminho = r.caminho && r.caminho.length
      ? [r.caminho[0].de, ...r.caminho.map((e) => e.para)]
      : [origem, destino].filter((u, i, arr) => arr.indexOf(u) === i);
    return {
      quantidade: r.quantidade,
      unidade: r.unidade,
      caminho: unidadesCaminho,
      etapas: r.caminho,
      fatorTotal: r.fatorTotal,
      estoqueAlterado: false
    };
  } catch (e) {
    if (e.code === CODIGOS.CONVERSAO_NAO_DISPONIVEL) {
      throw erroConv(
        'CONVERSAO_NAO_DISPONIVEL',
        `Não existe uma relação cadastrada para converter ${origem} em ${destino}.`
      );
    }
    throw erroConv(e.code || 'CONVERSAO_INVALIDA', e.message);
  }
}

module.exports = {
  flagUtiliza,
  validarConfiguracao,
  validarRelacaoSi,
  montarRelacoesMuc,
  listarRelacoes,
  listarRelacoesCb,
  obterConfiguracao,
  salvarConfiguracao,
  excluirRelacao,
  simularConversaoProduto,
  erroConv
};
