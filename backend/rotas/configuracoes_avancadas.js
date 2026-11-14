const express = require('express');
const router = express.Router();
const configService = require('../services/configuracaoService');
const { ContratoOperacionalService } = require('../core/modo-operacional');
const { exigirSuperAdmin } = require('../middleware/auth');

router.get('/confirmacao-fiscal', (req, res) => {
  try {
    res.json({
      modo_confirmacao_fiscal: configService.getModoConfirmacaoFiscal()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/recursos', (req, res) => {
  try {
    res.json(configService.getRecursos());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/contrato-operacional', async (req, res) => {
  try {
    const contrato = await ContratoOperacionalService.montarContratoOperacional();
    res.json(contrato);
  } catch (err) {
    const status = err.code === 'EMPRESA_OPERACIONAL_AUSENTE'
      || err.code === 'EMPRESA_OPERACIONAL_AMBIGUA'
      || err.code === 'EMPRESA_OPERACIONAL_INVALIDA'
      ? 409
      : 500;
    res.status(status).json({
      error: err.message,
      code: err.code || undefined
    });
  }
});

router.get('/canais-venda', exigirSuperAdmin, async (req, res) => {
  try {
    const db = require('../database');
    await new Promise((resolve, reject) => {
      if (typeof db.whenReady !== 'function') return resolve();
      db.whenReady((readyErr) => (readyErr ? reject(readyErr) : resolve()));
    });
    const configServiceLocal = require('../services/configuracaoService');
    const { consultarListagemCanais } = require('../services/vendas/CanalVendaEmpresaService');
    let cfg = null;
    try {
      cfg = configServiceLocal.readConfig();
    } catch (cfgErr) {
      console.error('[canais-venda] leitura de configuração', cfgErr && cfgErr.stack ? cfgErr.stack : cfgErr);
    }
    const lista = await consultarListagemCanais(db, cfg ? { cfg } : {});
    res.json(lista);
  } catch (err) {
    console.error('[canais-venda] GET /api/configuracoes-avancadas/canais-venda', err && err.stack ? err.stack : err);
    const { respostaHttpListagem } = require('../services/vendas/CanalVendaEmpresaService');
    const resposta = respostaHttpListagem(err);
    res.status(resposta.status).json(resposta.body);
  }
});

router.post('/canais-venda', exigirSuperAdmin, async (req, res) => {
  try {
    const db = require('../database');
    const { cadastrarCanal } = require('../services/vendas/CanalVendaEmpresaService');
    const canal = await cadastrarCanal(db, req.body || {}, { usuario: req.user });
    res.status(201).json({ canal });
  } catch (err) {
    const status = err.code === 'SQLITE_CONSTRAINT' ? 409 : (err.statusCode || 500);
    res.status(status).json({
      error: err.code === 'SQLITE_CONSTRAINT' ? 'Já existe um canal com este código.' : err.message,
      code: err.code || undefined
    });
  }
});

router.get('/canais-venda/:id/historico', exigirSuperAdmin, async (req, res) => {
  try {
    const db = require('../database');
    await new Promise((resolve, reject) => {
      if (typeof db.whenReady !== 'function') return resolve();
      db.whenReady((readyErr) => (readyErr ? reject(readyErr) : resolve()));
    });
    const { consultarHistoricoCanal } = require('../services/vendas/CanalVendaEmpresaService');
    const auditoria = await consultarHistoricoCanal(db, Number(req.params.id));
    res.json({ auditoria });
  } catch (err) {
    res.status(err.statusCode || 500).json({
      error: err.message || 'Não foi possível carregar o histórico do canal.',
      code: err.code || undefined
    });
  }
});

router.put('/canais-venda/:id', exigirSuperAdmin, async (req, res) => {
  try {
    const db = require('../database');
    const { atualizarVinculo } = require('../services/vendas/CanalVendaEmpresaService');
    const canal = await atualizarVinculo(db, Number(req.params.id), req.body || {}, { usuario: req.user });
    res.json({ canal });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, code: err.code || undefined });
  }
});

router.get('/pdv-modelo-empresa', (req, res) => {
  try {
    const { obterPdvModeloEmpresaPublico } = require('../services/pdv/PdvModeloEmpresaService');
    res.json(obterPdvModeloEmpresaPublico());
  } catch (err) {
    res.status(500).json({ error: err.message, code: err.code || undefined });
  }
});

router.get('/padrao-fiscal', (req, res) => {
  try {
    res.json(configService.getPadraoFiscal());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/padrao-fiscal', exigirSuperAdmin, (req, res) => {
  try {
    const saved = configService.savePadraoFiscal(req.body || {});
    res.json({
      success: true,
      message: 'Padrão Fiscal da Empresa atualizado com sucesso.',
      padrao_fiscal: configService.getPadraoFiscal(saved)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/', exigirSuperAdmin, (req, res) => {
  try {
    const cfg = configService.readConfig();
    res.json(Object.assign({}, cfg, { recursos: configService.getRecursos(cfg).recursos }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', exigirSuperAdmin, async (req, res) => {
  try {
    const data = req.body || {};
    const validation = configService.validateConfig(data);

    if (!validation.valid) {
      return res.status(400).json({
        error: 'Validação falhou',
        details: validation.errors
      });
    }

    const db = require('../database');
    const saved = await configService.saveConfigComValidacaoPdv(data, { db });

    res.json({
      success: true,
      message: 'Configurações salvas com sucesso.',
      config: saved,
      recursos: configService.getRecursos(saved).recursos
    });
  } catch (err) {
    const status = err.code === 'MODO_OPERACIONAL_ALTERACAO_REQUER_CONFIRMACAO'
      ? 409
      : (
        err.code === 'PDV_EMPRESA_ID_AUSENTE'
        || err.code === 'PDV_EMPRESA_INVALIDA'
        || err.code === 'EMPRESA_NAO_ENCONTRADA'
        || err.code === 'EMPRESA_INATIVA'
        || err.details
          ? (err.statusCode || err.status || 400)
          : 500
      );
    res.status(status).json({
      error: err.message,
      details: err.details || undefined,
      code: err.code || undefined
    });
  }
});

module.exports = router;
