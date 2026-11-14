/**
 * Fronteira oficial da contagem física — CDS-ESTOQUE-CONTAGEM-SNAPSHOT-FLUXO-03.1.
 * Exige snapshot completo nos fluxos oficiais (API / UI).
 * Não remove a compatibilidade do serviço sem snapshot para testes/legado.
 *
 * @module services/estoque/contagemFisicaSnapshotOficial
 */
'use strict';

const { roundStockQuantity } = require('./quantityPrecision');

function erroSnapshot(code, message, status = 400, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  Object.assign(err, extra);
  return err;
}

function lerCampo(item, ...chaves) {
  for (const chave of chaves) {
    if (item[chave] !== undefined && item[chave] !== null && item[chave] !== '') {
      return item[chave];
    }
    // zero explícito é valor válido
    if (item[chave] === 0) return 0;
  }
  return undefined;
}

function normalizarSaldoEsperado(valor, campo) {
  if (valor === undefined || valor === null || valor === '') {
    throw erroSnapshot(
      'SNAPSHOT_OBRIGATORIO',
      `${campo} é obrigatório na confirmação oficial da contagem física.`,
      400,
      { campo }
    );
  }
  const n = Number(valor);
  if (!Number.isFinite(n) || n < 0) {
    throw erroSnapshot(
      'SNAPSHOT_INVALIDO',
      `${campo} deve ser um número maior ou igual a zero.`,
      400,
      { campo, valor }
    );
  }
  return roundStockQuantity(n);
}

/**
 * Valida e normaliza itens da confirmação oficial.
 * Aceita 0. Rejeita ausência/nulo/inválido.
 * Não altera os valores do snapshot — apenas normaliza números.
 *
 * @param {Array<object>} itensBrutos
 * @returns {Array<object>} itens com snapshot explícito
 */
function exigirSnapshotItensOficiais(itensBrutos) {
  if (!Array.isArray(itensBrutos) || itensBrutos.length === 0) {
    throw erroSnapshot(
      'ITENS_CONTAGEM_OBRIGATORIOS',
      'Informe ao menos um produto na contagem.',
      400
    );
  }

  return itensBrutos.map((item, index) => {
    const raw = item || {};
    const produtoId = Number(
      raw.produto_id != null ? raw.produto_id : raw.produtoId
    );
    if (!Number.isInteger(produtoId) || produtoId <= 0) {
      throw erroSnapshot(
        'PRODUTO_INVALIDO',
        `produto_id inválido no item ${index + 1}.`,
        400
      );
    }

    const fiscalRaw = lerCampo(
      raw,
      'saldo_fiscal_esperado',
      'saldoFiscalEsperado'
    );
    const naoFiscalRaw = lerCampo(
      raw,
      'saldo_nao_fiscal_esperado',
      'saldoNaoFiscalEsperado'
    );

    if (fiscalRaw === undefined && naoFiscalRaw === undefined) {
      throw erroSnapshot(
        'SNAPSHOT_OBRIGATORIO',
        'Confirmação oficial exige saldo_fiscal_esperado e saldo_nao_fiscal_esperado '
        + '(obtidos no preview). Atualize a pré-visualização antes de confirmar.',
        400,
        { produto_id: produtoId, item_index: index }
      );
    }
    if (fiscalRaw === undefined || naoFiscalRaw === undefined) {
      throw erroSnapshot(
        'SNAPSHOT_OBRIGATORIO',
        'Snapshot incompleto: informe saldo_fiscal_esperado e saldo_nao_fiscal_esperado.',
        400,
        { produto_id: produtoId, item_index: index }
      );
    }

    const saldoFiscalEsperado = normalizarSaldoEsperado(fiscalRaw, 'saldo_fiscal_esperado');
    const saldoNaoFiscalEsperado = normalizarSaldoEsperado(naoFiscalRaw, 'saldo_nao_fiscal_esperado');

    return {
      ...raw,
      produto_id: produtoId,
      saldo_fiscal_esperado: saldoFiscalEsperado,
      saldo_nao_fiscal_esperado: saldoNaoFiscalEsperado,
      quantidade_fiscal_contada: raw.quantidade_fiscal_contada != null
        ? raw.quantidade_fiscal_contada
        : raw.quantidadeFiscalContada,
      quantidade_nao_fiscal_contada: raw.quantidade_nao_fiscal_contada != null
        ? raw.quantidade_nao_fiscal_contada
        : raw.quantidadeNaoFiscalContada
    };
  });
}

/**
 * Monta payload de confirmação a partir do preview (contrato frontend/API).
 * Preserva os valores originais do snapshot — não recalcula.
 */
function montarItemConfirmacaoApartirDoPreview(preview, overrides = {}) {
  if (!preview || typeof preview !== 'object') {
    throw erroSnapshot('SNAPSHOT_OBRIGATORIO', 'Preview inválido para montar confirmação.');
  }
  const produtoId = Number(
    overrides.produto_id != null
      ? overrides.produto_id
      : (preview.produto_id != null ? preview.produto_id : preview.produtoId)
  );
  const saldoFiscal = preview.saldo_fiscal_esperado != null
    ? preview.saldo_fiscal_esperado
    : preview.saldo_fiscal_anterior;
  const saldoNaoFiscal = preview.saldo_nao_fiscal_esperado != null
    ? preview.saldo_nao_fiscal_esperado
    : preview.saldo_nao_fiscal_anterior;

  return exigirSnapshotItensOficiais([{
    produto_id: produtoId,
    quantidade_fiscal_contada: overrides.quantidade_fiscal_contada != null
      ? overrides.quantidade_fiscal_contada
      : preview.quantidade_fiscal_contada,
    quantidade_nao_fiscal_contada: overrides.quantidade_nao_fiscal_contada != null
      ? overrides.quantidade_nao_fiscal_contada
      : preview.quantidade_nao_fiscal_contada,
    saldo_fiscal_esperado: saldoFiscal,
    saldo_nao_fiscal_esperado: saldoNaoFiscal
  }])[0];
}

module.exports = {
  exigirSnapshotItensOficiais,
  montarItemConfirmacaoApartirDoPreview,
  erroSnapshot
};
