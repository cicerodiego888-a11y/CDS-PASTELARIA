/**
 * Conciliação bancária manual. Não altera o financeiro. Sem matching automático.
 * @module motores/bancario/services/ConciliacaoBancariaService
 */
'use strict';

const {
  ERROS,
  DIRECAO,
  STATUS_CONCILIACAO,
  ORIGEM_FINANCEIRA,
  erroMbc
} = require('../contracts/constantes');
const { exigirEmpresaId } = require('../contracts/TransacaoBancariaNormalizada');
const { dbRun, dbGet, dbAll } = require('./dbPromessas');
const TransacaoBancariaService = require('./TransacaoBancariaService');
const ContaBancariaService = require('./ContaBancariaService');

const MSG_JA = 'Esta transação bancária já está conciliada.';
const MSG_VALORES = 'Os valores não são compatíveis para conciliação.';
const MSG_COMPAT = 'Não foi possível validar a compatibilidade financeira da transação.';

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function valorPositivo(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw erroMbc(ERROS.VALOR_INVALIDO, 'O valor conciliado deve ser positivo.', 400);
  }
  return round2(n);
}

function parseOrigem(v) {
  const t = String(v || '').trim().toUpperCase();
  if (!Object.values(ORIGEM_FINANCEIRA).includes(t)) {
    throw erroMbc(ERROS.ORIGEM_INVALIDA, 'Origem financeira inválida.', 400);
  }
  return t;
}

function parseStatus(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!Object.values(STATUS_CONCILIACAO).includes(s)) {
    throw erroMbc(ERROS.DTO_INVALIDO, 'Status de conciliação inválido.', 400);
  }
  return s;
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    empresa_id: row.empresa_id,
    transacao_bancaria_id: row.transacao_bancaria_id,
    origem_financeira: row.origem_financeira,
    registro_financeiro_id: row.registro_financeiro_id,
    status: row.status,
    valor_conciliado: row.valor_conciliado == null ? null : Number(row.valor_conciliado),
    observacao: row.observacao,
    ativo: Number(row.ativo) === 1,
    conciliado_em: row.conciliado_em,
    desconciliado_em: row.desconciliado_em,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

const txQueue = new WeakMap();

async function runTx(db, fn) {
  await dbRun(db, 'BEGIN IMMEDIATE');
  try {
    const out = await fn();
    await dbRun(db, 'COMMIT');
    return out;
  } catch (err) {
    try { await dbRun(db, 'ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  }
}

function withTx(db, fn) {
  const prev = txQueue.get(db) || Promise.resolve();
  const next = prev.then(() => runTx(db, fn), () => runTx(db, fn));
  txQueue.set(db, next.catch(() => {}));
  return next;
}

async function obterAtivaPorTransacao(db, transacaoId) {
  return dbGet(
    db,
    `SELECT * FROM conciliacao_bancaria WHERE transacao_bancaria_id = ? AND ativo = 1`,
    [transacaoId]
  );
}

async function somaConciliadaAtiva(db, empresaId, origem, registroId) {
  const row = await dbGet(
    db,
    `SELECT COALESCE(SUM(valor_conciliado), 0) AS total
     FROM conciliacao_bancaria
     WHERE empresa_id = ? AND origem_financeira = ? AND registro_financeiro_id = ?
       AND ativo = 1 AND status = ?`,
    [empresaId, origem, registroId, STATUS_CONCILIACAO.CONCILIADA]
  );
  return Number(row && row.total) || 0;
}

async function resolverRegistro(db, empresaId, origem, registroId, direcao) {
  const id = Number(registroId);
  if (!Number.isInteger(id) || id <= 0) {
    throw erroMbc(ERROS.REGISTRO_FINANCEIRO_NAO_ENCONTRADO, 'Registro financeiro não encontrado.', 404);
  }

  if (origem === ORIGEM_FINANCEIRA.FINANCEIRO) {
    const row = await dbGet(db, `SELECT * FROM financeiro WHERE id = ?`, [id]);
    if (!row) {
      throw erroMbc(ERROS.REGISTRO_FINANCEIRO_NAO_ENCONTRADO, 'Registro financeiro não encontrado.', 404);
    }
    if (Number(row.empresa_id) !== Number(empresaId)) {
      throw erroMbc(ERROS.REGISTRO_FINANCEIRO_NAO_ENCONTRADO, 'Registro financeiro não encontrado.', 404);
    }
    const tipo = String(row.tipo || '').toLowerCase();
    if (direcao === DIRECAO.ENTRADA && tipo !== 'receita') {
      throw erroMbc(ERROS.COMPATIBILIDADE_FINANCEIRA, MSG_COMPAT, 400);
    }
    if (direcao === DIRECAO.SAIDA && tipo !== 'despesa') {
      throw erroMbc(ERROS.COMPATIBILIDADE_FINANCEIRA, MSG_COMPAT, 400);
    }
    return {
      origem,
      id: row.id,
      empresa_id: row.empresa_id,
      valor_elegivel: round2(row.valor),
      permite_parcial: false,
      tipo,
      descricao: row.descricao,
      data: row.data_movimento,
      snapshot: {
        valor: Number(row.valor),
        tipo: row.tipo,
        status: row.status != null ? row.status : null,
        descricao: row.descricao
      }
    };
  }

  if (origem === ORIGEM_FINANCEIRA.CONTAS_RECEBER) {
    const row = await dbGet(db, `SELECT * FROM contas_receber WHERE id = ?`, [id]);
    if (!row || Number(row.empresa_id) !== Number(empresaId)) {
      throw erroMbc(ERROS.REGISTRO_FINANCEIRO_NAO_ENCONTRADO, 'Registro financeiro não encontrado.', 404);
    }
    if (direcao !== DIRECAO.ENTRADA) {
      throw erroMbc(ERROS.COMPATIBILIDADE_FINANCEIRA, MSG_COMPAT, 400);
    }
    const ja = await somaConciliadaAtiva(db, empresaId, origem, id);
    const disponivel = round2(Number(row.valor_restante) - ja);
    return {
      origem,
      id: row.id,
      empresa_id: row.empresa_id,
      valor_elegivel: disponivel > 0 ? disponivel : 0,
      permite_parcial: true,
      tipo: 'contas_receber',
      descricao: 'Parcela ' + (row.numero_parcela || '') + '/' + (row.total_parcelas || ''),
      data: row.data_vencimento,
      snapshot: {
        valor_parcela: Number(row.valor_parcela),
        valor_restante: Number(row.valor_restante),
        status: row.status
      }
    };
  }

  if (origem === ORIGEM_FINANCEIRA.CONTAS_RECEBER_PAGAMENTO) {
    const row = await dbGet(
      db,
      `SELECT p.*, c.empresa_id AS conta_empresa_id
       FROM contas_receber_pagamentos p
       INNER JOIN contas_receber c ON c.id = p.conta_receber_id
       WHERE p.id = ?`,
      [id]
    );
    if (!row || Number(row.conta_empresa_id) !== Number(empresaId)) {
      throw erroMbc(ERROS.REGISTRO_FINANCEIRO_NAO_ENCONTRADO, 'Registro financeiro não encontrado.', 404);
    }
    if (direcao !== DIRECAO.ENTRADA) {
      throw erroMbc(ERROS.COMPATIBILIDADE_FINANCEIRA, MSG_COMPAT, 400);
    }
    return {
      origem,
      id: row.id,
      empresa_id: row.conta_empresa_id,
      valor_elegivel: round2(row.valor_pago),
      permite_parcial: false,
      tipo: 'contas_receber_pagamento',
      descricao: row.observacao || 'Pagamento de contas a receber',
      data: row.data_pagamento,
      snapshot: { valor_pago: Number(row.valor_pago) }
    };
  }

  throw erroMbc(ERROS.ORIGEM_INVALIDA, 'Origem financeira inválida.', 400);
}

function validarValor(valorConciliado, txValor, registro) {
  const v = valorPositivo(valorConciliado);
  const tx = round2(txValor);
  const elegivel = round2(registro.valor_elegivel);
  if (registro.permite_parcial) {
    if (v > tx || v > elegivel) {
      throw erroMbc(ERROS.VALORES_INCOMPATIVEIS, MSG_VALORES, 409);
    }
    return v;
  }
  if (v !== tx || v !== elegivel) {
    throw erroMbc(ERROS.VALORES_INCOMPATIVEIS, MSG_VALORES, 409);
  }
  return v;
}

async function conciliar(params = {}) {
  const db = params.db;
  const empresaId = exigirEmpresaId(params.empresaId);
  return withTx(db, async () => {
    const tx = await TransacaoBancariaService.obterNoContexto({
      db,
      empresaId,
      id: params.transacao_bancaria_id
    });
    if (tx.empresa_id !== empresaId) {
      throw erroMbc(ERROS.TRANSACAO_NAO_ENCONTRADA, 'Transação bancária não encontrada.', 404);
    }
    if (tx.direcao === DIRECAO.TRANSFERENCIA) {
      throw erroMbc(ERROS.COMPATIBILIDADE_FINANCEIRA, MSG_COMPAT, 400);
    }
    const ativa = await obterAtivaPorTransacao(db, tx.id);
    if (ativa) {
      throw erroMbc(ERROS.JA_CONCILIADA, MSG_JA, 409);
    }
    const origem = parseOrigem(params.origem_financeira);
    const registro = await resolverRegistro(
      db,
      empresaId,
      origem,
      params.registro_financeiro_id,
      tx.direcao
    );
    if (Number(registro.empresa_id) !== Number(empresaId)) {
      throw erroMbc(ERROS.REGISTRO_FINANCEIRO_NAO_ENCONTRADO, 'Registro financeiro não encontrado.', 404);
    }
    const valor = validarValor(params.valor_conciliado, tx.valor, registro);
    try {
      const r = await dbRun(
        db,
        `INSERT INTO conciliacao_bancaria (
          empresa_id, transacao_bancaria_id, origem_financeira, registro_financeiro_id,
          status, valor_conciliado, observacao, ativo, conciliado_em, desconciliado_em,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now','localtime'), NULL,
                  datetime('now','localtime'), datetime('now','localtime'))`,
        [
          empresaId,
          tx.id,
          origem,
          registro.id,
          STATUS_CONCILIACAO.CONCILIADA,
          valor,
          params.observacao != null ? String(params.observacao).trim() || null : null
        ]
      );
      const row = await dbGet(db, `SELECT * FROM conciliacao_bancaria WHERE id = ?`, [r.lastID]);
      return mapRow(row);
    } catch (err) {
      if (/UNIQUE/i.test(String(err.message || ''))) {
        throw erroMbc(ERROS.JA_CONCILIADA, MSG_JA, 409);
      }
      throw err;
    }
  });
}

async function marcarStatusSimples(params, statusAlvo) {
  const db = params.db;
  const empresaId = exigirEmpresaId(params.empresaId);
  const observacao = params.observacao != null ? String(params.observacao).trim() : '';
  if (statusAlvo === STATUS_CONCILIACAO.DIVERGENTE && !observacao) {
    throw erroMbc(ERROS.OBSERVACAO_OBRIGATORIA, 'Observação é obrigatória para marcar como divergente.', 400);
  }
  return withTx(db, async () => {
    const tx = await TransacaoBancariaService.obterNoContexto({
      db,
      empresaId,
      id: params.transacao_bancaria_id || params.id
    });
    const ativa = await obterAtivaPorTransacao(db, tx.id);
    if (ativa && ativa.status === STATUS_CONCILIACAO.CONCILIADA) {
      throw erroMbc(ERROS.JA_CONCILIADA, MSG_JA, 409);
    }
    if (ativa) {
      await dbRun(
        db,
        `UPDATE conciliacao_bancaria
         SET status = ?, observacao = ?, updated_at = datetime('now','localtime')
         WHERE id = ? AND empresa_id = ? AND ativo = 1`,
        [statusAlvo, observacao || ativa.observacao, ativa.id, empresaId]
      );
      const row = await dbGet(db, `SELECT * FROM conciliacao_bancaria WHERE id = ?`, [ativa.id]);
      return mapRow(row);
    }
    const r = await dbRun(
      db,
      `INSERT INTO conciliacao_bancaria (
        empresa_id, transacao_bancaria_id, origem_financeira, registro_financeiro_id,
        status, valor_conciliado, observacao, ativo, conciliado_em, desconciliado_em,
        created_at, updated_at
      ) VALUES (?, ?, NULL, NULL, ?, NULL, ?, 1, NULL, NULL,
                datetime('now','localtime'), datetime('now','localtime'))`,
      [empresaId, tx.id, statusAlvo, observacao || null]
    );
    const row = await dbGet(db, `SELECT * FROM conciliacao_bancaria WHERE id = ?`, [r.lastID]);
    return mapRow(row);
  });
}

async function desconciliar(params = {}) {
  const db = params.db;
  const empresaId = exigirEmpresaId(params.empresaId);
  return withTx(db, async () => {
    const id = Number(params.id);
    const row = await dbGet(
      db,
      `SELECT * FROM conciliacao_bancaria WHERE id = ? AND empresa_id = ?`,
      [id, empresaId]
    );
    if (!row) {
      throw erroMbc(ERROS.CONCILIACAO_NAO_ENCONTRADA, 'Conciliação não encontrada.', 404);
    }
    if (Number(row.ativo) !== 1) {
      throw erroMbc(ERROS.CONCILIACAO_INATIVA, 'Conciliação já está desfeita.', 409);
    }
    await dbRun(
      db,
      `UPDATE conciliacao_bancaria
       SET ativo = 0, desconciliado_em = datetime('now','localtime'),
           updated_at = datetime('now','localtime')
       WHERE id = ? AND empresa_id = ?`,
      [id, empresaId]
    );
    const atual = await dbGet(db, `SELECT * FROM conciliacao_bancaria WHERE id = ?`, [id]);
    return mapRow(atual);
  });
}

async function obterNoContexto(params = {}) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const id = Number(params.id);
  const row = await dbGet(
    params.db,
    `SELECT * FROM conciliacao_bancaria WHERE id = ? AND empresa_id = ?`,
    [id, empresaId]
  );
  if (!row) {
    throw erroMbc(ERROS.CONCILIACAO_NAO_ENCONTRADA, 'Conciliação não encontrada.', 404);
  }
  return mapRow(row);
}

async function listar(params = {}) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const { inicio, fim } = TransacaoBancariaService.validarPeriodo(params.data_inicio, params.data_fim);
  const statusFiltro = params.status ? parseStatus(params.status) : null;

  if (statusFiltro === STATUS_CONCILIACAO.PENDENTE) {
    return listarPendentes(params);
  }

  const where = ['c.empresa_id = ?'];
  const bind = [empresaId];
  if (params.transacao_bancaria_id) {
    where.push('c.transacao_bancaria_id = ?');
    bind.push(Number(params.transacao_bancaria_id));
  }
  if (params.conta_bancaria_id) {
    const conta = await ContaBancariaService.obterNoContexto({
      db: params.db,
      empresaId,
      id: params.conta_bancaria_id
    });
    where.push('t.conta_bancaria_id = ?');
    bind.push(conta.id);
  }
  if (statusFiltro) {
    where.push('c.status = ?');
    bind.push(statusFiltro);
  }
  if (params.origem_financeira) {
    where.push('c.origem_financeira = ?');
    bind.push(parseOrigem(params.origem_financeira));
  }
  if (inicio) {
    where.push('date(COALESCE(c.conciliado_em, c.created_at)) >= date(?)');
    bind.push(inicio);
  }
  if (fim) {
    where.push('date(COALESCE(c.conciliado_em, c.created_at)) <= date(?)');
    bind.push(fim);
  }
  const rows = await dbAll(
    params.db,
    `SELECT c.* FROM conciliacao_bancaria c
     INNER JOIN transacao_bancaria t ON t.id = c.transacao_bancaria_id
     WHERE ${where.join(' AND ')}
     ORDER BY c.id DESC`,
    bind
  );
  return rows.map(mapRow);
}

async function listarPendentes(params = {}) {
  const empresaId = exigirEmpresaId(params.empresaId);
  const { inicio, fim } = TransacaoBancariaService.validarPeriodo(params.data_inicio, params.data_fim);
  const where = ['t.empresa_id = ?'];
  const bind = [empresaId];
  if (params.conta_bancaria_id) {
    const conta = await ContaBancariaService.obterNoContexto({
      db: params.db,
      empresaId,
      id: params.conta_bancaria_id
    });
    where.push('t.conta_bancaria_id = ?');
    bind.push(conta.id);
  }
  if (inicio) {
    where.push('date(t.data_transacao) >= date(?)');
    bind.push(inicio);
  }
  if (fim) {
    where.push('date(t.data_transacao) <= date(?)');
    bind.push(fim);
  }
  const rows = await dbAll(
    params.db,
    `SELECT t.* FROM transacao_bancaria t
     WHERE ${where.join(' AND ')}
       AND NOT EXISTS (
         SELECT 1 FROM conciliacao_bancaria c
         WHERE c.transacao_bancaria_id = t.id AND c.ativo = 1
       )
     ORDER BY t.data_transacao DESC, t.id DESC`,
    bind
  );
  return rows.map((t) => ({
    status: STATUS_CONCILIACAO.PENDENTE,
    ativo: false,
    transacao_bancaria_id: t.id,
    empresa_id: t.empresa_id,
    transacao: {
      id: t.id,
      conta_bancaria_id: t.conta_bancaria_id,
      data_transacao: t.data_transacao,
      valor: Number(t.valor),
      direcao: t.direcao,
      descricao: t.descricao,
      tipo: t.tipo
    }
  }));
}

async function obterStatusDaTransacao(db, transacaoId) {
  const ativa = await obterAtivaPorTransacao(db, transacaoId);
  if (!ativa) return { status: STATUS_CONCILIACAO.PENDENTE, conciliacao: null };
  return { status: ativa.status, conciliacao: mapRow(ativa) };
}

async function listarRegistrosElegiveis(params = {}) {
  const db = params.db;
  const empresaId = exigirEmpresaId(params.empresaId);
  const direcao = String(params.direcao || '').toLowerCase();
  if (direcao === DIRECAO.TRANSFERENCIA || !direcao) {
    return [];
  }
  const limite = 100;
  const out = [];
  if (direcao === DIRECAO.ENTRADA) {
    const recs = await dbAll(
      db,
      `SELECT id, descricao, valor, data_movimento, tipo
       FROM financeiro WHERE empresa_id = ? AND tipo = 'receita'
       ORDER BY data_movimento DESC, id DESC LIMIT ?`,
      [empresaId, limite]
    );
    recs.forEach((r) => {
      out.push({
        origem_financeira: ORIGEM_FINANCEIRA.FINANCEIRO,
        registro_financeiro_id: r.id,
        data: r.data_movimento,
        descricao: r.descricao,
        valor: Number(r.valor),
        tipo: r.tipo
      });
    });
    const crs = await dbAll(
      db,
      `SELECT id, valor_parcela, valor_restante, data_vencimento, numero_parcela, total_parcelas, status
       FROM contas_receber WHERE empresa_id = ? AND valor_restante > 0
       ORDER BY data_vencimento DESC, id DESC LIMIT ?`,
      [empresaId, limite]
    );
    crs.forEach((r) => {
      out.push({
        origem_financeira: ORIGEM_FINANCEIRA.CONTAS_RECEBER,
        registro_financeiro_id: r.id,
        data: r.data_vencimento,
        descricao: 'Contas a receber ' + (r.numero_parcela || '') + '/' + (r.total_parcelas || ''),
        valor: Number(r.valor_restante),
        tipo: 'contas_receber'
      });
    });
    const pags = await dbAll(
      db,
      `SELECT p.id, p.valor_pago, p.data_pagamento, p.observacao
       FROM contas_receber_pagamentos p
       INNER JOIN contas_receber c ON c.id = p.conta_receber_id
       WHERE c.empresa_id = ?
       ORDER BY p.data_pagamento DESC, p.id DESC LIMIT ?`,
      [empresaId, limite]
    );
    pags.forEach((r) => {
      out.push({
        origem_financeira: ORIGEM_FINANCEIRA.CONTAS_RECEBER_PAGAMENTO,
        registro_financeiro_id: r.id,
        data: r.data_pagamento,
        descricao: r.observacao || 'Pagamento de contas a receber',
        valor: Number(r.valor_pago),
        tipo: 'contas_receber_pagamento'
      });
    });
  } else if (direcao === DIRECAO.SAIDA) {
    const desp = await dbAll(
      db,
      `SELECT id, descricao, valor, data_movimento, tipo
       FROM financeiro WHERE empresa_id = ? AND tipo = 'despesa'
       ORDER BY data_movimento DESC, id DESC LIMIT ?`,
      [empresaId, limite]
    );
    desp.forEach((r) => {
      out.push({
        origem_financeira: ORIGEM_FINANCEIRA.FINANCEIRO,
        registro_financeiro_id: r.id,
        data: r.data_movimento,
        descricao: r.descricao,
        valor: Number(r.valor),
        tipo: r.tipo
      });
    });
  }
  return out;
}

module.exports = {
  conciliar,
  desconciliar,
  marcarIgnorada: (p) => marcarStatusSimples(p, STATUS_CONCILIACAO.IGNORADA),
  marcarDivergente: (p) => marcarStatusSimples(p, STATUS_CONCILIACAO.DIVERGENTE),
  obterNoContexto,
  listar,
  listarPendentes,
  listarRegistrosElegiveis,
  obterStatusDaTransacao,
  ORIGEM_FINANCEIRA,
  MSG_JA,
  MSG_VALORES,
  MSG_COMPAT
};
