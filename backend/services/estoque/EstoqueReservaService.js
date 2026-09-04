/**
 * Reserva de estoque para Vendas para Entrega / PDV (Sprint 2 + 02.7)
 * NÃO baixa saldo_fiscal / saldo_nao_fiscal / estoque_atual.
 * reservado_fiscal / reservado_nao_fiscal: escritos somente via reservasPublico.
 * Tracking permanece em venda_estoque_reservas.
 *
 * Sprint 05.52 — criação: vendas.empresa_id é a fonte de ownership.
 * COMPAT não decide empresa neste fluxo.
 */

'use strict';

const db = require('../../database');
const { produtoControlaEstoque } = require('./produtoControlaEstoque');
const reservasPublico = require('../fiscalNaoFiscal/reservasPublico');
const { TipoSaldo } = require('../fiscalNaoFiscal/constants');
const { resolverEmpresaId } = require('../fiscalNaoFiscal/empresaContexto');

/** @deprecated 05.52 — não é mais fallback do helper operacional PDV. */
const MOTIVO_COMPAT_RESERVA_PDV = 'COMPAT_RESERVA_PDV_PRE_MULTIEMPRESA';

function dbDeOpcoes(opcoes) {
  return (opcoes && opcoes.db) || db;
}

/**
 * Extrai empresaId já anexado em req (middleware). Não é ownership da reserva.
 */
function empresaIdDoReqReservaPdv(req) {
  return resolverEmpresaId(req && req.empresaId);
}

/**
 * Opções da porta F×NF para PDV.
 * Empresa explícita obrigatória. Sem COMPAT, sem descoberta de header/body/usuário.
 */
function montarOptsPortaReservaPdv(fonte = {}, dbConn) {
  const empresaId = resolverEmpresaId(
    fonte.empresaId != null ? fonte.empresaId : fonte.empresa_id
  );

  const base = {
    db: dbConn || dbDeOpcoes(fonte),
    usuarioId: fonte.usuarioId || fonte.operadorId || fonte.user?.id
      || fonte.req?.operadorId || fonte.req?.user?.id || null,
    validarEmpresa: fonte.validarEmpresa
  };

  if (empresaId != null) {
    return { ...base, empresaId, legado: false, motivoCompat: null, modoLegadoSemEmpresa: false };
  }

  const err = new Error(
    'empresaId é obrigatório para reserva PDV. Informe empresa da venda ou do contexto operacional.'
  );
  err.code = 'EMPRESA_CONTEXT_REQUIRED';
  err.status = 400;
  throw err;
}

function run(sql, params = [], dbConn = db) {
  return new Promise((resolve, reject) => {
    dbConn.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

async function garantirSchemaReservasVenda(dbConn) {
  try {
    await run(
      `ALTER TABLE venda_estoque_reservas ADD COLUMN empresa_id INTEGER REFERENCES empresas(id)`,
      [],
      dbConn
    );
  } catch (err) {
    const msg = String(err && err.message || '');
    if (!msg.includes('duplicate column name') && !msg.includes('already exists')) {
      throw err;
    }
  }
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

function erroVendaNaoEncontrada(empresaId) {
  const err = new Error('Venda não encontrada.');
  err.code = 'VENDA_NAO_ENCONTRADA';
  err.status = 404;
  if (empresaId != null) err.empresa_id = empresaId;
  return err;
}

function erroOwnershipVenda() {
  const err = new Error('Empresa é obrigatória para criar reserva da venda.');
  err.code = 'EMPRESA_OWNERSHIP_REQUIRED';
  err.status = 400;
  return err;
}

/**
 * Resolve empresa da venda persistida para criação de reserva PDV.
 * Fonte: vendas.empresa_id. Caller só autoriza.
 */
function resolverEmpresaParaCriacaoReservaPdv(venda, empresaIdCaller) {
  if (!venda) {
    throw erroVendaNaoEncontrada(empresaIdCaller);
  }
  const dona = resolverEmpresaId(venda.empresa_id != null ? venda.empresa_id : venda.empresaId);
  if (dona == null) {
    throw erroOwnershipVenda();
  }
  const caller = resolverEmpresaId(empresaIdCaller);
  if (caller != null && caller !== dona) {
    throw erroVendaNaoEncontrada(caller);
  }
  return dona;
}

/**
 * Incrementa reserva no produto (porta) e registra linha da reserva.
 * Ownership = vendas.empresa_id. Deve ser chamado DENTRO de TX do caller quando possível.
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
  const vid = Number(vendaId);

  if (qF <= 0 && qNf <= 0) {
    return callback(null);
  }

  if (!Number.isInteger(vid) || vid <= 0) {
    return callback(erroVendaNaoEncontrada(empresaId));
  }

  dbConn.get(
    `SELECT id, empresa_id FROM vendas WHERE id = ?`,
    [vid],
    (errVenda, venda) => {
      if (errVenda) {
        const msg = String(errVenda.message || '');
        if (msg.includes('no such table') || msg.includes('no such column')) {
          return callback(erroVendaNaoEncontrada(empresaId));
        }
        return callback(errVenda);
      }

      let empresaDona;
      try {
        empresaDona = resolverEmpresaParaCriacaoReservaPdv(venda, empresaId);
      } catch (e) {
        return callback(e);
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
              empresaId: empresaDona,
              usuarioId,
              exigirEmpresa: exigirEmpresa === true ? true : undefined,
              db: dbConn
            }, dbConn);
          } catch (e) {
            return callback(e);
          }

          aplicarReservadoViaPorta(produtoId, qF, qNf, optsPorta, 'reservar')
            .then(() => garantirSchemaReservasVenda(dbConn))
            .then(() => run(
              `
              INSERT INTO venda_estoque_reservas (
                venda_id, venda_item_id, produto_id,
                quantidade_fiscal, quantidade_nao_fiscal,
                status, criado_em, empresa_id
              ) VALUES (?, ?, ?, ?, ?, 'ATIVA', CURRENT_TIMESTAMP, ?)
            `,
              [vid, vendaItemId || null, produtoId, qF, qNf, empresaDona],
              dbConn
            ))
            .then(() => callback(null))
            .catch(callback);
        }
      );
    }
  );
}

/**
 * Libera reservas ativas de uma venda (cancelamento / entrega).
 * Fonte: venda_estoque_reservas.empresa_id. Sem COMPAT como dono.
 */
async function liberarReservasDaVenda(vendaId, opcoes = {}) {
  const dbConn = dbDeOpcoes(opcoes);
  await garantirSchemaReservasVenda(dbConn);
  const callerEmpresa = resolverEmpresaId(
    opcoes.empresaId != null ? opcoes.empresaId : opcoes.empresa_id
  ) ?? empresaIdDoReqReservaPdv(opcoes.req) ?? empresaIdDoReqReservaPdv(opcoes);

  const rows = await new Promise((resolve, reject) => {
    dbConn.all(
      `SELECT * FROM venda_estoque_reservas WHERE venda_id = ? AND status = 'ATIVA'`,
      [vendaId],
      (err, list) => (err ? reject(err) : resolve(list || []))
    );
  });

  for (const row of rows) {
    const dona = resolverEmpresaId(row.empresa_id);
    if (dona == null) {
      const err = new Error('Reserva sem ownership empresarial identificável.');
      err.code = 'EMPRESA_OWNERSHIP_REQUIRED';
      throw err;
    }
    if (callerEmpresa != null && callerEmpresa !== dona) {
      const err = new Error('empresa_id da reserva diverge da empresa informada na operação.');
      err.code = 'RESERVA_EMPRESA_DIVERGENTE';
      err.status = 409;
      err.reserva_empresa_id = dona;
      throw err;
    }
  }

  let liberadas = 0;
  for (const row of rows) {
    const dona = resolverEmpresaId(row.empresa_id);
    const optsPorta = {
      db: dbConn,
      empresaId: dona,
      legado: false,
      motivoCompat: null,
      modoLegadoSemEmpresa: false,
      usuarioId: opcoes.usuarioId || opcoes.operadorId || null
    };
    const qF = Number(row.quantidade_fiscal || 0);
    const qNf = Number(row.quantidade_nao_fiscal || 0);
    await aplicarReservadoViaPorta(row.produto_id, qF, qNf, optsPorta, 'liberar');
    await run(
      `UPDATE venda_estoque_reservas SET status = 'CANCELADA', atualizado_em = CURRENT_TIMESTAMP WHERE id = ?`,
      [row.id],
      dbConn
    );
    liberadas += 1;
  }

  return { liberadas };
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
  resolverEmpresaParaCriacaoReservaPdv,
  reservarItem,
  liberarReservasDaVenda,
  obterProdutoComReserva,
  run,
  get
};
