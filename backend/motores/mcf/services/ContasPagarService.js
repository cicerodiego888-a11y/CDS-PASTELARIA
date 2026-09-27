/**
 * ContasPagarService — Fundação MCF-01.
 * Títulos dedicados com valor_original / valor_restante.
 * Não grava em financeiro legado. Não altera MBC.
 * @module motores/mcf/services/ContasPagarService
 */
'use strict';

const {
  STATUS_CONTA_PAGAR,
  ERROS_MCF,
  erroMcf,
  round2
} = require('../contracts/constantesMcf');

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)));
  });
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

async function withTx(db, fn) {
  await dbRun(db, 'BEGIN IMMEDIATE');
  try {
    const out = await fn();
    await dbRun(db, 'COMMIT');
    return out;
  } catch (err) {
    try { await dbRun(db, 'ROLLBACK'); } catch (_e) { /* ignore */ }
    throw err;
  }
}

function exigirEmpresaId(empresaId) {
  const id = Number(empresaId);
  if (!Number.isInteger(id) || id <= 0) {
    throw erroMcf(ERROS_MCF.EMPRESA_OBRIGATORIA, 'empresa_id é obrigatório.', 400);
  }
  return id;
}

function parseData(valor, rotulo) {
  if (valor == null || String(valor).trim() === '') return null;
  const s = String(valor).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw erroMcf(ERROS_MCF.DATA_INVALIDA, rotulo + ' inválida. Use YYYY-MM-DD.', 400);
  }
  return s;
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    empresa_id: Number(row.empresa_id),
    fornecedor_id: row.fornecedor_id != null ? Number(row.fornecedor_id) : null,
    descricao: row.descricao != null ? String(row.descricao) : '',
    valor_original: round2(row.valor_original),
    valor_restante: round2(row.valor_restante),
    data_emissao: row.data_emissao || null,
    data_vencimento: row.data_vencimento,
    status: String(row.status || STATUS_CONTA_PAGAR.ABERTA),
    documento: row.documento != null ? String(row.documento) : null,
    origem: row.origem != null ? String(row.origem) : 'manual',
    referencia_tipo: row.referencia_tipo || null,
    referencia_id: row.referencia_id != null ? Number(row.referencia_id) : null,
    observacao: row.observacao != null ? String(row.observacao) : null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null
  };
}

function derivarStatus(valorOriginal, valorRestante, statusAtual) {
  if (statusAtual === STATUS_CONTA_PAGAR.CANCELADA) return STATUS_CONTA_PAGAR.CANCELADA;
  const orig = round2(valorOriginal);
  const rest = round2(valorRestante);
  if (rest <= 0) return STATUS_CONTA_PAGAR.QUITADA;
  if (rest < orig) return STATUS_CONTA_PAGAR.PARCIAL;
  return STATUS_CONTA_PAGAR.ABERTA;
}

function validarConsistencia(valorOriginal, valorRestante) {
  const orig = round2(valorOriginal);
  const rest = round2(valorRestante);
  if (!(orig > 0)) {
    throw erroMcf(ERROS_MCF.VALOR_INVALIDO, 'valor_original deve ser maior que zero.', 400);
  }
  if (rest < 0) {
    throw erroMcf(ERROS_MCF.INCONSISTENCIA, 'valor_restante não pode ser negativo.', 400);
  }
  if (rest > orig) {
    throw erroMcf(ERROS_MCF.INCONSISTENCIA, 'valor_restante não pode exceder valor_original.', 400);
  }
}

async function validarFornecedor(db, fornecedorId) {
  if (fornecedorId == null || fornecedorId === '') return null;
  const id = Number(fornecedorId);
  if (!Number.isInteger(id) || id <= 0) {
    throw erroMcf(ERROS_MCF.FORNECEDOR_NAO_ENCONTRADO, 'fornecedor_id inválido.', 400);
  }
  const row = await dbGet(db, 'SELECT id FROM fornecedores WHERE id = ?', [id]);
  if (!row) {
    throw erroMcf(ERROS_MCF.FORNECEDOR_NAO_ENCONTRADO, 'Fornecedor não encontrado.', 404);
  }
  return id;
}

async function criar(params = {}) {
  const db = params.db;
  const empresaId = exigirEmpresaId(params.empresaId);
  const valorOriginal = round2(params.valor_original);
  if (!(valorOriginal > 0) || !Number.isFinite(valorOriginal)) {
    throw erroMcf(ERROS_MCF.VALOR_INVALIDO, 'valor_original deve ser maior que zero.', 400);
  }
  const dataVencimento = parseData(params.data_vencimento, 'data_vencimento');
  if (!dataVencimento) {
    throw erroMcf(ERROS_MCF.DATA_INVALIDA, 'data_vencimento é obrigatória.', 400);
  }
  const dataEmissao = parseData(params.data_emissao, 'data_emissao')
    || dataVencimento;
  const fornecedorId = await validarFornecedor(db, params.fornecedor_id);
  // valor_restante sempre derivado — nunca confiar no frontend.
  const valorRestante = valorOriginal;
  validarConsistencia(valorOriginal, valorRestante);
  const status = STATUS_CONTA_PAGAR.ABERTA;

  const r = await dbRun(
    db,
    `INSERT INTO contas_pagar (
      empresa_id, fornecedor_id, descricao, valor_original, valor_restante,
      data_emissao, data_vencimento, status, documento, origem,
      referencia_tipo, referencia_id, observacao, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [
      empresaId,
      fornecedorId,
      params.descricao != null ? String(params.descricao) : '',
      valorOriginal,
      valorRestante,
      dataEmissao,
      dataVencimento,
      status,
      params.documento != null ? String(params.documento) : null,
      params.origem != null ? String(params.origem) : 'manual',
      params.referencia_tipo != null ? String(params.referencia_tipo) : null,
      params.referencia_id != null ? Number(params.referencia_id) : null,
      params.observacao != null ? String(params.observacao) : null
    ]
  );
  return obter({ db, empresaId, id: r.lastID });
}

async function obter(params = {}) {
  const db = params.db;
  const empresaId = exigirEmpresaId(params.empresaId);
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw erroMcf(ERROS_MCF.CONTA_NAO_ENCONTRADA, 'Conta a pagar não encontrada.', 404);
  }
  const row = await dbGet(
    db,
    `SELECT * FROM contas_pagar WHERE id = ? AND empresa_id = ?`,
    [id, empresaId]
  );
  if (!row) {
    throw erroMcf(ERROS_MCF.CONTA_NAO_ENCONTRADA, 'Conta a pagar não encontrada.', 404);
  }
  return mapRow(row);
}

async function listar(params = {}) {
  const db = params.db;
  const empresaId = exigirEmpresaId(params.empresaId);
  const where = ['empresa_id = ?'];
  const bind = [empresaId];
  if (params.status) {
    where.push('status = ?');
    bind.push(String(params.status));
  }
  if (params.fornecedor_id != null) {
    where.push('fornecedor_id = ?');
    bind.push(Number(params.fornecedor_id));
  }
  const limite = Math.min(Math.max(Number(params.limite) || 100, 1), 500);
  const rows = await dbAll(
    db,
    `SELECT * FROM contas_pagar
     WHERE ${where.join(' AND ')}
     ORDER BY data_vencimento ASC, id ASC
     LIMIT ?`,
    bind.concat([limite])
  );
  return rows.map(mapRow);
}

async function listarPagamentos(params = {}) {
  const db = params.db;
  const empresaId = exigirEmpresaId(params.empresaId);
  const titulo = await obter({ db, empresaId, id: params.id });
  const rows = await dbAll(
    db,
    `SELECT * FROM contas_pagar_pagamentos
     WHERE conta_pagar_id = ? AND empresa_id = ?
     ORDER BY data_pagamento ASC, id ASC`,
    [titulo.id, empresaId]
  );
  return {
    conta_pagar: titulo,
    pagamentos: rows.map((r) => ({
      id: Number(r.id),
      conta_pagar_id: Number(r.conta_pagar_id),
      empresa_id: Number(r.empresa_id),
      fornecedor_id: r.fornecedor_id != null ? Number(r.fornecedor_id) : null,
      valor_pago: round2(r.valor_pago),
      data_pagamento: r.data_pagamento,
      forma_pagamento: r.forma_pagamento || null,
      observacao: r.observacao || null,
      created_at: r.created_at || null
    }))
  };
}

/**
 * Baixa parcial/total. Reduz valor_restante. Não altera valor_original.
 * Não cria lançamento em financeiro nesta fundação.
 */
async function baixar(params = {}) {
  const db = params.db;
  const empresaId = exigirEmpresaId(params.empresaId);
  const id = Number(params.id);
  const valorPago = round2(params.valor_pago != null ? params.valor_pago : params.valor);
  if (!(valorPago > 0) || !Number.isFinite(valorPago)) {
    throw erroMcf(ERROS_MCF.VALOR_INVALIDO, 'valor_pago deve ser maior que zero.', 400);
  }
  const dataPagamento = parseData(params.data_pagamento, 'data_pagamento')
    || new Date().toISOString().slice(0, 10);

  return withTx(db, async () => {
    const row = await dbGet(
      db,
      `SELECT * FROM contas_pagar WHERE id = ? AND empresa_id = ?`,
      [id, empresaId]
    );
    if (!row) {
      throw erroMcf(ERROS_MCF.CONTA_NAO_ENCONTRADA, 'Conta a pagar não encontrada.', 404);
    }
    const statusAtual = String(row.status || '');
    if (statusAtual === STATUS_CONTA_PAGAR.CANCELADA) {
      throw erroMcf(ERROS_MCF.TITULO_CANCELADO, 'Título cancelado não aceita baixa.', 409);
    }
    if (statusAtual === STATUS_CONTA_PAGAR.QUITADA || round2(row.valor_restante) <= 0) {
      throw erroMcf(ERROS_MCF.TITULO_QUITADO, 'Título já está quitado.', 409);
    }
    const restante = round2(row.valor_restante);
    if (valorPago > restante) {
      throw erroMcf(
        ERROS_MCF.BAIXA_EXCEDE_RESTANTE,
        'Valor da baixa excede o valor restante.',
        400,
        { valor_restante: restante, valor_pago: valorPago }
      );
    }
    const novoRestante = round2(restante - valorPago);
    validarConsistencia(row.valor_original, novoRestante);
    const novoStatus = derivarStatus(row.valor_original, novoRestante, statusAtual);

    await dbRun(
      db,
      `INSERT INTO contas_pagar_pagamentos (
        conta_pagar_id, empresa_id, fornecedor_id, valor_pago,
        data_pagamento, forma_pagamento, observacao
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        empresaId,
        row.fornecedor_id,
        valorPago,
        dataPagamento,
        params.forma_pagamento != null ? String(params.forma_pagamento) : null,
        params.observacao != null ? String(params.observacao) : null
      ]
    );
    await dbRun(
      db,
      `UPDATE contas_pagar
       SET valor_restante = ?, status = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND empresa_id = ?`,
      [novoRestante, novoStatus, id, empresaId]
    );
    return obter({ db, empresaId, id });
  });
}

module.exports = {
  criar,
  obter,
  listar,
  listarPagamentos,
  baixar,
  STATUS_CONTA_PAGAR,
  ERROS_MCF,
  round2,
  mapRow,
  derivarStatus,
  validarConsistencia
};
