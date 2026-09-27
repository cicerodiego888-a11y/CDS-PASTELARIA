/**
 * Rotas MCF-01 — Contas a Pagar dedicada.
 * Prefixo: /api/contas-pagar
 * Não substitui /api/financeiro/contas-pagar (legado).
 */
'use strict';

const express = require('express');
const router = express.Router();
const db = require('../database');
const {
  middlewareResolverEmpresaFinanceiro,
  statusDeErroEmpresa
} = require('../services/financeiro/FinanceiroEmpresaContextoService');
const ContasPagarService = require('../motores/mcf/services/ContasPagarService');

const anexarEmpresa = middlewareResolverEmpresaFinanceiro({ db });
router.use(anexarEmpresa);

function responderErro(res, err) {
  const status = err.statusCode || statusDeErroEmpresa(err) || 500;
  return res.status(status).json({
    success: false,
    error: err.message || 'Erro interno',
    code: err.code || null
  });
}

router.get('/', async (req, res) => {
  try {
    const contas = await ContasPagarService.listar({
      db,
      empresaId: req.empresaId,
      status: req.query.status,
      fornecedor_id: req.query.fornecedor_id,
      limite: req.query.limite
    });
    return res.json({ success: true, contas });
  } catch (err) {
    return responderErro(res, err);
  }
});

router.get('/:id', async (req, res) => {
  try {
    const conta = await ContasPagarService.obter({
      db,
      empresaId: req.empresaId,
      id: req.params.id
    });
    return res.json({ success: true, conta });
  } catch (err) {
    return responderErro(res, err);
  }
});

router.get('/:id/pagamentos', async (req, res) => {
  try {
    const out = await ContasPagarService.listarPagamentos({
      db,
      empresaId: req.empresaId,
      id: req.params.id
    });
    return res.json({ success: true, ...out });
  } catch (err) {
    return responderErro(res, err);
  }
});

router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    const conta = await ContasPagarService.criar({
      db,
      empresaId: req.empresaId,
      fornecedor_id: body.fornecedor_id,
      descricao: body.descricao,
      valor_original: body.valor_original != null ? body.valor_original : body.valor,
      data_emissao: body.data_emissao,
      data_vencimento: body.data_vencimento,
      documento: body.documento,
      origem: body.origem,
      referencia_tipo: body.referencia_tipo,
      referencia_id: body.referencia_id,
      observacao: body.observacao
    });
    return res.status(201).json({ success: true, conta });
  } catch (err) {
    return responderErro(res, err);
  }
});

router.post('/:id/baixar', async (req, res) => {
  try {
    const body = req.body || {};
    const conta = await ContasPagarService.baixar({
      db,
      empresaId: req.empresaId,
      id: req.params.id,
      valor_pago: body.valor_pago != null ? body.valor_pago : body.valor,
      data_pagamento: body.data_pagamento,
      forma_pagamento: body.forma_pagamento,
      observacao: body.observacao
    });
    return res.json({ success: true, conta });
  } catch (err) {
    return responderErro(res, err);
  }
});

module.exports = router;
