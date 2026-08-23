/**
 * Rotas HTTP mínimas do ATENDIMENTO MULTIEMPRESA.
 * Sem regra de negócio — apenas valida id e delega ao serviço.
 */
'use strict';

const express = require('express');
const router = express.Router();
const db = require('../database');
const comprovanteService = require('../motores/muv/ComprovanteUnificadoAtendimentoService');
const { resolverSaidaHttp } = require('../motores/muv/comprovante/ComprovanteRenderer');
const { imprimirComprovante } = require('../motores/muv/impressao/ComprovantePrintService');

const STATUS_POR_CODIGO = {
  ATENDIMENTO_INVALIDO: 404,
  ATENDIMENTO_CANCELADO: 409,
  COMPROVANTE_FORMATO_INVALIDO: 400,
  COMPROVANTE_DTO_INVALIDO: 400,
  DESTINO_IMPRESSAO_INVALIDO: 400,
  FORMATO_NAO_SUPORTADO_PARA_DESTINO: 400,
  LARGURA_IMPRESSAO_INVALIDA: 400
};

function responderErro(res, err) {
  const code = err && err.code ? err.code : 'ERRO_ATENDIMENTO';
  const status = Number(err && err.statusCode) || STATUS_POR_CODIGO[code] || 500;
  if (status >= 500) console.error('Erro em /api/atendimentos:', err);
  return res.status(status).json({
    error: err && err.message ? err.message : 'Erro ao processar atendimento.',
    code
  });
}

router.post('/:id/imprimir', async (req, res) => {
  try {
    const body = req.body || {};
    const resultado = await imprimirComprovante({
      atendimentoId: req.params.id,
      destino: body.destino,
      formato: body.formato || body.format,
      largura: body.largura
    }, { db });
    return res.json(resultado);
  } catch (err) {
    return responderErro(res, err);
  }
});

router.get('/:id/comprovante', async (req, res) => {
  try {
    const dto = await comprovanteService.obterComprovanteUnificado(req.params.id, { db });
    const saida = resolverSaidaHttp(dto, req.query || {});
    if (saida.kind === 'json') return res.json(saida.body);
    res.set('Content-Type', saida.contentType);
    return res.send(saida.body);
  } catch (err) {
    return responderErro(res, err);
  }
});

module.exports = router;
