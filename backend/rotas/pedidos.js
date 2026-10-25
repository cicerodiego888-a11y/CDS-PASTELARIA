/**
 * Rotas — Módulo Pedidos (Sprint 3.5 + 3.14 Orçamento + RC3.16.1)
 * Gate: recursos.pedidos (Sprint 3.9 — herda faturamento quando flag ausente)
 */

'use strict';

const express = require('express');
const router = express.Router();
const db = require('../database');
const { exigirRecurso } = require('../middleware/validarRecursoImplantacao');
const { criarMiddlewareContextoEmpresa } = require('../services/fiscalNaoFiscal/empresaContexto');
const PedidoOperacional = require('../services/pedido/PedidoOperacionalService');
const EntradaPedido = require('../services/pedido/EntradaPedidoService');
const { empresaIdDoReqPedido } = require('../services/pedido/empresaIdDoReqPedido');
const { prepararComposicaoPedidoPdv } = require('../services/vendas/PedidoPdvComposicaoService');
const PedidoFaturamentoOperacaoRepository = require('../services/faturamento/PedidoFaturamentoOperacaoRepository');
const FaturamentoService = require('../services/faturamento/FaturamentoService');

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
  if (err.requer_autorizacao) payload.requer_autorizacao = true;
  if (err.plano) payload.plano = err.plano;
  if (err.consultas) payload.consultas = err.consultas;
  if (err.detalhes) payload.detalhes = err.detalhes;
  if (err.codigo === 'MODULO_NAO_LICENCIADO') {
    payload.erro = 'MODULO_NAO_LICENCIADO';
    payload.modulo = 'pedidos';
  }
  return res.status(status).json(payload);
}

router.get('/', async (req, res) => {
  try {
    const out = await PedidoOperacional.listar({
      status: req.query.status,
      cliente: req.query.cliente,
      representante: req.query.representante,
      dataInicio: req.query.dataInicio || req.query.inicio,
      dataFim: req.query.dataFim || req.query.fim,
      busca: req.query.busca || req.query.q,
      limite: req.query.limite,
      empresaId: empresaIdDoReqPedido(req)
    });
    res.json(out);
  } catch (err) {
    responderErro(res, err);
  }
});

router.get('/:id', async (req, res) => {
  try {
    const out = await PedidoOperacional.obter(req.params.id, {
      empresaId: empresaIdDoReqPedido(req)
    });
    res.json(out);
  } catch (err) {
    responderErro(res, err);
  }
});

router.post('/', async (req, res) => {
  try {
    const out = await EntradaPedido.receber({
      canal: EntradaPedido.CanalOrigem.EQUIPE,
      body: req.body || {},
      operadorId: req.user?.id || null,
      empresaId: empresaIdDoReqPedido(req),
      chaveIdempotencia: req.get('Idempotency-Key')
    });
    res.status(201).json(out);
  } catch (err) {
    responderErro(res, err);
  }
});

router.post('/:id/preparar-venda-pdv', async (req, res) => {
  try {
    const empresaId = empresaIdDoReqPedido(req);
    const operacaoExistente = await PedidoFaturamentoOperacaoRepository.consultarOperacaoPdv(
      Number(req.params.id),
      empresaId
    );
    if (operacaoExistente?.operacao.venda_id != null) {
      const payloadPersistido = operacaoExistente.payload;
      return res.json({
        success: true,
        pedido_id: Number(req.params.id),
        empresa_id: empresaId,
        operacao_id: operacaoExistente.operacao.id,
        venda_id: operacaoExistente.operacao.venda_id,
        recuperacao: true,
        venda_concluida: operacaoExistente.operacao.status === 'FINALIZADA',
        total: payloadPersistido.total,
        desconto: payloadPersistido.desconto || 0,
        valor_composicao_bruto: payloadPersistido.valor_composicao_bruto || payloadPersistido.total,
        cliente_id: payloadPersistido.cliente_id || null,
        itens: payloadPersistido.itens,
        fingerprint: payloadPersistido.fingerprint
      });
    }
    const composicao = await prepararComposicaoPedidoPdv({
      pedidoId: req.params.id,
      empresaId
    }, { db });
    const payload = {
      pedidoId: composicao.pedidoId,
      empresaId: composicao.empresaId,
      fingerprint: composicao.fingerprint,
      total: composicao.valorFinalCentavos / 100,
      desconto: composicao.desconto,
      valor_composicao_bruto: composicao.valorCompostoBrutoCentavos / 100,
      cliente_id: composicao.clienteId,
      itens: composicao.itens
    };
    const preparacao = await PedidoFaturamentoOperacaoRepository.prepararOperacaoPdv(
      composicao.pedidoId,
      empresaId,
      payload
    );
    res.json({
      success: true,
      pedido_id: composicao.pedidoId,
      empresa_id: empresaId,
      operacao_id: preparacao.operacao.id,
      venda_id: preparacao.operacao.venda_id || null,
      recuperacao: preparacao.recuperacao,
      venda_concluida: preparacao.operacao.status === 'FINALIZADA',
      total: payload.total,
      desconto: payload.desconto,
      valor_composicao_bruto: payload.valor_composicao_bruto,
      cliente_id: preparacao.payload.cliente_id || null,
      itens: preparacao.payload.itens,
      fingerprint: preparacao.payload.fingerprint
    });
  } catch (err) {
    responderErro(res, err);
  }
});

router.post('/:id/finalizar-venda-pdv', async (req, res) => {
  try {
    const out = await FaturamentoService.finalizarVendaPdvPedido(req.params.id, req);
    res.json({
      success: true,
      pedido: out.pedido,
      venda_id: out.venda_id,
      idempotente: out.idempotente === true
    });
  } catch (err) {
    responderErro(res, err);
  }
});

router.put('/:id', async (req, res) => {
  try {
    const out = await PedidoOperacional.atualizar(
      req.params.id,
      req.body || {},
      { empresaId: empresaIdDoReqPedido(req) }
    );
    res.json(out);
  } catch (err) {
    responderErro(res, err);
  }
});

router.post('/:id/cancelar', async (req, res) => {
  try {
    const out = await PedidoOperacional.cancelar(req.params.id, {
      empresaId: empresaIdDoReqPedido(req),
      usuarioId: req.user?.id || null,
      chaveIdempotencia: req.get('Idempotency-Key')
    });
    res.json(out);
  } catch (err) {
    responderErro(res, err);
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const out = await PedidoOperacional.excluir(req.params.id, {
      empresaId: empresaIdDoReqPedido(req)
    });
    res.json(out);
  } catch (err) {
    responderErro(res, err);
  }
});

router.post('/:id/duplicar', async (req, res) => {
  try {
    const out = await PedidoOperacional.duplicar(
      req.params.id,
      req.user?.id || null,
      {
        empresaId: empresaIdDoReqPedido(req),
        chaveIdempotencia: req.get('Idempotency-Key'),
        exigirChaveIdempotencia: true
      }
    );
    res.status(201).json(out);
  } catch (err) {
    responderErro(res, err);
  }
});

router.post('/:id/converter', async (req, res) => {
  try {
    const out = await PedidoOperacional.converterParaPedido(
      req.params.id,
      req.body || {},
      req.user?.id || null,
      { empresaId: empresaIdDoReqPedido(req) }
    );
    res.json(out);
  } catch (err) {
    responderErro(res, err);
  }
});

router.post('/:id/enviar-faturamento', async (req, res) => {
  try {
    const out = await PedidoOperacional.enviarParaFaturamento(
      req.params.id,
      req.body || {},
      req.user?.id || null,
      { empresaId: empresaIdDoReqPedido(req) }
    );
    res.json(out);
  } catch (err) {
    responderErro(res, err);
  }
});

module.exports = router;
