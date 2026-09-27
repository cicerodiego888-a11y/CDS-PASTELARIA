/**
 * Conciliação bancária (fundação MBC-05). Provider-agnóstica.
 * 1 transação → N alvos. Sem matching automático neste serviço.
 * @module motores/bancario/services/ConciliacaoBancariaService
 */
'use strict';

const {
  ERROS,
  DIRECAO,
  STATUS_CONCILIACAO,
  STATUS_TRANSACAO_CONCILIACAO,
  ORIGEM_FINANCEIRA,
  ORIGEM_CONCILIACAO,
  erroMbc
} = require('../contracts/constantes');
const { exigirEmpresaId } = require('../contracts/TransacaoBancariaNormalizada');
const { registrarOperacaoMbc } = require('../contracts/observabilidadeMbc');
const { dbRun, dbGet, dbAll } = require('./dbPromessas');
const TransacaoBancariaService = require('./TransacaoBancariaService');
const ContaBancariaService = require('./ContaBancariaService');

const MSG_JA = 'Esta transação bancária já está conciliada.';
const MSG_VALORES = 'Os valores não são compatíveis para conciliação.';
const MSG_COMPAT = 'Não foi possível validar a compatibilidade financeira da transação.';
const MSG_EXCESSO = 'O valor conciliado excede o disponível da transação bancária.';

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

function parseOrigemConciliacao(v) {
  const t = String(v || ORIGEM_CONCILIACAO.MANUAL).trim().toUpperCase();
  if (t !== ORIGEM_CONCILIACAO.MANUAL && t !== ORIGEM_CONCILIACAO.SISTEMA) {
    throw erroMbc(ERROS.DTO_INVALIDO, 'Origem da conciliação inválida.', 400);
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
    origem_conciliacao: row.origem_conciliacao || ORIGEM_CONCILIACAO.MANUAL,
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

async function listarLinksConciliadosAtivos(db, transacaoId) {
  return dbAll(
    db,
    `SELECT * FROM conciliacao_bancaria
     WHERE transacao_bancaria_id = ? AND ativo = 1 AND status = ?
     ORDER BY id ASC`,
    [transacaoId, STATUS_CONCILIACAO.CONCILIADA]
  );
}

async function obterMarcacaoAtiva(db, transacaoId) {
  return dbGet(
    db,
    `SELECT * FROM conciliacao_bancaria
     WHERE transacao_bancaria_id = ? AND ativo = 1
       AND status IN (?, ?)
     ORDER BY id DESC LIMIT 1`,
    [transacaoId, STATUS_CONCILIACAO.IGNORADA, STATUS_CONCILIACAO.DIVERGENTE]
  );
}

async function obterVinculoAtivo(db, empresaId, transacaoId, origem, registroId) {
  return dbGet(
    db,
    `SELECT * FROM conciliacao_bancaria
     WHERE empresa_id = ? AND transacao_bancaria_id = ?
       AND origem_financeira = ? AND registro_financeiro_id = ?
       AND ativo = 1 AND status = ?`,
    [empresaId, transacaoId, origem, registroId, STATUS_CONCILIACAO.CONCILIADA]
  );
}

async function calcularValorConciliado(params = {}) {
  const db = params.db;
  const transacaoId = Number(params.transacao_bancaria_id != null ? params.transacao_bancaria_id : params.id);
  if (!Number.isInteger(transacaoId) || transacaoId <= 0) {
    throw erroMbc(ERROS.TRANSACAO_NAO_ENCONTRADA, 'Transação bancária não encontrada.', 404);
  }
  const row = await dbGet(
    db,
    `SELECT COALESCE(SUM(valor_conciliado), 0) AS total
     FROM conciliacao_bancaria
     WHERE transacao_bancaria_id = ? AND ativo = 1 AND status = ?`,
    [transacaoId, STATUS_CONCILIACAO.CONCILIADA]
  );
  return round2(Number(row && row.total) || 0);
}

function derivarStatusTransacao(valorTotal, valorConciliado, marcacaoStatus) {
  if (marcacaoStatus === STATUS_CONCILIACAO.IGNORADA) {
    return STATUS_TRANSACAO_CONCILIACAO.IGNORADA;
  }
  if (marcacaoStatus === STATUS_CONCILIACAO.DIVERGENTE) {
    return STATUS_TRANSACAO_CONCILIACAO.DIVERGENTE;
  }
  const total = round2(valorTotal);
  const conc = round2(valorConciliado);
  if (conc <= 0) return STATUS_TRANSACAO_CONCILIACAO.NAO_CONCILIADA;
  if (conc < total) return STATUS_TRANSACAO_CONCILIACAO.PARCIALMENTE_CONCILIADA;
  return STATUS_TRANSACAO_CONCILIACAO.CONCILIADA;
}

/** Compatível com filtros legados: pendente = não conciliada + parcial. */
function statusLegadoDaTransacao(statusConciliacao) {
  if (statusConciliacao === STATUS_TRANSACAO_CONCILIACAO.CONCILIADA) {
    return STATUS_CONCILIACAO.CONCILIADA;
  }
  if (statusConciliacao === STATUS_TRANSACAO_CONCILIACAO.IGNORADA) {
    return STATUS_CONCILIACAO.IGNORADA;
  }
  if (statusConciliacao === STATUS_TRANSACAO_CONCILIACAO.DIVERGENTE) {
    return STATUS_CONCILIACAO.DIVERGENTE;
  }
  return STATUS_CONCILIACAO.PENDENTE;
}

async function calcularValorDisponivel(params = {}) {
  const db = params.db;
  const empresaId = params.empresaId != null ? exigirEmpresaId(params.empresaId) : null;
  let tx = params.transacao || null;
  if (!tx) {
    if (empresaId == null) {
      throw erroMbc(ERROS.DTO_INVALIDO, 'empresaId obrigatório para calcular valor disponível.', 400);
    }
    tx = await TransacaoBancariaService.obterNoContexto({
      db,
      empresaId,
      id: params.transacao_bancaria_id != null ? params.transacao_bancaria_id : params.id
    });
  }
  const valorTotal = round2(Number(tx.valor));
  const ja = await calcularValorConciliado({ db, transacao_bancaria_id: tx.id });
  const bruto = round2(valorTotal - ja);
  if (bruto < 0) {
    registrarOperacaoMbc({
      operacao: 'CONCILIACAO_VALOR_INCONSISTENTE',
      empresa_id: tx.empresa_id != null ? tx.empresa_id : empresaId,
      conta_bancaria_id: tx.conta_bancaria_id != null ? tx.conta_bancaria_id : null,
      resultado: 'ALERTA',
      status: 'valor_disponivel_negativo',
      quantidade: 1
    });
    return 0;
  }
  return bruto;
}

async function obterStatusConciliacao(params = {}) {
  const db = params.db;
  const empresaId = exigirEmpresaId(params.empresaId);
  const tx = await TransacaoBancariaService.obterNoContexto({
    db,
    empresaId,
    id: params.transacao_bancaria_id != null ? params.transacao_bancaria_id : params.id
  });
  return obterStatusDaTransacao(db, tx.id);
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
    const statusFin = row.status != null ? String(row.status).toLowerCase() : '';
    if (statusFin === 'cancelado' || statusFin === 'estornado') {
      throw erroMbc(ERROS.COMPATIBILIDADE_FINANCEIRA, MSG_COMPAT, 400);
    }
    const ja = await somaConciliadaAtiva(db, empresaId, origem, id);
    const valorTitulo = round2(row.valor);
    const disponivel = round2(valorTitulo - ja);
    // Despesa (AP de domínio) permite parcial bancário; receita permanece integral.
    const permiteParcial = tipo === 'despesa';
    return {
      origem,
      id: row.id,
      empresa_id: row.empresa_id,
      valor_elegivel: disponivel > 0 ? disponivel : 0,
      permite_parcial: permiteParcial,
      tipo,
      descricao: row.descricao,
      data: row.vencimento || row.data_movimento,
      snapshot: {
        valor: Number(row.valor),
        valor_ja_conciliado: ja,
        tipo: row.tipo,
        status: row.status != null ? row.status : null,
        descricao: row.descricao,
        vencimento: row.vencimento != null ? row.vencimento : null
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
    const ja = await somaConciliadaAtiva(db, empresaId, origem, id);
    const disponivel = round2(Number(row.valor_pago) - ja);
    return {
      origem,
      id: row.id,
      empresa_id: row.conta_empresa_id,
      valor_elegivel: disponivel > 0 ? disponivel : 0,
      permite_parcial: false,
      tipo: 'contas_receber_pagamento',
      descricao: row.observacao || 'Pagamento de contas a receber',
      data: row.data_pagamento,
      snapshot: { valor_pago: Number(row.valor_pago), valor_ja_conciliado: ja }
    };
  }

  throw erroMbc(ERROS.ORIGEM_INVALIDA, 'Origem financeira inválida.', 400);
}

function validarValor(valorConciliado, disponivelTx, registro) {
  const v = valorPositivo(valorConciliado);
  const disponivel = round2(disponivelTx);
  const elegivel = round2(registro.valor_elegivel);
  if (disponivel <= 0) {
    throw erroMbc(ERROS.JA_CONCILIADA, MSG_JA, 409);
  }
  if (v > disponivel) {
    throw erroMbc(ERROS.VALORES_INCOMPATIVEIS, MSG_EXCESSO, 409);
  }
  if (registro.permite_parcial) {
    if (v > elegivel) {
      throw erroMbc(ERROS.VALORES_INCOMPATIVEIS, MSG_VALORES, 409);
    }
    return v;
  }
  if (v !== elegivel) {
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
    const origem = parseOrigem(params.origem_financeira);
    const origemConc = parseOrigemConciliacao(params.origem_conciliacao);
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

    const existente = await obterVinculoAtivo(db, empresaId, tx.id, origem, registro.id);
    if (existente) {
      const valorPedido = valorPositivo(params.valor_conciliado);
      if (round2(existente.valor_conciliado) === valorPedido) {
        return mapRow(existente);
      }
      throw erroMbc(ERROS.JA_CONCILIADA, 'Já existe vínculo ativo desta transação com o mesmo alvo.', 409);
    }

    const disponivel = await calcularValorDisponivel({ db, empresaId, transacao: tx });
    const valor = validarValor(params.valor_conciliado, disponivel, registro);
    try {
      const r = await dbRun(
        db,
        `INSERT INTO conciliacao_bancaria (
          empresa_id, transacao_bancaria_id, origem_financeira, registro_financeiro_id,
          status, valor_conciliado, origem_conciliacao, observacao, ativo, conciliado_em, desconciliado_em,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now','localtime'), NULL,
                  datetime('now','localtime'), datetime('now','localtime'))`,
        [
          empresaId,
          tx.id,
          origem,
          registro.id,
          STATUS_CONCILIACAO.CONCILIADA,
          valor,
          origemConc,
          params.observacao != null ? String(params.observacao).trim() || null : null
        ]
      );
      const row = await dbGet(db, `SELECT * FROM conciliacao_bancaria WHERE id = ?`, [r.lastID]);
      registrarOperacaoMbc({
        operacao: 'CONCILIACAO_CRIADA',
        empresa_id: empresaId,
        conta_bancaria_id: tx.conta_bancaria_id,
        resultado: 'SUCESSO',
        status: STATUS_CONCILIACAO.CONCILIADA,
        quantidade: 1
      });
      return mapRow(row);
    } catch (err) {
      if (/UNIQUE/i.test(String(err.message || ''))) {
        throw erroMbc(ERROS.JA_CONCILIADA, 'Já existe vínculo ativo desta transação com o mesmo alvo.', 409);
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
    const links = await listarLinksConciliadosAtivos(db, tx.id);
    if (links.length) {
      throw erroMbc(ERROS.JA_CONCILIADA, MSG_JA, 409);
    }
    const marcacao = await obterMarcacaoAtiva(db, tx.id);
    if (marcacao) {
      await dbRun(
        db,
        `UPDATE conciliacao_bancaria
         SET status = ?, observacao = ?, updated_at = datetime('now','localtime')
         WHERE id = ? AND empresa_id = ? AND ativo = 1`,
        [statusAlvo, observacao || marcacao.observacao, marcacao.id, empresaId]
      );
      const row = await dbGet(db, `SELECT * FROM conciliacao_bancaria WHERE id = ?`, [marcacao.id]);
      return mapRow(row);
    }
    const r = await dbRun(
      db,
      `INSERT INTO conciliacao_bancaria (
        empresa_id, transacao_bancaria_id, origem_financeira, registro_financeiro_id,
        status, valor_conciliado, origem_conciliacao, observacao, ativo, conciliado_em, desconciliado_em,
        created_at, updated_at
      ) VALUES (?, ?, NULL, NULL, ?, NULL, ?, ?, 1, NULL, NULL,
                datetime('now','localtime'), datetime('now','localtime'))`,
      [empresaId, tx.id, statusAlvo, ORIGEM_CONCILIACAO.MANUAL, observacao || null]
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
    const motivo = params.motivo != null || params.observacao != null
      ? String(params.motivo != null ? params.motivo : params.observacao).trim() || null
      : null;
    let observacao = row.observacao;
    if (motivo) {
      observacao = observacao
        ? String(observacao) + ' | Cancelamento: ' + motivo
        : 'Cancelamento: ' + motivo;
    }
    await dbRun(
      db,
      `UPDATE conciliacao_bancaria
       SET ativo = 0, desconciliado_em = datetime('now','localtime'),
           observacao = ?, updated_at = datetime('now','localtime')
       WHERE id = ? AND empresa_id = ?`,
      [observacao, id, empresaId]
    );
    const atual = await dbGet(db, `SELECT * FROM conciliacao_bancaria WHERE id = ?`, [id]);
    registrarOperacaoMbc({
      operacao: 'CONCILIACAO_CANCELADA',
      empresa_id: empresaId,
      resultado: 'SUCESSO',
      status: 'cancelada',
      quantidade: 1
    });
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

async function obterPorTransacao(params = {}) {
  const db = params.db;
  const empresaId = exigirEmpresaId(params.empresaId);
  const tx = await TransacaoBancariaService.obterNoContexto({
    db,
    empresaId,
    id: params.transacao_bancaria_id != null ? params.transacao_bancaria_id : params.id
  });
  const rows = await dbAll(
    db,
    `SELECT * FROM conciliacao_bancaria
     WHERE empresa_id = ? AND transacao_bancaria_id = ?
     ORDER BY id ASC`,
    [empresaId, tx.id]
  );
  const valorConciliado = await calcularValorConciliado({ db, transacao_bancaria_id: tx.id });
  const valorDisponivel = await calcularValorDisponivel({ db, empresaId, transacao: tx });
  const statusInfo = await obterStatusDaTransacao(db, tx.id);
  return {
    empresa_id: empresaId,
    transacao_bancaria_id: tx.id,
    status: statusInfo.status,
    status_conciliacao: statusInfo.status_conciliacao,
    valor_total: round2(Number(tx.valor)),
    valor_transacao: Number(tx.valor),
    valor_conciliado: valorConciliado,
    valor_disponivel: valorDisponivel,
    conciliacoes: rows.map(mapRow)
  };
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
  if (params.direcao) {
    where.push('t.direcao = ?');
    bind.push(String(params.direcao).toLowerCase());
  }
  if (params.provider || params.origem || params.external_source) {
    const prov = String(params.provider || params.origem || params.external_source).trim().toUpperCase();
    where.push('UPPER(COALESCE(t.external_source, \'\')) = ?');
    bind.push(prov);
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
    `SELECT t.*,
        COALESCE((
          SELECT SUM(c.valor_conciliado) FROM conciliacao_bancaria c
          WHERE c.transacao_bancaria_id = t.id AND c.ativo = 1 AND c.status = 'conciliada'
        ), 0) AS valor_ja_conciliado
     FROM transacao_bancaria t
     WHERE ${where.join(' AND ')}
       AND NOT EXISTS (
         SELECT 1 FROM conciliacao_bancaria c
         WHERE c.transacao_bancaria_id = t.id AND c.ativo = 1
           AND c.status IN ('ignorada', 'divergente')
       )
       AND ROUND(100 * t.valor) > ROUND(100 * COALESCE((
         SELECT SUM(c2.valor_conciliado) FROM conciliacao_bancaria c2
         WHERE c2.transacao_bancaria_id = t.id AND c2.ativo = 1 AND c2.status = 'conciliada'
       ), 0))
     ORDER BY t.data_transacao DESC, t.id DESC`,
    bind
  );

  const out = rows.map((t) => {
    const valorTotal = round2(Number(t.valor));
    let valorConciliado = round2(Number(t.valor_ja_conciliado) || 0);
    let valorDisponivel = round2(valorTotal - valorConciliado);
    if (valorDisponivel < 0) {
      registrarOperacaoMbc({
        operacao: 'CONCILIACAO_VALOR_INCONSISTENTE',
        empresa_id: empresaId,
        conta_bancaria_id: t.conta_bancaria_id,
        resultado: 'ALERTA',
        status: 'valor_disponivel_negativo',
        quantidade: 1
      });
      valorDisponivel = 0;
      valorConciliado = valorTotal;
    }
    const statusConciliacao = derivarStatusTransacao(valorTotal, valorConciliado, null);
    const filtroStatus = params.status_conciliacao
      ? String(params.status_conciliacao).trim().toLowerCase()
      : null;
    if (
      filtroStatus
      && filtroStatus !== 'pendente'
      && filtroStatus !== statusConciliacao
    ) {
      return null;
    }
    return {
      status: statusLegadoDaTransacao(statusConciliacao),
      status_conciliacao: statusConciliacao,
      ativo: false,
      transacao_bancaria_id: t.id,
      empresa_id: t.empresa_id,
      conta_bancaria_id: t.conta_bancaria_id,
      provider: t.external_source || null,
      origem: t.external_source || null,
      data: t.data_transacao,
      descricao: t.descricao,
      direcao: t.direcao,
      valor_total: valorTotal,
      valor_conciliado: valorConciliado,
      valor_disponivel: valorDisponivel,
      transacao: {
        id: t.id,
        conta_bancaria_id: t.conta_bancaria_id,
        data_transacao: t.data_transacao,
        valor: Number(t.valor),
        direcao: t.direcao,
        descricao: t.descricao,
        tipo: t.tipo,
        external_source: t.external_source || null
      }
    };
  });
  return out.filter(Boolean);
}

async function obterStatusDaTransacao(db, transacaoId) {
  const tx = await dbGet(
    db,
    `SELECT id, valor, empresa_id, conta_bancaria_id FROM transacao_bancaria WHERE id = ?`,
    [transacaoId]
  );
  if (!tx) {
    return {
      status: STATUS_CONCILIACAO.PENDENTE,
      status_conciliacao: STATUS_TRANSACAO_CONCILIACAO.NAO_CONCILIADA,
      conciliacao: null,
      conciliacoes: [],
      valor_total: 0,
      valor_conciliado: 0,
      valor_disponivel: 0
    };
  }
  const links = await listarLinksConciliadosAtivos(db, transacaoId);
  let valorConciliado = round2(links.reduce((acc, r) => acc + Number(r.valor_conciliado || 0), 0));
  const valorTotal = round2(Number(tx.valor));
  let valorDisponivel = round2(valorTotal - valorConciliado);
  if (valorDisponivel < 0) {
    registrarOperacaoMbc({
      operacao: 'CONCILIACAO_VALOR_INCONSISTENTE',
      empresa_id: tx.empresa_id,
      conta_bancaria_id: tx.conta_bancaria_id,
      resultado: 'ALERTA',
      status: 'valor_disponivel_negativo',
      quantidade: 1
    });
    valorDisponivel = 0;
    valorConciliado = valorTotal;
  }
  const marcacao = await obterMarcacaoAtiva(db, transacaoId);
  const statusConciliacao = derivarStatusTransacao(
    valorTotal,
    valorConciliado,
    marcacao ? marcacao.status : null
  );
  return {
    status: statusLegadoDaTransacao(statusConciliacao),
    status_conciliacao: statusConciliacao,
    conciliacao: links.length
      ? mapRow(links[0])
      : (marcacao ? mapRow(marcacao) : null),
    conciliacoes: links.map(mapRow),
    valor_total: valorTotal,
    valor_conciliado: valorConciliado,
    valor_disponivel: valorDisponivel
  };
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
    const finCols = await dbAll(db, 'PRAGMA table_info(financeiro)');
    const colSet = new Set((finCols || []).map((c) => c.name));
    const temStatus = colSet.has('status');
    const statusFilterRec = temStatus
      ? `AND LOWER(COALESCE(status, 'pendente')) NOT IN ('cancelado', 'estornado')`
      : '';
    const selectStatus = temStatus ? 'status' : 'NULL AS status';
    const recs = await dbAll(
      db,
      `SELECT id, descricao, valor, data_movimento, tipo, ${selectStatus}
       FROM financeiro
       WHERE empresa_id = ? AND tipo = 'receita'
         ${statusFilterRec}
       ORDER BY data_movimento DESC, id DESC LIMIT ?`,
      [empresaId, limite]
    );
    const recIds = recs.map((r) => r.id);
    const recConcMap = Object.create(null);
    if (recIds.length) {
      const placeholders = recIds.map(() => '?').join(',');
      const concRows = await dbAll(
        db,
        `SELECT registro_financeiro_id AS id, COALESCE(SUM(valor_conciliado), 0) AS total
         FROM conciliacao_bancaria
         WHERE empresa_id = ?
           AND origem_financeira = ?
           AND ativo = 1 AND status = ?
           AND registro_financeiro_id IN (${placeholders})
         GROUP BY registro_financeiro_id`,
        [empresaId, ORIGEM_FINANCEIRA.FINANCEIRO, STATUS_CONCILIACAO.CONCILIADA, ...recIds]
      );
      (concRows || []).forEach((row) => {
        recConcMap[row.id] = Number(row.total) || 0;
      });
    }
    recs.forEach((r) => {
      const valorOriginal = round2(r.valor);
      const jaConc = round2(recConcMap[r.id] || 0);
      const disponivel = round2(valorOriginal - jaConc);
      if (!(disponivel > 0)) return;
      out.push({
        origem_financeira: ORIGEM_FINANCEIRA.FINANCEIRO,
        registro_financeiro_id: r.id,
        data: r.data_movimento,
        data_tipo: 'movimento',
        descricao: r.descricao,
        valor: disponivel,
        valor_original: valorOriginal,
        valor_ja_conciliado: jaConc,
        valor_disponivel: disponivel,
        status: r.status != null ? String(r.status) : null,
        permite_parcial: false,
        tipo: r.tipo
      });
    });

    const crs = await dbAll(
      db,
      `SELECT id, valor_parcela, valor_restante, data_vencimento, numero_parcela, total_parcelas, status
       FROM contas_receber
       WHERE empresa_id = ?
         AND valor_restante > 0
         AND LOWER(COALESCE(status, 'aberto')) NOT IN ('cancelado', 'estornado')
       ORDER BY data_vencimento DESC, id DESC LIMIT ?`,
      [empresaId, limite]
    );

    const crIds = crs.map((r) => r.id);
    const concMap = Object.create(null);
    const pagMap = Object.create(null);
    if (crIds.length) {
      const placeholders = crIds.map(() => '?').join(',');
      const concRows = await dbAll(
        db,
        `SELECT registro_financeiro_id AS id, COALESCE(SUM(valor_conciliado), 0) AS total
         FROM conciliacao_bancaria
         WHERE empresa_id = ?
           AND origem_financeira = ?
           AND ativo = 1 AND status = ?
           AND registro_financeiro_id IN (${placeholders})
         GROUP BY registro_financeiro_id`,
        [empresaId, ORIGEM_FINANCEIRA.CONTAS_RECEBER, STATUS_CONCILIACAO.CONCILIADA, ...crIds]
      );
      (concRows || []).forEach((row) => {
        concMap[row.id] = Number(row.total) || 0;
      });
      const pagRows = await dbAll(
        db,
        `SELECT conta_receber_id AS id,
                COUNT(*) AS quantidade,
                COALESCE(SUM(valor_pago), 0) AS valor_total
         FROM contas_receber_pagamentos
         WHERE conta_receber_id IN (${placeholders})
         GROUP BY conta_receber_id`,
        crIds
      );
      (pagRows || []).forEach((row) => {
        pagMap[row.id] = {
          quantidade: Number(row.quantidade) || 0,
          valor_total: Number(row.valor_total) || 0
        };
      });
    }

    crs.forEach((r) => {
      const valorParcela = round2(r.valor_parcela);
      const valorRestante = round2(r.valor_restante);
      const jaConc = round2(concMap[r.id] || 0);
      const disponivel = round2(valorRestante - jaConc);
      if (!(disponivel > 0)) return;
      const pag = pagMap[r.id] || { quantidade: 0, valor_total: 0 };
      // Pagamentos já reduzem valor_restante; não subtrair de novo.
      // Se não houver linhas em contas_receber_pagamentos, inferir pago pela diferença parcela−restante.
      const valorPago = pag.quantidade > 0
        ? round2(pag.valor_total)
        : round2(Math.max(0, valorParcela - valorRestante));
      out.push({
        origem_financeira: ORIGEM_FINANCEIRA.CONTAS_RECEBER,
        registro_financeiro_id: r.id,
        data: r.data_vencimento,
        data_tipo: 'vencimento',
        descricao: 'Contas a receber ' + (r.numero_parcela || '') + '/' + (r.total_parcelas || ''),
        valor: disponivel,
        valor_original: valorParcela,
        valor_restante: valorRestante,
        valor_pago: valorPago,
        valor_ja_conciliado: jaConc,
        valor_disponivel: disponivel,
        status: r.status != null ? String(r.status) : 'aberto',
        permite_parcial: true,
        quantidade_pagamentos: pag.quantidade,
        pagamentos: {
          quantidade: pag.quantidade,
          valor_total: valorPago
        },
        tipo: 'contas_receber'
      });
    });

    const pags = await dbAll(
      db,
      `SELECT p.id, p.valor_pago, p.data_pagamento, p.observacao, p.conta_receber_id
       FROM contas_receber_pagamentos p
       INNER JOIN contas_receber c ON c.id = p.conta_receber_id
       WHERE c.empresa_id = ?
       ORDER BY p.data_pagamento DESC, p.id DESC LIMIT ?`,
      [empresaId, limite]
    );
    const pagIds = pags.map((r) => r.id);
    const concPagMap = Object.create(null);
    if (pagIds.length) {
      const placeholders = pagIds.map(() => '?').join(',');
      const concPagRows = await dbAll(
        db,
        `SELECT registro_financeiro_id AS id, COALESCE(SUM(valor_conciliado), 0) AS total
         FROM conciliacao_bancaria
         WHERE empresa_id = ?
           AND origem_financeira = ?
           AND ativo = 1 AND status = ?
           AND registro_financeiro_id IN (${placeholders})
         GROUP BY registro_financeiro_id`,
        [empresaId, ORIGEM_FINANCEIRA.CONTAS_RECEBER_PAGAMENTO, STATUS_CONCILIACAO.CONCILIADA, ...pagIds]
      );
      (concPagRows || []).forEach((row) => {
        concPagMap[row.id] = Number(row.total) || 0;
      });
    }
    pags.forEach((r) => {
      const valorPago = round2(r.valor_pago);
      const jaConc = round2(concPagMap[r.id] || 0);
      const disponivel = round2(valorPago - jaConc);
      if (!(disponivel > 0)) return;
      out.push({
        origem_financeira: ORIGEM_FINANCEIRA.CONTAS_RECEBER_PAGAMENTO,
        registro_financeiro_id: r.id,
        data: r.data_pagamento,
        data_tipo: 'pagamento',
        descricao: r.observacao || 'Pagamento de contas a receber',
        valor: disponivel,
        valor_original: valorPago,
        valor_pago: valorPago,
        valor_ja_conciliado: jaConc,
        valor_disponivel: disponivel,
        permite_parcial: false,
        quantidade_pagamentos: 1,
        tipo: 'contas_receber_pagamento'
      });
    });
  } else if (direcao === DIRECAO.SAIDA) {
    // Contas a Pagar de domínio = financeiro.tipo=despesa (não há tabela contas_pagar).
    const finCols = await dbAll(db, 'PRAGMA table_info(financeiro)');
    const colSet = new Set((finCols || []).map((c) => c.name));
    const tem = (nome) => colSet.has(nome);
    const selectExtras = [
      tem('vencimento') ? 'vencimento' : 'NULL AS vencimento',
      tem('pessoa_nome') ? 'pessoa_nome' : 'NULL AS pessoa_nome',
      tem('documento') ? 'documento' : 'NULL AS documento',
      tem('numero_parcela') ? 'numero_parcela' : 'NULL AS numero_parcela',
      tem('total_parcelas') ? 'total_parcelas' : 'NULL AS total_parcelas',
      tem('origem') ? 'origem' : 'NULL AS origem',
      tem('status') ? 'status' : 'NULL AS status'
    ].join(', ');
    const orderExpr = tem('vencimento')
      ? 'COALESCE(vencimento, data_movimento)'
      : 'data_movimento';
    const statusFilter = tem('status')
      ? `AND LOWER(COALESCE(status, 'pendente')) NOT IN ('cancelado', 'estornado')`
      : '';
    const desp = await dbAll(
      db,
      `SELECT id, descricao, valor, data_movimento, tipo, ${selectExtras}
       FROM financeiro
       WHERE empresa_id = ?
         AND tipo = 'despesa'
         ${statusFilter}
       ORDER BY ${orderExpr} DESC, id DESC
       LIMIT ?`,
      [empresaId, limite]
    );
    const despIds = desp.map((r) => r.id);
    const concMap = Object.create(null);
    if (despIds.length) {
      const placeholders = despIds.map(() => '?').join(',');
      const concRows = await dbAll(
        db,
        `SELECT registro_financeiro_id AS id, COALESCE(SUM(valor_conciliado), 0) AS total
         FROM conciliacao_bancaria
         WHERE empresa_id = ?
           AND origem_financeira = ?
           AND ativo = 1 AND status = ?
           AND registro_financeiro_id IN (${placeholders})
         GROUP BY registro_financeiro_id`,
        [empresaId, ORIGEM_FINANCEIRA.FINANCEIRO, STATUS_CONCILIACAO.CONCILIADA, ...despIds]
      );
      (concRows || []).forEach((row) => {
        concMap[row.id] = Number(row.total) || 0;
      });
    }
    desp.forEach((r) => {
      const valorOriginal = round2(r.valor);
      const jaConc = round2(concMap[r.id] || 0);
      const disponivel = round2(valorOriginal - jaConc);
      if (!(disponivel > 0)) return;
      const status = r.status != null ? String(r.status) : 'pendente';
      const statusLow = status.toLowerCase();
      // Sem tabela de pagamentos AP: inferir pago só pelo status de baixa.
      let valorPago = null;
      if (statusLow === 'pago' || statusLow === 'recebido') {
        valorPago = valorOriginal;
      } else if (statusLow === 'parcial') {
        valorPago = null; // baixa parcial não persiste valor pago no modelo atual
      } else {
        valorPago = 0;
      }
      const dataRef = r.vencimento || r.data_movimento;
      const descBase = r.descricao || 'Contas a pagar';
      const forn = r.pessoa_nome ? String(r.pessoa_nome) : '';
      out.push({
        origem_financeira: ORIGEM_FINANCEIRA.FINANCEIRO,
        registro_financeiro_id: r.id,
        data: dataRef,
        data_tipo: r.vencimento ? 'vencimento' : 'movimento',
        descricao: forn ? (descBase + ' — ' + forn) : descBase,
        valor: disponivel,
        valor_original: valorOriginal,
        valor_pago: valorPago,
        valor_ja_conciliado: jaConc,
        valor_disponivel: disponivel,
        status,
        permite_parcial: true,
        quantidade_pagamentos: null,
        pagamentos: null,
        tipo: 'despesa',
        rotulo_entidade: 'CONTAS_A_PAGAR',
        documento: r.documento != null ? r.documento : null,
        origem_lancamento: r.origem != null ? r.origem : null
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
  obterPorTransacao,
  listar,
  listarPendentes,
  listarRegistrosElegiveis,
  obterStatusDaTransacao,
  obterStatusConciliacao,
  calcularValorConciliado,
  calcularValorDisponivel,
  ORIGEM_FINANCEIRA,
  ORIGEM_CONCILIACAO,
  STATUS_TRANSACAO_CONCILIACAO,
  MSG_JA,
  MSG_VALORES,
  MSG_COMPAT,
  MSG_EXCESSO
};
