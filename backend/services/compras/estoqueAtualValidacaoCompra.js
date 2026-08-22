/**
 * 03.33 — origem de estoque_atual para validar cancelamento/devolução de compra.
 * Não escreve. Não altera a porta. Sem fallback silencioso para produtos.
 */
'use strict';

const EstoqueEmpresaService = require('../estoque/EstoqueEmpresaService');
const { empresaIdDoReqCompra } = require('./creditoEstoqueCompraViaPorta');

/**
 * Sem req.empresaId: estoque_atual legado do produto.
 * Com empresa + registro: estoqueAtual isolado.
 * Com empresa sem registro: 0 (não copia produtos).
 */
async function estoqueAtualParaValidacaoCompra({ produto, produtoId, req, db } = {}) {
  const empresaId = empresaIdDoReqCompra(req);
  const legado = Number(produto && produto.estoque_atual != null ? produto.estoque_atual : 0);

  if (empresaId == null) {
    return legado;
  }

  const saldo = await EstoqueEmpresaService.consultarSaldoParaEmpresa({
    produtoId,
    empresaId,
    db
  });

  if (!saldo) return 0;
  return Number(saldo.estoqueAtual);
}

module.exports = { estoqueAtualParaValidacaoCompra };
