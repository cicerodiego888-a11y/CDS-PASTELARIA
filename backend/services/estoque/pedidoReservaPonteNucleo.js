/**
 * RC4.1.2 — Ponte Pedido ↔ Núcleo Transacional.
 *
 * Reconhece reservas ATIVAS de pedido_estoque_reservas no cálculo de
 * disponibilidade do Núcleo, e consome essas reservas ao faturar.
 *
 * Fase 2 / Implementação 03.6:
 *   consumo de reserva de pedido → reservasPublico.liberarQuantidadeReservada
 * Somente reservado_fiscal (comportamento encontrado). Não altera saldo físico.
 * Tracking permanece em pedido_estoque_reservas. PDV (02.7) não é este fluxo.
 *
 * NÃO altera Motor Comercial, MTS nem a API pública de criação de reserva.
 */

'use strict';

const reservasPublico = require('../fiscalNaoFiscal/reservasPublico');
const { TipoSaldo } = require('../fiscalNaoFiscal/constants');
const { resolverEmpresaId } = require('../fiscalNaoFiscal/empresaContexto');
const {
  exigirEmpresaDoPedido,
  exigirPedidoDaEmpresa,
  exigirReservaDaMesmaEmpresa,
  erroPedidoEmpresa,
  CODIGO_EMPRESA_CONTEXT_REQUIRED,
  CODIGO_OPERACAO_EMPRESA_DIVERGENTE
} = require('../pedidos/PedidoEmpresaContextoService');

function round3(n) {
  return Math.round(Number(n || 0) * 1000) / 1000;
}

/**
 * Porta de consumo de reserva originada de PEDIDO.
 * Empresa é obrigatória e explícita. Sem COMPAT, sem descoberta de req/contexto.
 */
function montarOptsPortaConsumoReservaPedido(opcoes = {}) {
  const empresaId = resolverEmpresaId(
    opcoes.empresaId != null ? opcoes.empresaId : opcoes.empresa_id
  );
  if (empresaId == null) {
    throw erroPedidoEmpresa(
      CODIGO_EMPRESA_CONTEXT_REQUIRED,
      'empresaId é obrigatório para consumo de reserva originada de pedido.',
      400
    );
  }

  return {
    db: getDb(opcoes.db),
    usuarioId: opcoes.usuarioId,
    validarEmpresa: opcoes.validarEmpresa,
    empresaId,
    legado: false,
    motivoCompat: null,
    modoLegadoSemEmpresa: false
  };
}

function getDb(dbInjected) {
  if (dbInjected) return dbInjected;
  return require('../../database');
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

/**
 * Mapa produto_id → quantidade_fiscal reservada ATIVA do pedido.
 * Pedido sem reserva / inválido → mapa vazio (fluxo legado).
 */
async function obterCreditoReservaPedido(pedidoId, opts = {}) {
  const id = Number(pedidoId);
  if (!Number.isInteger(id) || id <= 0) {
    return Object.freeze({ pedido_id: null, por_produto: Object.freeze({}), total: 0 });
  }

  const db = getDb(opts.db);
  let rows = [];
  try {
    rows = await dbAll(
      db,
      `SELECT produto_id, COALESCE(SUM(quantidade_fiscal), 0) AS quantidade
       FROM pedido_estoque_reservas
       WHERE pedido_id = ? AND status = 'ATIVA'
       GROUP BY produto_id`,
      [id]
    );
  } catch (_) {
    return Object.freeze({ pedido_id: id, por_produto: Object.freeze({}), total: 0 });
  }

  const porProduto = {};
  let total = 0;
  for (const row of rows) {
    const pid = Number(row.produto_id);
    const q = round3(row.quantidade);
    if (pid > 0 && q > 0) {
      porProduto[pid] = q;
      total = round3(total + q);
    }
  }

  return Object.freeze({
    pedido_id: id,
    por_produto: Object.freeze(porProduto),
    total
  });
}

/**
 * Ajusta disponibilidade fiscal creditando a reserva do próprio pedido.
 * disponivel_outros permanece (saldo - reservado); o crédito só vale para este pedido.
 */
function creditarDisponibilidadeComReservaPedido(calc, creditoProduto) {
  const credito = round3(creditoProduto || 0);
  const disponivelFiscal = round3(Number(calc?.disponivel_fiscal || 0) + credito);
  const disponivelNaoFiscal = round3(Number(calc?.disponivel_nao_fiscal || 0));
  return {
    ...calc,
    disponivel_fiscal: Math.max(0, disponivelFiscal),
    disponivel_nao_fiscal: Math.max(0, disponivelNaoFiscal),
    disponivel_total: Math.max(0, round3(disponivelFiscal + disponivelNaoFiscal)),
    credito_reserva_pedido: credito
  };
}

/**
 * Consome reservas ATIVAS do pedido após a venda (baixa já feita pelo Núcleo).
 * - Libera reservado_fiscal pela porta pública (quantidade_fiscal persistida)
 * - Marca pedido_estoque_reservas como CONSUMIDA
 * Não altera saldo_fiscal / saldo_nao_fiscal / estoque_atual.
 * Não toca reservado_nao_fiscal (o tracking do pedido só tem quantidade_fiscal).
 * Idempotente: linhas já CONSUMIDA/CANCELADA são ignoradas.
 * Não abre transação própria — usa o mesmo db do caller.
 */
async function consumirReservasPedidoNaVenda(pedidoId, vendaId = null, opts = {}) {
  const id = Number(pedidoId);
  if (!Number.isInteger(id) || id <= 0) {
    return { consumidas: 0, pedido_id: null };
  }

  const db = getDb(opts.db);

  let pedido = null;
  try {
    pedido = await dbGet(db, `SELECT id, empresa_id FROM pedidos WHERE id = ?`, [id]);
  } catch (err) {
    const msg = String(err && err.message || '');
    if (!msg.includes('no such table') && !msg.includes('no such column')) {
      throw err;
    }
  }

  const empresaIdPedido = exigirEmpresaDoPedido(pedido);

  const empresaContexto = resolverEmpresaId(
    opts.empresaId != null ? opts.empresaId : opts.empresa_id
  );
  if (empresaContexto != null) {
    exigirPedidoDaEmpresa(pedido, empresaContexto);
  }

  const vid = vendaId != null ? Number(vendaId) : null;
  if (Number.isInteger(vid) && vid > 0) {
    let venda = null;
    try {
      venda = await dbGet(db, `SELECT id, empresa_id FROM vendas WHERE id = ?`, [vid]);
    } catch (err) {
      const msg = String(err && err.message || '');
      if (!msg.includes('no such table') && !msg.includes('no such column')) {
        throw err;
      }
    }
    if (venda) {
      const empresaIdVenda = resolverEmpresaId(venda.empresa_id != null ? venda.empresa_id : venda.empresaId);
      if (empresaIdVenda == null || empresaIdVenda !== empresaIdPedido) {
        throw erroPedidoEmpresa(
          CODIGO_OPERACAO_EMPRESA_DIVERGENTE,
          'empresa_id da venda diverge da empresa persistida do pedido.',
          409,
          {
            pedido_empresa_id: empresaIdPedido,
            venda_empresa_id: empresaIdVenda
          }
        );
      }
    }
  }

  await reservasPublico.garantirSchemaReservas(db);
  const rows = await dbAll(
    db,
    `SELECT * FROM pedido_estoque_reservas WHERE pedido_id = ? AND status = 'ATIVA'`,
    [id]
  );

  for (const row of rows) {
    exigirReservaDaMesmaEmpresa(pedido, row);
  }

  const optsPorta = montarOptsPortaConsumoReservaPedido({
    db,
    empresaId: empresaIdPedido,
    usuarioId: opts.usuarioId,
    validarEmpresa: opts.validarEmpresa
  });

  let consumidas = 0;
  for (const row of rows) {
    const q = round3(row.quantidade_fiscal);
    if (q > 0) {
      await reservasPublico.liberarQuantidadeReservada(
        row.produto_id,
        TipoSaldo.FISCAL,
        q,
        optsPorta
      );
    }

    await dbRun(
      db,
      `UPDATE pedido_estoque_reservas
       SET status = 'CONSUMIDA',
           atualizado_em = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'ATIVA'`,
      [row.id]
    );
    consumidas += 1;
  }

  return {
    consumidas,
    pedido_id: id,
    venda_id: vendaId != null ? Number(vendaId) : null,
    empresa_id: empresaIdPedido,
    legado: false,
    motivo_compat: null
  };
}

/** Callback-friendly wrappers for VendaPagamentoService */
function obterCreditoReservaPedidoCb(pedidoId, db, callback) {
  obterCreditoReservaPedido(pedidoId, { db })
    .then((r) => callback(null, r))
    .catch((err) => callback(err));
}

function consumirReservasPedidoNaVendaCb(pedidoId, vendaId, db, callback, extra = {}) {
  consumirReservasPedidoNaVenda(pedidoId, vendaId, { db, ...extra })
    .then((r) => callback(null, r))
    .catch((err) => callback(err));
}

module.exports = {
  montarOptsPortaConsumoReservaPedido,
  obterCreditoReservaPedido,
  creditarDisponibilidadeComReservaPedido,
  consumirReservasPedidoNaVenda,
  obterCreditoReservaPedidoCb,
  consumirReservasPedidoNaVendaCb,
  round3
};
