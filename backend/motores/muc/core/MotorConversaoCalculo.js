/**
 * MUC RC2 / MUC-02 — Etapa 5: Conversão
 * Quantidade oficial via MotorConversaoQuantidade (SI + encadeamento).
 * Legado permanece para custo, subtotal e rateio F/NF.
 * @module motores/muc/core/MotorConversaoCalculo
 */
'use strict';

const { tipoParaUnidadeComercial } = require('../constants/tiposApresentacao');
const { num } = require('../dto/ConversaoDTO');
const LegacyMotor = require('../../../lib/motorConversaoUnidades');
const { converterQuantidade } = require('./MotorConversaoQuantidade');
const { normalizarUnidade } = require('./unidadesSi');

function montarItemLegado(dto, inferido) {
  const fracionado = LegacyMotor.produtoUsaConversaoUnidades(dto.produto || dto.item);
  const uc = tipoParaUnidadeComercial(inferido.tipoApresentacao);
  return {
    ...(dto.item || {}),
    produto_id: dto.produtoId,
    produto_fracionado: fracionado ? 1 : 0,
    vendido_por_peso: fracionado ? 1 : 0,
    unidade_comercial: uc,
    compra_em: inferido.tipoApresentacao,
    quantidade_embalagens: dto.quantidadeCompra,
    quantidade_por_embalagem: inferido.fator,
    valor_total_embalagem: dto.valorTotalCompra,
    quantidade_fiscal: dto.quantidadeFiscal,
    quantidade_nao_fiscal: dto.quantidadeNaoFiscal,
    unidade: inferido.unidadeEstoque,
    preco_unitario: dto.item?.preco_unitario,
    custo_unitario_final: dto.item?.custo_unitario_final,
    subtotal: dto.valorTotalCompra,
    margem_lucro: dto.item?.margem_lucro
  };
}

function relacaoApresentacao(ap) {
  if (!ap) return null;
  const de = tipoParaUnidadeComercial(ap.tipo || ap.unidadeComercial);
  const para = normalizarUnidade(ap.unidade);
  const fator = Number(ap.quantidade);
  if (!de || !para || !(fator > 0) || de === para) return null;
  return { de, para, fator };
}

function montarRelacoes(dto, inferido, input) {
  const rel = [];
  const vistas = new Set();
  const push = (r) => {
    if (!r) return;
    const k = `${r.de}|${r.para}|${r.fator}`;
    if (vistas.has(k)) return;
    vistas.add(k);
    rel.push(r);
  };

  for (const r of input.relacoes || dto.relacoes || []) {
    const de = normalizarUnidade(r.de || r.origem);
    const para = normalizarUnidade(r.para || r.destino);
    const fator = Number(r.fator ?? r.quantidade);
    if (de && para && fator > 0 && de !== para) push({ de, para, fator });
  }

  const lista = input.apresentacoes || dto.apresentacoes || [];
  for (const ap of lista) {
    push(relacaoApresentacao(ap));
  }
  push(relacaoApresentacao(inferido.apresentacao));

  const deCompra = tipoParaUnidadeComercial(inferido.tipoApresentacao);
  const fator = Number(inferido.fator);
  const tipoAp = String(inferido.tipoApresentacao || '').toUpperCase();
  const tiposConteudoUn = new Set(['CX', 'FD', 'PCT', 'DISPLAY', 'KIT', 'CAIXA', 'FARDO', 'PACOTE']);
  const paraConteudo = normalizarUnidade(inferido.apresentacao?.unidade)
    || (tiposConteudoUn.has(tipoAp)
      || tiposConteudoUn.has(deCompra)
      ? 'UN'
      : (normalizarUnidade(dto.produto?.unidade || dto.unidadeEstoque) || deCompra));
  if (fator > 0 && deCompra && paraConteudo && deCompra !== paraConteudo && tipoAp !== 'UN' && deCompra !== 'UN') {
    push({ de: deCompra, para: paraConteudo, fator });
  }

  return rel;
}

function executar(ctx) {
  const { dto, inferido, input } = ctx;
  const itemLegado = montarItemLegado(dto, inferido);
  const origem = tipoParaUnidadeComercial(inferido.tipoApresentacao);
  const destino = normalizarUnidade(
    Number(dto.produto?.utiliza_conversao) === 1
      ? (dto.produto.unidade_estoque || dto.produto.unidade)
      : (dto.produto?.unidade || dto.unidadeEstoque || inferido.apresentacao?.unidade || inferido.unidadeEstoque)
  ) || 'UN';
  const relacoes = montarRelacoes(dto, inferido, input || {});

  const conv = !(dto.quantidadeCompra > 0)
    ? {
      quantidade: 0,
      unidade: destino,
      fatorTotal: Number(inferido.fator) || 1,
      caminho: []
    }
    : converterQuantidade({
      quantidade: dto.quantidadeCompra,
      unidadeOrigem: origem,
      unidadeDestino: destino,
      relacoes
    });

  const qtdMuc = conv.quantidade;
  const itemComQtdMuc = {
    ...itemLegado,
    quantidade: qtdMuc,
    quantidade_convertida: qtdMuc,
    peso_total_compra: qtdMuc
  };
  const qtdsLegado = LegacyMotor.resolverQuantidadesEstoqueCompraItem(itemComQtdMuc);
  const legadoQtd = Number(qtdsLegado.quantidade_convertida || qtdsLegado.quantidade || 0);
  let quantidadeFiscal = num(qtdsLegado.quantidade_fiscal, 4);
  let quantidadeNaoFiscal = num(qtdsLegado.quantidade_nao_fiscal, 4);
  if (legadoQtd > 0 && Math.abs(legadoQtd - qtdMuc) > 1e-9) {
    const ratio = qtdMuc / legadoQtd;
    quantidadeFiscal = num(quantidadeFiscal * ratio, 4);
    quantidadeNaoFiscal = num(quantidadeNaoFiscal * ratio, 4);
  } else if (!(legadoQtd > 0)) {
    quantidadeFiscal = num(qtdMuc, 4);
    quantidadeNaoFiscal = 0;
  }

  const itemParaCusto = {
    ...itemComQtdMuc,
    quantidade: qtdMuc,
    quantidade_convertida: qtdMuc
  };
  const custoUnitario = LegacyMotor.resolverCustoUnitarioCadastro(itemParaCusto);
  const subtotal = LegacyMotor.calcularSubtotalFinanceiroItemCompra(itemParaCusto);

  return Object.freeze({
    ...ctx,
    calculado: Object.freeze({
      produtoId: dto.produtoId,
      apresentacaoId: inferido.apresentacao?.id ?? dto.apresentacaoId,
      origem: dto.origem,
      quantidadeCompra: dto.quantidadeCompra,
      unidadeCompra: inferido.tipoApresentacao,
      fatorConversao: conv.fatorTotal,
      quantidadeEstoque: num(qtdMuc, 4),
      quantidadeFiscal,
      quantidadeNaoFiscal,
      unidadeEstoque: conv.unidade,
      custoUnitario,
      custoTotal: LegacyMotor.moeda(subtotal),
      subtotal: LegacyMotor.moeda(subtotal),
      tipoConversao: inferido.tipoConversao,
      confianca: inferido.confianca,
      metodoInferencia: inferido.metodoInferencia,
      metadata: Object.freeze({ caminho: conv.caminho })
    })
  });
}

module.exports = { executar, montarItemLegado, montarRelacoes };
