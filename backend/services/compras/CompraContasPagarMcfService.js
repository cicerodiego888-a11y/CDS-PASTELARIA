'use strict';

const ContasPagarService = require('../../motores/mcf/services/ContasPagarService');

// The caller owns the transaction that also persists the purchase and its items.
async function criarTitulosMcfCompra(params = {}) {
  const db = params.db;
  const empresaId = Number(params.empresa_id);
  const compraId = Number(params.compra_id);
  if (!db || !Number.isInteger(empresaId) || empresaId <= 0) {
    throw new Error('db e empresa_id válido são obrigatórios para gerar títulos MCF da compra.');
  }
  if (!Number.isInteger(compraId) || compraId <= 0) {
    throw new Error('compra_id válido é obrigatório para gerar títulos MCF da compra.');
  }
  if (!Array.isArray(params.parcelas) || params.parcelas.length === 0) {
    throw new Error('A compra precisa ter ao menos uma parcela financeira.');
  }

  const titulos = [];
  for (const parcela of params.parcelas) {
    const numeroParcela = Number(parcela.numero_parcela);
    const totalParcelas = params.parcelas.length;
    const titulo = await ContasPagarService.criarNaTransacaoAtual({
      db,
      empresaId,
      fornecedor_id: params.fornecedor_id,
      descricao: parcela.descricao,
      valor_original: parcela.valor,
      data_emissao: params.data_emissao,
      data_vencimento: parcela.data_vencimento,
      documento: parcela.documento || params.documento || null,
      categoria: params.categoria || 'compras',
      origem: 'compra',
      referencia_tipo: 'compra',
      referencia_id: compraId,
      numero_parcela: numeroParcela,
      total_parcelas: totalParcelas,
      observacao: params.observacao,
      criado_por: params.usuario_id,
      idempotency_key: `compra:${compraId}:parcela:${numeroParcela}`
    });

    if (parcela.pagar_agora === true) {
      await ContasPagarService.baixarNaTransacaoAtual({
        db,
        empresaId,
        id: titulo.id,
        valor_pago: parcela.valor,
        data_pagamento: params.data_emissao,
        forma_pagamento: params.forma_pagamento,
        observacao: `Liquidação inicial da compra ${compraId}, parcela ${numeroParcela}.`,
        idempotency_key: `compra:${compraId}:parcela:${numeroParcela}:pagamento-inicial`,
        usuario_id: params.usuario_id,
        origem_operacao: 'compra'
      });
    }
    titulos.push(titulo);
  }
  return titulos;
}

module.exports = { criarTitulosMcfCompra };
