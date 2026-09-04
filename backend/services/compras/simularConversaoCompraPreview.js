/**
 * MUC-06 — Preview oficial de conversão na compra.
 * Autoridade: obterMuc(db).converterQuantidade. Sem multiplicador legado.
 * @module services/compras/simularConversaoCompraPreview
 */
'use strict';

const { obterMuc } = require('../../motores/muc/public');
const { EMBALAGEM, normalizarUnidade, isUnidadeConhecida } = require('../../motores/muc/core/unidadesSi');
const ProdutoConversaoConfigService = require('../produtos/ProdutoConversaoConfigService');

const TIPOS_EMBALAGEM = new Set(EMBALAGEM);

function erroPreview(codigo, mensagem, statusCode = 400) {
  const err = new Error(mensagem);
  err.code = codigo;
  err.statusCode = statusCode;
  return err;
}

function numPositivo(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function lerQuantidade(body = {}) {
  return numPositivo(
    body.quantidade
    ?? body.quantidadeCompra
    ?? body.quantidade_embalagens
    ?? body.quantidade_comercial
  );
}

function lerUnidadeOrigem(body = {}) {
  const raw = body.unidadeOrigem ?? body.unidade_origem ?? body.unidadeCompra ?? body.compra_em;
  return raw != null && String(raw).trim() !== '' ? String(raw).trim() : '';
}

function lerUnidadeDestino(body = {}) {
  const raw = body.unidadeDestino ?? body.unidade_destino ?? body.unidadeEstoque ?? body.unidade;
  return raw != null && String(raw).trim() !== '' ? String(raw).trim() : '';
}

function custoUnitario(valorTotal, quantidade) {
  const valor = Number(valorTotal || 0);
  if (!(valor > 0) || !(quantidade > 0)) return 0;
  return Math.round((valor / quantidade) * 10000) / 10000;
}

function formatarCaminho(quantidade, origem, destino, etapas) {
  if (!Array.isArray(etapas) || etapas.length === 0) {
    return `${quantidade} ${origem}`;
  }
  let qtd = Number(quantidade);
  const partes = [`${qtd} ${etapas[0].de || origem}`];
  for (const e of etapas) {
    qtd *= Number(e.fator) || 1;
    partes.push(`${qtd} ${e.para}`);
  }
  const ultima = partes[partes.length - 1];
  if (destino && !String(ultima).endsWith(` ${destino}`)) {
    partes.push(`${qtd} ${destino}`);
  }
  return partes.join(' → ');
}

function relacoesDoBody(body = {}) {
  const rel = [];
  for (const r of body.relacoes || []) {
    const de = normalizarUnidade(r.de || r.origem || r.unidade_origem);
    const para = normalizarUnidade(r.para || r.destino || r.unidade_destino);
    const fator = Number(r.fator ?? r.quantidade);
    if (de && para && fator > 0 && de !== para) rel.push({ de, para, fator });
  }
  return rel;
}

function relacaoEmbalagemInformada(origem, destino, quantidadePorApresentacao) {
  const fator = numPositivo(quantidadePorApresentacao);
  if (!(fator > 0) || !origem || !destino || origem === destino) return null;
  if (!TIPOS_EMBALAGEM.has(origem)) return null;
  const para = destino === 'UN' || !TIPOS_EMBALAGEM.has(destino) ? (destino === origem ? null : 'UN') : destino;
  const destRel = destino === 'UN' ? 'UN' : para;
  if (!destRel || destRel === origem) return null;
  return { de: origem, para: destRel, fator };
}

function listarApresentacoes(db, produtoId) {
  return new Promise((resolve, reject) => {
    const muc = obterMuc(db);
    if (!produtoId || !muc.apresentacoes) return resolve([]);
    muc.apresentacoes.listarPorProduto(produtoId, (err, lista) => {
      if (err) return reject(err);
      resolve(lista || []);
    });
  });
}

/**
 * @param {object} db
 * @param {object} body
 * @returns {Promise<object>}
 */
async function simularConversaoCompraPreview(db, body = {}) {
  const quantidade = lerQuantidade(body);
  if (!(quantidade > 0)) {
    throw erroPreview('QUANTIDADE_INVALIDA', 'Informe uma quantidade positiva.');
  }

  const origemRaw = lerUnidadeOrigem(body);
  const destinoRaw = lerUnidadeDestino(body);
  if (!origemRaw && !destinoRaw) {
    throw erroPreview(
      'UNIDADES_NAO_INFORMADAS',
      'Informe a unidade de origem e a unidade de destino.'
    );
  }
  if (!origemRaw) {
    throw erroPreview('UNIDADES_NAO_INFORMADAS', 'Informe a unidade de origem.');
  }
  if (!destinoRaw) {
    throw erroPreview('UNIDADES_NAO_INFORMADAS', 'Informe a unidade de destino.');
  }

  const origem = normalizarUnidade(origemRaw);
  const destino = normalizarUnidade(destinoRaw);
  if (!origem || !isUnidadeConhecida(origemRaw)) {
    throw erroPreview('UNIDADE_INVALIDA', `Unidade de origem inválida: ${origemRaw}.`);
  }
  if (!destino || !isUnidadeConhecida(destinoRaw)) {
    throw erroPreview('UNIDADE_INVALIDA', `Unidade de destino inválida: ${destinoRaw}.`);
  }

  const produtoId = Number((body.produtoId != null ? body.produtoId : body.produto_id) || 0);
  let relacoes = relacoesDoBody(body);
  let config = null;

  if (produtoId > 0) {
    try {
      config = await ProdutoConversaoConfigService.obterConfiguracao(db, produtoId);
    } catch (e) {
      if (e.code === 'PRODUTO_INEXISTENTE') {
        throw erroPreview('PRODUTO_INEXISTENTE', e.message, 404);
      }
      throw e;
    }
    const apresentacoes = await listarApresentacoes(db, produtoId);
    const doCadastro = ProdutoConversaoConfigService.montarRelacoesMuc(
      body.apresentacoes || apresentacoes,
      config.relacoes || []
    );
    relacoes = [...doCadastro, ...relacoes];

    if (Number(config.utiliza_conversao) !== 1) {
      if (origem === destino) {
        return montarResultado({
          quantidade,
          origem,
          destino,
          conv: {
            quantidade,
            unidade: destino,
            caminho: [],
            fatorTotal: 1
          },
          valorTotal: body.valorTotal ?? body.valor_total_embalagem,
          mensagem: 'Produto sem conversão: a quantidade permanece na unidade informada.'
        });
      }
      throw erroPreview(
        'CONVERSAO_NAO_DISPONIVEL',
        'Este produto não utiliza conversão. Não há relação cadastrada para converter unidades.'
      );
    }
  }

  const fatorEmb = body.quantidadePorApresentacao ?? body.quantidade_por_embalagem;
  const extraEmb = relacaoEmbalagemInformada(origem, destino, fatorEmb);
  if (extraEmb) relacoes.push(extraEmb);

  const muc = obterMuc(db);
  let conv;
  try {
    conv = muc.converterQuantidade({
      quantidade,
      unidadeOrigem: origem,
      unidadeDestino: destino,
      relacoes
    });
  } catch (e) {
    throw erroPreview(e.code || 'CONVERSAO_INVALIDA', e.message);
  }

  return montarResultado({
    quantidade,
    origem,
    destino,
    conv,
    valorTotal: body.valorTotal ?? body.valor_total_embalagem
  });
}

function montarResultado({ quantidade, origem, destino, conv, valorTotal, mensagem }) {
  const quantidadeConvertida = Number(conv.quantidade);
  const valor = Number(valorTotal || 0);
  const unitario = custoUnitario(valor, quantidadeConvertida);
  return {
    sucesso: true,
    quantidade,
    unidadeOrigem: origem,
    unidadeDestino: destino,
    quantidadeConvertida,
    quantidadeEstoque: quantidadeConvertida,
    unidade: destUnit(conv, destino),
    caminho: conv.caminho || [],
    caminhoTexto: formatarCaminho(quantidade, origem, destino, conv.caminho),
    fatorTotal: conv.fatorTotal,
    fatorConversao: conv.fatorTotal,
    custoUnitario: unitario,
    custoTotal: valor > 0 ? Math.round(valor * 100) / 100 : 0,
    subtotal: valor > 0 ? Math.round(valor * 100) / 100 : 0,
    mensagem: mensagem || null
  };
}

function destUnit(conv, destino) {
  return conv.unidade || destino;
}

module.exports = {
  simularConversaoCompraPreview,
  formatarCaminho
};
