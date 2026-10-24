/**
 * Reservas do saldo fiscal compartilhado por Pedido (Sprint 2D).
 *
 * Serviço INTERNO, sem rotas e sem integração com Pedido/venda/faturamento. Uma reserva apenas compromete
 * disponibilidade fiscal em ml (`saldo_reservado_ml`); não altera `saldo_atual_ml`, estoque físico,
 * itens ou valores do Pedido.
 *
 * Transações: reutiliza `executarEmTransacao` da Sprint 2B/2C (BEGIN IMMEDIATE, fila por conexão,
 * TRANSACAO_EXTERNA_ATIVA, SALDO_OCUPADO). O schema NUNCA é criado aqui: se ausente, SCHEMA_RESERVA_AUSENTE.
 *
 * Autorização: este serviço não verifica permissões. A camada de aplicação deve autenticar, autorizar,
 * derivar `usuarioId` do token e garantir que `empresaId` é o do usuário. O serviço valida que o Pedido existe,
 * tem `empresa_id` igual ao informado e (para reservar/ajustar) está em status elegível.
 *
 * Idempotência: chave única por empresa (`UNIQUE(empresa_id, idempotency_key)` nos eventos), compartilhada
 * por reservar/ajustarReserva/liberarReserva; namespace separado do ledger da 2B.
 *
 * @module services/vendas/ReservaSaldoFiscalCategoriaService
 */
'use strict';

const { normalizarCategoriaFiscal } = require('./CategoriaFiscalEmpresaService');
const { OBJETOS_OBRIGATORIOS } = require('./reservaSaldoFiscalCategoriaSchema');
const { PedidoStatus } = require('../pedido/enums');
const {
  internos: {
    erro, dbGet, dbRun, executarEmTransacao, idPositivo, texto,
    resolverOperador, resolverReferencia, exigirQuantidadeMl, exigirEmpresa, lerSaldoRow, mapearSaldo
  }
} = require('./SaldoFiscalCategoriaService');

const TipoEvento = Object.freeze({
  RESERVA: 'RESERVA',
  AJUSTE_RESERVA: 'AJUSTE_RESERVA',
  LIBERACAO_RESERVA: 'LIBERACAO_RESERVA'
});
const StatusReserva = Object.freeze({ ATIVA: 'ATIVA', LIBERADA: 'LIBERADA' });
const STATUS_PEDIDO_RESERVAVEL = Object.freeze([
  PedidoStatus.PEDIDO, PedidoStatus.ABERTO, PedidoStatus.EM_SEPARACAO, PedidoStatus.AGUARDANDO_FATURAMENTO
]);

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function mapearReserva(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    empresaId: Number(row.empresa_id),
    categoriaFiscal: row.categoria_fiscal,
    pedidoId: Number(row.pedido_id),
    quantidadeReservadaMl: Number(row.quantidade_reservada_ml),
    status: row.status,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    liberadaEm: row.liberada_em || null,
    motivoLiberacao: row.motivo_liberacao || null
  };
}

function mapearEvento(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    reservaId: Number(row.reserva_id),
    empresaId: Number(row.empresa_id),
    categoriaFiscal: row.categoria_fiscal,
    pedidoId: Number(row.pedido_id),
    tipo: row.tipo,
    quantidadeAnteriorMl: Number(row.quantidade_anterior_ml),
    quantidadePosteriorMl: Number(row.quantidade_posterior_ml),
    deltaMl: Number(row.delta_ml),
    saldoAtualMl: Number(row.saldo_atual_ml),
    reservadoAnteriorMl: Number(row.reservado_anterior_ml),
    reservadoPosteriorMl: Number(row.reservado_posterior_ml),
    origem: row.origem,
    usuarioId: row.usuario_id == null ? null : Number(row.usuario_id),
    origemSistemica: row.origem_sistemica || null,
    referencia: { tipo: row.referencia_tipo, id: row.referencia_id },
    idempotencyKey: row.idempotency_key,
    motivo: row.motivo,
    createdAt: row.created_at || null
  };
}

/** Verificação somente leitura: o serviço nunca executa DDL. */
async function exigirSchema(db) {
  const rows = await dbAll(
    db,
    `SELECT name FROM sqlite_master WHERE name IN (${OBJETOS_OBRIGATORIOS.map(() => '?').join(',')})`,
    OBJETOS_OBRIGATORIOS
  );
  const presentes = new Set(rows.map((r) => r.name));
  const faltando = OBJETOS_OBRIGATORIOS.filter((n) => !presentes.has(n));
  if (faltando.length) {
    throw erro(
      'SCHEMA_RESERVA_AUSENTE',
      'Schema de reservas do saldo fiscal não preparado. Execute garantirSchemaReservaSaldoFiscalCategoriaAsync fora de transação.',
      { statusCode: 500, objetos_ausentes: faltando }
    );
  }
}

async function prepararBase(params, opts) {
  const db = (opts && opts.db) || require('../../database');
  await exigirSchema(db);
  const empresaId = await exigirEmpresa(db, params.empresaId);
  const categoria = normalizarCategoriaFiscal(params.categoriaFiscal);
  const pedidoId = idPositivo(params.pedidoId, 'PEDIDO_OBRIGATORIO', 'pedidoId é obrigatório e deve ser um inteiro positivo.');
  return { db, empresaId, categoria, pedidoId };
}

function dadosComuns(params) {
  return {
    operador: resolverOperador(params),
    motivo: texto(params.motivo, 'MOTIVO_OBRIGATORIO', 'motivo é obrigatório.'),
    referencia: resolverReferencia(params.referencia),
    idempotencyKey: texto(params.idempotencyKey, 'IDEMPOTENCY_KEY_OBRIGATORIA', 'idempotencyKey é obrigatória.')
  };
}

async function validarPedido(db, empresaId, pedidoId, { exigirStatus }) {
  const tabela = await dbGet(db, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pedidos'`);
  const cols = tabela ? await dbAll(db, 'PRAGMA table_info(pedidos)') : [];
  if (!tabela || !cols.some((c) => c.name === 'empresa_id') || !cols.some((c) => c.name === 'status')) {
    throw erro('PEDIDO_CONTEXTO_INDISPONIVEL', 'Não é possível validar empresa/status do Pedido neste banco.', { statusCode: 500 });
  }
  const pedido = await dbGet(db, 'SELECT id, empresa_id, status FROM pedidos WHERE id = ?', [pedidoId]);
  if (!pedido) throw erro('PEDIDO_NAO_ENCONTRADO', `Pedido não encontrado: ${pedidoId}.`, { statusCode: 404 });
  if (pedido.empresa_id == null) {
    throw erro('PEDIDO_SEM_EMPRESA', 'O Pedido não possui empresa associada; reserva não permitida.', { statusCode: 409 });
  }
  if (Number(pedido.empresa_id) !== empresaId) {
    throw erro('PEDIDO_EMPRESA_DIVERGENTE', 'O Pedido pertence a outra empresa.', { statusCode: 409 });
  }
  if (exigirStatus && !STATUS_PEDIDO_RESERVAVEL.includes(String(pedido.status || '').toUpperCase())) {
    throw erro('PEDIDO_STATUS_INVALIDO', `Pedido em status ${pedido.status} não aceita reserva.`, { statusCode: 409 });
  }
  return pedido;
}

function conferirIdempotencia(ev, esperado) {
  const iguais =
    ev.tipo === esperado.tipo
    && ev.categoria_fiscal === esperado.categoria
    && Number(ev.pedido_id) === esperado.pedidoId
    && Number(ev.quantidade_posterior_ml) === esperado.quantidadePosterior
    && ev.referencia_tipo === esperado.referencia.tipo
    && ev.referencia_id === esperado.referencia.id
    && ev.motivo === esperado.motivo
    && (ev.usuario_id == null ? null : Number(ev.usuario_id)) === esperado.operador.usuarioId
    && (ev.origem_sistemica || null) === esperado.operador.origemSistemica;
  if (!iguais) {
    throw erro('IDEMPOTENCY_CONFLITO', 'idempotencyKey já utilizada com dados diferentes.', {
      statusCode: 409, evento_id: Number(ev.id)
    });
  }
}

async function lerReservaAtiva(db, empresaId, categoria, pedidoId) {
  return dbGet(
    db,
    `SELECT * FROM saldo_fiscal_categoria_reservas
      WHERE empresa_id = ? AND categoria_fiscal = ? AND pedido_id = ? AND status = 'ATIVA'`,
    [empresaId, categoria, pedidoId]
  );
}

async function exigirConsistenciaSaldo(db, saldo, empresaId, categoria) {
  const soma = await dbGet(
    db,
    `SELECT COALESCE(SUM(quantidade_reservada_ml), 0) AS total FROM saldo_fiscal_categoria_reservas
      WHERE empresa_id = ? AND categoria_fiscal = ? AND status = 'ATIVA'`,
    [empresaId, categoria]
  );
  if (Number(soma.total) !== Number(saldo.saldo_reservado_ml)) {
    throw erro(
      'RESERVA_INCONSISTENTE',
      'saldo_reservado_ml não corresponde à soma das reservas ativas; operação bloqueada.',
      { statusCode: 500, saldo_reservado_ml: Number(saldo.saldo_reservado_ml), soma_reservas_ml: Number(soma.total) }
    );
  }
}

async function aplicar(ctx) {
  const { db, empresaId, categoria, pedidoId, tipo, operador, motivo, referencia, idempotencyKey } = ctx;
  const novaQuantidade = ctx.quantidadeMl;

  return executarEmTransacao(db, async () => {
    const existente = await dbGet(
      db,
      'SELECT * FROM saldo_fiscal_categoria_reserva_eventos WHERE empresa_id = ? AND idempotency_key = ?',
      [empresaId, idempotencyKey]
    );
    if (existente) {
      conferirIdempotencia(existente, {
        tipo, categoria, pedidoId,
        quantidadePosterior: tipo === TipoEvento.LIBERACAO_RESERVA ? 0 : novaQuantidade,
        referencia, motivo, operador
      });
      return {
        idempotente: true,
        reserva: mapearReserva(await dbGet(db, 'SELECT * FROM saldo_fiscal_categoria_reservas WHERE id = ?', [existente.reserva_id])),
        evento: mapearEvento(existente),
        saldo: mapearSaldo(await lerSaldoRow(db, empresaId, categoria))
      };
    }

    await validarPedido(db, empresaId, pedidoId, { exigirStatus: tipo !== TipoEvento.LIBERACAO_RESERVA });

    const saldo = await lerSaldoRow(db, empresaId, categoria);
    if (!saldo) {
      throw erro('SALDO_NAO_ENCONTRADO', 'Saldo não inicializado para esta empresa e categoria.', { statusCode: 404 });
    }
    if (Number(saldo.ativo) !== 1) throw erro('SALDO_INATIVO', 'Saldo inativo: reservas não são permitidas.');
    await exigirConsistenciaSaldo(db, saldo, empresaId, categoria);

    const atual = Number(saldo.saldo_atual_ml);
    const reservadoAntes = Number(saldo.saldo_reservado_ml);
    const ativa = await lerReservaAtiva(db, empresaId, categoria, pedidoId);

    let quantidadeAnterior = 0;
    let quantidadePosterior;
    let reservaId;

    if (tipo === TipoEvento.RESERVA) {
      if (ativa) {
        throw erro('RESERVA_ATIVA_EXISTENTE', 'Já existe reserva ativa para este Pedido e categoria; use ajustarReserva.', {
          statusCode: 409, reserva_id: Number(ativa.id)
        });
      }
      quantidadePosterior = novaQuantidade;
    } else {
      if (!ativa) {
        const liberada = await dbGet(
          db,
          `SELECT id FROM saldo_fiscal_categoria_reservas
            WHERE empresa_id = ? AND categoria_fiscal = ? AND pedido_id = ? AND status = 'LIBERADA' LIMIT 1`,
          [empresaId, categoria, pedidoId]
        );
        if (liberada) throw erro('RESERVA_JA_LIBERADA', 'A reserva deste Pedido já foi liberada.', { statusCode: 409 });
        throw erro('RESERVA_NAO_ENCONTRADA', 'Não há reserva para este Pedido, empresa e categoria.', { statusCode: 404 });
      }
      reservaId = Number(ativa.id);
      quantidadeAnterior = Number(ativa.quantidade_reservada_ml);
      if (tipo === TipoEvento.AJUSTE_RESERVA) {
        if (novaQuantidade === quantidadeAnterior) {
          throw erro('RESERVA_SEM_ALTERACAO', 'A nova quantidade é igual à reservada.', { statusCode: 409 });
        }
        quantidadePosterior = novaQuantidade;
      } else {
        quantidadePosterior = 0;
      }
    }

    const delta = quantidadePosterior - quantidadeAnterior;
    const reservadoDepois = reservadoAntes + delta;
    if (reservadoDepois < 0) {
      throw erro('RESERVA_INCONSISTENTE', 'Reserva excede o saldo reservado registrado.', { statusCode: 500 });
    }
    if (delta > 0 && reservadoDepois > atual) {
      throw erro('SALDO_INSUFICIENTE', 'Saldo disponível insuficiente para a reserva.', {
        statusCode: 409, saldo_disponivel_ml: atual - reservadoAntes, quantidade_ml: delta
      });
    }

    const updSaldo = await dbRun(
      db,
      `UPDATE saldo_fiscal_categoria_empresa
          SET saldo_reservado_ml = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND saldo_atual_ml = ? AND saldo_reservado_ml = ? AND ativo = 1`,
      [reservadoDepois, saldo.id, atual, reservadoAntes]
    );
    if (updSaldo.changes !== 1) {
      throw erro('SALDO_CONFLITO_CONCORRENCIA', 'O saldo foi alterado por outra operação. Tente novamente.', { statusCode: 409 });
    }

    if (tipo === TipoEvento.RESERVA) {
      const ins = await dbRun(
        db,
        `INSERT INTO saldo_fiscal_categoria_reservas
           (empresa_id, categoria_fiscal, pedido_id, quantidade_reservada_ml, status, idempotency_key)
         VALUES (?, ?, ?, ?, 'ATIVA', ?)`,
        [empresaId, categoria, pedidoId, quantidadePosterior, idempotencyKey]
      );
      reservaId = ins.lastID;
    } else if (tipo === TipoEvento.AJUSTE_RESERVA) {
      const upd = await dbRun(
        db,
        `UPDATE saldo_fiscal_categoria_reservas
            SET quantidade_reservada_ml = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'ATIVA' AND quantidade_reservada_ml = ?`,
        [quantidadePosterior, reservaId, quantidadeAnterior]
      );
      if (upd.changes !== 1) throw erro('RESERVA_CONFLITO_CONCORRENCIA', 'A reserva foi alterada por outra operação.', { statusCode: 409 });
    } else {
      const upd = await dbRun(
        db,
        `UPDATE saldo_fiscal_categoria_reservas
            SET quantidade_reservada_ml = 0, status = 'LIBERADA', liberada_em = CURRENT_TIMESTAMP,
                motivo_liberacao = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'ATIVA' AND quantidade_reservada_ml = ?`,
        [motivo, reservaId, quantidadeAnterior]
      );
      if (upd.changes !== 1) throw erro('RESERVA_CONFLITO_CONCORRENCIA', 'A reserva foi alterada por outra operação.', { statusCode: 409 });
    }

    const ev = await dbRun(
      db,
      `INSERT INTO saldo_fiscal_categoria_reserva_eventos
         (reserva_id, empresa_id, categoria_fiscal, pedido_id, tipo, quantidade_anterior_ml, quantidade_posterior_ml,
          delta_ml, saldo_atual_ml, reservado_anterior_ml, reservado_posterior_ml, origem, usuario_id,
          origem_sistemica, referencia_tipo, referencia_id, idempotency_key, motivo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        reservaId, empresaId, categoria, pedidoId, tipo, quantidadeAnterior, quantidadePosterior,
        delta, atual, reservadoAntes, reservadoDepois, operador.origem, operador.usuarioId,
        operador.origemSistemica, referencia.tipo, referencia.id, idempotencyKey, motivo
      ]
    );

    return {
      idempotente: false,
      reserva: mapearReserva(await dbGet(db, 'SELECT * FROM saldo_fiscal_categoria_reservas WHERE id = ?', [reservaId])),
      evento: mapearEvento(await dbGet(db, 'SELECT * FROM saldo_fiscal_categoria_reserva_eventos WHERE id = ?', [ev.lastID])),
      saldo: mapearSaldo(await lerSaldoRow(db, empresaId, categoria))
    };
  });
}

/** Cria a reserva ativa do Pedido. Nunca abre saldo nem soma a uma reserva já ativa. */
async function reservar(params = {}, opts = {}) {
  const base = await prepararBase(params, opts);
  const quantidadeMl = exigirQuantidadeMl(params.quantidadeMl);
  return aplicar({ ...base, tipo: TipoEvento.RESERVA, quantidadeMl, ...dadosComuns(params) });
}

/** Define a nova quantidade total de uma reserva ativa existente. */
async function ajustarReserva(params = {}, opts = {}) {
  const base = await prepararBase(params, opts);
  const quantidadeMl = exigirQuantidadeMl(params.quantidadeMl);
  return aplicar({ ...base, tipo: TipoEvento.AJUSTE_RESERVA, quantidadeMl, ...dadosComuns(params) });
}

/** Libera a reserva ativa (saldo_atual_ml não muda). Operação explícita; sem vínculo com cancelamento. */
async function liberarReserva(params = {}, opts = {}) {
  const base = await prepararBase(params, opts);
  return aplicar({ ...base, tipo: TipoEvento.LIBERACAO_RESERVA, quantidadeMl: null, ...dadosComuns(params) });
}

/** Retorna a reserva ativa do Pedido (ou a mais recente) ou null; sempre filtrada por empresa e categoria. */
async function obterReserva(params = {}, opts = {}) {
  const { db, empresaId, categoria, pedidoId } = await prepararBase(params, opts);
  if (params.reservaId != null) {
    const id = idPositivo(params.reservaId, 'RESERVA_INVALIDA', 'reservaId inválido.');
    return mapearReserva(await dbGet(
      db,
      `SELECT * FROM saldo_fiscal_categoria_reservas
        WHERE id = ? AND empresa_id = ? AND categoria_fiscal = ? AND pedido_id = ?`,
      [id, empresaId, categoria, pedidoId]
    ));
  }
  return mapearReserva(await dbGet(
    db,
    `SELECT * FROM saldo_fiscal_categoria_reservas
      WHERE empresa_id = ? AND categoria_fiscal = ? AND pedido_id = ?
      ORDER BY (status = 'ATIVA') DESC, id DESC LIMIT 1`,
    [empresaId, categoria, pedidoId]
  ));
}

/** Lista paginada; empresa e categoria obrigatórias. */
async function listarReservasAtivas(params = {}, opts = {}) {
  const db = (opts && opts.db) || require('../../database');
  await exigirSchema(db);
  const empresaId = await exigirEmpresa(db, params.empresaId);
  const categoria = normalizarCategoriaFiscal(params.categoriaFiscal);
  const limite = Math.min(Math.max(parseInt(params.limite, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(params.offset, 10) || 0, 0);
  const rows = await dbAll(
    db,
    `SELECT * FROM saldo_fiscal_categoria_reservas
      WHERE empresa_id = ? AND categoria_fiscal = ? AND status = 'ATIVA'
      ORDER BY id LIMIT ? OFFSET ?`,
    [empresaId, categoria, limite, offset]
  );
  return { limite, offset, itens: rows.map(mapearReserva) };
}

/** Eventos de uma reserva (auditoria), filtrados por empresa/categoria/pedido. */
async function listarEventos(params = {}, opts = {}) {
  const { db, empresaId, categoria, pedidoId } = await prepararBase(params, opts);
  const rows = await dbAll(
    db,
    `SELECT * FROM saldo_fiscal_categoria_reserva_eventos
      WHERE empresa_id = ? AND categoria_fiscal = ? AND pedido_id = ? ORDER BY id`,
    [empresaId, categoria, pedidoId]
  );
  return rows.map(mapearEvento);
}

module.exports = {
  TipoEvento,
  StatusReserva,
  reservar,
  ajustarReserva,
  liberarReserva,
  obterReserva,
  listarReservasAtivas,
  listarEventos
};
