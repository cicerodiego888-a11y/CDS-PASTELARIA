/**
 * Débito de estoque na baixa normal de venda — Porta Pública F×NF.
 *
 * Fase 1 / Implementação 02.6:
 *   venda → distribuição (intacta) → debitarSaldo → produtos
 * Storage ainda em `produtos` (sem estoque_empresa).
 *
 * Reutiliza quantidade_fiscal / quantidade_nao_fiscal já produzidas
 * por distribuidorEstoqueVenda. Não recalcula distribuição.
 * Não altera cancelamento, devolução, reservas, TEF nem financeiro.
 *
 * @module services/vendas/debitoEstoqueVendaViaPorta
 */
'use strict';

const estoqueSaldosPublico = require('../fiscalNaoFiscal/estoqueSaldosPublico');
const { TipoSaldo } = require('../fiscalNaoFiscal/constants');
const { resolverEmpresaId } = require('../fiscalNaoFiscal/empresaContexto');

/** Compat explícita: ERP/PDV ainda sem empresa no JWT. */
const MOTIVO_COMPAT_DEBITO_VENDA = 'COMPAT_DEBITO_VENDA_PRE_MULTIEMPRESA';

function montarOpcoesBaixaEstoqueVenda(req, origem, dbConn) {
  return {
    db: dbConn,
    empresaId: resolverEmpresaId(req && req.empresaId),
    usuarioId: req?.operadorId || req?.user?.id || req?.user?.usuarioId || null,
    origem: origem || 'baixa_venda'
  };
}

function montarOptsPortaDebitoVenda(db, opcoes = {}) {
  const empresaId = resolverEmpresaId(opcoes)
    ?? resolverEmpresaId(opcoes.contexto)
    ?? resolverEmpresaId(opcoes.ctx);

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
    motivoCompat: opcoes.motivoCompat || MOTIVO_COMPAT_DEBITO_VENDA,
    legado: true
  };
}

function round3(n) {
  return Math.round(Number(n || 0) * 1000) / 1000;
}

/**
 * Debita SF e/ou SNF do item de venda pela porta pública (baixa normal).
 *
 * Assinatura: debitarEstoqueItemVenda(db, dados, callback)
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
function debitarEstoqueItemVenda(db, dados, callback) {
  if (typeof callback !== 'function') {
    throw new Error('debitarEstoqueItemVenda: callback obrigatório');
  }

  const produtoId = Number(dados.produtoId || dados.produto_id);
  const qtdFiscal = round3(dados.quantidadeFiscal ?? dados.quantidade_fiscal ?? 0);
  const qtdNaoFiscal = round3(dados.quantidadeNaoFiscal ?? dados.quantidade_nao_fiscal ?? 0);

  if (!Number.isInteger(produtoId) || produtoId <= 0) {
    return callback(new Error('produtoId inválido para débito de venda (baixa)'));
  }

  let optsPorta;
  try {
    optsPorta = montarOptsPortaDebitoVenda(db, dados);
  } catch (e) {
    return callback(e);
  }

  if (!(qtdFiscal > 0) && !(qtdNaoFiscal > 0)) {
    return callback(null, {
      produto_id: produtoId,
      debitado: false,
      saldo_fiscal: null,
      saldo_nao_fiscal: null,
      estoque_atual: null,
      empresa_id: optsPorta.empresaId != null ? optsPorta.empresaId : null,
      legado: optsPorta.legado === true,
      motivo_compat: optsPorta.legado ? (optsPorta.motivoCompat || MOTIVO_COMPAT_DEBITO_VENDA) : null,
      origem: dados.origem || null
    });
  }

  (async () => {
    if (qtdFiscal > 0) {
      await estoqueSaldosPublico.debitarSaldo(produtoId, TipoSaldo.FISCAL, qtdFiscal, optsPorta);
    }
    if (qtdNaoFiscal > 0) {
      await estoqueSaldosPublico.debitarSaldo(produtoId, TipoSaldo.NAO_FISCAL, qtdNaoFiscal, optsPorta);
    }

    const depois = await estoqueSaldosPublico.consultarSaldo(produtoId, optsPorta);
    return {
      produto_id: produtoId,
      debitado: true,
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
      motivo_compat: optsPorta.legado ? (optsPorta.motivoCompat || MOTIVO_COMPAT_DEBITO_VENDA) : null,
      origem: dados.origem || null
    };
  })().then(
    (result) => callback(null, result),
    (err) => callback(err)
  );
}

module.exports = {
  MOTIVO_COMPAT_DEBITO_VENDA,
  montarOpcoesBaixaEstoqueVenda,
  montarOptsPortaDebitoVenda,
  debitarEstoqueItemVenda
};
