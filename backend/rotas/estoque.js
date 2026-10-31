/**
 * Rotas administrativas de estoque (Fase 2 / Implementação 03.18).
 * Leitura isolada de estoque_empresa. Sem fallback para produtos.
 * CDS-ESTOQUE-MANUAL-01 — contagem física F×NF.
 */
'use strict';

const express = require('express');
const dbDefault = require('../database');
const { criarMiddlewareContextoEmpresa } = require('../services/fiscalNaoFiscal/empresaContexto');
const EstoqueEmpresaService = require('../services/estoque/EstoqueEmpresaService');
const EstoqueContagemFisicaService = require('../services/estoque/EstoqueContagemFisicaService');
const { exigirPerfilAjusteEstoque } = require('../middleware/auth');

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

  router.post('/contagem-fisica/preview', exigirContexto, exigirPerfilAjusteEstoque(), async (req, res) => {
    try {
      const body = req.body || {};
      const preview = await EstoqueContagemFisicaService.previsualizarContagem({
        db: dbConn,
        empresaId: req.empresaId,
        produtoId: body.produto_id != null ? body.produto_id : body.produtoId,
        quantidade_fiscal_contada: body.quantidade_fiscal_contada,
        quantidade_nao_fiscal_contada: body.quantidade_nao_fiscal_contada
      });
      return res.json(preview);
    } catch (err) {
      const status = Number(err && err.status) || 400;
      return res.status(status).json({
        error: err && err.message ? err.message : 'Erro ao pré-visualizar contagem.',
        code: err && err.code ? err.code : 'CONTAGEM_PREVIEW_FALHOU'
      });
    }
  });

  router.post('/contagem-fisica', exigirContexto, exigirPerfilAjusteEstoque(), async (req, res) => {
    try {
      const body = req.body || {};
      const chave = req.get('Idempotency-Key')
        || body.chave_idempotencia
        || body.chaveIdempotencia
        || null;
      const resultado = await EstoqueContagemFisicaService.registrarContagemFisica({
        db: dbConn,
        empresaId: req.empresaId,
        itens: body.itens || [],
        observacao: body.observacao,
        usuarioId: req.user && req.user.id,
        usuarioNome: (req.user && (req.user.username || req.user.nome)) || null,
        chaveIdempotencia: chave
      });
      return res.status(201).json(resultado);
    } catch (err) {
      const status = Number(err && err.status) || 400;
      return res.status(status).json({
        error: err && err.message ? err.message : 'Erro ao registrar contagem física.',
        code: err && err.code ? err.code : 'CONTAGEM_FISICA_FALHOU'
      });
    }
  });

  router.get('/contagem-fisica/:id', exigirContexto, exigirPerfilAjusteEstoque(), async (req, res) => {
    try {
      const resultado = await EstoqueContagemFisicaService.obterContagemPorId(
        dbConn,
        req.params.id,
        req.empresaId
      );
      return res.json(resultado);
    } catch (err) {
      const status = Number(err && err.status) || 400;
      return res.status(status).json({
        error: err && err.message ? err.message : 'Erro ao consultar contagem.',
        code: err && err.code ? err.code : 'CONTAGEM_CONSULTA_FALHOU'
      });
    }
  });

  return router;
}

const router = criarRotasEstoque(dbDefault);
router.criarRotasEstoque = criarRotasEstoque;
router.handleGetProdutoEstoqueEmpresa = handleGetProdutoEstoqueEmpresa;
module.exports = router;
