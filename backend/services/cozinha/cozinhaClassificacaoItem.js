/**
 * Classificação operacional Cozinha — PASTEL | BEBIDA | OUTRO.
 * Domínio exclusivo da Cozinha. Não altera Pedido/PDV/cadastros.
 *
 * Regra oficial (correção auditoria Sprint 03):
 * 1) Snapshot/campo explícito PASTEL|BEBIDA|OUTRO → respeitar.
 * 2) INSUMO + comercializavel=1 + categoria Refrigerantes/Refrigerante → BEBIDA.
 * 3) COMERCIAL + utiliza_ficha_tecnica=1 → PASTEL
 *    (personalização NÃO é critério; utiliza_ficha_tecnica não muda de significado global).
 * 4) Demais → OUTRO.
 *
 * Nunca: inferência por nome; todo INSUMO comercializável → BEBIDA;
 * ingredientes de ficha como item independente.
 */
'use strict';

const { CATEGORIAS_REFRIGERANTE, ehCategoriaRefrigerante } = require(
  '../pedido/PedidoRefrigeranteInsumoConsultaService'
);

const TIPOS_COZINHA = Object.freeze({
  PASTEL: 'PASTEL',
  BEBIDA: 'BEBIDA',
  OUTRO: 'OUTRO'
});

function textoUpper(v) {
  if (v == null || v === '') return '';
  return String(v).trim().toUpperCase();
}

function flagOn(v) {
  return v === true || v === 1 || v === '1' || Number(v) === 1;
}

/**
 * Apenas valores já no domínio Cozinha (não COMERCIAL/INSUMO do ERP).
 */
function extrairExplicitoCozinha(ctx = {}) {
  const candidatos = [
    ctx.tipo_item,
    ctx.tipo_cozinha,
    ctx.classificacao_cozinha_snapshot
  ];
  for (const bruto of candidatos) {
    const v = textoUpper(bruto);
    if (v === TIPOS_COZINHA.PASTEL || v === TIPOS_COZINHA.BEBIDA || v === TIPOS_COZINHA.OUTRO) {
      return v;
    }
  }
  // classificacao_operacional(_snapshot) só conta se já for PASTEL|BEBIDA|OUTRO
  for (const bruto of [ctx.classificacao_operacional, ctx.classificacao_operacional_snapshot]) {
    const v = textoUpper(bruto);
    if (v === TIPOS_COZINHA.PASTEL || v === TIPOS_COZINHA.BEBIDA || v === TIPOS_COZINHA.OUTRO) {
      return v;
    }
  }
  return null;
}

function tipoOperacionalErp(ctx = {}) {
  const v = textoUpper(
    ctx.tipo_operacional
    || (
      ['COMERCIAL', 'INSUMO', 'PRODUTO', 'PRODUTO_COMERCIAL'].includes(
        textoUpper(ctx.classificacao_operacional_snapshot)
      )
        ? ctx.classificacao_operacional_snapshot
        : null
    )
    || (
      ['COMERCIAL', 'INSUMO', 'PRODUTO', 'PRODUTO_COMERCIAL'].includes(
        textoUpper(ctx.classificacao_operacional)
      )
        ? ctx.classificacao_operacional
        : null
    )
  );
  if (v === 'INSUMO') return 'INSUMO';
  if (v === 'COMERCIAL' || v === 'PRODUTO' || v === 'PRODUTO_COMERCIAL') return 'COMERCIAL';
  return v || '';
}

/** Critério oficial PASTEL: somente utiliza_ficha_tecnica do cadastro COMERCIAL. */
function evidenciaPastelOficial(ctx = {}) {
  return flagOn(ctx.utiliza_ficha_tecnica);
}

function evidenciaBebidaPorCategoria(ctx = {}) {
  const cat = ctx.categoria_nome || ctx.categoria || '';
  return ehCategoriaRefrigerante(cat);
}

/**
 * @param {object} ctx dados do item de pedido + produto/categoria
 * @returns {{ tipo: 'PASTEL'|'BEBIDA'|'OUTRO', motivo: string, confiavel: boolean }}
 */
function classificarItemCozinha(ctx = {}) {
  const explicito = extrairExplicitoCozinha(ctx);
  if (explicito) {
    return { tipo: explicito, motivo: 'explicito_snapshot', confiavel: true };
  }

  const erp = tipoOperacionalErp(ctx);

  if (erp === 'INSUMO' && flagOn(ctx.comercializavel)) {
    if (evidenciaBebidaPorCategoria(ctx)) {
      return {
        tipo: TIPOS_COZINHA.BEBIDA,
        motivo: 'insumo_comercializavel_categoria_refrigerante',
        confiavel: true
      };
    }
    return {
      tipo: TIPOS_COZINHA.OUTRO,
      motivo: 'insumo_comercializavel_sem_categoria_bebida',
      confiavel: false
    };
  }

  if (erp === 'COMERCIAL' && evidenciaPastelOficial(ctx)) {
    return {
      tipo: TIPOS_COZINHA.PASTEL,
      motivo: 'comercial_utiliza_ficha_tecnica',
      confiavel: true
    };
  }

  if (erp === 'COMERCIAL') {
    return {
      tipo: TIPOS_COZINHA.OUTRO,
      motivo: 'comercial_sem_utiliza_ficha_tecnica',
      confiavel: false
    };
  }

  return {
    tipo: TIPOS_COZINHA.OUTRO,
    motivo: 'sem_evidencia_operacional',
    confiavel: false
  };
}

function classificarTipoItem(item) {
  return classificarItemCozinha(item || {}).tipo;
}

module.exports = {
  TIPOS_COZINHA,
  CATEGORIAS_REFRIGERANTE_COZINHA: CATEGORIAS_REFRIGERANTE,
  ehCategoriaRefrigerante,
  classificarItemCozinha,
  classificarTipoItem,
  evidenciaPastelOficial,
  /** @deprecated alias — usa regra oficial */
  evidenciaPastel: evidenciaPastelOficial,
  evidenciaBebidaPorCategoria
};
