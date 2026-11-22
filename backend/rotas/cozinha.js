/**
 * Rotas — Cozinha
 * Sprint 02: despacho | Sprint 03/05: preparação
 * Sprint 06 Bloco A: estações/contratos de impressão (sem print físico)
 * Sprint 06 Bloco B1: consulta da fila persistente
 * Sprint 06 Bloco D: reenvio controlado (sem Electron / sem print físico)
 */
'use strict';

const express = require('express');
const router = express.Router();
const db = require('../database');
const { exigirRecurso } = require('../middleware/validarRecursoImplantacao');
const { criarMiddlewareContextoEmpresa } = require('../services/fiscalNaoFiscal/empresaContexto');
const { empresaIdDoReqPedido } = require('../services/pedido/empresaIdDoReqPedido');
const CozinhaDespacho = require('../services/cozinha/CozinhaDespachoService');
const CozinhaPreparacao = require('../services/cozinha/CozinhaPreparacaoService');
const CozinhaKdsPainel = require('../services/cozinha/CozinhaKdsPainelService');
const CozinhaHistoricoPedidos = require('../services/cozinha/CozinhaHistoricoPedidosService');
const CozinhaSessaoUnidade = require('../services/cozinha/CozinhaSessaoUnidadeService');
const CozinhaUnidadeCadastro = require('../services/cozinha/CozinhaUnidadeCadastroService');
const CozinhaRoteamentoConfig = require('../services/cozinha/CozinhaRoteamentoConfigService');
const CozinhaCanais = require('../services/cozinha/CozinhaCanaisService');
const CozinhaImpressaoEstacao = require('../services/cozinha/CozinhaImpressaoEstacaoService');
const CozinhaImpressaoFila = require('../services/cozinha/CozinhaImpressaoFilaService');
const CozinhaRetiradaLedger = require('../services/cozinha/CozinhaRetiradaLedgerService');
const CozinhaTurno = require('../services/cozinha/CozinhaTurnoService');
const { verificarToken } = require('../middleware/auth');
const { exigirSenhaAdmin } = require('../middleware/exigirSenhaAdmin');
const {
  montarPayloadSnapshot,
  serializarSnapshot,
  snapshotContemCamposProibidos
} = require('../services/cozinha/cozinhaImpressaoContratos');
const { renderizarTexto } = require('../services/cozinha/CozinhaImpressaoRenderer');
const {
  resolverUnidadeOperacionalReq,
  unidadeCozinhaDaSessao
} = require('../services/cozinha/cozinhaUnidadeOperacional');
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
  if (Array.isArray(err.pendencias)) payload.pendencias = err.pendencias;
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

async function exigirTurnoDaRequisicao(req) {
  return CozinhaTurno.exigirTurnoAberto({
    empresaId: empresaIdDoReqPedido(req),
    unidadeId: resolverUnidadeOperacionalReq(req)
  }, { db });
}

async function contextoGerencialDaRequisicao(req) {
  return CozinhaTurno.exigirAcessoGerencial({
    operadorId: operadorDaSessao(req),
    unidadeId: resolverUnidadeOperacionalReq(req)
  }, { db });
}

function chaveIdempotencia(req) {
  const header = req.get('Idempotency-Key');
  const corpo = req.body && (req.body.idempotency_key || req.body.chave_idempotencia);
  if (header == null && (corpo == null || String(corpo).trim() === '')) return null;
  return String(header || corpo).trim();
}

router.get('/status', (req, res) => {
  const st = getCozinhaSchemaStatus();
  if (!st.operacional && st.erro) {
    console.error('[COZINHA][status] módulo não operacional:', st.erro.mensagem || st.erro);
  }
  return res.json({
    success: true,
    operacional: isCozinhaOperacional(),
    versao_schema: st.versao != null ? st.versao : null
  });
});

router.get('/turnos/status', async (req, res) => {
  try {
    const out = await CozinhaTurno.statusTurno({
      empresaId: empresaIdDoReqPedido(req),
      unidadeId: resolverUnidadeOperacionalReq(req)
    }, { db });
    return res.status(200).json(out);
  } catch (err) { return responderErro(res, err); }
});

router.post('/turnos/abrir', async (req, res) => {
  try {
    const out = await CozinhaTurno.abrirTurno({
      empresaId: empresaIdDoReqPedido(req),
      unidadeId: resolverUnidadeOperacionalReq(req),
      operadorId: operadorDaSessao(req)
    }, { db });
    return res.status(201).json(out);
  } catch (err) { return responderErro(res, err); }
});

router.post('/turnos/fechar', async (req, res) => {
  try {
    const body = req.body || {};
    const contexto = await contextoGerencialDaRequisicao(req);
    const empresaInformada = empresaIdDoReqPedido(req);
    const out = await CozinhaTurno.fecharTurno({
      empresaId: empresaInformada == null ? contexto.empresaId : empresaInformada,
      unidadeId: contexto.unidadeId,
      operadorId: contexto.operadorId,
      tipo: body.tipo,
      justificativa: body.justificativa
    }, { db });
    return res.status(200).json(out);
  } catch (err) { return responderErro(res, err); }
});

router.get('/turnos/historico', async (req, res) => {
  try {
    const contexto = await contextoGerencialDaRequisicao(req);
    const out = await CozinhaTurno.listarHistorico({
      empresaId: contexto.empresaId,
      unidadeId: contexto.unidadeId,
      limite: req.query.limit
    }, { db });
    return res.status(200).json(out);
  } catch (err) { return responderErro(res, err); }
});

router.get('/gerencial/historico-pedidos-retirados', async (req, res) => {
  try {
    const out = await CozinhaHistoricoPedidos.listarHistoricoPedidosRetirados({
      operadorId: operadorDaSessao(req),
      unidadeId: resolverUnidadeOperacionalReq(req),
      data: req.query.data,
      turnoId: req.query.turno_id,
      pedido: req.query.pedido,
      mesa: req.query.mesa,
      garcom: req.query.garcom,
      produto: req.query.produto,
      categoria: req.query.categoria,
      limite: req.query.limite,
      offset: req.query.offset
    }, { db });
    return res.status(200).json(out);
  } catch (err) { return responderErro(res, err); }
});

router.get('/turnos/:id/relatorio', async (req, res) => {
  try {
    const contexto = await contextoGerencialDaRequisicao(req);
    const out = await CozinhaTurno.gerarRelatorio({
      empresaId: contexto.empresaId,
      unidadeId: contexto.unidadeId,
      turnoId: req.params.id
    }, { db });
    return res.status(200).json(out);
  } catch (err) { return responderErro(res, err); }
});

router.get('/gerencial/painel', async (req, res) => {
  try {
    const contexto = await contextoGerencialDaRequisicao(req);
    const status = await CozinhaTurno.statusTurno({
      empresaId: contexto.empresaId,
      unidadeId: contexto.unidadeId
    }, { db });
    const turno = status.turno;
    const historico = turno ? null : await CozinhaTurno.listarHistorico({
      empresaId: contexto.empresaId,
      unidadeId: contexto.unidadeId,
      limite: 1
    }, { db });
    const turnoRelatorio = turno || (historico && historico.turnos[0]) || null;
    const painel = turno
      ? await CozinhaKdsPainel.listarPainelPreparacao({
        empresaId: contexto.empresaId,
        unidadeId: contexto.unidadeId,
        turnoId: turno.id,
        limite: 100,
        fila: 'ativa'
      }, { db })
      : { success: true, empresa_id: contexto.empresaId, unidade_id: contexto.unidadeId, rodadas: [] };
    const relatorio = turnoRelatorio
      ? await CozinhaTurno.gerarRelatorio({
        empresaId: contexto.empresaId,
        unidadeId: contexto.unidadeId,
        turnoId: turnoRelatorio.id
      }, { db })
      : null;
    return res.status(200).json({
      success: true,
      empresa_id: contexto.empresaId,
      unidade: { id: contexto.unidadeId, codigo: contexto.unidadeCodigo },
      operador_nome: contexto.operadorNome,
      estado: status.estado,
      turno,
      turno_relatorio: turnoRelatorio,
      painel,
      relatorio
    });
  } catch (err) { return responderErro(res, err); }
});

router.get('/gerencial/turnos/historico', async (req, res) => {
  try {
    const contexto = await contextoGerencialDaRequisicao(req);
    const out = await CozinhaTurno.listarHistorico({
      empresaId: contexto.empresaId,
      unidadeId: contexto.unidadeId,
      limite: req.query.limit
    }, { db });
    return res.status(200).json(out);
  } catch (err) { return responderErro(res, err); }
});

router.get('/gerencial/turnos/:id/relatorio', async (req, res) => {
  try {
    const contexto = await contextoGerencialDaRequisicao(req);
    const out = await CozinhaTurno.gerarRelatorio({
      empresaId: contexto.empresaId,
      unidadeId: contexto.unidadeId,
      turnoId: req.params.id
    }, { db });
    return res.status(200).json(out);
  } catch (err) { return responderErro(res, err); }
});

router.get('/configuracoes', async (req, res) => {
  try {
    const empresaRaw = req.query.empresa_id != null ? req.query.empresa_id : req.query.empresaId;
    const unidadeRaw = req.query.unidade_id != null ? req.query.unidade_id : req.query.unidadeCozinhaId;
    const out = await CozinhaTurno.obterConfiguracoes({
      empresaId: empresaRaw != null ? empresaRaw : empresaIdDoReqPedido(req),
      unidadeId: unidadeRaw != null ? unidadeRaw : resolverUnidadeOperacionalReq(req),
      operadorId: operadorDaSessao(req)
    }, { db });
    return res.status(200).json(out);
  } catch (err) { return responderErro(res, err); }
});

router.put('/configuracoes', async (req, res) => {
  try {
    const body = req.body || {};
    const out = await CozinhaTurno.salvarConfiguracoes({
      empresaId: body.empresa_id != null ? body.empresa_id : empresaIdDoReqPedido(req),
      unidadeId: body.unidade_id != null ? body.unidade_id : resolverUnidadeOperacionalReq(req),
      operadorId: operadorDaSessao(req),
      config: req.body || {}
    }, { db });
    return res.status(200).json(out);
  } catch (err) { return responderErro(res, err); }
});

function exigirCozinhaOperacional(res) {
  if (isCozinhaOperacional()) return true;
  const st = getCozinhaSchemaStatus();
  if (st.erro) {
    console.error('[COZINHA] não operacional:', st.erro.mensagem || st.erro);
  }
  res.status(503).json({
    success: false,
    codigo: 'COZINHA_NAO_OPERACIONAL',
    mensagem: 'Módulo Cozinha não operacional.'
  });
  return false;
}

router.post('/despacho', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    await CozinhaTurno.exigirTurnoAberto({
      empresaId: empresaIdDoReqPedido(req),
      unidadeId: resolverUnidadeOperacionalReq(req)
    }, { db });
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
    const turnoDespacho = await CozinhaTurno.statusTurno({
      empresaId: empresaIdDoReqPedido(req),
      unidadeId: resolverUnidadeOperacionalReq(req)
    }, { db });
    if (turnoDespacho.turno) {
      for (const item of (Array.isArray(body.itens) ? body.itens : [])) {
        await CozinhaTurno.vincularPedidoAoTurno(db, {
          empresaId: empresaIdDoReqPedido(req),
          unidadeId: resolverUnidadeOperacionalReq(req),
          turnoId: turnoDespacho.turno.id,
          pedidoId: item.pedido_id,
          pedidoItemId: item.pedido_item_id,
          cozinhaItemId: null,
          rodadaId: out.rodada ? out.rodada.id : null
        });
      }
    }
    return res.status(out.repetida ? 200 : 201).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});

router.post('/itens/:id/iniciar', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    await exigirTurnoDaRequisicao(req);
    const out = await CozinhaPreparacao.iniciarPreparacao({
      empresaId: empresaIdDoReqPedido(req),
      operadorId: operadorDaSessao(req),
      idempotencyKey: chaveIdempotencia(req),
      itemId: req.params.id,
      // unidade autoritativa = JWT (body/query só podem coincidir)
      unidade_id: resolverUnidadeOperacionalReq(req)
    });
    return res.status(200).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});

router.post('/itens/:id/aguardando', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    await exigirTurnoDaRequisicao(req);
    const out = await CozinhaPreparacao.voltarParaAguardando({
      empresaId: empresaIdDoReqPedido(req),
      operadorId: operadorDaSessao(req),
      idempotencyKey: chaveIdempotencia(req),
      itemId: req.params.id,
      unidade_id: resolverUnidadeOperacionalReq(req)
    });
    return res.status(200).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});

router.post('/itens/:id/pronto', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    await exigirTurnoDaRequisicao(req);
    const out = await CozinhaPreparacao.marcarItemPronto({
      empresaId: empresaIdDoReqPedido(req),
      operadorId: operadorDaSessao(req),
      idempotencyKey: chaveIdempotencia(req),
      itemId: req.params.id,
      unidade_id: resolverUnidadeOperacionalReq(req)
    });
    return res.status(200).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});

router.post('/rodadas/:id/retirada', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    await exigirTurnoDaRequisicao(req);
    const out = await CozinhaPreparacao.confirmarRetirada({
      empresaId: empresaIdDoReqPedido(req),
      operadorId: operadorDaSessao(req),
      idempotencyKey: chaveIdempotencia(req),
      rodadaId: req.params.id,
      unidade_id: resolverUnidadeOperacionalReq(req)
    });
    return res.status(200).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});

router.post('/itens/:id/retirada-ledger', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    await exigirTurnoDaRequisicao(req);
    const out = await CozinhaRetiradaLedger.retirarItem({
      empresaId: empresaIdDoReqPedido(req),
      operadorId: operadorDaSessao(req),
      unidade_id: resolverUnidadeOperacionalReq(req),
      itemId: req.params.id,
      usar_saldo_pendente: true,
      idempotencyKey: chaveIdempotencia(req)
    });
    return res.status(out.repetida ? 200 : 201).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});

router.post('/retiradas/:id/estornar', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    await exigirTurnoDaRequisicao(req);
    const body = req.body || {};
    const out = await CozinhaRetiradaLedger.estornarRetirada({
      empresaId: empresaIdDoReqPedido(req),
      operadorId: operadorDaSessao(req),
      unidade_id: resolverUnidadeOperacionalReq(req),
      eventoId: req.params.id,
      qty_millis: body.qty_millis,
      quantidade: body.quantidade,
      justificativa: body.justificativa,
      autorizadoPorOperadorId: body.autorizado_por_operador_id,
      idempotencyKey: chaveIdempotencia(req)
    });
    return res.status(out.repetida ? 200 : 201).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});

router.post('/itens/:id/cancelar', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    await exigirTurnoDaRequisicao(req);
    const body = req.body || {};
    const out = await CozinhaPreparacao.cancelarItem({
      empresaId: empresaIdDoReqPedido(req),
      operadorId: operadorDaSessao(req),
      idempotencyKey: chaveIdempotencia(req),
      itemId: req.params.id,
      unidade_id: resolverUnidadeOperacionalReq(req),
      motivo: body.motivo,
      justificativa: body.justificativa
    });
    return res.status(200).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});

router.post('/itens/:id/cancelamento-ledger', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    await exigirTurnoDaRequisicao(req);
    const body = req.body || {};
    const out = await CozinhaRetiradaLedger.cancelarItem({
      empresaId: empresaIdDoReqPedido(req),
      operadorId: operadorDaSessao(req),
      unidade_id: resolverUnidadeOperacionalReq(req),
      itemId: req.params.id,
      qty_millis: body.qty_millis,
      quantidade: body.quantidade,
      justificativa: body.justificativa,
      idempotencyKey: chaveIdempotencia(req)
    });
    return res.status(out.repetida ? 200 : 201).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});

router.post('/cancelamentos/:id/estornar', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    await exigirTurnoDaRequisicao(req);
    const body = req.body || {};
    const out = await CozinhaRetiradaLedger.estornarCancelamento({
      empresaId: empresaIdDoReqPedido(req),
      operadorId: operadorDaSessao(req),
      unidade_id: resolverUnidadeOperacionalReq(req),
      eventoId: req.params.id,
      qty_millis: body.qty_millis,
      quantidade: body.quantidade,
      justificativa: body.justificativa,
      autorizadoPorOperadorId: body.autorizado_por_operador_id,
      idempotencyKey: chaveIdempotencia(req)
    });
    return res.status(out.repetida ? 200 : 201).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});

router.post(
  '/itens/:id/ajuste-retirada',
  verificarToken,
  (req, res, next) => {
    if (!exigirCozinhaOperacional(res)) return;
    next();
  },
  exigirSenhaAdmin,
  async (req, res) => {
    try {
      await exigirTurnoDaRequisicao(req);
      const body = req.body || {};
      const operadorId = operadorDaSessao(req);
      const out = await CozinhaRetiradaLedger.ajustarRetirada({
        empresaId: empresaIdDoReqPedido(req),
        operadorId,
        autorizadoPorOperadorId: req.adminAutorizadorId,
        unidade_id: resolverUnidadeOperacionalReq(req),
        eventoId: body.evento_origem_id,
        tipo_evento: body.tipo_evento,
        qty_millis: body.qty_millis,
        quantidade: body.quantidade,
        justificativa: body.justificativa,
        idempotencyKey: chaveIdempotencia(req),
        adminAutorizado: true
      });
      return res.status(out.repetida ? 200 : 201).json(out);
    } catch (err) {
      return responderErro(res, err);
    }
  }
);

router.post('/rodadas/:id/cancelar', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    await exigirTurnoDaRequisicao(req);
    const body = req.body || {};
    const out = await CozinhaPreparacao.cancelarRodada({
      empresaId: empresaIdDoReqPedido(req),
      operadorId: operadorDaSessao(req),
      idempotencyKey: chaveIdempotencia(req),
      rodadaId: req.params.id,
      unidade_id: resolverUnidadeOperacionalReq(req),
      motivo: body.motivo,
      justificativa: body.justificativa
    });
    return res.status(out.repetida ? 200 : 200).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});

router.post('/itens/:id/bebida/entregar', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    await exigirTurnoDaRequisicao(req);
    const out = await CozinhaPreparacao.entregarBebida({
      empresaId: empresaIdDoReqPedido(req),
      operadorId: operadorDaSessao(req),
      idempotencyKey: chaveIdempotencia(req),
      itemId: req.params.id,
      unidade_id: resolverUnidadeOperacionalReq(req),
      usar_saldo_pendente: true
    });
    return res.status(out.repetida ? 200 : 201).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});

router.get('/rodadas/:id/preparacao', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    const out = await CozinhaPreparacao.consultarPreparacaoRodada({
      empresaId: empresaIdDoReqPedido(req),
      rodadaId: req.params.id
    });
    return res.status(200).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});

function bearerTokenDoReq(req) {
  const h = req.get && req.get('Authorization');
  if (!h || typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/**
 * S07-2 — Unidades de cozinha autorizadas na empresa do contexto.
 */
router.get('/unidades-disponiveis', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    const empresaRaw = req.query.empresa_id != null ? req.query.empresa_id : req.query.empresaId;
    const out = await CozinhaSessaoUnidade.listarUnidadesDisponiveis({
      user: req.user,
      empresaId: empresaRaw != null ? empresaRaw : empresaIdDoReqPedido(req)
    }, { db });
    return res.status(200).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});

/**
 * S07-2 — Gestão administrativa: listar unidades da empresa (inclui inativas).
 * Empresa somente do contexto autenticado. Admin operacional obrigatório.
 */
router.get('/unidades', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    const out = await CozinhaUnidadeCadastro.listarUnidadesGestao({
      user: req.user,
      empresaId: empresaIdDoReqPedido(req)
    }, { db });
    return res.status(200).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});

/**
 * S07-2 — Gestão administrativa: cadastrar unidade.
 * Body: { codigo, ativo? }. empresa_id do corpo é ignorado (não autoriza).
 */
router.post('/unidades', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    const body = req.body || {};
    const out = await CozinhaUnidadeCadastro.criarUnidade({
      user: req.user,
      empresaId: empresaIdDoReqPedido(req),
      codigoRaw: body.codigo,
      ativoRaw: body.ativo,
      bodyEmpresaIdIgnored: body.empresa_id != null ? body.empresa_id : body.empresaId
    }, { db });
    return res.status(201).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});

/**
 * S07-2 — Gestão administrativa: ativar/inativar unidade da empresa do contexto.
 * Body: { ativo }. Impede alteração de unidade de outra empresa.
 */
router.patch('/unidades/:id', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    const body = req.body || {};
    const out = await CozinhaUnidadeCadastro.alterarSituacaoUnidade({
      user: req.user,
      empresaId: empresaIdDoReqPedido(req),
      unidadeIdRaw: req.params.id,
      ativoRaw: body.ativo
    }, { db });
    return res.status(200).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});

/**
 * S07-3A — Consulta configuração de roteamento de cozinhas (admin operacional).
 * Empresa somente do contexto autenticado.
 */
router.get('/roteamento', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    const out = await CozinhaRoteamentoConfig.obterConfiguracao({
      user: req.user,
      empresaId: empresaIdDoReqPedido(req)
    }, { db });
    return res.status(200).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});

/**
 * S07-3A — Define modo de distribuição: COZINHA_PADRAO | COZINHA_POR_SEGMENTO.
 * Body: { modo }. empresa_id do corpo é ignorado.
 */
router.put('/roteamento/modo', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    const body = req.body || {};
    const out = await CozinhaRoteamentoConfig.definirModo({
      user: req.user,
      empresaId: empresaIdDoReqPedido(req),
      modoRaw: body.modo,
      bodyEmpresaIdIgnored: body.empresa_id != null ? body.empresa_id : body.empresaId
    }, { db });
    return res.status(200).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});

/**
 * S07-3A — Define cozinha padrão (unidade ativa da empresa).
 * Body: { unidade_id }. empresa_id do corpo é ignorado.
 */
router.put('/roteamento/padrao', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    const body = req.body || {};
    const out = await CozinhaRoteamentoConfig.definirCozinhaPadrao({
      user: req.user,
      empresaId: empresaIdDoReqPedido(req),
      unidadeIdRaw: body.unidade_id != null ? body.unidade_id : body.unidadeId,
      bodyEmpresaIdIgnored: body.empresa_id != null ? body.empresa_id : body.empresaId
    }, { db });
    return res.status(200).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});

/**
 * S07-3A — Associa segmento de atendimento a uma unidade ativa.
 * Body: { segmento, unidade_id }. Sem destino → 400 SEGMENTO_SEM_DESTINO.
 */
router.put('/roteamento/segmentos', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    const body = req.body || {};
    const out = await CozinhaRoteamentoConfig.associarSegmento({
      user: req.user,
      empresaId: empresaIdDoReqPedido(req),
      segmentoRaw: body.segmento,
      unidadeIdRaw: body.unidade_id != null ? body.unidade_id : body.unidadeId,
      bodyEmpresaIdIgnored: body.empresa_id != null ? body.empresa_id : body.empresaId
    }, { db });
    return res.status(200).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});

/**
 * S07-3C — Lista canais dinâmicos da empresa (garante LOJA SISTEMA).
 */
router.get('/canais', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    const out = await CozinhaCanais.listarCanais({
      user: req.user,
      empresaId: empresaIdDoReqPedido(req)
    }, { db });
    return res.status(200).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});

/**
 * S07-3C — Cria canal MANUAL. Body: { nome }. Código gerado no servidor.
 */
router.post('/canais', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    const body = req.body || {};
    const out = await CozinhaCanais.criarCanal({
      user: req.user,
      empresaId: empresaIdDoReqPedido(req),
      nomeRaw: body.nome,
      bodyEmpresaIdIgnored: body.empresa_id != null ? body.empresa_id : body.empresaId
    }, { db });
    return res.status(201).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});

/**
 * S07-3C — Atualiza nome/ativo. Não altera código, origem nem empresa.
 */
router.patch('/canais/:id', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    const body = req.body || {};
    const out = await CozinhaCanais.atualizarCanal({
      user: req.user,
      empresaId: empresaIdDoReqPedido(req),
      canalIdRaw: req.params.id,
      nomeRaw: Object.prototype.hasOwnProperty.call(body, 'nome') ? body.nome : undefined,
      ativoRaw: Object.prototype.hasOwnProperty.call(body, 'ativo') ? body.ativo : undefined,
      bodyEmpresaIdIgnored: body.empresa_id != null ? body.empresa_id : body.empresaId,
      bodyCodigoIgnored: body.codigo,
      bodyOrigemIgnored: body.origem_tipo != null ? body.origem_tipo : body.origemTipo
    }, { db });
    return res.status(200).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});

/**
 * S07-3C — Define destino (unidade ativa da empresa). Body: { unidade_id }.
 */
router.put('/canais/:id/destino', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    const body = req.body || {};
    const out = await CozinhaCanais.definirDestinoCanal({
      user: req.user,
      empresaId: empresaIdDoReqPedido(req),
      canalIdRaw: req.params.id,
      unidadeIdRaw: body.unidade_id != null ? body.unidade_id : body.unidadeId,
      bodyEmpresaIdIgnored: body.empresa_id != null ? body.empresa_id : body.empresaId
    }, { db });
    return res.status(200).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});

/**
 * S07-2 — Seleciona unidade e emite novo JWT com claim unidade_cozinha_id.
 * Body: { unidade_cozinha_id }. Identidade/empresa só da sessão autenticada.
 */
router.post('/sessao/unidade', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    const body = req.body || {};
    const raw = body.unidade_cozinha_id != null
      ? body.unidade_cozinha_id
      : body.unidadeCozinhaId;
    const out = await CozinhaSessaoUnidade.selecionarUnidadeSessao({
      user: req.user,
      empresaId: empresaIdDoReqPedido(req),
      unidadeCozinhaIdRaw: raw,
      tokenAtual: bearerTokenDoReq(req)
    }, { db });
    return res.status(200).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});

/**
 * S07-0 — Painel KDS (somente leitura).
 * Empresa: contexto autenticado. Unidade: JWT unidade_cozinha_id.
 * Query unidade_id/empresa_id do cliente, se presentes, não substituem a sessão
 * (unidade divergente → 409 via resolverUnidadeOperacionalReq).
 */
router.get('/preparacao/painel', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    const q = req.query || {};
    // Recusa empresa_id do cliente como substituto do contexto.
    if (Object.prototype.hasOwnProperty.call(q, 'empresa_id')
      || Object.prototype.hasOwnProperty.call(q, 'empresaId')) {
      const raw = q.empresa_id !== undefined ? q.empresa_id : q.empresaId;
      const empresaSessao = empresaIdDoReqPedido(req);
      if (raw != null && String(raw).trim() !== '') {
        const cliente = Number(raw);
        if (!Number.isInteger(cliente) || cliente <= 0 || cliente !== Number(empresaSessao)) {
          return res.status(409).json({
            success: false,
            codigo: 'EMPRESA_ISOLAMENTO',
            mensagem: 'empresa_id diverge da empresa autorizada na sessão.',
            error: 'empresa_id diverge da empresa autorizada na sessão.'
          });
        }
      }
    }

    const unidadeId = resolverUnidadeOperacionalReq(req);
    if (q.historico === 'legado') {
      const legado = await CozinhaKdsPainel.listarHistoricoLegado({
        empresaId: empresaIdDoReqPedido(req), unidadeId, limite: q.limite, cursor: q.cursor
      }, { db });
      return res.status(200).json(legado);
    }
    const empresaId = empresaIdDoReqPedido(req);
    if (q.historico === 'retirados') {
      await CozinhaTurno.exigirAcessoGerencial({
        operadorId: operadorDaSessao(req),
        unidadeId
      }, { db });
    }
    const turnoAtivo = q.historico
      ? null
      : await CozinhaTurno.statusTurno({ empresaId, unidadeId }, { db });
    const turnoId = q.historico
      ? q.turno_id
      : turnoAtivo && turnoAtivo.turno ? turnoAtivo.turno.id : null;
    let out = !q.historico && turnoId == null
      ? {
        success: true,
        empresa_id: empresaId,
        unidade_id: unidadeId,
        rodadas: [],
        total: 0,
        ordenacao: null
      }
      : await CozinhaKdsPainel.listarPainelPreparacao({
        empresaId,
        unidadeId,
        turnoId,
        estado_item: q.estado_item != null ? q.estado_item : q.estadoItem,
        estado_rodada: q.estado_rodada != null ? q.estado_rodada : q.estadoRodada,
        limite: q.limite != null ? q.limite : q.limit,
        offset: q.offset,
        historico: q.historico,
        paginacao: q.paginacao,
        cursor: q.cursor,
        fila: q.historicos === '1' ? 'ativa' : q.fila,
        incluir_cancelados: q.incluir_cancelados != null
          ? q.incluir_cancelados
          : q.incluirCancelados,
        incluir_pedidos_cancelados: q.incluir_pedidos_cancelados
          != null ? q.incluir_pedidos_cancelados : q.incluirPedidosCancelados
      }, { db });
    // fila=ativa exclui rodadas concluídas; recupere-as pelo ledger para a coluna RETIRADOS.
    if (!q.historico && q.historicos === '1' && turnoId != null) {
      const retiradosDoTurno = await CozinhaKdsPainel.listarPainelPreparacao({
        empresaId,
        unidadeId,
        turnoId,
        limite: q.limite != null ? q.limite : q.limit,
        historico: 'retirados'
      }, { db });
      out = {
        ...out,
        total: Number(out.total || 0) + Number(retiradosDoTurno.total || 0),
        rodadas: [...(out.rodadas || []), ...retiradosDoTurno.rodadas]
      };
    }
    if (q.historicos === '1') {
      const contexto = { empresaId: empresaIdDoReqPedido(req), unidadeId, limite: q.limite, paginacao: q.paginacao };
      out.historico_cancelados = await CozinhaKdsPainel.listarPainelPreparacao({
        ...contexto, historico: 'cancelados', offset: q.offset_cancelados, cursor: q.cursor_cancelados
      }, { db });
    }
    return res.status(200).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});

// —— Sprint 06 Bloco A: estações e contratos (sem impressão física / sem fila) ——
// Unidade/empresa: SOMENTE sessão (JWT + contexto). Body/query NÃO informam nem divergem.

router.get('/impressao/estacoes', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    const out = await CozinhaImpressaoEstacao.listarEstacoes({
      db,
      empresaId: empresaIdDoReqPedido(req),
      unidadeId: unidadeCozinhaDaSessao(req.user),
      apenas_ativas: req.query && (req.query.apenas_ativas === '1' || req.query.apenas_ativas === 'true')
    });
    return res.status(200).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});

router.get('/impressao/estacoes/:id', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    const out = await CozinhaImpressaoEstacao.obterEstacao({
      db,
      empresaId: empresaIdDoReqPedido(req),
      unidadeId: unidadeCozinhaDaSessao(req.user),
      id: req.params.id
    });
    return res.status(200).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});

router.post('/impressao/estacoes', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    const body = req.body || {};
    // empresa/unidade SOMENTE da sessão — body nunca sobrescreve (auditoria Bloco A).
    const out = await CozinhaImpressaoEstacao.criarEstacao({
      db,
      codigo_estacao: body.codigo_estacao != null ? body.codigo_estacao : body.codigoEstacao,
      device_name: body.device_name != null ? body.device_name : body.deviceName,
      largura_mm: body.largura_mm != null ? body.largura_mm : body.larguraMm,
      vias: body.vias,
      modelo_individual: body.modelo_individual != null ? body.modelo_individual : body.modeloIndividual,
      modelo_agrupado: body.modelo_agrupado != null ? body.modelo_agrupado : body.modeloAgrupado,
      ativo: body.ativo,
      empresaId: empresaIdDoReqPedido(req),
      unidadeId: unidadeCozinhaDaSessao(req.user)
    });
    return res.status(201).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});

router.put('/impressao/estacoes/:id', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    const body = req.body || {};
    // Não propagar empresaId/unidadeId do body para o serviço.
    const dados = {
      codigo_estacao: body.codigo_estacao != null ? body.codigo_estacao : body.codigoEstacao,
      device_name: body.device_name !== undefined ? body.device_name : body.deviceName,
      largura_mm: body.largura_mm != null ? body.largura_mm : body.larguraMm,
      vias: body.vias,
      modelo_individual: body.modelo_individual != null ? body.modelo_individual : body.modeloIndividual,
      modelo_agrupado: body.modelo_agrupado != null ? body.modelo_agrupado : body.modeloAgrupado,
      ativo: body.ativo
    };
    const out = await CozinhaImpressaoEstacao.atualizarEstacao({
      db,
      empresaId: empresaIdDoReqPedido(req),
      unidadeId: unidadeCozinhaDaSessao(req.user),
      id: req.params.id,
      dados
    });
    return res.status(200).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});

/** D6 — preview de teste sem fila e sem print físico. */
router.post('/impressao/estacoes/:id/teste', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    const out = await CozinhaImpressaoEstacao.testarEstacao({
      db,
      empresaId: empresaIdDoReqPedido(req),
      unidadeId: unidadeCozinhaDaSessao(req.user),
      id: req.params.id
    });
    return res.status(200).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});

// —— Sprint 06 Bloco B1/D: consulta da fila (sem print físico / sem Electron) ——
router.get('/impressao/fila', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    const q = req.query || {};
    const out = await CozinhaImpressaoFila.listarFila({
      db,
      empresaId: empresaIdDoReqPedido(req),
      unidadeId: unidadeCozinhaDaSessao(req.user),
      estado: q.estado,
      rodada_id: q.rodada_id != null ? q.rodada_id : q.rodadaId,
      estacao_impressao_id: q.estacao_impressao_id != null
        ? q.estacao_impressao_id
        : q.estacaoId,
      incluir_snapshot: q.incluir_snapshot === '1' || q.incluir_snapshot === 'true'
    });
    return res.status(200).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});

router.get('/impressao/fila/:id', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    const out = await CozinhaImpressaoFila.obterJob({
      db,
      empresaId: empresaIdDoReqPedido(req),
      unidadeId: unidadeCozinhaDaSessao(req.user),
      id: req.params.id
    });
    return res.status(200).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});

/**
 * Reenvio controlado (Bloco D).
 * RESULTADO_INCERTO exige confirmacao_humana=true no body.
 * Não altera preparação / rodada. Sem print físico.
 */
router.post('/impressao/fila/:id/reenviar', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    const body = req.body || {};
    const out = await CozinhaImpressaoFila.reenviarJob({
      db,
      empresaId: empresaIdDoReqPedido(req),
      unidadeId: unidadeCozinhaDaSessao(req.user),
      id: req.params.id,
      confirmacao_humana: body.confirmacao_humana === true
        || body.confirmacaoHumana === true
    });
    return res.status(200).json(out);
  } catch (err) {
    return responderErro(res, err);
  }
});

/** Contrato: monta + renderiza snapshot (sem enfileirar / sem print). */
router.post('/impressao/snapshot/preview', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    const body = req.body || {};
    // empresa/unidade sempre da sessão autenticada (não confiar no body).
    const snapshot = montarPayloadSnapshot({
      ...body,
      empresa_id: empresaIdDoReqPedido(req),
      unidade_id: unidadeCozinhaDaSessao(req.user)
    });
    const proibidos = snapshotContemCamposProibidos(snapshot);
    if (proibidos.length) {
      return res.status(400).json({
        success: false,
        codigo: 'SNAPSHOT_CAMPO_PROIBIDO',
        mensagem: 'Snapshot contém campos comerciais/fiscais proibidos.',
        detalhes: { campos: proibidos }
      });
    }
    const render = renderizarTexto(snapshot);
    return res.status(200).json({
      success: true,
      snapshot,
      payload_snapshot: serializarSnapshot(snapshot),
      render,
      impressao_fisica: false
    });
  } catch (err) {
    return responderErro(res, err);
  }
});

module.exports = router;
