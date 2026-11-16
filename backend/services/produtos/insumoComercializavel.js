/**
 * CDS-INSUMOS-PRODUTO-COMERCIALIZAVEL-01
 * Flag opt-in: INSUMO também vendável no Pedido (sem virar COMERCIAL no PDV).
 */
'use strict';

const { TipoOperacionalProduto } = require('./tipoOperacionalProduto');

function erro(codigo, mensagem, statusCode = 400) {
  const err = new Error(mensagem);
  err.code = codigo;
  err.statusCode = statusCode;
  return err;
}

function parseFlagComercializavel(valor) {
  if (valor === true || valor === 1 || valor === '1' || valor === 'true') return 1;
  if (valor === false || valor === 0 || valor === '0' || valor === 'false' || valor == null || valor === '') {
    return 0;
  }
  throw erro('COMERCIALIZAVEL_INVALIDO', 'Informe comercializável como ligado ou desligado.');
}

function parsePrecoVenda(valor) {
  if (valor === null || valor === undefined || valor === '') {
    return { ok: false, codigo: 'PRECO_VENDA_AUSENTE', mensagem: 'Informe o valor de venda.' };
  }
  const n = Number(valor);
  if (!Number.isFinite(n)) {
    return { ok: false, codigo: 'PRECO_VENDA_INVALIDO', mensagem: 'Valor de venda inválido.' };
  }
  if (n <= 0) {
    return {
      ok: false,
      codigo: 'PRECO_VENDA_OBRIGATORIO',
      mensagem: 'Para produto comercializável, informe valor de venda maior que zero.'
    };
  }
  return { ok: true, valor: Math.round((n + Number.EPSILON) * 100) / 100 };
}

/**
 * Margem do INSUMO comercializável: usa lucro informado ou deriva de compra×venda.
 * Evita gravar 0 artificial (quebrava "Atualizar preço" na compra → venda = custo).
 */
function resolverLucroInsumoComercializavel({
  lucroPercentualBody,
  precoCompraBody,
  precoVenda
} = {}) {
  const compra = Number(precoCompraBody);
  const venda = Number(precoVenda);
  const podeDerivar = Number.isFinite(compra) && compra > 0 && Number.isFinite(venda) && venda > 0;

  if (lucroPercentualBody !== undefined && lucroPercentualBody !== null && lucroPercentualBody !== '') {
    const n = Number(lucroPercentualBody);
    if (Number.isFinite(n)) {
      // 0 artificial do legado: se compra/venda existem e diferem, deriva a margem real.
      if (n === 0 && podeDerivar && venda !== compra) {
        return Math.round(((((venda - compra) / compra) * 100) + Number.EPSILON) * 100) / 100;
      }
      return Math.round((n + Number.EPSILON) * 100) / 100;
    }
  }
  if (podeDerivar) {
    return Math.round(((((venda - compra) / compra) * 100) + Number.EPSILON) * 100) / 100;
  }
  return 0;
}

/**
 * Resolve comercializável + preço na criação/edição de produto.
 * COMERCIAL: flag sempre 0 (campo não se aplica).
 * INSUMO não comercializável: não exige preço; na edição não sobrescreve preço histórico.
 * INSUMO comercializável: exige preço > 0 e persiste margem (lucro_percentual).
 */
function resolverComercializavelEPreco({
  tipoOperacional,
  comercializavelBody,
  precoVendaBody,
  lucroPercentualBody = null,
  precoCompraBody = null,
  modo = 'create',
  precoVendaAtual = 0
} = {}) {
  const tipo = String(tipoOperacional || '').trim().toUpperCase();
  if (tipo !== TipoOperacionalProduto.INSUMO) {
    return {
      comercializavel: 0,
      preco_venda: Number(precoVendaBody) || 0,
      lucro_percentual: lucroPercentualBody,
      atualizarPreco: true
    };
  }

  const comercializavel = parseFlagComercializavel(comercializavelBody);
  if (!comercializavel) {
    return {
      comercializavel: 0,
      preco_venda: modo === 'create' ? 0 : Number(precoVendaAtual) || 0,
      lucro_percentual: 0,
      // Edição: não mexe no preço histórico ao desligar.
      atualizarPreco: modo === 'create'
    };
  }

  const preco = parsePrecoVenda(precoVendaBody);
  if (!preco.ok) {
    throw erro(preco.codigo, preco.mensagem);
  }

  return {
    comercializavel: 1,
    preco_venda: preco.valor,
    lucro_percentual: resolverLucroInsumoComercializavel({
      lucroPercentualBody,
      precoCompraBody,
      precoVenda: preco.valor
    }),
    atualizarPreco: true
  };
}

module.exports = {
  parseFlagComercializavel,
  parsePrecoVenda,
  resolverLucroInsumoComercializavel,
  resolverComercializavelEPreco
};
