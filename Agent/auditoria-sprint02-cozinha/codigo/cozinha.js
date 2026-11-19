/**
 * Rotas — Cozinha (Sprint 02: despacho)
 */
'use strict';

const express = require('express');
const router = express.Router();
const db = require('../database');
const { exigirRecurso } = require('../middleware/validarRecursoImplantacao');
const { criarMiddlewareContextoEmpresa } = require('../services/fiscalNaoFiscal/empresaContexto');
const { empresaIdDoReqPedido } = require('../services/pedido/empresaIdDoReqPedido');
const CozinhaDespacho = require('../services/cozinha/CozinhaDespachoService');
const { isCozinhaOperacional, getCozinhaSchemaStatus } = require('../utils/cozinhaSchema');

router.use(exigirRecurso('pedidos'));
router.use(criarMiddlewareContextoEmpresa(db));

function responderErro(res, err) {
  const status = err.statusCode || 500;
  const payload = {
    success: false,
    error: err.message || 'Erro interno.',
    mensagem: err.message || 'Erro interno.',
    codigo: err.codigo || err.code || undefined
  };
  if (err.detalhes) payload.detalhes = err.detalhes;
  return res.status(status).json(payload);
}

function operadorDaSessao(req) {
  const id = Number(req.user && (req.user.id || req.user.usuario_id));
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('Sessão sem operador.');
    err.statusCode = 401;
    err.codigo = 'SESSAO_INVALIDA';
    throw err;
  }
  return id;
}

function chaveIdempotencia(req) {
  const header = req.get('Idempotency-Key');
  const corpo = req.body && (req.body.idempotency_key || req.body.chave_idempotencia);
  if (header == null && (corpo == null || String(corpo).trim() === '')) return null;
  return String(header || corpo).trim();
}

router.get('/status', (req, res) => {
  res.json({
    success: true,
    operacional: isCozinhaOperacional(),
    schema: getCozinhaSchemaStatus()
  });
});

router.post('/despacho', async (req, res) => {
  try {
    if (!isCozinhaOperacional()) {
      const st = getCozinhaSchemaStatus();
      return res.status(503).json({
        success: false,
        codigo: 'COZINHA_NAO_OPERACIONAL',
        mensagem: (st.erro && st.erro.mensagem) || 'Módulo Cozinha não operacional.',
        detalhes: st
      });
    }

    const body = req.body || {};
    const out = await CozinhaDespacho.despacharLote({
      empresaId: empresaIdDoReqPedido(req),
      operadorId: operadorDaSessao(req),
      idempotencyKey: chaveIdempotencia(req),
      unidade_id: body.unidade_id,
      mesa_id: body.mesa_id,
      atendimento_id: body.atendimento_id,
      itens: body.itens
    });
    return res.status(out.repetida ? 200 : 201).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});

module.exports = router;
