/**
 * MUC-07 — Resolução do estoque inicial na importação.
 * MUC quando origem+destino forem explícitos e o caminho existir.
 * fator_conversao só como compatibilidade, nunca após o MUC.
 * @module services/importacao-inicial-produtos/resolverEstoqueInicialImportacao
 */
'use strict';

const { obterMuc } = require('../../motores/muc/public');
const { normalizarUnidade, isUnidadeConhecida } = require('../../motores/muc/core/unidadesSi');
const { CODIGOS } = require('../../motores/muc/core/MotorConversaoQuantidade');
const ProdutoConversaoConfigService = require('../produtos/ProdutoConversaoConfigService');

const ORIGEM_CALCULO = Object.freeze({
  MUC: 'MUC',
  FATOR_CONVERSAO: 'FATOR_CONVERSAO'
});

const MODO = Object.freeze({
  CONVERSAO_MUC: 'CONVERSAO_MUC',
  COMPATIBILIDADE: 'COMPATIBILIDADE'
});

function arred3(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 1000) / 1000;
}

function erroEstoque(codigo, mensagem) {
  const err = new Error(mensagem);
  err.code = codigo;
  return err;
}

function fatorInformado(raw) {
  return raw !== undefined && raw !== null && raw !== '';
}

function fatorValidoDe(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function unidadeArquivo(raw) {
  const s = String(raw == null ? '' : raw).trim();
  return s || '';
}

function montarRelacoes(input = {}) {
  const apresentacoes = input.apresentacoes || input.produtoConfig?.apresentacoes || [];
  const relCfg = input.produtoConfig?.relacoes || [];
  const extra = input.relacoes || [];
  return ProdutoConversaoConfigService.montarRelacoesMuc(apresentacoes, [...relCfg, ...extra]);
}

function resultadoLegado({ quantidade, fator, unidadeDestino, motivo }) {
  const fatorUso = fatorValidoDe(fator) || 1;
  return {
    quantidade_origem: quantidade,
    fator_conversao: fatorUso,
    estoque_inicial: arred3(quantidade * fatorUso),
    quantidadeEstoque: arred3(quantidade * fatorUso),
    unidadeEstoque: unidadeDestino || null,
    origemCalculo: ORIGEM_CALCULO.FATOR_CONVERSAO,
    modo: MODO.COMPATIBILIDADE,
    motivo: motivo || 'FATOR_CONVERSAO'
  };
}

function resultadoMuc({ quantidade, fatorRef, conv, motivo }) {
  const qtd = arred3(conv.quantidade);
  return {
    quantidade_origem: quantidade,
    fator_conversao: Number(conv.fatorTotal) > 0 ? conv.fatorTotal : (fatorValidoDe(fatorRef) || 1),
    estoque_inicial: qtd,
    quantidadeEstoque: qtd,
    unidadeEstoque: conv.unidade,
    origemCalculo: ORIGEM_CALCULO.MUC,
    modo: MODO.CONVERSAO_MUC,
    motivo: motivo || 'CONVERSAO_MUC',
    caminho: conv.caminho || []
  };
}

/**
 * @param {object} input
 * @returns {object}
 */
function resolverEstoqueInicialImportacao(input = {}) {
  const qtdRaw = input.quantidadeDocumento ?? input.quantidade;
  const quantidade = Number(qtdRaw);
  if (!Number.isFinite(quantidade) || quantidade < 0) {
    throw erroEstoque('QUANTIDADE_INVALIDA', 'Quantidade do documento inválida.');
  }

  const fatorRaw = input.fatorConversao ?? input.fator_conversao;
  const temFator = fatorInformado(fatorRaw);
  const fatorOk = fatorValidoDe(fatorRaw);

  const origemRaw = unidadeArquivo(input.unidadeOrigem ?? input.unidade_origem);
  const destRaw = unidadeArquivo(
    input.unidadeDestino ?? input.unidade_destino ?? input.unidade_base
  );
  const origem = origemRaw ? normalizarUnidade(origemRaw) : null;
  const dest = destRaw ? normalizarUnidade(destRaw) : null;

  const unidadesSuficientes = Boolean(
    origemRaw && destRaw && origem && dest && isUnidadeConhecida(origemRaw) && isUnidadeConhecida(destRaw)
  );

  if (quantidade === 0) {
    if (!unidadesSuficientes) {
      if (temFator && !fatorOk) {
        throw erroEstoque('FATOR_INVALIDO', 'Fator de conversão inválido.');
      }
      return resultadoLegado({
        quantidade: 0,
        fator: fatorOk || 1,
        unidadeDestino: dest || destRaw || null,
        motivo: 'QUANTIDADE_ZERO'
      });
    }
    return resultadoMuc({
      quantidade: 0,
      fatorRef: fatorRaw,
      conv: { quantidade: 0, unidade: dest, fatorTotal: 1, caminho: [] },
      motivo: 'QUANTIDADE_ZERO'
    });
  }

  if (unidadesSuficientes) {
    const relacoes = montarRelacoes(input);
    try {
      const muc = obterMuc(input.db || null);
      const conv = muc.converterQuantidade({
        quantidade,
        unidadeOrigem: origem,
        unidadeDestino: dest,
        relacoes
      });
      return resultadoMuc({ quantidade, fatorRef: fatorRaw, conv });
    } catch (e) {
      if (e.code === CODIGOS.CONVERSAO_NAO_DISPONIVEL) {
        if (fatorOk) {
          return resultadoLegado({
            quantidade,
            fator: fatorOk,
            unidadeDestino: dest,
            motivo: 'CAMINHO_MUC_NAO_ENCONTRADO'
          });
        }
        throw erroEstoque(
          'CONVERSAO_NAO_DISPONIVEL',
          e.message || `Conversão não disponível: ${origem} → ${dest}.`
        );
      }
      if (e.code === CODIGOS.CONVERSAO_INVALIDA || e.code === CODIGOS.CONVERSAO_CICLO) {
        throw erroEstoque(e.code, e.message);
      }
      throw erroEstoque('ERRO_INTERNO_MUC', e.message || 'Falha interna do MUC.');
    }
  }

  if (temFator && !fatorOk) {
    throw erroEstoque('FATOR_INVALIDO', 'Fator de conversão inválido.');
  }
  if (!temFator && !origemRaw && !destRaw && (qtdRaw === undefined || qtdRaw === null || qtdRaw === '')) {
    throw erroEstoque(
      'DADOS_INSUFICIENTES',
      'Informe quantidade e fator de conversão, ou unidades de origem e destino.'
    );
  }

  return resultadoLegado({
    quantidade,
    fator: fatorOk || 1,
    unidadeDestino: dest || destRaw || null,
    motivo: origemRaw || destRaw ? 'UNIDADE_NAO_INFORMADA' : 'FATOR_CONVERSAO'
  });
}

async function carregarProdutoConfigMuc(db, produtoId) {
  const id = Number(produtoId);
  if (!db || !Number.isInteger(id) || id <= 0) return null;
  try {
    return await ProdutoConversaoConfigService.obterConfiguracao(db, id);
  } catch (_e) {
    return null;
  }
}

module.exports = {
  resolverEstoqueInicialImportacao,
  carregarProdutoConfigMuc,
  ORIGEM_CALCULO,
  MODO
};
