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
const CozinhaSessaoUnidade = require('../services/cozinha/CozinhaSessaoUnidadeService');
const CozinhaImpressaoEstacao = require('../services/cozinha/CozinhaImpressaoEstacaoService');
const CozinhaImpressaoFila = require('../services/cozinha/CozinhaImpressaoFilaService');
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

router.post('/itens/:id/iniciar', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
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

router.post('/itens/:id/pronto', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
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

router.post('/itens/:id/bebida/entregar', async (req, res) => {
  try {
    if (!exigirCozinhaOperacional(res)) return;
    const body = req.body || {};
    const out = await CozinhaPreparacao.entregarBebida({
      empresaId: empresaIdDoReqPedido(req),
      operadorId: operadorDaSessao(req),
      idempotencyKey: chaveIdempotencia(req),
      itemId: req.params.id,
      unidade_id: resolverUnidadeOperacionalReq(req),
      qty_entregue: body.qty_entregue != null ? body.qty_entregue : body.quantidade
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
    const out = await CozinhaSessaoUnidade.listarUnidadesDisponiveis({
      user: req.user,
      empresaId: empresaIdDoReqPedido(req)
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
    const out = await CozinhaKdsPainel.listarPainelPreparacao({
      empresaId: empresaIdDoReqPedido(req),
      unidadeId,
      estado_item: q.estado_item != null ? q.estado_item : q.estadoItem,
      estado_rodada: q.estado_rodada != null ? q.estado_rodada : q.estadoRodada,
      limite: q.limite != null ? q.limite : q.limit,
      offset: q.offset,
      incluir_cancelados: q.incluir_cancelados != null
        ? q.incluir_cancelados
        : q.incluirCancelados
    }, { db });
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
