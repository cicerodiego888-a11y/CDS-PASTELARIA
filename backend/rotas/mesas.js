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
const MesaAtendimentoService = require('../services/pedido/MesaAtendimentoService');
const PedidoPreparacaoService = require('../services/pedido/PedidoPreparacaoService');

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
  const bruta = header || corpo;
  if (bruta == null || String(bruta).trim() === '') return null;
  return String(bruta).trim();
}

function operadorSeHouver(req) {
  const id = Number(req.user && (req.user.id || req.user.usuario_id));
  return Number.isInteger(id) && id > 0 ? id : null;
}

router.get('/situacao', async (req, res) => {
  try {
    res.json(await MesaAtendimentoService.listarSituacao(empresaIdDoReqPedido(req), {
      operadorId: operadorSeHouver(req)
    }));
  } catch (err) {
    responder(res, err);
  }
});

router.get('/:id/atendimento/pedidos', async (req, res) => {
  try {
    res.json(await PedidoPreparacaoService.listarPorMesa(empresaIdDoReqPedido(req), req.params.id));
  } catch (err) {
    responder(res, err);
  }
});

router.get('/:id/atendimento', async (req, res) => {
  try {
    res.json(await MesaAtendimentoService.consultarAtivo(empresaIdDoReqPedido(req), req.params.id));
  } catch (err) {
    responder(res, err);
  }
});

router.post('/:id/atendimento', async (req, res) => {
  try {
    const resultado = await MesaAtendimentoService.abrir(empresaIdDoReqPedido(req), req.params.id, {
      operadorId: operadorDaSessao(req),
      clienteId: req.body && req.body.cliente_id,
      idempotencyKey: chaveIdempotencia(req)
    });
    res.status(resultado.repetida ? 200 : 201).json(resultado);
  } catch (err) {
    responder(res, err);
  }
});

router.post('/:id/atendimento/encerrar', async (req, res) => {
  try {
    res.json(await MesaAtendimentoService.encerrar(empresaIdDoReqPedido(req), req.params.id, {
      operadorId: operadorDaSessao(req)
    }));
  } catch (err) {
    responder(res, err);
  }
});

router.post('/:id/atendimento/transferir', async (req, res) => {
  try {
    res.json(await MesaAtendimentoService.transferir(empresaIdDoReqPedido(req), req.params.id, {
      mesaDestinoId: req.body && req.body.mesa_destino_id,
      operadorId: operadorDaSessao(req),
      idempotencyKey: chaveIdempotencia(req)
    }));
  } catch (err) {
    responder(res, err);
  }
});

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
