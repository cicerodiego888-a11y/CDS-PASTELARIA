/**
 * API do produto MIS (04.02).
 * Orquestra contexto + indicadores. Sem SQL. Sem consolidação.
 */
'use strict';

const express = require('express');
const router = express.Router();
const { verificarPermissaoEspecifica } = require('../middleware/auth');
const {
  resolverEmpresaIdParaMis,
  statusDeErroEmpresaMis
} = require('../services/mis/MisEmpresaContextoService');
const { obterResumoMis } = require('../services/mis/MisResumoService');

function dataIsoLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function periodoPadrao() {
  const fim = new Date();
  const inicio = new Date();
  inicio.setDate(fim.getDate() - 6);
  return { inicio: dataIsoLocal(inicio), fim: dataIsoLocal(fim) };
}

async function handleGetResumo(req, res, deps = {}) {
  const db = deps.db || require('../database');
  const resolver = deps.resolverEmpresaIdParaMis || resolverEmpresaIdParaMis;
  try {
    let ctx;
    try {
      ctx = await resolver(req, { db, ...deps });
    } catch (empErr) {
      return res.status(statusDeErroEmpresaMis(empErr)).json({
        error: empErr.message,
        code: empErr.code,
        empresa_id: empErr.empresa_id != null ? empErr.empresa_id : undefined
      });
    }

    const padrao = periodoPadrao();
    const inicio = req.query.inicio || padrao.inicio;
    const fim = req.query.fim || padrao.fim;
    const modoFiscal = req.query.modo_fiscal || '0';
    const comparar = req.query.comparar === '1' || req.query.comparacao === '1';

    const resumo = await obterResumoMis({
      db,
      empresaId: ctx.empresaId,
      inicio,
      fim,
      modoFiscal,
      comparar
    });

    return res.json({
      ...resumo,
      empresa: {
        id: ctx.empresaId,
        origem: ctx.origem || null,
        modo: ctx.modo || null
      }
    });
  } catch (err) {
    const status = err.statusCode || 500;
    console.error('[MIS] resumo:', err.message);
    return res.status(status).json({
      error: err.message || 'Erro ao montar o MIS.',
      code: err.code || 'MIS_RESUMO_ERRO'
    });
  }
}

router.get('/resumo', verificarPermissaoEspecifica('relatorios'), (req, res) => {
  handleGetResumo(req, res);
});

module.exports = router;
module.exports.handleGetResumo = handleGetResumo;
