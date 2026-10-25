/**
 * Rotas MCF — Contas a Pagar operacional canônica.
 * Prefixo: /api/contas-pagar
 * As rotas legadas permanecem para consumidores ainda não migrados.
 */
'use strict';

const express = require('express');
const router = express.Router();
const db = require('../database');
const { gravarAuditoria } = require('../services/auditoria');
const {
  middlewareResolverEmpresaFinanceiro,
  statusDeErroEmpresa
} = require('../services/financeiro/FinanceiroEmpresaContextoService');
const ContasPagarService = require('../motores/mcf/services/ContasPagarService');

const anexarEmpresa = middlewareResolverEmpresaFinanceiro({ db });
router.use(anexarEmpresa);

function responderErro(res, err) {
  const status = err.statusCode || statusDeErroEmpresa(err) || 500;
  return res.status(status).json({
    success: false,
    error: err.message || 'Erro interno',
    code: err.code || null
  });
}

function obterChaveIdempotencia(req, body = {}) {
  const cabecalho = typeof req.get === 'function'
    ? req.get('Idempotency-Key')
    : req.headers && req.headers['idempotency-key'];
  return cabecalho || body.idempotency_key || null;
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function exigirAdminFinanceiro(req, res) {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({ success: false, error: 'Apenas o administrador pode cancelar títulos a pagar.' });
    return false;
  }
  return true;
}

router.get('/', async (req, res) => {
  try {
    const contas = await ContasPagarService.listar({
      db,
      empresaId: req.empresaId,
      status: req.query.status,
      fornecedor_id: req.query.fornecedor_id,
      fornecedor: req.query.fornecedor,
      dataInicio: req.query.dataInicio,
      dataFim: req.query.dataFim,
      limite: req.query.limite
    });
    return res.json({ success: true, contas });
  } catch (err) {
    return responderErro(res, err);
  }
});

router.get('/:id', async (req, res) => {
  try {
    const conta = await ContasPagarService.obter({
      db,
      empresaId: req.empresaId,
      id: req.params.id
    });
    return res.json({ success: true, conta });
  } catch (err) {
    return responderErro(res, err);
  }
});

router.get('/:id/detalhes', async (req, res) => {
  try {
    const conta = await ContasPagarService.obter({
      db,
      empresaId: req.empresaId,
      id: req.params.id
    });
    let compra = null;
    let itens = [];
    if (conta.referencia_tipo === 'compra' && conta.referencia_id != null) {
      compra = await dbGet(
        'SELECT * FROM compras WHERE id = ? AND empresa_id = ?',
        [conta.referencia_id, req.empresaId]
      );
      if (compra) {
        itens = await dbAll(`
          SELECT ci.*, COALESCE(p.nome, ci.descricao_produto) AS produto_nome,
                 p.codigo AS produto_codigo
          FROM compras_itens ci
          LEFT JOIN produtos p ON p.id = ci.produto_id
          WHERE ci.compra_id = ?
          ORDER BY ci.id
        `, [conta.referencia_id]);
      }
    }
    const pagamentos = await ContasPagarService.listarPagamentos({
      db,
      empresaId: req.empresaId,
      id: conta.id
    });
    return res.json({
      success: true,
      ...conta,
      valor: conta.valor_original,
      dataEmissao: conta.data_emissao,
      dataVencimento: conta.data_vencimento,
      data_movimento: conta.data_emissao,
      vencimento: conta.data_vencimento,
      baixado_em: pagamentos.pagamentos.length
        ? pagamentos.pagamentos[pagamentos.pagamentos.length - 1].data_pagamento
        : null,
      pessoa_nome: conta.pessoa_nome || conta.fornecedor_nome || '',
      fornecedor: conta.pessoa_nome || conta.fornecedor_nome || '',
      categoria: conta.categoria || '',
      conta,
      compra,
      itens_compra: itens,
      pagamentos: pagamentos.pagamentos
    });
  } catch (err) {
    return responderErro(res, err);
  }
});

router.get('/:id/pagamentos', async (req, res) => {
  try {
    const out = await ContasPagarService.listarPagamentos({
      db,
      empresaId: req.empresaId,
      id: req.params.id
    });
    return res.json({ success: true, ...out });
  } catch (err) {
    return responderErro(res, err);
  }
});

router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    const idempotencyKey = obterChaveIdempotencia(req, body);
    if (
      String(body.referencia_tipo || '').toLowerCase() !== 'compra'
      && !idempotencyKey
    ) {
      return res.status(400).json({
        success: false,
        code: 'MCF_IDEMPOTENCIA_INVALIDA',
        error: 'Informe o cabeçalho Idempotency-Key para criar um título manual.'
      });
    }
    const conta = await ContasPagarService.criar({
      db,
      empresaId: req.empresaId,
      fornecedor_id: body.fornecedor_id,
      descricao: body.descricao,
      valor_original: body.valor_original != null ? body.valor_original : body.valor,
      data_emissao: body.data_emissao,
      data_vencimento: body.data_vencimento,
      documento: body.documento,
      origem: body.origem,
      categoria: body.categoria,
      pessoa_nome: body.pessoa_nome,
      forma_pagamento: body.forma_pagamento,
      referencia_tipo: body.referencia_tipo,
      referencia_id: body.referencia_id,
      numero_parcela: body.numero_parcela,
      total_parcelas: body.total_parcelas,
      observacao: body.observacao,
      criado_por: req.user && req.user.id,
      idempotency_key: idempotencyKey
    });
    const idempotente = conta.idempotente === true;
    const contaResposta = { ...conta };
    delete contaResposta.idempotente;
    if (!idempotente) {
      gravarAuditoria({
        usuario_id: req.user && req.user.id || null,
        usuario_nome: req.user && (req.user.nome || req.user.username) || null,
        modulo: 'financeiro',
        acao: 'criar_conta_pagar_mcf',
        referencia_tipo: 'contas_pagar',
        referencia_id: conta.id,
        detalhes: {
          empresa_id: req.empresaId,
          valor_original: conta.valor_original,
          referencia_tipo: conta.referencia_tipo,
          referencia_id: conta.referencia_id
        },
        ip_requisicao: req.ip || null
      }).catch((auditErr) => console.error('Erro ao auditar criação de conta MCF:', auditErr));
    }
    return res.status(idempotente ? 200 : 201).json({
      success: true,
      conta: contaResposta,
      ...(idempotente ? { idempotente: true } : {})
    });
  } catch (err) {
    return responderErro(res, err);
  }
});

router.post('/lote', async (req, res) => {
  try {
    const body = req.body || {};
    const idempotencyKey = obterChaveIdempotencia(req, body);
    if (!idempotencyKey) {
      return res.status(400).json({
        success: false,
        code: 'MCF_IDEMPOTENCIA_INVALIDA',
        error: 'Informe o cabeçalho Idempotency-Key para criar despesas.'
      });
    }
    if (!Array.isArray(body.parcelas)) {
      return res.status(400).json({
        success: false,
        code: 'MCF_PARCELA_INVALIDA',
        error: 'Informe a lista de parcelas.'
      });
    }

    const contas = await ContasPagarService.criarLote({
      db,
      empresaId: req.empresaId,
      fornecedor_id: body.fornecedor_id,
      data_emissao: body.data_emissao,
      documento: body.documento,
      origem: 'manual',
      categoria: body.categoria,
      pessoa_nome: body.pessoa_nome,
      forma_pagamento: body.forma_pagamento,
      observacao: body.observacao,
      criado_por: req.user && req.user.id,
      idempotency_key: idempotencyKey,
      parcelas: body.parcelas.map((parcela) => ({
        descricao: parcela && parcela.descricao,
        valor_original: parcela && parcela.valor_original,
        data_vencimento: parcela && parcela.data_vencimento
      }))
    });
    const idempotente = contas.every((conta) => conta.idempotente === true);
    const contasResposta = contas.map((conta) => {
      const resposta = { ...conta };
      delete resposta.idempotente;
      if (!conta.idempotente) {
        gravarAuditoria({
          usuario_id: req.user && req.user.id || null,
          usuario_nome: req.user && (req.user.nome || req.user.username) || null,
          modulo: 'financeiro',
          acao: 'criar_conta_pagar_mcf',
          referencia_tipo: 'contas_pagar',
          referencia_id: conta.id,
          detalhes: {
            empresa_id: req.empresaId,
            valor_original: conta.valor_original,
            referencia_tipo: conta.referencia_tipo,
            referencia_id: conta.referencia_id
          },
          ip_requisicao: req.ip || null
        }).catch((auditErr) => console.error('Erro ao auditar criação de conta MCF:', auditErr));
      }
      return resposta;
    });
    return res.status(idempotente ? 200 : 201).json({
      success: true,
      contas: contasResposta,
      ...(idempotente ? { idempotente: true } : {})
    });
  } catch (err) {
    return responderErro(res, err);
  }
});

router.post('/:id/baixar', async (req, res) => {
  try {
    const body = req.body || {};
    const conta = await ContasPagarService.baixar({
      db,
      empresaId: req.empresaId,
      id: req.params.id,
      valor_pago: body.valor_pago != null ? body.valor_pago : body.valor,
      data_pagamento: body.data_pagamento,
      forma_pagamento: body.forma_pagamento,
      observacao: body.observacao,
      idempotency_key: obterChaveIdempotencia(req, body),
      usuario_id: req.user && req.user.id,
      origem_operacao: 'mcf_api'
    });
    const idempotente = conta.idempotente === true;
    const contaResposta = { ...conta };
    delete contaResposta.idempotente;
    if (!idempotente) {
      gravarAuditoria({
        usuario_id: req.user && req.user.id || null,
        usuario_nome: req.user && (req.user.nome || req.user.username) || null,
        modulo: 'financeiro',
        acao: 'baixar_conta_pagar_mcf',
        referencia_tipo: 'contas_pagar',
        referencia_id: conta.id,
        detalhes: {
          empresa_id: req.empresaId,
          pagamento_id: conta.pagamento_id,
          valor_pago: body.valor_pago != null ? body.valor_pago : body.valor,
          forma_pagamento: body.forma_pagamento || null
        },
        ip_requisicao: req.ip || null
      }).catch((auditErr) => console.error('Erro ao auditar baixa de conta MCF:', auditErr));
    }
    return res.status(idempotente ? 200 : 201).json({
      success: true,
      conta: contaResposta,
      pagamento_id: conta.pagamento_id,
      ...(idempotente ? { idempotente: true } : {})
    });
  } catch (err) {
    return responderErro(res, err);
  }
});

router.post('/:id/cancelar', async (req, res) => {
  if (!exigirAdminFinanceiro(req, res)) return;
  try {
    const body = req.body || {};
    const conta = await ContasPagarService.cancelar({
      db,
      empresaId: req.empresaId,
      id: req.params.id,
      motivo: body.motivo,
      idempotency_key: obterChaveIdempotencia(req, body),
      usuario_id: req.user && req.user.id
    });
    const idempotente = conta.idempotente === true;
    if (!idempotente) {
      gravarAuditoria({
        usuario_id: req.user && req.user.id || null,
        usuario_nome: req.user && (req.user.nome || req.user.username) || null,
        modulo: 'financeiro',
        acao: 'cancelar_conta_pagar_mcf',
        referencia_tipo: 'contas_pagar',
        referencia_id: conta.id,
        detalhes: {
          empresa_id: req.empresaId,
          saldo_cancelado: conta.saldo_cancelado,
          motivo: conta.cancelamento_motivo
        },
        ip_requisicao: req.ip || null
      }).catch((auditErr) => console.error('Erro ao auditar cancelamento de conta MCF:', auditErr));
    }
    return res.status(200).json({
      success: true,
      conta,
      ...(idempotente ? { idempotente: true } : {})
    });
  } catch (err) {
    return responderErro(res, err);
  }
});

module.exports = router;
