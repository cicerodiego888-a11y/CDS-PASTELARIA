/**
 * Fachada HTTP do PDV Universal (05.01 contexto + 05.02 seleção).
 */
'use strict';

const express = require('express');
const router = express.Router();
const { validarCaixaSeOrigemPdv } = require('../middleware/validarCaixaAberto');
const {
  obterContexto,
  selecionarEmpresa,
  consultarDisponibilidadeProduto,
  finalizarCheckout,
  reservarAtendimentoPdv,
  confirmarPagamentoPdv,
  cancelarAtendimentoPdv,
  materializarAtendimentoPdv,
  fiscalizarAtendimentoPdv,
  obterComprovantePdv
} = require('../motores/pdv-universal/PDVUniversalApplicationService');
const { resolverSaidaHttp } = require('../motores/muv/comprovante/ComprovanteRenderer');

function responderErro(res, err) {
  const code = err && err.code ? err.code : 'ERRO_PDV_UNIVERSAL';
  const status = Number(err && err.statusCode) || (code === 'MODO_OPERACAO_VENDA_INVALIDO' ? 500 : 400);
  return res.status(status).json({
    error: err && err.message ? err.message : 'Erro no PDV Universal.',
    code,
    empresa_id: err && err.empresa_id != null ? err.empresa_id : undefined
  });
}

router.get('/contexto', async (req, res) => {
  try {
    const dto = await obterContexto({
      req,
      user: req.user
    });
    return res.json(dto);
  } catch (err) {
    return responderErro(res, err);
  }
});

router.get('/produtos/:produtoId/disponibilidade', async (req, res) => {
  try {
    const dto = await consultarDisponibilidadeProduto(req.params.produtoId, {
      req,
      user: req.user
    });
    return res.json(dto);
  } catch (err) {
    return responderErro(res, err);
  }
});

router.post('/checkout', validarCaixaSeOrigemPdv, async (req, res) => {
  try {
    const body = req.body || {};
    const resultado = await finalizarCheckout({
      req,
      user: req.user,
      itens: body.itens,
      pagamentos: body.pagamentos,
      emitir_fiscal: body.emitir_fiscal,
      idempotency_key: body.idempotency_key || req.headers['idempotency-key']
    });
    return res.json(resultado);
  } catch (err) {
    return responderErro(res, err);
  }
});

router.post('/atendimentos/:id/reservar', async (req, res) => {
  try {
    return res.json(await reservarAtendimentoPdv(req.params.id));
  } catch (err) {
    return responderErro(res, err);
  }
});

router.post('/atendimentos/:id/pagamento', async (req, res) => {
  try {
    const body = req.body || {};
    return res.json(await confirmarPagamentoPdv(req.params.id, {
      pagamentos: body.pagamentos,
      estrategia_rateio: body.estrategia_rateio || body.estrategia || 'POR_ITEM',
      idempotency_key: body.idempotency_key || req.headers['idempotency-key']
    }));
  } catch (err) {
    return responderErro(res, err);
  }
});

router.post('/atendimentos/:id/cancelar', async (req, res) => {
  try {
    return res.json(await cancelarAtendimentoPdv(req.params.id));
  } catch (err) {
    return responderErro(res, err);
  }
});

router.post('/atendimentos/:id/materializar', async (req, res) => {
  try {
    const body = req.body || {};
    return res.json(await materializarAtendimentoPdv(req.params.id, {
      idempotency_key: body.idempotency_key || req.headers['idempotency-key']
    }));
  } catch (err) {
    return responderErro(res, err);
  }
});

router.post('/atendimentos/:id/fiscalizar', async (req, res) => {
  try {
    return res.json(await fiscalizarAtendimentoPdv(req.params.id));
  } catch (err) {
    return responderErro(res, err);
  }
});

router.get('/atendimentos/:id/comprovante', async (req, res) => {
  try {
    const dto = await obterComprovantePdv(req.params.id);
    const saida = resolverSaidaHttp(dto, req.query || {});
    if (saida.kind === 'json') return res.json(saida.body);
    res.set('Content-Type', saida.contentType);
    return res.send(saida.body);
  } catch (err) {
    return responderErro(res, err);
  }
});

router.put('/contexto/empresa', async (req, res) => {
  try {
    const contexto = await selecionarEmpresa(req.body || {}, {
      req,
      user: req.user
    });
    return res.json({
      sucesso: true,
      contexto,
      persistencia: {
        header: 'X-Empresa-Id',
        valor: contexto.contexto.empresa_id
      }
    });
  } catch (err) {
    return responderErro(res, err);
  }
});

module.exports = router;
