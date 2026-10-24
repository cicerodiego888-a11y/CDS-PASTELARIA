/**
 * Rotas — Mesas (cadastro por empresa). Contexto de empresa via req.empresaId.
 * Não há exclusão: mesas são desativadas para preservar o histórico dos pedidos.
 */
'use strict';

const express = require('express');
const router = express.Router();
const db = require('../database');
const { exigirRecurso } = require('../middleware/validarRecursoImplantacao');
const { criarMiddlewareContextoEmpresa } = require('../services/fiscalNaoFiscal/empresaContexto');
const { empresaIdDoReqPedido } = require('../services/pedido/empresaIdDoReqPedido');
const MesaService = require('../services/pedido/MesaService');

router.use(exigirRecurso('pedidos'));
router.use(criarMiddlewareContextoEmpresa(db));

function responder(res, err) {
  const status = err.statusCode || 500;
  res.status(status).json({
    success: false,
    error: err.message || 'Erro interno.',
    mensagem: err.message || 'Erro interno.',
    codigo: err.codigo || err.code || undefined
  });
}

router.get('/', async (req, res) => {
  try {
    const somenteAtivas = ['1', 'true'].includes(String(req.query.ativas || '').toLowerCase());
    res.json(await MesaService.listar(empresaIdDoReqPedido(req), { somenteAtivas }));
  } catch (err) {
    responder(res, err);
  }
});

router.post('/', async (req, res) => {
  try {
    res.status(201).json(await MesaService.criar(empresaIdDoReqPedido(req), req.body || {}));
  } catch (err) {
    responder(res, err);
  }
});

router.put('/:id', async (req, res) => {
  try {
    res.json(await MesaService.atualizar(empresaIdDoReqPedido(req), req.params.id, req.body || {}));
  } catch (err) {
    responder(res, err);
  }
});

module.exports = router;
