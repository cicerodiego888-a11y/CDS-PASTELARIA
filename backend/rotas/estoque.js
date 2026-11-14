/**
 * Rotas administrativas de estoque (Fase 2 / Implementação 03.18).
 * Leitura isolada de estoque_empresa. Sem fallback para produtos.
 * CDS-ESTOQUE-MANUAL-01 — contagem física F×NF.
 * CDS-ESTOQUE-CONTAGEM-SNAPSHOT-FLUXO-03.1 — confirmação oficial exige snapshot.
 * CDS-ESTOQUE-CONTAGEM-REDESIGN-PREVIEW-05.3 — saldo atual somente leitura.
 */
'use strict';

const express = require('express');
const dbDefault = require('../database');
const { criarMiddlewareContextoEmpresa } = require('../services/fiscalNaoFiscal/empresaContexto');
const EstoqueEmpresaService = require('../services/estoque/EstoqueEmpresaService');
const EstoqueContagemFisicaService = require('../services/estoque/EstoqueContagemFisicaService');
const {
  exigirSnapshotItensOficiais
} = require('../services/estoque/contagemFisicaSnapshotOficial');
const {
  listarPendenciasEntradaEstoque
} = require('../services/estoque/CentralEntradasPendenciasEstoqueService');
const EstoqueContagemPeriodicidadeService = require('../services/estoque/EstoqueContagemPeriodicidadeService');
const {
  buscarProdutosParaContagem
} = require('../services/estoque/EstoqueContagemProdutoBuscaService');
const { exigirPerfilAjusteEstoque } = require('../middleware/auth');

async function handleGetProdutoEstoqueEmpresa(req, res, dbConn) {
  const produtoId = Number(req.params && req.params.produtoId);
  if (!Number.isInteger(produtoId) || produtoId <= 0) {
    return res.status(400).json({
      error: 'Produto inválido.',
      code: 'PRODUTO_INVALIDO'
    });
  }

  const empresaId = req.empresaId;
  try {
    const saldo = await EstoqueEmpresaService.consultarSaldoParaEmpresa({
      produtoId,
      empresaId,
      db: dbConn
    });

    if (!saldo) {
      return res.status(404).json({
        error: 'Não existe estoque isolado para este produto nesta empresa.',
        code: 'ESTOQUE_EMPRESA_NAO_ENCONTRADO',
        produtoId,
        empresaId
      });
    }

    return res.status(200).json({
      produtoId,
      empresaId,
      saldoFiscal: saldo.saldoFiscal,
      saldoNaoFiscal: saldo.saldoNaoFiscal,
      estoqueAtual: saldo.estoqueAtual,
      reservadoFiscal: saldo.reservadoFiscal,
      reservadoNaoFiscal: saldo.reservadoNaoFiscal
    });
  } catch (err) {
    const code = err && err.code ? err.code : 'ERRO_ESTOQUE_EMPRESA';
    const status = code === 'PRODUTO_NAO_ENCONTRADO' ? 404
      : (code === 'PRODUTO_INVALIDO' || code === 'EMPRESA_OBRIGATORIA' ? 400 : 500);
    return res.status(status).json({
      error: err && err.message ? err.message : 'Erro ao consultar estoque da empresa.',
      code
    });
  }
}

function criarRotasEstoque(dbConn) {
  const exigirContexto = criarMiddlewareContextoEmpresa(dbConn, { obrigatorio: true });
  const router = express.Router();
  router.get('/empresa/produtos/:produtoId', exigirContexto, (req, res) => {
    return handleGetProdutoEstoqueEmpresa(req, res, dbConn);
  });

  router.post('/contagem-fisica/preview', exigirContexto, exigirPerfilAjusteEstoque(), async (req, res) => {
    try {
      const body = req.body || {};
      const preview = await EstoqueContagemFisicaService.previsualizarContagem({
        db: dbConn,
        empresaId: req.empresaId,
        produtoId: body.produto_id != null ? body.produto_id : body.produtoId,
        quantidade_fiscal_informada: body.quantidade_fiscal_informada != null
          ? body.quantidade_fiscal_informada
          : body.quantidade_fiscal_contada,
        quantidade_nao_fiscal_informada: body.quantidade_nao_fiscal_informada != null
          ? body.quantidade_nao_fiscal_informada
          : body.quantidade_nao_fiscal_contada,
        quantidade_fiscal_contada: body.quantidade_fiscal_contada,
        quantidade_nao_fiscal_contada: body.quantidade_nao_fiscal_contada,
        apresentacao_id: body.apresentacao_id,
        unidade_informada: body.unidade_informada || body.unidade_comercial,
        modo_fiscal: body.modo_fiscal != null ? body.modo_fiscal : req.query.modo_fiscal,
        omitir_nao_fiscal: body.omitir_nao_fiscal,
        operacao: body.operacao,
        tipo_ajuste: body.tipo_ajuste != null ? body.tipo_ajuste : body.tipoAjuste
      });
      return res.json(preview);
    } catch (err) {
      const status = Number(err && err.status) || 400;
      return res.status(status).json({
        error: err && err.message ? err.message : 'Erro ao pré-visualizar contagem.',
        code: err && err.code ? err.code : 'CONTAGEM_PREVIEW_FALHOU'
      });
    }
  });

  router.post('/contagem-fisica', exigirContexto, exigirPerfilAjusteEstoque(), async (req, res) => {
    try {
      const body = req.body || {};
      const chave = req.get('Idempotency-Key')
        || body.chave_idempotencia
        || body.chaveIdempotencia
        || null;
      // Fronteira oficial: sem snapshot → SNAPSHOT_OBRIGATORIO (não cai no legado silencioso).
      const itensComSnapshot = exigirSnapshotItensOficiais(body.itens || []);
      const resultado = await EstoqueContagemFisicaService.registrarContagemFisica({
        db: dbConn,
        empresaId: req.empresaId,
        itens: itensComSnapshot,
        observacao: body.observacao,
        usuarioId: req.user && req.user.id,
        usuarioNome: (req.user && (req.user.username || req.user.nome)) || null,
        chaveIdempotencia: chave,
        modo_fiscal: body.modo_fiscal != null ? body.modo_fiscal : req.query.modo_fiscal,
        omitir_nao_fiscal: body.omitir_nao_fiscal
      });
      return res.status(201).json(resultado);
    } catch (err) {
      const status = Number(err && err.status) || 400;
      return res.status(status).json({
        error: err && err.message ? err.message : 'Erro ao registrar contagem física.',
        code: err && err.code ? err.code : 'CONTAGEM_FISICA_FALHOU',
        produto_id: err && err.produto_id != null ? err.produto_id : undefined,
        saldo_fiscal_esperado: err && err.saldo_fiscal_esperado,
        saldo_nao_fiscal_esperado: err && err.saldo_nao_fiscal_esperado,
        saldo_fiscal_atual: err && err.saldo_fiscal_atual,
        saldo_nao_fiscal_atual: err && err.saldo_nao_fiscal_atual
      });
    }
  });

  // CDS-ESTOQUE-CONTAGEM-REDESIGN-PREVIEW-05.3 — saldo atual, sem escrita (antes de :id).
  router.get('/contagem-fisica/saldo-atual', exigirContexto, exigirPerfilAjusteEstoque(), async (req, res) => {
    try {
      const q = req.query || {};
      const saldo = await EstoqueContagemFisicaService.consultarSaldoAtualContagem({
        db: dbConn,
        empresaId: req.empresaId,
        produtoId: q.produto_id != null ? q.produto_id : q.produtoId
      });
      return res.json(saldo);
    } catch (err) {
      const status = Number(err && err.status) || 400;
      return res.status(status).json({
        ok: false,
        somente_leitura: true,
        movimentou_estoque: false,
        error: err && err.message ? err.message : 'Erro ao consultar o saldo atual.',
        code: err && err.code ? err.code : 'SALDO_ATUAL_FALHOU'
      });
    }
  });

  // CDS-ESTOQUE-CONTAGEM-UX-PERMISSOES-05.1 — busca read-only de produtos (antes de :id).
  router.get('/contagem-fisica/produtos-busca', exigirContexto, exigirPerfilAjusteEstoque(), async (req, res) => {
    try {
      const q = req.query && (req.query.q != null ? req.query.q : req.query.termo);
      const limite = req.query && req.query.limite != null ? req.query.limite : undefined;
      const resultado = await buscarProdutosParaContagem(dbConn, q, { limite });
      return res.json(resultado);
    } catch (err) {
      const status = Number(err && err.status) || 400;
      return res.status(status).json({
        ok: false,
        error: err && err.message ? err.message : 'Erro ao pesquisar produtos.',
        code: err && err.code ? err.code : 'BUSCA_PRODUTOS_FALHOU'
      });
    }
  });

  // CDS-ESTOQUE-CONTAGEM-PERIODICIDADE-05 — configuração e status informativos (antes de :id).
  router.get('/contagem-fisica/periodicidade', exigirContexto, exigirPerfilAjusteEstoque(), async (req, res) => {
    try {
      const cfg = await EstoqueContagemPeriodicidadeService.obterPeriodicidade(dbConn, req.empresaId);
      return res.json(cfg);
    } catch (err) {
      const status = Number(err && err.status) || 400;
      return res.status(status).json({
        error: err && err.message ? err.message : 'Erro ao consultar periodicidade.',
        code: err && err.code ? err.code : 'PERIODICIDADE_CONSULTA_FALHOU',
        consulta_disponivel: false
      });
    }
  });

  router.put('/contagem-fisica/periodicidade', exigirContexto, exigirPerfilAjusteEstoque(), async (req, res) => {
    try {
      const body = req.body || {};
      const cfg = await EstoqueContagemPeriodicidadeService.salvarPeriodicidade(
        dbConn,
        req.empresaId,
        {
          periodicidade: body.periodicidade,
          ativo: body.ativo
        },
        { usuarioId: req.user && req.user.id }
      );
      return res.json(cfg);
    } catch (err) {
      const status = Number(err && err.status) || 400;
      return res.status(status).json({
        error: err && err.message ? err.message : 'Erro ao salvar periodicidade.',
        code: err && err.code ? err.code : 'PERIODICIDADE_SALVAR_FALHOU'
      });
    }
  });

  router.get('/contagem-fisica/status-periodicidade', exigirContexto, exigirPerfilAjusteEstoque(), async (req, res) => {
    try {
      const status = await EstoqueContagemPeriodicidadeService.obterStatusPeriodicidade(
        dbConn,
        req.empresaId
      );
      return res.json(status);
    } catch (err) {
      const statusCode = Number(err && err.status) || 400;
      return res.status(statusCode).json({
        ok: false,
        consulta_disponivel: false,
        error: err && err.message ? err.message : 'Não foi possível consultar o status da periodicidade.',
        code: err && err.code ? err.code : 'CONSULTA_PERIODICIDADE_FALHOU',
        empresa_id: req.empresaId
        // Não inventar EM_DIA em falha.
      });
    }
  });

  router.get('/contagem-fisica/historico', exigirContexto, exigirPerfilAjusteEstoque(), async (req, res) => {
    try {
      const limite = req.query && req.query.limite != null ? req.query.limite : undefined;
      const hist = await EstoqueContagemFisicaService.enriquecerHistoricoComTipoAjuste(
        dbConn,
        req.empresaId,
        await EstoqueContagemPeriodicidadeService.listarHistoricoContagens(
          dbConn,
          req.empresaId,
          { limite }
        )
      );
      return res.json(hist);
    } catch (err) {
      const status = Number(err && err.status) || 400;
      return res.status(status).json({
        ok: false,
        error: err && err.message ? err.message : 'Erro ao listar histórico de contagens.',
        code: err && err.code ? err.code : 'CONSULTA_HISTORICO_FALHOU'
      });
    }
  });

  // CDS-ESTOQUE-CONTAGEM-PENDENCIAS-04 — somente leitura (antes de :id).
  router.get('/contagem-fisica/pendencias-entrada', exigirContexto, exigirPerfilAjusteEstoque(), async (req, res) => {
    try {
      const limite = req.query && req.query.limite != null ? req.query.limite : undefined;
      const resultado = await listarPendenciasEntradaEstoque({
        db: dbConn,
        empresaId: req.empresaId,
        limite
      });
      return res.json(resultado);
    } catch (err) {
      const status = Number(err && err.status) || 400;
      return res.status(status).json({
        ok: false,
        consulta_disponivel: false,
        error: err && err.message
          ? err.message
          : 'Não foi possível verificar as entradas pendentes.',
        code: err && err.code ? err.code : 'CONSULTA_PENDENCIAS_FALHOU',
        empresa_id: req.empresaId
      });
    }
  });

  router.get('/contagem-fisica/:id', exigirContexto, exigirPerfilAjusteEstoque(), async (req, res) => {
    try {
      const resultado = await EstoqueContagemFisicaService.obterContagemPorId(
        dbConn,
        req.params.id,
        req.empresaId
      );
      return res.json(resultado);
    } catch (err) {
      const status = Number(err && err.status) || 400;
      return res.status(status).json({
        error: err && err.message ? err.message : 'Erro ao consultar contagem.',
        code: err && err.code ? err.code : 'CONTAGEM_CONSULTA_FALHOU'
      });
    }
  });

  return router;
}

const router = criarRotasEstoque(dbDefault);
router.criarRotasEstoque = criarRotasEstoque;
router.handleGetProdutoEstoqueEmpresa = handleGetProdutoEstoqueEmpresa;
module.exports = router;
