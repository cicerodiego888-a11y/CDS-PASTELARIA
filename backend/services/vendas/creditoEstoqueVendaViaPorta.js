/**
 * Crédito de estoque em cancelamento/devolução de venda — Porta Pública F×NF.
 *
 * Fase 1 / Implementação 02.5:
 *   cancel/devolução venda → creditarSaldo → produtos
 * Storage ainda em `produtos` (sem estoque_empresa).
 *
 * Reutiliza a classificação F/NF já persistida na venda
 * (resolverQuantidadesVendaItem / calcularDevolucaoVendaFiscalPrimeiro).
 * Não recalcula distribuição. Cancelamento/devolução: este módulo.
 * Baixa normal de venda: debitoEstoqueVendaViaPorta (02.6).
 *
 * @module services/vendas/creditoEstoqueVendaViaPorta
 */
'use strict';

const estoqueSaldosPublico = require('../fiscalNaoFiscal/estoqueSaldosPublico');
const { TipoSaldo } = require('../fiscalNaoFiscal/constants');
const { resolverEmpresaId } = require('../fiscalNaoFiscal/empresaContexto');

/** Compat explícita: ERP cancel/devolução venda ainda sem empresa no JWT. */
const MOTIVO_COMPAT_CREDITO_VENDA = 'COMPAT_CREDITO_VENDA_CANCEL_DEV_PRE_MULTIEMPRESA';

/**
 * 03.31 — req.empresaId (contexto validado) é a única autoridade HTTP.
 * body / query / user / contexto / ctx / CNPJ não substituem.
 */
function empresaIdDoReqCreditoVenda(req) {
  return resolverEmpresaId(req && req.empresaId);
}

function extrairEmpresaIdDeReq(req) {
  return empresaIdDoReqCreditoVenda(req);
}

/**
 * Monta opções de retorno a partir de req.empresaId.
 * Sem empresa: COMPAT 02.5 (não inventa empresa 1).
 */
function montarOpcoesRetornoEstoqueVenda(req, origem, dbConn) {
  return {
    db: dbConn,
    empresaId: empresaIdDoReqCreditoVenda(req),
    usuarioId: req?.operadorId || req?.user?.id || req?.user?.usuarioId || null,
    origem: origem || null
  };
}

/**
 * Retorno de estoque de cancelamento/devolução (05.42).
 * Empresa vem EXCLUSIVAMENTE de vendas.empresa_id — ignora req.empresaId.
 */
function montarOpcoesRetornoEstoqueDaVenda(venda, req, origem, dbConn) {
  const { resolverEmpresaDaVenda } = require('./VendaEmpresaContextoService');
  const empresaId = resolverEmpresaDaVenda(venda);
  return {
    db: dbConn,
    empresaId,
    usuarioId: req?.operadorId || req?.user?.id || req?.user?.usuarioId || null,
    origem: origem || null,
    exigirEmpresa: true
  };
}

function montarOptsPortaCreditoVenda(db, opcoes = {}) {
  const empresaId = resolverEmpresaId(opcoes.empresaId);

  const base = {
    db,
    usuarioId: opcoes.usuarioId,
    validarEmpresa: opcoes.validarEmpresa
  };

  if (empresaId != null) {
    return { ...base, empresaId, legado: false, motivoCompat: null };
  }

  if (opcoes.exigirEmpresa === true) {
    const err = new Error(
      'empresaId é obrigatório para operações de saldo/reserva. Informe empresa_id/empresaId no contexto.'
    );
    err.code = 'EMPRESA_OBRIGATORIA';
    throw err;
  }

  return {
    ...base,
    modoLegadoSemEmpresa: true,
    motivoCompat: opcoes.motivoCompat || MOTIVO_COMPAT_CREDITO_VENDA,
    legado: true
  };
}

function round3(n) {
  return Math.round(Number(n || 0) * 1000) / 1000;
}

/**
 * Credita SF e/ou SNF do item de venda pela porta pública
 * (retorno de cancelamento ou devolução).
 *
 * Assinatura: creditarEstoqueItemVenda(db, dados, callback)
 *
 * @param {object} db
 * @param {{
 *   produtoId: number,
 *   quantidadeFiscal?: number,
 *   quantidadeNaoFiscal?: number,
 *   empresaId?: number,
 *   usuarioId?: number,
 *   exigirEmpresa?: boolean,
 *   origem?: string
 * }} dados
 * @param {function} callback
 */
function creditarEstoqueItemVenda(db, dados, callback) {
  if (typeof callback !== 'function') {
    throw new Error('creditarEstoqueItemVenda: callback obrigatório');
  }

  const produtoId = Number(dados.produtoId || dados.produto_id);
  const qtdFiscal = round3(dados.quantidadeFiscal ?? dados.quantidade_fiscal ?? 0);
  const qtdNaoFiscal = round3(dados.quantidadeNaoFiscal ?? dados.quantidade_nao_fiscal ?? 0);

  if (!Number.isInteger(produtoId) || produtoId <= 0) {
    return callback(new Error('produtoId inválido para crédito de venda (cancel/devolução)'));
  }

  let optsPorta;
  try {
    optsPorta = montarOptsPortaCreditoVenda(db, dados);
  } catch (e) {
    return callback(e);
  }

  if (!(qtdFiscal > 0) && !(qtdNaoFiscal > 0)) {
    return callback(null, {
      produto_id: produtoId,
      creditado: false,
      saldo_fiscal: null,
      saldo_nao_fiscal: null,
      estoque_atual: null,
      empresa_id: optsPorta.empresaId != null ? optsPorta.empresaId : null,
      legado: optsPorta.legado === true,
      motivo_compat: optsPorta.legado ? (optsPorta.motivoCompat || MOTIVO_COMPAT_CREDITO_VENDA) : null,
      origem: dados.origem || null
    });
  }

  (async () => {
    if (qtdFiscal > 0) {
      await estoqueSaldosPublico.creditarSaldo(produtoId, TipoSaldo.FISCAL, qtdFiscal, optsPorta);
    }
    if (qtdNaoFiscal > 0) {
      await estoqueSaldosPublico.creditarSaldo(produtoId, TipoSaldo.NAO_FISCAL, qtdNaoFiscal, optsPorta);
    }

    const depois = await estoqueSaldosPublico.consultarSaldo(produtoId, optsPorta);
    return {
      produto_id: produtoId,
      creditado: true,
      quantidade_fiscal: qtdFiscal,
      quantidade_nao_fiscal: qtdNaoFiscal,
      saldo_fiscal: Number(depois.saldo_fiscal),
      saldo_nao_fiscal: Number(depois.saldo_nao_fiscal),
      estoque_atual: Number(
        depois.estoque_atual != null
          ? depois.estoque_atual
          : (depois.saldo_fiscal + depois.saldo_nao_fiscal)
      ),
      empresa_id: depois.empresa_id != null ? depois.empresa_id : null,
      legado: optsPorta.legado === true,
      motivo_compat: optsPorta.legado ? (optsPorta.motivoCompat || MOTIVO_COMPAT_CREDITO_VENDA) : null,
      origem: dados.origem || null
    };
  })().then(
    (result) => callback(null, result),
    (err) => callback(err)
  );
}

module.exports = {
  MOTIVO_COMPAT_CREDITO_VENDA,
  empresaIdDoReqCreditoVenda,
  extrairEmpresaIdDeReq,
  montarOpcoesRetornoEstoqueVenda,
  montarOpcoesRetornoEstoqueDaVenda,
  montarOptsPortaCreditoVenda,
  creditarEstoqueItemVenda
};
