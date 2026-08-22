/**
 * Rotas administrativas de estoque (Fase 2 / Implementação 03.18).
 * Leitura isolada de estoque_empresa. Sem fallback para produtos.
 */
'use strict';

const express = require('express');
const dbDefault = require('../database');
const { criarMiddlewareContextoEmpresa } = require('../services/fiscalNaoFiscal/empresaContexto');
const EstoqueEmpresaService = require('../services/estoque/EstoqueEmpresaService');

async function handleGetProdutoEstoqueEmpresa(req, res, dbConn) {
  const produtoId = Number(req.params && req.params.produtoId);
  if (!Number.isInteger(produtoId) || produtoId <= 0) {
    return res.status(400).json({
      error: 'Produto inválido.',
      code: 'PRODUTO_INVALIDO'
    });
  }

  const empresaId = req.empresaId;
  try {
    const saldo = await EstoqueEmpresaService.consultarSaldoParaEmpresa({
      produtoId,
      empresaId,
      db: dbConn
    });

    if (!saldo) {
      return res.status(404).json({
        error: 'Não existe estoque isolado para este produto nesta empresa.',
        code: 'ESTOQUE_EMPRESA_NAO_ENCONTRADO',
        produtoId,
        empresaId
      });
    }

    return res.status(200).json({
      produtoId,
      empresaId,
      saldoFiscal: saldo.saldoFiscal,
      saldoNaoFiscal: saldo.saldoNaoFiscal,
      estoqueAtual: saldo.estoqueAtual,
      reservadoFiscal: saldo.reservadoFiscal,
      reservadoNaoFiscal: saldo.reservadoNaoFiscal
    });
  } catch (err) {
    const code = err && err.code ? err.code : 'ERRO_ESTOQUE_EMPRESA';
    const status = code === 'PRODUTO_NAO_ENCONTRADO' ? 404
      : (code === 'PRODUTO_INVALIDO' || code === 'EMPRESA_OBRIGATORIA' ? 400 : 500);
    return res.status(status).json({
      error: err && err.message ? err.message : 'Erro ao consultar estoque da empresa.',
      code
    });
  }
}

function criarRotasEstoque(dbConn) {
  const exigirContexto = criarMiddlewareContextoEmpresa(dbConn, { obrigatorio: true });
  const router = express.Router();
  router.get('/empresa/produtos/:produtoId', exigirContexto, (req, res) => {
    return handleGetProdutoEstoqueEmpresa(req, res, dbConn);
  });
  return router;
}

const router = criarRotasEstoque(dbDefault);
router.criarRotasEstoque = criarRotasEstoque;
router.handleGetProdutoEstoqueEmpresa = handleGetProdutoEstoqueEmpresa;
module.exports = router;
