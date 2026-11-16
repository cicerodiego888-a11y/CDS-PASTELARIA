const express = require('express');
const router = express.Router();
const pixService = require('../services/pix/pixService');
const pixEvidenciaService = require('../services/pix/pixEvidenciaService');

function empresaDoPedido(req) {
  const header = req.headers['x-empresa-id'];
  if (header != null && String(header).trim() !== '') return Number(header);
  if (req.body && req.body.empresa_id != null) return Number(req.body.empresa_id);
  return null;
}

router.get('/provedores', (req, res) => {
  res.json({
    success: true,
    provedores: pixService.providerCatalog
  });
});

router.get('/config', async (req, res) => {
  try {
    const config = await pixService.buscarConfigPix();
    res.json({
      success: true,
      config
    });
  } catch (err) {
    console.error('Erro ao buscar config Pix:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/config', async (req, res) => {
  try {
    await pixService.salvarConfigPix(req.body);
    res.json({
      success: true,
      message: 'Configuração Pix salva com sucesso.'
    });
  } catch (err) {
    console.error('Erro ao salvar config Pix:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/criar-cobranca', async (req, res) => {
  try {
    const valor = Number(req.body.valor || 0);

    if (valor <= 0) {
      return res.status(400).json({ success: false, error: 'Valor inválido.' });
    }

    const empresaId = empresaDoPedido(req);
    const parcelaLocalId = req.body.parcela_local_id != null
      ? Number(req.body.parcela_local_id)
      : null;
    const sessaoPagamento = req.body.sessao_pagamento || null;
    const chaveParcela = req.body.chave_parcela
      || (sessaoPagamento && parcelaLocalId
        ? `${sessaoPagamento}:${parcelaLocalId}:${Number(valor).toFixed(2)}`
        : null);

    const cobranca = await pixService.criarCobranca({
      valor,
      descricao: req.body.descricao || 'Venda PDV',
      vendaId: req.body.venda_id || null,
      empresaId,
      parcelaLocalId,
      sessaoPagamento,
      chaveParcela
    });

    res.json({
      success: true,
      cobranca
    });
  } catch (err) {
    console.error('Erro ao criar cobrança Pix:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/status/:txid', async (req, res) => {
  try {
    const status = await pixService.consultarStatus(req.params.txid);
    res.json({
      success: true,
      status
    });
  } catch (err) {
    console.error('Erro ao consultar status Pix:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/comprovar/:txid', async (req, res) => {
  try {
    const prova = await pixEvidenciaService.comprovarCobrancaPixPago({
      txid: req.params.txid,
      empresaId: empresaDoPedido(req),
      valor: req.body && req.body.valor,
      vendaId: req.body && req.body.venda_id,
      parcelaLocalId: req.body && req.body.parcela_local_id,
      sessaoPagamento: req.body && req.body.sessao_pagamento,
      chaveParcela: req.body && req.body.chave_parcela,
      consultarProvedor: req.body && req.body.consultar_provedor === true
    });
    if (!prova.sucesso) {
      return res.status(409).json({ success: false, ...prova });
    }
    res.json({ success: true, prova });
  } catch (err) {
    console.error('Erro ao comprovar Pix:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/testar-conexao', async (req, res) => {
  try {
    await pixService.salvarConfigPix(req.body);
    res.json({
      success: true,
      message: 'Configuração salva. O teste real acontece ao gerar uma cobrança Pix.'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
