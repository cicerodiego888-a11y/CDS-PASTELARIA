/**
 * Reserva de estoque para Vendas para Entrega / PDV (Sprint 2 + 02.7)
 * NÃO baixa saldo_fiscal / saldo_nao_fiscal / estoque_atual.
 * reservado_fiscal / reservado_nao_fiscal: escritos somente via reservasPublico.
 * Tracking permanece em venda_estoque_reservas.
 */

'use strict';

const db = require('../../database');
const { produtoControlaEstoque } = require('./produtoControlaEstoque');
const reservasPublico = require('../fiscalNaoFiscal/reservasPublico');
const { TipoSaldo } = require('../fiscalNaoFiscal/constants');
const { resolverEmpresaId } = require('../fiscalNaoFiscal/empresaContexto');

/** Compat explícita: PDV/entrega ainda sem empresa no JWT. */
const MOTIVO_COMPAT_RESERVA_PDV = 'COMPAT_RESERVA_PDV_PRE_MULTIEMPRESA';

function dbDeOpcoes(opcoes) {
  return (opcoes && opcoes.db) || db;
}

/**
 * 03.26 — req.empresaId (contexto validado) é a única autoridade.
 * body / query / contexto / ctx / CNPJ não substituem.
 */
function empresaIdDoReqReservaPdv(req) {
  return resolverEmpresaId(req && req.empresaId);
}

function montarOptsPortaReservaPdv(fonte = {}, dbConn) {
  const empresaId = empresaIdDoReqReservaPdv(fonte.req)
    ?? empresaIdDoReqReservaPdv(fonte)
    ?? resolverEmpresaId(fonte.empresaId);

  const base = {
    db: dbConn || dbDeOpcoes(fonte),
    usuarioId: fonte.usuarioId || fonte.operadorId || fonte.user?.id || fonte.req?.operadorId || fonte.req?.user?.id || null,
    validarEmpresa: fonte.validarEmpresa
  };

  if (empresaId != null) {
    return { ...base, empresaId, legado: false, motivoCompat: null };
  }

  if (fonte.exigirEmpresa === true) {
    const err = new Error(
      'empresaId é obrigatório para operações de saldo/reserva. Informe empresa_id/empresaId no contexto.'
    );
    err.code = 'EMPRESA_OBRIGATORIA';
    throw err;
  }

  return {
    ...base,
    modoLegadoSemEmpresa: true,
    motivoCompat: fonte.motivoCompat || MOTIVO_COMPAT_RESERVA_PDV,
    legado: true
  };
}

function run(sql, params = [], dbConn = db) {
  return new Promise((resolve, reject) => {
    dbConn.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = [], dbConn = db) {
  return new Promise((resolve, reject) => {
    dbConn.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

async function aplicarReservadoViaPorta(produtoId, qF, qNf, optsPorta, sentido) {
  const fn = sentido === 'liberar'
    ? reservasPublico.liberarQuantidadeReservada
    : reservasPublico.reservarQuantidade;
  if (qF > 0) await fn(produtoId, TipoSaldo.FISCAL, qF, optsPorta);
  if (qNf > 0) await fn(produtoId, TipoSaldo.NAO_FISCAL, qNf, optsPorta);
}

/**
 * Incrementa reserva no produto (porta) e registra linha da reserva.
 * Deve ser chamado DENTRO de uma transação já aberta pelo caller quando possível.
 */
function reservarItem({
  vendaId,
  vendaItemId,
  produtoId,
  quantidadeFiscal,
  quantidadeNaoFiscal,
  empresaId,
  usuarioId,
  db: dbInjected,
  exigirEmpresa
} = {}, callback) {
  if (typeof callback !== 'function') {
    throw new Error('reservarItem: callback obrigatório');
  }

  const qF = Number(quantidadeFiscal || 0);
  const qNf = Number(quantidadeNaoFiscal || 0);
  const dbConn = dbInjected || db;

  if (qF <= 0 && qNf <= 0) {
    return callback(null);
  }

  dbConn.get(
    `SELECT COALESCE(controla_estoque, 1) AS controla_estoque FROM produtos WHERE id = ?`,
    [produtoId],
    (errFlag, rowFlag) => {
      if (errFlag) return callback(errFlag);
      if (!produtoControlaEstoque(rowFlag || {})) {
        return callback(null);
      }

      let optsPorta;
      try {
        optsPorta = montarOptsPortaReservaPdv({
          empresaId,
          usuarioId,
          exigirEmpresa,
          db: dbConn
        }, dbConn);
      } catch (e) {
        return callback(e);
      }

      aplicarReservadoViaPorta(produtoId, qF, qNf, optsPorta, 'reservar')
        .then(() => run(
          `
              INSERT INTO venda_estoque_reservas (
                venda_id, venda_item_id, produto_id,
                quantidade_fiscal, quantidade_nao_fiscal,
                status, criado_em
              ) VALUES (?, ?, ?, ?, ?, 'ATIVA', CURRENT_TIMESTAMP)
            `,
          [vendaId, vendaItemId || null, produtoId, qF, qNf],
          dbConn
        ))
        .then(() => callback(null))
        .catch(callback);
    }
  );
}

/**
 * Libera reservas ativas de uma venda (cancelamento / entrega).
 */
async function liberarReservasDaVenda(vendaId, opcoes = {}) {
  const dbConn = dbDeOpcoes(opcoes);
  const optsPorta = montarOptsPortaReservaPdv(opcoes, dbConn);

  const rows = await new Promise((resolve, reject) => {
    dbConn.all(
      `SELECT * FROM venda_estoque_reservas WHERE venda_id = ? AND status = 'ATIVA'`,
      [vendaId],
      (err, list) => (err ? reject(err) : resolve(list || []))
    );
  });

  for (const row of rows) {
    const qF = Number(row.quantidade_fiscal || 0);
    const qNf = Number(row.quantidade_nao_fiscal || 0);
    await aplicarReservadoViaPorta(row.produto_id, qF, qNf, optsPorta, 'liberar');
    await run(
      `UPDATE venda_estoque_reservas SET status = 'CANCELADA', atualizado_em = CURRENT_TIMESTAMP WHERE id = ?`,
      [row.id],
      dbConn
    );
  }

  return { liberadas: rows.length };
}

function obterProdutoComReserva(produtoId, callback, opcoes = {}) {
  const dbConn = dbDeOpcoes(opcoes);
  dbConn.get(
    `
      SELECT
        id, nome, estoque_atual,
        COALESCE(saldo_fiscal, 0) AS saldo_fiscal,
        COALESCE(saldo_nao_fiscal, 0) AS saldo_nao_fiscal,
        COALESCE(reservado_fiscal, 0) AS reservado_fiscal,
        COALESCE(reservado_nao_fiscal, 0) AS reservado_nao_fiscal
      FROM produtos
      WHERE id = ?
    `,
    [produtoId],
    callback
  );
}

module.exports = {
  MOTIVO_COMPAT_RESERVA_PDV,
  empresaIdDoReqReservaPdv,
  montarOptsPortaReservaPdv,
  reservarItem,
  liberarReservasDaVenda,
  obterProdutoComReserva,
  run,
  get
};
