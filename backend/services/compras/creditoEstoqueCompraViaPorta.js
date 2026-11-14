/**
 * Crédito de estoque na conclusão de compra — via Porta Pública F×NF.
 *
 * Sprint CDS-ESTOQUE-INTEGRIDADE-ENTRADAS-01:
 *   crédito com movimentação exige empresaId válido (estoque_empresa).
 *   Sem fallback silencioso para saldo global de `produtos`.
 * Dual-write em `produtos` permanece quando há empresa (não eliminado nesta Sprint).
 *
 * Não altera classificação F/NF, MUC, MIIP nem Central.
 * Cancelamento/devolução: ver debitoEstoqueCompraViaPorta (02.4).
 *
 * @module services/compras/creditoEstoqueCompraViaPorta
 */
'use strict';
const { roundStockQuantity } = require('../estoque/quantityPrecision');

const estoqueSaldosPublico = require('../fiscalNaoFiscal/estoqueSaldosPublico');
const { TipoSaldo } = require('../fiscalNaoFiscal/constants');
const { resolverEmpresaId } = require('../fiscalNaoFiscal/empresaContexto');

/** Compat explícita (somente no-op / fluxos formalmente autorizados — não para crédito com qty). */
const MOTIVO_COMPAT_CREDITO_COMPRA = 'COMPAT_CREDITO_COMPRA_PRE_MULTIEMPRESA';

/**
 * 03.27 — req.empresaId (contexto validado) é a única autoridade HTTP.
 * body / query / contexto / ctx / CNPJ não substituem.
 */
function empresaIdDoReqCompra(req) {
  return resolverEmpresaId(req && req.empresaId);
}

/**
 * Monta opts da porta: empresaId explícito obrigatório para crédito com movimentação.
 * Nunca inventa empresa 1 / CNPJ de configurações / Matriz.
 */
function montarOptsPortaCreditoCompra(db, opcoes = {}) {
  const empresaId = resolverEmpresaId(opcoes.empresaId);

  const base = {
    db,
    usuarioId: opcoes.usuarioId,
    validarEmpresa: opcoes.validarEmpresa
  };

  if (empresaId != null) {
    return { ...base, empresaId, legado: false, motivoCompat: null };
  }

  // CDS-ESTOQUE-INTEGRIDADE-ENTRADAS-01: sem empresa → bloqueio (sem COMPAT silencioso).
  if (opcoes.exigirEmpresa !== false) {
    const err = new Error(
      'empresaId é obrigatório para crédito de estoque da compra. Informe empresa_id/empresaId no contexto.'
    );
    err.code = 'EMPRESA_OBRIGATORIA';
    throw err;
  }

  // Somente se o chamador optar explicitamente por não exigir empresa (no-op / legado autorizado).
  return {
    ...base,
    modoLegadoSemEmpresa: true,
    motivoCompat: opcoes.motivoCompat || MOTIVO_COMPAT_CREDITO_COMPRA,
    legado: true
  };
}



/**
 * Credita SF e/ou SNF do item de compra pela porta pública.
 * Quantidades já devem estar resolvidas (MUC / tratamento fiscal).
 *
 * Assinatura:
 *   creditarEstoqueItemCompra(db, dados, callback)
 *
 * @param {object} db
 * @param {{
 *   produtoId: number,
 *   quantidadeFiscal?: number,
 *   quantidadeNaoFiscal?: number,
 *   empresaId?: number,
 *   usuarioId?: number,
 *   exigirEmpresa?: boolean
 * }} dados
 * @param {function} callback
 */
function creditarEstoqueItemCompra(db, dados, callback) {
  if (typeof callback !== 'function') {
    throw new Error('creditarEstoqueItemCompra: callback obrigatório');
  }

  const produtoId = Number(dados.produtoId || dados.produto_id);
  const qtdFiscal = roundStockQuantity(dados.quantidadeFiscal ?? dados.quantidade_fiscal ?? 0);
  const qtdNaoFiscal = roundStockQuantity(dados.quantidadeNaoFiscal ?? dados.quantidade_nao_fiscal ?? 0);

  if (!Number.isInteger(produtoId) || produtoId <= 0) {
    return callback(new Error('produtoId inválido para crédito de compra'));
  }

  const vaiMovimentar = qtdFiscal > 0 || qtdNaoFiscal > 0;

  // Sem quantidade: não há crédito — não força empresa (uso/consumo, bonificação sem estoque, etc.).
  if (!vaiMovimentar) {
    const empresaIdInfo = resolverEmpresaId(dados.empresaId);
    return callback(null, {
      produto_id: produtoId,
      creditado: false,
      saldo_fiscal: null,
      saldo_nao_fiscal: null,
      estoque_atual: null,
      empresa_id: empresaIdInfo != null ? empresaIdInfo : null,
      legado: false,
      motivo_compat: null
    });
  }

  // Com movimentação: empresa obrigatória — sem fallback para estoque global.
  let optsPorta;
  try {
    optsPorta = montarOptsPortaCreditoCompra(db, {
      ...dados,
      exigirEmpresa: true
    });
  } catch (e) {
    return callback(e);
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
      legado: false,
      motivo_compat: null
    };
  })().then(
    (result) => callback(null, result),
    (err) => callback(err)
  );
}

module.exports = {
  MOTIVO_COMPAT_CREDITO_COMPRA,
  empresaIdDoReqCompra,
  montarOptsPortaCreditoCompra,
  creditarEstoqueItemCompra
};
