/**
 * Converte reserva ATIVA em baixa definitiva de estoque (Sprint 3 + 02.7).
 * 1) Baixa saldo via reduzirEstoqueDistribuido (02.6 — não migrar aqui)
 * 2) Decrementa reservado_fiscal / reservado_nao_fiscal via reservasPublico
 * 3) Marca reserva como CONSUMIDA
 */

'use strict';

const db = require('../../database');
const { reduzirEstoqueDistribuido } = require('../vendas/VendaPagamentoService');
const reservasPublico = require('../fiscalNaoFiscal/reservasPublico');
const { TipoSaldo } = require('../fiscalNaoFiscal/constants');
const { montarOptsPortaReservaPdv } = require('./EstoqueReservaService');

function all(sql, params = [], dbConn = db) {
  return new Promise((resolve, reject) => {
    dbConn.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function get(sql, params = [], dbConn = db) {
  return new Promise((resolve, reject) => {
    dbConn.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function run(sql, params = [], dbConn = db) {
  return new Promise((resolve, reject) => {
    dbConn.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function reduzirEstoqueDistribuidoAsync(vendaItemId, produtoId, qF, qNf, opcoes = {}) {
  return new Promise((resolve, reject) => {
    reduzirEstoqueDistribuido(vendaItemId, produtoId, qF, qNf, (err) => {
      if (err) return reject(err);
      resolve();
    }, opcoes);
  });
}

/** Resolve item válido para FEFO/venda_lotes — evita FK com item órfão. */
async function resolverVendaItemId(vendaId, produtoId, vendaItemId, dbConn = db) {
  if (vendaItemId) {
    const ok = await get('SELECT id FROM vendas_itens WHERE id = ?', [vendaItemId], dbConn);
    if (ok) return ok.id;
  }
  const porProduto = await get(
    `SELECT id FROM vendas_itens WHERE venda_id = ? AND produto_id = ? ORDER BY id DESC LIMIT 1`,
    [vendaId, produtoId],
    dbConn
  );
  return porProduto ? porProduto.id : null;
}

/**
 * Consome reservas ativas da venda (baixa definitiva + libera reservado).
 * Deve ser chamado dentro de transação aberta pelo caller quando possível.
 */
async function consumirReservasDaVenda(vendaId, opcoes = {}) {
  const dbConn = opcoes.db || db;
  const optsPorta = montarOptsPortaReservaPdv(opcoes, dbConn);

  const rows = await all(
    `SELECT * FROM venda_estoque_reservas WHERE venda_id = ? AND status = 'ATIVA'`,
    [vendaId],
    dbConn
  );

  for (const row of rows) {
    const qF = Number(row.quantidade_fiscal || 0);
    const qNf = Number(row.quantidade_nao_fiscal || 0);

    if (qF > 0 || qNf > 0) {
      const vendaItemId = await resolverVendaItemId(
        vendaId,
        row.produto_id,
        row.venda_item_id,
        dbConn
      );
      await reduzirEstoqueDistribuidoAsync(
        vendaItemId,
        row.produto_id,
        qF,
        qNf,
        opcoes
      );
    }

    if (qF > 0) {
      await reservasPublico.liberarQuantidadeReservada(
        row.produto_id,
        TipoSaldo.FISCAL,
        qF,
        optsPorta
      );
    }
    if (qNf > 0) {
      await reservasPublico.liberarQuantidadeReservada(
        row.produto_id,
        TipoSaldo.NAO_FISCAL,
        qNf,
        optsPorta
      );
    }

    await run(
      `UPDATE venda_estoque_reservas
       SET status = 'CONSUMIDA', atualizado_em = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [row.id],
      dbConn
    );
  }

  return { consumidas: rows.length };
}

module.exports = {
  consumirReservasDaVenda
};
