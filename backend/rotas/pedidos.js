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
const { iniciarVendaPorValorPasteis } = require('../services/vendas/VendaPorValorPasteisService');
const PedidoFaturamentoOperacaoRepository = require('../services/faturamento/PedidoFaturamentoOperacaoRepository');
const FaturamentoService = require('../services/faturamento/FaturamentoService');
const PedidoPreparacaoService = require('../services/pedido/PedidoPreparacaoService');
const MesaAtendimentoService = require('../services/pedido/MesaAtendimentoService');
const VendaConsolidadaMesa = require('../services/vendas/VendaConsolidadaMesaService');
const ComandaSnapshot = require('../services/cozinha/CozinhaComandaSnapshotService');
const { htmlComanda } = require('../services/cozinha/CozinhaComandaRenderer');
const { validarUnidadeCozinhaNoLogin } = require('../services/cozinha/cozinhaAuthUnidade');
const { validarLiberacaoPdv } = require('../services/cozinha/CozinhaLiberacaoPdvService');

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
  if (err.pendencias) payload.pendencias = err.pendencias;
  if (err.consolidacao_id != null) payload.consolidacao_id = err.consolidacao_id;
  if (err.pedido_id != null) payload.pedido_id = err.pedido_id;
  if (err.codigo === 'MODULO_NAO_LICENCIADO') {
    payload.erro = 'MODULO_NAO_LICENCIADO';
    payload.modulo = 'pedidos';
  }
  return res.status(status).json(payload);
}

router.get('/', async (req, res) => {
  try {
    const empresaId = empresaIdDoReqPedido(req);
    const mesaId = req.query.mesa_id == null || req.query.mesa_id === ''
      ? null
      : Number(req.query.mesa_id);
    const mesaAtendimentoId = req.query.mesa_atendimento_id == null || req.query.mesa_atendimento_id === ''
      ? null
      : Number(req.query.mesa_atendimento_id);
    if (mesaId != null || mesaAtendimentoId != null) {
      if (
        !Number.isInteger(mesaId) || mesaId <= 0
        || !Number.isInteger(mesaAtendimentoId) || mesaAtendimentoId <= 0
      ) {
        const err = new Error('Informe uma mesa e um atendimento válidos para filtrar os pedidos.');
        err.statusCode = 400;
        err.codigo = 'FILTRO_MESA_INVALIDO';
        throw err;
      }
      const atendimento = await MesaAtendimentoService.consultarAtivo(empresaId, mesaId, { db });
      if (!atendimento.atendimento || Number(atendimento.atendimento.id) !== mesaAtendimentoId) {
        return res.json({ success: true, itens: [] });
      }
    }
    const out = await PedidoOperacional.listar({
      status: req.query.status,
      cliente: req.query.cliente,
      representante: req.query.representante,
      dataInicio: req.query.dataInicio || req.query.inicio,
      dataFim: req.query.dataFim || req.query.fim,
      busca: req.query.busca || req.query.q,
      limite: req.query.limite,
      empresaId,
      mesaId,
      mesaAtendimentoId
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

router.get('/:id/liberacao-pdv', async (req, res) => {
  try {
    const pedidoId = Number(req.params.id);
    const empresaId = empresaIdDoReqPedido(req);
    await validarLiberacaoPdv({ pedidoId, empresaId }, { db });
    return res.json({
      success: true,
      liberado: true,
      pedido_id: pedidoId,
      pendencias: []
    });
  } catch (err) {
    if (err && err.codigo === 'COZINHA_RETIRADA_PENDENTE') {
      return res.json({
        success: true,
        liberado: false,
        pedido_id: Number(req.params.id),
        mensagem: err.message,
        pendencias: err.pendencias || []
      });
    }
    return responderErro(res, err);
  }
});

router.post('/', async (req, res) => {
  try {
    const out = await EntradaPedido.receber({
      canal: EntradaPedido.CanalOrigem.EQUIPE,
      body: req.body || {},
      operadorId: req.user?.id || null,
      empresaId: empresaIdDoReqPedido(req),
      chaveIdempotencia: req.get('Idempotency-Key'),
      canalVendaCodigo: req.canalVendaCodigo,
      usuario: req.user,
      db
    });
    res.status(201).json(out);
  } catch (err) {
    responderErro(res, err);
  }
});

router.post('/venda-por-valor-pasteis', async (req, res) => {
  try {
    const body = req.body || {};
    const out = await iniciarVendaPorValorPasteis({
      db,
      empresaId: empresaIdDoReqPedido(req),
      operadorId: req.user?.id || null,
      chaveIdempotencia: req.get('Idempotency-Key') || body.chave_idempotencia || null,
      valorTotal: body.valor_total != null ? body.valor_total : body.valorTotal,
      quantidadePasteis: body.quantidade_pasteis != null
        ? body.quantidade_pasteis
        : body.quantidadePasteis,
      produtoPastelId: body.produto_pastel_id != null
        ? body.produto_pastel_id
        : body.produtoPastelId,
      clienteId: body.cliente_id != null ? body.cliente_id : body.clienteId
    });
    res.status(out.pedido_repetido || out.recuperacao ? 200 : 201).json(out);
  } catch (err) {
    responderErro(res, err);
  }
});

router.post('/venda-consolidada-mesa', async (req, res) => {
  try {
    const out = await VendaConsolidadaMesa.preparar({
      empresaId: empresaIdDoReqPedido(req),
      mesaId: (req.body || {}).mesa_id,
      pedidoIds: (req.body || {}).pedido_ids,
      operadorId: req.user && (req.user.id || req.user.usuario_id),
      idempotencyKey: req.get('Idempotency-Key') || (req.body || {}).idempotency_key
    }, { db });
    res.json({ success: true, ...out });
  } catch (err) {
    responderErro(res, err);
  }
});

router.post('/venda-consolidada-mesa/:consolidacaoId/vincular', async (req, res) => {
  try {
    const out = await VendaConsolidadaMesa.vincular({
      empresaId: empresaIdDoReqPedido(req),
      consolidacaoId: Number(req.params.consolidacaoId),
      vendaId: Number((req.body || {}).venda_id),
      operadorId: req.user && (req.user.id || req.user.usuario_id)
    }, { db });
    res.json({
      success: true,
      venda_id: out.venda_id,
      idempotente: out.idempotente === true,
      mesa: out.mesa || null
    });
  } catch (err) {
    responderErro(res, err);
  }
});

router.post('/venda-consolidada-mesa/:consolidacaoId/liberar', async (req, res) => {
  try {
    const out = await VendaConsolidadaMesa.liberarReserva({
      empresaId: empresaIdDoReqPedido(req),
      consolidacaoId: Number(req.params.consolidacaoId)
    }, { db });
    res.json({
      success: true,
      consolidacao_id: out.consolidacao_id,
      idempotente: out.idempotente === true
    });
  } catch (err) {
    responderErro(res, err);
  }
});

router.post('/:id/preparar-venda-pdv', async (req, res) => {
  try {
    const empresaId = empresaIdDoReqPedido(req);
    await validarLiberacaoPdv({ pedidoId: req.params.id, empresaId }, { db });
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
    await validarLiberacaoPdv(
      { pedidoId: req.params.id, empresaId: empresaIdDoReqPedido(req) },
      { db }
    );
    const out = await FaturamentoService.finalizarVendaPdvPedido(req.params.id, req);
    res.json({
      success: true,
      pedido: out.pedido,
      venda_id: out.venda_id,
      idempotente: out.idempotente === true,
      mesa: out.mesa || null
    });
  } catch (err) {
    responderErro(res, err);
  }
});

router.post('/:id/abandonar-venda-pdv', async (req, res) => {
  try {
    const out = await PedidoFaturamentoOperacaoRepository.abandonarOperacaoPdv(
      Number(req.params.id),
      empresaIdDoReqPedido(req),
      { db }
    );
    res.json({
      success: true,
      pedido_id: Number(req.params.id),
      liberado: out.liberado === true,
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

async function comandaAutorizada(req, snapshotId) {
  const empresaId = empresaIdDoReqPedido(req);
  const id = Number(snapshotId);
  if (!Number.isInteger(id) || id <= 0) {
    throw ComandaSnapshot.erro('Snapshot inválido.', 400, 'SNAPSHOT_INVALIDO');
  }
  const referencia = await ComandaSnapshot.get(db, `
    SELECT unidade_id FROM cozinha_comanda_snapshots
    WHERE id = ? AND empresa_id = ?
  `, [id, empresaId]);
  if (!referencia) throw ComandaSnapshot.erro('Comanda não encontrada.', 404, 'SNAPSHOT_NAO_DISPONIVEL');
  const unidadeId = Number(referencia.unidade_id);
  const unidadeSessao = req.user && (req.user.unidade_cozinha_id || req.user.unidadeCozinhaId);
  if (unidadeSessao != null && Number(unidadeSessao) !== unidadeId) {
    throw ComandaSnapshot.erro('Unidade divergente da sessão.', 403, 'UNIDADE_ISOLAMENTO');
  }
  await validarUnidadeCozinhaNoLogin({
    db, usuario: req.user, unidadeCozinhaIdRaw: unidadeId, empresaIdRaw: empresaId
  });
  const snapshot = await ComandaSnapshot.obter(db, empresaId, unidadeId, id);
  return { empresaId, unidadeId, snapshot };
}

router.get('/:id/comanda-kds', async (req, res) => {
  try {
    operadorDaSessao(req);
    const empresaId = empresaIdDoReqPedido(req);
    const pedidoId = Number(req.params.id);
    if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
      throw ComandaSnapshot.erro('Pedido inválido.', 400, 'PEDIDO_INVALIDO');
    }
    const ref = await ComandaSnapshot.get(db, `
      SELECT s.id FROM cozinha_comanda_snapshots s
      JOIN cozinha_pedido_despachos d
        ON d.empresa_id = s.empresa_id AND d.pedido_id = s.pedido_id
        AND d.unidade_id = s.unidade_id AND d.rodada_id = s.rodada_id
        AND d.idempotency_key = s.idempotency_key
      WHERE s.empresa_id = ? AND s.pedido_id = ? AND d.status = 'CONCLUIDO'
    `, [empresaId, pedidoId]);
    if (!ref) throw ComandaSnapshot.erro('Comanda não encontrada.', 404, 'SNAPSHOT_NAO_DISPONIVEL');
    const autorizado = await comandaAutorizada(req, ref.id);
    return res.json({
      success: true,
      snapshot_id: autorizado.snapshot.id,
      html: htmlComanda(autorizado.snapshot.conteudo)
    });
  } catch (err) {
    return responderErro(res, err);
  }
});

router.post('/comanda-kds/:snapshotId/tentativas', async (req, res) => {
  try {
    const operadorId = operadorDaSessao(req);
    const { empresaId, unidadeId, snapshot } = await comandaAutorizada(req, req.params.snapshotId);
    let tentativa;
    try {
      tentativa = await ComandaSnapshot.run(db, `
        INSERT INTO cozinha_comanda_tentativas (snapshot_id, empresa_id, unidade_id, operador_id)
        VALUES (?, ?, ?, ?)
      `, [snapshot.id, empresaId, unidadeId, operadorId]);
    } catch (err) {
      if (err && err.code === 'SQLITE_CONSTRAINT') {
        throw ComandaSnapshot.erro('Já existe uma tentativa em andamento ou com resultado desconhecido.', 409, 'IMPRESSAO_EM_ANDAMENTO');
      }
      throw err;
    }
    return res.status(201).json({ success: true, tentativa_id: tentativa.id, snapshot: snapshot.conteudo });
  } catch (err) {
    return responderErro(res, err);
  }
});

router.post('/comanda-kds/:snapshotId/tentativas/:tentativaId', async (req, res) => {
  try {
    const operadorId = operadorDaSessao(req);
    const { empresaId, unidadeId, snapshot } = await comandaAutorizada(req, req.params.snapshotId);
    const tentativaId = Number(req.params.tentativaId);
    const estado = req.body && req.body.estado;
    if (!Number.isInteger(tentativaId) || tentativaId <= 0
      || !['ACEITA_PELO_SPOOLER', 'FALHA'].includes(estado)) {
      throw ComandaSnapshot.erro('Resultado de impressão inválido.', 400, 'IMPRESSAO_RESULTADO_INVALIDO');
    }
    const atualizado = await ComandaSnapshot.run(db, `
      UPDATE cozinha_comanda_tentativas
      SET estado = ?, detalhe = ?, concluida_em = CURRENT_TIMESTAMP
      WHERE id = ? AND snapshot_id = ? AND empresa_id = ? AND unidade_id = ?
        AND operador_id = ? AND estado = 'EM_ANDAMENTO'
    `, [estado, String(req.body.detalhe || '').slice(0, 500) || null, tentativaId,
      snapshot.id, empresaId, unidadeId, operadorId]);
    if (atualizado.changes !== 1) {
      throw ComandaSnapshot.erro('Tentativa não encontrada ou já finalizada.', 409, 'IMPRESSAO_TENTATIVA_INVALIDA');
    }
    return res.json({ success: true, estado });
  } catch (err) {
    return responderErro(res, err);
  }
});

router.post('/:id/preparacao/enviar', async (req, res) => {
  try {
    res.json(await PedidoPreparacaoService.enviar(empresaIdDoReqPedido(req), req.params.id, {
      operadorId: operadorDaSessao(req),
      idempotencyKey: chaveIdempotencia(req)
    }));
  } catch (err) {
    responderErro(res, err);
  }
});

router.post('/:id/preparacao/concluir', async (req, res) => {
  try {
    res.json(await PedidoPreparacaoService.concluir(empresaIdDoReqPedido(req), req.params.id, {
      operadorId: operadorDaSessao(req),
      idempotencyKey: chaveIdempotencia(req)
    }));
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
