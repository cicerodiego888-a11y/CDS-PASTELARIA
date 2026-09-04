/**
 * Converte reserva ATIVA em baixa definitiva de estoque (Sprint 3 + 02.7).
 * 1) Baixa saldo via reduzirEstoqueDistribuido (02.6)
 * 2) Decrementa reservado_* via reservasPublico
 * 3) Marca reserva como CONSUMIDA
 *
 * Sprint 05.53 — baixa física usa somente reserva.empresa_id.
 * COMPAT / caller / req não decidem o estoque afetado.
 */

'use strict';

const db = require('../../database');
const { reduzirEstoqueDistribuido } = require('../vendas/VendaPagamentoService');
const reservasPublico = require('../fiscalNaoFiscal/reservasPublico');
const { TipoSaldo } = require('../fiscalNaoFiscal/constants');
const { resolverEmpresaId } = require('../fiscalNaoFiscal/empresaContexto');

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

function erroConsumoReserva(code, message, status = 400, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  Object.assign(err, extra);
  return err;
}

/**
 * Opções limpas para a baixa física: só a dona da reserva.
 * Sem spread de opcoes do caller (evita modoLegadoSemEmpresa / motivoCompat).
 */
function montarOpcoesBaixaFisicaDaReserva(dona, dbConn, opcoes = {}) {
  const empresaId = resolverEmpresaId(dona);
  if (empresaId == null) {
    throw erroConsumoReserva(
      'EMPRESA_OWNERSHIP_REQUIRED',
      'Reserva sem ownership empresarial identificável.'
    );
  }
  return {
    db: dbConn,
    empresaId,
    usuarioId: opcoes.usuarioId || opcoes.operadorId || null,
    exigirEmpresa: true,
    origem: 'consumo_reserva_pdv',
    validarEmpresa: opcoes.validarEmpresa
  };
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
 * Fonte da baixa física e do reservado: venda_estoque_reservas.empresa_id.
 * Caller só autoriza. Venda deve coincidir com a reserva.
 */
async function consumirReservasDaVenda(vendaId, opcoes = {}) {
  const dbConn = opcoes.db || db;
  const vid = Number(vendaId);
  const callerEmpresa = resolverEmpresaId(
    opcoes.empresaId != null ? opcoes.empresaId : opcoes.empresa_id
  );

  let venda = null;
  try {
    venda = await get(`SELECT id, empresa_id FROM vendas WHERE id = ?`, [vid], dbConn);
  } catch (err) {
    const msg = String(err && err.message || '');
    if (!msg.includes('no such table') && !msg.includes('no such column')) {
      throw err;
    }
  }

  const empresaIdVenda = venda
    ? resolverEmpresaId(venda.empresa_id != null ? venda.empresa_id : venda.empresaId)
    : null;

  const rows = await all(
    `SELECT * FROM venda_estoque_reservas WHERE venda_id = ? AND status = 'ATIVA'`,
    [vid],
    dbConn
  );

  // Validar ownership / divergências ANTES de qualquer mutação
  for (const row of rows) {
    const dona = resolverEmpresaId(row.empresa_id);
    if (dona == null) {
      throw erroConsumoReserva(
        'EMPRESA_OWNERSHIP_REQUIRED',
        'Reserva sem ownership empresarial identificável.'
      );
    }
    if (callerEmpresa != null && callerEmpresa !== dona) {
      throw erroConsumoReserva(
        'RESERVA_EMPRESA_DIVERGENTE',
        'empresa_id da reserva diverge da empresa informada na operação.',
        409,
        { reserva_empresa_id: dona, operacao_empresa_id: callerEmpresa }
      );
    }
    if (venda && empresaIdVenda != null && empresaIdVenda !== dona) {
      throw erroConsumoReserva(
        'OPERACAO_EMPRESA_DIVERGENTE',
        'empresa_id da venda diverge da empresa persistida da reserva.',
        409,
        {
          venda_empresa_id: empresaIdVenda,
          reserva_empresa_id: dona
        }
      );
    }
    if (venda && empresaIdVenda == null) {
      throw erroConsumoReserva(
        'EMPRESA_OWNERSHIP_REQUIRED',
        'Empresa é obrigatória na venda para consumir reserva PDV.'
      );
    }
  }

  for (const row of rows) {
    const dona = resolverEmpresaId(row.empresa_id);
    const optsBaixa = montarOpcoesBaixaFisicaDaReserva(dona, dbConn, opcoes);
    const optsPorta = {
      db: dbConn,
      empresaId: dona,
      legado: false,
      motivoCompat: null,
      modoLegadoSemEmpresa: false,
      usuarioId: optsBaixa.usuarioId
    };
    const qF = Number(row.quantidade_fiscal || 0);
    const qNf = Number(row.quantidade_nao_fiscal || 0);

    if (qF > 0 || qNf > 0) {
      const vendaItemId = await resolverVendaItemId(
        vid,
        row.produto_id,
        row.venda_item_id,
        dbConn
      );
      await reduzirEstoqueDistribuidoAsync(
        vendaItemId,
        row.produto_id,
        qF,
        qNf,
        optsBaixa
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
  consumirReservasDaVenda,
  montarOpcoesBaixaFisicaDaReserva
};
